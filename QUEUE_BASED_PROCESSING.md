# Queue-Based Subscription Processing System

## Overview

This document describes the queue-based processing system implemented for handling large quantity subscription purchases. This system prevents webhook timeouts and provides a production-ready solution for processing subscriptions asynchronously.

## Architecture

### Components

1. **Subscription Queue Table** (`subscription_queue`)
   - Stores pending subscription creation tasks
   - Tracks processing status, retry attempts, and errors
   - Supports exponential backoff for failed items

2. **Queue Functions**
   - `addToSubscriptionQueue()` - Adds subscription tasks to queue
   - `processQueueItem()` - Processes a single queue item
   - `processSubscriptionQueue()` - Processes multiple queue items

3. **Queue Endpoints**
   - `POST /process-queue` - Manually trigger queue processing
   - `GET /queue-status?payment_intent_id=xxx` - Check queue status

## How It Works

### Automatic Queue Mode

When a quantity purchase exceeds the threshold (default: 10 subscriptions):

1. **Webhook receives payment** (`checkout.session.completed`)
2. **Decision Point**: 
   - Quantity ≤ 10: **IMMEDIATE MODE** - Process all subscriptions immediately
   - Quantity > 10: **QUEUE MODE** - Add to queue for async processing
3. **Queue Mode Behavior**:
   - All subscriptions are added to `subscription_queue` table
   - First 5 subscriptions are processed immediately (for user feedback)
   - Remaining subscriptions are queued for background processing
   - Webhook returns quickly (prevents timeout)

### Queue Processing

Queue items are processed asynchronously:

1. **Status Flow**: `pending` → `processing` → `completed` or `failed`
2. **Retry Logic**: 
   - Failed items are retried up to 3 times
   - Exponential backoff: 2min, 4min, 8min
   - After 3 failures, status becomes `failed`
3. **Automatic License Saving**: Licenses are saved to database when subscriptions are created

## Database Schema

```sql
CREATE TABLE subscription_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  license_key TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  trial_end INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  error_message TEXT,
  subscription_id TEXT,
  item_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  processed_at INTEGER,
  next_retry_at INTEGER
);
```

## API Endpoints

### POST /process-queue

Processes pending queue items.

**Request:**
```json
{
  "limit": 10  // Optional: number of items to process (default: 10)
}
```

**Response:**
```json
{
  "processed": 10,
  "successCount": 8,
  "failCount": 2
}
```

### GET /queue-status

Get queue status for a payment intent.

**Request:**
```
GET /queue-status?payment_intent_id=pi_xxx
```

**Response:**
```json
{
  "total": 15,
  "pending": 5,
  "processing": 2,
  "completed": 7,
  "failed": 1,
  "items": [...]
}
```

## Usage Examples

### Manual Queue Processing

```bash
# Process up to 20 queue items
curl -X POST https://your-worker.workers.dev/process-queue \
  -H "Content-Type: application/json" \
  -d '{"limit": 20}'
```

### Check Queue Status

```bash
# Check status for a payment
curl "https://your-worker.workers.dev/queue-status?payment_intent_id=pi_xxx"
```

### Scheduled Processing (Recommended for Production)

Set up a Cloudflare Cron Trigger to process the queue automatically:

**wrangler.toml:**
```toml
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes
```

**In your worker:**
```javascript
export default {
  async scheduled(event, env, ctx) {
    // Process queue every 5 minutes
    await processSubscriptionQueue(env, 50);
  },
  async fetch(request, env) {
    // ... existing code
  }
}
```

## Configuration

### Queue Threshold

The threshold for using queue mode can be adjusted:

```javascript
const USE_QUEUE_THRESHOLD = 10; // Use queue for quantities > 10
```

### Retry Configuration

```javascript
const maxAttempts = 3; // Maximum retry attempts
const backoffMultiplier = 2; // Exponential backoff: 2min, 4min, 8min
```

## Benefits

1. **Prevents Timeouts**: Large quantities don't cause webhook timeouts
2. **Reliable Processing**: Failed items are automatically retried
3. **Scalable**: Can handle any quantity (100, 1000, etc.)
4. **Production Ready**: Includes error handling, retries, and monitoring
5. **User Feedback**: First batch processed immediately for instant feedback

## Monitoring

### Queue Health Checks

Monitor queue status regularly:

```sql
-- Check pending items
SELECT COUNT(*) FROM subscription_queue WHERE status = 'pending';

-- Check failed items
SELECT COUNT(*) FROM subscription_queue WHERE status = 'failed';

-- Check items stuck in processing
SELECT * FROM subscription_queue 
WHERE status = 'processing' 
AND updated_at < (unixepoch() - 300);  -- Stuck for > 5 minutes
```

### Alerts

Set up alerts for:
- High number of failed items
- Items stuck in processing
- Queue backlog growing too large

## Migration from Immediate Processing

The system automatically uses queue mode for quantities > 10. No migration needed - it's backward compatible:

- Quantities ≤ 10: Works exactly as before (immediate processing)
- Quantities > 10: Automatically uses queue mode

## Future Enhancements

1. **Cloudflare Queues**: Migrate to native Cloudflare Queues for better performance
2. **Webhook Retry**: Automatic retry of failed webhook processing
3. **Queue Dashboard**: Admin UI for monitoring and managing queue
4. **Priority Queue**: Process urgent items first
5. **Batch Processing**: Process multiple items in parallel within queue

