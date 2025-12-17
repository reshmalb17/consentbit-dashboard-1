# Payment Failure Handling - What Happens If Operations Fail After Payment

## Overview

**Critical Principle:** Once Stripe processes a payment successfully, the customer has **already paid**. We must **never** fail the webhook response, as this would cause Stripe to retry and potentially create duplicate operations.

## What Happens If Payment Succeeds But Operations Fail?

### 1. **Payment is Already Successful**
- ✅ Customer's payment is processed by Stripe
- ✅ Subscription is created/updated in Stripe
- ✅ Customer has access via Stripe subscription
- ❌ **BUT** our internal operations (KV, D1, license generation) might fail

### 2. **Automatic Retry Logic (3 Attempts)**

All critical operations now have **automatic retry with exponential backoff**:

- **Attempt 1:** Immediate
- **Attempt 2:** Wait 1 second, retry
- **Attempt 3:** Wait 2 seconds, retry
- **If all fail:** Queue for background retry

#### Operations with Retry:
1. ✅ **Session KV Save** - Magic link session token
2. ✅ **Payment D1 Save** - Payment record in database
3. ✅ **User Sites KV Save** - Site mappings (CRITICAL)
4. ✅ **License D1 Save** - License keys in database
5. ✅ **License KV Save** - License keys in KV
6. ✅ **Payment Key KV Save** - Payment metadata

### 3. **Background Retry Queue**

If an operation fails after 3 attempts, it's queued in KV with key pattern:
```
sync_pending:{operation_type}_{operationId}
```

**Queued Operations Include:**
- All data needed to retry the operation
- Timestamp for tracking
- Retry count (starts at 0)

**Example Queue Keys:**
- `sync_pending:payment_payment_cus_xxx_sub_xxx_1234567890`
- `sync_pending:licenses_payment_cus_xxx_sub_xxx_1234567890`
- `sync_pending:user_sites_payment_cus_xxx_sub_xxx_1234567890`

### 4. **Always Return 'ok' to Stripe**

**CRITICAL:** The webhook handler **always** returns `200 OK` to Stripe, even if operations fail.

**Why?**
- Payment is already successful
- Customer has access via Stripe
- Returning an error would cause Stripe to retry the webhook
- Retries could create duplicate operations or data inconsistencies

### 5. **Error Logging and Tracking**

All failures are logged with:
- **Operation ID:** Unique ID for tracking (`payment_{customerId}_{subscriptionId}_{timestamp}`)
- **Operation Type:** What failed (e.g., `save_payment`, `save_licenses`)
- **Error Details:** Full error message and stack trace
- **Data:** All data needed to retry the operation

**Log Format:**
```
[operationId] ⚠️  WARNING: X operation(s) failed after payment:
[operationId] Failed operation 1: save_payment - Database connection timeout
[operationId] These operations have been queued for background retry
[operationId] Payment is successful - customer has access via Stripe subscription
```

### 6. **What Customer Experiences**

**If Operations Succeed:**
- ✅ Dashboard shows all sites
- ✅ License keys are available
- ✅ Magic link works
- ✅ Everything is in sync

**If Operations Fail:**
- ✅ **Customer still has access** (via Stripe subscription)
- ✅ **Payment is successful** (money is paid)
- ⚠️ Dashboard might not show sites immediately
- ⚠️ License keys might not be available immediately
- ⚠️ Magic link might not work immediately

**But:** Operations are queued for retry, so data will sync eventually.

### 7. **Manual Recovery Process**

If operations fail, you can manually recover by:

1. **Check Worker Logs:**
   ```bash
   npx wrangler tail
   ```
   Look for `[operationId]` entries and failed operations.

2. **Check Queue in KV:**
   ```bash
   npx wrangler kv:key list --namespace-id=YOUR_NAMESPACE_ID | grep sync_pending
   ```

3. **Retry Queued Operations:**
   - Read the queued operation from KV
   - Execute the operation manually
   - Delete the queue entry

4. **Verify Data:**
   - Check D1 database for payment/license records
   - Check KV for user sites
   - Compare with Stripe subscription items

### 8. **Prevention Strategies**

**To Minimize Failures:**

1. **Monitor KV/D1 Health:**
   - Set up alerts for high error rates
   - Monitor retry queue size

2. **Database Connection Pooling:**
   - Ensure D1 connections are stable
   - Handle connection timeouts gracefully

3. **KV Rate Limits:**
   - Be aware of KV write limits
   - Batch operations when possible

4. **Idempotency:**
   - All operations are idempotent (safe to retry)
   - Duplicate checks prevent data corruption

### 9. **Example Failure Scenario**

**Scenario:** Payment succeeds, but D1 database is temporarily unavailable.

**What Happens:**
1. ✅ Payment processed by Stripe
2. ✅ Subscription created in Stripe
3. ✅ Customer has access
4. ❌ D1 save fails (connection timeout)
5. 🔄 Retry 1: Fails
6. 🔄 Retry 2: Fails
7. 🔄 Retry 3: Fails
8. 📦 Operation queued: `sync_pending:payment_...`
9. ✅ Webhook returns `200 OK` to Stripe
10. 📝 Error logged with full details
11. 🔄 Background process can retry later

**Customer Impact:**
- Payment successful ✅
- Access granted ✅
- Payment record missing (will be created on retry) ⚠️

### 10. **Code Implementation**

**Key Features:**
- Exponential backoff retry (1s, 2s delays)
- Operation tracking with unique IDs
- Failed operation queueing
- Comprehensive error logging
- Always return 'ok' to Stripe

**Location:** `src/index.js` - `checkout.session.completed` webhook handler (lines 289-900)

## Summary

✅ **Payment Success = Customer Has Access** (via Stripe)
✅ **Operations Fail = Data Sync Delayed** (but queued for retry)
✅ **Webhook Always Returns 'ok'** (prevents Stripe retries)
✅ **All Failures Are Logged** (for manual review)
✅ **Operations Are Queued** (for background retry)

**Bottom Line:** Even if our operations fail, the customer has paid and has access. We queue failed operations for retry and log everything for manual recovery if needed.

