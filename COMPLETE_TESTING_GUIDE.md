# Complete Testing Guide - Verify Everything Works

## Overview

This guide helps you verify that Memberstack authentication and Stripe payments are working correctly after setup.

---

## Pre-Testing Checklist

Before testing, ensure:

- [ ] Memberstack public key is set in frontend
- [ ] Memberstack secret key is set in backend (if creating members)
- [ ] Stripe secret key is set in backend
- [ ] Stripe webhook secret is set
- [ ] Product metadata `usedfor: dashboard` is added to both products
- [ ] Webhook endpoint is created in Stripe
- [ ] Payment Link URLs are configured correctly

---

## Part 1: Memberstack Authentication Testing

### Test 1.1: Login Flow

**Steps:**
1. Go to `https://dashboard.consentbit.com/`
2. Should see login page
3. Enter email and password (or use Memberstack login)
4. Click "Login"

**Expected Results:**
- ✅ Redirects to `/dashboard`
- ✅ Dashboard loads successfully
- ✅ User email is displayed
- ✅ No authentication errors in console

**Check Console:**
- Look for: `[Memberstack] Login successful`
- No errors related to authentication

---

### Test 1.2: Session Persistence

**Steps:**
1. Login successfully
2. Close browser tab
3. Open new tab
4. Navigate to `https://dashboard.consentbit.com/dashboard`

**Expected Results:**
- ✅ Automatically logged in (no login page shown)
- ✅ Dashboard loads directly
- ✅ Session persists (7 days default)

**Check:**
- Session should last 7 days (check `memberstack.js` - `sessionDurationDays: 7`)

---

### Test 1.3: Logout Flow

**Steps:**
1. Login successfully
2. Go to Profile section
3. Click "Logout" button (top right)

**Expected Results:**
- ✅ Redirects to login page (`/`)
- ✅ Session is cleared
- ✅ Cannot access `/dashboard` without login

**Check Console:**
- Look for: `[Memberstack] Logout successful`
- No errors

---

### Test 1.4: Protected Routes

**Steps:**
1. Logout (or use incognito window)
2. Try to access: `https://dashboard.consentbit.com/dashboard`

**Expected Results:**
- ✅ Redirects to login page (`/`)
- ✅ Cannot access dashboard without authentication

---

### Test 1.5: Member Creation (Use Case 1)

**Steps:**
1. Complete a payment via Payment Link (Use Case 1)
2. Check if Memberstack member is created

**Expected Results:**
- ✅ Member is created in Memberstack (if Use Case 1 webhook handler creates members)
- ✅ Member receives magic link (if configured)

**Check:**
- Memberstack Dashboard → Members
- Verify member exists with correct email

---

## Part 2: Stripe Payment Testing

### Test 2.1: Payment Link (Use Case 1) - Direct Payment

**Steps:**
1. Get Payment Link URL from Stripe Dashboard
2. Open Payment Link in browser
3. Use Stripe test card: `4242 4242 4242 4242`
4. Expiry: `12/34`
5. CVC: `123`
6. Complete payment

**Expected Results:**
- ✅ Payment completes successfully
- ✅ Redirects to: `https://dashboard.consentbit.com/dashboard?session_id=cs_test_xxxxx&payment=success`
- ✅ Dashboard loads
- ✅ Success message appears (if implemented)

**Check Stripe Dashboard:**
- Payments → Verify payment is recorded
- Webhooks → Verify `checkout.session.completed` event received
- Webhook event should show ✅ (success)

**Check Webhook Logs:**
- Look for: `[USE CASE 1] 🏷️ Product metadata usedfor: dashboard`
- Look for: `✅ Identified use case: 1`
- Look for: License creation logs

**Check Dashboard:**
- Licenses section → Verify license key is created
- License should appear in "Not Assigned" section

---

### Test 2.2: License Quantity Purchase (Use Case 3)

**Steps:**
1. Login to dashboard
2. Go to "Bulk Purchase" section
3. Enter quantity (e.g., 5)
4. Select billing period (Monthly/Yearly)
5. Click "Pay Now"
6. Complete payment in Stripe Checkout

**Expected Results:**
- ✅ Checkout opens in new tab
- ✅ Payment completes successfully
- ✅ Redirects to dashboard
- ✅ Progress bar appears showing "X of Y licenses created"
- ✅ All licenses are created successfully
- ✅ Success notification appears

**Check Stripe Dashboard:**
- Payments → Verify payment is recorded
- Subscriptions → Verify subscriptions are created (one per license)
- Webhooks → Verify `checkout.session.completed` event received

**Check Webhook Logs:**
- Look for: `[USE CASE 3]` logs
- Look for: Queue processing logs
- Look for: License generation logs

**Check Dashboard:**
- Licenses section → Verify all licenses are created
- Count should match quantity purchased

---

### Test 2.3: Site Purchase (Use Case 2)

**Steps:**
1. Login to dashboard
2. Go to "Add Domain" section (if visible)
3. Enter site domain(s) (max 5)
4. Select billing period
5. Click "Pay Now"
6. Complete payment in Stripe Checkout

**Expected Results:**
- ✅ Checkout opens in new tab
- ✅ Payment completes successfully
- ✅ Redirects to dashboard
- ✅ Progress bar appears showing "X of Y sites created"
- ✅ All sites are created successfully
- ✅ Licenses are generated for each site

**Check Stripe Dashboard:**
- Payments → Verify payment is recorded
- Subscriptions → Verify subscriptions are created (one per site)
- Webhooks → Verify `checkout.session.completed` event received

**Check Webhook Logs:**
- Look for: `[USE CASE 2]` logs
- Look for: Site queue processing logs
- Look for: License generation logs

**Check Dashboard:**
- Dashboard → Verify sites appear
- Licenses section → Verify licenses are created for each site

---

## Part 3: Webhook Testing

### Test 3.1: Webhook Endpoint Accessibility

**Steps:**
1. Open browser
2. Navigate to: `https://consentbit-dashboard-test.web-8fb.workers.dev/webhook`

**Expected Results:**
- ✅ Returns error (expected - webhook expects POST, not GET)
- ✅ Endpoint is accessible (not 404)

**If 404:**
- Deploy worker: `wrangler deploy --name consentbit-dashboard-test`

---

### Test 3.2: Webhook Event Reception

**Steps:**
1. Complete a test payment
2. Go to Stripe Dashboard → Developers → Webhooks
3. Click on your webhook endpoint
4. Check "Recent events" tab

**Expected Results:**
- ✅ `checkout.session.completed` event appears
- ✅ Event shows ✅ (success) status
- ✅ Event timestamp is recent

**If Event Shows ❌ (Failed):**
- Click on event to see error details
- Check webhook logs in Cloudflare Dashboard
- Verify webhook signing secret is correct

---

### Test 3.3: Webhook Processing

**Steps:**
1. Complete a test payment
2. Check Cloudflare Worker logs

**Expected Results:**
- ✅ Webhook receives event
- ✅ Product metadata check passes: `usedfor: dashboard`
- ✅ Use case is identified correctly
- ✅ Payment is processed
- ✅ License is created

**Check Logs For:**
```
[checkout.session.completed] 🔍 Determining use case
[USE CASE X] 🏷️ Product metadata usedfor: dashboard
[USE CASE X] ✅ Identified use case: X
[USE CASE X] ✅ Processing payment
[USE CASE X] ✅ License created
```

---

### Test 3.4: Subscription Renewal Webhook

**Steps:**
1. Wait for subscription renewal (or manually trigger in Stripe)
2. Check webhook events

**Expected Results:**
- ✅ `customer.subscription.updated` event received
- ✅ `invoice.payment_succeeded` event received
- ✅ Renewal date is updated in database
- ✅ License status remains active

**Check:**
- Stripe Dashboard → Subscriptions → Check renewal date
- Dashboard → Verify license renewal date is updated

---

## Part 4: Product Metadata Testing

### Test 4.1: Product Metadata Check

**Steps:**
1. Complete a test payment
2. Check webhook logs

**Expected Results:**
- ✅ Log shows: `🏷️ Product metadata usedfor: dashboard`
- ✅ Payment is processed (not skipped)

**If Payment is Skipped:**
- Check log: `⏭️ Skipping - Product usedfor is "...", not "dashboard"`
- Verify product metadata is set correctly in Stripe

---

### Test 4.2: Missing Product Metadata

**Steps:**
1. Temporarily remove `usedfor: dashboard` from a product
2. Complete a test payment with that product
3. Check webhook logs

**Expected Results:**
- ✅ Payment completes in Stripe
- ✅ Webhook receives event
- ✅ Webhook skips processing: `⏭️ Skipping - Product usedfor is "...", not "dashboard"`
- ✅ No license is created

**Then:**
- Add metadata back: `usedfor: dashboard`
- Retry payment
- Should work correctly

---

## Part 5: Integration Testing

### Test 5.1: End-to-End Flow (Use Case 1)

**Complete Flow:**
1. User clicks Payment Link
2. Completes payment
3. Redirects to dashboard
4. License is created
5. License appears in dashboard

**Expected Results:**
- ✅ All steps complete successfully
- ✅ No errors in any step
- ✅ User can see license in dashboard

---

### Test 5.2: End-to-End Flow (Use Case 3)

**Complete Flow:**
1. User logs in
2. Purchases 5 licenses
3. Completes payment
4. Progress bar shows "X of 5 licenses created"
5. All licenses are created
6. Success notification appears

**Expected Results:**
- ✅ All steps complete successfully
- ✅ Progress bar updates correctly
- ✅ All 5 licenses are created
- ✅ User can see all licenses in dashboard

---

### Test 5.3: Multiple Purchases

**Steps:**
1. Complete Payment Link purchase (Use Case 1)
2. Complete License Quantity purchase (Use Case 3)
3. Complete Site Purchase (Use Case 2)

**Expected Results:**
- ✅ All purchases work independently
- ✅ All licenses are created correctly
- ✅ No conflicts between use cases
- ✅ Dashboard shows all licenses

---

## Part 6: Error Handling Testing

### Test 6.1: Payment Cancellation

**Steps:**
1. Start checkout process
2. Click "Cancel" or close window

**Expected Results:**
- ✅ Redirects to cancel URL: `https://dashboard.consentbit.com/dashboard`
- ✅ No payment is processed
- ✅ No license is created
- ✅ No errors

---

### Test 6.2: Failed Payment

**Steps:**
1. Use Stripe test card that fails: `4000 0000 0000 0002`
2. Try to complete payment

**Expected Results:**
- ✅ Payment fails (expected)
- ✅ Error message shown in Stripe Checkout
- ✅ No license is created
- ✅ No webhook event for failed payment

---

### Test 6.3: Webhook Failure Recovery

**Steps:**
1. Temporarily break webhook endpoint
2. Complete a payment
3. Fix webhook endpoint
4. Check if Stripe retries

**Expected Results:**
- ✅ Stripe retries webhook (up to 3 times)
- ✅ After fixing, webhook processes successfully
- ✅ License is created on retry

---

## Part 7: Performance Testing

### Test 7.1: Large Quantity Purchase

**Steps:**
1. Purchase 50 licenses (maximum)
2. Monitor processing time

**Expected Results:**
- ✅ Payment completes successfully
- ✅ All 50 licenses are created
- ✅ Processing completes within reasonable time
- ✅ Progress bar updates correctly

**Check:**
- Queue processing logs
- License creation time
- Database performance

---

### Test 7.2: Multiple Concurrent Purchases

**Steps:**
1. Open multiple browser tabs
2. Complete purchases simultaneously

**Expected Results:**
- ✅ All purchases process correctly
- ✅ No conflicts or duplicates
- ✅ All licenses are created

---

## Part 8: Data Verification

### Test 8.1: Database Verification

**After completing payments, verify:**

**Licenses Table:**
- [ ] License keys are unique
- [ ] Customer IDs are correct
- [ ] Subscription IDs are correct
- [ ] Created timestamps are correct
- [ ] Status is 'active'

**Subscriptions Table:**
- [ ] Subscriptions are created
- [ ] Status is correct
- [ ] Billing period is correct
- [ ] Renewal dates are set

**Payments Table:**
- [ ] Payment records are created
- [ ] Amounts are correct
- [ ] Status is 'succeeded'

---

### Test 8.2: Stripe Dashboard Verification

**Check Stripe Dashboard:**

**Payments:**
- [ ] All payments are recorded
- [ ] Amounts match purchases
- [ ] Status is 'succeeded'

**Subscriptions:**
- [ ] Subscriptions are created
- [ ] Status is 'active' or 'trialing'
- [ ] Billing periods are correct
- [ ] Renewal dates are set

**Customers:**
- [ ] Customers are created
- [ ] Email addresses are correct
- [ ] Metadata is set (if applicable)

---

## Part 9: Frontend Testing

### Test 9.1: Dashboard Loading

**Steps:**
1. Login to dashboard
2. Check all sections load

**Expected Results:**
- ✅ Dashboard loads without errors
- ✅ Licenses section loads
- ✅ Profile section loads
- ✅ Data is displayed correctly

**Check Console:**
- No JavaScript errors
- API calls succeed
- Data loads correctly

---

### Test 9.2: License Display

**Steps:**
1. Login to dashboard
2. Go to Licenses section

**Expected Results:**
- ✅ All licenses are displayed
- ✅ License keys are shown correctly
- ✅ Status is displayed
- ✅ Sites are assigned correctly (if applicable)

---

### Test 9.3: Invoice Display

**Steps:**
1. Login to dashboard
2. Go to Profile section
3. Check Invoice History

**Expected Results:**
- ✅ Invoices are displayed
- ✅ Only paid invoices ($0 invoices filtered out)
- ✅ Download PDF works
- ✅ View online works
- ✅ "Load More" works (if more than 10 invoices)

---

## Part 10: Production Readiness

### Test 10.1: Environment Variables

**Verify all environment variables are set:**

```bash
wrangler secret list --name consentbit-dashboard-test
```

**Required:**
- [ ] `STRIPE_SECRET_KEY` (production key: `sk_live_xxxxx`)
- [ ] `STRIPE_WEBHOOK_SECRET`
- [ ] `MEMBERSTACK_SECRET_KEY` (if creating members)

**Optional (have defaults):**
- [ ] `MONTHLY_PRODUCT_ID`
- [ ] `YEARLY_PRODUCT_ID`
- [ ] `MONTHLY_UNIT_AMOUNT`
- [ ] `YEARLY_UNIT_AMOUNT`

---

### Test 10.2: Production Keys

**Before going live:**

- [ ] Switch from test keys to production keys
- [ ] Update webhook endpoint for production
- [ ] Test with production Stripe account
- [ ] Verify production webhook secret is set

---

## Testing Checklist Summary

### Authentication
- [ ] Login works
- [ ] Logout works
- [ ] Session persists
- [ ] Protected routes work

### Payments
- [ ] Payment Link (Use Case 1) works
- [ ] License Quantity (Use Case 3) works
- [ ] Site Purchase (Use Case 2) works
- [ ] Payment cancellation works

### Webhooks
- [ ] Webhook receives events
- [ ] Events process successfully
- [ ] Product metadata check works
- [ ] License creation works

### Data
- [ ] Licenses are created correctly
- [ ] Subscriptions are created correctly
- [ ] Database records are correct
- [ ] Stripe records match database

### Frontend
- [ ] Dashboard loads correctly
- [ ] Licenses display correctly
- [ ] Invoices display correctly
- [ ] No console errors

---

## Common Issues & Solutions

### Issue: Payment succeeds but no license created

**Check:**
1. Product metadata `usedfor: dashboard` is set
2. Webhook is receiving events
3. Webhook logs show processing
4. Database connection is working

**Solution:**
- Add product metadata
- Check webhook endpoint
- Review webhook logs

---

### Issue: Webhook events failing

**Check:**
1. Webhook signing secret is correct
2. Worker is deployed
3. Webhook URL is correct

**Solution:**
- Verify `STRIPE_WEBHOOK_SECRET` matches Stripe Dashboard
- Redeploy worker: `wrangler deploy`
- Verify webhook URL in Stripe

---

### Issue: Authentication not working

**Check:**
1. Memberstack public key is set
2. Memberstack secret key is set (backend)
3. Redirect URLs are correct

**Solution:**
- Verify environment variables
- Check Memberstack Dashboard settings
- Verify redirect URLs

---

## Success Criteria

**Everything is working correctly when:**

✅ All test payments create licenses  
✅ All webhook events process successfully  
✅ Dashboard displays all data correctly  
✅ Authentication works reliably  
✅ No errors in logs  
✅ All use cases work independently  

---

## Next Steps After Testing

1. **Document any issues found**
2. **Fix any failing tests**
3. **Re-test after fixes**
4. **Monitor production logs**
5. **Set up alerts for webhook failures**

---

## Quick Test Commands

```bash
# Check environment variables
wrangler secret list --name consentbit-dashboard-test

# Deploy worker
wrangler deploy --name consentbit-dashboard-test

# View logs (if available)
wrangler tail --name consentbit-dashboard-test
```

---

**Once all tests pass, your system is ready for production! 🎉**
