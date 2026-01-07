# Stripe Account Setup Guide

## Required Data for Adding a New Stripe Account

### 1. Stripe Account Credentials (Required)

#### Secret Key
- **Variable Name:** `STRIPE_SECRET_KEY`
- **Format:** `sk_test_xxxxx` (test) or `sk_live_xxxxx` (production)
- **Where to get:** Stripe Dashboard → Developers → API Keys → Secret key
- **Required:** ✅ Yes

#### Webhook Secret (Recommended)
- **Variable Name:** `STRIPE_WEBHOOK_SECRET`
- **Format:** `whsec_xxxxx`
- **Where to get:** Stripe Dashboard → Developers → Webhooks → Your endpoint → Signing secret
- **Required:** ⚠️ Optional but recommended for security

---

### 2. Product Configuration (Required)

You need to create **2 products** in your Stripe account (one for monthly, one for yearly, or one product with two prices).

#### Option A: Separate Products (Current Setup)

**Monthly Product:**
- **Product Name:** `ConsentBit Monthly` (or your preferred name)
- **Product Description:** `Monthly subscription for ConsentBit` (optional)
- **Product ID:** `prod_xxxxx` (copy from Stripe Dashboard)
- **Variable:** `MONTHLY_PRODUCT_ID`

**Yearly Product:**
- **Product Name:** `ConsentBit Yearly` (or your preferred name)
- **Product Description:** `Yearly subscription for ConsentBit` (optional)
- **Product ID:** `prod_xxxxx` (copy from Stripe Dashboard)
- **Variable:** `YEARLY_PRODUCT_ID`

#### Option B: Single Product with Multiple Prices (Recommended)

**Single Product:**
- **Product Name:** `ConsentBit`
- **Product Description:** `ConsentBit subscription service`
- **Product ID:** `prod_xxxxx`
- **Variables:** `MONTHLY_PRODUCT_ID` and `YEARLY_PRODUCT_ID` (both use same product ID)

---

### 3. Price Configuration (Required)

For each billing period, you need:

#### Monthly Price
- **Price Amount:** e.g., `$8.00` = `800` cents
- **Variable:** `MONTHLY_UNIT_AMOUNT` = `"800"`
- **Currency:** e.g., `usd`
- **Variable:** `MONTHLY_CURRENCY` = `"usd"`
- **Billing Period:** Monthly (recurring)
- **Price ID:** `price_xxxxx` (optional - only if using price_config table)

#### Yearly Price
- **Price Amount:** e.g., `$75.00` = `7500` cents
- **Variable:** `YEARLY_UNIT_AMOUNT` = `"7500"`
- **Currency:** e.g., `usd`
- **Variable:** `YEARLY_CURRENCY` = `"usd"`
- **Billing Period:** Yearly (recurring)
- **Price ID:** `price_xxxxx` (optional - only if using price_config table)

---

### 4. How to Create Products in Stripe Dashboard

#### Step 1: Create Monthly Product
1. Go to **Stripe Dashboard** → **Products**
2. Click **+ Add product**
3. **Name:** `ConsentBit Monthly` (or your name)
4. **Description:** `Monthly subscription` (optional)
5. Click **Save product**
6. **Copy Product ID:** `prod_xxxxx` ⚠️ **SAVE THIS**

#### Step 2: Add Monthly Price
1. In the product page, click **Add another price**
2. **Pricing model:** Select **Recurring**
3. **Price:** Enter amount (e.g., `8.00` for $8/month)
4. **Billing period:** Select **Monthly**
5. **Currency:** Select currency (e.g., USD)
6. Click **Add price**
7. **Copy Price ID:** `price_xxxxx` (optional)

#### Step 3: Create Yearly Product (or add yearly price to same product)
1. **Option A:** Create new product for yearly
   - Follow Step 1, name it `ConsentBit Yearly`
   - Copy Product ID: `prod_xxxxx`
2. **Option B:** Add yearly price to same product
   - In the same product, click **Add another price**
   - Set billing period to **Yearly**
   - Copy Price ID: `price_xxxxx`

---

### 5. Environment Variables to Set

#### In Cloudflare Workers (via `wrangler secret put` or Dashboard):

```bash
# Stripe Account Credentials
STRIPE_SECRET_KEY=sk_test_xxxxx  # or sk_live_xxxxx for production
STRIPE_WEBHOOK_SECRET=whsec_xxxxx  # Optional but recommended

# Monthly Product Configuration
MONTHLY_PRODUCT_ID=prod_xxxxx
MONTHLY_UNIT_AMOUNT=800  # $8.00 in cents
MONTHLY_CURRENCY=usd

# Yearly Product Configuration
YEARLY_PRODUCT_ID=prod_xxxxx  # Can be same as monthly if using one product
YEARLY_UNIT_AMOUNT=7500  # $75.00 in cents
YEARLY_CURRENCY=usd

# Global Currency (Optional - used as fallback)
CURRENCY=usd
```

#### Alternative Variable Names (Backward Compatibility):
- `MONTHLY_LICENSE_PRODUCT_ID` (fallback for `MONTHLY_PRODUCT_ID`)
- `MONTHLY_LICENSE_UNIT_AMOUNT` (fallback for `MONTHLY_UNIT_AMOUNT`)
- `YEARLY_LICENSE_PRODUCT_ID` (fallback for `YEARLY_PRODUCT_ID`)
- `YEARLY_LICENSE_UNIT_AMOUNT` (fallback for `YEARLY_UNIT_AMOUNT`)

---

### 6. Webhook Configuration (Required)

#### Step 1: Create Webhook Endpoint in Stripe
1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **+ Add endpoint**
3. **Endpoint URL:** `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
4. **Events to send:** Select these events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `customer.subscription.updated`
   - `invoice.payment_succeeded`
5. Click **Add endpoint**
6. **Copy Signing secret:** `whsec_xxxxx` ⚠️ **SAVE THIS**

#### Step 2: Set Webhook Secret
```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
# Enter: whsec_xxxxx
```

---

### 7. Complete Checklist

#### Stripe Dashboard Setup:
- [ ] Created Monthly Product (`prod_xxxxx`)
- [ ] Added Monthly Price (recurring, monthly)
- [ ] Created Yearly Product OR added Yearly Price (`prod_xxxxx`)
- [ ] Created Webhook Endpoint
- [ ] Copied Webhook Signing Secret (`whsec_xxxxx`)

#### Environment Variables:
- [ ] `STRIPE_SECRET_KEY` set
- [ ] `STRIPE_WEBHOOK_SECRET` set (recommended)
- [ ] `MONTHLY_PRODUCT_ID` set
- [ ] `MONTHLY_UNIT_AMOUNT` set (in cents)
- [ ] `MONTHLY_CURRENCY` set
- [ ] `YEARLY_PRODUCT_ID` set
- [ ] `YEARLY_UNIT_AMOUNT` set (in cents)
- [ ] `YEARLY_CURRENCY` set

---

### 8. Testing Your Setup

After configuring everything:

1. **Test Checkout Creation:**
   ```bash
   curl -X POST https://consentbit-dashboard-test.web-8fb.workers.dev/purchase-quantity \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","quantity":1,"billing_period":"monthly"}'
   ```

2. **Verify Response:**
   - Should return `checkout_url`
   - Checkout should show correct product name and price

3. **Test Webhook:**
   - Complete a test payment
   - Check webhook logs in Stripe Dashboard
   - Verify licenses are created in your database

---

### 9. Example Configuration

**For a $8/month, $75/year setup:**

```bash
# Stripe Credentials
STRIPE_SECRET_KEY=sk_test_51Abc123...
STRIPE_WEBHOOK_SECRET=whsec_xyz789...

# Monthly ($8.00/month)
MONTHLY_PRODUCT_ID=prod_SHWZdF20XLXtn9
MONTHLY_UNIT_AMOUNT=800
MONTHLY_CURRENCY=usd

# Yearly ($75.00/year)
YEARLY_PRODUCT_ID=prod_SJQgqC8uDgRcOi
YEARLY_UNIT_AMOUNT=7500
YEARLY_CURRENCY=usd
```

---

## Important Notes

1. **Product IDs vs Price IDs:**
   - The code uses **Product IDs** (`prod_xxxxx`) for checkout creation
   - **Price IDs** (`price_xxxxx`) are optional and only used if you're using the `price_config` database table
   - For most setups, **Product IDs are sufficient**

2. **Unit Amount Format:**
   - Always in **cents** (smallest currency unit)
   - $8.00 = `800`
   - $75.00 = `7500`
   - $96.00 = `9600`

3. **Currency:**
   - Use ISO 4217 currency codes: `usd`, `eur`, `gbp`, etc.
   - Defaults to `usd` if not specified

4. **Webhook Security:**
   - Always set `STRIPE_WEBHOOK_SECRET` in production
   - Webhook verification prevents unauthorized requests

5. **Test vs Production:**
   - Use `sk_test_` keys for testing
   - Use `sk_live_` keys for production
   - Never mix test and production keys
