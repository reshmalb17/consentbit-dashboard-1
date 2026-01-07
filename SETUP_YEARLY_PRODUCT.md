# Setup Yearly Product ID

## Your Yearly Product ID

**Product ID:** `prod_SJQgqC8uDgRcOi`

---

## Step 1: Set Environment Variable

Set the yearly product ID in Cloudflare Workers:

```bash
cd consentbit-dashboard-1
wrangler secret put YEARLY_PRODUCT_ID --name consentbit-dashboard-test
```

When prompted, enter:
```
prod_SJQgqC8uDgRcOi
```

---

## Step 2: Add Product Metadata (REQUIRED)

**Important:** You must add metadata to this product so the webhook processes it.

1. Go to **Stripe Dashboard** → **Products**
2. Click on product: `prod_SJQgqC8uDgRcOi`
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
- `YEARLY_PRODUCT_ID` ✅

### Check Product Metadata:
1. Stripe Dashboard → Products → `prod_SJQgqC8uDgRcOi`
2. Verify metadata shows: `usedfor: dashboard` ✅

---

## Step 4: Test

1. Create a test Payment Link using this yearly product
2. Complete a test payment
3. Check webhook logs for:
   - `[USE CASE 1] 🏷️ Product metadata usedfor: dashboard` ✅
   - License should be created successfully

---

## Current Configuration

| Variable | Value | Status |
|----------|-------|--------|
| `YEARLY_PRODUCT_ID` | `prod_SJQgqC8uDgRcOi` | ⚠️ Needs to be set |
| `YEARLY_UNIT_AMOUNT` | `7500` ($75.00/year) | ✅ Default in code |
| Product Metadata | `usedfor: dashboard` | ⚠️ Needs to be added |

---

## Related Environment Variables

You may also need to set:

```bash
# Yearly pricing (in cents)
wrangler secret put YEARLY_UNIT_AMOUNT --name consentbit-dashboard-test
# Enter: 7500 (for $75.00/year)

# Yearly currency
wrangler secret put YEARLY_CURRENCY --name consentbit-dashboard-test
# Enter: usd (or your currency)
```

---

## Quick Command Reference

```bash
# Set yearly product ID
wrangler secret put YEARLY_PRODUCT_ID --name consentbit-dashboard-test

# Set yearly unit amount (in cents)
wrangler secret put YEARLY_UNIT_AMOUNT --name consentbit-dashboard-test

# Set yearly currency
wrangler secret put YEARLY_CURRENCY --name consentbit-dashboard-test

# List all secrets
wrangler secret list --name consentbit-dashboard-test
```
