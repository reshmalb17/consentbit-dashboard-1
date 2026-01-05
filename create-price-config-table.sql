-- Price Configuration Table
-- Stores monthly/yearly price IDs and discount/coupon settings
-- Run this to create the price_config table

CREATE TABLE IF NOT EXISTS price_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_type TEXT NOT NULL,  -- 'monthly' or 'yearly'
  price_id TEXT NOT NULL,  -- Stripe price ID (e.g., price_xxxxx)
  discount_allowance REAL DEFAULT 0,  -- Discount percentage (0-100) or fixed amount in cents
  discount_type TEXT DEFAULT 'percentage',  -- 'percentage' or 'fixed_amount'
  coupon_code TEXT,  -- Stripe coupon code (optional)
  is_active INTEGER DEFAULT 1,  -- 1 = active, 0 = inactive
  description TEXT,  -- Optional description
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(price_type)  -- Only one active price per type
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_price_config_price_type ON price_config(price_type);
CREATE INDEX IF NOT EXISTS idx_price_config_is_active ON price_config(is_active);
CREATE INDEX IF NOT EXISTS idx_price_config_price_id ON price_config(price_id);

-- Insert default records (update with your actual price IDs)
-- NOTE: These are PRODUCT IDs - you need to get the PRICE IDs from these products in Stripe
-- Monthly product: prod_Tg3C9VY4GhshdE
-- Yearly product: prod_Tg3AbI4uIip8oO
-- 
-- To get price IDs:
-- 1. Go to Stripe Dashboard → Products
-- 2. Click on the product (prod_Tg3C9VY4GhshdE for monthly)
-- 3. Find the price under "Pricing" section
-- 4. Copy the Price ID (starts with price_)
-- 5. Update the price_id values below

-- Monthly price (UPDATE price_id with actual price ID from prod_Tg3C9VY4GhshdE)
INSERT OR IGNORE INTO price_config (price_type, price_id, discount_allowance, discount_type, is_active, description)
VALUES ('monthly', 'price_UPDATE_WITH_MONTHLY_PRICE_ID', 0, 'percentage', 1, 'Monthly subscription price - Product: prod_Tg3C9VY4GhshdE');

-- Yearly price (UPDATE price_id with actual price ID from prod_Tg3AbI4uIip8oO)
INSERT OR IGNORE INTO price_config (price_type, price_id, discount_allowance, discount_type, is_active, description)
VALUES ('yearly', 'price_UPDATE_WITH_YEARLY_PRICE_ID', 0, 'percentage', 1, 'Yearly subscription price - Product: prod_Tg3AbI4uIip8oO');

