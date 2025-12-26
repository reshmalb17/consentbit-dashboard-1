# Webhook Use Case Routing - Refactored Structure

## Overview

The `checkout.session.completed` webhook handler has been refactored to **first identify the use case**, then **route to the appropriate handler**. This ensures clean separation and prevents conflicts between Use Case 1 and Use Case 3.

---

## Refactored Structure

### Step 1: Identify Use Case

**Location:** `src/index.js` (Lines 1198-1218)

```javascript
// ========================================
// STEP 1: IDENTIFY USE CASE
// ========================================
// First, determine which use case this is based on session properties
// This ensures clean separation and prevents conflicts
const sessionMode = session.mode;
const sessionUseCase = session.metadata?.usecase || session.payment_intent?.metadata?.usecase;

// Determine use case based on mode and metadata
let identifiedUseCase = null;
if (sessionMode === 'payment' && sessionUseCase === '3') {
  identifiedUseCase = '3'; // Use Case 3: Quantity purchase
} else if (sessionMode === 'subscription') {
  identifiedUseCase = '1'; // Use Case 1: Direct payment link (creates new subscription)
} else {
  // Unknown use case - log and process as Use Case 1 (default)
  console.warn(`[checkout.session.completed] ⚠️ Unknown use case - mode: ${sessionMode}, usecase: ${sessionUseCase || 'not set'}. Defaulting to Use Case 1.`);
  identifiedUseCase = '1';
}

console.log(`[checkout.session.completed] 🔍 Identified Use Case: ${identifiedUseCase} (mode: ${sessionMode}, usecase: ${sessionUseCase || 'not set'})`);
```

**Identification Logic:**
- **Use Case 3**: `mode === 'payment'` AND `usecase === '3'`
- **Use Case 1**: `mode === 'subscription'` (default)
- **Unknown**: Defaults to Use Case 1 with warning

---

### Step 2: Route to Appropriate Handler

**Location:** `src/index.js` (Lines 1220-1457)

#### Use Case 3 Handler

```javascript
// ========================================
// STEP 2: ROUTE TO APPROPRIATE HANDLER
// ========================================
// Route to Use Case 3 handler
if (identifiedUseCase === '3') {
  console.log(`[checkout.session.completed] ✅ Routing to Use Case 3 handler`);
  
  // ========================================
  // USE CASE 3 HANDLER: Quantity Purchase
  // ========================================
  // ... (Use Case 3 processing logic)
  
  return new Response('ok'); // Returns early - never reaches Use Case 1
}
```

**What Use Case 3 Handler Does:**
1. Fetches payment intent and metadata
2. Checks for existing licenses (idempotency)
3. Creates separate subscriptions (one per license)
4. Stores license keys in database
5. Saves payment records
6. **Returns early** - prevents Use Case 1 processing

---

#### Use Case 1 Handler

```javascript
// ========================================
// USE CASE 1 HANDLER: Direct Payment Links
// ========================================
// This section ONLY processes Use Case 1
// Use Case 3 is handled above and returns early, so it never reaches here
if (identifiedUseCase === '1') {
  console.log(`[checkout.session.completed] ✅ Routing to Use Case 1 handler`);
  
  // ========================================
  // USE CASE 1 DEBUG: Extract Basic Info
  // ========================================
  // ... (Use Case 1 processing logic)
  
  return new Response('ok', { status: 200 });
}

// If we reach here, use case was not identified (shouldn't happen)
console.warn(`[checkout.session.completed] ⚠️ Unhandled use case - returning ok`);
return new Response('ok', { status: 200 });
```

**What Use Case 1 Handler Does:**
1. Extracts email, customer ID, subscription ID
2. Creates/updates user record
3. Creates subscription and subscription items
4. Generates license keys
5. Saves payment records
6. Creates Memberstack member
7. **Returns** after processing

---

## Flow Diagram

```
checkout.session.completed event received
    ↓
Extract session.mode and session.metadata.usecase
    ↓
STEP 1: IDENTIFY USE CASE
    ├─ mode === 'payment' && usecase === '3' → Use Case 3
    ├─ mode === 'subscription' → Use Case 1
    └─ Unknown → Default to Use Case 1 (with warning)
    ↓
STEP 2: ROUTE TO HANDLER
    ├─ IF identifiedUseCase === '3'
    │   ├─ Process Use Case 3
    │   ├─ Create separate subscriptions
    │   ├─ Store license keys
    │   └─ RETURN EARLY ✅ (prevents Use Case 1)
    │
    └─ IF identifiedUseCase === '1'
        ├─ Process Use Case 1
        ├─ Create subscription
        ├─ Generate licenses
        ├─ Create Memberstack member
        └─ RETURN ✅
```

---

## Key Benefits

### 1. **Clear Separation**
- Use Case 1 and Use Case 3 are **completely isolated**
- Each handler is in its own `if` block
- No shared logic that could cause conflicts

### 2. **Early Identification**
- Use case is identified **before** any processing
- Logs clearly show which use case is being processed
- Easy to debug and trace

### 3. **No Conflicts**
- Use Case 3 **returns early** - never reaches Use Case 1 code
- Use Case 1 only processes when `identifiedUseCase === '1'`
- Unknown cases default to Use Case 1 with warning

### 4. **Maintainability**
- Clear structure: Identify → Route → Process
- Easy to add new use cases in the future
- Each handler is self-contained

---

## Protection Mechanisms

### 1. **Mode Check (Primary)**
```javascript
sessionMode === 'payment'  // Use Case 3
sessionMode === 'subscription'  // Use Case 1
```

### 2. **Metadata Check (Secondary)**
```javascript
sessionUseCase === '3'  // Use Case 3
sessionUseCase === undefined  // Use Case 1
```

### 3. **Combined Check (Most Reliable)**
```javascript
if (sessionMode === 'payment' && sessionUseCase === '3') {
  identifiedUseCase = '3';
}
```

### 4. **Early Return**
```javascript
if (identifiedUseCase === '3') {
  // ... process Use Case 3
  return new Response('ok'); // ✅ Returns early
}

if (identifiedUseCase === '1') {
  // ... process Use Case 1
  return new Response('ok'); // ✅ Returns after processing
}
```

---

## Code Location

**File:** `src/index.js`

**Lines:**
- **1198-1218**: Step 1 - Identify Use Case
- **1220-1457**: Step 2 - Route to Use Case 3 Handler
- **1459-3563**: Step 2 - Route to Use Case 1 Handler
- **3564-3567**: Fallback return (shouldn't be reached)

---

## Testing

### Test Use Case 3:
```javascript
// Mock checkout session
const session = {
  mode: 'payment',
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

// Expected: identifiedUseCase = '3', routes to Use Case 3 handler ✅
```

### Test Use Case 1:
```javascript
// Mock checkout session
const session = {
  mode: 'subscription',
  subscription: 'sub_new_123',
  customer: 'cus_456',
  metadata: {}  // No usecase
};

// Expected: identifiedUseCase = '1', routes to Use Case 1 handler ✅
```

---

## Summary

**Before Refactoring:**
- Use Case 3 check was embedded in Use Case 1 handler
- Less clear separation
- Harder to maintain

**After Refactoring:**
- ✅ **Step 1**: Identify use case first
- ✅ **Step 2**: Route to appropriate handler
- ✅ **Clear separation**: Each use case in its own block
- ✅ **No conflicts**: Early returns prevent interference
- ✅ **Maintainable**: Easy to add new use cases

**Result:**
- Use Case 1 and Use Case 3 are **completely isolated**
- No risk of conflicts or cross-contamination
- Clear, maintainable code structure

