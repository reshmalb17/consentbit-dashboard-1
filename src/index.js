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

// Generate a unique license key
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

// Generate multiple license keys
function generateLicenseKeys(count) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(generateLicenseKey());
  }
  return keys;
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
    'http://localhost:8080'
  ];
  
  // If origin is in allowed list, use it; otherwise use wildcard (but won't work with credentials)
  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : '*';
  
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
              for (const item of subscription.items) {
                await env.DB.prepare(
                  `INSERT OR REPLACE INTO subscription_items 
                   (subscription_id, item_id, site_domain, price_id, quantity, status, created_at, updated_at, removed_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  subscription.subscriptionId,
                  item.item_id,
                  item.site || item.site_domain,
                  item.price || item.price_id,
                  item.quantity || 1,
                  item.status || 'active',
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
      
      // Get user object pending sites
      const userPendingSites = new Set();
      userData.pendingSites.forEach(ps => {
        const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
        if (siteName) {
          userPendingSites.add(siteName);
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
      const sitesToInsert = [];
      userData.pendingSites.forEach(ps => {
        const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
        if (siteName && !currentPendingSites.has(siteName)) {
          sitesToInsert.push(ps);
        }
      });
      
      // Delete sites that are in database but not in user object
      for (const siteToDelete of sitesToDelete) {
        await env.DB.prepare(
          'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
        ).bind(normalizedEmail, siteToDelete).run();
      }
      
      // Insert sites that are in user object but not in database
      for (const pendingSite of sitesToInsert) {
        await env.DB.prepare(
          'INSERT INTO pending_sites (user_email, subscription_id, site_domain, price_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          normalizedEmail,
          pendingSite.subscription_id || null,
          pendingSite.site || pendingSite.site_domain,
          pendingSite.price || pendingSite.price_id,
          pendingSite.quantity || 1,
          pendingSite.created_at || timestamp
        ).run();
      }
      
      if (sitesToDelete.length > 0 || sitesToInsert.length > 0) {
      }
    }
    // If userData.pendingSites is undefined, don't modify the database - keep existing pending sites
    
  } catch (error) {
    console.error('Error saving user to database:', error);
    throw error;
  }
}

async function addOrUpdateCustomerInUser(env, email, customerId, subscriptionId, items, billingPeriod = null) {
  let user = await getUserByEmail(env, email);
  
  if (!user) {
    // Create new user structure with email as primary key
    user = {
      email: email.toLowerCase().trim(),
      customers: [],
      licenses: [],
      pendingSites: [],
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000)
    };
  }
  
  // Find or create customer
  let customer = user.customers.find(c => c.customerId === customerId);
  if (!customer) {
    customer = {
      customerId: customerId,
      subscriptions: [],
      created_at: Math.floor(Date.now() / 1000)
    };
    user.customers.push(customer);
  }
  
  // Find or create subscription
  let subscription = customer.subscriptions.find(s => s.subscriptionId === subscriptionId);
  if (!subscription) {
    subscription = {
      subscriptionId: subscriptionId,
      status: 'active',
      items: [],
      billingPeriod: billingPeriod, // Add billing period if provided
      created_at: Math.floor(Date.now() / 1000)
    };
    customer.subscriptions.push(subscription);
  } else {
    // Update billing period if provided and not already set
    if (billingPeriod && !subscription.billingPeriod) {
      subscription.billingPeriod = billingPeriod;
    }
  }
  
  // Add/update items (merge with existing, avoid duplicates)
  items.forEach(item => {
    const existingItem = subscription.items.find(i => i.item_id === item.item_id);
    if (existingItem) {
      // Update existing item
      Object.assign(existingItem, item);
    } else {
      // Add new item
      subscription.items.push(item);
    }
  });
  
  // Update subscription status and timestamp
  subscription.status = 'active';
  subscription.updated_at = Math.floor(Date.now() / 1000);
  
  await saveUserByEmail(env, email, user);
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
    license_key,
    trial_end
  } = queueItem;
  
  try {
    // Check if subscription already exists for this license (may have been created immediately)
    let existingSubscriptionId = null;
    try {
      const existingLicense = await env.DB.prepare(
        `SELECT subscription_id FROM licenses WHERE license_key = ? AND subscription_id IS NOT NULL`
      ).bind(license_key).first();
      
      if (existingLicense && existingLicense.subscription_id) {
        existingSubscriptionId = existingLicense.subscription_id;
      }
    } catch (checkErr) {
      console.warn(`[QUEUE] ⚠️ Could not check for existing subscription:`, checkErr);
    }
    
    // If subscription already exists, mark queue item as completed and return
    if (existingSubscriptionId) {
      const timestamp = Math.floor(Date.now() / 1000);
      const existingLicense = await env.DB.prepare(
        `SELECT item_id FROM licenses WHERE license_key = ? AND subscription_id = ?`
      ).bind(license_key, existingSubscriptionId).first();
      
      const itemId = existingLicense?.item_id || null;
      
      await env.DB.prepare(
        `UPDATE subscription_queue 
         SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
         WHERE queue_id = ?`
      ).bind(existingSubscriptionId, itemId, timestamp, timestamp, queue_id).run();
      
      return { success: true, subscriptionId: existingSubscriptionId, itemId, skipped: true };
    }
    
    // Create subscription
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
      
      const timestamp = Math.floor(Date.now() / 1000);
      
      // Update queue item as completed
      await env.DB.prepare(
        `UPDATE subscription_queue 
         SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
         WHERE queue_id = ?`
      ).bind(subscriptionId, itemId, timestamp, timestamp, queue_id).run();
      
      // Save license to database (for dashboard display)
      try {
        await env.DB.prepare(
          `INSERT INTO licenses 
           (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          license_key,
          customer_id,
          subscriptionId,
          itemId || null,
          null,
          null,
          'active',
          'quantity',
          timestamp,
          timestamp
        ).run();
      } catch (licenseErr) {
        if (licenseErr.message && licenseErr.message.includes('UNIQUE constraint')) {
          console.warn(`[QUEUE] ⚠️ License ${license_key} already exists in database, skipping`);
        } else {
          console.error(`[QUEUE] ❌ Error saving license ${license_key}:`, licenseErr);
          // Don't fail the whole operation if license save fails - subscription was created successfully
        }
      }
      
      // Save subscription record to subscriptions table (for dashboard)
      try {
        await env.DB.prepare(
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
          null, // billing_period (can be fetched later if needed)
          timestamp,
          timestamp
        ).run();
      } catch (subErr) {
        console.error(`[QUEUE] ⚠️ Error saving subscription record:`, subErr);
        // Don't fail the whole operation if subscription record save fails
      }
      
      // Save payment record (for dashboard payment history)
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
        console.error(`[QUEUE] ⚠️ Error saving payment record:`, paymentErr);
        // Don't fail the whole operation if payment record save fails
      }
      
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
async function processSubscriptionQueue(env, limit = 10) {
  const timestamp = Math.floor(Date.now() / 1000);
  
  try {
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
    
    
    let successCount = 0;
    let failCount = 0;
    
    for (const item of queueItems.results) {
      // Mark as processing
      await env.DB.prepare(
        `UPDATE subscription_queue SET status = 'processing', updated_at = ? WHERE queue_id = ?`
      ).bind(timestamp, item.queue_id).run();
      
      const result = await processQueueItem(env, item);
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
      
      // Small delay between processing to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return { processed: queueItems.results.length, successCount, failCount };
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
  async scheduled(event, env, ctx) {
    
    try {
      // Process up to 50 queue items per run (adjust based on your needs)
      const queueResult = await processSubscriptionQueue(env, 50);
      
      
      // Process refunds for failed items older than 12 hours
      const refundResult = await processRefundsForOldFailedItems(env, 50);
      
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
      console.error(`[SCHEDULED] Error processing queue:`, error);
      
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

        // Log all webhook events for debugging
        
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
          
          const example_object=`{
  "object": {
    "id": "cs_test_a1JjTk6wNepu1ubanKYxj03OB1ebzEvhbD7JrAHa1JrzGPo8XbemeyCc9f",
    "object": "checkout.session",
    "adaptive_pricing": {
      "enabled": false
    },
    "after_expiration": null,
    "allow_promotion_codes": false,
    "amount_subtotal": 200,
    "amount_total": 200,
    "automatic_tax": {
      "enabled": false,
      "liability": null,
      "provider": null,
      "status": null
    },
    "billing_address_collection": "auto",
    "cancel_url": "https://stripe.com",
    "client_reference_id": null,
    "client_secret": null,
    "collected_information": {
      "business_name": null,
      "individual_name": null,
      "shipping_details": null
    },
    "consent": null,
    "consent_collection": {
      "payment_method_reuse_agreement": null,
      "promotions": "none",
      "terms_of_service": "none"
    },
    "created": 1766587887,
    "currency": "usd",
    "currency_conversion": null,
    "custom_fields": [
      {
        "key": "enteryourlivedomain",
        "label": {
          "custom": "Enter your Live Domain",
          "type": "custom"
        },
        "optional": false,
        "text": {
          "default_value": null,
          "maximum_length": null,
          "minimum_length": null,
          "value": "www.test.com"
        },
        "type": "text"
      }
    ],
    "custom_text": {
      "after_submit": null,
      "shipping_address": null,
      "submit": null,
      "terms_of_service_acceptance": null
    },
    "customer": "cus_TfDrvl3iCdWirl",
    "customer_account": null,
    "customer_creation": "if_required",
    "customer_details": {
      "address": {
        "city": "Washington",
        "country": "IN",
        "line1": "Albin",
        "line2": "abc",
        "postal_code": "467868",
        "state": "KL"
      },
      "business_name": null,
      "email": "reshma@seattlenewmedia.com",
      "individual_name": null,
      "name": "meena",
      "phone": null,
      "tax_exempt": "none",
      "tax_ids": []
    },
    "customer_email": null,
    "discounts": [],
    "expires_at": 1766674287,
    "invoice": "in_1ShtPvSAczuHLTOtQ2c4nD54",
    "invoice_creation": null,
    "livemode": false,
    "locale": "auto",
    "metadata": {},
    "mode": "subscription",
    "origin_context": null,
    "payment_intent": null,
    "payment_link": "plink_1ShWZUSAczuHLTOtiAmIzgJt",
    "payment_method_collection": "always",
    "payment_method_configuration_details": {
      "id": "pmc_1Q3NUpSAczuHLTOtmYftKx5t",
      "parent": null
    },
    "payment_method_options": {
      "card": {
        "request_three_d_secure": "automatic"
      }
    },
    "payment_method_types": [
      "card"
    ],
    "payment_status": "paid",
    "permissions": null,
    "phone_number_collection": {
      "enabled": false
    },
    "recovered_from": null,
    "saved_payment_method_options": {
      "allow_redisplay_filters": [
        "always"
      ],
      "payment_method_remove": "disabled",
      "payment_method_save": null
    },
    "setup_intent": null,
    "shipping_address_collection": null,
    "shipping_cost": null,
    "shipping_details": null,
    "shipping_options": [],
    "status": "complete",
    "submit_type": "auto",
    "subscription": "sub_1ShtQ2SAczuHLTOt8gzoOZjs",
    "success_url": "https://memberstack-login-test-713fa5.webflow.io?session_id={CHECKOUT_SESSION_ID}",
    "total_details": {
      "amount_discount": 0,
      "amount_shipping": 0,
      "amount_tax": 0
    },
    "ui_mode": "hosted",
    "url": null,
    "wallet_options": null
  },
  "previous_attributes": null
}`;
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
          if (identifiedUseCase === '3') {
            
            // ========================================
            // USE CASE 3 HANDLER: Quantity Purchase
            // ========================================
            // Get payment_intent from session
            const paymentIntentId = session.payment_intent;
            if (paymentIntentId && typeof paymentIntentId === 'string') {
              try {
                // Fetch payment intent to get metadata
                const piRes = await stripeFetch(env, `/payment_intents/${paymentIntentId}`);
                if (piRes.status === 200) {
                  const paymentIntent = piRes.body;
                  let metadata = paymentIntent.metadata || {};
                  
                  // Also check charge metadata
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
                  
                  // Process Use Case 3 if metadata is correct
                  if (metadata.usecase === '3') {
                    
                    // Use session.customer directly (following Stripe docs pattern)
                    const useCase3CustomerId = session.customer || metadata.customer_id || paymentIntent.customer;
                    
                    // Check if already processed by checking if licenses exist (idempotency)
                    let licenseKeys = [];
                    try {
                      if (metadata.license_keys) {
                        licenseKeys = JSON.parse(metadata.license_keys);
                      }
                    } catch (e) {
                      console.error(`[checkout.session.completed] Error parsing license_keys:`, e);
                    }
                    
                    if (env.DB && licenseKeys.length > 0) {
                      try {
                        const existingLicenseCheck = await env.DB.prepare(
                          `SELECT license_key FROM licenses WHERE license_key = ? LIMIT 1`
                        ).bind(licenseKeys[0]).first();
                        
                        if (existingLicenseCheck) {
                          return new Response('ok');
                        }
                      } catch (checkErr) {
                        console.warn(`[checkout.session.completed] Could not check existing licenses:`, checkErr);
                      }
                    }
                    
                    // Get user email
                    const userEmail = await getCustomerEmail(env, useCase3CustomerId);
                    if (!userEmail) {
                      console.warn('[checkout.session.completed] User email not found for Use Case 3');
                      return new Response('ok');
                    }
                    
                    // Parse metadata
                    let priceId = null;
                    let quantity = 0;
                    
                    try {
                      if (metadata.license_keys) {
                        licenseKeys = JSON.parse(metadata.license_keys);
                      } else {
                        console.warn(`[checkout.session.completed] ⚠️ No license_keys found in metadata. Available keys: ${Object.keys(metadata).join(', ')}`);
                      }
                      priceId = metadata.price_id || null;
                      quantity = parseInt(metadata.quantity) || licenseKeys.length || 0;
                    } catch (parseErr) {
                      console.error('[checkout.session.completed] ❌ Error parsing metadata:', parseErr);
                    }
                    
                    // ========================================
                    // STEP 1: FIRST - Save payment method to customer
                    // Following Stripe's recommended pattern exactly
                    // Reference: https://stripe.com/docs/payments/save-during-payment
                    // MUST complete successfully before proceeding to create subscriptions
                    // ========================================
                    // Get payment method from payment intent (session.payment_method may not be available)
                    let paymentMethodId = paymentIntent.payment_method;
                    
                    // If not in payment intent, try to get from charge
                    if (!paymentMethodId && paymentIntent.latest_charge) {
                      try {
                        const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
                        if (chargeRes.status === 200 && chargeRes.body.payment_method) {
                          paymentMethodId = chargeRes.body.payment_method;
                        }
                      } catch (chargeErr) {
                        console.warn(`[checkout.session.completed] Could not fetch charge for payment method:`, chargeErr);
                      }
                    }
                    
                    // Use session.customer (primary) or fallback to paymentIntent.customer
                    const customerIdForPaymentMethod = session.customer || paymentIntent.customer || useCase3CustomerId;
                    
                    let paymentMethodSaved = false;
                    if (paymentMethodId && customerIdForPaymentMethod) {
                      try {
                        
                        // Attach the payment method used in checkout to the customer
                        const attachRes = await stripeFetch(env, `/payment_methods/${paymentMethodId}/attach`, 'POST', {
                          'customer': customerIdForPaymentMethod
                        }, true);
                        
                        if (attachRes.status === 200) {
                          // Set it as the default payment method
                          const setDefaultRes = await stripeFetch(env, `/customers/${customerIdForPaymentMethod}`, 'POST', {
                            'invoice_settings[default_payment_method]': paymentMethodId
                          }, true);
                          
                          if (setDefaultRes.status === 200) {
                            paymentMethodSaved = true;
                          } else {
                            console.warn(`[checkout.session.completed] ⚠️ Payment method attached but failed to set as default:`, setDefaultRes.status, setDefaultRes.body);
                          }
                        } else {
                          // Check if it's already attached
                          const errorMessage = attachRes.body?.error?.message || '';
                          if (errorMessage.includes('already attached') || errorMessage.includes('already been attached')) {
                            // Just set as default
                            const setDefaultRes = await stripeFetch(env, `/customers/${customerIdForPaymentMethod}`, 'POST', {
                              'invoice_settings[default_payment_method]': paymentMethodId
                            }, true);
                            
                            if (setDefaultRes.status === 200) {
                              paymentMethodSaved = true;
                            } else {
                              console.warn(`[checkout.session.completed] ⚠️ Failed to set payment method as default:`, setDefaultRes.status, setDefaultRes.body);
                            }
                          } else {
                            console.error(`[checkout.session.completed] ❌ STEP 1 FAILED: Failed to attach payment method:`, attachRes.status, attachRes.body);
                          }
                        }
                      } catch (attachErr) {
                        console.error(`[checkout.session.completed] ❌ STEP 1 FAILED: Error attaching payment method:`, attachErr);
                      }
                    } else {
                      console.error(`[checkout.session.completed] ❌ STEP 1 FAILED: Missing payment_method or customer. payment_method: ${paymentMethodId}, customer: ${customerIdForPaymentMethod}`);
                    }
                    
                    // ========================================
                    // STEP 2: THEN - Create subscriptions (only if payment method was saved)
                    // No need to specify payment_method since we set the default above
                    // Following Stripe's recommended pattern
                    // ========================================
                    const createdSubscriptionIds = [];
                    // Use the same customer ID we used for payment method attachment
                    const customerIdForSubscriptions = customerIdForPaymentMethod || session.customer || useCase3CustomerId;
                    
                    // Debug logging to understand why subscriptions aren't being created
                    
                    // Declare these at a higher scope so they're available for license key storage
                    const failedSubscriptions = []; // Track failed subscriptions for refund
                    const failedLicenseKeys = []; // Track license keys for failed subscriptions
                    const successfulLicenseSubscriptions = []; // Track successful license-subscription pairs: {licenseKey, subscriptionId, itemId}
                    const savedLicenseKeys = new Set(); // Track which licenses have been saved to prevent duplicates
                    
                    if (paymentMethodSaved && priceId && quantity > 0 && customerIdForSubscriptions) {
                      try {
                        
                        // Calculate trial_end ONCE before loop - all subscriptions get same trial_end
                        // Use trial_end to skip first invoice (payment already collected via checkout)
                        // Trial prevents invoice creation until trial ends
                        // Priority: Custom trial days (env/metadata) > Billing interval > Default (30 days)
                        const now = Math.floor(Date.now() / 1000);
                        
                        // Check for custom trial period (environment variable or metadata)
                        let trialPeriodDays = null;
                        if (env.TRIAL_PERIOD_DAYS) {
                          trialPeriodDays = parseInt(env.TRIAL_PERIOD_DAYS);
                        } else if (session.metadata?.trial_period_days) {
                          trialPeriodDays = parseInt(session.metadata.trial_period_days);
                        }
                        
                        // Get price details to determine billing interval (if no custom trial period)
                        let trialPeriodSeconds = 30 * 24 * 60 * 60; // Default: 30 days (monthly)
                        let billingInterval = 'month'; // Default
                        
                        if (trialPeriodDays) {
                          // Use custom trial period
                          trialPeriodSeconds = trialPeriodDays * 24 * 60 * 60;
                        } else {
                          // Calculate based on billing interval
                          try {
                            const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                            if (priceRes.status === 200 && priceRes.body.recurring) {
                              billingInterval = priceRes.body.recurring.interval;
                              const intervalCount = priceRes.body.recurring.interval_count || 1;
                              
                              // Calculate trial period based on billing interval
                              if (billingInterval === 'week') {
                                trialPeriodSeconds = 7 * 24 * 60 * 60 * intervalCount; // Weekly
                              } else if (billingInterval === 'month') {
                                trialPeriodSeconds = 30 * 24 * 60 * 60 * intervalCount; // Monthly (approximate)
                              } else if (billingInterval === 'year') {
                                trialPeriodSeconds = 365 * 24 * 60 * 60 * intervalCount; // Yearly
                              } else if (billingInterval === 'day') {
                                trialPeriodSeconds = 24 * 60 * 60 * intervalCount; // Daily
                              }
                              
                            }
                          } catch (priceErr) {
                            console.warn(`[checkout.session.completed] ⚠️ Could not fetch price details, using default 30 days:`, priceErr);
                          }
                        }
                        
                        const trialEndTime = now + trialPeriodSeconds;
                        
                        // Ensure trial_end is at least 1 hour in the future (Stripe requirement)
                        // For daily billing, use at least 7 days to prevent immediate invoice creation
                        const minimumTrialEnd = billingInterval === 'day' 
                          ? now + (7 * 24 * 60 * 60) // 7 days minimum for daily billing
                          : now + 3600; // 1 hour minimum for other intervals
                        const trialEnd = Math.max(trialEndTime, minimumTrialEnd);
                        
                        const trialSource = trialPeriodDays ? `custom (${trialPeriodDays} days)` : `billing interval (${billingInterval})`;
                        
                        // QUEUE-BASED PROCESSING: For large quantities (>10), use queue to prevent timeouts
                        // For smaller quantities, process immediately
                        const USE_QUEUE_THRESHOLD = 10; // Use queue for quantities > 10
                        const BATCH_SIZE = 5; // Process 5 subscriptions per batch (for immediate processing)
                        const DELAY_BETWEEN_BATCHES = 200; // 200ms delay between batches
                        
                        // Initialize queue tracking variables (used in both QUEUE and IMMEDIATE modes)
                        let queuedCount = 0;
                        let queueErrors = 0;
                        
                        if (quantity > USE_QUEUE_THRESHOLD) {
                          // QUEUE MODE: Add all subscriptions to queue for async processing
                          
                          for (let i = 0; i < quantity; i++) {
                            const queueResult = await addToSubscriptionQueue(env, {
                              customerId: customerIdForSubscriptions,
                              userEmail: userEmail,
                              paymentIntentId: paymentIntent.id,
                              priceId: priceId,
                              licenseKey: licenseKeys[i],
                              quantity: 1,
                              trialEnd: trialEnd
                            });
                            
                            if (queueResult.success) {
                              queuedCount++;
                            } else {
                              queueErrors++;
                              // Track failed queue additions for refund
                              failedSubscriptions.push({ 
                                licenseKey: licenseKeys[i], 
                                reason: 'queue_add_failed',
                                error: queueResult.error 
                              });
                              failedLicenseKeys.push(licenseKeys[i]);
                            }
                          }
                          
                          
                          // Process first batch immediately if possible (to give user immediate feedback)
                          const IMMEDIATE_BATCH_SIZE = Math.min(5, quantity);
                          
                          // Track which queue items were processed immediately so we can mark them as completed
                          const immediateQueueIds = [];
                          
                          for (let i = 0; i < IMMEDIATE_BATCH_SIZE; i++) {
                            try {
                              const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
                                'customer': customerIdForSubscriptions,
                                'items[0][price]': priceId,
                                'items[0][quantity]': 1,
                                'metadata[license_key]': licenseKeys[i],
                                'metadata[usecase]': '3',
                                'metadata[purchase_type]': 'quantity',
                                'proration_behavior': 'none',
                                'collection_method': 'charge_automatically',
                                'trial_end': trialEnd.toString()
                              }, true);
                              
                              if (createSubRes.status === 200) {
                                const newSubscription = createSubRes.body;
                                createdSubscriptionIds.push(newSubscription.id);
                                const itemId = newSubscription.items?.data?.[0]?.id || null;
                                
                                successfulLicenseSubscriptions.push({
                                  licenseKey: licenseKeys[i],
                                  subscriptionId: newSubscription.id,
                                  itemId: itemId
                                });
                                
                                
                                // Find and mark the corresponding queue item as completed
                                // Queue ID format: queue_{paymentIntentId}_{licenseKey}_{timestamp}
                                try {
                                  const queueResult = await env.DB.prepare(
                                    `SELECT queue_id FROM subscription_queue 
                                     WHERE payment_intent_id = ? AND license_key = ? AND status = 'pending'
                                     ORDER BY created_at ASC LIMIT 1`
                                  ).bind(paymentIntent.id, licenseKeys[i]).first();
                                  
                                  if (queueResult && queueResult.queue_id) {
                                    immediateQueueIds.push(queueResult.queue_id);
                                    const timestamp = Math.floor(Date.now() / 1000);
                                    await env.DB.prepare(
                                      `UPDATE subscription_queue 
                                       SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
                                       WHERE queue_id = ?`
                                    ).bind(newSubscription.id, itemId, timestamp, timestamp, queueResult.queue_id).run();
                                  }
                                } catch (queueUpdateErr) {
                                  console.warn(`[checkout.session.completed] ⚠️ Could not mark queue item as completed for license ${licenseKeys[i]}:`, queueUpdateErr);
                                  // Don't fail - subscription was created successfully
                                }
                              }
                            } catch (error) {
                              console.error(`[checkout.session.completed] ❌ Error creating immediate subscription ${i + 1}:`, error);
                            }
                          }
                          
                          if (immediateQueueIds.length > 0) {
                          }
                        } else {
                          // IMMEDIATE MODE: Process all subscriptions immediately (for small quantities)
                          const totalBatches = Math.ceil(quantity / BATCH_SIZE);
                          
                          for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                          const batchNumber = batchIndex + 1;
                          const startIndex = batchIndex * BATCH_SIZE;
                          const endIndex = Math.min(startIndex + BATCH_SIZE, quantity);
                          const batchSize = endIndex - startIndex;
                          
                          
                          // Process each subscription in the current batch
                          for (let i = startIndex; i < endIndex; i++) {
                            const positionInBatch = (i % BATCH_SIZE) + 1;
                            
                            try {
                              // OPTIMIZATION: No delay between subscriptions - process as fast as possible
                              // Stripe can handle rapid sequential requests for the same customer
                            
                              // Create subscription - uses default payment method we set above
                            // All subscriptions use the same trial_end calculated above
                            const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
                            'customer': customerIdForSubscriptions,
                            'items[0][price]': priceId,
                            'items[0][quantity]': 1,
                            'metadata[license_key]': licenseKeys[i],
                            'metadata[usecase]': '3',
                            'metadata[purchase_type]': 'quantity',
                            'proration_behavior': 'none',
                            'collection_method': 'charge_automatically', // Use automatic charging
                            'trial_end': trialEnd.toString(), // Skip first invoice - payment already collected via checkout
                            // No need to specify payment_method - uses default we set above
                          }, true);
                          
                          
                          if (createSubRes.status === 200) {
                            const newSubscription = createSubRes.body;
                            createdSubscriptionIds.push(newSubscription.id);
                            const itemId = newSubscription.items?.data?.[0]?.id || null;
                            
                            // Verify payment was successful
                            // With trial_end, no invoice should be created until trial ends
                            // Payment already collected via checkout, so we just verify payment success
                            const paymentVerified = verifyPaymentSuccess(session, paymentIntent);
                            
                            if (!paymentVerified) {
                              console.error(`[checkout.session.completed] ❌ Payment verification failed. Session payment_status: ${session.payment_status}, Session status: ${session.status}, PaymentIntent status: ${paymentIntent?.status || 'N/A'}`);
                              // Track as failed for refund
                              failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'payment_verification_failed' });
                              failedLicenseKeys.push(licenseKeys[i]);
                              // Don't add to successfulLicenseSubscriptions - subscription created but payment not verified
                            } else {
                              // Payment verified - subscription created with trial_end (no invoice until trial ends)
                              
                              // OPTIMIZATION: Only check invoice if it exists AND we're processing a small batch
                              // For large batches (>10), skip invoice checking to avoid timeout - handle refunds in background
                              // With 7-day minimum trial for daily billing, invoices shouldn't be created anyway
                              if (newSubscription.latest_invoice && quantity <= 10) {
                                const invoiceId = typeof newSubscription.latest_invoice === 'string' 
                                  ? newSubscription.latest_invoice 
                                  : newSubscription.latest_invoice.id;
                                
                                try {
                                  const invoiceRes = await stripeFetch(env, `/invoices/${invoiceId}`);
                                  if (invoiceRes.status === 200) {
                                    const invoice = invoiceRes.body;
                                    if (invoice.status === 'open' || invoice.status === 'draft') {
                                      // Immediately void/delete to prevent auto-payment
                                      if (invoice.status === 'open') {
                                        await stripeFetch(env, `/invoices/${invoiceId}/void`, 'POST', {}, true);
                                      } else {
                                        await stripeFetch(env, `/invoices/${invoiceId}`, 'DELETE', {}, false);
                                      }
                                    } else if (invoice.status === 'paid') {
                                      // Invoice was auto-paid - log for background processing
                                      console.warn(`[checkout.session.completed] ⚠️ Invoice ${invoiceId} was auto-paid - will be refunded in background`);
                                      // Store for background refund processing (don't block here)
                                      failedSubscriptions.push({ 
                                        licenseKey: licenseKeys[i], 
                                        reason: 'auto_paid_invoice_needs_refund', 
                                        invoiceId: invoiceId,
                                        subscriptionId: newSubscription.id
                                      });
                                    }
                                  }
                                } catch (invoiceErr) {
                                  console.warn(`[checkout.session.completed] ⚠️ Error handling unexpected invoice:`, invoiceErr);
                                }
                              } else if (newSubscription.latest_invoice && quantity > 10) {
                                // For large batches, just log and handle in background
                                const invoiceId = typeof newSubscription.latest_invoice === 'string' 
                                  ? newSubscription.latest_invoice 
                                  : newSubscription.latest_invoice.id;
                                console.warn(`[checkout.session.completed] ⚠️ Subscription ${newSubscription.id} has invoice ${invoiceId} - skipping check for large batch (will handle in background)`);
                                // Store for background processing
                                failedSubscriptions.push({ 
                                  licenseKey: licenseKeys[i], 
                                  reason: 'invoice_check_skipped_large_batch', 
                                  invoiceId: invoiceId,
                                  subscriptionId: newSubscription.id
                                });
                              }
                            }
                            
                            // Track as successful if subscription was created (even if invoice was auto-paid and refunded)
                            // The subscription is valid - we just need to handle the duplicate payment via refund
                            if (createSubRes.status === 200) {
                              successfulLicenseSubscriptions.push({
                                licenseKey: licenseKeys[i],
                                subscriptionId: newSubscription.id,
                                itemId: itemId
                              });
                            } else {
                              console.warn(`[checkout.session.completed] ⚠️ Subscription creation failed, not adding to successful list`);
                            }
                            
                            // OPTIMIZATION: Skip metadata update for large batches to save time
                            if (itemId && quantity <= 10) {
                              await stripeFetch(env, `/subscription_items/${itemId}`, 'POST', {
                                'metadata[license_key]': licenseKeys[i]
                              }, true);
                            } else if (itemId && quantity > 10) {
                              // For large batches, skip metadata update to save time - can be done later
                            }
                          } else {
                            console.error(`[checkout.session.completed] ❌ Failed to create subscription ${i + 1}/${quantity}:`, createSubRes.status, createSubRes.body);
                            // Track failed subscription for refund
                            failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'subscription_creation_failed', status: createSubRes.status });
                            failedLicenseKeys.push(licenseKeys[i]);
                            // Continue to next subscription even if this one failed
                          }
                          } catch (subError) {
                            // Catch any errors during subscription creation to ensure loop continues
                            console.error(`[checkout.session.completed] ❌ Error creating subscription ${i + 1}/${quantity} for license ${licenseKeys[i]}:`, subError);
                            failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'subscription_creation_error', error: subError.message || String(subError) });
                            failedLicenseKeys.push(licenseKeys[i]);
                            // Continue to next subscription
                          }
                          } // End of inner loop (subscriptions in batch)
                          
                          // Batch completed - log summary
                          
                          // OPTIMIZATION: Save licenses incrementally after each batch to prevent data loss on timeout
                          // This ensures licenses are saved even if webhook times out before all batches complete
                          if (env.DB && successfulLicenseSubscriptions.length > 0) {
                            const timestamp = Math.floor(Date.now() / 1000);
                            let batchLicensesSaved = 0;
                            
                            // Save all licenses created in this batch (those with indices in the current batch range)
                            for (let i = startIndex; i < endIndex; i++) {
                              const licenseKey = licenseKeys[i];
                              
                              // Skip if already saved
                              if (savedLicenseKeys.has(licenseKey)) {
                                continue;
                              }
                              
                              // Find the corresponding subscription data
                              const licenseSub = successfulLicenseSubscriptions.find(s => s.licenseKey === licenseKey);
                              if (!licenseSub) {
                                continue; // Subscription wasn't created successfully for this license
                              }
                              
                              const { subscriptionId, itemId } = licenseSub;
                              
                              try {
                                const existingLicense = await env.DB.prepare(
                                  `SELECT license_key FROM licenses WHERE license_key = ?`
                                ).bind(licenseKey).first();
                                
                                if (existingLicense) {
                                  savedLicenseKeys.add(licenseKey);
                                  continue;
                                }
                                
                                await env.DB.prepare(
                                  `INSERT INTO licenses 
                                   (license_key, customer_id, subscription_id, item_id, 
                                    site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                                ).bind(
                                  licenseKey,
                                  customerIdForSubscriptions,
                                  subscriptionId,
                                  itemId || null,
                                  null,
                                  null,
                                  'active',
                                  'quantity',
                                  timestamp,
                                  timestamp
                                ).run();
                                
                                savedLicenseKeys.add(licenseKey);
                                batchLicensesSaved++;
                              } catch (insertErr) {
                                if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                                  savedLicenseKeys.add(licenseKey);
                                  console.warn(`[checkout.session.completed] ⚠️ License key ${licenseKey} already exists, skipping`);
                                } else {
                                  console.error(`[checkout.session.completed] ❌ Error storing license ${licenseKey}:`, insertErr);
                                }
                              }
                            }
                            
                            if (batchLicensesSaved > 0) {
                            }
                          }
                          
                          // Add delay between batches (except after the last batch)
                          if (batchIndex < totalBatches - 1) {
                            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
                          }
                        } // End of outer loop (batches) - IMMEDIATE MODE
                        
                        } // End of else block (IMMEDIATE MODE)
                        
                        // Check if all subscriptions were created - if not, add missing ones to failed list for refund
                        // This applies to both QUEUE MODE and IMMEDIATE MODE
                        // IMPORTANT: In QUEUE MODE, we should NOT count queued items as "missing" - they will be processed asynchronously
                        let missingCount = 0;
                        
                        if (quantity > USE_QUEUE_THRESHOLD) {
                          // QUEUE MODE: Only count items that failed to queue or failed to create immediately
                          // Items that were successfully queued should NOT be counted as missing
                          const queuedSuccessfully = queuedCount;
                          const processedImmediately = createdSubscriptionIds.length;
                          const failedToQueue = queueErrors;
                          const failedToCreate = failedSubscriptions.length;
                          
                          // Missing = total - (queued successfully + processed immediately + failed)
                          // But we only want to refund items that actually failed, not items that are queued
                          missingCount = quantity - (queuedSuccessfully + processedImmediately + failedToQueue + failedToCreate);
                          
                          if (missingCount > 0) {
                            console.warn(`[checkout.session.completed] ⚠️ WARNING: ${missingCount} subscription(s) were not processed (webhook may have timed out). Adding to failed list for refund.`);
                            
                            // Find which license keys weren't processed (not queued, not created, not failed)
                            const processedLicenseKeys = new Set([
                              ...successfulLicenseSubscriptions.map(s => s.licenseKey),
                              ...failedLicenseKeys
                            ]);
                            
                            // Also check which ones were successfully queued
                            let queuedLicenseKeys = new Set();
                            if (env.DB) {
                              try {
                                const queuedResult = await env.DB.prepare(
                                  `SELECT license_key FROM subscription_queue 
                                   WHERE payment_intent_id = ? AND status = 'pending'`
                                ).bind(paymentIntent.id).all();
                                
                                if (queuedResult.success) {
                                  queuedLicenseKeys = new Set(queuedResult.results.map(r => r.license_key));
                                }
                              } catch (queueCheckErr) {
                                console.warn(`[checkout.session.completed] ⚠️ Could not check queued items:`, queueCheckErr);
                              }
                            }
                            
                            for (let i = 0; i < licenseKeys.length; i++) {
                              // Only add to failed if it wasn't processed AND wasn't queued
                              if (!processedLicenseKeys.has(licenseKeys[i]) && !queuedLicenseKeys.has(licenseKeys[i])) {
                                failedSubscriptions.push({ 
                                  licenseKey: licenseKeys[i], 
                                  reason: 'not_processed_timeout', 
                                  index: i + 1 
                                });
                                failedLicenseKeys.push(licenseKeys[i]);
                                console.warn(`[checkout.session.completed] ⚠️ License ${licenseKeys[i]} (subscription ${i + 1}/${quantity}) was not processed - will be refunded`);
                              }
                            }
                          } else {
                          }
                        } else {
                          // IMMEDIATE MODE: Count all items that weren't created
                          const totalProcessed = createdSubscriptionIds.length + failedSubscriptions.length;
                          missingCount = quantity - totalProcessed;
                          
                          if (missingCount > 0) {
                            console.warn(`[checkout.session.completed] ⚠️ WARNING: ${missingCount} subscription(s) were not processed (webhook may have timed out). Adding to failed list for refund.`);
                            
                            // Find which license keys weren't processed
                            const processedLicenseKeys = new Set([
                              ...successfulLicenseSubscriptions.map(s => s.licenseKey),
                              ...failedLicenseKeys
                            ]);
                            
                            for (let i = 0; i < licenseKeys.length; i++) {
                              if (!processedLicenseKeys.has(licenseKeys[i])) {
                                failedSubscriptions.push({ 
                                  licenseKey: licenseKeys[i], 
                                  reason: 'not_processed_timeout', 
                                  index: i + 1 
                                });
                                failedLicenseKeys.push(licenseKeys[i]);
                                console.warn(`[checkout.session.completed] ⚠️ License ${licenseKeys[i]} (subscription ${i + 1}/${quantity}) was not processed - will be refunded`);
                              }
                            }
                          }
                        }
                        
                        // ========================================
                        // REFUND LOGIC: If any subscriptions failed or weren't processed, refund the failed portion
                        // ========================================
                        // REFUND CODE COMMENTED OUT - DO NOT REFUND AUTOMATICALLY
                        /*
                        if (failedSubscriptions.length > 0) {
                          console.warn(`[checkout.session.completed] ⚠️ ${failedSubscriptions.length} subscription(s) failed to create. Processing refund for failed subscriptions...`);
                          
                          try {
                            // Get payment intent charge ID for refund
                            let chargeId = null;
                            if (paymentIntent?.latest_charge) {
                              chargeId = typeof paymentIntent.latest_charge === 'string' 
                                ? paymentIntent.latest_charge 
                                : paymentIntent.latest_charge.id;
                            } else if (paymentIntent?.charges?.data?.length > 0) {
                              chargeId = paymentIntent.charges.data[0].id;
                            }
                            
                            if (!chargeId && session.payment_intent) {
                              // Fetch payment intent to get charge
                              try {
                                const piRes = await stripeFetch(env, `/payment_intents/${session.payment_intent}`);
                                if (piRes.status === 200) {
                                  const pi = piRes.body;
                                  chargeId = pi.latest_charge || (pi.charges?.data?.[0]?.id);
                                }
                              } catch (piErr) {
                                console.warn(`[checkout.session.completed] Could not fetch payment intent for refund:`, piErr);
                              }
                            }
                            
                            if (chargeId) {
                              // Get price details to calculate refund amount
                              let refundAmount = 0;
                              let currency = 'usd';
                              
                              try {
                                const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                                if (priceRes.status === 200) {
                                  const price = priceRes.body;
                                  const unitPrice = price.unit_amount || 0;
                                  currency = price.currency || 'usd';
                                  refundAmount = unitPrice * failedSubscriptions.length;
                                }
                              } catch (priceErr) {
                                console.warn(`[checkout.session.completed] ⚠️ Could not get price for refund calculation:`, priceErr);
                                // Fallback: Use payment intent amount divided by quantity
                                if (paymentIntent?.amount && quantity > 0) {
                                  refundAmount = Math.round((paymentIntent.amount / quantity) * failedSubscriptions.length);
                                  currency = paymentIntent.currency || 'usd';
                                }
                              }
                              
                              if (refundAmount > 0) {
                                // Create refund
                                const refundRes = await stripeFetch(env, '/refunds', 'POST', {
                                  'charge': chargeId,
                                  'amount': refundAmount,
                                  'metadata[reason]': 'subscription_creation_failed',
                                  'metadata[failed_count]': failedSubscriptions.length.toString(),
                                  'metadata[failed_license_keys]': JSON.stringify(failedLicenseKeys)
                                }, true);
                                
                                if (refundRes.status === 200) {
                                  const refund = refundRes.body;
                                  
                                  // Save refund record to database
                                  if (env.DB) {
                                    try {
                                      const timestamp = Math.floor(Date.now() / 1000);
                                      await env.DB.prepare(
                                        `INSERT INTO refunds (
                                          refund_id, payment_intent_id, charge_id, customer_id, user_email,
                                          amount, currency, status, reason, queue_id, license_key,
                                          subscription_id, attempts, metadata, created_at, updated_at
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                                      ).bind(
                                        refund.id,
                                        paymentIntent?.id || session.payment_intent,
                                        chargeId,
                                        customerIdForSubscriptions,
                                        session.customer_email || null,
                                        refundAmount,
                                        currency,
                                        refund.status || 'succeeded',
                                        'subscription_creation_failed',
                                        null, // queue_id (not from queue)
                                        null, // license_key (multiple licenses)
                                        null, // subscription_id (not created)
                                        null, // attempts
                                        JSON.stringify({
                                          reason: 'subscription_creation_failed',
                                          failed_count: failedSubscriptions.length,
                                          payment_intent_id: paymentIntent?.id || session.payment_intent,
                                          customer_id: customerIdForSubscriptions
                                        }),
                                        timestamp,
                                        timestamp
                                      ).run();
                                    } catch (refundDbErr) {
                                      if (refundDbErr.message && refundDbErr.message.includes('UNIQUE constraint')) {
                                        console.warn(`[checkout.session.completed] ⚠️ Refund ${refund.id} already exists in database, skipping`);
                                      } else {
                                        console.error(`[checkout.session.completed] ⚠️ Error saving refund record:`, refundDbErr);
                                      }
                                    }
                                  }
                                } else {
                                  console.error(`[checkout.session.completed] ❌ Failed to create refund:`, refundRes.status, refundRes.body);
                                }
                              } else {
                                console.warn(`[checkout.session.completed] ⚠️ Refund amount is 0, skipping refund creation`);
                              }
                            } else {
                              console.error(`[checkout.session.completed] ❌ Could not find charge ID for refund. PaymentIntent: ${paymentIntent?.id || 'N/A'}, Session payment_intent: ${session.payment_intent || 'N/A'}`);
                            }
                          } catch (refundErr) {
                            console.error(`[checkout.session.completed] ❌ Error processing refund:`, refundErr);
                          }
                        }
                        */
                        
                        // Log failed subscriptions without refunding
                        if (failedSubscriptions.length > 0) {
                          console.warn(`[checkout.session.completed] ⚠️ ${failedSubscriptions.length} subscription(s) failed to create. Refund code is disabled - manual review required.`);
                        }
                      } catch (createSubsErr) {
                        console.error('[checkout.session.completed] ❌ Error creating separate subscriptions:', createSubsErr);
                      }
                    } else {
                      // Log why subscriptions aren't being created
                      if (!paymentMethodSaved) {
                        console.error(`[checkout.session.completed] ❌ STEP 2 SKIPPED: Payment method was not saved successfully`);
                      }
                      if (!priceId) {
                        console.error(`[checkout.session.completed] ❌ STEP 2 SKIPPED: Missing priceId`);
                      }
                      if (!quantity || quantity <= 0) {
                        console.error(`[checkout.session.completed] ❌ STEP 2 SKIPPED: Invalid quantity: ${quantity}`);
                      }
                      if (!customerIdForSubscriptions) {
                        console.error(`[checkout.session.completed] ❌ STEP 2 SKIPPED: Missing customerId`);
                      }
                    }
                    
                    // Create license keys in database - ONLY for successfully created subscriptions
                    if (env.DB && successfulLicenseSubscriptions.length > 0) {
                      const timestamp = Math.floor(Date.now() / 1000);
                      
                      for (const licenseSub of successfulLicenseSubscriptions) {
                        const { licenseKey, subscriptionId, itemId } = licenseSub;
                        
                        try {
                          const existingLicense = await env.DB.prepare(
                            `SELECT license_key FROM licenses WHERE license_key = ?`
                          ).bind(licenseKey).first();
                          
                          if (existingLicense) {
                            console.warn(`[checkout.session.completed] ⚠️ License key ${licenseKey} already exists, skipping`);
                            continue;
                          }
                          
                          await env.DB.prepare(
                            `INSERT INTO licenses 
                             (license_key, customer_id, subscription_id, item_id, 
                              site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
                            licenseKey,
                            useCase3CustomerId,
                            subscriptionId,
                            itemId || null,
                            null,
                            null,
                            'active',
                            'quantity',
                            timestamp,
                            timestamp
                          ).run();
                          
                        } catch (insertErr) {
                          if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                            console.warn(`[checkout.session.completed] ⚠️ License key ${licenseKey} already exists, skipping`);
                          } else {
                            console.error(`[checkout.session.completed] ❌ Error storing license ${licenseKey}:`, insertErr);
                          }
                        }
                      }
                    } else if (env.DB && licenseKeys.length > 0 && successfulLicenseSubscriptions.length === 0) {
                      console.warn(`[checkout.session.completed] ⚠️ No subscriptions were created successfully - skipping license key storage. ${failedSubscriptions.length} subscription(s) failed.`);
                    }
                    
                    // Save payment records
                    if (env.DB && createdSubscriptionIds.length > 0) {
                      try {
                        const timestamp = Math.floor(Date.now() / 1000);
                        const quantityForPayment = parseInt(metadata.quantity) || licenseKeys.length || 1;
                        const totalAmount = paymentIntent.amount || 0;
                        const amountPerSubscription = Math.round(totalAmount / quantityForPayment);
                        const currency = paymentIntent.currency || 'usd';
                        
                        for (let i = 0; i < createdSubscriptionIds.length; i++) {
                          await env.DB.prepare(
                            `INSERT INTO payments (
                              customer_id, subscription_id, email, amount, currency, 
                              status, site_domain, magic_link, magic_link_generated, 
                              created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
                            useCase3CustomerId,
                            createdSubscriptionIds[i],
                            userEmail,
                            amountPerSubscription,
                            currency,
                            'succeeded',
                            null,
                            null,
                            0,
                            timestamp,
                            timestamp
                          ).run();
                        }
                        
                      } catch (paymentErr) {
                        console.error('[checkout.session.completed] ❌ Error saving payment record:', paymentErr);
                      }
                    }
                    
                    return new Response('ok');
                  }
                }
              } catch (piErr) {
                console.error(`[checkout.session.completed] Error fetching payment_intent for Use Case 3:`, piErr);
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
          
          // CRITICAL: Keep items separate by purchase type
          // Quantity purchases can add to existing subscription, but items are tagged separately
          // Site purchases should not add to quantity subscriptions (but quantity can add to site subscriptions)
          
          // Check if existing subscription is a quantity subscription when adding site purchase
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
          
          // For quantity purchases, allow adding to existing subscription
          // Items will be tagged with purchase_type: 'quantity' in metadata to keep them separate
          if (purchaseType === 'quantity' && addToExisting && existingSubscriptionId) {
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
                          const licenseKey = generateLicenseKey();
                          const timestamp = Math.floor(Date.now() / 1000);
                          await env.DB.prepare(
                            'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, license_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                          ).bind(customerId, existingSubscriptionId, newItem.id, site, licenseKey, 'active', timestamp, timestamp).run();
                        } else {
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
                const addedSites = sub.items.data.map((item, idx) => {
                  const siteFromMeta = sitesFromMetadata[idx] || `site_${idx + 1}`;
                  // Also check item metadata for site name
                  const siteFromItem = item.metadata?.site;
                  return siteFromItem || siteFromMeta;
                });
                
                // Also get sites that are now in user.sites (they were successfully added)
                const sitesInUserRecord = Object.keys(user.sites || {});
                
                // Get all sites that were just added (from the items we just added to existing subscription)
                const justAddedSites = [];
                for (let idx = 0; idx < sub.items.data.length; idx++) {
                  const site = sitesFromMetadata[idx] || `site_${idx + 1}`;
                  justAddedSites.push(site);
                }
                
                
                const beforeCount = user.pendingSites.length;
                
                // Remove pending sites that match any added site (case-insensitive)
                // Also remove if the site is now in user.sites (was successfully added)
                user.pendingSites = user.pendingSites.filter(pending => {
                  const pendingSiteLower = pending.site.toLowerCase().trim();
                  const isAdded = addedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                  justAddedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                  sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                  if (isAdded) {
                  }
                  return !isAdded;
                });
                
                const afterCount = user.pendingSites.length;
                if (afterCount > 0) {
                  // If we added sites but pending sites remain, they might be from a different source
                  // Remove any pending sites that are now in user.sites (double-check)
                  const stillPending = user.pendingSites.filter(pending => {
                    const pendingSiteLower = pending.site.toLowerCase().trim();
                    const isNowActive = sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                    if (isNowActive) {
                    }
                    return !isNowActive;
                  });
                  user.pendingSites = stillPending;
                }
              } else {
              }
              
              // Remove pending sites from database
              if (env.DB && user.pendingSites && user.pendingSites.length > 0) {
                const sitesToRemove = user.pendingSites.filter(pending => {
                  const pendingSiteLower = (pending.site || pending).toLowerCase().trim();
                  const addedSites = sub.items.data.map((item, idx) => {
                    const siteFromMeta = sitesFromMetadata[idx] || `site_${idx + 1}`;
                    return siteFromMeta.toLowerCase().trim();
                  });
                  return addedSites.includes(pendingSiteLower);
                });
                
                for (const pending of sitesToRemove) {
                  const siteToRemove = (pending.site || pending).toLowerCase().trim();
                  try {
                    await env.DB.prepare(
                      'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                    ).bind(email, siteToRemove).run();
                  } catch (dbError) {
                    console.error(`[${operationId}] Failed to remove pending site from database:`, dbError);
                  }
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
            }

            // Remove pending sites that were just added (for new subscription flow)
            if (user.pendingSites && user.pendingSites.length > 0) {
              const addedSites = sub.items.data.map((item, index) => {
                const siteFromMeta = sitesFromMetadata[index] || `site_${index + 1}`;
                // Also check item metadata for site name
                const siteFromItem = item.metadata?.site;
                return siteFromItem || siteFromMeta;
              });
              
              // Also get sites that are now in user.sites (they were successfully added)
              const sitesInUserRecord = Object.keys(user.sites || {});
              
              
              const beforeCount = user.pendingSites.length;
              
              // Remove pending sites that match any added site (case-insensitive, trimmed)
              // Also remove if the site is now in user.sites (was successfully added)
              user.pendingSites = user.pendingSites.filter(pending => {
                const pendingSiteLower = pending.site.toLowerCase().trim();
                const isAdded = addedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                if (isAdded) {
                }
                return !isAdded;
              });
              
              const afterCount = user.pendingSites.length;
              if (afterCount > 0) {
                // If we added sites but pending sites remain, they might be from a different source
                // Remove any pending sites that are now in user.sites (double-check)
                const stillPending = user.pendingSites.filter(pending => {
                  const pendingSiteLower = pending.site.toLowerCase().trim();
                  const isNowActive = sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                  if (isNowActive) {
                  }
                  return !isNowActive;
                });
                user.pendingSites = stillPending;
              }
            } else {
            }
            
            // Remove pending sites from database
            if (env.DB && user.pendingSites && user.pendingSites.length > 0) {
              const sitesToRemove = user.pendingSites.filter(pending => {
                const pendingSiteLower = (pending.site || pending).toLowerCase().trim();
                const addedSites = sub.items.data.map((item, index) => {
                  const siteFromMeta = sitesFromMetadata[index] || `site_${index + 1}`;
                  return siteFromMeta.toLowerCase().trim();
                });
                return addedSites.includes(pendingSiteLower);
              });
              
              for (const pending of sitesToRemove) {
                const siteToRemove = (pending.site || pending).toLowerCase().trim();
                try {
                  await env.DB.prepare(
                    'DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?'
                  ).bind(email, siteToRemove).run();
                } catch (dbError) {
                  console.error(`[${operationId}] Failed to remove pending site from database:`, dbError);
                }
              }
            }
            
            // User record will be saved AFTER payment is saved (see below)
          }

          // Save payment details to database
          // CRITICAL: Payment is already successful - we MUST complete all operations
          // If any operation fails, queue it for retry but always return 'ok' to Stripe
          // Note: failedOperations is already initialized at function scope above
          
          try {
            // Get all sites from subscription metadata (site_0, site_1, etc.)
            // Create payment records for ALL sites, not just the first one
            const allSites = [];
            
            // Extract all sites from metadata
            Object.keys(subscriptionMetadata).forEach(key => {
              if (key.startsWith('site_')) {
                const site = subscriptionMetadata[key];
                if (site && site !== 'unknown' && !site.startsWith('site_')) {
                  allSites.push(site);
                }
              }
            });
            
            // If no sites in metadata, try to get from subscription items
            if (allSites.length === 0 && sub.items && sub.items.data && sub.items.data.length > 0) {
              sub.items.data.forEach(item => {
                const site = item.metadata?.site;
                if (site && site !== 'unknown' && !site.startsWith('site_')) {
                  allSites.push(site);
                }
              });
            }
            
            // If still no sites, use custom field (for initial subscriptions)
            if (allSites.length === 0 && customFieldSiteUrl) {
              allSites.push(customFieldSiteUrl);
            }
            
            // Legacy: Check custom fields (for backward compatibility with old payment links)
            if (allSites.length === 0 && session.custom_fields && session.custom_fields.length > 0) {
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
              }
            }
            

            // Get amount from session or subscription
            // CRITICAL: Declare these at function scope so they're accessible in error handlers
            let totalAmount = session.amount_total || 0;
            let currency = session.currency || 'usd';

            // Calculate amount per site (divide total by number of sites, or get from price if available)
            const amountPerSite = allSites.length > 0 ? Math.floor(totalAmount / allSites.length) : totalAmount;

            // Magic link generation is DISABLED - Memberstack handles authentication via passwordless login
            // No custom magic links needed
            let magicLink = null;

            // Save payment details to D1 database (with retry)
            // Create payment records for ALL sites, not just the first one
            // For quantity purchases (license_addon), save payment record even without sites
            if (env.DB && (allSites.length > 0 || purchaseType === 'quantity')) {
              let paymentSaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                  const timestamp = Math.floor(Date.now() / 1000);
                  
                  // For quantity purchases, save one payment record without site
                  if (purchaseType === 'quantity' && allSites.length === 0) {
                    await env.DB.prepare(
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
                } else {
                    // Create payment record for each site
                    for (const siteDomain of allSites) {
                    // Try to get the actual price for this site from subscription items
                    let siteAmount = amountPerSite;
                    if (sub.items && sub.items.data) {
                      const item = sub.items.data.find(i => 
                        (i.metadata?.site || '').toLowerCase().trim() === siteDomain.toLowerCase().trim()
                      );
                      if (item && item.price) {
                        // Get price details to get the actual amount
                        try {
                          const priceRes = await stripeFetch(env, `/prices/${item.price.id}`);
                          if (priceRes.status === 200) {
                            siteAmount = priceRes.body.unit_amount || amountPerSite;
                          }
                        } catch (priceError) {
                        }
                      }
                    }
                    
                  await env.DB.prepare(
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
                    }
                  }

                  paymentSaved = true;
                  break;
                } catch (dbError) {
                  console.error(`[${operationId}] ❌ Database save attempt ${attempt + 1} failed:`, dbError.message);
                  if (attempt === 2) {
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
                  
                  // Save the complete merged user structure
                  await saveUserByEmail(env, email, completeUser);
                } else {
                  // Fallback: if we can't load from database, save userToSave
                  await saveUserByEmail(env, email, userToSave);
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
                            
                            // Insert new license key with subscription details
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
                              null,  // No site assigned initially
                              null,  // Will be set when activated
                              'active',  // Status: active after payment
                              'quantity',
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
                    preGeneratedLicenseKeys = generateLicenseKeys(itemQuantity);
                  }
                  
                  // Map each license key to its subscription item
                  // Each subscription item should have a license key in its metadata (from /purchase-quantity endpoint)
                  sub.items.data.forEach((item, index) => {
                    // Get license key from item metadata (PRIMARY - set by /purchase-quantity endpoint)
                    let licenseKey = item.metadata?.license_key;
                    // Fallback to pre-generated array
                    if (!licenseKey && preGeneratedLicenseKeys[index]) {
                      licenseKey = preGeneratedLicenseKeys[index];
                    } else if (!licenseKey) {
                      // Last resort: generate new key if not found
                      licenseKey = generateLicenseKey();
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
                  });
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
                const licenseKeys = licensesToCreate.map(l => l.license_key || generateLicenseKey());
                
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
                        // Use license_key as primary key, include purchase_type and used_site_domain
                        return env.DB.prepare(
                          'INSERT INTO licenses (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                        ).bind(key, customerId, subscriptionId, itemId, site, usedSiteDomain, 'active', purchaseType, timestamp, timestamp);
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

                  const existingMember = await getMemberstackMember(email, env);
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

                  member = await createMemberstackMember(email, env);
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
            const isCancelled = sub.status === 'canceled' || 
                               sub.cancel_at_period_end === true ||
                               sub.canceled_at !== null;
            
            if (isCancelled) {
              // Still update subscription status in database, but don't generate licenses or update sites
              // The subscription is cancelled, so we should mark items as inactive
              if (env.DB) {
                try {
                  const timestamp = Math.floor(Date.now() / 1000);
                  await env.DB.prepare(
                    'UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, cancel_at = ?, current_period_end = ?, updated_at = ? WHERE subscription_id = ?'
                  ).bind(
                    sub.status || 'canceled',
                    sub.cancel_at_period_end ? 1 : 0,
                    sub.canceled_at || null, // Stripe returns canceled_at, we store it as cancel_at
                    sub.current_period_end || null, // Ensure current_period_end is updated from Stripe
                    timestamp,
                    subscriptionId
                  ).run();
                  
                  // Mark all subscription items as inactive
                  await env.DB.prepare(
                    'UPDATE subscription_items SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
                  ).bind('inactive', timestamp, subscriptionId, 'active').run();
                  
                  // Mark all licenses as inactive for this subscription
                  await env.DB.prepare(
                    'UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
                  ).bind('inactive', timestamp, subscriptionId, 'active').run();
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
                      const licenseKey = generateLicenseKey();
                      const timestamp = Math.floor(Date.now() / 1000);
                      await env.DB.prepare(
                        'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, license_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                      ).bind(customerId, sub.id, item.id, site, licenseKey, 'active', timestamp, timestamp).run();
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
                    status: (sub.status === 'canceled' || sub.canceled_at) ? 'inactive' : (sub.status === 'unpaid' || sub.status === 'past_due' ? 'inactive' : (sub.cancel_at_period_end ? 'cancelling' : 'active')),
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
          if (useCase2 && useCase2CustomerId) {
            try {
              // Get user email
              const userEmail = await getCustomerEmail(env, useCase2CustomerId);
              if (!userEmail) {
                console.warn('[USE CASE 2] User email not found for payment_intent.succeeded');
                return new Response('ok');
              }
              
              // Get site names and subscription details from metadata
              let siteNames = [];
              let priceId = null;
              let quantity = 0;
              
              try {
                if (metadata.sites) {
                  siteNames = JSON.parse(metadata.sites);
                } else {
                  console.warn(`[USE CASE 2] ⚠️ No sites found in metadata. Available keys: ${Object.keys(metadata).join(', ')}`);
                }
                priceId = metadata.price_id || null;
                quantity = parseInt(metadata.quantity) || siteNames.length || 0;
              } catch (parseErr) {
                console.error('[USE CASE 2] ❌ Error parsing metadata:', parseErr);
              }
              
              if (!priceId || siteNames.length === 0) {
                console.warn('[USE CASE 2] ⚠️ Missing price_id or sites, cannot create subscriptions');
                return new Response('ok');
              }
              
              // Generate license keys for each site
              const licenseKeys = generateLicenseKeys(siteNames.length);
              
              // STEP 1: Save payment method to customer (same as Use Case 3)
              let paymentMethodId = paymentIntent.payment_method;
              
              if (!paymentMethodId && paymentIntent.latest_charge) {
                try {
                  const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
                  if (chargeRes.status === 200 && chargeRes.body.payment_method) {
                    paymentMethodId = chargeRes.body.payment_method;
                  }
                } catch (chargeErr) {
                  console.warn(`[USE CASE 2] Could not fetch charge for payment method:`, chargeErr);
                }
              }
              
              let paymentMethodSaved = false;
              if (paymentMethodId && useCase2CustomerId) {
                try {
                  const attachRes = await stripeFetch(env, `/payment_methods/${paymentMethodId}/attach`, 'POST', {
                    'customer': useCase2CustomerId
                  }, true);
                  
                  if (attachRes.status === 200) {
                    const setDefaultRes = await stripeFetch(env, `/customers/${useCase2CustomerId}`, 'POST', {
                      'invoice_settings[default_payment_method]': paymentMethodId
                    }, true);
                    
                    if (setDefaultRes.status === 200) {
                      paymentMethodSaved = true;
                    }
                  } else {
                    const errorMessage = attachRes.body?.error?.message || '';
                    if (errorMessage.includes('already attached')) {
                      const setDefaultRes = await stripeFetch(env, `/customers/${useCase2CustomerId}`, 'POST', {
                        'invoice_settings[default_payment_method]': paymentMethodId
                      }, true);
                      
                      if (setDefaultRes.status === 200) {
                        paymentMethodSaved = true;
                      }
                    }
                  }
                } catch (attachErr) {
                  console.error(`[USE CASE 2] ❌ Error attaching payment method:`, attachErr);
                }
              }
              
              // STEP 2: Create subscriptions (one per site) and generate license keys
              const createdSubscriptionIds = [];
              const successfulSiteSubscriptions = []; // Track successful site-subscription pairs
              
              if (paymentMethodSaved && priceId && siteNames.length > 0) {
                try {
                  // Calculate trial_end (same logic as Use Case 3)
                  const now = Math.floor(Date.now() / 1000);
                  let trialPeriodDays = null;
                  if (env.TRIAL_PERIOD_DAYS) {
                    trialPeriodDays = parseInt(env.TRIAL_PERIOD_DAYS);
                  } else if (paymentIntent.metadata?.trial_period_days) {
                    trialPeriodDays = parseInt(paymentIntent.metadata.trial_period_days);
                  }
                  
                  let trialPeriodSeconds = 30 * 24 * 60 * 60; // Default: 30 days
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
                      console.warn(`[USE CASE 2] ⚠️ Could not fetch price details, using default 30 days:`, priceErr);
                    }
                  }
                  
                  const trialEndTime = now + trialPeriodSeconds;
                  const minimumTrialEnd = billingInterval === 'day' 
                    ? now + (7 * 24 * 60 * 60)
                    : now + 3600;
                  const trialEnd = Math.max(trialEndTime, minimumTrialEnd);
                  
                  // Create subscription for each site
                  for (let i = 0; i < siteNames.length; i++) {
                    try {
                      const siteName = siteNames[i];
                      const licenseKey = licenseKeys[i];
                      
                      const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
                        'customer': useCase2CustomerId,
                        'items[0][price]': priceId,
                        'items[0][quantity]': 1,
                        'metadata[site]': siteName,
                        'metadata[license_key]': licenseKey,
                        'metadata[usecase]': '2',
                        'metadata[purchase_type]': 'site',
                        'proration_behavior': 'none',
                        'collection_method': 'charge_automatically',
                        'trial_end': trialEnd.toString()
                      }, true);
                      
                      if (createSubRes.status === 200) {
                        const newSubscription = createSubRes.body;
                        createdSubscriptionIds.push(newSubscription.id);
                        const itemId = newSubscription.items?.data?.[0]?.id || null;
                        
                        successfulSiteSubscriptions.push({
                          site: siteName,
                          licenseKey: licenseKey,
                          subscriptionId: newSubscription.id,
                          itemId: itemId
                        });
                        
                        // Store license key in subscription item metadata
                        if (itemId) {
                          await stripeFetch(env, `/subscription_items/${itemId}`, 'POST', {
                            'metadata[license_key]': licenseKey,
                            'metadata[site]': siteName
                          }, true);
                        }
                      } else {
                        console.error(`[USE CASE 2] ❌ Failed to create subscription for site ${siteName}:`, createSubRes.status, createSubRes.body);
                      }
                    } catch (subError) {
                      console.error(`[USE CASE 2] ❌ Error creating subscription for site ${siteNames[i]}:`, subError);
                    }
                  }
                  
                  // STEP 3: Save license keys to database
                  if (env.DB && successfulSiteSubscriptions.length > 0) {
                    const timestamp = Math.floor(Date.now() / 1000);
                    
                    for (const siteSub of successfulSiteSubscriptions) {
                      try {
                        // Check if license key already exists
                        const existingLicense = await env.DB.prepare(
                          'SELECT license_key FROM licenses WHERE license_key = ?'
                        ).bind(siteSub.licenseKey).first();
                        
                        if (!existingLicense) {
                          await env.DB.prepare(
                            `INSERT INTO licenses (
                              license_key, customer_id, subscription_id, item_id, 
                              used_site_domain, status, purchase_type, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
                            siteSub.licenseKey,
                            useCase2CustomerId,
                            siteSub.subscriptionId,
                            siteSub.itemId,
                            siteSub.site,
                            'active',
                            'site',
                            timestamp,
                            timestamp
                          ).run();
                        }
                      } catch (licenseError) {
                        console.error(`[USE CASE 2] ❌ Error saving license for site ${siteSub.site}:`, licenseError);
                      }
                    }
                  }
                  
                  // STEP 4: Create payment records (one per subscription)
                  if (env.DB && createdSubscriptionIds.length > 0) {
                    const timestamp = Math.floor(Date.now() / 1000);
                    const amountPerSubscription = Math.round((paymentIntent.amount || 0) / createdSubscriptionIds.length);
                    
                    for (let i = 0; i < createdSubscriptionIds.length; i++) {
                      try {
                        await env.DB.prepare(
                          `INSERT INTO payments (
                            customer_id, subscription_id, email, amount, currency, 
                            status, site_domain, magic_link, magic_link_generated, 
                            created_at, updated_at
                          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).bind(
                          useCase2CustomerId,
                          createdSubscriptionIds[i],
                          userEmail,
                          amountPerSubscription,
                          paymentIntent.currency || 'usd',
                          'succeeded',
                          siteNames[i] || null,
                          null,
                          0,
                          timestamp,
                          timestamp
                        ).run();
                      } catch (paymentError) {
                        console.error(`[USE CASE 2] ❌ Error saving payment record:`, paymentError);
                      }
                    }
                  }
                  
                  // STEP 5: Remove pending sites from user record
                  if (env.DB) {
                    try {
                      const user = await getUserByEmail(env, userEmail);
                      if (user && user.pendingSites) {
                        // Remove processed sites from pending list
                        user.pendingSites = user.pendingSites.filter(ps => {
                          const psSite = (ps.site || ps.site_domain || '').toLowerCase().trim();
                          return !siteNames.some(s => s.toLowerCase().trim() === psSite);
                        });
                        await saveUserByEmail(env, userEmail, user);
                      }
                    } catch (userError) {
                      console.error(`[USE CASE 2] ❌ Error updating user pending sites:`, userError);
                    }
                  }
                  
                } catch (usecase2Err) {
                  console.error('[USE CASE 2] ❌ Error processing site purchase payment:', usecase2Err);
                }
              }
              
              return new Response('ok');
            } catch (usecase2Err) {
              console.error('[USE CASE 2] ❌ Error in Use Case 2 handler:', usecase2Err);
              return new Response('ok');
            }
          }
          
          // USE CASE 3: License purchase by user (quantity purchase)
          // Option 2: Create separate subscriptions (one per license) for individual management
          if (useCase3 && useCase3CustomerId) {
            
            try {
              // Get user email
              const userEmail = await getCustomerEmail(env, useCase3CustomerId);
              if (!userEmail) {
                console.warn('[USE CASE 3] User email not found for payment_intent.succeeded');
                return new Response('ok');
              }
              
              // Get license keys and subscription details from metadata
              let licenseKeys = [];
              let priceId = null;
              let quantity = 0;
              
              
              try {
                if (metadata.license_keys) {
                  licenseKeys = JSON.parse(metadata.license_keys);
                } else {
                  console.warn(`[USE CASE 3] ⚠️ No license_keys found in metadata. Available keys: ${Object.keys(metadata).join(', ')}`);
                }
                priceId = metadata.price_id || null;
                quantity = parseInt(metadata.quantity) || licenseKeys.length || 0;
              } catch (parseErr) {
                console.error('[USE CASE 3] ❌ Error parsing metadata:', parseErr);
              }
              
              // ========================================
              // STEP 1: FIRST - Save payment method to customer
              // Following Stripe's recommended pattern
              // MUST complete successfully before proceeding to create subscriptions
              // ========================================
              let paymentMethodId = paymentIntent.payment_method;
              
              // If payment_method is not directly available, try to get it from the charge
              if (!paymentMethodId && paymentIntent.latest_charge) {
                try {
                  const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
                  if (chargeRes.status === 200 && chargeRes.body.payment_method) {
                    paymentMethodId = chargeRes.body.payment_method;
                  }
                } catch (chargeErr) {
                  console.warn(`[USE CASE 3] Could not fetch charge for payment method:`, chargeErr);
                }
              }
              
              let paymentMethodSaved = false;
              if (paymentMethodId && useCase3CustomerId) {
                try {
                  
                  // Attach the payment method used in payment to the customer
                  const attachRes = await stripeFetch(env, `/payment_methods/${paymentMethodId}/attach`, 'POST', {
                    'customer': useCase3CustomerId
                  }, true);
                  
                  if (attachRes.status === 200) {
                    // Set it as the default payment method
                    const setDefaultRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`, 'POST', {
                      'invoice_settings[default_payment_method]': paymentMethodId
                    }, true);
                    
                    if (setDefaultRes.status === 200) {
                      paymentMethodSaved = true;
                    } else {
                      console.warn(`[USE CASE 3] ⚠️ Payment method attached but failed to set as default:`, setDefaultRes.status, setDefaultRes.body);
                    }
                  } else {
                    // Check if it's already attached
                    const errorMessage = attachRes.body?.error?.message || '';
                    if (errorMessage.includes('already attached') || errorMessage.includes('already been attached')) {
                      // Just set as default
                      const setDefaultRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`, 'POST', {
                        'invoice_settings[default_payment_method]': paymentMethodId
                      }, true);
                      
                      if (setDefaultRes.status === 200) {
                        paymentMethodSaved = true;
                      } else {
                        console.warn(`[USE CASE 3] ⚠️ Failed to set payment method as default:`, setDefaultRes.status, setDefaultRes.body);
                      }
                    } else {
                      console.error(`[USE CASE 3] ❌ STEP 1 FAILED: Failed to attach payment method:`, attachRes.status, attachRes.body);
                    }
                  }
                } catch (attachErr) {
                  console.error(`[USE CASE 3] ❌ STEP 1 FAILED: Error attaching payment method:`, attachErr);
                }
              } else {
                console.error(`[USE CASE 3] ❌ STEP 1 FAILED: Missing payment_method or customer. payment_method: ${paymentMethodId}, customer: ${useCase3CustomerId}`);
              }
              
              // ========================================
              // STEP 2: THEN - Create subscriptions (only if payment method was saved)
              // No need to specify payment_method since we set the default above
              // Following Stripe's recommended pattern
              // ========================================
              const createdSubscriptionIds = [];
              
              // Debug logging to understand why subscriptions aren't being created
              
              // Declare these at a higher scope so they're available for license key storage
              const failedSubscriptions = []; // Track failed subscriptions for refund
              const failedLicenseKeys = []; // Track license keys for failed subscriptions
              const successfulLicenseSubscriptions = []; // Track successful license-subscription pairs: {licenseKey, subscriptionId, itemId}
              const savedLicenseKeys = new Set(); // Track which licenses have been saved to prevent duplicates
              
              if (paymentMethodSaved && priceId && quantity > 0 && useCase3CustomerId) {
                try {
                  
                  // Calculate trial_end ONCE before loop - all subscriptions get same trial_end
                  // Use trial_end to skip first invoice (payment already collected via checkout)
                  // Trial prevents invoice creation until trial ends
                  // Priority: Custom trial days (env/metadata) > Billing interval > Default (30 days)
                  const now = Math.floor(Date.now() / 1000);
                  
                  // Check for custom trial period (environment variable or metadata)
                  let trialPeriodDays = null;
                  if (env.TRIAL_PERIOD_DAYS) {
                    trialPeriodDays = parseInt(env.TRIAL_PERIOD_DAYS);
                  } else if (paymentIntent.metadata?.trial_period_days) {
                    trialPeriodDays = parseInt(paymentIntent.metadata.trial_period_days);
                  }
                  
                  // Get price details to determine billing interval (if no custom trial period)
                  let trialPeriodSeconds = 30 * 24 * 60 * 60; // Default: 30 days (monthly)
                  let billingInterval = 'month'; // Default
                  
                  if (trialPeriodDays) {
                    // Use custom trial period
                    trialPeriodSeconds = trialPeriodDays * 24 * 60 * 60;
                  } else {
                    // Calculate based on billing interval
                    try {
                      const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                      if (priceRes.status === 200 && priceRes.body.recurring) {
                        billingInterval = priceRes.body.recurring.interval;
                        const intervalCount = priceRes.body.recurring.interval_count || 1;
                        
                        // Calculate trial period based on billing interval
                        if (billingInterval === 'week') {
                          trialPeriodSeconds = 7 * 24 * 60 * 60 * intervalCount; // Weekly
                        } else if (billingInterval === 'month') {
                          trialPeriodSeconds = 30 * 24 * 60 * 60 * intervalCount; // Monthly (approximate)
                        } else if (billingInterval === 'year') {
                          trialPeriodSeconds = 365 * 24 * 60 * 60 * intervalCount; // Yearly
                        } else if (billingInterval === 'day') {
                          trialPeriodSeconds = 24 * 60 * 60 * intervalCount; // Daily
                        }
                        
                      }
                    } catch (priceErr) {
                      console.warn(`[USE CASE 3] ⚠️ Could not fetch price details, using default 30 days:`, priceErr);
                    }
                  }
                  
                  const trialEndTime = now + trialPeriodSeconds;
                  
                  // Ensure trial_end is at least 1 hour in the future (Stripe requirement)
                  // For daily billing, use at least 7 days to prevent immediate invoice creation
                  const minimumTrialEnd = billingInterval === 'day' 
                    ? now + (7 * 24 * 60 * 60) // 7 days minimum for daily billing
                    : now + 3600; // 1 hour minimum for other intervals
                  const trialEnd = Math.max(trialEndTime, minimumTrialEnd);
                  
                  const trialSource = trialPeriodDays ? `custom (${trialPeriodDays} days)` : `billing interval (${billingInterval})`;
                  
                  // Process subscriptions in safe batches to avoid rate limits and timeouts
                  // Batch size: 5-10 subscriptions per batch
                  // Rate: Adaptive delay - shorter for larger batches to prevent timeout
                  const BATCH_SIZE = 5; // Process 5 subscriptions per batch
                  // OPTIMIZATION: No delay between subscriptions within batch - process as fast as possible
                  // Only delay between batches to respect rate limits
                  const DELAY_BETWEEN_BATCHES = 200; // 200ms delay between batches (minimal to prevent timeout)
                  
                  const totalBatches = Math.ceil(quantity / BATCH_SIZE);
                  
                  
                  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                    const batchNumber = batchIndex + 1;
                    const startIndex = batchIndex * BATCH_SIZE;
                    const endIndex = Math.min(startIndex + BATCH_SIZE, quantity);
                    const batchSize = endIndex - startIndex;
                    
                    
                    // Process each subscription in the current batch
                    for (let i = startIndex; i < endIndex; i++) {
                      const positionInBatch = (i % BATCH_SIZE) + 1;
                      
                      try {
                        // OPTIMIZATION: No delay between subscriptions - process as fast as possible
                        // Stripe can handle rapid sequential requests for the same customer
                      
                        // Create subscription - uses default payment method we set above
                      // All subscriptions use the same trial_end calculated above
                      const createSubRes = await stripeFetch(env, '/subscriptions', 'POST', {
                      'customer': useCase3CustomerId,
                      'items[0][price]': priceId,
                      'items[0][quantity]': 1,
                      'metadata[license_key]': licenseKeys[i],
                      'metadata[usecase]': '3',
                      'metadata[purchase_type]': 'quantity',
                      'proration_behavior': 'none',
                      'collection_method': 'charge_automatically', // Use automatic charging
                      'trial_end': trialEnd.toString(), // Skip first invoice - payment already collected via checkout
                      // No need to specify payment_method - uses default we set above
                    }, true);
                    
                    
                    if (createSubRes.status === 200) {
                      const newSubscription = createSubRes.body;
                      createdSubscriptionIds.push(newSubscription.id);
                      
                      // Get the subscription item ID
                      const itemId = newSubscription.items?.data?.[0]?.id || null;
                      
                      
                      // Verify payment was successful
                      // With trial_end, no invoice should be created until trial ends
                      // Payment already collected via checkout, so we just verify payment success
                      const paymentVerified = paymentIntent.status === 'succeeded';
                      
                      if (!paymentVerified) {
                        console.error(`[USE CASE 3] ❌ Payment verification failed - PaymentIntent status is '${paymentIntent.status}', not 'succeeded'`);
                        // Track as failed for refund
                        failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'payment_verification_failed' });
                        failedLicenseKeys.push(licenseKeys[i]);
                        // Don't add to successfulLicenseSubscriptions - subscription created but payment not verified
                      } else {
                        // Payment verified - subscription created with trial_end (no invoice until trial ends)
                        
                        // If an invoice was somehow created (shouldn't happen with trial_end), void it immediately
                        if (newSubscription.latest_invoice) {
                          const invoiceId = typeof newSubscription.latest_invoice === 'string' 
                            ? newSubscription.latest_invoice 
                            : newSubscription.latest_invoice.id;
                          
                          try {
                            const invoiceRes = await stripeFetch(env, `/invoices/${invoiceId}`);
                            if (invoiceRes.status === 200) {
                              const invoice = invoiceRes.body;
                              if (invoice.status === 'open' || invoice.status === 'draft') {
                                // Immediately void/delete to prevent auto-payment
                                if (invoice.status === 'open') {
                                  await stripeFetch(env, `/invoices/${invoiceId}/void`, 'POST', {}, true);
                                } else {
                                  await stripeFetch(env, `/invoices/${invoiceId}`, 'DELETE', {}, false);
                                }
                              } else if (invoice.status === 'paid') {
                                // Invoice was auto-paid - this shouldn't happen with trial_end, but it can for very short trials
                                // For daily billing with short trial, Stripe may auto-pay immediately
                                // We need to refund this invoice to prevent duplicate payment
                                console.warn(`[USE CASE 3] ⚠️ Invoice ${invoiceId} was auto-paid (unexpected with trial_end) - refunding to prevent duplicate payment`);
                                
                                let refundSuccess = false;
                                try {
                                  // Get charge ID from invoice - try multiple sources
                                  let chargeId = invoice.charge;
                                  
                                  // If charge is an object, get the ID
                                  if (chargeId && typeof chargeId === 'object') {
                                    chargeId = chargeId.id;
                                  }
                                  
                                  // Try to get from payment intent if not in invoice
                                  if (!chargeId && invoice.payment_intent) {
                                    const piId = typeof invoice.payment_intent === 'string' 
                                      ? invoice.payment_intent 
                                      : invoice.payment_intent.id;
                                    try {
                                      const piRes = await stripeFetch(env, `/payment_intents/${piId}`);
                                      if (piRes.status === 200 && piRes.body.latest_charge) {
                                        chargeId = typeof piRes.body.latest_charge === 'string'
                                          ? piRes.body.latest_charge
                                          : piRes.body.latest_charge.id;
                                      }
                                    } catch (piErr) {
                                      console.warn(`[USE CASE 3] ⚠️ Could not fetch payment intent for charge:`, piErr);
                                    }
                                  }
                                  
                                  if (chargeId) {
                                    // Refund the charge to prevent duplicate payment
                                    const refundRes = await stripeFetch(env, '/refunds', 'POST', {
                                      'charge': chargeId,
                                      'reason': 'requested_by_customer',
                                      'metadata[reason]': 'auto_paid_invoice_during_trial',
                                      'metadata[invoice_id]': invoiceId,
                                      'metadata[subscription_id]': newSubscription.id
                                    }, true);
                                    
                                    if (refundRes.status === 200) {
                                      refundSuccess = true;
                                    } else {
                                      console.error(`[USE CASE 3] ❌ Failed to refund invoice ${invoiceId}:`, refundRes.status, refundRes.body);
                                    }
                                  } else {
                                    console.warn(`[USE CASE 3] ⚠️ Invoice ${invoiceId} is paid but has no charge ID - cannot refund. Invoice data:`, JSON.stringify(invoice, null, 2));
                                  }
                                } catch (refundErr) {
                                  console.error(`[USE CASE 3] ❌ Error refunding auto-paid invoice:`, refundErr);
                                }
                                
                                // Even if refund fails, log it for manual review
                                if (!refundSuccess) {
                                  console.error(`[USE CASE 3] ⚠️ CRITICAL: Could not refund auto-paid invoice ${invoiceId} - manual refund may be required`);
                                }
                              }
                            }
                          } catch (invoiceErr) {
                            console.warn(`[USE CASE 3] ⚠️ Error handling unexpected invoice:`, invoiceErr);
                          }
                        }
                      }
                      
                      // Track as successful if subscription was created (even if invoice was auto-paid and refunded)
                      // The subscription is valid - we just need to handle the duplicate payment via refund
                      if (createSubRes.status === 200) {
                        successfulLicenseSubscriptions.push({
                          licenseKey: licenseKeys[i],
                          subscriptionId: newSubscription.id,
                          itemId: itemId
                        });
                      } else {
                        console.warn(`[USE CASE 3] ⚠️ Subscription creation failed, not adding to successful list`);
                      }
                      
                      // Store license key in subscription item metadata
                      // OPTIMIZATION: Skip metadata update for large batches to save time
                      if (itemId && quantity <= 10) {
                        await stripeFetch(env, `/subscription_items/${itemId}`, 'POST', {
                          'metadata[license_key]': licenseKeys[i]
                        }, true);
                      } else if (itemId && quantity > 10) {
                        // For large batches, skip metadata update to save time - can be done later
                      }
                    } else {
                      console.error(`[USE CASE 3] ❌ Failed to create subscription ${i + 1}/${quantity}:`, createSubRes.status, createSubRes.body);
                      // Track failed subscription for refund
                      failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'subscription_creation_failed', status: createSubRes.status });
                      failedLicenseKeys.push(licenseKeys[i]);
                      // Continue to next subscription even if this one failed
                    }
                  } catch (subError) {
                    // Catch any errors during subscription creation to ensure loop continues
                    console.error(`[USE CASE 3] ❌ Error creating subscription ${i + 1}/${quantity} for license ${licenseKeys[i]}:`, subError);
                    failedSubscriptions.push({ licenseKey: licenseKeys[i], reason: 'subscription_creation_error', error: subError.message || String(subError) });
                    failedLicenseKeys.push(licenseKeys[i]);
                    // Continue to next subscription
                  }
                    } // End of inner loop (subscriptions in batch)
                    
                    // Batch completed - log summary
                    
                    // OPTIMIZATION: Save licenses incrementally after each batch to prevent data loss on timeout
                    // This ensures licenses are saved even if webhook times out before all batches complete
                    if (env.DB && successfulLicenseSubscriptions.length > 0) {
                      const timestamp = Math.floor(Date.now() / 1000);
                      let batchLicensesSaved = 0;
                      
                      // Save all licenses created in this batch (those with indices in the current batch range)
                      for (let i = startIndex; i < endIndex; i++) {
                        const licenseKey = licenseKeys[i];
                        
                        // Skip if already saved
                        if (savedLicenseKeys.has(licenseKey)) {
                          continue;
                        }
                        
                        // Find the corresponding subscription data
                        const licenseSub = successfulLicenseSubscriptions.find(s => s.licenseKey === licenseKey);
                        if (!licenseSub) {
                          continue; // Subscription wasn't created successfully for this license
                        }
                        
                        const { subscriptionId, itemId } = licenseSub;
                        
                        try {
                          const existingLicense = await env.DB.prepare(
                            `SELECT license_key FROM licenses WHERE license_key = ?`
                          ).bind(licenseKey).first();
                          
                          if (existingLicense) {
                            savedLicenseKeys.add(licenseKey);
                            continue;
                          }
                          
                          await env.DB.prepare(
                            `INSERT INTO licenses 
                             (license_key, customer_id, subscription_id, item_id, 
                              site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                          ).bind(
                            licenseKey,
                            useCase3CustomerId,
                            subscriptionId,
                            itemId || null,
                            null,
                            null,
                            'active',
                            'quantity',
                            timestamp,
                            timestamp
                          ).run();
                          
                          savedLicenseKeys.add(licenseKey);
                          batchLicensesSaved++;
                        } catch (insertErr) {
                          if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                            savedLicenseKeys.add(licenseKey);
                            console.warn(`[USE CASE 3] ⚠️ License key ${licenseKey} already exists, skipping`);
                          } else {
                            console.error(`[USE CASE 3] ❌ Error storing license ${licenseKey}:`, insertErr);
                          }
                        }
                      }
                      
                      if (batchLicensesSaved > 0) {
                      }
                    }
                    
                    // Add delay between batches (except after the last batch)
                    if (batchIndex < totalBatches - 1) {
                      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
                    }
                  } // End of outer loop (batches)
                  
                
                // Check if all subscriptions were created - if not, add missing ones to failed list for refund
                const totalProcessed = createdSubscriptionIds.length + failedSubscriptions.length;
                const missingCount = quantity - totalProcessed;
                
                if (missingCount > 0) {
                  console.warn(`[USE CASE 3] ⚠️ WARNING: ${missingCount} subscription(s) were not processed (webhook may have timed out). Adding to failed list for refund.`);
                  
                  // Find which license keys weren't processed
                  const processedLicenseKeys = new Set([
                    ...successfulLicenseSubscriptions.map(s => s.licenseKey),
                    ...failedLicenseKeys
                  ]);
                  
                  for (let i = 0; i < licenseKeys.length; i++) {
                    if (!processedLicenseKeys.has(licenseKeys[i])) {
                      failedSubscriptions.push({ 
                        licenseKey: licenseKeys[i], 
                        reason: 'not_processed_timeout', 
                        index: i + 1 
                      });
                      failedLicenseKeys.push(licenseKeys[i]);
                      console.warn(`[USE CASE 3] ⚠️ License ${licenseKeys[i]} (subscription ${i + 1}/${quantity}) was not processed - will be refunded`);
                    }
                  }
                }
                
                // ========================================
                // REFUND LOGIC: If any subscriptions failed or weren't processed, refund the failed portion
                // ========================================
                if (failedSubscriptions.length > 0) {
                  console.warn(`[USE CASE 3] ⚠️ ${failedSubscriptions.length} subscription(s) failed to create. Processing refund for failed subscriptions...`);
                  
                  try {
                    // Get payment intent charge ID for refund
                    let chargeId = null;
                    if (paymentIntent?.latest_charge) {
                      chargeId = typeof paymentIntent.latest_charge === 'string' 
                        ? paymentIntent.latest_charge 
                        : paymentIntent.latest_charge.id;
                    } else if (paymentIntent?.charges?.data?.length > 0) {
                      chargeId = paymentIntent.charges.data[0].id;
                    }
                    
                    if (chargeId) {
                      // Get price details to calculate refund amount
                      let refundAmount = 0;
                      let currency = 'usd';
                      
                      try {
                        const priceRes = await stripeFetch(env, `/prices/${priceId}`);
                        if (priceRes.status === 200) {
                          const price = priceRes.body;
                          const unitPrice = price.unit_amount || 0;
                          currency = price.currency || 'usd';
                          refundAmount = unitPrice * failedSubscriptions.length;
                        }
                      } catch (priceErr) {
                        console.warn(`[USE CASE 3] ⚠️ Could not get price for refund calculation:`, priceErr);
                        // Fallback: Use payment intent amount divided by quantity
                        if (paymentIntent?.amount && quantity > 0) {
                          refundAmount = Math.round((paymentIntent.amount / quantity) * failedSubscriptions.length);
                          currency = paymentIntent.currency || 'usd';
                        }
                      }
                      
                      if (refundAmount > 0) {
                        // Create refund
                        const refundRes = await stripeFetch(env, '/refunds', 'POST', {
                          'charge': chargeId,
                          'amount': refundAmount,
                          'metadata[reason]': 'subscription_creation_failed',
                          'metadata[failed_count]': failedSubscriptions.length.toString(),
                          'metadata[failed_license_keys]': JSON.stringify(failedLicenseKeys)
                        }, true);
                        
                        if (refundRes.status === 200) {
                          const refund = refundRes.body;
                          
                          // Save refund record to database
                          if (env.DB) {
                            try {
                              const timestamp = Math.floor(Date.now() / 1000);
                              await env.DB.prepare(
                                `INSERT INTO refunds (
                                  refund_id, payment_intent_id, charge_id, customer_id, user_email,
                                  amount, currency, status, reason, queue_id, license_key,
                                  subscription_id, attempts, metadata, created_at, updated_at
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                              ).bind(
                                refund.id,
                                paymentIntent?.id,
                                chargeId,
                                customerId,
                                paymentIntent?.metadata?.email || null,
                                refundAmount,
                                currency,
                                refund.status || 'succeeded',
                                'subscription_creation_failed',
                                null, // queue_id (not from queue)
                                null, // license_key (multiple licenses)
                                null, // subscription_id (not created)
                                null, // attempts
                                JSON.stringify({
                                  reason: 'subscription_creation_failed',
                                  failed_count: failedSubscriptions.length,
                                  payment_intent_id: paymentIntent?.id,
                                  customer_id: customerId
                                }),
                                timestamp,
                                timestamp
                              ).run();
                            } catch (refundDbErr) {
                              if (refundDbErr.message && refundDbErr.message.includes('UNIQUE constraint')) {
                                console.warn(`[USE CASE 3] ⚠️ Refund ${refund.id} already exists in database, skipping`);
                              } else {
                                console.error(`[USE CASE 3] ⚠️ Error saving refund record:`, refundDbErr);
                              }
                            }
                          }
                        } else {
                          console.error(`[USE CASE 3] ❌ Failed to create refund:`, refundRes.status, refundRes.body);
                        }
                      } else {
                        console.warn(`[USE CASE 3] ⚠️ Refund amount is 0, skipping refund creation`);
                      }
                    } else {
                      console.error(`[USE CASE 3] ❌ Could not find charge ID for refund. PaymentIntent: ${paymentIntent?.id || 'N/A'}`);
                    }
                  } catch (refundErr) {
                    console.error(`[USE CASE 3] ❌ Error processing refund:`, refundErr);
                  }
                }
              } catch (createSubsErr) {
                console.error('[USE CASE 3] ❌ Error creating separate subscriptions:', createSubsErr);
              }
              } else {
                // Log why subscriptions aren't being created
                if (!paymentMethodSaved) {
                  console.error(`[USE CASE 3] ❌ STEP 2 SKIPPED: Payment method was not saved successfully`);
                }
                if (!priceId) {
                  console.error(`[USE CASE 3] ❌ STEP 2 SKIPPED: Missing priceId`);
                }
                if (!quantity || quantity <= 0) {
                  console.error(`[USE CASE 3] ❌ STEP 2 SKIPPED: Invalid quantity: ${quantity}`);
                }
                if (!useCase3CustomerId) {
                  console.error(`[USE CASE 3] ❌ STEP 2 SKIPPED: Missing customerId`);
                }
              }
              
              // Create license keys in database after payment succeeds - ONLY for successfully created subscriptions
              // Store all relevant data: license_key, customer_id, subscription_id, item_id, status, purchase_type, timestamps
              if (env.DB && successfulLicenseSubscriptions.length > 0) {
                
                const timestamp = Math.floor(Date.now() / 1000);
                let licensesStored = 0;
                let licensesSkipped = 0;
                let licensesFailed = 0;
                
                for (let i = 0; i < successfulLicenseSubscriptions.length; i++) {
                  const { licenseKey, subscriptionId, itemId } = successfulLicenseSubscriptions[i];
                  
                  try {
                    // Check if license key already exists (shouldn't happen, but handle gracefully)
                    const existingLicense = await env.DB.prepare(
                      `SELECT license_key FROM licenses WHERE license_key = ?`
                    ).bind(licenseKey).first();
                    
                    if (existingLicense) {
                      console.warn(`[USE CASE 3] ⚠️ License key ${licenseKey} already exists in database, skipping`);
                      licensesSkipped++;
                      continue;
                    }
                    
                    // Insert new license key with all relevant subscription details
                    // Schema: license_key (PK), customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, created_at, updated_at
                    const insertResult = await env.DB.prepare(
                      `INSERT INTO licenses 
                       (license_key, customer_id, subscription_id, item_id, 
                        site_domain, used_site_domain, status, purchase_type, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                      licenseKey,                    // license_key (PRIMARY KEY)
                      useCase3CustomerId,            // customer_id (NOT NULL)
                      subscriptionId,                // subscription_id (guaranteed to exist)
                      itemId || null,                 // item_id (can be null)
                      null,                           // site_domain (null for quantity purchases - unassigned)
                      null,                           // used_site_domain (null until activated)
                      'active',                       // status (NOT NULL, default 'active')
                      'quantity',                     // purchase_type ('quantity' for Use Case 3)
                      timestamp,                      // created_at (NOT NULL)
                      timestamp                       // updated_at (NOT NULL)
                    ).run();
                    
                    if (insertResult.success) {
                      licensesStored++;
                    } else {
                      console.error(`[USE CASE 3] ❌ Failed to store license ${licenseKey}: insertResult.success = false`);
                      licensesFailed++;
                    }
                  } catch (insertErr) {
                    // If license key already exists (race condition), skip
                    if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                      console.warn(`[USE CASE 3] ⚠️ License key ${licenseKey} already exists (UNIQUE constraint), skipping`);
                      licensesSkipped++;
                    } else {
                      console.error(`[USE CASE 3] ❌ Error storing license ${licenseKey} in database:`, insertErr);
                      console.error(`[USE CASE 3]    Error details:`, insertErr.message);
                      licensesFailed++;
                    }
                  }
                }
                
                // Summary of license storage
                
                if (licensesStored === 0 && licensesFailed > 0) {
                  console.error(`[USE CASE 3] ❌ CRITICAL: No licenses were stored! All ${successfulLicenseSubscriptions.length} license(s) failed to save.`);
                }
              } else if (env.DB && licenseKeys.length > 0 && successfulLicenseSubscriptions.length === 0) {
                console.warn(`[USE CASE 3] ⚠️ No subscriptions were created successfully - skipping license key storage. ${failedSubscriptions.length} subscription(s) failed.`);
              } else {
                if (!env.DB) {
                  console.error('[USE CASE 3] ❌ Database not available - cannot store licenses');
                } else if (licenseKeys.length === 0) {
                  console.warn('[USE CASE 3] ⚠️ No license keys found in metadata - cannot store licenses');
                }
              }
              
              // Save payment record (one per subscription created)
              // Store all relevant payment data: customer_id, subscription_id, email, amount, currency, status, timestamps
              if (env.DB && createdSubscriptionIds.length > 0) {
                try {
                  const timestamp = Math.floor(Date.now() / 1000);
                  const quantityForPayment = parseInt(paymentIntent.metadata?.quantity) || licenseKeys.length || 1;
                  const totalAmount = paymentIntent.amount || 0;
                  const amountPerSubscription = Math.round(totalAmount / quantityForPayment);
                  const currency = paymentIntent.currency || 'usd';
                  
                  
                  let paymentsStored = 0;
                  let paymentsFailed = 0;
                  
                  // Save one payment record per subscription created
                  for (let i = 0; i < createdSubscriptionIds.length; i++) {
                    try {
                      const insertResult = await env.DB.prepare(
                        `INSERT INTO payments (
                          customer_id, subscription_id, email, amount, currency, 
                          status, site_domain, magic_link, magic_link_generated, 
                          created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                      ).bind(
                        useCase3CustomerId,              // customer_id (NOT NULL)
                        createdSubscriptionIds[i],        // subscription_id (NOT NULL)
                        userEmail,                        // email (NOT NULL)
                        amountPerSubscription,            // amount in cents (NOT NULL)
                        currency,                         // currency (NOT NULL, default 'usd')
                        'succeeded',                      // status (NOT NULL, default 'succeeded')
                        null,                             // site_domain (null for quantity purchases)
                        null,                             // magic_link (not used)
                        0,                                // magic_link_generated (0/false)
                        timestamp,                        // created_at (NOT NULL)
                        timestamp                         // updated_at (NOT NULL)
                      ).run();
                      
                      if (insertResult.success) {
                        paymentsStored++;
                      } else {
                        console.error(`[USE CASE 3] ❌ Failed to store payment record for subscription ${createdSubscriptionIds[i]}: insertResult.success = false`);
                        paymentsFailed++;
                      }
                    } catch (paymentInsertErr) {
                      console.error(`[USE CASE 3] ❌ Error storing payment record ${i + 1} for subscription ${createdSubscriptionIds[i]}:`, paymentInsertErr);
                      console.error(`[USE CASE 3]    Error details:`, paymentInsertErr.message);
                      paymentsFailed++;
                    }
                  }
                  
                  // Summary of payment storage
                  
                  if (paymentsStored === 0 && paymentsFailed > 0) {
                    console.error(`[USE CASE 3] ❌ CRITICAL: No payment records were stored! All ${createdSubscriptionIds.length} payment(s) failed to save.`);
                  }
                } catch (paymentErr) {
                  console.error('[USE CASE 3] ❌ Error processing payment records:', paymentErr);
                  console.error('[USE CASE 3]    Error details:', paymentErr.message);
                }
              } else {
                if (!env.DB) {
                  console.error('[USE CASE 3] ❌ Database not available - cannot store payment records');
                } else if (createdSubscriptionIds.length === 0) {
                  console.warn('[USE CASE 3] ⚠️ No subscriptions created - cannot store payment records');
                }
              }
              
              return new Response('ok');
            } catch (usecase3Err) {
              console.error('[USE CASE 3] ❌ Error processing license purchase payment:', usecase3Err);
              // Don't return error - let it fall through to normal processing as fallback
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
                      const licenseKey = generateLicenseKey();
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
          const licenseKeys = generateLicenseKeys(licensesToCreate.length);

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
          // handle payment failure
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

      if (request.method === 'GET' && pathname === '/dashboard') {
        // Try to get email from query parameter (for Memberstack users)
        const emailParam = url.searchParams.get('email');
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
                if (subRow.cancel_at_period_end === 1) {
                  subscriptionStatus = 'cancelling'; // Will cancel at period end
                } else if (subRow.status === 'canceled') {
                  subscriptionStatus = 'canceled';
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
        if (subscriptionIds.length > 0) {
          try {
            const placeholders = subscriptionIds.map(() => '?').join(',');
            // Include all items (even inactive ones) so cancelled subscriptions are visible
            const itemsRes = await env.DB.prepare(
              `SELECT subscription_id, item_id, site_domain, price_id, quantity, status, created_at, removed_at 
               FROM subscription_items 
               WHERE subscription_id IN (${placeholders})`
            ).bind(...subscriptionIds).all();
            
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
                  
                  subscriptions[subId].items = items.map(item => ({
                    item_id: item.item_id,
                    site: item.site_domain,
                    price: item.price_id,
                    quantity: item.quantity || 1,
                    status: item.status || (item.removed_at || isSubscriptionCancelled ? 'inactive' : 'active'),
                    created_at: item.created_at,
                    removed_at: item.removed_at || null
                  }));
                  subscriptions[subId].sitesCount = items.length;
                  subscriptions[subId].billingPeriod = billingPeriod;
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
                      }
                      
                      itemsToSave.push({
                        item_id: item.id,
                        site: siteDomain,
                        price: item.price.id,
                        quantity: item.quantity || 1,
                        status: 'active',
                        created_at: Math.floor(Date.now() / 1000),
                        // Add license key for quantity purchases
                        license_key: quantityLicense ? quantityLicense.license_key : null,
                        purchase_type: isQuantityPurchase ? 'quantity' : 'site'
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
        
        // Step 4: Get all licenses for these subscriptions
        // For site purchases: map by site_domain
        // For quantity purchases: map by subscription_id and item_id
        const allLicensesMap = {}; // site_domain -> license
        const quantityLicensesMap = {}; // subscription_id -> { item_id -> license }
        if (subscriptionIds.length > 0) {
          try {
            const placeholders = subscriptionIds.map(() => '?').join(',');
            const licensesRes = await env.DB.prepare(
              `SELECT license_key, site_domain, subscription_id, item_id, status, purchase_type, created_at 
               FROM licenses 
               WHERE subscription_id IN (${placeholders}) AND status = ?`
            ).bind(...subscriptionIds, 'active').all();
            
            if (licensesRes && licensesRes.results) {
              for (const license of licensesRes.results) {
                // For site purchases: map by site_domain
                if (license.site_domain && license.license_key && license.purchase_type !== 'quantity') {
                  allLicensesMap[license.site_domain] = {
                    license_key: license.license_key,
                    status: license.status || 'active',
                    created_at: license.created_at
                  };
                }
                
                // For quantity purchases: map by subscription_id and item_id
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
                    purchase_type: 'quantity'
                  };
                }
              }
            }
          } catch (dbErr) {
            console.error('Error fetching licenses:', dbErr);
          }
        }
        
        // Step 5: Build sites object from subscription items
        for (const [subId, subscription] of Object.entries(subscriptions)) {
          const customerId = subscription.customerId;
          
          for (const item of subscription.items) {
            const siteDomain = item.site;
            
            // Skip if no site domain
            if (!siteDomain || siteDomain.trim() === '') {
              continue;
            }
            
            // Skip placeholder sites (site_1, site_2, etc.) - only show real domains
            if (siteDomain.startsWith('site_') && /^site_\d+$/.test(siteDomain)) {
              continue;
            }
            
            // Get license for this site
            const license = allLicensesMap[siteDomain] || null;
            
            // Get site details from sites table
            let siteDetails = null;
            try {
              siteDetails = await env.DB.prepare(
                'SELECT amount_paid, currency, status, current_period_start, current_period_end, renewal_date, cancel_at_period_end, canceled_at FROM sites WHERE customer_id = ? AND subscription_id = ? AND site_domain = ? LIMIT 1'
              ).bind(customerId, subId, siteDomain).first();
            } catch (dbErr) {
            }
            
            // Build site object
            sites[siteDomain] = {
              item_id: item.item_id,
              price: item.price,
              quantity: item.quantity || 1,
              status: item.status || 'active',
              created_at: item.created_at,
              subscription_id: subId,
              license: license,
              amount_paid: siteDetails?.amount_paid || null,
              currency: siteDetails?.currency || 'usd',
              current_period_start: siteDetails?.current_period_start || subscription.current_period_start || null,
              current_period_end: siteDetails?.current_period_end || subscription.current_period_end || null,
              renewal_date: siteDetails?.renewal_date || subscription.current_period_end || null,
              cancel_at_period_end: siteDetails?.cancel_at_period_end === 1 || subscription.cancel_at_period_end || false,
              canceled_at: siteDetails?.canceled_at || subscription.canceled_at || null
            };
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

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // This endpoint is disabled - code removed
      }

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // This endpoint is disabled - code removed
      }

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // This endpoint is disabled - code removed
      }

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // This endpoint is disabled - code removed
      }

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
        // Support both session-based and email-based authentication
        let email = null;
        let customerId = null;
        let subscriptionId = subscriptionIdParam || null;
        
        // This endpoint is disabled - code removed
      }

      // REMOVED: /add-site endpoint - Use /add-sites-batch instead
      if (false && request.method === 'POST' && pathname === '/add-site') {
        const body = await request.json();
        const { site, price, quantity = 1, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
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
        
        if (!site) return jsonResponse(400, { error: 'missing site' }, true, request);

        // Get user by email (email-based structure)
        let userFromEmail = await getUserByEmail(env, email);
        let user = null; // Will be set in either branch
        
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
          
          // Continue with existing logic using converted user object
          // (rest of the function remains the same)
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
                console.error('[add-site] Error fetching customer ID from payments:', dbError);
              }
            }
            
            if (!customerId) {
              return jsonResponse(400, { error: 'customer not found', message: 'No customer found for this email. Please complete a payment first.' }, true, request);
            }
          }
          
          // Get user from database by customerId
          user = await getUserByCustomerId(env, customerId);
          
          // If user doesn't exist yet, create a new user structure
          if (!user) {
            user = {
              email: email,
              customers: [{
                customerId: customerId,
                subscriptions: [],
                created_at: Math.floor(Date.now() / 1000)
              }],
              licenses: [],
              pendingSites: [],
              created_at: Math.floor(Date.now() / 1000),
              updated_at: Math.floor(Date.now() / 1000)
            };
          }
        }

        // Check if site already exists (active or pending)
        if (user.sites && user.sites[site] && user.sites[site].status === 'active') {
          return jsonResponse(400, { error: 'site already exists' }, true, request);
        }
        if (user.pendingSites && user.pendingSites.some(s => s.site === site)) {
          return jsonResponse(400, { error: 'site already in pending list' }, true, request);
        }
        
        // If site exists but is inactive, remove it first (clean up old data)
        if (user.sites && user.sites[site] && user.sites[site].status === 'inactive') {
          // Remove the old inactive site entry - we'll create a fresh one
          delete user.sites[site];
        }

        // ALWAYS add to pending sites first - payment required before adding to subscription
        // This ensures users pay for new sites before they're added to their subscription
        if (!user.pendingSites) user.pendingSites = [];
        
        // Determine price to use for pending sites
        let priceToUse = price;
        if (!priceToUse) {
          // Try to get price from existing site
          if (user.sites && Object.keys(user.sites).length > 0) {
            const firstSite = Object.values(user.sites).find(s => s.status === 'active');
            if (firstSite && firstSite.price) {
              priceToUse = firstSite.price;
            }
          }
          // Try user's default price (stored after first payment)
          if (!priceToUse && user.defaultPrice) {
            priceToUse = user.defaultPrice;
          }
          // Fallback to environment variable
          if (!priceToUse && env.DEFAULT_PRICE_ID) {
            priceToUse = env.DEFAULT_PRICE_ID;
          }
          if (!priceToUse) {
            return jsonResponse(400, { 
              error: 'price required', 
              message: 'Please provide a Price ID for new sites, or configure DEFAULT_PRICE_ID in wrangler.jsonc.' 
            }, true, request);
          }
        }

        // Add site to pending list
        user.pendingSites.push({
          site: site,
          price: priceToUse,
          quantity: quantity || 1
        });

        // Save to both structures if using email-based
        if (userFromEmail && userFromEmail.customers && userFromEmail.customers.length > 0) {
          // Update email-based structure
          userFromEmail.pendingSites = user.pendingSites;
          await saveUserByEmail(env, email, userFromEmail);
        } else {
          // Save to legacy structure
          const userKey = `user:${customerId}`;
          await saveUserByEmail(env, email, user);
        }


        return jsonResponse(200, { 
          success: true, 
          site: site,
          pending: true,
          message: 'Site added to cart. Click "Pay Now" to checkout and complete payment.'
        }, true, request);
      }

      // Batch add multiple sites to pending list (prevents race conditions)
      if (request.method === 'POST' && pathname === '/add-sites-batch') {
        const body = await request.json();
        const { sites, email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
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
        
        if (!Array.isArray(sites) || sites.length === 0) {
          return jsonResponse(400, { error: 'sites array required' }, true, request);
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
                console.error('[add-sites-batch] Error fetching customer ID from payments:', dbError);
              }
            }
            
            if (!customerId) {
              return jsonResponse(400, { error: 'customer not found', message: 'No customer found for this email. Please complete a payment first.' }, true, request);
            }
          }
          
          // Get user from database by customerId
          user = await getUserByCustomerId(env, customerId);
          
          // If user doesn't exist yet, create a new user structure
          if (!user) {
            user = {
              email: email,
              customers: [{
                customerId: customerId,
                subscriptions: [],
                created_at: Math.floor(Date.now() / 1000)
              }],
              licenses: [],
              pendingSites: [],
              created_at: Math.floor(Date.now() / 1000),
              updated_at: Math.floor(Date.now() / 1000)
            };
          }
        }

        if (!user.pendingSites) user.pendingSites = [];

        // Determine price to use (same logic as single add-site)
        let priceToUse = null;
        if (user.sites && Object.keys(user.sites).length > 0) {
          const firstSite = Object.values(user.sites).find(s => s.status === 'active');
          if (firstSite && firstSite.price) {
            priceToUse = firstSite.price;
          }
        }
        if (!priceToUse && user.defaultPrice) {
          priceToUse = user.defaultPrice;
        }
        if (!priceToUse && env.DEFAULT_PRICE_ID) {
          priceToUse = env.DEFAULT_PRICE_ID;
        }
        if (!priceToUse) {
          return jsonResponse(400, { 
            error: 'price required', 
            message: 'Please configure DEFAULT_PRICE_ID in wrangler.jsonc.' 
          }, true, request);
        }

        // Add all sites in one atomic operation
        const addedSites = [];
        const errors = [];

        for (const site of sites) {
          const siteStr = site.trim();
          if (!siteStr) {
            continue;
          }
          

          // Check if site already exists
          if (user.sites && user.sites[siteStr] && user.sites[siteStr].status === 'active') {
            errors.push(`${siteStr}: already exists`);
            continue;
          }
          
          const alreadyPending = user.pendingSites.some(s => {
            const pendingSite = s.site || s;
            return pendingSite.toLowerCase().trim() === siteStr.toLowerCase().trim();
          });
          
          if (alreadyPending) {
            errors.push(`${siteStr}: already in pending list`);
            continue;
          }

          // Remove if inactive
          if (user.sites && user.sites[siteStr] && user.sites[siteStr].status === 'inactive') {
            delete user.sites[siteStr];
          }

          // Add to pending list
          user.pendingSites.push({
            site: siteStr,
            price: priceToUse,
            quantity: 1
          });
          addedSites.push(siteStr);
        }

        // Save to both structures if using email-based
        if (userFromEmail && userFromEmail.customers && userFromEmail.customers.length > 0) {
          // Update email-based structure
          userFromEmail.pendingSites = user.pendingSites;
          await saveUserByEmail(env, email, userFromEmail);
        } else {
          // Save to database (all data is in D1, not KV)
          await saveUserByEmail(env, email, user);
        }


        return jsonResponse(200, { 
          success: true, 
          added: addedSites,
          errors: errors,
          message: `Added ${addedSites.length} site(s) to cart. Click "Pay Now" to checkout.`
        }, true, request);
      }

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
      if (request.method === 'GET' && pathname === '/licenses') {
        
        // Try to get email from query parameter (for Memberstack users)
        const emailParam = url.searchParams.get('email');
        
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
            return jsonResponse(401, { error: 'invalid session', message: 'Session token is invalid or expired', licenses: [] }, true, request);
          }
          email = payload.email;
          customerId = payload.customerId;
        } else {
          return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found', licenses: [] }, true, request);
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
                  `SELECT license_key, site_domain, used_site_domain, status, purchase_type, created_at, customer_id, subscription_id, item_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                ).bind(...allCustomerIds).all();
              } catch (columnErr) {
                // Fallback if new columns don't exist yet
                if (columnErr.message && (columnErr.message.includes('no such column: used_site_domain') || columnErr.message.includes('no such column: purchase_type'))) {
                  try {
                    result = await env.DB.prepare(
                      `SELECT license_key, site_domain, status, created_at, customer_id, subscription_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
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
                      `SELECT license_key, site_domain, used_site_domain, purchase_type, status, created_at, customer_id, subscription_id, item_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                    ).bind(...customerIds).all();
                  } catch (colError) {
                    // Fallback if used_site_domain doesn't exist
                    if (colError.message && colError.message.includes('no such column: used_site_domain')) {
                      licenseRes = await env.DB.prepare(
                        `SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                      ).bind(...customerIds).all();
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
        const body = await request.json();
        const { email: emailParam, subscriptionId: subscriptionIdParam } = body;
        
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
        if (!user.pendingSites || user.pendingSites.length === 0) {
          return jsonResponse(400, { error: 'no pending sites to checkout', message: 'Please add sites to the pending list first' }, true, request);
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
        const form = {
          'customer': customerId,
          'success_url': successUrl,
          'cancel_url': cancelUrl,
          'mode': 'payment', // Payment mode like Use Case 3
        };

        // Get price ID from first pending site (all sites should use same price)
        const firstSite = uniquePendingSites[0];
        const priceId = firstSite.price || firstSite.price_id;
        
        if (!priceId) {
              return jsonResponse(400, { 
                error: 'missing_price', 
            message: 'No price ID found for pending sites. Please add sites with valid price IDs.' 
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
        form['line_items[0][price_data][currency]'] = price.currency || 'usd';
        form['line_items[0][price_data][unit_amount]'] = totalAmount;
        form['line_items[0][price_data][product_data][name]'] = `Subscription for ${uniquePendingSites.length} site(s)`;
                form['line_items[0][quantity]'] = 1;
                
        // Store site names and metadata in payment_intent_data (like Use Case 3 stores license keys)
        const siteNames = uniquePendingSites.map(ps => ps.site || ps.site_domain);
        form['payment_intent_data[metadata][usecase]'] = '2'; // Use Case 2 identifier
        form['payment_intent_data[metadata][purchase_type]'] = 'site'; // Distinguish from Use Case 3
        form['payment_intent_data[metadata][customer_id]'] = customerId;
        form['payment_intent_data[metadata][price_id]'] = priceId;
        form['payment_intent_data[metadata][quantity]'] = uniquePendingSites.length.toString();
        form['payment_intent_data[metadata][sites]'] = JSON.stringify(siteNames); // Store sites as JSON array

        // Create checkout session
        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
        
        if (session.status >= 400) {
          console.error(`❌ PAYMENT ERROR: Stripe checkout session creation failed (${session.status}):`, session.body);
          return jsonResponse(500, { 
            error: 'stripe_checkout_failed', 
            message: 'Failed to create checkout session with Stripe. Please try again.',
            details: session.body?.error?.message || 'Unknown error'
          }, true, request);
        }
        
        // Validate session was created successfully
        if (!session.body || !session.body.id || !session.body.url) {
          console.error('❌ PAYMENT ERROR: Invalid checkout session response from Stripe');
          return jsonResponse(500, { 
            error: 'invalid_checkout_session', 
            message: 'Stripe returned an invalid checkout session. Please try again.',
            details: session.body
          }, true, request);
        }

        return jsonResponse(200, {
          sessionId: session.body.id,
          url: session.body.url
        }, true, request);
      }

      // Remove a pending site (before payment)
      // REMOVED: /remove-pending-site endpoint - Can be handled in frontend
      if (false && request.method === 'POST' && pathname === '/remove-pending-site') {
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
            
            const memberstackMember = await getMemberstackMember(email, env);
            
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
          const member = await createMemberstackMember(email, env);

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
      if (request.method === 'POST' && pathname === '/process-queue') {
        const { limit = 10 } = await request.json().catch(() => ({}));
        const result = await processSubscriptionQueue(env, limit);
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
        const { email: emailParam, quantity, subscription_id: subscriptionIdParam } = await request.json();

        if (!quantity || quantity < 1) {
          return jsonResponse(400, {
            error: 'invalid_quantity',
            message: 'Quantity must be at least 1'
          }, true, request);
        }
        
        // Safety limit: Maximum recommended quantity for safe subscription creation
        // Stripe API rate limit: ~100 requests/second
        // Cloudflare Workers execution time: 30 seconds (free) / 50 seconds (paid)
        // Recommended: 50 subscriptions max per purchase for safe processing
        const MAX_RECOMMENDED_QUANTITY = parseInt(env.MAX_QUANTITY_PER_PURCHASE) || 25;
        
        if (quantity > MAX_RECOMMENDED_QUANTITY) {
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
          return jsonResponse(400, { error: 'invalid_email' }, true, request);
        }

        /* ─────────────────────────────
           LOAD USER & SUBSCRIPTION
        ───────────────────────────── */
        const user = await getUserByEmail(env, email);

        if (!user?.customers?.length) {
          return jsonResponse(400, {
            error: 'no_customer',
            message: 'Customer account required'
          }, true, request);
        }

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
           PRICE
        ───────────────────────────── */
        const priceId = env.LICENSE_PRICE_ID || env.DEFAULT_PRICE_ID;
        if (!priceId) {
          return jsonResponse(500, {
            error: 'price_not_configured',
            message: 'License price ID not configured'
          }, true, request);
        }

        /* ─────────────────────────────
           STEP 1: CALCULATE AMOUNT (FULL PRICE FOR NEW SUBSCRIPTIONS)
           Option 2: Creating separate subscriptions (one per license)
           Since we're creating NEW subscriptions, there's no proration - charge full price
        ───────────────────────────── */
        let proratedAmount = 0;
        let invoiceCurrency = 'usd'; // Default currency
        const licenseKeys = generateLicenseKeys(quantity);
        
        try {
          // Get price details for full price calculation
          const priceRes = await stripeFetch(env, `/prices/${priceId}`);
          if (priceRes.status === 200) {
            const price = priceRes.body;
            const unitPrice = price.unit_amount || 0;
            invoiceCurrency = price.currency || 'usd';
            
            // For Option 2 (separate subscriptions), charge full price per license
            // No proration needed since we're creating NEW subscriptions
            proratedAmount = unitPrice * quantity;
          } else {
            console.warn(`[USE CASE 3] ⚠️ Could not get price details, status: ${priceRes.status}`);
            proratedAmount = 0;
          }
        } catch (invoiceErr) {
          console.error('[USE CASE 3] ❌ Error getting prorated amount:', invoiceErr);
          // Fallback: Calculate estimated amount
          try {
            const priceRes = await stripeFetch(env, `/prices/${priceId}`);
            if (priceRes.status === 200) {
              const price = priceRes.body;
              proratedAmount = (price.unit_amount || 0) * quantity;
            }
          } catch (priceErr) {
            console.error('[USE CASE 3] ❌ Error getting price for fallback:', priceErr);
          }
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
            'metadata[price_id]': priceId, // Store price ID for webhook
            'metadata[quantity]': quantity.toString() // Store quantity for webhook
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

        // Create checkout session with the prorated amount
        // Subscription items will be added AFTER payment succeeds with proration_behavior: 'none'
        const form = {
          mode: 'payment', // One-time payment for prorated amount
          customer: customerId,
          'payment_method_types[0]': 'card',
          // Use custom price_data with prorated amount retrieved from Stripe
          'line_items[0][price_data][currency]': invoiceCurrency,
          'line_items[0][price_data][unit_amount]': proratedAmount,
          'line_items[0][price_data][product_data][name]': `${quantity} License${quantity > 1 ? 's' : ''} Purchase`,
          'line_items[0][price_data][product_data][description]': `Creating ${quantity} new subscription${quantity > 1 ? 's' : ''} (one per license) for individual management`,
          'line_items[0][quantity]': 1, // Always 1 since amount is already prorated
          'payment_intent_data[metadata][usecase]': '3', // Primary identifier for Use Case 3
          'payment_intent_data[metadata][customer_id]': customerId, // Required for webhook
          'payment_intent_data[metadata][license_keys]': JSON.stringify(licenseKeys), // Required: license keys
          'payment_intent_data[metadata][price_id]': priceId, // Required: to create subscriptions after payment
          'payment_intent_data[metadata][quantity]': quantity.toString(), // Required: quantity to create
          'payment_intent_data[metadata][currency]': invoiceCurrency, // Store currency for reference
          'payment_intent_data[setup_future_usage]': 'off_session', // Save payment method for future subscriptions
          'success_url': `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
          'cancel_url': dashboardUrl
        };

        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);

        if (session.status >= 400) {
          // No rollback needed - items will be added after payment succeeds
          console.error('[USE CASE 3] ❌ Checkout session creation failed:', session.body);
          
          return jsonResponse(500, {
            error: 'checkout_failed',
            message: 'Failed to create checkout session'
          }, true, request);
        }

        return jsonResponse(200, {
          checkout_url: session.body.url,
          session_id: session.body.id,
          prorated_amount: proratedAmount,
          currency: invoiceCurrency,
          quantity: quantity,
          license_keys: licenseKeys.length
        }, true, request);
      }

      // Activate license endpoint - associates a license key with a site
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
            'SELECT license_key, used_site_domain, status, customer_id, subscription_id, item_id, purchase_type FROM licenses WHERE license_key = ?'
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
          
          // Allow updating site domain if already used (don't block, just update)
          const isUpdating = !!licenseRes.used_site_domain;
          if (isUpdating) {
          }
          
          // Check if inactive
          if (licenseRes.status !== 'active') {
            console.warn(`[activate-license] ⚠️ License is not active: ${licenseRes.status}`);
            return jsonResponse(400, { error: 'inactive_license', message: 'This license is not active' }, true, request);
          }
          
          const timestamp = Math.floor(Date.now() / 1000);
          
          // Step 1: Update license with used site domain
          const licenseUpdate = await env.DB.prepare(
            'UPDATE licenses SET used_site_domain = ?, updated_at = ? WHERE license_key = ?'
          ).bind(site_domain, timestamp, license_key).run();
          
          
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
          
          const actionText = isUpdating ? 'updated' : 'activated';
          const message = isUpdating 
            ? `License site updated successfully from ${licenseRes.used_site_domain} to ${site_domain}`
            : 'License activated successfully';
          
          
          return jsonResponse(200, { 
            success: true, 
            message: message,
            license_key: license_key,
            site_domain: site_domain,
            previous_site: isUpdating ? licenseRes.used_site_domain : null,
            status: 'used',
            is_used: true,
            was_update: isUpdating
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
      return new Response('Internal server error', { status: 500 });
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
