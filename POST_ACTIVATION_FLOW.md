# What Happens After License Activation

## Overview
After a successful license activation, the system performs several backend operations and frontend updates to reflect the new state.

---

## Backend Operations (Server-Side)

### 1. ✅ License Table Update
**Table:** `licenses`
**Action:** Updates the license record with the site domain

```sql
UPDATE licenses 
SET used_site_domain = 'dashboard-test-e630c7', 
    updated_at = 1766742763 
WHERE license_key = 'KEY-75FX-EYCC-3FHR-67CS'
```

**Result:**
- `used_site_domain` is set to the provided domain
- `updated_at` timestamp is updated
- License status remains `'active'` (status doesn't change to 'used' in database, but frontend treats it as used)

---

### 2. ✅ Sites Table Update/Create
**Table:** `sites`
**Action:** Creates a new site entry or updates existing one

**If site doesn't exist (new activation):**
```sql
INSERT INTO sites (
    customer_id, 
    subscription_id, 
    site_domain, 
    price_id, 
    amount_paid, 
    currency, 
    status, 
    renewal_date, 
    created_at, 
    updated_at
) VALUES (
    'cus_TfKmd04i90EWia',
    'sub_1SiMaRSAczuHLTOtoll64Ojs',
    'dashboard-test-e630c7',
    NULL,  -- May be NULL if price_id column doesn't exist
    0,     -- May be 0 if price fetch fails
    'usd',
    'active',
    1767304777,  -- current_period_end from subscription
    1766742763,
    1766742763
)
```

**If site already exists (update):**
```sql
UPDATE sites 
SET status = 'active', 
    updated_at = 1766742763, 
    renewal_date = 1767304777 
WHERE customer_id = 'cus_TfKmd04i90EWia' 
  AND site_domain = 'dashboard-test-e630c7'
```

**Result:**
- Site is linked to the customer and subscription
- Site status is set to `'active'`
- Renewal date is set from subscription's `current_period_end`

**Note:** There's a warning in your logs about `price_id` column not existing. This is non-critical - the site is still created successfully.

---

### 3. ✅ User Object Update (KV Store)
**Storage:** Cloudflare KV (if available)
**Action:** Updates the user's sites object

```javascript
user.sites['dashboard-test-e630c7'] = {
    subscriptionId: 'sub_1SiMaRSAczuHLTOtoll64Ojs',
    site: 'dashboard-test-e630c7',
    status: 'active',
    licenseKey: 'KEY-75FX-EYCC-3FHR-67CS',
    updatedAt: 1766742763
}
```

**Result:**
- Site is added to user's sites object in KV
- This allows quick lookup of user's sites without querying the database

---

### 4. ✅ API Response Sent
**Status Code:** `200 OK`

**Response Body:**
```json
{
  "success": true,
  "message": "License activated successfully",
  "license_key": "KEY-75FX-EYCC-3FHR-67CS",
  "site_domain": "dashboard-test-e630c7",
  "previous_site": null,
  "status": "used",
  "is_used": true,
  "was_update": false
}
```

**For Updates (when `used_site_domain` was already set):**
```json
{
  "success": true,
  "message": "License site updated successfully from old-site.com to dashboard-test-e630c7",
  "license_key": "KEY-75FX-EYCC-3FHR-67CS",
  "site_domain": "dashboard-test-e630c7",
  "previous_site": "old-site.com",
  "status": "used",
  "is_used": true,
  "was_update": true
}
```

---

## Frontend Operations (Client-Side)

### 1. ✅ Success Message Display
**Action:** Shows a success notification to the user

```javascript
showSuccess("License activated successfully for dashboard-test-e630c7")
```

**UI:** Green success banner appears at the top of the page

---

### 2. ✅ License List Reload
**Action:** Fetches updated license data from the server

```javascript
await loadLicenseKeys(currentUserEmail)
```

**API Call:**
```
GET /licenses?email=user@example.com
```

**What Gets Updated:**
- License status display
- Site domain display
- Button states (Activate → Update Site)
- Copy button visibility

---

### 3. ✅ UI Updates

#### License Card Changes:

**Before Activation:**
```html
<div class="license-card">
  <div>License Key: KEY-75FX-EYCC-3FHR-67CS</div>
  <div>Status: Inactive</div>
  <div>Site: Not assigned</div>
  <button class="activate-license-button" style="background: #4caf50;">
    Activate
  </button>
  <button class="copy-license-button">Copy</button>
</div>
```

**After Activation:**
```html
<div class="license-card">
  <div>License Key: KEY-75FX-EYCC-3FHR-67CS</div>
  <div>Status: Used</div>
  <div>Site: dashboard-test-e630c7</div>
  <button class="activate-license-button" style="background: #ff9800;">
    Update Site
  </button>
  <button class="copy-license-button">Copy</button>
</div>
```

#### Visual Changes:
1. **Status Badge:**
   - Changes from "Inactive" to "Used"
   - Color may change to indicate active usage

2. **Site Domain Display:**
   - Shows the activated site domain: `dashboard-test-e630c7`
   - Previously showed "Not assigned" or was empty

3. **Activate Button:**
   - **Text:** Changes from "Activate" to "Update Site"
   - **Color:** Changes from green (`#4caf50`) to orange (`#ff9800`)
   - **Functionality:** Still allows updating the site domain if needed

4. **Copy Button:**
   - **Remains visible** (not disabled)
   - Still allows copying the license key

5. **Deactivate Button:**
   - May appear if the license is part of a quantity purchase
   - Allows canceling the subscription for this specific license

---

## Database State After Activation

### `licenses` Table
```sql
license_key: 'KEY-75FX-EYCC-3FHR-67CS'
used_site_domain: 'dashboard-test-e630c7'  -- ✅ NEW
status: 'active'  -- (unchanged)
updated_at: 1766742763  -- ✅ UPDATED
```

### `sites` Table
```sql
customer_id: 'cus_TfKmd04i90EWia'
subscription_id: 'sub_1SiMaRSAczuHLTOtoll64Ojs'
site_domain: 'dashboard-test-e630c7'  -- ✅ NEW ENTRY
status: 'active'
renewal_date: 1767304777
created_at: 1766742763
updated_at: 1766742763
```

### User KV Object
```json
{
  "email": "user@example.com",
  "sites": {
    "dashboard-test-e630c7": {
      "subscriptionId": "sub_1SiMaRSAczuHLTOtoll64Ojs",
      "site": "dashboard-test-e630c7",
      "status": "active",
      "licenseKey": "KEY-75FX-EYCC-3FHR-67CS",
      "updatedAt": 1766742763
    }
  }
}
```

---

## What Users See

### Immediate Feedback
1. ✅ **Success Message:** "License activated successfully for dashboard-test-e630c7"
2. ✅ **Button State:** Button changes to "Update Site" (orange)
3. ✅ **Site Display:** Site domain appears in the license card

### After Page Reload/Refresh
1. ✅ **Persistent State:** All changes are saved and persist
2. ✅ **License Status:** Shows as "Used"
3. ✅ **Site Domain:** Displays the activated domain
4. ✅ **Dashboard Sites Tab:** New site appears in the sites list

---

## Error Handling

### If Activation Fails:
1. ❌ **Error Message:** Shows specific error (e.g., "License key not found")
2. ❌ **Button Reset:** Button returns to original state ("Activate")
3. ❌ **No Database Changes:** No updates are made to licenses or sites tables
4. ❌ **No UI Changes:** License card remains unchanged

### Common Errors:
- `license_not_found`: License key doesn't exist
- `subscription_ended`: Subscription has expired
- `subscription_cancelled`: Subscription was cancelled
- `subscription_inactive`: Subscription is not active/trialing
- `unauthorized`: License doesn't belong to user

---

## Summary Flow Diagram

```
User clicks "Activate"
    ↓
Enter site domain: "dashboard-test-e630c7"
    ↓
Frontend sends POST /activate-license
    ↓
Backend validates license & subscription
    ↓
✅ Update licenses.used_site_domain
    ↓
✅ Create/Update sites table entry
    ↓
✅ Update user KV object
    ↓
✅ Return success response
    ↓
Frontend shows success message
    ↓
Frontend reloads license list
    ↓
UI updates:
  - Status: "Used"
  - Site: "dashboard-test-e630c7"
  - Button: "Update Site" (orange)
  - Copy button: Still visible
```

---

## Next Steps After Activation

1. **Use License Key in App:**
   - Copy the license key
   - Paste it into your application
   - Application validates the key with your backend

2. **Update Site Domain:**
   - Click "Update Site" button
   - Enter new domain
   - Site domain is updated in database

3. **Cancel License:**
   - Click "Deactivate" button (if available)
   - Subscription is cancelled at period end
   - License becomes inactive

4. **View in Dashboard:**
   - Site appears in "Sites" tab
   - Shows subscription details
   - Shows renewal date

---

## Notes

- ⚠️ **Warning in Logs:** The `price_id` column warning is non-critical. The site is still created successfully.
- ✅ **Idempotency:** Activating the same license multiple times with different domains updates the site domain (doesn't create duplicates)
- ✅ **Status Field:** The database `status` field remains `'active'`, but the frontend treats licenses with `used_site_domain` as "used"
- ✅ **Copy Button:** Always remains visible and functional, even after activation
- ✅ **Update Capability:** Users can update the site domain at any time using the "Update Site" button

