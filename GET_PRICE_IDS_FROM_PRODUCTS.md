# How to Get Price IDs from Your Products

You provided **Product IDs**, but the `price_config` table needs **Price IDs**. Here's how to get them:

---

## 📋 Your Products

- **Monthly Product ID:** `prod_Tg3C9VY4GhshdE`
- **Yearly Product ID:** `prod_Tg3AbI4uIip8oO`

---

## 🔍 Step-by-Step: Get Price IDs

### For Monthly Product (prod_Tg3C9VY4GhshdE):

1. **Go to Stripe Dashboard:** https://dashboard.stripe.com/
2. **Navigate to:** Products → Click on product `prod_Tg3C9VY4GhshdE`
3. **Find Pricing Section:** Scroll to see the prices under this product
4. **Copy Price ID:** You'll see something like `price_1SiMxxxxx`
5. **Note it down:** This is your monthly price ID

### For Yearly Product (prod_Tg3AbI4uIip8oO):

1. **Navigate to:** Products → Click on product `prod_Tg3AbI4uIip8oO`
2. **Find Pricing Section:** Scroll to see the prices under this product
3. **Copy Price ID:** You'll see something like `price_1SiNyyyyy`
4. **Note it down:** This is your yearly price ID

---

## 📝 What You'll See in Stripe

```
Product: prod_Tg3C9VY4GhshdE
├─ Pricing
│  └─ Price: $XX.XX / month
│     └─ Price ID: price_1SiMxxxxx  ← COPY THIS
```

---

## ✅ Once You Have Price IDs

### Option 1: Update via SQL

```sql
-- Update monthly (replace price_xxxxx with your actual monthly price ID)
UPDATE price_config 
SET price_id = 'price_xxxxx',
    description = 'Monthly subscription price - Product: prod_Tg3C9VY4GhshdE',
    updated_at = unixepoch()
WHERE price_type = 'monthly';

-- Update yearly (replace price_xxxxx with your actual yearly price ID)
UPDATE price_config 
SET price_id = 'price_xxxxx',
    description = 'Yearly subscription price - Product: prod_Tg3AbI4uIip8oO',
    updated_at = unixepoch()
WHERE price_type = 'yearly';
```

**Run with wrangler:**
```bash
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_MONTHLY_PRICE_ID', updated_at = unixepoch() WHERE price_type = 'monthly';"
wrangler d1 execute consentbit-licenses --command="UPDATE price_config SET price_id = 'YOUR_YEARLY_PRICE_ID', updated_at = unixepoch() WHERE price_type = 'yearly';"
```

### Option 2: Update via API

```bash
# Update monthly
curl -X POST https://consentbit-dashboard-test.web-8fb.workers.dev/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "monthly",
    "price_id": "YOUR_MONTHLY_PRICE_ID",
    "description": "Monthly subscription price - Product: prod_Tg3C9VY4GhshdE",
    "is_active": 1
  }'

# Update yearly
curl -X POST https://consentbit-dashboard-test.web-8fb.workers.dev/admin/update-price-config \
  -H "Content-Type: application/json" \
  -d '{
    "price_type": "yearly",
    "price_id": "YOUR_YEARLY_PRICE_ID",
    "description": "Yearly subscription price - Product: prod_Tg3AbI4uIip8oO",
    "is_active": 1
  }'
```

---

## 🔍 Quick Check: Verify Your Products Have Prices

If you don't see prices under your products:

1. **Check if prices exist:**
   - Go to product page
   - Look for "Pricing" section
   - If empty, you need to create prices

2. **Create prices if needed:**
   - Click "Add another price"
   - Set amount and billing period
   - Save - this creates a price ID

---

## 📋 Summary

1. ✅ You have: **Product IDs**
   - Monthly: `prod_Tg3C9VY4GhshdE`
   - Yearly: `prod_Tg3AbI4uIip8oO`

2. 🔍 You need: **Price IDs** (from those products)
   - Go to each product in Stripe
   - Find the price under "Pricing"
   - Copy the Price ID (starts with `price_`)

3. ✅ Then: **Update the table**
   - Use SQL or API to update `price_config` table
   - Replace `price_xxxxx` with your actual price IDs

---

## ❓ Need Help?

If you can't find the price IDs:
1. Make sure you're looking at the correct product
2. Check if prices are created for those products
3. If no prices exist, create them in Stripe Dashboard

Once you have the price IDs, I can help you update the table! 🚀

