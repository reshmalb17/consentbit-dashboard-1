# Webhook Differentiation: Use Case 1 vs Use Case 3

## Overview

The system uses **different webhook events** and **metadata checks** to differentiate between Use Case 1 (Direct Payment Link) and Use Case 3 (License Purchase).

---

## Key Differentiators

### 1. **Webhook Event Type**

| Use Case | Webhook Event | Mode | Subscription |
|----------|--------------|------|--------------|
| **Use Case 1** | `checkout.session.completed` | `subscription` | **NEW** subscription created |
| **Use Case 3** | `payment_intent.succeeded` | `payment` | **EXISTING** subscription |

### 2. **Metadata Identifiers**

| Use Case | Metadata Field | Value | Purpose |
|----------|---------------|-------|---------|
| **Use Case 1** | `usecase` | **NOT SET** (or `undefined`) | No usecase metadata = Use Case 1 |
| **Use Case 3** | `usecase` | **`'3'`** | Explicit identifier for Use Case 3 |

### 3. **Subscription Status**

| Use Case | `existingSubscriptionId` | `addToExisting` | Subscription Action |
|----------|------------------------|-----------------|-------------------|
| **Use Case 1** | **`null`** or **`undefined`** | **`false`** or **`undefined`** | Creates **NEW** subscription |
| **Use Case 3** | **Present** (e.g., `sub_...`) | **`true`** (implicit) | Adds to **EXISTING** subscription |

---

## Webhook Flow

### Use Case 1: Direct Payment Link

**Webhook**: `checkout.session.completed`

**Flow**:
```
1. User clicks Stripe Payment Link
2. Payment completed → Stripe sends checkout.session.completed
3. Handler checks:
   - ✅ mode === 'subscription' (creates new subscription)
   - ✅ subscriptionId is NEW (not existing)
   - ✅ usecase metadata is NOT '3' (or undefined)
4. Processes as Use Case 1:
   - Creates new subscription
   - Creates user record
   - Generates license keys
   - Creates Memberstack member
```

**Code Check**:
```javascript
if (event.type === 'checkout.session.completed') {
  // Use Case 1: Direct payment link
  // No usecase === '3' check needed here
  // This webhook ONLY handles new subscriptions
}
```

**Metadata Example**:
```json
{
  "mode": "subscription",
  "subscription": "sub_NEW123",  // NEW subscription
  "metadata": {
    // No usecase field = Use Case 1
  }
}
```

---

### Use Case 3: License Purchase

**Webhook**: `payment_intent.succeeded`

**Flow**:
```
1. User purchases quantity via dashboard
2. Payment completed → Stripe sends payment_intent.succeeded
3. Handler checks:
   - ✅ usecase === '3' (explicit identifier)
   - ✅ existingSubscriptionId is present
   - ✅ customerId is present
4. Processes as Use Case 3:
   - Creates license keys in database
   - Maps to existing subscription
   - Does NOT create new subscription
   - Does NOT create new user
```

**Code Check**:
```javascript
if (event.type === 'payment_intent.succeeded') {
  const useCase3 = paymentIntent.metadata?.usecase === '3';
  const existingSubscriptionId = paymentIntent.metadata?.subscription_id;
  
  // USE CASE 3: Only processes if usecase === '3'
  if (useCase3 && existingSubscriptionId && customerId) {
    // Process Use Case 3
    // Create license keys from metadata
  }
  
  // Use Case 2: Site-based purchase (addToExisting === 'true')
  if (addToExisting && existingSubscriptionId && customerId) {
    // Process Use Case 2
  }
  
  // Use Case 1: Will NOT reach here (uses checkout.session.completed)
}
```

**Metadata Example**:
```json
{
  "mode": "payment",
  "metadata": {
    "usecase": "3",  // ✅ Explicit Use Case 3 identifier
    "subscription_id": "sub_EXISTING456",  // Existing subscription
    "license_keys": "[\"KEY-...\", ...]",
    "item_ids": "[\"si_...\", ...]"
  }
}
```

---

## Protection Mechanisms

### 1. **Separate Webhook Handlers**

Use Case 1 and Use Case 3 use **completely different webhook events**:
- Use Case 1: `checkout.session.completed` → Processes Use Case 1 (with protection to skip Use Case 3)
- Use Case 3: `payment_intent.succeeded` → **ONLY** processes if `usecase === '3'`

### 1a. **Both Webhooks Fire for Use Case 3**

**Important**: When Use Case 3 completes payment, **BOTH** webhooks fire:
1. `checkout.session.completed` - Fires when checkout session completes
2. `payment_intent.succeeded` - Fires when payment succeeds

**Protection**: `checkout.session.completed` handler has **early return** to skip Use Case 3:
```javascript
// Early check: Skip Use Case 3
const sessionMode = session.mode;
const sessionUseCase = session.metadata?.usecase || session.payment_intent?.metadata?.usecase;

if (sessionMode === 'payment' && sessionUseCase === '3') {
  console.log(`[checkout.session.completed] Skipping Use Case 3 - will be handled by payment_intent.succeeded webhook`);
  return new Response('ok');
}

// Additional check after fetching subscription
const subscriptionUseCase = subscriptionMetadata.usecase;
if (subscriptionUseCase === '3' || subscriptionUseCase === 3) {
  console.log(`[checkout.session.completed] Skipping Use Case 3 (detected from subscription metadata)`);
  return new Response('ok');
}
```

### 2. **Explicit Metadata Check**

Use Case 3 handler has **explicit check**:
```javascript
const useCase3 = paymentIntent.metadata?.usecase === '3';

// Only processes Use Case 3 if:
if (useCase3 && existingSubscriptionId && customerId) {
  // Use Case 3 logic
}
```

**Use Case 1 will NEVER have `usecase === '3'`** because:
- Payment links don't set this metadata
- New subscriptions don't have this metadata
- Only `/purchase-quantity` endpoint sets `usecase: '3'`

### 3. **Early Return in Use Case 3**

Use Case 3 handler **returns early** after processing:
```javascript
if (useCase3 && existingSubscriptionId && customerId) {
  // Process Use Case 3
  // ...
  console.log(`[USE CASE 3] ✅ License purchase payment processed successfully`);
  return new Response('ok');  // ✅ Returns early - doesn't process Use Case 1/2
}
```

### 4. **Subscription Status Check**

Use Case 1 creates **NEW** subscription:
- `subscriptionId` is **new** (doesn't exist in database)
- No `existingSubscriptionId` in metadata

Use Case 3 uses **EXISTING** subscription:
- `subscriptionId` **already exists** in database
- `existingSubscriptionId` is **present** in metadata

---

## Code Flow Diagram

### Use Case 1 Flow
```
Stripe Payment Link Payment
    ↓
checkout.session.completed webhook
    ↓
Check: mode === 'subscription' ✅
Check: usecase !== '3' ✅ (early return if Use Case 3)
Check: subscriptionId is NEW ✅
    ↓
Process Use Case 1:
- Create user
- Create subscription
- Generate licenses
- Create Memberstack member
    ↓
✅ Complete
```

### Use Case 3 Flow
```
Dashboard Quantity Purchase
    ↓
BOTH webhooks fire:
1. checkout.session.completed
2. payment_intent.succeeded
    ↓
checkout.session.completed:
  Check: mode === 'payment' && usecase === '3' ✅
  → Early return (skip processing)
    ↓
payment_intent.succeeded:
  Check: usecase === '3' ✅
  Check: existingSubscriptionId exists ✅
  Check: customerId exists ✅
    ↓
Process Use Case 3:
- Create license keys from metadata
- Map to existing subscription
- Save payment record
    ↓
return new Response('ok') ✅ (Early return)
    ↓
✅ Complete (Use Case 1 NOT processed)
```

---

## Testing Scenarios

### Scenario 1: Use Case 1 Payment Link
**Input**:
- Webhook: `checkout.session.completed`
- Mode: `subscription`
- Metadata: `{}` (no usecase)

**Result**:
- ✅ Processes as Use Case 1
- ✅ Creates new subscription
- ✅ Does NOT trigger Use Case 3 logic

### Scenario 2: Use Case 3 Quantity Purchase
**Input**:
- Webhook: `payment_intent.succeeded`
- Mode: `payment`
- Metadata: `{ usecase: '3', subscription_id: 'sub_EXISTING' }`

**Result**:
- ✅ Processes as Use Case 3
- ✅ Creates license keys
- ✅ Does NOT create new subscription
- ✅ Returns early (doesn't process Use Case 1/2)

### Scenario 3: Use Case 2 Site Purchase
**Input**:
- Webhook: `payment_intent.succeeded`
- Mode: `payment`
- Metadata: `{ add_to_existing: 'true', subscription_id: 'sub_EXISTING' }`
- No `usecase: '3'`

**Result**:
- ✅ Processes as Use Case 2
- ✅ Adds site to existing subscription
- ✅ Does NOT trigger Use Case 3 logic (no `usecase === '3'`)

---

## Summary

### Why Use Case 1 Won't Trigger Use Case 3:

1. ✅ **Different Webhook Events**: Use Case 1 uses `checkout.session.completed`, Use Case 3 uses `payment_intent.succeeded`
2. ✅ **Explicit Metadata Check**: Use Case 3 requires `usecase === '3'`, which Use Case 1 never sets
3. ✅ **Early Return**: Use Case 3 handler returns immediately after processing
4. ✅ **Subscription Status**: Use Case 1 creates NEW subscription, Use Case 3 uses EXISTING subscription

### Why Use Case 3 Won't Trigger Use Case 1:

1. ✅ **Early Return in checkout.session.completed**: Checks `mode === 'payment' && usecase === '3'` and returns early
2. ✅ **Subscription Metadata Check**: Also checks `subscription.metadata.usecase === '3'` and returns early
3. ✅ **Explicit Check**: Use Case 3 handler checks `usecase === '3'` before processing
4. ✅ **Early Return**: Use Case 3 returns early in `payment_intent.succeeded`, never reaches Use Case 1 logic

### Both Webhooks Fire for Use Case 3:

**Important**: When Use Case 3 completes payment:
- ✅ `checkout.session.completed` fires → **Early return** (skips processing)
- ✅ `payment_intent.succeeded` fires → **Processes Use Case 3**

**Protection**: `checkout.session.completed` handler has **two checks**:
1. Early check: `session.mode === 'payment' && usecase === '3'` → Return early
2. After subscription fetch: `subscription.metadata.usecase === '3'` → Return early

---

## Code Reference

### Use Case 1 Handler
**Location**: `src/index.js` → Line ~1034
```javascript
if (event.type === 'checkout.session.completed') {
  // Use Case 1: Direct payment link
  // Creates new subscription
  // No usecase check needed
}
```

### Use Case 3 Handler
**Location**: `src/index.js` → Line ~3720
```javascript
if (event.type === 'payment_intent.succeeded') {
  const useCase3 = paymentIntent.metadata?.usecase === '3';
  
  if (useCase3 && existingSubscriptionId && customerId) {
    // Process Use Case 3
    // ...
    return new Response('ok'); // Early return
  }
}
```

---

## Conclusion

**Use Case 1 and Use Case 3 are completely isolated**:
- ✅ Different webhook events
- ✅ Explicit metadata checks
- ✅ Early returns prevent cross-contamination
- ✅ Different subscription handling (new vs existing)

**No risk of Use Case 1 triggering Use Case 3 logic or vice versa.**

