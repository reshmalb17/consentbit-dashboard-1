# Price Configuration Table Setup Guide

This guide explains how to set up and use the `price_config` table to manage monthly/yearly price IDs, discounts, and coupon codes.

---

## 📋 Overview

The `price_config` table allows you to:
- ✅ Store monthly and yearly Stripe price IDs in the database
- ✅ Configure discount allowances (percentage or fixed amount)
- ✅ Set up coupon codes for future use
- ✅ Update prices without redeploying code
- ✅ Enable/disable specific price types

---

## 🚀 Quick Start

### Step 1: Create the Table

Run the SQL migration to create the table:

```bash
# Using PowerShell (Windows)
.\create-price-config-table.ps1

# Or manually using wrangler
wrangler d1 execute consentbit-licenses --file=create-price-config-table.sql
```

### Step 2: Update Price IDs

Update the price IDs with your actual Stripe price IDs:

```sql
-- Update monthly price
UPDATE price_config 
SET price_id = 'price_1SiMxxxxx',  -- Your monthly price ID
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly price
UPDATE price_config 
SET price_id = 'price_1SiNyyyyy',  -- Your yearly price ID
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

### Step 3: Verify Setup

Check that prices are configured:

```bash
# Using API endpoint
curl https://your-worker-url/get-price-options

# Or query database directly
wrangler d1 execute consentbit-licenses --command="SELECT * FROM price_config;"
```

---

## 📊 Table Structure

### `price_config` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key (auto-increment) |
| `price_type` | TEXT | 'monthly' or 'yearly' (UNIQUE) |
| `price_id` | TEXT | Stripe price ID (e.g., `price_xxxxx`) |
| `discount_allowance` | REAL | Discount amount (0-100 for percentage, or cents for fixed) |
| `discount_type` | TEXT | 'percentage' or 'fixed_amount' |
| `coupon_code` | TEXT | Stripe coupon code (optional, for future use) |
| `is_active` | INTEGER | 1 = active, 0 = inactive |
| `description` | TEXT | Optional description |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

---

## 🔧 API Endpoints

### 1. Get Price Options

**Endpoint:** `GET /get-price-options`

**Response:**
```json
{
  "monthly": {
    "price_id": "price_1SiMxxxxx",
    "discount_allowance": 0,
    "discount_type": "percentage",
    "coupon_code": null
  },
  "yearly": {
    "price_id": "price_1SiNyyyyy",
    "discount_allowance": 10,
    "discount_type": "percentage",
    "coupon_code": "YEARLY10"
  },
  "source": "database"
}
```

### 2. Update Price Configuration

**Endpoint:** `POST /admin/update-price-config`

**Request Body:**
```json
{
  "price_type": "monthly",
  "price_id": "price_1SiMxxxxx",
  "discount_allowance": 5,
  "discount_type": "percentage",
  "coupon_code": "MONTHLY5",
  "description": "Monthly subscription with 5% discount",
  "is_active": 1
}
```

**Response:**
```json
{
  "success": true,
  "message": "Price config for monthly updated successfully",
  "data": {
    "price_type": "monthly",
    "price_id": "price_1SiMxxxxx",
    "discount_allowance": 5,
    "discount_type": "percentage",
    "coupon_code": "MONTHLY5",
    "is_active": 1,
    "description": "Monthly subscription with 5% discount"
  }
}
```

### 3. Get All Price Configurations

**Endpoint:** `GET /admin/price-config`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "price_type": "monthly",
      "price_id": "price_1SiMxxxxx",
      "discount_allowance": 0,
      "discount_type": "percentage",
      "coupon_code": null,
      "is_active": 1,
      "description": "Monthly subscription price",
      "created_at": 1704067200,
      "updated_at": 1704067200
    },
    {
      "id": 2,
      "price_type": "yearly",
      "price_id": "price_1SiNyyyyy",
      "discount_allowance": 10,
      "discount_type": "percentage",
      "coupon_code": "YEARLY10",
      "is_active": 1,
      "description": "Yearly subscription with 10% discount",
      "created_at": 1704067200,
      "updated_at": 1704067200
    }
  ]
}
```

---

## 💡 Usage Examples

### Example 1: Update Monthly Price

```bash
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "monthly",
    "price_id": "price_1SiMxxxxx",
    "discount_allowance": 0,
    "discount_type": "percentage",
    "is_active": 1
  }'
```

### Example 2: Add Discount to Yearly Price

```bash
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "yearly",
    "price_id": "price_1SiNyyyyy",
    "discount_allowance": 15,
    "discount_type": "percentage",
    "coupon_code": "YEARLY15",
    "description": "Yearly subscription with 15% discount",
    "is_active": 1
  }'
```

### Example 3: Disable a Price Type

```bash
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "monthly",
    "price_id": "price_1SiMxxxxx",
    "is_active": 0
  }'
```

### Example 4: Set Fixed Amount Discount

```bash
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "yearly",
    "price_id": "price_1SiNyyyyy",
    "discount_allowance": 2000,
    "discount_type": "fixed_amount",
    "description": "Yearly subscription with $20 fixed discount",
    "is_active": 1
  }'
```

---

## 🔄 How It Works

### Priority Order

The system fetches price IDs in this order:

1. **Database (`price_config` table)** - Primary source
2. **User's existing subscriptions** - Overrides database if user has subscriptions
3. **Environment variables** - Fallback if database is unavailable

### Frontend Flow

1. User opens dashboard
2. Frontend calls `/get-price-options`
3. System queries `price_config` table
4. Returns monthly/yearly price IDs with discount info
5. User selects payment plan
6. Selected price ID is used for checkout

### Backend Flow

1. Checkout request includes `price_id`
2. Backend validates price ID
3. If discount/coupon configured, applies to checkout
4. Creates subscription with selected price

---

## 📝 SQL Examples

### Insert New Price Config

```sql
INSERT INTO price_config (price_type, price_id, discount_allowance, discount_type, coupon_code, is_active, description)
VALUES ('monthly', 'price_1SiMxxxxx', 0, 'percentage', NULL, 1, 'Monthly subscription');
```

### Update Existing Price

```sql
UPDATE price_config 
SET price_id = 'price_1SiMNewPrice',
    discount_allowance = 10,
    discount_type = 'percentage',
    coupon_code = 'SAVE10',
    updated_at = unixepoch()
WHERE price_type = 'monthly';
```

### Query Active Prices

```sql
SELECT price_type, price_id, discount_allowance, discount_type, coupon_code
FROM price_config
WHERE is_active = 1
ORDER BY price_type;
```

### Disable a Price

```sql
UPDATE price_config 
SET is_active = 0,
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

---

## 🛠️ Integration with Existing Code

The code automatically uses the database table:

1. **`/get-price-options` endpoint** - Reads from `price_config` table
2. **Frontend `fetchPriceIds()`** - Calls `/get-price-options` to get price IDs
3. **Checkout creation** - Uses price IDs from database

**No code changes needed** - the system automatically falls back to environment variables if the table doesn't exist or is empty.

---

## ✅ Testing Checklist

- [ ] Table created successfully
- [ ] Monthly price ID inserted/updated
- [ ] Yearly price ID inserted/updated
- [ ] `/get-price-options` returns correct data
- [ ] `/admin/update-price-config` updates prices
- [ ] Frontend displays correct prices
- [ ] Checkout uses correct price IDs
- [ ] Discount/coupon fields are stored correctly

---

## 🔍 Troubleshooting

### Problem: Prices not loading

**Solution:**
1. Check table exists: `SELECT * FROM price_config;`
2. Verify `is_active = 1` for both monthly and yearly
3. Check API response: `curl /get-price-options`
4. Review browser console for errors

### Problem: Wrong price used

**Solution:**
1. Verify price IDs in database match Stripe
2. Check user's existing subscriptions (they override database)
3. Clear browser cache and reload

### Problem: Discount not applied

**Solution:**
1. Verify `discount_allowance` is set correctly
2. Check `discount_type` is 'percentage' or 'fixed_amount'
3. Ensure discount logic is implemented in checkout creation

---

## 📚 Next Steps

1. **Create the table** using `create-price-config-table.sql`
2. **Update price IDs** with your Stripe price IDs
3. **Test the endpoints** to verify setup
4. **Configure discounts** if needed
5. **Set up coupon codes** in Stripe and link them here

The system is now ready to use database-driven price configuration! 🎉

