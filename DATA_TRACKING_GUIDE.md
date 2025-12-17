# Data Tracking and Storage Guide

This document explains how subscription and site data are tracked and saved across KV storage and D1 database.

## Storage Architecture

The system uses **two storage systems**:

1. **Cloudflare KV (USERS_KV)** - Fast, key-value storage for user records and site mappings
2. **D1 Database** - SQLite database for payment history and license keys

---

## 1. KV Storage (USERS_KV)

### Key Structure
```
user:{customerId}  →  JSON user record
payment:{customerId}:{subscriptionId}  →  JSON payment record (optional)
```

### User Record Structure

**Key:** `user:cus_TZePUHOJ5KEG1Z`

**Value (JSON):**
```json
{
  "customerId": "cus_TZePUHOJ5KEG1Z",
  "subscriptionId": "sub_1ScV7GSAczuHLTOtiAe0sI3k",
  "email": "reshma@seattlenewmedia.com",
  "defaultPrice": "price_1Sc89ISAczuHLTOtGHNji8Ay",
  "sites": {
    "tre.com": {
      "item_id": "si_TZeRxqsUkgGpxD",
      "price": "price_1ScUzMSAczuHLTOtCoNaMn6k",
      "quantity": 1,
      "status": "active",
      "created_at": 1765906776
    },
    "ewr.in": {
      "item_id": "si_TZeRJu79EurSFw",
      "price": "price_1ScUzNSAczuHLTOtG6YlFRnu",
      "quantity": 1,
      "status": "active",
      "created_at": 1765906777
    },
    "site_1": {
      "item_id": "si_TZf7gDlY89lNap",
      "price": "price_1Sc89ISAczuHLTOtGHNji8Ay",
      "quantity": 1,
      "status": "inactive",
      "created_at": 1765906000,
      "removed_at": 1765906247
    }
  },
  "pendingSites": [
    {
      "site": "new-site.com",
      "price": "price_1Sc89ISAczuHLTOtGHNji8Ay",
      "quantity": 1
    }
  ]
}
```

### When Data is Saved to KV

#### 1. **After Payment (checkout.session.completed webhook)**
```javascript
// Location: src/index.js line ~414, ~460
await env.USERS_KV.put(userKey, JSON.stringify(user));
```

**What gets saved:**
- Customer ID
- Subscription ID
- Email
- Sites mapping (site → subscription item ID)
- Default price (from first subscription item)

#### 2. **When Adding Site to Pending**
```javascript
// Location: src/index.js line ~940
await env.USERS_KV.put(userKey, JSON.stringify(user));
```

**What gets saved:**
- Site added to `pendingSites` array
- Price ID for the site

#### 3. **When Removing Site**
```javascript
// Location: src/index.js line ~1301
await env.USERS_KV.put(userKey, JSON.stringify(user));
```

**What gets saved:**
- Site status changed to `inactive`
- `removed_at` timestamp added
- `item_id` kept for reference

#### 4. **When Subscription Updates (webhook)**
```javascript
// Location: src/index.js line ~609
await env.USERS_KV.put(userKey, JSON.stringify(user));
```

**What gets saved:**
- Site statuses synced (active/inactive)
- Quantities updated if changed

---

## 2. D1 Database (SQLite)

### Tables

#### **payments** Table

**Schema:**
```sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'succeeded',
  site_domain TEXT,
  magic_link TEXT,
  magic_link_generated INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**When Data is Saved:**
```javascript
// Location: src/index.js line ~510-520
await env.DB.prepare(
  `INSERT INTO payments (
    customer_id, subscription_id, email, amount, currency, 
    status, site_domain, magic_link, magic_link_generated, 
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
  customerId,
  subscriptionId,
  email,
  amount,
  currency,
  'succeeded',
  siteDomain,
  magicLink,
  1,
  timestamp,
  timestamp
).run();
```

**What Gets Saved:**
- Customer ID
- Subscription ID
- Email
- Payment amount (in cents)
- Currency
- Payment status
- Site domain (first site from checkout)
- Magic login link
- Timestamps

**Example Record:**
```
id: 1
customer_id: cus_TZePUHOJ5KEG1Z
subscription_id: sub_1ScV7GSAczuHLTOtiAe0sI3k
email: reshma@seattlenewmedia.com
amount: 2000 (represents $20.00)
currency: usd
status: succeeded
site_domain: tre.com
magic_link: https://consentbit-dashboard.web-8fb.workers.dev/auth/callback?token=...
magic_link_generated: 1
created_at: 1765906776
updated_at: 1765906776
```

#### **licenses** Table

**Schema:**
```sql
CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  license_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**When Data is Saved:**
```javascript
// Location: src/index.js line ~685-688
await env.DB.prepare(
  'INSERT INTO licenses (customer_id, subscription_id, license_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
).bind(customerId, subscriptionId, key, 'active', timestamp, timestamp);
```

**What Gets Saved:**
- Customer ID
- Subscription ID
- License key (generated per subscription item)
- Status (active/inactive)
- Timestamps

**Example Records:**
```
id: 1
customer_id: cus_TZePUHOJ5KEG1Z
subscription_id: sub_1ScV7GSAczuHLTOtiAe0sI3k
license_key: KEY-ABCD-1234-EFGH
status: active
created_at: 1765906776
updated_at: 1765906776

id: 2
customer_id: cus_TZePUHOJ5KEG1Z
subscription_id: sub_1ScV7GSAczuHLTOtiAe0sI3k
license_key: KEY-WXYZ-5678-IJKL
status: active
created_at: 1765906776
updated_at: 1765906776
```

---

## 3. Data Flow

### Initial Payment Flow

```
1. User clicks "Pay Now"
   ↓
2. POST /create-checkout-from-pending
   - Creates Stripe Checkout Session
   - Stores pending sites in KV (temporarily)
   ↓
3. User completes payment on Stripe
   ↓
4. Stripe sends webhook: checkout.session.completed
   ↓
5. Webhook handler:
   a. Maps subscription items to sites
   b. Saves to KV: user:{customerId}
      - customerId
      - subscriptionId
      - email
      - sites: { site → { item_id, price, status } }
      - defaultPrice
   c. Saves to D1: payments table
      - Payment details
      - Magic link
   d. Clears pendingSites from KV
   ↓
6. Stripe sends webhook: invoice.payment_succeeded
   ↓
7. Webhook handler:
   a. Generates license keys (one per subscription item)
   b. Saves to D1: licenses table
   c. Updates KV: user.licenses array
```

### Adding Site Flow

```
1. User adds site via dashboard
   ↓
2. POST /add-site
   - Adds site to pendingSites array
   - Saves to KV: user:{customerId}
   ↓
3. User clicks "Pay Now"
   ↓
4. POST /create-checkout-from-pending
   - Creates checkout session
   - Creates unique price IDs if needed
   ↓
5. User completes payment
   ↓
6. Webhook: checkout.session.completed
   - Adds subscription items to existing subscription
   - Updates KV: sites mapping
   - Clears pendingSites
   ↓
7. Webhook: invoice.payment_succeeded
   - Generates new license keys
   - Saves to D1: licenses table
```

### Removing Site Flow

```
1. User clicks "Cancel Subscription" on site
   ↓
2. POST /remove-site
   - Deletes subscription item from Stripe
   - Updates KV: site status = "inactive"
   - Adds removed_at timestamp
   ↓
3. Stripe sends webhook: customer.subscription.updated
   ↓
4. Webhook handler:
   - Syncs site statuses
   - Updates KV: confirms inactive status
```

---

## 4. Data Relationships

### KV → D1 Mapping

```
KV: user:{customerId}
  └─ customerId → D1: payments.customer_id
  └─ subscriptionId → D1: payments.subscription_id, licenses.subscription_id
  └─ sites.{site}.item_id → Stripe: subscription_items.id
  └─ sites.{site}.price → Stripe: prices.id
```

### Stripe → KV → D1 Flow

```
Stripe Subscription (sub_xxx)
  └─ Subscription Items (si_xxx)
      └─ Each item has metadata.site = "site.com"
      ↓
KV: user:{customerId}.sites["site.com"]
  └─ item_id: "si_xxx"
  └─ price: "price_xxx"
  └─ status: "active" | "inactive"
  ↓
D1: licenses table
  └─ One license per subscription item
  └─ Linked via subscription_id
```

---

## 5. Querying Data

### Get User's Sites (from KV)
```javascript
// Location: src/index.js line ~873
const userKey = `user:${customerId}`;
const userRaw = await env.USERS_KV.get(userKey);
const user = JSON.parse(userRaw);
const sites = user.sites; // { "site.com": { item_id, price, status } }
```

### Get Payment History (from D1)
```javascript
// Location: src/index.js line ~966
const result = await env.DB.prepare(
  'SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC'
).bind(customerId).all();
```

### Get Licenses (from D1)
```javascript
// Location: src/index.js line ~1027
const result = await env.DB.prepare(
  'SELECT license_key, status, created_at FROM licenses WHERE customer_id = ? ORDER BY created_at DESC'
).bind(customerId).all();
```

---

## 6. Data Consistency

### How Status is Tracked

1. **Active Site:**
   - KV: `sites.{site}.status = "active"`
   - Stripe: Subscription item exists
   - D1: License exists with `status = "active"`

2. **Inactive Site:**
   - KV: `sites.{site}.status = "inactive"` + `removed_at` timestamp
   - Stripe: Subscription item deleted
   - D1: License may still exist (historical record)

3. **Pending Site:**
   - KV: `pendingSites` array contains site
   - Stripe: No subscription item yet
   - D1: No payment record yet

---

## 7. Key Points

✅ **KV is the source of truth** for:
- Current site mappings
- Subscription relationships
- Pending sites

✅ **D1 is the source of truth** for:
- Payment history
- License keys
- Historical records

✅ **Stripe is the source of truth** for:
- Actual subscription items
- Billing amounts
- Payment processing

✅ **Data sync happens via webhooks:**
- `checkout.session.completed` → Creates initial mapping
- `customer.subscription.updated` → Syncs status changes
- `invoice.payment_succeeded` → Generates licenses

---

## 8. Example: Complete Data State

**After user has 3 sites, removes 1, adds 1:**

**KV (`user:cus_123`):**
```json
{
  "customerId": "cus_123",
  "subscriptionId": "sub_123",
  "email": "user@example.com",
  "defaultPrice": "price_10",
  "sites": {
    "site1.com": { "item_id": "si_1", "status": "active" },
    "site2.com": { "item_id": "si_2", "status": "inactive", "removed_at": 1765906247 },
    "site3.com": { "item_id": "si_3", "status": "active" },
    "site4.com": { "item_id": "si_4", "status": "active" }
  },
  "pendingSites": []
}
```

**D1 payments table:**
```
id | customer_id | subscription_id | email | amount | site_domain
1  | cus_123     | sub_123         | user@ | 3000   | site1.com
2  | cus_123     | sub_123         | user@ | 2000   | site4.com
```

**D1 licenses table:**
```
id | customer_id | subscription_id | license_key    | status
1  | cus_123     | sub_123         | KEY-ABCD-1234 | active
2  | cus_123     | sub_123         | KEY-WXYZ-5678 | active
3  | cus_123     | sub_123         | KEY-MNOP-9012 | active
```

**Stripe:**
- Subscription: `sub_123`
- Items: `si_1` (site1.com), `si_3` (site3.com), `si_4` (site4.com)
- Item `si_2` deleted (site2.com)

---

This architecture ensures:
- ✅ Fast lookups (KV for current state)
- ✅ Historical records (D1 for payments/licenses)
- ✅ Billing accuracy (Stripe as source of truth)
- ✅ Data consistency (webhooks sync everything)

