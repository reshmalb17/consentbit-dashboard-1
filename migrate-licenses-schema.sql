-- Migration script to update licenses table schema
-- Run this to update existing licenses table to use license_key as primary key

-- Step 1: Create new table with updated schema
CREATE TABLE IF NOT EXISTS licenses_new (
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

-- Step 2: Copy data from old table to new table
INSERT INTO licenses_new (
  license_key, customer_id, subscription_id, item_id, site_domain, 
  status, purchase_type, created_at, updated_at
)
SELECT 
  license_key, 
  customer_id, 
  subscription_id,
  NULL as item_id,  -- May not exist in old schema
  site_domain,
  status,
  'site' as purchase_type,  -- Default to 'site' for existing licenses
  created_at,
  updated_at
FROM licenses;

-- Step 3: Drop old table
DROP TABLE IF EXISTS licenses;

-- Step 4: Rename new table to licenses
ALTER TABLE licenses_new RENAME TO licenses;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_licenses_customer_id ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_subscription_id ON licenses(subscription_id);
CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_site_domain ON licenses(site_domain);
CREATE INDEX IF NOT EXISTS idx_licenses_used_site_domain ON licenses(used_site_domain);

