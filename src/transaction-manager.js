/**
 * Transaction Manager for Maintaining Consistency Across KV, D1, and Stripe
 * 
 * Since we can't have true ACID across distributed systems, we implement:
 * 1. Saga Pattern (Compensating Transactions)
 * 2. Idempotency Keys
 * 3. Retry Logic with Exponential Backoff
 * 4. Operation Logging
 * 5. Rollback Functions
 */

// Operation types
const OP_TYPES = {
  STRIPE_CREATE_ITEM: 'stripe_create_item',
  STRIPE_DELETE_ITEM: 'stripe_delete_item',
  KV_UPDATE_USER: 'kv_update_user',
  D1_INSERT_LICENSE: 'd1_insert_license',
  D1_UPDATE_LICENSE: 'd1_update_license'
};

/**
 * Transaction context - tracks all operations for rollback
 */
class TransactionContext {
  constructor(operationId) {
    this.operationId = operationId;
    this.operations = []; // Array of { type, params, rollback }
    this.committed = false;
    this.rolledBack = false;
  }

  addOperation(type, params, rollbackFn) {
    this.operations.push({
      type,
      params,
      rollback: rollbackFn,
      timestamp: Date.now()
    });
  }

  async rollback() {
    if (this.rolledBack) {
      console.warn(`Transaction ${this.operationId} already rolled back`);
      return;
    }

    this.rolledBack = true;

    // Rollback in reverse order
    for (let i = this.operations.length - 1; i >= 0; i--) {
      const op = this.operations[i];
      try {
        if (op.rollback) {
          await op.rollback();
        }
      } catch (error) {
        console.error(`Failed to rollback operation ${i} (${op.type}):`, error);
        // Continue rolling back other operations
      }
    }
  }

  commit() {
    this.committed = true;
  }
}

/**
 * Generate idempotency key for an operation
 */
function generateIdempotencyKey(operation, params) {
  const key = `${operation}_${JSON.stringify(params)}`;
  return btoa(key).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

/**
 * Retry with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Execute transaction with rollback support
 */
async function executeTransaction(env, operationId, operations) {
  const ctx = new TransactionContext(operationId);
  
  try {
    // Check idempotency - if operation already completed, return success
    const idempotencyKey = `idempotency:${operationId}`;
    const existing = await env.USERS_KV.get(idempotencyKey);
    if (existing) {
      const result = JSON.parse(existing);
      return { success: true, result: result.result, idempotent: true };
    }

    // Execute all operations
    for (const op of operations) {
      const result = await retryWithBackoff(() => op.execute(ctx));
      ctx.addOperation(op.type, op.params, op.rollback);
    }

    // Mark as committed
    ctx.commit();

    // Store idempotency result
    const finalResult = operations[operations.length - 1].result;
    await env.USERS_KV.put(idempotencyKey, JSON.stringify({
      operationId,
      result: finalResult,
      completedAt: Date.now()
    }), { expirationTtl: 86400 }); // 24 hours

    return { success: true, result: finalResult };
  } catch (error) {
    console.error(`Transaction ${operationId} failed:`, error);
    
    // Rollback all operations
    await ctx.rollback();
    
    return { success: false, error: error.message };
  }
}

/**
 * Create Stripe subscription item operation
 */
function createStripeItemOp(env, subscriptionId, priceId, site, metadata = {}) {
  return {
    type: OP_TYPES.STRIPE_CREATE_ITEM,
    params: { subscriptionId, priceId, site },
    async execute(ctx) {
      const form = {
        'subscription': subscriptionId,
        'price': priceId,
        'quantity': 1,
        'metadata[site]': site,
        ...Object.entries(metadata).reduce((acc, [k, v]) => {
          acc[`metadata[${k}]`] = v;
          return acc;
        }, {})
      };

      const res = await stripeFetch(env, '/subscription_items', 'POST', form, true);
      if (res.status >= 400) {
        throw new Error(`Stripe API error: ${JSON.stringify(res.body)}`);
      }

      const itemId = res.body.id;
      this.result = { itemId, site };
      return { itemId, site };
    },
    async rollback() {
      // Delete the item we just created
      if (this.result && this.result.itemId) {
        try {
          await stripeFetch(env, `/subscription_items/${this.result.itemId}`, 'DELETE');
        } catch (error) {
          console.error(`Failed to rollback Stripe item ${this.result.itemId}:`, error);
        }
      }
    }
  };
}

/**
 * Delete Stripe subscription item operation
 */
function deleteStripeItemOp(env, itemId, site) {
  let originalItem = null;
  
  return {
    type: OP_TYPES.STRIPE_DELETE_ITEM,
    params: { itemId, site },
    async execute(ctx) {
      // First, fetch the item to restore it if needed
      const getRes = await stripeFetch(env, `/subscription_items/${itemId}`);
      if (getRes.status === 200) {
        originalItem = getRes.body;
      }

      // Delete the item
      const res = await stripeFetch(env, `/subscription_items/${itemId}`, 'DELETE');
      if (res.status >= 400) {
        throw new Error(`Stripe API error: ${JSON.stringify(res.body)}`);
      }

      this.result = { itemId, site, deleted: true };
      return { itemId, site, deleted: true };
    },
    async rollback() {
      // Restore the item if we have its data
      if (originalItem) {
        try {
          const form = {
            'subscription': originalItem.subscription,
            'price': originalItem.price.id,
            'quantity': originalItem.quantity,
            'metadata[site]': originalItem.metadata?.site || site
          };
          await stripeFetch(env, '/subscription_items', 'POST', form, true);
        } catch (error) {
          console.error(`Failed to rollback Stripe item deletion:`, error);
        }
      }
    }
  };
}

/**
 * Update KV user record operation
 */
function updateKVUserOp(env, customerId, updateFn) {
  let originalUser = null;
  
  return {
    type: OP_TYPES.KV_UPDATE_USER,
    params: { customerId },
    async execute(ctx) {
      const userKey = `user:${customerId}`;
      const userRaw = await env.USERS_KV.get(userKey);
      originalUser = userRaw ? JSON.parse(userRaw) : null;
      
      const updatedUser = updateFn(originalUser || { customerId, sites: {}, pendingSites: [] });
      
      await env.USERS_KV.put(userKey, JSON.stringify(updatedUser));
      this.result = { updated: true };
      return { updated: true };
    },
    async rollback() {
      // Restore original user data
      if (originalUser !== null) {
        const userKey = `user:${customerId}`;
        await env.USERS_KV.put(userKey, JSON.stringify(originalUser));
      }
    }
  };
}

/**
 * Insert license in D1 operation
 */
function insertLicenseOp(env, customerId, subscriptionId, licenseKey, siteDomain) {
  let insertedId = null;
  
  return {
    type: OP_TYPES.D1_INSERT_LICENSE,
    params: { customerId, subscriptionId, licenseKey, siteDomain },
    async execute(ctx) {
      if (!env.DB) {
        console.warn('D1 not configured, skipping license insert');
        return { skipped: true };
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const result = await env.DB.prepare(
        'INSERT INTO licenses (customer_id, subscription_id, license_key, site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(customerId, subscriptionId, licenseKey, siteDomain, 'active', timestamp, timestamp).first();

      if (result && result.id) {
        insertedId = result.id;
        this.result = { licenseId: insertedId };
        return { licenseId: insertedId };
      }
      
      throw new Error('Failed to insert license');
    },
    async rollback() {
      if (insertedId && env.DB) {
        try {
          await env.DB.prepare('DELETE FROM licenses WHERE id = ?').bind(insertedId).run();
        } catch (error) {
          console.error(`Failed to rollback license insert:`, error);
        }
      }
    }
  };
}

// Export for use in main file
export {
  executeTransaction,
  createStripeItemOp,
  deleteStripeItemOp,
  updateKVUserOp,
  insertLicenseOp,
  generateIdempotencyKey,
  OP_TYPES
};

