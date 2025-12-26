# Queue Processing Flow - Database & Dashboard Updates

## Overview

This document explains what happens after queue processing triggers subscription creation, including database updates, dashboard updates, and retry behavior.

## Complete Flow

### 1. Queue Processing Triggers Subscription Creation

When the queue is processed (via cron or manual trigger):

```
POST /process-queue → processSubscriptionQueue() → processQueueItem()
```

### 2. Successful Subscription Creation

When a subscription is **successfully created**, the following happens:

#### ✅ Database Updates (Automatic)

1. **Queue Table** (`subscription_queue`)
   - Status updated to `'completed'`
   - `subscription_id` and `item_id` saved
   - `processed_at` timestamp recorded

2. **Licenses Table** (`licenses`)
   - License key saved with `subscription_id`
   - Status: `'active'`
   - Purchase type: `'quantity'`
   - **Dashboard will show this license immediately**

3. **Subscriptions Table** (`subscriptions`)
   - Subscription record created/updated
   - Status, billing period, dates saved
   - **Dashboard will show this subscription**

4. **Payments Table** (`payments`)
   - Payment record created
   - Amount, currency, status saved
   - **Dashboard will show payment history**

#### ✅ Dashboard Updates (Automatic)

The dashboard automatically shows new data because:

1. **License Display**: Dashboard fetches from `/licenses?email=xxx` endpoint
   - This queries the `licenses` table
   - Since licenses are saved immediately after queue processing, they appear on next dashboard load

2. **Subscription Display**: Dashboard fetches from `/dashboard?email=xxx` endpoint
   - This queries the `subscriptions` table
   - New subscriptions appear automatically

3. **Payment History**: Dashboard shows payment records
   - Payment records are saved with each subscription
   - Appears in payment history section

**Note**: Dashboard may need a refresh to show new data (browser refresh or auto-refresh)

---

## 3. Failed Subscription Creation - Retry Logic

When subscription creation **fails**, the system automatically retries:

### Retry Behavior

1. **First Failure** (Attempt 1/3)
   - Status: `'pending'` (ready for retry)
   - `next_retry_at`: Current time + 2 minutes
   - Error message saved
   - **Will retry automatically**

2. **Second Failure** (Attempt 2/3)
   - Status: `'pending'` (ready for retry)
   - `next_retry_at`: Current time + 4 minutes (exponential backoff)
   - Error message updated
   - **Will retry automatically**

3. **Third Failure** (Attempt 3/3)
   - Status: `'pending'` (ready for retry)
   - `next_retry_at`: Current time + 8 minutes (exponential backoff)
   - Error message updated
   - **Will retry automatically**

4. **Final Failure** (After 3 attempts)
   - Status: `'failed'` (no more retries)
   - `next_retry_at`: `null`
   - Error message saved
   - **Requires manual intervention**

### Retry Schedule

| Attempt | Wait Time | Total Time Since First Failure |
|---------|-----------|-------------------------------|
| 1       | Immediate | 0 minutes                     |
| 2       | 2 minutes | 2 minutes                     |
| 3       | 4 minutes | 6 minutes                     |
| 4       | 8 minutes | 14 minutes                    |
| Final   | N/A       | Status: `failed` + **Automatic Refund** ✅ |

### Automatic Retry Processing

The cron job (every 5 minutes) automatically processes items ready for retry:

```sql
SELECT * FROM subscription_queue 
WHERE status = 'pending' 
AND (next_retry_at IS NULL OR next_retry_at <= current_timestamp)
```

This means:
- Items with `next_retry_at` in the past are automatically retried
- No manual intervention needed for retries
- Failed items (after 3 attempts) are marked and won't retry

---

## Monitoring Failed Items

### Check Failed Items

```bash
# Get queue status for a payment
GET /queue-status?payment_intent_id=pi_xxx
```

Response shows:
```json
{
  "total": 15,
  "pending": 0,
  "processing": 0,
  "completed": 12,
  "failed": 3,
  "items": [
    {
      "queue_id": "...",
      "license_key": "KEY-XXXX-...",
      "status": "failed",
      "attempts": 3,
      "error_message": "Subscription creation failed: 400 - {...}",
      "subscription_id": null
    }
  ]
}
```

### Manual Retry of Failed Items

If an item fails after 3 attempts, you can manually retry:

1. **Option 1**: Update the queue item to reset attempts
   ```sql
   UPDATE subscription_queue 
   SET status = 'pending', attempts = 0, next_retry_at = NULL 
   WHERE queue_id = 'queue_xxx';
   ```

2. **Option 2**: Create a manual retry endpoint (future enhancement)

---

## Example Scenarios

### Scenario 1: All Subscriptions Succeed

**Purchase**: 15 subscriptions
**Queue Processing**: 
- 5 processed immediately (webhook)
- 10 queued
- Cron processes queue every 5 minutes

**Result**:
- ✅ All 15 licenses saved to database
- ✅ All 15 subscriptions in subscriptions table
- ✅ All 15 payment records saved
- ✅ Dashboard shows all 15 licenses immediately

### Scenario 2: Some Failures, Then Success

**Purchase**: 15 subscriptions
**Queue Processing**:
- 12 succeed immediately
- 3 fail (network error)

**Retry Behavior**:
- Failed items retry after 2 minutes
- 2 succeed on retry
- 1 fails again, retries after 4 minutes
- Final item succeeds on 2nd retry

**Result**:
- ✅ All 15 licenses eventually saved
- ✅ Dashboard shows all 15 licenses (may take up to 14 minutes for all)

### Scenario 3: Permanent Failure

**Purchase**: 15 subscriptions
**Queue Processing**:
- 14 succeed
- 1 fails (invalid price ID - permanent error)

**Retry Behavior**:
- Item retries 3 times (2min, 4min, 8min intervals)
- All retries fail
- Status set to `'failed'`
- No more automatic retries

**Result**:
- ✅ 14 licenses saved and visible in dashboard
- ❌ 1 license not created (permanently failed)
- ✅ **Automatic refund processed** for failed subscription
- 💰 Refund amount: Price per subscription (e.g., $200)
- 📝 Refund ID saved in queue item error message

---

## Dashboard Refresh Behavior

### Automatic Updates

The dashboard **does NOT auto-refresh** by default. Users need to:

1. **Manual Refresh**: Click refresh button or reload page
2. **Auto-Refresh** (if implemented): Dashboard polls `/licenses` endpoint periodically

### Recommended: Add Auto-Refresh

For better UX, consider adding auto-refresh to dashboard:

```javascript
// Auto-refresh licenses every 30 seconds
setInterval(() => {
  loadLicenseKeys(userEmail);
}, 30000);
```

---

## Summary

### ✅ What Happens on Success

1. **Database**: License, subscription, and payment records saved immediately
2. **Dashboard**: Shows new data on next refresh/load
3. **Queue**: Item marked as `'completed'`

### 🔄 What Happens on Failure

1. **Retry**: Automatically retries up to 3 times with exponential backoff
2. **Database**: Queue item updated with error message and retry time
3. **Dashboard**: Won't show failed items (no license created)
4. **Final State**: After 3 failures:
   - Status becomes `'failed'`
   - **Automatic refund processed** ✅
   - Refund amount: Price per subscription
   - Refund ID saved in error message
   - Customer receives refund automatically

### 📊 Monitoring

- Use `/queue-status` endpoint to check processing status
- Monitor logs for retry attempts
- Failed items are automatically refunded (no manual intervention needed)
- Check refund status in Stripe dashboard or queue item error message

### 💰 Automatic Refund Details

When a subscription creation fails after 3 retry attempts:

1. **Refund Calculation**:
   - Primary: Uses price from Stripe (`price.unit_amount`)
   - Fallback: Divides payment intent amount by total quantity

2. **Refund Processing**:
   - Creates refund via Stripe API
   - Refund ID saved in queue item error message
   - Metadata includes: reason, queue_id, license_key, payment_intent_id, attempts

3. **Refund Metadata**:
   ```json
   {
     "reason": "subscription_creation_failed_after_retries",
     "queue_id": "queue_xxx",
     "license_key": "KEY-XXXX-...",
     "payment_intent_id": "pi_xxx",
     "attempts": "3"
   }
   ```

4. **Error Message Format**:
   ```
   Original error message | REFUNDED: re_xxx (20000 usd)
   ```

