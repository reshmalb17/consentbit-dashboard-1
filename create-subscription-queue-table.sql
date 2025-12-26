-- Create subscription_queue table for queue-based subscription processing
-- Run this to add the queue table to your D1 database
-- Usage: wrangler d1 execute consentbit-licenses --file=create-subscription-queue-table.sql

-- Subscription queue table - stores pending subscription creation tasks
-- Used for queue-based processing of large quantity purchases
CREATE TABLE IF NOT EXISTS subscription_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id TEXT NOT NULL UNIQUE,  -- Unique identifier for this queue job
  customer_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  license_key TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  trial_end INTEGER,  -- Unix timestamp for trial_end
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER DEFAULT 0,  -- Number of processing attempts
  max_attempts INTEGER DEFAULT 3,  -- Maximum retry attempts
  error_message TEXT,  -- Error message if processing failed
  subscription_id TEXT,  -- Created subscription ID (when completed)
  item_id TEXT,  -- Created subscription item ID (when completed)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER,  -- When subscription was successfully created
  next_retry_at INTEGER  -- When to retry if failed (exponential backoff)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_subscription_queue_status ON subscription_queue(status);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_customer_id ON subscription_queue(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_payment_intent_id ON subscription_queue(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_next_retry_at ON subscription_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_queue_id ON subscription_queue(queue_id);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_license_key ON subscription_queue(license_key);

-- Verify table was created
SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_queue';

