# Setup Checklist - Final Steps

## ✅ Completed
- [x] D1 Database created
- [x] Database schema run locally
- [x] Payment link added to Webflow
- [x] JWT_SECRET set

## ⏳ Remaining Steps

### 1. Set Stripe Secrets (if not done)

**STRIPE_SECRET_KEY:**
```bash
npx wrangler secret put STRIPE_SECRET_KEY
```
Paste your Stripe secret key (from Stripe Dashboard → API Keys)

**STRIPE_WEBHOOK_SECRET:**
```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```
Paste webhook signing secret (after creating webhook)

### 2. Run Database Schema on Remote

```bash
npx wrangler d1 execute consentbit-licenses --file=./schema.sql --remote
```
Type `Y` when prompted.

### 3. Create Stripe Webhook

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **Add endpoint**
3. **Endpoint URL:**
   ```
   https://consentbit-dashboard.web-8fb.workers.dev/webhook
   ```
4. **Events to listen for:**
   - ✅ `checkout.session.completed`
   - ✅ `invoice.payment_succeeded`
5. Copy the **Signing secret** (starts with `whsec_`)
6. Set it: `npx wrangler secret put STRIPE_WEBHOOK_SECRET`

### 4. Configure Payment Link Success URL

In **Stripe Dashboard** → **Payment Links** → Edit your link:

**After payment** → **Redirect to URL:**
```
https://consentbit-dashboard.web-8fb.workers.dev/success.html?email={CHECKOUT_EMAIL}
```

### 5. Deploy Worker

```bash
npx wrangler deploy
```

### 6. Test the Flow

1. Visit: https://consentbit-dashboard-test.webflow.io/
2. Click **Subscribe** button
3. Use test card: `4242 4242 4242 4242`
4. Complete payment
5. Should redirect to success page
6. Magic link should appear

### 7. Verify in Logs

```bash
npx wrangler tail
```

Look for:
- ✅ Payment processed
- ✅ Magic link generated
- ✅ No errors

## 🎯 Quick Command Summary

```bash
# Set secrets
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # After creating webhook

# Run database schema
npx wrangler d1 execute consentbit-licenses --file=./schema.sql --remote

# Deploy
npx wrangler deploy

# Monitor logs
npx wrangler tail
```

## ✅ Final Checklist

- [ ] STRIPE_SECRET_KEY set
- [ ] Webhook created in Stripe
- [ ] STRIPE_WEBHOOK_SECRET set
- [ ] Database schema run on remote
- [ ] Payment Link success URL configured
- [ ] Worker deployed
- [ ] Test payment completed
- [ ] Magic link appears on success page

Once all checked, your workflow is complete! 🎉

