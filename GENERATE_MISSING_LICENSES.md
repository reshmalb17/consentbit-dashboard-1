# Generate Missing Licenses - Retroactive License Key Creation

## Overview
This endpoint allows you to retroactively generate license keys for existing purchases/subscriptions that were created before the license generation logic was working properly.

## Endpoint

**POST** `/generate-missing-licenses`

## Request Body

```json
{
  "email": "user@example.com"
}
```

## How It Works

1. **Fetches user record** by email
2. **Gets all subscriptions** for that user
3. **For each subscription:**
   - Fetches subscription details from Stripe
   - Checks existing licenses in database
   - Determines missing licenses based on subscription items
   - Generates missing license keys
   - Saves them to database

## Usage

### Option 1: Call from Browser Console

Open your dashboard, then in browser console:

```javascript
fetch('https://consentbit-dashboard-test.web-8fb.workers.dev/generate-missing-licenses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    email: 'reshma@seattlenewmedia.com'  // Your email
  })
})
.then(r => r.json())
.then(data => console.log('Result:', data));
```

### Option 2: Add Button to Dashboard (Recommended)

Add a button in your dashboard that calls this endpoint. I can help you add this to `dashboard-script.js`.

## Response

### Success Response

```json
{
  "success": true,
  "message": "Generated 1 license key(s)",
  "totalGenerated": 1,
  "results": [
    {
      "subscriptionId": "sub_xxxxx",
      "licensesGenerated": 1,
      "licenseKeys": ["KEY-XXXX-XXXX-XXXX"]
    }
  ]
}
```

### Error Responses

- **400**: Missing email
- **401**: Not authenticated
- **404**: User not found or has no subscriptions

## What It Does

### For Site-Based Purchases:
- Generates **1 license per subscription item**
- Maps each license to the site from:
  - Item metadata
  - User record
  - Sites table
  - Payments table

### For Quantity-Based Purchases:
- Generates licenses based on `quantity` from subscription metadata
- Creates licenses without `site_domain` (they can be assigned later)

## Database Schema Handling

The endpoint handles different database schemas:
- **New schema**: Includes `item_id` and `purchase_type`
- **Old schema**: Falls back to schema without these columns

## After Running

1. **Refresh your dashboard**
2. **Go to License Keys tab**
3. **You should see the newly generated license keys**

## Important Notes

- ✅ **Safe to run multiple times** - won't create duplicates
- ✅ **Only generates missing licenses** - skips if already exists
- ✅ **Handles schema differences** - works with old and new database schemas
- ✅ **Requires authentication** - must be logged in

## Testing

1. Make sure you're logged in to the dashboard
2. Call the endpoint with your email
3. Check the response for generated license keys
4. Refresh the License Keys tab to see them

