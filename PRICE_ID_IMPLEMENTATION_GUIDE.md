# Price ID Implementation Guide

## Overview

This guide explains how price IDs work in the system and how to implement the automatic price ID handling.

## How Price IDs Work

### 1. **Payment Links (Stripe Dashboard)**
- ✅ **Same price ID can be used in multiple payment links**
- The price ID is just a reference to a pricing plan (amount + billing interval)
- Example: `price_123` can be used in Payment Link 1, Payment Link 2, etc.

### 2. **Creating New Subscriptions**
- ✅ **Same price ID can be used multiple times when creating NEW subscriptions**
- Each new subscription can use the same price ID
- Example: User A pays → creates subscription with `price_123`, User B pays → creates NEW subscription with `price_123` ✅

### 3. **Adding Sites to Existing Subscription**
- ⚠️ **Stripe doesn't allow duplicate price IDs in the SAME subscription**
- When adding a site to an existing subscription, if that price ID already exists, the system **automatically creates a new unique price ID** with the same amount
- Example: Subscription has `price_123` → Adding another site with `price_123` → System auto-creates `price_456` (same $10, unique ID)

## Implementation Steps

### Step 1: Configure Default Price ID

1. **Get your Price ID from Stripe:**
   - Go to Stripe Dashboard → Products → Pricing
   - Copy the Price ID (starts with `price_`)
   - Example: `price_1Sc89ISAczuHLTOtGHNji8Ay`

2. **Add to `wrangler.jsonc`:**
   ```jsonc
   "vars": {
     "DEFAULT_PRICE_ID": "price_1Sc89ISAczuHLTOtGHNji8Ay"
   }
   ```

3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

### Step 2: How the System Determines Price ID

The system uses this priority order:

1. **User-provided price** (if specified in API call)
2. **User's `defaultPrice`** (stored after first payment)
3. **Environment variable `DEFAULT_PRICE_ID`** (from `wrangler.jsonc`)
4. **Error** (if none found)

### Step 3: Automatic Price Creation Flow

When adding a site to an **existing subscription**:

```
1. User clicks "Add Site" → site1.com
2. System checks: Does subscription already have price_123?
   ├─ NO → Uses price_123 ✅
   └─ YES → Creates new price_456 (same amount, unique ID) ✅
3. Creates subscription item with the determined price
4. Site is added successfully
```

**Code Location:** `src/index.js` lines 1014-1059

## Usage Examples

### Example 1: First Payment (New Subscription)

**User Flow:**
1. User pays via Payment Link with `price_123`
2. System creates subscription with `price_123`
3. System stores `defaultPrice: "price_123"` in user record
4. ✅ Works perfectly

### Example 2: Adding Site to Existing Subscription

**User Flow:**
1. User has subscription with `price_123` (site1.com)
2. User adds site2.com → System tries to use `price_123`
3. System detects: `price_123` already exists in subscription
4. System automatically:
   - Fetches `price_123` details ($10/month)
   - Creates new price `price_456` ($10/month, same product)
   - Uses `price_456` for site2.com
5. ✅ Both sites active, one subscription, correct billing

### Example 3: Adding Site Without Price ID

**User Flow:**
1. User clicks "Add Site" without providing price ID
2. System checks:
   - No user-provided price ❌
   - User has `defaultPrice: "price_123"` ✅
3. System uses `price_123`
4. ✅ Site added successfully

### Example 4: First Site (No Previous Payment)

**User Flow:**
1. New user adds first site (no subscription yet)
2. System checks:
   - No user-provided price ❌
   - No `defaultPrice` (no previous payment) ❌
   - `DEFAULT_PRICE_ID` in environment ✅
3. System uses `DEFAULT_PRICE_ID`
4. Site added to pending sites
5. User clicks "Pay Now" → Checkout created with `DEFAULT_PRICE_ID`
6. ✅ Payment successful, subscription created

## Dashboard Behavior

### Adding Sites

**With Active Subscription:**
- Price ID is **optional** (uses `defaultPrice` or `DEFAULT_PRICE_ID`)
- If price ID provided and already exists → Auto-creates new unique price
- Site added immediately to subscription

**Without Active Subscription:**
- Price ID is **optional** (uses `DEFAULT_PRICE_ID`)
- Site added to pending sites
- "Pay Now" button appears
- After payment → Sites added to subscription

### Removing Sites

- Click "Unsubscribe" on any site
- System deletes the subscription item
- Stripe automatically handles proration
- Next invoice reflects the change

## Configuration Checklist

- [ ] Get Price ID from Stripe Dashboard
- [ ] Add `DEFAULT_PRICE_ID` to `wrangler.jsonc`
- [ ] Deploy: `npx wrangler deploy`
- [ ] Test: Add site without price ID (should use `DEFAULT_PRICE_ID`)
- [ ] Test: Add multiple sites to existing subscription (should auto-create unique prices)
- [ ] Verify: Check Stripe Dashboard → Products → Prices (should see auto-created prices)

## Troubleshooting

### Error: "price required"
**Cause:** No price ID provided and `DEFAULT_PRICE_ID` not configured  
**Fix:** Add `DEFAULT_PRICE_ID` to `wrangler.jsonc` and redeploy

### Error: "Invalid value for metadata"
**Cause:** Stripe API format issue (already fixed in code)  
**Fix:** Should not occur with current implementation

### Multiple prices created for same amount
**Expected:** This is normal when adding sites to existing subscription  
**Why:** Stripe requires unique price IDs per subscription item  
**Impact:** None - billing is correct, just more price objects in Stripe

## Code Locations

- **Price ID determination:** `src/index.js` lines 979-996 (active subscription), 1119-1125 (pending sites)
- **Auto-create unique price:** `src/index.js` lines 1014-1059
- **Default price storage:** `src/index.js` lines 424-426 (webhook handler)
- **Configuration:** `wrangler.jsonc` line 31-33

## Summary

✅ **Same price ID can be used in multiple payment links**  
✅ **System automatically handles price ID conflicts**  
✅ **No manual price ID entry needed in dashboard**  
✅ **Works seamlessly with existing subscriptions**

The system is fully automated - just configure `DEFAULT_PRICE_ID` once and it handles everything!

