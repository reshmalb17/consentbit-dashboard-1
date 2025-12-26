-- Add billing_period column to subscriptions table
-- This column stores the recurring billing frequency: 'monthly', 'yearly', 'weekly', 'daily'

ALTER TABLE subscriptions ADD COLUMN billing_period TEXT;

-- Add index for faster queries by billing period (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_period ON subscriptions(billing_period);

