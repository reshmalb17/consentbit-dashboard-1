# Use Case 3: Quantity Purchase Workflow - Complete Guide with Examples

## Overview

Use Case 3 handles purchasing multiple license keys by quantity. License keys are generated **before payment** and stored temporarily in Stripe metadata. After payment succeeds, they are saved to the database with subscription details.

---

## Complete Workflow with Examples

### Example Scenario
- **User Email**: `john@example.com`
- **Customer ID**: `cus_ABC123XYZ`
- **Existing Subscription ID**: `sub_ExistingSub456`
- **Price ID**: `price_LicensePrice789`
- **Quantity**: `3` (user wants to purchase 3 license keys)

---

## Step 1: User Initiates Purchase

### Frontend Request

**Location**: `dashboard-script.js` → `handleQuantityPurchase()`

**User Action**: User enters quantity `3` in the dashboard and clicks "Purchase Now"

**Frontend Code**:
```javascript
async function handleQuantityPurchase(userEmail, quantity) {
  const response = await fetch(`${API_BASE}/purchase-quantity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'john@example.com',
      quantity: 3
    })
  });
  
  const data = await response.json();
  window.location.href = data.checkout_url; // Redirects to Stripe checkout
}
```

**Request**:
```http
POST /purchase-quantity
Content-Type: application/json

{
  "email": "john@example.com",
  "quantity": 3
}
```

---

## Step 2: Backend Validates Request

### Backend Processing

**Location**: `src/index.js` → `POST /purchase-quantity`

**Process**:
1. Validates quantity (must be ≥ 1)
2. Authenticates user (email or session cookie)
3. Loads user data from Memberstack
4. Finds active subscription

**Example User Data**:
```json
{
  "email": "john@example.com",
  "customers": [
    {
      "customerId": "cus_ABC123XYZ",
      "subscriptions": [
        {
          "subscriptionId": "sub_ExistingSub456",
          "status": "active",
          "items": [
            {
              "id": "si_Item123",
              "price": "price_LicensePrice789"
            }
          ]
        }
      ]
    }
  ]
}
```

**Result**:
- ✅ Customer ID: `cus_ABC123XYZ`
- ✅ Subscription ID: `sub_ExistingSub456`
- ✅ Price ID: `price_LicensePrice789`

---

## Step 3: Generate License Keys (Temporary Storage)

### License Key Generation

**Location**: `src/index.js` → Line ~7240

**Process**:
```javascript
const licenseKeys = generateLicenseKeys(quantity); // quantity = 3
```

**Example Generated License Keys**:
```javascript
[
  "KEY-A1B2-C3D4-E5F6",
  "KEY-G7H8-I9J0-K1L2",
  "KEY-M3N4-O5P6-Q7R8"
]
```

**Important**: License keys are **NOT saved to database yet**. They are stored temporarily in Stripe metadata only.

**Console Log**:
```
[USE CASE 3] Generated 3 license key(s) - storing temporarily in Stripe metadata
```

---

## Step 4: Add Subscription Items (Trigger Proration)

### Add Items to Existing Subscription

**Location**: `src/index.js` → Lines ~7276-7325

**Process**: Adds one subscription item per license to trigger Stripe's proration calculation.

**API Calls to Stripe**:

**Item 1**:
```http
POST https://api.stripe.com/v1/subscription_items
{
  "subscription": "sub_ExistingSub456",
  "price": "price_LicensePrice789",
  "quantity": 1,
  "metadata[license_key]": "KEY-A1B2-C3D4-E5F6",
  "metadata[purchase_type]": "quantity",
  "metadata[licencepurchase]": "by user",
  "proration_behavior": "create_prorations"
}
```

**Response**:
```json
{
  "id": "si_NewItem001",
  "subscription": "sub_ExistingSub456",
  "price": {
    "id": "price_LicensePrice789",
    "unit_amount": 1000
  }
}
```

**Item 2**:
```http
POST https://api.stripe.com/v1/subscription_items
{
  "subscription": "sub_ExistingSub456",
  "price": "price_LicensePrice789",
  "quantity": 1,
  "metadata[license_key]": "KEY-G7H8-I9J0-K1L2",
  ...
}
```

**Response**: `si_NewItem002`

**Item 3**:
```http
POST https://api.stripe.com/v1/subscription_items
{
  "subscription": "sub_ExistingSub456",
  "price": "price_LicensePrice789",
  "quantity": 1,
  "metadata[license_key]": "KEY-M3N4-O5P6-Q7R8",
  ...
}
```

**Response**: `si_NewItem003`

**Created Item IDs**:
```javascript
createdItemIds = [
  "si_NewItem001",
  "si_NewItem002",
  "si_NewItem003"
]
```

**Console Logs**:
```
[USE CASE 3] Adding 3 subscription item(s) to subscription sub_ExistingSub456 to trigger proration
[USE CASE 3] ✅ Added subscription item si_NewItem001 for license KEY-A1B2-C3D4-E5F6
[USE CASE 3] ✅ Added subscription item si_NewItem002 for license KEY-G7H8-I9J0-K1L2
[USE CASE 3] ✅ Added subscription item si_NewItem003 for license KEY-M3N4-O5P6-Q7R8
```

### Store License Keys in Subscription Metadata

**Process**: Store license keys in subscription metadata as backup.

**API Call**:
```http
POST https://api.stripe.com/v1/subscriptions/sub_ExistingSub456
{
  "metadata[license_keys]": "[\"KEY-A1B2-C3D4-E5F6\",\"KEY-G7H8-I9J0-K1L2\",\"KEY-M3N4-O5P6-Q7R8\"]",
  "metadata[usecase]": "3",
  "metadata[purchase_type]": "quantity",
  "metadata[quantity]": "3"
}
```

**Console Log**:
```
[USE CASE 3] ✅ Stored license keys in subscription metadata
```

---

## Step 5: Get Prorated Amount

### Calculate Prorated Amount

**Location**: `src/index.js` → Lines ~7322-7363

**Process**: Retrieves the prorated amount from Stripe's upcoming invoice.

**API Call**:
```http
GET https://api.stripe.com/v1/invoices/upcoming?subscription=sub_ExistingSub456
```

**Response**:
```json
{
  "amount_due": 750,  // Prorated amount (e.g., 75% of monthly price)
  "currency": "usd",
  "subscription": "sub_ExistingSub456"
}
```

**Example Calculation**:
- Monthly price per license: `$10.00` (1000 cents)
- Quantity: `3`
- Days remaining in billing period: `23 days`
- Total days in period: `30 days`
- Prorated amount: `(1000 * 3) * (23/30) = 2300 cents = $23.00`

**Console Log**:
```
[USE CASE 3] ✅ Retrieved prorated amount: 2300 (usd)
```

---

## Step 6: Create Checkout Session

### Create Stripe Checkout Session

**Location**: `src/index.js` → Lines ~7365-7389

**Process**: Creates a one-time payment checkout session for the prorated amount.

**API Call to Stripe**:
```http
POST https://api.stripe.com/v1/checkout/sessions
{
  "mode": "payment",
  "customer": "cus_ABC123XYZ",
  "line_items[0][price]": "price_LicensePrice789",
  "line_items[0][quantity]": 3,
  "payment_intent_data[metadata][licencepurchase]": "by user",
  "payment_intent_data[metadata][purchase_type]": "quantity",
  "payment_intent_data[metadata][quantity]": "3",
  "payment_intent_data[metadata][subscription_id]": "sub_ExistingSub456",
  "payment_intent_data[metadata][license_keys]": "[\"KEY-A1B2-C3D4-E5F6\",\"KEY-G7H8-I9J0-K1L2\",\"KEY-M3N4-O5P6-Q7R8\"]",
  "payment_intent_data[metadata][item_ids]": "[\"si_NewItem001\",\"si_NewItem002\",\"si_NewItem003\"]",
  "payment_intent_data[metadata][email]": "john@example.com",
  "payment_intent_data[metadata][usecase]": "3",
  "success_url": "https://dashboard.example.com?session_id={CHECKOUT_SESSION_ID}&payment=success",
  "cancel_url": "https://dashboard.example.com"
}
```

**Response**:
```json
{
  "id": "cs_CheckoutSession123",
  "url": "https://checkout.stripe.com/c/pay/cs_CheckoutSession123",
  "status": "open"
}
```

**Backend Response**:
```json
{
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_CheckoutSession123",
  "session_id": "cs_CheckoutSession123",
  "prorated_amount": 2300,
  "currency": "usd",
  "quantity": 3,
  "license_keys": 3
}
```

**Console Log**:
```
[USE CASE 3] ✅ Checkout session created successfully
```

---

## Step 7: User Completes Payment

### User Flow

1. User is redirected to Stripe Checkout page
2. User enters payment details (card: `4242 4242 4242 4242`)
3. User clicks "Pay $23.00"
4. Payment is processed by Stripe
5. User is redirected back to dashboard: `https://dashboard.example.com?session_id=cs_CheckoutSession123&payment=success`

**Stripe Payment Intent Created**:
```json
{
  "id": "pi_PaymentIntent789",
  "customer": "cus_ABC123XYZ",
  "amount": 2300,
  "currency": "usd",
  "status": "succeeded",
  "metadata": {
    "licencepurchase": "by user",
    "purchase_type": "quantity",
    "quantity": "3",
    "subscription_id": "sub_ExistingSub456",
    "license_keys": "[\"KEY-A1B2-C3D4-E5F6\",\"KEY-G7H8-I9J0-K1L2\",\"KEY-M3N4-O5P6-Q7R8\"]",
    "item_ids": "[\"si_NewItem001\",\"si_NewItem002\",\"si_NewItem003\"]",
    "email": "john@example.com",
    "usecase": "3"
  }
}
```

---

## Step 8: Webhook Processing - Payment Intent Succeeded

### Webhook Event

**Event Type**: `payment_intent.succeeded`

**Location**: `src/index.js` → Lines ~3726-3803

**Webhook Payload**:
```json
{
  "type": "payment_intent.succeeded",
  "data": {
    "object": {
      "id": "pi_PaymentIntent789",
      "customer": "cus_ABC123XYZ",
      "amount": 2300,
      "metadata": {
        "licencepurchase": "by user",
        "purchase_type": "quantity",
        "quantity": "3",
        "subscription_id": "sub_ExistingSub456",
        "license_keys": "[\"KEY-A1B2-C3D4-E5F6\",\"KEY-G7H8-I9J0-K1L2\",\"KEY-M3N4-O5P6-Q7R8\"]",
        "item_ids": "[\"si_NewItem001\",\"si_NewItem002\",\"si_NewItem003\"]",
        "email": "john@example.com",
        "usecase": "3"
      }
    }
  }
}
```

### Process License Keys

**Step 8.1: Extract Metadata**
```javascript
const useCase3 = true; // licencepurchase === 'by user' && usecase === '3'
const purchaseType = 'quantity';
const existingSubscriptionId = 'sub_ExistingSub456';
const customerId = 'cus_ABC123XYZ';
const licenseKeys = [
  "KEY-A1B2-C3D4-E5F6",
  "KEY-G7H8-I9J0-K1L2",
  "KEY-M3N4-O5P6-Q7R8"
];
const itemIds = [
  "si_NewItem001",
  "si_NewItem002",
  "si_NewItem003"
];
```

**Step 8.2: Create License Keys in Database**

**Console Log**:
```
[USE CASE 3] Processing license purchase payment
[USE CASE 3] Creating 3 license key(s) in database after payment
```

**Database Inserts**:

**License 1**:
```sql
INSERT INTO licenses 
(license_key, customer_id, subscription_id, item_id, 
 site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
VALUES (
  'KEY-A1B2-C3D4-E5F6',
  'cus_ABC123XYZ',
  'sub_ExistingSub456',
  'si_NewItem001',
  NULL,
  NULL,
  'active',
  'quantity',
  1704067200,  -- Unix timestamp
  1704067200
);
```

**License 2**:
```sql
INSERT INTO licenses 
(license_key, customer_id, subscription_id, item_id, 
 site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
VALUES (
  'KEY-G7H8-I9J0-K1L2',
  'cus_ABC123XYZ',
  'sub_ExistingSub456',
  'si_NewItem002',
  NULL,
  NULL,
  'active',
  'quantity',
  1704067200,
  1704067200
);
```

**License 3**:
```sql
INSERT INTO licenses 
(license_key, customer_id, subscription_id, item_id, 
 site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
VALUES (
  'KEY-M3N4-O5P6-Q7R8',
  'cus_ABC123XYZ',
  'sub_ExistingSub456',
  'si_NewItem003',
  NULL,
  NULL,
  'active',
  'quantity',
  1704067200,
  1704067200
);
```

**Console Logs**:
```
[USE CASE 3] ✅ Created license KEY-A1B2-C3D4-E5F6 (subscription: sub_ExistingSub456, item: si_NewItem001)
[USE CASE 3] ✅ Created license KEY-G7H8-I9J0-K1L2 (subscription: sub_ExistingSub456, item: si_NewItem002)
[USE CASE 3] ✅ Created license KEY-M3N4-O5P6-Q7R8 (subscription: sub_ExistingSub456, item: si_NewItem003)
```

**Step 8.3: Save Payment Record**

**Database Insert**:
```sql
INSERT INTO payments (
  customer_id, subscription_id, email, amount, currency, 
  status, site_domain, magic_link, magic_link_generated, 
  created_at, updated_at
) VALUES (
  'cus_ABC123XYZ',
  'sub_ExistingSub456',
  'john@example.com',
  2300,
  'usd',
  'succeeded',
  NULL,
  NULL,
  0,
  1704067200,
  1704067200
);
```

**Console Log**:
```
[USE CASE 3] ✅ Payment record saved for quantity purchase
[USE CASE 3] ✅ License purchase payment processed successfully
```

---

## Step 9: Webhook Processing - Subscription Updated (Alternative Handler)

### Webhook Event

**Event Type**: `customer.subscription.updated`

**Location**: `src/index.js` → Lines ~2694-2763

**Note**: This is an alternative handler that can also process Use Case 3 payments. It retrieves license keys from subscription item metadata.

**Process**:
1. Detects `usecase === '3'` in subscription metadata
2. Retrieves license keys from subscription item metadata
3. Creates license keys in database

**Example Subscription Data**:
```json
{
  "id": "sub_ExistingSub456",
  "customer": "cus_ABC123XYZ",
  "status": "active",
  "metadata": {
    "usecase": "3",
    "purchase_type": "quantity",
    "quantity": "3",
    "license_keys": "[\"KEY-A1B2-C3D4-E5F6\",\"KEY-G7H8-I9J0-K1L2\",\"KEY-M3N4-O5P6-Q7R8\"]"
  },
  "items": {
    "data": [
      {
        "id": "si_NewItem001",
        "metadata": {
          "license_key": "KEY-A1B2-C3D4-E5F6",
          "purchase_type": "quantity"
        }
      },
      {
        "id": "si_NewItem002",
        "metadata": {
          "license_key": "KEY-G7H8-I9J0-K1L2",
          "purchase_type": "quantity"
        }
      },
      {
        "id": "si_NewItem003",
        "metadata": {
          "license_key": "KEY-M3N4-O5P6-Q7R8",
          "purchase_type": "quantity"
        }
      }
    ]
  }
}
```

**Console Log**:
```
[USE CASE 3] Processing payment - creating license keys from metadata
[USE CASE 3] Found 3 license key(s) in metadata to create
[USE CASE 3] ✅ Created license KEY-A1B2-C3D4-E5F6 (subscription: sub_ExistingSub456, item: si_NewItem001)
[USE CASE 3] ✅ Created license KEY-G7H8-I9J0-K1L2 (subscription: sub_ExistingSub456, item: si_NewItem002)
[USE CASE 3] ✅ Created license KEY-M3N4-O5P6-Q7R8 (subscription: sub_ExistingSub456, item: si_NewItem003)
```

---

## Step 10: Final Database State

### Licenses Table

| license_key | customer_id | subscription_id | item_id | site_domain | used_site_domain | status | purchase_type |
|------------|-------------|-----------------|---------|-------------|------------------|--------|---------------|
| KEY-A1B2-C3D4-E5F6 | cus_ABC123XYZ | sub_ExistingSub456 | si_NewItem001 | NULL | NULL | active | quantity |
| KEY-G7H8-I9J0-K1L2 | cus_ABC123XYZ | sub_ExistingSub456 | si_NewItem002 | NULL | NULL | active | quantity |
| KEY-M3N4-O5P6-Q7R8 | cus_ABC123XYZ | sub_ExistingSub456 | si_NewItem003 | NULL | NULL | active | quantity |

### Payments Table

| customer_id | subscription_id | email | amount | currency | status | site_domain |
|------------|----------------|-------|--------|----------|--------|-------------|
| cus_ABC123XYZ | sub_ExistingSub456 | john@example.com | 2300 | usd | succeeded | NULL |

### Stripe Subscription

**Subscription**: `sub_ExistingSub456`
- **Status**: `active`
- **Items**: 4 total (1 original + 3 new)
- **Metadata**: Contains license keys and use case info

---

## Step 11: License Activation (Optional - Later)

### User Activates License on Site

**User Action**: User wants to use license `KEY-A1B2-C3D4-E5F6` on site `www.mysite.com`

**Frontend Request**:
```http
POST /activate-license
Content-Type: application/json

{
  "email": "john@example.com",
  "license_key": "KEY-A1B2-C3D4-E5F6",
  "site_domain": "www.mysite.com"
}
```

**Backend Process**:
1. Validates license belongs to user
2. Checks license is not already used
3. Updates license with site domain

**Database Update**:
```sql
UPDATE licenses 
SET used_site_domain = 'www.mysite.com', updated_at = 1704067300
WHERE license_key = 'KEY-A1B2-C3D4-E5F6' 
  AND customer_id = 'cus_ABC123XYZ'
  AND status = 'active'
  AND used_site_domain IS NULL;
```

**Updated License**:
| license_key | used_site_domain | status |
|------------|------------------|--------|
| KEY-A1B2-C3D4-E5F6 | www.mysite.com | active |

---

## Key Differences from Use Case 2

| Feature | Use Case 2 (Site Purchase) | Use Case 3 (Quantity Purchase) |
|---------|---------------------------|-------------------------------|
| **License Creation** | After payment | Before payment (temporary) |
| **Storage Before Payment** | N/A | Stripe metadata only |
| **Storage After Payment** | Database (active) | Database (active) |
| **Site Assignment** | Immediate | Optional (via activation) |
| **Metadata Identifier** | `add_to_existing: 'true'` | `licencepurchase: 'by user'` + `usecase: '3'` |
| **Database Status** | Created as `active` | Created as `active` after payment |

---

## Error Handling & Rollback

### If Checkout Creation Fails

**Scenario**: Checkout session creation fails after subscription items are added

**Process**:
1. Delete all created subscription items
2. No database cleanup needed (no records created yet)
3. Return error to user

**Console Logs**:
```
[USE CASE 3] ❌ Checkout session creation failed, rolling back subscription items
[USE CASE 3] ✅ Rolled back subscription item si_NewItem001
[USE CASE 3] ✅ Rolled back subscription item si_NewItem002
[USE CASE 3] ✅ Rolled back subscription item si_NewItem003
```

### If Payment Fails

**Scenario**: User cancels payment or payment fails

**Process**:
1. Subscription items remain (will be prorated on next invoice)
2. No license keys created in database (they were only in metadata)
3. User can retry purchase

**Note**: Subscription items should be manually cleaned up if payment is permanently cancelled.

---

## Summary

### Flow Diagram

```
User Request (quantity: 3)
    ↓
Generate License Keys (temporary)
    ↓
Add Subscription Items (trigger proration)
    ↓
Store License Keys in Stripe Metadata
    ↓
Get Prorated Amount ($23.00)
    ↓
Create Checkout Session
    ↓
User Pays
    ↓
Webhook: payment_intent.succeeded
    ↓
Create License Keys in Database (active)
    ↓
Save Payment Record
    ↓
✅ Complete - 3 License Keys Active
```

### Key Points

1. ✅ **License keys generated before payment** (stored temporarily in Stripe metadata)
2. ✅ **No database records before payment** (prevents orphaned records)
3. ✅ **License keys created after payment succeeds** (with subscription details)
4. ✅ **Multiple metadata sources** (payment intent, subscription, item metadata)
5. ✅ **Clean rollback** (subscription items deleted if checkout fails)
6. ✅ **Prorated payment** (user pays only for remaining billing period)

---

## Testing Checklist

- [ ] Purchase quantity of 1
- [ ] Purchase quantity of 5
- [ ] Verify license keys are generated correctly
- [ ] Verify license keys stored in Stripe metadata
- [ ] Verify payment processes correctly
- [ ] Verify license keys created in database after payment
- [ ] Verify subscription items added correctly
- [ ] Verify prorated amount calculated correctly
- [ ] Test payment cancellation (verify no license keys created)
- [ ] Test checkout failure (verify rollback works)
- [ ] Activate license key on site
- [ ] Verify license keys display in dashboard

---

## API Endpoints Used

1. **POST /purchase-quantity** - Initiate quantity purchase
2. **POST /activate-license** - Activate license on site (optional)

## Webhook Events

1. **payment_intent.succeeded** - Primary handler for Use Case 3
2. **customer.subscription.updated** - Alternative handler (fallback)

---

*Last Updated: Based on current implementation where license keys are stored temporarily in Stripe metadata before payment, then created in database after payment succeeds.*

