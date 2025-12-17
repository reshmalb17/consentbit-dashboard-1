# Quick Start: Payment Link + License Keys

## 🚀 5-Minute Setup

### 1. Create D1 Database

```bash
npx wrangler d1 create consentbit-licenses
```

Copy the `database_id` from output.

### 2. Update wrangler.jsonc

Replace `YOUR_D1_DATABASE_ID` with the ID from step 1:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "consentbit-licenses",
    "database_id": "YOUR_D1_DATABASE_ID_HERE"
  }
]
```

### 3. Create Database Tables

```bash
npx wrangler d1 execute consentbit-licenses --file=./schema.sql
```

### 4. Create Stripe Payment Link

1. Stripe Dashboard → Products → Your Product
2. Click "..." → Create payment link
3. Enable "Allow customers to set quantity"
4. Copy the Payment Link URL

### 5. Configure Webhook

1. Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://consentbit-dashboard.web-8fb.workers.dev/webhook`
3. Select event: `invoice.payment_succeeded`
4. Copy signing secret

### 6. Set Webhook Secret

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# Paste the signing secret
```

### 7. Deploy

```bash
npx wrangler deploy
```

### 8. Add to Webflow

Add this button to your Webflow page:

```html
<a href="YOUR_PAYMENT_LINK_URL" 
   class="w-button" 
   target="_blank">
  Subscribe / Buy License
</a>
```

Replace `YOUR_PAYMENT_LINK_URL` with your Stripe Payment Link.

---

## ✅ Test It

1. Click the button → Opens Stripe checkout
2. Enter email, set quantity (e.g., 3)
3. Use test card: `4242 4242 4242 4242`
4. Complete payment
5. Check logs: `npx wrangler tail`
6. Verify licenses: `npx wrangler d1 execute consentbit-licenses --command "SELECT * FROM licenses"`

---

## 📋 What Happens

1. User clicks button → Opens Payment Link
2. User pays → Stripe creates Customer & Subscription
3. Webhook fires → Worker generates license keys (quantity = number of keys)
4. Keys saved → Stored in D1 database
5. Done! ✅

---

## 🔍 Check Licenses

Query database:
```bash
npx wrangler d1 execute consentbit-licenses --command "SELECT * FROM licenses ORDER BY created_at DESC LIMIT 10"
```

Or use API (requires auth):
```bash
GET https://consentbit-dashboard.web-8fb.workers.dev/licenses
```

---

## 🐛 Troubleshooting

**Webhook not working?**
- Check webhook URL is correct
- Verify `STRIPE_WEBHOOK_SECRET` is set
- Check Stripe webhook logs

**No licenses generated?**
- Check Worker logs: `npx wrangler tail`
- Verify D1 database is set up
- Ensure `invoice.payment_succeeded` event is selected

**Database errors?**
- Verify `database_id` in wrangler.jsonc
- Run schema.sql again
- Check D1 database exists

---

## 📚 Full Documentation

See `PAYMENT_LINK_SETUP.md` for complete guide.

