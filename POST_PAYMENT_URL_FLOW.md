# Post-Payment URL Flow

This document explains what happens after a user completes payment on Stripe.

## Complete Flow Diagram

```
1. User completes payment on Stripe
   ↓
2. Stripe redirects to: /success.html?session_id={CHECKOUT_SESSION_ID}
   ↓
3. Success page loads and calls: /get-magic-link
   ↓
4. Success page displays magic link button
   ↓
5. User clicks "Open Dashboard" button
   ↓
6. Browser navigates to: /auth/callback?token=...&redirect=/dashboard.html
   ↓
7. Auth callback sets session cookie and redirects to: /dashboard.html
   ↓
8. Dashboard page loads and calls: /dashboard and /licenses
   ↓
9. User sees their sites, subscription info, and license keys
```

## Step-by-Step Details

### Step 1: Payment Completion
- **Location**: Stripe Checkout
- **Action**: User enters payment details and clicks "Pay"
- **Stripe Processing**: Payment is processed, webhook events are sent

### Step 2: Stripe Redirect
- **URL**: `https://consentbit-dashboard.web-8fb.workers.dev/success.html?session_id={CHECKOUT_SESSION_ID}`
- **Set in**: `src/index.js` line ~1162
  ```javascript
  const successUrl = `${url.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`;
  ```
- **Note**: `{CHECKOUT_SESSION_ID}` is a Stripe placeholder that gets replaced with the actual session ID

### Step 3: Success Page Loads
- **File**: Embedded in `src/index.js` (around line 1578)
- **What it does**:
  1. Extracts `session_id` from URL parameters
  2. Calls `/get-magic-link?session_id=...` API endpoint
  3. Displays a success message with a magic link button

### Step 4: Magic Link Retrieval
- **Endpoint**: `GET /get-magic-link`
- **Location**: `src/index.js` lines 1021-1068
- **What it does**:
  - Searches D1 database for payment record matching `session_id`, `email`, or `customer_id`
  - Returns the magic link that was generated during webhook processing
  - Magic link format: `/auth/callback?token=JWT_TOKEN&redirect=/dashboard.html`

### Step 5: User Clicks Magic Link
- **Action**: User clicks "Open Dashboard" button on success page
- **Navigation**: Browser goes to the magic link URL

### Step 6: Auth Callback Processing
- **Endpoint**: `GET /auth/callback`
- **Location**: `src/index.js` lines 831-852
- **What it does**:
  1. Extracts `token` from URL query parameters
  2. Verifies the JWT token
  3. Creates a session cookie (`sb_session`) with the token
  4. Redirects to `/dashboard.html` (or custom redirect URL)

### Step 7: Dashboard Page Loads
- **File**: Embedded in `src/index.js` (around line 1650)
- **What it does**:
  1. Automatically calls `/dashboard` API (with session cookie)
  2. Automatically calls `/licenses` API (with session cookie)
  3. Displays:
     - Account Information (Customer ID, Subscription ID, Email, Site Count, License Count)
     - Active Sites (with Subscription Item IDs)
     - Pending Sites (waiting for payment)
     - License Keys

## Key Code Locations

### Success URL Configuration
```javascript
// src/index.js ~line 1162
const successUrl = `${url.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`;
const cancelUrl = `${url.origin}/dashboard.html`;
```

### Magic Link Generation (During Webhook)
```javascript
// src/index.js ~line 504
const dashboardUrl = `${url.origin}/auth/callback?token=${encodeURIComponent(token)}&redirect=/dashboard.html`;
const magicLink = dashboardUrl;
```

### Auth Callback Handler
```javascript
// src/index.js lines 831-852
if (request.method === 'GET' && pathname === '/auth/callback') {
  const token = url.searchParams.get('token');
  const payload = await verifyToken(env, token);
  const cookie = createSessionCookie(token);
  const redirectUrl = url.searchParams.get('redirect') || '/dashboard.html';
  return new Response('', { 
    status: 302, 
    headers: { 
      'Set-Cookie': cookie, 
      'Location': redirectUrl
    } 
  });
}
```

## Current Behavior

✅ **What happens now:**
1. User pays → Stripe redirects to `/success.html`
2. Success page shows magic link
3. User clicks link → Goes to dashboard
4. Dashboard shows all user data

## Alternative Options

### Option 1: Auto-Redirect from Success Page
Skip the manual click - automatically redirect to dashboard after 2-3 seconds.

**Implementation**: Add to `success.html` JavaScript:
```javascript
setTimeout(() => { 
  window.location.href = magicLink; 
}, 2000);
```

### Option 2: Direct Redirect to Dashboard
Skip the success page entirely - go straight to dashboard after payment.

**Implementation**: Change success URL to:
```javascript
const successUrl = `${url.origin}/auth/callback?token={CHECKOUT_SESSION_TOKEN}&redirect=/dashboard.html`;
```
**Note**: This requires generating the token differently, as Stripe doesn't provide tokens directly.

### Option 3: Keep Current (Manual Click)
Keep the success page with manual "Open Dashboard" button click.

**Pros**: 
- User sees confirmation message
- User controls when to go to dashboard
- Clear success indication

**Cons**:
- Extra click required
- Slightly slower user experience

## Webhook Processing (Background)

While the user is being redirected, webhooks are processed:

1. **`checkout.session.completed`** (lines 542-632):
   - Generates license keys immediately
   - Saves payment details to D1
   - Creates magic link and saves to D1
   - Adds sites to subscription (if adding to existing)

2. **`invoice.payment_succeeded`** (lines 681-791):
   - Fallback license key generation (if not already done)
   - Ensures licenses are created even if checkout webhook fails

3. **`customer.subscription.updated`** (lines 634-679):
   - Syncs site status from Stripe
   - Updates inactive sites

## Testing the Flow

1. **Make a test payment** on Stripe
2. **Check logs** with `wrangler tail`:
   - Look for "PAYMENT SUCCESSFUL - MAGIC LINK"
   - Copy the magic link from logs
3. **Visit success page**: `https://consentbit-dashboard.web-8fb.workers.dev/success.html`
4. **Or use magic link directly**: Copy from logs and paste in browser

## Troubleshooting

### Issue: "Magic link not found" on success page
**Cause**: Webhook hasn't finished processing yet
**Solution**: Wait a few seconds and refresh, or check Worker logs for the magic link

### Issue: Dashboard shows "Loading..." forever
**Cause**: Session cookie not set properly
**Solution**: Check browser cookies, ensure `sb_session` cookie exists

### Issue: Redirect loop
**Cause**: Auth callback not setting cookie correctly
**Solution**: Check browser console for errors, verify JWT token is valid


