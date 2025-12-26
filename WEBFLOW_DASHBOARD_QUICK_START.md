# Webflow Dashboard Quick Start Guide

## Summary

You need to:
1. **Create elements in Webflow Designer** (see `WEBFLOW_DASHBOARD_SETUP.md`)
2. **Add JavaScript code** (use `webflow-dashboard-code.html`)
3. **Ensure API supports email-based queries** (or modify API)

---

## Step-by-Step Implementation

### Step 1: Create Elements in Webflow Designer

**Required Elements with IDs:**

1. **Error Message Container**
   - ID: `error-message`
   - Style: Red background, hidden by default

2. **Success Message Container**
   - ID: `success-message`
   - Style: Green background, hidden by default

3. **Sites Container**
   - ID: `sites-container`
   - Layout: Grid (3 columns desktop, 1 mobile)

4. **Add Site Form**
   - Input 1: ID = `new-site-input` (site domain)
   - Input 2: ID = `new-site-price` (price ID)
   - Button: ID = `add-site-button`

5. **Licenses Container**
   - ID: `licenses-container`

6. **Logout Button**
   - ID: `logout-button`

**See `WEBFLOW_DASHBOARD_SETUP.md` for detailed element structure.**

---

### Step 2: Add Memberstack SDK to Page HEAD

```html
<script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
        src="https://static.memberstack.com/scripts/v2/memberstack.js" 
        type="text/javascript"></script>
```

---

### Step 3: Add JavaScript Code to Footer

Copy the entire content from `webflow-dashboard-code.html` and paste it into:
- **Webflow Designer** → Your Dashboard Page → **Settings** → **Custom Code** → **Footer Code**

---

### Step 4: API Configuration

**Option A: Modify API to Support Email Parameter (Recommended)**

Update your `/dashboard` and `/licenses` endpoints in `src/index.js` to accept email as query parameter when Memberstack session is verified:

```javascript
// In /dashboard endpoint
if (request.method === 'GET' && pathname === '/dashboard') {
  // Try to get email from query parameter (for Memberstack users)
  const emailParam = url.searchParams.get('email');
  
  // If email provided and Memberstack session verified, use email
  if (emailParam) {
    // Verify Memberstack session first (optional security check)
    // Then use email to fetch data
    const email = emailParam;
    // ... fetch data by email
  } else {
    // Fall back to session cookie method
    // ... existing session cookie code
  }
}
```

**Option B: Create Session Token from Memberstack**

The JavaScript code will try to create a session token from Memberstack. You may need to add a `/create-session` endpoint that accepts email and creates a session token.

---

## How It Works

1. **User logs in via Memberstack** → Session created
2. **Dashboard page loads** → JavaScript checks Memberstack session
3. **If logged in:**
   - Gets user email from Memberstack
   - Fetches dashboard data from API (using email or session token)
   - Populates sites and licenses
   - Shows all dashboard content
4. **If not logged in:**
   - Hides all dashboard content
   - Shows login prompt
   - Optionally redirects to login page

---

## Testing Checklist

- [ ] All elements created with correct IDs
- [ ] Memberstack SDK added to HEAD
- [ ] JavaScript code added to Footer
- [ ] API endpoint supports email parameter (or session token)
- [ ] Test with logged-in user → Dashboard shows data
- [ ] Test with logged-out user → Dashboard is hidden
- [ ] Test logout button → Redirects to login
- [ ] Test add site → Site appears in list
- [ ] Test remove site → Site is removed
- [ ] Test copy license → License key copied

---

## Troubleshooting

### Dashboard not showing data
- Check browser console for errors
- Verify Memberstack session is active
- Check API endpoint is accessible
- Verify email parameter is being sent

### "Authentication system not configured" error
- Ensure Memberstack SDK is in HEAD section
- Check `data-memberstack-app` attribute is correct

### API returns 401 Unauthorized
- API may need email parameter support
- Or session token creation endpoint needed
- Check API logs for details

---

## Next Steps

1. ✅ Create all elements in Webflow
2. ✅ Add Memberstack SDK
3. ✅ Add JavaScript code
4. ✅ Test with logged-in user
5. ✅ Modify API if needed (email parameter support)

---

**Files to Reference:**
- `WEBFLOW_DASHBOARD_SETUP.md` - Detailed element structure
- `webflow-dashboard-code.html` - JavaScript code
- `dashboard.html` - Original design reference

