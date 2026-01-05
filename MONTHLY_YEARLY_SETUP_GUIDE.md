# Monthly/Yearly Payment Plan Setup Guide

This guide explains what you need to do in **Stripe** and what to configure in your **code** to enable Monthly/Yearly payment plan selection.

---

## 📋 Table of Contents

1. [Stripe Setup](#stripe-setup)
2. [Code Configuration](#code-configuration)
3. [Testing](#testing)
4. [Troubleshooting](#troubleshooting)

---

## 🎯 Part 1: Stripe Setup

### Step 1: Create Products in Stripe Dashboard

1. **Go to Stripe Dashboard**
   - Navigate to: https://dashboard.stripe.com/
   - Select your account (Test or Live mode)

2. **Create Monthly Product**
   - Go to **Products** → Click **+ Add product**
   - **Name:** `ConsentBit Monthly Subscription` (or your preferred name)
   - **Description:** `Monthly subscription for ConsentBit service` (optional)
   - Click **Save product**
   - **Note the Product ID:** `prod_xxxxx` (you'll need this)

3. **Add Monthly Price to Product**
   - In the product page, click **Add another price**
   - **Pricing model:** Select **Recurring**
   - **Price:** Enter your monthly amount (e.g., `10.00` for $10/month)
   - **Billing period:** Select **Monthly**
   - **Currency:** Select your currency (e.g., USD)
   - Click **Add price**
   - **Copy the Price ID:** `price_xxxxx` (e.g., `price_1SiMxxxxx`) ⚠️ **SAVE THIS!**

4. **Create Yearly Product** (Optional - can use same product)
   - You can either:
     - **Option A:** Add a yearly price to the same product
     - **Option B:** Create a separate product for yearly subscriptions
   - **Recommended:** Use the same product with different prices

5. **Add Yearly Price**
   - In the same product (or new product), click **Add another price**
   - **Pricing model:** Select **Recurring**
   - **Price:** Enter your yearly amount (e.g., `100.00` for $100/year)
   - **Billing period:** Select **Yearly** (or "Every 12 months")
   - **Currency:** Same as monthly
   - Click **Add price**
   - **Copy the Price ID:** `price_yyyyy` (e.g., `price_1SiNyyyyy`) ⚠️ **SAVE THIS!**

### Step 2: Verify Your Prices

In Stripe Dashboard, you should now have:

```
Product: ConsentBit Monthly Subscription
├─ Price 1: $10.00 / month → price_1SiMxxxxx (MONTHLY)
└─ Price 2: $100.00 / year → price_1SiNyyyyy (YEARLY)
```

**Or two separate products:**

```
Product 1: ConsentBit Monthly Subscription
└─ Price: $10.00 / month → price_1SiMxxxxx

Product 2: ConsentBit Yearly Subscription
└─ Price: $100.00 / year → price_1SiNyyyyy
```

### Step 3: Test Mode vs Live Mode

- **Test Mode:** Use test price IDs (starts with `price_`)
- **Live Mode:** Use live price IDs (also starts with `price_`)

**Important:** Make sure you're using the correct mode for your environment!

---

## 💻 Part 2: Code Configuration

### Step 1: Update `wrangler.jsonc`

Open your `wrangler.jsonc` file and add the monthly and yearly price IDs:

```jsonc
{
  "name": "consentbit-dashboard-test",
  "main": "src/index.js",
  "compatibility_date": "2024-01-01",
  "vars": {
    // ... existing variables ...
    
    // Monthly and Yearly Price IDs
    "MONTHLY_PRICE_ID": "price_1SiMxxxxx",  // Replace with your monthly price ID
    "YEARLY_PRICE_ID": "price_1SiNyyyyy",   // Replace with your yearly price ID
    
    // Optional: Keep DEFAULT_PRICE_ID as fallback (use monthly price ID)
    "DEFAULT_PRICE_ID": "price_1SiMxxxxx",  // Fallback to monthly
    
    // Optional: License price ID (for license key purchases)
    "LICENSE_PRICE_ID": "price_1SiMxxxxx"   // Can use same as monthly
  }
}
```

### Step 2: Update Code to Use Environment Variables

The code already supports fetching price IDs from user subscriptions, but you can also add fallback logic to use environment variables. Let me check if we need to update the frontend code:

**Current Behavior:**
- Frontend tries to fetch price IDs from user's existing subscriptions
- If user has no subscriptions, it won't have price IDs

**Recommended:** Add fallback to environment variables in the frontend.

### Step 3: Add API Endpoint to Get Price IDs (Optional)

If you want to provide price IDs via an API endpoint, you can add this to `src/index.js`:

```javascript
// Add this endpoint to get available price IDs
if (request.method === 'GET' && pathname === '/get-price-options') {
  return jsonResponse(200, {
    monthly: env.MONTHLY_PRICE_ID || null,
    yearly: env.YEARLY_PRICE_ID || null,
    default: env.DEFAULT_PRICE_ID || null
  }, true, request);
}
```

Then update `dashboard-script.js` to fetch from this endpoint:

```javascript
// In setupPaymentPlanHandlers function, add:
async function fetchPriceIds(userEmail) {
  try {
    // Try to get from environment variables first
    const priceOptionsResponse = await fetch(`${API_BASE}/get-price-options`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    
    if (priceOptionsResponse.ok) {
      const priceOptions = await priceOptionsResponse.json();
      if (priceOptions.monthly) monthlyPriceId = priceOptions.monthly;
      if (priceOptions.yearly) yearlyPriceId = priceOptions.yearly;
    }
    
    // Also try to get from user's subscriptions (existing logic)
    const response = await fetch(`${API_BASE}/dashboard?email=${encodeURIComponent(userEmail)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    
    // ... rest of existing logic ...
  } catch (error) {
    console.warn('[Dashboard] Could not fetch price IDs:', error);
  }
}
```

---

## ✅ Part 3: Testing

### Test Checklist

1. **Test Monthly Selection**
   - [ ] Select "Monthly" payment plan
   - [ ] Verify site input is enabled
   - [ ] Add a site
   - [ ] Click "Pay Now"
   - [ ] Verify Stripe checkout shows monthly price

2. **Test Yearly Selection**
   - [ ] Select "Yearly" payment plan
   - [ ] Verify site input is enabled
   - [ ] Add a site
   - [ ] Click "Pay Now"
   - [ ] Verify Stripe checkout shows yearly price

3. **Test License Key Purchase**
   - [ ] Select "Monthly" or "Yearly" for license keys
   - [ ] Enter quantity
   - [ ] Click "Purchase Now"
   - [ ] Verify correct price is used

4. **Test Without Selection**
   - [ ] Try to add site without selecting payment plan
   - [ ] Verify error message appears
   - [ ] Verify inputs remain disabled

---

## 🔧 Part 4: Troubleshooting

### Problem: Price IDs not found

**Symptoms:**
- Payment plan selector doesn't enable inputs
- Error: "Please select a payment plan first"

**Solutions:**
1. **Check environment variables:**
   ```bash
   # Verify wrangler.jsonc has correct price IDs
   cat wrangler.jsonc | grep PRICE_ID
   ```

2. **Verify Stripe price IDs:**
   - Go to Stripe Dashboard → Products
   - Check that price IDs match what's in `wrangler.jsonc`
   - Make sure you're using Test mode price IDs in test environment

3. **Check user has subscriptions:**
   - If user has no existing subscriptions, price IDs won't be auto-detected
   - Solution: Add fallback to environment variables (see Step 2 above)

### Problem: Wrong price shown in checkout

**Symptoms:**
- Monthly selected but yearly price shown (or vice versa)

**Solutions:**
1. **Check price ID mapping:**
   - Verify `monthlyPriceId` and `yearlyPriceId` variables are set correctly
   - Check browser console for errors

2. **Verify price IDs in Stripe:**
   - Confirm monthly price has `interval: "month"`
   - Confirm yearly price has `interval: "year"`

### Problem: Inputs not enabling after selection

**Symptoms:**
- Payment plan selected but inputs still disabled

**Solutions:**
1. **Check JavaScript errors:**
   - Open browser console (F12)
   - Look for errors in `setupPaymentPlanHandlers`

2. **Verify event listeners:**
   - Check that radio buttons have correct IDs
   - Verify `handlePaymentPlanChange` is called

---

## 📝 Summary

### What You Need from Stripe:

1. ✅ **Monthly Price ID:** `price_xxxxx` (recurring, monthly)
2. ✅ **Yearly Price ID:** `price_yyyyy` (recurring, yearly)

### What You Need to Configure in Code:

1. ✅ **Add to `wrangler.jsonc`:**
   ```jsonc
   "MONTHLY_PRICE_ID": "price_xxxxx",
   "YEARLY_PRICE_ID": "price_yyyyy"
   ```

2. ✅ **Optional:** Add `/get-price-options` endpoint for fallback

3. ✅ **Optional:** Update frontend to fetch from environment variables if user has no subscriptions

### Current Status:

✅ **Frontend:** Payment plan selectors added, inputs disabled until selection  
✅ **Backend:** Accepts `price_id` parameter in all relevant endpoints  
✅ **Logic:** Fetches price IDs from user subscriptions  

### Next Steps:

1. Create prices in Stripe (see Part 1)
2. Add price IDs to `wrangler.jsonc` (see Part 2)
3. Test the flow (see Part 3)
4. Deploy and verify in production

---

## 🚀 Quick Start

**If you already have prices in Stripe:**

1. Copy your monthly price ID from Stripe Dashboard
2. Copy your yearly price ID from Stripe Dashboard
3. Add to `wrangler.jsonc`:
   ```jsonc
   "MONTHLY_PRICE_ID": "your_monthly_price_id",
   "YEARLY_PRICE_ID": "your_yearly_price_id"
   ```
4. Deploy: `wrangler deploy`
5. Test in dashboard

**That's it!** The system will automatically use these price IDs when users select Monthly or Yearly plans.

