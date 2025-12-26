-- Clear all data from D1 database tables
-- This script safely deletes all rows from tables that exist
-- Run with: wrangler d1 execute consentbit-licenses --file=clear-all-data.sql --remote

-- Delete from tables (in reverse dependency order to avoid foreign key issues)
DELETE FROM idempotency_keys;
DELETE FROM pending_sites;
DELETE FROM subscription_items;
DELETE FROM licenses;
DELETE FROM sites;
DELETE FROM payments;
DELETE FROM subscriptions;
DELETE FROM customers;
DELETE FROM users;
DELETE FROM magic_link_tokens;

