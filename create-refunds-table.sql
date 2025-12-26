-- Create refunds table for tracking refund transactions
-- Run this to add the refunds table to your D1 database
-- Usage: wrangler d1 execute consentbit-licenses --file=create-refunds-table.sql

-- Refunds table - stores refund transaction records
-- Tracks all refunds including automatic refunds for failed subscriptions
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id TEXT NOT NULL UNIQUE,  -- Stripe refund ID (e.g., re_xxx)
  payment_intent_id TEXT NOT NULL,  -- Stripe payment intent ID (e.g., pi_xxx)
  charge_id TEXT NOT NULL,  -- Stripe charge ID (e.g., ch_xxx)
  customer_id TEXT NOT NULL,  -- Stripe customer ID (e.g., cus_xxx)
  user_email TEXT,  -- User email (optional, for easier lookups)
  amount INTEGER NOT NULL,  -- Refund amount in cents (e.g., 20000 = $200.00)
  currency TEXT NOT NULL DEFAULT 'usd',  -- Currency code
  status TEXT NOT NULL DEFAULT 'succeeded',  -- Refund status: 'succeeded', 'pending', 'failed'
  reason TEXT,  -- Refund reason (e.g., 'subscription_creation_failed_after_retries')
  queue_id TEXT,  -- Queue ID if refund was from queue processing
  license_key TEXT,  -- License key if refund was for a specific license
  subscription_id TEXT,  -- Subscription ID if refund was for a subscription
  attempts INTEGER,  -- Number of attempts before refund (for queue items)
  metadata TEXT,  -- JSON string of additional metadata
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),  -- When refund was created
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())  -- When refund was last updated
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_refunds_refund_id ON refunds(refund_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment_intent_id ON refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_charge_id ON refunds(charge_id);
CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_email ON refunds(user_email);
CREATE INDEX IF NOT EXISTS idx_refunds_queue_id ON refunds(queue_id);
CREATE INDEX IF NOT EXISTS idx_refunds_license_key ON refunds(license_key);
CREATE INDEX IF NOT EXISTS idx_refunds_subscription_id ON refunds(subscription_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds(created_at);

-- Verify table was created
SELECT name FROM sqlite_master WHERE type='table' AND name='refunds';

