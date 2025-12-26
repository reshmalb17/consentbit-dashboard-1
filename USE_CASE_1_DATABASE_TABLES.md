# Use Case 1 - Database Tables Data Storage

This document lists all database tables that receive data when processing a direct payment link (Use Case 1) through the `checkout.session.completed` webhook.

## Tables That Receive Data

### 1. **users** ✅
**When:** Always (for every payment)
**What:** User email and timestamps
**Primary Key:** `id` (auto-increment integer)
**Unique Constraint:** `email` (email address must be unique)

**Fields:**
- `id` - Primary key (auto-increment integer)
- `email` - User's email address (normalized to lowercase, UNIQUE, NOT NULL)
- `created_at` - Unix timestamp when user was first created
- `updated_at` - Unix timestamp when user was last updated

**Operation:** `INSERT OR IGNORE` (creates if doesn't exist) + `UPDATE` (updates timestamp)

---

### 2. **customers** ✅
**When:** Always (for every payment)
**What:** Stripe customer ID linked to user email
**Primary Key:** `id` (auto-increment integer)
**Unique Constraint:** `(user_email, customer_id)` - combination must be unique
**Foreign Key:** `user_email` references `users.email`

**Fields:**
- `id` - Primary key (auto-increment integer)
- `user_email` - User's email (foreign key to users table, NOT NULL)
- `customer_id` - Stripe customer ID (e.g., `cus_xxx`, NOT NULL)
- `created_at` - Unix timestamp when customer was first created
- `updated_at` - Unix timestamp when customer was last updated

**Operation:** `INSERT OR IGNORE` (creates if doesn't exist)

**Note:** One user can have multiple customer IDs (unique combination of user_email + customer_id)

---

### 3. **subscriptions** ✅
**When:** Always (for every payment)
**What:** Stripe subscription details
**Fields:**
- `user_email` - User's email (foreign key to users table)
- `customer_id` - Stripe customer ID
- `subscription_id` - Stripe subscription ID (e.g., `sub_xxx`)
- `status` - Subscription status (e.g., 'active', 'trialing')
- `cancel_at_period_end` - Boolean (0 or 1) - whether subscription will cancel at period end
- `cancel_at` - Unix timestamp when subscription was canceled (null if active)
- `current_period_start` - Unix timestamp of current billing period start
- `current_period_end` - Unix timestamp of current billing period end
- `billing_period` - Billing frequency: 'monthly', 'yearly', 'weekly', 'daily' (optional column)
- `created_at` - Unix timestamp when subscription was first created
- `updated_at` - Unix timestamp when subscription was last updated

**Operation:** `INSERT OR REPLACE` (creates new or updates existing)

**Note:** If `billing_period` column doesn't exist in schema, it will save without it (graceful fallback)

---

### 4. **subscription_items** ✅
**When:** Always (for every payment)
**What:** Individual items within a subscription (one per site)
**Primary Key:** `id` (auto-increment integer)
**Unique Constraint:** `item_id` (Stripe subscription item ID must be unique)
**Foreign Key:** `subscription_id` references `subscriptions.subscription_id`

**Fields:**
- `id` - Primary key (auto-increment integer)
- `subscription_id` - Stripe subscription ID (foreign key to subscriptions table, NOT NULL)
- `item_id` - Stripe subscription item ID (e.g., `si_xxx`) - UNIQUE constraint
- `site_domain` - Site domain/URL (e.g., 'www.example.com')
- `price_id` - Stripe price ID (e.g., `price_xxx`)
- `quantity` - Quantity of items (usually 1 for site-based purchases)
- `status` - Item status (e.g., 'active')
- `created_at` - Unix timestamp when item was first created
- `updated_at` - Unix timestamp when item was last updated
- `removed_at` - Unix timestamp when item was removed (null if active)

**Operation:** `INSERT OR REPLACE` (creates new or updates existing)

**Note:** 
- One record per subscription item (one per site)
- Multiple items can share the same `subscription_id` (one subscription can have multiple items)
- `item_id` is unique across all records

---

### 5. **payments** ✅
**When:** Always (for every payment)
**What:** Payment transaction records
**Primary Key:** `id` (auto-increment integer)

**Fields:**
- `id` - Primary key (auto-increment integer)
- `customer_id` - Stripe customer ID (NOT NULL)
- `subscription_id` - Stripe subscription ID (NOT NULL)
- `email` - User's email address (NOT NULL)
- `amount` - Payment amount in cents (e.g., 2000 = $20.00, NOT NULL)
- `currency` - Currency code (e.g., 'usd', NOT NULL, default 'usd')
- `status` - Payment status (e.g., 'succeeded', NOT NULL, default 'succeeded')
- `site_domain` - Site domain for this payment (null for quantity purchases)
- `magic_link` - Not used (null) - Memberstack handles authentication
- `magic_link_generated` - Not used (0/false, default 0)
- `created_at` - Unix timestamp when payment was created (NOT NULL)
- `updated_at` - Unix timestamp when payment was last updated (NOT NULL)

**Operation:** `INSERT` (one record per site, or one record for quantity purchases)

**Note:** 
- For site-based purchases: One payment record per site
- For quantity purchases: One payment record (no site_domain)
- Multiple payments can share the same `subscription_id` (recurring payments)

---

### 6. **licenses** ✅
**When:** Always (for every payment)
**What:** License keys generated for sites or quantity purchases
**Primary Key:** `license_key` (TEXT - the license key itself is the primary key)

**Fields:**
- `license_key` - Unique license key (PRIMARY KEY, TEXT, NOT NULL)
- `customer_id` - Stripe customer ID (NOT NULL)
- `subscription_id` - Stripe subscription ID
- `item_id` - Stripe subscription item ID (maps to subscription_items)
- `site_domain` - Site domain for site-based purchases (null for quantity purchases)
- `used_site_domain` - Site where license is actually activated (same as site_domain for site purchases, null for quantity purchases until activated)
- `status` - License status (e.g., 'active', 'inactive', NOT NULL, default 'active')
- `purchase_type` - Purchase type: 'site' or 'quantity' (default 'site')
- `created_at` - Unix timestamp when license was created (NOT NULL)
- `updated_at` - Unix timestamp when license was last updated (NOT NULL)

**Operation:** `INSERT` (batch insert for multiple licenses)

**Note:** 
- For site-based purchases: One license per site
- For quantity purchases: One license per quantity purchased
- `license_key` is the primary key (must be unique)

---

### 7. **sites** ✅
**When:** For site-based purchases (not quantity purchases)
**What:** Detailed site information including billing periods and amounts
**Primary Key:** `id` (auto-increment integer)

**Fields:**
- `id` - Primary key (auto-increment integer)
- `customer_id` - Stripe customer ID (NOT NULL)
- `subscription_id` - Stripe subscription ID (NOT NULL)
- `item_id` - Stripe subscription item ID
- `site_domain` - Site domain/URL (NOT NULL)
- `price_id` - Stripe price ID
- `amount_paid` - Amount paid in cents (NOT NULL)
- `currency` - Currency code (e.g., 'usd', NOT NULL, default 'usd')
- `status` - Site status (e.g., 'active', NOT NULL, default 'active')
- `current_period_start` - Unix timestamp of current billing period start
- `current_period_end` - Unix timestamp of current billing period end
- `renewal_date` - Unix timestamp of next renewal date
- `cancel_at_period_end` - Boolean (0 or 1) - whether subscription will cancel at period end (default 0)
- `canceled_at` - Unix timestamp when site was canceled (null if active)
- `created_at` - Unix timestamp when site was first created (NOT NULL)
- `updated_at` - Unix timestamp when site was last updated (NOT NULL)

**Operation:** `INSERT` or `UPDATE` (via `saveOrUpdateSiteInDB` function)

**Note:** 
- Only for site-based purchases, not quantity purchases
- Multiple sites can share the same `subscription_id` (one subscription can have multiple sites)

---

### 8. **pending_sites** ⚠️ (May be deleted)
**When:** If user had pending sites that were just paid for
**What:** Sites that were pending payment (removed after successful payment)
**Fields:**
- `user_email` - User's email
- `subscription_id` - Stripe subscription ID (may be null)
- `site_domain` - Site domain
- `price_id` - Stripe price ID
- `quantity` - Quantity
- `created_at` - Unix timestamp when pending site was created

**Operation:** `DELETE` (removes pending sites that were successfully paid for)

**Note:** This table is cleaned up - pending sites are removed after payment succeeds

---

## Tables That Do NOT Receive Data (Use Case 1)

### **idempotency_keys** ❌
**Why:** Only used for idempotency in other operations (like remove-site), not for initial payments

### **magic_link_tokens** ❌
**Why:** Not used - Memberstack handles authentication via passwordless login

---

## Data Flow Summary

```
Direct Payment Link Payment
  ↓
checkout.session.completed webhook
  ↓
1. users table          → INSERT/UPDATE user email
2. customers table      → INSERT customer_id linked to user_email
3. subscriptions table  → INSERT/REPLACE subscription details
4. subscription_items   → INSERT/REPLACE one record per site/item
5. payments table       → INSERT one record per site (or one for quantity)
6. licenses table       → INSERT one license per site (or per quantity)
7. sites table          → INSERT/UPDATE site details (site purchases only)
8. pending_sites table  → DELETE pending sites that were paid for
```

## Example: Single Site Payment

If a user pays $20/month for `www.example.com`:

1. **users**: 1 record (user email)
2. **customers**: 1 record (customer_id)
3. **subscriptions**: 1 record (subscription_id)
4. **subscription_items**: 1 record (one item for www.example.com)
5. **payments**: 1 record ($20 payment for www.example.com)
6. **licenses**: 1 record (license key for www.example.com)
7. **sites**: 1 record (site details for www.example.com)
8. **pending_sites**: 0 records (deleted if existed)

## Example: Multiple Sites Payment

If a user pays $40/month for 2 sites (`www.site1.com` and `www.site2.com`):

1. **users**: 1 record
2. **customers**: 1 record
3. **subscriptions**: 1 record
4. **subscription_items**: 2 records (one per site)
5. **payments**: 2 records (one per site, $20 each)
6. **licenses**: 2 records (one license per site)
7. **sites**: 2 records (one per site)
8. **pending_sites**: 0 records (deleted if existed)

## Example: Quantity Purchase

If a user pays $50/month for 5 licenses (no specific sites):

1. **users**: 1 record
2. **customers**: 1 record
3. **subscriptions**: 1 record
4. **subscription_items**: 1 record (quantity = 5)
5. **payments**: 1 record ($50 payment, site_domain = null)
6. **licenses**: 5 records (5 license keys, site_domain = null)
7. **sites**: 0 records (not created for quantity purchases)
8. **pending_sites**: 0 records

---

## Database Operations Order

The data is saved in this order:

1. **User/Customer/Subscription structure** (via `saveUserByEmail`)
   - users
   - customers
   - subscriptions
   - subscription_items

2. **Payment records** (via direct INSERT)
   - payments

3. **User record update** (via `saveUserByEmail` again)
   - Updates users, customers, subscriptions, subscription_items

4. **License generation** (via batch INSERT)
   - licenses

5. **Site details** (via `saveOrUpdateSiteInDB`)
   - sites

6. **Pending sites cleanup** (via DELETE)
   - pending_sites

---

## Important Notes

1. **User email may already exist**: If the user already has a subscription, the new subscription is added alongside the existing one. Both subscriptions are stored.

2. **Direct payment link detection**: If `paymentby === 'directlink'` in metadata, the system always creates a new subscription (doesn't add to existing).

3. **Billing period**: Extracted from Stripe price's `recurring.interval` and saved to `subscriptions.billing_period` if the column exists.

4. **Retry logic**: Payment and license saves have retry logic (3 attempts with exponential backoff) to handle transient database errors.

5. **Transaction safety**: All operations are designed to be idempotent - if a webhook is retried, it won't create duplicate records.

