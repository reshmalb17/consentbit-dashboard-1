# How to Connect Cloudflare Worker to Webflow Login Page

## 📋 Overview

This guide explains how to connect your Cloudflare Worker backend to your Webflow login page for magic link authentication.

---

## 🔗 Connection Methods

### Method 1: Direct API Call (Current Implementation)

The Webflow page makes direct HTTP requests to your Cloudflare Worker API.

---

## 📝 Step-by-Step Setup

### Step 1: Get Your Cloudflare Worker URL

Your Cloudflare Worker URL format:
```
https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev
```

**Example:**
```
https://consentbit-dashboard-test.web-8fb.workers.dev
```

**How to find it:**
1. Go to Cloudflare Dashboard
2. Workers & Pages → Your Worker
3. Copy the URL from the "Preview" or "Triggers" section

---

### Step 2: Update Webflow Login Page Code

#### Option A: Hardcoded URL (Simple)

In `webflow-login-page-code-visible.html`, update the API URL:

```javascript
// Find this line (around line 235):
const response = await fetch('https://consentbit-dashboard-test.web-8fb.workers.dev/request-magic-link', {

// Replace with your actual Worker URL:
const response = await fetch('https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/request-magic-link', {
```

#### Option B: Environment Variable (Recommended)

Create a configurable API base URL:

```javascript
// Add at the top of the script
const API_BASE_URL = 'https://consentbit-dashboard-test.web-8fb.workers.dev';

// Then use it:
const response = await fetch(`${API_BASE_URL}/request-magic-link`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: enteredEmail })
});
```

---

### Step 3: Add Code to Webflow

1. **Open Webflow Designer**
   - Go to your login page
   - Click on the page settings (gear icon)

2. **Add Custom Code**
   - Go to **Page Settings** → **Custom Code**
   - In **Footer Code** section, paste the entire code from `webflow-login-page-code-visible.html`

3. **Update API URL**
   - Find the fetch URL in the code
   - Replace with your Cloudflare Worker URL

4. **Save and Publish**
   - Click **Save**
   - Click **Publish** to make it live

---

### Step 4: Configure CORS (Cross-Origin Resource Sharing)

Your Cloudflare Worker needs to allow requests from your Webflow domain.

#### Update `src/index.js`:

Add CORS headers to the `/request-magic-link` endpoint:

```javascript
// In the /request-magic-link handler, add CORS headers:
if (request.method === 'POST' && pathname === '/request-magic-link') {
  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://memberstack-login-test-713fa5.webflow.io',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  
  // ... existing code ...
  
  // Add CORS headers to response
  return jsonResponse(200, { 
    success: true,
    message: 'If an account exists with this email, a magic link has been sent.'
  }, {
    'Access-Control-Allow-Origin': 'https://memberstack-login-test-713fa5.webflow.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}
```

**Or use environment variable for allowed origins:**

```javascript
// Get allowed origin from environment or use wildcard for development
const allowedOrigin = env.ALLOWED_ORIGIN || 'https://memberstack-login-test-713fa5.webflow.io';

// In response headers:
'Access-Control-Allow-Origin': allowedOrigin,
```

---

## 🔧 Complete Integration Code

### Updated Webflow Login Page Code

```html
<script>
(function() {
    'use strict';
    
    // ============================================
    // CONFIGURATION
    // ============================================
    const API_BASE_URL = 'https://consentbit-dashboard-test.web-8fb.workers.dev';
    const WEBFLOW_LOGIN_URL = 'https://memberstack-login-test-713fa5.webflow.io/';
    
    // ============================================
    // Helper Functions
    // ============================================
    
    // Create visible message container
    function createVisibleMessage() {
        let container = document.getElementById('memberstack-passwordless-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'memberstack-passwordless-container';
            container.style.cssText = `
                max-width: 600px;
                margin: 50px auto;
                padding: 30px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                text-align: center;
            `;
            document.body.insertBefore(container, document.body.firstChild);
        }
        return container;
    }
    
    // Show message
    function showMessage(text, type, showContainer = true) {
        const container = createVisibleMessage();
        const colors = {
            loading: '#2196F3',
            success: '#4caf50',
            error: '#f44336'
        };
        container.innerHTML = `
            <div style="color: ${colors[type] || '#333'}; font-size: 18px; padding: 20px;">
                ${text}
            </div>
        `;
        if (!showContainer) {
            setTimeout(() => container.style.display = 'none', 5000);
        }
    }
    
    // Hide message
    function hideMessage() {
        const container = document.getElementById('memberstack-passwordless-container');
        if (container) {
            container.style.display = 'none';
        }
    }
    
    // Get email from URL parameter
    function getEmailFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('email');
    }
    
    // Trigger Memberstack passwordless (fallback)
    function triggerPasswordless(email) {
        try {
            const memberstack = window.memberstack || window.$memberstack || window.Memberstack;
            if (memberstack) {
                const btn = document.createElement('button');
                btn.setAttribute('data-ms-action', 'passwordless');
                btn.setAttribute('data-ms-email', email);
                btn.style.cssText = 'position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0;';
                document.body.appendChild(btn);
                setTimeout(() => {
                    btn.click();
                    setTimeout(() => btn.remove(), 2000);
                }, 100);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error triggering passwordless:', error);
            return false;
        }
    }
    
    // Request magic link from Cloudflare Worker
    async function requestMagicLink(email) {
        try {
            showMessage('Sending magic link email...', 'loading', false);
            
            const response = await fetch(`${API_BASE_URL}/request-magic-link`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: email })
            });
            
            const data = await response.json();
            
            if (response.ok && data.success) {
                showMessage('Magic link sent!<br><small style="color: #666;">Please check your inbox</small>', 'success', false);
                hideMessage();
                return true;
            } else {
                const errorMsg = data.message || data.error || 'Failed to send magic link';
                showMessage(errorMsg, 'error', false);
                return false;
            }
        } catch (error) {
            console.error('Error requesting magic link:', error);
            showMessage('Error sending magic link. Please try again.', 'error', false);
            return false;
        }
    }
    
    // Main handler
    function handleEmailAndTriggerPasswordless() {
        const email = getEmailFromURL();
        
        if (!email) {
            // No email - show form
            showMessage('Enter your email to receive a magic link', 'loading', true);
            const container = document.getElementById('memberstack-passwordless-container');
            if (container) {
                container.innerHTML = `
                    <div style="font-size: 48px; margin-bottom: 20px;">🔐</div>
                    <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px;">Login with Magic Link</h2>
                    <form id="memberstack-email-form" style="max-width: 400px; margin: 0 auto;">
                        <input 
                            type="email" 
                            id="memberstack-email-input" 
                            placeholder="your@email.com" 
                            required
                            style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 16px; margin-bottom: 15px; box-sizing: border-box;"
                        >
                        <button 
                            type="submit"
                            style="width: 100%; padding: 12px 24px; background: #2196F3; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; font-weight: 600;"
                        >Send Magic Link</button>
                    </form>
                `;
                
                const form = document.getElementById('memberstack-email-form');
                const emailInput = document.getElementById('memberstack-email-input');
                
                if (form && emailInput) {
                    form.onsubmit = async (e) => {
                        e.preventDefault();
                        const enteredEmail = emailInput.value.trim();
                        if (!enteredEmail) {
                            showMessage('Please enter your email address', 'error', false);
                            return;
                        }
                        
                        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                        if (!emailRegex.test(enteredEmail)) {
                            showMessage('Please enter a valid email address', 'error', false);
                            return;
                        }
                        
                        await requestMagicLink(enteredEmail);
                    };
                }
            }
            return;
        }
        
        // Email in URL - try both methods
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            showMessage('Invalid email address', 'error', false);
            return;
        }
        
        // Try Cloudflare Worker first
        requestMagicLink(email).then(success => {
            if (!success) {
                // Fallback to Memberstack
                triggerPasswordless(email);
            }
        });
    }
    
    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleEmailAndTriggerPasswordless);
    } else {
        handleEmailAndTriggerPasswordless();
    }
})();
</script>
```

---

## 🧪 Testing the Connection

### Test 1: Check API Endpoint

Open browser console on your Webflow page and run:

```javascript
fetch('https://consentbit-dashboard-test.web-8fb.workers.dev/request-magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com' })
})
.then(r => r.json())
.then(console.log)
.catch(console.error);
```

**Expected Response:**
```json
{
  "success": true,
  "message": "If an account exists with this email, a magic link has been sent."
}
```

### Test 2: Check CORS

If you see CORS errors in console:
- Check that CORS headers are set in Worker
- Verify the origin URL matches your Webflow domain

### Test 3: Full Flow Test

1. Visit Webflow login page
2. Enter email manually
3. Click "Send Magic Link"
4. Check browser console for errors
5. Check Network tab for API call
6. Verify email received

---

## 🔒 Security Considerations

### 1. CORS Configuration

**Production:**
- Only allow your specific Webflow domain
- Don't use wildcard `*` in production

**Development:**
- Can use wildcard for testing
- Switch to specific domain before production

### 2. API URL Security

- Don't expose sensitive endpoints
- Use HTTPS only
- Consider API key authentication for sensitive operations

### 3. Rate Limiting

Already implemented in backend:
- 5 requests per IP per hour
- 3 requests per email per hour

---

## 📋 Checklist

- [ ] Get Cloudflare Worker URL
- [ ] Update API URL in Webflow code
- [ ] Add CORS headers to Worker
- [ ] Add code to Webflow page Footer
- [ ] Test API connection
- [ ] Test CORS
- [ ] Test full flow
- [ ] Publish Webflow site

---

## 🐛 Troubleshooting

### Error: "Failed to fetch"

**Causes:**
- CORS not configured
- Wrong API URL
- Worker not deployed

**Solutions:**
- Check CORS headers in Worker
- Verify API URL is correct
- Deploy Worker: `wrangler deploy`

### Error: "CORS policy blocked"

**Causes:**
- Origin not allowed
- Missing CORS headers

**Solutions:**
- Add your Webflow domain to CORS headers
- Check `Access-Control-Allow-Origin` header

### Error: "Network request failed"

**Causes:**
- Worker URL incorrect
- Worker not accessible

**Solutions:**
- Verify Worker URL in Cloudflare Dashboard
- Test Worker URL directly in browser

---

## 📝 Environment Variables

Add to your Cloudflare Worker environment:

```bash
ALLOWED_ORIGIN=https://memberstack-login-test-713fa5.webflow.io
BASE_URL=https://consentbit-dashboard-test.web-8fb.workers.dev
```

---

## ✅ Summary

1. **Get Worker URL** from Cloudflare Dashboard
2. **Update API URL** in Webflow code
3. **Add CORS headers** to Worker responses
4. **Paste code** in Webflow Footer
5. **Test connection** in browser console
6. **Publish** Webflow site

The connection is now complete! 🎉

