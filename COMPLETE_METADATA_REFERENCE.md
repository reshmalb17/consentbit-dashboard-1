# Complete Metadata Reference Guide

## Overview

This guide covers **all metadata requirements** for all use cases in the ConsentBit Dashboard system. Metadata is used to route payments, identify use cases, and process payments correctly.

**Related Guides:**
- **[STRIPE_REDIRECT_URLS_SETUP.md](./STRIPE_REDIRECT_URLS_SETUP.md)** - How to set redirect URLs in Stripe Dashboard

---

## Table of Contents

1. [Product Metadata (Required for All Use Cases)](#product-metadata)
2. [Use Case 1: Direct Payment Links](#use-case-1-direct-payment-links)
3. [Use Case 2: Site Purchases](#use-case-2-site-purchases)
4. [Use Case 3: License Quantity Purchases](#use-case-3-license-quantity-purchases)
5. [Webhook Metadata Processing](#webhook-metadata-processing)
6. [Quick Reference Table](#quick-reference-table)

---

## Product Metadata

### ✅ REQUIRED: Product Metadata

**Location:** Stripe Dashboard → Products → Your Product → Metadata

**Required for ALL products (Monthly and Yearly):**

| Key | Value | Purpose |
|-----|-------|---------|
| `usedfor` | `dashboard` | Identifies product as dashboard product - **webhook will skip processing without this** |

**Steps to Add:**
1. Go to **Stripe Dashboard** → **Products**
2. Click on your product (Monthly or Yearly)
3. Scroll to **Metadata** section
4. Click **+ Add metadata**
5. **Key:** `usedfor`
6. **Value:** `dashboard`
7. Click **Save**

**Repeat for both Monthly and Yearly products.**

**Why Required:** The webhook checks `product.metadata.usedfor === 'dashboard'` before processing any payment. Without this, payments will be skipped.

---

## Use Case 1: Direct Payment Links

### Overview
- **Mode:** `subscription`
- **How Identified:** Automatically detected when `session.mode === 'subscription'`
- **No `usecase` metadata needed** - auto-detected

### Required Metadata

#### 1. Product Metadata (REQUIRED)
- **Location:** Product → Metadata
- **Key:** `usedfor`
- **Value:** `dashboard`

### Optional Metadata

#### 2. Payment Link / Session Metadata (OPTIONAL)
- **Location:** Payment Link (via API) or Checkout Session
- **Purpose:** Control behavior for direct links

| Key | Value | Purpose |
|-----|-------|---------|
| `paymentby` | `directlink` | Identifies payment as direct link purchase |
| `add_to_existing` | `true` or `false` | Whether to add to existing subscription |
| `existing_subscription_id` | Subscription ID | Subscription ID if adding to existing |

**Note:** Stripe Dashboard Payment Links may not support custom metadata. These are only available when creating Payment Links via API.

### Custom Fields (OPTIONAL)

#### 3. Site URL Field (OPTIONAL)
- **Location:** Payment Link → Custom Fields
- **Field Key:** `enteryourlivedomain`
- **Purpose:** Collect site domain during checkout
- **Type:** Text input

---

## Use Case 2: Site Purchases

### Overview
- **Mode:** `payment`
- **How Identified:** `metadata.usecase === '2'`
- **Endpoint:** `/create-site-checkout` or `/add-sites-batch`

### Required Metadata

#### 1. Product Metadata (REQUIRED)
- **Location:** Product → Metadata
- **Key:** `usedfor`
- **Value:** `dashboard`

#### 2. Payment Intent Metadata (REQUIRED - Set by Code)
The code automatically sets these when creating checkout sessions:

| Key | Value | Purpose |
|-----|-------|---------|
| `usecase` | `'2'` | Identifies as Use Case 2 |
| `purchase_type` | `'site'` | Distinguishes from Use Case 3 |
| `customer_id` | Customer ID | Customer identifier |
| `product_id` | Product ID | Product identifier |
| `sites_json` | JSON array | Array of site names |
| `sites` | JSON array | Alternative key for sites |
| `billing_period` | `'monthly'` or `'yearly'` | Billing period |
| `currency` | Currency code | Currency (e.g., `usd`) |

**Example:**
```javascript
{
  "usecase": "2",
  "purchase_type": "site",
  "customer_id": "cus_xxxxx",
  "product_id": "prod_SJQgqC8uDgRcOi",
  "sites_json": "[\"example.com\", \"test.com\"]",
  "billing_period": "monthly",
  "currency": "usd"
}
```

#### 3. Subscription Metadata (Set by Code)
When creating subscriptions for sites:

| Key | Value | Purpose |
|-----|-------|---------|
| `usecase` | `'2'` | Identifies as Use Case 2 |
| `purchase_type` | `'site'` | Distinguishes from Use Case 3 |
| `site` | Site domain | Site domain name |
| `license_key` | License key | Generated license key |

---

## Use Case 3: License Quantity Purchases

### Overview
- **Mode:** `payment`
- **How Identified:** `metadata.usecase === '3'`
- **Endpoint:** `/purchase-quantity`

### Required Metadata

#### 1. Product Metadata (REQUIRED)
- **Location:** Product → Metadata
- **Key:** `usedfor`
- **Value:** `dashboard`

#### 2. Payment Intent Metadata (REQUIRED - Set by Code)
The code automatically sets these when creating checkout sessions:

| Key | Value | Purpose |
|-----|-------|---------|
| `usecase` | `'3'` | Identifies as Use Case 3 |
| `purchase_type` | `'quantity'` | Distinguishes from Use Case 2 |
| `customer_id` | Customer ID | Customer identifier |
| `product_id` | Product ID | Product identifier |
| `price_id` | Price ID | Price identifier |
| `quantity` | Number (string) | Number of licenses |
| `billing_period` | `'monthly'` or `'yearly'` | Billing period |
| `currency` | Currency code | Currency (e.g., `usd`) |

**Example:**
```javascript
{
  "usecase": "3",
  "purchase_type": "quantity",
  "customer_id": "cus_xxxxx",
  "product_id": "prod_SJQgqC8uDgRcOi",
  "price_id": "price_xxxxx",
  "quantity": "5",
  "billing_period": "yearly",
  "currency": "usd"
}
```

#### 3. Customer Metadata (Set by Code - Optional Fallback)
If payment intent metadata exceeds limits, license keys are stored in customer metadata:

| Key | Value | Purpose |
|-----|-------|---------|
| `usecase` | `'3'` | Identifies as Use Case 3 |
| `license_keys_pending` | JSON array | Array of license keys |
| `product_id` | Product ID | Product identifier |

#### 4. Subscription Metadata (Set by Code)
When creating subscriptions for licenses:

| Key | Value | Purpose |
|-----|-------|---------|
| `usecase` | `'3'` | Identifies as Use Case 3 |
| `purchase_type` | `'quantity'` | Distinguishes from Use Case 2 |
| `license_key` | License key | Generated license key |

---

## Webhook Metadata Processing

### How Webhooks Check Metadata

#### 1. Use Case Identification

The webhook identifies use cases in this order:

```javascript
// Step 1: Check session mode
if (sessionMode === 'subscription') {
  identifiedUseCase = '1'; // Use Case 1
} else if (sessionMode === 'payment') {
  // Step 2: Check metadata
  if (metadata.usecase === '3') {
    identifiedUseCase = '3'; // Use Case 3
  } else if (metadata.usecase === '2') {
    identifiedUseCase = '2'; // Use Case 2
  }
}
```

#### 2. Product Metadata Check (REQUIRED)

**All use cases check product metadata:**

```javascript
// Fetch product
const product = await fetchProduct(productId);

// Check metadata
if (product.metadata.usedfor !== 'dashboard') {
  return; // Skip processing
}
```

**Checked in:**
- `checkout.session.completed` webhook (all use cases)
- `customer.subscription.updated` webhook
- `invoice.payment_succeeded` webhook

#### 3. Metadata Sources (Priority Order)

For Use Case 3, metadata is checked in this order:

1. **Payment Intent Metadata** (primary)
2. **Customer Metadata** (fallback)
3. **Session Metadata** (fallback)

---

## Quick Reference Table

### Product Metadata (REQUIRED for ALL)

| Product | Key | Value | Required |
|---------|-----|-------|----------|
| Monthly | `usedfor` | `dashboard` | ✅ Yes |
| Yearly | `usedfor` | `dashboard` | ✅ Yes |

### Use Case Metadata

| Use Case | Mode | Identification | Product Metadata | Additional Metadata |
|----------|------|----------------|------------------|---------------------|
| **Use Case 1** | `subscription` | Auto-detected | ✅ Required | Optional: `paymentby`, `add_to_existing` |
| **Use Case 2** | `payment` | `usecase: '2'` | ✅ Required | Required: `sites_json`, `product_id`, `billing_period` |
| **Use Case 3** | `payment` | `usecase: '3'` | ✅ Required | Required: `quantity`, `product_id`, `price_id`, `billing_period` |

### Metadata Set by Code (Automatic)

| Use Case | Where Set | Metadata Keys |
|----------|-----------|---------------|
| Use Case 2 | Checkout Session | `usecase`, `purchase_type`, `customer_id`, `product_id`, `sites_json`, `billing_period` |
| Use Case 3 | Checkout Session | `usecase`, `purchase_type`, `customer_id`, `product_id`, `price_id`, `quantity`, `billing_period` |
| Use Case 2 | Subscription | `usecase`, `purchase_type`, `site`, `license_key` |
| Use Case 3 | Subscription | `usecase`, `purchase_type`, `license_key` |

---

## Setup Checklist

### Stripe Dashboard Setup

- [ ] **Monthly Product:**
  - [ ] Created product
  - [ ] Added price (monthly recurring)
  - [ ] Added metadata: `usedfor: dashboard`

- [ ] **Yearly Product:**
  - [ ] Created product (`prod_SJQgqC8uDgRcOi`)
  - [ ] Added price (yearly recurring)
  - [ ] Added metadata: `usedfor: dashboard`

- [ ] **Webhook Endpoint:**
  - [ ] Created webhook endpoint
  - [ ] Added events: `checkout.session.completed`, `payment_intent.succeeded`, `customer.subscription.updated`, `invoice.payment_succeeded`
  - [ ] Copied webhook signing secret

### Environment Variables

- [ ] `STRIPE_SECRET_KEY` - Stripe secret key
- [ ] `STRIPE_WEBHOOK_SECRET` - Webhook signing secret
- [ ] `MONTHLY_PRODUCT_ID` - Monthly product ID
- [ ] `YEARLY_PRODUCT_ID` - Yearly product ID (`prod_SJQgqC8uDgRcOi`)
- [ ] `MONTHLY_UNIT_AMOUNT` - Monthly price in cents (default: `800` = $8.00)
- [ ] `YEARLY_UNIT_AMOUNT` - Yearly price in cents (default: `7500` = $75.00)
- [ ] `MONTHLY_CURRENCY` - Monthly currency (default: `usd`)
- [ ] `YEARLY_CURRENCY` - Yearly currency (default: `usd`)

---

## Current Configuration

### Products

| Product | Product ID | Unit Amount | Currency | Metadata |
|---------|-----------|-------------|----------|----------|
| Monthly | `prod_SHWZdF20XLXtn9` | $8.00 (800 cents) | USD | `usedfor: dashboard` |
| Yearly | `prod_SJQgqC8uDgRcOi` | $75.00 (7500 cents) | USD | `usedfor: dashboard` |

### Pricing

| Period | Amount | In Cents | Default |
|--------|--------|----------|---------|
| Monthly | $8.00 | 800 | ✅ Set in code |
| Yearly | $75.00 | 7500 | ✅ Set in code |

---

## Troubleshooting

### Payment successful but not processed

1. **Check Product Metadata:**
   - Verify `usedfor: dashboard` is set on the product
   - Check webhook logs for: `⏭️ Skipping - Product usedfor is "...", not "dashboard"`

2. **Check Use Case Identification:**
   - Use Case 1: Verify `mode === 'subscription'`
   - Use Case 2: Verify `metadata.usecase === '2'`
   - Use Case 3: Verify `metadata.usecase === '3'`

3. **Check Webhook Events:**
   - Verify webhook endpoint is receiving events
   - Check Stripe Dashboard → Webhooks → Your endpoint → Recent events

### Metadata not found

1. **Use Case 2/3:**
   - Verify checkout session includes `payment_intent_data[metadata][usecase]`
   - Check payment intent metadata in Stripe Dashboard

2. **Product Metadata:**
   - Verify metadata is set on the product (not price or payment link)
   - Check product ID matches the one used in checkout

---

## Examples

### Use Case 1: Direct Payment Link

**Product Setup:**
```
Product: ConsentBit Monthly
Metadata:
  usedfor: dashboard
```

**Payment Link:**
```
Mode: subscription
Product: ConsentBit Monthly (with usedfor: dashboard)
Success URL: https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}
```

### Use Case 2: Site Purchase

**Checkout Session Metadata (Set by Code):**
```json
{
  "usecase": "2",
  "purchase_type": "site",
  "customer_id": "cus_xxxxx",
  "product_id": "prod_SJQgqC8uDgRcOi",
  "sites_json": "[\"example.com\", \"test.com\"]",
  "billing_period": "monthly",
  "currency": "usd"
}
```

### Use Case 3: License Quantity Purchase

**Checkout Session Metadata (Set by Code):**
```json
{
  "usecase": "3",
  "purchase_type": "quantity",
  "customer_id": "cus_xxxxx",
  "product_id": "prod_SJQgqC8uDgRcOi",
  "price_id": "price_xxxxx",
  "quantity": "5",
  "billing_period": "yearly",
  "currency": "usd"
}
```

---

## Summary

### ✅ Always Required:
- **Product Metadata:** `usedfor: dashboard` on ALL products

### ✅ Set Automatically by Code:
- Use Case 2 metadata (checkout session, subscription)
- Use Case 3 metadata (checkout session, subscription, customer)

### ⚠️ Optional:
- Use Case 1 Payment Link metadata (`paymentby`, `add_to_existing`)
- Custom fields for site URL collection

### 🎯 Key Points:
1. **Product metadata is mandatory** - webhook skips without it
2. **Use Case 1 is auto-detected** - no `usecase` metadata needed
3. **Use Case 2/3 metadata is set by code** - no manual setup needed
4. **Always verify product metadata** before testing payments
