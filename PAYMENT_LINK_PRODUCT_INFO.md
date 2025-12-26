# Stripe Payment Link - Product Information Guide

## Quick Answer: **No Product IDs Required in Code** ✅

When you change your Stripe Payment Link, you **do NOT need to update any product IDs in your code**. The webhook handler automatically extracts all product and price information from Stripe.

## How It Works

### 1. **Payment Link Configuration (Stripe Dashboard)**
- Payment Links are configured in **Stripe Dashboard** → **Products** → **Payment Links**
- You select which **Product** and **Price** to use when creating the link
- No code changes needed

### 2. **Webhook Processing (Automatic)**
When a payment is completed via your Payment Link:

1. **Stripe sends webhook** → `checkout.session.completed`
2. **Your code extracts**:
   - `subscription_id` - From webhook payload
   - `customer_id` - From webhook payload
   - `email` - From customer details
3. **Your code fetches subscription**:
   ```javascript
   const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
   ```
4. **Subscription contains**:
   - All `subscription.items.data[]` with:
     - `item.price.id` (Price ID) ✅
     - `item.price.product` (Product ID) ✅
     - `item.metadata.site` (if configured)
   - All product/price info is automatically available

### 3. **License Generation (Automatic)**
- Code reads `sub.items.data` array
- Extracts price IDs and product IDs automatically
- Generates licenses based on subscription items
- **No hardcoded product IDs needed**

## What You DO Need to Configure

### ✅ Required: Success/Cancel URLs
In **Stripe Dashboard** → **Payment Links** → **Settings** → **After payment**:

- **Success URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}`
- **Cancel URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard`

### ✅ Required: Webhook Endpoint
Make sure your webhook endpoint is configured in Stripe:
- **Endpoint URL:** `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
- **Events:** `checkout.session.completed`, `subscription.updated`, `customer.subscription.deleted`

### ✅ Optional: Product/Price IDs (For Reference Only)
If you want to **track or validate** which products are associated with your payment link, you can find them in:

**Stripe Dashboard** → **Products** → **Payment Links** → Click your link → **Product details**

You'll see:
- **Product ID:** `prod_xxxxx` (e.g., `prod_TZhSQII1jkyj0Y`)
- **Price ID:** `price_xxxxx` (e.g., `price_1Sc89ISAczuHLTOtGHNji8Ay`)

**But these are NOT required in your code** - they're just for reference.

## Optional: If You Want to Track Payment Link Usage

If you want to know which payment link was used, you can check the webhook payload:

```javascript
// In webhook handler
const session = event.data.object;
const paymentLinkId = session.payment_link; // If payment was via payment link
```

But this is **optional** - the code works without it.

## Summary

| Item | Required in Code? | Where to Configure |
|------|------------------|-------------------|
| Product ID | ❌ No | Stripe Dashboard (Payment Link settings) |
| Price ID | ❌ No | Stripe Dashboard (Payment Link settings) |
| Success URL | ✅ Yes | Stripe Dashboard (Payment Link → Settings → After payment) |
| Cancel URL | ✅ Yes | Stripe Dashboard (Payment Link → Settings → After payment) |
| Webhook Endpoint | ✅ Yes | Stripe Dashboard (Developers → Webhooks) |

## Your Current Payment Link

**URL:** `https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08`

**What to do:**
1. ✅ Configure success/cancel URLs in Stripe Dashboard (see above)
2. ✅ Make sure webhook is configured
3. ❌ **No code changes needed** - webhook extracts everything automatically

## Testing

1. Use your payment link: `https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08`
2. Complete a test payment
3. Check webhook logs - you'll see:
   - Product IDs extracted automatically
   - Price IDs extracted automatically
   - Licenses generated automatically
   - No hardcoded IDs needed!

