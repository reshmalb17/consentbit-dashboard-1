# Next Steps - Complete Your Payment Flow

## ✅ What You've Done
- [x] Created D1 database
- [x] Added payment link to button
- [x] Webhook handler implemented
- [x] Success page created

## 🔧 What's Next

### Step 1: Configure Stripe Payment Link Success URL

1. Go to **Stripe Dashboard** → **Payment Links**
2. Click on your payment link
3. Edit the link settings
4. Set **After payment** → **Redirect to URL**:
   ```
   https://consentbit-dashboard.web-8fb.workers.dev/success.html?email={CHECKOUT_EMAIL}
   ```
   
   Or if hosting on your own domain:
   ```
   https://yoursite.com/success.html?email={CHECKOUT_EMAIL}
   ```

**Important:** The `{CHECKOUT_EMAIL}` placeholder will automatically include the customer's email.

### Step 2: Set Up Stripe Webhook

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **Add endpoint**
3. **Endpoint URL:**
   ```
   https://consentbit-dashboard.web-8fb.workers.dev/webhook
   ```
4. **Events to listen for:**
   - ✅ `checkout.session.completed` (Required)
   - ✅ `invoice.payment_succeeded` (Required for license generation)
   - ✅ `customer.subscription.updated` (Optional)
5. Click **Add endpoint**
6. Copy the **Signing secret** (starts with `whsec_...`)

### Step 3: Set Webhook Secret

Run this command and paste the signing secret when prompted:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Step 4: Run Database Schema on Remote

```bash
npx wrangler d1 execute consentbit-licenses --file=./schema.sql --remote
```

Type `Y` when prompted.

### Step 5: Deploy Your Worker

```bash
npx wrangler deploy
```

### Step 6: Test the Flow

1. **Click your payment button** → Opens Stripe checkout
2. **Enter test email:** `test@example.com`
3. **Use test card:** `4242 4242 4242 4242`
4. **Complete payment**
5. **You'll be redirected to success page**
6. **Magic link will be displayed** (or check Worker logs)

### Step 7: Check Worker Logs

To see the magic link in logs:

```bash
npx wrangler tail
```

Look for:
```
🎉 PAYMENT SUCCESSFUL - MAGIC LINK
========================================
Email: test@example.com
Magic Link: https://...
========================================
```

## 📋 Quick Checklist

- [ ] Payment Link success URL configured
- [ ] Stripe webhook endpoint added
- [ ] Webhook secret set (`npx wrangler secret put STRIPE_WEBHOOK_SECRET`)
- [ ] Database schema run on remote (`--remote` flag)
- [ ] Worker deployed (`npx wrangler deploy`)
- [ ] Test payment completed
- [ ] Magic link visible in logs or success page

## 🧪 Testing

### Test Payment Flow:
1. Click payment button
2. Use test card: `4242 4242 4242 4242`
3. Complete payment
4. Should redirect to success page
5. Magic link should appear

### Verify Webhook:
1. Go to Stripe Dashboard → Webhooks
2. Click on your webhook endpoint
3. View **Recent events**
4. Look for `checkout.session.completed` event
5. Should show green checkmark (success)

### Check Database:
```bash
npx wrangler d1 execute consentbit-licenses --command "SELECT * FROM payments LIMIT 5;" --remote
```

## 🐛 Troubleshooting

### Magic link not showing?
- Check webhook logs in Stripe Dashboard
- Check Worker logs: `npx wrangler tail`
- Verify webhook secret is set
- Make sure database schema is run

### Payment not processing?
- Verify Payment Link is active
- Check you're using test mode for testing
- Verify success URL is correct

### Database errors?
- Make sure schema is run on remote: `--remote` flag
- Verify database_id in wrangler.jsonc is correct

## 🎯 You're Ready!

Once you complete these steps, your complete flow will work:

**User clicks button → Pays → Webhook processes → Magic link generated → User gets link → Accesses dashboard**

