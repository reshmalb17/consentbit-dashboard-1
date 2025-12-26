# Why Price ID is Needed

## Overview
A **Price ID** is required by Stripe to create subscription items or checkout sessions. It tells Stripe:
- **How much** to charge (amount)
- **What currency** (USD, EUR, etc.)
- **Billing interval** (monthly, yearly, etc.)
- **Which product** it's associated with

## Why Store Price ID in `pending_sites` Table?

### 1. **Stripe Requirement**
When creating a checkout session or subscription item, Stripe **requires** a price ID. You cannot create a subscription without specifying which price to use.

```javascript
// Stripe API requires price_id
const checkoutSession = await stripe.checkout.sessions.create({
  line_items: [{
    price: 'price_1234567890',  // ← REQUIRED
    quantity: 1
  }]
});
```

### 2. **Remember What to Charge**
When a user adds a site to the pending list, we need to remember:
- **What price** to charge for that site
- **When** they click "Pay Now", we use this stored price ID

**Example Flow:**
```
User adds "www.example.com" → System stores price_id: "price_123"
  ↓
User clicks "Pay Now" → System uses stored price_id to create checkout
  ↓
Stripe checkout shows correct amount based on price_id
```

### 3. **Price Selection Logic**
When adding sites, the system determines which price to use in this order:

```javascript
// Priority 1: Use price from existing active site
if (user has active sites) {
  priceToUse = firstActiveSite.price;
}

// Priority 2: Use user's default price
if (!priceToUse && user.defaultPrice) {
  priceToUse = user.defaultPrice;
}

// Priority 3: Use environment default
if (!priceToUse && env.DEFAULT_PRICE_ID) {
  priceToUse = env.DEFAULT_PRICE_ID;
}
```

This price is then **stored** in the `pending_sites` table for later use.

## What Information Does a Price ID Contain?

A Stripe Price object contains:

```json
{
  "id": "price_1234567890",
  "currency": "usd",
  "unit_amount": 1000,        // $10.00 (in cents)
  "recurring": {
    "interval": "month",       // Monthly billing
    "interval_count": 1
  },
  "product": "prod_1234567890"
}
```

## Why Price IDs Can Become Invalid?

### 1. **Price Deleted in Stripe**
- Admin might delete a price in Stripe dashboard
- Price no longer exists → Returns 404 error

### 2. **Wrong Stripe Account**
- Price might be from a different Stripe account
- Cannot access it → Returns 404 error

### 3. **Price Archived**
- Price might be archived (but still usable)
- System can still use it, but it's marked as inactive

### 4. **Price Changed**
- Price amount or interval might have changed
- Old price ID might still exist but with different settings

## Fallback Logic When Price ID is Invalid

When the stored price ID is invalid, the system tries fallbacks:

```
1. Try Original Price ID
   ├─ ✅ Found → Use it
   └─ ❌ Not Found → Continue

2. Try Subscription Prices (if subscription exists)
   ├─ ✅ Found → Use it
   └─ ❌ Not Found → Continue

3. Try Subscription Items (if subscription exists)
   ├─ ✅ Found → Use it
   └─ ❌ Not Found → Continue

4. Return Error
   └─ ❌ No valid price found → Show error message
```

## Real-World Example

### Scenario: User Adds Multiple Sites

**Step 1: User adds "www.site1.com"**
- System determines price: `price_123` (from existing subscription)
- Stores in database: `{ site: "www.site1.com", price_id: "price_123" }`

**Step 2: User adds "www.site2.com"**
- System determines price: `price_123` (same as site1)
- Stores in database: `{ site: "www.site2.com", price_id: "price_123" }`

**Step 3: User clicks "Pay Now"**
- System reads pending sites from database
- For each site, uses stored `price_id` to create checkout line items
- Stripe checkout shows correct amounts for each site

**Step 4: If price_123 was deleted**
- System tries original price → ❌ Not found
- System tries subscription prices → ✅ Found `price_456`
- System uses `price_456` as fallback
- Creates new price with same amount for the site

## Database Schema

```sql
CREATE TABLE pending_sites (
  id INTEGER PRIMARY KEY,
  user_email TEXT NOT NULL,
  site_domain TEXT NOT NULL,
  price_id TEXT,              -- ← Stores the price ID
  quantity INTEGER DEFAULT 1,
  created_at INTEGER,
  UNIQUE(user_email, site_domain)
);
```

## Why Not Just Use DEFAULT_PRICE_ID?

**Problem:** Different users might have different pricing:
- User A: $10/month per site
- User B: $20/month per site (premium plan)
- User C: $5/month per site (discount)

**Solution:** Store the price ID that was determined when the site was added, so:
- Each user gets charged the correct amount
- Pricing is consistent with their subscription
- Changes to DEFAULT_PRICE_ID don't affect existing pending sites

## Summary

| Question | Answer |
|----------|--------|
| **Why needed?** | Stripe requires price ID to create subscriptions/checkout |
| **Why store it?** | Remember what to charge when user clicks "Pay Now" |
| **What if invalid?** | System falls back to subscription prices or returns error |
| **Can we skip it?** | No - Stripe API requires it |
| **What if missing?** | System tries to find fallback price from subscription |

## Key Takeaway

**Price ID is the bridge between:**
- Your application (knowing which site to charge)
- Stripe API (knowing how much to charge)

Without it, Stripe doesn't know:
- How much to charge
- What currency to use
- How often to bill

That's why it's essential to store and use price IDs correctly! 🎯

