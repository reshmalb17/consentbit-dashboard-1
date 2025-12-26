# Complete Workflow Documentation: Payment to Login

## 📋 Table of Contents
1. [Overview](#overview)
2. [Phase 1: Payment](#phase-1-payment)
3. [Phase 2: Webhook Processing (Backend)](#phase-2-webhook-processing-backend)
4. [Phase 3: User Redirect](#phase-3-user-redirect)
5. [Phase 4: Webflow Login Page](#phase-4-webflow-login-page)
6. [Phase 5: User Clicks Magic Link](#phase-5-user-clicks-magic-link)
7. [Phase 6: Alternative Flow (Expired Link)](#phase-6-alternative-flow-expired-link)
8. [Complete Flow Diagram](#complete-flow-diagram)
9. [Key Points](#key-points)
10. [Security Features](#security-features)
11. [Database Schema](#database-schema)
12. [API Endpoints](#api-endpoints)

---

## Overview

This document describes the complete workflow from when a user makes a payment through Stripe to when they successfully log in using magic links. The system uses a combination of custom magic links and Memberstack's passwordless authentication.

---

## Phase 1: Payment

### Steps:
1. **User clicks "Buy Now" or payment link**
   - User initiates checkout process

2. **Stripe Checkout Session created**
   - Stripe creates a checkout session
   - User is redirected to Stripe's payment page

3. **User enters payment details**
   - User provides credit card information
   - User may enter custom fields (e.g., site URL)

4. **User completes payment**
   - Stripe processes the payment
   - Payment is authorized and captured

5. **Stripe processes payment ✅**
   - Payment status: `succeeded`
   - Stripe generates `customer_id` and `subscription_id`

---

## Phase 2: Webhook Processing (Backend)

### Steps:

6. **Stripe sends webhook**
   - **Endpoint:** `POST /webhook`
   - **Event:** `checkout.session.completed`
   - **Payload:** Contains session data, customer info, subscription info

7. **Cloudflare Worker receives webhook**
   - Worker verifies webhook signature
   - Extracts event data

8. **Extract data from webhook:**
   ```javascript
   {
     email: "user@example.com",
     customerId: "cus_xxxxx",
     subscriptionId: "sub_xxxxx",
     amount: 1000, // in cents
     currency: "usd"
   }
   ```

9. **Save payment to D1 database**
   - **Table:** `payments`
   - **Fields:**
     - `customer_id`
     - `subscription_id`
     - `email`
     - `amount`
     - `currency`
     - `status`
     - `site_domain`
     - `created_at`

10. **Generate license keys**
    - One license key per subscription item (site)
    - Format: `KEY-XXXX-XXXX-XXXX-XXXX`
    - **Table:** `licenses`
    - **Fields:**
      - `customer_id`
      - `subscription_id`
      - `license_key` (UNIQUE)
      - `site_domain`
      - `status` (active)
      - `created_at`

11. **Create Memberstack member**
    - **API:** `POST https://admin.memberstack.com/members`
    - **Headers:**
      ```json
      {
        "X-API-KEY": "sk_sb_xxxxx",
        "Content-Type": "application/json"
      }
      ```
    - **Body:**
      ```json
      {
        "email": "user@example.com",
        "password": "random-generated-password",
        "plans": [{ "planId": "pln_basic-il7702hh" }],
        "loginRedirect": "https://memberstack-login-test-713fa5.webflow.io/"
      }
      ```
    - **Response:** Member ID (e.g., `mem_sb_xxxxx`)

12. **Generate secure magic link token**
    - **Method:** `crypto.getRandomValues()`
    - **Length:** 64 hexadecimal characters (256 bits)
    - **Format:** `a1b2c3d4e5f6...` (64 chars)
    - Cryptographically secure, impossible to guess

13. **Save token to D1 database**
    - **Table:** `magic_link_tokens`
    - **Fields:**
      - `token` (UNIQUE, 64 chars)
      - `email`
      - `member_id`
      - `customer_id`
      - `ip_address` (null for webhook)
      - `used` (0 = not used, 1 = used)
      - `attempts` (0)
      - `expires_at` (unix timestamp, 60 minutes from now)
      - `created_at` (unix timestamp)
      - `used_at` (null until used)

14. **Send custom email via Resend**
    - **Service:** Resend API
    - **Subject:** "Your Secure Login Link"
    - **Content:** HTML email with:
      - Branded design
      - Magic link button
      - Security information
      - Expiration notice (60 minutes)
    - **Link Format:** `https://consentbit-dashboard-test.web-8fb.workers.dev/magic-link-handler?token=abc123...`

15. **Webhook returns 200 OK ✅**
    - All operations completed
    - Payment saved, licenses generated, member created, email sent

---

## Phase 3: User Redirect

### Steps:

16. **User redirected to success page**
    - **URL:** `/success.html?session_id=cs_test_xxxxx`
    - Stripe redirects user after payment

17. **success.html page loads**
    - HTML page with loading indicator
    - JavaScript starts fetching email

18. **Fetch email from Stripe session**
    - **API Call:** `GET /get-magic-link?session_id=cs_test_xxxxx`
    - Worker fetches session from Stripe API
    - Extracts `email` from session data

19. **Show "Payment Successful!" message**
    - Displays success message
    - Shows email address
    - Mentions magic link sent to email

20. **Auto-redirect after 1.5 seconds**
    - JavaScript waits 1.5 seconds
    - Then redirects automatically

21. **Redirect to Webflow login page**
    - **URL:** `https://memberstack-login-test-713fa5.webflow.io/?email=user@example.com`
    - Email is passed as URL parameter
    - User lands on Webflow login page

---

## Phase 4: Webflow Login Page

### Steps:

22. **Webflow login page loads**
    - Page HTML loads
    - Memberstack SDK script loads:
      ```html
      <script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
              src="https://static.memberstack.com/scripts/v2/memberstack.js">
      </script>
      ```

23. **JavaScript detects email parameter**
    - Reads `?email=user@example.com` from URL
    - Extracts email value

24. **Wait for Memberstack SDK to load**
    - Checks for `window.memberstack` or `window.$memberstack`
    - Retries up to 20 times (10 seconds max)

25. **Create hidden button**
    - Creates `<button>` element
    - Sets attributes:
      - `data-ms-action="passwordless"`
      - `data-ms-email="user@example.com"`
    - Button is hidden (off-screen)

26. **Auto-click button**
    - Programmatically clicks the button
    - Triggers Memberstack passwordless flow

27. **Memberstack SDK triggers passwordless**
    - SDK detects button click
    - Sends request to Memberstack API
    - Memberstack processes passwordless request

28. **Memberstack sends magic link email**
    - **This is a SECOND email** (from Memberstack)
    - Email sent to user's inbox
    - Contains Memberstack's magic link
    - Subject: Usually "Your magic login link" or similar

29. **Show success message**
    - Displays: "Magic link email sent! Check your inbox"
    - User sees confirmation message

---

## Phase 5: User Clicks Magic Link

### Option A: Custom Magic Link (from Phase 2, Step 14)

30. **User receives email from Resend**
    - **Subject:** "Your Secure Login Link"
    - **From:** Your custom email (via Resend)
    - Contains branded magic link button

31. **User clicks magic link**
    - Link: `https://consentbit-dashboard-test.web-8fb.workers.dev/magic-link-handler?token=abc123...`

32. **Redirects to magic link handler**
    - **Endpoint:** `GET /magic-link-handler?token=abc123...`
    - Worker receives request

33. **Backend verifies token:**
    - Checks if token exists in `magic_link_tokens` table
    - Checks if token is expired (60 minutes)
    - Checks if token already used (`used = 1`)
    - Checks rate limits (10 per IP, 5 per email per hour)
    - Validates IP address (if stored)

34. **Mark token as used**
    - Updates `magic_link_tokens` table:
      - `used = 1`
      - `used_at = current_timestamp`
    - Token cannot be reused (one-time use)

35. **Redirect to Webflow login page**
    - **URL:** `https://memberstack-login-test-713fa5.webflow.io/?email=user@example.com&auto_trigger=true`
    - Email parameter included
    - `auto_trigger=true` flag added

36. **Webflow page triggers Memberstack passwordless**
    - Page detects email parameter
    - Auto-triggers Memberstack passwordless
    - Memberstack sends magic link email (if not already sent)

37. **User receives Memberstack magic link email**
    - Second email from Memberstack
    - Contains Memberstack's magic link

38. **User clicks Memberstack link**
    - Link redirects to `loginRedirect` URL
    - Memberstack creates session

39. **Memberstack creates session ✅**
    - Session cookie set
    - User authenticated

40. **User is logged in! 🎉**
    - Can access protected pages
    - Memberstack SDK recognizes session
    - Plan access verified

### Option B: Memberstack Magic Link (from Phase 4, Step 28)

30. **User receives email from Memberstack**
    - Email sent when Webflow page triggered passwordless
    - Contains Memberstack's magic link

31. **User clicks Memberstack magic link**
    - Link format: Memberstack's custom URL
    - Redirects to `loginRedirect` URL

32. **Redirects to loginRedirect URL**
    - URL: `https://memberstack-login-test-713fa5.webflow.io/`
    - Memberstack processes authentication

33. **Memberstack creates session ✅**
    - Session cookie set
    - User authenticated

34. **User is logged in! 🎉**
    - Can access protected pages
    - Memberstack SDK recognizes session

---

## Phase 6: Alternative Flow (Expired Link)

### If user's magic link expired:

35. **User visits Webflow login page**
    - No email parameter in URL
    - Page shows email input form

36. **No email in URL → Shows email input form**
    - Form displayed with:
      - Email input field
      - "Send Magic Link" button
      - Instructions

37. **User enters email**
    - User types: `user@example.com`
    - Clicks "Send Magic Link" button

38. **JavaScript calls API**
    - **Endpoint:** `POST /request-magic-link`
    - **Body:**
      ```json
      {
        "email": "user@example.com"
      }
      ```

39. **Backend processes request:**
    - **Rate limit check:**
      - 5 requests per IP per hour
      - 3 requests per email per hour
    - **Validate email format**
      - Regex validation
    - **Check if email exists in database**
      - Query `payments` table
      - Get `customer_id` if exists
    - **Generate NEW secure token**
      - 64-character hex token
      - Cryptographically secure
    - **Save to database**
      - Table: `magic_link_tokens`
      - Expires in 60 minutes
    - **Send new magic link email**
      - Via Resend API
      - Custom branded email

40. **User receives new email**
    - New magic link sent
    - 60-minute expiry

41. **User clicks link → Back to Phase 5 ✅**
    - Follows same verification flow
    - User logged in

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: PAYMENT                                            │
│ User → Stripe Checkout → Payment Complete                   │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: WEBHOOK PROCESSING (Backend)                      │
│ 1. Save payment to DB                                       │
│ 2. Generate license keys                                    │
│ 3. Create Memberstack member                                │
│ 4. Generate secure token                                    │
│ 5. Save token to DB                                         │
│ 6. Send custom magic link email ✉️                          │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: USER REDIRECT                                      │
│ success.html → Webflow login page                           │
│ URL: ?email=user@example.com                                │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: WEBFLOW LOGIN PAGE                                 │
│ 1. Detect email parameter                                   │
│ 2. Trigger Memberstack passwordless                          │
│ 3. Memberstack sends magic link email ✉️                    │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 5: USER CLICKS MAGIC LINK                             │
│ Option A: Custom link → Verify → Redirect → Memberstack     │
│ Option B: Memberstack link → Direct login                    │
│ Result: User logged in! ✅                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Points

### 1. Two Magic Link Emails
- **Custom Email (Resend):** Sent immediately after payment (Phase 2, Step 14)
  - Branded design
  - Custom messaging
  - 60-minute expiry
  
- **Memberstack Email:** Sent when Webflow page triggers passwordless (Phase 4, Step 28)
  - Memberstack's design
  - Memberstack's messaging
  - Memberstack's expiry

### 2. Two Login Paths
- **Path A: Custom Magic Link**
  - User clicks custom link → Token verified → Redirects to Webflow → Memberstack handles login
  
- **Path B: Memberstack Magic Link**
  - User clicks Memberstack link → Direct login via Memberstack

### 3. Security Features
- ✅ Rate limiting (prevents abuse)
- ✅ Token expiration (60 minutes)
- ✅ One-time use tokens
- ✅ IP tracking
- ✅ Security logging
- ✅ Email enumeration protection

### 4. Fallback Option
- If link expires → User can request new link
- Enter email on Webflow page → New magic link sent
- Rate limited to prevent abuse

---

## Security Features

### 1. Token Generation
- **Method:** `crypto.getRandomValues()`
- **Length:** 64 hexadecimal characters (256 bits)
- **Entropy:** 2^256 possible combinations
- **Impossible to guess or brute force**

### 2. Rate Limiting
- **Per IP:** 10 requests per hour (magic link handler)
- **Per IP:** 5 requests per hour (request new link)
- **Per Email:** 3 requests per hour (request new link)
- **Prevents:** Brute force attacks, abuse

### 3. Token Expiration
- **Default:** 60 minutes
- **Configurable:** Can be adjusted
- **Auto-cleanup:** Expired tokens rejected

### 4. One-Time Use
- **Tokens marked as used:** `used = 1` after successful use
- **Cannot be reused:** Prevents replay attacks
- **Database tracking:** `used_at` timestamp recorded

### 5. IP Validation
- **Optional:** IP address stored with token
- **Verification:** IP must match on token use (if stored)
- **Prevents:** Token theft and reuse from different locations

### 6. Security Logging
- **All attempts logged:** Success and failure
- **Failed attempts tracked:** `attempts` counter incremented
- **Monitoring:** Can detect suspicious activity

### 7. Email Enumeration Protection
- **Always returns success:** Doesn't reveal if email exists
- **Prevents:** Attackers from discovering valid emails
- **Security:** "If an account exists, email sent" message

---

## Database Schema

### Table: `magic_link_tokens`

```sql
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  member_id TEXT,
  customer_id TEXT,
  ip_address TEXT,
  used INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at INTEGER
);
```

### Indexes:
- `idx_tokens_token` - Fast token lookup
- `idx_tokens_email` - Fast email lookup
- `idx_tokens_expires` - Fast expiration checks
- `idx_tokens_used` - Fast used token filtering
- `idx_tokens_ip` - Fast IP lookup

---

## API Endpoints

### 1. Webhook Handler
- **Endpoint:** `POST /webhook`
- **Purpose:** Process Stripe payment webhooks
- **Events:** `checkout.session.completed`
- **Actions:**
  - Save payment to database
  - Generate license keys
  - Create Memberstack member
  - Generate and send magic link

### 2. Magic Link Handler
- **Endpoint:** `GET /magic-link-handler?token=xxx`
- **Purpose:** Verify and process magic link tokens
- **Actions:**
  - Verify token exists
  - Check expiration
  - Check if already used
  - Rate limit check
  - Mark token as used
  - Redirect to Webflow login page

### 3. Request Magic Link
- **Endpoint:** `POST /request-magic-link`
- **Purpose:** Generate new magic link for expired tokens
- **Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Actions:**
  - Rate limit check
  - Validate email format
  - Check if email exists
  - Generate new token
  - Save to database
  - Send email

### 4. Get Magic Link (Email Retrieval)
- **Endpoint:** `GET /get-magic-link?session_id=xxx`
- **Purpose:** Get email from Stripe session
- **Returns:** Email address

---

## Summary

### Complete Flow:
1. **Payment** → Stripe processes payment
2. **Webhook** → Save payment, generate licenses, create member, send custom email
3. **Redirect** → User redirected to Webflow login page
4. **Webflow** → Triggers Memberstack passwordless, sends Memberstack email
5. **Login** → User clicks either magic link → Logged in ✅

### Security:
- ✅ Cryptographically secure tokens
- ✅ Rate limiting
- ✅ Token expiration
- ✅ One-time use
- ✅ IP tracking
- ✅ Security logging

### User Experience:
- ✅ Automatic magic link after payment
- ✅ Fallback option if link expires
- ✅ Clear error messages
- ✅ Branded emails
- ✅ Seamless login flow

---

## Files Involved

1. **Backend:**
   - `src/index.js` - Main Cloudflare Worker code
   - `schema.sql` - Database schema

2. **Frontend:**
   - `success.html` - Payment success page
   - `webflow-login-page-code-visible.html` - Webflow login page code

3. **Database:**
   - `create-tables.ps1` - Database creation script

---

## Environment Variables Required

- `STRIPE_SECRET_KEY` - Stripe API key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret
- `RESEND_API_KEY` - Resend email API key
- `MEMBERSTACK_SECRET_KEY` - Memberstack admin API key
- `MEMBERSTACK_PLAN_ID` - Memberstack plan ID
- `MEMBERSTACK_REDIRECT_URL` - Webflow login page URL
- `BASE_URL` - Base URL for magic links
- `DB` - D1 database binding

---

**Last Updated:** 2025-01-19
**Version:** 1.0

