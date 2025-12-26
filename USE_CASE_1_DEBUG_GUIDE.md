# Use Case 1 Debug Guide

This document explains the debug statements added for Use Case 1 (Initial Payment Through Direct Payment Link) testing.

## Overview

Use Case 1 is the initial payment flow where a user makes their first payment through a Stripe Payment Link. This creates a new subscription, stores all data in the database, and creates a Memberstack member.

## Debug Statements Added

All debug statements are prefixed with `[USE CASE 1]` to make them easy to filter in logs.

### 1. Webhook Received
- **Location**: Start of `checkout.session.completed` handler
- **What it logs**:
  - Event type and ID
  - Timestamp
  - Session ID, Customer ID, Subscription ID
  - Payment link, mode, and payment status

### 1a. Recurring Payment Webhook Received
- **Location**: Start of `invoice.payment_succeeded` handler
- **What it logs**:
  - Event type and ID
  - Timestamp
  - Invoice ID, Customer ID, Subscription ID
  - Invoice amount, currency, and status

### 2. Email Extraction
- **Location**: After extracting session data
- **What it logs**:
  - Initial email from `customer_details`
  - `customer_email` field value
  - Whether email was fetched from customer object
  - Final email used

### 3. Custom Fields Extraction
- **Location**: After extracting custom fields
- **What it logs**:
  - Number of custom fields found
  - Each custom field's key and value
  - Site URL extracted from custom field (if found)

### 4. Subscription Fetch
- **Location**: After fetching subscription from Stripe
- **What it logs**:
  - Subscription status
  - Number of subscription items
  - Subscription metadata

### 5. Metadata Extraction
- **Location**: After extracting subscription metadata
- **What it logs**:
  - Sites extracted from metadata
  - Purchase type and quantity

### 6. User Check
- **Location**: After checking for existing user
- **What it logs**:
  - Whether user exists or is new
  - Existing customer/subscription counts (if user exists)

### 7. Use Case Determination
- **Location**: After checking `addToExisting` flag
- **What it logs**:
  - Whether this is Use Case 1 (new subscription) or Use Case 2/3 (adding to existing)
  - Confirmation of use case type

### 8. Database Operations

#### 8.1 User Save (`saveUserByEmail`)
- **What it logs**:
  - Operation ID
  - User email
  - Each customer being saved
  - Each subscription being saved
  - Each subscription item being saved

#### 8.2 Payment Save (Initial Payment)
- **What it logs**:
  - Sites to save
  - Amount and currency
  - Each payment record being saved
  - Success/failure of payment save

#### 8.2a Recurring Payment Save
- **Location**: `invoice.payment_succeeded` handler
- **What it logs**:
  - Invoice details (ID, amount, currency)
  - Customer email
  - Sites for payment
  - Each recurring payment record being saved
  - Success/failure of recurring payment save

#### 8.3 License Save
- **What it logs**:
  - Number of licenses to create
  - Purchase type
  - Each license's site, item_id, and key
  - Success/failure of license save

### 9. Memberstack Member Creation
- **Location**: Memberstack integration section
- **What it logs**:
  - Whether Memberstack is configured
  - Plan ID and redirect URL
  - Checking for existing member
  - Creating new member (if needed)
  - Member ID and email after creation

### 10. Webhook Summary
- **Location**: End of webhook handler (before returning 'ok')
- **What it logs**:
  - Complete summary of all operations
  - Email, Customer ID, Subscription ID
  - Purchase type, site URL, amount
  - Memberstack member status
  - Number of failed operations

## Database Cleanup Script

A PowerShell script `clear-db-usecase1.ps1` has been created to clear all database tables for fresh testing.

### Usage:
```powershell
.\clear-db-usecase1.ps1
```

### What it does:
1. Checks if `wrangler` CLI is available
2. Shows warning about data deletion
3. Requires confirmation (type 'YES')
4. Executes `clear-all-data-safe.sql` against the remote database
5. Confirms successful cleanup

### Tables Cleared:
- `users`
- `customers`
- `subscriptions`
- `subscription_items`
- `payments`
- `licenses`
- `sites`
- `pending_sites`
- `idempotency_keys`
- `magic_link_tokens`

## Testing Use Case 1

### Step 1: Clear Database
```powershell
.\clear-db-usecase1.ps1
```

### Step 2: Make Payment
1. Use a Stripe Payment Link
2. Enter email and site domain
3. Complete payment

### Step 3: Check Logs
Filter logs for `[USE CASE 1]` to see all debug output:

```bash
wrangler tail --filter "[USE CASE 1]"
```

### Step 4: Verify Database
Check that data was saved correctly:
- User record created
- Customer record created
- Subscription record created
- Subscription items created
- Payment record created (initial payment)
- License record created (if site-based purchase)
- Memberstack member created

### Step 4a: Verify Payment History in Dashboard
After making a payment, check the dashboard:
1. Dashboard should display payment history
2. Initial payment should appear in payment history
3. After recurring payment, it should also appear in payment history
4. Payment history should show:
   - Amount (formatted as dollars)
   - Currency
   - Status (succeeded)
   - Site domain (if applicable)
   - Date (formatted timestamp)

### Step 5: Test Recurring Payments
After initial payment, wait for the next billing cycle or trigger a test invoice:
1. Stripe will send `invoice.payment_succeeded` webhook
2. Check logs for `[USE CASE 1]` recurring payment debug statements
3. Verify recurring payment record is saved to `payments` table
4. Verify payment history shows both initial and recurring payments

## Expected Flow

### Initial Payment (checkout.session.completed)
1. ✅ Webhook received
2. ✅ Email extracted
3. ✅ Custom field (site URL) extracted
4. ✅ Subscription fetched from Stripe
5. ✅ User checked (should be new user)
6. ✅ Use Case 1 confirmed (new subscription)
7. ✅ Site mapped to subscription item
8. ✅ User saved to database
9. ✅ Payment saved to database
10. ✅ License generated and saved
11. ✅ Memberstack member created
12. ✅ Webhook returns 'ok'

### Recurring Payments (invoice.payment_succeeded)
1. ✅ Recurring payment webhook received
2. ✅ Invoice details extracted (ID, amount, currency)
3. ✅ Customer email fetched
4. ✅ Subscription fetched from Stripe
5. ✅ Sites extracted from subscription items
6. ✅ Recurring payment saved to database (one record per site)
7. ✅ Licenses checked/created (if needed)
8. ✅ Webhook returns 'ok'

## Troubleshooting

### No debug output
- Check that webhook is being received
- Verify `checkout.session.completed` event is firing
- Check Cloudflare Workers logs

### Database not saving
- Check `env.DB` is configured
- Verify database bindings in `wrangler.toml`
- Check for database errors in logs

### Memberstack member not created
- Check `MEMBERSTACK_SECRET_KEY` is configured
- Verify API key format (should start with `sk_sb_` or `sk_`)
- Check for Memberstack API errors in logs

### Site URL not found
- Verify custom field key is `enteryourlivedomain`
- Check custom field value in Stripe dashboard
- Check logs for custom field extraction

## Log Filtering

To filter logs for Use Case 1 only:
```bash
# Cloudflare Workers
wrangler tail | grep "USE CASE 1"

# Or view in Cloudflare Dashboard
# Filter by: [USE CASE 1]
```

## Next Steps

After Use Case 1 is working correctly:
1. Test Use Case 2 (Adding site to existing subscription)
2. Test Use Case 3 (Quantity purchase)
3. Remove debug statements or make them conditional based on environment variable

