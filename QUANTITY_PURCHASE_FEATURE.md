# Quantity-Based License Purchase Feature

## Overview
This feature allows users to purchase license keys in bulk by specifying a quantity, without needing to enter individual site names. Each purchased quantity generates a unique license key that can later be assigned to any site.

## Features

### 1. **Quantity Purchase Interface**
- New sidebar item: "🔑 License Keys"
- Purchase form with quantity input
- Each quantity generates one license key
- License keys are generated immediately after successful payment

### 2. **License Key Management**
- License keys are stored with `license_key` as the primary key
- Each license key tracks:
  - `used_site_domain`: Site where the license is currently used (null if unused)
  - `purchase_type`: 'quantity' or 'site'
  - `status`: 'active' or 'inactive'
  - `customer_id`, `subscription_id`, `item_id`

### 3. **License Activation**
- Endpoint: `/activate-license`
- Associates a license key with a specific site
- Validates that license key belongs to the user
- Prevents duplicate usage (one license per site)

### 4. **Dashboard Display**
- Shows all license keys in a table
- Displays:
  - License key (copyable)
  - Status (Available/Used)
  - Used For Site (if assigned)
  - Purchase Type (Quantity Purchase/Site Purchase)
  - Created date
- Copy button for easy license key sharing

## Database Schema

### Updated `licenses` Table
```sql
CREATE TABLE licenses (
  license_key TEXT PRIMARY KEY,        -- Primary key (was id before)
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  item_id TEXT,
  site_domain TEXT,                    -- Original site (for site purchases)
  used_site_domain TEXT,               -- Site where license is used/activated
  status TEXT NOT NULL DEFAULT 'active',
  purchase_type TEXT DEFAULT 'site',   -- 'site' or 'quantity'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## API Endpoints

### 1. `POST /purchase-quantity`
**Purpose:** Create checkout session for quantity-based purchase

**Request:**
```json
{
  "email": "user@example.com",
  "quantity": 5
}
```

**Response:**
```json
{
  "checkout_url": "https://checkout.stripe.com/...",
  "session_id": "cs_..."
}
```

### 2. `POST /activate-license`
**Purpose:** Associate a license key with a site

**Request:**
```json
{
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.example.com",
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "License activated successfully",
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.example.com"
}
```

### 3. `GET /licenses`
**Updated to include:**
- `used_site_domain`: Site where license is used
- `purchase_type`: 'quantity' or 'site'

## Workflow

### Quantity Purchase Flow
1. User enters quantity (e.g., 5)
2. Clicks "Purchase Now"
3. System creates Stripe checkout session with:
   - `subscription_data[metadata][purchase_type]`: 'quantity'
   - `subscription_data[metadata][quantity]`: '5'
   - Quantity set on line item
4. User completes payment
5. Webhook `checkout.session.completed` fires
6. System generates 5 license keys (without `site_domain`)
7. License keys stored with `purchase_type: 'quantity'`
8. User sees license keys in dashboard

### License Activation Flow
1. User has unused license key
2. User calls `/activate-license` with license key and site domain
3. System validates:
   - License key exists
   - License key belongs to user
   - License key is not already used
   - License key is active
4. System updates `used_site_domain`
5. License key is now associated with the site

## Migration

To update existing database:

1. Run `migrate-licenses-schema.sql` to:
   - Create new table structure
   - Migrate existing data
   - Update indexes

2. Existing licenses will have:
   - `purchase_type`: 'site' (default)
   - `used_site_domain`: null (can be set later)

## Frontend Changes

### New Sidebar Section
- Added "🔑 License Keys" menu item
- Shows purchase form and license list

### License Display
- Table format with all license details
- Copy button for easy sharing
- Status badges (Available/Used)
- Shows which site each license is used for

## Backend Changes

### Webhook Handler Updates
- Detects `purchase_type: 'quantity'` from subscription metadata
- Generates multiple license keys based on quantity
- Stores licenses without `site_domain` for quantity purchases
- Stores licenses with `site_domain` for site purchases

### License Generation Logic
```javascript
if (purchaseType === 'quantity') {
  // Generate quantity licenses without site_domain
  // They will be assigned later via /activate-license
} else {
  // Generate one license per site (existing behavior)
}
```

## Testing Checklist

- [ ] Purchase quantity of 1
- [ ] Purchase quantity of 5
- [ ] Verify license keys are generated correctly
- [ ] Activate license key with site
- [ ] Try to activate already-used license (should fail)
- [ ] Try to activate license from different user (should fail)
- [ ] Display license keys in dashboard
- [ ] Copy license key functionality
- [ ] Verify license keys persist after page refresh

## Notes

- License keys are unique and cannot be duplicated
- Each license key can only be used for one site
- License keys purchased via quantity can be assigned to any site
- License keys purchased via site are pre-assigned to that site
- The `used_site_domain` field tracks where quantity-purchased licenses are actually used

