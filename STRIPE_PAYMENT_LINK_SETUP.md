# Stripe Payment Link & Dashboard Redirect Setup

## Overview
This document explains how to configure Stripe Payment Links and Checkout Sessions to redirect to your dashboard after payment.

## Your Payment Link
**Payment Link URL:** `https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08`

## Configuration Options

### Option 1: Configure Payment Link in Stripe Dashboard (Recommended)

If you want to use your **Payment Link** directly, configure the success/cancel URLs in Stripe Dashboard:

1. Go to **Stripe Dashboard** → **Products** → **Payment Links**
2. Click on your payment link (or create a new one)
3. Go to **Settings** → **After payment**
4. Set **Success page**:
   - Select **Custom URL**
   - Enter: `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}`
5. Set **Cancel page**:
   - Select **Custom URL**
   - Enter: `https://memberstack-login-test-713fa5.webflow.io/dashboard`

**Note:** Payment Links use `{CHECKOUT_SESSION_ID}` placeholder which Stripe will replace with the actual session ID.

### Option 2: Use Payment Link Directly in Code

If you want to redirect users directly to your Payment Link:

```javascript
// In your frontend code
window.location.href = 'https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08';
```

Then configure the success/cancel URLs in Stripe Dashboard as described in Option 1.

### Option 3: Checkout Sessions (Already Updated)

The code has been updated to redirect to your dashboard for all **Checkout Sessions** created via API:

- **Success URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success`
- **Cancel URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard`

This applies to:
- `/create-checkout-from-pending` (adding sites to existing subscription)
- `/purchase-quantity` (quantity-based license purchases)
- `/create-checkout-session` (legacy endpoint)

## Environment Variable

You can configure the dashboard URL via environment variable:

**In `wrangler.jsonc`:**
```json
"vars": {
  "MEMBERSTACK_REDIRECT_URL": "https://memberstack-login-test-713fa5.webflow.io/dashboard"
}
```

**Or set as secret in Cloudflare Dashboard:**
- Go to Workers & Pages → Your Worker → Settings → Variables
- Add `MEMBERSTACK_REDIRECT_URL` as an environment variable

## URL Parameters

After successful payment, users will be redirected with:
- `session_id={CHECKOUT_SESSION_ID}` - Stripe session ID (for tracking)
- `payment=success` - Indicates successful payment

You can use these in your dashboard to:
- Show a success message
- Refresh subscription data
- Track payment completion

## Testing

1. **Test Payment Link:**
   - Visit: `https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08`
   - Complete test payment
   - Should redirect to: `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id=cs_test_...`

2. **Test Checkout Sessions:**
   - Add sites to pending list
   - Click "Pay Now"
   - Complete payment
   - Should redirect to dashboard with success parameters

## Important Notes

- **Payment Links** are pre-configured in Stripe Dashboard - success/cancel URLs must be set there
- **Checkout Sessions** (created via API) - success/cancel URLs are set in code (already updated)
- Both methods will redirect to your dashboard after payment
- The `{CHECKOUT_SESSION_ID}` placeholder is automatically replaced by Stripe
