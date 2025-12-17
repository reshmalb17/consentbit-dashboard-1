# ACID Consistency Implementation

## Overview

This system maintains data consistency across **three distributed systems**:
- **Cloudflare KV** (user records, sites)
- **D1 Database** (payments, licenses)
- **Stripe API** (subscriptions, billing)

Since true ACID transactions are impossible across distributed systems, we implement **compensating transactions (Saga pattern)** with idempotency and retry logic.

---

## Implementation Summary

### ✅ What's Implemented

1. **Idempotency Keys**
   - Every operation has a unique idempotency key
   - Prevents duplicate operations if retried
   - Stored in KV with 24-hour TTL

2. **Retry Logic with Exponential Backoff**
   - All external API calls retry up to 3 times
   - Base delay: 1000ms, exponential backoff (1s, 2s, 4s)

3. **Rollback Mechanisms**
   - **Remove Site:** If Stripe deletion fails → Rollback KV update
   - **Add Site:** If KV update fails → Rollback Stripe item creation (where possible)

4. **Operation Ordering**
   - Operations performed in order that minimizes rollback complexity
   - Stripe is always source of truth for billing

5. **Error Handling**
   - Transient errors → Automatic retry
   - Permanent errors → Immediate rollback
   - D1 failures → Queue for background sync (non-critical)

---

## Current Implementation Status

### ✅ Remove Site (`/remove-site`)

**Implemented:**
- ✅ Idempotency key check
- ✅ Retry logic for KV updates (3 attempts)
- ✅ Rollback if Stripe deletion fails
- ✅ D1 update with error handling (non-critical)
- ✅ Operation logging with operation ID

**Flow:**
```
1. Check idempotency → Return if already completed
2. Fetch original state for rollback
3. Update KV (with retry) → Mark site inactive
4. Delete from Stripe → If fails, rollback KV
5. Update D1 (non-critical) → Queue for sync if fails
6. Store idempotency result
```

### ✅ Add Site (via Checkout)

**Implemented:**
- ✅ Batch endpoint prevents race conditions
- ✅ Webhook handles consistency after payment
- ✅ License generation with site mapping

**Flow:**
```
1. Add sites to pending list (KV)
2. Create checkout session
3. After payment → Webhook processes:
   - Adds items to Stripe subscription
   - Updates KV with site mappings
   - Generates licenses with site_domain
   - Clears pending sites
```

### ⚠️ Add Site (Direct - Not Recommended)

**Current:** Sites go to pending list, require checkout
**Reason:** Ensures payment before adding to subscription

---

## Failure Scenarios & Handling

### Scenario 1: Stripe API Failure

**What happens:**
- Stripe API down or returns error
- Operation fails before any changes

**Handling:**
- ✅ Retry with exponential backoff (3 attempts)
- ✅ If all retries fail → Return error
- ✅ **No rollback needed** (nothing changed)

### Scenario 2: KV Update Failure

**What happens:**
- Stripe operation succeeded
- KV update fails (network, rate limit)

**Handling:**
- ✅ Retry KV update (3 attempts with backoff)
- ✅ If still fails → Rollback Stripe operation
- ✅ Log error for manual review

**Rollback Example (Remove Site):**
```javascript
// If Stripe deletion failed after KV update
await env.USERS_KV.put(userKey, JSON.stringify(originalUserState));
```

### Scenario 3: D1 Database Failure

**What happens:**
- Stripe and KV operations succeeded
- D1 insert/update fails

**Handling:**
- ✅ Retry D1 operation (3 attempts)
- ✅ If still fails → Queue for background sync
- ✅ **Don't rollback Stripe/KV** (they're source of truth)
- ✅ Store in `sync_pending:{operationId}` for later retry

**Non-Critical Operations:**
- License generation (can be retried later)
- License status updates (webhook will sync)

### Scenario 4: Partial Success (Network Timeout)

**What happens:**
- Operation appears to fail but actually succeeded
- User retries → Idempotency prevents duplicate

**Handling:**
- ✅ Check idempotency key first
- ✅ If completed → Return cached result
- ✅ If in progress → Wait for completion

---

## Data Consistency Guarantees

### Strong Consistency (Eventually Consistent)

**KV ↔ Stripe:**
- ✅ KV updated immediately after Stripe operations
- ✅ If KV fails, Stripe is rolled back (where possible)
- ✅ **Guarantee:** KV reflects Stripe state within seconds

**D1 ↔ Stripe:**
- ✅ D1 updated after Stripe operations
- ✅ If D1 fails, queued for background sync
- ✅ **Guarantee:** D1 consistent within 24 hours

### Weak Consistency (Best Effort)

**License Keys:**
- ✅ Generated after payment
- ✅ If generation fails, retried on next webhook
- ✅ **Guarantee:** Licenses generated eventually

---

## Operation Examples

### Example 1: Remove Site (Success)

```
[remove_site_cus_123_example.com_1234567890] Starting operation
[remove_site_...] Fetching Stripe item for rollback backup: si_abc123
[remove_site_...] KV update successful (attempt 1)
[remove_site_...] Deleting Stripe subscription item: si_abc123
[remove_site_...] Updated license status in D1 for site: example.com
[remove_site_...] Site removal completed successfully
```

### Example 2: Remove Site (Failure with Rollback)

```
[remove_site_cus_123_example.com_1234567890] Starting operation
[remove_site_...] KV update successful (attempt 1)
[remove_site_...] Deleting Stripe subscription item: si_abc123
[remove_site_...] ERROR: Stripe deletion failed, rolling back KV update
[remove_site_...] Rolled back KV state
[remove_site_...] Operation failed: Stripe API error
```

### Example 3: Idempotent Retry

```
[remove_site_cus_123_example.com_1234567890] Starting operation
[remove_site_...] Operation already completed (idempotent)
→ Returns cached result (no duplicate operation)
```

---

## Monitoring & Reconciliation

### Operation Logs

All operations log:
- Operation ID (for tracking)
- Each step (KV, Stripe, D1)
- Success/Failure status
- Rollback status

**View logs:**
```bash
npx wrangler tail --format pretty
```

### Pending Sync Queue

D1 failures are stored in KV:
```
Key: sync_pending:{operationId}
Value: { operation, params, retryCount, lastAttempt }
```

**Manual reconciliation:**
1. Query pending operations
2. Retry failed D1 operations
3. Clean up after 7 days

### Consistency Checks

**Weekly checks:**
1. Compare Stripe subscription items with KV sites
2. Verify licenses match subscription items
3. Check for orphaned records

**Automated (Future):**
- Background job to sync D1 with Stripe
- Alert on inconsistencies
- Auto-reconciliation for common issues

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

### 2. Store Original State for Rollback

```javascript
const originalUserState = JSON.parse(JSON.stringify(user));
// ... perform operations ...
// If failure: await env.USERS_KV.put(userKey, JSON.stringify(originalUserState));
```

### 3. Use Retry Logic for All External Calls

```javascript
let success = false;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await operation();
    success = true;
    break;
  } catch (error) {
    if (attempt === 2) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
  }
}
```

### 4. Log Everything

```javascript
console.log(`[${operationId}] Starting operation`);
console.log(`[${operationId}] Step 1: KV update - SUCCESS`);
console.log(`[${operationId}] Step 2: Stripe delete - SUCCESS`);
console.log(`[${operationId}] Operation completed`);
```

---

## Limitations

### ⚠️ True ACID Not Possible

- Cannot have atomic transactions across KV, D1, and Stripe
- Some failures require manual reconciliation
- Background sync may take up to 24 hours

### ⚠️ Stripe Deletions Cannot Be Rolled Back

- Once a subscription item is deleted, it cannot be restored
- If KV update fails after Stripe deletion, we restore KV but item is gone
- Webhook will eventually sync state

### ⚠️ Network Partitions

- If systems are partitioned, operations may appear to fail
- Idempotency prevents duplicates
- Manual reconciliation may be needed

---

## Recommendations

1. **Monitor Operation Logs**
   - Set up alerts for high failure rates
   - Review rollback frequency
   - Check pending sync queue size

2. **Regular Reconciliation**
   - Weekly: Compare Stripe ↔ KV
   - Monthly: Verify D1 consistency
   - Quarterly: Audit orphaned records

3. **Background Sync Job** (Future)
   - Hourly: Retry pending D1 operations
   - Daily: Sync KV with Stripe
   - Weekly: Generate missing licenses

4. **Error Alerting**
   - High rollback rate → Investigate
   - Pending sync queue > 100 → Review
   - Stripe API errors → Check status

---

## Summary

**Consistency Model:** Eventually Consistent with Compensating Transactions

**Guarantees:**
- ✅ Stripe is source of truth for billing
- ✅ KV eventually consistent with Stripe (seconds)
- ✅ D1 eventually consistent with Stripe (24 hours)
- ✅ All operations are idempotent
- ✅ Automatic rollback on failure (where possible)

**Current Status:**
- ✅ Remove site: Fully implemented with rollback
- ✅ Add site (checkout): Webhook handles consistency
- ✅ License generation: Includes site mapping
- ⚠️ Direct add site: Not recommended (use checkout flow)

**Next Steps:**
1. Implement background sync job for D1
2. Add automated consistency checks
3. Set up error alerting
4. Create reconciliation dashboard

