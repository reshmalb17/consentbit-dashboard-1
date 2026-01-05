# Environment Variables for License Purchase

## Required Environment Variables

The `/purchase-quantity` endpoint now reads pricing configuration from environment variables instead of the database.

### Monthly License Configuration

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `MONTHLY_PRODUCT_ID` | Stripe Product ID for monthly licenses | `prod_TiX0VbsXQSm4N5` | ✅ Yes |
| `MONTHLY_UNIT_AMOUNT` | Price per license in cents | `800` (for $8.00) | ⚠️ Optional (defaults to 800) |
| `MONTHLY_CURRENCY` | Currency code | `usd` | ⚠️ Optional (defaults to 'usd') |

**Alternative variable names (for backward compatibility):**
- `MONTHLY_LICENSE_PRODUCT_ID` (fallback if `MONTHLY_PRODUCT_ID` not set)
- `MONTHLY_LICENSE_UNIT_AMOUNT` (fallback if `MONTHLY_UNIT_AMOUNT` not set)

### Yearly License Configuration

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `YEARLY_PRODUCT_ID` | Stripe Product ID for yearly licenses | `prod_TiX0CF9K1RSRyb` | ✅ Yes |
| `YEARLY_UNIT_AMOUNT` | Price per license in cents | `7200` (for $72.00) | ⚠️ Optional (defaults to 7200) |
| `YEARLY_CURRENCY` | Currency code | `usd` | ⚠️ Optional (defaults to 'usd') |

**Alternative variable names (for backward compatibility):**
- `YEARLY_LICENSE_PRODUCT_ID` (fallback if `YEARLY_PRODUCT_ID` not set)
- `YEARLY_LICENSE_UNIT_AMOUNT` (fallback if `YEARLY_UNIT_AMOUNT` not set)

### Global Currency (Optional)

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `CURRENCY` | Default currency for all pricing | `usd` | ⚠️ Optional (used if period-specific currency not set) |

---

## How to Set Environment Variables

### Option 1: Using Wrangler (Cloudflare Workers)

**In `wrangler.toml` or `wrangler.jsonc`:**

```toml
[vars]
MONTHLY_PRODUCT_ID = "prod_TiX0VbsXQSm4N5"
MONTHLY_UNIT_AMOUNT = "800"
MONTHLY_CURRENCY = "usd"

YEARLY_PRODUCT_ID = "prod_TiX0CF9K1RSRyb"
YEARLY_UNIT_AMOUNT = "7200"
YEARLY_CURRENCY = "usd"
```

### Option 2: Using Cloudflare Dashboard

1. Go to Cloudflare Dashboard → Workers & Pages
2. Select your worker
3. Go to Settings → Variables
4. Add each environment variable

### Option 3: Using Wrangler CLI

```bash
# Set monthly variables
wrangler secret put MONTHLY_PRODUCT_ID
# Enter: prod_TiX0VbsXQSm4N5

wrangler secret put MONTHLY_UNIT_AMOUNT
# Enter: 800

# Set yearly variables
wrangler secret put YEARLY_PRODUCT_ID
# Enter: prod_TiX0CF9K1RSRyb

wrangler secret put YEARLY_UNIT_AMOUNT
# Enter: 7200
```

---

## Current Configuration

Based on your requirements:

```bash
# Monthly
MONTHLY_PRODUCT_ID=prod_TiX0VbsXQSm4N5
MONTHLY_UNIT_AMOUNT=800      # $8.00 per license
MONTHLY_CURRENCY=usd

# Yearly
YEARLY_PRODUCT_ID=prod_TiX0CF9K1RSRyb
YEARLY_UNIT_AMOUNT=7200      # $72.00 per license
YEARLY_CURRENCY=usd
```

---

## Price Calculation Examples

With the current configuration:

**Monthly ($8.00 per license):**
- 1 license = 800 × 1 = 800 cents = **$8.00**
- 5 licenses = 800 × 5 = 4000 cents = **$40.00**
- 10 licenses = 800 × 10 = 8000 cents = **$80.00**

**Yearly ($72.00 per license):**
- 1 license = 7200 × 1 = 7200 cents = **$72.00**
- 5 licenses = 7200 × 5 = 36000 cents = **$360.00**
- 10 licenses = 7200 × 10 = 72000 cents = **$720.00**

---

## Benefits of Using Environment Variables

✅ **Fast**: No database query needed (~0ms vs ~50-100ms)  
✅ **Flexible**: Change prices without code deployment  
✅ **Simple**: Easy to update via Cloudflare Dashboard  
✅ **Secure**: Can use secrets for sensitive values  
✅ **Version Control**: Can be in `wrangler.toml` for different environments  

---

## Troubleshooting

### Error: "product_id_not_configured"

**Solution:** Make sure `MONTHLY_PRODUCT_ID` or `YEARLY_PRODUCT_ID` is set in your environment variables.

### Error: "Invalid unit_amount"

**Solution:** Make sure `MONTHLY_UNIT_AMOUNT` or `YEARLY_UNIT_AMOUNT` is a valid number (in cents).

### Prices Not Updating

**Solution:** After updating environment variables, redeploy your worker:
```bash
wrangler deploy
```
