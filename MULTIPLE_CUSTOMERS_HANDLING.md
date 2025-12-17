# Handling Multiple Customer IDs with Same Email

## Problem
Stripe can create multiple customer records for the same email address (e.g., when using payment links directly vs. dashboard). We need to:
1. Store each customer separately in the database
2. Merge all their data in the dashboard view
3. Use email as the primary identifier for finding related customers

## Solution Architecture

### Database Storage (KV)

**Key Structure:**
```
user:{customerId1} → { customerId, email, subscriptions, sites, ... }
user:{customerId2} → { customerId, email, subscriptions, sites, ... }
```

**Important:** Each customer ID has its own record. We don't merge or delete records.

### Database Storage (D1)

**Payments Table:**
```
customer_id | subscription_id | email | ...
cus_123     | sub_1           | user@example.com
cus_456     | sub_2           | user@example.com  ← Same email, different customer
```

**Licenses Table:**
```
customer_id | subscription_id | license_key | site_domain
cus_123     | sub_1           | KEY-XXX    | site1.com
cus_456     | sub_2           | KEY-YYY    | site2.com
```

### How It Works

#### 1. **Webhook Handler (checkout.session.completed)**

When a payment is completed:
1. Gets email from Stripe customer object (source of truth)
2. Finds ALL existing customer IDs with this email from D1 payments table
3. If existing user found:
   - Creates NEW user record for the new customerId
   - Links them via `linkedCustomerIds` array
   - Both records exist separately
4. If no existing user:
   - Creates new user record normally

**Key Point:** We don't delete or overwrite existing customer records. Each customer ID maintains its own record.

#### 2. **Dashboard Endpoint (/dashboard)**

When loading the dashboard:
1. Gets current customerId from session token
2. Finds ALL customer IDs with the same email from D1
3. Loads user records for ALL customer IDs
4. Merges them into one view:
   - Merges all subscriptions
   - Merges all sites
   - Merges all pending sites
5. Returns unified view with `allCustomerIds` array

**Response Structure:**
```json
{
  "subscriptions": {
    "sub_1": { "sites": {...}, "status": "active" },
    "sub_2": { "sites": {...}, "status": "active" }
  },
  "sites": { /* all sites from all subscriptions */ },
  "customerId": "cus_123",  // Primary customer ID
  "allCustomerIds": ["cus_123", "cus_456"],  // All customer IDs
  "email": "user@example.com"
}
```

#### 3. **Licenses Endpoint (/licenses)**

When fetching licenses:
1. Finds ALL customer IDs with the same email
2. Queries D1 for licenses from ALL customer IDs: `WHERE customer_id IN (cus_123, cus_456)`
3. Returns all licenses with `customer_id` field to track which customer they belong to

### Data Flow Example

**Scenario:** User pays via dashboard (creates `cus_123`), then uses payment link (creates `cus_456`)

**Step 1: First Payment (Dashboard)**
- Creates: `user:cus_123` with subscription `sub_1`
- D1: `payments` table has `customer_id: cus_123, email: user@example.com`

**Step 2: Second Payment (Payment Link)**
- Stripe creates: `cus_456` (new customer, same email)
- Webhook finds existing email in D1
- Creates: `user:cus_456` with subscription `sub_2`
- Both records exist separately

**Step 3: Dashboard Load**
- User logs in with `cus_456` session
- System finds both `cus_123` and `cus_456` from D1
- Loads both user records
- Merges subscriptions: `{ sub_1: {...}, sub_2: {...} }`
- Returns unified view showing all subscriptions and sites

### Benefits

✅ **No Data Loss:** Each customer record is preserved
✅ **Unified View:** Dashboard shows all subscriptions and sites together
✅ **Email-Based:** Email is the primary identifier for finding related customers
✅ **Backward Compatible:** Works with existing single-customer records
✅ **Scalable:** Can handle any number of customer IDs per email

### Frontend Display

The dashboard displays:
- **Tab View:** One tab per subscription
- **Each Tab Shows:**
  - Subscription ID
  - Status
  - All sites (subscription items) in that subscription
  - Created date

All subscriptions from all customer IDs are shown in one unified dashboard.


