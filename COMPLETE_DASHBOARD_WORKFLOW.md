# Complete Dashboard Workflow: From Stripe Payment to Dashboard Access

## 📋 Table of Contents
1. [Overview](#overview)
2. [Phase 1: Initial Payment - Checkout Session Creation](#phase-1-initial-payment---checkout-session-creation)
3. [Phase 2: Stripe Payment Processing](#phase-2-stripe-payment-processing)
4. [Phase 3: Webhook Processing - Backend Operations](#phase-3-webhook-processing---backend-operations)
5. [Phase 4: User Redirect & Authentication](#phase-4-user-redirect--authentication)
6. [Phase 5: Dashboard Access](#phase-5-dashboard-access)
7. [Phase 6: Site Management](#phase-6-site-management)
8. [Phase 7: License Management](#phase-7-license-management)
9. [Phase 8: Quantity Purchases](#phase-8-quantity-purchases)
10. [Phase 9: Subscription Updates](#phase-9-subscription-updates)
11. [Database Schema](#database-schema)
12. [API Endpoints Reference](#api-endpoints-reference)
13. [Error Handling](#error-handling)

---

## Overview

This document describes the complete end-to-end workflow for three payment use cases:

### Three Payment Use Cases

#### **Use Case 1: Initial Payment Through Direct Payment Link**

**Flow:**
1. User clicks Stripe Payment Link (e.g., `https://buy.stripe.com/test_xxxxx`)
2. User completes payment on Stripe checkout
3. Stripe sends webhook → Backend processes payment
4. **Initial subscription created** and saved to database
5. Subscription items saved to database
6. License keys generated and saved
7. Memberstack member created
8. User session saved
9. Dashboard displays customer and subscription details

**Key Points:**
- Creates **new subscription** (first-time payment)
- All data saved to database (payments, customers, subscriptions, subscription_items, licenses)
- User session available after authentication
- Dashboard loads subscription and payment details

#### **Use Case 2: Payment Through Dashboard - Site-Based Purchase**

**Flow:**
1. User adds site details in dashboard (e.g., "www.example.com")
2. Backend creates checkout session for **prorated payment**
3. User completes payment
4. Webhook processes payment → Adds site as **subscription item** to **existing subscription**
5. Subscription item saved to database
6. License key generated for the site

**Key Points:**
- Purchased as **subscription items** (not new subscription)
- Added to **existing subscription** with proration
- Prorated amount paid in checkout
- Uses `payment_intent.succeeded` webhook
- Same subscription ID, new subscription item ID

#### **Use Case 3: Payment Through Dashboard - Quantity Purchase**

**Flow:**
1. User enters quantity in dashboard (e.g., 5)
2. **License keys created FIRST** (before payment) with `pending` status
3. Backend creates checkout session for **prorated payment** (same as Use Case 2)
4. User completes payment
5. Webhook processes payment → Adds quantity as **subscription item** to **existing subscription**
6. License keys updated with subscription/item IDs and status changed to `active`

**Key Points:**
- **License keys created FIRST** (before payment)
- Payment processed **same as site-based** (Use Case 2)
- Added to **existing subscription** with proration
- Uses `payment_intent.succeeded` webhook
- License keys updated after payment completes

### System Components

- **Payment Processing**: Stripe Checkout Sessions and Payment Links
- **Webhook Processing**: Automatic license generation and user creation
- **Memberstack Member Creation**: Initial member creation during webhook
- **Authentication**: Memberstack passwordless login with code verification (6-digit code)
- **Dashboard Management**: Site and license management interface
- **Subscription Management**: Adding sites, quantity purchases with proration

---

---

## USE CASE 1: Initial Payment Through Direct Payment Link

This use case covers the first-time payment when a user clicks a Stripe Payment Link directly.

---

## Phase 1: Initial Payment - Direct Payment Link

### Step 1.1: User Initiates Purchase

**Two Payment Methods:**

#### **Method A: Direct Payment Link (Most Common)**

**User Action:**
- User clicks a Stripe Payment Link (e.g., `https://buy.stripe.com/test_xxxxx`)
- Payment link is pre-configured in Stripe Dashboard
- No code required - link is ready to use

**Payment Link Configuration:**
- **Created in:** Stripe Dashboard → Products → Payment Links
- **Success URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id={CHECKOUT_SESSION_ID}`
- **Cancel URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard`
- **Product/Price:** Selected in Stripe Dashboard
- **Custom Fields:** Can be configured in Stripe Dashboard (e.g., "Enter your Live Domain")

**Example Payment Link:**
```
https://buy.stripe.com/test_00w6oJgWy61GdIGdH157W08
```

#### **Method B: Checkout Session via API**

**Frontend Action:**
- User clicks "Buy Now" button on your website
- Frontend calls API to create checkout session

**Frontend Code:**
```javascript
const response = await fetch(`${API_BASE}/create-checkout-session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    customerEmail: 'user@example.com',
    sites: [
      { site: 'www.example.com', price: 'price_xxxxx', quantity: 1 }
    ],
    success_url: 'https://dashboard.example.com?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://dashboard.example.com'
  })
});

const { sessionId, url } = await response.json();
window.location.href = url; // Redirect to Stripe checkout
```

**Backend Process (for Method B only):**
1. Validates request (email, sites array)
2. Creates or finds Stripe customer
3. Creates checkout session with line items
4. Returns checkout URL

### Step 1.2: User Completes Payment

**What Happens:**
- User is on Stripe's hosted checkout page
- User enters payment details (credit card, billing address)
- User may enter custom fields (e.g., site domain if configured)
- User clicks "Pay" or "Subscribe"

**Stripe Processing:**
- Stripe validates payment method
- Stripe authorizes payment
- Stripe creates:
  - `customer_id`: `cus_xxxxx`
  - `subscription_id`: `sub_xxxxx` (for subscription mode)
  - `session_id`: `cs_xxxxx`

---

## Phase 2: Stripe Payment Processing

### Step 2.1: Payment Authorization

**Stripe Actions:**
1. Validates payment method
2. Authorizes payment
3. Creates subscription (for subscription mode)
4. Generates:
   - `customer_id`: `cus_xxxxx`
   - `subscription_id`: `sub_xxxxx`
   - `session_id`: `cs_xxxxx`

### Step 2.2: Payment Completion

**Stripe Events Triggered:**
1. `checkout.session.completed` - Checkout session completed
2. `customer.subscription.created` - Subscription created
3. `invoice.payment_succeeded` - Payment succeeded

### Step 2.3: User Redirected to Success URL

**What Happens After Payment:**

1. **Stripe processes payment** ✅
   - Payment status: `succeeded`
   - Subscription created (if subscription mode)
   - Customer created or found

2. **Stripe sends webhook** (happens simultaneously)
   - **Event:** `checkout.session.completed`
   - **Endpoint:** `POST /webhook`
   - **Payload:** Contains session data, customer info, subscription info

3. **Stripe redirects user** to success URL
   - **Payment Link:** Uses URL configured in Stripe Dashboard
   - **Checkout Session:** Uses `success_url` from session creation
   - **Redirect URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id=cs_test_xxxxx&payment=success`

**Important:** The webhook processing (Phase 3) happens **in parallel** with the user redirect. The user may land on the dashboard before webhook processing completes, but the webhook will finish processing in the background.

---

## Phase 3: Webhook Processing - Backend Operations

### Step 3.1: Stripe Sends Webhook

**Webhook Event:** `checkout.session.completed`

**Endpoint:** `POST /webhook`

**Webhook Payload:**
```json
{
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_xxxxx",
      "customer": "cus_xxxxx",
      "subscription": "sub_xxxxx",
      "customer_details": {
        "email": "user@example.com"
      },
      "custom_fields": [
        {
          "key": "enteryourlivedomain",
          "text": { "value": "www.example.com" }
        }
      ],
      "payment_status": "paid"
    }
  }
}
```

### Step 3.2: Webhook Signature Verification

**Backend Code:**
```javascript
const raw = await request.text();
const sig = request.headers.get('stripe-signature');
const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

// Verify webhook signature
const event = await verifyStripeWebhookForMemberstack(raw, sig, webhookSecret);
```

### Step 3.3: Extract Payment Data

**Backend Process:**
1. Extract from session:
   - `email`: From `customer_details.email`
   - `customerId`: From `customer`
   - `subscriptionId`: From `subscription`
   - `siteUrl`: From `custom_fields` (if provided)

2. Fetch subscription details:
   ```javascript
   const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
   const sub = subRes.body;
   ```

3. Extract subscription items:
   ```javascript
   const items = sub.items.data; // Array of subscription items
   // Each item has: id, price.id, quantity, metadata.site
   ```

### Step 3.4: Determine Purchase Type

**Backend Logic:**
```javascript
// Check multiple sources for purchase_type
let purchaseType = subscriptionMetadata.purchase_type || 'site';
let quantity = parseInt(subscriptionMetadata.quantity) || 1;

// Check session.metadata
if (session.metadata?.purchase_type) {
  purchaseType = session.metadata.purchase_type;
}

// Check subscription_data.metadata (PRIMARY SOURCE)
if (session.subscription_data?.metadata?.purchase_type) {
  purchaseType = session.subscription_data.metadata.purchase_type;
  quantity = parseInt(session.subscription_data.metadata.quantity) || quantity;
}
```

**Purchase Types:**
- **`site`**: Site-based purchase (default)
- **`quantity`**: Quantity purchase (buy N licenses)

### Step 3.5: Save Payment to Database

**Database Table:** `payments`

**Backend Code:**
```javascript
await env.DB.prepare(
  `INSERT INTO payments 
   (customer_id, subscription_id, email, amount, currency, status, site_domain, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
  customerId,
  subscriptionId,
  email,
  amountTotal,
  currency,
  'succeeded',
  siteDomain,
  timestamp
).run();
```

### Step 3.6: Save Customer & Subscription

**Database Tables:** `customers`, `subscriptions`, `subscription_items`

**Backend Process:**
1. Save customer:
   ```javascript
   await env.DB.prepare(
     `INSERT OR IGNORE INTO customers (customer_id, user_email, created_at)
      VALUES (?, ?, ?)`
   ).bind(customerId, email, timestamp).run();
   ```

2. Save subscription:
   ```javascript
   await env.DB.prepare(
     `INSERT OR REPLACE INTO subscriptions 
      (subscription_id, customer_id, user_email, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`
   ).bind(subscriptionId, customerId, email, 'active', timestamp, timestamp).run();
   ```

3. Save subscription items:
   ```javascript
   for (const item of sub.items.data) {
     const site = item.metadata?.site || customFieldSiteUrl || null;
     
     await env.DB.prepare(
       `INSERT INTO subscription_items 
        (subscription_id, item_id, site_domain, price_id, quantity, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
     ).bind(
       subscriptionId,
       item.id,
       site,
       item.price.id,
       item.quantity,
       'active',
       timestamp
     ).run();
   }
   ```

### Step 3.7: Generate License Keys

**For Site-Based Purchases:**
```javascript
// One license per site
for (const item of sub.items.data) {
  const site = item.metadata?.site || customFieldSiteUrl;
  const licenseKey = generateLicenseKey(); // Format: KEY-XXXX-XXXX-XXXX
  
  await env.DB.prepare(
    `INSERT INTO licenses 
     (license_key, customer_id, subscription_id, item_id, 
      site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    licenseKey,
    customerId,
    subscriptionId,
    item.id,
    site,           // Original site domain
    site,           // Used site domain (same for site purchases)
    'active',
    'site',
    timestamp,
    timestamp
  ).run();
}
```

**For Quantity Purchases:**
```javascript
// N licenses (where N = quantity)
const itemQuantity = sub.items.data[0].quantity || quantity;
const licenseKeys = generateLicenseKeys(itemQuantity);

for (let i = 0; i < licenseKeys.length; i++) {
  await env.DB.prepare(
    `INSERT INTO licenses 
     (license_key, customer_id, subscription_id, item_id, 
      site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    licenseKeys[i],
    customerId,
    subscriptionId,
    sub.items.data[0].id,
    null,           // No site assigned initially
    null,           // Will be set when activated
    'active',
    'quantity',
    timestamp,
    timestamp
  ).run();
}
```

### Step 3.8: Create Memberstack Member

**Backend Process:**

#### Step 3.8.1: Check if Member Exists

**Backend Code:**
```javascript
// First, try to get existing member by email
let member = null;
let memberWasCreated = false;

try {
  const existingMember = await getMemberstackMember(email, env);
  if (existingMember) {
    const existingEmail = existingMember.email || existingMember._email || 'N/A';
    const existingId = existingMember.id || existingMember._id;
    
    // Verify exact email match (case-insensitive)
    if (existingEmail.toLowerCase().trim() === email.toLowerCase().trim() || existingEmail === 'N/A') {
      member = existingMember;
      memberWasCreated = false;
      console.log(`[${operationId}] ✅ Member already exists: ${existingId}`);
    } else {
      // Email doesn't match - create new member
      console.warn(`[${operationId}] ⚠️ Found member but email doesn't match exactly`);
      console.warn(`[${operationId}] ⚠️ Requested: "${email}", Found: "${existingEmail}"`);
      member = null; // Don't use this member, create a new one
    }
  }
} catch (getError) {
  console.error(`[${operationId}] Error checking for existing member:`, getError);
  member = null; // Continue to create new member
}
```

**`getMemberstackMember()` Function:**
```javascript
async function getMemberstackMember(email, env) {
  if (!env.MEMBERSTACK_SECRET_KEY) {
    return null;
  }

  const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();
  
  try {
    // GET request to Memberstack Admin API
    const getRes = await fetch(
      `https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (getRes.ok) {
      const members = await getRes.json();
      let membersArray = [];
      
      // Normalize response to array
      if (Array.isArray(members)) {
        membersArray = members;
      } else if (members.data && Array.isArray(members.data)) {
        membersArray = members.data;
      }
      
      // Find member with EXACT email match (case-insensitive)
      const searchEmailLower = email.toLowerCase().trim();
      let foundMember = null;
      
      for (const member of membersArray) {
        const memberEmail = member.email || member._email;
        if (memberEmail && memberEmail.toLowerCase().trim() === searchEmailLower) {
          foundMember = member;
          break; // Found exact match, stop searching
        }
      }
      
      return foundMember;
    }
  } catch (error) {
    console.error('Error fetching member:', error);
  }
  
  return null;
}
```

#### Step 3.8.2: Create New Member (if doesn't exist)

**Backend Code:**
```javascript
// If member doesn't exist, create it
if (!member) {
  member = await createMemberstackMember(email, env);
  memberWasCreated = true;
  const newMemberId = member.id || member._id;
  const newMemberEmail = member.email || member._email || email;
  console.log(`[${operationId}] ✅ Created new Memberstack member: ${newMemberId}`);
}
```

**`createMemberstackMember()` Function:**
```javascript
async function createMemberstackMember(email, env) {
  if (!env.MEMBERSTACK_SECRET_KEY) {
    throw new Error('MEMBERSTACK_SECRET_KEY not configured');
  }

  // Validate API key format
  const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();
  
  // Memberstack test keys start with 'sk_sb_' (26 chars)
  // Memberstack live keys start with 'sk_' (longer)
  const isValidFormat = apiKey.startsWith('sk_sb_') || apiKey.startsWith('sk_');
  if (!isValidFormat) {
    throw new Error(`Invalid API key format. Expected 'sk_sb_' (test) or 'sk_' (live)`);
  }
  
  // First, try to get existing member (double-check)
  try {
    const getRes = await fetch(
      `https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (getRes.ok) {
      const members = await getRes.json();
      let membersArray = [];
      
      if (Array.isArray(members)) {
        membersArray = members;
      } else if (members.data && Array.isArray(members.data)) {
        membersArray = members.data;
      }
      
      // Find member with EXACT email match
      const searchEmailLower = email.toLowerCase().trim();
      for (const member of membersArray) {
        const memberEmail = member.email || member._email;
        if (memberEmail && memberEmail.toLowerCase().trim() === searchEmailLower) {
          return member; // Return existing member
        }
      }
    }
  } catch (error) {
    // If GET fails, continue to create
  }

  // Member doesn't exist, create it
  // Memberstack Admin API: https://admin.memberstack.com/members
  // Required: email, password
  // Optional: plans (array of { planId: string }), loginRedirect
  const createMemberPayload = {
    email: email,
    password: generateRandomPassword(), // 32-char random password
    loginRedirect: env.MEMBERSTACK_REDIRECT_URL || 'https://memberstack-login-test-713fa5.webflow.io/dashboard',
  };
  
  // Add plans array only if plan ID is configured
  if (env.MEMBERSTACK_PLAN_ID) {
    createMemberPayload.plans = [{ planId: env.MEMBERSTACK_PLAN_ID }];
  }
  
  // POST request to create member
  const res = await fetch('https://admin.memberstack.com/members', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createMemberPayload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    
    // 409 Conflict means member already exists - try to fetch again
    if (res.status === 409) {
      // Retry fetching the member
      const retryRes = await fetch(
        `https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`,
        {
          method: 'GET',
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
        }
      );
      if (retryRes.ok) {
        const members = await retryRes.json();
        if (Array.isArray(members) && members.length > 0) {
          return members[0];
        }
        if (members.data && Array.isArray(members.data) && members.data.length > 0) {
          return members.data[0];
        }
      }
    }
    
    throw new Error(`Member create failed: ${res.status} ${errorText}`);
  }

  const newMember = await res.json();
  const createdMemberData = newMember.data || newMember;
  
  // Handle different response formats
  return createdMemberData;
}
```

**Key Points:**
- **API Endpoint:** `POST https://admin.memberstack.com/members`
- **Headers:** `X-API-KEY: {MEMBERSTACK_SECRET_KEY}`
- **Required Fields:** `email`, `password`
- **Optional Fields:** `plans`, `loginRedirect`
- **Password:** Generated 32-character random password (user uses code verification, not password)
- **Plan Assignment:** Automatically assigned during creation if `MEMBERSTACK_PLAN_ID` is configured

#### Step 3.8.3: Verify Member Creation

**Backend Code:**
```javascript
const memberId = member.id || member._id;
const memberEmail = member.email || member._email || email;

// Verify member exists in Memberstack
try {
  const verifyRes = await fetch(
    `https://admin.memberstack.com/members/${memberId}`,
    {
      method: 'GET',
      headers: {
        'X-API-KEY': env.MEMBERSTACK_SECRET_KEY.trim(),
        'Content-Type': 'application/json',
      },
    }
  );
  
  if (verifyRes.ok) {
    const verifiedMember = await verifyRes.json();
    console.log(`[${operationId}] ✅ Member verified: ${memberId}`);
  } else {
    console.error(`[${operationId}] ❌ Member verification failed: ${verifyRes.status}`);
  }
} catch (verifyError) {
  console.error(`[${operationId}] ❌ Error verifying member: ${verifyError.message}`);
}
```

**Error Handling:**
- **409 Conflict:** Member already exists → Retry fetching
- **Invalid API Key:** Throws error, logged for debugging
- **Network Errors:** Caught and logged, operation continues

**Important Notes:**
- ✅ **Member is created** during webhook processing (initial process)
- ✅ **Plan is assigned** automatically if `MEMBERSTACK_PLAN_ID` is configured
- ⚠️ **NO email is sent yet** - Memberstack passwordless will be triggered on first dashboard login
- ⚠️ **User has no active session** - They need to log in via passwordless flow

### Step 3.9: Redirect User to Login Page

**Backend Process:**
After member creation, the webhook completes and user is redirected to success page, which then redirects to the Webflow login page.

**Note:** At this point:
- ✅ Memberstack member exists
- ✅ Plan is assigned
- ❌ User has NO active session
- ❌ User needs to trigger passwordless login

**No code is sent yet** - Memberstack will send verification code when user requests it on the login page.

### Step 3.9: Webhook Completes - Data Stored in Database

**Response:** `200 OK`

All operations completed:
- ✅ **Payment saved** to `payments` table
- ✅ **Customer saved** to `customers` table
- ✅ **Subscription saved** to `subscriptions` table
- ✅ **Subscription items saved** to `subscription_items` table
- ✅ **License keys generated** and saved to `licenses` table
- ✅ **Memberstack member created** (member ID stored)

**Database Records Created:**
```sql
-- Payment record
INSERT INTO payments (customer_id, subscription_id, email, amount, currency, status, created_at)
VALUES ('cus_xxxxx', 'sub_xxxxx', 'user@example.com', 1000, 'usd', 'succeeded', timestamp);

-- Customer record
INSERT INTO customers (customer_id, user_email, created_at)
VALUES ('cus_xxxxx', 'user@example.com', timestamp);

-- Subscription record
INSERT INTO subscriptions (subscription_id, customer_id, user_email, status, created_at)
VALUES ('sub_xxxxx', 'cus_xxxxx', 'user@example.com', 'active', timestamp);

-- Subscription items
INSERT INTO subscription_items (subscription_id, item_id, site_domain, price_id, quantity, status, created_at)
VALUES ('sub_xxxxx', 'si_xxxxx', 'www.example.com', 'price_xxxxx', 1, 'active', timestamp);

-- License keys
INSERT INTO licenses (license_key, customer_id, subscription_id, item_id, site_domain, status, created_at)
VALUES ('KEY-XXXX-XXXX-XXXX', 'cus_xxxxx', 'sub_xxxxx', 'si_xxxxx', 'www.example.com', 'active', timestamp);
```

**Key Point:** All subscription and payment data is now stored in the database and ready to be displayed on the dashboard.

---

## Phase 4: User Redirect & First Login Attempt

### Step 4.1: User Lands on Dashboard After Payment

**URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard?session_id=cs_test_xxxxx&payment=success`

**What Happens:**

1. **User redirected from Stripe** after successful payment
   - **Payment Link:** Stripe redirects to success URL configured in Dashboard
   - **Checkout Session:** Stripe redirects to `success_url` from session creation

2. **Dashboard page loads** with `session_id` parameter

3. **Dashboard script checks for Memberstack session:**
   ```javascript
   // Dashboard initialization
   async function initializeDashboard() {
     const member = await checkMemberstackSession();
     
     if (!member) {
       // No session found - user needs to log in
       console.log('[Dashboard] User not logged in - redirecting to login');
       toggleDashboardVisibility(false);
       
       // Redirect to login page
       const loginUrl = 'https://memberstack-login-test-713fa5.webflow.io/';
       window.location.href = loginUrl;
       return;
     }
     
     // User has session - load dashboard data
     const userEmail = member.email || member._email;
     await loadDashboard(userEmail);
   }
   ```

**Current State After Webhook Processing:**
- ✅ Payment completed (Stripe)
- ✅ **Webhook processing completed** (Phase 3)
  - ✅ Payment saved to database
  - ✅ Customer saved to database
  - ✅ **Initial subscription created** and saved to database
  - ✅ Subscription items saved to database
  - ✅ License keys generated and saved
  - ✅ Memberstack member created
- ✅ **User session saved** (Memberstack session cookie set)
- ✅ **Dashboard data ready** - All subscription and payment details available in database

**Important:** After webhook processing completes, the user's session is available and the dashboard can immediately load and display:
- Customer information
- Subscription details
- Payment history
- License keys
- Site information

### Step 4.2: User Redirected to Login Page

**URL:** `https://memberstack-login-test-713fa5.webflow.io/?email=user@example.com`

**Frontend Code (Webflow Login Page):**
```javascript
// Extract email from URL
const email = new URLSearchParams(window.location.search).get('email');

// Pre-fill email in form if present
if (email) {
  document.getElementById('passwordlessEmail').value = email;
}

// Wait for Memberstack SDK to load
const memberstack = await waitForSDK();
```

**Login Page UI:**
- Email input field (pre-filled if email in URL)
- "Send Login Code" button
- Code input section (hidden initially)
- "Verify Code" button
- "Resend Code" button

### Step 4.3: User Requests Login Code

**User Action:**
- User clicks "Send Login Code" button (or form auto-submits if email pre-filled)

**Frontend Code:**
```javascript
// User clicks "Send Login Code" button
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  
  const email = document.getElementById('passwordlessEmail').value.trim();
  
  // Call Memberstack API to send code
  await memberstack.sendMemberLoginPasswordlessEmail({
    email: email,
    redirectUrl: dashboardUrl
  });
  
  // Show success message
  messageDiv.textContent = '✅ Check your email for the login code';
  
  // Show code input section
  document.getElementById('codeInputSection').style.display = 'block';
  document.getElementById('passwordlessCode').focus();
});
```

**What Happens:**
1. **Memberstack API** receives passwordless email request
2. **Memberstack generates** a 6-digit verification code
3. **Memberstack sends code email** to user
   - 📧 **From:** Memberstack (not custom email)
   - 📧 **Subject:** "Your login code" (or similar)
   - 📧 **Contains:** 6-digit code (e.g., "123456")
4. **Code input section** appears on login page
5. **User enters code** from email

### Step 4.4: User Enters and Verifies Code

**User Action:**
- User receives email with 6-digit code
- User enters code in the code input field
- User clicks "Verify Code" button

**Frontend Code:**
```javascript
// User clicks "Verify Code" button
verifyCodeButton.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  
  // Verify code with Memberstack
  const member = await memberstack.loginMemberPasswordless({
    passwordlessToken: code,
    email: document.getElementById('passwordlessEmail').value.trim()
  });
  
  // Code verified successfully
  console.log('[Webflow Login] ✅ Code verified successfully');
  
  // Redirect to dashboard
  window.location.href = dashboardUrl;
});
```

**What Happens:**
1. **Memberstack API** verifies the code
2. **Memberstack creates session** cookie
3. **User is authenticated**
4. **User redirected** to dashboard

### Step 4.5: User Authenticated

**Memberstack Session:**
- ✅ Session cookie set by Memberstack
- ✅ User email available via `memberstack.getCurrentMember()`
- ✅ Plan access verified
- ✅ User can now access dashboard

**Redirect URL:**
```
https://memberstack-login-test-713fa5.webflow.io/dashboard
```

---

## Phase 5: Dashboard Access (First Time Login)

### Step 5.1: Dashboard Page Loads (First Time)

**Scenario 1: User Has Active Session (After Verifying Code)**

**URL:** `https://memberstack-login-test-713fa5.webflow.io/dashboard`

**Frontend Code (dashboard-script.js):**
```javascript
// Check Memberstack session
async function initializeDashboard() {
  // Step 1: Check if user has active Memberstack session
  const member = await checkMemberstackSession();
  
  if (!member) {
    // Step 2: No active session - redirect to login page
    console.log('[Dashboard] User not logged in - redirecting to login');
    toggleDashboardVisibility(false);
    
    // Optionally redirect to login page
    const loginUrl = 'https://memberstack-login-test-713fa5.webflow.io/';
    window.location.href = loginUrl;
    return;
  }
  
  // Step 3: User is logged in - load dashboard data
  const userEmail = member.email || member._email;
  console.log('[Dashboard] ✅ User logged in:', userEmail);
  
  // Load dashboard data
  await Promise.all([
    loadDashboard(userEmail),
    loadLicenses(userEmail)
  ]);
}
```

**Scenario 2: User Tries to Access Dashboard Without Session**

**Flow:**
1. User navigates to dashboard URL
2. Dashboard script checks for Memberstack session
3. **No session found** → Dashboard is hidden
4. User is redirected to login page
5. Login page triggers passwordless (as in Phase 4.2)
6. User receives Memberstack code email
7. User clicks link → Session created → Redirected back to dashboard

**Key Point:** The first dashboard access attempt **initiates the Memberstack passwordless flow** if no session exists.

### Step 5.1.1: Memberstack Session Checking (Detailed)

**Frontend Code - `checkMemberstackSession()` Function:**

```javascript
async function checkMemberstackSession() {
  try {
    // Step 1: Wait for Memberstack SDK to load
    const memberstack = await waitForSDK();
    
    if (!memberstack) {
      console.error('[Dashboard] Memberstack SDK not loaded');
      return null;
    }
    
    // Step 2: Wait for SDK to be ready (with timeout)
    if (memberstack.onReady && typeof memberstack.onReady.then === 'function') {
      try {
        await Promise.race([
          memberstack.onReady,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
        ]);
      } catch (error) {
        console.warn('[Dashboard] ⚠️ SDK ready promise timeout or error:', error);
        // Continue anyway - SDK might still work
      }
    }
    
    // Step 3: Additional wait to ensure SDK is fully initialized
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Step 4: Try multiple methods to get current member
    let member = null;
    
    // Method 1: memberstack.getCurrentMember
    if (memberstack.getCurrentMember && typeof memberstack.getCurrentMember === 'function') {
      try {
        member = await memberstack.getCurrentMember();
        if (member) {
          // Check both direct and nested structure
          const hasDirectId = !!(member.id || member._id);
          const hasNestedId = !!(member.data && (member.data.id || member.data._id));
          const hasDirectEmail = !!(member.email || member._email);
          const hasNestedEmail = !!(member.data && (member.data.email || member.data._email || member.data.auth?.email));
          
          if (member.data) {
            // Memberstack v2 SDK returns {data: {...}}
            console.log('[Dashboard] Member data nested in data property');
          }
        }
      } catch (error) {
        console.error('[Dashboard] ❌ Error calling getCurrentMember:', error);
      }
    }
    
    // Method 2: window.memberstack.getCurrentMember
    if ((!member || !member.id) && window.memberstack && window.memberstack.getCurrentMember) {
      try {
        member = await window.memberstack.getCurrentMember();
      } catch (error) {
        console.error('[Dashboard] ❌ Error with window.memberstack:', error);
      }
    }
    
    // Method 3: $memberstackDom.memberstack.getCurrentMember
    if ((!member || !member.id) && window.$memberstackDom) {
      if (window.$memberstackDom.memberstack && window.$memberstackDom.memberstack.getCurrentMember) {
        try {
          member = await window.$memberstackDom.memberstack.getCurrentMember();
        } catch (error) {
          console.error('[Dashboard] ❌ Error with $memberstackDom.memberstack:', error);
        }
      }
    }
    
    // Method 4: Try $memberstackDom directly
    if ((!member || !member.id) && window.$memberstackDom && typeof window.$memberstackDom.getCurrentMember === 'function') {
      try {
        member = await window.$memberstackDom.getCurrentMember();
      } catch (error) {
        console.error('[Dashboard] ❌ Error with $memberstackDom:', error);
      }
    }
    
    // Step 5: Handle Memberstack v2 SDK response structure
    let actualMember = member;
    
    // CRITICAL: Always check if member exists first
    if (!member) {
      console.log('[Dashboard] User not logged in');
      return null;
    }
    
    // Check if member data is nested in 'data' property (Memberstack v2)
    if (member && member.data) {
      actualMember = member.data;
    }
    
    // Step 6: Validate member has required fields
    const memberId = actualMember.id || actualMember._id;
    const memberEmail = actualMember.email || actualMember._email;
    
    if (!memberId) {
      console.warn('[Dashboard] ⚠️ Member object missing ID');
      return null;
    }
    
    if (!memberEmail) {
      console.warn('[Dashboard] ⚠️ Member object missing email');
      return null;
    }
    
    // Step 7: Return validated member
    console.log('[Dashboard] ✅ User logged in:', memberEmail);
    return actualMember;
    
  } catch (error) {
    console.error('[Dashboard] Error checking session:', error);
    return null;
  }
}
```

**`waitForSDK()` Helper Function:**
```javascript
async function waitForSDK() {
  let retries = 0;
  const maxRetries = 20; // 10 seconds max (20 * 500ms)
  
  while (retries < maxRetries) {
    // Try multiple ways to access Memberstack SDK
    const memberstack = 
      window.memberstack || 
      window.$memberstack || 
      (window.$memberstackDom && window.$memberstackDom.memberstack) ||
      null;
    
    if (memberstack) {
      return memberstack;
    }
    
    // Wait 500ms before retrying
    await new Promise(resolve => setTimeout(resolve, 500));
    retries++;
  }
  
  console.error('[Dashboard] ❌ Memberstack SDK not found after 10 seconds');
  return null;
}
```

**Key Points:**
- **SDK Detection:** Checks multiple global variables (`window.memberstack`, `window.$memberstack`, `window.$memberstackDom`)
- **SDK Ready:** Waits for `memberstack.onReady` promise (with 15-second timeout)
- **Multiple Methods:** Tries 4 different methods to get current member
- **Response Structure:** Handles both direct and nested (`{data: {...}}`) response formats
- **Validation:** Verifies member has `id` and `email` before returning
- **Error Handling:** Gracefully handles errors and returns `null` if session check fails
- **First Login:** If `null` is returned, user is redirected to login page which triggers passwordless flow

**Important Flow:**
1. **Member Creation** (Phase 3) → Member created, no session yet
2. **First Dashboard Access** (Phase 5) → No session found → Redirect to login
3. **Login Page** → User requests login code → Code email sent
4. **User Enters Code** → Code verified → Session created → Dashboard accessible

### Step 5.2: Fetch Dashboard Data

**Frontend Code:**
```javascript
async function loadDashboard(userEmail) {
  // Try email-based endpoint first
  let response = await fetch(`${API_BASE}/dashboard?email=${encodeURIComponent(userEmail)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  
  // Fallback to session cookie if needed
  if (!response.ok && response.status === 401) {
    response = await fetch(`${API_BASE}/dashboard`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
  }
  
  const data = await response.json();
  // data.sites, data.subscriptions, data.pendingSites
}
```

### Step 5.3: Backend Processes Dashboard Request

**Endpoint:** `GET /dashboard?email=user@example.com`

**What Happens:**

1. **Backend authenticates user** (email parameter or session cookie)
2. **Backend queries database** for subscription and payment data
3. **Backend returns** customer and subscription details
4. **Frontend displays** subscription information on dashboard

#### Step 5.3.1: Authentication Methods

**Backend Code:**
```javascript
// Try to get email from query parameter (for Memberstack users)
const emailParam = url.searchParams.get('email');

// Read session cookie (fallback method)
const cookie = request.headers.get('cookie') || "";
const match = cookie.match(/sb_session=([^;]+)/);

let payload = null;
let email = null;

// Method 1: Email parameter (PRIMARY - for Memberstack authentication)
if (emailParam) {
  email = emailParam.toLowerCase().trim();
  // Create a mock payload for email-based access
  payload = {
    email: email,
    customerId: null // Will be looked up from database
  };
} 
// Method 2: Session cookie (FALLBACK - for custom session tokens)
else if (match) {
  const token = match[1];
  payload = await verifyToken(env, token);
  if (!payload) {
    return jsonResponse(401, { 
      error: 'invalid session', 
      message: 'Session token is invalid or expired' 
    }, true, request);
  }
  email = payload.email;
} 
// Method 3: No authentication provided
else {
  return jsonResponse(401, { 
    error: 'unauthenticated', 
    message: 'No session cookie found' 
  }, true, request);
}
```

**Authentication Flow:**
1. **Primary Method:** Email parameter from URL (Memberstack session verified on frontend)
2. **Fallback Method:** Session cookie (custom token-based authentication)
3. **Error:** Returns `401 Unauthorized` if neither method provides valid authentication

#### Step 5.3.2: Query Database

**Backend Code:**
```javascript
// CRITICAL: Query database tables directly by email
// This is the correct approach - no fallback needed
if (!env.DB) {
  console.error('Database not configured');
  return jsonResponse(500, { error: 'Database not configured' }, true, request);
}

const normalizedEmail = email.toLowerCase().trim();
const subscriptions = {};
const sites = {};
let allCustomerIds = [];
let allSubscriptions = [];

// Step 1: Get all customers for this email
try {
  const customersRes = await env.DB.prepare(
    'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
  ).bind(normalizedEmail).all();
  
  if (customersRes && customersRes.results) {
    allCustomerIds = customersRes.results.map(row => row.customer_id).filter(id => id);
  }
  
  // Also check payments table for any additional customer IDs
  const paymentsCustomersRes = await env.DB.prepare(
    'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
  ).bind(normalizedEmail).all();
  
  if (paymentsCustomersRes && paymentsCustomersRes.results) {
    const paymentCustomerIds = paymentsCustomersRes.results
        .map(row => row.customer_id)
        .filter(id => id && id.startsWith('cus_'));
    allCustomerIds = [...new Set([...allCustomerIds, ...paymentCustomerIds])];
  }
} catch (dbErr) {
  console.error('Error finding customers by email:', dbErr);
}

// Step 2: Get all subscriptions for these customers
if (allCustomerIds.length > 0) {
  try {
    const placeholders = allCustomerIds.map(() => '?').join(',');
    const subscriptionsRes = await env.DB.prepare(
      `SELECT subscription_id, customer_id, status, cancel_at_period_end, cancel_at, 
       current_period_start, current_period_end, created_at 
       FROM subscriptions 
       WHERE customer_id IN (${placeholders}) AND user_email = ?`
    ).bind(...allCustomerIds, normalizedEmail).all();
    
    if (subscriptionsRes && subscriptionsRes.results) {
      for (const subRow of subscriptionsRes.results) {
        const subscriptionId = subRow.subscription_id;
        const customerId = subRow.customer_id;
        
        subscriptions[subscriptionId] = {
          subscriptionId: subscriptionId,
          customerId: customerId,
          status: subRow.status || 'active',
          items: [],
          sitesCount: 0,
          created_at: subRow.created_at,
          current_period_start: subRow.current_period_start,
          current_period_end: subRow.current_period_end,
          cancel_at_period_end: subRow.cancel_at_period_end === 1,
          canceled_at: subRow.canceled_at
        };
        
        allSubscriptions.push({
          subscriptionId: subscriptionId,
          customerId: customerId,
          status: subRow.status || 'active',
          created_at: subRow.created_at
        });
      }
    }
  } catch (dbErr) {
    console.error('Error finding subscriptions by customer IDs:', dbErr);
  }
}

// Step 3: Get all subscription items directly from subscription_items table
const subscriptionIds = Object.keys(subscriptions);
if (subscriptionIds.length > 0) {
  try {
    const placeholders = subscriptionIds.map(() => '?').join(',');
    const itemsRes = await env.DB.prepare(
      `SELECT subscription_id, item_id, site_domain, price_id, quantity, status, created_at, removed_at 
       FROM subscription_items 
       WHERE subscription_id IN (${placeholders})`
    ).bind(...subscriptionIds).all();
    
    if (itemsRes && itemsRes.results) {
      for (const itemRow of itemsRes.results) {
        const subscriptionId = itemRow.subscription_id;
        const site = itemRow.site_domain;
        
        if (subscriptions[subscriptionId]) {
          const itemData = {
            item_id: itemRow.item_id,
            price: itemRow.price_id,
            quantity: itemRow.quantity || 1,
            status: itemRow.status || 'active',
            created_at: itemRow.created_at,
            removed_at: itemRow.removed_at
          };
          
          subscriptions[subscriptionId].items.push(itemData);
          
          // Build sites object
          if (site) {
            sites[site] = {
              ...itemData,
              subscription_id: subscriptionId,
              customer_id: subscriptions[subscriptionId].customerId
            };
          }
        }
      }
      
      // Update sitesCount for each subscription
      for (const subId in subscriptions) {
        subscriptions[subId].sitesCount = subscriptions[subId].items.length;
      }
    }
  } catch (dbErr) {
    console.error('Error finding subscription items:', dbErr);
  }
}
```

**Key Points:**
- **Email-based lookup:** All queries use email as the primary identifier
- **Multiple customers:** Handles users with multiple Stripe customers
- **Multiple subscriptions:** Handles users with multiple subscriptions
- **Direct database queries:** No fallback to KV storage or other methods
- **Error handling:** Gracefully handles database errors and continues

#### Step 5.3.3: Build Response with Subscription Data

**Backend Code:**
```javascript
// Get pending sites (if any)
let pendingSites = [];
try {
  const pendingRes = await env.DB.prepare(
    'SELECT site_domain FROM pending_sites WHERE email = ?'
  ).bind(normalizedEmail).all();
  
  if (pendingRes && pendingRes.results) {
    pendingSites = pendingRes.results.map(row => row.site_domain);
  }
} catch (dbErr) {
  console.error('Error finding pending sites:', dbErr);
}

// Get payment history
let payments = [];
try {
  const paymentsRes = await env.DB.prepare(
    'SELECT customer_id, subscription_id, amount, currency, status, site_domain, created_at FROM payments WHERE email = ? ORDER BY created_at DESC'
  ).bind(normalizedEmail).all();
  
  if (paymentsRes && paymentsRes.results) {
    payments = paymentsRes.results.map(row => ({
      customer_id: row.customer_id,
      subscription_id: row.subscription_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      site_domain: row.site_domain,
      created_at: row.created_at
    }));
  }
} catch (dbErr) {
  console.error('Error finding payments:', dbErr);
}

// Return dashboard data with subscription and payment details
return jsonResponse(200, {
  email: email,
  sites: sites,  // { "www.example.com": { item_id, price, quantity, status, ... } }
  subscriptions: subscriptions,  // { "sub_xxxxx": { subscriptionId, status, items, current_period_start, current_period_end, ... } }
  payments: payments,  // Array of payment records
  pendingSites: pendingSites  // Array of pending sites
}, true, request);
```

**Response Data Structure:**
```json
{
  "email": "user@example.com",
  "sites": {
    "www.example.com": {
      "item_id": "si_xxxxx",
      "price": "price_xxxxx",
      "quantity": 1,
      "status": "active",
      "subscription_id": "sub_xxxxx",
      "customer_id": "cus_xxxxx",
      "created_at": 1234567890
    }
  },
  "subscriptions": {
    "sub_xxxxx": {
      "subscriptionId": "sub_xxxxx",
      "customerId": "cus_xxxxx",
      "status": "active",
      "items": [
        {
          "item_id": "si_xxxxx",
          "price": "price_xxxxx",
          "quantity": 1,
          "status": "active"
        }
      ],
      "sitesCount": 1,
      "created_at": 1234567890,
      "current_period_start": 1234567890,
      "current_period_end": 1237257890,
      "cancel_at_period_end": false
    }
  },
  "payments": [
    {
      "customer_id": "cus_xxxxx",
      "subscription_id": "sub_xxxxx",
      "amount": 1000,
      "currency": "usd",
      "status": "succeeded",
      "site_domain": "www.example.com",
      "created_at": 1234567890
    }
  ],
  "pendingSites": []
}
```

**Key Point:** After initial payment through payment link, all subscription and payment data is stored in the database and immediately available for display on the dashboard.

2. Query database:
   ```javascript
   // Get all customers for this email
   const customersRes = await env.DB.prepare(
     'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
   ).bind(email).all();
   
   // Get all subscriptions
   const subscriptionsRes = await env.DB.prepare(
     `SELECT subscription_id, customer_id, status, created_at 
      FROM subscriptions 
      WHERE customer_id IN (${placeholders}) AND user_email = ?`
   ).bind(...customerIds, email).all();
   
   // Get all subscription items
   const itemsRes = await env.DB.prepare(
     `SELECT subscription_id, item_id, site_domain, price_id, quantity, status 
      FROM subscription_items 
      WHERE subscription_id IN (${placeholders})`
   ).bind(...subscriptionIds).all();
   ```

3. Build response:
   ```javascript
   return jsonResponse(200, {
     email: email,
     sites: sites,  // { "www.example.com": { item_id, price, quantity, status, ... } }
     subscriptions: subscriptions,  // { "sub_xxxxx": { subscriptionId, status, items, ... } }
     pendingSites: pendingSites  // Array of pending sites
   });
   ```

### Step 5.4: Display Dashboard Data

**Frontend Code:**
```javascript
function displaySites(sites) {
  const container = document.getElementById('sites-container');
  
  if (Object.keys(sites).length === 0) {
    container.innerHTML = '<p>No sites found. Add your first site below.</p>';
    return;
  }
  
  let html = '<table><thead><tr><th>Site</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  
  for (const [site, data] of Object.entries(sites)) {
    html += `
      <tr>
        <td>${site}</td>
        <td>${data.status}</td>
        <td>
          <button onclick="removeSite('${site}')">Remove</button>
        </td>
      </tr>
    `;
  }
  
  html += '</tbody></table>';
  container.innerHTML = html;
}

function displaySubscriptionInfo(subscriptions) {
  const container = document.getElementById('subscription-container');
  
  let html = '<div class="subscription-info">';
  
  for (const [subId, sub] of Object.entries(subscriptions)) {
    html += `
      <div class="subscription-card">
        <h3>Subscription ${subId}</h3>
        <p><strong>Status:</strong> ${sub.status}</p>
        <p><strong>Customer ID:</strong> ${sub.customerId}</p>
        <p><strong>Sites:</strong> ${sub.sitesCount}</p>
        <p><strong>Created:</strong> ${new Date(sub.created_at * 1000).toLocaleDateString()}</p>
        ${sub.current_period_start ? `<p><strong>Current Period:</strong> ${new Date(sub.current_period_start * 1000).toLocaleDateString()} - ${new Date(sub.current_period_end * 1000).toLocaleDateString()}</p>` : ''}
      </div>
    `;
  }
  
  html += '</div>';
  container.innerHTML = html;
}

function displayPaymentHistory(payments) {
  const container = document.getElementById('payments-container');
  
  if (payments.length === 0) {
    container.innerHTML = '<p>No payment history available.</p>';
    return;
  }
  
  let html = '<table><thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Site</th></tr></thead><tbody>';
  
  for (const payment of payments) {
    html += `
      <tr>
        <td>${new Date(payment.created_at * 1000).toLocaleDateString()}</td>
        <td>${(payment.amount / 100).toFixed(2)} ${payment.currency.toUpperCase()}</td>
        <td>${payment.status}</td>
        <td>${payment.site_domain || 'N/A'}</td>
      </tr>
    `;
  }
  
  html += '</tbody></table>';
  container.innerHTML = html;
}
```

**Dashboard Displays:**
- ✅ **Customer Information:** Customer ID, email
- ✅ **Subscription Details:** Subscription ID, status, billing period, sites count
- ✅ **Payment History:** All payment records with amounts, dates, status
- ✅ **Site List:** All sites associated with subscriptions
- ✅ **License Keys:** Generated license keys for each site

---

---

## USE CASE 2: Payment Through Dashboard - Site-Based Purchase

This use case covers adding sites to an existing subscription through the dashboard. Sites are purchased as subscription items with proration and added to the existing subscription.

---

## Phase 6: Site Management - Adding Sites to Existing Subscription

### Step 6.1: User Adds Site Details in Dashboard

**Frontend Action:**
```javascript
async function addSite(userEmail) {
  const siteInput = document.getElementById('new-site-input');
  const site = siteInput.value.trim();
  
  if (!site) {
    alert('Please enter a site domain');
    return;
  }
  
  const response = await fetch(`${API_BASE}/add-sites-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      sites: [{ site: site, price: 'price_xxxxx' }]
    })
  });
  
  const data = await response.json();
  
  if (data.checkout_url) {
    // Redirect to Stripe checkout for prorated payment
    window.location.href = data.checkout_url;
  } else {
    // Site added successfully
    loadDashboard(userEmail);
  }
}
```

**Backend Endpoint:** `POST /add-sites-batch`

**Backend Process:**
1. Authenticate user
2. Get existing subscription:
   ```javascript
   const user = await getUserByEmail(env, email);
   const existingSubscriptionId = Object.keys(user.subscriptions || {})[0];
   ```
3. Create checkout session for prorated payment:
   ```javascript
   const form = {
     'mode': 'payment',  // One-time payment for prorated amount
     'customer': customerId,
     'line_items[0][price]': priceId,
     'line_items[0][quantity]': 1,
     'payment_intent_data[metadata][add_to_existing]': 'true',
     'payment_intent_data[metadata][existing_subscription_id]': existingSubscriptionId,
     'payment_intent_data[metadata][site_0]': site,
     'payment_intent_data[metadata][price_0]': priceId,
     'success_url': dashboardUrl,
     'cancel_url': dashboardUrl
   };
   
   const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
   ```
4. Return checkout URL:
   ```javascript
   return jsonResponse(200, {
     checkout_url: session.body.url,
     session_id: session.body.id
   });
   ```

### Step 6.2: Process Add Site Payment with Proration

**Webhook Event:** `payment_intent.succeeded`

**Backend Process:**

**Step 6.2.1: Extract Metadata**
```javascript
const addToExisting = paymentIntent.metadata?.add_to_existing === 'true';
const existingSubscriptionId = paymentIntent.metadata?.existing_subscription_id;
const site = paymentIntent.metadata?.site_0;
const priceId = paymentIntent.metadata?.price_0;
```

**Step 6.2.2: Add Subscription Item to Existing Subscription**

**Key Point:** Site is purchased as a **subscription item** and added to the **existing subscription** with proration.

```javascript
// Add subscription item to existing subscription
const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
  'subscription': existingSubscriptionId,  // Add to existing subscription
  'price': priceId,
  'quantity': 1,
  'metadata[site]': site,
  'proration_behavior': 'none'  // No proration - already paid prorated amount in checkout
}, true);

const newItem = addItemRes.body;
```

**Step 6.2.3: Save Subscription Item to Database**

```javascript
await env.DB.prepare(
  `INSERT INTO subscription_items 
   (subscription_id, item_id, site_domain, price_id, quantity, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).bind(
  existingSubscriptionId,  // Same subscription ID
  newItem.id,              // New subscription item ID
  site,
  priceId,
  1,
  'active',
  timestamp
).run();
```

**Step 6.2.4: Generate License Key**

```javascript
const licenseKey = generateLicenseKey();
await env.DB.prepare(
  `INSERT INTO licenses 
   (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
  licenseKey,
  customerId,
  existingSubscriptionId,  // Same subscription
  newItem.id,              // New item ID
  site,
  site,
  'active',
  'site',
  timestamp,
  timestamp
).run();
```

**Summary:**
- ✅ Site purchased as **subscription item** (not new subscription)
- ✅ Added to **existing subscription** with proration
- ✅ Prorated amount paid in checkout
- ✅ Subscription item saved to database
- ✅ License key generated and saved

### Step 6.3: Remove Site

**Frontend Action:**
```javascript
async function removeSite(userEmail, site) {
  if (!confirm(`Remove ${site}? This will cancel the subscription for this site.`)) {
    return;
  }
  
  const response = await fetch(`${API_BASE}/remove-site`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      site: site
    })
  });
  
  const data = await response.json();
  
  if (data.success) {
    loadDashboard(userEmail);
  }
}
```

**Backend Endpoint:** `POST /remove-site`

**Backend Process:**
1. Authenticate user
2. Find subscription item:
   ```javascript
   const itemRes = await env.DB.prepare(
     'SELECT item_id, subscription_id FROM subscription_items WHERE site_domain = ?'
   ).bind(site).first();
   ```

3. Delete subscription item from Stripe:
   ```javascript
   await stripeFetch(env, `/subscription_items/${itemId}`, 'DELETE', null, false);
   ```

4. Update database:
   ```javascript
   await env.DB.prepare(
     `UPDATE subscription_items 
      SET status = 'inactive', removed_at = ? 
      WHERE item_id = ?`
   ).bind(timestamp, itemId).run();
   
   await env.DB.prepare(
     `UPDATE licenses 
      SET status = 'inactive' 
      WHERE item_id = ?`
   ).bind(itemId).run();
   ```

---

## Phase 7: License Management

### Step 7.1: Fetch Licenses

**Frontend Code:**
```javascript
async function loadLicenses(userEmail) {
  const response = await fetch(`${API_BASE}/licenses?email=${encodeURIComponent(userEmail)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  
  const data = await response.json();
  displayLicenses(data.licenses);
}
```

**Backend Endpoint:** `GET /licenses?email=user@example.com`

**Backend Process:**
1. Authenticate user
2. Get all customer IDs for email
3. Query licenses:
   ```javascript
   const result = await env.DB.prepare(
     `SELECT license_key, site_domain, used_site_domain, status, purchase_type, created_at 
      FROM licenses 
      WHERE customer_id IN (${placeholders}) 
      ORDER BY created_at DESC`
   ).bind(...customerIds).all();
   ```

4. Return licenses:
   ```javascript
   return jsonResponse(200, {
     licenses: result.results.map(row => ({
       license_key: row.license_key,
       site_domain: row.site_domain,
       used_site_domain: row.used_site_domain,
       status: row.status,
       purchase_type: row.purchase_type || 'site',
       created_at: row.created_at
     }))
   });
   ```

### Step 7.2: Display Licenses

**Frontend Code:**
```javascript
function displayLicenses(licenses) {
  const container = document.getElementById('licenses-container');
  
  let html = '<table><thead><tr><th>License Key</th><th>Status</th><th>Site</th><th>Actions</th></tr></thead><tbody>';
  
  for (const license of licenses) {
    const site = license.used_site_domain || license.site_domain || 'Not assigned';
    const status = license.used_site_domain ? 'Used' : 'Available';
    
    html += `
      <tr>
        <td>${license.license_key}</td>
        <td>${status}</td>
        <td>${site}</td>
        <td>
          <button onclick="copyLicense('${license.license_key}')">Copy</button>
        </td>
      </tr>
    `;
  }
  
  html += '</tbody></table>';
  container.innerHTML = html;
}
```

### Step 7.3: Copy License Key

**Frontend Code:**
```javascript
async function copyLicense(licenseKey) {
  await navigator.clipboard.writeText(licenseKey);
  alert('License key copied to clipboard!');
}
```

---

---

## USE CASE 3: Payment Through Dashboard - Quantity Purchase

This use case covers purchasing multiple license keys by quantity. License keys are created first, then payment is processed the same way as site-based purchases (Use Case 2) - added to existing subscription with proration.

---

## Phase 8: Quantity Purchases

### Step 8.1: User Enters Quantity in Dashboard

**Frontend Code:**
```javascript
async function handleQuantityPurchase(userEmail, quantity) {
  const response = await fetch(`${API_BASE}/purchase-quantity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      quantity: parseInt(quantity)
    })
  });
  
  const data = await response.json();
  window.location.href = data.checkout_url;
}
```

### Step 8.2: Create License Keys First (Before Payment)

**Backend Endpoint:** `POST /purchase-quantity`

**Backend Process:**

**Step 8.2.1: Generate License Keys Before Payment**

```javascript
// FIRST: Create license keys for the quantity (before payment)
const licenseKeys = generateLicenseKeys(quantity); // e.g., 5 keys

// Save license keys to database with 'pending' status
for (let i = 0; i < licenseKeys.length; i++) {
  await env.DB.prepare(
    `INSERT INTO licenses 
     (license_key, customer_id, subscription_id, item_id, 
      site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    licenseKeys[i],
    customerId,
    null,  // Subscription ID will be set after payment
    null,  // Item ID will be set after payment
    null,  // No site assigned initially
    null,  // Will be set when activated
    'pending',  // Status: pending until payment completes
    'quantity',
    timestamp,
    timestamp
  ).run();
}
```

**Key Point:** License keys are created **FIRST** before payment is processed.

### Step 8.3: Create Checkout Session (Same as Site-Based Purchase)

**Backend Process:**

1. Get user's existing price and subscription:
   ```javascript
   const user = await getUserByEmail(env, email);
   const existingSubscription = Object.values(user.subscriptions || {})[0];
   const existingSubscriptionId = existingSubscription.subscriptionId;
   const priceId = existingSubscription?.items[0]?.price || env.DEFAULT_PRICE_ID;
   ```

2. Create checkout session with proration (same as Use Case 2):
   ```javascript
   const form = {
     'mode': 'payment',  // One-time payment for prorated amount (same as site-based)
     'customer': customerId,
     'line_items[0][price]': priceId,
     'line_items[0][quantity]': quantity,  // e.g., 5
     'payment_intent_data[metadata][add_to_existing]': 'true',
     'payment_intent_data[metadata][existing_subscription_id]': existingSubscriptionId,
     'payment_intent_data[metadata][purchase_type]': 'quantity',
     'payment_intent_data[metadata][quantity]': quantity.toString(),
     'success_url': dashboardUrl,
     'cancel_url': dashboardUrl
   };
   
   const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
   ```

**Key Point:** Payment processing is **the same as site-based purchases** (Use Case 2) - uses proration and adds to existing subscription.

### Step 8.4: Process Quantity Purchase Payment

**Webhook Event:** `payment_intent.succeeded` (same as Use Case 2)

**Backend Process:**

1. Extract metadata:
   ```javascript
   const addToExisting = paymentIntent.metadata?.add_to_existing === 'true';
   const existingSubscriptionId = paymentIntent.metadata?.existing_subscription_id;
   const purchaseType = paymentIntent.metadata?.purchase_type; // 'quantity'
   const quantity = parseInt(paymentIntent.metadata?.quantity) || 1;
   ```

2. Add subscription item to existing subscription (same as Use Case 2):
   ```javascript
   // Add subscription item with quantity to existing subscription
   const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
     'subscription': existingSubscriptionId,
     'price': priceId,
     'quantity': quantity,  // e.g., 5
     'metadata[purchase_type]': 'quantity',
     'proration_behavior': 'none'  // Already paid prorated amount
   }, true);
   
   const newItem = addItemRes.body;
   ```

3. Update license keys with subscription/item IDs:
   ```javascript
   // Update pending license keys with subscription and item IDs
   await env.DB.prepare(
     `UPDATE licenses 
      SET subscription_id = ?, item_id = ?, status = 'active', updated_at = ?
      WHERE customer_id = ? AND purchase_type = 'quantity' AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?`
   ).bind(
     existingSubscriptionId,
     newItem.id,
     timestamp,
     customerId,
     quantity
   ).run();
   ```

**Summary:**
- ✅ License keys created **FIRST** (before payment)
- ✅ Payment processed **same as site-based** (Use Case 2)
- ✅ Added to **existing subscription** with proration
- ✅ License keys updated with subscription/item IDs after payment

### Step 8.4: Activate Quantity License (Optional)

**Frontend Action:**
```javascript
async function activateLicense(userEmail, licenseKey, siteDomain) {
  const response = await fetch(`${API_BASE}/activate-license`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      license_key: licenseKey,
      site_domain: siteDomain
    })
  });
  
  const data = await response.json();
  if (data.success) {
    loadLicenses(userEmail);
  }
}
```

**Backend Endpoint:** `POST /activate-license`

**Backend Process:**
1. Validate license:
   ```javascript
   const license = await env.DB.prepare(
     'SELECT * FROM licenses WHERE license_key = ? AND customer_id = ?'
   ).bind(licenseKey, customerId).first();
   
   if (!license || license.used_site_domain || license.status !== 'active') {
     return error;
   }
   ```

2. Update license:
   ```javascript
   await env.DB.prepare(
     `UPDATE licenses 
      SET used_site_domain = ?, updated_at = ? 
      WHERE license_key = ?`
   ).bind(siteDomain, timestamp, licenseKey).run();
   ```

---

## Phase 9: Subscription Updates

### Step 9.1: Subscription Updated Webhook

**Webhook Event:** `customer.subscription.updated`

**Backend Process:**
1. Extract subscription data:
   ```javascript
   const subscription = event.data.object;
   const subscriptionId = subscription.id;
   const customerId = subscription.customer;
   const status = subscription.status;
   ```

2. Update database:
   ```javascript
   await env.DB.prepare(
     `UPDATE subscriptions 
      SET status = ?, updated_at = ? 
      WHERE subscription_id = ?`
   ).bind(status, timestamp, subscriptionId).run();
   ```

3. Sync subscription items:
   ```javascript
   // Get current items from Stripe
   const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
   const sub = subRes.body;
   
   // Update each item status
   for (const item of sub.items.data) {
     const site = item.metadata?.site;
     
     if (site) {
       await env.DB.prepare(
         `UPDATE subscription_items 
          SET status = ?, quantity = ?, updated_at = ? 
          WHERE item_id = ?`
       ).bind(status, item.quantity, timestamp, item.id).run();
     }
   }
   ```

4. Update license status if subscription canceled:
   ```javascript
   if (status === 'canceled' || status === 'unpaid') {
     await env.DB.prepare(
       `UPDATE licenses 
        SET status = 'inactive' 
        WHERE subscription_id = ?`
     ).bind(subscriptionId).run();
   }
   ```

---

## Database Schema

### Tables Overview

1. **`users`**: User email and metadata
2. **`customers`**: Stripe customer IDs linked to emails
3. **`subscriptions`**: Stripe subscription records
4. **`subscription_items`**: Individual subscription items (sites)
5. **`licenses`**: Generated license keys
6. **`payments`**: Payment records
7. **`magic_link_tokens`**: (Legacy table - not used with code verification)
8. **`sites`**: Site domain records (legacy)

### Key Relationships

```
users (email)
  └── customers (customer_id, user_email)
       └── subscriptions (subscription_id, customer_id)
            └── subscription_items (item_id, subscription_id, site_domain)
                 └── licenses (license_key, item_id, site_domain)
```

---

## API Endpoints Reference

### Payment & Checkout
- `POST /create-checkout-session` - Create Stripe checkout session
- `POST /purchase-quantity` - Create quantity purchase checkout
- `POST /webhook` - Handle Stripe webhooks

### Authentication
- `GET /get-magic-link?session_id=xxx` - Get email from Stripe session (for success page redirect)

### Dashboard
- `GET /dashboard?email=xxx` - Get user dashboard data
- `GET /licenses?email=xxx` - Get user licenses

### Site Management
- `POST /add-sites-batch` - Add one or more sites
- `POST /remove-site` - Remove a site

### License Management
- `POST /activate-license` - Activate quantity license with site

---

## Error Handling

### Common Errors

1. **Payment Failed**
   - User redirected to cancel URL
   - No webhook sent
   - No database changes

2. **Webhook Verification Failed**
   - Returns `400 Bad Request`
   - Stripe retries webhook
   - Logs error for investigation

3. **Database Errors**
   - Transaction rollback (if supported)
   - Error logged
   - Webhook returns `200 OK` (prevents retries)
   - Manual intervention may be needed

4. **Authentication Errors**
   - `401 Unauthorized` returned
   - User redirected to login
   - Session cleared

5. **Rate Limiting**
   - `429 Too Many Requests`
   - Retry-After header set
   - Prevents abuse

---

## Summary

**Complete Flow:**
1. **Payment** → User initiates checkout → Stripe processes payment
2. **Webhook** → Backend saves payment, generates licenses, creates member, sends email
3. **Authentication** → User enters verification code → Memberstack authenticates
4. **Dashboard** → User accesses dashboard → Views sites and licenses
5. **Management** → User adds/removes sites → Purchases quantity licenses
6. **Updates** → Subscription changes → Webhooks sync database

**Key Features:**
- ✅ Automatic license generation
- ✅ Memberstack integration
- ✅ Code verification authentication
- ✅ Site management
- ✅ Quantity purchases
- ✅ Subscription sync
- ✅ Error handling
- ✅ Rate limiting

---

**Last Updated:** 2025-01-19  
**Version:** 1.0

