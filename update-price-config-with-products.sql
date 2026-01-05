-- Update Price Config Table with Product Information
-- 
-- PRODUCT IDs PROVIDED:
-- Monthly Product: prod_Tg3C9VY4GhshdE
-- Yearly Product: prod_Tg3AbI4uIip8oO
--
-- IMPORTANT: You need to get the PRICE IDs from these products in Stripe Dashboard
-- The price_config table stores price_id, not product_id
--
-- Steps to get Price IDs:
-- 1. Go to Stripe Dashboard → Products
-- 2. Click on product: prod_Tg3C9VY4GhshdE (monthly)
-- 3. Look under "Pricing" section
-- 4. Copy the Price ID (starts with price_)
-- 5. Repeat for prod_Tg3AbI4uIip8oO (yearly)
--
-- Then run the UPDATE commands below with your actual price IDs

-- Update monthly price (REPLACE price_xxxxx with actual monthly price ID from prod_Tg3C9VY4GhshdE)
UPDATE price_config 
SET price_id = 'price_xxxxx',  -- ← REPLACE WITH ACTUAL MONTHLY PRICE ID
    description = 'Monthly subscription price - Product: prod_Tg3C9VY4GhshdE',
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly price (REPLACE price_xxxxx with actual yearly price ID from prod_Tg3AbI4uIip8oO)
UPDATE price_config 
SET price_id = 'price_xxxxx',  -- ← REPLACE WITH ACTUAL YEARLY PRICE ID
    description = 'Yearly subscription price - Product: prod_Tg3AbI4uIip8oO',
    updated_at = unixepoch()
WHERE price_type = 'yearly';

-- If records don't exist, insert them
INSERT OR IGNORE INTO price_config (price_type, price_id, discount_allowance, discount_type, is_active, description)
VALUES 
  ('monthly', 'price_xxxxx', 0, 'percentage', 1, 'Monthly subscription price - Product: prod_Tg3C9VY4GhshdE'),
  ('yearly', 'price_xxxxx', 0, 'percentage', 1, 'Yearly subscription price - Product: prod_Tg3AbI4uIip8oO');

