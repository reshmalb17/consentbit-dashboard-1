# Use Case 1 Testing Guide - Complete Verification

## Overview

This guide helps you test Use Case 1 (Direct Payment Links) and verify that:
- ✅ Data is saving to database
- ✅ Data is updating in dashboard
- ✅ All operations complete successfully

---

## Pre-Testing Checklist

Before testing, ensure:

- [ ] Product metadata `usedfor: dashboard` is added to product
- [ ] Payment Link URLs are configured correctly
- [ ] Webhook endpoint is created
- [ ] Environment variables are set

---

## Step 1: Complete Test Payment

### 1.1 Get Payment Link

1. Go to **Stripe Dashboard** → **Products**
2. Click on your product (Monthly or Yearly)
3. Click **Payment Links** tab
4. Copy the Payment Link URL

### 1.2 Complete Payment

1. Open Payment Link in browser
2. Use Stripe test card: `4242 4242 4242 4242`
3. Expiry: `12/34`
4. CVC: `123`
5. Complete payment

### 1.3 Verify Redirect

**Expected:**
- ✅ Redirects to: `https://dashboard.consentbit.com/dashboard?session_id=cs_test_xxxxx&payment=success`
- ✅ Dashboard loads successfully

---

## Step 2: Check Webhook Logs

### 2.1 View Cloudflare Worker Logs

**Option A: Cloudflare Dashboard**
1. Go to Cloudflare Dashboard → Workers & Pages
2. Click on `consentbit-dashboard-test`
3. Go to **Logs** tab
4. Filter for recent logs

**Option B: Wrangler CLI**
```bash
cd consentbit-dashboard-1
wrangler tail --name consentbit-dashboard-test
```

### 2.2 Expected Log Sequence

Look for these logs in order:

```
[USE CASE 1] 🚀 ========================================
[USE CASE 1] 🚀 STARTING USE CASE 1 PROCESSING
[USE CASE 1] 🚀 ========================================
[USE CASE 1] 📋 Session ID: cs_test_xxxxx
[USE CASE 1] 📋 Customer ID: cus_xxxxx
[USE CASE 1] 📋 Subscription ID: sub_xxxxx
[USE CASE 1] ✅ Email found: user@example.com
[USE CASE 1] 🆔 Operation ID: payment_cus_xxxxx_sub_xxxxx_1234567890
[USE CASE 1] 🔍 Fetching subscription from Stripe...
[USE CASE 1] ✅ Subscription fetched: { id: 'sub_xxxxx', status: 'active', items_count: 1 }
[USE CASE 1] 🔍 Fetching product metadata for product: prod_SHWZdF20XLXtn9
[USE CASE 1] 🏷️ Product metadata usedfor: dashboard
[USE CASE 1] 📦 Product details: { id: 'prod_xxxxx', name: '...', metadata: { usedfor: 'dashboard' } }
[USE CASE 1] ✅ Product metadata check PASSED - proceeding with processing
[USE CASE 1] 🔍 Fetching user from database for email: user@example.com
[USE CASE 1] 🔑 Generating 1 license key(s)...
[USE CASE 1] 🔑 Generated new license key: CONSENTBIT...
[USE CASE 1] ✅ Generated 1 license key(s) successfully
[USE CASE 1] 💾 Preparing to save 1 license(s) to database
[USE CASE 1] 📋 Licenses to create: [{ site: 'site_1', item_id: 'si_xxxxx', license_key: 'CONSENTBIT...' }]
[USE CASE 1] 📝 License 1: { license_key: 'CONSENTBIT...', site: 'site_1', item_id: 'si_xxxxx', customer_id: 'cus_xxxxx', subscription_id: 'sub_xxxxx' }
[USE CASE 1] 💾 Starting database save operation...
[USE CASE 1] 💾 Database save attempt 1/3
[USE CASE 1] ✅ SUCCESS: 1 license(s) saved to database
[USE CASE 1] 📊 Database save summary: { licenses_saved: 1, customer_id: 'cus_xxxxx', subscription_id: 'sub_xxxxx', purchase_type: 'site', timestamp: 1234567890 }
[USE CASE 1] 💾 Saving user data to database...
[USE CASE 1] 📊 User data summary: { email: 'user@example.com', customers_count: 1, subscriptions_count: 1, sites_count: 1 }
[USE CASE 1] ✅ User data saved to database successfully
[USE CASE 1] 🎉 ========================================
[USE CASE 1] 🎉 USE CASE 1 PROCESSING COMPLETED SUCCESSFULLY
[USE CASE 1] 🎉 ========================================
[USE CASE 1] 📊 Final Summary: { operation_id: '...', email: 'user@example.com', customer_id: 'cus_xxxxx', subscription_id: 'sub_xxxxx', licenses_created: 1, purchase_type: 'site', billing_period: 'monthly', user_saved: true, memberstack_processed: true, failed_operations: 0 }
[USE CASE 1] ✅ All operations completed - returning 'ok' to Stripe
[USE CASE 1] ✅ Returning 'ok' to Stripe webhook
```

---

## Step 3: Verify Database Records

### 3.1 Check Licenses Table

**Query:**
```sql
SELECT * FROM licenses 
WHERE customer_id = 'cus_xxxxx' 
ORDER BY created_at DESC 
LIMIT 10;
```

**Expected:**
- ✅ License record exists
- ✅ `license_key` is populated
- ✅ `customer_id` matches
- ✅ `subscription_id` matches
- ✅ `status` is 'active'
- ✅ `purchase_type` is 'site'
- ✅ `created_at` is recent timestamp

### 3.2 Check Subscriptions Table

**Query:**
```sql
SELECT * FROM subscriptions 
WHERE subscription_id = 'sub_xxxxx';
```

**Expected:**
- ✅ Subscription record exists
- ✅ `user_email` matches customer email
- ✅ `customer_id` matches
- ✅ `status` is 'active' or 'trialing'
- ✅ `billing_period` is set (monthly/yearly)

### 3.3 Check Subscription Items Table

**Query:**
```sql
SELECT * FROM subscription_items 
WHERE subscription_id = 'sub_xxxxx';
```

**Expected:**
- ✅ Subscription item record exists
- ✅ `item_id` matches Stripe subscription item
- ✅ `site_domain` is set (if applicable)
- ✅ `status` is 'active'

### 3.4 Check Users Table

**Query:**
```sql
SELECT * FROM users 
WHERE email = 'user@example.com';
```

**Expected:**
- ✅ User record exists
- ✅ `email` matches
- ✅ `updated_at` is recent

### 3.5 Check Customers Table

**Query:**
```sql
SELECT * FROM customers 
WHERE customer_id = 'cus_xxxxx';
```

**Expected:**
- ✅ Customer record exists
- ✅ `user_email` matches
- ✅ `customer_id` matches Stripe customer

---

## Step 4: Verify Dashboard Updates

### 4.1 Login to Dashboard

1. Go to `https://dashboard.consentbit.com/`
2. Login with the email used for payment
3. Navigate to dashboard

### 4.2 Check Licenses Section

**Expected:**
- ✅ License appears in "Not Assigned" section (or assigned to site)
- ✅ License key is displayed correctly
- ✅ Status shows as "Active"
- ✅ Site domain is shown (if applicable)

### 4.3 Check Dashboard Data

**Expected:**
- ✅ Site count is updated
- ✅ Subscription count is updated
- ✅ License count is updated

### 4.4 Check Profile Section

**Expected:**
- ✅ Invoice appears in invoice history
- ✅ Invoice shows correct amount
- ✅ Invoice shows correct date
- ✅ Download PDF works
- ✅ View online works

---

## Step 5: Verify Stripe Dashboard

### 5.1 Check Payment

1. Stripe Dashboard → **Payments**
2. Find the payment
3. Verify:
   - ✅ Status: Succeeded
   - ✅ Amount: Correct
   - ✅ Customer: Matches

### 5.2 Check Subscription

1. Stripe Dashboard → **Subscriptions**
2. Find the subscription
3. Verify:
   - ✅ Status: Active or Trialing
   - ✅ Customer: Matches
   - ✅ Items: Correct product/price

### 5.3 Check Webhook Events

1. Stripe Dashboard → **Developers** → **Webhooks**
2. Click on your webhook endpoint
3. Check **Recent events**
4. Verify:
   - ✅ `checkout.session.completed` event received
   - ✅ Event shows ✅ (success)
   - ✅ Event timestamp is recent

---

## Step 6: Verify Data Consistency

### 6.1 Cross-Reference Data

**Check:**
- [ ] License in database matches license in dashboard
- [ ] Subscription ID in database matches Stripe subscription
- [ ] Customer ID in database matches Stripe customer
- [ ] Email in database matches payment email
- [ ] Amount in invoice matches payment amount

### 6.2 Verify Relationships

**Check:**
- [ ] License → Subscription relationship is correct
- [ ] Subscription → Customer relationship is correct
- [ ] Customer → User relationship is correct
- [ ] All foreign keys are valid

---

## Troubleshooting

### Issue: Logs show "Skipping - Product usedfor is not dashboard"

**Solution:**
1. Go to Stripe Dashboard → Products
2. Click on your product
3. Add metadata: Key = `usedfor`, Value = `dashboard`
4. Save
5. Retry payment

---

### Issue: Logs show "Database error saving licenses"

**Check:**
1. Database connection is working
2. Database schema is correct
3. Required columns exist

**Solution:**
- Check database schema
- Verify D1 database is bound correctly
- Check for column name mismatches

---

### Issue: License saved but not showing in dashboard

**Check:**
1. Frontend is fetching from correct endpoint
2. API endpoint is returning correct data
3. TanStack Query cache is invalidated

**Solution:**
- Refresh dashboard
- Check browser console for API errors
- Verify API endpoint returns license data

---

### Issue: User data not saving

**Check Logs For:**
```
[USE CASE 1] 💾 Saving user data to database...
[USE CASE 1] ✅ User data saved to database successfully
```

**If Missing:**
- Check database connection
- Verify `saveUserByEmail` function is called
- Check for database errors in logs

---

## Success Criteria

**Everything is working correctly when:**

✅ Payment completes successfully  
✅ Webhook receives event  
✅ Logs show all steps completed  
✅ License is saved to database  
✅ User data is saved to database  
✅ License appears in dashboard  
✅ Invoice appears in profile  
✅ All data is consistent  

---

## Quick Verification Checklist

After completing a test payment:

- [ ] **Webhook Logs:** Show complete processing flow
- [ ] **Database:** License record exists
- [ ] **Database:** Subscription record exists
- [ ] **Database:** User record exists
- [ ] **Dashboard:** License appears
- [ ] **Dashboard:** Invoice appears
- [ ] **Stripe:** Payment recorded
- [ ] **Stripe:** Subscription created
- [ ] **Stripe:** Webhook event succeeded

---

## Next Steps

After verifying Use Case 1 works:

1. **Test Use Case 2** (Site Purchase)
2. **Test Use Case 3** (License Quantity)
3. **Test Multiple Purchases**
4. **Test Renewals**
5. **Monitor Production Logs**

---

## Log Reference

### Key Log Patterns to Look For:

**Start:**
```
[USE CASE 1] 🚀 STARTING USE CASE 1 PROCESSING
```

**Product Check:**
```
[USE CASE 1] ✅ Product metadata check PASSED
```

**License Generation:**
```
[USE CASE 1] ✅ Generated X license key(s) successfully
```

**Database Save:**
```
[USE CASE 1] ✅ SUCCESS: X license(s) saved to database
```

**User Save:**
```
[USE CASE 1] ✅ User data saved to database successfully
```

**Completion:**
```
[USE CASE 1] 🎉 USE CASE 1 PROCESSING COMPLETED SUCCESSFULLY
```

---

**If all logs appear and data is in database/dashboard, Use Case 1 is working correctly! ✅**
