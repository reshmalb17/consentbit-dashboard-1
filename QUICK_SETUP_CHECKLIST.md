# Quick Setup Checklist - What Details You Need to Provide

This checklist shows exactly what information you need to provide to set up the price configuration system.

---

## ✅ Step 1: Create the Database Table

**Action:** Run the migration script

```bash
.\create-price-config-table.ps1
```

**What you need:** Nothing - this creates the empty table structure.

---

## ✅ Step 2: Get Your Stripe Price IDs

**Action:** Go to Stripe Dashboard and find your price IDs

### Where to Find Price IDs in Stripe:

1. **Go to Stripe Dashboard:** https://dashboard.stripe.com/
2. **Navigate to:** Products → Select your product
3. **Find Prices:** Look for the price list under your product
4. **Copy Price IDs:** You'll see IDs like `price_1SiMxxxxx`

### What You Need:

- ✅ **Monthly Price ID** (e.g., `price_1SiMxxxxx`)
- ✅ **Yearly Price ID** (e.g., `price_1SiNyyyyy`)

**Example:**
```
Monthly: price_1ShWWXSAczuHLTOtbNqhSk5n
Yearly: price_1SiNyyyyy  (you need to create this if you don't have it)
```

---

## ✅ Step 3: Update the Database with Your Price IDs

**Option A: Using SQL (Recommended)**

```sql
-- Update monthly price
UPDATE price_config 
SET price_id = 'price_1SiMxxxxx',  -- REPLACE WITH YOUR MONTHLY PRICE ID
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly price
UPDATE price_config 
SET price_id = 'price_1SiNyyyyy',  -- REPLACE WITH YOUR YEARLY PRICE ID
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

**Option B: Using API Endpoint**

```bash
# Update monthly price
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "monthly",
    "price_id": "price_1SiMxxxxx",  -- REPLACE WITH YOUR MONTHLY PRICE ID
    "discount_allowance": 0,
    "discount_type": "percentage",
    "is_active": 1
  }'

# Update yearly price
curl -X POST https://your-worker-url/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "yearly",
    "price_id": "price_1SiNyyyyy",  -- REPLACE WITH YOUR YEARLY PRICE ID
    "discount_allowance": 0,
    "discount_type": "percentage",
    "is_active": 1
  }'
```

**What you need to provide:**
- ✅ Your monthly Stripe price ID
- ✅ Your yearly Stripe price ID

---

## ✅ Step 4: Optional - Configure Discounts (If Needed)

**If you want to add discounts:**

```sql
-- Add 10% discount to yearly subscription
UPDATE price_config 
SET discount_allowance = 10,
    discount_type = 'percentage',
    coupon_code = 'YEARLY10',  -- Optional: Stripe coupon code
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

**What you need to provide:**
- ✅ Discount percentage (0-100) OR fixed amount in cents
- ✅ Discount type: 'percentage' or 'fixed_amount'
- ✅ (Optional) Stripe coupon code if you have one

**Example Discounts:**
```
10% discount: discount_allowance = 10, discount_type = 'percentage'
$20 off: discount_allowance = 2000, discount_type = 'fixed_amount'
```

---

## ✅ Step 5: Verify Setup

**Check that everything is configured:**

```bash
# Using API
curl https://your-worker-url/get-price-options

# Or using SQL
wrangler d1 execute consentbit-licenses --command="SELECT price_type, price_id, discount_allowance, is_active FROM price_config;"
```

**Expected Response:**
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
    "discount_allowance": 0,
    "discount_type": "percentage",
    "coupon_code": null
  },
  "source": "database"
}
```

---

## 📋 Summary: What Details You Need

### Required Information:

1. ✅ **Monthly Stripe Price ID**
   - Format: `price_xxxxx`
   - Where: Stripe Dashboard → Products → Your Product → Prices
   - Example: `price_1ShWWXSAczuHLTOtbNqhSk5n`

2. ✅ **Yearly Stripe Price ID**
   - Format: `price_xxxxx`
   - Where: Stripe Dashboard → Products → Your Product → Prices
   - Note: Create this in Stripe if you don't have it yet

### Optional Information:

3. ⚪ **Discount Allowance** (if you want discounts)
   - Percentage: 0-100 (e.g., 10 for 10%)
   - Fixed amount: Amount in cents (e.g., 2000 for $20)

4. ⚪ **Discount Type** (if using discounts)
   - `'percentage'` or `'fixed_amount'`

5. ⚪ **Coupon Code** (if you have Stripe coupons)
   - Your Stripe coupon code (e.g., `'YEARLY10'`)

---

## 🚀 Quick Start Commands

### 1. Create Table
```bash
.\create-price-config-table.ps1
```

### 2. Update Monthly Price (Replace with your price ID)
```sql
UPDATE price_config SET price_id = 'YOUR_MONTHLY_PRICE_ID' WHERE price_type = 'monthly';
```

### 3. Update Yearly Price (Replace with your price ID)
```sql
UPDATE price_config SET price_id = 'YOUR_YEARLY_PRICE_ID' WHERE price_type = 'yearly';
```

### 4. Verify
```bash
curl https://your-worker-url/get-price-options
```

---

## ❓ Don't Have Yearly Price Yet?

If you don't have a yearly price in Stripe yet:

1. **Go to Stripe Dashboard**
2. **Products → Your Product → Add another price**
3. **Set:**
   - Pricing model: Recurring
   - Price: Your yearly amount (e.g., $100)
   - Billing period: Yearly (or Every 12 months)
   - Currency: Your currency
4. **Copy the Price ID** that gets created
5. **Use it in Step 3 above**

---

## ✅ That's It!

Once you provide:
- ✅ Monthly price ID
- ✅ Yearly price ID

The system will automatically use these prices from the database instead of environment variables!

