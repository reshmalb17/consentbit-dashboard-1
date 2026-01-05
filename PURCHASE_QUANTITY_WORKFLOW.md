# Complete Workflow: `/purchase-quantity` Endpoint

## Overview

The `/purchase-quantity` endpoint allows users to purchase multiple license keys. Each license key gets its own individual Stripe subscription for independent management.

---

## 📋 Frontend Request

### Request Format:

```javascript
POST https://consentbit-dashboard-test.web-8fb.workers.dev/purchase-quantity

Headers:
  Content-Type: application/json
  Cookie: sb_session=... (for authentication)

Body:
{
  "email": "user@example.com",        // Optional - can get from session
  "quantity": 5,                       // Number of licenses to purchase
  "billing_period": "monthly"          // "monthly" or "yearly"
}
```

### Frontend Code Example:

```javascript
// From dashboard-script.js (lines 3051-3061)
const response = await fetch(`${API_BASE}/purchase-quantity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
        email: userEmail,
        quantity: parseInt(quantity),
        billing_period: selectedPaymentPlan // 'monthly' or 'yearly'
    })
});
```

---

## 🔄 Complete Workflow

### **STEP 1: Frontend Request** (dashboard-script.js)

**User Action:**
- User selects quantity (e.g., 5 licenses)
- User selects billing period (monthly or yearly)
- User clicks "Purchase Now"

**Frontend Sends:**
```json
{
  "email": "user@example.com",
  "quantity": 5,
  "billing_period": "monthly"
}
```

---

### **STEP 2: Backend Validation** (src/index.js lines 11619-11697)

**Validations:**
1. ✅ Quantity ≥ 1 and ≤ 25 (configurable via `MAX_QUANTITY_PER_PURCHASE`)
2. ✅ Email validation (from request or session cookie)
3. ✅ Customer exists in database
4. ✅ Billing period is "monthly" or "yearly"

**Code Location:** `src/index.js` lines 11622-11697

---

### **STEP 3: Get Price Configuration** (src/index.js lines 11700-11760)

**Reads from Environment Variables:**

```javascript
// Monthly
MONTHLY_PRODUCT_ID = "prod_TiX0VbsXQSm4N5"
MONTHLY_UNIT_AMOUNT = "800"  // $8.00 in cents
MONTHLY_CURRENCY = "usd"

// Yearly
YEARLY_PRODUCT_ID = "prod_TiX0CF9K1RSRyb"
YEARLY_UNIT_AMOUNT = "7200"  // $72.00 in cents
YEARLY_CURRENCY = "usd"
```

**Calculates Total:**
```javascript
total = unit_amount × quantity
// Example: 800 × 5 = 4000 cents = $40.00
```

**Code Location:** `src/index.js` lines 11710-11760

---

### **STEP 4: Generate License Keys** (src/index.js line 11749)

**Generates unique license keys:**
```javascript
licenseKeys = [
  "KEY-XXXX-XXXX-XXXX",
  "KEY-YYYY-YYYY-YYYY",
  "KEY-ZZZZ-ZZZZ-ZZZZ",
  ...
]
```

**Format:** `KEY-XXXX-XXXX-XXXX` (4 segments of 4 characters each)

**Code Location:** `src/index.js` lines 98-104

---

### **STEP 5: Store Metadata in Stripe** (src/index.js lines 11768-11781)

**Stores in Customer Metadata:**
```javascript
customer.metadata = {
  license_keys_pending: ["KEY-1", "KEY-2", ...],  // All license keys
  usecase: "3",
  product_id: "prod_TiX0VbsXQSm4N5",
  quantity: "5",
  billing_period: "monthly"
}
```

**Purpose:** Webhook will retrieve this data after payment succeeds

**Code Location:** `src/index.js` lines 11771-11777

---

### **STEP 6: Create Stripe Checkout Session** (src/index.js lines 11783-11820)

**Creates one-time payment checkout:**

```javascript
{
  mode: "payment",  // One-time payment (not subscription mode)
  customer: "cus_xxxxx",
  line_items: [{
    price_data: {
      currency: "usd",
      unit_amount: 4000,  // Total: $40.00
      product: "prod_TiX0VbsXQSm4N5"  // From env var
    },
    quantity: 1
  }],
  payment_intent_data: {
    metadata: {
      usecase: "3",
      product_id: "prod_TiX0VbsXQSm4N5",
      quantity: "5",
      billing_period: "monthly",
      license_keys: ["KEY-1", "KEY-2", ...]  // If < 450 chars
    }
  }
}
```

**Returns:** `checkout_url` → User redirects to Stripe

**Code Location:** `src/index.js` lines 11792-11820

---

### **STEP 7: User Pays on Stripe**

- User enters payment details
- Stripe processes payment
- Payment succeeds

---

### **STEP 8: Webhook Handler** (src/index.js lines 2105-3400+)

**Event:** `checkout.session.completed`

**Webhook Flow:**

1. **Verify Payment** (line 2137)
   - Checks `session.payment_status === "paid"`

2. **Identify Use Case** (line 2334)
   - Reads `metadata.usecase === "3"` → Quantity purchase

3. **Get License Keys** (lines 2387-2406)
   - From `payment_intent.metadata.license_keys` OR
   - From `customer.metadata.license_keys_pending`

4. **Get Price ID** (line 2453)
   - From `metadata.product_id` → Converts to `price_id` via Stripe API

5. **Save Payment Method** (lines 2484-2526)
   - Attaches payment method to customer
   - Sets as default payment method

6. **Create Subscriptions** (lines 2545-3400+)

   **Two Processing Modes:**

   **A. Immediate Mode** (quantity ≤ 10):
   ```javascript
   // Creates subscriptions immediately in batches of 5
   for (each license key) {
     Create Stripe Subscription:
       - customer: customerId
       - items[0][price]: price_id
       - metadata[license_key]: "KEY-XXXX-..."
       - metadata[usecase]: "3"
       - metadata[purchase_type]: "quantity"
       - trial_end: calculated (prevents immediate invoice)
   }
   ```

   **B. Queue Mode** (quantity > 10):
   ```javascript
   // Adds ALL items to subscription_queue table
   for (each license key) {
     INSERT INTO subscription_queue (
       queue_id, customer_id, user_email, 
       payment_intent_id, price_id, license_key, 
       status: 'pending'
     )
   }
   
   // Processes first 5 immediately (for user feedback)
   // Rest processed by scheduled job every 1 minute
   ```

**Code Location:** `src/index.js` lines 2353-3400+

---

### **STEP 9: Individual Subscription Creation**

**For Each License Key:**

```javascript
// Stripe API Call
POST /subscriptions
{
  customer: "cus_xxxxx",
  items[0][price]: "price_xxxxx",  // From product_id
  items[0][quantity]: 1,
  metadata[license_key]: "KEY-XXXX-XXXX-XXXX",
  metadata[usecase]: "3",
  metadata[purchase_type]: "quantity",
  trial_end: 1234567890  // Prevents immediate invoice
}
```

**Stripe Returns:**
```json
{
  "id": "sub_xxxxx",
  "status": "trialing",
  "items": {
    "data": [{
      "id": "si_xxxxx",
      "price": {
        "id": "price_xxxxx",
        "recurring": {
          "interval": "month"
        }
      }
    }]
  },
  "current_period_end": 1234567890
}
```

**Code Location:** 
- Immediate: `src/index.js` lines 2652-2735, 2760-2771
- Queue: `src/index.js` lines 1442-1452

---

### **STEP 10: Save to Database**

**For Each Subscription Created:**

#### **A. Save License** (licenses table)

```sql
INSERT INTO licenses (
  license_key,           -- "KEY-XXXX-XXXX-XXXX"
  customer_id,           -- "cus_xxxxx"
  subscription_id,       -- "sub_xxxxx"
  item_id,              -- "si_xxxxx"
  site_domain,          -- NULL (not activated yet)
  used_site_domain,     -- NULL (not activated yet)
  status,               -- "active"
  purchase_type,        -- "quantity"
  billing_period,       -- "monthly" or "yearly"
  renewal_date,         -- subscription.current_period_end
  created_at,
  updated_at
)
```

**Code Location:** `src/index.js` lines 1500-1517, 3011-3026, 3328-3343

#### **B. Save Subscription** (subscriptions table)

```sql
INSERT OR REPLACE INTO subscriptions (
  user_email,            -- "user@example.com"
  customer_id,           -- "cus_xxxxx"
  subscription_id,       -- "sub_xxxxx"
  status,               -- "trialing" or "active"
  cancel_at_period_end,  -- 0 (false)
  cancel_at,            -- NULL
  current_period_start, -- subscription.current_period_start
  current_period_end,   -- subscription.current_period_end
  billing_period,       -- "monthly" or "yearly"
  created_at,
  updated_at
)
```

**Code Location:** `src/index.js` lines 1539-1548

#### **C. Save Payment** (payments table)

```sql
INSERT INTO payments (
  customer_id,           -- "cus_xxxxx"
  subscription_id,       -- "sub_xxxxx"
  email,                 -- "user@example.com"
  amount,                -- 800 (unit_amount in cents)
  currency,              -- "usd"
  status,                -- "succeeded"
  site_domain,          -- NULL (quantity purchase)
  magic_link,           -- NULL
  magic_link_generated, -- 0
  created_at,
  updated_at
)
```

**Code Location:** `src/index.js` lines 1612-1629, 3414-3429

#### **D. Update Queue** (subscription_queue table - if used)

```sql
UPDATE subscription_queue 
SET status = 'completed',
    subscription_id = 'sub_xxxxx',
    item_id = 'si_xxxxx',
    processed_at = 1234567890
WHERE queue_id = 'queue_xxxxx'
```

**Code Location:** `src/index.js` lines 1566-1570, 2722-2725

---

## 📊 Database Tables Used

### 1. **subscription_queue** (Temporary - for async processing)

| Column | Description | Example |
|--------|-------------|---------|
| `queue_id` | Unique queue item ID | `queue_pi_xxxxx_KEY-XXXX_1234567890` |
| `customer_id` | Stripe customer ID | `cus_xxxxx` |
| `user_email` | User email | `user@example.com` |
| `payment_intent_id` | Stripe payment intent ID | `pi_xxxxx` |
| `price_id` | Stripe price ID | `price_xxxxx` |
| `license_key` | Generated license key | `KEY-XXXX-XXXX-XXXX` |
| `quantity` | Always 1 (one per queue item) | `1` |
| `trial_end` | Trial end timestamp | `1234567890` |
| `status` | `pending`, `processing`, `completed`, `failed` | `completed` |
| `subscription_id` | Created subscription ID | `sub_xxxxx` |
| `item_id` | Subscription item ID | `si_xxxxx` |
| `created_at` | Queue entry timestamp | `1234567890` |
| `processed_at` | Processing completion timestamp | `1234567890` |

**Used For:** Large quantity purchases (>10) to prevent webhook timeouts

---

### 2. **licenses** (Permanent - stores license keys)

| Column | Description | Example |
|--------|-------------|---------|
| `license_key` | Unique license key | `KEY-XXXX-XXXX-XXXX` |
| `customer_id` | Stripe customer ID | `cus_xxxxx` |
| `subscription_id` | Stripe subscription ID | `sub_xxxxx` |
| `item_id` | Stripe subscription item ID | `si_xxxxx` |
| `site_domain` | NULL (not activated) | `NULL` |
| `used_site_domain` | NULL (not activated) | `NULL` |
| `status` | License status | `active` |
| `purchase_type` | Purchase type | `quantity` |
| `billing_period` | Billing period | `monthly` or `yearly` |
| `renewal_date` | Subscription renewal date | `1234567890` (Unix timestamp) |
| `created_at` | Creation timestamp | `1234567890` |
| `updated_at` | Last update timestamp | `1234567890` |

**Purpose:** Stores all license keys for dashboard display

---

### 3. **subscriptions** (Permanent - stores subscription details)

| Column | Description | Example |
|--------|-------------|---------|
| `user_email` | User email | `user@example.com` |
| `customer_id` | Stripe customer ID | `cus_xxxxx` |
| `subscription_id` | Stripe subscription ID | `sub_xxxxx` |
| `status` | Subscription status | `trialing`, `active`, `canceled` |
| `cancel_at_period_end` | Will cancel at period end | `0` (false) |
| `cancel_at` | Cancellation timestamp | `NULL` |
| `current_period_start` | Current period start | `1234567890` |
| `current_period_end` | Current period end (renewal date) | `1234567890` |
| `billing_period` | Billing period | `monthly` or `yearly` |
| `created_at` | Creation timestamp | `1234567890` |
| `updated_at` | Last update timestamp | `1234567890` |

**Purpose:** Tracks all subscriptions for dashboard display

---

### 4. **payments** (Permanent - payment history)

| Column | Description | Example |
|--------|-------------|---------|
| `customer_id` | Stripe customer ID | `cus_xxxxx` |
| `subscription_id` | Stripe subscription ID | `sub_xxxxx` |
| `email` | User email | `user@example.com` |
| `amount` | Payment amount in cents | `800` ($8.00) |
| `currency` | Currency code | `usd` |
| `status` | Payment status | `succeeded` |
| `site_domain` | NULL (quantity purchase) | `NULL` |
| `magic_link` | NULL | `NULL` |
| `magic_link_generated` | 0 (false) | `0` |
| `created_at` | Payment timestamp | `1234567890` |
| `updated_at` | Last update timestamp | `1234567890` |

**Purpose:** Payment history for dashboard

---

## 🔄 Complete Flow Diagram

```
┌─────────────────┐
│  Frontend       │
│  User clicks    │
│  "Purchase Now" │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ POST /purchase-quantity             │
│ { quantity: 5, billing_period }    │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ 1. Validate request                 │
│ 2. Get price from env vars          │
│ 3. Generate 5 license keys          │
│ 4. Store metadata in Stripe         │
│ 5. Create checkout session           │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ Return checkout_url                 │
│ User redirects to Stripe            │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ User pays on Stripe                 │
│ Payment succeeds                    │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ Webhook: checkout.session.completed │
│ 1. Get license keys from metadata    │
│ 2. Get price_id from product_id      │
│ 3. Save payment method               │
└────────┬────────────────────────────┘
         │
         ├─── Quantity ≤ 10 ───┐
         │                      │
         │                      ▼
         │         ┌────────────────────────────┐
         │         │ Immediate Mode             │
         │         │ Create subscriptions now   │
         │         └────────┬───────────────────┘
         │                  │
         │                  ▼
         │         ┌────────────────────────────┐
         │         │ For each license key:      │
         │         │ 1. Create Stripe sub       │
         │         │ 2. Save to licenses table    │
         │         │ 3. Save to subscriptions   │
         │         │ 4. Save to payments         │
         │         └────────────────────────────┘
         │
         └─── Quantity > 10 ───┐
                               │
                               ▼
                  ┌────────────────────────────┐
                  │ Queue Mode                  │
                  │ Add to subscription_queue   │
                  └────────┬───────────────────┘
                           │
                           ▼
                  ┌────────────────────────────┐
                  │ Process first 5 immediately │
                  │ Rest processed by scheduled │
                  │ job (every minute)          │
                  └────────────────────────────┘
```

---

## 📝 Example: Purchasing 5 Monthly Licenses

### Frontend Request:
```json
{
  "email": "user@example.com",
  "quantity": 5,
  "billing_period": "monthly"
}
```

### Backend Processing:
1. Gets `MONTHLY_PRODUCT_ID` = `prod_TiX0VbsXQSm4N5`
2. Gets `MONTHLY_UNIT_AMOUNT` = `800` ($8.00)
3. Calculates: `800 × 5 = 4000 cents = $40.00`
4. Generates 5 license keys: `["KEY-AAAA-AAAA-AAAA", "KEY-BBBB-BBBB-BBBB", ...]`
5. Creates checkout for $40.00

### After Payment:
1. Webhook receives `checkout.session.completed`
2. Creates 5 individual Stripe subscriptions:
   - `sub_1` → License `KEY-AAAA-AAAA-AAAA`
   - `sub_2` → License `KEY-BBBB-BBBB-BBBB`
   - `sub_3` → License `KEY-CCCC-CCCC-CCCC`
   - `sub_4` → License `KEY-DDDD-DDDD-DDDD`
   - `sub_5` → License `KEY-EEEE-EEEE-EEEE`

### Database Records Created:

**licenses table:** 5 rows (one per license key)
**subscriptions table:** 5 rows (one per subscription)
**payments table:** 5 rows (one per subscription)

---

## 🎯 Key Points

1. **One License = One Subscription**: Each license key gets its own Stripe subscription for independent management

2. **Trial Period**: All subscriptions created with `trial_end` to prevent immediate invoice (payment already collected via checkout)

3. **Queue System**: For quantities > 10, uses `subscription_queue` table to prevent webhook timeouts

4. **Idempotency**: Checks if licenses already exist before creating (prevents duplicates)

5. **Metadata Storage**: License keys stored in Stripe customer metadata temporarily, then moved to database

6. **Environment Variables**: All pricing comes from env vars (no database queries needed)

---

## ⏰ Queue Processing Details (Quantity > 10)

When quantity is **more than 10**, the system uses a queue-based approach:

### **Processing Strategy:**

1. **Immediate Processing (First 5):**
   - First 5 subscriptions are created **immediately** during webhook
   - Provides instant user feedback
   - Code Location: `src/index.js` lines 2644-2735

2. **Queue Processing (Remaining Items):**
   - All items are added to `subscription_queue` table with `status = 'pending'`
   - First 5 are processed immediately, then marked as `completed`
   - Remaining items stay as `pending` until scheduled job processes them

### **Scheduled Job Interval:**

**Runs every 1 minute** (configured in `wrangler.jsonc`):
```json
{
  "triggers": {
    "crons": ["*/1 * * * *"]  // Every 1 minute
  }
}
```

**Code Location:** `src/index.js` lines 1990-2050

**Optimization:** The scheduler automatically skips execution if there are no pending items or failed items to process, minimizing resource usage.

### **Processing Per Run:**

- **Maximum items per run:** 100 items
- **Processing order:** Oldest first (`ORDER BY created_at ASC`)
- **Delay between items:** 100ms (to respect Stripe rate limits)
- **Status tracking:** 
  - `pending` → `processing` → `completed` or `failed`
- **Early exit:** If no pending or failed items exist, the scheduler exits immediately without processing

### **Example Timeline:**

**Purchase of 25 licenses:**

1. **Webhook (0 seconds):**
   - All 25 items added to queue
   - First 5 processed immediately ✅
   - Remaining 20 stay as `pending`

2. **Scheduled Job (1 minute):**
   - Processes next 100 items (but only 20 pending)
   - All 20 processed ✅
   - Total: 25 subscriptions created

**Purchase of 150 licenses:**

1. **Webhook (0 seconds):**
   - All 150 items added to queue
   - First 5 processed immediately ✅
   - Remaining 145 stay as `pending`

2. **Scheduled Job (1 minute):**
   - Processes first 100 items ✅
   - 45 remain `pending`

3. **Scheduled Job (2 minutes):**
   - Processes remaining 45 items ✅
   - Total: 150 subscriptions created

### **Retry Logic:**

- **Max attempts:** 3 retries
- **Exponential backoff:** 2min, 4min, 8min
- **Failed items:** Marked as `failed` after 3 attempts
- **Refunds:** Failed items older than 12 hours are automatically refunded

**Code Location:** `src/index.js` lines 1640-1668

---

## 🔍 Database Schema Summary

| Table | Purpose | Records Created |
|-------|---------|----------------|
| `subscription_queue` | Temporary queue for async processing | 1 per license (if quantity > 10) |
| `licenses` | Stores all license keys | 1 per license |
| `subscriptions` | Stores subscription details | 1 per license |
| `payments` | Payment history | 1 per subscription |

**Total Records for 5 Licenses:**
- `licenses`: 5 rows
- `subscriptions`: 5 rows  
- `payments`: 5 rows
- `subscription_queue`: 0-5 rows (depends on quantity)
