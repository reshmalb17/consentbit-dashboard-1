/*
Cloudflare Worker (module) - Stripe Checkout + Dashboard user mgmt
Deploy: Cloudflare Workers (Wrangler v3) or Pages Functions

Bindings required (set in your worker's environment):
- STRIPE_SECRET_KEY: your Stripe secret key
- STRIPE_WEBHOOK_SECRET: your Stripe webhook signing secret (optional but recommended)
- JWT_SECRET: HMAC secret for magic links / session tokens
- SESSION_KV (KV namespace binding) - Only for session tokens
- RESEND_API_KEY: Resend API key for sending emails (required for email functionality)
- EMAIL_FROM: (optional) from address for Resend emails (defaults to 'onboarding@resend.dev')
- BASE_URL: (optional) Base URL for magic links (defaults to request origin, e.g., 'https://consentbit-dashboard-test.web-8fb.workers.dev')
- MEMBERSTACK_SECRET_KEY: (optional) Memberstack admin secret key for /memberstack-webhook
  - Test Mode Keys: Start with 'sk_sb_' (development/testing)
  - Live Mode Keys: Start with 'sk_' (production)
  - Security: Store in environment variables, never commit to version control
  - Reference: https://developers.memberstack.com/admin-node-package/quick-start#installation-setup
- MEMBERSTACK_PLAN_ID: (optional) Memberstack plan ID to assign to users
- MEMBERSTACK_REDIRECT_URL: (optional) Redirect URL after Memberstack magic link login (defaults to dashboard: https://memberstack-login-test-713fa5.webflow.io/dashboard)
- MEMBERSTACK_LOGIN_URL: (optional) Webflow login page URL for triggering passwordless (defaults to: https://memberstack-login-test-713fa5.webflow.io/)

Notes:
- This Worker uses fetch to call Stripe REST API (no stripe-node dependency) so it runs cleanly on Workers.
- Email sending is implemented with Resend. If RESEND_API_KEY is not configured, emails will be logged to console for development.
- This is an illustrative starting point — add production hardening (rate limits, validation, logging, retries).

Endpoints implemented:
POST /create-checkout-session    -> create a Stripe Checkout Session (for multiple sites, single subscription with items)
POST /webhook                    -> handle Stripe webhooks (payment_intent.succeeded, checkout.session.completed, customer.subscription.updated)
POST /memberstack-webhook        -> Stripe → Memberstack integration (creates/updates Memberstack user, assigns plan, sends magic link)
POST /magic-link                 -> request a magic login link (creates a session token and returns a link)
GET  /auth/callback?token=...    -> verifies token and sets session cookie (redirects to dashboard URL)
GET  /dashboard                  -> returns the user's sites and billing info (requires session cookie)
POST /add-site                   -> add a site (create subscription_item)
POST /remove-site                -> remove a site (delete subscription_item)

Database usage (schema):
- All user data stored in D1 database tables (users, customers, subscriptions, subscription_items, pending_sites, licenses, payments, sites)
- No KV storage needed for user data - everything is in D1 
    email: string,
    customers: [
      {
        customerId: string,
        subscriptions: [
          {
            subscriptionId: string,
            status: string,
            items: [
              {
                item_id: string,
                site: string,  // Actual site name/domain
                price: string,
                quantity: number,
                status: string,
                created_at: number
              }
            ],
            created_at: number
          }
        ]
      }
    ],
    licenses: [...],
    pendingSites: [...],
    updated_at: number
  }
- SESSION_KV: key `session:{token}` => JSON { customerId, email, expires }

Deployment:
1. wrangler init
2. configure bindings in wrangler.toml
3. wrangler publish

*/

const STRIPE_BASE = 'https://api.stripe.com/v1';

// Import transaction manager for ACID-like consistency
// Note: Cloudflare Workers don't support ES6 imports from local files in the same way
// We'll inline the transaction logic or use a different approach

// Generate a random license key (internal function - use generateUniqueLicenseKey or generateLicenseKeys instead)
function generateLicenseKey() {
  // Generate a random license key format: KEY-XXXX-XXXX-XXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  const segments = [4, 4, 4, 4];
  const key = segments.map(segLen => {
    let segment = '';
    for (let i = 0; i < segLen; i++) {
      segment += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return segment;
  }).join('-');
  return `KEY-${key}`;
}
// Enqueue site purchase job (Use Case 2 -> process later from sitesqueue)
async function enqueueSiteQueueItem(env, {
  customerId,
  userEmail,
  subscriptionId,
  sites,
  billingPeriod,
  priceId,
  paymentIntentId,
}) {
  if (!env.DB) {
    console.warn('[USE CASE 2 - QUEUE] No DB configured, skipping enqueue');
    return null;
  }

  const queueId = `sitequeue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sitesJson = JSON.stringify(sites || []);

  const res = await env.DB.prepare(`
    INSERT INTO sitesqueue (
      queueid,
      customerid,
      useremail,
      subscriptionid,
      paymentintentid,
      priceid,
      sites_json,
      billingperiod,
      status,
      createdat,
      updatedat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    queueId,
    customerId,
    userEmail.toLowerCase().trim(),
    subscriptionId || null,
    paymentIntentId || null,
    priceId || null,
    sitesJson,
    billingPeriod || null,
    'pending',
    timestamp,
    timestamp
  ).run();

  if (!res.success) {
    console.error('[USE CASE 2 - QUEUE] Failed to enqueue site job', res);
    return null;
  }

  console.log('[USE CASE 2 - QUEUE] Enqueued site job', queueId, 'for', sites.length, 'site(s)');
  return queueId;
}


// Helper: map billing_period -> Stripe price id
function getPriceIdForSite(env, billingPeriod) {
  if (billingPeriod === 'yearly') return env.STRIPE_SITE_YEARLY_PRICE_ID;
  return env.STRIPE_SITE_MONTHLY_PRICE_ID;
}


function getSitePriceId(env, billingPeriod) {
  if (billingPeriod === 'yearly') return env.STRIPE_SITE_YEARLY_PRICE_ID;
  return env.STRIPE_SITE_MONTHLY_PRICE_ID;
}



// Generate a single unique license key with database check
async function generateTempLicenseKeys(quantity) {
  return Array.from({ length: quantity }, (_, i) => {
    return `L${i + 1}`;
  });
}

// Check if a license key is temporary (placeholder)
function isTemporaryLicenseKey(key) {
  if (!key || typeof key !== 'string') return false;
  // Temporary keys start with "L" followed by numbers (e.g., "L1", "L2", "L10")
  // or start with "TEMP-" (e.g., "TEMP-1", "TEMP-2")
  return /^L\d+$/.test(key) || /^TEMP-/.test(key);
}

// Generate a single unique license key with database check
async function generateUniqueLicenseKey(env) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const makeKey = () =>
    'KEY-' +
    Array.from({ length: 4 })
      .map(() =>
        Array.from({ length: 4 })
          .map(() => chars[Math.floor(Math.random() * chars.length)])
          .join('')
      )
      .join('-');

  for (let i = 0; i < 50; i++) {
    const key = makeKey();

    if (!env?.DB) return key;

    const exists = await env.DB.prepare(
      'SELECT license_key FROM licenses WHERE license_key = ? LIMIT 1'
    ).bind(key).first();

    if (!exists) return key;
  }

  throw new Error('Failed to generate unique license key');
}

// Generate multiple license keys with uniqueness check
async function handleCreateSiteCheckout(request, env) {
  const url = new URL(request.url);

  console.log('[CREATE-SITE-CHECKOUT] 📥 Request received');

  /* ─────────────────────────────
     PARSE BODY
  ───────────────────────────── */
  let body;
  try {
    body = await request.json();
    console.log('[CREATE-SITE-CHECKOUT] 📋 Request body:', {
      email: body.email ? 'provided' : 'not provided',
      billing_period: body.billing_period,
      sites: Array.isArray(body.sites) ? body.sites.length : 0,
    });
  } catch (err) {
    console.error('[CREATE-SITE-CHECKOUT] ❌ Error parsing request body:', err);
    return jsonResponse(400, {
      error: 'invalid_request',
      message: 'Invalid JSON in request body',
    }, true, request);
  }

  const { email: emailParam, sites, billing_period: billingPeriodParam } = body;
  const sitesArray = Array.isArray(sites) ? sites : [];

  if (!sitesArray.length) {
    console.log('[CREATE-SITE-CHECKOUT] ❌ No sites provided');
    return jsonResponse(400, {
      error: 'missing_sites',
      message: 'At least one site is required',
    }, true, request);
  }

  /* ─────────────────────────────
     AUTH / EMAIL (same as purchase-quantity)
  ───────────────────────────── */
  let email = emailParam?.toLowerCase().trim();

  if (!email) {
    const cookie = request.headers.get('cookie') || '';
    const match = cookie.match(/sb_session=([^;]+)/);
    if (!match) {
      return jsonResponse(401, { error: 'unauthenticated' }, true, request);
    }

    const payload = await verifyToken(env, match[1]);
    if (!payload?.email) {
      return jsonResponse(401, { error: 'invalid_session' }, true, request);
    }

    email = payload.email;
  }

  if (!email.includes('@')) {
    console.log('[CREATE-SITE-CHECKOUT] ❌ Invalid email format:', email);
    return jsonResponse(400, { error: 'invalid_email' }, true, request);
  }

  console.log('[CREATE-SITE-CHECKOUT] ✅ Email validated:', email);

  /* ─────────────────────────────
     LOAD USER & CUSTOMER (exactly like purchase-quantity)
  ───────────────────────────── */
  console.log('[CREATE-SITE-CHECKOUT] 🔍 Loading user from database...');
  const user = await getUserByEmail(env, email);

  if (!user?.customers?.length) {
    console.log('[CREATE-SITE-CHECKOUT] ❌ No customer found for email:', email);
    return jsonResponse(400, {
      error: 'no_customer',
      message: 'Customer account required',
    }, true, request);
  }

  console.log('[CREATE-SITE-CHECKOUT] ✅ User found with', user.customers.length, 'customer(s)');

  let customerId = null;
  if (user.customers && user.customers.length > 0) {
    customerId = user.customers[0].customerId;
  }

  if (!customerId) {
    return jsonResponse(400, {
      error: 'no_customer',
      message: 'Customer account required',
    }, true, request);
  }

  /* ─────────────────────────────
     PRICE CONFIG (reuse purchase-quantity logic)
  ───────────────────────────── */
  if (!billingPeriodParam) {
    console.log('[CREATE-SITE-CHECKOUT] ❌ Billing period not provided');
    return jsonResponse(400, {
      error: 'billing_period_required',
      message: 'billing_period is required. Please provide "monthly" or "yearly".',
    }, true, request);
  }

  const normalizedPeriod = billingPeriodParam.toLowerCase().trim();
  console.log('[CREATE-SITE-CHECKOUT] 📅 Billing period:', normalizedPeriod);

  let productId, unitAmount, currency;
  if (normalizedPeriod === 'monthly') {
    productId = env.MONTHLY_PRODUCT_ID || env.MONTHLY_LICENSE_PRODUCT_ID || 'prod_TiX0VbsXQSm4N5';
    unitAmount = parseInt(env.MONTHLY_UNIT_AMOUNT || env.MONTHLY_LICENSE_UNIT_AMOUNT || '800');
    currency = env.MONTHLY_CURRENCY || env.CURRENCY || 'usd';
    console.log('[CREATE-SITE-CHECKOUT] 💰 Monthly config:', { productId, unitAmount, currency });
  } else if (normalizedPeriod === 'yearly') {
    productId = env.YEARLY_PRODUCT_ID || env.YEARLY_LICENSE_PRODUCT_ID || 'prod_TiX0CF9K1RSRyb';
    unitAmount = parseInt(env.YEARLY_UNIT_AMOUNT || env.YEARLY_LICENSE_UNIT_AMOUNT || '7200');
    currency = env.YEARLY_CURRENCY || env.CURRENCY || 'usd';
    console.log('[CREATE-SITE-CHECKOUT] 💰 Yearly config:', { productId, unitAmount, currency });
  } else {
    console.log('[CREATE-SITE-CHECKOUT] ❌ Invalid billing period:', billingPeriodParam);
    return jsonResponse(400, {
      error: 'invalid_billing_period',
      message: `Invalid billing_period: ${billingPeriodParam}. Must be "monthly" or "yearly".`,
    }, true, request);
  }

  if (!productId) {
    console.log('[CREATE-SITE-CHECKOUT] ❌ Product ID not configured for:', normalizedPeriod);
    return jsonResponse(500, {
      error: 'product_id_not_configured',
      message: `${normalizedPeriod.charAt(0).toUpperCase() + normalizedPeriod.slice(1)} product ID not configured.`,
    }, true, request);
  }

  const storedUnitAmount = unitAmount;
  const storedCurrency = currency;
  console.log(`[CREATE-SITE-CHECKOUT] ✅ Price config loaded (${normalizedPeriod}):`, {
    productId,
    storedUnitAmount,
    storedCurrency,
  });

  /* ─────────────────────────────
     STEP 1: CALCULATE AMOUNT (like purchase-quantity)
  ───────────────────────────── */
  const totalSites = sitesArray.length;
  let totalAmount = storedUnitAmount * totalSites;
  let invoiceCurrency = storedCurrency || 'usd';

  console.log(`[CREATE-SITE-CHECKOUT] Using unit_amount from env: ${storedUnitAmount}, sites: ${totalSites}, total: ${totalAmount}`);

  /* ─────────────────────────────
     STEP 2: PREPARE METADATA FOR AFTER PAYMENT
  ───────────────────────────── */
  try {
    await stripeFetch(env, `/customers/${customerId}`, 'POST', {
      'metadata[sites_pending]': JSON.stringify(sitesArray),
      'metadata[usecase]': 'sites',
      'metadata[billing_period]': normalizedPeriod,
    }, true);
  } catch (metadataErr) {
    console.warn('[CREATE-SITE-CHECKOUT] ⚠️ Failed to store metadata in customer:', metadataErr);
    // Non-critical
  }

  /* ─────────────────────────────
     STEP 3: CREATE CHECKOUT SESSION (mode: payment, like purchase-quantity)
  ───────────────────────────── */
  const dashboardUrl =
    env.MEMBERSTACK_REDIRECT_URL ||
    'https://memberstack-login-test-713fa5.webflow.io/dashboard';

  const form = {
    mode: 'payment', // one-time payment, subscriptions created later in webhook
    customer: customerId,
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': invoiceCurrency,
    'line_items[0][price_data][unit_amount]': totalAmount,
    'line_items[0][price_data][product]': productId,
    'line_items[0][quantity]': 1,
    'payment_intent_data[metadata][usecase]': 'sites',
    'payment_intent_data[metadata][customer_id]': customerId,
    'payment_intent_data[metadata][billing_period]': normalizedPeriod,
    'payment_intent_data[metadata][sites_json]': JSON.stringify(sitesArray),
    'payment_intent_data[metadata][currency]': invoiceCurrency,
    'payment_intent_data[setup_future_usage]': 'off_session',
    'success_url': `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
    'cancel_url': dashboardUrl,
  };

  console.log('[CREATE-SITE-CHECKOUT] 💳 Creating Stripe checkout session...', {
    amount: totalAmount,
    currency: invoiceCurrency,
    totalSites,
    productId,
  });

  const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);

  if (session.status >= 400) {
    console.error('[CREATE-SITE-CHECKOUT] ❌ Checkout session creation failed:', {
      status: session.status,
      body: session.body,
    });

    return jsonResponse(500, {
      error: 'checkout_failed',
      message: 'Failed to create checkout session',
      details: session.body,
    }, true, request);
  }

  console.log('[CREATE-SITE-CHECKOUT] ✅ Checkout session created successfully:', {
    session_id: session.body.id,
    checkout_url: session.body.url ? 'present' : 'missing',
  });

  const response = {
    checkout_url: session.body.url,
    session_id: session.body.id,
    amount: totalAmount,
    currency: invoiceCurrency,
    sites: totalSites,
    billing_period: normalizedPeriod,
  };

  console.log('[CREATE-SITE-CHECKOUT] 📤 Returning response:', {
    has_checkout_url: !!response.checkout_url,
    session_id: response.session_id,
    sites: response.sites,
  });

  return jsonResponse(200, response, true, request);
}



async function generateTempLicenceKey(count) {
  
}

// Generate a secure random password for Memberstack members
// Members will use magic links to login, so password is just for API requirement
function generateRandomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  // Generate 32 character password
  for (let i = 0; i < 32; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Helper to get CORS headers with proper origin handling
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = [
    'https://memberstack-login-test-713fa5.webflow.io',
    'https://consentbit-dashboard-test.web-8fb.workers.dev',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://localhost:1337',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175'
  ];
  
  // If origin is in allowed list, use it; otherwise use wildcard (but won't work with credentials)
  // For localhost development, allow any localhost origin
  const isLocalhost = origin && origin.startsWith('http://localhost:');
  const corsOrigin = (origin && allowedOrigins.includes(origin)) || isLocalhost ? origin : '*';
  
  // Log for debugging
  if (origin && !allowedOrigins.includes(origin)) {
  } else if (origin) {
  } else {
  }
  
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  
  // Only set credentials header if using specific origin (not wildcard)
  if (corsOrigin !== '*') {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  
  return headers;
}

function jsonResponse(status, body, cors = true, request = null) {
  const headers = { 'content-type': 'application/json' };
  if (cors) {
    if (request) {
      const corsHeaders = getCorsHeaders(request);
      Object.assign(headers, corsHeaders);
    } else {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers
  });
}

function getEnvVar(env, key) {
  if (!env[key]) throw new Error(`Missing env var ${key}`);
  return env[key];
}

// Helper functions for email-based data structure
// Database-based user functions (replaces KV storage)
async function getUserByEmail(env, email) {
  if (!env.DB) {
    console.warn('Database not configured, cannot get user by email');
    return null;
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    // Get user
    const user = await env.DB.prepare(
      'SELECT email, created_at, updated_at FROM users WHERE email = ?'
    ).bind(normalizedEmail).first();
    
    if (!user) {
      return null;
    }
    
    // Get customers for this user
    const customersRes = await env.DB.prepare(
      'SELECT customer_id, created_at FROM customers WHERE user_email = ?'
    ).bind(normalizedEmail).all();
    
    const customers = [];
    
    if (customersRes && customersRes.results) {
      for (const customerRow of customersRes.results) {
        const customerId = customerRow.customer_id;
        
        // Get subscriptions for this customer
        // CRITICAL: Include billing_period in SELECT query
        const subscriptionsRes = await env.DB.prepare(
          'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_start, current_period_end, billing_period, created_at FROM subscriptions WHERE customer_id = ? AND user_email = ?'
        ).bind(customerId, normalizedEmail).all();
        
        const subscriptions = [];
        
        if (subscriptionsRes && subscriptionsRes.results) {
          for (const subRow of subscriptionsRes.results) {
            // Get items for this subscription
            const itemsRes = await env.DB.prepare(
              'SELECT item_id, site_domain, price_id, quantity, status, created_at, removed_at FROM subscription_items WHERE subscription_id = ?'
            ).bind(subRow.subscription_id).all();
            
            const items = [];
            if (itemsRes && itemsRes.results) {
              for (const itemRow of itemsRes.results) {
                // Get license for this site
                const licenseRes = await env.DB.prepare(
                  'SELECT license_key, status, created_at FROM licenses WHERE site_domain = ? AND subscription_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
                ).bind(itemRow.site_domain, subRow.subscription_id, 'active').first();
                
                items.push({
                  item_id: itemRow.item_id,
                  site: itemRow.site_domain,
                  price: itemRow.price_id,
                  quantity: itemRow.quantity,
                  status: itemRow.status,
                  created_at: itemRow.created_at,
                  license: licenseRes ? {
                    license_key: licenseRes.license_key,
                    status: licenseRes.status,
                    created_at: licenseRes.created_at
                  } : null
                });
              }
            }
            
            subscriptions.push({
              subscriptionId: subRow.subscription_id,
              status: subRow.status,
              cancel_at_period_end: subRow.cancel_at_period_end === 1,
              cancel_at: subRow.cancel_at,
              current_period_start: subRow.current_period_start,
              current_period_end: subRow.current_period_end,
              billingPeriod: subRow.billing_period || null, // CRITICAL: Load billing_period from database
              items: items,
              sitesCount: items.length,
              created_at: subRow.created_at
            });
          }
        }
        
        customers.push({
          customerId: customerId,
          subscriptions: subscriptions,
          created_at: customerRow.created_at
        });
      }
    }
    
    // Get pending sites
    // Use DISTINCT to prevent duplicate rows at database level
    // Also group by site_domain to ensure only one row per site (case-insensitive)
    const pendingSitesRes = await env.DB.prepare(
      `SELECT DISTINCT 
        subscription_id, 
        site_domain, 
        price_id, 
        quantity, 
        created_at 
      FROM pending_sites 
      WHERE user_email = ? 
      ORDER BY created_at DESC`
    ).bind(normalizedEmail).all();
    
    const pendingSites = [];
    const seenSites = new Set(); // Deduplicate by site domain (case-insensitive)
    if (pendingSitesRes && pendingSitesRes.results) {
      for (const psRow of pendingSitesRes.results) {
        const siteKey = (psRow.site_domain || '').toLowerCase().trim();
        if (!siteKey) {
          console.warn(`[getUserByEmail] ⚠️ Skipping pending site with empty domain`);
          continue;
        }
        
        if (!seenSites.has(siteKey)) {
          seenSites.add(siteKey);
          pendingSites.push({
            site: psRow.site_domain,
            price: psRow.price_id,
            quantity: psRow.quantity || 1,
            subscription_id: psRow.subscription_id,
            created_at: psRow.created_at
          });
        } else {
          // Duplicate found - log for audit but keep first occurrence
          console.warn(`[getUserByEmail] ⚠️ PAYMENT SAFETY: Skipping duplicate pending site "${psRow.site_domain}" to prevent duplicate charges`);
        }
      }
    }
    
    return {
      email: normalizedEmail,
      customers: customers,
      licenses: [], // Licenses are now fetched per item
      pendingSites: pendingSites,
      created_at: user.created_at,
      updated_at: user.updated_at
    };
  } catch (error) {
    console.error('Error getting user from database:', error);
    return null;
  }
}

async function saveUserByEmail(env, email, userData) {
  if (!env.DB) {
    return;
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  const timestamp = Math.floor(Date.now() / 1000);
  
  try {
    // Create or update user
    await env.DB.prepare(
      'INSERT OR IGNORE INTO users (email, created_at, updated_at) VALUES (?, ?, ?)'
    ).bind(normalizedEmail, timestamp, timestamp).run();
    
    await env.DB.prepare(
      'UPDATE users SET updated_at = ? WHERE email = ?'
    ).bind(timestamp, normalizedEmail).run();
    
    // Update customers
    if (userData.customers && Array.isArray(userData.customers)) {
      for (const customer of userData.customers) {
        // Create or update customer
        await env.DB.prepare(
          'INSERT OR IGNORE INTO customers (user_email, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)'
        ).bind(normalizedEmail, customer.customerId, timestamp, timestamp).run();
        
        // Update subscriptions
        // CRITICAL: INSERT OR REPLACE only affects the specific subscription_id (UNIQUE constraint)
        // This means we can safely add new subscriptions without affecting existing ones
        if (customer.subscriptions && Array.isArray(customer.subscriptions)) {
          for (const subscription of customer.subscriptions) {
            // Check if subscription already exists in database
            const existingSub = await env.DB.prepare(
              'SELECT subscription_id FROM subscriptions WHERE subscription_id = ?'
            ).bind(subscription.subscriptionId).first();
            
            const isNewSubscription = !existingSub;
            const billingPeriodValue = subscription.billingPeriod || subscription.billing_period || null;
            
            // Try to save with billing_period column (if it exists in schema)
            // INSERT OR REPLACE: INSERTs if subscription_id doesn't exist, REPLACEs if it does
            // Since subscription_id is UNIQUE, this only affects THIS subscription, not others
            try {
              await env.DB.prepare(
                `INSERT OR REPLACE INTO subscriptions 
                 (user_email, customer_id, subscription_id, status, cancel_at_period_end, cancel_at, 
                  current_period_start, current_period_end, billing_period, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                normalizedEmail,
                customer.customerId,
                subscription.subscriptionId,
                subscription.status || 'active',
                subscription.cancel_at_period_end ? 1 : 0,
                subscription.cancel_at || null,
                subscription.current_period_start || null,
                subscription.current_period_end || null,
                billingPeriodValue, // Use the extracted value explicitly
                subscription.created_at || timestamp,
                timestamp
              ).run();
            } catch (billingPeriodError) {
              // If billing_period column doesn't exist, save without it
              // Check for both error message formats: "no such column" and "has no column named"
              const errorMsg = billingPeriodError.message || '';
              if (errorMsg.includes('no such column: billing_period') || 
                  errorMsg.includes('has no column named billing_period') ||
                  errorMsg.includes('billing_period')) {
                await env.DB.prepare(
                  `INSERT OR REPLACE INTO subscriptions 
                   (user_email, customer_id, subscription_id, status, cancel_at_period_end, cancel_at, 
                    current_period_start, current_period_end, created_at, updated_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  normalizedEmail,
                  customer.customerId,
                  subscription.subscriptionId,
                  subscription.status || 'active',
                  subscription.cancel_at_period_end ? 1 : 0,
                  subscription.cancel_at || null,
                  subscription.current_period_start || null,
                  subscription.current_period_end || null,
                  subscription.created_at || timestamp,
                  timestamp
                ).run();
              } else {
                throw billingPeriodError; // Re-throw if it's a different error
              }
            }
            
            // Update subscription items
            if (subscription.items && Array.isArray(subscription.items)) {
              // Get billing_period and renewal_date from subscription
              const billingPeriod = subscription.billingPeriod || subscription.billing_period || null;
              const renewalDate = subscription.current_period_end || null;
              
              for (const item of subscription.items) {
                await env.DB.prepare(
                  `INSERT OR REPLACE INTO subscription_items 
                   (subscription_id, item_id, site_domain, price_id, quantity, status, billing_period, renewal_date, created_at, updated_at, removed_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  subscription.subscriptionId,
                  item.item_id,
                  item.site || item.site_domain,
                  item.price || item.price_id,
                  item.quantity || 1,
                  item.status || 'active',
                  billingPeriod,
                  renewalDate,
                  item.created_at || timestamp,
                  timestamp,
                  item.removed_at || null
                ).run();
              }
            }
          }
        }
      }
    }
    
    // Update pending sites
    // CRITICAL: Only sync if userData.pendingSites is explicitly provided
    // If not provided, don't touch the database (preserves existing pending sites)
    // IMPORTANT: The database is the source of truth - we sync FROM database TO user object, not the other way around
    // So when saving, we only update the database if userData.pendingSites is explicitly set
    console.log(`[saveUserByEmail] Checking pendingSites:`, {
      hasPendingSites: userData.pendingSites !== undefined,
      isArray: Array.isArray(userData.pendingSites),
      length: userData.pendingSites?.length,
      pendingSites: userData.pendingSites
    });
    
    if (userData.pendingSites !== undefined && Array.isArray(userData.pendingSites)) {
      // Get current pending sites from database (source of truth)
      const currentPendingSitesRes = await env.DB.prepare(
        'SELECT site_domain FROM pending_sites WHERE user_email = ?'
      ).bind(normalizedEmail).all();
      
      const currentPendingSites = new Set();
      if (currentPendingSitesRes && currentPendingSitesRes.results) {
        currentPendingSitesRes.results.forEach(row => {
          currentPendingSites.add(row.site_domain.toLowerCase().trim());
        });
      }
      
      console.log(`[saveUserByEmail] Current pending sites in DB: ${currentPendingSites.size}`);
      
      // Get user object pending sites
      const userPendingSites = new Set();
      userData.pendingSites.forEach(ps => {
        const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
        if (siteName) {
          userPendingSites.add(siteName);
        }
      });
      
      console.log(`[saveUserByEmail] User pending sites: ${userPendingSites.size}`);
      
      // Flatten pendingSites array to handle nested structures
      const flattenedPendingSites = [];
      userData.pendingSites.forEach(ps => {
        // Handle nested arrays or objects with pendingSites property
        if (Array.isArray(ps)) {
          // If element is an array, extract items
          ps.forEach(item => {
            if (item && typeof item === 'object') {
              flattenedPendingSites.push(item);
            } else if (typeof item === 'string') {
              // If it's just a string, convert to object
              flattenedPendingSites.push({ site: item, site_domain: item });
            }
          });
        } else if (ps && typeof ps === 'object' && ps.pendingSites) {
          // If object has pendingSites property, extract it
          if (Array.isArray(ps.pendingSites)) {
            flattenedPendingSites.push(...ps.pendingSites);
          } else {
            flattenedPendingSites.push(ps.pendingSites);
          }
        } else if (ps && typeof ps === 'object') {
          // Normal object, add as is
          flattenedPendingSites.push(ps);
        } else if (typeof ps === 'string') {
          // If it's just a string, convert to object
          flattenedPendingSites.push({ site: ps, site_domain: ps });
        }
      });
      
      // Find sites to delete (in database but not in user object)
      const sitesToDelete = [];
      currentPendingSites.forEach(site => {
        if (!userPendingSites.has(site)) {
          sitesToDelete.push(site);
        }
      });
      
      // Find sites to insert (in user object but not in database)
      // Use flattened array to avoid nested structures
      const sitesToInsert = [];
      flattenedPendingSites.forEach(ps => {
        const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
        if (siteName && !currentPendingSites.has(siteName)) {
          sitesToInsert.push(ps);
        }
      });
      
      console.log(`[saveUserByEmail] Sites to insert: ${sitesToInsert.length}, Sites to delete: ${sitesToDelete.length}`);
      
      // Delete sites that are in database but not in user object
      for (const siteToDelete of sitesToDelete) {
        const deleteResult = await env.DB.prepare(
          'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
        ).bind(normalizedEmail, siteToDelete).run();
        console.log(`[saveUserByEmail] 🗑️ Deleted pending site: ${siteToDelete}`, deleteResult.success ? '✅' : '❌');
      }
      
      // Insert sites that are in user object but not in database
      for (const pendingSite of sitesToInsert) {
        const siteName = pendingSite.site || pendingSite.site_domain;
        const sitePrice = pendingSite.price || pendingSite.price_id;
        try {
          const insertResult = await env.DB.prepare(
            'INSERT INTO pending_sites (user_email, subscription_id, site_domain, price_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(
            normalizedEmail,
            pendingSite.subscription_id || null,
            siteName,
            sitePrice,
            pendingSite.quantity || 1,
            pendingSite.created_at || timestamp
          ).run();
          
          if (insertResult.success) {
            console.log(`[saveUserByEmail] ✅ Inserted pending site: ${siteName} with price: ${sitePrice}`);
          } else {
            console.error(`[saveUserByEmail] ❌ Failed to insert pending site: ${siteName}`, insertResult);
          }
        } catch (insertErr) {
          console.error(`[saveUserByEmail] ❌ Error inserting pending site ${siteName}:`, insertErr);
        }
      }
      
      if (sitesToDelete.length > 0 || sitesToInsert.length > 0) {
        console.log(`[saveUserByEmail] ✅ Pending sites sync complete: ${sitesToInsert.length} inserted, ${sitesToDelete.length} deleted`);
      }
    } else {
      console.log(`[saveUserByEmail] ⚠️ Skipping pending sites sync: pendingSites is ${userData.pendingSites === undefined ? 'undefined' : 'not an array'}`);
    }
    // If userData.pendingSites is undefined, don't modify the database - keep existing pending sites
    
  } catch (error) {
    console.error('Error saving user to database:', error);
    throw error;
  }
}

async function addOrUpdateCustomerInUser(env, email, customerId, subscriptionId, items, billingPeriod = null) {
  console.log(`[addOrUpdateCustomerInUser] 🔍 Starting database update for subscription...`);
  console.log(`[addOrUpdateCustomerInUser]   - Email: ${email}`);
  console.log(`[addOrUpdateCustomerInUser]   - Customer ID: ${customerId}`);
  console.log(`[addOrUpdateCustomerInUser]   - Subscription ID: ${subscriptionId}`);
  console.log(`[addOrUpdateCustomerInUser]   - Items count: ${items.length}`);
  console.log(`[addOrUpdateCustomerInUser]   - Billing period: ${billingPeriod || 'not set'}`);
  
  let user = await getUserByEmail(env, email);
  
  if (!user) {
    console.log(`[addOrUpdateCustomerInUser]   - Creating new user structure...`);
    // Create new user structure with email as primary key
    user = {
      email: email.toLowerCase().trim(),
      customers: [],
      licenses: [],
      pendingSites: [],
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000)
    };
  } else {
    console.log(`[addOrUpdateCustomerInUser]   - User exists with ${user.customers?.length || 0} customer(s)`);
  }
  
  // Find or create customer
  let customer = user.customers.find(c => c.customerId === customerId);
  if (!customer) {
    console.log(`[addOrUpdateCustomerInUser]   - Creating new customer: ${customerId}`);
    customer = {
      customerId: customerId,
      subscriptions: [],
      created_at: Math.floor(Date.now() / 1000)
    };
    user.customers.push(customer);
  } else {
    console.log(`[addOrUpdateCustomerInUser]   - Customer exists with ${customer.subscriptions?.length || 0} subscription(s)`);
  }
  
  // Find or create subscription
  let subscription = customer.subscriptions.find(s => s.subscriptionId === subscriptionId);
  if (!subscription) {
    console.log(`[addOrUpdateCustomerInUser]   - Creating new subscription: ${subscriptionId}`);
    subscription = {
      subscriptionId: subscriptionId,
      status: 'active',
      items: [],
      billingPeriod: billingPeriod, // Add billing period if provided
      created_at: Math.floor(Date.now() / 1000)
    };
    customer.subscriptions.push(subscription);
  } else {
    console.log(`[addOrUpdateCustomerInUser]   - Subscription exists with ${subscription.items?.length || 0} item(s)`);
    // Update billing period if provided and not already set
    if (billingPeriod && !subscription.billingPeriod) {
      console.log(`[addOrUpdateCustomerInUser]   - Updating billing period: ${billingPeriod}`);
      subscription.billingPeriod = billingPeriod;
    }
  }
  
  // Add/update items (merge with existing, avoid duplicates)
  let newItemsCount = 0;
  let updatedItemsCount = 0;
  items.forEach((item, idx) => {
    const existingItem = subscription.items.find(i => i.item_id === item.item_id);
    if (existingItem) {
      // Update existing item
      console.log(`[addOrUpdateCustomerInUser]   - Updating existing item ${idx + 1}: ${item.item_id} (site: ${item.site || 'N/A'})`);
      Object.assign(existingItem, item);
      updatedItemsCount++;
    } else {
      // Add new item
      console.log(`[addOrUpdateCustomerInUser]   - Adding new item ${idx + 1}: ${item.item_id} (site: ${item.site || 'N/A'})`);
      subscription.items.push(item);
      newItemsCount++;
    }
  });
  console.log(`[addOrUpdateCustomerInUser]   - Items summary: ${newItemsCount} new, ${updatedItemsCount} updated`);
  
  // Update subscription status and timestamp
  subscription.status = 'active';
  subscription.updated_at = Math.floor(Date.now() / 1000);
  
  console.log(`[addOrUpdateCustomerInUser]   - Saving user object to database...`);
  await saveUserByEmail(env, email, user);
  console.log(`[addOrUpdateCustomerInUser] ✅ Database update complete for subscription ${subscriptionId}`);
  return user;
}

// Helper function to get user by customerId (uses database)
async function getUserByCustomerId(env, customerId) {
  if (!env.DB) {
    console.warn('Database not configured, cannot get user by customerId');
    return null;
  }
  
  try {
    // Find email for this customerId
    const customerRes = await env.DB.prepare(
      'SELECT user_email FROM customers WHERE customer_id = ? LIMIT 1'
    ).bind(customerId).first();
    
    if (!customerRes || !customerRes.user_email) {
      return null;
    }
    
    // Get user by email
    return await getUserByEmail(env, customerRes.user_email);
  } catch (error) {
    console.error('Error getting user by customerId from database:', error);
    return null;
  }
}

// Helper function to save or update site details in database
async function saveOrUpdateSiteInDB(env, siteData) {
  if (!env.DB) {
    return;
  }
  
  try {
    const {
      customerId,
      subscriptionId,
      itemId,
      siteDomain,
      priceId,
      amountPaid,
      currency = 'usd',
      status = 'active',
      currentPeriodStart,
      currentPeriodEnd,
      renewalDate,
      cancelAtPeriodEnd = false,
      canceledAt = null
    } = siteData;
    
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Check if site already exists
    const existing = await env.DB.prepare(
      'SELECT id FROM sites WHERE customer_id = ? AND subscription_id = ? AND site_domain = ?'
    ).bind(customerId, subscriptionId, siteDomain).first();
    
    if (existing) {
      // Update existing site
      await env.DB.prepare(
        `UPDATE sites SET
          item_id = ?,
          price_id = ?,
          amount_paid = ?,
          currency = ?,
          status = ?,
          current_period_start = ?,
          current_period_end = ?,
          renewal_date = ?,
          cancel_at_period_end = ?,
          canceled_at = ?,
          updated_at = ?
        WHERE customer_id = ? AND subscription_id = ? AND site_domain = ?`
      ).bind(
        itemId,
        priceId,
        amountPaid,
        currency,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        renewalDate,
        cancelAtPeriodEnd ? 1 : 0,
        canceledAt,
        timestamp,
        customerId,
        subscriptionId,
        siteDomain
      ).run();
    } else {
      // Insert new site
      await env.DB.prepare(
        `INSERT INTO sites (
          customer_id, subscription_id, item_id, site_domain, price_id,
          amount_paid, currency, status, current_period_start, current_period_end,
          renewal_date, cancel_at_period_end, canceled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        customerId,
        subscriptionId,
        itemId,
        siteDomain,
        priceId,
        amountPaid,
        currency,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        renewalDate,
        cancelAtPeriodEnd ? 1 : 0,
        canceledAt,
        timestamp,
        timestamp
      ).run();
    }
  } catch (error) {
    console.error('Error saving site to database:', error);
    // Don't throw - database save failure shouldn't break the flow
  }
}

/**
 * Helper function to extract billing_period from Stripe subscription
 * @param {Object} subscription - Stripe subscription object
 * @returns {string|null} - 'monthly', 'yearly', 'weekly', 'daily', or null
 */
function extractBillingPeriodFromStripe(subscription) {
  if (!subscription || !subscription.items || !subscription.items.data || subscription.items.data.length === 0) {
    return null;
  }
  
  const firstItem = subscription.items.data[0];
  if (firstItem.price && firstItem.price.recurring) {
    const interval = firstItem.price.recurring.interval;
    if (interval === 'month') {
      return 'monthly';
    } else if (interval === 'year') {
      return 'yearly';
    } else if (interval === 'week') {
      return 'weekly';
    } else if (interval === 'day') {
      return 'daily';
    } else {
      return interval; // fallback to raw value
    }
  }
  
  return null;
}

// Helper function to fetch license for a specific site
async function getLicenseForSite(env, siteDomain, customerId, subscriptionId) {
  if (!env.DB || !siteDomain) {
    return null;
  }
  
  try {
    // Try to find license by site_domain and subscription_id first (most specific)
    let license = await env.DB.prepare(
      'SELECT license_key, status, created_at FROM licenses WHERE site_domain = ? AND subscription_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(siteDomain, subscriptionId, 'active').first();
    
    // If not found, try with customer_id
    if (!license) {
      license = await env.DB.prepare(
        'SELECT license_key, status, created_at FROM licenses WHERE site_domain = ? AND customer_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(siteDomain, customerId, 'active').first();
    }
    
    if (license && license.license_key) {
      return {
        license_key: license.license_key,
        status: license.status || 'active',
        created_at: license.created_at
      };
    }
  } catch (error) {
    console.error('Error fetching license for site:', error);
  }
  
  return null;
}

// Helper function to fetch all licenses for multiple sites
async function getLicensesForSites(env, sites, customerId, subscriptionId) {
  if (!env.DB || !sites || sites.length === 0) {
    return {};
  }
  
  const licenseMap = {};
  
  try {
    // Fetch all licenses for this subscription
    const licenses = await env.DB.prepare(
      'SELECT license_key, site_domain, status, created_at FROM licenses WHERE subscription_id = ? AND status = ?'
    ).bind(subscriptionId, 'active').all();
    
    if (licenses && licenses.results) {
      licenses.results.forEach(license => {
        if (license.site_domain && license.license_key) {
          licenseMap[license.site_domain] = {
            license_key: license.license_key,
            status: license.status || 'active',
            created_at: license.created_at
          };
        }
      });
    }
  } catch (error) {
    console.error('Error fetching licenses for sites:', error);
  }
  
  return licenseMap;
}

// ============================================
// HIGH-SECURITY MAGIC LINK FUNCTIONS
// ============================================

// Generate cryptographically secure token (256 bits = 64 hex characters)
// REMOVED: Magic link utility functions - Not needed (Memberstack handles login)
// - generateSecureMagicLinkToken
// - checkRateLimit  
// - saveMagicLinkToken
// - verifyAndUseMagicLinkToken
// - logTokenAttempt
// - sendCustomMagicLinkEmail

// Utility: simple HMAC token (not a full JWT) for magic links
async function signToken(env, payload, expiresInSeconds = 60 * 60) {
  const secret = getEnvVar(env, 'JWT_SECRET');
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  payload.exp = exp;
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  ).then(key => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigBase64}`;
}

async function verifyToken(env, token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sigB64] = parts;
    const data = `${headerB64}.${bodyB64}`;
    const secret = getEnvVar(env, 'JWT_SECRET');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig = Uint8Array.from(atob(sigB64).split('').map(c => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(bodyB64));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Send email using Resend
async function sendEmail(to, subject, html, env) {
  
  if (!env.RESEND_API_KEY) {
    console.warn('⚠️ [sendEmail] RESEND_API_KEY not configured. Email not sent.');
    return { success: false, message: 'RESEND_API_KEY not configured' };
  }

  try {
    const emailPayload = {
      from: env.EMAIL_FROM || 'onboarding@resend.dev',
      to: to,
      subject: subject,
      html: html,
    };
    
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });


    if (!res.ok) {
      const errorText = await res.text();
      console.error('❌ [sendEmail] Resend API error response:', {
        status: res.status,
        statusText: res.statusText,
        body: errorText
      });
      throw new Error(`Email send failed: ${res.status} ${errorText}`);
    }

    const result = await res.json();
    return result;
  } catch (error) {
    console.error('❌ [sendEmail] Exception caught:', error);
    console.error('❌ [sendEmail] Error name:', error.name);
    console.error('❌ [sendEmail] Error message:', error.message);
    console.error('❌ [sendEmail] Error stack:', error.stack);
    throw error;
  }
}

// Fetch customer email from Stripe customer object
/**
 * Get price ID by billing period (monthly or yearly)
 * Checks database first, then falls back to environment variables
 */
// Get price_id and product_id from price_config table (optimized - no Stripe API call)
async function getPriceConfigByBillingPeriod(env, billingPeriod) {
  try {
    // Normalize billing period
    const normalizedPeriod = billingPeriod?.toLowerCase().trim();
    if (!normalizedPeriod || (normalizedPeriod !== 'monthly' && normalizedPeriod !== 'yearly')) {
      console.warn(`[getPriceConfigByBillingPeriod] Invalid billing period: ${billingPeriod}`);
      return null;
    }
    
    // Map to database price_type format
    const priceType = normalizedPeriod === 'monthly' ? 'monthly' : 'yearly';
    
    // Try database first
    if (env.DB) {
      try {
        // Get all available columns from price_config table
        // This handles cases where some columns might not exist yet
        const result = await env.DB.prepare(
          'SELECT * FROM price_config WHERE price_type = ? AND is_active = 1 LIMIT 1'
        ).bind(priceType).first();
        
        if (result) {
          // Extract available fields (handle missing columns gracefully)
          const config = {
            price_id: result.price_id || null,
            product_id: result.product_id || null,
            unit_amount: result.unit_amount || null,
            currency: result.currency || 'usd',
            discount_allowance: result.discount_allowance || null,
            discount_type: result.discount_type || null,
            coupon_code: result.coupon_code || null
          };
          
          // If price_id exists, return the config
          if (config.price_id) {
            console.log(`[getPriceConfigByBillingPeriod] Found config from database for ${priceType}:`, config);
            return config;
              } else {
            console.warn(`[getPriceConfigByBillingPeriod] Record found for ${priceType} but price_id is missing`);
          }
        }
      } catch (dbError) {
        console.warn(`[getPriceConfigByBillingPeriod] Database query failed:`, dbError);
        // If error is due to missing columns, try with basic query
        try {
          const basicResult = await env.DB.prepare(
            'SELECT price_id FROM price_config WHERE price_type = ? AND is_active = 1 LIMIT 1'
          ).bind(priceType).first();
          
          if (basicResult && basicResult.price_id) {
            console.log(`[getPriceConfigByBillingPeriod] Found price_id using basic query: ${basicResult.price_id}`);
            return {
              price_id: basicResult.price_id,
              product_id: null,
              unit_amount: null,
              currency: 'usd'
            };
          }
        } catch (basicError) {
          console.warn(`[getPriceConfigByBillingPeriod] Basic query also failed:`, basicError);
        }
      }
    }
    
    // Fallback to environment variables
    const fallbackPriceId = env.LICENSE_PRICE_ID || env.DEFAULT_PRICE_ID;
    if (fallbackPriceId) {
      console.log(`[getPriceConfigByBillingPeriod] Using fallback price_id from environment: ${fallbackPriceId}`);
      return { price_id: fallbackPriceId, product_id: null, unit_amount: null };
    }
    
    return null;
  } catch (error) {
    console.error(`[getPriceConfigByBillingPeriod] Error:`, error);
    return null;
  }
}

// Legacy function for backward compatibility
async function getPriceIdByBillingPeriod(env, billingPeriod) {
  const config = await getPriceConfigByBillingPeriod(env, billingPeriod);
  return config ? config.price_id : null;
}

async function getCustomerEmail(env, customerId) {
  try {
    const customerRes = await stripeFetch(env, `/customers/${customerId}`);
    if (customerRes.status === 200 && customerRes.body && customerRes.body.email) {
      return customerRes.body.email;
    } else {
      console.error(`[getCustomerEmail] Failed to fetch customer or email missing:`, customerRes.status);
      return null;
    }
  } catch (error) {
    console.error(`[getCustomerEmail] Error fetching customer:`, error);
    return null;
  }
}

// Basic auth cookie helper
// REMOVED: createSessionCookie - Only used by removed /auth/callback endpoint
function createSessionCookie_UNUSED(token, maxAge = 60 * 60 * 24 * 7) {
  const cookie = `sb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return cookie;
}

// Stripe helper using fetch
/**
 * Verify that payment was actually successful before marking invoice as paid
 * @param {Object} session - Stripe checkout session object
 * @param {Object} paymentIntent - Stripe payment intent object (optional, for payment mode)
 * @returns {boolean} - true if payment is verified as successful, false otherwise
 */
// Helper function to format site name with https:// prefix if needed
function formatSiteName(siteName) {
  if (!siteName) return null;
  const trimmed = siteName.trim();
  if (!trimmed) return null;
  
  // If already has http:// or https://, return as is
  if (trimmed.toLowerCase().startsWith('http://') || trimmed.toLowerCase().startsWith('https://')) {
    return trimmed;
  }
  
  // Otherwise, add https://
  return `https://${trimmed}`;
}

/**
 * Log Stripe webhook events to database for debugging and tracking
 * Stores logs in stripe_logs table in D1 database
 * @param {Object} env - Environment variables
 * @param {Object} event - Stripe webhook event object
 * @param {string} subscriptionId - Subscription ID (if available)
 * @param {string} customerId - Customer ID (if available)
 * @param {Object} additionalData - Additional data to log (status changes, etc.)
 */
async function logStripeEvent(env, event, subscriptionId = null, customerId = null, additionalData = {}) {
  try {
    if (!env.DB) {
      console.warn('[Stripe Log] Database not configured, skipping log storage');
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split('T')[0]; // YYYY-MM-DD
    const eventId = event.id || `evt_${timestamp}`;
    const eventType = event.type || 'unknown';
    
    // Extract subscription ID from event if not provided
    if (!subscriptionId && event.data?.object) {
      subscriptionId = event.data.object.subscription || 
                       event.data.object.id || 
                       event.data.object.subscription_id || 
                       null;
    }
    
    // Extract customer ID from event if not provided
    if (!customerId && event.data?.object) {
      customerId = event.data.object.customer || 
                   event.data.object.customer_id || 
                   null;
    }

    // Prepare event data for storage (store as JSON string)
    const eventData = {
      id: event.id,
      type: event.type,
      created: event.created,
      livemode: event.livemode,
      object: event.data?.object ? {
        id: event.data.object.id,
        object: event.data.object.object,
        status: event.data.object.status,
        cancel_at_period_end: event.data.object.cancel_at_period_end,
        canceled_at: event.data.object.canceled_at,
        current_period_end: event.data.object.current_period_end,
        current_period_start: event.data.object.current_period_start,
      } : null
    };

    // Store additional data as JSON string
    const additionalDataJson = JSON.stringify(additionalData);
    const eventDataJson = JSON.stringify(eventData);

    // Insert into stripe_logs table
    // Table schema: id (AUTOINCREMENT), timestamp, date, event_id, event_type, subscription_id, customer_id, event_data (TEXT/JSON), additional_data (TEXT/JSON), created_at
    await env.DB.prepare(
      `INSERT INTO stripe_logs 
       (timestamp, date, event_id, event_type, subscription_id, customer_id, event_data, additional_data, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      timestamp,
      date,
      eventId,
      eventType,
      subscriptionId,
      customerId,
      eventDataJson,
      additionalDataJson,
      timestamp
    ).run();
    
    console.log(`[Stripe Log] ✅ Logged event ${eventType} for subscription ${subscriptionId || 'N/A'} at ${date} ${new Date(timestamp * 1000).toISOString()}`);
  } catch (error) {
    console.error('[Stripe Log] ❌ Error logging Stripe event:', error);
    // Don't throw - logging failures shouldn't break webhook processing
    // If table doesn't exist, log warning but continue
    if (error.message && error.message.includes('no such table: stripe_logs')) {
      console.warn('[Stripe Log] ⚠️ stripe_logs table does not exist. Please run the migration to create it.');
    }
  }
}

// Helper function to save subscription data to KV storage
async function saveSubscriptionToKV(env, customerId, subscriptionId, email, siteName, subscriptionStatus = 'complete', paymentStatus = 'paid', cancelAtPeriodEnd = false) {
  try {
    if (!env.ACTIVE_SITES_CONSENTBIT || !env.SUBSCRIPTION_CONSENTBIT) {
      console.warn('[KV] KV namespaces not configured, skipping KV storage');
      return;
    }
    
    const now = new Date().toISOString();
    const formattedSiteName = formatSiteName(siteName);
    
    if (!formattedSiteName) {
      console.warn('[KV] No site name provided, skipping KV storage');
      return;
    }
    
    // Save to ACTIVE_SITES_CONSENTBIT with fixed ID: 66c7aa5c7fcb4c2a8dfec5463e86a293
    const activeSitesData = {
      active: subscriptionStatus === 'complete' || subscriptionStatus === 'active',
      subscriptionId: subscriptionId,
      customerId: customerId,
      email: email,
      status: subscriptionStatus,
      lastUpdated: now,
      cancelAtPeriodEnd: cancelAtPeriodEnd
    };
    
    await env.ACTIVE_SITES_CONSENTBIT.put('66c7aa5c7fcb4c2a8dfec5463e86a293', JSON.stringify(activeSitesData));
    console.log('[KV] ✅ Saved to ACTIVE_SITES_CONSENTBIT with ID: 66c7aa5c7fcb4c2a8dfec5463e86a293');
    
    // Save to SUBSCRIPTION_CONSENTBIT with key: customerId-subscriptionId
    const subscriptionKey = `${customerId}-${subscriptionId}`;
    const subscriptionData = {
      email: email,
      connectDomain: formattedSiteName,
      isSubscribed: subscriptionStatus === 'complete' || subscriptionStatus === 'active',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: subscriptionStatus,
      paymentStatus: paymentStatus,
      created: now,
      lastUpdated: now
    };
    
    await env.SUBSCRIPTION_CONSENTBIT.put(subscriptionKey, JSON.stringify(subscriptionData));
    console.log(`[KV] ✅ Saved to SUBSCRIPTION_CONSENTBIT with key: ${subscriptionKey}`);
    
  } catch (error) {
    console.error('[KV] ❌ Error saving to KV storage:', error);
    // Don't throw - KV storage is optional, don't fail the main operation
  }
}

// Helper function to save license key data to KV storage (for quantity purchases)
async function saveLicenseKeyToKV(env, licenseKey, customerId, subscriptionId, email, subscriptionStatus = 'complete', cancelAtPeriodEnd = false, siteName = null) {
  try {
    if (!env.ACTIVE_SITES_CONSENTBIT) {
      console.warn('[KV] ACTIVE_SITES_CONSENTBIT namespace not configured, skipping KV storage');
      return;
    }
    
    const now = new Date().toISOString();
    
    const activeSitesData = {
      active: subscriptionStatus === 'complete' || subscriptionStatus === 'active',
      subscriptionId: subscriptionId,
      customerId: customerId,
      email: email,
      status: subscriptionStatus,
      lastUpdated: now,
      cancelAtPeriodEnd: cancelAtPeriodEnd
    };
    
    // If site name is provided (license key is activated), use connectDomain as the KV key
    if (siteName) {
      const formattedSiteName = formatSiteName(siteName);
      if (formattedSiteName) {
        activeSitesData.connectDomain = formattedSiteName;
        
        // Use connectDomain as the KV key instead of license key
        await env.ACTIVE_SITES_CONSENTBIT.put(formattedSiteName, JSON.stringify(activeSitesData));
        console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${formattedSiteName} (connectDomain)`);
        
        // Delete old KV entry if it was keyed by license key (for backward compatibility)
        // Note: This is a safety check - the activate-license endpoint also deletes old entries
        try {
          const oldEntry = await env.ACTIVE_SITES_CONSENTBIT.get(licenseKey);
          if (oldEntry) {
            await env.ACTIVE_SITES_CONSENTBIT.delete(licenseKey);
            console.log(`[KV] 🗑️ Deleted old KV entry keyed by license key: ${licenseKey}`);
          }
        } catch (deleteErr) {
          // Entry might not exist or already deleted - that's okay
          // Non-critical, continue
        }
      } else {
        // If formatting failed, fall back to license key as the key
        await env.ACTIVE_SITES_CONSENTBIT.put(licenseKey, JSON.stringify(activeSitesData));
        console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${licenseKey} (fallback)`);
      }
    } else {
      // If no site name, use license key as the key (license not activated yet)
      await env.ACTIVE_SITES_CONSENTBIT.put(licenseKey, JSON.stringify(activeSitesData));
      console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${licenseKey} (not activated)`);
    }
    
  } catch (error) {
    console.error('[KV] ❌ Error saving license key to KV storage:', error);
    // Don't throw - KV storage is optional, don't fail the main operation
  }
}

function verifyPaymentSuccess(session, paymentIntent = null) {
  // Verify checkout session payment status
  if (session.payment_status !== 'paid') {
    console.warn(`[verifyPaymentSuccess] ❌ Session payment_status is '${session.payment_status}', not 'paid'`);
    return false;
  }
  
  // Verify checkout session status
  if (session.status !== 'complete') {
    console.warn(`[verifyPaymentSuccess] ❌ Session status is '${session.status}', not 'complete'`);
    return false;
  }
  
  // For payment mode, also verify payment intent status
  if (session.mode === 'payment' && paymentIntent) {
    if (paymentIntent.status !== 'succeeded') {
      console.warn(`[verifyPaymentSuccess] ❌ PaymentIntent status is '${paymentIntent.status}', not 'succeeded'`);
      return false;
    }
  }
  
  // All checks passed
  return true;
}

// ========================================
// QUEUE-BASED PROCESSING FUNCTIONS
// ========================================

/**
 * Add subscription creation task to queue
 * Used for large quantity purchases to prevent webhook timeouts
 */
async function addToSubscriptionQueue(env, queueData) {
  const {
    customerId,
    userEmail,
    paymentIntentId,
    priceId,
    licenseKey,
    quantity,
    trialEnd
  } = queueData;
  
  const queueId = `queue_${paymentIntentId}_${licenseKey}_${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  
  try {
    // CRITICAL: Check if a queue item with the same payment_intent_id and license_key already exists
    // This prevents duplicate queue entries if the webhook is called multiple times
    const existingQueueItem = await env.DB.prepare(
      `SELECT queue_id, status FROM subscription_queue 
       WHERE payment_intent_id = ? AND license_key = ? 
       AND status IN ('pending', 'processing', 'completed')
       LIMIT 1`
    ).bind(paymentIntentId, licenseKey).first();
    
    if (existingQueueItem) {
      console.log(`[QUEUE] ⚠️ Queue item already exists for payment_intent_id=${paymentIntentId}, license_key=${licenseKey} (status: ${existingQueueItem.status}, queue_id: ${existingQueueItem.queue_id}). Skipping duplicate entry.`);
      return { success: true, queueId: existingQueueItem.queue_id, skipped: true, reason: 'duplicate' };
    }
    
    await env.DB.prepare(
      `INSERT INTO subscription_queue 
       (queue_id, customer_id, user_email, payment_intent_id, price_id, license_key, quantity, trial_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      queueId,
      customerId,
      userEmail,
      paymentIntentId,
      priceId,
      licenseKey,
      quantity,
      trialEnd || null,
      timestamp,
      timestamp
    ).run();
    
    return { success: true, queueId };
  } catch (error) {
    console.error(`[QUEUE] ❌ Error adding to queue:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Process a single subscription from the queue
 */
async function processQueueItem(env, queueItem) {
  const {
    queue_id,
    customer_id,
    user_email,
    payment_intent_id,
    price_id,
    license_key: originalLicenseKey,
    trial_end
  } = queueItem;
  
  // STEP: Replace temporary license key with real unique key if needed
  let license_key = originalLicenseKey;
  if (isTemporaryLicenseKey(originalLicenseKey)) {
    console.log(`[USE CASE 3 - QUEUE] 🔄 Replacing temporary license key "${originalLicenseKey}" with real unique key...`);
    license_key = await generateUniqueLicenseKey(env);
    console.log(`[USE CASE 3 - QUEUE] ✅ Replaced temporary key "${originalLicenseKey}" with real key "${license_key}"`);
    
    // Update the queue item with the real license key
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `UPDATE subscription_queue SET license_key = ?, updated_at = ? WHERE queue_id = ?`
      ).bind(license_key, timestamp, queue_id).run();
      console.log(`[USE CASE 3 - QUEUE] ✅ Updated queue item with real license key`);
    } catch (updateErr) {
      console.warn(`[USE CASE 3 - QUEUE] ⚠️ Could not update queue item with real license key:`, updateErr);
      // Continue anyway - we'll use the real key for subscription creation
    }
  }
  
  console.log(`[USE CASE 3 - QUEUE] 🔍 Processing queue item for license: ${license_key}`);
  console.log(`[USE CASE 3 - QUEUE] 📋 Queue Details:`, {
    queue_id,
    customer_id,
    user_email,
    payment_intent_id,
    price_id,
    license_key,
    original_license_key: originalLicenseKey !== license_key ? originalLicenseKey : null,
    trial_end: trial_end ? new Date(trial_end * 1000).toISOString() : null
  });
  
  try {
    // CRITICAL: Check if subscription already exists for this license (may have been created immediately)
    // Also check if another queue item for this license_key has already been processed
    // This prevents race conditions when multiple queue items exist for the same license_key
    let existingSubscriptionId = null;
    let existingItemId = null;
    try {
      // First check: Look for existing license with subscription in licenses table
      const existingLicense = await env.DB.prepare(
        `SELECT subscription_id, item_id FROM licenses WHERE license_key = ? AND subscription_id IS NOT NULL LIMIT 1`
      ).bind(license_key).first();
      
      if (existingLicense && existingLicense.subscription_id) {
        existingSubscriptionId = existingLicense.subscription_id;
        existingItemId = existingLicense.item_id || null;
        console.log(`[USE CASE 3 - QUEUE] ✅ Subscription already exists for license ${license_key}: ${existingSubscriptionId}`);
      } else {
        // Second check: Look for completed queue items for this license_key (to catch race conditions)
        const completedQueueItem = await env.DB.prepare(
          `SELECT subscription_id, item_id FROM subscription_queue 
           WHERE license_key = ? AND status = 'completed' AND subscription_id IS NOT NULL
           ORDER BY processed_at DESC LIMIT 1`
        ).bind(license_key).first();
        
        if (completedQueueItem && completedQueueItem.subscription_id) {
          existingSubscriptionId = completedQueueItem.subscription_id;
          existingItemId = completedQueueItem.item_id || null;
          console.log(`[USE CASE 3 - QUEUE] ✅ Another queue item for license ${license_key} already completed with subscription: ${existingSubscriptionId}`);
        } else {
          console.log(`[USE CASE 3 - QUEUE] ℹ️ No existing subscription found for license ${license_key}, creating new one`);
        }
      }
    } catch (checkErr) {
      console.warn(`[USE CASE 3 - QUEUE] ⚠️ Could not check for existing subscription:`, checkErr);
    }
    
    // If subscription already exists, mark queue item as completed and return
    if (existingSubscriptionId) {
      const timestamp = Math.floor(Date.now() / 1000);
      
      // OPTIMIZATION: Single UPDATE query instead of separate SELECT + UPDATE
      await env.DB.prepare(
        `UPDATE subscription_queue 
         SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
         WHERE queue_id = ?`
      ).bind(existingSubscriptionId, existingItemId, timestamp, timestamp, queue_id).run();
      
      console.log(`[USE CASE 3 - QUEUE] ✅ Queue item ${queue_id} marked as completed (subscription already existed)`);
      return { success: true, subscriptionId: existingSubscriptionId, itemId: existingItemId, skipped: true };
    }
    
    // CRITICAL: Final duplicate check right before creating subscription
    // Double-check that no subscription was created while we were processing
    // This is a last line of defense against race conditions
    try {
      const finalCheck = await env.DB.prepare(
        `SELECT subscription_id, item_id FROM licenses WHERE license_key = ? AND subscription_id IS NOT NULL LIMIT 1`
      ).bind(license_key).first();
      
      if (finalCheck && finalCheck.subscription_id) {
        console.log(`[USE CASE 3 - QUEUE] ⚠️ Subscription was created for license ${license_key} while processing (race condition detected): ${finalCheck.subscription_id}`);
        // Mark queue item as completed with existing subscription
        const timestamp = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          `UPDATE subscription_queue 
           SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
           WHERE queue_id = ?`
        ).bind(finalCheck.subscription_id, finalCheck.item_id || null, timestamp, timestamp, queue_id).run();
        
        return { success: true, subscriptionId: finalCheck.subscription_id, itemId: finalCheck.item_id || null, skipped: true, reason: 'duplicate_detected' };
      }
    } catch (finalCheckErr) {
      console.warn(`[USE CASE 3 - QUEUE] ⚠️ Final duplicate check failed (continuing anyway):`, finalCheckErr);
    }
    
    // Create subscription
    console.log(`[USE CASE 3 - QUEUE] 🚀 Creating individual subscription for license ${license_key}...`);
    const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
      'customer': customer_id,
      'items[0][price]': price_id,
      'items[0][quantity]': 1,
      'metadata[license_key]': license_key,
      'metadata[usecase]': '3',
      'metadata[purchase_type]': 'quantity',
      'proration_behavior': 'none',
      'collection_method': 'charge_automatically',
      'trial_end': trial_end ? trial_end.toString() : undefined
    }, true);
    
    if (createSubRes.status === 200) {
      const subscription = createSubRes.body;
      const subscriptionId = subscription.id;
      const itemId = subscription.items?.data?.[0]?.id || null;
      
      console.log(`[USE CASE 3 - QUEUE] ✅ Individual subscription created successfully!`);
      console.log(`[USE CASE 3 - QUEUE] 📊 Subscription Details:`, {
        license_key,
        subscription_id: subscriptionId,
        item_id: itemId,
        customer_id,
        status: subscription.status,
        current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
        current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
        trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null
      });
      
      const timestamp = Math.floor(Date.now() / 1000);
      
      // Fetch billing_period and renewal_date from Stripe subscription
      let billingPeriod = null;
      // Stripe automatically calculates current_period_end correctly:
      // - If trial_end exists: current_period_end = trial_end + billing_interval
      // - If no trial: current_period_end = now + billing_interval
      // So we can use current_period_end directly - it's already the correct renewal date
      let renewalDate = subscription.current_period_end || null;
      
      // Get billing period from subscription items
      if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
        const firstItem = subscription.items.data[0];
        if (firstItem.price && firstItem.price.recurring) {
          const interval = firstItem.price.recurring.interval;
          if (interval === 'month') {
            billingPeriod = 'monthly';
          } else if (interval === 'year') {
            billingPeriod = 'yearly';
          } else if (interval === 'week') {
            billingPeriod = 'weekly';
          } else if (interval === 'day') {
            billingPeriod = 'daily';
          } else {
            billingPeriod = interval;
          }
          
          // Stripe sets current_period_end = billing_cycle_anchor + billing_interval
          // When trial_end is set, billing_cycle_anchor = trial_end
          // So current_period_end = trial_end + billing_interval (already correct!)
          // No need to calculate manually - use Stripe's value directly
        }
      }
      
      // CRITICAL: Save license and subscription records FIRST before marking as completed
      // If database save fails, we should retry, not mark as completed
      let licenseSaved = false;
      let subscriptionSaved = false;
      
      // Save license to database (for dashboard display)
      try {
        const insertResult = await env.DB.prepare(
          `INSERT INTO licenses 
           (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, billing_period, renewal_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          license_key,
          customer_id,
          subscriptionId,
          itemId || null,
          null,
          null,
          'active',
          'quantity',
          billingPeriod,
          renewalDate,
          timestamp,
          timestamp
        ).run();
        
        if (insertResult.success) {
          licenseSaved = true;
          console.log(`[USE CASE 3 - QUEUE] ✅ License saved to database:`, {
            license_key,
            subscription_id: subscriptionId,
            item_id: itemId,
            customer_id,
            purchase_type: 'quantity',
            billing_period: billingPeriod,
            renewal_date: renewalDate ? new Date(renewalDate * 1000).toISOString() : null,
            created_at: new Date(timestamp * 1000).toISOString()
          });
          
          // Verify the license was saved correctly
          const verifyLicense = await env.DB.prepare(
            `SELECT license_key, subscription_id, item_id, customer_id, purchase_type, billing_period, renewal_date 
             FROM licenses WHERE license_key = ? LIMIT 1`
          ).bind(license_key).first();
          
          if (verifyLicense) {
            console.log(`[USE CASE 3 - QUEUE] ✅ Verified license in database:`, {
              license_key: verifyLicense.license_key,
              subscription_id: verifyLicense.subscription_id,
              item_id: verifyLicense.item_id,
              customer_id: verifyLicense.customer_id,
              purchase_type: verifyLicense.purchase_type,
              billing_period: verifyLicense.billing_period,
              renewal_date: verifyLicense.renewal_date ? new Date(verifyLicense.renewal_date * 1000).toISOString() : null
            });
        } else {
            console.error(`[USE CASE 3 - QUEUE] ❌ License verification failed - license not found in database after insert!`);
          }
        } else {
          console.error(`[USE CASE 3 - QUEUE] ❌ Database insert returned success=false for license ${license_key}`);
          throw new Error(`Database insert failed for license ${license_key}`);
        }
      } catch (licenseErr) {
        if (licenseErr.message && licenseErr.message.includes('UNIQUE constraint')) {
          console.warn(`[USE CASE 3 - QUEUE] ⚠️ License ${license_key} already exists in database, skipping`);
          licenseSaved = true; // Already exists, consider it saved
        } else {
          console.error(`[USE CASE 3 - QUEUE] ❌ Error saving license ${license_key}:`, licenseErr);
          // If license save fails, throw error to trigger retry
          throw new Error(`Failed to save license to database: ${licenseErr.message || String(licenseErr)}`);
        }
      }
      
      // Save subscription record to subscriptions table (for dashboard)
      console.log(`[USE CASE 3 - QUEUE] 💾 Saving subscription record to subscriptions table...`);
      try {
        const subInsertResult = await env.DB.prepare(
          `INSERT OR REPLACE INTO subscriptions 
           (user_email, customer_id, subscription_id, status, cancel_at_period_end, cancel_at, 
            current_period_start, current_period_end, billing_period, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          user_email,
          customer_id,
          subscriptionId,
          subscription.status || 'active',
          0, // cancel_at_period_end
          null, // cancel_at
          subscription.current_period_start || null,
          subscription.current_period_end || null,
          billingPeriod, // billing_period from Stripe subscription
          timestamp,
          timestamp
        ).run();
        
        if (subInsertResult.success) {
        subscriptionSaved = true;
          console.log(`[USE CASE 3 - QUEUE] ✅ Subscription record saved to database:`, {
            subscription_id: subscriptionId,
            customer_id,
            user_email,
            status: subscription.status || 'active',
            billing_period: billingPeriod,
            current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
            current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
          });
          
          // Verify the subscription was saved correctly
          const verifySub = await env.DB.prepare(
            `SELECT subscription_id, customer_id, user_email, status, billing_period, current_period_end 
             FROM subscriptions WHERE subscription_id = ? LIMIT 1`
          ).bind(subscriptionId).first();
          
          if (verifySub) {
            console.log(`[USE CASE 3 - QUEUE] ✅ Verified subscription in database:`, {
              subscription_id: verifySub.subscription_id,
              customer_id: verifySub.customer_id,
              user_email: verifySub.user_email,
              status: verifySub.status,
              billing_period: verifySub.billing_period,
              current_period_end: verifySub.current_period_end ? new Date(verifySub.current_period_end * 1000).toISOString() : null
            });
          } else {
            console.error(`[USE CASE 3 - QUEUE] ❌ Subscription verification failed - subscription not found in database after insert!`);
          }
        } else {
          console.error(`[USE CASE 3 - QUEUE] ❌ Subscription record insert returned success=false`);
          throw new Error(`Subscription record insert failed`);
        }
      } catch (subErr) {
        console.error(`[USE CASE 3 - QUEUE] ❌ Error saving subscription record:`, subErr);
        // If subscription record save fails, throw error to trigger retry
        throw new Error(`Failed to save subscription record to database: ${subErr.message || String(subErr)}`);
      }
      
      // Only mark as completed AFTER all critical database operations succeed
      if (licenseSaved && subscriptionSaved) {
        await env.DB.prepare(
          `UPDATE subscription_queue 
           SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
           WHERE queue_id = ?`
        ).bind(subscriptionId, itemId, timestamp, timestamp, queue_id).run();
        
        console.log(`[USE CASE 3 - QUEUE] ✅ Queue item ${queue_id} marked as completed`);
        console.log(`[USE CASE 3 - QUEUE] 📊 Final Summary for License ${license_key}:`, {
          license_key,
          subscription_id: subscriptionId,
          item_id: itemId,
          customer_id,
          user_email,
          billing_period: billingPeriod,
          renewal_date: renewalDate ? new Date(renewalDate * 1000).toISOString() : null,
          queue_status: 'completed',
          processed_at: new Date(timestamp * 1000).toISOString()
        });
        
        // Verify one-to-one relationship: Each license has exactly one subscription
        const verifyRelationship = await env.DB.prepare(
          `SELECT l.license_key, l.subscription_id, l.item_id, s.subscription_id as sub_id, s.status as sub_status
           FROM licenses l
           LEFT JOIN subscriptions s ON l.subscription_id = s.subscription_id
           WHERE l.license_key = ? LIMIT 1`
        ).bind(license_key).first();
        
        if (verifyRelationship && verifyRelationship.subscription_id === verifyRelationship.sub_id) {
          console.log(`[USE CASE 3 - QUEUE] ✅ Verified one-to-one relationship: License ${license_key} → Subscription ${verifyRelationship.subscription_id}`);
        } else {
          console.error(`[USE CASE 3 - QUEUE] ❌ Relationship verification failed! License ${license_key} subscription mismatch.`);
        }
        
        // Save to KV storage (for license key purchase - queue processing)
        try {
          console.log(`[USE CASE 3 - QUEUE] 💾 Saving license key to KV storage: ${license_key}`);
          await saveLicenseKeyToKV(
            env,
            license_key,
            customer_id,
            subscriptionId,
            user_email,
            'complete', // License keys start as complete/active
            false, // cancelAtPeriodEnd (will be updated when subscription status changes)
            null // No site name yet (not activated)
          );
        } catch (kvErr) {
          console.error(`[USE CASE 3 - QUEUE] ⚠️ Error saving license key to KV storage (non-blocking):`, kvErr);
          // Don't fail the whole operation if KV save fails
        }
      } else {
        throw new Error('License or subscription record was not saved successfully');
      }
      
      // Save payment record (for dashboard payment history)
      // OPTIMIZATION: Make payment record saving non-blocking to prevent timeouts
      // Use a separate async operation that doesn't block the main flow
      (async () => {
        try {
          // Get price amount for payment record
          let amountPerSubscription = 0;
          let currency = 'usd';
          try {
            const priceRes = await stripeFetch(env, `/prices/${price_id}`);
            if (priceRes.status === 200) {
              amountPerSubscription = priceRes.body.unit_amount || 0;
              currency = priceRes.body.currency || 'usd';
            }
          } catch (priceErr) {
            console.warn(`[QUEUE] ⚠️ Could not fetch price for payment record:`, priceErr);
          }
          
          await env.DB.prepare(
            `INSERT INTO payments (
              customer_id, subscription_id, email, amount, currency, 
              status, site_domain, magic_link, magic_link_generated, 
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            customer_id,
            subscriptionId,
            user_email,
            amountPerSubscription,
            currency,
            'succeeded',
            null, // site_domain (null for quantity purchases)
            null, // magic_link
            0, // magic_link_generated
            timestamp,
            timestamp
          ).run();
        } catch (paymentErr) {
          console.error(`[QUEUE] ⚠️ Error saving payment record (non-blocking):`, paymentErr);
          // Don't fail the whole operation if payment record save fails
        }
      })(); // Fire and forget - don't await to prevent timeout
      
      return { success: true, subscriptionId, itemId };
    } else {
      throw new Error(`Subscription creation failed: ${createSubRes.status} - ${JSON.stringify(createSubRes.body)}`);
    }
  } catch (error) {
    // Update queue item as failed and schedule retry
    const attempts = (queueItem.attempts || 0) + 1;
    const maxAttempts = queueItem.max_attempts || 3;
    const nextRetryAt = attempts < maxAttempts 
      ? Math.floor(Date.now() / 1000) + (Math.pow(2, attempts) * 60) // Exponential backoff: 2min, 4min, 8min
      : null;
    const status = attempts >= maxAttempts ? 'failed' : 'pending';
    
    const timestamp = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE subscription_queue 
       SET status = ?, attempts = ?, error_message = ?, next_retry_at = ?, updated_at = ?
       WHERE queue_id = ?`
    ).bind(status, attempts, error.message || String(error), nextRetryAt, timestamp, queue_id).run();
    
    console.error(`[QUEUE] ❌ Failed to process queue item ${queue_id} (attempt ${attempts}/${maxAttempts}):`, error);
    
    if (attempts >= maxAttempts) {
      console.error(`[QUEUE] 🚨 Queue item ${queue_id} has exceeded max attempts (${maxAttempts}). Marking as failed - refund will be processed after 12 hours if still incomplete.`);
      console.error(`[QUEUE] 🚨 License: ${license_key}, Customer: ${customer_id}, Payment Intent: ${payment_intent_id}`);
      
      // Don't refund immediately - refund will be processed by scheduled job after 12 hours
      // This gives the system time to retry and allows for manual intervention if needed
    } else {
    }
    
    return { success: false, error: error.message, attempts };
  }
}

/**
 * Process refund for a permanently failed queue item
 */
async function processRefundForFailedQueueItem(env, queueItem) {
  const {
    queue_id,
    payment_intent_id,
    price_id,
    license_key
  } = queueItem;
  
  try {
    // Get payment intent to find charge ID
    const piRes = await stripeFetch(env, `/payment_intents/${payment_intent_id}`);
    if (piRes.status !== 200) {
      console.error(`[QUEUE] ❌ Could not fetch payment intent ${payment_intent_id} for refund`);
      return { success: false, error: 'payment_intent_not_found' };
    }
    
    const paymentIntent = piRes.body;
    
    // Get charge ID from payment intent
    let chargeId = null;
    if (paymentIntent.latest_charge) {
      chargeId = typeof paymentIntent.latest_charge === 'string' 
        ? paymentIntent.latest_charge 
        : paymentIntent.latest_charge.id;
    } else if (paymentIntent.charges?.data?.length > 0) {
      chargeId = paymentIntent.charges.data[0].id;
    }
    
    if (!chargeId) {
      console.error(`[QUEUE] ❌ Could not find charge ID for refund. Payment Intent: ${payment_intent_id}`);
      return { success: false, error: 'charge_not_found' };
    }
    
    // Get price details to calculate refund amount
    let refundAmount = 0;
    let currency = 'usd';
    
    try {
      const priceRes = await stripeFetch(env, `/prices/${price_id}`);
      if (priceRes.status === 200) {
        const price = priceRes.body;
        refundAmount = price.unit_amount || 0;
        currency = price.currency || 'usd';
      } else {
        // Fallback: Use payment intent amount divided by quantity
        // We need to get the total quantity from the payment intent metadata
        const quantity = parseInt(paymentIntent.metadata?.quantity) || 1;
        if (paymentIntent.amount && quantity > 0) {
          refundAmount = Math.round(paymentIntent.amount / quantity);
          currency = paymentIntent.currency || 'usd';
        }
      }
    } catch (priceErr) {
      console.warn(`[QUEUE] ⚠️ Could not get price for refund calculation:`, priceErr);
      // Fallback: Use payment intent amount divided by quantity
      const quantity = parseInt(paymentIntent.metadata?.quantity) || 1;
      if (paymentIntent.amount && quantity > 0) {
        refundAmount = Math.round(paymentIntent.amount / quantity);
        currency = paymentIntent.currency || 'usd';
      }
    }
    
    if (refundAmount > 0) {
      // Create refund
      const refundRes = await stripeFetch(env, '/refunds', 'POST', {
        'charge': chargeId,
        'amount': refundAmount,
        'metadata[reason]': 'subscription_creation_failed_after_retries',
        'metadata[queue_id]': queue_id,
        'metadata[license_key]': license_key,
        'metadata[payment_intent_id]': payment_intent_id,
        'metadata[attempts]': queueItem.attempts?.toString() || '3'
      }, true);
      
      if (refundRes.status === 200) {
        const refund = refundRes.body;
        
        const timestamp = Math.floor(Date.now() / 1000);
        
        // Save refund record to database
        try {
          await env.DB.prepare(
            `INSERT INTO refunds (
              refund_id, payment_intent_id, charge_id, customer_id, user_email,
              amount, currency, status, reason, queue_id, license_key,
              subscription_id, attempts, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            refund.id,
            payment_intent_id,
            chargeId,
            queueItem.customer_id,
            queueItem.user_email || null,
            refundAmount,
            currency,
            refund.status || 'succeeded',
            'subscription_creation_failed_after_retries',
            queue_id,
            license_key,
            null, // subscription_id (not created)
            queueItem.attempts || 3,
            JSON.stringify({
              reason: 'subscription_creation_failed_after_retries',
              queue_id: queue_id,
              license_key: license_key,
              payment_intent_id: payment_intent_id,
              attempts: queueItem.attempts || 3
            }),
            timestamp,
            timestamp
          ).run();
        } catch (refundDbErr) {
          if (refundDbErr.message && refundDbErr.message.includes('UNIQUE constraint')) {
            console.warn(`[QUEUE] ⚠️ Refund ${refund.id} already exists in database, skipping`);
          } else {
            console.error(`[QUEUE] ⚠️ Error saving refund record:`, refundDbErr);
            // Don't fail the whole operation if refund record save fails
          }
        }
        
        // Update queue item with refund information
        await env.DB.prepare(
          `UPDATE subscription_queue 
           SET error_message = ?, updated_at = ?
           WHERE queue_id = ?`
        ).bind(
          `${queueItem.error_message || 'Subscription creation failed'} | REFUNDED: ${refund.id} (${refundAmount} ${currency})`,
          timestamp,
          queue_id
        ).run();
        
        return { success: true, refundId: refund.id, amount: refundAmount, currency };
      } else {
        console.error(`[QUEUE] ❌ Failed to create refund:`, refundRes.status, refundRes.body);
        return { success: false, error: 'refund_creation_failed', details: refundRes.body };
      }
    } else {
      console.warn(`[QUEUE] ⚠️ Refund amount is 0, skipping refund creation`);
      return { success: false, error: 'zero_refund_amount' };
    }
  } catch (refundErr) {
    console.error(`[QUEUE] ❌ Error processing refund for queue item ${queue_id}:`, refundErr);
    return { success: false, error: refundErr.message || String(refundErr) };
  }
}

/**
 * Process refunds for failed queue items that are older than 12 hours
 * Only refunds items that have exhausted all retry attempts and are still failed
 */
async function processRefundsForOldFailedItems(env, limit = 50) {
  const timestamp = Math.floor(Date.now() / 1000);
  const twelveHoursAgo = timestamp - (12 * 60 * 60); // 12 hours in seconds
  
  try {
    // Get failed items that are older than 12 hours and haven't been refunded yet
    const failedItems = await env.DB.prepare(
      `SELECT * FROM subscription_queue 
       WHERE status = 'failed' 
       AND created_at <= ?
       AND error_message NOT LIKE '%REFUNDED:%'
       ORDER BY created_at ASC
       LIMIT ?`
    ).bind(twelveHoursAgo, limit).all();
    
    if (failedItems.results.length === 0) {
      return { processed: 0, refunded: 0, message: 'No old failed items to refund' };
    }
    
    
    let refundedCount = 0;
    let errorCount = 0;
    
    for (const item of failedItems.results) {
      try {
        const refundResult = await processRefundForFailedQueueItem(env, item);
        if (refundResult.success) {
          refundedCount++;
        } else {
          errorCount++;
          console.error(`[REFUND] ❌ Failed to refund queue item ${item.queue_id}: ${refundResult.error}`);
        }
      } catch (refundErr) {
        errorCount++;
        console.error(`[REFUND] ❌ Error processing refund for queue item ${item.queue_id}:`, refundErr);
      }
      
      // Small delay between refunds to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return { processed: failedItems.results.length, refunded: refundedCount, errors: errorCount };
  } catch (error) {
    console.error(`[REFUND] ❌ Error processing refunds for old failed items:`, error);
    return { processed: 0, refunded: 0, error: error.message };
  }
}

/**
 * Process pending queue items
 * Can be called via endpoint or scheduled worker
 */
async function processSubscriptionQueue(env, limit = 100) {
  const timestamp = Math.floor(Date.now() / 1000);
  const fiveMinutesAgo = timestamp - (5 * 60); // 5 minutes in seconds
  
  try {
    // First, reset items stuck in 'processing' status for more than 5 minutes back to 'pending'
    // This handles cases where the worker crashed or timed out while processing
    try {
      const resetResult = await env.DB.prepare(
        `UPDATE subscription_queue 
         SET status = 'pending', updated_at = ?
         WHERE status = 'processing' 
         AND updated_at < ?`
      ).bind(timestamp, fiveMinutesAgo).run();
      
      if (resetResult.meta.changes > 0) {
        console.log(`[QUEUE] 🔄 Reset ${resetResult.meta.changes} stuck 'processing' items back to 'pending'`);
      }
    } catch (resetErr) {
      console.warn(`[QUEUE] ⚠️ Could not reset stuck processing items:`, resetErr);
    }
    
    // Get pending items that are ready to process (next_retry_at is null or in the past)
    const queueItems = await env.DB.prepare(
      `SELECT * FROM subscription_queue 
       WHERE status = 'pending' 
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`
    ).bind(timestamp, limit).all();
    
    if (queueItems.results.length === 0) {
      return { processed: 0, message: 'No pending queue items' };
    }
    
    console.log(`[QUEUE] 📋 Processing ${queueItems.results.length} queue items...`);
    
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    
    for (const item of queueItems.results) {
      // CRITICAL: Atomic lock mechanism - only update if status is still 'pending'
      // This prevents concurrent processes from processing the same queue item
      // The WHERE clause acts as a lock - only one process can successfully update
      const lockResult = await env.DB.prepare(
        `UPDATE subscription_queue 
         SET status = 'processing', updated_at = ? 
         WHERE queue_id = ? AND status = 'pending'`
      ).bind(timestamp, item.queue_id).run();
      
      // Check if we successfully acquired the lock (rows affected > 0)
      if (lockResult.meta.changes === 0) {
        // Another process already acquired the lock or item is no longer pending
        console.log(`[QUEUE] ⚠️ Could not acquire lock for queue item ${item.queue_id} - already being processed by another worker or status changed`);
        skippedCount++;
        continue;
      }
      
      // Lock acquired successfully - proceed with processing
      const result = await processQueueItem(env, item);
      if (result.success) {
        successCount++;
        console.log(`[QUEUE] ✅ Successfully processed queue item ${item.queue_id} for license ${item.license_key}`);
      } else {
        failCount++;
        console.error(`[QUEUE] ❌ Failed to process queue item ${item.queue_id} for license ${item.license_key}: ${result.error}`);
      }
      
      // Small delay between processing to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (skippedCount > 0) {
      console.log(`[QUEUE] ⚠️ Skipped ${skippedCount} queue items (lock already acquired by another process)`);
    }
    
    console.log(`[QUEUE] ✅ Queue processing complete: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped (lock conflict) out of ${queueItems.results.length} total`);
    
    return { processed: queueItems.results.length, successCount, failCount, skippedCount };
  } catch (error) {
    console.error(`[QUEUE] ❌ Error processing queue:`, error);
    return { processed: 0, error: error.message };
  }
}

async function stripeFetch(env, path, method = 'GET', body = null, form = false) {
  try {
  const key = getEnvVar(env, 'STRIPE_SECRET_KEY');
  const url = `${STRIPE_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${key}`
  };
  let init = { method, headers };
  if (body) {
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      // Build URLSearchParams manually to properly handle bracket notation
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        params.append(key, String(value));
      }
      init.body = params.toString();
      // Debug: Log line items count in encoded data
      const lineItemMatches = init.body.match(/line_items\[\d+\]\[price\]/g);
      if (lineItemMatches) {
      }
    } else {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, init);
  const text = await res.text();
  try {
      const parsed = JSON.parse(text);
      if (res.status >= 400) {
        console.error(`Stripe API error (${res.status}):`, parsed);
      }
      return { status: res.status, body: parsed };
  } catch (e) {
      console.error(`Stripe API error - failed to parse response:`, text);
    return { status: res.status, body: text };
    }
  } catch (e) {
    console.error('Stripe fetch error:', e);
    throw e;
  }
}

export default {
  // Scheduled event handler - processes subscription queue automatically
  // Runs every 1 minute (configured in wrangler.jsonc: "*/1 * * * *")
  // Exits early if no pending items to minimize resource usage
  

 
    
  async scheduled(event, env, ctx) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    try {
      // Quick check: Are there any pending items or failed items that need refunds?
      const pendingCheck = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscription_queue 
         WHERE status = 'pending' 
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         LIMIT 1`
      ).bind(timestamp).first();
      
      const twelveHoursAgo = timestamp - (12 * 60 * 60);
      const failedCheck = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscription_queue 
         WHERE status = 'failed' 
         AND created_at <= ?
         AND error_message NOT LIKE '%REFUNDED:%'
         LIMIT 1`
      ).bind(twelveHoursAgo).first();
      
      const hasPending = (pendingCheck?.count || 0) > 0;
      const hasFailed = (failedCheck?.count || 0) > 0;
      
      // Early exit if nothing to process
      if (!hasPending && !hasFailed) {
        console.log(`[SCHEDULED] ⏸️ No pending items or failed items to process. Skipping execution.`);
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          message: 'No pending or failed items to process',
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.log(`[SCHEDULED] 🕐 Starting scheduled queue processing at ${new Date().toISOString()}`);
      
      // Process up to 100 queue items per run to handle large batches
      // This ensures all pending subscriptions are created even for large purchases
      const queueResult = await processSubscriptionQueue(env, 100);
      
      console.log(`[SCHEDULED] ✅ Queue processing result:`, queueResult);
      
      // Process refunds for failed items older than 12 hours (only if there are failed items)
      let refundResult = { processed: 0, refunded: 0, message: 'No failed items to refund' };
      if (hasFailed) {
        refundResult = await processRefundsForOldFailedItems(env, 50);
      console.log(`[SCHEDULED] ✅ Refund processing result:`, refundResult);
      }
      
      // Return success
      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        queue: queueResult,
        refunds: refundResult
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error(`[SCHEDULED] ❌ Error processing queue:`, error);
      
      return new Response(JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      const corsHeaders = getCorsHeaders(request);
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    try {
      if (request.method === 'POST' && pathname === '/create-checkout-session') {
        // Create a Checkout Session to collect payment for N sites and create a single subscription with multiple items
        const data = await request.json();
        // expected: { customerEmail, sites: [{site: 'site1.com', price: 'price_10'} , ...], success_url, cancel_url }
        const { customerEmail, sites, success_url, cancel_url } = data;
        if (!customerEmail || !Array.isArray(sites) || sites.length === 0) {
          console.error('Validation failed: missing customerEmail or sites');
          return jsonResponse(400, { error: 'missing customerEmail or sites' });
        }

        // Create (or find) customer
        // For simplicity, we always create a new customer tied to the email
        const cust = await stripeFetch(env, '/customers', 'POST', { email: customerEmail }, true);
        if (cust.status >= 400) {
          console.error('Stripe customer creation failed:', cust.status, cust.body);
          return jsonResponse(500, { error: 'stripe customer create failed', details: cust.body });
        }
        const customerId = cust.body.id;

        // Prepare line items for Checkout - ONE subscription with MULTIPLE subscription items
        // Each site becomes a separate subscription item with metadata
        // Use provided URLs or default to dashboard
        const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://memberstack-login-test-713fa5.webflow.io/dashboard';
        const form = {
          'mode': 'subscription',
          'customer': customerId,
          'success_url': success_url || `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
          'cancel_url': cancel_url || dashboardUrl,
        };
        sites.forEach((s, i) => {
          // Each line item becomes a subscription item
          form[`line_items[${i}][price]`] = s.price;
          form[`line_items[${i}][quantity]`] = s.quantity || 1;
          // Note: description field is not allowed when using price ID - site name will show via product name
          if (s.site) {
            // Store site in subscription metadata temporarily, will be moved to items in webhook
            form[`subscription_data[metadata][site_${i}]`] = s.site;
          }
        });

        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
        if (session.status >= 400) {
          console.error('Stripe checkout session creation failed:', session.status, session.body);
          return jsonResponse(500, { error: 'stripe checkout session failed', details: session.body });
        }

        
        // If redirect=true query parameter is present, redirect directly to checkout
        const redirect = url.searchParams.get('redirect') === 'true';
        if (redirect && session.body.url) {
          return new Response(null, {
            status: 302,
            headers: { 'Location': session.body.url }
          });
        }

        return jsonResponse(200, { sessionId: session.body.id, url: session.body.url });
      }

      if (request.method === 'POST' && pathname === '/webhook') {
        // Stripe webhook handler - verifies signature and processes checkout.session.completed
        const raw = await request.text();
        const sig = request.headers.get('stripe-signature');
        const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

        // Verify Stripe webhook signature (mandatory for security)
        let event;
        try {
          if (webhookSecret && sig) {
            // Use proper webhook verification - call method from export default object
            event = await this.verifyStripeWebhookForMemberstack(raw, sig, webhookSecret);
          } else {
            // Fallback for development (not recommended for production)
            console.warn('⚠️ Webhook verification skipped - STRIPE_WEBHOOK_SECRET or signature missing');
            event = JSON.parse(raw);
          }
        } catch (e) {
          console.error('Webhook verification failed:', e);
          return new Response('Invalid signature or payload', { status: 400 });
        }

        // Log all webhook events for debugging and tracking
        const subscriptionId = event.data?.object?.subscription || event.data?.object?.id || null;
        const customerId = event.data?.object?.customer || null;
        await logStripeEvent(env, event, subscriptionId, customerId, {
          action: 'webhook_received',
          note: 'Initial webhook event received'
        });
        
        try {
        // Handle checkout.session.completed - save payment details and generate magic link
        if (event.type === 'checkout.session.completed') {
          
          // CRITICAL: Declare ALL variables IMMEDIATELY at the start of the handler
          // This ensures they're always defined, even if an error occurs early
          let email = null;
          let customerId = null;
          let subscriptionId = null;
          let operationId = null;
          let failedOperations = [];
          let purchaseType = 'site';
          let addToExisting = false;
          let existingSubscriptionId = null;
          let isDirectLink = false;
          let paymentBy = null;
          let totalAmount = 0;
          let currency = 'usd';
          let customFieldSiteUrl = null;
          let billingPeriod = null;
          let billingInterval = null;

          const session = event.data.object;
          // Note: subscriptionId and customerId are already declared at the top of the handler
          subscriptionId = session.subscription;
          customerId = session.customer;
          
          // ========================================
          // STEP 1: IDENTIFY USE CASE
          // ========================================
          // First, determine which use case this is based on session properties
          // This ensures clean separation and prevents conflicts
          const sessionMode = session.mode;
          let sessionUseCase = session.metadata?.usecase; // Check session metadata first
          
          // For payment mode, we need to check customer metadata or payment intent metadata
          // session.payment_intent is just an ID string, not an object, so we can't access .metadata directly
          if (sessionMode === 'payment' && !sessionUseCase && customerId) {
            try {
              // Check customer metadata (we store usecase: '3' there)
              const customerRes = await stripeFetch(env, `/customers/${customerId}`);
              if (customerRes.status === 200 && customerRes.body?.metadata?.usecase) {
                sessionUseCase = customerRes.body.metadata.usecase;
              }
            } catch (customerErr) {
              console.warn(`[checkout.session.completed] Could not fetch customer metadata:`, customerErr);
            }
            
            // If still not found, check payment intent metadata
            if (!sessionUseCase && session.payment_intent && typeof session.payment_intent === 'string') {
              try {
                const piRes = await stripeFetch(env, `/payment_intents/${session.payment_intent}`);
                if (piRes.status === 200 && piRes.body?.metadata?.usecase) {
                  sessionUseCase = piRes.body.metadata.usecase;
                }
              } catch (piErr) {
                console.warn(`[checkout.session.completed] Could not fetch payment intent metadata:`, piErr);
              }
            }
          }
          
          // Determine use case based on mode and metadata
          let identifiedUseCase = null;
          if (sessionMode === 'payment' && sessionUseCase === '3') {
            identifiedUseCase = '3'; // Use Case 3: Quantity purchase
          } else if (sessionMode === 'payment' && sessionUseCase === '2') {
            // Use Case 2: Site purchase - handled by payment_intent.succeeded webhook
            // Skip here to prevent duplicate processing
            return new Response('ok');
          } else if (sessionMode === 'subscription') {
            identifiedUseCase = '1'; // Use Case 1: Direct payment link (creates new subscription)
          } else {
            // Unknown use case - log and process as Use Case 1 (default)
            console.warn(`[checkout.session.completed] ⚠️ Unknown use case - mode: ${sessionMode}, usecase: ${sessionUseCase || 'not set'}. Defaulting to Use Case 1.`);
            identifiedUseCase = '1';
          }
          
          
          // ========================================
          // STEP 2: ROUTE TO APPROPRIATE HANDLER
          // ========================================
          // Route to Use Case 3 handler
       // Route to Use Case 3 handler
if (identifiedUseCase === '3') {

  // ========================================
  // USE CASE 3 HANDLER: Quantity Purchase
  // ALWAYS QUEUE, NEVER IMMEDIATE
  // ========================================

  const paymentIntentId = session.payment_intent;

  if (paymentIntentId && typeof paymentIntentId === 'string') {
    try {
      // 1) Fetch payment intent + metadata
      const piRes = await stripeFetch(env, `/payment_intents/${paymentIntentId}`);
      if (piRes.status === 200) {
        const paymentIntent = piRes.body;
       let metadata = paymentIntent.metadata || {};

        // Also merge charge metadata if needed
        if (!metadata.usecase && paymentIntent.latest_charge) {
          try {
            const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
            if (chargeRes.status === 200 && chargeRes.body.metadata) {
              metadata = { ...metadata, ...chargeRes.body.metadata };
            }
          } catch (chargeErr) {
            console.warn(`[checkout.session.completed] Could not fetch charge metadata:`, chargeErr);
          }
        }

        // Only handle Use Case 3
        if (metadata.usecase === '3') {

          // 2) Resolve customer id for this use case
          const useCase3CustomerId =

            session.customer ||
            metadata.customer_id ||
            paymentIntent.customer;

          // 3) Load license keys (temporary) from metadata / customer
          let licenseKeys = [];
          try {
            if (metadata.license_keys) {
              // Stored directly on payment_intent metadata
              licenseKeys = JSON.parse(metadata.license_keys);
            } else if (
              metadata.license_keys_source === 'customer_metadata' ||
              metadata.license_keys_count
            ) {
              // For large quantity, keys are on customer metadata
              try {
                const customerRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`);
                if (
                  customerRes.status === 200 &&
                  customerRes.body.metadata?.license_keys_pending
                ) {
                  licenseKeys = JSON.parse(
                    customerRes.body.metadata.license_keys_pending
                  );
                  console.log(
                    `[checkout.session.completed] ✅ Retrieved ${licenseKeys.length} license keys from customer metadata`
                  );
                }
              } catch (customerErr) {
                console.error(
                  `[checkout.session.completed] ❌ Error fetching license keys from customer metadata:`,
                  customerErr
                );
              }
            }
          } catch (e) {
            console.error(
              `[checkout.session.completed] Error parsing license_keys:`,
              e
            );
          }

          // If still empty, try again (same logic, but keep as is for idempotency)
          if (licenseKeys.length === 0) {
            console.warn(
              `[checkout.session.completed] ⚠️ No license_keys found in metadata. Available keys: ${Object.keys(
                metadata
              ).join(', ')}`
            );
          }

          // 4) Basic idempotency check: if at least first license already exists, exit
          if (env.DB && licenseKeys.length > 0) {
            try {
              const existingLicenseCheck = await env.DB.prepare(
                `SELECT license_key FROM licenses WHERE license_key = ? LIMIT 1`
              )
                .bind(licenseKeys[0])
                .first();
              if (existingLicenseCheck) {
                console.log(
                  `[checkout.session.completed] ℹ️ Use Case 3 already processed (license ${licenseKeys[0]} exists), returning early.`
                );
                return new Response('ok');
              }
            } catch (checkErr) {
              console.warn(
                `[checkout.session.completed] Could not check existing licenses:`,
                checkErr
              );
            }
          }

          // 5) Resolve user email
          const userEmail = await getCustomerEmail(env, useCase3CustomerId);
          if (!userEmail) {
            console.warn(
              '[checkout.session.completed] User email not found for Use Case 3'
            );
            return new Response('ok');
          }

          // 6) Resolve priceId (from metadata → product → billing_period)
          let priceId=null;
          let quantity = parseInt(metadata.quantity) || licenseKeys.length || 1;
          const productIdFromMetadata = metadata.product_id || null;
          let productIdFromCustomer= null;

          console.log(
            `[checkout.session.completed] 📋 Metadata keys: ${Object.keys(metadata).join(
              ', '
            )}`
          );
          if (productIdFromMetadata) {
            console.log(
              `[checkout.session.completed] 🆔 Product ID from metadata: ${productIdFromMetadata}`
            );
          }

          try {
            // Re-load keys if needed (same as above, safe)
            if (metadata.license_keys) {
              licenseKeys = JSON.parse(metadata.license_keys);
            } else if (
              metadata.license_keys_source === 'customer_metadata' ||
              metadata.license_keys_count
            ) {
              if (licenseKeys.length === 0) {
                try {
                  const customerRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`);
                  if (
                    customerRes.status === 200 &&
                    customerRes.body.metadata?.license_keys_pending
                  ) {
                    licenseKeys = JSON.parse(
                      customerRes.body.metadata.license_keys_pending
                    );
                    console.log(
                      `[checkout.session.completed] ✅ Retrieved ${licenseKeys.length} license keys from customer metadata`
                    );
                  }
                  if (!productIdFromMetadata && customerRes.body.metadata?.product_id) {
                    productIdFromCustomer = customerRes.body.metadata.product_id;
                    console.log(
                      `[checkout.session.completed] 🆔 Product ID from customer metadata: ${productIdFromCustomer}`
                    );
                  }
                } catch (customerErr) {
                  console.error(
                    `[checkout.session.completed] ❌ Error fetching license keys from customer metadata:`,
                    customerErr
                  );
                }
              }
            } else {
              console.warn(
                `[checkout.session.completed] ⚠️ No license_keys found in metadata.`
              );
            }

            priceId = metadata.price_id || null;
            quantity = parseInt(metadata.quantity) || licenseKeys.length || 0;

            const productIdToUse = productIdFromMetadata || productIdFromCustomer;

            // If price_id not in metadata, try via product
            if (!priceId && productIdToUse) {
              console.log(
                `[checkout.session.completed] 🔍 price_id not found, fetching from product_id: ${productIdToUse}`
              );
              try {
                const productRes = await stripeFetch(env, `/products/${productIdToUse}`);
                if (productRes.status === 200 && productRes.body) {
                  const pricesRes = await stripeFetch(
                    env,
                    `/prices?product=${productIdToUse}&active=true&limit=1`
                  );
                  if (pricesRes.status === 200 && pricesRes.body?.data?.length > 0) {
                    priceId = pricesRes.body.data[0].id;
                    console.log(
                      `[checkout.session.completed] ✅ Found price_id from product: ${priceId}`
                    );
                  } else {
                    console.warn(
                      `[checkout.session.completed] ⚠️ No active prices found for product: ${productIdToUse}`
                    );
                  }
                }
              } catch (productErr) {
                console.error(
                  `[checkout.session.completed] ❌ Error fetching price_id from product_id:`,
                  productErr
                );
              }
            }

            // Fallback: by billing_period
            if (!priceId && metadata.billing_period) {
              console.log(
                `[checkout.session.completed] 🔍 Trying to get price_id from billing_period: ${metadata.billing_period}`
              );
              try {
                priceId = await getPriceIdByBillingPeriod(env, metadata.billing_period);
                if (priceId) {
                  console.log(
                    `[checkout.session.completed] ✅ Found price_id from billing_period: ${priceId}`
                  );
                }
              } catch (billingErr) {
                console.error(
                  `[checkout.session.completed] ❌ Error getting price_id from billing_period:`,
                  billingErr
                );
              }
            }
          } catch (parseErr) {
            console.error(
              '[checkout.session.completed] ❌ Error parsing metadata:',
              parseErr
            );
          }

          // 7) Save payment method to customer (unchanged)
          let paymentMethodId = paymentIntent.payment_method;

          if (!paymentMethodId && paymentIntent.latest_charge) {
            try {
              const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
              if (chargeRes.status === 200 && chargeRes.body.payment_method) {
                paymentMethodId = chargeRes.body.payment_method;
              }
            } catch (chargeErr) {
              console.warn(
                `[checkout.session.completed] Could not fetch charge for payment method:`,
                chargeErr
              );
            }
          }

          const customerIdForPaymentMethod =
            session.customer || paymentIntent.customer || useCase3CustomerId;

          let paymentMethodSaved = false;

          if (paymentMethodId && customerIdForPaymentMethod) {
            try {
              const attachRes = await stripeFetch(
                env,
                `/payment_methods/${paymentMethodId}/attach`,
                'POST',
                { customer: customerIdForPaymentMethod },
                true
              );

              if (attachRes.status === 200) {
                const setDefaultRes = await stripeFetch(
                  env,
                  `/customers/${customerIdForPaymentMethod}`,
                  'POST',
                  { 'invoice_settings[default_payment_method]': paymentMethodId },
                  true
                );
                if (setDefaultRes.status === 200) {
                  paymentMethodSaved = true;
                } else {
                  console.warn(
                    `[checkout.session.completed] ⚠️ Payment method attached but failed to set as default:`,
                    setDefaultRes.status,
                    setDefaultRes.body
                  );
                }
              } else {
                const errorMessage = attachRes.body?.error?.message || '';
                if (
                  errorMessage.includes('already attached') ||
                  errorMessage.includes('already been attached')
                ) {
                  const setDefaultRes = await stripeFetch(
                    env,
                    `/customers/${customerIdForPaymentMethod}`,
                    'POST',
                    { 'invoice_settings[default_payment_method]': paymentMethodId },
                    true
                  );
                  if (setDefaultRes.status === 200) {
                    paymentMethodSaved = true;
                  } else {
                    console.warn(
                      `[checkout.session.completed] ⚠️ Failed to set payment method as default:`,
                      setDefaultRes.status,
                      setDefaultRes.body
                    );
                  }
                } else {
                  console.error(
                    `[checkout.session.completed] ❌ STEP 1 FAILED: Failed to attach payment method:`,
                    attachRes.status,
                    attachRes.body
                  );
                }
              }
            } catch (attachErr) {
              console.error(
                `[checkout.session.completed] ❌ STEP 1 FAILED: Error attaching payment method:`,
                attachErr
              );
            }
          } else {
            console.error(
              `[checkout.session.completed] ❌ STEP 1 FAILED: Missing payment_method or customer. payment_method: ${paymentMethodId}, customer: ${customerIdForPaymentMethod}`
            );
          }

          // 8) ALWAYS QUEUE: no immediate subscription creation, no thresholds
          const customerIdForSubscriptions =
            customerIdForPaymentMethod || session.customer || useCase3CustomerId;

          if (paymentMethodSaved && priceId && quantity > 0 && customerIdForSubscriptions) {
            try {
              // Calculate single trial_end for all future subscriptions
              const now = Math.floor(Date.now() / 1000);

              let trialPeriodDays = null;
              if (env.TRIAL_PERIOD_DAYS) {
                trialPeriodDays = parseInt(env.TRIAL_PERIOD_DAYS);
              } else if (session.metadata?.trial_period_days) {
                trialPeriodDays = parseInt(session.metadata.trial_period_days);
              }

              let trialPeriodSeconds = 30 * 24 * 60 * 60;
              let billingInterval = 'month';

              if (trialPeriodDays) {
                trialPeriodSeconds = trialPeriodDays * 24 * 60 * 60;
              } else {
                try {
                  const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                  if (priceRes.status === 200 && priceRes.body.recurring) {
                    billingInterval = priceRes.body.recurring.interval;
                    const intervalCount = priceRes.body.recurring.interval_count || 1;
                    if (billingInterval === 'week') {
                      trialPeriodSeconds = 7 * 24 * 60 * 60 * intervalCount;
                    } else if (billingInterval === 'month') {
                      trialPeriodSeconds = 30 * 24 * 60 * 60 * intervalCount;
                    } else if (billingInterval === 'year') {
                      trialPeriodSeconds = 365 * 24 * 60 * 60 * intervalCount;
                    } else if (billingInterval === 'day') {
                      trialPeriodSeconds = 24 * 60 * 60 * intervalCount;
                    }
                  }
                } catch (priceErr) {
                  console.warn(
                    `[checkout.session.completed] ⚠️ Could not fetch price details, using default 30 days:`,
                    priceErr
                  );
                }
              }

              const trialEndTime = now + trialPeriodSeconds;
              const minimumTrialEnd =
                billingInterval === 'day'
                  ? now + 7 * 24 * 60 * 60
                  : now + 3600;
              const trialEnd = Math.max(trialEndTime, minimumTrialEnd);

              // LICENSE KEYS: if for some reason metadata had count but not actual array,
              // generate temporary keys so queue has one per subscription.
              if (!licenseKeys || licenseKeys.length === 0) {
                const count = quantity || 0;
                licenseKeys = await generateTempLicenseKeys(count);
                console.log(
                  `[USE CASE 3] Generated ${licenseKeys.length} temporary license keys because none were found in metadata`
                );
              }

              if (licenseKeys.length !== quantity) {
                console.warn(
                  `[USE CASE 3] ⚠️ licenseKeys.length (${licenseKeys.length}) != quantity (${quantity}). Will queue min(count) items.`
                );
              }

              const toQueue = Math.min(licenseKeys.length, quantity);
              let queuedCount = 0;
              let queueErrors = 0;

              console.log(
                `[USE CASE 3 - QUEUE ONLY] 📋 Adding ${toQueue} items to subscription_queue...`
              );

              for (let i = 0; i < toQueue; i++) {
                const queueResult = await addToSubscriptionQueue(env, {
                  customerId: customerIdForSubscriptions,
                  userEmail,
                  paymentIntentId: paymentIntent.id,
                  priceId,
                  licenseKey: licenseKeys[i],
                  quantity: 1,
                  trialEnd,
                });

                if (queueResult.success) {
                  queuedCount++;
                  if ((i + 1) % 10 === 0 || i === toQueue - 1) {
                    console.log(
                      `[USE CASE 3 - QUEUE ONLY] ✅ Queued ${i + 1}/${toQueue} items (${queuedCount} successful, ${queueErrors} errors)`
                    );
                  }
                } else {
                  queueErrors++;
                  console.error(
                    `[USE CASE 3 - QUEUE ONLY] ❌ Failed to queue item ${i + 1}/${toQueue} for license ${licenseKeys[i]}:`,
                    queueResult.error
                  );
                }
              }

              console.log(
                `[USE CASE 3 - QUEUE ONLY] 📊 Queue Summary: ${queuedCount} queued successfully, ${queueErrors} failed out of ${toQueue} planned`
              );

              // No subscription creation here. Background worker / cron will call processQueueItem()
              // for each pending row and:
              //  - generate real license key if temporary
              //  - create subscription in Stripe
              //  - create license row in DB
              //  - mark queue row as completed or delete it

            } catch (queueErr) {
              console.error(
                '[checkout.session.completed] ❌ Error queuing subscriptions for Use Case 3:',
                queueErr
              );
            }
          } else {
            // Explain why nothing was queued
            if (!paymentMethodSaved) {
              console.error(
                `[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Payment method was not saved successfully`
              );
            }
            if (!priceId) {
              console.error(
                `[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Missing priceId`
              );
            }
            if (!quantity || quantity <= 0) {
              console.error(
                `[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Invalid quantity: ${quantity}`
              );
            }
            if (!customerIdForSubscriptions) {
              console.error(
                `[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Missing customerId`
              );
            }
          }

          // IMPORTANT: no immediate creation, no license DB writes here.
          // Everything happens in queue processor.

          return new Response('ok');
        }
      }
    } catch (piErr) {
      console.error(
        `[checkout.session.completed] Error fetching payment_intent for Use Case 3:`,
        piErr
      );
    }
  }

  // If payment_intent fetch failed or metadata.usecase is not '3', return early
  // This ensures Use Case 3 doesn't fall through to Use Case 1 processing
  return new Response('ok');
}

          
          // ========================================
          // USE CASE 1 HANDLER: Direct Payment Links
          // ========================================
          // This section ONLY processes Use Case 1
          // Use Case 3 is handled above and returns early, so it never reaches here
          if (identifiedUseCase === '1') {
          
          // ========================================
          // USE CASE 1 DEBUG: Extract Basic Info
          // ========================================
          // Extract email from multiple possible locations (Payment Links vs Checkout Sessions)
          // Note: email variable is already declared at the top of the handler
          email = session.customer_details?.email;

          if (!subscriptionId || !customerId) {
            return new Response('ok');
          }

          // If email not found in session, fetch from customer object
          if (!email) {
            email = await getCustomerEmail(env, customerId);
            if (!email) {
              return new Response('ok');
            }
          }

          
          // Generate operation ID for tracking (used throughout payment processing)
          // Note: Variables are already declared at the top of the handler
          operationId = `payment_${customerId}_${subscriptionId}_${Date.now()}`;
          
          // Extract site URL from custom field - support multiple field key variations
          // Note: customFieldSiteUrl is already declared at the top of the handler
          customFieldSiteUrl = null;
          if (session.custom_fields && session.custom_fields.length > 0) {
            // Look for site URL field with various possible keys
            // Support: "enteryourlivesiteurl", "enteryourlivesiteur", "enteryourlivedomain"
            const siteUrlField = session.custom_fields.find(field =>             
              field.key === 'enteryourlivedomain'          
            
            );
            
            if (siteUrlField) {
              if (siteUrlField.type === 'text' && siteUrlField.text && siteUrlField.text.value) {
                customFieldSiteUrl = siteUrlField.text.value.trim();
              }
            }
          }

          // Retrieve the subscription and its items
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status !== 200) {
            return new Response('ok');
          }

            const sub = subRes.body;
          
          // ========================================
          // USE CASE 1 DEBUG: Extract Recurring Billing Period
          // ========================================
          // Note: billingPeriod and billingInterval are already declared at the top of the handler
          billingPeriod = null;
          billingInterval = null;
          if (sub.items && sub.items.data && sub.items.data.length > 0) {
            // Get billing period from first subscription item's price
            const firstItem = sub.items.data[0];
            if (firstItem.price && firstItem.price.id) {
              try {
                const priceRes = await stripeFetch(env, `/prices/${firstItem.price.id}`);
                if (priceRes.status === 200 && priceRes.body.recurring) {
                  billingInterval = priceRes.body.recurring.interval;
                  // Map Stripe interval to readable format
                  if (billingInterval === 'month') {
                    billingPeriod = 'monthly';
                  } else if (billingInterval === 'year') {
                    billingPeriod = 'yearly';
                  } else if (billingInterval === 'week') {
                    billingPeriod = 'weekly';
                  } else if (billingInterval === 'day') {
                    billingPeriod = 'daily';
                  } else {
                    billingPeriod = billingInterval; // fallback to raw value
                  }
                }
              } catch (priceErr) {
                // Silently continue if price fetch fails
              }
            }
          }
          
          // Get site metadata from subscription metadata (temporary storage from checkout)
          const subscriptionMetadata = sub.metadata || {};
          const sitesFromMetadata = [];
          Object.keys(subscriptionMetadata).forEach(key => {
            if (key.startsWith('site_')) {
              const index = parseInt(key.replace('site_', ''));
              sitesFromMetadata[index] = subscriptionMetadata[key];
            }
          });

          // ========================================
          // PROTECTION: Additional Use Case 3 check from subscription metadata
          // ========================================
          // Check subscription metadata for usecase === '3' (Use Case 3)
          const subscriptionUseCase = subscriptionMetadata.usecase;
          if (subscriptionUseCase === '3' || subscriptionUseCase === 3) {
            return new Response('ok');
          }

          // CRITICAL: Check if this is a quantity purchase BEFORE doing any site mapping
          // Check multiple sources for purchase_type
          // Note: purchaseType is already declared at handler scope above, so we're updating it here
          purchaseType = subscriptionMetadata.purchase_type || 'site';
          let quantity = parseInt(subscriptionMetadata.quantity) || 1;
          
          // Check session metadata (for checkout sessions created via /purchase-quantity)
          if (session && session.metadata) {
            if (session.metadata.purchase_type) {
              purchaseType = session.metadata.purchase_type;
            }
            if (session.metadata.quantity) {
              quantity = parseInt(session.metadata.quantity) || quantity;
            }
          }
          
          // Check subscription_data.metadata (PRIMARY SOURCE for /purchase-quantity and /purchase-quantity endpoint)
          if (session && session.subscription_data && session.subscription_data.metadata) {
            if (session.subscription_data.metadata.purchase_type) {
              purchaseType = session.subscription_data.metadata.purchase_type;
            }
            if (session.subscription_data.metadata.quantity) {
              quantity = parseInt(session.subscription_data.metadata.quantity) || quantity;
            }
          }
          
          // Treat 'license_addon' the same as 'quantity' purchases
          if (purchaseType === 'license_addon') {
            purchaseType = 'quantity';
          }
          
          // Ensure purchaseType is always set (fallback to 'site' if somehow undefined)
          if (!purchaseType) {
            purchaseType = 'site';
          }
          
          // Get user from database by email (all data is now in D1, not KV)
          let user = await getUserByEmail(env, email);
          
          if (!user) {
            // No existing user found - create new user record structure
              user = {
                email: email,
              customers: [{
                customerId: customerId,
                subscriptions: [{
                  subscriptionId: sub.id,
                  status: sub.status || 'active',
                  sites: {},
                  billingPeriod: billingPeriod || null // Add billing period
                }]
              }],
                sites: {}, // site -> { item_id, price, status }
              subscriptionId: sub.id
              };
            } else {
            // User exists - check if this customer/subscription already exists
            // CRITICAL: Preserve ALL existing subscriptions - only ADD new ones, never overwrite
            let customer = user.customers.find(c => c.customerId === customerId);
            if (!customer) {
              // New customer ID for this email - ADD new customer with new subscription
              user.customers.push({
                customerId: customerId,
                subscriptions: [{
                  subscriptionId: sub.id,
                  status: sub.status || 'active',
                  sites: {},
                  billingPeriod: billingPeriod || null // Add billing period
                }]
              });
            } else {
              // Customer exists - check if THIS subscription already exists
              let existingSubscription = customer.subscriptions.find(s => s.subscriptionId === sub.id);
              if (!existingSubscription) {
                // NEW subscription for existing customer - ADD it without modifying existing subscriptions
                customer.subscriptions.push({
                  subscriptionId: sub.id,
                  status: sub.status || 'active',
                  sites: {},
                  billingPeriod: billingPeriod || null // Add billing period
                });
              } else {
                // Subscription already exists - this is an update, not a new subscription
                // Update billing period if not already set
                if (billingPeriod && !existingSubscription.billingPeriod) {
                  existingSubscription.billingPeriod = billingPeriod;
                }
              }
            }
            
            // Set primary subscriptionId if not set (but don't overwrite if already set)
            if (!user.subscriptionId) {
              user.subscriptionId = sub.id;
            }
          }

          // Ensure email is set (in case it was missing)
          if (!user.email || user.email !== email) {
            user.email = email;
          }

          // Ensure sites object exists (for legacy structure)
          if (!user.sites) {
            user.sites = {};
          }
          
          // Ensure subscriptions object exists (for new structure)
          if (!user.subscriptions) {
            user.subscriptions = {};
          }
          
          if (!user.subscriptionId) {
            // No existing subscription - use this one
            user.subscriptionId = sub.id;
          } else if (user.subscriptionId !== sub.id) {
            // User has existing subscription, but this is a different one
            // This happens when user pays via payment link (creates new subscription)
            
            // Keep the original subscription as primary, but we'll add sites from this new subscription
            // Note: In Stripe, these are separate subscriptions, but in our system, we merge them under one user
            // The user will see all sites from both subscriptions in their dashboard
          }
          
          // Check if this checkout is adding items to an existing subscription
          // Note: addToExisting, existingSubscriptionId, isDirectLink, and paymentBy are already declared at handler scope
          // CRITICAL: Check metadata from multiple sources (payment link metadata flows to session/subscription)
          
          // Initialize from subscription metadata first
          existingSubscriptionId = subscriptionMetadata.existing_subscription_id || null;
          addToExisting = subscriptionMetadata.add_to_existing === 'true' || false;
          
          // Note: isDirectLink and paymentBy are already declared at handler scope
          // Reset to defaults
          isDirectLink = false;
          paymentBy = null;
          
          // CRITICAL: Check session.metadata FIRST (payment link metadata flows here)
          // Payment links can have metadata that flows to session.metadata
          if (session && session.metadata) {
            // Check for paymentby in session metadata (from payment link)
            if (session.metadata.paymentby) {
              paymentBy = session.metadata.paymentby;
            }
            // Check for add_to_existing in session metadata (from payment link)
            if (session.metadata.add_to_existing !== undefined) {
              addToExisting = session.metadata.add_to_existing === 'true' || session.metadata.add_to_existing === true;
            }
            // Check for existing_subscription_id in session metadata (from payment link)
            if (session.metadata.existing_subscription_id) {
              existingSubscriptionId = session.metadata.existing_subscription_id;
            }
          }
          
          // Check subscription metadata for paymentby
          if (subscriptionMetadata.paymentby) {
            paymentBy = subscriptionMetadata.paymentby;
          }
          
          // Check subscription_data.metadata for paymentby (payment link metadata can flow here too)
          if (session && session.subscription_data && session.subscription_data.metadata && session.subscription_data.metadata.paymentby) {
            paymentBy = session.subscription_data.metadata.paymentby;
          }
          
          // If paymentby is 'directlink', force new subscription creation
          if (paymentBy && paymentBy.toLowerCase() === 'directlink') {
            isDirectLink = true;
            addToExisting = false;
            existingSubscriptionId = null;
            // For direct payment links, ensure purchaseType is 'site' (direct links collect site domain via custom field)
            if (!purchaseType || purchaseType === 'site') {
              purchaseType = 'site';
            }
          }
          
          const isUseCase1 = !addToExisting || !existingSubscriptionId || isDirectLink;
          
         
          if (addToExisting && existingSubscriptionId && purchaseType !== 'quantity') {
            try {
              const existingSubRes = await stripeFetch(env, `/subscriptions/${existingSubscriptionId}`);
              if (existingSubRes.status === 200) {
                const existingSub = existingSubRes.body;
                const existingSubPurchaseType = existingSub.metadata?.purchase_type || 'site';
                if (existingSubPurchaseType === 'quantity') {
                  addToExisting = false; // Force new subscription - don't add site to quantity subscription
                }
              }
            } catch (e) {
            }
          }
          
        
          if (addToExisting && existingSubscriptionId) {
            
            // Get the existing subscription and verify it's active
            const existingSubRes = await stripeFetch(env, `/subscriptions/${existingSubscriptionId}`);
            if (existingSubRes.status === 200) {
              const existingSub = existingSubRes.body;
              
              // CRITICAL: Check if subscription is canceled or inactive
              // If canceled, we cannot add items - must create new subscription instead
              if (existingSub.status === 'canceled' || existingSub.status === 'incomplete_expired' || existingSub.status === 'unpaid') {
                addToExisting = false;
                existingSubscriptionId = null;
                // Fall through to create new subscription - skip the rest of this block
              } else if (existingSub.status !== 'active' && existingSub.status !== 'trialing') {
                addToExisting = false;
                existingSubscriptionId = null;
                // Fall through to create new subscription - skip the rest of this block
              } else {
                // Subscription is active - proceed with adding items
              
              // IMPORTANT: Preserve existing sites from the user record
              // Don't overwrite - merge with existing sites/
              if (!user.sites) user.sites = {};
              
              // Create a backup of existing sites to preserve them
              const existingSitesBackup = { ...user.sites };
              
              // Sync existing sites from Stripe subscription items to ensure consistency
              // Map Stripe items by item_id to find existing sites
              const stripeItemMap = new Map();
              if (existingSub.items && existingSub.items.data) {
                existingSub.items.data.forEach(existingItem => {
                  stripeItemMap.set(existingItem.id, existingItem);
                  
                  // If item has site metadata, update that site
                  const existingSite = existingItem.metadata?.site;
                  if (existingSite) {
                    if (user.sites[existingSite]) {
                      // Update existing site info from Stripe
                      user.sites[existingSite].item_id = existingItem.id;
                      user.sites[existingSite].price = existingItem.price.id;
                      user.sites[existingSite].quantity = existingItem.quantity;
                      user.sites[existingSite].status = existingItem.status; // Ensure it's active
                    } else {
                      // Site exists in Stripe but not in user record - add it
                      user.sites[existingSite] = {
                        item_id: existingItem.id,
                        price: existingItem.price.id,
                        quantity: existingItem.quantity,
                        status: 'active',
                        created_at: Math.floor(Date.now() / 1000)
                      };
                    }
                  }
                });
              }
              
              // Preserve existing sites that match Stripe items by item_id (even if no metadata)
              Object.keys(existingSitesBackup).forEach(site => {
                const existingSiteData = existingSitesBackup[site];
                if (existingSiteData.item_id && stripeItemMap.has(existingSiteData.item_id)) {
                  // This site exists in Stripe - preserve it and update from Stripe
                  const stripeItem = stripeItemMap.get(existingSiteData.item_id);
                  user.sites[site] = {
                    item_id: stripeItem.id,
                    price: stripeItem.price.id,
                    quantity: stripeItem.quantity,
                    status: existingSiteData.status === 'inactive' ? 'inactive' : 'active',
                    created_at: existingSiteData.created_at || Math.floor(Date.now() / 1000)
                  };
                } else if (existingSiteData.status === 'active' && existingSiteData.item_id) {
                  // Site is active but not found in Stripe - might have been removed, but keep it for now
                  // (customer.subscription.updated webhook will handle marking it inactive)
                  user.sites[site] = existingSiteData;
                }
              });
              
              // Add each new item to the existing subscription
              // CRITICAL: For quantity purchases, skip site mapping and only add quantity item
              if (purchaseType === 'quantity') {
                // Quantity purchase: Add single item with quantity to existing subscription
                const item = sub.items.data[0]; // Quantity purchases have one item with quantity > 1
                
                // Add subscription item to existing subscription with proration enabled
                const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
                  'subscription': existingSubscriptionId,
                  'price': item.price.id,
                  'quantity': item.quantity || quantity || 1,
                  'metadata[purchase_type]': 'quantity', // Mark as quantity purchase
                  'proration_behavior': 'create_prorations' // Explicitly enable proration
                }, true);
                
                if (addItemRes.status === 200) {
                  const newItem = addItemRes.body;
                  // Skip site mapping for quantity purchases - will only generate license keys later
                  // License keys will be generated in the license generation section below
                  
                  // For quantity purchases, cancel the new subscription since item was added to existing
                  try {
                    const cancelRes = await stripeFetch(env, `/subscriptions/${sub.id}`, 'DELETE', {}, false);
                    if (cancelRes.status === 200) {
                    } else {
                      const cancelRes2 = await stripeFetch(env, `/subscriptions/${sub.id}`, 'POST', { 
                        cancel_at_period_end: false 
                      }, true);
                      if (cancelRes2.status === 200) {
                      }
                    }
                  } catch (err) {
                    console.error(`[${operationId}] Failed to cancel duplicate subscription:`, err);
                  }
                } else {
                  console.error(`[${operationId}] Failed to add quantity item to subscription:`, addItemRes.status, addItemRes.body);
                  // CRITICAL: If adding to existing subscription failed (e.g., subscription is canceled),
                  // we need to use the NEW subscription instead and generate licenses for it
                  // Clear addToExisting flag so we use the new subscription
                  addToExisting = false;
                  existingSubscriptionId = null;
                  // The new subscription (sub.id) will be used for license generation below
                }
              } else {
                // Site purchase: Add items with site metadata
              for (let index = 0; index < sub.items.data.length; index++) {
                const item = sub.items.data[index];
                // Sites are stored in metadata (site_0, site_1, etc.)
                const site = sitesFromMetadata[index] || `site_${index + 1}`;
                
                  // Add subscription item to existing subscription with proration enabled
                  // Stripe automatically calculates prorated amount when adding items mid-cycle
                const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
                  'subscription': existingSubscriptionId,
                  'price': item.price.id,
                  'quantity': item.quantity || 1,
                    'metadata[site]': site,
                    'metadata[purchase_type]': 'site', // Mark as site purchase
                    'proration_behavior': 'create_prorations' // Explicitly enable proration
                }, true);
                
                if (addItemRes.status === 200) {
                  const newItem = addItemRes.body;
                  
                    const siteData = {
                    item_id: newItem.id,
                    price: newItem.price.id,
                    quantity: newItem.quantity,
                    status: 'active',
                      created_at: Math.floor(Date.now() / 1000),
                      subscription_id: existingSubscriptionId
                    };
                    
                    // Add new site to user record (preserving existing sites) - legacy structure
                    user.sites[site] = siteData;
                    
                    // ALSO store in subscriptions structure (NEW structure)
                    if (!user.subscriptions) {
                      user.subscriptions = {};
                    }
                    if (!user.subscriptions[existingSubscriptionId]) {
                      user.subscriptions[existingSubscriptionId] = {
                        subscriptionId: existingSubscriptionId,
                        status: 'active',
                        sites: {},
                    created_at: Math.floor(Date.now() / 1000)
                  };
                    }
                    user.subscriptions[existingSubscriptionId].sites[site] = siteData;
                    user.subscriptions[existingSubscriptionId].sitesCount = Object.keys(user.subscriptions[existingSubscriptionId].sites).length;
                    
                    // Remove from pending sites in user object
                    if (user.pendingSites) {
                      user.pendingSites = user.pendingSites.filter(p => 
                        (p.site || p).toLowerCase().trim() !== site.toLowerCase().trim()
                      );
                    }
                    
                    // Remove from pending sites in database
                    if (env.DB) {
                      try {
                        await env.DB.prepare(
                          'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                        ).bind(email, site.toLowerCase().trim()).run();
                      } catch (dbError) {
                        console.error(`Failed to remove pending site from database:`, dbError);
                      }
                    }
                    
                    // Generate license key for newly added site
                    if (env.DB) {
                      try {
                        // Check if license already exists
                        const existingLicense = await env.DB.prepare(
                          'SELECT license_key FROM licenses WHERE customer_id = ? AND site_domain = ? AND status = ? LIMIT 1'
                        ).bind(customerId, site, 'active').first();
                        
                        if (!existingLicense) {
                          const licenseKey = await generateUniqueLicenseKey(env);
                          const timestamp = Math.floor(Date.now() / 1000);
                          // CRITICAL: For site-based purchases, set both site_domain and used_site_domain to the same site
                          // This marks the license as "used" and tied to this specific site - cannot be reused
                          await env.DB.prepare(
                            'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, used_site_domain, license_key, status, purchase_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                          ).bind(customerId, existingSubscriptionId, newItem.id, site, site, licenseKey, 'active', 'site', timestamp, timestamp).run();
                          console.log(`[add-site] ✅ Created site-based license ${licenseKey} for site ${site} (marked as used)`);
                        } else {
                          console.log(`[add-site] ℹ️ License already exists for site ${site}, skipping creation`);
                        }
                      } catch (licenseError) {
                        console.error(`Failed to generate license for site ${site}:`, licenseError);
                      }
                    }
                    
                } else {
                  console.error('Failed to add item to existing subscription:', addItemRes.status, addItemRes.body);
                }
              }
              
                // Cancel the new subscription immediately (we don't need it, items are in existing subscription)
                // This prevents double charging - items are already added to existing subscription with proration
                // Note: Quantity purchases already handle cancellation above
                if (purchaseType !== 'quantity') {
                  try {
                    // Try DELETE first (immediate cancellation and refund)
                    const cancelRes = await stripeFetch(env, `/subscriptions/${sub.id}`, 'DELETE', {}, false);
                    if (cancelRes.status === 200) {
                    } else {
                      // Fallback: cancel immediately (no refund, but stops future charges)
                      const cancelRes2 = await stripeFetch(env, `/subscriptions/${sub.id}`, 'POST', { 
                        cancel_at_period_end: false 
                      }, true);
                      if (cancelRes2.status === 200) {
                      } else {
                        console.warn(`⚠️ Could not cancel duplicate subscription ${sub.id} - customer may be charged twice`);
                      }
                    }
                  } catch (err) {
                console.error('Failed to cancel duplicate subscription:', err);
                  }
                }
              }
              
              // Update user to use existing subscription
              user.subscriptionId = existingSubscriptionId;
              
              // Remove pending sites that were just added
              // Match by site name (case-insensitive) or by checking if site is now in user.sites
              if (user.pendingSites && user.pendingSites.length > 0) {
                // STEP 1: Get list of added sites BEFORE filtering user.pendingSites
                const addedSites = sub.items.data.map((item, idx) => {
                  const siteFromMeta = sitesFromMetadata[idx] || `site_${idx + 1}`;
                  // Also check item metadata for site name
                  const siteFromItem = item.metadata?.site;
                  return (siteFromItem || siteFromMeta).toLowerCase().trim();
                });
                
                // Also get sites that are now in user.sites (they were successfully added)
                const sitesInUserRecord = Object.keys(user.sites || {}).map(s => s.toLowerCase().trim());
                
                // Get all sites that were just added (from the items we just added to existing subscription)
                const justAddedSites = [];
                for (let idx = 0; idx < sub.items.data.length; idx++) {
                  const site = sitesFromMetadata[idx] || `site_${idx + 1}`;
                  justAddedSites.push(site.toLowerCase().trim());
                }
                
                // Combine all added sites (from subscription items, just added sites, and user.sites)
                const allAddedSites = [...new Set([...addedSites, ...justAddedSites, ...sitesInUserRecord])];
                
                // STEP 2: Delete pending sites from database FIRST (before filtering user.pendingSites)
                // This ensures we delete ALL added sites, even if they're removed from user.pendingSites during filtering
                if (env.DB && allAddedSites.length > 0) {
                  console.log(`[${operationId}] 🗑️ Removing ${allAddedSites.length} pending site(s) from database (add to existing):`, allAddedSites);
                  for (const addedSite of allAddedSites) {
                    try {
                      const deleteResult = await env.DB.prepare(
                        'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                      ).bind(email, addedSite).run();
                      if (deleteResult.success) {
                        console.log(`[${operationId}] ✅ Deleted pending site from database: ${addedSite}`);
                      } else {
                        console.warn(`[${operationId}] ⚠️ Delete query succeeded but no rows affected for: ${addedSite}`);
                      }
                    } catch (dbError) {
                      console.error(`[${operationId}] ❌ Failed to remove pending site ${addedSite} from database:`, dbError);
                    }
                  }
                }
                
                // STEP 3: Now filter user.pendingSites to remove added sites
                const beforeCount = user.pendingSites.length;
                
                // Remove pending sites that match any added site (case-insensitive)
                // Also remove if the site is now in user.sites (was successfully added)
                user.pendingSites = user.pendingSites.filter(pending => {
                  const pendingSiteLower = (pending.site || pending.site_domain || pending).toLowerCase().trim();
                  const isAdded = allAddedSites.includes(pendingSiteLower);
                  if (isAdded) {
                    console.log(`[${operationId}] 🗑️ Removing pending site from user object: ${pendingSiteLower}`);
                  }
                  return !isAdded;
                });
                
                const afterCount = user.pendingSites.length;
                console.log(`[${operationId}] 🗑️ Pending sites (add to existing): ${beforeCount} → ${afterCount} (removed ${beforeCount - afterCount})`);
                
                if (afterCount > 0) {
                  // If we added sites but pending sites remain, they might be from a different source
                  // Remove any pending sites that are now in user.sites (double-check)
                  const stillPending = user.pendingSites.filter(pending => {
                    const pendingSiteLower = (pending.site || pending.site_domain || pending).toLowerCase().trim();
                    const isNowActive = sitesInUserRecord.includes(pendingSiteLower);
                    if (isNowActive) {
                      console.log(`[${operationId}] 🗑️ Removing pending site (double-check): ${pendingSiteLower}`);
                    }
                    return !isNowActive;
                  });
                  user.pendingSites = stillPending;
                }
              }
              
              // CRITICAL: Retry database update for user sites (payment already successful)
              // Note: failedOperations is declared later in the function scope
              // CRITICAL: Load complete user from database before saving to preserve ALL subscriptions
              let userSitesSaved = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  // Load complete user structure from database to ensure we preserve ALL subscriptions
                  let completeUser = await getUserByEmail(env, email);
                  if (completeUser) {
                    // Merge the current user's data into the complete user structure
                    // This ensures we don't lose any existing subscriptions
                    if (!completeUser.customers) {
                      completeUser.customers = [];
                    }
                    
                    // Merge customers and subscriptions from current user into complete user
                    if (user.customers && user.customers.length > 0) {
                      for (const currentCustomer of user.customers) {
                        let completeCustomer = completeUser.customers.find(c => c.customerId === currentCustomer.customerId);
                        if (!completeCustomer) {
                          // Add new customer
                          completeUser.customers.push(currentCustomer);
                        } else {
                          // Merge subscriptions - add new ones, update existing ones
                          if (currentCustomer.subscriptions && currentCustomer.subscriptions.length > 0) {
                            for (const currentSub of currentCustomer.subscriptions) {
                              let existingSub = completeCustomer.subscriptions.find(s => s.subscriptionId === currentSub.subscriptionId);
                              if (!existingSub) {
                                // Add new subscription
                                completeCustomer.subscriptions.push(currentSub);
                              } else {
                                // Update existing subscription (merge items)
                                if (currentSub.items && currentSub.items.length > 0) {
                                  for (const item of currentSub.items) {
                                    let existingItem = existingSub.items.find(i => i.item_id === item.item_id);
                                    if (!existingItem) {
                                      existingSub.items.push(item);
                                    }
                                  }
                                }
                                // Update status and other fields, preserving billingPeriod if currentSub has it
                                Object.assign(existingSub, currentSub);
                                // CRITICAL: Ensure billingPeriod is preserved/updated
                                if (currentSub.billingPeriod) {
                                  existingSub.billingPeriod = currentSub.billingPeriod;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                    
                    // Save the complete merged user structure
                    await saveUserByEmail(env, email, completeUser);
                  } else {
                    // Fallback: if we can't load from database, save the current user
                    await saveUserByEmail(env, email, user);
                  }
                  userSitesSaved = true;
                  const totalSites = (completeUser || user).customers.reduce((sum, c) => sum + c.subscriptions.reduce((s, sub) => s + (sub.items?.length || 0), 0), 0);
                  break;
                } catch (dbError) {
                  if (attempt === 2) {
                    console.error(`[${operationId}] CRITICAL: Failed to save user sites after 3 attempts:`, dbError);
                    failedOperations.push({ 
                      type: 'save_user_sites', 
                      error: dbError.message,
                      data: { customerId, subscriptionId, email }
                    });
                  } else {
                    const delay = 1000 * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                  }
                }
              }
              
              // Continue to payment processing below (skip normal mapping since we already handled it)
              } // End of else block for active subscription
            } else {
              console.error(`[${operationId}] Failed to fetch existing subscription: ${existingSubscriptionId} (status: ${existingSubRes.status})`);
              // Subscription doesn't exist or is invalid - create new subscription instead
              addToExisting = false;
              existingSubscriptionId = null;
              // Fall through to normal flow
            }
          }
          
          // Initialize itemsForEmailStructure for all purchase types (needed for database structure)
          // For quantity purchases, this will remain empty (no sites to map)
          // For site purchases, this will be populated in the site mapping loop below
          let itemsForEmailStructure = [];
          
          // Normal flow: map items to sites for new subscription (only if not adding to existing)
          // CRITICAL: Skip site mapping for quantity purchases - they don't have sites
          if ((!addToExisting || !existingSubscriptionId) && purchaseType !== 'quantity') {
            // Store default price from first subscription item for future use
            if (sub.items && sub.items.data && sub.items.data.length > 0 && !user.defaultPrice) {
              user.defaultPrice = sub.items.data[0].price.id;
            }

            // Ensure subscriptions structure exists
            if (!user.subscriptions) {
              user.subscriptions = {};
            }
            // Ensure this subscription exists in subscriptions structure
            if (!user.subscriptions[subscriptionId]) {
              user.subscriptions[subscriptionId] = {
                subscriptionId: subscriptionId,
                status: 'active',
                sites: {},
                billingPeriod: billingPeriod, // Add billing period (monthly, yearly, daily, etc.)
                created_at: Math.floor(Date.now() / 1000)
              };
            } else {
              // Update billing period if not already set
              if (!user.subscriptions[subscriptionId].billingPeriod && billingPeriod) {
                user.subscriptions[subscriptionId].billingPeriod = billingPeriod;
              }
            }

            // Map each subscription item to its site
            // CRITICAL: Extract actual site names from metadata, not generic "site_1"
            const itemsForEmailStructure = [];
            
            // Fetch all licenses for sites in this subscription (batch fetch for efficiency)
            const siteNames = sub.items.data.map((item, index) => 
              item.metadata?.site || sitesFromMetadata[index] || `site_${index + 1}`
            );
            const licensesMap = await getLicensesForSites(env, siteNames, customerId, subscriptionId);
            
            for (let index = 0; index < sub.items.data.length; index++) {
              const item = sub.items.data[index];
              // Priority order for site name:
              // 1. Item metadata (set when item is created/updated)
              // 2. Subscription metadata (site_0, site_1, etc. from checkout)
              // 3. Custom field from checkout session (for initial subscriptions)
              // 4. Payments table site_domain (if available - this is the source of truth from checkout)
              // 5. Fallback to index-based naming only if nothing else available
              let site = item.metadata?.site || 
                        sitesFromMetadata[index] || 
                        (index === 0 && customFieldSiteUrl ? customFieldSiteUrl : null) ||
                        `site_${index + 1}`;
              
              // CRITICAL: If site is still a placeholder, check payments table for actual site_domain
              // The payments table stores the actual site domain entered during checkout
              // BUT: Skip this for quantity purchases - they don't have site domains
              if ((!site || site.startsWith('site_') && /^site_\d+$/.test(site)) && env.DB && purchaseType !== 'quantity') {
                try {
                  // Try to get from payments table - this is the source of truth
                  const paymentCheck = await env.DB.prepare(
                    'SELECT site_domain FROM payments WHERE subscription_id = ? AND site_domain IS NOT NULL AND site_domain != ? AND site_domain != "" ORDER BY created_at DESC LIMIT 1'
                  ).bind(subscriptionId, 'unknown').first();
                  
                  if (paymentCheck && paymentCheck.site_domain && !paymentCheck.site_domain.startsWith('site_')) {
                    site = paymentCheck.site_domain;
                  } else {
                    // Try with customer ID as well (in case subscription_id doesn't match yet)
                    const paymentCheckByCustomer = await env.DB.prepare(
                      'SELECT site_domain FROM payments WHERE customer_id = ? AND site_domain IS NOT NULL AND site_domain != ? AND site_domain != "" ORDER BY created_at DESC LIMIT 1'
                    ).bind(customerId, 'unknown').first();
                    
                    if (paymentCheckByCustomer && paymentCheckByCustomer.site_domain && !paymentCheckByCustomer.site_domain.startsWith('site_')) {
                      site = paymentCheckByCustomer.site_domain;
                    }
                  }
                } catch (paymentErr) {
                }
              }
              
              // CRITICAL: If we found the real site name (from custom field or payments table), 
              // update the subscription item metadata so it's stored in Stripe for future reference
              // BUT: Never set site metadata for quantity purchases - they don't have sites
              if (purchaseType !== 'quantity' && site && site !== `site_${index + 1}` && (!item.metadata?.site || item.metadata.site === `site_${index + 1}` || item.metadata.site.startsWith('site_'))) {
                try {
                  await stripeFetch(env, `/subscription_items/${item.id}`, 'POST', {
                    'metadata[site]': site,
                    'metadata[purchase_type]': 'site' // Ensure purchase_type is set
                  }, true);
                } catch (updateError) {
                  console.error(`[${operationId}] Failed to update subscription item metadata:`, updateError);
                  // Continue anyway - we have the site name
                }
              } else if (purchaseType === 'quantity') {
                // For quantity purchases, ensure purchase_type metadata is set (but NO site metadata)
                if (!item.metadata?.purchase_type || item.metadata.purchase_type !== 'quantity') {
                  try {
                    await stripeFetch(env, `/subscription_items/${item.id}`, 'POST', {
                      'metadata[purchase_type]': 'quantity'
                      // Explicitly do NOT set site metadata
                    }, true);
                  } catch (updateError) {
                    console.error(`[${operationId}] Failed to update subscription item metadata:`, updateError);
                  }
                }
              }
              
              // Log what we found
              
              // Get license for this site (already fetched in batch, but check if missing)
              let license = licensesMap[site];
              if (!license) {
                license = await getLicenseForSite(env, site, customerId, subscriptionId);
              }
              
              // Get subscription details for renewal date and period info
              const subDetails = sub;
              
              // Get price details for amount paid
              const priceDetailsRes = await stripeFetch(env, `/prices/${item.price.id}`);
              const priceDetails = priceDetailsRes.status === 200 ? priceDetailsRes.body : null;
              
              const siteData = {
                item_id: item.id,
                price: item.price.id,
                quantity: item.quantity,
                status: 'active',
                created_at: Math.floor(Date.now() / 1000),
                subscription_id: subscriptionId,
                license: license || null,  // Add license info to site object
                current_period_start: subDetails.current_period_start,
                current_period_end: subDetails.current_period_end,
                renewal_date: subDetails.current_period_end,
                cancel_at_period_end: subDetails.cancel_at_period_end || false,
                canceled_at: subDetails.canceled_at || null
              };
              
              // Save site details to database
              if (env.DB && priceDetails) {
                await saveOrUpdateSiteInDB(env, {
                  customerId: customerId,
                  subscriptionId: subscriptionId,
                  itemId: item.id,
                  siteDomain: site,
                  priceId: item.price.id,
                  amountPaid: priceDetails.unit_amount || amount || 0, // Use price amount or payment amount
                  currency: priceDetails.currency || currency || 'usd',
                  status: 'active',
                  currentPeriodStart: subDetails.current_period_start,
                  currentPeriodEnd: subDetails.current_period_end,
                  renewalDate: subDetails.current_period_end,
                  cancelAtPeriodEnd: subDetails.cancel_at_period_end || false,
                  canceledAt: subDetails.canceled_at || null
                });
              }
              
              // Prepare item for email-based structure (NEW PRIMARY STRUCTURE)
              itemsForEmailStructure.push({
                item_id: item.id,
                site: site,  // Actual site name/domain
                price: item.price.id,
                quantity: item.quantity,
                status: 'active',
                created_at: Math.floor(Date.now() / 1000),
                license: license || null  // Add license info to item
              });
              
              // Update site mapping (legacy structure - keep for backward compatibility)
              user.sites[site] = siteData;
              
              // ALSO store in subscriptions structure (NEW structure)
              // Ensure subscription object exists
              if (!user.subscriptions) {
                user.subscriptions = {};
              }
              if (!user.subscriptions[subscriptionId]) {
                user.subscriptions[subscriptionId] = {
                  subscriptionId: subscriptionId,
                  status: 'active',
                  sites: {},
                created_at: Math.floor(Date.now() / 1000)
              };
              }
              if (!user.subscriptions[subscriptionId].sites) {
                user.subscriptions[subscriptionId].sites = {};
              }
              user.subscriptions[subscriptionId].sites[site] = siteData;

              // Also set metadata on the subscription item for future reference
              // BUT: Never set site metadata for quantity purchases
              if (purchaseType !== 'quantity' && (!item.metadata || !item.metadata.site)) {
                // Format metadata correctly for form-encoded request
                const metadataForm = {
                  'metadata[site]': site,
                  'metadata[purchase_type]': 'site' // Ensure purchase_type is set
                };
                stripeFetch(env, `/subscription_items/${item.id}`, 'POST', metadataForm, true).catch(err => {
                  console.error('Failed to set item metadata:', err);
                });
              } else if (purchaseType === 'quantity') {
                // For quantity purchases, ensure purchase_type is set but NO site metadata
                if (!item.metadata?.purchase_type || item.metadata.purchase_type !== 'quantity') {
                  const metadataForm = {
                    'metadata[purchase_type]': 'quantity'
                    // Explicitly do NOT set site metadata
                  };
                  stripeFetch(env, `/subscription_items/${item.id}`, 'POST', metadataForm, true).catch(err => {
                    console.error('Failed to set item metadata for quantity purchase:', err);
                  });
                }
              }
            }
            
            // Update subscription metadata (only for site-based purchases)
            if (purchaseType !== 'quantity') {
              user.subscriptions[subscriptionId].sitesCount = Object.keys(user.subscriptions[subscriptionId].sites).length;
            }
            user.subscriptionId = subscriptionId; // Keep for backward compatibility
            
            // CRITICAL: For quantity purchases, skip site mapping entirely
            // Quantity purchases don't have sites - they only generate license keys
            if (purchaseType === 'quantity') {
              // Still need to create subscription record for quantity purchases
              // Save subscription items to database for quantity purchases
              const quantityItems = [];
              if (sub.items && sub.items.data && sub.items.data.length > 0) {
                for (const item of sub.items.data) {
                  quantityItems.push({
                    item_id: item.id,
                    site: '', // Quantity purchases don't have sites - use empty string (schema requires NOT NULL)
                    price: item.price.id,
                    quantity: item.quantity || 1,
                    status: 'active',
                    created_at: Math.floor(Date.now() / 1000)
                  });
                }
              }
              try {
                await addOrUpdateCustomerInUser(env, email, customerId, subscriptionId, quantityItems, billingPeriod);
              } catch (emailStructureError) {
                console.error(`[${operationId}] ❌ Failed to create subscription record:`, emailStructureError);
              }
            } else {
              // CRITICAL: ALSO save to email-based structure (NEW PRIMARY STRUCTURE)
              // This stores data with email as primary key: user:email -> { email, customers: [{ customerId, subscriptions: [{ subscriptionId, items: [...] }] }] }
              // CRITICAL: For initial purchases, itemsForEmailStructure might be empty if sub.items.data is empty
              // In that case, we need to create an item from the subscription's single item
              let itemsToSave = itemsForEmailStructure;
              if (itemsToSave.length === 0 && sub.items && sub.items.data && sub.items.data.length > 0) {
                for (let index = 0; index < sub.items.data.length; index++) {
                  const item = sub.items.data[index];
                  // Get site name - prioritize custom field for initial purchases
                  let site = item.metadata?.site;
                  if (!site) {
                    site = sitesFromMetadata[index];
                    if (!site && index === 0 && customFieldSiteUrl) {
                      site = customFieldSiteUrl;
                    }
                    if (!site) {
                      site = `site_${index + 1}`;
                    }
                  }
                  
                  itemsToSave.push({
                    item_id: item.id,
                    site: site,
                    price: item.price.id,
                    quantity: item.quantity,
                    status: 'active',
                    created_at: Math.floor(Date.now() / 1000)
                  });
                }
              }
              
              try {
                await addOrUpdateCustomerInUser(env, email, customerId, subscriptionId, itemsToSave, billingPeriod);
              } catch (emailStructureError) {
                console.error(`[${operationId}] ❌ Failed to save to email-based structure:`, emailStructureError);
                // Don't fail the entire operation - legacy structure is still saved
              }
              
              // CRITICAL: Explicitly save subscription_items to database for site purchases (Use Case 2)
              // This ensures subscription_items are saved even if addOrUpdateCustomerInUser has issues
              console.log(`[${operationId}] 💾 Explicitly saving ${itemsToSave.length} subscription item(s) to database for site purchases...`);
              for (const item of itemsToSave) {
                try {
                  console.log(`[${operationId}] 💾 Saving subscription item to database: ${item.item_id} (site: ${item.site || item.site_domain})`);
                  
                  // Try with price_id column first (newer schema)
                  try {
                    await env.DB.prepare(
                      `INSERT OR REPLACE INTO subscription_items 
                       (subscription_id, item_id, site_domain, price_id, quantity, status, created_at, updated_at, removed_at) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                      subscriptionId,
                      item.item_id,
                      item.site || item.site_domain || '',
                      item.price || item.price_id,
                      item.quantity || 1,
                      item.status || 'active',
                      item.created_at || Math.floor(Date.now() / 1000),
                      Math.floor(Date.now() / 1000),
                      null
                    ).run();
                    console.log(`[${operationId}] ✅ Saved subscription item: ${item.item_id} (with price_id column)`);
                  } catch (priceIdError) {
                    // If price_id column doesn't exist, try without it (older schema)
                    if (priceIdError.message && priceIdError.message.includes('no such column: price_id')) {
                      console.log(`[${operationId}] ⚠️ price_id column not found, trying without it...`);
                      await env.DB.prepare(
                        `INSERT OR REPLACE INTO subscription_items 
                         (subscription_id, item_id, site_domain, quantity, status, created_at, updated_at, removed_at) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                      ).bind(
                        subscriptionId,
                        item.item_id,
                        item.site || item.site_domain || '',
                        item.quantity || 1,
                        item.status || 'active',
                        item.created_at || Math.floor(Date.now() / 1000),
                        Math.floor(Date.now() / 1000),
                        null
                      ).run();
                      console.log(`[${operationId}] ✅ Saved subscription item: ${item.item_id} (without price_id column)`);
                    } else {
                      throw priceIdError; // Re-throw if it's a different error
                    }
                  }
                } catch (itemError) {
                  console.error(`[${operationId}] ❌ Failed to save subscription item ${item.item_id} to database:`, itemError);
                  // Continue with other items even if one fails
                }
              }
              console.log(`[${operationId}] ✅ Finished explicitly saving subscription items for site purchases`);
            }

            // CRITICAL: Reload user object to get fresh pending sites from database
            // This ensures we have the latest pending sites that might have been added just before checkout
            console.log(`[${operationId}] 🔍 STEP 1: Checking for pending sites to remove...`);
            let freshUser = await getUserByEmail(env, email);
            if (freshUser && freshUser.pendingSites && freshUser.pendingSites.length > 0) {
              // Use fresh user's pending sites
              console.log(`[${operationId}] 🔄 Reloaded user object - found ${freshUser.pendingSites.length} pending site(s) in database:`, freshUser.pendingSites.map(ps => ({ site: ps.site || ps.site_domain, price: ps.price || ps.price_id })));
              user.pendingSites = freshUser.pendingSites;
            } else if (user.pendingSites && user.pendingSites.length > 0) {
              console.log(`[${operationId}] ⚠️ Using existing user object - found ${user.pendingSites.length} pending site(s):`, user.pendingSites.map(ps => ({ site: ps.site || ps.site_domain, price: ps.price || ps.price_id })));
            } else {
              console.log(`[${operationId}] ℹ️ No pending sites found in user object`);
            }
            
            // Remove pending sites that were just added (for new subscription flow)
            if (user.pendingSites && user.pendingSites.length > 0) {
              console.log(`[${operationId}] 🔍 STEP 2: Processing ${user.pendingSites.length} pending site(s) for removal...`);
              // STEP 1: Get list of added sites BEFORE filtering user.pendingSites
              console.log(`[${operationId}] 🔍 STEP 2.1: Extracting site names from subscription items...`);
              const addedSites = sub.items.data.map((item, index) => {
                const siteFromMeta = sitesFromMetadata[index] || `site_${index + 1}`;
                // Also check item metadata for site name
                const siteFromItem = item.metadata?.site;
                const finalSite = (siteFromItem || siteFromMeta).toLowerCase().trim();
                console.log(`[${operationId}]   - Item ${index}: metadata=${siteFromItem}, subscriptionMeta=${sitesFromMetadata[index]}, final=${finalSite}`);
                return finalSite;
              });
              console.log(`[${operationId}] ✅ Extracted ${addedSites.length} site(s) from subscription items:`, addedSites);
              
              // Also get sites that are now in user.sites (they were successfully added)
              const sitesInUserRecord = Object.keys(user.sites || {}).map(s => s.toLowerCase().trim());
              console.log(`[${operationId}] ✅ Found ${sitesInUserRecord.length} site(s) in user.sites:`, sitesInUserRecord);
              
              // CRITICAL: Also check pending sites - if a pending site matches this subscription's price,
              // it was likely just purchased, so include it in the removal list
              // This handles cases where the site name isn't in subscription metadata yet
              console.log(`[${operationId}] 🔍 STEP 2.2: Matching pending sites by price ID...`);
              const pendingSitesToRemove = [];
              if (sub.items && sub.items.data && sub.items.data.length > 0) {
                const subscriptionPriceId = sub.items.data[0].price.id;
                console.log(`[${operationId}]   - Subscription price ID: ${subscriptionPriceId}`);
                user.pendingSites.forEach((pending, idx) => {
                  const pendingPrice = pending.price || pending.price_id;
                  const pendingSiteName = (pending.site || pending.site_domain || '').toLowerCase().trim();
                  console.log(`[${operationId}]   - Pending site ${idx + 1}: ${pendingSiteName}, price: ${pendingPrice}`);
                  // If pending site has the same price as this subscription, it was likely just purchased
                  if (pendingPrice === subscriptionPriceId) {
                    if (pendingSiteName && !pendingSiteName.startsWith('site_')) {
                      console.log(`[${operationId}]   ✅ MATCH by price: ${pendingSiteName} (price: ${pendingPrice})`);
                      pendingSitesToRemove.push(pendingSiteName);
                    } else {
                      console.log(`[${operationId}]   ⚠️ Skipping ${pendingSiteName} - invalid site name`);
                    }
                  } else {
                    console.log(`[${operationId}]   ❌ No match: ${pendingSiteName} (price: ${pendingPrice} !== ${subscriptionPriceId})`);
                  }
                });
              }
              console.log(`[${operationId}] ✅ Found ${pendingSitesToRemove.length} pending site(s) matching by price:`, pendingSitesToRemove);
              
              // Combine all added sites (from subscription items, user.sites, and matching pending sites)
              const allAddedSites = [...new Set([...addedSites, ...sitesInUserRecord, ...pendingSitesToRemove])];
              console.log(`[${operationId}] ✅ STEP 2.3: Combined ${allAddedSites.length} unique site(s) to remove:`, allAddedSites);
              
              // STEP 2: Delete pending sites from database FIRST (before filtering user.pendingSites)
              // This ensures we delete ALL added sites, even if they're removed from user.pendingSites during filtering
              if (env.DB) {
                console.log(`[${operationId}] 🔍 STEP 2.4: Starting database deletion process...`);
                // If we have pending sites to remove by price match, delete them directly
                if (pendingSitesToRemove.length > 0) {
                  console.log(`[${operationId}] 🗑️ STEP 2.4.1: Removing ${pendingSitesToRemove.length} pending site(s) by price match:`, pendingSitesToRemove);
                  let deletedByPrice = 0;
                  for (const siteToRemove of pendingSitesToRemove) {
                    try {
                      console.log(`[${operationId}]   - Attempting to delete: ${siteToRemove} (email: ${email})`);
                      const deleteResult = await env.DB.prepare(
                        'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                      ).bind(email, siteToRemove).run();
                      if (deleteResult.success) {
                        console.log(`[${operationId}]   ✅ Deleted pending site from database (price match): ${siteToRemove}`);
                        deletedByPrice++;
                      } else {
                        console.warn(`[${operationId}]   ⚠️ Delete query succeeded but no rows affected for: ${siteToRemove}`);
                      }
                    } catch (dbError) {
                      console.error(`[${operationId}]   ❌ Failed to remove pending site ${siteToRemove} from database:`, dbError);
                    }
                  }
                  console.log(`[${operationId}] ✅ Deleted ${deletedByPrice}/${pendingSitesToRemove.length} pending site(s) by price match`);
                } else {
                  console.log(`[${operationId}] ℹ️ No pending sites to remove by price match`);
                }
                
                // Also delete by site name match if we have added sites
                if (allAddedSites.length > 0) {
                  console.log(`[${operationId}] 🗑️ STEP 2.4.2: Removing ${allAddedSites.length} pending site(s) from database (name match):`, allAddedSites);
                  let deletedByName = 0;
                  for (const addedSite of allAddedSites) {
                    // Skip if already deleted above
                    if (pendingSitesToRemove.includes(addedSite)) {
                      console.log(`[${operationId}]   ⏭️ Skipping ${addedSite} - already deleted by price match`);
                      continue;
                    }
                    
                    try {
                      console.log(`[${operationId}]   - Attempting to delete: ${addedSite} (email: ${email})`);
                      const deleteResult = await env.DB.prepare(
                        'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                      ).bind(email, addedSite).run();
                      if (deleteResult.success) {
                        console.log(`[${operationId}]   ✅ Deleted pending site from database (name match): ${addedSite}`);
                        deletedByName++;
                      } else {
                        console.warn(`[${operationId}]   ⚠️ Delete query succeeded but no rows affected for: ${addedSite}`);
                      }
                    } catch (dbError) {
                      console.error(`[${operationId}]   ❌ Failed to remove pending site ${addedSite} from database:`, dbError);
                    }
                  }
                  console.log(`[${operationId}] ✅ Deleted ${deletedByName}/${allAddedSites.length} pending site(s) by name match`);
                } else {
                  console.log(`[${operationId}] ℹ️ No pending sites to remove by name match`);
                }
                
                // FALLBACK: If subscription was just created and we have pending sites with matching price,
                // remove ALL pending sites with that price (in case site name matching failed)
                // CRITICAL: This should run even if we found some matches, to catch any missed ones
                if (sub.items && sub.items.data && sub.items.data.length > 0 && user.pendingSites && user.pendingSites.length > 0) {
                  const subscriptionPriceId = sub.items.data[0].price.id;
                  const matchingPendingSites = user.pendingSites.filter(ps => {
                    const psPrice = ps.price || ps.price_id;
                    return psPrice === subscriptionPriceId;
                  });
                  
                  // Remove ALL matching pending sites by price, regardless of whether name matching worked
                  // This ensures we catch all pending sites that were just purchased
                  if (matchingPendingSites.length > 0) {
                    console.log(`[${operationId}] 🗑️ STEP 2.4.3: FALLBACK - Removing ${matchingPendingSites.length} pending site(s) by price match:`, matchingPendingSites.map(ps => ({ site: ps.site || ps.site_domain, price: ps.price || ps.price_id })));
                    let deletedByFallback = 0;
                    for (const pendingSite of matchingPendingSites) {
                      const siteToRemove = (pendingSite.site || pendingSite.site_domain || '').toLowerCase().trim();
                      if (siteToRemove && !siteToRemove.startsWith('site_')) {
                        // Skip if already in allAddedSites (was already removed)
                        if (allAddedSites.includes(siteToRemove)) {
                          console.log(`[${operationId}]   ⏭️ Skipping ${siteToRemove} - already removed by name/price match`);
                          continue;
                        }
                        
                        try {
                          console.log(`[${operationId}]   - Attempting to delete (fallback): ${siteToRemove} (email: ${email})`);
                          const deleteResult = await env.DB.prepare(
                            'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                          ).bind(email, siteToRemove).run();
                          if (deleteResult.success) {
                            console.log(`[${operationId}]   ✅ Deleted pending site from database (fallback price match): ${siteToRemove}`);
                            deletedByFallback++;
                            // Add to allAddedSites so it gets removed from user object too
                            if (!allAddedSites.includes(siteToRemove)) {
                              allAddedSites.push(siteToRemove);
                            }
                          } else {
                            console.warn(`[${operationId}]   ⚠️ Delete query succeeded but no rows affected for: ${siteToRemove}`);
                          }
                        } catch (dbError) {
                          console.error(`[${operationId}]   ❌ Failed to remove pending site ${siteToRemove} from database:`, dbError);
                        }
                      } else {
                        console.log(`[${operationId}]   ⚠️ Skipping invalid site name: ${siteToRemove}`);
                      }
                    }
                    console.log(`[${operationId}] ✅ Deleted ${deletedByFallback}/${matchingPendingSites.length} pending site(s) by fallback price match`);
                  } else {
                    console.log(`[${operationId}] ℹ️ No pending sites found matching subscription price for fallback removal`);
                }
              } else {
                console.log(`[${operationId}] ⚠️ Database not available - cannot remove pending sites`);
              }
              }
              
              // STEP 3: Now filter user.pendingSites to remove added sites
              console.log(`[${operationId}] 🔍 STEP 3: Filtering user.pendingSites array...`);
              const beforeCount = user.pendingSites.length;
              console.log(`[${operationId}]   - Before filtering: ${beforeCount} pending site(s)`);
              console.log(`[${operationId}]   - Sites to remove from array: ${allAddedSites.length} site(s):`, allAddedSites);
              
              // Remove pending sites that match any added site (case-insensitive, trimmed)
              // Also remove if the site is now in user.sites (was successfully added)
              user.pendingSites = user.pendingSites.filter(pending => {
                const pendingSiteLower = (pending.site || pending.site_domain || pending).toLowerCase().trim();
                const isAdded = allAddedSites.includes(pendingSiteLower);
                if (isAdded) {
                  console.log(`[${operationId}]   🗑️ Removing pending site from user object: ${pendingSiteLower}`);
                }
                return !isAdded;
              });
              
              const afterCount = user.pendingSites.length;
              const removedCount = beforeCount - afterCount;
              console.log(`[${operationId}] ✅ Pending sites array: ${beforeCount} → ${afterCount} (removed ${removedCount})`);
              
              if (afterCount > 0) {
                // If we added sites but pending sites remain, they might be from a different source
                // Remove any pending sites that are now in user.sites (double-check)
                const stillPending = user.pendingSites.filter(pending => {
                  const pendingSiteLower = (pending.site || pending.site_domain || pending).toLowerCase().trim();
                  const isNowActive = sitesInUserRecord.includes(pendingSiteLower);
                  if (isNowActive) {
                    console.log(`[${operationId}] 🗑️ Removing pending site (double-check): ${pendingSiteLower}`);
                  }
                  return !isNowActive;
                });
                user.pendingSites = stillPending;
              }
              
              // CRITICAL: Save user object immediately after removing pending sites
              // This ensures pending sites are removed from the database even if payment save fails
              console.log(`[${operationId}] 🔍 STEP 4: Saving user object with updated pending sites...`);
              if (beforeCount !== afterCount || allAddedSites.length > 0) {
                try {
                  console.log(`[${operationId}]   - Remaining pending sites: ${afterCount}`);
                  console.log(`[${operationId}]   - Sites removed: ${removedCount}`);
                  console.log(`[${operationId}]   - Attempting to save user object...`);
                  await saveUserByEmail(env, email, user);
                  console.log(`[${operationId}] ✅ User object saved successfully with updated pending sites`);
                } catch (saveError) {
                  console.error(`[${operationId}] ❌ Failed to save user object after removing pending sites:`, saveError);
                  console.error(`[${operationId}] ❌ Error details:`, saveError.message);
                  console.error(`[${operationId}] ❌ Error stack:`, saveError.stack);
                  // Don't throw - continue with payment save
                }
              } else {
                console.log(`[${operationId}] ℹ️ No changes to pending sites - skipping save`);
              }
            }
            
            // User record will be saved again AFTER payment is saved (see below) to ensure all data is synced
          }

          // Save payment details to database
          // CRITICAL: Payment is already successful - we MUST complete all operations
          // If any operation fails, queue it for retry but always return 'ok' to Stripe
          // Note: failedOperations is already initialized at function scope above
          
          console.log(`[${operationId}] 💰 STEP 5: Starting payment processing and database updates...`);
          console.log(`[${operationId}]   - Customer ID: ${customerId}`);
          console.log(`[${operationId}]   - Subscription ID: ${subscriptionId}`);
          console.log(`[${operationId}]   - Email: ${email}`);
          console.log(`[${operationId}]   - Purchase Type: ${purchaseType}`);
          
          try {
            // Get all sites from subscription metadata (site_0, site_1, etc.)
            // Create payment records for ALL sites, not just the first one
            console.log(`[${operationId}] 🔍 STEP 5.1: Extracting site names for payment records...`);
            const allSites = [];
            
            // Extract all sites from metadata
            Object.keys(subscriptionMetadata).forEach(key => {
              if (key.startsWith('site_')) {
                const site = subscriptionMetadata[key];
                if (site && site !== 'unknown' && !site.startsWith('site_')) {
                  allSites.push(site);
                  console.log(`[${operationId}]   - Found site in subscription metadata (${key}): ${site}`);
                }
              }
            });
            
            // If no sites in metadata, try to get from subscription items
            if (allSites.length === 0 && sub.items && sub.items.data && sub.items.data.length > 0) {
              console.log(`[${operationId}]   - No sites in metadata, checking subscription items...`);
              sub.items.data.forEach((item, idx) => {
                const site = item.metadata?.site;
                if (site && site !== 'unknown' && !site.startsWith('site_')) {
                  allSites.push(site);
                  console.log(`[${operationId}]   - Found site in item ${idx} metadata: ${site}`);
                }
              });
            }
            
            // If still no sites, use custom field (for initial subscriptions)
            if (allSites.length === 0 && customFieldSiteUrl) {
              allSites.push(customFieldSiteUrl);
              console.log(`[${operationId}]   - Using custom field site URL: ${customFieldSiteUrl}`);
            }
            
            // Legacy: Check custom fields (for backward compatibility with old payment links)
            if (allSites.length === 0 && session.custom_fields && session.custom_fields.length > 0) {
              console.log(`[${operationId}]   - Checking custom fields...`);
              const siteUrlField = session.custom_fields.find(field => 
                field.key === 'enteryourlivesiteurl' || 
                field.key === 'enteryourlivesiteur' ||
                field.key === 'enteryourlivedomain' ||
                field.key === 'enteryourlivedomaine' ||
                field.key?.toLowerCase().includes('domain') || 
                field.key?.toLowerCase().includes('site') ||
                (field.type === 'text' && field.text && field.text.value)
              );
              if (siteUrlField && siteUrlField.text && siteUrlField.text.value) {
                allSites.push(siteUrlField.text.value.trim());
                console.log(`[${operationId}]   - Found site in custom field: ${siteUrlField.text.value.trim()}`);
              }
            }
            
            console.log(`[${operationId}] ✅ Extracted ${allSites.length} site(s) for payment records:`, allSites);

            // Get amount from session or subscription
            // CRITICAL: Declare these at function scope so they're accessible in error handlers
            let totalAmount = session.amount_total || 0;
            let currency = session.currency || 'usd';
            console.log(`[${operationId}] 💰 Payment details: amount=${totalAmount}, currency=${currency}`);

            // Calculate amount per site (divide total by number of sites, or get from price if available)
            const amountPerSite = allSites.length > 0 ? Math.floor(totalAmount / allSites.length) : totalAmount;
            console.log(`[${operationId}] 💰 Amount per site: ${amountPerSite} (${allSites.length} sites)`);

            // Magic link generation is DISABLED - Memberstack handles authentication via passwordless login
            // No custom magic links needed
            let magicLink = null;

            // Save payment details to D1 database (with retry)
            // Create payment records for ALL sites, not just the first one
            // For quantity purchases (license_addon), save payment record even without sites
            if (env.DB && (allSites.length > 0 || purchaseType === 'quantity')) {
              console.log(`[${operationId}] 🔍 STEP 5.2: Saving payment records to database...`);
              let paymentSaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                  console.log(`[${operationId}]   - Payment save attempt ${attempt + 1}/3...`);
                  const timestamp = Math.floor(Date.now() / 1000);
                  
                  // For quantity purchases, save one payment record without site
                  if (purchaseType === 'quantity' && allSites.length === 0) {
                    console.log(`[${operationId}]   - Creating payment record for quantity purchase (no site)...`);
                    const paymentResult = await env.DB.prepare(
                      `INSERT INTO payments (
                        customer_id, subscription_id, email, amount, currency, 
                        status, site_domain, magic_link, magic_link_generated, 
                        created_at, updated_at
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                  customerId, 
                      subscriptionId,
                  email, 
                      totalAmount,
                      currency,
                      'succeeded',
                      null, // No site for quantity purchases
                      null, // magic_link - not used
                      0, // magic_link_generated - false
                      timestamp,
                      timestamp
                    ).run();
                    console.log(`[${operationId}]   ✅ Payment record created for quantity purchase:`, paymentResult.success ? 'SUCCESS' : 'FAILED');
                } else {
                    // Create payment record for each site
                    console.log(`[${operationId}]   - Creating payment records for ${allSites.length} site(s)...`);
                    let paymentCount = 0;
                    for (const siteDomain of allSites) {
                      console.log(`[${operationId}]     - Processing payment for site: ${siteDomain}`);
                      // Try to get the actual price for this site from subscription items
                      let siteAmount = amountPerSite;
                      if (sub.items && sub.items.data) {
                        const item = sub.items.data.find(i => 
                          (i.metadata?.site || '').toLowerCase().trim() === siteDomain.toLowerCase().trim()
                        );
                        if (item && item.price) {
                          console.log(`[${operationId}]       - Found item with price ID: ${item.price.id}`);
                          // Get price details to get the actual amount
                          try {
                            const priceRes = await stripeFetch(env, `/prices/${item.price.id}`);
                            if (priceRes.status === 200) {
                              siteAmount = priceRes.body.unit_amount || amountPerSite;
                              console.log(`[${operationId}]       - Price amount from Stripe: ${siteAmount}`);
                            }
                          } catch (priceError) {
                            console.warn(`[${operationId}]       ⚠️ Failed to fetch price details, using calculated amount: ${priceError.message}`);
                          }
                        }
                      }
                      
                      console.log(`[${operationId}]       - Inserting payment record: site=${siteDomain}, amount=${siteAmount}, currency=${currency}`);
                      const paymentResult = await env.DB.prepare(
                        `INSERT INTO payments (
                          customer_id, subscription_id, email, amount, currency, 
                          status, site_domain, magic_link, magic_link_generated, 
                          created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                      ).bind(
                        customerId,
                        subscriptionId,
                        email,
                          siteAmount,
                        currency,
                        'succeeded',
                        siteDomain,
                          null, // magic_link - not used
                          0, // magic_link_generated - false
                        timestamp,
                        timestamp
                      ).run();
                      
                      if (paymentResult.success) {
                        paymentCount++;
                        console.log(`[${operationId}]       ✅ Payment record created successfully for ${siteDomain}`);
                      } else {
                        console.error(`[${operationId}]       ❌ Payment record creation failed for ${siteDomain}`);
                      }
                    }
                    console.log(`[${operationId}]   ✅ Created ${paymentCount}/${allSites.length} payment record(s)`);
                  }

                  paymentSaved = true;
                  console.log(`[${operationId}] ✅ Payment records saved successfully on attempt ${attempt + 1}`);
                  break;
                } catch (dbError) {
                  console.error(`[${operationId}] ❌ Payment save attempt ${attempt + 1}/3 failed:`, dbError.message);
                  console.error(`[${operationId}] ❌ Error details:`, dbError);
                  if (attempt === 2) {
                    console.error(`[${operationId}] ❌ CRITICAL: Failed to save payment records after 3 attempts`);
                    console.error(`[${operationId}] ❌ Failed to save payment to D1 after 3 attempts:`, dbError);
                    failedOperations.push({ 
                      type: 'save_payment', 
                      error: dbError.message,
                      data: { customerId, subscriptionId, email, amount: totalAmount, currency, siteDomain: allSites[0] || customFieldSiteUrl, magicLink: null }
                    });
                  } else {
                    const delay = 1000 * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                  }
                }
              }
              
              // If payment save failed, log for manual review (no KV needed - all in DB)
              if (!paymentSaved) {
                console.error(`[${operationId}] Payment save failed - will retry on next webhook or manual intervention needed`, {
                  operation: 'save_payment',
                  customerId,
                  subscriptionId,
                  email,
                  amount: totalAmount,
                  currency,
                  siteDomain: allSites[0] || customFieldSiteUrl,
                  magicLink: null,
                  timestamp: Date.now(),
                  retryCount: 0
                });
              } else {
                // Save to KV storage (for direct link purchase - Use Case 1)
                // Only save for site purchases, not quantity purchases
                if (purchaseType !== 'quantity' && allSites.length > 0) {
                  // Get site name - prioritize custom field, then first site from metadata
                  const siteName = customFieldSiteUrl || allSites[0] || (sub.items?.data?.[0]?.metadata?.site);
                  if (siteName) {
                    console.log(`[${operationId}] 💾 Saving to KV storage for site: ${siteName}`);
                    await saveSubscriptionToKV(
                      env,
                      customerId,
                      subscriptionId,
                      email,
                      siteName,
                      sub.status === 'active' ? 'complete' : sub.status,
                      'paid',
                      sub.cancel_at_period_end || false
                    );
                  }
                }
              }
            } else {
              console.error(`[${operationId}] ❌ CRITICAL: env.DB is NOT configured! Payment will NOT be saved to database.`);
              console.error(`[${operationId}] ❌ Please configure D1 database binding in wrangler.toml`);
              failedOperations.push({ 
                type: 'save_payment', 
                error: 'Database not configured (env.DB is missing)',
                critical: true
              });
            }

            // CRITICAL: Create/update user record AFTER payment is saved, BEFORE generating license keys
            // This ensures user data is available when mapping sites to subscription items for license generation
            // NOTE: The user record was already saved earlier in the webhook handler (around line 1919)
            // This is a second save to ensure everything is up to date after payment is saved
            
            // CRITICAL: Ensure user object has the email-based structure with items
            // Get the latest user from database to merge with current data
            // This preserves ALL existing subscriptions from the database
            let userToSave = await getUserByEmail(env, email);
            if (!userToSave) {
              userToSave = user; // Fallback to legacy structure
            } else {
              // Merge items from current processing into the user structure
              // Ensure items are in the email-based structure format
              if (!userToSave.customers) {
                userToSave.customers = [];
              }
              let customer = userToSave.customers.find(c => c.customerId === customerId);
              if (!customer) {
                customer = {
                  customerId: customerId,
                  subscriptions: [],
                  created_at: Math.floor(Date.now() / 1000)
                };
                userToSave.customers.push(customer);
              }
              
              let subscription = customer.subscriptions.find(s => s.subscriptionId === subscriptionId);
              if (!subscription) {
                subscription = {
                  subscriptionId: subscriptionId,
                  status: 'active',
                  items: [],
                  billingPeriod: billingPeriod || null, // Add billing period
                  created_at: Math.floor(Date.now() / 1000)
                };
                customer.subscriptions.push(subscription);
              } else {
                // Update billing period if not already set or if we have a new value
                if (billingPeriod && !subscription.billingPeriod) {
                  subscription.billingPeriod = billingPeriod;
                }
              }
              // Add items from itemsForEmailStructure if they don't exist
              // CRITICAL: itemsForEmailStructure is defined in the outer scope (around line 1763)
              // If subscription.items is empty, we need to populate it
              if (subscription.items.length === 0) {
                // Try to get items from itemsForEmailStructure first (most reliable)
                if (itemsForEmailStructure && itemsForEmailStructure.length > 0) {
                  itemsForEmailStructure.forEach(newItem => {
                    subscription.items.push(newItem);
                  });
                } else if (sub && sub.items && sub.items.data) {
                  // Fallback: Rebuild items from Stripe subscription data
                  for (let index = 0; index < sub.items.data.length; index++) {
                    const item = sub.items.data[index];
                    // Get site name from multiple sources
                    let site = item.metadata?.site;
                    if (!site && sitesFromMetadata && sitesFromMetadata[index]) {
                      site = sitesFromMetadata[index];
                    }
                    if (!site && index === 0 && customFieldSiteUrl) {
                      site = customFieldSiteUrl;
                    }
                    if (!site) {
                      site = `site_${index + 1}`;
                    }
                    
                    subscription.items.push({
                      item_id: item.id,
                      site: site,
                      price: item.price.id,
                      quantity: item.quantity,
                      status: 'active',
                      created_at: Math.floor(Date.now() / 1000)
                    });
                  }
                } else {
                  console.warn(`[${operationId}] ⚠️ Cannot rebuild items: itemsForEmailStructure is empty and sub.items is not available`);
                }
              } else if (itemsForEmailStructure && itemsForEmailStructure.length > 0) {
                // Merge items from itemsForEmailStructure (items already exist, just update)
                itemsForEmailStructure.forEach(newItem => {
                  const existingItem = subscription.items.find(i => i.item_id === newItem.item_id);
                  if (!existingItem) {
                    subscription.items.push(newItem);
                  } else {
                    Object.assign(existingItem, newItem);
                  }
                });
              }
            }
            
            // CRITICAL: Remove pending sites from database AFTER payment is saved
            // This ensures pending sites are removed even if they weren't matched by name earlier
            let subscriptionPriceIds = [];
            if (env.DB && sub.items && sub.items.data && sub.items.data.length > 0) {
              try {
                // Get price_id from subscription items
                subscriptionPriceIds = sub.items.data.map(item => item.price.id);
                console.log(`[${operationId}] 🗑️ Removing pending sites by price_id match:`, subscriptionPriceIds);
                
                // Remove ALL pending sites that match any of the subscription's price_ids
                // This is more reliable than matching by site name
                for (const priceId of subscriptionPriceIds) {
                  try {
                    const deleteResult = await env.DB.prepare(
                      'DELETE FROM pending_sites WHERE user_email = ? AND price_id = ?'
                    ).bind(email.toLowerCase().trim(), priceId).run();
                    
                    if (deleteResult.success) {
                      console.log(`[${operationId}] ✅ Removed pending sites with price_id ${priceId} from database`);
                    }
                  } catch (deleteError) {
                    console.error(`[${operationId}] ❌ Error removing pending sites by price_id ${priceId}:`, deleteError);
                  }
                }
                
                // Also remove by site name match (for sites that were successfully added)
                if (allSites && allSites.length > 0) {
                  for (const site of allSites) {
                    try {
                      const deleteResult = await env.DB.prepare(
                        'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                      ).bind(email.toLowerCase().trim(), site.toLowerCase().trim()).run();
                      
                      if (deleteResult.success) {
                        console.log(`[${operationId}] ✅ Removed pending site ${site} from database`);
                      }
                    } catch (deleteError) {
                      console.error(`[${operationId}] ❌ Error removing pending site ${site}:`, deleteError);
                    }
                  }
                }
              } catch (pendingSitesError) {
                console.error(`[${operationId}] ❌ Error removing pending sites:`, pendingSitesError);
              }
            }
            
            let userSitesSaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                // CRITICAL: Load complete user from database before saving to preserve ALL subscriptions
                // This ensures we don't lose any existing subscriptions when saving
                let completeUser = await getUserByEmail(env, email);
                if (completeUser) {
                  // Merge userToSave data into completeUser to preserve all subscriptions
                  if (!completeUser.customers) {
                    completeUser.customers = [];
                  }
                  
                  // Merge customers and subscriptions from userToSave into completeUser
                  if (userToSave.customers && userToSave.customers.length > 0) {
                    for (const currentCustomer of userToSave.customers) {
                      let completeCustomer = completeUser.customers.find(c => c.customerId === currentCustomer.customerId);
                      if (!completeCustomer) {
                        // Add new customer
                        completeUser.customers.push(currentCustomer);
                      } else {
                        // Merge subscriptions - add new ones, update existing ones
                        if (currentCustomer.subscriptions && currentCustomer.subscriptions.length > 0) {
                          for (const currentSub of currentCustomer.subscriptions) {
                            let existingSub = completeCustomer.subscriptions.find(s => s.subscriptionId === currentSub.subscriptionId);
                            if (!existingSub) {
                              // Add new subscription
                              completeCustomer.subscriptions.push(currentSub);
                              } else {
                                // Update existing subscription (merge items)
                                if (currentSub.items && currentSub.items.length > 0) {
                                  for (const item of currentSub.items) {
                                    let existingItem = existingSub.items.find(i => i.item_id === item.item_id);
                                    if (!existingItem) {
                                      existingSub.items.push(item);
                                    } else {
                                      // Update existing item
                                      Object.assign(existingItem, item);
                                    }
                                  }
                                }
                                // Update status and other fields, preserving billingPeriod if currentSub has it
                                Object.assign(existingSub, currentSub);
                                // CRITICAL: Ensure billingPeriod is preserved/updated
                                if (currentSub.billingPeriod) {
                                  existingSub.billingPeriod = currentSub.billingPeriod;
                                }
                              }
                          }
                        }
                      }
                    }
                  }
                  
                  // CRITICAL: Remove pending sites from user object after they've been removed from database
                  if (completeUser.pendingSites && completeUser.pendingSites.length > 0) {
                    const beforeCount = completeUser.pendingSites.length;
                    // Remove pending sites that match the subscription's price_ids
                    completeUser.pendingSites = completeUser.pendingSites.filter(pending => {
                      const pendingPrice = pending.price || pending.price_id;
                      return !subscriptionPriceIds.includes(pendingPrice);
                    });
                    const afterCount = completeUser.pendingSites.length;
                    if (beforeCount !== afterCount) {
                      console.log(`[${operationId}] 🗑️ Removed ${beforeCount - afterCount} pending site(s) from user object`);
                    }
                  }
                  
                  // Save the complete merged user structure
                  await saveUserByEmail(env, email, completeUser);
                  console.log(`[${operationId}] ✅ Saved user record with subscription details`);
                  
                  // CRITICAL: Verify subscription details were saved by checking database
                  if (env.DB) {
                    try {
                      const verifySub = await env.DB.prepare(
                        'SELECT subscription_id FROM subscriptions WHERE subscription_id = ? AND user_email = ?'
                      ).bind(subscriptionId, email.toLowerCase().trim()).first();
                      
                      if (!verifySub) {
                        console.warn(`[${operationId}] ⚠️ Subscription ${subscriptionId} not found in database after save - retrying...`);
                        // Retry saving subscription details directly to database
                        const timestamp = Math.floor(Date.now() / 1000);
                        await env.DB.prepare(
                          'INSERT OR REPLACE INTO subscriptions (subscription_id, customer_id, user_email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
                        ).bind(subscriptionId, customerId, email.toLowerCase().trim(), 'active', timestamp, timestamp).run();
                        
                        // Also save subscription items
                        if (sub.items && sub.items.data && sub.items.data.length > 0) {
                          for (const item of sub.items.data) {
                            const site = item.metadata?.site || allSites[0] || null;
                            await env.DB.prepare(
                              'INSERT OR REPLACE INTO subscription_items (subscription_id, item_id, site_domain, price_id, quantity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                            ).bind(subscriptionId, item.id, site, item.price.id, item.quantity || 1, 'active', timestamp).run();
                          }
                        }
                        console.log(`[${operationId}] ✅ Retried and saved subscription details directly to database`);
                      } else {
                        console.log(`[${operationId}] ✅ Verified subscription details saved to database`);
                      }
                    } catch (verifyError) {
                      console.error(`[${operationId}] ❌ Error verifying subscription details:`, verifyError);
                    }
                  }
                } else {
                  // Fallback: if we can't load from database, save userToSave
                  await saveUserByEmail(env, email, userToSave);
                  console.log(`[${operationId}] ✅ Saved user record (fallback)`);
                }
                userSitesSaved = true;
                break;
              } catch (dbError) {
                if (attempt === 2) {
                  console.error(`[${operationId}] CRITICAL: Failed to save user record after 3 attempts:`, dbError);
                  failedOperations.push({ 
                    type: 'save_user_record', 
                    error: dbError.message,
                    data: { customerId, subscriptionId, email }
                  });
                } else {
                  const delay = 1000 * Math.pow(2, attempt);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
            }

            // Generate license keys AFTER user record is created/updated
            // Check if this is a quantity purchase or site-based purchase
            // CRITICAL: purchaseType is already declared at handler scope (line 1264), so we're updating it here
            // Don't redeclare - just update the existing variable
            purchaseType = subscriptionMetadata.purchase_type || purchaseType || 'site';
            let quantity = parseInt(subscriptionMetadata.quantity) || 1;
            
            // Also check session metadata (for checkout sessions created via /purchase-quantity)
            if (session && session.metadata) {
              if (session.metadata.purchase_type) {
                purchaseType = session.metadata.purchase_type;
              }
              if (session.metadata.quantity) {
                quantity = parseInt(session.metadata.quantity) || quantity;
              }
            }
            
            // Also check subscription_data.metadata (for checkout sessions)
            if (session && session.subscription_data && session.subscription_data.metadata) {
              if (session.subscription_data.metadata.purchase_type) {
                purchaseType = session.subscription_data.metadata.purchase_type;
              }
              if (session.subscription_data.metadata.quantity) {
                quantity = parseInt(session.subscription_data.metadata.quantity) || quantity;
              }
            }
            
            // Treat 'license_addon' the same as 'quantity' purchases
            if (purchaseType === 'license_addon') {
              purchaseType = 'quantity';
            }
            
            if (sub.items && sub.items.data && sub.items.data.length > 0) {
              // Check for existing licenses to avoid duplicates
              let existingLicenses = [];
              if (env.DB) {
                try {
                  const existing = await env.DB.prepare(
                    'SELECT license_key, site_domain FROM licenses WHERE subscription_id = ?'
                  ).bind(subscriptionId).all();
                  if (existing.success) {
                    existingLicenses = existing.results.map(r => ({ key: r.license_key, site: r.site_domain }));
                  }
                } catch (e) {
                  console.error('Error checking existing licenses:', e);
                }
              }
              
              let licensesToCreate = [];
              let totalLicensesNeeded = 0;
              
              if (purchaseType === 'quantity') {
                // Quantity purchase (or license_addon): Use pre-generated license keys from metadata
                // Each subscription item corresponds to one license key
                // License keys are stored in subscription metadata as JSON array
                let preGeneratedLicenseKeys = [];
                
                // Try to get license keys from subscription metadata (PRIMARY SOURCE for /purchase-quantity endpoint)
                if (subscriptionMetadata.license_keys) {
                  try {
                    preGeneratedLicenseKeys = JSON.parse(subscriptionMetadata.license_keys);
                  } catch (e) {
                    console.error(`[${operationId}] Failed to parse license_keys from metadata:`, e);
                  }
                }
                
                // Also check subscription_data.metadata (for /purchase-quantity endpoint)
                if (session && session.subscription_data && session.subscription_data.metadata && session.subscription_data.metadata.license_keys) {
                  try {
                    preGeneratedLicenseKeys = JSON.parse(session.subscription_data.metadata.license_keys);
                  } catch (e) {
                    console.error(`[${operationId}] Failed to parse license_keys from subscription_data metadata:`, e);
                  }
                }
                
                // Also check session metadata (for payment mode)
                if (session && session.metadata && session.metadata.license_keys) {
                  try {
                    preGeneratedLicenseKeys = JSON.parse(session.metadata.license_keys);
                  } catch (e) {
                    console.error(`[${operationId}] Failed to parse license_keys from session metadata:`, e);
                  }
                }
                
                // Also check payment_intent metadata (for payment mode with proration)
                if (session && session.payment_intent && typeof session.payment_intent === 'object' && session.payment_intent.metadata && session.payment_intent.metadata.license_keys) {
                  try {
                    preGeneratedLicenseKeys = JSON.parse(session.payment_intent.metadata.license_keys);
                  } catch (e) {
                    console.error(`[${operationId}] Failed to parse license_keys from payment_intent metadata:`, e);
                  }
                }
                
                // If no pre-generated keys found, try to get from item metadata (each item has license_key in metadata)
                if (preGeneratedLicenseKeys.length === 0 && sub.items && sub.items.data) {
                  preGeneratedLicenseKeys = sub.items.data.map(item => item.metadata?.license_key).filter(key => key);
                }
                
                // USE CASE 3: Create license keys from metadata after payment succeeds
                const useCase3 = subscriptionMetadata.usecase === '3' || subscriptionMetadata.usecase === 3;
                let useCase3Processed = false;
                
                if (useCase3 && env.DB) {
                  // USE CASE 3: Create license keys from Stripe metadata (stored temporarily before payment)
                  
                  try {
                    // Get license keys from subscription item metadata (PRIMARY SOURCE - set during checkout)
                    let licenseKeysFromMetadata = [];
                    
                    // First, try to get from subscription items' metadata (most reliable)
                    for (const item of sub.items.data) {
                      if (item.metadata?.license_key) {
                        licenseKeysFromMetadata.push(item.metadata.license_key);
                      }
                    }
                    
                    // Fallback: Get from subscription metadata
                    if (licenseKeysFromMetadata.length === 0 && subscriptionMetadata.license_keys) {
                      try {
                        licenseKeysFromMetadata = JSON.parse(subscriptionMetadata.license_keys);
                      } catch (e) {
                        console.error('[USE CASE 3] Failed to parse license_keys from subscription metadata:', e);
                      }
                    }
                    
                    // Fallback: Use pre-generated keys from other sources
                    if (licenseKeysFromMetadata.length === 0 && preGeneratedLicenseKeys.length > 0) {
                      licenseKeysFromMetadata = preGeneratedLicenseKeys;
                    }
                    
                    if (licenseKeysFromMetadata.length > 0) {
                      
                      const timestamp = Math.floor(Date.now() / 1000);
                      
                      // Map license keys to subscription items and create them
                      for (let index = 0; index < sub.items.data.length && index < licenseKeysFromMetadata.length; index++) {
                        const item = sub.items.data[index];
                        const licenseKey = licenseKeysFromMetadata[index];
                        
                        if (licenseKey) {
                          try {
                            // Check if license key already exists (shouldn't happen, but handle gracefully)
                            const existingLicense = await env.DB.prepare(
                              `SELECT license_key FROM licenses WHERE license_key = ?`
                            ).bind(licenseKey).first();
                            
                            if (existingLicense) {
                              console.warn(`[USE CASE 3] ⚠️ License key ${licenseKey} already exists, skipping`);
                              continue;
                            }
                            
                            // Extract billing_period and renewal_date from Stripe subscription
                            const billingPeriod = extractBillingPeriodFromStripe(sub);
                            const renewalDate = sub.current_period_end || null;
                            
                            // Insert new license key with subscription details
                            await env.DB.prepare(
                              `INSERT INTO licenses 
                               (license_key, customer_id, subscription_id, item_id, 
                                site_domain, used_site_domain, status, purchase_type, billing_period, renewal_date, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                              licenseKey,
                              customerId,
                              subscriptionId,
                              item.id,
                              null,  // No site assigned initially
                              null,  // Will be set when activated
                              'active',  // Status: active after payment
                              'quantity',
                              billingPeriod,
                              renewalDate,
                              timestamp,
                              timestamp
                            ).run();
                            
                          } catch (insertErr) {
                            // If license key already exists (race condition), skip
                            if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                              console.warn(`[USE CASE 3] ⚠️ License key ${licenseKey} already exists, skipping`);
                            } else {
                              console.error(`[USE CASE 3] ❌ Error creating license ${licenseKey}:`, insertErr);
                            }
                          }
                        } else {
                          console.warn(`[USE CASE 3] ⚠️ No license key found for item ${item.id} at index ${index}`);
                        }
                      }
                      
                      // Don't create new licenses - they were already created from metadata
                      useCase3Processed = true;
                      licensesToCreate = [];
                    } else {
                      // Fall through to create licenses normally
                    }
                  } catch (usecase3Err) {
                    console.error('[USE CASE 3] ❌ Error processing license keys from metadata:', usecase3Err);
                    // Fall through to create licenses normally
                  }
                }
                
                // If Use Case 3 didn't handle it (no pending licenses found), create licenses normally
                // licensesToCreate will be empty if Use Case 3 successfully updated pending licenses
                if (licensesToCreate.length === 0 && !useCase3Processed) {
                  // If still no keys found, generate them (fallback for old flow)
                  if (preGeneratedLicenseKeys.length === 0) {
                    const itemQuantity = sub.items.data[0]?.quantity || quantity || sub.items.data.length || 1;
                    preGeneratedLicenseKeys = await generateLicenseKeys(itemQuantity, env);
                  }
                  
                  // Map each license key to its subscription item
                  // Each subscription item should have a license key in its metadata (from /purchase-quantity endpoint)
                  // Use for...of loop to support async operations
                  for (let index = 0; index < sub.items.data.length; index++) {
                    const item = sub.items.data[index];
                    // Get license key from item metadata (PRIMARY - set by /purchase-quantity endpoint)
                    let licenseKey = item.metadata?.license_key;
                    // Fallback to pre-generated array
                    if (!licenseKey && preGeneratedLicenseKeys[index]) {
                      licenseKey = preGeneratedLicenseKeys[index];
                    } else if (!licenseKey) {
                      // Last resort: generate new unique key if not found
                      licenseKey = await generateUniqueLicenseKey(env);
                    }
                    
                    // Check if license already exists
                    const existingForLicense = existingLicenses.find(l => l.key === licenseKey);
                    if (!existingForLicense) {
                      licensesToCreate.push({ 
                        site: null, // Quantity purchases don't have sites
                        item_id: item.id, // Map to subscription item
                        license_key: licenseKey // Pre-generated key
                      });
                    }
                  }
                }
                
                // CRITICAL: Ensure purchase_type metadata is set on all items
                for (const item of sub.items.data) {
                  if (!item.metadata?.purchase_type || item.metadata.purchase_type !== 'quantity') {
                    try {
                      await stripeFetch(env, `/subscription_items/${item.id}`, 'POST', {
                        'metadata[purchase_type]': 'quantity'
                      }, true);
                    } catch (updateError) {
                      console.error(`[${operationId}] Failed to set purchase_type metadata on item ${item.id}:`, updateError);
                    }
                  }
                }
              } else {
                // Site-based purchase: Generate one license per subscription item/site
                const siteCount = sub.items.data.length;
                
                // Map sites to subscription items - get site from metadata or user record
                // Get user from database by email
                const userData = await getUserByEmail(env, email) || { sites: {} };
              
              // Generate one license per subscription item, mapped to its site
              sub.items.data.forEach((item, index) => {
                  // Get site from item metadata, user record, subscription metadata, or custom field
                let site = item.metadata?.site;
                if (!site) {
                  // Try to find site in user record by item_id
                  const siteEntry = Object.entries(userData.sites || {}).find(([_, data]) => data.item_id === item.id);
                  if (siteEntry) {
                    site = siteEntry[0];
                  } else {
                      // Try subscription metadata
                      site = sitesFromMetadata[index];
                      // If still no site and this is the first item, use custom field (for payment links)
                      if (!site && index === 0 && customFieldSiteUrl) {
                        site = customFieldSiteUrl;
                      }
                      // Final fallback to placeholder
                      if (!site) {
                        site = `site_${index + 1}`;
                      }
                    }
                  }
                  
                  // CRITICAL: If site is still a placeholder and we have customFieldSiteUrl, use it
                  // This handles the case where metadata wasn't set yet
                  if (site.startsWith('site_') && customFieldSiteUrl && index === 0) {
                    site = customFieldSiteUrl;
                }
                
                // Check if license already exists for this site
                const existingForSite = existingLicenses.find(l => l.site === site);
                if (!existingForSite) {
                  licensesToCreate.push({ site, item_id: item.id });
                  } else {
                }
              });
              }
              
              if (licensesToCreate.length > 0) {
                // Use pre-generated license keys if available, otherwise generate new ones
                // Generate unique license keys for licenses that don't have one yet
                const licenseKeys = [];
                for (const l of licensesToCreate) {
                  if (l.license_key) {
                    licenseKeys.push(l.license_key);
                  } else {
                    const uniqueKey = await generateUniqueLicenseKey(env);
                    licenseKeys.push(uniqueKey);
                  }
                }
                
                // ========================================
                // USE CASE 1 DEBUG: Save Licenses to Database
                // ========================================


                licensesToCreate.forEach((license, idx) => {

                });
                
                // Save to D1 database (with retry)
                if (env.DB) {
                  let licensesSaved = false;
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                      const timestamp = Math.floor(Date.now() / 1000);
                      const inserts = licenseKeys.map((key, idx) => {
                        const site = licensesToCreate[idx].site;
                        const itemId = licensesToCreate[idx].item_id || null; // Map to subscription item
                        // For site-based purchases, automatically assign used_site_domain = site_domain
                        // For quantity-based purchases, used_site_domain remains NULL until activated
                        const usedSiteDomain = (purchaseType === 'site' && site) ? site : null;
                        // Extract billing_period and renewal_date from Stripe subscription (if available)
                        const billingPeriod = sub ? extractBillingPeriodFromStripe(sub) : null;
                        const renewalDate = sub ? (sub.current_period_end || null) : null;
                        
                        // Use license_key as primary key, include purchase_type and used_site_domain
                        // Try with billing_period and renewal_date first (if columns exist)
                        try {
                          return env.DB.prepare(
                            'INSERT INTO licenses (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, billing_period, renewal_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                          ).bind(key, customerId, subscriptionId, itemId, site, usedSiteDomain, 'active', purchaseType, billingPeriod, renewalDate, timestamp, timestamp);
                        } catch (colErr) {
                          // If columns don't exist, fallback to insert without them
                          if (colErr.message && (colErr.message.includes('no such column: billing_period') || 
                                                 colErr.message.includes('no such column: renewal_date'))) {
                            return env.DB.prepare(
                              'INSERT INTO licenses (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                            ).bind(key, customerId, subscriptionId, itemId, site, usedSiteDomain, 'active', purchaseType, timestamp, timestamp);
                          } else {
                            throw colErr;
                          }
                        }
                      });
                      const batch = env.DB.batch(inserts);
                      await batch;
                      licensesSaved = true;

                      break;
                    } catch (dbError) {
                      // Handle case where item_id column doesn't exist (database not migrated yet)
                      if (dbError.message && (dbError.message.includes('no such column: item_id') || dbError.message.includes('no such column: purchase_type'))) {
                        // Try without item_id and purchase_type (old schema)
                        try {
                          const timestamp = Math.floor(Date.now() / 1000);
                          const inserts = licenseKeys.map((key, idx) => {
                            const site = licensesToCreate[idx].site;
                            // For site-based purchases, automatically assign used_site_domain = site_domain
                            const usedSiteDomain = (purchaseType === 'site' && site) ? site : null;
                            return env.DB.prepare(
                              'INSERT INTO licenses (license_key, customer_id, subscription_id, site_domain, used_site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                            ).bind(key, customerId, subscriptionId, site, usedSiteDomain, 'active', timestamp, timestamp);
                          });
                          const batch = env.DB.batch(inserts);
                          await batch;
                          licensesSaved = true;
                          break;
                        } catch (fallbackError) {
                          // If license_key is not primary key, try with id as primary key
                          if (fallbackError.message && fallbackError.message.includes('UNIQUE constraint failed: licenses.license_key')) {
                            try {
                              const timestamp = Math.floor(Date.now() / 1000);
                              const inserts = licenseKeys.map((key, idx) => {
                                const site = licensesToCreate[idx].site;
                                // For site-based purchases, automatically assign used_site_domain = site_domain
                                const usedSiteDomain = (purchaseType === 'site' && site) ? site : null;
                                return env.DB.prepare(
                                  'INSERT INTO licenses (customer_id, subscription_id, license_key, site_domain, used_site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                                ).bind(customerId, subscriptionId, key, site, usedSiteDomain, 'active', timestamp, timestamp);
                              });
                              const batch = env.DB.batch(inserts);
                              await batch;
                              licensesSaved = true;
                              break;
                            } catch (finalError) {
                      if (attempt === 2) {
                                console.error(`[${operationId}] Database error saving licenses after 3 attempts:`, finalError);
                        failedOperations.push({ 
                          type: 'save_licenses', 
                                  error: finalError.message
                        });
                      } else {
                        const delay = 1000 * Math.pow(2, attempt);
                        await new Promise(resolve => setTimeout(resolve, delay));
                      }
                    }
                          } else if (attempt === 2) {
                            console.error(`[${operationId}] Database error saving licenses after 3 attempts:`, fallbackError);
                            failedOperations.push({ 
                              type: 'save_licenses', 
                              error: fallbackError.message
                            });
                          } else {
                            const delay = 1000 * Math.pow(2, attempt);
                            await new Promise(resolve => setTimeout(resolve, delay));
                          }
                        }
                      } else if (dbError.message && dbError.message.includes('UNIQUE constraint failed: licenses.license_key')) {
                        // Try with old schema (id as primary key)
                        try {
                          const timestamp = Math.floor(Date.now() / 1000);
                          const inserts = licenseKeys.map((key, idx) => {
                      const site = licensesToCreate[idx].site;
                            const itemId = licensesToCreate[idx].item_id;
                            // For site-based purchases, automatically assign used_site_domain = site_domain
                            const usedSiteDomain = (purchaseType === 'site' && site) ? site : null;
                            return env.DB.prepare(
                              'INSERT INTO licenses (customer_id, subscription_id, item_id, license_key, site_domain, used_site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                            ).bind(customerId, subscriptionId, itemId, key, site, usedSiteDomain, 'active', timestamp, timestamp);
                          });
                          const batch = env.DB.batch(inserts);
                          await batch;
                          licensesSaved = true;
                    break;
                        } catch (fallbackError) {
                    if (attempt === 2) {
                            console.error(`[${operationId}] Database error saving licenses after 3 attempts:`, fallbackError);
                      failedOperations.push({ 
                              type: 'save_licenses', 
                              error: fallbackError.message
                      });
                    } else {
                      const delay = 1000 * Math.pow(2, attempt);
                      await new Promise(resolve => setTimeout(resolve, delay));
                    }
                  }
                      } else if (attempt === 2) {
                        console.error(`[${operationId}] Database error saving licenses after 3 attempts:`, dbError);
                        failedOperations.push({ 
                          type: 'save_licenses', 
                          error: dbError.message
                        });
                      } else {
                        const delay = 1000 * Math.pow(2, attempt);
                        await new Promise(resolve => setTimeout(resolve, delay));
                      }
                    }
                  }
                }
              } else {
              }
            }

            // Also save magic link to KV for quick access (with retry)
            // Payment data is already saved to database (payments table)
            // No need for separate KV storage - all data is in D1

            
            // Handle user login via Memberstack (if configured) or fallback to email
            
            // CRITICAL: Use Memberstack for login sessions - Memberstack sends magic link and handles authentication
            // ========================================
            // USE CASE 1 DEBUG: Memberstack Member Creation
            // ========================================



            if (env.MEMBERSTACK_SECRET_KEY) {



              try {
                
                // 1️⃣ Create or get Memberstack member (plan is included during creation if configured)
                
                // First check if member already exists with EXACT email match
                let member = null;
                let memberWasCreated = false;
                
                try {

                  const existingMember = await this.getMemberstackMember(email, env);
                  if (existingMember) {
                    const existingEmail = existingMember.email || existingMember._email || 'N/A';
                    const existingId = existingMember.id || existingMember._id;

                    // Verify exact email match
                    if (existingEmail.toLowerCase().trim() === email.toLowerCase().trim() || existingEmail === 'N/A') {
                      member = existingMember;
                      memberWasCreated = false;

                } else {
                      // Email doesn't match - this shouldn't happen with exact matching, but log it



                      member = null; // Don't use this member, create a new one
                    }
                  } else {

                  }
                } catch (getError) {


                }
                
                // If member doesn't exist, create it
                if (!member) {

                  member = await this.createMemberstackMember(email, env);
                  memberWasCreated = true;
                  const newMemberId = member.id || member._id;
                  const newMemberEmail = member.email || member._email || email;

                }
                
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
                  } else {
                    console.error(`[${operationId}] ❌ Member verification failed: ${verifyRes.status}`);
                    const errorText = await verifyRes.text();
                    console.error(`[${operationId}] Error: ${errorText}`);
                  }
                } catch (verifyError) {
                  console.error(`[${operationId}] ❌ Error verifying member: ${verifyError.message}`);
                }
                
                // Note: Plan is already assigned during member creation if MEMBERSTACK_PLAN_ID is configured
                if (env.MEMBERSTACK_PLAN_ID) {
                  if (memberWasCreated) {
                  } else {
                  }
                } else {
                }
                
                // 2️⃣ Member ready - Redirect to login page for Memberstack passwordless
                
              } catch (memberstackError) {
                console.error(`\n[${operationId}] ========================================`);
                console.error(`[${operationId}] ❌ MEMBERSTACK SETUP FAILED`);
                console.error(`[${operationId}] ========================================`);
                console.error(`[${operationId}] Error type: ${memberstackError.name || 'Unknown'}`);
                console.error(`[${operationId}] Error message: ${memberstackError.message}`);
                console.error(`[${operationId}] Error stack:`, memberstackError.stack);
                console.error(`[${operationId}] ========================================\n`);
                
                // CRITICAL: If Memberstack is configured but fails, DO NOT use Resend fallback
                // Memberstack is the primary authentication method - if it fails, it's a configuration issue
                // The user needs to fix the Memberstack API key, not fall back to Resend
                failedOperations.push({ 
                  type: 'memberstack_setup', 
                  error: memberstackError.message,
                  critical: true,
                  requiresManualReview: true
                });
                
              
              }
            } else {
              // Fallback: Send email via Resend ONLY if Memberstack is not configured
              // NOTE: Resend is optional - if not configured, no email will be sent
              console.error(`[${operationId}] ❌ CRITICAL: Memberstack not configured (MEMBERSTACK_SECRET_KEY missing)`);
              console.error(`[${operationId}] ❌ Memberstack member will NOT be created`);
              console.error(`[${operationId}] ❌ Memberstack magic link will NOT be sent`);
              
              // Only attempt Resend if configured (optional)
              if (env.RESEND_API_KEY) {
            try {
              const emailHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">🎉 Payment Successful!</h1>
                  </div>
                  <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
                    <p style="font-size: 16px; margin-bottom: 20px;">Thank you for your purchase! Your payment has been processed successfully.</p>
                    <p style="font-size: 16px; margin-bottom: 20px;">Click the button below to access your dashboard:</p>
                    <div style="text-align: center; margin: 30px 0;">
                      <a href="${magicLink}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 600; font-size: 16px;">Access Dashboard</a>
                    </div>
                    <div style="background: #fff; padding: 20px; border-radius: 6px; margin: 20px 0;">
                      <p style="margin: 0; font-size: 14px; color: #666;"><strong>Subscription:</strong> ${subscriptionId}</p>
                      <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;"><strong>Amount:</strong> ${(totalAmount / 100).toFixed(2)} ${currency.toUpperCase()}</p>
                      ${customFieldSiteUrl && customFieldSiteUrl !== 'unknown' ? `<p style="margin: 5px 0 0 0; font-size: 14px; color: #666;"><strong>Site:</strong> ${customFieldSiteUrl}</p>` : ''}
                    </div>
                    <p style="font-size: 14px; color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">
                      Or copy and paste this link into your browser:<br>
                      <a href="${magicLink}" style="color: #667eea; word-break: break-all;">${magicLink}</a>
                    </p>
                    <p style="font-size: 12px; color: #999; margin-top: 20px;">
                      This link will expire in 7 days. If you didn't make this purchase, please contact support immediately.
                    </p>
                  </div>
                </body>
                </html>
              `;
              const emailResult = await sendEmail(email, 'Payment Successful - Access Your Dashboard', emailHtml, env);
            } catch (emailError) {
                  console.error(`[${operationId}] ❌ Resend email sending failed:`, emailError.message);
              failedOperations.push({ type: 'send_email', error: emailError.message });
                }
              } else {
                failedOperations.push({ 
                  type: 'send_email', 
                  error: 'Neither Memberstack nor Resend configured',
                  requiresConfiguration: true
                });
              }
            }
            
            // Also log to console in a way that's easy to copy
            
            // Log any failed operations for manual review
            if (failedOperations.length > 0) {

              failedOperations.forEach((op, idx) => {

              });


            }
            
            // ========================================
            // USE CASE 1 DEBUG: Webhook Summary
            // ========================================

















            // ========================================
            // USE CASE 1 DEBUG: Success Completion
            // ========================================










          } catch (error) {
            // CRITICAL: Payment is already successful - we MUST return 'ok' to Stripe
            // Log error but don't fail the webhook (would cause Stripe to retry)
            console.error(`[${operationId}] CRITICAL ERROR in payment processing:`, error);
            console.error(`[${operationId}] Payment is already successful - customer has paid`);
            console.error(`[${operationId}] Error details:`, error.stack);
            
            // Log critical error for manual review (no KV needed - all in DB)
            console.error(`[${operationId}] CRITICAL: Payment processing failed - manual intervention needed`, {
              operation: 'payment_processing',
              customerId,
              subscriptionId,
              email,
              error: error.message,
              stack: error.stack,
              timestamp: Date.now(),
              requiresManualReview: true
            });
            
            // ALWAYS return 'ok' - payment is already processed
            // Stripe will not retry if we return 200
          }
          
            // CRITICAL: Always return 'ok' to Stripe after payment is successful
            // This prevents Stripe from retrying the webhook
            // Failed operations are queued for background retry

            return new Response('ok', { status: 200 });
          }
          
          // If we reach here, use case was not identified (shouldn't happen)
          console.warn(`[checkout.session.completed] ⚠️ Unhandled use case - returning ok`);
          return new Response('ok', { status: 200 });
        }

        // Handle subscription.updated - sync site status
        if (event.type === 'customer.subscription.updated') {
          const subscription = event.data.object;
          const subscriptionId = subscription.id;
          const customerId = subscription.customer;
          
          // Log subscription update with detailed status information
          await logStripeEvent(env, event, subscriptionId, customerId, {
            action: 'subscription_updated',
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            canceled_at: subscription.canceled_at,
            current_period_end: subscription.current_period_end,
            current_period_start: subscription.current_period_start,
            billing_cycle_anchor: subscription.billing_cycle_anchor,
            note: 'Subscription status updated by Stripe'
          });

          // Get user email from customerId
          const userEmail = await getCustomerEmail(env, customerId);
          if (!userEmail) {
            console.warn('User email not found for subscription update');
            return new Response('ok');
          }
          
          // Get user record from database
          let user = await getUserByEmail(env, userEmail);
          if (!user) {
            console.warn('User record not found for subscription update');
            return new Response('ok');
          }

          // Check if this subscription belongs to this user
          const subscriptionExists = user.customers.some(c => 
            c.subscriptions.some(s => s.subscriptionId === subscriptionId)
          );
          if (!subscriptionExists) {
            return new Response('ok');
          }
          
          // Get current subscription items from Stripe
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status === 200) {
            const sub = subRes.body;
            
            // CRITICAL: Check if subscription is cancelled - skip license generation and site updates
            const now = Math.floor(Date.now() / 1000);
            const periodEnded = sub.current_period_end && sub.current_period_end < now;
            const isCancelled = sub.status === 'canceled' || 
                               (sub.cancel_at_period_end === true && periodEnded) ||
                               sub.canceled_at !== null;
            
            // Always update subscription status in database when cancel_at_period_end is true
            if (isCancelled || sub.cancel_at_period_end === true) {
              // Still update subscription status in database, but don't generate licenses or update sites
              // The subscription is cancelled, so we should mark items as inactive
              if (env.DB) {
                try {
                  const timestamp = Math.floor(Date.now() / 1000);
                  // Determine final status: if period ended and cancel_at_period_end was true, it's now cancelled
                  // When Stripe automatically cancels at period end, it sends status: 'canceled'
                  let finalStatus = sub.status || 'active';
                  if (sub.status === 'canceled') {
                    // Stripe has cancelled the subscription (either manually or automatically at period end)
                    finalStatus = 'canceled';
                  } else if (sub.cancel_at_period_end === true && periodEnded) {
                    // Period ended and cancel_at_period_end was true - subscription should be cancelled
                    finalStatus = 'canceled';
                  } else if (sub.cancel_at_period_end === true && !periodEnded) {
                    // Still active but will cancel at period end
                    finalStatus = 'active';
                  }
                  
                  await env.DB.prepare(
                    'UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, cancel_at = ?, current_period_end = ?, updated_at = ? WHERE subscription_id = ?'
                  ).bind(
                    finalStatus,
                    sub.cancel_at_period_end ? 1 : 0,
                    sub.canceled_at || null, // Stripe returns canceled_at, we store it as cancel_at
                    sub.current_period_end || null, // Ensure current_period_end is updated from Stripe
                    timestamp,
                    subscriptionId
                  ).run();
                  
                  // Mark items and licenses as inactive if:
                  // 1. Subscription status is 'canceled' (Stripe has cancelled it)
                  // 2. OR period has ended and cancel_at_period_end was true
                  // This handles both manual cancellations and automatic cancellations at period end
                  const shouldMarkInactive = sub.status === 'canceled' || 
                                             (periodEnded && sub.cancel_at_period_end === true);
                  
                  if (shouldMarkInactive) {
                    console.log(`[subscription.updated] Marking subscription ${subscriptionId} as inactive - status: ${sub.status}, periodEnded: ${periodEnded}, cancel_at_period_end: ${sub.cancel_at_period_end}`);
                    
                    // Mark all subscription items as inactive
                    await env.DB.prepare(
                      'UPDATE subscription_items SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
                    ).bind('inactive', timestamp, subscriptionId, 'active').run();
                    
                    // Mark all licenses as inactive for this subscription
                    const licenseUpdateResult = await env.DB.prepare(
                      'UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
                    ).bind('inactive', timestamp, subscriptionId, 'active').run();
                    
                    if (licenseUpdateResult.success) {
                      console.log(`[subscription.updated] ✅ Marked licenses as inactive for subscription ${subscriptionId}`);
                      
                      // Log the license deactivation
                      await logStripeEvent(env, {
                        id: `manual_${timestamp}`,
                        type: 'subscription.cancelled',
                        data: { object: sub },
                        created: timestamp
                      }, subscriptionId, customerId, {
                        action: 'licenses_marked_inactive',
                        period_ended: periodEnded,
                        cancel_at_period_end: sub.cancel_at_period_end,
                        status: sub.status,
                        note: 'Licenses marked inactive due to subscription cancellation'
                      });
                    } else {
                      console.warn(`[subscription.updated] ⚠️ Failed to mark licenses as inactive for subscription ${subscriptionId}`);
                    }
                  } else {
                    console.log(`[subscription.updated] Subscription ${subscriptionId} is not yet cancelled - status: ${sub.status}, periodEnded: ${periodEnded}, cancel_at_period_end: ${sub.cancel_at_period_end}`);
                  }
                } catch (dbErr) {
                  console.error('Error updating cancelled subscription in database:', dbErr);
                }
              }
              return new Response('ok');
            }
            
            const activeItemIds = new Set(sub.items.data.map(item => item.id));
            const itemIdToSite = new Map(); // Map item_id -> site name from user record
            
            // Build map of item_id to site name from user record
            Object.keys(user.sites || {}).forEach(site => {
              const siteData = user.sites[site];
              if (siteData.item_id) {
                itemIdToSite.set(siteData.item_id, site);
              }
            });

            // First, update existing sites and add new ones from Stripe
            const itemsForEmailStructure = [];
            const userEmail = user.email;
            
            // Fetch all licenses for sites in this subscription (batch fetch for efficiency)
            const siteNames = sub.items.data.map(item => {
              const siteFromMetadata = item.metadata?.site;
              const siteFromUserRecord = itemIdToSite.get(item.id);
              return siteFromMetadata || siteFromUserRecord;
            }).filter(Boolean);
            const licensesMap = await getLicensesForSites(env, siteNames, customerId, sub.id);
            
            for (const item of sub.items.data) {
              const siteFromMetadata = item.metadata?.site;
              const siteFromUserRecord = itemIdToSite.get(item.id);
              const site = siteFromMetadata || siteFromUserRecord;
              
              if (site) {
                // Get license for this site (already fetched in batch, but check if missing)
                let license = licensesMap[site];
                if (!license) {
                  license = await getLicenseForSite(env, site, customerId, sub.id);
                }
                
                // Generate license key if missing (for subscription.updated webhook)
                // CRITICAL: Only generate licenses for active subscriptions (not cancelled)
                if (!license && env.DB && sub.status === 'active' && !sub.cancel_at_period_end && !sub.canceled_at) {
                  try {
                    // Check if license already exists in database
                    const existingLicense = await env.DB.prepare(
                      'SELECT license_key FROM licenses WHERE customer_id = ? AND site_domain = ? AND status = ? LIMIT 1'
                    ).bind(customerId, site, 'active').first();
                    
                    if (!existingLicense) {
                      // Generate new license key only if subscription is active
                      const licenseKey = await generateUniqueLicenseKey(env);
                      const timestamp = Math.floor(Date.now() / 1000);
                      // Extract billing_period and renewal_date from subscription
                      const billingPeriod = extractBillingPeriodFromStripe(sub);
                      const renewalDate = sub.current_period_end || null;
                      await env.DB.prepare(
                        'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, license_key, status, billing_period, renewal_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                      ).bind(customerId, sub.id, item.id, site, licenseKey, 'active', billingPeriod, renewalDate, timestamp, timestamp).run();
                      license = { license_key: licenseKey };
                    } else {
                      license = existingLicense;
                    }
                  } catch (licenseError) {
                    console.error(`Failed to generate license for site ${site}:`, licenseError);
                  }
                } else if (!license && (sub.status === 'canceled' || sub.cancel_at_period_end || sub.canceled_at)) {
                }
                
                // Update existing site or add new one
                // CRITICAL: Mark as inactive if subscription is cancelled
                if (!user.sites) user.sites = {};
                const siteStatus = (sub.status === 'canceled' || sub.cancel_at_period_end || sub.canceled_at) ? 'inactive' : 'active';
                const siteData = {
                  item_id: item.id,
                  price: item.price.id,
                  quantity: item.quantity,
                  status: siteStatus,
                  created_at: user.sites[site]?.created_at || Math.floor(Date.now() / 1000),
                  subscription_id: sub.id,
                  license: license ? (license.license_key || license) : null,  // Add license info to site object
                  current_period_start: sub.current_period_start,
                  current_period_end: sub.current_period_end,
                  renewal_date: sub.current_period_end,
                  cancel_at_period_end: sub.cancel_at_period_end || false,
                  canceled_at: sub.canceled_at || null
                };
                user.sites[site] = siteData;
                
                // Save to KV storage (for subscription updates)
                // Only save for site purchases, not quantity purchases
                const itemPurchaseType = item.metadata?.purchase_type || 'site';
                if (itemPurchaseType !== 'quantity' && site) {
                  console.log(`[subscription.updated] 💾 Saving to KV storage for site: ${site}`);
                  await saveSubscriptionToKV(
                    env,
                    customerId,
                    subscriptionId,
                    userEmail,
                    site,
                    sub.status === 'active' ? 'complete' : sub.status,
                    'paid',
                    sub.cancel_at_period_end || false
                  );
                }
                
                // Save/update site details in database
                if (env.DB) {
                  // Get price details for amount
                  const priceDetailsRes = await stripeFetch(env, `/prices/${item.price.id}`);
                  const priceDetails = priceDetailsRes.status === 200 ? priceDetailsRes.body : null;
                  
                  await saveOrUpdateSiteInDB(env, {
                    customerId: customerId,
                    subscriptionId: sub.id,
                    itemId: item.id,
                    siteDomain: site,
                    priceId: item.price.id,
                    amountPaid: priceDetails?.unit_amount || 0,
                    currency: priceDetails?.currency || 'usd',
                    status: (() => {
                      const now = Math.floor(Date.now() / 1000);
                      const periodEnded = sub.current_period_end && sub.current_period_end < now;
                      
                      if (sub.status === 'canceled' || sub.canceled_at) {
                        return 'inactive';
                      } else if (sub.status === 'unpaid' || sub.status === 'past_due') {
                        return 'inactive';
                      } else if (sub.cancel_at_period_end && periodEnded) {
                        return 'inactive'; // Period ended, now cancelled
                      } else if (sub.cancel_at_period_end && !periodEnded) {
                        return 'cancelling'; // Will cancel at period end
                      } else {
                        return 'active';
                      }
                    })(),
                    currentPeriodStart: sub.current_period_start,
                    currentPeriodEnd: sub.current_period_end,
                    renewalDate: sub.current_period_end,
                    cancelAtPeriodEnd: sub.cancel_at_period_end || false,
                    canceledAt: sub.canceled_at || null
                  });
                }
                
                // ALSO store in subscriptions structure (NEW structure)
                if (!user.subscriptions) {
                  user.subscriptions = {};
                }
                if (!user.subscriptions[sub.id]) {
                  user.subscriptions[sub.id] = {
                    subscriptionId: sub.id,
                    status: sub.status || 'active',
                    sites: {},
                    created_at: Math.floor(Date.now() / 1000)
                  };
                }
                user.subscriptions[sub.id].sites[site] = siteData;
                user.subscriptions[sub.id].sitesCount = Object.keys(user.subscriptions[sub.id].sites).length;
                
                // Prepare item for email-based structure
                itemsForEmailStructure.push({
                  item_id: item.id,
                  site: site,  // Actual site name/domain
                  price: item.price.id,
                  quantity: item.quantity,
                  status: 'active',
                  created_at: siteData.created_at,
                  license: license || null  // Add license info to item
                });
                
              } else {
                // Item exists in Stripe but no site mapping - try to create one from metadata
                if (item.metadata?.site) {
                  const newSite = item.metadata.site;
                  if (!user.sites) user.sites = {};
                  user.sites[newSite] = {
                    item_id: item.id,
                    price: item.price.id,
                    quantity: item.quantity,
                    status: 'active',
                    created_at: Math.floor(Date.now() / 1000)
                  };
                }
              }
            }

            // Now, only mark sites as inactive if:
            // 1. They have an item_id
            // 2. That item_id is NOT in the active items
            // 3. They are currently marked as active (don't re-mark already inactive sites)
            Object.keys(user.sites || {}).forEach(site => {
              const siteData = user.sites[site];
              if (siteData.item_id && siteData.status === 'active') {
                // Only mark as inactive if item no longer exists AND it was previously active
                if (!activeItemIds.has(siteData.item_id)) {
                  // Double-check: make sure this item was actually removed, not just being added
                  // If the site was just added in checkout.session.completed, it might not be in Stripe yet
                  // So we only mark inactive if it's been more than a few seconds since creation
                  const timeSinceCreation = Date.now() / 1000 - (siteData.created_at || 0);
                  if (timeSinceCreation > 10) { // Only mark inactive if created more than 10 seconds ago
                    user.sites[site].status = 'inactive';
                    if (!user.sites[site].removed_at) {
                      user.sites[site].removed_at = Math.floor(Date.now() / 1000);
                    }
                  } else {
                  }
                } else {
                  // Item exists - ensure it's active and update quantity
                  const currentItem = sub.items.data.find(item => item.id === siteData.item_id);
                  if (currentItem) {
                    user.sites[site].status = 'active'; // Ensure it's active
                    user.sites[site].quantity = currentItem.quantity;
                    user.sites[site].price = currentItem.price.id; // Update price in case it changed
                  }
                }
              }
            });

            // Update subscription status (handle cancellation)
            if (sub.cancel_at_period_end) {
              // Subscription is scheduled to cancel at period end
              user.subscriptionStatus = 'cancelling';
              if (user.subscriptions && user.subscriptions[subscriptionId]) {
                user.subscriptions[subscriptionId].status = 'cancelling';
                user.subscriptions[subscriptionId].cancel_at_period_end = true;
                user.subscriptions[subscriptionId].cancel_at = sub.cancel_at;
                user.subscriptions[subscriptionId].current_period_end = sub.current_period_end;
              }
            } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'past_due') {
              // Subscription is cancelled or in bad state
              const finalStatus = sub.status === 'canceled' && sub.current_period_end < now ? 'expired' : sub.status;
              user.subscriptionStatus = finalStatus;
              if (user.subscriptions && user.subscriptions[subscriptionId]) {
                user.subscriptions[subscriptionId].status = finalStatus;
                user.subscriptions[subscriptionId].canceled_at = sub.canceled_at;
              }
              // Mark all sites as inactive or expired
              const removedAt = Math.floor(Date.now() / 1000);
              Object.keys(user.sites || {}).forEach(site => {
                if (user.sites[site].subscription_id === subscriptionId) {
                  user.sites[site].status = finalStatus === 'expired' ? 'expired' : 'inactive';
                  if (!user.sites[site].removed_at) {
                    user.sites[site].removed_at = removedAt;
                  }
                  
                  // Update site status in database
                  if (env.DB) {
                    saveOrUpdateSiteInDB(env, {
                      customerId: customerId,
                      subscriptionId: subscriptionId,
                      itemId: user.sites[site].item_id,
                      siteDomain: site,
                      priceId: user.sites[site].price,
                      amountPaid: 0, // Will be updated from existing record
                      currency: 'usd',
                      status: finalStatus === 'expired' ? 'expired' : 'inactive',
                      currentPeriodStart: sub.current_period_start,
                      currentPeriodEnd: sub.current_period_end,
                      renewalDate: sub.current_period_end,
                      cancelAtPeriodEnd: false,
                      canceledAt: sub.canceled_at || removedAt
                    }).catch(err => console.error('Failed to update site in DB:', err));
                  }
                }
              });
            } else {
              // Subscription is active
              user.subscriptionStatus = 'active';
              if (user.subscriptions && user.subscriptions[subscriptionId]) {
                user.subscriptions[subscriptionId].status = 'active';
                user.subscriptions[subscriptionId].cancel_at_period_end = false;
              }
            }
            
            // Update user in database
            await saveUserByEmail(env, userEmail, user);
            
            // Update subscription items in database
            if (itemsForEmailStructure.length > 0) {
              try {
                await addOrUpdateCustomerInUser(env, userEmail, customerId, subscriptionId, itemsForEmailStructure);
              } catch (dbError) {
                console.error(`❌ Failed to update database structure:`, dbError);
              }
            }
          }
        }

        // Handle customer.subscription.deleted - subscription was permanently deleted
        if (event.type === 'customer.subscription.deleted') {
          const subscription = event.data.object;
          const subscriptionId = subscription.id;
          const customerId = subscription.customer;
          
          // Log subscription deletion
          await logStripeEvent(env, event, subscriptionId, customerId, {
            action: 'subscription_deleted',
            status: subscription.status,
            canceled_at: subscription.canceled_at,
            current_period_end: subscription.current_period_end,
            note: 'Subscription permanently deleted by Stripe'
          });


          // Get user record from database by email
          const userEmail = await getCustomerEmail(env, customerId);
          if (!userEmail) {
            console.warn('User email not found for subscription deletion');
            return new Response('ok');
          }
          
          const user = await getUserByEmail(env, userEmail);
          if (!user) {
            console.warn('User record not found for subscription deletion');
            return new Response('ok');
          }
          
          // Mark subscription as deleted
          if (user.subscriptions && user.subscriptions[subscriptionId]) {
            user.subscriptions[subscriptionId].status = 'deleted';
            user.subscriptions[subscriptionId].deleted_at = Math.floor(Date.now() / 1000);
            user.subscriptions[subscriptionId].canceled_at = subscription.canceled_at;
          }
          
          // Mark all sites in this subscription as inactive/expired
          const deletedAt = Math.floor(Date.now() / 1000);
          Object.keys(user.sites || {}).forEach(site => {
            if (user.sites[site].subscription_id === subscriptionId) {
              user.sites[site].status = 'expired';
              if (!user.sites[site].removed_at) {
                user.sites[site].removed_at = deletedAt;
              }
              
              // Update site status in database to expired
              if (env.DB) {
                saveOrUpdateSiteInDB(env, {
                  customerId: customerId,
                  subscriptionId: subscriptionId,
                  itemId: user.sites[site].item_id,
                  siteDomain: site,
                  priceId: user.sites[site].price,
                  amountPaid: 0, // Will be updated from existing record
                  currency: 'usd',
                  status: 'expired',
                  currentPeriodStart: subscription.current_period_start || null,
                  currentPeriodEnd: subscription.current_period_end || null,
                  renewalDate: subscription.current_period_end || null,
                  cancelAtPeriodEnd: false,
                  canceledAt: subscription.canceled_at || deletedAt
                }).catch(err => console.error('Failed to update site in DB:', err));
              }
            }
          });
          
          // Update licenses in database
          if (env.DB) {
            try {
              const timestamp = Math.floor(Date.now() / 1000);
              await env.DB.prepare(
                'UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
              ).bind('inactive', timestamp, subscriptionId, 'active').run();
            } catch (dbError) {
              console.error('Failed to update licenses for deleted subscription:', dbError);
            }
          }
          
          // If this was the primary subscription, update subscriptionId
          if (user.subscriptionId === subscriptionId) {
            // Find another active subscription
            const activeSub = Object.keys(user.subscriptions || {}).find(subId => 
              user.subscriptions[subId].status === 'active'
            );
            user.subscriptionId = activeSub || null;
          }
          
          // Save updated user to database
          await saveUserByEmail(env, userEmail, user);
          
          // Update database structure
          if (userEmail) {
            try {
              const userFromEmail = await getUserByEmail(env, userEmail);
              if (userFromEmail && userFromEmail.customers) {
                for (const customer of userFromEmail.customers) {
                  const subscription = customer.subscriptions.find(s => s.subscriptionId === subscriptionId);
                  if (subscription) {
                    subscription.status = 'deleted';
                    subscription.deleted_at = Math.floor(Date.now() / 1000);
                    // Mark items as inactive
                    if (subscription.items) {
                      subscription.items.forEach(item => {
                        item.status = 'inactive';
                      });
                    }
                  }
                }
                await saveUserByEmail(env, user.email, userFromEmail);
              }
            } catch (emailStructureError) {
              console.error(`❌ Failed to update email-based structure:`, emailStructureError);
            }
          }
        }

        // Handle payment_intent.succeeded - for payment mode checkouts (prorated amounts)
        if (event.type === 'payment_intent.succeeded') {
          const paymentIntent = event.data.object;
          const customerId = paymentIntent.customer;
          
          // For Use Case 3, metadata might be on payment_intent or we need to fetch it
          // Also check if there's a charge with metadata
          let metadata = paymentIntent.metadata || {};
          
          // If metadata is empty, try to get it from the latest charge
          if (!metadata.usecase && paymentIntent.latest_charge) {
            try {
              const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
              if (chargeRes.status === 200 && chargeRes.body.metadata) {
                metadata = { ...metadata, ...chargeRes.body.metadata };
              }
            } catch (chargeErr) {
              console.warn(`[payment_intent.succeeded] Could not fetch charge metadata:`, chargeErr);
            }
          }
          
          const existingSubscriptionId = metadata.existing_subscription_id || metadata.subscription_id;
          const addToExisting = metadata.add_to_existing === 'true';
          const useCase3 = metadata.usecase === '3'; // Primary identifier for Use Case 3
          const useCase2 = metadata.usecase === '2'; // Primary identifier for Use Case 2
          // For Use Case 3, get customer ID from metadata or paymentIntent.customer
          const useCase3CustomerId = metadata.customer_id || customerId;
          // For Use Case 2, get customer ID from metadata or paymentIntent.customer
          const useCase2CustomerId = metadata.customer_id || customerId;
          
          
          // USE CASE 2: Site purchase - Create separate subscription for each site (like Use Case 3 for licenses)
         // USE CASE 2: Site purchase - enqueue site processing job instead of immediate subscriptions


if (useCase2 && useCase2CustomerId) {
  try {
    const userEmail = await getCustomerEmail(env, useCase2CustomerId);
    if (!userEmail) {
      console.warn('[USE CASE 2] No user email, exiting');
      return new Response('ok');
    }

    let siteNames = [];
    let priceId = null;
    let billingPeriod = null;

    try {
      if (metadata.sites) {
        siteNames = JSON.parse(metadata.sites);
      }
      priceId = metadata.price_id || null;
      billingPeriod = (metadata.billing_period || '').toLowerCase().trim() || null;
    } catch (e) {
      console.error('[USE CASE 2] Error parsing metadata:', e);
    }

    if (!priceId || siteNames.length === 0) {
      console.warn('[USE CASE 2] Missing priceId or sites, skipping');
      return new Response('ok');
    }

    // STEP 1: save payment method as before (same code you already had)
    let paymentMethodId = paymentIntent.payment_method;
    /* ... keep your existing payment method attach + set default logic here ... */
    let paymentMethodSaved = true; // set to true at the end of that logic

    if (!paymentMethodSaved) {
      console.warn('[USE CASE 2] Payment method not saved, skipping enqueue');
      return new Response('ok');
    }

    // STEP 2: enqueue site job
    const sitesForQueue = siteNames.map(name => ({
      site: name,
      price: priceId,
      billing_period: billingPeriod,
    }));

    const queueId = await enqueueSiteQueueItem(env, {
      customerId: useCase2CustomerId,
      userEmail,
      subscriptionId: null,
      sites: sitesForQueue,
      billingPeriod,
      priceId,
      paymentIntentId: paymentIntent.id,
    });

    console.log('[USE CASE 2] Enqueued site job', queueId);

    // optional: clear pendingSites here if you want
    return new Response('ok');
  } catch (err) {
    console.error('[USE CASE 2] Error in handler:', err);
    return new Response('ok');
  }
}
         
// USE CASE 3: Quantity license purchase


          if (useCase3 && useCase3CustomerId) {
  // Check if subscriptions/licenses already exist for this payment intent
  // This indicates checkout.session.completed already processed the purchase
  if (env.DB) {
    try {
      // Method 1: Check if subscriptions exist with payment_intent_id in queue (most reliable)
      const queueCheck = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscription_queue 
         WHERE payment_intent_id = ? AND status IN ('completed', 'processing')`
      ).bind(paymentIntent.id).first();
      
      if (queueCheck && queueCheck.count > 0) {
        console.log(`[USE CASE 3 - payment_intent.succeeded] ⚠️ Skipping duplicate processing - ${queueCheck.count} queue item(s) already processed by checkout.session.completed webhook`);
                return new Response('ok');
              }
              
      // Method 2: Check if licenses exist for this customer with purchase_type='quantity' created recently (within last 10 minutes)
      // This catches cases where checkout.session.completed already processed the purchase
      const recentTimestamp = Math.floor(Date.now() / 1000) - (10 * 60); // 10 minutes ago
      const existingLicenses = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM licenses 
         WHERE customer_id = ? AND purchase_type = 'quantity' AND created_at >= ?`
      ).bind(useCase3CustomerId, recentTimestamp).first();
      
      if (existingLicenses && existingLicenses.count > 0) {
        console.log(`[USE CASE 3 - payment_intent.succeeded] ⚠️ Skipping duplicate processing - ${existingLicenses.count} license(s) already created by checkout.session.completed webhook`);
        return new Response('ok');
      }
    } catch (checkErr) {
      console.warn(`[USE CASE 3 - payment_intent.succeeded] ⚠️ Could not check for existing licenses:`, checkErr);
      // Continue processing if check fails (fallback behavior - but log warning)
      console.warn(`[USE CASE 3 - payment_intent.succeeded] ⚠️ Proceeding with fallback processing (may create duplicates if checkout.session.completed already processed)`);
    }
  }
  
  try {
    const userEmail = await getCustomerEmail(env, useCase3CustomerId);
    if (!userEmail) {
      console.warn('[USE CASE 3] Email not found');
      return new Response('ok');
    }

    // ===============================
    // ✅ METADATA (ONLY quantity + price)
    // ===============================
    const priceId = metadata.price_id || null;
    const quantity = Number(metadata.quantity) || 0;

    if (!priceId || quantity <= 0) {
      console.error('[USE CASE 3] ❌ Invalid metadata', metadata);
      return new Response('ok');
    }

    // ===============================
    // ✅ GENERATE REAL LICENSE KEYS
    // ===============================
    const licenseKeys = [];
    for (let i = 0; i < quantity; i++) {
      licenseKeys.push(await generateUniqueLicenseKey(env));
    }

    console.log(`[USE CASE 3 - payment_intent.succeeded] ✅ Generated ${licenseKeys.length} license keys (fallback handler - checkout.session.completed should have handled this)`);

    // ===============================
    // STEP 1: Save payment method
    // ===============================
    let paymentMethodId = paymentIntent.payment_method;

    if (!paymentMethodId && paymentIntent.latest_charge) {
      const charge = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
      paymentMethodId = charge?.body?.payment_method;
    }

    if (!paymentMethodId) {
      console.error('[USE CASE 3] ❌ No payment method');
      return new Response('ok');
    }

    await stripeFetch(
      env,
      `/payment_methods/${paymentMethodId}/attach`,
      'POST',
      { customer: useCase3CustomerId },
      true
    );

    await stripeFetch(
      env,
      `/customers/${useCase3CustomerId}`,
      'POST',
      { 'invoice_settings[default_payment_method]': paymentMethodId },
      true
    );

    // ===============================
    // STEP 2: Create subscriptions
    // ===============================
    const createdSubscriptionIds = [];
    const successfulLicenseSubscriptions = [];
    const now = Math.floor(Date.now() / 1000);
    const trialEnd = now + 30 * 24 * 60 * 60; // 30 days

    for (let i = 0; i < quantity; i++) {
      const res = await stripeFetch(
        env,
        '/subscriptions',
        'POST',
        {
          customer: useCase3CustomerId,
                      'items[0][price]': priceId,
                      'items[0][quantity]': 1,
          'trial_end': trialEnd.toString(),
                      'metadata[license_key]': licenseKeys[i],
                      'metadata[usecase]': '3',
          'metadata[purchase_type]': 'quantity'
        },
        true
      );

      if (res.status !== 200) continue;

      const sub = res.body;
      createdSubscriptionIds.push(sub.id);

      const itemId = sub.items?.data?.[0]?.id || null;
                        
                        successfulLicenseSubscriptions.push({
                          licenseKey: licenseKeys[i],
        subscriptionId: sub.id,
        itemId,
        renewalDate: sub.current_period_end || null
      });
    }

    // ===============================
    // STEP 3: Save licenses to DB + KV
    // ===============================
    if (env.DB) {
      const ts = Math.floor(Date.now() / 1000);

      for (const l of successfulLicenseSubscriptions) {
                          await env.DB.prepare(
                            `INSERT INTO licenses 
                             (license_key, customer_id, subscription_id, item_id, 
            status, purchase_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
          l.licenseKey,
                            useCase3CustomerId,
          l.subscriptionId,
          l.itemId,
                            'active',
                            'quantity',
          ts,
          ts
                          ).run();
                          
                          await saveLicenseKeyToKV(
                            env,
          l.licenseKey,
                            useCase3CustomerId,
          l.subscriptionId,
                            userEmail,
          'complete',
          false,
          null
        );
      }
    }

    // ===============================
    // STEP 4: Save payments
    // ===============================
    if (env.DB && createdSubscriptionIds.length > 0) {
      const ts = Math.floor(Date.now() / 1000);
      const perUnit = Math.round(paymentIntent.amount / quantity);

      for (const subId of createdSubscriptionIds) {
                              await env.DB.prepare(
          `INSERT INTO payments
           (customer_id, subscription_id, email, amount, currency,
            status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                              ).bind(
          useCase3CustomerId,
          subId,
          userEmail,
          perUnit,
          paymentIntent.currency || 'usd',
          'succeeded',
          ts,
          ts
                              ).run();
                }
              }
              
              return new Response('ok');
  } catch (err) {
    console.error('[USE CASE 3] ❌ Fatal error', err);
    return new Response('ok');
            }
          }
          
          // Normal site-based purchase flow (existing logic)
          if (addToExisting && existingSubscriptionId && customerId) {
            // Extract sites and prices from metadata
            const sites = [];
            const prices = [];
            let index = 0;
            while (metadata[`site_${index}`]) {
              sites.push(metadata[`site_${index}`]);
              prices.push(metadata[`price_${index}`]);
              index++;
            }
            
            
            // Get user email from customerId
            const userEmail = await getCustomerEmail(env, customerId);
            if (!userEmail) {
              console.warn('User email not found for payment_intent.succeeded');
              return new Response('ok');
            }
            
            // Get user record from database
            let user = await getUserByEmail(env, userEmail);
            if (!user) {
              console.warn('User record not found for payment_intent.succeeded');
              return new Response('ok');
            }
            
            // Get existing subscription
            const existingSubRes = await stripeFetch(env, `/subscriptions/${existingSubscriptionId}`);
            if (existingSubRes.status === 200) {
              const existingSub = existingSubRes.body;
              
              // Add each site to the existing subscription with proration
              for (let i = 0; i < sites.length; i++) {
                const site = sites[i];
                const priceId = prices[i];
                
                if (!site || !priceId) continue;
                
                
                // Add subscription item to existing subscription
                // Note: Since user already paid prorated amount, we add with proration_behavior: 'none'
                // to avoid double charging. The prorated amount was already paid in the checkout.
                const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
                  'subscription': existingSubscriptionId,
                  'price': priceId,
                  'quantity': 1,
                  'metadata[site]': site,
                  'proration_behavior': 'none' // No proration - already paid
                }, true);
                
                if (addItemRes.status === 200) {
                  const newItem = addItemRes.body;
                  
                  const siteData = {
                    item_id: newItem.id,
                    price: newItem.price.id,
                    quantity: newItem.quantity,
                    status: 'active',
                    created_at: Math.floor(Date.now() / 1000),
                    subscription_id: existingSubscriptionId
                  };
                  
                  // Update user record
                  if (!user.sites) user.sites = {};
                  user.sites[site] = siteData;
                  
                  // Update subscriptions structure
                  if (!user.subscriptions) {
                    user.subscriptions = {};
                  }
                  if (!user.subscriptions[existingSubscriptionId]) {
                    user.subscriptions[existingSubscriptionId] = {
                      subscriptionId: existingSubscriptionId,
                      status: 'active',
                      sites: {},
                      created_at: Math.floor(Date.now() / 1000)
                    };
                  }
                  user.subscriptions[existingSubscriptionId].sites[site] = siteData;
                  user.subscriptions[existingSubscriptionId].sitesCount = Object.keys(user.subscriptions[existingSubscriptionId].sites).length;
                  
                  // Remove from pending sites
                  if (user.pendingSites) {
                    user.pendingSites = user.pendingSites.filter(p => 
                      (p.site || p).toLowerCase().trim() !== site.toLowerCase().trim()
                    );
                  }
                  
                  // Get subscription details for renewal date
                  const subDetailsRes = await stripeFetch(env, `/subscriptions/${existingSubscriptionId}`);
                  const subDetails = subDetailsRes.status === 200 ? subDetailsRes.body : null;
                  
                  // Get price details for amount
                  const priceDetailsRes = await stripeFetch(env, `/prices/${priceId}`);
                  const priceDetails = priceDetailsRes.status === 200 ? priceDetailsRes.body : null;
                  
                  // Save site details to database
                  if (env.DB && subDetails && priceDetails) {
                    await saveOrUpdateSiteInDB(env, {
                      customerId: customerId,
                      subscriptionId: existingSubscriptionId,
                      itemId: newItem.id,
                      siteDomain: site,
                      priceId: priceId,
                      amountPaid: priceDetails.unit_amount || 0,
                      currency: priceDetails.currency || 'usd',
                      status: 'active',
                      currentPeriodStart: subDetails.current_period_start,
                      currentPeriodEnd: subDetails.current_period_end,
                      renewalDate: subDetails.current_period_end,
                      cancelAtPeriodEnd: subDetails.cancel_at_period_end || false,
                      canceledAt: subDetails.canceled_at || null
                    });
                    
                    // Create payment record for this site
                    // The amount paid is the prorated amount from the payment intent
                    const paymentAmount = paymentIntent.amount || priceDetails.unit_amount || 0;
                    try {
                      const timestamp = Math.floor(Date.now() / 1000);
                      await env.DB.prepare(
                        `INSERT INTO payments (
                          customer_id, subscription_id, email, amount, currency, 
                          status, site_domain, magic_link, magic_link_generated, 
                          created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                      ).bind(
                        customerId,
                        existingSubscriptionId,
                        userEmail,
                        paymentAmount,
                        paymentIntent.currency || priceDetails.currency || 'usd',
                        'succeeded',
                        site,
                        null, // magic_link - not used
                        0, // magic_link_generated - false
                        timestamp,
                        timestamp
                      ).run();
                    } catch (paymentError) {
                      console.error(`Failed to create payment record for site ${site}:`, paymentError);
                      // Don't fail the whole operation if payment record creation fails
                    }
                  }
                  
                  // Generate license key
                  if (env.DB) {
                    try {
                      const licenseKey = await generateUniqueLicenseKey(env);
                      const timestamp = Math.floor(Date.now() / 1000);
                      await env.DB.prepare(
                        'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, license_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                      ).bind(customerId, existingSubscriptionId, newItem.id, site, licenseKey, 'active', timestamp, timestamp).run();
                    } catch (licenseError) {
                      console.error('Failed to generate license:', licenseError);
                    }
                  }
                  
                } else {
                  console.error(`Failed to add site ${site} to subscription:`, addItemRes.status, addItemRes.body);
                }
              }
              
              // Save user record to database
              await saveUserByEmail(env, userEmail, user);
              
              // Update database structure
              if (user.email) {
                try {
                  await addOrUpdateCustomerInUser(env, user.email, customerId, existingSubscriptionId, 
                    sites.map((site, i) => ({
                      item_id: user.sites[site]?.item_id,
                      site: site,
                      price: prices[i],
                      quantity: 1,
                      status: 'active',
                      created_at: Math.floor(Date.now() / 1000)
                    }))
                  );
                } catch (emailError) {
                  console.error('Failed to update email-based structure:', emailError);
                }
              }
              
            }
          }
        }

        // Handle invoice.payment_succeeded - generate license keys (if not already done)
        if (event.type === 'invoice.payment_succeeded') {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const customerId = invoice.customer;
          
          // Log invoice payment success
          await logStripeEvent(env, event, subscriptionId, customerId, {
            action: 'invoice_payment_succeeded',
            invoice_id: invoice.id,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            period_start: invoice.period_start,
            period_end: invoice.period_end,
            note: 'Invoice payment succeeded - renewal or initial payment'
          });


          if (!subscriptionId || !customerId) {
            console.error('Missing subscription_id or customer_id in invoice');
            return new Response('ok'); // Return ok to prevent retries
          }

          // Fetch subscription details to get quantity
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status !== 200) {
            console.error('Failed to fetch subscription:', subRes.status, subRes.body);
            return new Response('ok');
          }

          const subscription = subRes.body;
          
          // CRITICAL: Skip Use Case 3 (quantity purchases) - licenses already exist
          // Use Case 3 subscriptions have metadata.purchase_type = 'quantity' and metadata.usecase = '3'
          const subscriptionMetadata = subscription.metadata || {};
          const isUseCase3 = subscriptionMetadata.purchase_type === 'quantity' || subscriptionMetadata.usecase === '3';
          
          if (isUseCase3) {
            return new Response('ok'); // Return ok - licenses already exist for Use Case 3
          }
          
          // CRITICAL: Check if subscription is cancelled before generating licenses
          // Skip license generation for cancelled subscriptions
          const isCancelled = subscription.status === 'canceled' || 
                             subscription.cancel_at_period_end === true ||
                             subscription.canceled_at !== null;
          
          // Also check database to see if subscription is marked as cancelled
          let dbSubscriptionCancelled = false;
          if (env.DB) {
            try {
              const dbSub = await env.DB.prepare(
                'SELECT status, cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(subscriptionId).first();
              
              if (dbSub) {
                dbSubscriptionCancelled = dbSub.status === 'canceled' || dbSub.cancel_at_period_end === 1;
              }
            } catch (dbErr) {
              console.error('Error checking subscription status in database:', dbErr);
            }
          }
          
          if (isCancelled || dbSubscriptionCancelled) {
            return new Response('ok'); // Return ok - don't generate licenses for cancelled subscriptions
          }
          
          // Generate one license key per subscription item (site)
          // Each subscription item represents one site, regardless of quantity
          let siteCount = 1;
          if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
            // Count number of subscription items (sites), not quantities
            siteCount = subscription.items.data.length;
          }

          // Get user record from database to map sites to subscription items
          const userData = await getUserByCustomerId(env, customerId) || { sites: {} };

          // Check if licenses already exist for this subscription to avoid duplicates
          let existingLicenses = [];
          if (env.DB) {
            try {
              const existing = await env.DB.prepare(
                'SELECT license_key, site_domain FROM licenses WHERE subscription_id = ?'
              ).bind(subscriptionId).all();
              if (existing.success) {
                existingLicenses = existing.results.map(r => ({ key: r.license_key, site: r.site_domain }));
              }
            } catch (e) {
              console.error('Error checking existing licenses:', e);
            }
          }

          // Map subscription items to sites and generate licenses
          const licensesToCreate = [];
          subscription.items.data.forEach((item, index) => {
            // Get site from item metadata or user record
            let site = item.metadata?.site;
            if (!site) {
              const siteEntry = Object.entries(userData.sites || {}).find(([_, data]) => data.item_id === item.id);
              if (siteEntry) {
                site = siteEntry[0];
              } else {
                site = `site_${index + 1}`;
              }
            }
            
            // Check if license already exists for this site
            const existingForSite = existingLicenses.find(l => l.site === site);
            if (!existingForSite) {
              licensesToCreate.push({ site, item_id: item.id });
            }
          });

          if (licensesToCreate.length === 0) {
            return new Response('ok');
          }

          // Generate license keys - one per site
          const licenseKeys = await generateLicenseKeys(licensesToCreate.length, env);

          // Save licenses to D1 database with site mapping
          if (env.DB) {
            try {
              const timestamp = Math.floor(Date.now() / 1000);
              
              // Prepare insert statements with site_domain
              const inserts = licenseKeys.map((key, idx) => {
                const site = licensesToCreate[idx].site;
                return env.DB.prepare(
                  'INSERT INTO licenses (customer_id, subscription_id, license_key, site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(customerId, subscriptionId, key, site, 'active', timestamp, timestamp);
              });

              // Execute all inserts in a transaction
              const batch = env.DB.batch(inserts);
              await batch;
              
            } catch (dbError) {
              console.error('Database error saving licenses:', dbError);
              // Log but don't fail - Stripe will retry if we return error
            }
          } else {
            console.warn('D1 database not configured. License keys generated but not saved:', licenseKeys);
          }

          // Licenses are stored in database, no need to update user data structure
          // (Licenses are now stored in the licenses table, not in user data)
        }

        if (event.type === 'invoice.payment_failed') {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const customerId = invoice.customer;
          
          // Log invoice payment failure
          await logStripeEvent(env, event, subscriptionId, customerId, {
            action: 'invoice_payment_failed',
            invoice_id: invoice.id,
            amount_due: invoice.amount_due,
            currency: invoice.currency,
            attempt_count: invoice.attempt_count,
            next_payment_attempt: invoice.next_payment_attempt,
            note: 'Invoice payment failed - subscription may be at risk'
          });
        }
        
        // Log any other unhandled event types
        const handledEventTypes = [
          'checkout.session.completed', 
          'payment_intent.succeeded', 
          'customer.subscription.updated', 
          'customer.subscription.deleted', 
          'invoice.payment_succeeded', 
          'invoice.payment_failed'
        ];
        
        if (!handledEventTypes.includes(event.type)) {
          const unhandledSubId = event.data?.object?.subscription || event.data?.object?.id || null;
          const unhandledCustId = event.data?.object?.customer || null;
          await logStripeEvent(env, event, unhandledSubId, unhandledCustId, {
            action: 'unhandled_event',
            note: `Unhandled event type: ${event.type}`
          });
        }

        return new Response('ok');
        } catch (error) {
          // Safely log error without referencing variables that might not be in scope
          const errorMessage = error?.message || 'Unknown error';
          const errorStack = error?.stack || 'No stack trace';
          console.error('Handler error:', errorMessage);
          console.error('Error stack:', errorStack);
          return new Response(JSON.stringify({ error: 'Internal server error', message: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Export Stripe logs as JSON file
      if (request.method === 'GET' && pathname === '/export-stripe-logs') {
        if (!env.DB) {
          return jsonResponse(500, { error: 'Database not configured' }, true, request);
        }

        try {
          const url = new URL(request.url);
          const date = url.searchParams.get('date'); // Optional: filter by date (YYYY-MM-DD)
          const subscriptionId = url.searchParams.get('subscription_id'); // Optional: filter by subscription ID
          const customerId = url.searchParams.get('customer_id'); // Optional: filter by customer ID
          const eventType = url.searchParams.get('event_type'); // Optional: filter by event type
          const limit = parseInt(url.searchParams.get('limit')) || 1000; // Default 1000, max 10000
          const maxLimit = Math.min(limit, 10000);

          let query = 'SELECT * FROM stripe_logs WHERE 1=1';
          const params = [];

          if (date) {
            query += ' AND date = ?';
            params.push(date);
          }
          if (subscriptionId) {
            query += ' AND subscription_id = ?';
            params.push(subscriptionId);
          }
          if (customerId) {
            query += ' AND customer_id = ?';
            params.push(customerId);
          }
          if (eventType) {
            query += ' AND event_type = ?';
            params.push(eventType);
          }

          query += ' ORDER BY timestamp DESC LIMIT ?';
          params.push(maxLimit);

          const result = await env.DB.prepare(query).bind(...params).all();

          if (!result.success) {
            return jsonResponse(500, { error: 'Failed to fetch logs', details: result.error }, true, request);
          }

          // Parse JSON fields
          const logs = (result.results || []).map(log => ({
            id: log.id,
            timestamp: log.timestamp,
            date: log.date,
            event_id: log.event_id,
            event_type: log.event_type,
            subscription_id: log.subscription_id,
            customer_id: log.customer_id,
            event_data: log.event_data ? JSON.parse(log.event_data) : null,
            additional_data: log.additional_data ? JSON.parse(log.additional_data) : null,
            created_at: log.created_at,
            created_at_iso: new Date(log.created_at * 1000).toISOString()
          }));

          // Return as JSON file download
          const jsonContent = JSON.stringify(logs, null, 2);
          const filename = `stripe-logs-${date || 'all'}-${new Date().toISOString().split('T')[0]}.json`;

          return new Response(jsonContent, {
            headers: {
              'Content-Type': 'application/json',
              'Content-Disposition': `attachment; filename="${filename}"`,
              ...corsHeaders
            }
          });
        } catch (error) {
          console.error('[Export Logs] Error:', error);
          return jsonResponse(500, { error: 'Failed to export logs', message: error.message }, true, request);
        }
      }

      if (request.method === 'GET' && pathname === '/dashboard') {
        // Try to get email from query parameter (for Memberstack users)
        const emailParam = url.searchParams.get('email');
        
        // Pagination parameters
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        const type = url.searchParams.get('type'); // 'sites' or 'subscriptions'
        const status = url.searchParams.get('status'); // 'active', 'cancelling', 'cancelled' for sites; 'monthly', 'yearly' for subscriptions
        
        // Read session cookie
        const cookie = request.headers.get('cookie') || "";
        const match = cookie.match(/sb_session=([^;]+)/);
        
        let payload = null;
        let email = null;
        
        // If email parameter is provided, use it directly (for Memberstack authentication)
        if (emailParam) {
          email = emailParam.toLowerCase().trim();
          // Create a mock payload for email-based access
          payload = {
            email: email,
            customerId: null // Will be looked up from database
          };
        } else if (match) {
          // Use session cookie authentication
        const token = match[1];
          payload = await verifyToken(env, token);
        if (!payload) {
            return jsonResponse(401, { error: 'invalid session', message: 'Session token is invalid or expired' }, true, request);
          }
          email = payload.email;
        } else {
          return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found' }, true, request);
        }

        
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
        
        // Initialize license maps early (used later in Step 3)
        const allLicensesMap = {}; // site_domain -> license
        const quantityLicensesMap = {}; // subscription_id -> { item_id -> license }
        
        // Step 1: Get all customers for this email (OPTIMIZED: parallel queries)
        try {
          // Run both customer queries in parallel for faster loading
          const [customersRes, paymentsCustomersRes] = await Promise.all([
            env.DB.prepare(
              'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
            ).bind(normalizedEmail).all(),
            env.DB.prepare(
              'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
            ).bind(normalizedEmail).all()
          ]);
          
          if (customersRes && customersRes.results) {
            allCustomerIds = customersRes.results.map(row => row.customer_id).filter(id => id);
          }
          
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
               current_period_start, current_period_end, billing_period, created_at 
               FROM subscriptions 
               WHERE customer_id IN (${placeholders}) AND user_email = ?`
            ).bind(...allCustomerIds, normalizedEmail).all();
            
            if (subscriptionsRes && subscriptionsRes.results) {
              for (const subRow of subscriptionsRes.results) {
                const subscriptionId = subRow.subscription_id;
                const customerId = subRow.customer_id;
                
                // Determine subscription status - if canceled or cancel_at_period_end, show as cancelled
                let subscriptionStatus = subRow.status || 'active';
                const now = Math.floor(Date.now() / 1000);
                
                if (subRow.status === 'canceled') {
                  // Already cancelled in Stripe
                  subscriptionStatus = 'cancelled';
                } else if (subRow.cancel_at_period_end === 1) {
                  // Check if period has ended
                  if (subRow.current_period_end && subRow.current_period_end < now) {
                    // Period has ended, subscription should be cancelled
                    subscriptionStatus = 'cancelled';
                  } else {
                    // Period hasn't ended yet, still cancelling
                    subscriptionStatus = 'cancelling';
                  }
                }
                
                subscriptions[subscriptionId] = {
                  subscriptionId: subscriptionId,
                  customerId: customerId,
                  status: subscriptionStatus,
                  items: [],
                  sitesCount: 0,
                  created_at: subRow.created_at,
                  current_period_start: subRow.current_period_start,
                  current_period_end: subRow.current_period_end,
                  billingPeriod: subRow.billing_period || null,
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
        
        // Store licenses result for later use (activated license sites)
        let allLicensesResult = null;
        
        // Step 3.5 & 3: Fetch licenses and subscription items in parallel (OPTIMIZED)
        // (License maps are already initialized at the top of the function)
        // For site purchases: map by site_domain
        // For quantity purchases: map by subscription_id and item_id
        if (subscriptionIds.length > 0) {
          try {
            const placeholders = subscriptionIds.map(() => '?').join(',');
            
            // OPTIMIZED: Run licenses and items queries in parallel
            const [licensesRes, itemsRes] = await Promise.all([
              env.DB.prepare(
                `SELECT license_key, site_domain, used_site_domain, subscription_id, item_id, status, purchase_type, billing_period, renewal_date, created_at 
                 FROM licenses 
                 WHERE subscription_id IN (${placeholders}) AND status = ?`
              ).bind(...subscriptionIds, 'active').all(),
              env.DB.prepare(
                `SELECT subscription_id, item_id, site_domain, price_id, quantity, status, billing_period, renewal_date, created_at, removed_at 
                 FROM subscription_items 
                 WHERE subscription_id IN (${placeholders})`
              ).bind(...subscriptionIds).all()
            ]);
            
            // Store licenses result for later use
            allLicensesResult = licensesRes;
            
            // Process licenses
            // CRITICAL: Map licenses for both site purchases and activated quantity purchases
            if (licensesRes && licensesRes.results) {
              for (const license of licensesRes.results) {
                // For site purchases: map by site_domain or used_site_domain
                const siteDomain = license.used_site_domain || license.site_domain;
                if (siteDomain && license.license_key && license.purchase_type !== 'quantity') {
                  allLicensesMap[siteDomain] = {
                    license_key: license.license_key,
                    status: license.status || 'active',
                    created_at: license.created_at,
                    billing_period: license.billing_period || null,
                    renewal_date: license.renewal_date || null,
                    purchase_type: license.purchase_type || 'site'
                  };
                }
                
                // For activated quantity purchases: also map by used_site_domain
                if (license.purchase_type === 'quantity' && license.used_site_domain && license.license_key) {
                  // Map activated license sites so they appear in subscriptions
                  const activatedSite = license.used_site_domain;
                  if (activatedSite && 
                      !activatedSite.startsWith('license_') && 
                      !activatedSite.startsWith('quantity_') &&
                      activatedSite !== 'N/A' &&
                      !activatedSite.startsWith('KEY-')) {
                    allLicensesMap[activatedSite] = {
                      license_key: license.license_key,
                      status: license.status || 'active',
                      created_at: license.created_at,
                      billing_period: license.billing_period || null,
                      renewal_date: license.renewal_date || null,
                      purchase_type: 'quantity',
                      used_site_domain: license.used_site_domain
                    };
                  }
                }
                
                // For quantity purchases: map by subscription_id and item_id (for unactivated licenses)
                if (license.purchase_type === 'quantity' && license.license_key && license.subscription_id) {
                  if (!quantityLicensesMap[license.subscription_id]) {
                    quantityLicensesMap[license.subscription_id] = {};
                  }
                  // Map by item_id if available, otherwise use subscription_id as key
                  const key = license.item_id || license.subscription_id;
                  quantityLicensesMap[license.subscription_id][key] = {
                    license_key: license.license_key,
                    status: license.status || 'active',
                    created_at: license.created_at,
                    item_id: license.item_id,
                    purchase_type: 'quantity',
                    billing_period: license.billing_period || null,
                    renewal_date: license.renewal_date || null,
                    used_site_domain: license.used_site_domain || null
                  };
                }
              }
            }
            
            // Process subscription items
            if (itemsRes && itemsRes.results) {
              
              // Build a map of subscription_id -> items
              const itemsBySubscription = {};
              for (const itemRow of itemsRes.results) {
                const subId = itemRow.subscription_id;
                if (!itemsBySubscription[subId]) {
                  itemsBySubscription[subId] = [];
                }
                itemsBySubscription[subId].push(itemRow);
              }
              
              // Add items to subscriptions and fetch billing period from Stripe
              for (const [subId, items] of Object.entries(itemsBySubscription)) {
                if (subscriptions[subId]) {
                  // Fetch billing period from first item's price (all items in a subscription typically have same billing period)
                  let billingPeriod = subscriptions[subId].billingPeriod || null;
                  if (!billingPeriod && items.length > 0 && items[0].price_id) {
                    try {
                      const priceRes = await stripeFetch(env, `/prices/${items[0].price_id}`);
                      if (priceRes.status === 200 && priceRes.body.recurring) {
                        const interval = priceRes.body.recurring.interval;
                        // Map Stripe interval to readable format
                        if (interval === 'month') billingPeriod = 'monthly';
                        else if (interval === 'year') billingPeriod = 'yearly';
                        else if (interval === 'week') billingPeriod = 'weekly';
                        else if (interval === 'day') billingPeriod = 'daily';
                        else billingPeriod = interval; // fallback to raw value
                      }
                    } catch (priceErr) {
                      // If price fetch fails, continue without billing period
                    }
                  }
                  
                  // Determine item status - if subscription is cancelled or item is removed, mark as inactive
                  const isSubscriptionCancelled = subscriptions[subId].cancel_at_period_end || subscriptions[subId].status === 'canceled' || subscriptions[subId].status === 'cancelling';
                  
                  // Determine purchase_type for subscription based on items and licenses
                  let subscriptionPurchaseType = null;
                  const quantityLicenses = quantityLicensesMap[subId] || {};
                  
                  // First, process regular subscription items
                  subscriptions[subId].items = items.map(item => {
                    // Check if this is a quantity purchase by looking for license
                    const quantityLicense = quantityLicenses[item.item_id] || quantityLicenses[subId];
                    const isQuantityPurchase = !!quantityLicense;
                    
                    // Determine purchase_type for this item
                    // If item has purchase_type in DB, use it; otherwise infer from license
                    let itemPurchaseType = item.purchase_type;
                    if (!itemPurchaseType) {
                      itemPurchaseType = isQuantityPurchase ? 'quantity' : 'site';
                    }
                    
                    // Set subscription purchase_type based on first item (before adding activated licenses)
                    if (!subscriptionPurchaseType) {
                      subscriptionPurchaseType = itemPurchaseType;
                    }
                    
                    return {
                      item_id: item.item_id,
                      site: item.site_domain,
                      site_domain: item.site_domain, // Add both for compatibility
                      price: item.price_id,
                      quantity: item.quantity || 1,
                      status: item.status || (item.removed_at || isSubscriptionCancelled ? 'inactive' : 'active'),
                      created_at: item.created_at,
                      removed_at: item.removed_at || null,
                      purchase_type: itemPurchaseType,
                      license_key: quantityLicense?.license_key || null
                    };
                  });
                  
                  // CRITICAL: Only add activated license sites to quantity purchase subscriptions
                  // Site purchase subscriptions should NOT have activated license items added
                  if (subscriptionPurchaseType === 'quantity') {
                    const activatedLicenses = (allLicensesResult && allLicensesResult.results) ? allLicensesResult.results.filter(lic => 
                      lic.subscription_id === subId &&
                      lic.purchase_type === 'quantity' &&
                      lic.used_site_domain &&
                      !lic.used_site_domain.startsWith('license_') &&
                      !lic.used_site_domain.startsWith('quantity_') &&
                      lic.used_site_domain !== 'N/A' &&
                      !lic.used_site_domain.startsWith('KEY-')
                    ) : [];
                    
                    // Add activated license sites as items if they're not already in items
                    const existingSites = new Set(subscriptions[subId].items.map(i => (i.site || i.site_domain || '').toLowerCase().trim()));
                    
                    for (const activatedLicense of activatedLicenses) {
                      const activatedSite = activatedLicense.used_site_domain.toLowerCase().trim();
                      if (!existingSites.has(activatedSite)) {
                        // Find a matching item_id or create a placeholder
                        let itemId = activatedLicense.item_id || `license_${activatedLicense.license_key?.substring(0, 8)}_${subId.substring(0, 12)}`;
                        
                        // Try to find price_id from subscription items or get from first item
                        let priceId = null;
                        if (subscriptions[subId].items.length > 0) {
                          priceId = subscriptions[subId].items[0].price;
                        }
                        
                        subscriptions[subId].items.push({
                          item_id: itemId,
                          site: activatedLicense.used_site_domain,
                          site_domain: activatedLicense.used_site_domain,
                          price: priceId,
                          quantity: 1,
                          status: 'active',
                          created_at: activatedLicense.created_at || Math.floor(Date.now() / 1000),
                          removed_at: null,
                          purchase_type: 'quantity',
                          license_key: activatedLicense.license_key,
                          isActivated: true, // Mark as activated license
                          billing_period: activatedLicense.billing_period || subscriptions[subId].billingPeriod || null,
                          renewal_date: activatedLicense.renewal_date || subscriptions[subId].current_period_end || null
                        });
                        existingSites.add(activatedSite);
                      }
                    }
                  }
                  
                  subscriptions[subId].sitesCount = subscriptions[subId].items.length;
                  subscriptions[subId].billingPeriod = billingPeriod;
                  // CRITICAL: Ensure purchase_type is correctly set - don't let activated licenses change it
                  subscriptions[subId].purchase_type = subscriptionPurchaseType || 'site'; // Default to 'site' if can't determine
                }
              }
            }
            
            // CRITICAL: If items are missing from database, try payments table first, then Stripe
            for (const subId of subscriptionIds) {
              if (!subscriptions[subId].items || subscriptions[subId].items.length === 0) {
                
                // FIRST: Try to get items from payments table (most reliable source)
                try {
                  const paymentsRes = await env.DB.prepare(
                    `SELECT DISTINCT site_domain, customer_id, amount, currency, created_at 
                     FROM payments 
                     WHERE subscription_id = ? 
                     AND site_domain IS NOT NULL 
                     AND site_domain != '' 
                     AND site_domain NOT LIKE 'site_%'
                     ORDER BY created_at DESC`
                  ).bind(subId).all();
                  
                  if (paymentsRes && paymentsRes.results && paymentsRes.results.length > 0) {
                    
                    // Fetch subscription from Stripe to get item_ids
                    let stripeItems = [];
                    try {
                      const stripeSubRes = await stripeFetch(env, `/subscriptions/${subId}`);
                      if (stripeSubRes.status === 200 && stripeSubRes.body.items && stripeSubRes.body.items.data) {
                        stripeItems = stripeSubRes.body.items.data;
                      }
                    } catch (stripeErr) {
                      console.error(`Error fetching subscription ${subId} from Stripe:`, stripeErr);
                    }
                    
                    // Build items from payments table
                    const itemsToSave = [];
                    for (let index = 0; index < paymentsRes.results.length; index++) {
                      const payment = paymentsRes.results[index];
                      const siteDomain = payment.site_domain;
                      
                      // Try to match with Stripe item by index, or use first item if only one
                      let itemId = null;
                      let priceId = null;
                      if (stripeItems.length > 0) {
                        const stripeItem = stripeItems[index] || stripeItems[0];
                        itemId = stripeItem.id;
                        priceId = stripeItem.price.id;
                      }
                      
                      // If no Stripe item, we'll need to create a placeholder item_id
                      if (!itemId) {
                        itemId = `pending_${subId}_${index}`;
                      }
                      
                      itemsToSave.push({
                        item_id: itemId,
                        site: siteDomain,
                        price: priceId || null,
                        quantity: 1,
                        status: 'active',
                        created_at: payment.created_at || Math.floor(Date.now() / 1000)
                      });
                      
                      // Save to subscription_items table (only if we have a real item_id from Stripe)
                      if (itemId && !itemId.startsWith('pending_')) {
                        try {
                          await env.DB.prepare(
                            `INSERT OR REPLACE INTO subscription_items 
                             (subscription_id, item_id, site_domain, price_id, quantity, status, created_at, updated_at, removed_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
                            subId,
                            itemId,
                            siteDomain,
                            priceId,
                            1,
                            'active',
                            payment.created_at || Math.floor(Date.now() / 1000),
                            Math.floor(Date.now() / 1000),
                            null
                          ).run();
                        } catch (saveErr) {
                          console.error(`Error saving item ${itemId} to database:`, saveErr);
                        }
                      }
                    }
                    
                    // Update subscriptions object with items from payments table
                    subscriptions[subId].items = itemsToSave;
                    subscriptions[subId].sitesCount = itemsToSave.length;
                    continue; // Skip Stripe fetch since we got data from payments
                  }
                } catch (paymentErr) {
                  console.error(`Error fetching from payments table for subscription ${subId}:`, paymentErr);
                }
                
                // SECOND: If payments table didn't have data, try Stripe
                try {
                  // Fetch subscription from Stripe
                  const stripeSubRes = await stripeFetch(env, `/subscriptions/${subId}`);
                  if (stripeSubRes.status === 200 && stripeSubRes.body.items && stripeSubRes.body.items.data) {
                    const stripeItems = stripeSubRes.body.items.data;
                    
                    // Fetch billing period from price
                    let billingPeriod = subscriptions[subId].billingPeriod || null;
                    if (!billingPeriod && stripeItems.length > 0 && stripeItems[0].price) {
                      try {
                        const priceRes = await stripeFetch(env, `/prices/${stripeItems[0].price.id}`);
                        if (priceRes.status === 200 && priceRes.body.recurring) {
                          const interval = priceRes.body.recurring.interval;
                          if (interval === 'month') billingPeriod = 'monthly';
                          else if (interval === 'year') billingPeriod = 'yearly';
                          else if (interval === 'week') billingPeriod = 'weekly';
                          else if (interval === 'day') billingPeriod = 'daily';
                          else billingPeriod = interval;
                        }
                      } catch (priceErr) {
                        // Continue without billing period
                      }
                    }
                    
                    // Get license keys for quantity purchases for this subscription
                    const quantityLicenses = quantityLicensesMap[subId] || {};
                    
                    const itemsToSave = [];
                    for (const item of stripeItems) {
                      // Check if this is a quantity purchase by checking for license key
                      const quantityLicense = quantityLicenses[item.id] || quantityLicenses[subId];
                      const isQuantityPurchase = !!quantityLicense;
                      
                      // Try to get site domain from metadata or payments table (only for site purchases)
                      let siteDomain = null;
                      if (!isQuantityPurchase) {
                        siteDomain = item.metadata?.site || item.metadata?.site_domain || null;
                        
                        // If no site in metadata, try payments table
                        if (!siteDomain || siteDomain.startsWith('site_')) {
                          try {
                            const paymentRes = await env.DB.prepare(
                              'SELECT site_domain FROM payments WHERE subscription_id = ? AND site_domain IS NOT NULL AND site_domain != "" AND site_domain NOT LIKE "site_%" ORDER BY created_at DESC LIMIT 1'
                            ).bind(subId).first();
                            if (paymentRes && paymentRes.site_domain) {
                              siteDomain = paymentRes.site_domain;
                            }
                          } catch (paymentErr) {
                          }
                        }
                        
                        // Fallback to placeholder if still not found
                        if (!siteDomain || siteDomain.startsWith('site_')) {
                          siteDomain = `site_${itemsToSave.length + 1}`;
                        }
                      } else {
                        // For quantity purchases, use a placeholder since site_domain is required but not applicable
                        // Use license key or subscription ID as identifier
                        const licenseKey = quantityLicense?.license_key || '';
                        if (licenseKey) {
                          siteDomain = `license_${licenseKey.substring(0, 8)}_${subId.substring(0, 12)}`;
                        } else {
                          siteDomain = `quantity_${subId.substring(0, 20)}`;
                        }
                      }
                      
                      // Determine purchase type - check if this is an activated license
                      let itemPurchaseType = isQuantityPurchase ? 'quantity' : 'site';
                      let isActivated = false;
                      
                      if (isQuantityPurchase && quantityLicense && quantityLicense.used_site_domain) {
                        // This is an activated license - use the actual site domain
                        const actualSite = quantityLicense.used_site_domain;
                        if (actualSite && 
                            !actualSite.startsWith('license_') && 
                            !actualSite.startsWith('quantity_') &&
                            actualSite !== 'N/A' &&
                            !actualSite.startsWith('KEY-')) {
                          siteDomain = actualSite; // Use the activated site domain
                          isActivated = true;
                        }
                      }
                      
                      itemsToSave.push({
                        item_id: item.id,
                        site: siteDomain,
                        site_domain: siteDomain, // Add both for compatibility
                        price: item.price.id,
                        quantity: item.quantity || 1,
                        status: 'active',
                        created_at: Math.floor(Date.now() / 1000),
                        // Add license key for quantity purchases
                        license_key: quantityLicense ? quantityLicense.license_key : null,
                        purchase_type: itemPurchaseType,
                        isActivated: isActivated // Mark activated licenses
                      });
                      
                      // Save to subscription_items table
                      try {
                        await env.DB.prepare(
                          `INSERT OR REPLACE INTO subscription_items 
                           (subscription_id, item_id, site_domain, price_id, quantity, status, created_at, updated_at, removed_at) 
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).bind(
                          subId,
                          item.id,
                          siteDomain,
                          item.price.id,
                          item.quantity || 1,
                          'active',
                          Math.floor(Date.now() / 1000),
                          Math.floor(Date.now() / 1000),
                          null
                        ).run();
                      } catch (saveErr) {
                        console.error(`Error saving item ${item.id} to database:`, saveErr);
                      }
                    }
                    
                    // Update subscriptions object with fetched items
                    subscriptions[subId].items = itemsToSave;
                    subscriptions[subId].sitesCount = itemsToSave.length;
                    subscriptions[subId].billingPeriod = billingPeriod;
                  }
                } catch (stripeErr) {
                  console.error(`Error fetching subscription ${subId} from Stripe:`, stripeErr);
                }
              }
            }
          } catch (dbErr) {
            console.error('Error fetching subscription items:', dbErr);
          }
        }
        
        // Step 4: (Licenses are now fetched in Step 3.5, so this step is no longer needed)
        // License maps are already populated before Step 3 uses them
        
        // Step 5: Build sites object from subscription items
        // CRITICAL: ONLY include site purchases (purchase_type === 'site') for Domain-Subscriptions
        // Exclude: direct payments and activated license sites
        console.log(`[USE CASE 2 - DASHBOARD] 🔍 STEP 4: Building sites object from subscription items`);
        console.log(`[USE CASE 2 - DASHBOARD] 📊 Processing ${Object.keys(subscriptions).length} subscription(s)`);
        let useCase2SiteCount = 0;
        for (const [subId, subscription] of Object.entries(subscriptions)) {
          const customerId = subscription.customerId;
          
          for (const item of subscription.items) {
            const siteDomain = item.site || item.site_domain;
            const itemPurchaseType = item.purchase_type || subscription.purchase_type || 'site';
            
            // Only log Use Case 2 items
            if (itemPurchaseType === 'site') {
              console.log(`[USE CASE 2 - DASHBOARD] 🔍 Processing site: ${siteDomain} (subscription: ${subId})`);
            }
            
            // Skip if no site domain
            if (!siteDomain || siteDomain.trim() === '') {
              continue;
            }
            
            // Skip placeholder sites (site_1, site_2, etc.) - only show real domains
            // BUT include activated license sites even if they have license_ prefix in item
            const isActivatedLicense = item.isActivated || (item.purchase_type === 'quantity' && item.license_key);
            if (siteDomain.startsWith('site_') && /^site_\d+$/.test(siteDomain) && !isActivatedLicense) {
              continue;
            }
            
            // Skip license_ and quantity_ placeholders for unactivated licenses
            if ((siteDomain.startsWith('license_') || siteDomain.startsWith('quantity_')) && !isActivatedLicense) {
              continue;
            }
            
            // For activated licenses, use the used_site_domain from license
            let actualSiteDomain = siteDomain;
            if (isActivatedLicense && item.purchase_type === 'quantity') {
              // Try to get the actual site domain from license
              const license = allLicensesMap[siteDomain] || 
                            (allLicensesResult && allLicensesResult.results ? allLicensesResult.results.find(lic => 
                              lic.subscription_id === subId && 
                              lic.license_key === item.license_key &&
                              lic.used_site_domain
                            ) : null);
              if (license && license.used_site_domain) {
                actualSiteDomain = license.used_site_domain;
              } else {
                // Skip if no actual site domain for activated license
                continue;
              }
            }
            
            // CRITICAL: Include ALL sites in sites object (for "Your Domains/Sites" section)
            // This includes: direct payments, site purchases, and activated license sites
            // The frontend will filter Domain-Subscriptions to only show site purchases
            
            // Get license for this site
            const license = allLicensesMap[actualSiteDomain] || 
                          (item.license_key ? {
                            license_key: item.license_key,
                            status: 'active',
                            purchase_type: item.purchase_type || 'site'
                          } : null);
            
            // Get site details from sites table
            let siteDetails = null;
            try {
              siteDetails = await env.DB.prepare(
                'SELECT amount_paid, currency, status, current_period_start, current_period_end, renewal_date, cancel_at_period_end, canceled_at, billing_period FROM sites WHERE customer_id = ? AND subscription_id = ? AND site_domain = ? LIMIT 1'
              ).bind(customerId, subId, actualSiteDomain).first();
            } catch (dbErr) {
            }
            
            // Determine purchase type
            const purchaseType = item.purchase_type || 
                               subscription.purchase_type || 
                               license?.purchase_type || 
                               'site';
            
            // Build site object
            sites[actualSiteDomain] = {
              item_id: item.item_id,
              price: item.price,
              quantity: item.quantity || 1,
              status: item.status || 'active',
              created_at: item.created_at,
              subscription_id: subId,
              license_key: license?.license_key || item.license_key || null,
              purchase_type: purchaseType,
              billing_period: siteDetails?.billing_period || subscription.billingPeriod || license?.billing_period || null,
              amount_paid: siteDetails?.amount_paid || null,
              currency: siteDetails?.currency || 'usd',
              current_period_start: siteDetails?.current_period_start || subscription.current_period_start || null,
              current_period_end: siteDetails?.current_period_end || subscription.current_period_end || null,
              renewal_date: siteDetails?.renewal_date || license?.renewal_date || subscription.current_period_end || null,
              cancel_at_period_end: siteDetails?.cancel_at_period_end === 1 || subscription.cancel_at_period_end || false,
              canceled_at: siteDetails?.canceled_at || subscription.canceled_at || null
            };
            
            // Log Use Case 2 sites
            if (purchaseType === 'site') {
              useCase2SiteCount++;
              console.log(`[USE CASE 2 - DASHBOARD] ✅ Added site: ${actualSiteDomain} (license: ${sites[actualSiteDomain].license_key?.substring(0, 20)}...)`);
            }
          }
        }
        console.log(`[USE CASE 2 - DASHBOARD] ✅ STEP 4 COMPLETE: Added ${useCase2SiteCount} Use Case 2 site(s) to sites object`);
        
        // Step 5.5: Also add activated license sites that might not be in subscription items
        // This ensures all activated license sites are included in the sites object
        // (for "Your Domains/Sites" section which shows all sites)
        if (allLicensesResult && allLicensesResult.results) {
          for (const license of allLicensesResult.results) {
            // Only process activated quantity purchase licenses
            if (license.purchase_type === 'quantity' && 
                license.used_site_domain &&
                !license.used_site_domain.startsWith('license_') &&
                !license.used_site_domain.startsWith('quantity_') &&
                license.used_site_domain !== 'N/A' &&
                !license.used_site_domain.startsWith('KEY-')) {
              
              const activatedSite = license.used_site_domain;
              
              // Skip if already in sites object
              if (sites[activatedSite]) {
                continue;
              }
              
              // Get subscription for this license
              const subId = license.subscription_id;
              const subscription = subscriptions[subId];
              
              if (subscription) {
                const customerId = subscription.customerId;
                
                // Get site details from sites table
                let siteDetails = null;
                try {
                  siteDetails = await env.DB.prepare(
                    'SELECT amount_paid, currency, status, current_period_start, current_period_end, renewal_date, cancel_at_period_end, canceled_at, billing_period FROM sites WHERE customer_id = ? AND subscription_id = ? AND site_domain = ? LIMIT 1'
                  ).bind(customerId, subId, activatedSite).first();
                } catch (dbErr) {
                }
                
                // Add activated license site to sites object
                sites[activatedSite] = {
                  item_id: license.item_id || `license_${license.license_key?.substring(0, 8)}_${subId.substring(0, 12)}`,
                  price: null, // Will be set from subscription if available
                  quantity: 1,
                  status: license.status || 'active',
                  created_at: license.created_at || Math.floor(Date.now() / 1000),
                  subscription_id: subId,
                  license_key: license.license_key,
                  purchase_type: 'quantity',
                  billing_period: license.billing_period || subscription.billingPeriod || siteDetails?.billing_period || null,
                  amount_paid: siteDetails?.amount_paid || null,
                  currency: siteDetails?.currency || 'usd',
                  current_period_start: siteDetails?.current_period_start || subscription.current_period_start || null,
                  current_period_end: siteDetails?.current_period_end || subscription.current_period_end || null,
                  renewal_date: license.renewal_date || siteDetails?.renewal_date || subscription.current_period_end || null,
                  cancel_at_period_end: siteDetails?.cancel_at_period_end === 1 || subscription.cancel_at_period_end || false,
                  canceled_at: siteDetails?.canceled_at || subscription.canceled_at || null,
                  isActivated: true
                };
              }
            }
          }
        }
        
        // Step 6: Get pending sites
        let pendingSites = [];
        try {
          const pendingRes = await env.DB.prepare(
            'SELECT site_domain FROM pending_sites WHERE user_email = ?'
          ).bind(normalizedEmail).all();
          
          if (pendingRes && pendingRes.results) {
            pendingSites = pendingRes.results.map(row => row.site_domain).filter(s => s);
          }
        } catch (dbErr) {
          console.error('Error fetching pending sites:', dbErr);
        }
        
        // Step 7: Get payment history
        let paymentHistory = [];
        try {
          // Query matches actual schema: id (not payment_id), no payment_type column
          const paymentsRes = await env.DB.prepare(
            `SELECT id, customer_id, subscription_id, email, amount, currency, 
             site_domain, status, created_at 
             FROM payments 
             WHERE email = ? 
             ORDER BY created_at DESC`
          ).bind(normalizedEmail).all();
          
          if (paymentsRes && paymentsRes.results) {
            paymentHistory = paymentsRes.results.map(payment => ({
              id: payment.id,
              payment_id: payment.id, // Map id to payment_id for frontend compatibility
              customer_id: payment.customer_id,
              subscription_id: payment.subscription_id,
              email: payment.email,
              amount: payment.amount,
              currency: payment.currency,
              site_domain: payment.site_domain,
              status: payment.status,
              created_at: payment.created_at
            }));
          }
        } catch (dbErr) {
          console.error('Error fetching payment history:', dbErr);
        }
        
        return jsonResponse(200, {
          sites: sites,
          subscriptions: subscriptions,
          pendingSites: pendingSites,
          paymentHistory: paymentHistory,
          subscription: allSubscriptions.length > 0 ? {
            id: allSubscriptions[0].subscriptionId,
            customerId: allSubscriptions[0].customerId,
            email: email
          } : null,
          subscriptionId: allSubscriptions.length > 0 ? allSubscriptions[0].subscriptionId : null,
          customerId: allCustomerIds.length > 0 ? allCustomerIds[0] : null,
          allCustomerIds: allCustomerIds,
          email: email
        }, true, request);
      }

//USECASE 2 DASHBOARD - END
if (request.method === 'POST' && url.pathname === '/create-site-checkout') {
      return handleCreateSiteCheckout(request, env);
    }

   

   
    //   if (request.method === 'POST' && url.pathname === '/add-sites-batch') {
    //   return handleAddSitesBatch(request, env);
    // }

    // if (request.method === 'POST' && url.pathname === '/create-checkout-from-pending') {
    //   return handleCreateCheckoutFromPending(request, env);
    // }
      // Get magic link for a customer (for testing/display after payment)
      // Supports: ?email=... OR ?session_id=... OR ?customer_id=...
      if (request.method === 'GET' && pathname === '/get-magic-link') {
        const email = url.searchParams.get('email');
        // Strip any cache-busting parameters that might be appended to session_id
        let sessionId = url.searchParams.get('session_id');
        if (sessionId && sessionId.includes('?')) {
          sessionId = sessionId.split('?')[0]; // Remove query string if present
        }
        const customerId = url.searchParams.get('customer_id');

        try {
          let result = null;
          let lookupCustomerId = customerId;
          let lookupEmail = email;
          let stripeSessionData = null;

          // PRIORITY: If session_id is provided, ALWAYS fetch from Stripe first (most reliable)
          // This ensures we get the correct email even if URL params are wrong or database has old records
          if (sessionId) {
            const sessionRes = await stripeFetch(env, `/checkout/sessions/${sessionId}`);
            if (sessionRes.status === 200 && sessionRes.body) {
              stripeSessionData = sessionRes.body;
              lookupCustomerId = stripeSessionData.customer;
              lookupEmail = stripeSessionData.customer_details?.email || stripeSessionData.customer_email;
              
              // CRITICAL: If we have session_id, ALWAYS return email from Stripe (most reliable)
              // Don't query database - Stripe is the source of truth for the current payment
              if (lookupEmail) {
                
                // Try to get additional info from database if available, but use Stripe email
                // Wrap in try-catch so database errors don't prevent returning the email
                let dbResult = null;
          if (env.DB) {
                  try {
                    dbResult = await env.DB.prepare(
                      'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments WHERE customer_id = ? OR subscription_id = ? ORDER BY created_at DESC LIMIT 1'
                    ).bind(lookupCustomerId, stripeSessionData.subscription || '').first();
                  } catch (dbError) {
                    console.warn(`[get-magic-link] Database query failed (non-critical):`, dbError.message);
                    // Continue without database data - we have email from Stripe
                  }
                }
                
                // ALWAYS return email from Stripe, even if database fails
                return jsonResponse(200, {
                  email: lookupEmail, // ALWAYS use email from Stripe session
                  customerId: lookupCustomerId,
                  subscriptionId: stripeSessionData.subscription || dbResult?.subscription_id || null,
                  siteDomain: dbResult?.site_domain || null,
                  message: `Redirecting to login page...`,
                  sent: true,
                  createdAt: dbResult?.created_at || null
                });
              }
            } else {
              console.error(`[get-magic-link] Failed to fetch Stripe session: ${sessionRes.status}`);
            }
          }

          // Get latest payment record from database (only if no session_id provided)
          if (env.DB) {
            if (lookupEmail) {
              // Search by email (most reliable)
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments WHERE email = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(lookupEmail).first();
            } else if (lookupCustomerId) {
              // Search by customer_id
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(lookupCustomerId).first();
            } else {
              // Get most recent payment (for testing only)
              console.warn('[get-magic-link] No email or customer_id provided, returning most recent payment');
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments ORDER BY created_at DESC LIMIT 1'
              ).first();
            }

            if (result && result.email) {
              return jsonResponse(200, {
                email: result.email,
                customerId: result.customer_id,
                subscriptionId: result.subscription_id,
                siteDomain: result.site_domain,
                message: `Redirecting to login page...`,
                sent: true,
                createdAt: result.created_at
              });
            }
          }

          return jsonResponse(404, { 
            error: 'magic link not found',
            message: 'Payment may not be completed yet. Please wait a moment and refresh, or check Worker logs for the magic link.'
          });
        } catch (error) {
          console.error('Error retrieving magic link:', error);
          return jsonResponse(500, { error: 'failed to retrieve magic link' });
        }
      }

      // Get licenses for a customer
      // Get available price options (monthly/yearly) from database
      if (request.method === 'GET' && pathname === '/get-price-options') {
        try {
          // Try to get from database first
          if (env.DB) {
            const monthlyResult = await env.DB.prepare(
              'SELECT price_id, discount_allowance, discount_type, coupon_code FROM price_config WHERE price_type = ? AND is_active = 1'
            ).bind('monthly').first();
            
            const yearlyResult = await env.DB.prepare(
              'SELECT price_id, discount_allowance, discount_type, coupon_code FROM price_config WHERE price_type = ? AND is_active = 1'
            ).bind('yearly').first();
            
            if (monthlyResult || yearlyResult) {
              return jsonResponse(200, {
                monthly: monthlyResult ? {
                  price_id: monthlyResult.price_id,
                  discount_allowance: monthlyResult.discount_allowance || 0,
                  discount_type: monthlyResult.discount_type || 'percentage',
                  coupon_code: monthlyResult.coupon_code || null
                } : null,
                yearly: yearlyResult ? {
                  price_id: yearlyResult.price_id,
                  discount_allowance: yearlyResult.discount_allowance || 0,
                  discount_type: yearlyResult.discount_type || 'percentage',
                  coupon_code: yearlyResult.coupon_code || null
                } : null,
                source: 'database'
              }, true, request);
            }
          }
          
          // Fallback to environment variables if database not available
          return jsonResponse(200, {
            monthly: env.MONTHLY_PRICE_ID ? {
              price_id: env.MONTHLY_PRICE_ID,
              discount_allowance: 0,
              discount_type: 'percentage',
              coupon_code: null
            } : null,
            yearly: env.YEARLY_PRICE_ID ? {
              price_id: env.YEARLY_PRICE_ID,
              discount_allowance: 0,
              discount_type: 'percentage',
              coupon_code: null
            } : null,
            default: env.DEFAULT_PRICE_ID || null,
            source: 'environment'
          }, true, request);
        } catch (error) {
          console.error('[get-price-options] Error:', error);
          // Fallback to environment variables on error
          return jsonResponse(200, {
            monthly: env.MONTHLY_PRICE_ID ? {
              price_id: env.MONTHLY_PRICE_ID,
              discount_allowance: 0,
              discount_type: 'percentage',
              coupon_code: null
            } : null,
            yearly: env.YEARLY_PRICE_ID ? {
              price_id: env.YEARLY_PRICE_ID,
              discount_allowance: 0,
              discount_type: 'percentage',
              coupon_code: null
            } : null,
            default: env.DEFAULT_PRICE_ID || null,
            source: 'environment_fallback',
            error: error.message
          }, true, request);
        }
      }

      // Admin endpoint to update price configuration
      if (request.method === 'POST' && pathname === '/admin/update-price-config') {
        try {
          const body = await request.json();
          const { price_type, price_id, discount_allowance, discount_type, coupon_code, description, is_active } = body;
          
          // Validate required fields
          if (!price_type || !price_id) {
            return jsonResponse(400, {
              error: 'missing_fields',
              message: 'price_type and price_id are required'
            }, true, request);
          }
          
          if (price_type !== 'monthly' && price_type !== 'yearly') {
            return jsonResponse(400, {
              error: 'invalid_price_type',
              message: 'price_type must be "monthly" or "yearly"'
            }, true, request);
          }
          
          if (!env.DB) {
            return jsonResponse(500, {
              error: 'database_not_available',
              message: 'Database is not configured'
            }, true, request);
          }
          
          // Update or insert price config
          const discountAllowance = discount_allowance !== undefined ? discount_allowance : 0;
          const discountType = discount_type || 'percentage';
          const couponCode = coupon_code || null;
          const isActive = is_active !== undefined ? (is_active ? 1 : 0) : 1;
          const desc = description || null;
          
          // Check if record exists
          const existing = await env.DB.prepare(
            'SELECT id FROM price_config WHERE price_type = ?'
          ).bind(price_type).first();
          
          if (existing) {
            // Update existing record
            await env.DB.prepare(`
              UPDATE price_config 
              SET price_id = ?,
                  discount_allowance = ?,
                  discount_type = ?,
                  coupon_code = ?,
                  is_active = ?,
                  description = ?,
                  updated_at = unixepoch()
              WHERE price_type = ?
            `).bind(price_id, discountAllowance, discountType, couponCode, isActive, desc, price_type).run();
          } else {
            // Insert new record
            await env.DB.prepare(`
              INSERT INTO price_config (price_type, price_id, discount_allowance, discount_type, coupon_code, is_active, description, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
            `).bind(price_type, price_id, discountAllowance, discountType, couponCode, isActive, desc).run();
          }
          
          return jsonResponse(200, {
            success: true,
            message: `Price config for ${price_type} updated successfully`,
            data: {
              price_type,
              price_id,
              discount_allowance: discountAllowance,
              discount_type: discountType,
              coupon_code: couponCode,
              is_active: isActive,
              description: desc
            }
          }, true, request);
        } catch (error) {
          console.error('[admin/update-price-config] Error:', error);
          return jsonResponse(500, {
            error: 'update_failed',
            message: error.message || 'Failed to update price config'
          }, true, request);
        }
      }

      // Admin endpoint to get all price configurations
      if (request.method === 'GET' && pathname === '/admin/price-config') {
        try {
          if (!env.DB) {
            return jsonResponse(500, {
              error: 'database_not_available',
              message: 'Database is not configured'
            }, true, request);
          }
          
          const results = await env.DB.prepare(
            'SELECT * FROM price_config ORDER BY price_type'
          ).all();
          
          return jsonResponse(200, {
            success: true,
            data: results.results || []
          }, true, request);
        } catch (error) {
          console.error('[admin/price-config] Error:', error);
          return jsonResponse(500, {
            error: 'fetch_failed',
            message: error.message || 'Failed to fetch price config'
          }, true, request);
        }
      }

      if (request.method === 'GET' && pathname === '/licenses') {
        
        // Try to get email from query parameter (for Memberstack users)
        const emailParam = url.searchParams.get('email');
        
        // Pagination parameters
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        const status = url.searchParams.get('status'); // 'available', 'activated', 'cancelling', 'cancelled'
        
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        let payload = null;
        let email = null;
        let customerId = null;
        
        if (emailParam) {
          email = emailParam.toLowerCase().trim();
          payload = { email: email, customerId: null };
        } else if (match) {
        const token = match[1];
          payload = await verifyToken(env, token);
        if (!payload) {
            return jsonResponse(401, { error: 'invalid session', message: 'Session token is invalid or expired', licenses: [], pagination: { total: 0, hasMore: false } }, true, request);
          }
          email = payload.email;
          customerId = payload.customerId;
        } else {
          return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found', licenses: [], pagination: { total: 0, hasMore: false } }, true, request);
        }

        // CRITICAL: Find ALL customers with the same email to get all licenses
        let allCustomerIds = customerId ? [customerId] : [];
        if (email && env.DB) {
          try {
            // First, get customer IDs from the customers table (primary source)
            const customersRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
            ).bind(email.toLowerCase().trim()).all();
            
            if (customersRes && customersRes.results) {
              const foundCustomerIds = customersRes.results
                .map(row => row.customer_id)
                .filter(id => id && id.startsWith('cus_'));
              allCustomerIds = [...new Set([...allCustomerIds, ...foundCustomerIds])];
            }
            
            // Also check payments table for any additional customer IDs
            const paymentsRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
            ).bind(email.toLowerCase().trim()).all();
            
            if (paymentsRes && paymentsRes.results) {
              const paymentCustomerIds = paymentsRes.results
                .map(row => row.customer_id)
                .filter(id => id && id.startsWith('cus_'));
              allCustomerIds = [...new Set([...allCustomerIds, ...paymentCustomerIds])];
            }
            
            // Filter out null values and ensure all are valid customer IDs
            allCustomerIds = allCustomerIds.filter(id => id && id.startsWith('cus_'));
            
          } catch (dbErr) {
            console.error('Error finding all customers by email for licenses:', dbErr);
          }
        }

        try {
          let licenses = [];
          let d1Error = null;
          let kvError = null;

          // Try to get from D1 database first - query ALL customer IDs
          if (env.DB) {
            try {
              // Build query for all customer IDs
              const placeholders = allCustomerIds.map(() => '?').join(',');
              let result;
              // Query with all license fields including used_site_domain and purchase_type
              // IMPORTANT: Query ALL licenses (not just active) to show complete history
              try {
                result = await env.DB.prepare(
                  `SELECT license_key, site_domain, used_site_domain, status, purchase_type, created_at, customer_id, subscription_id, item_id, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                ).bind(...allCustomerIds).all();
              } catch (columnErr) {
                // Fallback if new columns don't exist yet
                if (columnErr.message && (columnErr.message.includes('no such column: used_site_domain') || columnErr.message.includes('no such column: purchase_type'))) {
                  try {
                    result = await env.DB.prepare(
                      `SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                    ).bind(...allCustomerIds).all();
                  } catch (fallbackErr) {
                    if (fallbackErr.message && fallbackErr.message.includes('no such column: site_domain')) {
                  result = await env.DB.prepare(
                    `SELECT license_key, status, created_at, customer_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                  ).bind(...allCustomerIds).all();
                } else {
                      throw fallbackErr;
                    }
                  }
                } else {
                  throw columnErr;
                }
              }

              if (result.success) {
                // Get subscription statuses for all subscription IDs
                const subscriptionIds = [...new Set(result.results.map(r => r.subscription_id).filter(Boolean))];
                const subscriptionStatusMap = {};
                
                if (subscriptionIds.length > 0 && env.DB) {
                  try {
                    const placeholders = subscriptionIds.map(() => '?').join(',');
                    const subStatusRes = await env.DB.prepare(
                      `SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end 
                       FROM subscriptions 
                       WHERE subscription_id IN (${placeholders})`
                    ).bind(...subscriptionIds).all();
                    
                    if (subStatusRes && subStatusRes.results) {
                      subStatusRes.results.forEach(sub => {
                        subscriptionStatusMap[sub.subscription_id] = {
                          status: sub.status,
                          cancel_at_period_end: sub.cancel_at_period_end === 1,
                          cancel_at: sub.cancel_at,
                          current_period_end: sub.current_period_end
                        };
                      });
                    } else {
                    }
                  } catch (subErr) {
                    console.error('[Licenses] Error fetching subscription statuses:', subErr);
                  }
                } else {
                }
                
                licenses = result.results.map(row => {
                  const subscriptionInfo = row.subscription_id ? subscriptionStatusMap[row.subscription_id] : null;
                  const isSubscriptionCancelled = subscriptionInfo && (
                    subscriptionInfo.status === 'canceled' || 
                    subscriptionInfo.cancel_at_period_end || 
                    subscriptionInfo.cancel_at !== null
                  );
                  
                  // Debug logging for cancelled subscriptions
                  if (isSubscriptionCancelled) {
                    // Subscription cancellation details available
                  }
                  
                  return {
                    license_key: row.license_key,
                    site_domain: row.site_domain || null,
                    used_site_domain: row.used_site_domain || null, // May not exist in old schema
                    status: row.status || 'active',
                    purchase_type: row.purchase_type || 'site', // May not exist in old schema
                    created_at: row.created_at,
                    customer_id: row.customer_id || customerId,
                    subscription_id: row.subscription_id || null,
                    item_id: row.item_id || null,
                    billing_period: row.billing_period || null, // From licenses table
                    renewal_date: row.renewal_date || subscriptionInfo?.current_period_end || null, // From licenses table or subscription
                    subscription_status: subscriptionInfo?.status || null,
                    subscription_cancelled: isSubscriptionCancelled || false,
                    subscription_cancel_at_period_end: subscriptionInfo?.cancel_at_period_end || false,
                    subscription_current_period_end: subscriptionInfo?.current_period_end || null
                  };
                });
              } else {
                console.warn(`[Licenses] D1 query returned success=false for customer ${customerId}`);
                d1Error = 'D1 query failed';
              }
            } catch (dbErr) {
              console.error(`[Licenses] D1 database error for customer ${customerId}:`, dbErr);
              d1Error = dbErr.message;
              // Continue to try KV fallback
            }
          } else {
            d1Error = 'D1 database not configured';
          }

          // If D1 failed or returned no results, try fetching by email
          if (licenses.length === 0 && email) {
            try {
              // Get user from database by email (all data is now in D1)
              const user = await getUserByEmail(env, email);
              if (user && user.customers) {
                // Get all customer IDs for this user
                const customerIds = user.customers.map(c => c.customerId);
                if (customerIds.length > 0) {
                  // Fetch licenses from database for all customer IDs
                  // Handle case where used_site_domain column might not exist
                  const placeholders = customerIds.map(() => '?').join(',');
                  let licenseRes;
                  try {
                    // Query ALL licenses (not just active) to show complete history
                    licenseRes = await env.DB.prepare(
                      `SELECT license_key, site_domain, used_site_domain, purchase_type, status, created_at, customer_id, subscription_id, item_id, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                    ).bind(...customerIds).all();
                  } catch (colError) {
                    // Fallback if used_site_domain doesn't exist
                    if (colError.message && colError.message.includes('no such column: used_site_domain')) {
                      try {
                        licenseRes = await env.DB.prepare(
                          `SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                        ).bind(...customerIds).all();
                      } catch (colError2) {
                        // Fallback if billing_period or renewal_date don't exist
                        if (colError2.message && (colError2.message.includes('no such column: billing_period') || colError2.message.includes('no such column: renewal_date'))) {
                          licenseRes = await env.DB.prepare(
                            `SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                          ).bind(...customerIds).all();
                        } else {
                          throw colError2;
                        }
                      }
                    } else {
                      throw colError;
                    }
                  }
                  
                  if (licenseRes.success && licenseRes.results) {
                    // Get subscription statuses for fallback licenses too
                    const fallbackSubscriptionIds = [...new Set(licenseRes.results.map(r => r.subscription_id).filter(Boolean))];
                    const fallbackSubscriptionStatusMap = {};
                    
                    if (fallbackSubscriptionIds.length > 0 && env.DB) {
                      try {
                        const placeholders = fallbackSubscriptionIds.map(() => '?').join(',');
                        const fallbackSubStatusRes = await env.DB.prepare(
                          `SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end 
                           FROM subscriptions 
                           WHERE subscription_id IN (${placeholders})`
                        ).bind(...fallbackSubscriptionIds).all();
                        
                        if (fallbackSubStatusRes && fallbackSubStatusRes.results) {
                          fallbackSubStatusRes.results.forEach(sub => {
                            fallbackSubscriptionStatusMap[sub.subscription_id] = {
                              status: sub.status,
                              cancel_at_period_end: sub.cancel_at_period_end === 1,
                              cancel_at: sub.cancel_at,
                              current_period_end: sub.current_period_end
                            };
                          });
                        }
                      } catch (fallbackSubErr) {
                        console.error('[Licenses] Error fetching subscription statuses for fallback licenses:', fallbackSubErr);
                      }
                    }
                    
                    const userLicenses = licenseRes.results.map(l => {
                      const subscriptionInfo = l.subscription_id ? fallbackSubscriptionStatusMap[l.subscription_id] : null;
                      const isSubscriptionCancelled = subscriptionInfo && (
                        subscriptionInfo.status === 'canceled' || 
                        subscriptionInfo.cancel_at_period_end || 
                        subscriptionInfo.cancel_at !== null
                      );
                      
                      return {
                        license_key: l.license_key,
                        site_domain: l.site_domain || null,
                        used_site_domain: l.used_site_domain || null,
                        status: l.status || 'active',
                        purchase_type: l.purchase_type || 'site',
                        created_at: l.created_at,
                        customer_id: l.customer_id || customerIds[0],
                        subscription_id: l.subscription_id || null,
                        item_id: l.item_id || null,
                        billing_period: l.billing_period || null, // From licenses table
                        renewal_date: l.renewal_date || subscriptionInfo?.current_period_end || null, // From licenses table or subscription
                        subscription_status: subscriptionInfo?.status || null,
                        subscription_cancelled: isSubscriptionCancelled || false,
                        subscription_cancel_at_period_end: subscriptionInfo?.cancel_at_period_end || false,
                        subscription_current_period_end: subscriptionInfo?.current_period_end || null
                      };
                    });
                    licenses = [...licenses, ...userLicenses];
                  }
                }
              }
            } catch (emailErr) {
              console.error(`[Licenses] Error fetching licenses by email:`, emailErr);
            }
          }

          // If D1 failed, return error
          if (d1Error && licenses.length === 0) {
            console.error(`[Licenses] D1 failed for email ${email}. D1: ${d1Error}`);
            return jsonResponse(500, { 
              error: 'Failed to fetch licenses',
              details: {
                d1Error: d1Error
              },
              licenses: [] // Return empty array so frontend doesn't break
            });
          }

          // Fetch active subscriptions for the user
          let activeSubscriptions = [];
          if (email && env.DB) {
            try {
              // Get all subscriptions for this email that are active or trialing
              const subsRes = await env.DB.prepare(
                `SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_start, current_period_end, billing_period, created_at
                 FROM subscriptions 
                 WHERE user_email = ? AND (status = 'active' OR status = 'trialing') AND (cancel_at_period_end = 0 OR cancel_at_period_end IS NULL)
                 ORDER BY created_at DESC`
              ).bind(email.toLowerCase().trim()).all();
              
              if (subsRes && subsRes.results) {
                activeSubscriptions = subsRes.results.map(sub => ({
                  subscription_id: sub.subscription_id,
                  status: sub.status,
                  cancel_at_period_end: sub.cancel_at_period_end === 1,
                  cancel_at: sub.cancel_at,
                  current_period_start: sub.current_period_start,
                  current_period_end: sub.current_period_end,
                  billing_period: sub.billing_period || null,
                  created_at: sub.created_at
                }));
              }
            } catch (subsErr) {
              console.error('[Licenses] Error fetching active subscriptions:', subsErr);
            }
          }

          // Debug: Log what we're returning
          if (licenses.length > 0) {
            // Count by purchase_type
            const quantityLicenses = licenses.filter(l => l.purchase_type === 'quantity').length;
            const siteLicenses = licenses.filter(l => l.purchase_type === 'site').length;
          }
          
          // Return licenses and active subscriptions
          return jsonResponse(200, { success: true, licenses, activeSubscriptions }, true, request);
        } catch (error) {
          console.error(`[Licenses] Unexpected error fetching licenses for customer ${customerId}:`, error);
          console.error(`[Licenses] Error stack:`, error.stack);
          return jsonResponse(500, { 
            error: 'Failed to fetch licenses',
            message: error.message,
            licenses: [] // Return empty array so frontend doesn't break
          }, true, request);
        }
      }

      // Create checkout session from pending sites - adds to existing subscription or creates new one
      if (request.method === 'POST' && pathname === '/create-checkout-from-pending') {
        console.log(`[USE CASE 2 - CHECKOUT] 🚀 STEP 2: Starting checkout session creation`);
        const body = await request.json();
        const { email: emailParam, subscriptionId: subscriptionIdParam, billing_period: billingPeriodParam, price_id: priceIdParam } = body;
        console.log(`[USE CASE 2 - CHECKOUT] 📥 Received request: billing_period: ${billingPeriodParam}, price_id: ${priceIdParam}`);
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // Try email parameter first (for Memberstack authentication)
        if (emailParam) {
          email = emailParam.toLowerCase().trim();
        } else {
          // Fallback to session cookie
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
          if (!match) return jsonResponse(401, { error: 'unauthenticated', message: 'No email or session provided' }, true, request);
        const token = match[1];
        const payload = await verifyToken(env, token);
          if (!payload) return jsonResponse(401, { error: 'invalid session' }, true, request);
          email = payload.email;
          customerId = payload.customerId;
        }
        
        if (!email || !email.includes('@')) {
          return jsonResponse(400, { error: 'invalid email', message: 'Valid email is required' }, true, request);
        }

        // Get user by email (email-based structure)
        let userFromEmail = await getUserByEmail(env, email);
        let user = null;
        
        // If email-based structure exists, use it
        if (userFromEmail && userFromEmail.customers && userFromEmail.customers.length > 0) {
          // Get the first customer (or find by customerId if provided)
          const customer = customerId 
            ? userFromEmail.customers.find(c => c.customerId === customerId)
            : userFromEmail.customers[0];
          
          if (!customer) {
            return jsonResponse(400, { error: 'customer not found', message: 'No customer found for this email' }, true, request);
          }
          
          customerId = customer.customerId;
          
          // Get subscription (use provided subscriptionId or first active subscription)
          const subscription = subscriptionId
            ? customer.subscriptions.find(s => s.subscriptionId === subscriptionId)
            : customer.subscriptions.find(s => s.status === 'active') || customer.subscriptions[0];
          
          if (subscription) {
            subscriptionId = subscription.subscriptionId;
          }
          
          // Convert email-based structure to legacy format for compatibility
          user = {
            customerId: customerId,
            email: email,
            sites: {},
            pendingSites: userFromEmail.pendingSites || [],
            subscriptionId: subscriptionId,
            defaultPrice: userFromEmail.defaultPrice || null
          };
          
          // Convert items to sites format
          customer.subscriptions.forEach(sub => {
            if (sub.items) {
              sub.items.forEach(item => {
                if (item.site) {
                  user.sites[item.site] = {
                    item_id: item.item_id,
                    price: item.price,
                    quantity: item.quantity || 1,
                    status: item.status || 'active',
                    created_at: item.created_at,
                    subscription_id: sub.subscriptionId
                  };
                }
              });
            }
          });
        } else {
          // Fallback to legacy customer-based structure
          if (!customerId) {
            // Try to find customer ID from payments table
            if (env.DB) {
              try {
                const paymentResult = await env.DB.prepare(
                  'SELECT customer_id FROM payments WHERE email = ? ORDER BY created_at DESC LIMIT 1'
                ).bind(email).first();
                if (paymentResult && paymentResult.customer_id) {
                  customerId = paymentResult.customer_id;
                }
              } catch (dbError) {
                console.error('[create-checkout-from-pending] Error fetching customer ID from payments:', dbError);
              }
            }
            
            if (!customerId) {
              return jsonResponse(400, { error: 'customer not found', message: 'No customer found for this email. Please complete a payment first.' }, true, request);
            }
          }
          
          // Get user from database by customerId
          user = await getUserByCustomerId(env, customerId);
          if (!user) {
            return jsonResponse(400, { error: 'no user found' }, true, request);
          }
        }

        // Check if there are pending sites
        console.log(`[USE CASE 2 - CHECKOUT] 🔍 STEP 2.1: Checking pending sites (count: ${user.pendingSites?.length || 0})`);
        if (!user.pendingSites || user.pendingSites.length === 0) {
          console.log(`[USE CASE 2 - CHECKOUT] ❌ No pending sites found`);
          return jsonResponse(400, { error: 'no pending sites to checkout', message: 'Please add sites to the pending list first' }, true, request);
        }
        console.log(`[USE CASE 2 - CHECKOUT] ✅ Found ${user.pendingSites.length} pending site(s):`, user.pendingSites.map(ps => ps.site || ps.site_domain));

        // CRITICAL: Check if any pending sites already exist in subscription details
        const existingSitesSet = new Set();
        
        // Check legacy structure (user.sites)
        if (user.sites) {
          Object.keys(user.sites).forEach(site => {
            if (user.sites[site] && user.sites[site].status === 'active') {
              existingSitesSet.add(site.toLowerCase().trim());
            }
          });
        }
        
        // Check email-based structure (subscription items)
        if (userFromEmail && userFromEmail.customers) {
          userFromEmail.customers.forEach(customer => {
            if (customer.subscriptions) {
              customer.subscriptions.forEach(subscription => {
                if (subscription.items) {
                  subscription.items.forEach(item => {
                    if (item.site && item.status === 'active') {
                      existingSitesSet.add(item.site.toLowerCase().trim());
                    }
                  });
                }
              });
            }
          });
        }
        
        // CRITICAL: Check database across ALL users to prevent duplicate sites
        // Check subscription_items, sites, and licenses tables
        const duplicateSites = [];
        if (env.DB) {
          try {
            // Get all pending site names
            const pendingSiteNames = user.pendingSites.map(ps => {
              const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
              return siteName;
            }).filter(s => s);
            
            if (pendingSiteNames.length > 0) {
              // Check each pending site against all database tables (across all users)
              for (const pendingSite of pendingSiteNames) {
                let isDuplicate = false;
                
                // Check if site exists in subscription_items (across all users)
                const existingInItems = await env.DB.prepare(
                  'SELECT site_domain FROM subscription_items WHERE LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
                ).bind(pendingSite, 'active').first();
                
                if (existingInItems) {
                  isDuplicate = true;
                }
                
                // Check if site exists in sites table (across all users)
                if (!isDuplicate) {
                  const existingInSites = await env.DB.prepare(
                    'SELECT site_domain FROM sites WHERE LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
                  ).bind(pendingSite, 'active').first();
                  
                  if (existingInSites) {
                    isDuplicate = true;
                  }
                }
                
                // Check if site exists in licenses table - both site_domain and used_site_domain (across all users)
                if (!isDuplicate) {
                  const existingInLicenses = await env.DB.prepare(
                    'SELECT site_domain, used_site_domain FROM licenses WHERE (LOWER(TRIM(site_domain)) = ? OR LOWER(TRIM(used_site_domain)) = ?) AND (site_domain IS NOT NULL AND site_domain != "" OR used_site_domain IS NOT NULL AND used_site_domain != "") LIMIT 1'
                  ).bind(pendingSite, pendingSite).first();
                  
                  if (existingInLicenses) {
                    isDuplicate = true;
                  }
                }
                
                // Also check against existingSitesSet (from user's own subscriptions)
                if (!isDuplicate && existingSitesSet.has(pendingSite)) {
                  isDuplicate = true;
                }
                
                if (isDuplicate) {
                  duplicateSites.push(pendingSite);
                }
              }
            }
          } catch (dbError) {
            console.warn('[create-checkout-from-pending] Error checking database for existing sites:', dbError);
          }
        } else {
          // Fallback: check against existingSitesSet if database not available
          user.pendingSites.forEach(ps => {
            const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
            if (siteName && existingSitesSet.has(siteName)) {
              duplicateSites.push(siteName);
            }
          });
        }
        
        // If any duplicates found, return error
        if (duplicateSites.length > 0) {
          const duplicateList = duplicateSites.join(', ');
          return jsonResponse(400, { 
            error: 'duplicate_sites', 
            message: `The following site(s) already exist and cannot be added (may be in use by another user): ${duplicateList}. Please remove them from the pending list.`,
            duplicateSites: duplicateSites
          }, true, request);
        }

        // Email and customerId are already set above from authentication
        if (!email) {
          return jsonResponse(400, { error: 'email required' }, true, request);
        }

        // Create or find customer if not already set
        if (!customerId || !customerId.startsWith('cus_')) {
          customerId = user.customerId;
        }
        if (!customerId || !customerId.startsWith('cus_')) {
          const cust = await stripeFetch(env, '/customers', 'POST', { email: email }, true);
          if (cust.status >= 400) {
            return jsonResponse(500, { error: 'failed to create customer', details: cust.body }, true, request);
          }
          customerId = cust.body.id;
          user.customerId = customerId;
          
          // Update email-based structure if it exists
          if (userFromEmail && userFromEmail.customers && userFromEmail.customers.length > 0) {
            const customer = userFromEmail.customers.find(c => c.customerId === customerId) || userFromEmail.customers[0];
            if (customer) {
              customer.customerId = customerId;
              await saveUserByEmail(env, email, userFromEmail);
            }
          }
        }

        // After payment, redirect directly to dashboard
        // Users will be automatically logged in via Memberstack session
        const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://memberstack-login-test-713fa5.webflow.io/dashboard';
        const successUrl = `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`;
        const cancelUrl = dashboardUrl;

        // CRITICAL: Deduplicate pending sites FIRST
        const uniquePendingSites = [];
        const seenSites = new Set();
        for (const ps of user.pendingSites) {
          const siteKey = (ps.site || ps.site_domain || '').toLowerCase().trim();
          if (siteKey && !seenSites.has(siteKey)) {
            seenSites.add(siteKey);
            uniquePendingSites.push(ps);
          }
        }
        
        if (user.pendingSites.length !== uniquePendingSites.length) {
          console.warn(`⚠️ Deduplicated ${user.pendingSites.length} pending sites to ${uniquePendingSites.length} unique sites`);
        }
          
          // Validate we have at least one site to process
          if (uniquePendingSites.length === 0) {
            return jsonResponse(400, { 
              error: 'no_pending_sites', 
              message: 'No valid pending sites found to process. Please add sites before checkout.' 
            }, true, request);
          }
          
        // USE CASE 2: Create separate subscription for each site (like Use Case 3 for licenses)
        // Use payment mode and handle subscription creation in webhook
        console.log(`[USE CASE 2 - CHECKOUT] 🔍 STEP 2.2: Preparing checkout session for ${uniquePendingSites.length} site(s)`);
        const form = {
          'customer': customerId,
          'success_url': successUrl,
          'cancel_url': cancelUrl,
          'mode': 'payment', // Payment mode like Use Case 3
        };

        // Get price ID from billing_period parameter (required - no fallbacks)
        if (!billingPeriodParam) {
          console.log(`[USE CASE 2 - CHECKOUT] ❌ Missing billing_period parameter`);
          return jsonResponse(400, { 
            error: 'missing_billing_period', 
            message: 'billing_period parameter is required (monthly or yearly).' 
          }, true, request);
        }
        
        console.log(`[USE CASE 2 - CHECKOUT] 🔍 Getting price ID for billing period: ${billingPeriodParam}`);
        const priceId = await getPriceIdByBillingPeriod(env, billingPeriodParam);
        console.log(`[USE CASE 2 - CHECKOUT] ✅ Price ID: ${priceId}`);
        
        if (!priceId) {
          return jsonResponse(400, { 
            error: 'price_not_configured', 
            message: `Price ID not configured for ${billingPeriodParam} billing period. Please configure it in the database or environment variables.` 
          }, true, request);
        }

        // Get price details to calculate total amount
        const priceRes = await stripeFetch(env, `/prices/${priceId}`);
        if (priceRes.status !== 200) {
          return jsonResponse(400, { 
                error: 'invalid_price', 
            message: 'Invalid price ID. Please add sites again with valid price IDs.' 
              }, true, request);
        }

                    const price = priceRes.body;
        const unitAmount = price.unit_amount || 0;
        const totalAmount = unitAmount * uniquePendingSites.length;

        // Create single line item with total amount (like Use Case 3)
        // Use the product_id from the price to ensure all site purchases use the same product
        form['line_items[0][price_data][currency]'] = price.currency || 'usd';
        form['line_items[0][price_data][unit_amount]'] = totalAmount;
        
        // Use product_id from price if available, otherwise create product_data
        if (price.product) {
          form['line_items[0][price_data][product]'] = price.product;
        } else {
          form['line_items[0][price_data][product_data][name]'] = `Subscription for ${uniquePendingSites.length} site(s)`;
        }
        
        form['line_items[0][quantity]'] = 1;
                
        // Store site names and metadata in payment_intent_data (like Use Case 3 stores license keys)
        const siteNames = uniquePendingSites.map(ps => ps.site || ps.site_domain);
        console.log(`[USE CASE 2 - CHECKOUT] 📝 Storing metadata: ${siteNames.length} site(s):`, siteNames);
        form['payment_intent_data[metadata][usecase]'] = '2'; // Use Case 2 identifier
        form['payment_intent_data[metadata][purchase_type]'] = 'site'; // Distinguish from Use Case 3
        form['payment_intent_data[metadata][customer_id]'] = customerId;
        form['payment_intent_data[metadata][price_id]'] = priceId;
        form['payment_intent_data[metadata][quantity]'] = uniquePendingSites.length.toString();
        form['payment_intent_data[metadata][sites]'] = JSON.stringify(siteNames); // Store sites as JSON array

        // Create checkout session
        console.log(`[USE CASE 2 - CHECKOUT] 💳 STEP 2.3: Creating Stripe checkout session...`);
        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
        
        if (session.status >= 400) {
          console.error(`[USE CASE 2 - CHECKOUT] ❌ Stripe checkout session creation failed (${session.status}):`, session.body);
          return jsonResponse(500, { 
            error: 'stripe_checkout_failed', 
            message: 'Failed to create checkout session with Stripe. Please try again.',
            details: session.body?.error?.message || 'Unknown error'
          }, true, request);
        }
        
        // Validate session was created successfully
        if (!session.body || !session.body.id || !session.body.url) {
          console.error(`[USE CASE 2 - CHECKOUT] ❌ Invalid checkout session response from Stripe`);
          return jsonResponse(500, { 
            error: 'invalid_checkout_session', 
            message: 'Stripe returned an invalid checkout session. Please try again.',
            details: session.body
          }, true, request);
        }

        console.log(`[USE CASE 2 - CHECKOUT] ✅ STEP 2 COMPLETE: Checkout session created - ${session.body.id}`);
        console.log(`[USE CASE 2 - CHECKOUT] 🔗 Checkout URL: ${session.body.url}`);
        return jsonResponse(200, {
          sessionId: session.body.id,
          url: session.body.url
        }, true, request);
      }

      // Remove a pending site (before payment)
      // Remove pending site endpoint
      if (request.method === 'POST' && pathname === '/remove-pending-site') {
        // Support both session cookie and email-based authentication
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        
        let email = null;
        let customerId = null;
        
        // Try email from request body (for Memberstack users)
        const body = await request.json();
        if (body.email) {
          email = body.email.toLowerCase().trim();
        } else if (match) {
          // Use session cookie authentication
        const token = match[1];
        const payload = await verifyToken(env, token);
          if (!payload) {
            return jsonResponse(401, { error: 'invalid session' }, true, request);
          }
          email = payload.email;
          customerId = payload.customerId;
        } else {
          return jsonResponse(401, { error: 'unauthenticated' }, true, request);
        }

        const { site, subscriptionId } = body;
        if (!site) return jsonResponse(400, { error: 'missing site' }, true, request);

        // Get user record - try email-based structure first
        let userFromEmail = await getUserByEmail(env, email);
        
        if (userFromEmail) {
          // Update email-based structure
          if (!userFromEmail.pendingSites || userFromEmail.pendingSites.length === 0) {
            return jsonResponse(400, { error: 'no pending sites' }, true, request);
          }

          const beforeCount = userFromEmail.pendingSites.length;
          // Remove the site from pending list (case-insensitive, trimmed)
          userFromEmail.pendingSites = userFromEmail.pendingSites.filter(p => {
            const pendingSite = (p.site || p).toLowerCase().trim();
            const targetSite = site.toLowerCase().trim();
            return pendingSite !== targetSite;
          });
          
          const afterCount = userFromEmail.pendingSites.length;
          
          if (beforeCount === afterCount) {
            return jsonResponse(400, { error: 'site not in pending list' }, true, request);
          }
          
          // Remove from database pending_sites table FIRST (source of truth)
          if (env.DB) {
            try {
              const result = await env.DB.prepare(
                'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
              ).bind(email.toLowerCase().trim(), site.toLowerCase().trim()).run();
              
              // Verify deletion worked
              const verifyResult = await env.DB.prepare(
                'SELECT COUNT(*) as count FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
              ).bind(email.toLowerCase().trim(), site.toLowerCase().trim()).first();
              
              if (verifyResult && verifyResult.count > 0) {
                console.warn(`[remove-pending-site] ⚠️ Site still exists in database after deletion attempt. Count: ${verifyResult.count}`);
              } else {
              }
            } catch (dbError) {
              console.error('[remove-pending-site] Failed to remove pending site from database:', dbError);
              // Don't continue - fail the operation if database deletion fails
              return jsonResponse(500, { 
                error: 'failed to remove from database', 
                message: 'Could not remove pending site from database. Please try again.' 
              }, true, request);
            }
          }
          
          // Now save the updated user object (which will sync pending sites from user object to database)
          // Since we already deleted from database, this will just ensure consistency
          await saveUserByEmail(env, email, userFromEmail);
          
          // Pending sites are already updated in database (pending_sites table)
          // No need for separate KV update - all data is in D1

        return jsonResponse(200, { 
          success: true,
          site: site,
            message: 'Site removed from pending list',
            remaining: afterCount
          }, true, request);
        }
        if (!user.pendingSites || user.pendingSites.length === 0) {
          return jsonResponse(400, { error: 'no pending sites' }, true, request);
        }

        const beforeCount = user.pendingSites.length;
        // Remove the site from pending list (case-insensitive, trimmed)
        user.pendingSites = user.pendingSites.filter(p => {
          const pendingSite = (p.site || p).toLowerCase().trim();
          const targetSite = site.toLowerCase().trim();
          return pendingSite !== targetSite;
        });
        
        const afterCount = user.pendingSites.length;
        
        if (beforeCount === afterCount) {
          return jsonResponse(400, { error: 'site not in pending list' }, true, request);
        }
        
        // Remove from database pending_sites table
        if (env.DB) {
          try {
            const result = await env.DB.prepare(
              'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
            ).bind(email.toLowerCase().trim(), site.toLowerCase().trim()).run();
          } catch (dbError) {
            console.error('[remove-pending-site] Failed to remove pending site from database:', dbError);
            // Continue anyway - we'll update the user object
          }
        }
        
        await saveUserByEmail(env, email, user);


        return jsonResponse(200, { 
          success: true,
          site: site,
          message: 'Site removed from pending list',
          remaining: afterCount
        }, true, request);
      }

      // Remove a site (delete subscription item from subscription)
      // Uses transaction-like pattern with rollback for consistency
      if (request.method === 'POST' && pathname === '/remove-site') {
        
        // Support both session cookie and email-based authentication
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        
        let email = null;
        let customerId = null;
        
        // Try email from request body (for Memberstack users)
        const body = await request.json();
        
        if (body.email) {
          email = body.email.toLowerCase().trim();
        } else if (match) {
          // Use session cookie authentication
        const token = match[1];
        const payload = await verifyToken(env, token);
          if (!payload) {
            console.error(`[REMOVE-SITE] ❌ Invalid session token`);
            return jsonResponse(401, { error: 'invalid session' }, true, request);
          }
          email = payload.email;
          customerId = payload.customerId;
        } else {
          console.error(`[REMOVE-SITE] ❌ No authentication found`);
          return jsonResponse(401, { error: 'unauthenticated' }, true, request);
        }

        const { site, subscription_id } = body;
        console.log (`[REMOVE-SITE] 🔍 Received request to remove site: ${site} for email: ${email} for subscriptionid ${subscription_id}`);

        if (!site) {
          console.error(`[REMOVE-SITE] ❌ Missing site parameter`);
          return jsonResponse(400, { error: 'missing site parameter' }, true, request);
        }

        // Get user email if not already set
        if (!email && customerId) {
          email = await getCustomerEmail(env, customerId);
        }
        
        if (!email) {
          console.error(`[REMOVE-SITE] ❌ Email not found`);
          return jsonResponse(400, { error: 'email not found' }, true, request);
        }

        // Verify Memberstack session (if Memberstack is configured)
        
        if (env.MEMBERSTACK_SECRET_KEY) {
          try {
            const normalizedRequestEmail = email.toLowerCase().trim();
            
            const memberstackMember = await this.getMemberstackMember(email, env);
            
            if (!memberstackMember) {
              console.error(`[REMOVE-SITE] ❌ Memberstack member not found for email: ${email}`);
              return jsonResponse(401, { 
                error: 'memberstack_authentication_failed',
                message: 'User is not authenticated with Memberstack. Please log in to continue.'
              }, true, request);
            }
            
            // Extract member email from various possible locations (check auth.email first for Memberstack API structure)
            const memberEmail = memberstackMember.auth?.email ||
                               memberstackMember.email || 
                               memberstackMember._email || 
                               memberstackMember.data?.email || 
                               memberstackMember.data?._email ||
                               memberstackMember.data?.auth?.email ||
                               'N/A';
            
            const memberId = memberstackMember.id || 
                           memberstackMember._id || 
                           memberstackMember.data?.id ||
                           memberstackMember.data?._id ||
                           'N/A';
            
            
            // Log session/login information from API response
            const lastLogin = memberstackMember.lastLogin || memberstackMember.data?.lastLogin || 'N/A';
            const verified = memberstackMember.verified !== undefined ? memberstackMember.verified : (memberstackMember.data?.verified !== undefined ? memberstackMember.data.verified : 'N/A');
            const loginRedirect = memberstackMember.loginRedirect || memberstackMember.data?.loginRedirect || 'N/A';
            
            
            // CRITICAL: Verify email matches exactly (case-insensitive comparison)
            const normalizedMemberEmail = memberEmail.toLowerCase().trim();
            
            if (memberEmail === 'N/A') {
              console.error(`[REMOVE-SITE] ❌ Memberstack member has no email address`);
              return jsonResponse(401, { 
                error: 'memberstack_email_missing',
                message: 'Memberstack account has no email address. Please contact support.'
              }, true, request);
            }
            
            if (normalizedMemberEmail !== normalizedRequestEmail) {
              console.error(`[REMOVE-SITE] ❌ Email mismatch detected:`);
              console.error(`[REMOVE-SITE]   Request email (normalized): "${normalizedRequestEmail}"`);
              console.error(`[REMOVE-SITE]   Memberstack email (normalized): "${normalizedMemberEmail}"`);
              console.error(`[REMOVE-SITE]   Original request email: "${email}"`);
              console.error(`[REMOVE-SITE]   Original member email: "${memberEmail}"`);
              return jsonResponse(401, { 
                error: 'email_mismatch',
                message: `Email does not match Memberstack account. Requested: "${email}", Memberstack: "${memberEmail}"`
              }, true, request);
            }
            
            // Verify member is active/accessible
            // If getMemberstackMember returns a member, it means they exist and are accessible
            // Check for explicit inactive/deleted indicators if they exist
            const isDeleted = memberstackMember.deleted === true || 
                             memberstackMember.data?.deleted === true ||
                             memberstackMember.isDeleted === true;
            
            const isActive = memberstackMember.active !== false && 
                           memberstackMember.data?.active !== false &&
                           !isDeleted;
            
            if (isDeleted) {
              console.error(`[REMOVE-SITE] ❌ Memberstack member is deleted: ID=${memberId}`);
              return jsonResponse(401, { 
                error: 'memberstack_account_deleted',
                message: 'Your Memberstack account has been deleted. Please contact support.'
              }, true, request);
            }
            
            if (!isActive) {
              console.error(`[REMOVE-SITE] ❌ Memberstack member is inactive: ID=${memberId}`);
              return jsonResponse(401, { 
                error: 'memberstack_account_inactive',
                message: 'Your Memberstack account is inactive. Please contact support.'
              }, true, request);
            }
            
            
          } catch (memberstackError) {
            console.error(`[REMOVE-SITE] ❌ Error verifying Memberstack member:`, memberstackError);
            console.error(`[REMOVE-SITE] Error details:`, memberstackError.message);
            console.error(`[REMOVE-SITE] Error stack:`, memberstackError.stack);
            return jsonResponse(401, { 
              error: 'memberstack_verification_failed',
              message: 'Failed to verify Memberstack session. Please log in again.'
            }, true, request);
          }
        } else {
        }

        // Generate idempotency key
        const operationId = `remove_site_${email}_${site}_${Date.now()}`;
        const idempotencyKey = `idempotency:${operationId}`;
        
        // Check if operation already completed (idempotency) - use database
        if (env.DB) {
          const existingOp = await env.DB.prepare(
            'SELECT operation_data FROM idempotency_keys WHERE operation_id = ? LIMIT 1'
          ).bind(operationId).first();
          if (existingOp && existingOp.operation_data) {
            const result = JSON.parse(existingOp.operation_data);
            return jsonResponse(200, { success: true, idempotent: true, ...result }, true, request);
          }
        }

        // Fetch user record from database
        let user = await getUserByEmail(env, email);
        if (!user) {
          console.error(`[REMOVE-SITE] ❌ User not found in database: ${email}`);
          return jsonResponse(400, { error: 'user not found' }, true, request);
        }

        // Find the site and get its item_id from database
        let itemId = null;
        let subscriptionId = subscription_id || null; // Use subscription_id from frontend if provided
        
        if (subscriptionId) {
          // If subscription_id is provided, find the item_id for this site in this subscription
          if (env.DB) {
            try {
              const siteRecord = await env.DB.prepare(
                'SELECT item_id FROM sites WHERE subscription_id = ? AND LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
              ).bind(subscriptionId, site.toLowerCase().trim(), 'active').first();
              
              if (siteRecord && siteRecord.item_id) {
                itemId = siteRecord.item_id;
              } else {
                // Try subscription_items table
                const itemRecord = await env.DB.prepare(
                  'SELECT item_id FROM subscription_items WHERE subscription_id = ? AND LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
                ).bind(subscriptionId, site.toLowerCase().trim(), 'active').first();
                
                if (itemRecord && itemRecord.item_id) {
                  itemId = itemRecord.item_id;
                }
              }
            } catch (directSubError) {
              console.error(`[REMOVE-SITE] ⚠️ Error finding item with subscription_id:`, directSubError);
            }
          }
        }
        
        // If not found with subscription_id, fall back to searching all customers
        // First, try to find in database (most reliable source of truth)
        if (!itemId && env.DB) {
          try {
            // Get customer IDs for this email first
            // Note: customers table uses user_email, not user_id
            const customerIdsRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
            ).bind(email).all();
            
            
            if (customerIdsRes && customerIdsRes.results && customerIdsRes.results.length > 0) {
              const customerIds = customerIdsRes.results.map(r => r.customer_id);
              
              // Search for site in sites table using customer IDs
              for (const cid of customerIds) {
                const siteRecord = await env.DB.prepare(
                  'SELECT item_id, subscription_id FROM sites WHERE customer_id = ? AND LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
                ).bind(cid, site.toLowerCase().trim(), 'active').first();
                
                if (siteRecord && siteRecord.item_id) {
                  itemId = siteRecord.item_id;
                  subscriptionId = siteRecord.subscription_id;
                  break;
                }
              }
            }
          } catch (dbError) {
            console.error(`[REMOVE-SITE] ❌ Error querying sites table:`, dbError);
            // Continue to fallback methods
          }
        }
        
        // Fallback: Search through all customers and subscriptions to find the site
        if (!itemId && user.customers) {
          for (const customer of user.customers) {
            if (customer.subscriptions) {
              for (const subscription of customer.subscriptions) {
                if (subscription.items) {
                  // Try exact match first
                  let item = subscription.items.find(i => 
                    (i.site || '').toLowerCase().trim() === site.toLowerCase().trim()
                  );
                  
                  // If not found, try case-insensitive match
                  if (!item) {
                    item = subscription.items.find(i => {
                      const itemSite = (i.site || '').toLowerCase().trim();
                      const targetSite = site.toLowerCase().trim();
                      return itemSite === targetSite;
                    });
                  }
                  
                  if (item && item.item_id) {
                    itemId = item.item_id;
                    subscriptionId = subscription.subscriptionId;
                    break;
                  }
                }
              }
              if (itemId) break;
            }
          }
        }
        
        // Fallback: check legacy sites structure
        if (!itemId && user.sites) {
          // Try exact match
          if (user.sites[site] && user.sites[site].item_id) {
        const siteData = user.sites[site];
            itemId = siteData.item_id;
            subscriptionId = siteData.subscription_id;
          } else {
            // Try case-insensitive match
            const siteKey = Object.keys(user.sites).find(key => 
              key.toLowerCase().trim() === site.toLowerCase().trim()
            );
            if (siteKey && user.sites[siteKey] && user.sites[siteKey].item_id) {
              const siteData = user.sites[siteKey];
              itemId = siteData.item_id;
              subscriptionId = siteData.subscription_id;
            }
          }
        }
        
        // Final fallback: check subscription_items table directly
        if (!itemId && env.DB) {
          try {
            // Get all customer IDs for this email
            // Note: customers table uses user_email, not user_id
            const customerIdsRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM customers WHERE user_email = ?'
            ).bind(email).all();
            
            if (customerIdsRes && customerIdsRes.results) {
              const customerIds = customerIdsRes.results.map(r => r.customer_id);
              
              // Search in subscription_items table
              for (const cid of customerIds) {
                const itemRecord = await env.DB.prepare(
                  'SELECT si.item_id, si.subscription_id FROM subscription_items si WHERE si.subscription_id IN (SELECT subscription_id FROM subscriptions WHERE customer_id = ?) AND LOWER(TRIM(si.site_domain)) = ? AND si.status = ? LIMIT 1'
                ).bind(cid, site.toLowerCase().trim(), 'active').first();
                
                if (itemRecord && itemRecord.item_id) {
                  itemId = itemRecord.item_id;
                  subscriptionId = itemRecord.subscription_id;
                  break;
                }
              }
            }
          } catch (dbError) {
            console.error(`[REMOVE-SITE] ❌ Error querying subscription_items table:`, dbError);
          }
        }

        if (!itemId || !subscriptionId) {
          console.error(`[REMOVE-SITE] ❌ Site not found: ${site}, email: ${email}`);
          console.error(`[REMOVE-SITE] User customers count: ${user.customers?.length || 0}`);
          console.error(`[REMOVE-SITE] User sites keys: ${user.sites ? Object.keys(user.sites).join(', ') : 'none'}`);
          return jsonResponse(400, { 
            error: 'site has no associated subscription item',
            message: `Could not find subscription item for site "${site}". The site may not exist or may have already been removed.`
          }, true, request);
        }
        

        // Check if this is a quantity purchase with individual subscription (Use Case 3)
        // For Use Case 3, each license has its own subscription, so canceling = canceling entire subscription (no proration)
        let isIndividualSubscription = false;
        let purchaseType = 'site'; // Default
        if (env.DB && subscriptionId) {
          try {
            // Check license table for purchase_type
            const licenseCheck = await env.DB.prepare(
              'SELECT purchase_type FROM licenses WHERE subscription_id = ? LIMIT 1'
            ).bind(subscriptionId).first();
            
            if (licenseCheck && licenseCheck.purchase_type === 'quantity') {
              purchaseType = 'quantity';
              // Check if this subscription has only one item (individual subscription)
              try {
                const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
                if (subRes.status === 200) {
                  const sub = subRes.body;
                  const subMetadata = sub.metadata || {};
                  // Use Case 3 creates individual subscriptions (one per license)
                  if (subMetadata.purchase_type === 'quantity' && subMetadata.usecase === '3') {
                    isIndividualSubscription = true;
                  }
                }
              } catch (subErr) {
                console.warn(`[REMOVE-SITE] ⚠️ Could not check subscription metadata:`, subErr.message);
              }
            }
          } catch (licenseErr) {
            console.warn(`[REMOVE-SITE] ⚠️ Could not check license purchase_type:`, licenseErr.message);
          }
        }
        

        // Store original state for rollback
        const originalUserState = JSON.parse(JSON.stringify(user));
        let originalStripeItem = null;

        try {
          
          // Step 1: Fetch Stripe item data for potential rollback
          const getItemRes = await stripeFetch(env, `/subscription_items/${itemId}`);
          
          if (getItemRes.status === 200) {
            originalStripeItem = getItemRes.body;
          } else {
            console.error(`[REMOVE-SITE] ⚠️ Failed to fetch Stripe item: ${getItemRes.status}`, getItemRes.body);
          }

          
          // Step 2: Update database first (optimistic update for better UX)
          // If this fails, we haven't touched Stripe yet, so no rollback needed
          const removedAt = Math.floor(Date.now() / 1000);
          
          // Get subscription details to preserve renewal_date (current_period_end)
          let subscriptionPeriodEnd = null;
          if (env.DB && subscriptionId) {
            try {
              const subDetails = await env.DB.prepare(
                'SELECT current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(subscriptionId).first();
              if (subDetails && subDetails.current_period_end) {
                subscriptionPeriodEnd = subDetails.current_period_end;
              }
            } catch (subErr) {
            }
          }
          
          // If subscription period end not found in DB, try to get from existing site record
          if (!subscriptionPeriodEnd && env.DB) {
            try {
              const existingSite = await env.DB.prepare(
                'SELECT renewal_date, current_period_end FROM sites WHERE item_id = ? LIMIT 1'
              ).bind(itemId).first();
              if (existingSite) {
                subscriptionPeriodEnd = existingSite.renewal_date || existingSite.current_period_end;
              }
            } catch (siteErr) {
            }
          }
          
          // Update site status in database - mark ALL items and sites for this subscription as inactive
          // (since unsubscribe = cancel subscription, all sites in the subscription are affected)
          if (env.DB && subscriptionId) {
            const subItemsUpdate = await env.DB.prepare(
              'UPDATE subscription_items SET status = ?, removed_at = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
            ).bind('inactive', removedAt, removedAt, subscriptionId, 'active').run();
            
            const sitesUpdate = await env.DB.prepare(
              'UPDATE sites SET status = ?, canceled_at = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
            ).bind('inactive', removedAt, removedAt, subscriptionId, 'active').run();
            
          } else {
            console.error(`[REMOVE-SITE] ⚠️ env.DB or subscriptionId missing - skipping database updates`);
          }
          
          // Update user object - mark ALL items for this subscription as inactive
          for (const customer of user.customers) {
            for (const subscription of customer.subscriptions) {
              if (subscription.subscriptionId === subscriptionId) {
                // Mark all items in this subscription as inactive
                if (subscription.items) {
                  subscription.items.forEach(item => {
                    if (item.status === 'active') {
                      item.status = 'inactive';
                      item.removed_at = removedAt;
                    }
                  });
                }
                // Also update subscription status
                subscription.status = 'canceled';
              }
            }
          }
          
          // Legacy: Update sites structure - mark all sites for this subscription
          if (user.sites) {
            Object.keys(user.sites).forEach(siteKey => {
              const siteData = user.sites[siteKey];
              if (siteData.subscription_id === subscriptionId && siteData.status === 'active') {
                siteData.status = 'inactive';
                siteData.removed_at = removedAt;
              }
            });
          }
          
          // Retry database update with exponential backoff
          let dbSuccess = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await saveUserByEmail(env, email, user);
              dbSuccess = true;
              break;
            } catch (dbError) {
              console.error(`[REMOVE-SITE] ❌ Database save attempt ${attempt + 1} failed:`, dbError.message);
              if (attempt === 2) throw dbError;
              const delay = 1000 * Math.pow(2, attempt);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }

          if (!dbSuccess) {
            throw new Error('Failed to update database after 3 retries');
          }

          
          // Step 3: Cancel the subscription (unsubscribe means cancel subscription)
          // This will cancel the entire subscription, affecting all sites in it
          
          // Get current subscription status from database before cancellation
          let subscriptionBeforeCancel = null;
          if (env.DB && subscriptionId) {
            try {
              const subBefore = await env.DB.prepare(
                'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end, current_period_start FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(subscriptionId).first();
              if (subBefore) {
                subscriptionBeforeCancel = subBefore;
              }
            } catch (subBeforeErr) {
              console.warn(`[REMOVE-SITE] ⚠️ Could not fetch subscription status before cancel:`, subBeforeErr.message);
            }
          }
          
          
          // Cancel the subscription at period end (preserves access until period ends)
          // This is better UX than immediate cancellation - user keeps access until billing period ends
          // IMPORTANT: Pass true as 4th parameter to send as form-urlencoded (Stripe requires this)
          const cancelStartTime = Date.now();
          const cancelRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`, 'POST', {
            cancel_at_period_end: true
          }, true);
          const cancelEndTime = Date.now();
          const cancelDuration = cancelEndTime - cancelStartTime;
          
          // Extract key fields from response for debugging
          if (cancelRes.body && cancelRes.status === 200) {
            const sub = cancelRes.body;
          }
          
          if (cancelRes.status >= 400) {
            // Rollback database update
            console.error(`[REMOVE-SITE] ❌ Stripe cancellation failed (status ${cancelRes.status}), rolling back database update`);
            console.error(`[REMOVE-SITE] Stripe error details:`, cancelRes.body);
            await saveUserByEmail(env, email, originalUserState);
            console.error(`[REMOVE-SITE] ✅ Database rollback completed`);
            return jsonResponse(500, { 
              error: 'failed to cancel subscription', 
              details: cancelRes.body,
              rolledBack: true
            }, true, request);
          }
          
          // Update subscription status in database
          if (env.DB) {
            try {
              const timestamp = Math.floor(Date.now() / 1000);
              // Get current_period_end from Stripe response to ensure accurate cancellation date
              const currentPeriodEnd = cancelRes.body?.current_period_end || null;
              const cancelAt = cancelRes.body?.cancel_at || cancelRes.body?.canceled_at || timestamp;
              
              const subUpdate = await env.DB.prepare(
                'UPDATE subscriptions SET cancel_at_period_end = ?, status = ?, cancel_at = ?, current_period_end = ?, updated_at = ? WHERE subscription_id = ?'
              ).bind(1, 'canceled', cancelAt, currentPeriodEnd, timestamp, subscriptionId).run();
              
              
              // Verify the update by reading back the subscription
              if (subUpdate.success) {
                try {
                  const verifySub = await env.DB.prepare(
                    'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
                  ).bind(subscriptionId).first();
                  if (verifySub) {
                    // Subscription verified
                  }
                } catch (verifyErr) {
                  console.warn(`[REMOVE-SITE] ⚠️ Could not verify subscription update:`, verifyErr.message);
                }
              }
              
              // Also mark all subscription items for this subscription as inactive
              const itemsUpdate = await env.DB.prepare(
                'UPDATE subscription_items SET status = ?, removed_at = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
              ).bind('inactive', removedAt, removedAt, subscriptionId, 'active').run();
              
              // Mark all sites for this subscription as inactive
              const sitesUpdate = await env.DB.prepare(
                'UPDATE sites SET status = ?, canceled_at = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
              ).bind('inactive', removedAt, removedAt, subscriptionId, 'active').run();
              
            } catch (subUpdateError) {
              console.error(`[REMOVE-SITE] ⚠️ Failed to update subscription status (non-critical):`, subUpdateError);
            }
          }
          

          
          // Step 4: Update D1 (mark license inactive if exists)
          // Get customer ID from user object or subscription
          let customerIdForLicense = null;
          if (user.customers && user.customers.length > 0) {
            // Find customer that has this subscription
            for (const customer of user.customers) {
              if (customer.subscriptions && customer.subscriptions.some(s => s.subscriptionId === subscriptionId)) {
                customerIdForLicense = customer.customerId;
                break;
              }
            }
            // Fallback to first customer if not found
            if (!customerIdForLicense && user.customers[0]) {
              customerIdForLicense = user.customers[0].customerId;
            }
          }
          
          
          if (env.DB && customerIdForLicense) {
            try {
              const timestamp = Math.floor(Date.now() / 1000);
              // CRITICAL: Mark ALL licenses for this subscription as inactive (not just for the specific site)
              // This ensures all licenses associated with the cancelled subscription are deactivated
              
              // First, update licenses for the specific site
              const licenseUpdateSite = await env.DB.prepare(
                'UPDATE licenses SET status = ?, updated_at = ? WHERE customer_id = ? AND site_domain = ? AND status = ?'
              ).bind('inactive', timestamp, customerIdForLicense, site, 'active').run();
              
              // Also update ALL licenses for this subscription (in case there are multiple sites)
              const licenseUpdateSub = await env.DB.prepare(
                'UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
              ).bind('inactive', timestamp, subscriptionId, 'active').run();
            } catch (dbError) {
              // Don't fail the operation if D1 update fails - log for background sync
              console.error(`[REMOVE-SITE] ⚠️ License status update failed (non-critical):`, dbError);
              // Log for manual review (no KV needed - all data is in D1)
              console.error(`[REMOVE-SITE] License status update failed - manual intervention may be needed`, {
                operation: 'update_license_status',
                customerId: customerIdForLicense,
                site,
                status: 'inactive',
                timestamp: Date.now()
              });
            }
          } else if (!customerIdForLicense) {
            console.warn(`[REMOVE-SITE] ⚠️ Could not find customer ID for license update, skipping`);
          } else {
            console.warn(`[REMOVE-SITE] ⚠️ env.DB not configured, skipping license update`);
          }

          
          // Mark operation as completed (idempotency) - store in database
          if (env.DB) {
            try {
              const resultData = {
            operationId,
            success: true,
                site: site,
                itemId: itemId,
            completedAt: Date.now()
              };
              await env.DB.prepare(
                'INSERT OR REPLACE INTO idempotency_keys (operation_id, operation_data, created_at) VALUES (?, ?, ?)'
              ).bind(operationId, JSON.stringify(resultData), Math.floor(Date.now() / 1000)).run();
            } catch (idempotencyError) {
              console.error(`[REMOVE-SITE] ⚠️ Failed to save idempotency key (non-critical):`, idempotencyError);
              // Don't fail the operation if idempotency save fails
            }
          }


          // Build appropriate message based on subscription type
          let cancelMessage = '';
          if (isIndividualSubscription) {
            cancelMessage = 'Subscription canceled successfully. This license has its own individual subscription (Use Case 3), so canceling it will cancel the entire subscription. NO PRORATION applies since each license has its own subscription. The subscription will remain active until the end of the current billing period.';
          } else {
            cancelMessage = 'Subscription canceled successfully. The subscription has been canceled and will remain active until the end of the current billing period. All sites in this subscription have been marked as inactive. Stripe will prorate the current period and future invoices will be reduced.';
          }

          return jsonResponse(200, { 
            success: true, 
            site: site,
            subscriptionId: subscriptionId,
            is_individual_subscription: isIndividualSubscription,
            purchase_type: purchaseType,
            requires_proration: !isIndividualSubscription, // Only shared subscriptions require proration
            message: cancelMessage
          }, true, request);

        } catch (error) {
        
          // Rollback: Restore database state
          console.error(`[REMOVE-SITE] Attempting database rollback...`);
          try {
            await saveUserByEmail(env, email, originalUserState);
            console.error(`[REMOVE-SITE] ✅ Database rollback completed`);
          } catch (rollbackError) {
            console.error(`[REMOVE-SITE] ❌ Failed to rollback database:`, rollbackError);
          }

          // Note: Stripe item deletion cannot be rolled back (it's permanent)
          // If database update succeeded but Stripe failed, we already rolled back database above
          // If Stripe succeeded but later operations failed, the webhook will sync state

          return jsonResponse(500, { 
            error: 'operation failed', 
            message: error.message,
            rolledBack: true
          }, true, request);
        }
      }

    
      // Memberstack webhook handler - Stripe → Memberstack integration
      if (request.method === 'POST' && pathname === '/memberstack-webhook') {
        const sig = request.headers.get('stripe-signature');
        const body = await request.text();

        // Verify Stripe webhook
        let event;
        try {
          event = await this.verifyStripeWebhookForMemberstack(
            body,
            sig,
            env.STRIPE_WEBHOOK_SECRET
          );
        } catch (error) {
          console.error('Memberstack webhook verification failed:', error);
          return new Response('Invalid signature', { status: 401 });
        }

        if (event.type !== 'checkout.session.completed') {
          return new Response('Ignored', { status: 200 });
        }

        const session = event.data.object;
        const email = session.customer_details?.email;

        if (!email) {
          return new Response('Email missing', { status: 400 });
        }

        try {
          // 1️⃣ Create or get Memberstack user
          const member = await this.createMemberstackMember(email, env);

          // 2️⃣ Assign plan
          await assignMemberstackPlan(member.id, env);

          // 3️⃣ NO magic link sent here - Memberstack frontend SDK will handle it
          // User will be redirected to Webflow login page where Memberstack detects email and sends magic link

          return new Response('OK', { status: 200 });
            } catch (error) {
          console.error('Error processing Memberstack webhook:', error);
          // Still return 200 to prevent Stripe retries
          // Log error for manual investigation
          return new Response('Error processed', { status: 200 });
        }
      }

      // Purchase quantity endpoint - creates checkout for quantity-based license purchases
      // Purchase quantity endpoint - ADD INDIVIDUAL LICENSES
      // Queue processing endpoint - processes pending subscription creation tasks
      // Can be called manually to process queue immediately (useful for debugging)
      if (request.method === 'POST' && pathname === '/process-queue') {
        const { limit = 100 } = await request.json().catch(() => ({}));
        console.log(`[ENDPOINT] /process-queue called with limit: ${limit}`);
        const result = await processSubscriptionQueue(env, limit);
        console.log(`[ENDPOINT] /process-queue result:`, result);
        return jsonResponse(200, result, true, request);
      }
      
      // Process refunds for failed queue items older than 12 hours
      if (request.method === 'POST' && pathname === '/process-refunds') {
        const { limit = 50 } = await request.json().catch(() => ({}));
        const result = await processRefundsForOldFailedItems(env, limit);
        return jsonResponse(200, result, true, request);
      }
      
      // Get queue status endpoint
      if (request.method === 'GET' && pathname === '/queue-status') {
        const { payment_intent_id } = Object.fromEntries(url.searchParams);
        
        if (!payment_intent_id) {
          return jsonResponse(400, { error: 'payment_intent_id required' }, true, request);
        }
        
        try {
          const queueItems = await env.DB.prepare(
            `SELECT queue_id, license_key, status, attempts, error_message, subscription_id, created_at, processed_at
             FROM subscription_queue 
             WHERE payment_intent_id = ?
             ORDER BY created_at ASC`
          ).bind(payment_intent_id).all();
          
          const stats = {
            total: queueItems.results.length,
            pending: queueItems.results.filter(item => item.status === 'pending').length,
            processing: queueItems.results.filter(item => item.status === 'processing').length,
            completed: queueItems.results.filter(item => item.status === 'completed').length,
            failed: queueItems.results.filter(item => item.status === 'failed').length,
            items: queueItems.results
          };
          
          return jsonResponse(200, stats, true, request);
        } catch (error) {
          console.error('[queue-status] Error:', error);
          return jsonResponse(500, { error: error.message }, true, request);
        }
      }
      
      if (request.method === 'POST' && pathname === '/purchase-quantity') {
        console.log('[PURCHASE-QUANTITY] 📥 Request received');
        
        let requestBody;
        try {
          requestBody = await request.json();
          console.log('[PURCHASE-QUANTITY] 📋 Request body:', { 
            quantity: requestBody.quantity, 
            billing_period: requestBody.billing_period,
            email: requestBody.email ? 'provided' : 'not provided'
          });
        } catch (parseError) {
          console.error('[PURCHASE-QUANTITY] ❌ Error parsing request body:', parseError);
          return jsonResponse(400, {
            error: 'invalid_request',
            message: 'Invalid JSON in request body'
          }, true, request);
        }
        
        const { email: emailParam, quantity, subscription_id: subscriptionIdParam, billing_period: billingPeriodParam } = requestBody;

        if (!quantity || quantity < 1) {
          console.log('[PURCHASE-QUANTITY] ❌ Invalid quantity:', quantity);
          return jsonResponse(400, {
            error: 'invalid_quantity',
            message: 'Quantity must be at least 1'
          }, true, request);
        }
        
        console.log('[PURCHASE-QUANTITY] ✅ Quantity validated:', quantity);
        
        // Safety limit: Maximum recommended quantity for safe subscription creation
        // Stripe API rate limit: ~100 requests/second
        // Cloudflare Workers execution time: 30 seconds (free) / 50 seconds (paid)
        // Recommended: 50 subscriptions max per purchase for safe processing
        const MAX_RECOMMENDED_QUANTITY = parseInt(env.MAX_QUANTITY_PER_PURCHASE) || 25;
        
        if (quantity > MAX_RECOMMENDED_QUANTITY) {
          console.log('[PURCHASE-QUANTITY] ❌ Quantity too large:', quantity, 'max:', MAX_RECOMMENDED_QUANTITY);
          return jsonResponse(400, {
            error: 'quantity_too_large',
            message: `Quantity cannot exceed ${MAX_RECOMMENDED_QUANTITY} licenses per purchase. Please purchase in smaller batches.`,
            max_quantity: MAX_RECOMMENDED_QUANTITY
          }, true, request);
        }

        /* ─────────────────────────────
           AUTH / EMAIL
        ───────────────────────────── */
        let email = emailParam?.toLowerCase().trim();

        if (!email) {
          const cookie = request.headers.get('cookie') || '';
          const match = cookie.match(/sb_session=([^;]+)/);
          if (!match) {
            return jsonResponse(401, { error: 'unauthenticated' }, true, request);
          }

          const payload = await verifyToken(env, match[1]);
          if (!payload?.email) {
            return jsonResponse(401, { error: 'invalid_session' }, true, request);
          }

          email = payload.email;
        }

        if (!email.includes('@')) {
          console.log('[PURCHASE-QUANTITY] ❌ Invalid email format:', email);
          return jsonResponse(400, { error: 'invalid_email' }, true, request);
        }

        console.log('[PURCHASE-QUANTITY] ✅ Email validated:', email);

        /* ─────────────────────────────
           LOAD USER & SUBSCRIPTION
        ───────────────────────────── */
        console.log('[PURCHASE-QUANTITY] 🔍 Loading user from database...');
        const user = await getUserByEmail(env, email);

        if (!user?.customers?.length) {
          console.log('[PURCHASE-QUANTITY] ❌ No customer found for email:', email);
          return jsonResponse(400, {
            error: 'no_customer',
            message: 'Customer account required'
          }, true, request);
        }
        
        console.log('[PURCHASE-QUANTITY] ✅ User found with', user.customers.length, 'customer(s)');

        /* ─────────────────────────────
           GET CUSTOMER ID
           Option 2: We're creating NEW subscriptions, so we only need customer ID
           No need to verify existing subscription since we're not adding to it
        ───────────────────────────── */
        let customerId = null;
        
        // Get customer ID from user's first customer
        // For Option 2 (separate subscriptions), we just need a customer to create new subscriptions
        if (user.customers && user.customers.length > 0) {
          customerId = user.customers[0].customerId;
        }
        
        if (!customerId) {
          return jsonResponse(400, {
            error: 'no_customer',
            message: 'Customer account required'
          }, true, request);
        }

        /* ─────────────────────────────
           PRICE - From Environment Variables (fastest - no database query)
           Reads from env vars: MONTHLY_PRODUCT_ID, MONTHLY_UNIT_AMOUNT, etc.
        ───────────────────────────── */
        if (!billingPeriodParam) {
          console.log('[PURCHASE-QUANTITY] ❌ Billing period not provided');
          return jsonResponse(400, {
            error: 'billing_period_required',
            message: 'billing_period is required. Please provide "monthly" or "yearly".'
          }, true, request);
        }
        
        const normalizedPeriod = billingPeriodParam.toLowerCase().trim();
        console.log('[PURCHASE-QUANTITY] 📅 Billing period:', normalizedPeriod);
        
        // Get price configuration from environment variables
        let productId, unitAmount, currency;
        
        if (normalizedPeriod === 'monthly') {
          productId = env.MONTHLY_PRODUCT_ID || env.MONTHLY_LICENSE_PRODUCT_ID || 'prod_TiX0VbsXQSm4N5';
          unitAmount = parseInt(env.MONTHLY_UNIT_AMOUNT || env.MONTHLY_LICENSE_UNIT_AMOUNT || '800');
          currency = env.MONTHLY_CURRENCY || env.CURRENCY || 'usd';
          console.log('[PURCHASE-QUANTITY] 💰 Monthly config:', { productId, unitAmount, currency });
        } else if (normalizedPeriod === 'yearly') {
          productId = env.YEARLY_PRODUCT_ID || env.YEARLY_LICENSE_PRODUCT_ID || 'prod_TiX0CF9K1RSRyb';
          unitAmount = parseInt(env.YEARLY_UNIT_AMOUNT || env.YEARLY_LICENSE_UNIT_AMOUNT || '7200');
          currency = env.YEARLY_CURRENCY || env.CURRENCY || 'usd';
          console.log('[PURCHASE-QUANTITY] 💰 Yearly config:', { productId, unitAmount, currency });
              } else {
          console.log('[PURCHASE-QUANTITY] ❌ Invalid billing period:', billingPeriodParam);
                return jsonResponse(400, {
            error: 'invalid_billing_period',
            message: `Invalid billing_period: ${billingPeriodParam}. Must be "monthly" or "yearly".`
                }, true, request);
        }
        
        if (!productId) {
          console.log('[PURCHASE-QUANTITY] ❌ Product ID not configured for:', normalizedPeriod);
          return jsonResponse(500, {
            error: 'product_id_not_configured',
            message: `${normalizedPeriod.charAt(0).toUpperCase() + normalizedPeriod.slice(1)} product ID not configured. Please set MONTHLY_PRODUCT_ID or YEARLY_PRODUCT_ID in environment variables.`
          }, true, request);
        }
        
        // Use variables directly (already set from environment)npm run =
        const storedUnitAmount = unitAmount;
        const storedCurrency = currency;
        console.log(`[PURCHASE-QUANTITY] ✅ Price config loaded (${normalizedPeriod}):`, { productId, storedUnitAmount, storedCurrency });

        /* ─────────────────────────────
           STEP 1: CALCULATE AMOUNT (FULL PRICE FOR NEW SUBSCRIPTIONS)
           Option 2: Creating separate subscriptions (one per license)
           Since we're creating NEW subscriptions, there's no proration - charge full price
        ───────────────────────────── */
        let proratedAmount = 0;
        let invoiceCurrency = storedCurrency || 'usd'; // Use currency from environment or default
        // Generate temporary license keys (e.g., "L1", "L2") for metadata storage
        // Temporary keys are shorter and fit within Stripe's 500 character metadata limit
        // Real unique license keys will be generated later during subscription creation
        const licenseKeys = await generateTempLicenseKeys(quantity);
        
        // Calculate total amount using unit_amount from environment variables (no database or Stripe API call needed)
        proratedAmount = storedUnitAmount * quantity;
        console.log(`[USE CASE 3] Using unit_amount from environment: ${storedUnitAmount}, currency: ${invoiceCurrency}, total: ${proratedAmount}`);
        
        if (!productId) {
          return jsonResponse(500, {
            error: 'product_id_missing',
            message: `Product ID not configured for ${billingPeriodParam} billing period.`
          }, true, request);
        }

        /* ─────────────────────────────
           STEP 2: PREPARE METADATA FOR AFTER PAYMENT
           Separate subscriptions will be created AFTER payment succeeds (one per license)
           Option 2: Each license gets its own subscription for individual management
        ───────────────────────────── */
        
        // Store license keys in customer metadata temporarily (for webhook to retrieve)
        // We use customer metadata since we're creating NEW subscriptions, not adding to existing
        try {
          await stripeFetch(env, `/customers/${customerId}`, 'POST', {
            'metadata[license_keys_pending]': JSON.stringify(licenseKeys),
            'metadata[usecase]': '3', // Primary identifier for Use Case 3
            'metadata[product_id]': productId, // Store product_id for webhook (can get price_id from this)
            'metadata[quantity]': quantity.toString(), // Store quantity for webhook
            'metadata[billing_period]': normalizedPeriod // Store billing period for reference
          }, true);
        } catch (metadataErr) {
          console.warn(`[USE CASE 3] ⚠️ Failed to store metadata in customer:`, metadataErr);
          // Non-critical, but webhook will need this data
        }

        /* ─────────────────────────────
           STEP 3: CREATE CHECKOUT SESSION FOR PRORATED PAYMENT
        ───────────────────────────── */
        const dashboardUrl =
          env.MEMBERSTACK_REDIRECT_URL ||
          'https://memberstack-login-test-713fa5.webflow.io/dashboard';

       
        const form = {
          mode: 'payment', // One-time payment for prorated amount
          customer: customerId,
          'payment_method_types[0]': 'card',
          // Use custom price_data with prorated amount and product_id from environment variables
          'line_items[0][price_data][currency]': invoiceCurrency,
          'line_items[0][price_data][unit_amount]': proratedAmount,
          'line_items[0][price_data][product]': productId, // Use product_id from environment
          'line_items[0][quantity]': 1, // Always 1 since amount is already prorated
          'payment_intent_data[metadata][usecase]': '3', // Primary identifier for Use Case 3
          'payment_intent_data[metadata][customer_id]': customerId, // Required for webhook
          // For large quantities, license_keys may exceed 500 char limit - store in customer metadata instead
          // Only store in payment_intent_data if it fits within Stripe's 500 character limit
          ...(JSON.stringify(licenseKeys).length <= 450 ? {
            'payment_intent_data[metadata][license_keys]': JSON.stringify(licenseKeys) // Store if within limit
          } : {
            'payment_intent_data[metadata][license_keys_count]': quantity.toString(), // Store count instead
            'payment_intent_data[metadata][license_keys_source]': 'customer_metadata' // Indicate where to find keys
          }),
          'payment_intent_data[metadata][product_id]': productId, // Required: to create subscriptions after payment (webhook can get price_id from this)
          'payment_intent_data[metadata][quantity]': quantity.toString(), // Required: quantity to create
          'payment_intent_data[metadata][currency]': invoiceCurrency, // Store currency for reference
          'payment_intent_data[metadata][billing_period]': normalizedPeriod, // Store billing period for reference
          'payment_intent_data[setup_future_usage]': 'off_session', // Save payment method for future subscriptions
          'success_url': `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
          'cancel_url': dashboardUrl
        };

        console.log('[PURCHASE-QUANTITY] 💳 Creating Stripe checkout session...', {
          amount: proratedAmount,
          currency: invoiceCurrency,
          quantity: quantity,
          productId: productId
        });

        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);

        if (session.status >= 400) {
          // No rollback needed - items will be added after payment succeeds
          console.error('[PURCHASE-QUANTITY] ❌ Checkout session creation failed:', {
            status: session.status,
            body: session.body
          });
          
          return jsonResponse(500, {
            error: 'checkout_failed',
            message: 'Failed to create checkout session',
            details: session.body
          }, true, request);
        }

        console.log('[PURCHASE-QUANTITY] ✅ Checkout session created successfully:', {
          session_id: session.body.id,
          checkout_url: session.body.url ? 'present' : 'missing'
        });

        const response = {
          checkout_url: session.body.url,
          session_id: session.body.id,
          prorated_amount: proratedAmount,
          currency: invoiceCurrency,
          quantity: quantity,
          license_keys: licenseKeys.length
        };
        
        console.log('[PURCHASE-QUANTITY] 📤 Returning response:', {
          has_checkout_url: !!response.checkout_url,
          session_id: response.session_id,
          quantity: response.quantity
        });
        
        return jsonResponse(200, response, true, request);
      }

      // Check license status for a site
      if ((request.method === 'GET' || request.method === 'POST') && pathname === '/check-license-status') {
        // Get site domain from URL parameters (GET) or request body (POST)
        let site_domain = null;
        let email = null;
        
        if (request.method === 'GET') {
          site_domain = url.searchParams.get('site') || url.searchParams.get('site_domain') || url.searchParams.get('domain');
          email = url.searchParams.get('email');
        } else {
          const body = await request.json().catch(() => ({}));
          site_domain = body.site || body.site_domain || body.domain;
          email = body.email;
        }
        
        if (!site_domain) {
          return jsonResponse(400, { 
            error: 'missing_site', 
            message: 'Site domain is required. Provide it as URL parameter: ?site=example.com or in request body.' 
          }, true, request);
        }
        
        // Normalize site domain
        const normalizedSite = site_domain.toLowerCase().trim();
        
        console.log(`[check-license-status] 🔍 Checking license status for site: ${normalizedSite}`);
        
        if (!env.DB) {
          return jsonResponse(500, { error: 'database_not_configured', message: 'Database not configured' }, true, request);
        }
        
        try {
          // Check for active license with this site domain
          // Check both used_site_domain (activated licenses) and site_domain (site-based purchases)
          const licenseRes = await env.DB.prepare(
            `SELECT 
              license_key, 
              customer_id, 
              subscription_id, 
              item_id,
              site_domain,
              used_site_domain,
              status, 
              purchase_type,
              billing_period,
              renewal_date,
              created_at,
              updated_at
            FROM licenses 
            WHERE (LOWER(TRIM(used_site_domain)) = ? OR LOWER(TRIM(site_domain)) = ?)
            AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT 1`
          ).bind(normalizedSite, normalizedSite).first();
          
          if (!licenseRes) {
            console.log(`[check-license-status] ❌ No active license found for site: ${normalizedSite}`);
            return jsonResponse(200, {
              success: false,
              available: false,
              site: site_domain,
              message: 'No active license found for this site',
              license: null
            }, true, request);
          }
          
          // If email is provided, verify the license belongs to that user
          if (email) {
            const normalizedEmail = email.toLowerCase().trim();
            const user = await getUserByEmail(env, normalizedEmail);
            
            if (user && user.customers) {
              const customerIds = user.customers.map(c => c.customerId);
              if (!customerIds.includes(licenseRes.customer_id)) {
                console.log(`[check-license-status] ❌ License does not belong to user: ${normalizedEmail}`);
                return jsonResponse(200, {
                  success: false,
                  available: false,
                  site: site_domain,
                  message: 'No active license found for this site in your account',
                  license: null
                }, true, request);
              }
            }
          }
          
          // Get subscription details if available
          let subscriptionDetails = null;
          if (licenseRes.subscription_id) {
            try {
              const subRes = await env.DB.prepare(
                'SELECT subscription_id, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(licenseRes.subscription_id).first();
              
              if (subRes) {
                subscriptionDetails = {
                  subscription_id: subRes.subscription_id,
                  status: subRes.status,
                  current_period_end: subRes.current_period_end,
                  cancel_at_period_end: subRes.cancel_at_period_end === 1
                };
              }
            } catch (subError) {
              console.warn(`[check-license-status] ⚠️ Could not fetch subscription details:`, subError.message);
            }
          }
          
          // Format expiration date
          let expirationDate = null;
          if (licenseRes.renewal_date) {
            try {
              const timestamp = typeof licenseRes.renewal_date === 'number' ? licenseRes.renewal_date : parseInt(licenseRes.renewal_date);
              const dateInMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
              expirationDate = new Date(dateInMs).toISOString();
            } catch (e) {
              console.warn(`[check-license-status] ⚠️ Error parsing expiration date:`, e);
            }
          } else if (subscriptionDetails && subscriptionDetails.current_period_end) {
            try {
              const timestamp = typeof subscriptionDetails.current_period_end === 'number' ? subscriptionDetails.current_period_end : parseInt(subscriptionDetails.current_period_end);
              const dateInMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
              expirationDate = new Date(dateInMs).toISOString();
            } catch (e) {
              console.warn(`[check-license-status] ⚠️ Error parsing subscription expiration date:`, e);
            }
          }
          
          console.log(`[check-license-status] ✅ Found active license for site: ${normalizedSite}`);
          
          return jsonResponse(200, {
            success: true,
            available: true,
            site: site_domain,
            message: 'Active license found for this site',
            license: {
              license_key: licenseRes.license_key,
              status: licenseRes.status,
              purchase_type: licenseRes.purchase_type,
              site_domain: licenseRes.site_domain,
              used_site_domain: licenseRes.used_site_domain,
              billing_period: licenseRes.billing_period,
              expiration_date: expirationDate,
              renewal_date: licenseRes.renewal_date,
              created_at: licenseRes.created_at,
              updated_at: licenseRes.updated_at,
              subscription: subscriptionDetails
            }
          }, true, request);
          
        } catch (error) {
          console.error(`[check-license-status] ❌ Error checking license status:`, error);
          return jsonResponse(500, { 
            error: 'database_error', 
            message: 'Failed to check license status',
            details: error.message 
          }, true, request);
        }
      }
      
      if (request.method === 'POST' && pathname === '/activate-license') {
        const body = await request.json();
        const { license_key, site_domain, email: emailParam } = body;
        
        if (!license_key || !site_domain) {
          return jsonResponse(400, { error: 'missing_fields', message: 'license_key and site_domain are required' }, true, request);
        }
        
        // Get email
        let email = null;
        if (emailParam) {
          email = emailParam.toLowerCase().trim();
                } else {
          const cookie = request.headers.get('cookie') || '';
          const match = cookie.match(/sb_session=([^;]+)/);
          if (!match) {
            return jsonResponse(401, { error: 'unauthenticated', message: 'No email or session provided' }, true, request);
          }
          const token = match[1];
          const payload = await verifyToken(env, token);
          if (!payload) {
            return jsonResponse(401, { error: 'invalid session' }, true, request);
          }
          email = payload.email;
        }
        
        // Find license in database
        if (!env.DB) {
          return jsonResponse(500, { error: 'database_not_configured' }, true, request);
        }
        
        try {
          
          // Check if license exists and get full details
          const licenseRes = await env.DB.prepare(
            'SELECT license_key, site_domain, used_site_domain, status, customer_id, subscription_id, item_id, purchase_type FROM licenses WHERE license_key = ?'
          ).bind(license_key).first();
          
          if (!licenseRes) {
            console.error(`[activate-license] ❌ License not found: ${license_key}`);
            return jsonResponse(404, { 
              error: 'license_not_found', 
              message: 'License key not found. Please check the license key and try again.' 
            }, true, request);
          }
          
          // Verify customer ownership
          if (email) {
            const user = await getUserByEmail(env, email);
            if (user && user.customers) {
              const customerIds = user.customers.map(c => c.customerId);
              if (!customerIds.includes(licenseRes.customer_id)) {
                console.error(`[activate-license] ❌ Unauthorized: License ${license_key} does not belong to user ${email}`);
                return jsonResponse(403, { error: 'unauthorized', message: 'This license key does not belong to your account' }, true, request);
              }
            }
          }
          
          // Check subscription status if subscription_id exists
          if (licenseRes.subscription_id) {
            
            try {
              const subRes = await env.DB.prepare(
                'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(licenseRes.subscription_id).first();
              
              if (!subRes) {
                console.warn(`[activate-license] ⚠️ Subscription not found in database: ${licenseRes.subscription_id}`);
                // Try to fetch from Stripe as fallback
                try {
                  const stripeSubRes = await stripeFetch(env, `/subscriptions/${licenseRes.subscription_id}`);
                  if (stripeSubRes.status === 200 && stripeSubRes.body) {
                    const stripeSub = stripeSubRes.body;
                    const now = Math.floor(Date.now() / 1000);
                    const periodEnd = stripeSub.current_period_end || 0;
                    
                    // Check if subscription has ended
                    if (periodEnd > 0 && periodEnd < now) {
                      const endDate = new Date(periodEnd * 1000).toLocaleDateString();
                      console.warn(`[activate-license] ⚠️ Subscription has ended: ${endDate}`);
                      return jsonResponse(400, { 
                        error: 'subscription_ended', 
                        message: `This license key's subscription has ended on ${endDate}. Please renew your subscription to continue using this license.`,
                        subscription_end_date: periodEnd,
                        subscription_end_date_formatted: endDate
                      }, true, request);
                    }
                    
                    // Check if subscription is cancelled
                    if (stripeSub.status === 'canceled' || stripeSub.cancel_at_period_end || stripeSub.canceled_at) {
                      const cancelDate = stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000).toLocaleDateString() : 
                                        (stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toLocaleDateString() : 'N/A');
                      console.warn(`[activate-license] ⚠️ Subscription is cancelled: ${cancelDate}`);
                      return jsonResponse(400, { 
                        error: 'subscription_cancelled', 
                        message: `This license key's subscription has been cancelled. It will end on ${cancelDate}. Please reactivate your subscription to continue using this license.`,
                        subscription_cancel_date: stripeSub.cancel_at || stripeSub.current_period_end,
                        subscription_cancel_date_formatted: cancelDate
                      }, true, request);
                    }
                    
                    // Check if subscription is not active
                    if (stripeSub.status !== 'active' && stripeSub.status !== 'trialing') {
                      console.warn(`[activate-license] ⚠️ Subscription is not active: ${stripeSub.status}`);
                      return jsonResponse(400, { 
                        error: 'subscription_inactive', 
                        message: `This license key's subscription is ${stripeSub.status}. Please ensure your subscription is active to use this license.`,
                        subscription_status: stripeSub.status
                      }, true, request);
                    }
                  }
                } catch (stripeErr) {
                  console.warn(`[activate-license] ⚠️ Could not fetch subscription from Stripe:`, stripeErr.message);
                }
              } else {
                // Subscription found in database - check status
                const now = Math.floor(Date.now() / 1000);
                const periodEnd = subRes.current_period_end || 0;
                
                // Check if subscription has ended
                if (periodEnd > 0 && periodEnd < now) {
                  const endDate = new Date(periodEnd * 1000).toLocaleDateString();
                  console.warn(`[activate-license] ⚠️ Subscription has ended: ${endDate}`);
                  return jsonResponse(400, { 
                    error: 'subscription_ended', 
                    message: `This license key's subscription has ended on ${endDate}. Please renew your subscription to continue using this license.`,
                    subscription_end_date: periodEnd,
                    subscription_end_date_formatted: endDate
                  }, true, request);
                }
                
                // Check if subscription is cancelled
                if (subRes.status === 'canceled' || subRes.cancel_at_period_end === 1 || subRes.cancel_at) {
                  const cancelDate = subRes.cancel_at ? new Date(subRes.cancel_at * 1000).toLocaleDateString() : 
                                    (subRes.current_period_end ? new Date(subRes.current_period_end * 1000).toLocaleDateString() : 'N/A');
                  console.warn(`[activate-license] ⚠️ Subscription is cancelled: ${cancelDate}`);
                  return jsonResponse(400, { 
                    error: 'subscription_cancelled', 
                    message: `This license key's subscription has been cancelled. It will end on ${cancelDate}. Please reactivate your subscription to continue using this license.`,
                    subscription_cancel_date: subRes.cancel_at || subRes.current_period_end,
                    subscription_cancel_date_formatted: cancelDate
                  }, true, request);
                }
                
                // Check if subscription is not active
                if (subRes.status !== 'active' && subRes.status !== 'trialing') {
                  console.warn(`[activate-license] ⚠️ Subscription is not active: ${subRes.status}`);
                  return jsonResponse(400, { 
                    error: 'subscription_inactive', 
                    message: `This license key's subscription is ${subRes.status}. Please ensure your subscription is active to use this license.`,
                    subscription_status: subRes.status
                  }, true, request);
                }
              }
            } catch (subCheckErr) {
              console.error(`[activate-license] ⚠️ Error checking subscription status:`, subCheckErr.message);
              // Continue with activation if subscription check fails (non-critical)
            }
          }
          
          // CRITICAL: Check if license is from site-based purchase (has site_domain set)
          // Site-based licenses are pre-assigned to a specific site and cannot be used for other sites
          if (licenseRes.site_domain && licenseRes.site_domain.trim() !== '') {
            const normalizedOriginalSite = licenseRes.site_domain.toLowerCase().trim();
            const normalizedRequestedSite = site_domain.toLowerCase().trim();
            
            if (normalizedOriginalSite !== normalizedRequestedSite) {
              console.error(`[activate-license] ❌ License ${license_key} is tied to site ${licenseRes.site_domain} and cannot be used for ${site_domain}`);
              return jsonResponse(400, { 
                error: 'license_site_mismatch', 
                message: `This license key is tied to the site "${licenseRes.site_domain}" and cannot be used for other sites. Please use the correct license key for "${site_domain}".`,
                original_site: licenseRes.site_domain,
                requested_site: site_domain
              }, true, request);
            }
            
            // Site matches - check if already activated
            if (licenseRes.used_site_domain) {
              console.log(`[activate-license] ℹ️ License ${license_key} is already activated for site ${licenseRes.used_site_domain}`);
              // Site-based licenses are already "used" - return success but don't allow reuse
              return jsonResponse(400, { 
                error: 'license_already_used', 
                message: `This license key is already activated and tied to "${licenseRes.used_site_domain}". Site-based licenses cannot be reused or transferred.`,
                activated_site: licenseRes.used_site_domain
              }, true, request);
            }
          }
          
          // Check if license is already activated (for quantity-based purchases)
          const isAlreadyActivated = !!licenseRes.used_site_domain;
          
          // If already activated, prevent reuse
          if (isAlreadyActivated) {
            console.error(`[activate-license] ❌ License ${license_key} is already activated for site ${licenseRes.used_site_domain} and cannot be reused`);
            return jsonResponse(400, { 
              error: 'license_already_used', 
              message: `This license key is already activated and used for "${licenseRes.used_site_domain}". Licenses cannot be reused or transferred to other sites.`,
              activated_site: licenseRes.used_site_domain
            }, true, request);
          }
          
          // First-time activation - mark as activated
          console.log(`[activate-license] ✅ Activating license ${license_key} for the first time with site: ${site_domain}`);
          
          // Check if inactive
          if (licenseRes.status !== 'active') {
            console.warn(`[activate-license] ⚠️ License is not active: ${licenseRes.status}`);
            return jsonResponse(400, { error: 'inactive_license', message: 'This license is not active' }, true, request);
          }
          
          const timestamp = Math.floor(Date.now() / 1000);
          
          // Step 1: Update license with used site domain (this marks it as activated)
          // Once used_site_domain is set, the license is considered activated
          const licenseUpdate = await env.DB.prepare(
            'UPDATE licenses SET used_site_domain = ?, updated_at = ? WHERE license_key = ?'
          ).bind(site_domain, timestamp, license_key).run();
          
          // Update KV storage with site details (for license key activation)
          if (licenseRes.subscription_id && licenseRes.customer_id) {
            console.log(`[activate-license] 💾 Updating KV storage for license key: ${license_key}`);
            
            // Always clean up old KV entries before saving new one
            // This handles both first activation and domain updates
            try {
              if (env.ACTIVE_SITES_CONSENTBIT) {
                // 1. Delete old entry keyed by license key (always, for backward compatibility)
                try {
                  const oldLicenseKeyEntry = await env.ACTIVE_SITES_CONSENTBIT.get(license_key);
                  if (oldLicenseKeyEntry) {
                    await env.ACTIVE_SITES_CONSENTBIT.delete(license_key);
                    console.log(`[activate-license] 🗑️ Deleted old KV entry keyed by license key: ${license_key}`);
                  }
                } catch (deleteLicenseKeyErr) {
                  // Entry might not exist, that's okay
                  console.log(`[activate-license] ℹ️ No existing KV entry found for license key: ${license_key}`);
                }
                
                // 2. If updating domain (not first activation), delete old domain entry
                if (isAlreadyActivated && licenseRes.used_site_domain && licenseRes.used_site_domain !== site_domain) {
                  const oldFormattedDomain = formatSiteName(licenseRes.used_site_domain);
                  if (oldFormattedDomain) {
                    try {
                      const oldDomainEntry = await env.ACTIVE_SITES_CONSENTBIT.get(oldFormattedDomain);
                      if (oldDomainEntry) {
                        await env.ACTIVE_SITES_CONSENTBIT.delete(oldFormattedDomain);
                        console.log(`[activate-license] 🗑️ Deleted old KV entry for previous domain: ${oldFormattedDomain}`);
                      }
                    } catch (deleteDomainErr) {
                      console.warn(`[activate-license] ⚠️ Could not delete old domain KV entry:`, deleteDomainErr.message);
                      // Non-critical, continue
                    }
                  }
                }
              }
            } catch (deleteErr) {
              console.warn(`[activate-license] ⚠️ Error during KV cleanup:`, deleteErr.message);
              // Non-critical, continue - we'll still save the new entry
            }
            
            // Get subscription cancel_at_period_end status for KV storage
            let cancelAtPeriodEnd = false;
            try {
              const subDetails = await env.DB.prepare(
                'SELECT cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
              ).bind(licenseRes.subscription_id).first();
              if (subDetails) {
                cancelAtPeriodEnd = subDetails.cancel_at_period_end === 1;
              }
            } catch (subErr) {
              console.warn(`[activate-license] ⚠️ Could not fetch subscription cancel status:`, subErr.message);
            }
            
            // CRITICAL: Ensure site_domain is not item_id - validate it's a proper domain
            // item_id typically starts with 'si_' (Stripe subscription item ID)
            // If site_domain looks like an item_id, use the previous used_site_domain or reject
            let validatedSiteDomain = site_domain;
            
            if (!site_domain || site_domain.trim() === '') {
              console.error(`[activate-license] ❌ Empty site_domain provided`);
              return jsonResponse(400, { 
                error: 'invalid_site_domain', 
                message: 'Site domain cannot be empty.' 
              }, true, request);
            }
            
            // Check if site_domain is actually an item_id (Stripe item IDs start with 'si_')
            if (site_domain.startsWith('si_') || site_domain.startsWith('item_') || site_domain.match(/^[a-z]{2}_[a-zA-Z0-9]+$/)) {
              console.error(`[activate-license] ❌ Invalid site_domain provided: "${site_domain}". This appears to be an item_id, not a domain name.`);
              
              // If updating and we have a previous valid domain, use that instead
              if (isAlreadyActivated && licenseRes.used_site_domain && 
                  !licenseRes.used_site_domain.startsWith('si_') && 
                  !licenseRes.used_site_domain.startsWith('item_')) {
                console.warn(`[activate-license] ⚠️ Using previous valid domain: ${licenseRes.used_site_domain}`);
                validatedSiteDomain = licenseRes.used_site_domain;
              } else {
                return jsonResponse(400, { 
                  error: 'invalid_site_domain', 
                  message: `Invalid site domain provided: "${site_domain}". Expected a domain name (e.g., example.com), not an item ID.` 
                }, true, request);
              }
            }
            
            console.log(`[activate-license] ✅ Using validated site domain: ${validatedSiteDomain} (original: ${site_domain})`);
            
            await saveLicenseKeyToKV(
              env,
              license_key,
              licenseRes.customer_id,
              licenseRes.subscription_id,
              email,
              'complete', // License is active
              cancelAtPeriodEnd,
              validatedSiteDomain // Use validated site domain (not item_id)
            );
          }
          
          // Step 2: Update or create site entry in sites table
          if (licenseRes.subscription_id && licenseRes.customer_id) {
            
            // Check if site already exists
            const existingSite = await env.DB.prepare(
              'SELECT id, site_domain, status FROM sites WHERE customer_id = ? AND site_domain = ? LIMIT 1'
            ).bind(licenseRes.customer_id, site_domain).first();
            
            if (existingSite) {
              // Update existing site entry
              
              // Get subscription details for renewal date
              let renewalDate = null;
              if (licenseRes.subscription_id) {
                try {
                  const subDetails = await env.DB.prepare(
                    'SELECT current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
                  ).bind(licenseRes.subscription_id).first();
                  if (subDetails && subDetails.current_period_end) {
                    renewalDate = subDetails.current_period_end;
                  }
                } catch (subErr) {
                  console.warn(`[activate-license] ⚠️ Could not fetch subscription details:`, subErr.message);
                }
              }
              
              await env.DB.prepare(
                'UPDATE sites SET status = ?, updated_at = ?, renewal_date = ? WHERE customer_id = ? AND site_domain = ?'
              ).bind('active', timestamp, renewalDate, licenseRes.customer_id, site_domain).run();
              
            } else {
              // Create new site entry
              
              // Get subscription and price details
              let priceId = null;
              let amountPaid = 0;
              let renewalDate = null;
              
              if (licenseRes.subscription_id) {
                try {
                  const subDetails = await env.DB.prepare(
                    'SELECT price_id, current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
                  ).bind(licenseRes.subscription_id).first();
                  
                  if (subDetails) {
                    priceId = subDetails.price_id;
                    renewalDate = subDetails.current_period_end;
                    
                    // Get price amount
                    if (priceId) {
                      try {
                        const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                        if (priceRes.status === 200 && priceRes.body) {
                          amountPaid = priceRes.body.unit_amount || 0;
                        }
                      } catch (priceErr) {
                        console.warn(`[activate-license] ⚠️ Could not fetch price details:`, priceErr.message);
                      }
                    }
                  }
                } catch (subErr) {
                  console.warn(`[activate-license] ⚠️ Could not fetch subscription details:`, subErr.message);
                }
              }
              
              await env.DB.prepare(
                'INSERT INTO sites (customer_id, subscription_id, site_domain, price_id, amount_paid, currency, status, renewal_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
              ).bind(
                licenseRes.customer_id,
                licenseRes.subscription_id,
                site_domain,
                priceId,
                amountPaid,
                'usd',
                'active',
                renewalDate,
                timestamp,
                timestamp
              ).run();
              
            }
          } else {
            console.warn(`[activate-license] ⚠️ Missing subscription_id or customer_id, skipping sites table update`);
          }
          
          // Step 3: Update user object sites if available
          if (email && env.KV) {
            try {
              const user = await getUserByEmail(env, email);
              if (user && licenseRes.subscription_id) {
                if (!user.sites) user.sites = {};
                user.sites[site_domain] = {
                  subscriptionId: licenseRes.subscription_id,
                  site: site_domain,
                  status: 'active',
                  licenseKey: license_key,
                  updatedAt: timestamp
                };
                await saveUserByEmail(env, email, user);
              }
            } catch (userErr) {
              console.warn(`[activate-license] ⚠️ Could not update user object:`, userErr.message);
              // Non-critical, continue
            }
          }
          
          const actionText = isAlreadyActivated ? 'updated' : 'activated';
          const message = isAlreadyActivated 
            ? `License site domain updated successfully from ${licenseRes.used_site_domain} to ${site_domain}`
            : `License activated successfully for ${site_domain}`;
          
          
          return jsonResponse(200, { 
            success: true, 
            message: message,
            license_key: license_key,
            site_domain: site_domain,
            previous_site: isAlreadyActivated ? licenseRes.used_site_domain : null,
            status: 'used',
            is_used: true,
            is_activated: true,
            was_update: isAlreadyActivated
          }, true, request);
        } catch (error) {
          console.error('[activate-license] ❌ Error:', error);
          console.error('[activate-license] ❌ Error stack:', error.stack);
          return jsonResponse(500, { error: 'activation_failed', message: error.message }, true, request);
        }
      }
      
      // Deactivate license endpoint - removes one license from subscription (quantity-based)
      if (request.method === 'POST' && pathname === '/deactivate-license') {
        const body = await request.json();
        const { license_key, email: emailParam } = body;
        
        if (!license_key) {
          return jsonResponse(400, { error: 'missing_license_key', message: 'license_key is required' }, true, request);
        }
        
        // Get email (for ownership validation and session)
        let email = null;
        if (emailParam) {
          email = emailParam.toLowerCase().trim();
                    } else {
          const cookie = request.headers.get('cookie') || '';
          const match = cookie.match(/sb_session=([^;]+)/);
          if (!match) {
            return jsonResponse(401, { error: 'unauthenticated', message: 'No email or session provided' }, true, request);
          }
          const token = match[1];
          const payload = await verifyToken(env, token);
          if (!payload) {
            return jsonResponse(401, { error: 'invalid session' }, true, request);
          }
          email = payload.email;
        }
        
        if (!env.DB) {
          return jsonResponse(500, { error: 'database_not_configured' }, true, request);
        }
        
        try {
          // Load license including subscription and item info
          const licenseRes = await env.DB.prepare(
            'SELECT license_key, customer_id, subscription_id, item_id, purchase_type, status, used_site_domain FROM licenses WHERE license_key = ?'
          ).bind(license_key).first();
          
          if (!licenseRes) {
            return jsonResponse(404, { error: 'license_not_found', message: 'License key not found' }, true, request);
          }
          
          // Only support quantity-based licenses here; site-based licenses should use /remove-site
          if (licenseRes.purchase_type && licenseRes.purchase_type !== 'quantity') {
            return jsonResponse(400, { 
              error: 'unsupported_operation', 
              message: 'This license is site-based. Please use the Unsubscribe button for that site.' 
            }, true, request);
          }
          
          // Validate ownership
          if (email) {
            const user = await getUserByEmail(env, email);
            if (user && user.customers) {
              const customerIds = user.customers.map(c => c.customerId);
              if (!customerIds.includes(licenseRes.customer_id)) {
                return jsonResponse(403, { error: 'unauthorized', message: 'This license key does not belong to your account' }, true, request);
              }
            }
          }
          
          if (licenseRes.status !== 'active') {
            return jsonResponse(400, { error: 'inactive_license', message: 'This license is already inactive' }, true, request);
          }
          
          const subscriptionId = licenseRes.subscription_id;
          const itemId = licenseRes.item_id;
          
          if (!subscriptionId || !itemId) {
            return jsonResponse(400, { 
              error: 'missing_subscription_info', 
              message: 'Subscription information is missing for this license. It may be from an older purchase.' 
            }, true, request);
          }
          
          // Check if this is an individual subscription (one license per subscription)
          // For Use Case 3, we create individual subscriptions (one per license)
          // In this case, we should cancel the subscription instead of reducing quantity
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status !== 200) {
            console.error('[deactivate-license] Failed to fetch subscription from Stripe:', subRes.status, subRes.body);
            return jsonResponse(500, { error: 'stripe_error', message: 'Failed to fetch subscription from Stripe' }, true, request);
          }
          
          const subscription = subRes.body;
          const subscriptionMetadata = subscription.metadata || {};
          const isIndividualSubscription = subscriptionMetadata.purchase_type === 'quantity' && subscriptionMetadata.usecase === '3';
          
          if (isIndividualSubscription) {
            // Individual subscription approach: Cancel the subscription
            // Each license has its own subscription, so canceling it deactivates the license
            
            // Get subscription status from Stripe before cancellation
            try {
              const subBeforeRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
              if (subBeforeRes.status === 200) {
                const subBefore = subBeforeRes.body;
                // Subscription details available
              }
            } catch (subBeforeErr) {
              console.warn(`[deactivate-license] ⚠️ Could not fetch subscription before cancel:`, subBeforeErr.message);
            }
            
            // Cancel the subscription at period end (preserves access until period ends)
            
            const cancelStartTime = Date.now();
            const cancelRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`, 'POST', {
              'cancel_at_period_end': 'true'
            }, true);
            const cancelEndTime = Date.now();
            const cancelDuration = cancelEndTime - cancelStartTime;
            
            
            if (cancelRes.status >= 400) {
              console.error('[deactivate-license] ❌ Failed to cancel subscription:', cancelRes.status, cancelRes.body);
              return jsonResponse(500, { error: 'stripe_cancel_failed', details: cancelRes.body }, true, request);
            }
            
            // Extract and log key fields from successful response
            if (cancelRes.body && cancelRes.status === 200) {
              const sub = cancelRes.body;
              // Subscription cancellation details available
              
              // Verify cancellation was applied
              if (sub.cancel_at_period_end === true) {
              } else {
                console.warn(`[deactivate-license] ⚠️ WARNING: cancel_at_period_end is not true in response:`, sub.cancel_at_period_end);
              }
            }
            
            // Mark this license as inactive in DB
            const timestamp = Math.floor(Date.now() / 1000);
            await env.DB.prepare(
              'UPDATE licenses SET status = ?, updated_at = ? WHERE license_key = ?'
            ).bind('inactive', timestamp, license_key).run();
            
            // Update subscription status in database
            if (env.DB) {
              try {
                // Get cancel_at from Stripe response
                const canceledAt = cancelRes.body?.cancel_at || cancelRes.body?.canceled_at || cancelRes.body?.current_period_end || timestamp;
                const currentPeriodEnd = cancelRes.body?.current_period_end || null;
                
                await env.DB.prepare(
                  'UPDATE subscriptions SET cancel_at_period_end = ?, cancel_at = ?, status = ?, current_period_end = ?, updated_at = ? WHERE subscription_id = ?'
                ).bind(1, canceledAt, 'active', currentPeriodEnd, timestamp, subscriptionId).run();
                
                
                // Verify the update
                try {
                  const verifySub = await env.DB.prepare(
                    'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
                  ).bind(subscriptionId).first();
                  
                  if (verifySub) {
                    // Subscription verified
                  }
                } catch (verifyErr) {
                  console.warn(`[deactivate-license] ⚠️ Could not verify database update:`, verifyErr.message);
                }
              } catch (dbErr) {
                console.error('[deactivate-license] ❌ Error updating subscription in database:', dbErr);
              }
            }
            
            return jsonResponse(200, { 
              success: true,
              message: 'License subscription canceled successfully. The subscription will remain active until the end of the current billing period.',
              license_key: license_key,
              subscription_id: subscriptionId,
              cancel_at_period_end: true
            }, true, request);
          } else {
            // Legacy approach: Multiple licenses in one subscription (reduce quantity)
            // Get current subscription item to know the quantity
            const itemRes = await stripeFetch(env, `/subscription_items/${itemId}`);
            if (itemRes.status !== 200) {
              console.error('[deactivate-license] Failed to fetch subscription item from Stripe:', itemRes.status, itemRes.body);
              return jsonResponse(500, { error: 'stripe_error', message: 'Failed to fetch subscription item from Stripe' }, true, request);
            }
            
            const currentQuantity = itemRes.body.quantity || 1;
            let newQuantity = currentQuantity - 1;
            if (newQuantity < 0) newQuantity = 0;
            
            // Update Stripe subscription item quantity (or delete if reaching 0)
            if (newQuantity > 0) {
              const updateRes = await stripeFetch(env, `/subscription_items/${itemId}`, 'POST', {
                quantity: newQuantity,
                proration_behavior: 'create_prorations'
              }, true);
              
              if (updateRes.status >= 400) {
                console.error('[deactivate-license] Failed to update subscription item quantity:', updateRes.status, updateRes.body);
                return jsonResponse(500, { error: 'stripe_update_failed', details: updateRes.body }, true, request);
              }
            } else {
              // If quantity would be 0, delete the subscription item entirely
              const deleteRes = await stripeFetch(
                env, 
                `/subscription_items/${itemId}?proration_behavior=create_prorations`, 
                'DELETE', 
                null, 
                true
              );
              
              if (deleteRes.status >= 400) {
                console.error('[deactivate-license] Failed to delete subscription item:', deleteRes.status, deleteRes.body);
                return jsonResponse(500, { error: 'stripe_delete_failed', details: deleteRes.body }, true, request);
              }
            }
            
            // Mark this license as inactive in DB, but keep used_site_domain for history
            const timestamp = Math.floor(Date.now() / 1000);
            await env.DB.prepare(
              'UPDATE licenses SET status = ?, updated_at = ? WHERE license_key = ?'
            ).bind('inactive', timestamp, license_key).run();
            
            return jsonResponse(200, { 
              success: true,
              message: 'License removed from subscription and deactivated successfully',
              license_key: license_key,
              subscription_id: subscriptionId,
              new_quantity: newQuantity
            }, true, request);
          }
        } catch (error) {
          console.error('[deactivate-license] Error:', error);
          return jsonResponse(500, { error: 'deactivation_failed', message: error.message }, true, request);
        }
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error('Error in request handler:', err);
      return jsonResponse(500, { error: 'internal_server_error', message: err.message || 'Internal server error' }, true, request);
    }
  },

  /* ---------------- MEMBERSTACK HELPER FUNCTIONS ---------------- */

  /**
   * Verifies Stripe webhook signature using HMAC-SHA256 for Memberstack integration
   * @param {string} payload - Raw webhook payload
   * @param {string} sigHeader - Stripe signature header
   * @param {string} secret - Webhook signing secret
   * @returns {Promise<object>} Parsed event object
   */
  async verifyStripeWebhookForMemberstack(payload, sigHeader, secret) {
  if (!sigHeader || !secret) {
    throw new Error('Missing signature or secret');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Parse signature header: "t=timestamp,v1=signature"
  const parts = sigHeader.split(',');
  let timestamp;
  let signature;

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signature = value;
    }
  }

  if (!timestamp || !signature) {
    throw new Error('Invalid signature format');
  }

  const signedPayload = `${timestamp}.${payload}`;

  // Convert hex signature to bytes
  const signatureBytes = this.hexToBytesForMemberstack(signature);

  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(signedPayload)
  );

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  return JSON.parse(payload);
  },

  /**
   * Converts hex string to Uint8Array
   * @param {string} hex - Hex string
   * @returns {Uint8Array} Byte array
   */
  hexToBytesForMemberstack(hex) {
  return new Uint8Array(
    hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
  );
  },

  /**
   * Creates a Memberstack member or returns existing member
   * @param {string} email - User email
   * @param {object} env - Environment variables
   * @returns {Promise<object>} Member object with id
   * 
   * Security Best Practices (per Memberstack docs):
   * - Secret keys stored in environment variables (env.MEMBERSTACK_SECRET_KEY)
   * - Never committed to version control
   * - Test Mode Keys: Start with 'sk_sb_' (development/testing)
   * - Live Mode Keys: Start with 'sk_' (production)
   * - Use different keys for dev/prod environments
   * - Rotate keys periodically for enhanced security
   * Reference: https://developers.memberstack.com/admin-node-package/quick-start#installation-setup
   */
  async createMemberstackMember(email, env) {
  // ========================================
  // USE CASE 1 DEBUG: Memberstack Member Creation Function
  // ========================================

  if (!env.MEMBERSTACK_SECRET_KEY) {
    throw new Error('MEMBERSTACK_SECRET_KEY not configured');
  }

  // Validate API key format (Memberstack secret keys start with 'sk_sb_' for test or 'sk_' for live)
  // Reference: https://developers.memberstack.com/admin-node-package/quick-start#installation-setup
  const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();
  
  // Check if key exists
  if (!apiKey || apiKey.length < 10) {
    throw new Error('MEMBERSTACK_SECRET_KEY appears to be invalid (too short or missing)');
  }
  
  // Memberstack test keys (sk_sb_*) are typically 26 characters
  // Memberstack live keys (sk_*) are typically longer
  // Both are valid, just different lengths based on mode
  
  // Check if key has correct format
  const isValidFormat = apiKey.startsWith('sk_sb_') || apiKey.startsWith('sk_');
  if (!isValidFormat) {
    Error(`Invalid API key format. Expected 'sk_sb_' (test) or 'sk_' (live), got: ${apiKey.substring(0, 6)}...`);
  }

  // First, try to get existing member by email
  // Note: Memberstack Admin API uses X-API-KEY header (uppercase)
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
      
      if (foundMember) {
        const memberEmail = foundMember.auth?.email || foundMember.email || foundMember._email || email;
        const memberId = foundMember.id || foundMember._id || 'N/A';

        return foundMember;
      } else if (membersArray.length > 0) {
        // Found members but none match the exact email
        const firstMemberEmail = membersArray[0].email || membersArray[0]._email || 'N/A';



        // Don't return - continue to create new member
      }
    } else {
      // GET request failed - log for debugging
      const errorText = await getRes.text();

    }
  } catch (error) {
    // If GET fails, try to create (member might not exist)

  }

  // Member doesn't exist, create it
  // Memberstack Admin API: https://admin.memberstack.com/members
  // Required: email, password
  // Optional: plans (array of { planId: string }), customFields, metaData, json, loginRedirect
  // Reference: Memberstack Admin REST API documentation
  // Example format matches: { email, password, plans: [{ planId: "pln_abc123" }], loginRedirect: "/dashboard" }
  const createMemberPayload = {
    email: email,
    password: generateRandomPassword(), // Generate a secure random password (user will use magic link to login)
    loginRedirect: env.MEMBERSTACK_REDIRECT_URL || 'https://memberstack-login-test-713fa5.webflow.io/dashboard',
  };
  
  // Add plans array only if plan ID is configured (matches example format)
  if (env.MEMBERSTACK_PLAN_ID) {
    createMemberPayload.plans = [{ planId: env.MEMBERSTACK_PLAN_ID }];

  }

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
    // Log detailed error for debugging
   
    throw new Error(`Member create failed: ${res.status} ${errorText}`);
  }

  const newMember = await res.json();
  const createdMemberData = newMember.data || newMember;
  const newMemberId = createdMemberData.id || createdMemberData._id;
  const newMemberEmail = createdMemberData.email || createdMemberData._email || 'N/A';

  // Handle different response formats
  return createdMemberData;
  },

  /**
   * Gets an existing Memberstack member by email (READ-ONLY - does not create)
   * Use this when you only need to retrieve a member, not create one
   * @param {string} email - User email
   * @param {object} env - Environment variables
   * @returns {Promise<object|null>} Member object with id, or null if not found
   */
  async getMemberstackMember(email, env) {
  if (!env.MEMBERSTACK_SECRET_KEY) {
    return null;
  }

  const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();
  
  if (!apiKey || apiKey.length < 10) {
    return null;
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  const apiUrl = `https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`;
  
  
  try {
    const getRes = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
    });


    if (getRes.ok) {
      const members = await getRes.json();
      
      let membersArray = [];
      
      // Normalize response to array
      if (Array.isArray(members)) {
        membersArray = members;
      } else if (members.data && Array.isArray(members.data)) {
        membersArray = members.data;
      } else {
      }
      
      // Find member with EXACT email match (case-insensitive)
      const searchEmailLower = normalizedEmail;
      let foundMember = null;
      
      
      for (const member of membersArray) {
        // Check auth.email first (Memberstack API structure)
        const memberEmail = member.auth?.email || 
                           member.email || 
                           member._email || 
                           member.data?.email || 
                           member.data?._email ||
                           member.data?.auth?.email;
        const memberEmailLower = memberEmail ? memberEmail.toLowerCase().trim() : null;
        
        
        if (memberEmailLower && memberEmailLower === searchEmailLower) {
          foundMember = member;
          break; // Found exact match, stop searching
        }
      }
      
      if (foundMember) {
        const memberEmail = foundMember.auth?.email || foundMember.email || foundMember._email || foundMember.data?.email || foundMember.data?._email || email;
        const memberId = foundMember.id || foundMember._id || foundMember.data?.id || foundMember.data?._id || 'N/A';
        return foundMember;
      } else if (membersArray.length > 0) {
        // Found members but none match the exact email
        const firstMemberEmail = membersArray[0].email || membersArray[0]._email || membersArray[0].data?.email || 'N/A';
        return null;
      } else {
        return null;
      }
    } else {
      // GET request failed - log for debugging
      const errorText = await getRes.text();
      console.error(`[getMemberstackMember] ❌ GET member failed (${getRes.status}): ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`[getMemberstackMember] ❌ Error fetching member:`, error);
    console.error(`[getMemberstackMember] Error message: ${error.message}`);
    console.error(`[getMemberstackMember] Error stack:`, error.stack);
    return null;
  }
  },

  /**
   * Assigns a plan to a Memberstack member
   * @param {string} memberId - Memberstack member ID
   * @param {object} env - Environment variables
   */
  async assignMemberstackPlan(memberId, env) {
  if (!env.MEMBERSTACK_SECRET_KEY) {
    throw new Error('MEMBERSTACK_SECRET_KEY not configured');
  }
  if (!env.MEMBERSTACK_PLAN_ID) {
    throw new Error('MEMBERSTACK_PLAN_ID not configured');
  }

  const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();
  // Note: Plan assignment might be done during member creation, but this endpoint is for updating
  // Using admin.memberstack.com with X-API-KEY header
  const res = await fetch(
    `https://admin.memberstack.com/members/${memberId}/plans`,
    {
    method: 'POST',
    headers: {
        'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        planId: env.MEMBERSTACK_PLAN_ID,
    }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Plan assignment failed: ${res.status} ${errorText}`);
  }

  return await res.json();
  }
};
