# Use Case 3 Webhook Flow - Complete Documentation

## Overview

Use Case 3 (License Quantity Purchase) uses **`payment_intent.succeeded`** webhook event to process payments and create separate subscriptions (Option 2: one subscription per license).

---

## Webhook Event Flow

### 1. **Webhook Event Received**

**Event Type:** `payment_intent.succeeded`

**Trigger:** User completes payment for license quantity purchase

**Location:** `src/index.js` → Line 3742

```javascript
if (event.type === 'payment_intent.succeeded') {
  console.log(`[payment_intent.succeeded] Webhook received - event ID: ${event.id || 'N/A'}`);
  const paymentIntent = event.data.object;
  const customerId = paymentIntent.customer;
```

---

### 2. **Metadata Retrieval**

**Purpose:** Get license keys, price ID, quantity, and customer ID from metadata

**Location:** `src/index.js` → Lines 3747-3770

#### Step 2.1: Check Payment Intent Metadata
```javascript
let metadata = paymentIntent.metadata || {};
```

#### Step 2.2: Fallback to Charge Metadata
If metadata is not on `payment_intent`, fetch from the associated `charge`:

```javascript
if (!metadata.usecase && paymentIntent.latest_charge) {
  const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
  if (chargeRes.status === 200 && chargeRes.body.metadata) {
    metadata = { ...metadata, ...chargeRes.body.metadata };
  }
}
```

**Why?** Stripe sometimes places metadata on the `charge` object instead of `payment_intent`.

#### Step 2.3: Extract Use Case 3 Identifier
```javascript
const useCase3 = metadata.usecase === '3'; // Primary identifier
const useCase3CustomerId = metadata.customer_id || customerId;
```

**Required Metadata Fields:**
- `usecase: '3'` - Identifies Use Case 3
- `license_keys` - JSON array of generated license keys
- `price_id` - Stripe price ID for subscription
- `quantity` - Number of licenses purchased
- `customer_id` - Stripe customer ID

---

### 3. **Use Case 3 Detection**

**Location:** `src/index.js` → Line 3774

```javascript
if (useCase3 && useCase3CustomerId) {
  console.log(`[USE CASE 3] Processing license purchase payment`);
  // Process Use Case 3...
}
```

**Protection:** `checkout.session.completed` webhook **skips** Use Case 3 to avoid duplicate processing:

```javascript
// In checkout.session.completed handler (Line 1207)
if (sessionMode === 'payment' && sessionUseCase === '3') {
  console.log(`[checkout.session.completed] Skipping Use Case 3 - will be handled by payment_intent.succeeded webhook`);
  return new Response('ok');
}
```

---

### 4. **Get User Email**

**Location:** `src/index.js` → Line 3779

```javascript
const userEmail = await getCustomerEmail(env, useCase3CustomerId);
if (!userEmail) {
  console.warn('[USE CASE 3] User email not found');
  return new Response('ok');
}
```

**Purpose:** Required for database records (licenses, payments)

---

### 5. **Parse Metadata**

**Location:** `src/index.js` → Lines 3785-3804

```javascript
let licenseKeys = [];
let priceId = null;
let quantity = 0;

// Parse license_keys JSON array
if (metadata.license_keys) {
  licenseKeys = JSON.parse(metadata.license_keys);
  console.log(`[USE CASE 3] ✅ Parsed ${licenseKeys.length} license key(s) from metadata`);
}

priceId = metadata.price_id || null;
quantity = parseInt(metadata.quantity) || licenseKeys.length || 0;
```

**Example Metadata:**
```json
{
  "usecase": "3",
  "customer_id": "cus_TfKmd04i90EWia",
  "license_keys": "[\"KEY-MR3Z-9DV2-PLRB-REUX\",\"KEY-KZSZ-TEGB-EUG3-3J78\",\"KEY-ZAXT-EDM4-6GPP-JQ5W\"]",
  "price_id": "price_1ShWWXSAczuHLTOtbNqhSk5n",
  "quantity": "3",
  "currency": "usd"
}
```

---

### 6. **Create Separate Subscriptions (Option 2)**

**Location:** `src/index.js` → Lines 3806-3849

**Purpose:** Create one subscription per license for individual management

#### Step 6.1: Loop Through Quantity
```javascript
const createdSubscriptionIds = [];
if (priceId && quantity > 0) {
  for (let i = 0; i < quantity; i++) {
    // Create subscription for each license
  }
}
```

#### Step 6.2: Create Subscription
```javascript
const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
  'customer': useCase3CustomerId,
  'items[0][price]': priceId,
  'items[0][quantity]': 1,  // One item per subscription
  'metadata[license_key]': licenseKeys[i],
  'metadata[usecase]': '3',
  'metadata[purchase_type]': 'quantity',
  'proration_behavior': 'none'  // Already charged full price
}, true);
```

**Key Points:**
- ✅ Each license gets its own subscription
- ✅ `proration_behavior: 'none'` - No additional charge (already paid)
- ✅ Metadata stored on subscription and item

#### Step 6.3: Store License Key in Item Metadata
```javascript
if (createSubRes.status === 200) {
  const newSubscription = createSubRes.body;
  createdSubscriptionIds.push(newSubscription.id);
  const itemId = newSubscription.items?.data?.[0]?.id || null;
  
  // Store license key in subscription item metadata
  if (itemId) {
    await stripeFetch(env, `/subscription_items/${itemId}`, 'POST', {
      'metadata[license_key]': licenseKeys[i]
    }, true);
  }
}
```

**Result:** 
- 3 licenses → 3 separate subscriptions
- Each subscription can be cancelled independently
- Each subscription has its own billing cycle

---

### 7. **Create License Keys in Database**

**Location:** `src/index.js` → Lines 3851-3916

#### Step 7.1: Loop Through License Keys
```javascript
if (env.DB && licenseKeys.length > 0) {
  for (let i = 0; i < licenseKeys.length; i++) {
    const licenseKey = licenseKeys[i];
    const subscriptionIdForLicense = createdSubscriptionIds[i] || null;
    // Get item ID from subscription
    // Insert license into database
  }
}
```

#### Step 7.2: Get Subscription Item ID
```javascript
let itemId = null;
if (subscriptionIdForLicense) {
  const subRes = await stripeFetch(env, `/subscriptions/${subscriptionIdForLicense}`);
  if (subRes.status === 200) {
    itemId = subRes.body.items?.data?.[0]?.id || null;
  }
}
```

#### Step 7.3: Insert License Record
```javascript
await env.DB.prepare(
  `INSERT INTO licenses 
   (license_key, customer_id, subscription_id, item_id, 
    site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
  licenseKey,                    // Generated license key
  useCase3CustomerId,            // Stripe customer ID
  subscriptionIdForLicense,       // New subscription ID
  itemId,                         // Subscription item ID
  null,                           // No site assigned initially
  null,                           // Will be set when activated
  'active',                       // Status: active after payment
  'quantity',                     // Purchase type
  timestamp,
  timestamp
).run();
```

**Database Record:**
```
license_key: KEY-MR3Z-9DV2-PLRB-REUX
customer_id: cus_TfKmd04i90EWia
subscription_id: sub_xxx (new subscription)
item_id: si_xxx
site_domain: NULL (unassigned)
status: active
purchase_type: quantity
```

---

### 8. **Save Payment Records**

**Location:** `src/index.js` → Lines 3918-3951

**Purpose:** Save one payment record per subscription created

#### Step 8.1: Calculate Amount Per Subscription
```javascript
const quantityForPayment = parseInt(paymentIntent.metadata?.quantity) || licenseKeys.length || 1;
const amountPerSubscription = Math.round((paymentIntent.amount || 0) / quantityForPayment);
```

**Example:**
- Total payment: $600 (3 licenses × $200)
- Amount per subscription: $200

#### Step 8.2: Insert Payment Records
```javascript
for (let i = 0; i < createdSubscriptionIds.length; i++) {
  await env.DB.prepare(
    `INSERT INTO payments (
      customer_id, subscription_id, email, amount, currency, 
      status, site_domain, magic_link, magic_link_generated, 
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    useCase3CustomerId,
    createdSubscriptionIds[i],      // One payment per subscription
    userEmail,
    amountPerSubscription,           // Split amount
    paymentIntent.currency || 'usd',
    'succeeded',
    null,                            // No site domain for quantity purchases
    null,
    0,
    timestamp,
    timestamp
  ).run();
}
```

**Result:**
- 3 subscriptions → 3 payment records
- Each payment record linked to its subscription
- Amount split proportionally

---

## Complete Flow Diagram

```
1. User Purchases 3 Licenses
   ↓
2. Checkout Session Created (mode: 'payment')
   - Metadata stored in payment_intent_data
   ↓
3. User Completes Payment
   ↓
4. Stripe Sends Webhook: payment_intent.succeeded
   ↓
5. Webhook Handler:
   ├─ Verify event type
   ├─ Extract metadata (from payment_intent or charge)
   ├─ Check usecase === '3'
   ├─ Get user email
   ├─ Parse license_keys, price_id, quantity
   ├─ Create 3 separate subscriptions (one per license)
   ├─ Create 3 license records in database
   └─ Create 3 payment records in database
   ↓
6. ✅ Complete: 3 subscriptions, 3 licenses, 3 payments
```

---

## Key Differences from Use Case 1

| Aspect | Use Case 1 | Use Case 3 |
|--------|------------|------------|
| **Webhook Event** | `checkout.session.completed` | `payment_intent.succeeded` |
| **Checkout Mode** | `subscription` | `payment` |
| **Subscription** | Creates 1 new subscription | Creates N subscriptions (one per license) |
| **Metadata Location** | `subscription.metadata` | `payment_intent.metadata` or `charge.metadata` |
| **Proration** | Not applicable | Not applicable (full price charged upfront) |
| **License Assignment** | Pre-assigned to sites | Unassigned (can be assigned later) |
| **Individual Management** | No (shared subscription) | Yes (separate subscriptions) |

---

## Protection Mechanisms

### 1. **Skip in checkout.session.completed**
```javascript
// Prevents duplicate processing
if (sessionMode === 'payment' && sessionUseCase === '3') {
  return new Response('ok'); // Skip - handled by payment_intent.succeeded
}
```

### 2. **Metadata Validation**
```javascript
if (useCase3 && useCase3CustomerId) {
  // Only process if usecase === '3' AND customer_id exists
}
```

### 3. **Idempotency**
```javascript
// Check if license key already exists
const existingLicense = await env.DB.prepare(
  `SELECT license_key FROM licenses WHERE license_key = ?`
).bind(licenseKey).first();

if (existingLicense) {
  console.warn(`⚠️ License key already exists, skipping`);
  continue;
}
```

---

## Error Handling

### Missing Metadata
```javascript
if (!metadata.license_keys) {
  console.warn(`⚠️ No license_keys found in metadata`);
  // Cannot create subscriptions without license keys
}
```

### Missing Price ID or Quantity
```javascript
if (!priceId || quantity === 0) {
  console.warn(`⚠️ Missing price_id or quantity, cannot create subscriptions`);
  // Skip subscription creation
}
```

### Subscription Creation Failure
```javascript
if (createSubRes.status !== 200) {
  console.error(`❌ Failed to create subscription ${i + 1}:`, createSubRes.status);
  // Continue with next license (don't fail entire batch)
}
```

### Database Errors
```javascript
try {
  await env.DB.prepare(`INSERT INTO licenses...`).run();
} catch (insertErr) {
  if (insertErr.message.includes('UNIQUE constraint')) {
    console.warn(`⚠️ License key already exists, skipping`);
  } else {
    console.error(`❌ Error creating license:`, insertErr);
  }
}
```

---

## Logging Output Example

```
[WEBHOOK] Received event type: payment_intent.succeeded, event ID: evt_xxx
[payment_intent.succeeded] Webhook received - event ID: evt_xxx
[payment_intent.succeeded] Processing payment - useCase3: true, customerId: cus_xxx, metadataKeys: usecase, customer_id, license_keys, price_id, quantity, currency
[USE CASE 3] Processing license purchase payment - will create separate subscriptions for customer: cus_xxx
[USE CASE 3] 🔍 Full metadata object: {...}
[USE CASE 3] ✅ Parsed 3 license key(s) from metadata
[USE CASE 3] 📊 Extracted: priceId=price_xxx, quantity=3, licenseKeys.length=3
[USE CASE 3] Creating 3 separate subscription(s) - one per license for individual management
[USE CASE 3] ✅ Created subscription sub_xxx1 for license KEY-xxx1 (item: si_xxx1)
[USE CASE 3] ✅ Created subscription sub_xxx2 for license KEY-xxx2 (item: si_xxx2)
[USE CASE 3] ✅ Created subscription sub_xxx3 for license KEY-xxx3 (item: si_xxx3)
[USE CASE 3] Creating 3 license key(s) in database after payment
[USE CASE 3] ✅ Created license KEY-xxx1 (subscription: sub_xxx1, item: si_xxx1)
[USE CASE 3] ✅ Created license KEY-xxx2 (subscription: sub_xxx2, item: si_xxx2)
[USE CASE 3] ✅ Created license KEY-xxx3 (subscription: sub_xxx3, item: si_xxx3)
[USE CASE 3] ✅ Payment record(s) saved for 3 subscription(s)
[USE CASE 3] ✅ License purchase payment processed successfully
```

---

## Summary

**Use Case 3 Webhook Handler:**
1. ✅ Receives `payment_intent.succeeded` event
2. ✅ Retrieves metadata from `payment_intent` or `charge`
3. ✅ Validates `usecase === '3'`
4. ✅ Creates N separate subscriptions (one per license)
5. ✅ Creates N license records in database
6. ✅ Creates N payment records (one per subscription)
7. ✅ Returns `'ok'` to acknowledge webhook

**Result:** Each license has its own subscription for individual management (cancellation, billing cycles, invoices).

