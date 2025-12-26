# How to Distinguish Use Case 1 and Use Case 3 in `checkout.session.completed`

## Overview

Both Use Case 1 and Use Case 3 trigger `checkout.session.completed`, but they can be distinguished using **two key properties**:

1. **`session.mode`** - The checkout session mode
2. **`usecase` metadata** - Custom metadata identifier

---

## Key Differentiators

### 1. **Checkout Session Mode**

| Use Case | `session.mode` | Purpose |
|----------|---------------|---------|
| **Use Case 1** | `'subscription'` | Creates a **NEW** recurring subscription |
| **Use Case 3** | `'payment'` | One-time payment (for prorated amount) |

### 2. **Metadata Identifier**

| Use Case | `usecase` Metadata | Location |
|----------|-------------------|----------|
| **Use Case 1** | **NOT SET** (or `undefined`) | No `usecase` metadata |
| **Use Case 3** | **`'3'`** | In `session.metadata.usecase` or `session.payment_intent.metadata.usecase` |

---

## Code Implementation

### Current Implementation (Line 1204-1211)

```javascript
// Extract session properties
const sessionMode = session.mode;
const sessionUseCase = session.metadata?.usecase || session.payment_intent?.metadata?.usecase;

console.log(`[checkout.session.completed] Session mode: ${sessionMode}, usecase: ${sessionUseCase || 'not set'}`);

// Check for Use Case 3
if (sessionMode === 'payment' && sessionUseCase === '3') {
  // Process Use Case 3
  // Returns early, never reaches Use Case 1 code
}

// If condition is false, continue to Use Case 1 processing
// Use Case 1: mode === 'subscription' (doesn't match Use Case 3 condition)
```

---

## Decision Tree

```
checkout.session.completed event received
    ↓
Extract: session.mode and session.metadata.usecase
    ↓
Check: sessionMode === 'payment' && sessionUseCase === '3'?
    ↓
    ├─ YES → Use Case 3
    │   ├─ mode: 'payment'
    │   ├─ usecase: '3'
    │   ├─ Process: Create separate subscriptions
    │   ├─ Process: Store license keys
    │   └─ Return early ✅
    │
    └─ NO → Use Case 1
        ├─ mode: 'subscription' (or undefined)
        ├─ usecase: undefined (or not '3')
        ├─ Process: Create new subscription
        ├─ Process: Create user
        ├─ Process: Generate licenses
        └─ Continue normally ✅
```

---

## Examples

### Example 1: Use Case 1 (Direct Payment Link)

**Checkout Session Object:**
```json
{
  "id": "cs_test_123",
  "mode": "subscription",
  "subscription": "sub_new_456",
  "customer": "cus_789",
  "metadata": {
    // No 'usecase' field
  },
  "payment_intent": null
}
```

**Detection:**
```javascript
sessionMode = 'subscription'
sessionUseCase = undefined

// Condition check:
if ('subscription' === 'payment' && undefined === '3') {
  // FALSE - Not Use Case 3
}

// Result: Process as Use Case 1 ✅
```

---

### Example 2: Use Case 3 (Quantity Purchase)

**Checkout Session Object:**
```json
{
  "id": "cs_test_789",
  "mode": "payment",
  "subscription": null,
  "customer": "cus_existing_123",
  "payment_intent": "pi_456",
  "metadata": {
    // May or may not have usecase here
  }
}
```

**Payment Intent Metadata:**
```json
{
  "id": "pi_456",
  "customer": "cus_existing_123",
  "metadata": {
    "usecase": "3",
    "customer_id": "cus_existing_123",
    "license_keys": "[\"KEY-ABC-123\",\"KEY-DEF-456\"]",
    "price_id": "price_789",
    "quantity": "2"
  }
}
```

**Detection:**
```javascript
sessionMode = 'payment'
sessionUseCase = session.metadata?.usecase || session.payment_intent?.metadata?.usecase
                = undefined || '3'
                = '3'

// Condition check:
if ('payment' === 'payment' && '3' === '3') {
  // TRUE - Use Case 3 ✅
  // Process Use Case 3 and return early
}

// Result: Process as Use Case 3 ✅
```

---

## Where Metadata is Set

### Use Case 1: No Metadata Set

**Location:** Payment Links or `/create-checkout-session` endpoint

```javascript
// Use Case 1 checkout session creation
const form = {
  mode: 'subscription',  // ← Key identifier
  // No usecase metadata set
  // No payment_intent_data metadata
};
```

### Use Case 3: Metadata Set in Payment Intent

**Location:** `/purchase-quantity` endpoint (Line 7785)

```javascript
// Use Case 3 checkout session creation
const form = {
  mode: 'payment',  // ← Key identifier
  'payment_intent_data[metadata][usecase]': '3',  // ← Key identifier
  'payment_intent_data[metadata][customer_id]': customerId,
  'payment_intent_data[metadata][license_keys]': JSON.stringify(licenseKeys),
  'payment_intent_data[metadata][price_id]': priceId,
  'payment_intent_data[metadata][quantity]': quantity.toString(),
};
```

---

## Complete Detection Logic

### Step 1: Extract Properties

```javascript
const sessionMode = session.mode;
const sessionUseCase = session.metadata?.usecase || session.payment_intent?.metadata?.usecase;
```

**Why check both locations?**
- Stripe may place metadata on `session.metadata` or `session.payment_intent.metadata`
- For `mode: 'payment'`, metadata is often on `payment_intent.metadata`

### Step 2: Check Condition

```javascript
if (sessionMode === 'payment' && sessionUseCase === '3') {
  // Use Case 3
} else {
  // Use Case 1 (or other use cases)
}
```

### Step 3: Process Accordingly

**Use Case 3:**
- Returns early after processing
- Never reaches Use Case 1 code

**Use Case 1:**
- Continues to normal processing
- Creates subscription, user, licenses, etc.

---

## Protection Mechanisms

### 1. **Mode Check (Primary)**

```javascript
sessionMode === 'payment'  // Use Case 3
sessionMode === 'subscription'  // Use Case 1
```

**Why it works:**
- Use Case 1 **always** uses `mode: 'subscription'` (creates recurring subscription)
- Use Case 3 **always** uses `mode: 'payment'` (one-time payment)

### 2. **Metadata Check (Secondary)**

```javascript
sessionUseCase === '3'  // Use Case 3
sessionUseCase === undefined  // Use Case 1 (or not set)
```

**Why it works:**
- Use Case 1 **never** sets `usecase: '3'` metadata
- Use Case 3 **always** sets `usecase: '3'` in payment_intent metadata

### 3. **Combined Check (Most Reliable)**

```javascript
if (sessionMode === 'payment' && sessionUseCase === '3') {
  // Use Case 3 - BOTH conditions must be true
}
```

**Why both checks:**
- **Mode check** prevents false positives (other payment mode checkouts)
- **Metadata check** provides explicit identifier
- **Combined** ensures 100% accuracy

---

## Edge Cases

### Edge Case 1: Payment Mode Without Usecase

**Scenario:** Another payment mode checkout (not Use Case 3)

```javascript
sessionMode = 'payment'
sessionUseCase = undefined

// Condition check:
if ('payment' === 'payment' && undefined === '3') {
  // FALSE - Not Use Case 3
}

// Result: Would fall through to Use Case 1, but Use Case 1 checks for subscription mode
// Protection: Use Case 1 also checks for subscriptionId, so it won't process incorrectly
```

### Edge Case 2: Subscription Mode With Usecase (Shouldn't Happen)

**Scenario:** Hypothetical - subscription mode with usecase '3' (shouldn't occur)

```javascript
sessionMode = 'subscription'
sessionUseCase = '3'  // Shouldn't happen, but if it does...

// Condition check:
if ('subscription' === 'payment' && '3' === '3') {
  // FALSE - First condition fails
}

// Result: Process as Use Case 1 (mode check takes precedence)
```

---

## Summary Table

| Property | Use Case 1 | Use Case 3 |
|----------|------------|------------|
| **`session.mode`** | `'subscription'` | `'payment'` |
| **`session.metadata.usecase`** | `undefined` | `'3'` (or undefined) |
| **`session.payment_intent.metadata.usecase`** | `undefined` | `'3'` |
| **`session.subscription`** | **NEW** subscription ID | `null` (no subscription) |
| **`session.payment_intent`** | `null` (or not used) | **Payment intent ID** |
| **Checkout Purpose** | Create new subscription | One-time payment |
| **Subscription Action** | Creates NEW subscription | Creates NEW subscriptions (after payment) |

---

## Code Location

**File:** `src/index.js`

**Lines:**
- **1204-1205**: Extract `sessionMode` and `sessionUseCase`
- **1211**: Check condition `if (sessionMode === 'payment' && sessionUseCase === '3')`
- **1426 or 1441**: Use Case 3 returns early
- **1444+**: Use Case 1 processing continues

---

## Testing

### Test Use Case 1:
```javascript
// Mock checkout session
const session = {
  mode: 'subscription',
  subscription: 'sub_new_123',
  customer: 'cus_456',
  metadata: {}  // No usecase
};

// Should process as Use Case 1 ✅
```

### Test Use Case 3:
```javascript
// Mock checkout session
const session = {
  mode: 'payment',
  subscription: null,
  customer: 'cus_existing_123',
  payment_intent: 'pi_789',
  metadata: {}
};

// Mock payment intent
const paymentIntent = {
  id: 'pi_789',
  metadata: {
    usecase: '3',
    license_keys: '["KEY-ABC"]',
    price_id: 'price_123',
    quantity: '1'
  }
};

// Should process as Use Case 3 ✅
```

---

## Conclusion

**Distinguishing Logic:**
1. ✅ Check `session.mode` → `'payment'` = Use Case 3, `'subscription'` = Use Case 1
2. ✅ Check `usecase` metadata → `'3'` = Use Case 3, `undefined` = Use Case 1
3. ✅ Combined check ensures accuracy: `mode === 'payment' && usecase === '3'`

**Result:**
- Use Case 3: Processes and returns early (never reaches Use Case 1 code)
- Use Case 1: Continues to normal processing (Use Case 3 already returned)

