# Webflow Login Page Setup Instructions

## Overview
This guide shows you how to add automatic passwordless magic link functionality to your Webflow login page.

## Step-by-Step Instructions

### Step 1: Access Your Webflow Page Settings

1. Log in to your Webflow account
2. Open your project
3. Navigate to the page: `https://memberstack-login-test-713fa5.webflow.io/`
4. Click on the page in the Pages panel (left sidebar)
5. Click **Page Settings** (gear icon) at the top

### Step 2: Add Custom Code

1. In Page Settings, scroll down to the **Custom Code** section
2. Find the **Footer Code** field
3. Copy the entire contents of `webflow-login-page-code.html`
4. Paste it into the **Footer Code** field

### Step 3: Verify Your Memberstack App ID

1. Check the code you pasted - look for this line:
   ```html
   <script src="https://cdn.memberstack.com/scripts/memberstack.js?appId=app_clz9z3q4t00fI0sos3fhyOwft"></script>
   ```

2. Verify that `app_clz9z3q4t00fI0sos3fhyOwft` is your correct Memberstack App ID
   - If different, replace it with your actual App ID
   - You can find your App ID in Memberstack Dashboard → Settings → API Keys

### Step 4: Publish Your Site

1. Click **Publish** in Webflow
2. Select your hosting (if not already published)
3. The changes will go live immediately

## How It Works

### Flow:
1. **User completes payment** → Redirected to `success.html`
2. **success.html** → Gets email from Stripe → Redirects to Webflow login page with `?email=user@example.com`
3. **Webflow login page loads** → Code detects email parameter
4. **Memberstack SDK** → Automatically triggers passwordless magic link
5. **User receives email** → Clicks magic link → Logged in via Memberstack

### What the Code Does:

1. **Loads Memberstack SDK** - Required for passwordless functionality
2. **Detects Email Parameter** - Reads `?email=user@example.com` from URL
3. **Validates Email** - Checks email format before proceeding
4. **Triggers Passwordless** - Automatically sends magic link email via Memberstack
5. **Shows User Feedback** - Displays success/error messages
6. **Handles Retries** - Retries if Memberstack SDK isn't loaded yet

## Testing

### Test the Flow:

1. **Make a test payment** through Stripe
2. **Check the redirect** - You should be redirected to:
   ```
   https://memberstack-login-test-713fa5.webflow.io/?email=test@example.com
   ```
3. **Check browser console** - Open DevTools (F12) → Console tab
   - You should see logs like:
     ```
     [Webflow Login] Email detected in URL: test@example.com
     [Webflow Login] Memberstack SDK loaded, triggering passwordless...
     [Webflow Login] ✅ Passwordless triggered - magic link email sent
     ```
4. **Check email** - User should receive magic link email from Memberstack
5. **Click magic link** - Should redirect to your Webflow site with active Memberstack session

### Troubleshooting

#### Magic link not being sent:
- ✅ Check browser console for errors
- ✅ Verify Memberstack App ID is correct
- ✅ Ensure Memberstack SDK is loading (check Network tab)
- ✅ Verify passwordless is enabled in Memberstack Dashboard

#### Email parameter not detected:
- ✅ Check URL has `?email=user@example.com` parameter
- ✅ Verify code is in Footer Code section (not Header Code)
- ✅ Check browser console for logs

#### Memberstack SDK not loading:
- ✅ Check Network tab for failed requests to `cdn.memberstack.com`
- ✅ Verify App ID is correct
- ✅ Check for ad blockers or security extensions blocking the script

## Customization

### Customize Success Message:
Find this line in the code:
```javascript
showMessage('Magic link email sent! Check your inbox.', 'success');
```
Change the message text to match your brand voice.

### Customize Error Message:
Find this line:
```javascript
showMessage('Error sending magic link. Please try again.', 'error');
```
Update the message as needed.

### Customize Message Styling:
The `showMessage()` function includes inline styles. You can modify:
- Position (top, right, left, bottom)
- Colors (background, text)
- Font size and family
- Animation/transitions

## Additional Notes

- **No Manual Action Required**: The magic link is sent automatically when email is detected
- **Secure**: Email is only used to trigger passwordless - never displayed or stored
- **Memberstack Handles Everything**: Email delivery, link generation, and session management
- **Works with Existing Memberstack Setup**: This code works alongside your existing Memberstack configuration

## Support

If you encounter issues:
1. Check browser console for error messages
2. Verify Memberstack Dashboard settings
3. Test with a different email address
4. Check Memberstack documentation: https://developers.memberstack.com


