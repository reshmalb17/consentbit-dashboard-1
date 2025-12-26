# Dashboard Script Setup Guide

## Overview
This guide shows you how to host `dashboard-script.js` on GitHub/Cloudflare Pages and reference it from your Webflow dashboard page.

---

## Step 1: Host the Script

### Option A: GitHub + Cloudflare Pages (Recommended)

1. **Create a GitHub Repository**
   ```bash
   # Create a new repo or use existing one
   git init
   git add dashboard-script.js
   git commit -m "Add dashboard script"
   git remote add origin https://github.com/yourusername/your-repo.git
   git push -u origin main
   ```

2. **Deploy to Cloudflare Pages**
   - Go to Cloudflare Dashboard → Pages
   - Click "Create a project"
   - Connect your GitHub repository
   - Build settings:
     - **Framework preset:** None
     - **Build command:** (leave empty)
     - **Output directory:** `/` (root)
   - Click "Save and Deploy"
   - Your script will be available at: `https://your-project.pages.dev/dashboard-script.js`

### Option B: GitHub Raw (Simple but slower)

1. Upload `dashboard-script.js` to GitHub
2. Get the raw file URL:
   - Go to your file on GitHub
   - Click "Raw" button
   - Copy the URL: `https://raw.githubusercontent.com/yourusername/your-repo/main/dashboard-script.js`

### Option C: Cloudflare Workers (Fastest)

1. Create a new Worker in Cloudflare Dashboard
2. Copy the content of `dashboard-script.js`
3. Set Content-Type header: `text/javascript`
4. Deploy
5. Your script URL: `https://your-worker.your-subdomain.workers.dev`

---

## Step 2: Add Script to Webflow

### In Webflow Designer:

1. **Go to your Dashboard Page**
   - Open the page in Webflow Designer

2. **Add Script to Footer Code**
   - Click **Page Settings** (gear icon)
   - Go to **Custom Code** tab
   - In **Footer Code** section, add:
   ```html
   <script src="https://api.consentbit.com/dashboardscript.js"></script>
   ```
   
   **Your script URL:** `https://api.consentbit.com/dashboardscript.js`

3. **Ensure Memberstack SDK is in HEAD**
   - In **Custom Code** → **Head Code**, make sure you have:
   ```html
   <script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
           src="https://static.memberstack.com/scripts/v2/memberstack.js" 
           type="text/javascript"></script>
   ```

---

## Step 3: Create Elements in Webflow Designer

Create these elements with these **exact IDs** (you'll style them in Webflow):

### Required Elements:

| Element | ID | Type | Notes |
|---------|-----|------|-------|
| Error message | `error-message` | Div Block | Hidden by default |
| Success message | `success-message` | Div Block | Hidden by default |
| Sites container | `sites-container` | Div Block | Grid layout (3 columns) |
| Site domain input | `new-site-input` | Input Field | Text input |
| Price ID input | `new-site-price` | Input Field | Text input |
| Add site button | `add-site-button` | Button | Click to add site |
| Licenses container | `licenses-container` | Div Block | List container |
| Logout button | `logout-button` | Button | Click to logout |

### Dynamic Content Classes (for styling):

The script will create elements with these classes - style them in Webflow:

- `.site-card` - Each site card
- `.site-card.active` - Active site card
- `.site-card.inactive` - Inactive site card
- `.site-header` - Site card header
- `.site-name` - Site domain name
- `.status-badge` - Status badge
- `.status-badge.status-active` - Active status badge
- `.status-badge.status-inactive` - Inactive status badge
- `.site-info` - Site information section
- `.remove-site-button` - Remove site button
- `.site-removed-message` - Message for removed sites
- `.license-item` - Each license item
- `.license-key` - License key text (monospace font)
- `.license-meta` - License metadata
- `.copy-license-button` - Copy license button

---

## Step 4: Style in Webflow Designer

### Sites Container:
- Set to **Grid Layout**
- 3 columns on desktop
- 1 column on mobile
- Gap: 20px

### Site Cards:
- White background
- Rounded corners (8px)
- Padding: 20px
- Border: 2px solid
- Active: Green border (#4caf50), light green background (#f1f8f4)
- Inactive: Red border (#f44336), light red background (#fff5f5), opacity: 0.7

### License Items:
- Light gray background (#f5f5f5)
- Rounded corners (8px)
- Padding: 15px
- Flexbox layout (space-between)

### Buttons:
- Add Site: Primary color (#667eea)
- Remove Site: Danger color (#f44336)
- Copy License: Secondary color (#667eea)

---

## Step 5: Test

1. **Publish your Webflow site**
2. **Visit the dashboard page**
3. **Check browser console** for any errors
4. **Test functionality:**
   - ✅ Login with Memberstack
   - ✅ Sites load and display
   - ✅ Licenses load and display
   - ✅ Add site works
   - ✅ Remove site works
   - ✅ Copy license works
   - ✅ Logout works

---

## Troubleshooting

### Script not loading
- Check the script URL is correct
- Verify CORS headers if using Cloudflare Workers
- Check browser console for 404 errors

### Data not displaying
- Verify all element IDs are correct
- Check browser console for JavaScript errors
- Ensure Memberstack SDK is loaded before dashboard script

### Styling issues
- Make sure you've styled the classes in Webflow
- Check if Webflow's CSS is overriding your styles
- Use Webflow's Style Panel to adjust

---

## Quick Reference

**Your Script URL:**
- `https://api.consentbit.com/dashboardscript.js`

**Webflow Footer Code:**
```html
<script src="https://api.consentbit.com/dashboardscript.js"></script>
```

**Required Element IDs:**
- `error-message`
- `success-message`
- `sites-container`
- `new-site-input`
- `new-site-price`
- `add-site-button`
- `licenses-container`
- `logout-button`

---

## Next Steps

1. ✅ Upload `dashboard-script.js` to GitHub
2. ✅ Deploy to Cloudflare Pages (or use GitHub Raw)
3. ✅ Add script tag to Webflow Footer Code
4. ✅ Create all required elements with correct IDs
5. ✅ Style elements in Webflow Designer
6. ✅ Test the dashboard

---

**That's it! Your dashboard will fetch and display data automatically when users are logged in via Memberstack.**

