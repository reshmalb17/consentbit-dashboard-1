-- D1 Database Schema for License Management
-- Run this to create your D1 database tables

-- Payments/Subscriptions table - stores payment details
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'succeeded',
  site_domain TEXT,
  magic_link TEXT,
  magic_link_generated INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sites table - stores detailed site information including renewal dates and amounts
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  item_id TEXT,
  site_domain TEXT NOT NULL,
  price_id TEXT,
  amount_paid INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start INTEGER,
  current_period_end INTEGER,
  renewal_date INTEGER,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Licenses table - license_key is the primary identifier
CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  item_id TEXT,
  site_domain TEXT,
  used_site_domain TEXT,  -- Site where license is actually used/activated
  status TEXT NOT NULL DEFAULT 'active',
  purchase_type TEXT DEFAULT 'site',  -- 'site' or 'quantity'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- REMOVED: Magic Link Tokens table - Not needed (Memberstack handles login)

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_subscription_id ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email);
CREATE INDEX IF NOT EXISTS idx_licenses_customer_id ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_subscription_id ON licenses(subscription_id);
CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_site_domain ON licenses(site_domain);
CREATE INDEX IF NOT EXISTS idx_sites_customer_id ON sites(customer_id);
CREATE INDEX IF NOT EXISTS idx_sites_subscription_id ON sites(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sites_site_domain ON sites(site_domain);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_item_id ON sites(item_id);
CREATE INDEX IF NOT EXISTS idx_sites_renewal_date ON sites(renewal_date);

-- REMOVED: Magic link token indexes - Not needed

-- Users table - stores user data (replaces KV storage)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Customers table - stores customer data linked to users
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
  UNIQUE(user_email, customer_id)
);

-- Subscriptions table - stores subscription data
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cancel_at_period_end INTEGER DEFAULT 0,
  cancel_at INTEGER,
  current_period_start INTEGER,
  current_period_end INTEGER,
  billing_period TEXT,  -- Recurring billing frequency: 'monthly', 'yearly', 'weekly', 'daily'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
  UNIQUE(subscription_id)
);

-- Subscription items table - stores individual items in subscriptions
CREATE TABLE IF NOT EXISTS subscription_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  site_domain TEXT NOT NULL,
  price_id TEXT,
  quantity INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  removed_at INTEGER,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  UNIQUE(item_id)
);

-- Pending sites table - stores pending sites before payment
CREATE TABLE IF NOT EXISTS pending_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  subscription_id TEXT,
  site_domain TEXT NOT NULL,
  price_id TEXT,
  quantity INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
  UNIQUE(user_email, site_domain)
);

-- Create indexes for users and related tables
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_customers_user_email ON customers(user_email);
CREATE INDEX IF NOT EXISTS idx_customers_customer_id ON customers(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_email ON subscriptions(user_email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id ON subscriptions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_period ON subscriptions(billing_period);
CREATE INDEX IF NOT EXISTS idx_subscription_items_subscription_id ON subscription_items(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_items_item_id ON subscription_items(item_id);
CREATE INDEX IF NOT EXISTS idx_subscription_items_site_domain ON subscription_items(site_domain);
CREATE INDEX IF NOT EXISTS idx_subscription_items_status ON subscription_items(status);
CREATE INDEX IF NOT EXISTS idx_pending_sites_user_email ON pending_sites(user_email);
CREATE INDEX IF NOT EXISTS idx_pending_sites_subscription_id ON pending_sites(subscription_id);

-- Idempotency keys table - stores idempotency keys for operations
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  operation_data TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_operation_id ON idempotency_keys(operation_id);

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

CREATE INDEX IF NOT EXISTS idx_subscription_queue_status ON subscription_queue(status);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_customer_id ON subscription_queue(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_payment_intent_id ON subscription_queue(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_next_retry_at ON subscription_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_subscription_queue_queue_id ON subscription_queue(queue_id);

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
