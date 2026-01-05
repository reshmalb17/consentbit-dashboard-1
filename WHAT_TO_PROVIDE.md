# What Details You Need to Provide

## 🎯 Quick Answer

You need to provide **2 things**:

1. **Your Monthly Stripe Price ID** (e.g., `price_1ShWWXSAczuHLTOtbNqhSk5n`)
2. **Your Yearly Stripe Price ID** (e.g., `price_1SiNyyyyy`)

---

## 📝 Step-by-Step

### Step 1: Find Your Price IDs in Stripe

1. Go to: https://dashboard.stripe.com/
2. Click: **Products** (left sidebar)
3. Click: Your product name
4. Look at the **Prices** section
5. You'll see price IDs like: `price_1ShWWXSAczuHLTOtbNqhSk5n`

**What to copy:**
- ✅ Monthly price ID (if you have monthly pricing)
- ✅ Yearly price ID (if you have yearly pricing)

**Note:** If you don't have a yearly price yet, create one in Stripe first!

---

### Step 2: Run the Setup Script

```bash
.\create-price-config-table.ps1
```

This creates the empty table. **No details needed here.**

---

### Step 3: Update the Database

**Replace the placeholders with YOUR actual price IDs:**

```sql
-- Update monthly price (use YOUR monthly price ID)
UPDATE price_config 
SET price_id = 'price_1ShWWXSAczuHLTOtbNqhSk5n',  -- ← YOUR MONTHLY PRICE ID HERE
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly price (use YOUR yearly price ID)
UPDATE price_config 
SET price_id = 'price_1SiNyyyyy',  -- ← YOUR YEARLY PRICE ID HERE
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

**To run this:**
```bash
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_MONTHLY_PRICE_ID' WHERE price_type = 'monthly';"
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_YEARLY_PRICE_ID' WHERE price_type = 'yearly';"
```

---

## 📋 Example with Your Current Setup

Based on your `wrangler.jsonc`, you currently have:
- `DEFAULT_PRICE_ID`: `price_1ShWWXSAczuHLTOtbNqhSk5n`

**So you would do:**

```sql
-- Use your existing price as monthly
UPDATE price_config 
SET price_id = 'price_1ShWWXSAczuHLTOtbNqhSk5n',
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Add your yearly price (you need to create this in Stripe if you don't have it)
UPDATE price_config 
SET price_id = 'price_1SiNyyyyy',  -- Replace with your actual yearly price ID
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

---

## ✅ Optional: Discounts & Coupons

**Only if you want to add discounts:**

```sql
-- Example: 10% discount on yearly
UPDATE price_config 
SET discount_allowance = 10,           -- 10% discount
    discount_type = 'percentage',      -- or 'fixed_amount'
    coupon_code = 'YEARLY10',          -- Optional: your Stripe coupon code
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

**What you need:**
- Discount amount: `10` (for 10%) or `2000` (for $20 fixed)
- Discount type: `'percentage'` or `'fixed_amount'`
- Coupon code: `'YEARLY10'` (optional, if you have Stripe coupons)

---

## 🎯 Summary

### Required (Must Provide):
1. ✅ **Monthly Price ID** from Stripe
2. ✅ **Yearly Price ID** from Stripe

### Optional (Only if needed):
3. ⚪ Discount allowance (0-100 for %, or cents for fixed)
4. ⚪ Discount type (`'percentage'` or `'fixed_amount'`)
5. ⚪ Coupon code (your Stripe coupon code)

---

## 🚀 Quick Copy-Paste Commands

**After you have your price IDs, run these:**

```bash
# 1. Create table
.\create-price-config-table.ps1

# 2. Update monthly (replace YOUR_MONTHLY_PRICE_ID)
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_MONTHLY_PRICE_ID', updated_at = unixepoch() WHERE price_type = 'monthly';"

# 3. Update yearly (replace YOUR_YEARLY_PRICE_ID)
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_YEARLY_PRICE_ID', updated_at = unixepoch() WHERE price_type = 'yearly';"

# 4. Verify
curl https://consentbit-dashboard-test.web-8fb.workers.dev/get-price-options
```

---

## ❓ Don't Have Yearly Price?

**Create it in Stripe:**

1. Stripe Dashboard → Products → Your Product
2. Click **"Add another price"**
3. Set:
   - **Pricing model:** Recurring
   - **Price:** Your yearly amount (e.g., `100.00`)
   - **Billing period:** Yearly
   - **Currency:** USD (or your currency)
4. Click **"Add price"**
5. **Copy the new Price ID** (starts with `price_`)
6. Use it in Step 3 above

---

## ✅ That's All!

Once you provide the 2 price IDs, the system will automatically use them from the database! 🎉

