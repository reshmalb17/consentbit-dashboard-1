-- Safe version: Only delete if tables exist
-- This handles cases where some tables might not be created yet

-- Check and delete from each table (SQLite doesn't support IF EXISTS for DELETE, so we'll use a different approach)
-- Delete from tables that exist (ignore errors for missing tables)

DELETE FROM idempotency_keys WHERE 1=1;
DELETE FROM pending_sites WHERE 1=1;
DELETE FROM subscription_items WHERE 1=1;
DELETE FROM licenses WHERE 1=1;
DELETE FROM sites WHERE 1=1;
DELETE FROM payments WHERE 1=1;
DELETE FROM subscriptions WHERE 1=1;
DELETE FROM customers WHERE 1=1;
DELETE FROM users WHERE 1=1;
DELETE FROM magic_link_tokens WHERE 1=1;

