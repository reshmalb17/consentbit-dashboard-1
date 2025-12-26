# Webflow Dashboard Quick Reference

## Script URL
```
https://api.consentbit.com/dashboardscript.js
```

## Add to Webflow Dashboard Page

### Footer Code:
```html
<script src="https://api.consentbit.com/dashboardscript.js"></script>
```

### Head Code (Memberstack SDK):
```html
<script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
        src="https://static.memberstack.com/scripts/v2/memberstack.js" 
        type="text/javascript"></script>
```

---

## Required Element IDs

Create these elements in Webflow Designer with these **exact IDs**:

| ID | Element Type | Purpose |
|----|-------------|---------|
| `error-message` | Div Block | Shows error messages |
| `success-message` | Div Block | Shows success messages |
| `sites-container` | Div Block | Container for site cards (Grid layout) |
| `new-site-input` | Input Field | Input for site domain |
| `new-site-price` | Input Field | Input for price ID |
| `add-site-button` | Button | Button to add new site |
| `licenses-container` | Div Block | Container for license items |
| `logout-button` | Button | Logout button |

---

## CSS Classes (for styling in Webflow)

The script creates elements with these classes - style them in Webflow Designer:

### Site Cards:
- `.site-card` - Base site card
- `.site-card.active` - Active site card
- `.site-card.inactive` - Inactive site card
- `.site-header` - Site card header section
- `.site-name` - Site domain name
- `.status-badge` - Status badge
- `.status-badge.status-active` - Active status (green)
- `.status-badge.status-inactive` - Inactive status (red)
- `.site-info` - Site information section
- `.remove-site-button` - Remove site button
- `.site-removed-message` - Message for removed sites

### License Items:
- `.license-item` - Each license item container
- `.license-key` - License key text (use monospace font)
- `.license-meta` - License metadata (status, date)
- `.copy-license-button` - Copy license button

---

## How It Works

1. **User logs in via Memberstack** → Session created
2. **Dashboard page loads** → Script checks Memberstack session
3. **If logged in:**
   - Gets user email from Memberstack
   - Fetches sites from API
   - Fetches licenses from API
   - Displays data in containers
4. **If not logged in:**
   - Hides dashboard elements
   - Shows login prompt (if element exists)

---

## API Endpoints Used

- `GET /dashboard?email={email}` - Get user sites
- `GET /licenses?email={email}` - Get user licenses
- `POST /add-site` - Add new site
- `POST /remove-site` - Remove site

---

## Testing Checklist

- [ ] Script URL added to Footer Code
- [ ] Memberstack SDK added to Head Code
- [ ] All required element IDs created
- [ ] Elements styled in Webflow Designer
- [ ] Test login → Dashboard shows data
- [ ] Test logout → Dashboard hides
- [ ] Test add site → Site appears
- [ ] Test remove site → Site removed
- [ ] Test copy license → License copied

---

## Troubleshooting

### Script not loading
- Check script URL is correct: `https://api.consentbit.com/dashboardscript.js`
- Check browser console for 404 errors
- Verify CORS headers on API server

### Data not displaying
- Check all element IDs are correct (case-sensitive)
- Check browser console for JavaScript errors
- Verify Memberstack SDK loads before dashboard script
- Check API endpoints are accessible

### Styling issues
- Style the CSS classes in Webflow Designer
- Check Webflow's CSS isn't overriding your styles
- Use Webflow Style Panel to adjust

---

## Quick Copy-Paste

### Webflow Footer Code:
```html
<script src="https://api.consentbit.com/dashboardscript.js"></script>
```

### Webflow Head Code:
```html
<script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
        src="https://static.memberstack.com/scripts/v2/memberstack.js" 
        type="text/javascript"></script>
```

---

**That's it! The script will automatically handle all data fetching and display.**

