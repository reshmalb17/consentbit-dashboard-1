# Webflow Success URL Configuration

## Your Webflow Site
**URL:** https://consentbit-dashboard-test.webflow.io/

## Step 1: Configure Stripe Payment Link Success URL

In your **Stripe Dashboard** → **Payment Links** → Edit your payment link:

### Option A: Use Your Worker Domain (Recommended)
```
https://consentbit-dashboard.web-8fb.workers.dev/success.html?email={CHECKOUT_EMAIL}
```

### Option B: Use Your Webflow Domain
If you upload `success.html` to Webflow:
```
https://consentbit-dashboard-test.webflow.io/success.html?email={CHECKOUT_EMAIL}
```

**Important:** The `{CHECKOUT_EMAIL}` placeholder automatically includes the customer's email.

---

## Step 2: Upload success.html to Webflow (Optional)

If you want to host the success page on Webflow:

1. **In Webflow:**
   - Go to your site settings
   - Navigate to **Custom Code** or **Pages**
   - Create a new page: `success.html`
   - Or add the success page content via Custom Code

2. **Or use the Worker domain:**
   - Keep `success.html` on your Worker
   - Point Payment Link to Worker URL (Option A above)

---

## Step 3: Test the Flow

1. **Visit your Webflow site:**
   https://consentbit-dashboard-test.webflow.io/

2. **Click the Subscribe button**
   - Should open Stripe checkout

3. **Complete test payment:**
   - Email: `test@example.com`
   - Card: `4242 4242 4242 4242`
   - Any future expiry, CVC, ZIP

4. **After payment:**
   - You'll be redirected to success page
   - Magic link will be displayed
   - Copy and use to access dashboard

---

## Current Setup Status

✅ Payment link added to Webflow button  
⏳ Success URL needs to be configured in Stripe  
⏳ Webhook needs to be set up  
⏳ Database schema needs to run on remote  
⏳ Worker needs to be deployed  

---

## Quick Configuration

### In Stripe Payment Link Settings:

1. **After payment** → **Redirect to URL**
2. Paste:
   ```
   https://consentbit-dashboard.web-8fb.workers.dev/success.html?email={CHECKOUT_EMAIL}
   ```
3. **Save**

That's it! The `{CHECKOUT_EMAIL}` will automatically be replaced with the customer's email.

---

## Testing Checklist

- [ ] Payment link button works on Webflow site
- [ ] Stripe checkout opens correctly
- [ ] Success URL configured in Payment Link
- [ ] Webhook endpoint set up
- [ ] Test payment completes
- [ ] Redirects to success page
- [ ] Magic link appears on success page

---

## Need Help?

If the success page doesn't load:
1. Check Payment Link settings in Stripe
2. Verify the success URL is correct
3. Check Worker logs: `npx wrangler tail`
4. Make sure Worker is deployed

