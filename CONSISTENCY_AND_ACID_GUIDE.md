# Data Consistency and ACID Properties Guide

## Overview

This system maintains data consistency across **three distributed systems**:
1. **Cloudflare KV** - User records, sites, pending sites
2. **D1 Database** - Payments, license keys
3. **Stripe API** - Subscriptions, subscription items, billing

Since true ACID transactions are not possible across distributed systems, we implement **compensating transactions (Saga pattern)** with idempotency and retry logic.

---

## Consistency Strategy

### 1. **Saga Pattern (Compensating Transactions)**

Each operation that touches multiple systems is wrapped in a transaction context that:
- Tracks all operations performed
- Maintains rollback functions for each operation
- Automatically rolls back on failure

**Example: Removing a Site**
```
1. Delete Stripe subscription item → Success
2. Update KV (mark site inactive) → Success
3. Update D1 (mark license inactive) → FAILURE
   ↓
   ROLLBACK:
   - Restore Stripe item (if possible)
   - Restore KV state
   - Log error for manual review
```

### 2. **Idempotency Keys**

Every operation has a unique idempotency key. If an operation is retried with the same key:
- If already completed → Return cached result
- If in progress → Wait and return result
- If failed → Allow retry

**Format:** `operation_type:customerId:site:timestamp`

### 3. **Retry Logic with Exponential Backoff**

All external API calls (Stripe, KV, D1) use retry logic:
- **Max retries:** 3 attempts
- **Base delay:** 1000ms
- **Backoff:** Exponential (1s, 2s, 4s)

### 4. **Operation Ordering**

Operations are performed in a specific order to minimize rollback complexity:

**Adding a Site:**
1. Add to Stripe (source of truth)
2. Update KV (fast lookup)
3. Generate license in D1 (historical record)

**Removing a Site:**
1. Mark inactive in KV (immediate UI update)
2. Delete from Stripe (billing update)
3. Mark license inactive in D1 (historical record)

---

## Failure Scenarios and Handling

### Scenario 1: Stripe API Failure

**What happens:**
- Stripe API is down or returns error
- Operation fails before updating KV/D1

**Handling:**
- Retry with exponential backoff (up to 3 times)
- If all retries fail → Return error to user
- **No rollback needed** (nothing changed)

### Scenario 2: KV Update Failure

**What happens:**
- Stripe operation succeeded
- KV update fails (network issue, rate limit)

**Handling:**
- Retry KV update (up to 3 times)
- If still fails → Rollback Stripe operation
- Log error for manual reconciliation

**Rollback:**
```javascript
// Delete the Stripe item we just created
await stripeFetch(env, `/subscription_items/${itemId}`, 'DELETE');
```

### Scenario 3: D1 Database Failure

**What happens:**
- Stripe and KV operations succeeded
- D1 insert fails (database error)

**Handling:**
- Retry D1 operation (up to 3 times)
- If still fails → Mark as "pending sync"
- Store in KV with `sync_status: 'pending'`
- Background job will retry later

**Rollback:**
- Don't rollback Stripe/KV (they're source of truth)
- Log error for manual reconciliation
- Queue for background sync

### Scenario 4: Partial Success (Network Timeout)

**What happens:**
- Operation appears to fail but actually succeeded
- User retries → Idempotency key prevents duplicate

**Handling:**
- Check idempotency key first
- If operation already completed → Return cached result
- If in progress → Wait for completion

---

## Implementation Details

### Transaction Context

```javascript
class TransactionContext {
  constructor(operationId) {
    this.operationId = operationId;
    this.operations = []; // Array of { type, params, rollback }
    this.committed = false;
    this.rolledBack = false;
  }

  async rollback() {
    // Rollback in reverse order
    for (let i = this.operations.length - 1; i >= 0; i--) {
      await this.operations[i].rollback();
    }
  }
}
```

### Operation Wrapper

Each operation must provide:
1. **Execute function** - Performs the operation
2. **Rollback function** - Undoes the operation
3. **Type** - For logging and debugging

```javascript
{
  type: 'STRIPE_CREATE_ITEM',
  params: { subscriptionId, priceId, site },
  async execute(ctx) {
    // Perform operation
    const result = await stripeFetch(...);
    return result;
  },
  async rollback() {
    // Undo operation
    await stripeFetch(`/subscription_items/${itemId}`, 'DELETE');
  }
}
```

---

## Data Consistency Guarantees

### Strong Consistency (Eventually Consistent)

**KV ↔ Stripe:**
- KV is updated immediately after Stripe operations
- If KV update fails, Stripe is rolled back
- **Guarantee:** KV always reflects Stripe state (eventually)

**D1 ↔ Stripe:**
- D1 is updated after Stripe operations
- If D1 fails, operation is queued for background sync
- **Guarantee:** D1 will be consistent within 24 hours (background sync)

### Weak Consistency (Best Effort)

**License Keys:**
- Generated after payment
- If generation fails, retried on next webhook
- **Guarantee:** Licenses will be generated eventually

---

## Monitoring and Reconciliation

### Operation Logs

All operations are logged with:
- Operation ID
- Timestamp
- Success/Failure status
- Rollback status (if applicable)

**Location:** Cloudflare Workers logs (`wrangler tail`)

### Pending Sync Queue

Operations that fail D1 updates are stored in KV:
```
Key: `sync_pending:{operationId}`
Value: { operation, params, retryCount, lastAttempt }
```

**Background Job:**
- Runs every hour
- Retries pending operations
- Cleans up after 7 days

### Manual Reconciliation

If automatic rollback fails, manual steps:

1. **Check Stripe Dashboard:**
   - Verify subscription items match expected state
   - Check for orphaned items

2. **Check KV:**
   - Verify user records match Stripe
   - Check for inconsistent states

3. **Check D1:**
   - Verify licenses match subscription items
   - Check for missing licenses

4. **Reconcile:**
   - Update KV to match Stripe (source of truth)
   - Generate missing licenses
   - Clean up orphaned records

---

## Best Practices

### 1. Always Check Idempotency First

```javascript
const idempotencyKey = `idempotency:${operationId}`;
const existing = await env.USERS_KV.get(idempotencyKey);
if (existing) {
  return JSON.parse(existing).result; // Already completed
}
```

### 2. Store Rollback Data Before Operations

```javascript
// Before deleting, fetch the item
const originalItem = await stripeFetch(env, `/subscription_items/${itemId}`);
// Store for rollback
ctx.addOperation(OP_TYPES.STRIPE_DELETE_ITEM, { itemId }, async () => {
  // Restore using originalItem
});
```

### 3. Use Retry Logic for All External Calls

```javascript
const result = await retryWithBackoff(
  () => stripeFetch(env, '/subscription_items', 'POST', form, true),
  3, // max retries
  1000 // base delay
);
```

### 4. Log Everything

```javascript
console.log(`[${operationId}] Starting transaction`);
console.log(`[${operationId}] Operation 1: ${op.type} - ${op.params}`);
console.log(`[${operationId}] Operation 1: SUCCESS`);
console.log(`[${operationId}] Transaction committed`);
```

---

## Error Recovery

### Automatic Recovery

1. **Transient Errors (Network, Rate Limits):**
   - Automatic retry with exponential backoff
   - Up to 3 attempts

2. **Permanent Errors (Invalid Data, Auth Failure):**
   - Immediate failure
   - Rollback all operations
   - Return error to user

### Manual Recovery

1. **Check Operation Logs:**
   ```bash
   npx wrangler tail --format pretty
   ```

2. **Check Pending Sync Queue:**
   ```javascript
   // Query KV for pending operations
   const pending = await env.USERS_KV.list({ prefix: 'sync_pending:' });
   ```

3. **Reconcile Manually:**
   - Use Stripe Dashboard as source of truth
   - Update KV to match Stripe
   - Generate missing licenses

---

## Testing Consistency

### Test Scenarios

1. **Network Failure During Operation:**
   - Simulate network timeout
   - Verify rollback occurs
   - Verify idempotency prevents duplicates

2. **Partial Success:**
   - Stripe succeeds, KV fails
   - Verify Stripe is rolled back
   - Verify error is logged

3. **Idempotency:**
   - Submit same operation twice
   - Verify second call returns cached result
   - Verify no duplicate operations

### Monitoring

- **Success Rate:** Track operation success/failure rates
- **Rollback Rate:** Track how often rollbacks occur
- **Sync Queue Size:** Monitor pending sync operations
- **Reconciliation Alerts:** Alert if inconsistencies detected

---

## Summary

**Consistency Model:** Eventually Consistent with Compensating Transactions

**Guarantees:**
- ✅ Stripe is always the source of truth for billing
- ✅ KV is eventually consistent with Stripe (within seconds)
- ✅ D1 is eventually consistent with Stripe (within 24 hours via background sync)
- ✅ All operations are idempotent (safe to retry)
- ✅ Automatic rollback on failure (where possible)

**Limitations:**
- ⚠️ True ACID not possible across distributed systems
- ⚠️ Some failures require manual reconciliation
- ⚠️ Background sync may take up to 24 hours

**Recommendations:**
- Monitor operation logs regularly
- Set up alerts for high rollback rates
- Review pending sync queue weekly
- Perform manual reconciliation monthly

