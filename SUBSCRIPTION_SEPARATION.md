# Subscription Separation: Quantity vs Site Purchases

## Overview
Quantity purchases and site purchases are kept completely separate. Each type has its own subscription(s) and items, ensuring clean separation and proper management.

## Architecture

### 1. **Quantity Purchases**
- **Can add to existing subscriptions OR create new subscriptions**
- **Items are tagged with `purchase_type: 'quantity'` metadata to keep them separate**
- **Subscription metadata:** `purchase_type: 'quantity'`
- **Items:** One subscription item with `quantity > 1` (or multiple items if added separately)
- **Purpose:** Generate multiple license keys without site assignment
- **Individual Management:** Each license can be individually deactivated, which reduces the subscription item quantity and triggers proration

### 2. **Site Purchases**
- **Can create new subscription OR add to existing site-based subscription**
- **Never adds to quantity subscriptions**
- **Subscription metadata:** `purchase_type: 'site'` (or default)
- **Items:** One subscription item per site
- **Purpose:** One license key per site, pre-assigned

## Separation Logic

### Quantity Purchase Flow

**Endpoint:** `POST /purchase-quantity`

```javascript
// Can add to existing subscription OR create new
const form = {
  'mode': 'subscription',
  'subscription_data[metadata][purchase_type]': 'quantity',
  'subscription_data[metadata][quantity]': '7',
  'subscription_data[metadata][add_to_existing]': existingSubscriptionId ? 'true' : 'false'
};
```

**Result (if adding to existing subscription):**
- Adds to subscription: `sub_existing_123`
- Subscription item tagged with: `metadata.purchase_type = 'quantity'`
- One subscription item with `quantity: 7` (or adds to existing quantity item)
- Generates 7 license keys (no site domains)
- Each license can be individually deactivated via `/deactivate-license`

**Result (if creating new subscription):**
- Creates subscription: `sub_quantity_123`
- Subscription has: `metadata.purchase_type = 'quantity'`
- One subscription item with `quantity: 7`
- Generates 7 license keys (no site domains)

### Site Purchase Flow

**Endpoint:** `POST /create-checkout-from-pending`

**When adding to existing subscription:**
```javascript
// Check if existing subscription is quantity-based
if (existingSub.metadata?.purchase_type === 'quantity') {
  // REJECT: Cannot add site purchase to quantity subscription
  // Force new subscription instead
  addToExisting = false;
}
```

**Result:**
- Only adds to site-based subscriptions
- Creates new subscription if existing is quantity-based
- Each site gets its own subscription item

## Database Structure

### Subscriptions Table
```sql
subscription_id | customer_id | metadata (JSON)
----------------|-------------|------------------
sub_site_1      | cus_123     | {"purchase_type": "site"}
sub_site_2      | cus_123     | {"purchase_type": "site"}
sub_quantity_1  | cus_123     | {"purchase_type": "quantity", "quantity": "7"}
```

### Subscription Items Table
```sql
subscription_id | item_id      | site_domain    | quantity | metadata
----------------|--------------|----------------|----------|------------------
sub_site_1      | si_site_1    | www.site1.com  | 1        | {"purchase_type": "site", "site": "www.site1.com"}
sub_site_2      | si_site_2    | www.site2.com  | 1        | {"purchase_type": "site", "site": "www.site2.com"}
sub_quantity_1  | si_quantity_1 | NULL           | 7        | {"purchase_type": "quantity"}
```

### Licenses Table
```sql
license_key     | subscription_id | site_domain | used_site_domain | purchase_type
----------------|-----------------|-------------|------------------|---------------
KEY-SITE-1      | sub_site_1      | www.site1.com| www.site1.com    | site
KEY-SITE-2      | sub_site_2      | www.site2.com| www.site2.com    | site
KEY-QTY-1       | sub_quantity_1  | NULL        | NULL             | quantity
KEY-QTY-2       | sub_quantity_1  | NULL        | NULL             | quantity
...
KEY-QTY-7       | sub_quantity_1  | NULL        | NULL             | quantity
```

## Protection Mechanisms

### 1. **Quantity Purchase Flexibility**
```javascript
// In /purchase-quantity endpoint
'subscription_data[metadata][add_to_existing]': existingSubscriptionId ? 'true' : 'false'
'line_items[0][metadata][purchase_type]': 'quantity'  // Tag item separately
```

**Allows:**
- Quantity purchases to add to existing subscriptions (if subscription exists)
- Items are tagged with `purchase_type: 'quantity'` to keep them separate from site purchases
- Individual license management: each license can be deactivated independently

### 2. **Site Purchase Protection**
```javascript
// In webhook handler
if (purchaseType === 'quantity') {
  addToExisting = false;  // Force new subscription
}

// Check existing subscription type
if (existingSub.metadata?.purchase_type === 'quantity') {
  addToExisting = false;  // Cannot add site to quantity subscription
}
```

**Prevents:**
- Site purchases from being added to quantity subscriptions
- Mixing site and quantity items in same subscription

### 3. **Item Metadata Protection**
```javascript
// When adding site item to subscription
'metadata[purchase_type]': 'site'  // Mark as site purchase
```

**Ensures:**
- Items are tagged with purchase type
- Easy identification of item type
- Prevents accidental mixing

## Dashboard Display

### Subscriptions Tab
Shows separate subscriptions:
```
Subscription 1 (Site Purchase)
├── www.site1.com
└── www.site2.com

Subscription 2 (Site Purchase)
└── www.site3.com

Subscription 3 (Quantity Purchase)
└── 7 licenses (unassigned)
```

### License Keys Tab
Shows all licenses grouped by type:
```
Site Purchases:
├── KEY-SITE-1 (www.site1.com)
├── KEY-SITE-2 (www.site2.com)
└── KEY-SITE-3 (www.site3.com)

Quantity Purchases:
├── KEY-QTY-1 (Available)
├── KEY-QTY-2 (Available)
...
└── KEY-QTY-7 (Available)
```

## Benefits of Separation

1. **Clear Organization**
   - Easy to identify subscription type
   - Separate billing cycles if needed
   - Clear license management

2. **Prevents Mixing**
   - No accidental mixing of purchase types
   - Clean data structure
   - Easier to manage

3. **Flexible Management**
   - Can cancel quantity subscription separately
   - Can cancel site subscriptions separately
   - Independent billing

4. **Better Tracking**
   - Clear separation in database
   - Easy to query by purchase type
   - Better reporting

## Example Scenarios

### Scenario 1: User purchases 5 quantity licenses (new subscription)
1. Creates: `sub_quantity_1` with `quantity: 5`
2. Generates: 5 license keys (no site domains)
3. Subscription metadata: `purchase_type: 'quantity'`

### Scenario 1b: User purchases 3 more quantity licenses (adds to existing)
1. Finds existing subscription: `sub_quantity_1` (quantity-based) ✅
2. Adds quantity item to: `sub_quantity_1` (or increases existing item quantity)
3. Generates: 3 additional license keys
4. Each license can be individually deactivated later

### Scenario 2: User purchases 2 sites
1. Creates: `sub_site_1` with 2 items
2. Generates: 2 license keys (one per site)
3. Subscription metadata: `purchase_type: 'site'` (default)

### Scenario 3: User adds 1 more site
1. Checks existing subscription: `sub_site_1` (site-based) ✅
2. Adds item to: `sub_site_1`
3. Generates: 1 license key for new site

### Scenario 4: User tries to add site to quantity subscription
1. Checks existing subscription: `sub_quantity_1` (quantity-based) ❌
2. **Rejects:** Cannot add site to quantity subscription
3. Creates: New `sub_site_2` instead
4. Generates: 1 license key for new site

### Scenario 5: User deactivates 1 quantity license
1. Finds license in database: `KEY-XXXX-XXXX-XXXX`
2. Gets subscription item: `si_quantity_1` with `quantity: 5`
3. Reduces quantity: `quantity: 4` (with proration)
4. Marks license as inactive in database
5. Stripe automatically prorates the current period

## Code Locations

### Quantity Purchase
- **Endpoint:** `src/index.js` → `POST /purchase-quantity` (line ~7665)
- **Webhook:** `src/index.js` → `checkout.session.completed` (line ~2334)
- **Detection:** Checks `session.subscription_data.metadata.purchase_type`

### Site Purchase
- **Endpoint:** `src/index.js` → `POST /create-checkout-from-pending` (line ~2600)
- **Webhook:** `src/index.js` → `checkout.session.completed` (line ~1738)
- **Protection:** Checks existing subscription type before adding

## Testing Checklist

- [ ] Quantity purchase creates new subscription
- [ ] Site purchase creates new subscription (if no existing site subscription)
- [ ] Site purchase adds to existing site subscription
- [ ] Site purchase rejects adding to quantity subscription
- [ ] Quantity purchase never adds to existing subscription
- [ ] Licenses are generated correctly for each type
- [ ] Dashboard shows separate subscriptions
- [ ] License keys tab shows correct grouping

