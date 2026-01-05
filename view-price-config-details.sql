-- View all price_config details
-- Shows complete configuration for monthly and yearly pricing

SELECT 
    id,
    price_type,
    price_id,
    product_id,
    unit_amount,
    (unit_amount / 100.0) as price_in_dollars,
    currency,
    discount_allowance,
    discount_type,
    coupon_code,
    is_active,
    description,
    datetime(created_at, 'unixepoch') as created_at,
    datetime(updated_at, 'unixepoch') as updated_at
FROM price_config
WHERE price_type IN ('monthly', 'yearly')
ORDER BY price_type;

-- Summary view
SELECT 
    price_type,
    CASE 
        WHEN unit_amount IS NOT NULL THEN '$' || (unit_amount / 100.0) || ' per license'
        ELSE 'Not set'
    END as price_per_license,
    product_id,
    currency,
    CASE 
        WHEN is_active = 1 THEN 'Active'
        ELSE 'Inactive'
    END as status
FROM price_config
WHERE price_type IN ('monthly', 'yearly')
ORDER BY price_type;
