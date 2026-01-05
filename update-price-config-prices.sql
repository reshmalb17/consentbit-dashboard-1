-- Update price_config table with monthly and yearly prices
-- Monthly: $8.00 per quantity (800 cents) - Product: prod_TiX0VbsXQSm4N5
-- Yearly: $72.00 per quantity (7200 cents) - Product: prod_TiX0CF9K1RSRyb

-- Update monthly price
UPDATE price_config 
SET unit_amount = 800,  -- $8.00 in cents
    product_id = 'prod_TiX0VbsXQSm4N5',  -- Monthly product ID
    currency = 'usd',
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly price
UPDATE price_config 
SET unit_amount = 7200,  -- $72.00 in cents
    product_id = 'prod_TiX0CF9K1RSRyb',  -- Yearly product ID
    currency = 'usd',
    updated_at = unixepoch()
WHERE price_type = 'yearly';

-- Verify the updates
SELECT 
    price_type,
    price_id,
    product_id,
    unit_amount,
    (unit_amount / 100.0) as price_in_dollars,
    currency,
    is_active,
    updated_at
FROM price_config
WHERE price_type IN ('monthly', 'yearly')
ORDER BY price_type;
