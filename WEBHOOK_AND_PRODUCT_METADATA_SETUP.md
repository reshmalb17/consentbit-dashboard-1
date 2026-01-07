# Webhook and Product Metadata Setup Guide

## Required Webhooks in Stripe Dashboard

### Step 1: Create Webhook Endpoint

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **+ Add endpoint**
3. **Endpoint URL:** `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
4. **Description:** `ConsentBit Dashboard Webhook`

### Step 2: Select Events to Send

Select these **4 required events**:

#### ✅ Required Events:

1. **`checkout.session.completed`** ⭐ **PRIMARY**
   - **Purpose:** Processes completed checkout sessions
   - **When:** After customer completes payment
   - **Handles:** 
     - Use Case 1: Direct payment links
     - Use Case 2: Site purchases
     - Use Case 3: License quantity purchases
   - **Checks:** Product metadata `usedfor: dashboard`

2. **`payment_intent.succeeded`** ⚠️ **FALLBACK**
   - **Purpose:** Fallback handler for payment mode checkouts
   - **When:** Payment is successfully processed
   - **Handles:** License quantity purchases (Use Case 3) if checkout.session.completed didn't process
   - **Note:** Usually handled by checkout.session.completed, this is a backup

3. **`customer.subscription.updated`** ✅ **REQUIRED**
   - **Purpose:** Updates subscription status and renewal dates
   - **When:** Subscription status changes (active, canceled, etc.)
   - **Handles:** 
     - Subscription renewals
     - Renewal date updates
     - Status changes

4. **`invoice.payment_succeeded`** ✅ **REQUIRED**
   - **Purpose:** Processes successful invoice payments
   - **When:** Subscription invoice is paid
   - **Handles:** 
     - Subscription renewals
     - License generation for renewals

#### ⚠️ Optional Events (Recommended):

5. **`invoice.payment_failed`**
   - **Purpose:** Logs failed payment attempts
   - **When:** Invoice payment fails
   - **Handles:** Payment failure tracking

6. **`customer.subscription.deleted`**
   - **Purpose:** Handles subscription cancellations
   - **When:** Subscription is deleted/canceled
   - **Handles:** Cleanup of canceled subscriptions

### Step 3: Copy Webhook Signing Secret

After creating the webhook:
1. Click on your webhook endpoint
2. Find **Signing secret** section
3. Click **Reveal** and copy: `whsec_xxxxx`
4. Set in Cloudflare: `wrangler secret put STRIPE_WEBHOOK_SECRET`

---

## Product Metadata Setup

### Purpose

Add metadata to products in Stripe to identify which products are for the dashboard, so the webhook can route payments correctly.

### Step 1: Add Metadata to Products in Stripe

#### For Monthly Product:
1. Go to **Stripe Dashboard** → **Products**
2. Click on your **Monthly Product**
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. Add:
   - **Key:** `usedfor`
   - **Value:** `dashboard`
6. Click **Save**

#### For Yearly Product:
1. Go to **Stripe Dashboard** → **Products**
2. Click on your **Yearly Product**
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. Add:
   - **Key:** `usedfor`
   - **Value:** `dashboard`
6. Click **Save**

### Step 2: Metadata Values

You can use different values to route to different systems:

| Value | Purpose |
|-------|---------|
| `dashboard` | Process for ConsentBit Dashboard |
| `other` | Process for other systems (if needed) |

---

## How Webhook Processes Metadata

### Current Flow:

1. **`checkout.session.completed`** webhook fires
2. Code checks metadata in this order:
   - Session metadata (`session.metadata.usecase`)
   - Customer metadata (`customer.metadata.usecase`)
   - Payment intent metadata (`payment_intent.metadata.usecase`)
3. Routes to appropriate use case handler

### With Product Metadata (New):

The code will also check:
- **Product metadata** (`product.metadata.usedfor`)
- If `usedfor === 'dashboard'`, process for dashboard
- If not, skip or route elsewhere

---

## Code Changes Required

The webhook handler will be updated to:
1. Fetch product details from Stripe
2. Check `product.metadata.usedfor`
3. Only process if `usedfor === 'dashboard'`
4. Route payment accordingly

---

## Complete Checklist

### Stripe Dashboard:
- [ ] Created webhook endpoint
- [ ] Added `checkout.session.completed` event
- [ ] Added `payment_intent.succeeded` event
- [ ] Added `customer.subscription.updated` event
- [ ] Added `invoice.payment_succeeded` event
- [ ] Copied webhook signing secret
- [ ] Added `usedfor: dashboard` metadata to Monthly Product
- [ ] Added `usedfor: dashboard` metadata to Yearly Product

### Cloudflare Workers:
- [ ] Set `STRIPE_WEBHOOK_SECRET` environment variable
- [ ] Set `STRIPE_SECRET_KEY` environment variable

---

## Testing

After setup:

1. **Test Webhook:**
   - Complete a test purchase
   - Check Stripe Dashboard → Webhooks → Your endpoint → Recent events
   - Verify events are being received

2. **Test Product Metadata:**
   - Check webhook logs for product metadata
   - Verify `usedfor: dashboard` is detected
   - Confirm payment is processed correctly

---

## Example Product Metadata

```json
{
  "usedfor": "dashboard"
}
```

This tells the webhook: "This product is for the dashboard, process it here."

---

## Complete Metadata Reference

For detailed metadata requirements for all use cases, see:
- **[COMPLETE_METADATA_REFERENCE.md](./COMPLETE_METADATA_REFERENCE.md)** - Comprehensive guide covering all metadata for Use Case 1, 2, and 3
