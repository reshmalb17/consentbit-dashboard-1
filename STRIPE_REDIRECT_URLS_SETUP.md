# Stripe Redirect URLs Setup Guide

**Related:** See **[SETUP_COMPLETE_CHECKLIST.md](./SETUP_COMPLETE_CHECKLIST.md)** for complete setup steps.

## Redirect URLs After Payment

### Success URL (After Successful Payment)
```
https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success
```

### Cancel URL (If Payment is Cancelled)
```
https://dashboard.consentbit.com/dashboard
```

---

## Where to Set These URLs in Stripe

### Option 1: Payment Links (Use Case 1)

**Steps:**

1. Go to **Stripe Dashboard** → **Products**
2. Click on your product (Monthly or Yearly)
3. Click **Payment Links** tab
4. Click **+ Create payment link** (or edit existing link)
5. Scroll to **After payment** section
6. Set:
   - **Success URL:** `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success`
   - **Cancel URL:** `https://dashboard.consentbit.com/dashboard`
7. Click **Create payment link** (or **Save**)

**Important:** 
- Include `{CHECKOUT_SESSION_ID}` in the success URL (Stripe will replace this with the actual session ID)
- The `?payment=success` parameter helps the frontend detect successful payments

---

### Option 2: Checkout Sessions (Use Case 2 & 3)

**Note:** These are set automatically by the code, but you can verify them:

**In Code:**
- Success URL: `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`
- Cancel URL: `${dashboardUrl}`

**Where `dashboardUrl` = `https://dashboard.consentbit.com/dashboard`**

**No manual setup needed** - the code automatically sets these when creating checkout sessions via:
- `/purchase-quantity` endpoint (Use Case 3)
- `/add-sites-batch` endpoint (Use Case 2)
- `/create-site-checkout` endpoint (Use Case 2)

---

## Step-by-Step: Setting Payment Link URLs

### 1. Navigate to Payment Links

1. Log in to **Stripe Dashboard**
2. Go to **Products** (left sidebar)
3. Click on your product (e.g., "ConsentBit Monthly" or "ConsentBit Yearly")
4. Click **Payment Links** tab

### 2. Create or Edit Payment Link

**To Create New:**
- Click **+ Create payment link**

**To Edit Existing:**
- Click on the payment link you want to edit
- Click **Edit** button

### 3. Configure Redirect URLs

Scroll down to **After payment** section:

**Success URL:**
```
https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success
```

**Cancel URL:**
```
https://dashboard.consentbit.com/dashboard
```

### 4. Save

Click **Create payment link** (for new) or **Save** (for existing)

---

## Visual Guide

### Payment Link Settings:

```
┌─────────────────────────────────────────┐
│ Payment Link Settings                   │
├─────────────────────────────────────────┤
│ Product: ConsentBit Monthly             │
│ Price: $8.00/month                      │
│                                         │
│ After payment:                          │
│ ┌─────────────────────────────────────┐ │
│ │ Success URL:                         │ │
│ │ https://dashboard.consentbit.com/    │ │
│ │ dashboard?session_id={CHECKOUT_     │ │
│ │ SESSION_ID}&payment=success         │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ Cancel URL:                          │ │
│ │ https://dashboard.consentbit.com/   │ │
│ │ dashboard                            │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Create payment link]                   │
└─────────────────────────────────────────┘
```

---

## Important Notes

### 1. `{CHECKOUT_SESSION_ID}` Placeholder

- Stripe automatically replaces `{CHECKOUT_SESSION_ID}` with the actual session ID
- This allows the frontend to track which checkout session completed
- **Always include this** in the success URL

### 2. URL Parameters

The success URL includes:
- `session_id={CHECKOUT_SESSION_ID}` - Stripe session ID
- `payment=success` - Flag for frontend to detect successful payment

### 3. Cancel URL

- Simpler URL - just redirects to dashboard
- No parameters needed since payment was cancelled

---

## Testing

### After Setting URLs:

1. **Test Payment Link:**
   - Copy the Payment Link URL
   - Open in browser
   - Complete a test payment
   - Verify redirect to: `https://dashboard.consentbit.com/dashboard?session_id=cs_test_xxxxx&payment=success`

2. **Test Cancel:**
   - Start checkout
   - Click "Cancel" or close window
   - Verify redirect to: `https://dashboard.consentbit.com/dashboard`

---

## Current Configuration

| Setting | Value |
|---------|-------|
| **Base Dashboard URL** | `https://dashboard.consentbit.com/dashboard` |
| **Success URL** | `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success` |
| **Cancel URL** | `https://dashboard.consentbit.com/dashboard` |
| **Environment Variable** | `MEMBERSTACK_REDIRECT_URL` = `https://dashboard.consentbit.com/dashboard` |

---

## Troubleshooting

### Redirect not working:

1. **Check URL Format:**
   - Ensure `{CHECKOUT_SESSION_ID}` is included (with curly braces)
   - No spaces in URL
   - HTTPS protocol (not HTTP)

2. **Check Stripe Settings:**
   - Verify URLs are saved in Payment Link settings
   - Check if Payment Link is active

3. **Check Frontend:**
   - Verify frontend handles `?payment=success` parameter
   - Check browser console for errors

### Wrong redirect URL:

1. **For Payment Links:**
   - Edit Payment Link in Stripe Dashboard
   - Update "After payment" URLs
   - Save changes

2. **For Checkout Sessions (Use Case 2/3):**
   - URLs are set by code automatically
   - Check `MEMBERSTACK_REDIRECT_URL` environment variable
   - Update in `wrangler.jsonc` or via `wrangler secret put`

---

## Quick Reference

### Copy-Paste URLs:

**Success URL:**
```
https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success
```

**Cancel URL:**
```
https://dashboard.consentbit.com/dashboard
```

---

## Summary

### For Payment Links (Manual Setup):
1. Stripe Dashboard → Products → Your Product → Payment Links
2. Create/Edit Payment Link
3. Set Success URL: `https://dashboard.consentbit.com/dashboard?session_id={CHECKOUT_SESSION_ID}&payment=success`
4. Set Cancel URL: `https://dashboard.consentbit.com/dashboard`
5. Save

### For Checkout Sessions (Automatic):
- URLs are set automatically by code
- No manual setup needed
- Uses `MEMBERSTACK_REDIRECT_URL` environment variable
