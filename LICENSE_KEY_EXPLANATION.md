# License Key Generation - Explanation

## What Are License Keys For?

License keys are **unique activation codes** that customers use to activate your software/service on their websites. They serve as:

1. **Proof of Purchase** - Shows the customer has a valid subscription
2. **Activation Code** - Used to unlock features on their site
3. **Access Control** - Validates which sites can use your service
4. **Tracking** - Links each license to a specific subscription and site

## How License Keys Are Generated

### Current Implementation

**Format:** `KEY-XXXX-XXXX-XXXX-XXXX` (e.g., `KEY-ABCD-1234-EFGH-5678`)

**Generation Trigger:**
- License keys are generated when Stripe sends the `invoice.payment_succeeded` webhook
- This happens **after payment is successfully processed**

**Generation Logic:**
```javascript
// One license key per subscription item (site)
// If you have 3 sites → 3 license keys generated
```

### When License Keys Are Created

1. **Initial Payment:**
   - User pays for sites → Stripe processes payment
   - Stripe sends `invoice.payment_succeeded` webhook
   - System generates one license key per subscription item
   - Keys saved to D1 database and KV

2. **Adding New Sites:**
   - User adds site → Pays → New subscription item created
   - Next invoice payment → New license key generated for new site

3. **Removing Sites:**
   - Site removed → Subscription item deleted
   - Existing license keys remain (historical record)
   - No new keys generated

## Why License Keys Might Not Be Generating

### Possible Issues:

1. **Webhook Not Configured**
   - Stripe webhook endpoint not set up
   - `invoice.payment_succeeded` event not enabled
   - Webhook URL not pointing to your Worker

2. **Webhook Not Firing**
   - Payment might be pending
   - Invoice might not be paid yet
   - Webhook might be failing silently

3. **Database Error**
   - D1 database not configured
   - Table not created
   - Insert query failing

4. **Duplicate Prevention**
   - Code checks for existing licenses
   - If licenses already exist, it skips generation
   - This prevents duplicate keys

## How to Check If License Keys Are Being Generated

### 1. Check Worker Logs
```bash
npx wrangler tail
```

Look for:
- `Processing invoice.payment_succeeded`
- `Generated X new license key(s)`
- `Successfully saved X licenses to database`

### 2. Check D1 Database
```bash
npx wrangler d1 execute consentbit-licenses --command "SELECT * FROM licenses ORDER BY created_at DESC LIMIT 10"
```

### 3. Check Stripe Webhooks
- Go to Stripe Dashboard → Developers → Webhooks
- Check if `invoice.payment_succeeded` events are being sent
- Check if webhook deliveries are successful

## Current Code Behavior

**Location:** `src/index.js` lines 614-724

**What It Does:**
1. Listens for `invoice.payment_succeeded` webhook
2. Counts subscription items (sites)
3. Checks for existing licenses
4. Generates missing license keys
5. Saves to D1 database
6. Saves to KV for quick lookup

**Key Logic:**
```javascript
// Generate one license key per subscription item (site)
siteCount = subscription.items.data.length;
licensesNeeded = siteCount - existingLicenses.length;
licenseKeys = generateLicenseKeys(licensesNeeded);
```

## Example Flow

**User has 3 sites:**
- Site 1: tre.com
- Site 2: ewr.in  
- Site 3: new-site.com

**After payment:**
- 3 subscription items created
- `invoice.payment_succeeded` webhook fires
- 3 license keys generated:
  - `KEY-ABCD-1234-EFGH-5678` (for tre.com)
  - `KEY-WXYZ-9012-IJKL-3456` (for ewr.in)
  - `KEY-MNOP-7890-QRST-1234` (for new-site.com)

**Saved to:**
- D1: `licenses` table (3 records)
- KV: `user:{customerId}.licenses` array

## Troubleshooting

### If No License Keys Are Generated:

1. **Check Webhook Configuration:**
   ```
   Stripe Dashboard → Webhooks → Your endpoint
   Events: invoice.payment_succeeded (must be enabled)
   ```

2. **Check Webhook Logs:**
   ```
   Stripe Dashboard → Webhooks → Recent deliveries
   Look for invoice.payment_succeeded events
   Check if they're successful (200 status)
   ```

3. **Check Worker Logs:**
   ```bash
   npx wrangler tail
   ```
   Look for errors or "Processing invoice.payment_succeeded" messages

4. **Check Database:**
   ```bash
   npx wrangler d1 execute consentbit-licenses --command "SELECT COUNT(*) FROM licenses"
   ```

5. **Manually Trigger (for testing):**
   - Use Stripe CLI to send test webhook:
   ```bash
   stripe trigger invoice.payment_succeeded
   ```

## Summary

✅ **License keys ARE being generated** - but only when:
- Payment is successful
- `invoice.payment_succeeded` webhook fires
- Webhook is properly configured in Stripe

❌ **License keys are NOT generated** if:
- Webhook not configured
- Payment not completed
- Webhook failing
- Database errors

**To verify:** Check Stripe webhook logs and Worker logs to see if the webhook is firing and processing correctly.

