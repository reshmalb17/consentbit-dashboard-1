# One Subscription with Multiple Sites - Implementation Guide

This implementation follows Stripe's recommended approach: **ONE subscription with MULTIPLE subscription items** (one item per site).

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         ONE Subscription                 │
│         (sub_123)                        │
├─────────────────────────────────────────┤
│  Subscription Item 1 → site1.com ($10)  │
│  Subscription Item 2 → site2.com ($10)  │
│  Subscription Item 3 → site3.com ($10)  │
└─────────────────────────────────────────┘
         ↓
    ONE Invoice ($30)
    ONE Payment
```

## Data Structure

### User Record (KV Storage)

```json
{
  "customerId": "cus_123",
  "subscriptionId": "sub_123",
  "email": "user@example.com",
  "sites": {
    "site1.com": {
      "item_id": "si_abc123",
      "price": "price_10",
      "quantity": 1,
      "status": "active",
      "created_at": 1704067200
    },
    "site2.com": {
      "item_id": "si_def456",
      "price": "price_10",
      "quantity": 1,
      "status": "active",
      "created_at": 1704067300
    }
  }
}
```

## API Endpoints

### 1. Create Checkout Session (Initial Purchase)

**POST** `/create-checkout-session`

Creates ONE subscription with multiple subscription items.

**Request:**
```json
{
  "customerEmail": "user@example.com",
  "sites": [
    { "site": "site1.com", "price": "price_10", "quantity": 1 },
    { "site": "site2.com", "price": "price_10", "quantity": 1 },
    { "site": "site3.com", "price": "price_10", "quantity": 1 }
  ],
  "success_url": "https://yoursite.com/success",
  "cancel_url": "https://yoursite.com/cancel"
}
```

**Response:**
```json
{
  "sessionId": "cs_test_...",
  "url": "https://checkout.stripe.com/..."
}
```

**What Happens:**
- Creates ONE subscription
- Creates 3 subscription items (one per site)
- User pays $30 in ONE payment
- Webhook maps sites to item IDs

---

### 2. Add a Site (Add Subscription Item)

**POST** `/add-site`

Adds a new subscription item to the existing subscription.

**Request:**
```json
{
  "site": "site4.com",
  "price": "price_10",
  "quantity": 1
}
```

**Response:**
```json
{
  "success": true,
  "itemId": "si_ghi789",
  "site": "site4.com",
  "message": "Site added successfully. Billing will be updated on next invoice."
}
```

**What Happens:**
- Creates new subscription item: `si_ghi789`
- Adds to existing subscription
- Next invoice: $40 (site1 + site2 + site3 + site4)
- Stripe handles proration automatically

**Stripe Code Equivalent:**
```javascript
await stripe.subscriptionItems.create({
  subscription: "sub_123",
  price: "price_10",
  metadata: { site: "site4.com" }
});
```

---

### 3. Remove a Site (Delete Subscription Item)

**POST** `/remove-site`

Removes a subscription item from the subscription.

**Request:**
```json
{
  "site": "site2.com"
}
```

**Response:**
```json
{
  "success": true,
  "site": "site2.com",
  "message": "Site removed successfully. Billing will be updated automatically by Stripe."
}
```

**What Happens:**
- Deletes subscription item: `si_def456`
- Stripe prorates (credits unused time)
- Next invoice: $20 (site1 + site3 + site4)
- Site marked as `inactive` in database (kept for history)

**Stripe Code Equivalent:**
```javascript
await stripe.subscriptionItems.del("si_def456");
```

---

### 4. Get Dashboard (List All Sites)

**GET** `/dashboard`

Returns all sites with their status.

**Response:**
```json
{
  "sites": {
    "site1.com": {
      "item_id": "si_abc123",
      "price": "price_10",
      "quantity": 1,
      "status": "active",
      "created_at": 1704067200
    },
    "site2.com": {
      "item_id": "si_def456",
      "price": "price_10",
      "quantity": 1,
      "status": "inactive",
      "created_at": 1704067300,
      "removed_at": 1704153600
    }
  },
  "subscription": {
    "id": "sub_123",
    "customerId": "cus_123",
    "email": "user@example.com"
  },
  "customerId": "cus_123"
}
```

---

## Webhook Events

### 1. `checkout.session.completed`

**Triggered:** When user completes initial checkout

**Action:**
- Maps subscription items to sites
- Stores site → item_id mapping in KV
- Sets metadata on subscription items

### 2. `customer.subscription.updated`

**Triggered:** When subscription items are added/removed

**Action:**
- Syncs site status (active/inactive)
- Updates quantities if changed
- Marks removed sites as inactive

### 3. `invoice.payment_succeeded`

**Triggered:** When payment is successful

**Action:**
- Generates license keys based on quantity
- Saves licenses to D1 database

---

## Example Flow

### Scenario: User subscribes to 3 sites, then removes 1

#### Step 1: Initial Purchase

**User clicks:** "Subscribe" button

**API Call:**
```javascript
POST /create-checkout-session
{
  "customerEmail": "user@example.com",
  "sites": [
    { "site": "site1.com", "price": "price_10" },
    { "site": "site2.com", "price": "price_10" },
    { "site": "site3.com", "price": "price_10" }
  ]
}
```

**Result:**
- Subscription: `sub_123`
- Items: `si_1` (site1), `si_2` (site2), `si_3` (site3)
- Invoice: $30
- Payment: ✅ Success

**Database:**
```json
{
  "sites": {
    "site1.com": { "item_id": "si_1", "status": "active" },
    "site2.com": { "item_id": "si_2", "status": "active" },
    "site3.com": { "item_id": "si_3", "status": "active" }
  }
}
```

---

#### Step 2: User Removes site2.com

**User clicks:** "Remove site2.com" button

**API Call:**
```javascript
POST /remove-site
{
  "site": "site2.com"
}
```

**Result:**
- Deletes subscription item: `si_2`
- Stripe prorates (credits unused time)
- Next invoice: $20 (site1 + site3)

**Database:**
```json
{
  "sites": {
    "site1.com": { "item_id": "si_1", "status": "active" },
    "site2.com": { "item_id": "si_2", "status": "inactive", "removed_at": 1704153600 },
    "site3.com": { "item_id": "si_3", "status": "active" }
  }
}
```

---

#### Step 3: User Adds site4.com

**User clicks:** "Add site4.com" button

**API Call:**
```javascript
POST /add-site
{
  "site": "site4.com",
  "price": "price_10"
}
```

**Result:**
- Creates subscription item: `si_4`
- Adds to existing subscription
- Next invoice: $30 (site1 + site3 + site4)

**Database:**
```json
{
  "sites": {
    "site1.com": { "item_id": "si_1", "status": "active" },
    "site2.com": { "item_id": "si_2", "status": "inactive" },
    "site3.com": { "item_id": "si_3", "status": "active" },
    "site4.com": { "item_id": "si_4", "status": "active", "created_at": 1704240000 }
  }
}
```

---

## Frontend Integration Examples

### Webflow: Add Site Button

```html
<button onclick="addSite('newsite.com', 'price_10')">Add Site</button>

<script>
async function addSite(site, price) {
  const response = await fetch('https://consentbit-dashboard.web-8fb.workers.dev/add-site', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Include session cookie
    body: JSON.stringify({ site, price })
  });
  
  const data = await response.json();
  if (data.success) {
    alert('Site added! Next invoice will be updated.');
    location.reload(); // Refresh dashboard
  }
}
</script>
```

### Webflow: Remove Site Button

```html
<button onclick="removeSite('site2.com')">Remove Site</button>

<script>
async function removeSite(site) {
  if (!confirm(`Remove ${site}? Billing will be updated automatically.`)) {
    return;
  }
  
  const response = await fetch('https://consentbit-dashboard.web-8fb.workers.dev/remove-site', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ site })
  });
  
  const data = await response.json();
  if (data.success) {
    alert('Site removed! Billing updated.');
    location.reload();
  }
}
</script>
```

### Display Sites Dashboard

```javascript
async function loadDashboard() {
  const response = await fetch('https://consentbit-dashboard.web-8fb.workers.dev/dashboard', {
    credentials: 'include'
  });
  
  const data = await response.json();
  
  // Display sites
  const container = document.getElementById('sites-list');
  Object.keys(data.sites).forEach(site => {
    const siteData = data.sites[site];
    const div = document.createElement('div');
    div.innerHTML = `
      <strong>${site}</strong>
      <span>Status: ${siteData.status}</span>
      ${siteData.status === 'active' 
        ? `<button onclick="removeSite('${site}')">Remove</button>`
        : '<span>(Removed)</span>'
      }
    `;
    container.appendChild(div);
  });
}
```

---

## Key Benefits

✅ **One Invoice** - All sites billed together  
✅ **One Payment** - Single payment per billing cycle  
✅ **Per-Site Control** - Add/remove sites independently  
✅ **Automatic Proration** - Stripe handles billing adjustments  
✅ **Clean Billing** - No multiple subscriptions to manage  
✅ **Simple Dashboard** - Easy to display and manage sites  

---

## Testing

### Test Add Site

```bash
curl -X POST https://consentbit-dashboard.web-8fb.workers.dev/add-site \
  -H "Content-Type: application/json" \
  -H "Cookie: sb_session=YOUR_SESSION_TOKEN" \
  -d '{
    "site": "testsite.com",
    "price": "price_test123"
  }'
```

### Test Remove Site

```bash
curl -X POST https://consentbit-dashboard.web-8fb.workers.dev/remove-site \
  -H "Content-Type: application/json" \
  -H "Cookie: sb_session=YOUR_SESSION_TOKEN" \
  -d '{
    "site": "testsite.com"
  }'
```

---

## Troubleshooting

### Site not appearing after add

- Check webhook: `customer.subscription.updated` should fire
- Verify subscription item was created in Stripe Dashboard
- Check Worker logs: `npx wrangler tail`

### Site not removed

- Verify `item_id` exists in user record
- Check Stripe Dashboard for subscription items
- Ensure webhook is receiving `subscription.updated` events

### Billing not updating

- Stripe automatically handles proration
- Check next invoice in Stripe Dashboard
- Verify subscription items were added/removed correctly

---

## Summary

This implementation follows Stripe's best practices:

- ✅ ONE subscription per customer
- ✅ Multiple subscription items (one per site)
- ✅ Easy add/remove of sites
- ✅ Automatic billing management
- ✅ Clean data structure

Perfect for multi-site licensing! 🎉

