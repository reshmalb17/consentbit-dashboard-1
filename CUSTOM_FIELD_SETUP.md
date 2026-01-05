# Custom Field Setup for "Enter Your Live Domain"

This guide shows exactly how to configure the custom field in Stripe Payment Link to collect the site domain.

---

## 🎯 Quick Answer

**Custom Field Key:** `enteryourlivedomain`

**Field Type:** Text

**Label:** "Enter your live domain" (or any label you prefer)

**Required:** Yes ✅

---

## 📋 Step-by-Step Setup in Stripe Dashboard

### Step 1: Navigate to Payment Link

1. Go to **Stripe Dashboard:** https://dashboard.stripe.com/
2. Navigate to **Products** → **Payment Links**
3. Click on your payment link (or create a new one)

### Step 2: Add Custom Field

1. Go to **Custom fields** section (usually in Settings or Checkout customization)
2. Click **Add field** or **+ Add custom field**
3. Configure the field:

| Setting | Value |
|---------|-------|
| **Field type** | Text |
| **Field key** | `enteryourlivedomain` |
| **Label** | "Enter your live domain" |
| **Placeholder** | "example.com" (optional) |
| **Required** | ✅ Yes |
| **Help text** | "Enter the domain where you'll use this license" (optional) |

### Step 3: Save

Click **Save** to apply the changes.

---

## ✅ Exact Configuration

### Field Key (Most Important):
```
enteryourlivedomain
```

**Important:** 
- ✅ Must be exactly: `enteryourlivedomain` (all lowercase, no spaces)
- ✅ This is what the code looks for
- ❌ Don't use spaces or different casing

### Field Settings:

```
Field Type: Text
Field Key: enteryourlivedomain
Label: Enter your live domain
Required: Yes
```

### Optional Settings:

```
Placeholder: example.com
Help Text: Enter the domain where you'll use this license
Character Limit: 255 (or leave unlimited)
```

---

## 🔍 What the Code Looks For

The code searches for a custom field with this exact key:

```javascript
const siteUrlField = session.custom_fields.find(field => 
  field.key === 'enteryourlivedomain'
);
```

**Supported Variations (for backward compatibility):**
- `enteryourlivedomain` ✅ (Primary - use this)
- `enteryourlivesiteurl` (legacy support)
- `enteryourlivesiteur` (legacy support)
- `enteryourlivedomaine` (legacy support)

**Recommendation:** Use `enteryourlivedomain` as it's the primary key the code looks for.

---

## 📝 Example User Experience

When users click your payment link, they'll see:

```
┌─────────────────────────────────────┐
│ Payment Information                 │
├─────────────────────────────────────┤
│ Card Number: [_____________]        │
│                                     │
│ Enter your live domain *            │
│ [example.com________________]      │
│                                     │
│ * Required                          │
└─────────────────────────────────────┘
```

---

## 🎨 Visual Guide

### In Stripe Dashboard:

```
Payment Link Settings
├── Custom fields
│   └── Add field
│       ├── Field type: Text
│       ├── Field key: enteryourlivedomain
│       ├── Label: Enter your live domain
│       ├── Placeholder: example.com
│       ├── Required: ☑ Yes
│       └── Help text: (optional)
```

---

## ✅ Verification Checklist

After adding the custom field:

- [ ] Field key is exactly: `enteryourlivedomain` (all lowercase)
- [ ] Field type is: Text
- [ ] Field is marked as Required
- [ ] Changes are saved
- [ ] Test payment link shows the field
- [ ] User can enter domain value
- [ ] Domain value is captured in webhook

---

## 🧪 Testing

### Test the Custom Field:

1. **Use your payment link:** `https://buy.stripe.com/test_xxxxx`
2. **Fill in the form:**
   - Enter test card: `4242 4242 4242 4242`
   - Enter domain in custom field: `example.com`
   - Complete payment
3. **Check webhook:**
   - Verify `session.custom_fields` contains the field
   - Verify `field.key === 'enteryourlivedomain'`
   - Verify `field.text.value === 'example.com'`

### Expected Webhook Data:

```json
{
  "custom_fields": [
    {
      "key": "enteryourlivedomain",
      "type": "text",
      "text": {
        "value": "example.com"
      }
    }
  ]
}
```

---

## 🔧 Troubleshooting

### Problem: Custom field not appearing

**Solution:**
- Verify field is added in Payment Link settings
- Check that field is enabled/active
- Ensure you're testing with the correct payment link
- Clear browser cache and try again

### Problem: Domain value not captured

**Solution:**
- Verify field key is exactly `enteryourlivedomain`
- Check webhook logs for `session.custom_fields`
- Ensure field is marked as required
- Test with a new payment

### Problem: Code not finding the field

**Solution:**
- Verify field key matches exactly (case-sensitive)
- Check that field type is "Text"
- Ensure field value is not empty
- Review webhook payload structure

---

## 📚 Code Reference

### How Code Extracts the Value:

```javascript
// Extract site URL from custom field
customFieldSiteUrl = null;
if (session.custom_fields && session.custom_fields.length > 0) {
  const siteUrlField = session.custom_fields.find(field => 
    field.key === 'enteryourlivedomain'
  );
  
  if (siteUrlField) {
    if (siteUrlField.type === 'text' && siteUrlField.text && siteUrlField.text.value) {
      customFieldSiteUrl = siteUrlField.text.value.trim();
    }
  }
}
```

---

## 🎯 Summary

### Required Configuration:

| Setting | Value |
|---------|-------|
| **Field Key** | `enteryourlivedomain` |
| **Field Type** | Text |
| **Required** | Yes ✅ |

### Where to Configure:

**Stripe Dashboard** → **Products** → **Payment Links** → **Your Link** → **Custom fields**

### Result:

- ✅ Users enter their domain during checkout
- ✅ Domain is captured in webhook
- ✅ Domain is used to generate license keys
- ✅ Domain is stored in database

---

## ✅ Quick Setup

1. Go to Stripe Dashboard → Payment Links → Your Link
2. Add custom field:
   - **Key:** `enteryourlivedomain`
   - **Type:** Text
   - **Required:** Yes
3. Save
4. Test payment link

That's it! The code will automatically extract the domain value from this field. 🎉

