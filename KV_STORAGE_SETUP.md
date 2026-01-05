# KV Storage Setup for Subscriptions

This document explains how KV storage is configured to save subscription data when subscriptions are created or updated.

---

## 📋 Overview

When a subscription is created or updated (for site purchases or direct link purchases), the system automatically saves data to two KV namespaces:

1. **ACTIVE_SITES_CONSENTBIT** - Stores active site information with a fixed ID
2. **SUBSCRIPTION_CONSENTBIT** - Stores subscription details with key format: `customerId-subscriptionId`

---

## 🔧 Configuration

### KV Namespaces in `wrangler.jsonc`

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "ACTIVE_SITES_KV",
      "id": "66c7aa5c7fcb4c2a8dfec5463e86a293"
    },
    {
      "binding": "SUBSCRIPTION_KV",
      "id": "c46f2faa3cf74039ac7207bdb20ad8fa"
    }
  ]
}
```

---

## 📊 Data Format

### ACTIVE_SITES_CONSENTBIT

**Key:** `66c7aa5c7fcb4c2a8dfec5463e86a293` (fixed ID)

**Value Format:**
```json
{
  "active": true,
  "subscriptionId": "sub_1SDXNhJwcuB9163MfsNQzsgJ",
  "customerId": "cus_B9r57ajToCz2Fk",
  "email": "reshma@seattlenewmedia.com",
  "status": "complete",
  "lastUpdated": "2025-10-01T21:16:16.046Z",
  "cancelAtPeriodEnd": false
}
```

### SUBSCRIPTION_CONSENTBIT

**Key Format:** `{customerId}-{subscriptionId}`

**Example Key:** `cus_B9r57ajToCz2Fk-sub_1SDXNhJwcuB9163MfsNQzsgJ`

**Value Format:**
```json
{
  "email": "george@emergingttech.com",
  "connectDomain": "https://emergingtt.com",
  "isSubscribed": true,
  "stripeCustomerId": "cus_SgxE4OS5YHjFYU",
  "stripeSubscriptionId": "sub_1RlZK7JwcuG9163MnsJNpDw2",
  "subscriptionStatus": "complete",
  "paymentStatus": "paid",
  "created": "2025-07-16T17:40:40.000Z",
  "lastUpdated": "2025-07-16T18:42:12.142Z"
}
```

---

## 🔄 When KV Storage is Updated

### 1. Use Case 1: Direct Payment Link

**Trigger:** `checkout.session.completed` webhook

**When:** After payment is successfully saved to database

**Location:** `src/index.js` → Use Case 1 handler (after payment save)

**Code:**
```javascript
// Save to KV storage (for direct link purchase - Use Case 1)
if (purchaseType !== 'quantity' && allSites.length > 0) {
  const siteName = customFieldSiteUrl || allSites[0] || (sub.items?.data?.[0]?.metadata?.site);
  if (siteName) {
    await saveSubscriptionToKV(
      env,
      customerId,
      subscriptionId,
      email,
      siteName,
      sub.status === 'active' ? 'complete' : sub.status,
      'paid',
      sub.cancel_at_period_end || false
    );
  }
}
```

### 2. Use Case 2: Site Purchase

**Trigger:** `payment_intent.succeeded` webhook

**When:** After each subscription is created for a site

**Location:** `src/index.js` → Use Case 2 handler (after subscription creation)

**Code:**
```javascript
// Save to KV storage (for site purchase - Use Case 2)
await saveSubscriptionToKV(
  env,
  useCase2CustomerId,
  newSubscription.id,
  userEmail,
  siteName,
  newSubscription.status === 'active' ? 'complete' : newSubscription.status,
  'paid',
  newSubscription.cancel_at_period_end || false
);
```

### 3. Subscription Updates

**Trigger:** `customer.subscription.updated` webhook

**When:** When subscription status changes (active, cancelled, etc.)

**Location:** `src/index.js` → Subscription update handler

**Code:**
```javascript
// Save to KV storage (for subscription updates)
const itemPurchaseType = item.metadata?.purchase_type || 'site';
if (itemPurchaseType !== 'quantity' && site) {
  await saveSubscriptionToKV(
    env,
    customerId,
    subscriptionId,
    userEmail,
    site,
    sub.status === 'active' ? 'complete' : sub.status,
    'paid',
    sub.cancel_at_period_end || false
  );
}
```

---

## 🔍 Site Name Formatting

The system automatically formats site names:

- **If site name already has `http://` or `https://`:** Uses as-is
- **If site name doesn't have protocol:** Adds `https://` prefix

**Examples:**
- `example.com` → `https://example.com`
- `https://example.com` → `https://example.com` (unchanged)
- `http://example.com` → `http://example.com` (unchanged)

---

## ✅ What Gets Saved

### For Site Purchases (Use Case 1 & 2):

- ✅ Site name (formatted with https:// if needed)
- ✅ Subscription ID
- ✅ Customer ID
- ✅ Email
- ✅ Subscription status
- ✅ Payment status
- ✅ Cancel at period end flag
- ✅ Timestamps (created, lastUpdated)

### For Quantity Purchases:

- ❌ **Not saved to KV** - Only site purchases are saved

---

## 🛠️ Helper Functions

### `formatSiteName(siteName)`

Formats site name with `https://` prefix if needed.

**Input:** `"example.com"`  
**Output:** `"https://example.com"`

### `saveSubscriptionToKV(env, customerId, subscriptionId, email, siteName, subscriptionStatus, paymentStatus, cancelAtPeriodEnd)`

Saves subscription data to both KV namespaces.

**Parameters:**
- `env` - Environment object with KV bindings
- `customerId` - Stripe customer ID
- `subscriptionId` - Stripe subscription ID
- `email` - User email
- `siteName` - Site domain/name
- `subscriptionStatus` - Subscription status (default: 'complete')
- `paymentStatus` - Payment status (default: 'paid')
- `cancelAtPeriodEnd` - Whether subscription cancels at period end (default: false)

---

## 📝 Data Flow

### Use Case 1 (Direct Payment Link):

```
1. User completes payment via payment link
2. Stripe sends checkout.session.completed webhook
3. System processes subscription
4. Payment saved to database
5. ✅ KV storage updated (ACTIVE_SITES_CONSENTBIT + SUBSCRIPTION_CONSENTBIT)
```

### Use Case 2 (Site Purchase):

```
1. User adds sites and clicks "Pay Now"
2. Payment completed
3. Stripe sends payment_intent.succeeded webhook
4. System creates subscription for each site
5. ✅ KV storage updated for each subscription (ACTIVE_SITES_CONSENTBIT + SUBSCRIPTION_CONSENTBIT)
```

### Subscription Updates:

```
1. Subscription status changes (cancel, renew, etc.)
2. Stripe sends customer.subscription.updated webhook
3. System updates subscription in database
4. ✅ KV storage updated (ACTIVE_SITES_CONSENTBIT + SUBSCRIPTION_CONSENTBIT)
```

---

## 🔍 Verification

### Check KV Storage:

```bash
# Using wrangler CLI
wrangler kv:key get "66c7aa5c7fcb4c2a8dfec5463e86a293" --namespace-id=66c7aa5c7fcb4c2a8dfec5463e86a293
wrangler kv:key get "cus_xxx-sub_xxx" --namespace-id=c46f2faa3cf74039ac7207bdb20ad8fa
```

### Expected Output:

**ACTIVE_SITES_CONSENTBIT:**
```json
{
  "active": true,
  "subscriptionId": "sub_xxx",
  "customerId": "cus_xxx",
  "email": "user@example.com",
  "status": "complete",
  "lastUpdated": "2025-01-27T12:00:00.000Z",
  "cancelAtPeriodEnd": false
}
```

**SUBSCRIPTION_CONSENTBIT:**
```json
{
  "email": "user@example.com",
  "connectDomain": "https://example.com",
  "isSubscribed": true,
  "stripeCustomerId": "cus_xxx",
  "stripeSubscriptionId": "sub_xxx",
  "subscriptionStatus": "complete",
  "paymentStatus": "paid",
  "created": "2025-01-27T12:00:00.000Z",
  "lastUpdated": "2025-01-27T12:00:00.000Z"
}
```

---

## ⚠️ Important Notes

1. **KV Storage is Optional:**
   - If KV namespaces are not configured, the system will log a warning but continue
   - Main operations (database saves) are not affected

2. **Only Site Purchases:**
   - Quantity purchases (Use Case 3) are **not** saved to KV
   - Only site purchases (Use Case 1 & 2) are saved

3. **Fixed ID for ACTIVE_SITES_CONSENTBIT:**
   - The ID `66c7aa5c7fcb4c2a8dfec5463e86a293` is hardcoded
   - This means only the **last** subscription will be stored in this namespace
   - For multiple subscriptions, use SUBSCRIPTION_CONSENTBIT with unique keys

4. **Site Name Formatting:**
   - Site names are automatically formatted with `https://` prefix
   - This ensures consistent format in `connectDomain` field

---

## ✅ Summary

- ✅ KV namespaces configured in `wrangler.jsonc`
- ✅ Helper functions created (`formatSiteName`, `saveSubscriptionToKV`)
- ✅ KV storage integrated in Use Case 1 handler
- ✅ KV storage integrated in Use Case 2 handler
- ✅ KV storage integrated in subscription update handler
- ✅ Site names automatically formatted with `https://` prefix
- ✅ Only site purchases are saved (quantity purchases excluded)

The system is now ready to save subscription data to KV storage! 🎉

