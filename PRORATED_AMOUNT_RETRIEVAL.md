# How Prorated Amount is Retrieved Before Checkout Session

## Current Flow for Use Case 3

### Step-by-Step Process

```
1. Generate License Keys
   ↓
2. Add Subscription Items (with proration_behavior: 'create_prorations')
   ↓
3. Get Prorated Amount from Stripe's Upcoming Invoice API
   ↓
4. Create Checkout Session
```

---

## Step 2: Add Subscription Items (Triggers Proration)

**Location**: `src/index.js` → Lines ~7285-7334

**Process**: Add subscription items to existing subscription with proration enabled.

```javascript
for (let i = 0; i < quantity; i++) {
  const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
    'subscription': subscriptionId,
    'price': priceId,
    'quantity': 1,
    'metadata[license_key]': licenseKeys[i],
    'proration_behavior': 'create_prorations' // ✅ This triggers proration calculation
  });
}
```

**What Happens**:
- ✅ Stripe calculates proration automatically
- ✅ Prorated amount is added to upcoming invoice
- ✅ Subscription items are now part of the subscription

---

## Step 3: Get Prorated Amount from Stripe

**Location**: `src/index.js` → Lines ~7363-7398

**Process**: Retrieve the prorated amount from Stripe's upcoming invoice.

```javascript
// Get upcoming invoice to see prorated amount
const upcomingInvoiceRes = await stripeFetch(env, `/invoices/upcoming?subscription=${subscriptionId}`);

if (upcomingInvoiceRes.status === 200) {
  const upcomingInvoice = upcomingInvoiceRes.body;
  proratedAmount = upcomingInvoice.amount_due || 0;
  console.log(`[USE CASE 3] ✅ Retrieved prorated amount: ${proratedAmount}`);
}
```

**API Call**:
```http
GET https://api.stripe.com/v1/invoices/upcoming?subscription=sub_ExistingSub456
```

**Response**:
```json
{
  "id": "in_upcoming_xxx",
  "amount_due": 2300,  // ✅ Prorated amount in cents
  "currency": "usd",
  "subscription": "sub_ExistingSub456",
  "lines": {
    "data": [
      {
        "amount": 2300,
        "description": "Proration for subscription items",
        "proration": true
      }
    ]
  }
}
```

**Example Calculation**:
- Monthly price per license: `$10.00` (1000 cents)
- Quantity: `3` licenses
- Days remaining in billing period: `23 days`
- Total days in period: `30 days`
- **Prorated amount**: `(1000 * 3) * (23/30) = 2300 cents = $23.00`

---

## Step 4: Create Checkout Session

**Location**: `src/index.js` → Lines ~7400-7420

**Current Implementation**:
```javascript
const form = {
  mode: 'payment', // One-time payment
  customer: customerId,
  'line_items[0][price]': priceId,
  'line_items[0][quantity]': quantity,  // e.g., 3
  // ... metadata
};
```

**Issue**: The checkout session is created with `line_items` using the full price, not the prorated amount!

---

## ⚠️ Potential Issue

### Current Behavior:
1. ✅ Prorated amount is retrieved: `$23.00` (2300 cents)
2. ❌ Checkout session uses full price: `$30.00` (1000 * 3 = 3000 cents)
3. ❌ User sees wrong amount in checkout

### Why This Happens:
- Stripe calculates proration on the **subscription invoice**
- But checkout session `line_items` uses the **full price**
- The prorated amount is retrieved but **not used** in checkout session creation

---

## Solutions

### Option 1: Use Custom Amount (Recommended)

Set the exact prorated amount in the checkout session:

```javascript
const form = {
  mode: 'payment',
  customer: customerId,
  'line_items[0][price_data][currency]': 'usd',
  'line_items[0][price_data][unit_amount]': proratedAmount, // ✅ Use prorated amount
  'line_items[0][price_data][product_data][name]': `${quantity} License(s) - Prorated`,
  'line_items[0][quantity]': 1, // Always 1 for custom amount
  // ... metadata
};
```

**Pros**:
- ✅ User sees exact prorated amount
- ✅ Matches what they'll pay
- ✅ Clear and accurate

**Cons**:
- ❌ Requires creating price_data inline
- ❌ More complex

---

### Option 2: Use Stripe's Automatic Proration (Current - Needs Fix)

Let Stripe handle proration automatically by using subscription items:

```javascript
const form = {
  mode: 'payment',
  customer: customerId,
  'subscription': subscriptionId, // ✅ Reference existing subscription
  'payment_intent_data[setup_future_usage]': 'off_session',
  // Stripe will automatically calculate prorated amount
  // ... metadata
};
```

**But**: This doesn't work with `mode: 'payment'` - it requires `mode: 'subscription'`.

---

### Option 3: Create Invoice and Pay It (Best for Accuracy)

Create an invoice for the prorated amount and pay it:

```javascript
// Step 1: Create invoice (Stripe calculates proration automatically)
const invoiceRes = await stripeFetch(env, '/invoices', 'POST', {
  'customer': customerId,
  'subscription': subscriptionId,
  'auto_advance': false, // Don't auto-finalize
  'collection_method': 'send_invoice'
});

// Step 2: Finalize invoice (calculates proration)
const invoiceId = invoiceRes.body.id;
await stripeFetch(env, `/invoices/${invoiceId}/finalize`, 'POST', {});

// Step 3: Pay invoice via checkout
const form = {
  mode: 'payment',
  'invoice': invoiceId, // ✅ Pay the specific invoice
  // ... metadata
};
```

**Pros**:
- ✅ Stripe handles all proration calculations
- ✅ Exact amount matches
- ✅ Proper invoice tracking

**Cons**:
- ❌ More API calls
- ❌ More complex flow

---

### Option 4: Use Payment Intent Directly (Simplest)

Create a payment intent with the exact prorated amount:

```javascript
// Step 1: Create payment intent with prorated amount
const paymentIntentRes = await stripeFetch(env, '/payment_intents', 'POST', {
  'amount': proratedAmount, // ✅ Exact prorated amount
  'currency': 'usd',
  'customer': customerId,
  'metadata[usecase]': '3',
  'metadata[subscription_id]': subscriptionId,
  'metadata[license_keys]': JSON.stringify(licenseKeys),
  'metadata[item_ids]': JSON.stringify(createdItemIds)
});

// Step 2: Create checkout session to confirm payment intent
const form = {
  mode: 'payment',
  'payment_intent': paymentIntentRes.body.id, // ✅ Use existing payment intent
  'success_url': dashboardUrl,
  'cancel_url': dashboardUrl
};
```

**Pros**:
- ✅ Exact prorated amount
- ✅ Simple and direct
- ✅ Works with `mode: 'payment'`

**Cons**:
- ❌ Requires creating payment intent first

---

## Recommended Solution

**Use Option 4: Payment Intent with Exact Amount**

This is the cleanest approach:
1. ✅ Get prorated amount from upcoming invoice
2. ✅ Create payment intent with exact amount
3. ✅ Create checkout session to confirm payment intent
4. ✅ User sees exact prorated amount

---

## Current Code Issue

**Problem**: Prorated amount is retrieved but not used in checkout session.

**Current Code**:
```javascript
// ✅ Step 3: Get prorated amount
proratedAmount = upcomingInvoice.amount_due; // e.g., 2300 cents

// ❌ Step 4: Create checkout with full price
const form = {
  'line_items[0][price]': priceId, // Full price: 1000 cents
  'line_items[0][quantity]': quantity, // 3
  // Total: 3000 cents (WRONG - should be 2300 cents)
};
```

**Fix Needed**: Use the prorated amount in checkout session creation.

---

## Implementation Fix

Update checkout session creation to use prorated amount:

```javascript
const form = {
  mode: 'payment',
  customer: customerId,
  // Option A: Use custom amount
  'line_items[0][price_data][currency]': 'usd',
  'line_items[0][price_data][unit_amount]': proratedAmount, // ✅ Use prorated amount
  'line_items[0][price_data][product_data][name]': `${quantity} License(s) - Prorated`,
  'line_items[0][quantity]': 1,
  // ... metadata
};
```

Or use payment intent approach (recommended).

---

## Summary

### Current Flow:
1. ✅ Add subscription items (triggers proration)
2. ✅ Get prorated amount from upcoming invoice
3. ❌ **Create checkout with full price** (BUG!)

### Fixed Flow:
1. ✅ Add subscription items (triggers proration)
2. ✅ Get prorated amount from upcoming invoice
3. ✅ **Create checkout with prorated amount** (FIXED!)

The prorated amount **is retrieved** but **not used** in checkout session creation. This needs to be fixed to show the correct amount to users.

