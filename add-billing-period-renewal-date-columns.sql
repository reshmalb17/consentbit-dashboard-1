-- Migration: Add billing_period and renewal_date columns to licenses and subscription_items tables
-- Run this migration to add the new columns

-- Add billing_period and renewal_date to licenses table
ALTER TABLE licenses ADD COLUMN billing_period TEXT;
ALTER TABLE licenses ADD COLUMN renewal_date INTEGER;

-- Add billing_period and renewal_date to subscription_items table
ALTER TABLE subscription_items ADD COLUMN billing_period TEXT;
ALTER TABLE subscription_items ADD COLUMN renewal_date INTEGER;

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_licenses_billing_period ON licenses(billing_period);
CREATE INDEX IF NOT EXISTS idx_licenses_renewal_date ON licenses(renewal_date);
CREATE INDEX IF NOT EXISTS idx_subscription_items_billing_period ON subscription_items(billing_period);
CREATE INDEX IF NOT EXISTS idx_subscription_items_renewal_date ON subscription_items(renewal_date);

