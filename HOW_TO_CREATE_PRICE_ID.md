# How to Create Price IDs in Stripe

## Overview
Price IDs are created in two ways:
1. **Automatically by your code** (when adding sites)
2. **Manually in Stripe Dashboard** (for initial setup)

## Method 1: Automatic Creation (By Your Code)

### When Prices Are Created Automatically

Your code creates new price IDs automatically when:
- User adds sites to pending list
- System processes checkout for multiple sites
- Each site needs a unique price ID (Stripe requirement)

### Process Flow

```javascript
// Step 1: Get existing price details
const priceRes = await stripeFetch(env, `/prices/${existingPriceId}`);
const existingPrice = priceRes.body; // Contains: amount, currency, recurring info

// Step 2: Create new product (with site name)
const newProductData = {
  name: `ConsentBit Purchase - ${siteName}`,
  description: `Subscription for ${siteName}`,
  'metadata[site]': siteName,
  'metadata[created_for]': 'multi_site_subscription'
};
const productRes = await stripeFetch(env, '/products', 'POST', newProductData, true);
const productId = productRes.body.id; // e.g., "prod_xxxxx"

// Step 3: Create new price (linked to new product)
const newPriceData = {
  currency: existingPrice.currency,           // e.g., "usd"
  unit_amount: existingPrice.unit_amount,     // e.g., 1000 (cents = $10.00)
  product: productId,                         // Link to product created above
  'metadata[site]': siteName,
  'metadata[created_for]': 'multi_site_subscription',
  'metadata[original_price]': existingPriceId
};

// Add recurring fields if it's a subscription
if (existingPrice.recurring) {
  newPriceData['recurring[interval]'] = existingPrice.recurring.interval;        // "month" or "year"
  newPriceData['recurring[interval_count]'] = existingPrice.recurring.interval_count; // 1
}

// Step 4: Call Stripe API to create price
const newPriceRes = await stripeFetch(env, '/prices', 'POST', newPriceData, true);
const priceId = newPriceRes.body.id; // e.g., "price_xxxxx" ✅
```

### Code Location

**File:** `src/index.js`  
**Function:** `/create-checkout-from-pending` endpoint  
**Lines:** ~5494-5512

### Example: What Gets Created

**Input:**
- Site: `"www.example.com"`
- Existing Price: `price_1Sc89ISAczuHLTOtGHNji8Ay` ($10/month)

**Output:**
- **Product:** `prod_xxxxx` (name: "ConsentBit Purchase - www.example.com")
- **Price:** `price_yyyyy` (amount: $10/month, linked to product)

## Method 2: Manual Creation (Stripe Dashboard)

### Step-by-Step Guide

1. **Go to Stripe Dashboard**
   - Navigate to **Products** → **+ Add product**

2. **Create Product**
   - **Name:** `ConsentBit Purchase` (or your product name)
   - **Description:** `Subscription service` (optional)
   - Click **Save product**

3. **Add Price to Product**
   - In the product page, click **Add another price**
   - **Pricing model:** Recurring
   - **Price:** Enter amount (e.g., `10.00`)
   - **Billing period:** Monthly (or Yearly)
   - **Currency:** USD (or your currency)
   - Click **Add price**

4. **Copy Price ID**
   - After creating, you'll see the **Price ID**: `price_xxxxx`
   - Copy this ID

5. **Use in Your Code**
   - Add to `wrangler.jsonc`:
     ```json
     "vars": {
       "DEFAULT_PRICE_ID": "price_xxxxx"
     }
     ```

### Stripe Dashboard UI Example

```
Products → Add product
├─ Product Name: "ConsentBit Purchase"
├─ Description: "Subscription service"
└─ Pricing
   ├─ Price: $10.00
   ├─ Billing: Monthly
   ├─ Currency: USD
   └─ Price ID: price_1Sc89ISAczuHLTOtGHNji8Ay ✅
```

## Method 3: Via Stripe API (Direct)

### Using Stripe CLI or API

```bash
# Create product first
curl https://api.stripe.com/v1/products \
  -u sk_test_xxxxx: \
  -d name="ConsentBit Purchase" \
  -d description="Subscription service"

# Response: { "id": "prod_xxxxx", ... }

# Create price linked to product
curl https://api.stripe.com/v1/prices \
  -u sk_test_xxxxx: \
  -d product="prod_xxxxx" \
  -d currency="usd" \
  -d unit_amount=1000 \
  -d "recurring[interval]"=month

# Response: { "id": "price_xxxxx", ... } ✅
```

### Using Stripe SDK (Node.js)

```javascript
const stripe = require('stripe')('sk_test_xxxxx');

// Create product
const product = await stripe.products.create({
  name: 'ConsentBit Purchase',
  description: 'Subscription service'
});

// Create price
const price = await stripe.prices.create({
  product: product.id,
  currency: 'usd',
  unit_amount: 1000, // $10.00 in cents
  recurring: {
    interval: 'month'
  }
});

console.log('Price ID:', price.id); // "price_xxxxx" ✅
```

## Required Data for Price Creation

### Minimum Required Fields

| Field | Type | Example | Required |
|-------|------|---------|----------|
| `product` | String | `"prod_xxxxx"` | ✅ Yes |
| `currency` | String | `"usd"` | ✅ Yes |
| `unit_amount` | Integer | `1000` (cents) | ✅ Yes (for fixed price) |
| `recurring[interval]` | String | `"month"` or `"year"` | ✅ Yes (for subscriptions) |

### Optional Fields

| Field | Type | Example | Purpose |
|-------|------|---------|---------|
| `recurring[interval_count]` | Integer | `1` | Billing frequency (1 = every month, 3 = every 3 months) |
| `metadata[site]` | String | `"www.example.com"` | Track which site this price is for |
| `metadata[created_for]` | String | `"multi_site_subscription"` | Track why price was created |
| `nickname` | String | `"Monthly Subscription"` | Human-readable name |

## Price ID Format

- **Format:** `price_xxxxxxxxxxxxx`
- **Length:** ~20-30 characters
- **Example:** `price_1Sc89ISAczuHLTOtGHNji8Ay`
- **Test Mode:** Starts with `price_` (same format)
- **Live Mode:** Starts with `price_` (same format)

## How Your Code Uses Price IDs

### 1. **When Adding Sites**
```javascript
// User adds site → System determines price
let priceToUse = user.sites[firstSite].price || 
                 user.defaultPrice || 
                 env.DEFAULT_PRICE_ID;

// Store in pending_sites table
await DB.prepare(
  'INSERT INTO pending_sites (user_email, site_domain, price_id) VALUES (?, ?, ?)'
).bind(email, site, priceToUse).run();
```

### 2. **When Creating Checkout**
```javascript
// Read price_id from pending_sites
const pendingSite = { site: "www.example.com", price: "price_123" };

// Fetch price details
const priceRes = await stripeFetch(env, `/prices/${pendingSite.price}`);
const existingPrice = priceRes.body; // Contains all price info

// Create new price for this specific site
const newPrice = await stripeFetch(env, '/prices', 'POST', {
  currency: existingPrice.currency,
  unit_amount: existingPrice.unit_amount,
  product: newProductId,
  'recurring[interval]': existingPrice.recurring.interval
}, true);

const newPriceId = newPrice.body.id; // "price_yyyyy" ✅
```

### 3. **In Checkout Session**
```javascript
// Use price ID in checkout
const checkoutSession = {
  line_items: [{
    price: 'price_yyyyy',  // ← Price ID required here
    quantity: 1
  }]
};
```

## Common Scenarios

### Scenario 1: First Time Setup
1. Create product in Stripe Dashboard
2. Create price for that product
3. Copy price ID: `price_xxxxx`
4. Add to `wrangler.jsonc`: `"DEFAULT_PRICE_ID": "price_xxxxx"`

### Scenario 2: Adding Sites (Automatic)
1. User adds site → Code reads `DEFAULT_PRICE_ID`
2. Code creates new product: `"ConsentBit Purchase - site.com"`
3. Code creates new price: `price_yyyyy` (same amount, new product)
4. Price ID stored in `pending_sites` table
5. Used in checkout session

### Scenario 3: Price Deleted
1. Code tries to use stored price ID → 404 error
2. Code falls back to subscription prices
3. If found → Uses fallback price
4. Creates new price with same amount
5. Continues checkout process

## Testing Price Creation

### Test in Stripe Dashboard
1. Go to **Products** → Create test product
2. Add test price: $10/month
3. Copy test price ID: `price_test_xxxxx`
4. Use in test mode checkout

### Test via Code
```javascript
// Test price creation
const testPrice = await stripeFetch(env, '/prices', 'POST', {
  product: 'prod_test_xxxxx',
  currency: 'usd',
  unit_amount: 1000,
  'recurring[interval]': 'month'
}, true);

console.log('Test Price ID:', testPrice.body.id);
```

## Summary

| Method | When to Use | Who Creates |
|--------|-------------|-------------|
| **Stripe Dashboard** | Initial setup, one-time prices | You (manual) |
| **Your Code** | Adding sites, checkout processing | System (automatic) |
| **Stripe API** | Custom integrations, scripts | Developer (programmatic) |

## Key Points

1. ✅ **Price IDs are created automatically** when adding sites
2. ✅ **Initial price** should be created in Stripe Dashboard
3. ✅ **DEFAULT_PRICE_ID** in `wrangler.jsonc` is the starting point
4. ✅ **Each site gets unique price ID** (Stripe requirement)
5. ✅ **Price contains:** amount, currency, billing interval, product link

## Your Current Setup

**Default Price ID:** `price_1Sc89ISAczuHLTOtGHNji8Ay` (from `wrangler.jsonc`)

**How it works:**
1. User adds site → Code uses `DEFAULT_PRICE_ID`
2. Code creates new product + price for that site
3. New price ID stored in `pending_sites` table
4. Used in checkout session

No manual price creation needed for each site! 🎯

