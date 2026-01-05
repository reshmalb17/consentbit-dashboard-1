# Direct Payment Link Metadata Guide

This guide explains what metadata you need to add to Stripe Payment Links for direct payment processing (Use Case 1).

---

## 🎯 Quick Answer

For **direct payment links**, you need to add this metadata in **Stripe Dashboard**:

### Required Metadata:
- ✅ `paymentby: 'directlink'` - Identifies this as a direct payment link

### Optional Metadata:
- ⚪ `usecase: '1'` - Explicitly marks as Use Case 1 (optional, defaults to Use Case 1 if not set)

---

## 📋 Where to Add Metadata

### Option 1: Payment Link Metadata (Recommended)

**Location:** Stripe Dashboard → Products → Payment Links → Your Payment Link → Settings → Metadata

**Steps:**
1. Go to Stripe Dashboard
2. Navigate to **Products** → **Payment Links**
3. Click on your payment link
4. Go to **Settings** tab
5. Scroll to **Metadata** section
6. Click **Add metadata**
7. Add the following:

| Key | Value | Description |
|-----|-------|-------------|
| `paymentby` | `directlink` | Identifies this as a direct payment link |
| `usecase` | `1` | (Optional) Explicitly marks as Use Case 1 |

**Example:**
```
Key: paymentby
Value: directlink

Key: usecase
Value: 1
```

### Option 2: Checkout Session Metadata (If creating via API)

If you're creating checkout sessions programmatically, add metadata like this:

```javascript
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_xxxxx', quantity: 1 }],
  metadata: {
    paymentby: 'directlink',
    usecase: '1'  // Optional
  },
  subscription_data: {
    metadata: {
      paymentby: 'directlink',
      usecase: '1'  // Optional
    }
  }
});
```

---

## 🔍 How Metadata is Used

### Metadata Check Order

The code checks metadata in this order:

1. **`session.metadata`** - From payment link/checkout session
2. **`subscription.metadata`** - From subscription object
3. **`session.subscription_data.metadata`** - From subscription data in session

### Code Logic

```javascript
// Check session.metadata FIRST (payment link metadata flows here)
if (session && session.metadata) {
  if (session.metadata.paymentby) {
    paymentBy = session.metadata.paymentby;
  }
}

// If paymentby is 'directlink', force new subscription creation
if (paymentBy && paymentBy.toLowerCase() === 'directlink') {
  isDirectLink = true;
  addToExisting = false;
  existingSubscriptionId = null;
  purchaseType = 'site';  // Direct links collect site domain via custom field
}
```

---

## ✅ Required Metadata Fields

### 1. `paymentby: 'directlink'`

**Purpose:** Identifies the payment as coming from a direct payment link

**Effect:**
- Forces creation of a **new subscription** (Use Case 1)
- Prevents adding to existing subscription
- Sets `purchaseType` to `'site'`

**Where to add:** Payment Link → Settings → Metadata

**Example:**
```
Key: paymentby
Value: directlink
```

---

## ⚪ Optional Metadata Fields

### 2. `usecase: '1'`

**Purpose:** Explicitly marks this as Use Case 1 (direct payment link)

**Effect:**
- Makes it clear this is Use Case 1
- Helps with debugging and logging

**Note:** If not set, the system defaults to Use Case 1 when `paymentby: 'directlink'` is present

**Where to add:** Payment Link → Settings → Metadata

**Example:**
```
Key: usecase
Value: 1
```

---

## 🚫 What NOT to Add

### Don't Add These (For Direct Payment Links):

- ❌ `add_to_existing: 'true'` - This would try to add to existing subscription
- ❌ `existing_subscription_id: 'sub_xxxxx'` - This would target a specific subscription
- ❌ `usecase: '2'` or `usecase: '3'` - These are for other use cases

**Why:** Direct payment links should always create **new subscriptions**, not add to existing ones.

---

## 📝 Complete Metadata Example

### For Direct Payment Link (Use Case 1):

**In Stripe Dashboard → Payment Link → Metadata:**

```
Metadata:
├─ paymentby: directlink
└─ usecase: 1
```

**Result:**
- ✅ Creates new subscription
- ✅ Generates license keys
- ✅ Processes as Use Case 1
- ✅ Collects site domain from custom field

---

## 🔄 Comparison with Other Use Cases

| Use Case | Metadata | Purpose |
|----------|----------|---------|
| **Use Case 1** (Direct Link) | `paymentby: 'directlink'` | Creates new subscription |
| **Use Case 2** (Site Purchase) | `usecase: '2'`, `purchase_type: 'site'` | Creates separate subscription per site |
| **Use Case 3** (License Purchase) | `usecase: '3'`, `purchase_type: 'quantity'` | Creates separate subscription per license |

---

## 🛠️ Step-by-Step Setup

### Step 1: Go to Stripe Dashboard

1. Navigate to: https://dashboard.stripe.com/
2. Go to **Products** → **Payment Links**
3. Click on your payment link (or create a new one)

### Step 2: Add Metadata

1. Click **Settings** tab
2. Scroll to **Metadata** section
3. Click **Add metadata**
4. Add:
   - **Key:** `paymentby`
   - **Value:** `directlink`
5. Click **Add metadata** again
6. Add:
   - **Key:** `usecase`
   - **Value:** `1`
7. Click **Save**

### Step 3: Verify

1. Test your payment link
2. Check webhook logs
3. Verify subscription is created (not added to existing)

---

## ✅ Verification Checklist

After adding metadata, verify:

- [ ] Metadata added in Stripe Dashboard
- [ ] `paymentby: 'directlink'` is set
- [ ] `usecase: '1'` is set (optional but recommended)
- [ ] Payment link creates new subscription (not adds to existing)
- [ ] Webhook processes as Use Case 1
- [ ] License keys are generated

---

## 🔍 Testing

### Test Payment Link

1. Use your payment link: `https://buy.stripe.com/test_xxxxx`
2. Complete a test payment
3. Check webhook logs for:
   ```
   [checkout.session.completed] Payment by: directlink
   [checkout.session.completed] Use Case: 1
   [checkout.session.completed] Creating new subscription...
   ```

### Check Metadata in Webhook

In your webhook handler logs, you should see:

```javascript
session.metadata = {
  paymentby: 'directlink',
  usecase: '1'
}
```

---

## 📚 Additional Configuration

### After Payment URLs (Required)

You **MUST** configure where users are redirected after payment:

**In Stripe Dashboard → Payment Link → Settings → After payment:**

#### Success URL (After Successful Payment):
```
https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}
```

**Steps:**
1. Go to **Settings** → **After payment**
2. Under **Success page**, select **Custom URL**
3. Enter: `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}`
4. **Important:** Keep `{CHECKOUT_SESSION_ID}` - Stripe will replace it with the actual session ID

#### Cancel URL (If User Cancels):
```
https://memberstack-login-test-713fa5.webflow.io/dashboard
```

**Steps:**
1. Under **Cancel page**, select **Custom URL**
2. Enter: `https://memberstack-login-test-713fa5.webflow.io/dashboard`

**Note:** The `{CHECKOUT_SESSION_ID}` placeholder is automatically replaced by Stripe with the actual checkout session ID.

### Custom Field for Site Domain

Direct payment links typically collect the site domain via a custom field:

**In Stripe Dashboard → Payment Link → Custom fields:**

- **Field type:** Text
- **Field key:** `enteryourlivedomain`
- **Label:** "Enter your live domain"
- **Required:** Yes

**Code automatically extracts this:**
```javascript
const siteUrlField = session.custom_fields.find(field => 
  field.key === 'enteryourlivedomain'
);
```

---

## 🎯 Summary

### What to Add:

1. ✅ **`paymentby: 'directlink'`** - Required
2. ⚪ **`usecase: '1'`** - Optional but recommended

### Where to Add:

- **Stripe Dashboard** → **Payment Links** → **Your Link** → **Settings** → **Metadata**

### Result:

- ✅ Creates new subscription (Use Case 1)
- ✅ Generates license keys
- ✅ Processes site domain from custom field
- ✅ Does NOT add to existing subscription

---

## ❓ Troubleshooting

### Problem: Payment adds to existing subscription instead of creating new

**Solution:**
- Verify `paymentby: 'directlink'` is set in metadata
- Check that `add_to_existing` is NOT set to `'true'`
- Ensure `existing_subscription_id` is NOT set

### Problem: Metadata not appearing in webhook

**Solution:**
- Verify metadata is saved in Stripe Dashboard
- Check that you're looking at `session.metadata` in webhook
- Test with a new payment to ensure metadata is included

---

That's it! Add `paymentby: 'directlink'` to your payment link metadata and you're done! 🎉

