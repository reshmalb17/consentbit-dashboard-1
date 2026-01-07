# Complete Setup Checklist - What to Do Next

**Related:** See **[COMPLETE_TESTING_GUIDE.md](./COMPLETE_TESTING_GUIDE.md)** for comprehensive testing after setup.

## ✅ Step 1: Stripe Dashboard Setup (COMPLETED)

### Payment Links
- [x] Created Payment Link(s) for Monthly/Yearly products
- [x] Set Success URL: `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success`
- [x] Set Cancel URL: `https://dashboard.consentbit.com/dashboard`

---

## ✅ Step 2: Product Metadata (REQUIRED - Do This Next!)

### Monthly Product (`prod_SHWZdF20XLXtn9`)

1. Go to **Stripe Dashboard** → **Products**
2. Click on product: `prod_SHWZdF20XLXtn9`
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. **Key:** `usedfor`
6. **Value:** `dashboard`
7. Click **Save**

### Yearly Product (`prod_SJQgqC8uDgRcOi`)

1. Go to **Stripe Dashboard** → **Products**
2. Click on product: `prod_SJQgqC8uDgRcOi`
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. **Key:** `usedfor`
6. **Value:** `dashboard`
7. Click **Save**

**⚠️ CRITICAL:** Without this metadata, webhooks will skip processing payments!

---

## ✅ Step 3: Webhook Setup (REQUIRED - Do This Next!)

### Create Webhook Endpoint

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **+ Add endpoint**
3. **Endpoint URL:** `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
4. **Description:** `ConsentBit Dashboard Webhook`
5. **Select Events to Send:**
   - ✅ `checkout.session.completed`
   - ✅ `payment_intent.succeeded`
   - ✅ `customer.subscription.updated`
   - ✅ `invoice.payment_succeeded`
   - (Optional) `invoice.payment_failed`
   - (Optional) `customer.subscription.deleted`
6. Click **Add endpoint**
7. **Copy Signing Secret:** `whsec_xxxxx` ⚠️ **SAVE THIS**

---

## ✅ Step 4: Environment Variables Setup

### Set in Cloudflare Workers

Run these commands in your terminal:

```bash
cd consentbit-dashboard-1

# Stripe Credentials (REQUIRED)
wrangler secret put STRIPE_SECRET_KEY --name consentbit-dashboard-test
# Enter: sk_test_xxxxx or sk_live_xxxxx

wrangler secret put STRIPE_WEBHOOK_SECRET --name consentbit-dashboard-test
# Enter: whsec_xxxxx (from Step 3)

# Product IDs (OPTIONAL - already set in code as defaults)
wrangler secret put MONTHLY_PRODUCT_ID --name consentbit-dashboard-test
# Enter: prod_SHWZdF20XLXtn9

wrangler secret put YEARLY_PRODUCT_ID --name consentbit-dashboard-test
# Enter: prod_SJQgqC8uDgRcOi

# Pricing (OPTIONAL - already set in code as defaults)
wrangler secret put MONTHLY_UNIT_AMOUNT --name consentbit-dashboard-test
# Enter: 800 (for $8.00/month)

wrangler secret put YEARLY_UNIT_AMOUNT --name consentbit-dashboard-test
# Enter: 7500 (for $75.00/year)

# Currency (OPTIONAL - defaults to usd)
wrangler secret put MONTHLY_CURRENCY --name consentbit-dashboard-test
# Enter: usd

wrangler secret put YEARLY_CURRENCY --name consentbit-dashboard-test
# Enter: usd
```

### Verify Environment Variables

```bash
wrangler secret list --name consentbit-dashboard-test
```

**Required:**
- ✅ `STRIPE_SECRET_KEY`
- ✅ `STRIPE_WEBHOOK_SECRET`

**Optional (have defaults in code):**
- `MONTHLY_PRODUCT_ID` (default: `prod_SHWZdF20XLXtn9`)
- `YEARLY_PRODUCT_ID` (default: `prod_SJQgqC8uDgRcOi`)
- `MONTHLY_UNIT_AMOUNT` (default: `800`)
- `YEARLY_UNIT_AMOUNT` (default: `7500`)

---

## ✅ Step 5: Deploy Code (If Not Already Deployed)

```bash
cd consentbit-dashboard-1
wrangler deploy --name consentbit-dashboard-test
```

---

## ✅ Step 6: Testing

### Test Payment Link

1. **Get Payment Link URL:**
   - Stripe Dashboard → Products → Your Product → Payment Links
   - Copy the Payment Link URL

2. **Test Payment:**
   - Open Payment Link in browser
   - Use Stripe test card: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/34`)
   - CVC: Any 3 digits (e.g., `123`)
   - Complete payment

3. **Verify Redirect:**
   - Should redirect to: `https://dashboard.consentbit.com/dashboard?session_id=cs_test_xxxxx&payment=success`
   - Check if dashboard loads correctly

4. **Check Webhook:**
   - Stripe Dashboard → Developers → Webhooks → Your endpoint
   - Click on endpoint → **Recent events**
   - Verify `checkout.session.completed` event was received
   - Check if event shows ✅ (success) or ❌ (failed)

5. **Check Webhook Logs:**
   - Look for: `[USE CASE 1] 🏷️ Product metadata usedfor: dashboard`
   - Should see: `✅ Identified use case: 1`
   - Should see license creation logs

6. **Verify License Created:**
   - Check dashboard → Licenses section
   - Verify license key was created
   - Verify license shows in "Not Assigned" or assigned to site

---

## ✅ Step 7: Verify Everything Works

### Checklist:

- [ ] Payment Link redirects correctly after payment
- [ ] Webhook receives `checkout.session.completed` event
- [ ] Webhook processes payment successfully (check logs)
- [ ] License is created in database
- [ ] License appears in dashboard
- [ ] Product metadata `usedfor: dashboard` is set
- [ ] Environment variables are set correctly

---

## 🚨 Troubleshooting

### Payment successful but no license created:

1. **Check Product Metadata:**
   - Verify `usedfor: dashboard` is set on product
   - Check webhook logs for: `⏭️ Skipping - Product usedfor is "...", not "dashboard"`

2. **Check Webhook:**
   - Verify webhook endpoint is receiving events
   - Check if events show errors
   - Verify webhook signing secret is correct

3. **Check Environment Variables:**
   ```bash
   wrangler secret list --name consentbit-dashboard-test
   ```
   - Verify `STRIPE_SECRET_KEY` is set
   - Verify `STRIPE_WEBHOOK_SECRET` is set

### Webhook not receiving events:

1. **Check Webhook URL:**
   - Verify: `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
   - Test URL in browser (should return error, but confirms endpoint exists)

2. **Check Events Selected:**
   - Verify `checkout.session.completed` is selected
   - Verify webhook is active (not disabled)

3. **Check Worker Deployment:**
   ```bash
   wrangler deploy --name consentbit-dashboard-test
   ```

### Wrong redirect URL:

1. **For Payment Links:**
   - Edit Payment Link in Stripe Dashboard
   - Update "After payment" URLs
   - Save changes

---

## 📋 Current Configuration Summary

### Products

| Product | Product ID | Unit Amount | Currency | Metadata Status |
|---------|-----------|-------------|----------|-----------------|
| Monthly | `prod_SHWZdF20XLXtn9` | $8.00 (800 cents) | USD | ⚠️ Needs `usedfor: dashboard` |
| Yearly | `prod_SJQgqC8uDgRcOi` | $75.00 (7500 cents) | USD | ⚠️ Needs `usedfor: dashboard` |

### URLs

| Type | URL |
|------|-----|
| **Webhook URL** | `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook` |
| **Success URL** | `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success` |
| **Cancel URL** | `https://dashboard.consentbit.com/dashboard` |

### Environment Variables

| Variable | Value | Required |
|----------|-------|----------|
| `STRIPE_SECRET_KEY` | `sk_test_xxxxx` or `sk_live_xxxxx` | ✅ Yes |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxxx` | ✅ Yes |
| `MONTHLY_PRODUCT_ID` | `prod_SHWZdF20XLXtn9` | ⚠️ Optional (has default) |
| `YEARLY_PRODUCT_ID` | `prod_SJQgqC8uDgRcOi` | ⚠️ Optional (has default) |
| `MONTHLY_UNIT_AMOUNT` | `800` | ⚠️ Optional (has default) |
| `YEARLY_UNIT_AMOUNT` | `7500` | ⚠️ Optional (has default) |

---

## 🎯 Next Steps After Setup

### 1. Test All Use Cases

- [ ] **Use Case 1:** Test Payment Link (Direct payment)
- [ ] **Use Case 2:** Test Site Purchase (via dashboard)
- [ ] **Use Case 3:** Test License Quantity Purchase (via dashboard)

### 2. Monitor Webhooks

- [ ] Check webhook logs regularly
- [ ] Monitor for failed events
- [ ] Set up alerts for webhook failures (optional)

### 3. Production Checklist

- [ ] Switch to production Stripe keys (`sk_live_xxxxx`)
- [ ] Update webhook endpoint for production
- [ ] Test with real payment methods
- [ ] Verify all products have `usedfor: dashboard` metadata

---

## 📚 Related Documentation

- **[COMPLETE_METADATA_REFERENCE.md](./COMPLETE_METADATA_REFERENCE.md)** - All metadata requirements
- **[STRIPE_REDIRECT_URLS_SETUP.md](./STRIPE_REDIRECT_URLS_SETUP.md)** - Redirect URL setup
- **[WEBHOOK_AND_PRODUCT_METADATA_SETUP.md](./WEBHOOK_AND_PRODUCT_METADATA_SETUP.md)** - Webhook setup guide
- **[SETUP_MONTHLY_PRODUCT.md](./SETUP_MONTHLY_PRODUCT.md)** - Monthly product setup
- **[SETUP_YEARLY_PRODUCT.md](./SETUP_YEARLY_PRODUCT.md)** - Yearly product setup

---

## ✅ Quick Action Items

**Do these NOW:**

1. ✅ **Add Product Metadata** (CRITICAL)
   - Monthly product: `usedfor: dashboard`
   - Yearly product: `usedfor: dashboard`

2. ✅ **Create Webhook Endpoint**
   - URL: `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
   - Events: `checkout.session.completed`, `payment_intent.succeeded`, `customer.subscription.updated`, `invoice.payment_succeeded`
   - Copy signing secret

3. ✅ **Set Environment Variables**
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`

4. ✅ **Test Payment Link**
   - Complete test payment
   - Verify redirect works
   - Verify license is created

---

## 🎉 You're Done When:

- ✅ Product metadata is set (`usedfor: dashboard`)
- ✅ Webhook endpoint is created and receiving events
- ✅ Environment variables are set
- ✅ Test payment creates license successfully
- ✅ License appears in dashboard

**Once all checkboxes are checked, your setup is complete!**
