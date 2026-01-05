-- Create stripe_logs table for storing Stripe webhook events
-- This table stores all Stripe webhook events for debugging and tracking

CREATE TABLE IF NOT EXISTS stripe_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    date TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    subscription_id TEXT,
    customer_id TEXT,
    event_data TEXT,
    additional_data TEXT,
    created_at INTEGER NOT NULL
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_stripe_logs_date ON stripe_logs(date);
CREATE INDEX IF NOT EXISTS idx_stripe_logs_subscription_id ON stripe_logs(subscription_id);
CREATE INDEX IF NOT EXISTS idx_stripe_logs_customer_id ON stripe_logs(customer_id);
CREATE INDEX IF NOT EXISTS idx_stripe_logs_event_type ON stripe_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_stripe_logs_timestamp ON stripe_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_stripe_logs_event_id ON stripe_logs(event_id);

