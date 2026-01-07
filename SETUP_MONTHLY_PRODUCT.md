# Setup Monthly Product ID

## Your Monthly Product ID

**Product ID:** `prod_SHWZdF20XLXtn9`

---

## Step 1: Set Environment Variable

Set the monthly product ID in Cloudflare Workers:

```bash
cd consentbit-dashboard-1
wrangler secret put MONTHLY_PRODUCT_ID --name consentbit-dashboard-test
```

When prompted, enter:
```
prod_SHWZdF20XLXtn9
```

---

## Step 2: Add Product Metadata (REQUIRED)

**Important:** You must add metadata to this product so the webhook processes it.

1. Go to **Stripe Dashboard** → **Products**
2. Click on product: `prod_SHWZdF20XLXtn9`
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. **Key:** `usedfor`
6. **Value:** `dashboard`
7. Click **Save**

**Why:** Without this metadata, the webhook will skip processing payments for this product.

---

## Step 3: Verify Setup

### Check Environment Variable:
```bash
wrangler secret list --name consentbit-dashboard-test
```

You should see:
- `MONTHLY_PRODUCT_ID` ✅

### Check Product Metadata:
1. Stripe Dashboard → Products → `prod_SHWZdF20XLXtn9`
2. Verify metadata shows: `usedfor: dashboard` ✅

---

## Step 4: Test

1. Create a test Payment Link using this monthly product
2. Complete a test payment
3. Check webhook logs for:
   - `[USE CASE 1] 🏷️ Product metadata usedfor: dashboard` ✅
   - License should be created successfully

---

## Current Configuration

| Variable | Value | Status |
|----------|-------|--------|
| `MONTHLY_PRODUCT_ID` | `prod_SHWZdF20XLXtn9` | ✅ Updated in code |
| `MONTHLY_UNIT_AMOUNT` | `800` ($8.00/month) | ✅ Default in code |
| Product Metadata | `usedfor: dashboard` | ⚠️ Needs to be added |

---

## Related Environment Variables

You may also need to set:

```bash
# Monthly pricing (in cents)
wrangler secret put MONTHLY_UNIT_AMOUNT --name consentbit-dashboard-test
# Enter: 800 (for $8.00/month) or your amount

# Monthly currency
wrangler secret put MONTHLY_CURRENCY --name consentbit-dashboard-test
# Enter: usd (or your currency)
```

---

## Quick Command Reference

```bash
# Set monthly product ID
wrangler secret put MONTHLY_PRODUCT_ID --name consentbit-dashboard-test

# Set monthly unit amount (in cents)
wrangler secret put MONTHLY_UNIT_AMOUNT --name consentbit-dashboard-test

# Set monthly currency
wrangler secret put MONTHLY_CURRENCY --name consentbit-dashboard-test

# List all secrets
wrangler secret list --name consentbit-dashboard-test
```

---

## Complete Product Configuration

| Product | Product ID | Unit Amount | Currency | Metadata Required |
|---------|-----------|-------------|----------|-------------------|
| **Monthly** | `prod_SHWZdF20XLXtn9` | $8.00 (800 cents) | USD | `usedfor: dashboard` |
| **Yearly** | `prod_SJQgqC8uDgRcOi` | $75.00 (7500 cents) | USD | `usedfor: dashboard` |
