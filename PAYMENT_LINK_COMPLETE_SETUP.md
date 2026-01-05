# Complete Payment Link Setup Guide

This guide shows you **everything** you need to configure for your Stripe Payment Link.

---

## 🎯 Quick Setup Checklist

### ✅ Step 1: Metadata (Required)
- [ ] Add `paymentby: 'directlink'`
- [ ] Add `usecase: '1'` (optional but recommended)

### ✅ Step 2: After Payment URLs (Required)
- [ ] Set Success URL
- [ ] Set Cancel URL

### ✅ Step 3: Custom Field (Required for Site Collection)
- [ ] Add custom field for site domain

---

## 📋 Step-by-Step Configuration

### Step 1: Add Metadata

**Location:** Stripe Dashboard → Products → Payment Links → Your Link → Settings → Metadata

**Add these metadata fields:**

| Key | Value | Required |
|-----|-------|----------|
| `paymentby` | `directlink` | ✅ Yes |
| `usecase` | `1` | ⚪ Optional |

**How to add:**
1. Go to Stripe Dashboard
2. Navigate to **Products** → **Payment Links**
3. Click on your payment link
4. Go to **Settings** tab
5. Scroll to **Metadata** section
6. Click **Add metadata**
7. Add each key-value pair
8. Click **Save**

---

### Step 2: Configure After Payment URLs

**Location:** Stripe Dashboard → Products → Payment Links → Your Link → Settings → After payment

#### Success URL (After Successful Payment)

**URL:**
```
https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}
```

**Steps:**
1. Under **Success page**, select **Custom URL**
2. Paste the URL above
3. **Important:** Keep `{CHECKOUT_SESSION_ID}` exactly as shown - Stripe will replace it automatically

#### Cancel URL (If User Cancels)

**URL:**
```
https://memberstack-login-test-713fa5.webflow.io/dashboard
```

**Steps:**
1. Under **Cancel page**, select **Custom URL**
2. Paste the URL above
3. Click **Save**

**Note:** The `{CHECKOUT_SESSION_ID}` placeholder is automatically replaced by Stripe with the actual checkout session ID (e.g., `cs_test_xxxxx`).

---

### Step 3: Add Custom Field for Site Domain

**Location:** Stripe Dashboard → Products → Payment Links → Your Link → Custom fields

**Add custom field:**

| Setting | Value |
|---------|-------|
| **Field type** | Text |
| **Field key** | `enteryourlivedomain` |
| **Label** | "Enter your live domain" |
| **Required** | Yes ✅ |

**Steps:**
1. Go to **Custom fields** section
2. Click **Add field**
3. Select **Text** field type
4. Set **Field key:** `enteryourlivedomain`
5. Set **Label:** "Enter your live domain"
6. Check **Required**
7. Click **Save**

**Why:** This collects the site domain from the user during checkout, which is then used to generate license keys.

---

## 📝 Complete Configuration Summary

### Metadata:
```
paymentby: directlink
usecase: 1
```

### After Payment URLs:
```
Success URL: https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}
Cancel URL: https://memberstack-login-test-713fa5.webflow.io/dashboard
```

### Custom Field:
```
Field key: enteryourlivedomain
Label: Enter your live domain
Type: Text
Required: Yes
```

---

## 🔍 Visual Guide

### Stripe Dashboard Navigation:

```
Stripe Dashboard
└── Products
    └── Payment Links
        └── Your Payment Link
            ├── Settings
            │   ├── Metadata
            │   │   ├── Key: paymentby, Value: directlink
            │   │   └── Key: usecase, Value: 1
            │   └── After payment
            │       ├── Success page: Custom URL
            │       │   └── https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}
            │       └── Cancel page: Custom URL
            │           └── https://memberstack-login-test-713fa5.webflow.io/dashboard
            └── Custom fields
                └── Field key: enteryourlivedomain
                    └── Label: Enter your live domain
```

---

## ✅ Verification Checklist

After configuration, verify:

- [ ] Metadata `paymentby: 'directlink'` is set
- [ ] Metadata `usecase: '1'` is set (optional)
- [ ] Success URL is configured with `{CHECKOUT_SESSION_ID}` placeholder
- [ ] Cancel URL is configured
- [ ] Custom field `enteryourlivedomain` is added
- [ ] Custom field is marked as required
- [ ] All changes are saved

---

## 🧪 Testing

### Test Your Payment Link:

1. **Use your payment link:** `https://buy.stripe.com/test_xxxxx`
2. **Complete a test payment:**
   - Enter test card: `4242 4242 4242 4242`
   - Enter site domain in custom field
   - Complete payment
3. **Verify redirect:**
   - Should redirect to: `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id=cs_test_xxxxx`
   - Dashboard should load successfully
4. **Check webhook:**
   - Verify subscription is created
   - Verify license keys are generated
   - Verify site domain is stored

---

## 📚 URL Parameters Explained

### Success URL Parameters:

After successful payment, users are redirected with:

- `session_id={CHECKOUT_SESSION_ID}` - Stripe checkout session ID
  - Example: `session_id=cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6`
  - Used for tracking and verification

### How Your Dashboard Uses These:

```javascript
// In your dashboard code
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session_id');
const paymentStatus = urlParams.get('payment');

if (sessionId && paymentStatus === 'success') {
  // Show success message
  // Refresh subscription data
  // Track payment completion
}
```

---

## 🔄 URL Placeholders

### `{CHECKOUT_SESSION_ID}`

**What it is:** A Stripe placeholder that gets replaced automatically

**Example:**
- **Before:** `dashboard?session_id={CHECKOUT_SESSION_ID}`
- **After:** `dashboard?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6`

**Important:** 
- ✅ Keep the placeholder exactly as shown: `{CHECKOUT_SESSION_ID}`
- ✅ Stripe automatically replaces it
- ❌ Don't replace it manually
- ❌ Don't use quotes around it

---

## 🎯 Quick Copy-Paste URLs

### For Stripe Dashboard Configuration:

**Success URL:**
```
https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}
```

**Cancel URL:**
```
https://memberstack-login-test-713fa5.webflow.io/dashboard
```

**Custom Field Key:**
```
enteryourlivedomain
```

---

## ❓ Troubleshooting

### Problem: Users not redirected after payment

**Solution:**
- Verify Success URL is set in Stripe Dashboard
- Check that URL is accessible (not blocked)
- Ensure `{CHECKOUT_SESSION_ID}` placeholder is included

### Problem: Session ID not in URL

**Solution:**
- Verify `{CHECKOUT_SESSION_ID}` is in Success URL (exactly as shown)
- Check that you're using Custom URL (not default Stripe page)
- Test with a new payment

### Problem: Custom field not appearing

**Solution:**
- Verify custom field is added in Payment Link settings
- Check field key is exactly `enteryourlivedomain`
- Ensure field is marked as required
- Save and test again

---

## 📋 Complete Configuration Example

Here's what your Payment Link settings should look like:

### Metadata Section:
```
┌─────────────────────────────────┐
│ Metadata                        │
├─────────────────────────────────┤
│ Key: paymentby                  │
│ Value: directlink               │
├─────────────────────────────────┤
│ Key: usecase                    │
│ Value: 1                        │
└─────────────────────────────────┘
```

### After Payment Section:
```
┌─────────────────────────────────┐
│ After payment                    │
├─────────────────────────────────┤
│ Success page:                   │
│ ☑ Custom URL                    │
│ https://memberstack-login-test-  │
│ 713fa5.webflow.io/dashboard?     │
│ session_id={CHECKOUT_SESSION_ID} │
├─────────────────────────────────┤
│ Cancel page:                     │
│ ☑ Custom URL                    │
│ https://memberstack-login-test-  │
│ 713fa5.webflow.io/dashboard     │
└─────────────────────────────────┘
```

### Custom Fields Section:
```
┌─────────────────────────────────┐
│ Custom fields                    │
├─────────────────────────────────┤
│ Field key: enteryourlivedomain  │
│ Label: Enter your live domain    │
│ Type: Text                      │
│ Required: ☑ Yes                 │
└─────────────────────────────────┘
```

---

## ✅ That's It!

Once you've configured:
1. ✅ Metadata (`paymentby: 'directlink'`)
2. ✅ Success URL (with `{CHECKOUT_SESSION_ID}`)
3. ✅ Cancel URL
4. ✅ Custom field (`enteryourlivedomain`)

Your payment link is ready to use! 🎉

---

## 🔗 Related Documentation

- **Metadata Details:** See `DIRECT_PAYMENT_LINK_METADATA.md`
- **Webhook Setup:** See `STRIPE_PAYMENT_LINK_SETUP.md`
- **Product Info:** See `PAYMENT_LINK_PRODUCT_INFO.md`

