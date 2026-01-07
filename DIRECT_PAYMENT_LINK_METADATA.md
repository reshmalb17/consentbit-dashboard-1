# Use Case 1: Direct Payment Link Metadata Guide

## Overview

**Use Case 1** = Direct Payment Links created in **Stripe Dashboard** → **Products** → **Payment Links**. 

These links:
- Use **subscription mode** (not payment mode)
- Are identified automatically when `session.mode === 'subscription'`
- Default to Use Case 1 if no other use case metadata is set

---

## Required Metadata for Use Case 1

### In Stripe Dashboard (Payment Link Settings)

When creating or editing a Payment Link in Stripe Dashboard, you can add metadata in the **Advanced options** or **Metadata** section:

#### 1. **Product Metadata** (Required)

Add metadata to the **Product** itself (not the Payment Link):

- **Key:** `usedfor`
- **Value:** `dashboard`

**Steps:**
1. Go to **Stripe Dashboard** → **Products**
2. Click on your product
3. Scroll to **Metadata** section
4. Add: Key = `usedfor`, Value = `dashboard`
5. Click **Save**

**Why:** This tells the webhook to process this product for the dashboard.

---

#### 2. **Payment Link Metadata** (Optional but Recommended)

You can add metadata to the Payment Link itself. This metadata flows to the checkout session and subscription:

##### Option A: Via Stripe Dashboard (if supported)

If Stripe Dashboard allows metadata on Payment Links:
- **Key:** `paymentby`
- **Value:** `directlink`

##### Option B: Via API (Recommended)

When creating a Payment Link via API, you can set:

```javascript
{
  "metadata": {
    "paymentby": "directlink",
    "add_to_existing": "false",  // Optional: "true" to add to existing subscription
    "existing_subscription_id": null  // Optional: subscription ID if adding to existing
  }
}
```

---

## How Use Case 1 is Identified

The webhook automatically identifies Use Case 1 when:

```javascript
if (sessionMode === 'subscription') {
  identifiedUseCase = '1'; // Use Case 1: Direct payment link
}
```

**Key Point:** Use Case 1 is the **default** for subscription mode checkouts. No `usecase` metadata is required - it's automatically detected.

---

## How Metadata Flows

### 1. **Product Metadata** → Webhook Processing (REQUIRED)

```
Product (metadata.usedfor = "dashboard")
  ↓
Subscription created from Payment Link
  ↓
Webhook checks product.metadata.usedfor
  ↓
If "dashboard" → Process payment ✅
If not → Skip processing ❌
```

### 2. **Payment Link Metadata** → Session/Subscription Metadata (OPTIONAL)

```
Payment Link (metadata.paymentby = "directlink")
  ↓
Checkout Session (session.metadata.paymentby)
  ↓
Subscription (subscription.metadata.paymentby)
  ↓
Webhook reads metadata to determine behavior
```

### 3. **Custom Fields** → Site URL (OPTIONAL)

```
Payment Link Custom Field: "Enter Your Live Domain"
  ↓
Checkout Session (session.custom_fields)
  ↓
Webhook extracts site URL
  ↓
Saves site domain with license
```

---

## Metadata Fields Explained

### Product Metadata

| Key | Value | Required | Purpose |
|-----|-------|----------|---------|
| `usedfor` | `dashboard` | ✅ **Yes** | Identifies product as dashboard product |

### Payment Link / Session Metadata

| Key | Value | Required | Purpose |
|-----|-------|----------|---------|
| `paymentby` | `directlink` | ⚠️ Optional | Identifies payment as direct link purchase |
| `add_to_existing` | `true` or `false` | ⚠️ Optional | Whether to add to existing subscription |
| `existing_subscription_id` | Subscription ID | ⚠️ Optional | Subscription ID if adding to existing |

---

## What Happens Without Metadata

### Without Product Metadata (`usedfor: dashboard`):

- ❌ Webhook will **skip processing** the payment
- ❌ No licenses will be created
- ❌ Payment will be successful in Stripe but not processed in dashboard

### Without Payment Link Metadata:

- ✅ Payment will still be processed (if product has `usedfor: dashboard`)
- ✅ Default behavior: Creates new subscription
- ⚠️ Cannot add to existing subscription without `add_to_existing: true`

---

## Step-by-Step Setup

### Step 1: Add Product Metadata

1. Go to **Stripe Dashboard** → **Products**
2. Click on your product (Monthly or Yearly)
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. **Key:** `usedfor`
6. **Value:** `dashboard`
7. Click **Save**

**Repeat for both Monthly and Yearly products.**

### Step 2: Create Payment Link

1. Go to **Stripe Dashboard** → **Products**
2. Click on your product
3. Click **Payment Links** tab
4. Click **+ Create payment link**
5. Configure:
   - **Price:** Select your price (monthly/yearly)
   - **Mode:** Subscription (default)
   - **Success URL:** `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}`
   - **Cancel URL:** `https://dashboard.consentbit.com/dashboard`
6. **Custom Fields** (Optional):
   - Add field: "Enter Your Live Domain" (if you want to collect site URL)
7. Click **Create payment link**

### Step 3: Test Payment Link

1. Copy the Payment Link URL
2. Open in browser
3. Complete a test payment
4. Check webhook logs to verify:
   - Product metadata is detected
   - Payment is processed correctly
   - License is created

---

## Webhook Processing Flow

### When `checkout.session.completed` webhook fires:

1. **Check Product Metadata:**
   ```javascript
   // Fetches subscription → items → price → product
   const product = await fetchProduct(subscription.items[0].price.product);
   if (product.metadata.usedfor !== 'dashboard') {
     return; // Skip processing
   }
   ```

2. **Check Session Metadata:**
   ```javascript
   // Reads metadata from checkout session
   const paymentBy = session.metadata?.paymentby;
   const addToExisting = session.metadata?.add_to_existing;
   ```

3. **Process Payment:**
   - Creates license keys
   - Saves to database
   - Updates user dashboard

---

## Example: Complete Setup

### Product Setup:
```
Product: ConsentBit Monthly
Metadata:
  - usedfor: dashboard
```

### Payment Link Setup:
```
Payment Link: Monthly Subscription
Product: ConsentBit Monthly
Success URL: https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}
Cancel URL: https://dashboard.consentbit.com/dashboard
```

### Result:
- ✅ Payment Link creates subscription
- ✅ Webhook checks product metadata (`usedfor: dashboard`)
- ✅ Payment is processed
- ✅ License is created
- ✅ User sees license in dashboard

---

## Troubleshooting

### Payment successful but no license created:

1. **Check Product Metadata:**
   - Go to Stripe Dashboard → Products
   - Verify `usedfor: dashboard` is set

2. **Check Webhook Logs:**
   - Look for: `[USE CASE 1] 🏷️ Product metadata usedfor: ...`
   - If you see: `⏭️ Skipping - Product usedfor is "...", not "dashboard"`
   - → Product metadata is missing or incorrect

3. **Check Webhook Events:**
   - Go to Stripe Dashboard → Developers → Webhooks
   - Click on your webhook endpoint
   - Check if `checkout.session.completed` event was received

### Payment Link not working:

1. **Verify Product has Price:**
   - Product must have at least one active price

2. **Verify Webhook Endpoint:**
   - URL: `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`
   - Events: `checkout.session.completed` is selected

3. **Check Success/Cancel URLs:**
   - Must include `{CHECKOUT_SESSION_ID}` in success URL

---

## Use Case 1 Summary

### ✅ Required:
- **Product Metadata:** `usedfor: dashboard` (MANDATORY - webhook will skip without this)
- **Payment Link Mode:** `subscription` (automatically detected as Use Case 1)

### ⚠️ Optional:
- **Payment Link Metadata:** `paymentby: directlink` (helps identify direct links)
- **Session Metadata:** `add_to_existing: true/false` (for adding to existing subscription)
- **Custom Field:** Site URL field (if collecting domain name)

### 🎯 Key Points for Use Case 1:
1. **No `usecase` metadata needed** - Use Case 1 is automatically detected from `mode: 'subscription'`
2. **Product metadata is mandatory** - `usedfor: dashboard` must be set on the product
3. **Subscription mode only** - Use Case 1 only works with subscription mode Payment Links
4. **Metadata flows:** Product → Subscription → Webhook
5. **Always test** after setting up metadata

### 🔍 How Use Case 1 Differs from Other Use Cases:

| Use Case | Mode | Metadata Required | How Identified |
|----------|------|------------------|----------------|
| **Use Case 1** | `subscription` | `usedfor: dashboard` (product) | Auto-detected from mode |
| Use Case 2 | `payment` | `usecase: '2'` + `usedfor: dashboard` | Explicit metadata |
| Use Case 3 | `payment` | `usecase: '3'` + `usedfor: dashboard` | Explicit metadata |

---

## Quick Reference

```javascript
// Product Metadata (REQUIRED)
{
  "usedfor": "dashboard"
}

// Payment Link Metadata (OPTIONAL)
{
  "paymentby": "directlink",
  "add_to_existing": "false",
  "existing_subscription_id": null
}
```

---

## Complete Metadata Reference

For detailed metadata requirements for all use cases, see:
- **[COMPLETE_METADATA_REFERENCE.md](./COMPLETE_METADATA_REFERENCE.md)** - Comprehensive guide covering all metadata for Use Case 1, 2, and 3
