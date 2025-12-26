# Custom Magic Link with Memberstack - Feasibility Analysis

## ⚠️ Important Findings

### 1. `memberstack.setToken()` - **NOT VERIFIED**
The `setToken()` method mentioned in the implementation guide is **not found** in Memberstack's official documentation or SDK. This is a critical limitation.

**What we know:**
- Memberstack SDK v2 uses `window.memberstack` or `window.$memberstack`
- Common methods: `getCurrentMember()`, `open()`, `close()`, `login()`, `logout()`
- **No documented `setToken()` method found**

### 2. Memberstack Session Creation API - **UNCLEAR**
Memberstack's Admin API documentation doesn't clearly show a session creation endpoint.

**What we know:**
- ✅ Can create members: `POST /admin.memberstack.com/members`
- ✅ Can assign plans: Included in member creation
- ❓ Can create sessions: **Not clearly documented**

## 🎯 Two Possible Approaches

### **Approach A: Hybrid System (RECOMMENDED)**
Use custom magic links but redirect to Memberstack's passwordless flow:

```javascript
// Custom magic link handler
async function handleCustomMagicLink(token, env) {
  // 1. Verify token from KV
  const tokenData = await env.MAGIC_LINKS_KV.get(`token:${token}`);
  if (!tokenData) return { error: 'Invalid token' };
  
  const { email, memberId } = JSON.parse(tokenData);
  
  // 2. Redirect to Webflow login page with email
  // Memberstack SDK will handle passwordless automatically
  const redirectUrl = `${env.MEMBERSTACK_REDIRECT_URL}?email=${email}&auto_trigger=true`;
  
  return { redirect: redirectUrl };
}
```

**Pros:**
- ✅ Full control over email design
- ✅ Custom token system
- ✅ Still uses Memberstack for authentication
- ✅ Works with existing Memberstack SDK

**Cons:**
- ⚠️ Still requires Memberstack passwordless to be enabled
- ⚠️ User clicks link → redirected → Memberstack sends another email

### **Approach B: Full Custom System (EXPERIMENTAL)**
Try to create Memberstack sessions programmatically:

```javascript
// EXPERIMENTAL - May not work
async function createMemberstackSession(memberId, env) {
  // Option 1: Try session endpoint (if it exists)
  const res = await fetch(
    `https://admin.memberstack.com/members/${memberId}/sessions`,
    {
      method: 'POST',
      headers: {
        'X-API-KEY': env.MEMBERSTACK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
  
  // Option 2: Generate JWT token (requires knowing Memberstack's JWT secret)
  // This is NOT recommended as it's not documented
  
  return res.json();
}
```

**Pros:**
- ✅ Single email (no redirect)
- ✅ Full control

**Cons:**
- ❌ `setToken()` method not verified
- ❌ Session API not documented
- ❌ May break with Memberstack updates
- ❌ Security concerns

## 📋 Recommended Implementation: Hybrid Approach

### Step 1: Create Custom Magic Link System

```javascript
// In src/index.js - Add to webhook handler after member creation
async function sendCustomMagicLink(email, memberId, env) {
  // Generate secure token
  const token = generateSecureToken();
  
  // Store in KV (expires in 1 hour)
  const tokenData = {
    email: email,
    memberId: memberId,
    expiresAt: Date.now() + (60 * 60 * 1000)
  };
  
  await env.MAGIC_LINKS_KV.put(
    `token:${token}`,
    JSON.stringify(tokenData),
    { expirationTtl: 3600 }
  );
  
  // Create magic link
  const magicLink = `${env.BASE_URL}/magic-link-handler?token=${token}`;
  
  // Send email via Resend
  await sendEmail(
    email,
    'Your Magic Login Link',
    `
      <h1>Welcome!</h1>
      <p>Click the link below to log in:</p>
      <a href="${magicLink}">Login to Dashboard</a>
      <p>This link expires in 1 hour.</p>
    `,
    env
  );
}

function generateSecureToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
```

### Step 2: Add Magic Link Handler Route

```javascript
// In src/index.js - Add to fetch handler
if (request.method === 'GET' && pathname === '/magic-link-handler') {
  return handleMagicLink(request, env);
}

async function handleMagicLink(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  
  if (!token) {
    return new Response("Token missing", { status: 400 });
  }
  
  // Get token from KV
  const tokenDataStr = await env.MAGIC_LINKS_KV.get(`token:${token}`);
  if (!tokenDataStr) {
    return new Response("Invalid or expired token", { status: 400 });
  }
  
  const tokenData = JSON.parse(tokenDataStr);
  const { email, memberId } = tokenData;
  
  // Delete used token
  await env.MAGIC_LINKS_KV.delete(`token:${token}`);
  
  // Redirect to Webflow login page with email
  // Memberstack SDK will automatically trigger passwordless
  const redirectUrl = `${env.MEMBERSTACK_REDIRECT_URL}?email=${encodeURIComponent(email)}&auto_trigger=true`;
  
  return Response.redirect(redirectUrl, 302);
}
```

### Step 3: Update Webflow Login Page

The existing `webflow-login-page-code-visible.html` already handles the `email` parameter and triggers passwordless automatically.

## 🔧 Setup Requirements

### 1. Create Cloudflare KV Namespace
```powershell
wrangler kv:namespace create "MAGIC_LINKS_KV"
# Add binding to wrangler.toml:
# [[kv_namespaces]]
# binding = "MAGIC_LINKS_KV"
# id = "your-namespace-id"
```

### 2. Environment Variables
- `MAGIC_LINKS_KV` (KV namespace binding)
- `MEMBERSTACK_REDIRECT_URL` (already configured)
- `RESEND_API_KEY` (already configured)

## ✅ Final Recommendation

**Use Approach A (Hybrid System)** because:
1. ✅ Works with existing Memberstack infrastructure
2. ✅ No undocumented APIs
3. ✅ Full control over email design
4. ✅ Secure token system
5. ✅ Compatible with Memberstack SDK

**The flow:**
1. Payment → Create Memberstack member
2. Generate custom token → Store in KV
3. Send custom email with magic link
4. User clicks link → Verify token
5. Redirect to Webflow with email parameter
6. Memberstack SDK triggers passwordless automatically
7. User receives Memberstack magic link email
8. User clicks Memberstack link → Logged in

**Note:** This creates two emails (your custom one + Memberstack's), but gives you full control over the first email's design.

## 🚀 Alternative: Single Email Solution

If you want only ONE email (your custom one), you would need to:
1. Find Memberstack's session creation API (if it exists)
2. Verify `setToken()` method works
3. Test extensively

This is **experimental** and may break with Memberstack updates.

