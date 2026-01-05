-- Add product_id and unit_amount columns to price_config table
-- This allows storing product_id and unit_amount directly in database
-- to reduce Stripe API calls and improve performance

-- Add product_id column (Stripe product ID, e.g., prod_xxxxx)
ALTER TABLE price_config ADD COLUMN product_id TEXT;

-- Add unit_amount column (price in cents, e.g., 1000 = $10.00)
ALTER TABLE price_config ADD COLUMN unit_amount INTEGER;

-- Add currency column (optional, defaults to 'usd' if not set)
ALTER TABLE price_config ADD COLUMN currency TEXT DEFAULT 'usd';

-- Create index on product_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_price_config_product_id ON price_config(product_id);

-- Example: Update existing records with product_id and unit_amount
-- (Replace with your actual values from Stripe)
-- 
-- UPDATE price_config 
-- SET product_id = 'prod_Tg3C9VY4GhshdE',
--     unit_amount = 1000,
--     currency = 'usd',
--     updated_at = unixepoch()
-- WHERE price_type = 'monthly';
--
-- UPDATE price_config 
-- SET product_id = 'prod_Tg3AbI4uIip8oO',
--     unit_amount = 10000,
--     currency = 'usd',
--     updated_at = unixepoch()
-- WHERE price_type = 'yearly';
