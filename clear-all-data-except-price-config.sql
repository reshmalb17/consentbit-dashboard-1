-- Clear all data from all tables except price_config
-- This script deletes all data but keeps the table structures intact
-- Run with: wrangler d1 execute consentbit-licenses --remote --file=clear-all-data-except-price-config.sql

-- Disable foreign key checks temporarily for faster deletion
PRAGMA foreign_keys = OFF;

-- Delete data from tables (order matters for foreign key constraints)
-- Start with child tables first, then parent tables

-- Delete from subscription_items (references subscriptions)
DELETE FROM subscription_items;

-- Delete from pending_sites (references users)
DELETE FROM pending_sites;

-- Delete from licenses (no foreign keys, but references other tables)
DELETE FROM licenses;

-- Delete from sites (no foreign keys)
DELETE FROM sites;

-- Delete from payments (no foreign keys)
DELETE FROM payments;

-- Delete from subscription_queue (no foreign keys)
DELETE FROM subscription_queue;

-- Delete from refunds (no foreign keys)
DELETE FROM refunds;

-- Delete from idempotency_keys (no foreign keys)
DELETE FROM idempotency_keys;

-- Delete from subscriptions (references users and customers)
DELETE FROM subscriptions;

-- Delete from customers (references users)
DELETE FROM customers;

-- Delete from users (parent table)
DELETE FROM users;

-- Re-enable foreign key checks
PRAGMA foreign_keys = ON;

-- Verify price_config still has data
SELECT COUNT(*) as price_config_count FROM price_config;

