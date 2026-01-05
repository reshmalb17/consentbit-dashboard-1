# Use Case 2: Site-Based Purchase with Separate Subscriptions

## Overview

Use Case 2 allows users to purchase sites through the dashboard. Each site gets its own separate subscription (similar to Use Case 3 where each license gets its own subscription). This enables individual management of each site's subscription.

**Key Difference from Old Use Case 2:**
- **Old:** Sites were added as items to an existing subscription
- **New:** Each site gets its own separate subscription (like Use Case 3 for licenses)

---

## Complete Workflow

### Phase 1: User Adds Sites to Pending List

**Location:** `dashboard-script.js` → `displaySubscriptions()` function

1. **User enters site name** in the input field for a subscription
2. **User clicks "Add to List"** button
3. **Frontend adds site to pending list:**
   ```javascript
   pendingSitesBySubscription[subscriptionId].push(site);
   ```
4. **Site is displayed** in the pending sites section for that subscription
5. **User can add multiple sites** to the pending list

**Note:** Sites are organized by subscription in the UI, but when payment is processed, each site gets its own new subscription.

---

### Phase 2: User Clicks "Pay Now"

**Location:** `dashboard-script.js` → Pay Now button event listener

1. **User clicks "Pay Now"** button for a subscription's pending sites
2. **Frontend collects pending sites** for that subscription:
   ```javascript
   const pendingSites = pendingSitesBySubscription[subscriptionId] || [];
   ```
3. **Frontend saves pending sites to backend:**
   ```javascript
   POST /add-sites-batch
   {
     sites: pendingSites,
     email: userEmail
   }
   ```
4. **Frontend creates checkout session:**
   ```javascript
   POST /create-checkout-from-pending
   {
     email: userEmail
   }
   ```
5. **User is redirected** to Stripe Checkout

---

### Phase 3: Backend Creates Checkout Session

**Location:** `src/index.js` → `/create-checkout-from-pending` endpoint

1. **Backend authenticates user** (email or session cookie)
2. **Backend retrieves user** and pending sites from database
3. **Backend deduplicates pending sites** (case-insensitive)
4. **Backend validates** at least one pending site exists
5. **Backend gets price ID** from first pending site (all sites use same price)
6. **Backend calculates total amount:**
   ```javascript
   totalAmount = unitAmount × number_of_sites
   ```
7. **Backend creates checkout session** with:
   - **Mode:** `payment` (one-time payment, like Use Case 3)
   - **Line item:** Single item with total amount
   - **Metadata in payment_intent_data:**
     - `usecase: '2'` (Use Case 2 identifier)
     - `purchase_type: 'site'` (distinguishes from Use Case 3)
     - `customer_id: <customer_id>`
     - `price_id: <price_id>`
     - `quantity: <number_of_sites>`
     - `sites: <JSON_array_of_site_names>`

**Example Checkout Session:**
```javascript
{
  mode: 'payment',
  customer: 'cus_xxxxx',
  line_items: [{
    price_data: {
      currency: 'usd',
      unit_amount: 20000, // $200 × 3 sites = $600
      product_data: {
        name: 'Subscription for 3 site(s)'
      }
    },
    quantity: 1
  }],
  payment_intent_data: {
    metadata: {
      usecase: '2',
      purchase_type: 'site',
      customer_id: 'cus_xxxxx',
      price_id: 'price_xxxxx',
      quantity: '3',
      sites: '["example.com", "test.com", "demo.com"]'
    }
  }
}
```

---

### Phase 4: User Completes Payment

1. **User enters payment details** in Stripe Checkout
2. **User completes payment**
3. **Stripe processes payment** and creates `payment_intent`
4. **Stripe sends webhook:** `payment_intent.succeeded`

---

### Phase 5: Webhook Processes Use Case 2

**Location:** `src/index.js` → `payment_intent.succeeded` event handler

#### Step 5.1: Identify Use Case 2

```javascript
const useCase2 = metadata.usecase === '2';
const useCase2CustomerId = metadata.customer_id || customerId;
```

#### Step 5.2: Extract Metadata

```javascript
// Parse site names from metadata
const siteNames = JSON.parse(metadata.sites); // ["example.com", "test.com", "demo.com"]
const priceId = metadata.price_id;
const quantity = parseInt(metadata.quantity); // 3
```

#### Step 5.3: Generate License Keys

```javascript
// Generate one license key per site
const licenseKeys = generateLicenseKeys(siteNames.length);
// Result: ["KEY-1234-5678-9012", "KEY-2345-6789-0123", "KEY-3456-7890-1234"]
```

#### Step 5.4: Save Payment Method

1. **Attach payment method** to customer
2. **Set as default payment method** for customer
3. **This enables automatic charging** for future subscription renewals

#### Step 5.5: Calculate Trial Period

- **Priority:** Custom trial days (env/metadata) > Billing interval > Default (30 days)
- **Purpose:** Skip first invoice (payment already collected via checkout)
- **Result:** `trial_end` timestamp

#### Step 5.6: Create Separate Subscriptions

**Loop through each site:**

```javascript
for (let i = 0; i < siteNames.length; i++) {
  const siteName = siteNames[i];
  const licenseKey = licenseKeys[i];
  
  // Create subscription for this site
  const subscription = await stripe.subscriptions.create({
    customer: useCase2CustomerId,
    items: [{
      price: priceId,
      quantity: 1
    }],
    metadata: {
      site: siteName,
      license_key: licenseKey,
      usecase: '2',
      purchase_type: 'site'
    },
    trial_end: trialEnd,
    collection_method: 'charge_automatically'
  });
  
  // Store license key in subscription item metadata
  await stripe.subscriptionItems.update(itemId, {
    metadata: {
      license_key: licenseKey,
      site: siteName
    }
  });
}
```

**Result:** 3 sites → 3 separate subscriptions

#### Step 5.7: Save License Keys to Database

```javascript
for (const siteSub of successfulSiteSubscriptions) {
  await db.prepare(`
    INSERT INTO licenses (
      license_key, customer_id, subscription_id, item_id,
      used_site_domain, status, purchase_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    siteSub.licenseKey,      // "KEY-1234-5678-9012"
    useCase2CustomerId,      // "cus_xxxxx"
    siteSub.subscriptionId,   // "sub_xxxxx"
    siteSub.itemId,          // "si_xxxxx"
    siteSub.site,            // "example.com"
    'active',                // status
    'site',                  // purchase_type
    timestamp,
    timestamp
  ).run();
}
```

#### Step 5.8: Create Payment Records

```javascript
// Split payment amount across subscriptions
const amountPerSubscription = Math.round(totalAmount / createdSubscriptionIds.length);

for (let i = 0; i < createdSubscriptionIds.length; i++) {
  await db.prepare(`
    INSERT INTO payments (
      customer_id, subscription_id, email, amount, currency,
      status, site_domain, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    useCase2CustomerId,
    createdSubscriptionIds[i],  // One payment per subscription
    userEmail,
    amountPerSubscription,      // Split amount
    currency,
    'succeeded',
    siteNames[i],               // Site name
    timestamp,
    timestamp
  ).run();
}
```

#### Step 5.9: Remove Pending Sites

```javascript
// Remove processed sites from user's pending list
user.pendingSites = user.pendingSites.filter(ps => {
  const psSite = (ps.site || ps.site_domain || '').toLowerCase().trim();
  return !siteNames.some(s => s.toLowerCase().trim() === psSite);
});
await saveUserByEmail(env, userEmail, user);
```

---

### Phase 6: User Redirected to Dashboard

1. **Stripe redirects** to success URL
2. **User sees** dashboard with new subscriptions
3. **Each site** has its own subscription
4. **License keys** are available for each site

---

## Key Features

### ✅ Separate Subscriptions

Each site gets its own subscription:
- **Individual cancellation:** Cancel one site without affecting others
- **Individual billing cycles:** Each site has its own renewal date
- **Individual management:** Manage each site independently

### ✅ License Key Generation

- **One license key per site**
- **Stored in database** with site association
- **Linked to subscription** via metadata

### ✅ Metadata Distinction

Use Case 2 is distinguished by:
- `metadata.usecase = '2'`
- `metadata.purchase_type = 'site'`
- `metadata.site = <site_name>` (on subscription and item)

### ✅ Protection Mechanisms

1. **Skip in checkout.session.completed:**
   ```javascript
   if (sessionMode === 'payment' && sessionUseCase === '2') {
     return new Response('ok'); // Skip - handled by payment_intent.succeeded
   }
   ```

2. **Metadata validation:**
   ```javascript
   if (useCase2 && useCase2CustomerId) {
     // Only process if usecase === '2' AND customer_id exists
   }
   ```

3. **Idempotency:**
   - Check if license key already exists before creating
   - Skip duplicate license keys

---

## Comparison with Other Use Cases

| Aspect | Use Case 1 | Use Case 2 | Use Case 3 |
|--------|------------|------------|------------|
| **Webhook Event** | `checkout.session.completed` | `payment_intent.succeeded` | `payment_intent.succeeded` |
| **Checkout Mode** | `subscription` | `payment` | `payment` |
| **Subscription** | 1 new subscription | N subscriptions (one per site) | N subscriptions (one per license) |
| **Metadata** | `subscription.metadata` | `payment_intent.metadata` | `payment_intent.metadata` |
| **Purchase Type** | Direct payment link | Site-based | Quantity-based |
| **License Keys** | Generated per site | Generated per site | Pre-generated per license |
| **Individual Management** | No (shared subscription) | Yes (separate subscriptions) | Yes (separate subscriptions) |

---

## Database Schema

### Licenses Table

```sql
CREATE TABLE licenses (
  license_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  item_id TEXT,
  used_site_domain TEXT,
  status TEXT DEFAULT 'active',
  purchase_type TEXT,  -- 'site' for Use Case 2
  created_at INTEGER,
  updated_at INTEGER
);
```

### Payments Table

```sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,  -- One payment per subscription
  email TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  site_domain TEXT,  -- Site name for Use Case 2
  created_at INTEGER,
  updated_at INTEGER
);
```

---

## Example Flow

### Input:
- User adds 3 sites: `["example.com", "test.com", "demo.com"]`
- Price: $200/month per site

### Process:
1. Checkout: User pays $600 (3 × $200)
2. Webhook creates 3 subscriptions:
   - Subscription 1: `example.com` → License: `KEY-1234-5678-9012`
   - Subscription 2: `test.com` → License: `KEY-2345-6789-0123`
   - Subscription 3: `demo.com` → License: `KEY-3456-7890-1234`
3. Database stores 3 license records
4. Database stores 3 payment records ($200 each)

### Result:
- 3 separate subscriptions
- 3 license keys (one per site)
- Each subscription can be cancelled independently
- Each subscription has its own billing cycle

---

## Error Handling

### Missing Metadata
```javascript
if (!metadata.sites || !metadata.price_id) {
  console.warn('[USE CASE 2] ⚠️ Missing required metadata');
  return new Response('ok');
}
```

### Subscription Creation Failure
```javascript
if (createSubRes.status !== 200) {
  console.error(`[USE CASE 2] ❌ Failed to create subscription for site ${siteName}`);
  // Continue to next site
}
```

### License Key Already Exists
```javascript
const existingLicense = await db.prepare(
  'SELECT license_key FROM licenses WHERE license_key = ?'
).bind(licenseKey).first();

if (existingLicense) {
  console.warn(`[USE CASE 2] ⚠️ License key already exists, skipping`);
  continue;
}
```

---

## Summary

**Use Case 2 Workflow:**
1. ✅ User adds sites to pending list
2. ✅ User clicks "Pay Now"
3. ✅ Checkout session created with `usecase='2'` metadata
4. ✅ User completes payment
5. ✅ Webhook creates separate subscription for each site
6. ✅ License key generated for each site
7. ✅ License keys stored in database
8. ✅ Payment records created (one per subscription)
9. ✅ Pending sites removed from user record

**Result:** Each site has its own subscription for individual management (cancellation, billing cycles, invoices).

