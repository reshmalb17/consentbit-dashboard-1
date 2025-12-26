# Quantity Purchase Flow - Complete Documentation

## Overview
Quantity purchases allow users to buy multiple license keys at once without specifying site names upfront. Each quantity generates one license key that can be assigned to any site later.

## Complete Flow

### 1. **Frontend: User Initiates Purchase**

**Location:** `dashboard-script.js` → `handleQuantityPurchase()`

```javascript
// User enters quantity (e.g., 5) and clicks "Purchase Now"
async function handleQuantityPurchase(userEmail, quantity) {
  const response = await fetch(`${API_BASE}/purchase-quantity`, {
    method: 'POST',
    body: JSON.stringify({
      email: userEmail,
      quantity: parseInt(quantity)  // e.g., 5
    })
  });
  
  // Redirects to Stripe checkout
  window.location.href = data.checkout_url;
}
```

**What happens:**
- User enters quantity in the License Keys tab
- Frontend calls `/purchase-quantity` endpoint
- Receives Stripe checkout URL
- Redirects user to Stripe checkout page

---

### 2. **Backend: Create Checkout Session**

**Location:** `src/index.js` → `POST /purchase-quantity`

**Steps:**

1. **Validate Request:**
   - Extract `email` and `quantity` from request body
   - Verify user exists and has a customer ID
   - Determine which price to use (from existing subscription or DEFAULT_PRICE_ID)

2. **Create Stripe Checkout Session:**
   ```javascript
   const form = {
     'mode': 'subscription',
     'customer': customerId,
     'line_items[0][price]': priceToUse,
     'line_items[0][quantity]': quantity,  // e.g., 5
     'subscription_data[metadata][purchase_type]': 'quantity',
     'subscription_data[metadata][quantity]': quantity.toString(),
     'success_url': dashboardUrl,
     'cancel_url': dashboardUrl
   };
   ```

3. **Key Points:**
   - **Mode:** `subscription` (recurring billing)
   - **Quantity:** Set on the line item (e.g., quantity: 5)
   - **Metadata:** Stored in `subscription_data.metadata`:
     - `purchase_type: 'quantity'`
     - `quantity: '5'`
   - **Redirect:** Goes back to dashboard after payment

4. **Response:**
   ```json
   {
     "checkout_url": "https://checkout.stripe.com/...",
     "session_id": "cs_..."
   }
   ```

---

### 3. **Stripe: Payment Processing**

**What Stripe Does:**
- Displays checkout page with quantity (e.g., "5 × $10.00 = $50.00")
- User enters payment details
- Stripe processes payment
- Creates subscription with:
  - One subscription item
  - Item quantity = 5
  - Subscription metadata includes `purchase_type: 'quantity'` and `quantity: '5'`
- Sends webhook event: `checkout.session.completed`

---

### 4. **Webhook: Process Payment**

**Location:** `src/index.js` → Webhook handler for `checkout.session.completed`

**Flow:**

#### Step 4.1: Extract Metadata
```javascript
// Check multiple sources for purchase_type and quantity
let purchaseType = subscriptionMetadata.purchase_type || 'site';
let quantity = parseInt(subscriptionMetadata.quantity) || 1;

// Check session.metadata
if (session.metadata?.purchase_type) {
  purchaseType = session.metadata.purchase_type;
}

// Check session.subscription_data.metadata (PRIMARY SOURCE)
if (session.subscription_data?.metadata?.purchase_type) {
  purchaseType = session.subscription_data.metadata.purchase_type;
  quantity = parseInt(session.subscription_data.metadata.quantity) || quantity;
}
```

#### Step 4.2: Detect Purchase Type
```javascript
if (purchaseType === 'quantity') {
  // Quantity purchase logic
} else {
  // Site-based purchase logic
}
```

#### Step 4.3: Calculate Licenses Needed
```javascript
if (purchaseType === 'quantity') {
  // Get quantity from subscription item (most reliable)
  const itemQuantity = sub.items.data[0].quantity || quantity || 1;
  totalLicensesNeeded = itemQuantity;  // e.g., 5
  
  // Check existing licenses to avoid duplicates
  const existingCount = existingLicenses.length;
  const neededCount = totalLicensesNeeded - existingCount;  // e.g., 5 - 0 = 5
}
```

#### Step 4.4: Generate License Keys
```javascript
if (neededCount > 0) {
  for (let i = 0; i < neededCount; i++) {
    licensesToCreate.push({ 
      site: null,  // No site assigned yet
      item_id: sub.items.data[0].id 
    });
  }
  
  // Generate unique license keys
  const licenseKeys = generateLicenseKeys(neededCount);
  // e.g., ['KEY-XXXX-XXXX-XXXX', 'KEY-YYYY-YYYY-YYYY', ...]
}
```

#### Step 4.5: Save to Database
```javascript
// Save each license key to licenses table
for (let i = 0; i < licenseKeys.length; i++) {
  await env.DB.prepare(
    `INSERT INTO licenses 
     (license_key, customer_id, subscription_id, item_id, 
      site_domain, used_site_domain, status, purchase_type, 
      created_at, updated_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    licenseKeys[i],           // license_key
    customerId,                // customer_id
    subscriptionId,            // subscription_id
    itemId,                    // item_id
    null,                      // site_domain (NULL for quantity purchases)
    null,                      // used_site_domain (NULL until activated)
    'active',                  // status
    'quantity',                // purchase_type
    timestamp,                 // created_at
    timestamp                  // updated_at
  ).run();
}
```

**Key Database Fields:**
- `site_domain`: `NULL` (no site assigned initially)
- `used_site_domain`: `NULL` (will be set when license is activated)
- `purchase_type`: `'quantity'`
- `status`: `'active'`

---

### 5. **Dashboard: Display License Keys**

**Location:** `dashboard-script.js` → `displayLicenseKeys()`

**What User Sees:**
- Table with all license keys
- Columns:
  - **License Key:** `KEY-XXXX-XXXX-XXXX` (with copy button)
  - **Status:** "Available" (if `used_site_domain` is NULL)
  - **Used For Site:** "Not assigned" (if unused)
  - **Purchase Type:** "Quantity Purchase"
  - **Created Date:** When license was generated

**Example Display:**
```
License Key          | Status    | Used For Site | Purchase Type
---------------------|-----------|---------------|------------------
KEY-XXXX-XXXX-XXXX   | Available | Not assigned  | Quantity Purchase
KEY-YYYY-YYYY-YYYY   | Available | Not assigned  | Quantity Purchase
KEY-ZZZZ-ZZZZ-ZZZZ   | Available | Not assigned  | Quantity Purchase
...
```

---

### 6. **License Activation (Optional)**

**Location:** `src/index.js` → `POST /activate-license`

**When User Activates:**
```javascript
// User calls /activate-license with license key and site domain
POST /activate-license
{
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.example.com",
  "email": "user@example.com"
}
```

**What Happens:**
1. System validates:
   - License key exists
   - License key belongs to user
   - License key is not already used
   - License key is active

2. Updates database:
   ```sql
   UPDATE licenses 
   SET used_site_domain = 'www.example.com',
       updated_at = CURRENT_TIMESTAMP
   WHERE license_key = 'KEY-XXXX-XXXX-XXXX'
   ```

3. Dashboard now shows:
   - **Status:** "Used"
   - **Used For Site:** "www.example.com"

---

## Key Differences: Quantity vs Site Purchase

| Aspect | Quantity Purchase | Site Purchase |
|--------|------------------|---------------|
| **Input** | Quantity number (e.g., 5) | Site domain (e.g., "www.example.com") |
| **Checkout** | One line item with quantity | One line item per site |
| **Metadata** | `purchase_type: 'quantity'` | `purchase_type: 'site'` (default) |
| **License Generation** | N licenses (N = quantity) | 1 license per site |
| **site_domain** | `NULL` initially | Set to site domain |
| **used_site_domain** | `NULL` until activated | Same as `site_domain` |
| **Activation** | Required (via `/activate-license`) | Automatic (pre-assigned) |

---

## Database Schema

### `licenses` Table
```sql
CREATE TABLE licenses (
  license_key TEXT PRIMARY KEY,        -- Unique license key
  customer_id TEXT NOT NULL,           -- Stripe customer ID
  subscription_id TEXT,                -- Stripe subscription ID
  item_id TEXT,                        -- Stripe subscription item ID
  site_domain TEXT,                    -- Original site (NULL for quantity purchases)
  used_site_domain TEXT,               -- Site where license is used (NULL if unused)
  status TEXT NOT NULL DEFAULT 'active', -- 'active' or 'inactive'
  purchase_type TEXT DEFAULT 'site',   -- 'site' or 'quantity'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Example Records

**Quantity Purchase (5 licenses):**
```
license_key          | site_domain | used_site_domain | purchase_type
---------------------|-------------|------------------|---------------
KEY-AAAA-AAAA-AAAA   | NULL        | NULL             | quantity
KEY-BBBB-BBBB-BBBB   | NULL        | NULL             | quantity
KEY-CCCC-CCCC-CCCC   | NULL        | NULL             | quantity
KEY-DDDD-DDDD-DDDD   | NULL        | NULL             | quantity
KEY-EEEE-EEEE-EEEE   | NULL        | NULL             | quantity
```

**After Activation:**
```
license_key          | site_domain | used_site_domain | purchase_type
---------------------|-------------|------------------|---------------
KEY-AAAA-AAAA-AAAA   | NULL        | www.site1.com    | quantity
KEY-BBBB-BBBB-BBBB   | NULL        | www.site2.com    | quantity
KEY-CCCC-CCCC-CCCC   | NULL        | NULL             | quantity
KEY-DDDD-DDDD-DDDD   | NULL        | NULL             | quantity
KEY-EEEE-EEEE-EEEE   | NULL        | NULL             | quantity
```

---

## Error Handling

### Common Issues:

1. **No Customer Found:**
   - Error: `"No customer found. Please complete a payment first."`
   - Solution: User must have at least one previous payment

2. **Invalid Price:**
   - Error: `"No valid price found"`
   - Solution: Ensure `DEFAULT_PRICE_ID` is set in `wrangler.jsonc` or user has active subscription

3. **Metadata Not Found:**
   - Issue: Webhook doesn't detect `purchase_type: 'quantity'`
   - Solution: Code checks multiple sources (session.metadata, subscription_data.metadata, subscription.metadata)

4. **Duplicate Licenses:**
   - Prevention: Code checks existing licenses before generating new ones
   - Logic: `neededCount = totalLicensesNeeded - existingCount`

---

## Testing Checklist

- [ ] Purchase quantity of 1 → Generates 1 license
- [ ] Purchase quantity of 5 → Generates 5 licenses
- [ ] Verify licenses appear in dashboard
- [ ] Verify licenses have `purchase_type: 'quantity'`
- [ ] Verify licenses have `site_domain: NULL`
- [ ] Activate license with site → Updates `used_site_domain`
- [ ] Try to activate already-used license → Should fail
- [ ] Verify license keys are unique
- [ ] Verify licenses persist after page refresh
- [ ] Test with existing subscription (uses existing price)
- [ ] Test without existing subscription (uses DEFAULT_PRICE_ID)

---

## Summary

**Quantity Purchase Flow:**
1. User enters quantity → Frontend calls `/purchase-quantity`
2. Backend creates Stripe checkout with quantity and metadata
3. User pays → Stripe creates subscription with quantity
4. Webhook detects `purchase_type: 'quantity'` → Generates N license keys
5. Licenses saved with `site_domain: NULL` and `purchase_type: 'quantity'`
6. Dashboard displays licenses → User can activate them later

**Key Points:**
- Quantity purchases generate unassigned license keys
- Licenses can be activated later via `/activate-license`
- Each quantity = 1 license key
- License keys are unique and cannot be duplicated
- System prevents duplicate license generation

