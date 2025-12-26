# Webflow Login Page Setup Guide

## 📋 What Code to Add

Add the **ENTIRE** content from `webflow-login-page-code-visible.html` to your Webflow login page.

---

## 🚀 Step-by-Step Instructions

### Step 1: Open Webflow Designer
1. Go to your Webflow project
2. Open the **Designer**
3. Navigate to your **login page** (`https://memberstack-login-test-713fa5.webflow.io/`)

### Step 2: Access Page Settings
1. Click on the page name in the **Pages panel** (left sidebar)
2. Or click the **⚙️ Settings** icon in the top toolbar
3. Select **Page Settings**

### Step 3: Add Custom Code
1. In Page Settings, scroll down to **Custom Code** section
2. Find **Footer Code** (or **Before </body> tag**)
3. Click in the code box

### Step 4: Paste the Code
1. Open `webflow-login-page-code-visible.html` file
2. **Copy ALL the code** (from line 1 to line 402)
3. **Paste it** into the Footer Code box in Webflow

### Step 5: Update API URL (Important!)
In the pasted code, find this line (around line 108):
```javascript
const API_BASE_URL = 'https://consentbit-dashboard-test.web-8fb.workers.dev';
```

**Replace it with your actual Cloudflare Worker URL:**
```javascript
const API_BASE_URL = 'https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev';
```

### Step 6: Save and Publish
1. Click **Save** in Webflow
2. Click **Publish** to make it live
3. Test the page!

---

## 📝 Complete Code to Add

The code you need to add is in: **`webflow-login-page-code-visible.html`**

**Copy everything from that file** (lines 1-402) and paste it into Webflow's Footer Code section.

---

## ✅ What the Code Does

1. **Detects email from URL** - When user arrives with `?email=xxx`
2. **Creates custom magic link** - Automatically calls `/request-magic-link` API
3. **Sends magic link email** - User receives email with custom magic link
4. **Triggers Memberstack passwordless** - Automatically triggers Memberstack SDK
5. **Shows user messages** - Loading, success, error messages
6. **Handles manual entry** - If no email in URL, shows input form

---

## 🔧 Configuration

### Required: Update API URL
```javascript
// Line 108 - Update this:
const API_BASE_URL = 'https://consentbit-dashboard-test.web-8fb.workers.dev';
```

### Optional: Customize Messages
You can customize the messages in the code:
- Loading messages
- Success messages
- Error messages
- Button text

---

## 🧪 Testing

After adding the code:

1. **Test with email parameter:**
   ```
   https://memberstack-login-test-713fa5.webflow.io/?email=test@example.com
   ```
   - Should show "Creating your login link..."
   - Should create and send magic link
   - Should trigger Memberstack passwordless

2. **Test without email:**
   ```
   https://memberstack-login-test-713fa5.webflow.io/
   ```
   - Should show email input form
   - User can enter email and click "Send Magic Link"

3. **Test with verified parameter:**
   ```
   https://memberstack-login-test-713fa5.webflow.io/?email=test@example.com&verified=true
   ```
   - Should show "Completing authentication..."
   - Should auto-trigger Memberstack passwordless

---

## ⚠️ Important Notes

1. **Memberstack SDK Required:**
   - Make sure Memberstack SDK is loaded on the page
   - Should be: `<script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" src="..."></script>`

2. **CORS Configuration:**
   - Make sure your Cloudflare Worker has CORS headers configured
   - Should allow requests from your Webflow domain

3. **API URL:**
   - Must match your actual Cloudflare Worker URL
   - Check in Cloudflare Dashboard → Workers & Pages

---

## 📋 Quick Checklist

- [ ] Opened Webflow Designer
- [ ] Navigated to login page
- [ ] Opened Page Settings
- [ ] Found Footer Code section
- [ ] Copied code from `webflow-login-page-code-visible.html`
- [ ] Pasted code into Footer Code
- [ ] Updated API_BASE_URL with your Worker URL
- [ ] Saved changes
- [ ] Published site
- [ ] Tested the page

---

## 🎯 Summary

**Add the entire code from `webflow-login-page-code-visible.html` to your Webflow login page Footer Code section.**

That's it! The code will handle everything automatically. 🚀

