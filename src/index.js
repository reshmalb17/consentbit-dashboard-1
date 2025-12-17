/*
Cloudflare Worker (module) - Stripe Checkout + Dashboard user mgmt
Deploy: Cloudflare Workers (Wrangler v3) or Pages Functions

Bindings required (set in your worker's environment):
- STRIPE_SECRET_KEY: your Stripe secret key
- STRIPE_WEBHOOK_SECRET: your Stripe webhook signing secret (optional but recommended)
- JWT_SECRET: HMAC secret for magic links / session tokens
- USERS_KV (KV namespace binding)
- SESSION_KV (KV namespace binding)
- EMAIL_FROM: (optional) from address for email provider

Notes:
- This Worker uses fetch to call Stripe REST API (no stripe-node dependency) so it runs cleanly on Workers.
- For sending emails, replace the placeholder sendEmail() with your preferred provider (Sendgrid, Mailgun, Postmark, etc.).
- This is an illustrative starting point — add production hardening (rate limits, validation, logging, retries).

Endpoints implemented:
POST /create-checkout-session    -> create a Stripe Checkout Session (for multiple sites, single subscription with items)
POST /webhook                    -> handle Stripe webhooks (payment_intent.succeeded, checkout.session.completed, customer.subscription.updated)
POST /magic-link                 -> request a magic login link (creates a session token and returns a link)
GET  /auth/callback?token=...    -> verifies token and sets session cookie (redirects to dashboard URL)
GET  /dashboard                  -> returns the user's sites and billing info (requires session cookie)
POST /add-site                   -> add a site (create subscription_item)
POST /remove-site                -> remove a site (delete subscription_item)

KV usage (simple schema):
- USERS_KV: key `user:{customerId}` => JSON { customerId, email, subscriptionId, items: {site -> itemId}} 
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

function jsonResponse(status, body, cors = true) {
  const headers = { 'content-type': 'application/json' };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
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

// Send email placeholder — replace with real provider
async function sendEmail(to, subject, html) {
  // Implement SendGrid / Mailgun / Postmark call here using fetch
  // e.g. fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: {...}, body: JSON.stringify({...}) })
  // For testing, we'll just log
  console.log('SEND EMAIL', to, subject);
  return true;
}

// Basic auth cookie helper
function createSessionCookie(token, maxAge = 60 * 60 * 24 * 7) {
  const cookie = `sb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return cookie;
}

// Stripe helper using fetch
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
        console.log(`📦 Encoded form contains ${lineItemMatches.length} line_items[][price]`);
      }
    } else {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
    console.log(`Stripe API ${method} ${path}`);
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    try {
      if (request.method === 'POST' && pathname === '/create-checkout-session') {
        // Create a Checkout Session to collect payment for N sites and create a single subscription with multiple items
        console.log('Creating checkout session...');
        const data = await request.json();
        console.log('Request data:', JSON.stringify(data));
        // expected: { customerEmail, sites: [{site: 'site1.com', price: 'price_10'} , ...], success_url, cancel_url }
        const { customerEmail, sites, success_url, cancel_url } = data;
        if (!customerEmail || !Array.isArray(sites) || sites.length === 0) {
          console.error('Validation failed: missing customerEmail or sites');
          return jsonResponse(400, { error: 'missing customerEmail or sites' });
        }

        // Create (or find) customer
        // For simplicity, we always create a new customer tied to the email
        console.log('Creating Stripe customer for email:', customerEmail);
        const cust = await stripeFetch(env, '/customers', 'POST', { email: customerEmail }, true);
        if (cust.status >= 400) {
          console.error('Stripe customer creation failed:', cust.status, cust.body);
          return jsonResponse(500, { error: 'stripe customer create failed', details: cust.body });
        }
        const customerId = cust.body.id;
        console.log('Customer created:', customerId);

        // Prepare line items for Checkout - ONE subscription with MULTIPLE subscription items
        // Each site becomes a separate subscription item with metadata
        const form = {
          'mode': 'subscription',
          'customer': customerId,
          'success_url': success_url || `${url.origin}/success`,
          'cancel_url': cancel_url || `${url.origin}/cancel`,
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

        console.log('Creating checkout session with form data:', JSON.stringify(form));
        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
        if (session.status >= 400) {
          console.error('Stripe checkout session creation failed:', session.status, session.body);
          return jsonResponse(500, { error: 'stripe checkout session failed', details: session.body });
        }

        console.log('Checkout session created successfully:', session.body.id);
        
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
        // Stripe webhook handler - for production, verify signature header using STRIPE_WEBHOOK_SECRET
        const raw = await request.text();
        const sig = request.headers.get('stripe-signature');
        const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

        // Simple handling (signature verification omitted here) - strongly recommend verifying using stripe-node or manual HMAC verification.
        // We'll just parse the event directly from the raw body
        let event;
        try {
          event = JSON.parse(raw);
        } catch (e) {
          return new Response('invalid payload', { status: 400 });
        }

        // Handle checkout.session.completed - save payment details and generate magic link
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const subscriptionId = session.subscription;
          const customerId = session.customer;
          const email = session.customer_details?.email || session.customer_email;

          if (!subscriptionId || !customerId || !email) {
            console.error('Missing subscription_id, customer_id, or email in checkout.session.completed');
            return new Response('ok');
          }

          console.log('Processing checkout.session.completed:', { subscriptionId, customerId, email });
          
          // Generate operation ID for tracking (used throughout payment processing)
          const operationId = `payment_${customerId}_${subscriptionId}_${Date.now()}`;
          console.log(`[${operationId}] Starting payment processing`);
          
          // Extract site URL from custom field using the key "enteryourlivesiteurl"
          let customFieldSiteUrl = null;
          if (session.custom_fields && session.custom_fields.length > 0) {
            console.log('Custom fields in session:', JSON.stringify(session.custom_fields, null, 2));
            
            // Look for the specific key "enteryourlivesiteurl"
            const siteUrlField = session.custom_fields.find(field => 
              field.key === 'enteryourlivesiteurl' || field.key === 'enteryourlivesiteur'
            );
            
            if (siteUrlField) {
              if (siteUrlField.type === 'text' && siteUrlField.text && siteUrlField.text.value) {
                customFieldSiteUrl = siteUrlField.text.value.trim();
                console.log('✅ Extracted site URL from custom field "enteryourlivesiteurl":', customFieldSiteUrl);
              } else {
                console.log('Site URL field found but value is missing:', JSON.stringify(siteUrlField, null, 2));
              }
            } else {
              console.log('Custom field with key "enteryourlivesiteurl" not found. Available keys:', 
                session.custom_fields.map(f => f.key));
            }
          } else {
            console.log('No custom_fields found in checkout.session.completed event');
          }

          // Retrieve the subscription and its items
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status !== 200) {
            console.error('Failed to fetch subscription:', subRes.status);
            return new Response('ok');
          }

            const sub = subRes.body;
          
          // Get site metadata from subscription metadata (temporary storage from checkout)
          const subscriptionMetadata = sub.metadata || {};
          const sitesFromMetadata = [];
          Object.keys(subscriptionMetadata).forEach(key => {
            if (key.startsWith('site_')) {
              const index = parseInt(key.replace('site_', ''));
              sitesFromMetadata[index] = subscriptionMetadata[key];
            }
          });

          // Map subscription items to sites
          // Structure: { site: 'site1.com', item_id: 'si_xxx', price: 'price_xxx', status: 'active' }
          
          // CRITICAL: Check if user exists by customerId first
          let userKey = `user:${customerId}`;
          let existingUser = await env.USERS_KV.get(userKey);
          let user = null;
          
          if (existingUser) {
            // User found by customerId - use existing record
            user = JSON.parse(existingUser);
            console.log(`[${operationId}] Found existing user by customerId: ${customerId}`);
            // Ensure email is up to date
            if (!user.email || user.email !== email) {
              user.email = email;
            }
          } else {
            // User not found by customerId - check if email already exists in system
            // This handles the case where payment link creates a NEW customerId for same email
            console.log(`[${operationId}] User not found by customerId ${customerId}, searching by email: ${email}`);
            
            // Find ALL existing customer IDs with this email from D1
            let allExistingCustomerIds = [];
            if (env.DB) {
              try {
                const emailCheck = await env.DB.prepare(
                  'SELECT DISTINCT customer_id FROM payments WHERE email = ?'
                ).bind(email).all();
                
                if (emailCheck && emailCheck.results) {
                  allExistingCustomerIds = emailCheck.results
                    .map(row => row.customer_id)
                    .filter(id => id && id.startsWith('cus_'));
                  console.log(`[${operationId}] Found ${allExistingCustomerIds.length} existing customer_id(s) for email ${email}:`, allExistingCustomerIds);
                }
              } catch (dbErr) {
                console.error(`[${operationId}] Error checking D1 for existing customers:`, dbErr);
              }
            }
            
            // Try to find an existing user record from any of the customer IDs
            // Use the FIRST one found as the "primary" record
            let primaryCustomerId = null;
            for (const existingCustomerId of allExistingCustomerIds) {
              const existingUserKey = `user:${existingCustomerId}`;
              const existingUserRaw = await env.USERS_KV.get(existingUserKey);
              
              if (existingUserRaw) {
                user = JSON.parse(existingUserRaw);
                primaryCustomerId = existingCustomerId;
                console.log(`[${operationId}] Found existing user record by email! Primary customerId: ${primaryCustomerId}, New customerId: ${customerId}`);
                console.log(`[${operationId}] Total customers with same email: ${allExistingCustomerIds.length + 1}`);
                break; // Use first found as primary
              }
            }
            
            // If we found an existing user, we'll create a NEW user record for this new customerId
            // but link them together via email. Both records will exist separately.
            if (user && primaryCustomerId) {
              // Keep the existing user record as-is (don't modify it)
              // Create a NEW user record for this new customerId
              // Both will be linked by email and merged in dashboard
              console.log(`[${operationId}] Creating new user record for customerId ${customerId} (email ${email} already exists under ${primaryCustomerId})`);
              user = {
                customerId,
                subscriptionId: sub.id,
                email: email,
                sites: {}, // site -> { item_id, price, status }
                linkedCustomerIds: [...allExistingCustomerIds, customerId] // Track all customer IDs with same email
              };
            } else {
              // No existing user found - create new user record
              console.log(`[${operationId}] No existing user found, creating new user record for customerId: ${customerId}`);
              user = {
                customerId,
                subscriptionId: sub.id,
                email: email,
                sites: {} // site -> { item_id, price, status }
              };
            }
          }

          // Ensure email is set (in case it was missing)
          if (!user.email || user.email !== email) {
            user.email = email;
          }

          // Handle subscription ID - if user has existing subscription, we need to decide:
          // Option 1: Keep existing subscription (if adding to existing)
          // Option 2: Use new subscription (if this is a separate payment)
          // For now, if user has existing subscription and this is a new one, we'll merge sites but keep both subscriptions
          // The primary subscriptionId will be the first one, but we'll track all subscriptions
          
          if (!user.subscriptionId) {
            // No existing subscription - use this one
            user.subscriptionId = sub.id;
            console.log(`[${operationId}] Set primary subscriptionId to: ${sub.id}`);
          } else if (user.subscriptionId !== sub.id) {
            // User has existing subscription, but this is a different one
            // This happens when user pays via payment link (creates new subscription)
            console.log(`[${operationId}] User has existing subscription ${user.subscriptionId}, but payment created new subscription ${sub.id}`);
            console.log(`[${operationId}] This is a separate subscription - will merge sites into existing user record`);
            
            // Keep the original subscription as primary, but we'll add sites from this new subscription
            // Note: In Stripe, these are separate subscriptions, but in our system, we merge them under one user
            // The user will see all sites from both subscriptions in their dashboard
          }
          
          // Check if this checkout is adding items to an existing subscription
          const existingSubscriptionId = subscriptionMetadata.existing_subscription_id;
          const addToExisting = subscriptionMetadata.add_to_existing === 'true';
          
          if (addToExisting && existingSubscriptionId) {
            console.log('Adding items to existing subscription:', existingSubscriptionId);
            
            // Get the existing subscription
            const existingSubRes = await stripeFetch(env, `/subscriptions/${existingSubscriptionId}`);
            if (existingSubRes.status === 200) {
              const existingSub = existingSubRes.body;
              
              // IMPORTANT: Preserve existing sites from the user record
              // Don't overwrite - merge with existing sites
              if (!user.sites) user.sites = {};
              
              // Create a backup of existing sites to preserve them
              const existingSitesBackup = { ...user.sites };
              console.log('Preserving existing sites:', Object.keys(existingSitesBackup));
              
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
                      user.sites[existingSite].status = 'active'; // Ensure it's active
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
                  console.log('Preserved existing site:', site);
                } else if (existingSiteData.status === 'active' && existingSiteData.item_id) {
                  // Site is active but not found in Stripe - might have been removed, but keep it for now
                  // (customer.subscription.updated webhook will handle marking it inactive)
                  user.sites[site] = existingSiteData;
                  console.log('Preserved active site not in current Stripe items:', site);
                }
              });
              
              // Add each new item to the existing subscription
              for (let index = 0; index < sub.items.data.length; index++) {
                const item = sub.items.data[index];
                // Sites are stored in metadata (site_0, site_1, etc.)
                const site = sitesFromMetadata[index] || `site_${index + 1}`;
                console.log(`Adding item ${index} to existing subscription for site: ${site}`);
                
                // Add subscription item to existing subscription
                const addItemRes = await stripeFetch(env, '/subscription_items', 'POST', {
                  'subscription': existingSubscriptionId,
                  'price': item.price.id,
                  'quantity': item.quantity || 1,
                  'metadata[site]': site
                }, true);
                
                if (addItemRes.status === 200) {
                  const newItem = addItemRes.body;
                  
                  // Add new site to user record (preserving existing sites)
                  user.sites[site] = {
                    item_id: newItem.id,
                    price: newItem.price.id,
                    quantity: newItem.quantity,
                    status: 'active',
                    created_at: Math.floor(Date.now() / 1000)
                  };
                  
                  console.log('Added item to existing subscription:', site, '->', newItem.id);
                } else {
                  console.error('Failed to add item to existing subscription:', addItemRes.status, addItemRes.body);
                }
              }
              
              // Cancel the new subscription (we don't need it, items are in existing subscription)
              await stripeFetch(env, `/subscriptions/${sub.id}`, 'POST', { cancel_at_period_end: false }, true).catch(err => {
                console.error('Failed to cancel duplicate subscription:', err);
              });
              
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
                
                console.log(`[${operationId}] Removing pending sites. Added sites from checkout:`, addedSites);
                console.log(`[${operationId}] Sites just added to existing subscription:`, justAddedSites);
                console.log(`[${operationId}] Sites now in user record:`, sitesInUserRecord);
                console.log(`[${operationId}] Current pending sites:`, user.pendingSites.map(p => p.site));
                
                const beforeCount = user.pendingSites.length;
                
                // Remove pending sites that match any added site (case-insensitive)
                // Also remove if the site is now in user.sites (was successfully added)
                user.pendingSites = user.pendingSites.filter(pending => {
                  const pendingSiteLower = pending.site.toLowerCase().trim();
                  const isAdded = addedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                  justAddedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                  sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                  if (isAdded) {
                    console.log(`[${operationId}] ✅ Removing pending site: ${pending.site} (now active)`);
                  }
                  return !isAdded;
                });
                
                const afterCount = user.pendingSites.length;
                console.log(`[${operationId}] Removed ${beforeCount - afterCount} pending site(s). Remaining: ${afterCount}`);
                if (afterCount > 0) {
                  console.log(`[${operationId}] ⚠️  WARNING: ${afterCount} pending site(s) still remain after payment:`, user.pendingSites.map(p => p.site));
                  // If we added sites but pending sites remain, they might be from a different source
                  // Remove any pending sites that are now in user.sites (double-check)
                  const stillPending = user.pendingSites.filter(pending => {
                    const pendingSiteLower = pending.site.toLowerCase().trim();
                    const isNowActive = sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                    if (isNowActive) {
                      console.log(`[${operationId}] ✅ Found and removing pending site that is now active: ${pending.site}`);
                    }
                    return !isNowActive;
                  });
                  user.pendingSites = stillPending;
                  console.log(`[${operationId}] After double-check, remaining pending sites:`, user.pendingSites.length);
                }
              } else {
                console.log(`[${operationId}] No pending sites to remove (pendingSites is empty or null)`);
              }
              
              // CRITICAL: Retry KV update for user sites (payment already successful)
              let userSitesSaved = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await env.USERS_KV.put(userKey, JSON.stringify(user));
                  userSitesSaved = true;
                  console.log(`[${operationId}] Added items to existing subscription and updated user record (attempt ${attempt + 1}). Total sites:`, Object.keys(user.sites).length);
                  break;
                } catch (kvError) {
                  if (attempt === 2) {
                    console.error(`[${operationId}] CRITICAL: Failed to save user sites after 3 attempts:`, kvError);
                    failedOperations.push({ 
                      type: 'save_user_sites', 
                      error: kvError.message,
                      data: { customerId, subscriptionId, sites: user.sites }
                    });
                    // Queue for background retry
                    await env.USERS_KV.put(`sync_pending:user_sites_${operationId}`, JSON.stringify({
                      operation: 'save_user_sites',
                      customerId,
                      subscriptionId,
                      sites: user.sites,
                      timestamp: Date.now(),
                      retryCount: 0
                    })).catch(e => console.error(`[${operationId}] Failed to queue user sites for retry:`, e));
                  } else {
                    const delay = 1000 * Math.pow(2, attempt);
                    console.log(`[${operationId}] KV user sites save failed, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                  }
                }
              }
              
              // Continue to payment processing below (skip normal mapping since we already handled it)
            } else {
              console.error('Failed to fetch existing subscription:', existingSubscriptionId);
              // Fall through to normal flow
            }
          }
          
          // Normal flow: map items to sites for new subscription (only if not adding to existing)
          if (!addToExisting || !existingSubscriptionId) {
            // Store default price from first subscription item for future use
            if (sub.items && sub.items.data && sub.items.data.length > 0 && !user.defaultPrice) {
              user.defaultPrice = sub.items.data[0].price.id;
              console.log('Stored default price for user:', user.defaultPrice);
            }

            // Map each subscription item to its site
            // Sites are stored in subscription metadata (site_0, site_1, etc.)
            sub.items.data.forEach((item, index) => {
              // Use metadata first, fallback to index-based naming
              const site = sitesFromMetadata[index] || `site_${index + 1}`;
              console.log(`Mapping subscription item ${index} to site: ${site}`);
              
              // Update site mapping
              user.sites[site] = {
                item_id: item.id,
                price: item.price.id,
                quantity: item.quantity,
                status: 'active',
                created_at: Math.floor(Date.now() / 1000)
              };

              // Also set metadata on the subscription item for future reference
              if (!item.metadata || !item.metadata.site) {
                // Format metadata correctly for form-encoded request
                const metadataForm = {
                  'metadata[site]': site
                };
                stripeFetch(env, `/subscription_items/${item.id}`, 'POST', metadataForm, true).catch(err => {
                  console.error('Failed to set item metadata:', err);
                });
              }
            });

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
              
              console.log(`[${operationId}] Removing pending sites (new subscription flow). Added sites from checkout:`, addedSites);
              console.log(`[${operationId}] Sites now in user record:`, sitesInUserRecord);
              console.log(`[${operationId}] Current pending sites:`, user.pendingSites.map(p => p.site));
              
              const beforeCount = user.pendingSites.length;
              
              // Remove pending sites that match any added site (case-insensitive, trimmed)
              // Also remove if the site is now in user.sites (was successfully added)
              user.pendingSites = user.pendingSites.filter(pending => {
                const pendingSiteLower = pending.site.toLowerCase().trim();
                const isAdded = addedSites.some(added => added.toLowerCase().trim() === pendingSiteLower) ||
                                sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                if (isAdded) {
                  console.log(`[${operationId}] ✅ Removing pending site: ${pending.site} (now active)`);
                }
                return !isAdded;
              });
              
              const afterCount = user.pendingSites.length;
              console.log(`[${operationId}] Removed ${beforeCount - afterCount} pending site(s). Remaining: ${afterCount}`);
              if (afterCount > 0) {
                console.log(`[${operationId}] ⚠️  WARNING: ${afterCount} pending site(s) still remain after payment:`, user.pendingSites.map(p => p.site));
                // If we added sites but pending sites remain, they might be from a different source
                // Remove any pending sites that are now in user.sites (double-check)
                const stillPending = user.pendingSites.filter(pending => {
                  const pendingSiteLower = pending.site.toLowerCase().trim();
                  const isNowActive = sitesInUserRecord.some(site => site.toLowerCase().trim() === pendingSiteLower);
                  if (isNowActive) {
                    console.log(`[${operationId}] ✅ Found and removing pending site that is now active: ${pending.site}`);
                  }
                  return !isNowActive;
                });
                user.pendingSites = stillPending;
                console.log(`[${operationId}] After double-check, remaining pending sites:`, user.pendingSites.length);
              }
            } else {
              console.log(`[${operationId}] No pending sites to remove (pendingSites is empty or null)`);
            }
            
            // CRITICAL: Retry KV update for user sites (payment already successful)
            let userSitesSaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await env.USERS_KV.put(userKey, JSON.stringify(user));
                userSitesSaved = true;
                console.log(`[${operationId}] Updated user record with sites mapping (attempt ${attempt + 1})`);
                break;
              } catch (kvError) {
                if (attempt === 2) {
                  console.error(`[${operationId}] CRITICAL: Failed to save user sites after 3 attempts:`, kvError);
                  failedOperations.push({ 
                    type: 'save_user_sites', 
                    error: kvError.message,
                    data: { customerId, subscriptionId, sites: user.sites }
                  });
                  // Queue for background retry
                  await env.USERS_KV.put(`sync_pending:user_sites_${operationId}`, JSON.stringify({
                    operation: 'save_user_sites',
                    customerId,
                    subscriptionId,
                    sites: user.sites,
                    timestamp: Date.now(),
                    retryCount: 0
                  })).catch(e => console.error(`[${operationId}] Failed to queue user sites for retry:`, e));
                } else {
                  const delay = 1000 * Math.pow(2, attempt);
                  console.log(`[${operationId}] KV user sites save failed, retrying in ${delay}ms...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
            }
          }

          // Save payment details to database and generate magic link
          // CRITICAL: Payment is already successful - we MUST complete all operations
          // If any operation fails, queue it for retry but always return 'ok' to Stripe
          const failedOperations = [];
          
          try {
            // Get site domain from subscription metadata (site_0, site_1, etc.)
            // Sites are already stored in subscription metadata when checkout is created
            let siteDomain = subscriptionMetadata.site_0 || 'unknown';
            
            // For multiple sites, use the first one for the payment record
            if (siteDomain === 'unknown' && sub.items && sub.items.data && sub.items.data.length > 0) {
              const firstItem = sub.items.data[0];
              siteDomain = firstItem.metadata?.site || 'unknown';
            }
            
            console.log(`[${operationId}] Site domain for payment record:`, siteDomain);
            
            // Legacy: Check custom fields (for backward compatibility with old payment links)
            // New checkouts use metadata (site_0, site_1, etc.) so this won't be needed
            if (siteDomain === 'unknown' && session.custom_fields && session.custom_fields.length > 0) {
              const siteUrlField = session.custom_fields.find(field => 
                field.key === 'enteryourlivesiteurl' || 
                (field.type === 'text' && field.text && field.text.value)
              );
              if (siteUrlField && siteUrlField.text && siteUrlField.text.value) {
                siteDomain = siteUrlField.text.value.trim();
                console.log(`[${operationId}] Found site URL in custom field (legacy):`, siteDomain);
              }
            }

            // Get amount from session or subscription
            const amount = session.amount_total || 0;
            const currency = session.currency || 'usd';

            // Generate magic login link
            const token = await signToken(env, { customerId, email }, 60 * 60 * 24 * 7); // 7 days expiry
            const sessionKey = `session:${token}`;
            
            // Retry KV operations with exponential backoff
            let sessionSaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await env.SESSION_KV.put(sessionKey, JSON.stringify({ 
                  customerId, 
                  email, 
                  exp: Date.now() + 1000 * 60 * 60 * 24 * 7 
                }));
                sessionSaved = true;
                console.log(`[${operationId}] Session saved to KV (attempt ${attempt + 1})`);
                break;
              } catch (kvError) {
                if (attempt === 2) {
                  console.error(`[${operationId}] Failed to save session after 3 attempts:`, kvError);
                  failedOperations.push({ type: 'save_session', error: kvError.message });
                } else {
                  const delay = 1000 * Math.pow(2, attempt);
                  console.log(`[${operationId}] KV save failed, retrying in ${delay}ms...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
            }

            const dashboardUrl = `${url.origin}/auth/callback?token=${encodeURIComponent(token)}&redirect=/dashboard.html`;
            const magicLink = dashboardUrl;

            // Save payment details to D1 database (with retry)
            if (env.DB) {
              let paymentSaved = false;
              for (let attempt = 0; attempt < 3; attempt++) {
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
                    subscriptionId,
                    email,
                    amount,
                    currency,
                    'succeeded',
                    siteDomain,
                    magicLink,
                    1,
                    timestamp,
                    timestamp
                  ).run();

                  paymentSaved = true;
                  console.log(`[${operationId}] Payment details saved to database (attempt ${attempt + 1})`);
                  break;
                } catch (dbError) {
                  if (attempt === 2) {
                    console.error(`[${operationId}] Failed to save payment to D1 after 3 attempts:`, dbError);
                    failedOperations.push({ 
                      type: 'save_payment', 
                      error: dbError.message,
                      data: { customerId, subscriptionId, email, amount, currency, siteDomain, magicLink }
                    });
                  } else {
                    const delay = 1000 * Math.pow(2, attempt);
                    console.log(`[${operationId}] D1 save failed, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                  }
                }
              }
              
              // If payment save failed, queue for background retry
              if (!paymentSaved) {
                await env.USERS_KV.put(`sync_pending:payment_${operationId}`, JSON.stringify({
                  operation: 'save_payment',
                  customerId,
                  subscriptionId,
                  email,
                  amount,
                  currency,
                  siteDomain,
                  magicLink,
                  timestamp: Date.now(),
                  retryCount: 0
                }));
                console.log(`[${operationId}] Queued payment save for background retry`);
              }
            }

            // Generate license keys immediately after payment (one per subscription item/site)
            // This ensures licenses are available right away, not waiting for invoice.payment_succeeded
            if (sub.items && sub.items.data && sub.items.data.length > 0) {
              const siteCount = sub.items.data.length;
              console.log('Generating license keys immediately after payment for', siteCount, 'site(s)');
              
              // Map sites to subscription items - get site from metadata or user record
              const userKey = `user:${customerId}`;
              const existingUser = await env.USERS_KV.get(userKey);
              const userData = existingUser ? JSON.parse(existingUser) : { sites: {} };
              
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
              
              // Generate one license per subscription item, mapped to its site
              const licensesToCreate = [];
              sub.items.data.forEach((item, index) => {
                // Get site from item metadata, user record, or subscription metadata
                let site = item.metadata?.site;
                if (!site) {
                  // Try to find site in user record by item_id
                  const siteEntry = Object.entries(userData.sites || {}).find(([_, data]) => data.item_id === item.id);
                  if (siteEntry) {
                    site = siteEntry[0];
                  } else {
                    // Fallback to subscription metadata
                    site = sitesFromMetadata[index] || `site_${index + 1}`;
                  }
                }
                
                // Check if license already exists for this site
                const existingForSite = existingLicenses.find(l => l.site === site);
                if (!existingForSite) {
                  licensesToCreate.push({ site, item_id: item.id });
                }
              });
              
              if (licensesToCreate.length > 0) {
                const licenseKeys = generateLicenseKeys(licensesToCreate.length);
                console.log(`[${operationId}] Generated ${licenseKeys.length} license key(s) for sites:`, licensesToCreate.map(l => l.site));
                
                // Save to D1 database with site mapping (with retry)
                if (env.DB) {
                  let licensesSaved = false;
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                      const timestamp = Math.floor(Date.now() / 1000);
                      const inserts = licenseKeys.map((key, idx) => {
                        const site = licensesToCreate[idx].site;
                        return env.DB.prepare(
                          'INSERT INTO licenses (customer_id, subscription_id, license_key, site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                        ).bind(customerId, subscriptionId, key, site, 'active', timestamp, timestamp);
                      });
                      const batch = env.DB.batch(inserts);
                      await batch;
                      licensesSaved = true;
                      console.log(`[${operationId}] Saved ${licenseKeys.length} license(s) to database (attempt ${attempt + 1})`);
                      break;
                    } catch (dbError) {
                      if (attempt === 2) {
                        console.error(`[${operationId}] Database error saving licenses after 3 attempts:`, dbError);
                        failedOperations.push({ 
                          type: 'save_licenses', 
                          error: dbError.message,
                          data: { customerId, subscriptionId, licenses: licenseKeys.map((key, idx) => ({
                            license_key: key,
                            site_domain: licensesToCreate[idx].site
                          }))}
                        });
                      } else {
                        const delay = 1000 * Math.pow(2, attempt);
                        console.log(`[${operationId}] D1 license save failed, retrying in ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                      }
                    }
                  }
                  
                  // If license save failed, queue for background retry
                  if (!licensesSaved) {
                    await env.USERS_KV.put(`sync_pending:licenses_${operationId}`, JSON.stringify({
                      operation: 'save_licenses',
                      customerId,
                      subscriptionId,
                      licenses: licenseKeys.map((key, idx) => ({
                        license_key: key,
                        site_domain: licensesToCreate[idx].site
                      })),
                      timestamp: Date.now(),
                      retryCount: 0
                    }));
                    console.log(`[${operationId}] Queued license save for background retry`);
                  }
                }
                
                // Save to KV with site mapping (with retry)
                let licensesKVSaved = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                  try {
                    let userDataForKV = existingUser ? JSON.parse(existingUser) : { customerId, subscriptionId, licenses: [] };
                    if (!userDataForKV.licenses) userDataForKV.licenses = [];
                    licenseKeys.forEach((key, idx) => {
                      const site = licensesToCreate[idx].site;
                      userDataForKV.licenses.push({
                        license_key: key,
                        site_domain: site,
                        subscription_id: subscriptionId,
                        status: 'active',
                        created_at: Math.floor(Date.now() / 1000)
                      });
                    });
                    await env.USERS_KV.put(userKey, JSON.stringify(userDataForKV));
                    licensesKVSaved = true;
                    console.log(`[${operationId}] Updated user licenses in KV (attempt ${attempt + 1})`);
                    break;
                  } catch (kvError) {
                    if (attempt === 2) {
                      console.error(`[${operationId}] KV error saving licenses after 3 attempts:`, kvError);
                      failedOperations.push({ 
                        type: 'save_licenses_kv', 
                        error: kvError.message,
                        data: { customerId, subscriptionId, licenses: licenseKeys.map((key, idx) => ({
                          license_key: key,
                          site_domain: licensesToCreate[idx].site
                        }))}
                      });
                    } else {
                      const delay = 1000 * Math.pow(2, attempt);
                      console.log(`[${operationId}] KV license save failed, retrying in ${delay}ms...`);
                      await new Promise(resolve => setTimeout(resolve, delay));
                    }
                  }
                }
                
                // If KV license save failed, queue for background retry
                if (!licensesKVSaved) {
                  await env.USERS_KV.put(`sync_pending:licenses_kv_${operationId}`, JSON.stringify({
                    operation: 'save_licenses_kv',
                    customerId,
                    subscriptionId,
                    licenses: licenseKeys.map((key, idx) => ({
                      license_key: key,
                      site_domain: licensesToCreate[idx].site
                    })),
                    timestamp: Date.now(),
                    retryCount: 0
                  }));
                  console.log(`[${operationId}] Queued KV license save for background retry`);
                }
              } else {
                console.log(`[${operationId}] Already have licenses for all ${siteCount} site(s). Skipping generation.`);
              }
            }

            // Also save magic link to KV for quick access (with retry)
            const paymentKey = `payment:${customerId}:${subscriptionId}`;
            let paymentKeySaved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await env.USERS_KV.put(paymentKey, JSON.stringify({
                  customerId,
                  subscriptionId,
                  email,
                  siteDomain,
                  magicLink,
                  createdAt: Math.floor(Date.now() / 1000)
                }));
                paymentKeySaved = true;
                console.log(`[${operationId}] Payment key saved to KV (attempt ${attempt + 1})`);
                break;
              } catch (kvError) {
                if (attempt === 2) {
                  console.error(`[${operationId}] Failed to save payment key after 3 attempts:`, kvError);
                  failedOperations.push({ type: 'save_payment_key', error: kvError.message });
                } else {
                  const delay = 1000 * Math.pow(2, attempt);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
            }

            console.log(`[${operationId}] Magic link generated:`, magicLink);
            console.log('\n========================================');
            console.log('🎉 PAYMENT SUCCESSFUL - MAGIC LINK');
            console.log('========================================');
            console.log('Email:', email);
            console.log('Customer ID:', customerId);
            console.log('Subscription ID:', subscriptionId);
            console.log('Site Domain:', siteDomain);
            console.log('Amount:', amount / 100, currency.toUpperCase());
            console.log('Magic Link:', magicLink);
            console.log('========================================\n');
            
            // Also log to console in a way that's easy to copy
            console.log('\n📋 COPY THIS LINK FOR TESTING:');
            console.log(magicLink);
            console.log('\n');
            
            // Log any failed operations for manual review
            if (failedOperations.length > 0) {
              console.error(`[${operationId}] ⚠️  WARNING: ${failedOperations.length} operation(s) failed after payment:`);
              failedOperations.forEach((op, idx) => {
                console.error(`[${operationId}] Failed operation ${idx + 1}: ${op.type} - ${op.error}`);
              });
              console.error(`[${operationId}] These operations have been queued for background retry`);
              console.error(`[${operationId}] Payment is successful - customer has access via Stripe subscription`);
            }

          } catch (error) {
            // CRITICAL: Payment is already successful - we MUST return 'ok' to Stripe
            // Log error but don't fail the webhook (would cause Stripe to retry)
            console.error(`[${operationId}] CRITICAL ERROR in payment processing:`, error);
            console.error(`[${operationId}] Payment is already successful - customer has paid`);
            console.error(`[${operationId}] Error details:`, error.stack);
            
            // Queue all operations for manual review
            await env.USERS_KV.put(`sync_pending:critical_${operationId}`, JSON.stringify({
              operation: 'payment_processing',
              customerId,
              subscriptionId,
              email,
              error: error.message,
              stack: error.stack,
              timestamp: Date.now(),
              requiresManualReview: true
            })).catch(e => {
              console.error(`[${operationId}] Failed to queue critical error for review:`, e);
            });
            
            // ALWAYS return 'ok' - payment is already processed
            // Stripe will not retry if we return 200
          }
          
          // CRITICAL: Always return 'ok' to Stripe after payment is successful
          // This prevents Stripe from retrying the webhook
          // Failed operations are queued for background retry
          return new Response('ok', { status: 200 });
        }

        // Handle subscription.updated - sync site status
        if (event.type === 'customer.subscription.updated') {
          const subscription = event.data.object;
          const subscriptionId = subscription.id;
          const customerId = subscription.customer;

          console.log('Processing subscription.updated:', { subscriptionId, customerId });

          // Get user record
          const userKey = `user:${customerId}`;
          const userRaw = await env.USERS_KV.get(userKey);
          if (!userRaw) {
            console.warn('User record not found for subscription update');
            return new Response('ok');
          }

          const user = JSON.parse(userRaw);
          
          // Only process if this subscription matches the user's subscription
          if (user.subscriptionId !== subscriptionId) {
            console.log('Subscription ID mismatch, skipping update');
            return new Response('ok');
          }
          
          // Get current subscription items from Stripe
          const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
          if (subRes.status === 200) {
            const sub = subRes.body;
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
            sub.items.data.forEach(item => {
              const siteFromMetadata = item.metadata?.site;
              const siteFromUserRecord = itemIdToSite.get(item.id);
              const site = siteFromMetadata || siteFromUserRecord;
              
              if (site) {
                // Update existing site or add new one
                if (!user.sites) user.sites = {};
                user.sites[site] = {
                  item_id: item.id,
                  price: item.price.id,
                  quantity: item.quantity,
                  status: 'active',
                  created_at: user.sites[site]?.created_at || Math.floor(Date.now() / 1000)
                };
                console.log(`Updated/added site from Stripe: ${site} (item: ${item.id})`);
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
                  console.log(`Added new site from Stripe metadata: ${newSite}`);
                }
              }
            });

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
                    console.log(`Marked site as inactive: ${site} (item ${siteData.item_id} not found in subscription)`);
                  } else {
                    console.log(`Skipping inactive mark for recently created site: ${site} (created ${timeSinceCreation}s ago)`);
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

            await env.USERS_KV.put(userKey, JSON.stringify(user));
            console.log('Updated user sites status from subscription.updated. Total sites:', Object.keys(user.sites || {}).length);
          }
        }

        // Handle invoice.payment_succeeded - generate license keys (if not already done)
        if (event.type === 'invoice.payment_succeeded') {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const customerId = invoice.customer;

          console.log('Processing invoice.payment_succeeded:', { subscriptionId, customerId });

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
          
          // Generate one license key per subscription item (site)
          // Each subscription item represents one site, regardless of quantity
          let siteCount = 1;
          if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
            // Count number of subscription items (sites), not quantities
            siteCount = subscription.items.data.length;
          }

          console.log('Subscription items (sites) count:', siteCount);
          console.log('Subscription items:', subscription.items?.data?.map(item => ({
            id: item.id,
            price: item.price.id,
            quantity: item.quantity,
            metadata: item.metadata
          })));

          // Get user record to map sites to subscription items
          const userKey = `user:${customerId}`;
          const userRaw = await env.USERS_KV.get(userKey);
          const userData = userRaw ? JSON.parse(userRaw) : { sites: {} };

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
            console.log(`Already have licenses for all ${siteCount} site(s). Skipping generation.`);
            return new Response('ok');
          }

          // Generate license keys - one per site
          const licenseKeys = generateLicenseKeys(licensesToCreate.length);
          console.log(`Generated ${licenseKeys.length} new license key(s) for sites:`, licensesToCreate.map(l => l.site));

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
              
              console.log(`Successfully saved ${licenseKeys.length} licenses to database with site mapping`);
            } catch (dbError) {
              console.error('Database error saving licenses:', dbError);
              // Log but don't fail - Stripe will retry if we return error
            }
          } else {
            console.warn('D1 database not configured. License keys generated but not saved:', licenseKeys);
          }

          // Also save to KV for quick lookup with site mapping
          try {
            let userDataForKV = userRaw ? JSON.parse(userRaw) : { customerId, subscriptionId, licenses: [] };
            
            if (!userDataForKV.licenses) userDataForKV.licenses = [];
            licenseKeys.forEach((key, idx) => {
              const site = licensesToCreate[idx].site;
              userDataForKV.licenses.push({
                license_key: key,
                site_domain: site,
                subscription_id: subscriptionId,
                status: 'active',
                created_at: Math.floor(Date.now() / 1000)
              });
            });
            
            await env.USERS_KV.put(userKey, JSON.stringify(userData));
            console.log('Updated user data in KV');
          } catch (kvError) {
            console.error('KV error:', kvError);
          }
        }

        if (event.type === 'invoice.payment_failed') {
          // handle payment failure
          console.log('Payment failed for invoice:', event.data.object.id);
        }

        return new Response('ok');
      }

      if (request.method === 'POST' && pathname === '/magic-link') {
        const data = await request.json();
        const { email, dashboardUrl } = data;
        if (!email) return jsonResponse(400, { error: 'missing email' });

        // Create or fetch Stripe customer for this email
        const cust = await stripeFetch(env, '/customers', 'POST', { email }, true);
        if (cust.status >= 400) return jsonResponse(500, { error: 'stripe customer create failed', details: cust.body });
        const customerId = cust.body.id;

        // Create token and store session
        const token = await signToken(env, { customerId, email }, 60 * 60 * 24);
        const sessionKey = `session:${token}`;
        await env.SESSION_KV.put(sessionKey, JSON.stringify({ customerId, email, exp: Date.now() + 1000 * 60 * 60 * 24 }));

        // Construct the magic link
        const callbackUrl = dashboardUrl || `${url.origin}/auth/callback`;
        const link = `${callbackUrl}?token=${encodeURIComponent(token)}`;

        // Optional: Still send email (but also return link for popup)
        await sendEmail(email, 'Your Login Link', `<p>Click to login: <a href="${link}">${link}</a></p>`);

        // Return the magic link so it can be shown in popup
        return jsonResponse(200, { 
          message: 'magic link generated',
          magicLink: link,
          token: token // Include token for direct use if needed
        });
      }

      if (request.method === 'GET' && pathname === '/auth/callback') {
        const token = url.searchParams.get('token');
        if (!token) return new Response('missing token', { status: 400 });
        const payload = await verifyToken(env, token);
        if (!payload) return new Response('invalid token', { status: 401 });

        console.log('Auth callback - setting new session for customer:', payload.customerId, 'email:', payload.email);

        // create session cookie - this will overwrite any existing session
        const cookie = createSessionCookie(token);
        
        // Redirect to dashboard (support both /dashboard endpoint and dashboard.html)
        const redirectUrl = url.searchParams.get('redirect') || '/dashboard.html';
        return new Response('', { 
          status: 302, 
          headers: { 
            'Set-Cookie': cookie, 
            'Location': redirectUrl,
            'Access-Control-Allow-Origin': '*'
          } 
        });
      }

      // Get user dashboard with sites and subscription info
      if (request.method === 'GET' && pathname === '/dashboard') {
        console.log('Dashboard endpoint called');
        // Read session cookie
        const cookie = request.headers.get('cookie') || '';
        console.log('Cookie header:', cookie ? 'Present' : 'Missing');
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) {
          console.log('No session cookie found');
          return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found' });
        }
        const token = match[1];
        console.log('Session token found, verifying...');
        const payload = await verifyToken(env, token);
        if (!payload) {
          console.log('Invalid session token');
          return jsonResponse(401, { error: 'invalid session', message: 'Session token is invalid or expired' });
        }

        console.log('Token verified, customerId:', payload.customerId, 'email:', payload.email);
        
        // CRITICAL: Find ALL customers with the same email and merge them
        // This handles cases where Stripe created multiple customers for the same email
        const email = payload.email;
        let allCustomerIds = [payload.customerId]; // Start with current customerId
        
        // Find all customerIds for this email from D1 payments table
        if (email && env.DB) {
          try {
            const allCustomersRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM payments WHERE email = ?'
            ).bind(email).all();
            
            if (allCustomersRes && allCustomersRes.results) {
              const foundCustomerIds = allCustomersRes.results
                .map(row => row.customer_id)
                .filter(id => id && id.startsWith('cus_'));
              
              // Merge with current customerId (avoid duplicates)
              allCustomerIds = [...new Set([...allCustomerIds, ...foundCustomerIds])];
              console.log(`Found ${allCustomerIds.length} customer(s) for email ${email}:`, allCustomerIds);
            }
          } catch (dbErr) {
            console.error('Error finding all customers by email:', dbErr);
            // Continue with just the current customerId
          }
        }
        
        // Load user records for all customerIds and merge them
        let mergedUser = null;
        let primaryCustomerId = payload.customerId;
        
        for (const customerId of allCustomerIds) {
          const userKey = `user:${customerId}`;
          const userRaw = await env.USERS_KV.get(userKey);
          
          if (userRaw) {
            const user = JSON.parse(userRaw);
            
            if (!mergedUser) {
              // First user record - use as base
              mergedUser = user;
              primaryCustomerId = customerId;
              console.log(`Using customer ${customerId} as primary for merged view`);
            } else {
              // Merge additional user records
              console.log(`Merging customer ${customerId} into primary customer ${primaryCustomerId}`);
              
              // Merge subscriptions
              if (user.subscriptions) {
                if (!mergedUser.subscriptions) {
                  mergedUser.subscriptions = {};
                }
                Object.keys(user.subscriptions).forEach(subId => {
                  if (!mergedUser.subscriptions[subId]) {
                    mergedUser.subscriptions[subId] = user.subscriptions[subId];
                    console.log(`Added subscription ${subId} from customer ${customerId}`);
                  } else {
                    // Merge sites from this subscription
                    const existingSub = mergedUser.subscriptions[subId];
                    const newSub = user.subscriptions[subId];
                    if (newSub.sites) {
                      Object.keys(newSub.sites).forEach(site => {
                        if (!existingSub.sites[site]) {
                          existingSub.sites[site] = newSub.sites[site];
                          console.log(`Added site ${site} to subscription ${subId}`);
                        }
                      });
                      existingSub.sitesCount = Object.keys(existingSub.sites).length;
                    }
                  }
                });
              }
              
              // Merge sites (legacy structure)
              if (user.sites) {
                if (!mergedUser.sites) {
                  mergedUser.sites = {};
                }
                Object.keys(user.sites).forEach(site => {
                  if (!mergedUser.sites[site]) {
                    mergedUser.sites[site] = user.sites[site];
                    // Ensure subscription_id is set
                    if (!mergedUser.sites[site].subscription_id && user.subscriptionId) {
                      mergedUser.sites[site].subscription_id = user.subscriptionId;
                    }
                  }
                });
              }
              
              // Merge pending sites
              if (user.pendingSites && user.pendingSites.length > 0) {
                if (!mergedUser.pendingSites) {
                  mergedUser.pendingSites = [];
                }
                // Add pending sites that don't already exist
                user.pendingSites.forEach(pending => {
                  const exists = mergedUser.pendingSites.some(
                    p => p.site.toLowerCase().trim() === pending.site.toLowerCase().trim()
                  );
                  if (!exists) {
                    mergedUser.pendingSites.push(pending);
                  }
                });
              }
              
              // Keep the most recent email
              if (user.email && (!mergedUser.email || user.email === email)) {
                mergedUser.email = user.email;
              }
            }
          }
        }
        
        if (!mergedUser) {
          console.log('No user record found in KV for any customer:', allCustomerIds);
          return jsonResponse(200, { 
            sites: {},
            subscriptions: {},
            subscription: null,
            customerId: payload.customerId,
            allCustomerIds: allCustomerIds
          });
        }
        
        // Update primary customerId if we merged multiple customers
        if (allCustomerIds.length > 1) {
          mergedUser.customerId = primaryCustomerId; // Keep primary customerId
          mergedUser.allCustomerIds = allCustomerIds; // Track all customer IDs
          console.log(`Merged ${allCustomerIds.length} customers into one view. Primary: ${primaryCustomerId}`);
        }
        
        const user = mergedUser;
        
        // Migrate old structure to new if needed
        if (!user.subscriptions && user.subscriptionId) {
          user.subscriptions = {};
          if (user.sites) {
            user.subscriptions[user.subscriptionId] = {
              subscriptionId: user.subscriptionId,
              status: 'active',
              sites: { ...user.sites },
              created_at: Math.floor(Date.now() / 1000)
            };
            console.log('Migrated user record to new subscriptions structure');
          }
        }
        
        console.log('User record found:', { 
          customerId: user.customerId, 
          subscriptionId: user.subscriptionId,
          email: user.email,
          subscriptionsCount: user.subscriptions ? Object.keys(user.subscriptions).length : 0,
          sitesCount: user.sites ? Object.keys(user.sites).length : 0,
          allCustomerIds: user.allCustomerIds || [user.customerId]
        });
        
        // Format subscriptions for response - NEW STRUCTURE
        const subscriptions = {};
        if (user.subscriptions) {
          Object.keys(user.subscriptions).forEach(subId => {
            const sub = user.subscriptions[subId];
            const subSites = {};
            if (sub.sites) {
              Object.keys(sub.sites).forEach(site => {
                subSites[site] = {
                  item_id: sub.sites[site].item_id,
                  price: sub.sites[site].price,
                  quantity: sub.sites[site].quantity || 1,
                  status: sub.sites[site].status || 'active',
                  created_at: sub.sites[site].created_at,
                  removed_at: sub.sites[site].removed_at
                };
              });
            }
            subscriptions[subId] = {
              subscriptionId: subId,
              status: sub.status || 'active',
              sites: subSites,
              created_at: sub.created_at,
              sitesCount: Object.keys(subSites).length
            };
          });
        }
        
        // Format sites for response (legacy - for backward compatibility)
        // This aggregates all sites from all subscriptions
        const sites = {};
        if (user.sites) {
          Object.keys(user.sites).forEach(site => {
            sites[site] = {
              item_id: user.sites[site].item_id,
              price: user.sites[site].price,
              quantity: user.sites[site].quantity || 1,
              status: user.sites[site].status || 'active',
              created_at: user.sites[site].created_at,
              removed_at: user.sites[site].removed_at,
              subscription_id: user.sites[site].subscription_id || user.subscriptionId
            };
          });
        }

        // Get pending sites and clean up any that are already active
        let pendingSites = user.pendingSites || [];
        const activeSiteNames = Object.keys(sites).map(s => s.toLowerCase().trim());
        
        if (pendingSites.length > 0) {
          const beforeCleanup = pendingSites.length;
          pendingSites = pendingSites.filter(pending => {
            const pendingSiteLower = pending.site.toLowerCase().trim();
            const isActive = activeSiteNames.some(active => active === pendingSiteLower);
            if (isActive) {
              console.log(`Dashboard cleanup: Removing pending site "${pending.site}" - it's already active`);
            }
            return !isActive;
          });
          
          // If we removed any pending sites, update the user record
          if (pendingSites.length < beforeCleanup) {
            user.pendingSites = pendingSites;
            try {
              // Update primary customer record
              const primaryUserKey = `user:${user.customerId}`;
              await env.USERS_KV.put(primaryUserKey, JSON.stringify(user));
              console.log(`Dashboard cleanup: Removed ${beforeCleanup - pendingSites.length} pending site(s) that are already active`);
            } catch (cleanupError) {
              console.error('Dashboard cleanup: Failed to update user record:', cleanupError);
              // Continue anyway - we'll return the cleaned list
            }
          }
        }

        console.log('Returning dashboard data with', Object.keys(sites).length, 'sites,', Object.keys(subscriptions).length, 'subscriptions, and', pendingSites.length, 'pending sites');
        return jsonResponse(200, {
          sites: sites, // Legacy - all sites aggregated
          subscriptions: subscriptions, // NEW - all subscriptions with their sites
          pendingSites: pendingSites,
          subscription: {
            id: user.subscriptionId,
            customerId: user.customerId,
            email: user.email
          },
          subscriptionId: user.subscriptionId, // Primary subscription (for backward compatibility)
          customerId: user.customerId, // Primary customer ID
          allCustomerIds: user.allCustomerIds || [user.customerId], // All customer IDs merged (for same email)
          email: user.email
        });
      }

      // Add a new site (either to existing subscription OR to pending sites for checkout)
      if (request.method === 'POST' && pathname === '/add-site') {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) return jsonResponse(401, { error: 'unauthenticated' });
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) return jsonResponse(401, { error: 'invalid session' });

        const body = await request.json();
        const { site, price, quantity = 1 } = body; // price = price_xxx (optional - will use existing price if not provided)
        if (!site) return jsonResponse(400, { error: 'missing site' });

        // Fetch user record
        const userKey = `user:${payload.customerId}`;
        const userRaw = await env.USERS_KV.get(userKey);
        
        // If user doesn't exist yet, create a pending user record
        let user = userRaw ? JSON.parse(userRaw) : {
          customerId: payload.customerId,
          email: payload.email || '',
          sites: {},
          pendingSites: [] // Sites waiting to be paid for
        };

        // Check if site already exists (active or pending)
        if (user.sites && user.sites[site] && user.sites[site].status === 'active') {
          return jsonResponse(400, { error: 'site already exists' });
        }
        if (user.pendingSites && user.pendingSites.some(s => s.site === site)) {
          return jsonResponse(400, { error: 'site already in pending list' });
        }
        
        // If site exists but is inactive, remove it first (clean up old data)
        if (user.sites && user.sites[site] && user.sites[site].status === 'inactive') {
          console.log('Site was previously inactive, cleaning up old data:', site);
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
              console.log('Using price from existing site:', priceToUse);
            }
          }
          // Try user's default price (stored after first payment)
          if (!priceToUse && user.defaultPrice) {
            priceToUse = user.defaultPrice;
            console.log('Using default price from user record:', priceToUse);
          }
          // Fallback to environment variable
          if (!priceToUse && env.DEFAULT_PRICE_ID) {
            priceToUse = env.DEFAULT_PRICE_ID;
            console.log('Using default price from environment:', priceToUse);
          }
          if (!priceToUse) {
            return jsonResponse(400, { 
              error: 'price required', 
              message: 'Please provide a Price ID for new sites, or configure DEFAULT_PRICE_ID in wrangler.jsonc.' 
            });
          }
        }

        // Add site to pending list
        user.pendingSites.push({
          site: site,
          price: priceToUse,
          quantity: quantity || 1
        });

        await env.USERS_KV.put(userKey, JSON.stringify(user));

        console.log('Site added to pending list:', site, 'Price:', priceToUse, 'Has subscription:', !!user.subscriptionId);

        return jsonResponse(200, { 
          success: true, 
          site: site,
          pending: true,
          message: 'Site added to cart. Click "Pay Now" to checkout and complete payment.'
        });
      }

      // Batch add multiple sites to pending list (prevents race conditions)
      if (request.method === 'POST' && pathname === '/add-sites-batch') {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) return jsonResponse(401, { error: 'unauthenticated' });
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) return jsonResponse(401, { error: 'invalid session' });

        const { sites } = await request.json();
        if (!Array.isArray(sites) || sites.length === 0) {
          return jsonResponse(400, { error: 'sites array required' });
        }

        // Fetch user record
        const userKey = `user:${payload.customerId}`;
        const userRaw = await env.USERS_KV.get(userKey);
        
        let user = userRaw ? JSON.parse(userRaw) : {
          customerId: payload.customerId,
          email: payload.email || '',
          sites: {},
          pendingSites: []
        };

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
          });
        }

        // Add all sites in one atomic operation
        const addedSites = [];
        const errors = [];

        for (const site of sites) {
          const siteStr = site.trim();
          if (!siteStr) continue;

          // Check if site already exists
          if (user.sites && user.sites[siteStr] && user.sites[siteStr].status === 'active') {
            errors.push(`${siteStr}: already exists`);
            continue;
          }
          if (user.pendingSites.some(s => s.site === siteStr)) {
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

        // Save all at once (atomic operation)
        await env.USERS_KV.put(userKey, JSON.stringify(user));

        console.log(`Batch added ${addedSites.length} site(s) to pending list:`, addedSites);

        return jsonResponse(200, { 
          success: true, 
          added: addedSites,
          errors: errors,
          message: `Added ${addedSites.length} site(s) to cart. Click "Pay Now" to checkout.`
        });
      }

      // Get magic link for a customer (for testing/display after payment)
      // Supports: ?email=... OR ?session_id=... OR ?customer_id=...
      if (request.method === 'GET' && pathname === '/get-magic-link') {
        const email = url.searchParams.get('email');
        const sessionId = url.searchParams.get('session_id');
        const customerId = url.searchParams.get('customer_id');

        try {
          let result = null;

          // Get latest payment record from database
          if (env.DB) {
            if (email) {
              // Search by email
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments WHERE email = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(email).first();
            } else if (customerId) {
              // Search by customer_id
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(customerId).first();
            } else {
              // Get most recent payment (for testing)
              result = await env.DB.prepare(
                'SELECT customer_id, subscription_id, email, magic_link, site_domain, created_at FROM payments ORDER BY created_at DESC LIMIT 1'
              ).first();
            }

            if (result && result.magic_link) {
              return jsonResponse(200, {
                email: result.email,
                customerId: result.customer_id,
                subscriptionId: result.subscription_id,
                siteDomain: result.site_domain,
                magicLink: result.magic_link,
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
        console.log('Licenses endpoint called');
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) {
          console.log('No session cookie found for licenses');
          return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found', licenses: [] });
        }
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) {
          console.log('Invalid session token for licenses');
          return jsonResponse(401, { error: 'invalid session', message: 'Session token is invalid or expired', licenses: [] });
        }

        const customerId = payload.customerId;
        const email = payload.email;
        console.log('Fetching licenses for customer:', customerId, 'email:', email);

        // CRITICAL: Find ALL customers with the same email to get all licenses
        let allCustomerIds = [customerId];
        if (email && env.DB) {
          try {
            const allCustomersRes = await env.DB.prepare(
              'SELECT DISTINCT customer_id FROM payments WHERE email = ?'
            ).bind(email).all();
            
            if (allCustomersRes && allCustomersRes.results) {
              const foundCustomerIds = allCustomersRes.results
                .map(row => row.customer_id)
                .filter(id => id && id.startsWith('cus_'));
              allCustomerIds = [...new Set([...allCustomerIds, ...foundCustomerIds])];
              console.log(`Found ${allCustomerIds.length} customer(s) for email ${email}, fetching licenses from all`);
            }
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
              try {
                // Try query with site_domain first
                result = await env.DB.prepare(
                  `SELECT license_key, site_domain, status, created_at, customer_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                ).bind(...allCustomerIds).all();
              } catch (columnErr) {
                // If column doesn't exist, query without it
                if (columnErr.message && columnErr.message.includes('no such column: site_domain')) {
                  console.log(`[Licenses] site_domain column not found, querying without it`);
                  result = await env.DB.prepare(
                    `SELECT license_key, status, created_at, customer_id FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
                  ).bind(...allCustomerIds).all();
                } else {
                  throw columnErr; // Re-throw if it's a different error
                }
              }

              if (result.success) {
                licenses = result.results.map(row => ({
                  license_key: row.license_key,
                  site_domain: row.site_domain || null, // Will be null if column doesn't exist
                  status: row.status,
                  created_at: row.created_at,
                  customer_id: row.customer_id || customerId // Track which customer this license belongs to
                }));
                console.log(`[Licenses] Found ${licenses.length} license(s) in D1 for ${allCustomerIds.length} customer(s):`, allCustomerIds);
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
            console.log(`[Licenses] D1 database not configured, using KV fallback`);
          }

          // Fallback to KV if D1 not available or empty - check ALL customer IDs
          if (licenses.length === 0) {
            try {
              // Try each customer ID
              for (const cid of allCustomerIds) {
                const userKey = `user:${cid}`;
                const userRaw = await env.USERS_KV.get(userKey);
                if (userRaw) {
                  const user = JSON.parse(userRaw);
                  const userLicenses = (user.licenses || []).map(l => ({
                    license_key: l.license_key,
                    site_domain: l.site_domain || null,
                    status: l.status || 'active',
                    created_at: l.created_at,
                    customer_id: cid
                  }));
                  licenses = [...licenses, ...userLicenses];
                  console.log(`[Licenses] Found ${userLicenses.length} license(s) in KV for customer ${cid}`);
                }
              }
              if (licenses.length > 0) {
                console.log(`[Licenses] Total ${licenses.length} license(s) found in KV across ${allCustomerIds.length} customer(s)`);
              } else {
                console.log(`[Licenses] No user records found in KV for any customer:`, allCustomerIds);
              }
            } catch (kvErr) {
              console.error(`[Licenses] KV error for customers:`, kvErr);
              kvError = kvErr.message;
            }
          }

          // If both D1 and KV failed, return error with details
          if (d1Error && kvError) {
            console.error(`[Licenses] Both D1 and KV failed for customer ${customerId}. D1: ${d1Error}, KV: ${kvError}`);
            return jsonResponse(500, { 
              error: 'Failed to fetch licenses',
              details: {
                d1Error: d1Error,
                kvError: kvError
              },
              licenses: [] // Return empty array so frontend doesn't break
            });
          }

          // Return licenses (even if empty - that's valid)
          return jsonResponse(200, { licenses });
        } catch (error) {
          console.error(`[Licenses] Unexpected error fetching licenses for customer ${customerId}:`, error);
          console.error(`[Licenses] Error stack:`, error.stack);
          return jsonResponse(500, { 
            error: 'Failed to fetch licenses',
            message: error.message,
            licenses: [] // Return empty array so frontend doesn't break
          });
        }
      }

      // Create checkout session from pending sites - adds to existing subscription or creates new one
      if (request.method === 'POST' && pathname === '/create-checkout-from-pending') {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) return jsonResponse(401, { error: 'unauthenticated' });
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) return jsonResponse(401, { error: 'invalid session' });

        // Fetch user record
        const userKey = `user:${payload.customerId}`;
        const userRaw = await env.USERS_KV.get(userKey);
        if (!userRaw) {
          return jsonResponse(400, { error: 'no user found' });
        }
        const user = JSON.parse(userRaw);

        // Check if there are pending sites
        if (!user.pendingSites || user.pendingSites.length === 0) {
          return jsonResponse(400, { error: 'no pending sites to checkout' });
        }

        // Debug: Log pending sites count
        console.log(`Found ${user.pendingSites.length} pending site(s) to process:`, user.pendingSites.map(s => s.site));

        const email = user.email || payload.email || '';
        if (!email) {
          return jsonResponse(400, { error: 'email required' });
        }

        // Create or find customer
        let customerId = user.customerId;
        if (!customerId || !customerId.startsWith('cus_')) {
          const cust = await stripeFetch(env, '/customers', 'POST', { email: email }, true);
          if (cust.status >= 400) {
            return jsonResponse(500, { error: 'failed to create customer', details: cust.body });
          }
          customerId = cust.body.id;
          user.customerId = customerId;
        }

        // After payment, redirect directly to dashboard via magic link
        // The success page will automatically redirect using the session_id from Stripe
        const successUrl = `${url.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${url.origin}/dashboard.html`;

        // Prepare checkout session
        const form = {
          'mode': 'subscription',
          'customer': customerId,
          'success_url': successUrl,
          'cancel_url': cancelUrl,
        };

        // If user has existing subscription, check for duplicate prices and create unique ones
        let existingSubscriptionPrices = new Set();
        if (user.subscriptionId) {
          form['subscription_data[metadata][existing_subscription_id]'] = user.subscriptionId;
          form['subscription_data[metadata][add_to_existing]'] = 'true';
          console.log('Creating checkout to add items to existing subscription:', user.subscriptionId);
          
          // Get existing subscription to check which prices are already used
          const subCheckRes = await stripeFetch(env, `/subscriptions/${user.subscriptionId}`);
          if (subCheckRes.status === 200) {
            const subDetails = subCheckRes.body;
            if (subDetails.items && subDetails.items.data) {
              subDetails.items.data.forEach(item => {
                existingSubscriptionPrices.add(item.price.id);
              });
              console.log('Existing subscription prices:', Array.from(existingSubscriptionPrices));
            }
          }
        }

        // Sites are already specified in metadata (site_0, site_1, etc.)
        // No need for custom field - all site information is in subscription metadata
        // This avoids confusion when multiple sites are being purchased

        // Process each pending site - create unique prices if needed
        // IMPORTANT: Each site needs its own unique price ID, even if they share the same original price
        // Stripe doesn't allow duplicate price IDs in a single checkout session
        const usedPricesInCheckout = new Set(); // Track prices already used in this checkout session
        
        console.log(`🔄 Starting to process ${user.pendingSites.length} pending sites for checkout...`);
        
        for (let i = 0; i < user.pendingSites.length; i++) {
          const s = user.pendingSites[i];
          console.log(`Processing site ${i + 1}/${user.pendingSites.length}: ${s.site}`);
          let priceToUse = s.price;
          
          // Check if this price is already used in the subscription OR in this checkout session
          const priceAlreadyUsed = (user.subscriptionId && existingSubscriptionPrices.has(priceToUse)) || 
                                   usedPricesInCheckout.has(priceToUse);
          
          // Always create a new product with site name and new price to show site in checkout
          // This ensures each site is clearly identified in the Stripe checkout
          console.log(`Creating product and price with site name for ${s.site}`);
          
          // Get the price details to create a new product and price
          const priceRes = await stripeFetch(env, `/prices/${s.price}`);
          if (priceRes.status === 200) {
            const existingPrice = priceRes.body;
            
            // Get product details to create a new product with site name
            const productRes = await stripeFetch(env, `/products/${existingPrice.product}`);
            let productId = existingPrice.product;
            
            // Always create a new product with site name for better checkout display
            if (productRes.status === 200) {
              const existingProduct = productRes.body;
              
              // Extract base product name (remove any existing site suffixes like " - site.com")
              // This prevents concatenation like "ConsentBit Purchase - test2.com - test5.com"
              let baseProductName = existingProduct.name;
              // Check if name already has a site suffix (contains " - " followed by something that looks like a domain)
              const suffixMatch = baseProductName.match(/^(.+?)\s*-\s*[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/);
              if (suffixMatch) {
                baseProductName = suffixMatch[1].trim();
                console.log(`Extracted base product name: "${baseProductName}" from "${existingProduct.name}"`);
              }
              
              const newProductData = {
                name: `${baseProductName} - ${s.site}`,
                description: `Subscription for ${s.site}`,
                'metadata[site]': s.site,
                'metadata[created_for]': 'multi_site_subscription'
              };
              
              const newProductRes = await stripeFetch(env, '/products', 'POST', newProductData, true);
              if (newProductRes.status === 200) {
                productId = newProductRes.body.id;
                console.log(`Created new product for ${s.site}: ${productId}`);
              } else {
                console.log(`Failed to create product for ${s.site}, using existing product`);
              }
            }
            
            // Create a new price with the same amount but unique ID and custom product
            const newPriceData = {
              currency: existingPrice.currency,
              unit_amount: existingPrice.unit_amount,
              product: productId,
              'metadata[site]': s.site,
              'metadata[created_for]': 'multi_site_subscription',
              'metadata[original_price]': s.price
            };
            
            // Add recurring fields if this is a recurring price
            if (existingPrice.recurring) {
              newPriceData['recurring[interval]'] = existingPrice.recurring.interval;
              if (existingPrice.recurring.interval_count) {
                newPriceData['recurring[interval_count]'] = existingPrice.recurring.interval_count;
              }
            }
            
            const newPriceRes = await stripeFetch(env, '/prices', 'POST', newPriceData, true);
            
            if (newPriceRes.status === 200) {
              priceToUse = newPriceRes.body.id;
              console.log(`Created new price with site name for ${s.site}: ${priceToUse}`);
            } else {
              console.error('Failed to create new price:', newPriceRes.body);
              return jsonResponse(500, { 
                error: 'failed to create price for site', 
                details: newPriceRes.body?.error?.message || 'Unknown error',
                site: s.site
              });
            }
          } else {
            console.error('Failed to fetch existing price details:', priceRes.body);
            return jsonResponse(500, { 
              error: 'failed to fetch price details', 
              details: priceRes.body?.error?.message || 'Unknown error'
            });
          }
          
          // Mark this price as used in the checkout session
          usedPricesInCheckout.add(priceToUse);
          
          // Add line item with the determined price
          form[`line_items[${i}][price]`] = priceToUse;
          form[`line_items[${i}][quantity]`] = s.quantity || 1;
          // Note: description field is not allowed when using price ID - site name will show via product name
          // Store site in subscription metadata
          form[`subscription_data[metadata][site_${i}]`] = s.site;
          console.log(`✅ Added line item ${i} for site: ${s.site} with price: ${priceToUse}`);
        }

        // Debug: Count line items actually added
        const lineItemKeys = Object.keys(form).filter(k => k.startsWith('line_items[') && k.includes('[price]'));
        console.log(`📊 Processed ${user.pendingSites.length} pending sites, created ${lineItemKeys.length} line items in checkout form`);
        
        // Debug: Show the actual form data that will be sent
        const formDebug = {};
        for (const [key, value] of Object.entries(form)) {
          if (key.startsWith('line_items[')) {
            formDebug[key] = value;
          }
        }
        console.log('Line items in form:', JSON.stringify(formDebug, null, 2));
        console.log('Full form data:', JSON.stringify(form));
        
        const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
        
        if (session.status >= 400) {
          console.error('Stripe checkout session creation failed:', session.status, session.body);
          return jsonResponse(500, { error: 'stripe checkout session failed', details: session.body });
        }

        // Store pending sites info temporarily (will be processed in webhook)
        await env.USERS_KV.put(userKey, JSON.stringify(user));

        return jsonResponse(200, {
          sessionId: session.body.id,
          url: session.body.url,
          subscriptionId: user.subscriptionId || null
        });
      }

      // Remove a pending site (before payment)
      if (request.method === 'POST' && pathname === '/remove-pending-site') {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) return jsonResponse(401, { error: 'unauthenticated' });
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) return jsonResponse(401, { error: 'invalid session' });

        const body = await request.json();
        const { site } = body;
        if (!site) return jsonResponse(400, { error: 'missing site' });

        const userKey = `user:${payload.customerId}`;
        const userRaw = await env.USERS_KV.get(userKey);
        if (!userRaw) return jsonResponse(404, { error: 'user not found' });

        const user = JSON.parse(userRaw);
        if (!user.pendingSites || user.pendingSites.length === 0) {
          return jsonResponse(400, { error: 'no pending sites' });
        }

        // Remove the site from pending list
        user.pendingSites = user.pendingSites.filter(p => p.site !== site);
        await env.USERS_KV.put(userKey, JSON.stringify(user));

        console.log('Removed pending site:', site, 'Remaining:', user.pendingSites.length);

        return jsonResponse(200, { 
          success: true,
          site: site,
          message: 'Site removed from pending list'
        });
      }

      // Remove a site (delete subscription item from subscription)
      // Uses transaction-like pattern with rollback for consistency
      if (request.method === 'POST' && pathname === '/remove-site') {
        const cookie = request.headers.get('cookie') || '';
        const match = cookie.match(/sb_session=([^;]+)/);
        if (!match) return new Response('unauthenticated', { status: 401 });
        const token = match[1];
        const payload = await verifyToken(env, token);
        if (!payload) return new Response('invalid session', { status: 401 });

        const body = await request.json();
        const { site } = body;

        if (!site) return jsonResponse(400, { error: 'missing site parameter' });

        // Generate idempotency key
        const operationId = `remove_site_${payload.customerId}_${site}_${Date.now()}`;
        const idempotencyKey = `idempotency:${operationId}`;
        
        // Check if operation already completed (idempotency)
        const existingOp = await env.USERS_KV.get(idempotencyKey);
        if (existingOp) {
          const result = JSON.parse(existingOp);
          console.log(`Operation ${operationId} already completed (idempotent)`);
          return jsonResponse(200, { success: true, idempotent: true, ...result });
        }

        // Fetch user record
        const userKey = `user:${payload.customerId}`;
        const userRaw = await env.USERS_KV.get(userKey);
        if (!userRaw) return jsonResponse(400, { error: 'user not found' });

        const user = JSON.parse(userRaw);

        // Find the site and get its item_id
        if (!user.sites || !user.sites[site]) {
          return jsonResponse(400, { error: 'site not found' });
        }

        const siteData = user.sites[site];
        const itemId = siteData.item_id;

        if (!itemId) {
          return jsonResponse(400, { error: 'site has no associated subscription item' });
        }

        // Store original state for rollback
        const originalUserState = JSON.parse(JSON.stringify(user));
        let originalStripeItem = null;

        try {
          // Step 1: Fetch Stripe item data for potential rollback
          console.log(`[${operationId}] Fetching Stripe item for rollback backup:`, itemId);
          const getItemRes = await stripeFetch(env, `/subscription_items/${itemId}`);
          if (getItemRes.status === 200) {
            originalStripeItem = getItemRes.body;
          }

          // Step 2: Update KV first (optimistic update for better UX)
          // If this fails, we haven't touched Stripe yet, so no rollback needed
          user.sites[site].status = 'inactive';
          user.sites[site].removed_at = Math.floor(Date.now() / 1000);
          
          // Retry KV update with exponential backoff
          let kvSuccess = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await env.USERS_KV.put(userKey, JSON.stringify(user));
              kvSuccess = true;
              console.log(`[${operationId}] KV update successful (attempt ${attempt + 1})`);
              break;
            } catch (kvError) {
              if (attempt === 2) throw kvError;
              const delay = 1000 * Math.pow(2, attempt);
              console.log(`[${operationId}] KV update failed, retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }

          if (!kvSuccess) {
            throw new Error('Failed to update KV after 3 retries');
          }

          // Step 3: Delete from Stripe (source of truth)
          console.log(`[${operationId}] Deleting Stripe subscription item:`, itemId, 'for site:', site);
          const delRes = await stripeFetch(env, `/subscription_items/${itemId}`, 'DELETE');
          
          if (delRes.status >= 400) {
            // Rollback KV update
            console.error(`[${operationId}] Stripe deletion failed, rolling back KV update`);
            await env.USERS_KV.put(userKey, JSON.stringify(originalUserState));
            return jsonResponse(500, { 
              error: 'failed to delete subscription item', 
              details: delRes.body,
              rolledBack: true
            });
          }

          // Step 4: Update D1 (mark license inactive if exists)
          if (env.DB) {
            try {
              const timestamp = Math.floor(Date.now() / 1000);
              await env.DB.prepare(
                'UPDATE licenses SET status = ?, updated_at = ? WHERE customer_id = ? AND site_domain = ? AND status = ?'
              ).bind('inactive', timestamp, payload.customerId, site, 'active').run();
              console.log(`[${operationId}] Updated license status in D1 for site:`, site);
            } catch (dbError) {
              // Don't fail the operation if D1 update fails - log for background sync
              console.error(`[${operationId}] D1 update failed (non-critical):`, dbError);
              // Store in pending sync queue
              await env.USERS_KV.put(`sync_pending:${operationId}`, JSON.stringify({
                operation: 'update_license_status',
                customerId: payload.customerId,
                site,
                status: 'inactive',
                timestamp: Date.now(),
                retryCount: 0
              }));
            }
          }

          // Mark operation as completed (idempotency)
          await env.USERS_KV.put(idempotencyKey, JSON.stringify({
            operationId,
            success: true,
            site,
            itemId,
            completedAt: Date.now()
          }), { expirationTtl: 86400 }); // 24 hours

          console.log(`[${operationId}] Site removal completed successfully`);
          return jsonResponse(200, { 
            success: true, 
            site: site,
            message: 'Site removed successfully. Billing will be updated automatically by Stripe.'
          });

        } catch (error) {
          console.error(`[${operationId}] Operation failed:`, error);
          
          // Rollback: Restore KV state
          try {
            await env.USERS_KV.put(userKey, JSON.stringify(originalUserState));
            console.log(`[${operationId}] Rolled back KV state`);
          } catch (rollbackError) {
            console.error(`[${operationId}] Failed to rollback KV:`, rollbackError);
          }

          // Note: Stripe item deletion cannot be rolled back (it's permanent)
          // If KV update succeeded but Stripe failed, we already rolled back KV above
          // If Stripe succeeded but later operations failed, the webhook will sync state

          return jsonResponse(500, { 
            error: 'operation failed', 
            message: error.message,
            rolledBack: true
          });
        }
      }

      // Serve success.html page
      if (request.method === 'GET' && pathname === '/success.html') {
        const successPage = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful - Get Your Login Link</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .success-container {
            background: white;
            border-radius: 12px;
            padding: 40px;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            text-align: center;
        }

        .success-icon {
            font-size: 64px;
            margin-bottom: 20px;
        }

        h1 {
            color: #333;
            margin-bottom: 10px;
        }

        .subtitle {
            color: #666;
            margin-bottom: 30px;
        }

        .magic-link-box {
            background: #f5f5f5;
            border: 2px solid #667eea;
            border-radius: 8px;
            padding: 20px;
            margin: 30px 0;
            word-break: break-all;
        }

        .magic-link {
            font-family: 'Courier New', monospace;
            font-size: 14px;
            color: #667eea;
            margin-bottom: 15px;
            display: block;
            text-decoration: none;
            word-break: break-all;
        }

        .magic-link:hover {
            text-decoration: underline;
        }

        .btn {
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.3s;
            text-decoration: none;
            display: inline-block;
            margin: 10px;
        }

        .btn:hover {
            background: #5568d3;
        }

        .btn-secondary {
            background: #f5f5f5;
            color: #333;
        }

        .btn-secondary:hover {
            background: #e0e0e0;
        }

        .loading {
            color: #666;
            margin: 20px 0;
        }

        .error {
            background: #ffebee;
            color: #c62828;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
        }

        .info {
            background: #e3f2fd;
            color: #1976d2;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
            font-size: 14px;
        }

        .instructions {
            text-align: left;
            background: #f5f5f5;
            padding: 20px;
            border-radius: 6px;
            margin-top: 30px;
        }

        .instructions h3 {
            color: #333;
            margin-bottom: 15px;
        }

        .instructions ol {
            margin-left: 20px;
            color: #666;
        }

        .instructions li {
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="success-container">
        <div class="success-icon">✅</div>
        <h1>Payment Successful!</h1>
        <p class="subtitle">Your subscription has been activated</p>

        <div id="loading" class="loading">
            Generating your login link...
        </div>

        <div id="error-message" class="error" style="display: none;"></div>

        <div id="magic-link-section" style="display: none;">
            <div class="info">
                <strong>Your Dashboard Login Link</strong><br>
                Click the link below or copy it to access your dashboard
            </div>

            <div class="magic-link-box">
                <a id="magic-link" href="#" class="magic-link" target="_blank"></a>
                <button class="btn" onclick="copyMagicLink()">📋 Copy Link</button>
            </div>

            <div>
                <a id="open-dashboard-btn" href="#" class="btn">🚀 Open Dashboard</a>
                <button class="btn btn-secondary" onclick="window.location.href='login.html'">Back to Login</button>
            </div>

            <div class="instructions">
                <h3>📝 Instructions:</h3>
                <ol>
                    <li>Click "Open Dashboard" above, or copy the link</li>
                    <li>You'll be automatically logged in</li>
                    <li>Access your sites and license keys</li>
                    <li>This link expires in 7 days</li>
                </ol>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = 'https://consentbit-dashboard.web-8fb.workers.dev';

        // Get parameters from URL (Stripe Payment Links don't support email placeholder)
        function getParamsFromURL() {
            const urlParams = new URLSearchParams(window.location.search);
            return {
                email: urlParams.get('email') || urlParams.get('customer_email'),
                session_id: urlParams.get('session_id'),
                customer_id: urlParams.get('customer_id')
            };
        }

        // Show error
        function showError(message) {
            document.getElementById('loading').style.display = 'none';
            const errorDiv = document.getElementById('error-message');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        }

        // Load magic link
        async function loadMagicLink() {
            const params = getParamsFromURL();
            
            // Build query string - try email first, then session_id, then customer_id, then most recent
            let queryString = '';
            if (params.email) {
                queryString = \`?email=\${encodeURIComponent(params.email)}\`;
            } else if (params.session_id) {
                queryString = \`?session_id=\${encodeURIComponent(params.session_id)}\`;
            } else if (params.customer_id) {
                queryString = \`?customer_id=\${encodeURIComponent(params.customer_id)}\`;
            } else {
                // No params - get most recent payment (for testing)
                queryString = '';
            }

            // Try to get magic link from API
            try {
                const response = await fetch(\`\${API_BASE}/get-magic-link\${queryString}\`);
                const data = await response.json();

                if (!response.ok) {
                    // If not found, show helpful message
                    const errorMsg = data.message || data.error || 'Login link not ready yet.';
                    showError(errorMsg + ' Please wait a moment and refresh the page, or check Worker logs for the magic link.');
                    
                    // Show instructions
                    document.getElementById('loading').innerHTML = \`
                        <div style="text-align: left; background: #f5f5f5; padding: 20px; border-radius: 8px; margin-top: 20px;">
                            <h3 style="margin-bottom: 10px;">📋 How to get your login link:</h3>
                            <ol style="margin-left: 20px;">
                                <li>Check your email (if email was sent)</li>
                                <li>Check Worker logs: <code>npx wrangler tail</code></li>
                                <li>Look for "MAGIC LINK FOR TESTING" in the logs</li>
                                <li>Or contact support with your payment confirmation</li>
                            </ol>
                        </div>
                    \`;
                    return;
                }

                // Display magic link
                const magicLink = data.magicLink;
                const linkElement = document.getElementById('magic-link');
                const openBtn = document.getElementById('open-dashboard-btn');

                linkElement.href = magicLink;
                linkElement.textContent = magicLink;
                openBtn.href = magicLink;

                document.getElementById('loading').style.display = 'none';
                document.getElementById('magic-link-section').style.display = 'block';

                // Store for copy function
                window.magicLink = magicLink;

            } catch (error) {
                console.error('Error loading magic link:', error);
                showError('Failed to load login link. Please try refreshing the page or contact support.');
            }
        }

        // Copy magic link
        function copyMagicLink() {
            if (!window.magicLink) return;

            navigator.clipboard.writeText(window.magicLink).then(() => {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✓ Copied!';
                btn.style.background = '#4caf50';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.background = '#667eea';
                }, 2000);
            }).catch(err => {
                alert('Failed to copy link. Please select and copy manually.');
            });
        }

        // Auto-load magic link on page load
        window.addEventListener('DOMContentLoaded', () => {
            // Wait a moment for webhook to process
            setTimeout(() => {
                loadMagicLink();
            }, 2000); // 2 second delay to allow webhook to process
        });
    </script>
</body>
</html>`;

        return new Response(successPage, {
          headers: {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Serve dashboard.html page
      if (request.method === 'GET' && pathname === '/dashboard.html') {
        // Embed the full dashboard.html content
        const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>License Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .card {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
        }
        .btn-danger { background: #f44336; color: white; }
        .btn-primary { background: #667eea; color: white; }
        .site-card {
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 10px;
        }
        .site-card.active { border-color: #4caf50; background: #f1f8f4; }
        .license-item {
            background: #f5f5f5;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>📋 License Dashboard</h1>
                <p>Manage your sites and license keys</p>
            </div>
            <button class="btn btn-danger" onclick="logout()">Logout</button>
        </div>
        <div id="error-message" style="display: none; background: #ffebee; color: #c62828; padding: 15px; border-radius: 8px; margin-bottom: 20px;"></div>
        <div class="card" id="customer-info-card" style="display: none;">
            <h2>👤 Account Information</h2>
            <div id="customer-info-content" style="margin-top: 15px; line-height: 1.8;">
                <div><strong>Email:</strong> <span id="info-email">-</span></div>
                <div><strong>Customer ID:</strong> <code id="info-customer-id" style="background: #f5f5f5; padding: 4px 8px; border-radius: 4px; font-family: monospace;">-</code></div>
                <div><strong>Subscription ID:</strong> <code id="info-subscription-id" style="background: #f5f5f5; padding: 4px 8px; border-radius: 4px; font-family: monospace;">-</code></div>
                <div><strong>Total Sites:</strong> <span id="info-sites-count">0</span></div>
                <div><strong>Total Licenses:</strong> <span id="info-licenses-count">0</span></div>
            </div>
        </div>
        <div class="card">
            <h2>🌐 Your Sites</h2>
            <div id="sites-container">Loading...</div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e0e0e0;">
                <h3>Add New Site</h3>
                <div style="margin-top: 10px; margin-bottom: 15px; padding: 10px; background: #f5f5f5; border-radius: 6px; font-size: 13px; color: #666;">
                    <strong>Note:</strong> Price will be automatically set from your existing subscription. Just enter the site domain.
                </div>
                <div style="display: flex; gap: 10px; margin-top: 15px; align-items: center;">
                    <input type="text" id="new-site-input" placeholder="Site domain (e.g., example.com)" style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" onkeypress="if(event.key==='Enter') addSiteToPending()">
                    <button class="btn btn-primary" onclick="addSiteToPending()" title="Add a new site to your subscription" style="position: relative; min-width: 50px; padding: 10px 20px; display: flex; align-items: center; justify-content: center; gap: 5px;">
                        <span style="font-size: 18px; font-weight: bold;">+</span>
                        <span>Add Site</span>
                    </button>
                </div>
                <div id="pending-sites-to-add" style="margin-top: 20px; display: none;">
                    <h4 style="margin-bottom: 10px; color: #666; font-size: 14px;">Sites to be added:</h4>
                    <div id="pending-sites-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
                    <button class="btn btn-primary" onclick="addSite()" style="margin-top: 15px; width: 100%;">Save Sites to Pending List</button>
                </div>
            </div>
        </div>
        <div class="card">
            <h2>🔑 Your License Keys</h2>
            <div id="licenses-container">Loading...</div>
        </div>
    </div>
    <script>
        const API_BASE = 'https://consentbit-dashboard.web-8fb.workers.dev';
        function getSessionToken() {
            const cookies = document.cookie.split(';');
            for (let cookie of cookies) {
                const [name, value] = cookie.trim().split('=');
                if (name === 'sb_session') return value;
            }
            return null;
        }
        function showError(message) {
            const errorDiv = document.getElementById('error-message');
            if (errorDiv) {
                errorDiv.textContent = message;
                errorDiv.style.display = 'block';
            }
            console.error('Dashboard Error:', message);
        }
        function hideError() {
            const errorDiv = document.getElementById('error-message');
            if (errorDiv) {
                errorDiv.style.display = 'none';
            }
        }
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        async function loadDashboard() {
            try {
                hideError();
                console.log('Fetching dashboard data from:', API_BASE + '/dashboard');
                const res = await fetch(API_BASE + '/dashboard', { credentials: 'include' });
                console.log('Dashboard response status:', res.status);
                const text = await res.text();
                if (!res.ok) {
                    const errorMsg = 'Failed to load dashboard: ' + (res.status === 401 ? 'Not authenticated. Please login again.' : text);
                    showError(errorMsg);
                    document.getElementById('sites-container').innerHTML = '<p style="color: #c62828;">Error: ' + errorMsg + '</p>';
                    if (res.status === 401) {
                        setTimeout(() => {
                            window.location.href = 'login.html';
                        }, 2000);
                    }
                    return;
                }
                const data = JSON.parse(text);
                console.log('Dashboard data:', data);
                const sites = data.sites || {};
                const pendingSites = data.pendingSites || [];
                
                // Update customer info card
                if (data.subscription || data.customerId) {
                    const infoCard = document.getElementById('customer-info-card');
                    if (infoCard) {
                        infoCard.style.display = 'block';
                        
                        // Always show customer ID
                        document.getElementById('info-customer-id').textContent = data.customerId || 'N/A';
                        
                        // Show subscription ID (from subscription object or directly from data)
                        const subscriptionId = data.subscription?.id || data.subscriptionId || 'N/A';
                        document.getElementById('info-subscription-id').textContent = subscriptionId;
                        
                        // Show email (from subscription or data)
                        const email = data.subscription?.email || data.email || 'N/A';
                        document.getElementById('info-email').textContent = email;
                        
                        // Show sites count
                        document.getElementById('info-sites-count').textContent = Object.keys(sites).length;
                    }
                }
                
                // Get subscription ID for use in site cards
                const subscriptionId = data.subscription?.id || data.subscriptionId || 'N/A';
                
                // Display active sites
                const sitesContainer = document.getElementById('sites-container');
                if (Object.keys(sites).length === 0 && pendingSites.length === 0) {
                    sitesContainer.innerHTML = '<p>No sites yet. Add your first site below.</p>';
                } else {
                    sitesContainer.innerHTML = '';
                    Object.keys(sites).forEach(site => {
                        const s = sites[site];
                        const div = document.createElement('div');
                        div.className = 'site-card ' + s.status;
                        
                        // Build site card content
                        let cardContent = '<div style="margin-bottom: 10px;">';
                        cardContent += '<div style="font-size: 18px; font-weight: bold; margin-bottom: 8px;">' + escapeHtml(site) + '</div>';
                        cardContent += '<div style="font-size: 12px; color: #666; margin-bottom: 8px;">';
                        cardContent += '<span style="padding: 2px 8px; background: ' + (s.status === 'active' ? '#4caf50' : '#999') + '; color: white; border-radius: 4px; font-size: 11px;">' + escapeHtml(s.status) + '</span>';
                        cardContent += '</div>';
                        
                        // Show subscription item ID
                        if (s.item_id) {
                            cardContent += '<div style="font-size: 11px; color: #666; margin-top: 8px; margin-bottom: 4px;">';
                            cardContent += '<strong>Subscription Item ID:</strong><br>';
                            cardContent += '<code style="background: #f5f5f5; padding: 4px 8px; border-radius: 3px; font-family: monospace; font-size: 11px; display: inline-block; margin-top: 4px;">' + escapeHtml(s.item_id) + '</code>';
                            cardContent += '</div>';
                        }
                        
                        // Show subscription ID (get from data)
                        const siteSubscriptionId = data.subscription?.id || data.subscriptionId || 'N/A';
                        if (siteSubscriptionId && siteSubscriptionId !== 'N/A') {
                            cardContent += '<div style="font-size: 11px; color: #666; margin-top: 4px; margin-bottom: 8px;">';
                            cardContent += '<strong>Subscription ID:</strong><br>';
                            cardContent += '<code style="background: #f5f5f5; padding: 4px 8px; border-radius: 3px; font-family: monospace; font-size: 11px; display: inline-block; margin-top: 4px;">' + escapeHtml(siteSubscriptionId) + '</code>';
                            cardContent += '</div>';
                        }
                        
                        cardContent += '</div>';
                        div.innerHTML = cardContent;
                        
                        // Append action button based on status
                        if (s.status === 'active') {
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-danger';
                            btn.textContent = 'Cancel Subscription';
                            btn.style.marginTop = '10px';
                            btn.onclick = () => removeSite(site);
                            div.appendChild(btn);
                        } else if (s.status === 'inactive') {
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-primary';
                            btn.textContent = 'Subscribe';
                            btn.style.marginTop = '10px';
                            btn.onclick = () => resubscribeSite(site);
                            div.appendChild(btn);
                        }
                        
                        sitesContainer.appendChild(div);
                    });
                }
                
                // Display pending sites and Pay Now button
                updatePendingSitesFromBackend(pendingSites);
            } catch (e) {
                const errorMsg = 'Error loading sites: ' + e.message;
                showError(errorMsg);
                document.getElementById('sites-container').innerHTML = '<p style="color: #c62828;">' + errorMsg + '</p>';
                console.error('loadDashboard error:', e);
            }
        }
        async function loadLicenses() {
            try {
                hideError();
                console.log('Fetching licenses data from:', API_BASE + '/licenses');
                const res = await fetch(API_BASE + '/licenses', { credentials: 'include' });
                console.log('Licenses response status:', res.status);
                const text = await res.text();
                console.log('Licenses response text:', text);
                
                if (!res.ok) {
                    let errorMsg = 'Failed to load licenses';
                    try {
                        const errorData = JSON.parse(text);
                        errorMsg = errorData.error || errorData.message || errorMsg;
                        if (errorData.details) {
                            console.error('License fetch error details:', errorData.details);
                        }
                    } catch (e) {
                        // If response is not JSON, use the text as-is
                        errorMsg = res.status === 401 ? 'Not authenticated. Please login again.' : text;
                    }
                    
                    showError(errorMsg);
                    const container = document.getElementById('licenses-container');
                    if (container) {
                        container.innerHTML = '<p style="color: #c62828;">Error: ' + escapeHtml(errorMsg) + '</p>';
                    }
                    
                    if (res.status === 401) {
                        setTimeout(() => {
                            window.location.href = 'login.html';
                        }, 2000);
                    }
                    return;
                }
                
                let data;
                try {
                    data = JSON.parse(text);
                } catch (parseError) {
                    console.error('Failed to parse licenses response as JSON:', parseError);
                    console.error('Response text:', text);
                    const container = document.getElementById('licenses-container');
                    if (container) {
                        container.innerHTML = '<p style="color: #c62828;">Error: Invalid response from server. Please try again later.</p>';
                    }
                    return;
                }
                
                console.log('Licenses data:', data);
                const licenses = data.licenses || [];
                
                // Update license count in customer info
                const licenseCountEl = document.getElementById('info-licenses-count');
                if (licenseCountEl) {
                    licenseCountEl.textContent = licenses.length;
                }
                
                if (licenses.length === 0) {
                    document.getElementById('licenses-container').innerHTML = '<p>No licenses yet. Licenses will appear here after payment is processed.</p>';
                } else {
                    const container = document.getElementById('licenses-container');
                    container.innerHTML = '';
                    
                    // Group licenses by site
                    const licensesBySite = {};
                    licenses.forEach(l => {
                        const site = l.site_domain || 'Unknown Site';
                        if (!licensesBySite[site]) {
                            licensesBySite[site] = [];
                        }
                        licensesBySite[site].push(l);
                    });
                    
                    // Display licenses grouped by site
                    Object.keys(licensesBySite).forEach(site => {
                        const siteDiv = document.createElement('div');
                        siteDiv.style.cssText = 'margin-bottom: 25px; padding: 15px; background: #f5f5f5; border-radius: 8px; border-left: 4px solid #1976d2;';
                        
                        const siteHeader = document.createElement('h3');
                        siteHeader.style.cssText = 'margin: 0 0 15px 0; color: #1976d2; font-size: 16px; font-weight: 600;';
                        siteHeader.textContent = '🌐 ' + escapeHtml(site);
                        siteDiv.appendChild(siteHeader);
                        
                        licensesBySite[site].forEach((l, index) => {
                            const div = document.createElement('div');
                            div.className = 'license-item';
                            div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 10px; background: white; border-radius: 6px; margin-bottom: 8px;';
                            div.innerHTML = '<span style="font-family: monospace; font-size: 14px; color: #333;">' + escapeHtml(l.license_key) + '</span>';
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-primary';
                            btn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
                            btn.textContent = 'Copy';
                            btn.onclick = () => {
                                navigator.clipboard.writeText(l.license_key).then(() => {
                                    btn.textContent = '✓ Copied!';
                                    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
                                }).catch(() => alert('Failed to copy'));
                            };
                            div.appendChild(btn);
                            siteDiv.appendChild(div);
                        });
                        
                        container.appendChild(siteDiv);
                    });
                }
            } catch (e) {
                const errorMsg = 'Error loading licenses: ' + e.message;
                showError(errorMsg);
                document.getElementById('licenses-container').innerHTML = '<p style="color: #c62828;">' + errorMsg + '</p>';
                console.error('loadLicenses error:', e);
            }
        }
        function updatePendingSitesFromBackend(pendingSites) {
            const pendingContainer = document.getElementById('pending-sites-backend');
            const payNowBtn = document.getElementById('pay-now-btn');
            
            if (!pendingContainer) {
                // Create pending sites section if it doesn't exist
                const sitesCard = document.querySelector('.card');
                if (sitesCard) {
                    const pendingSection = document.createElement('div');
                    pendingSection.id = 'pending-sites-section';
                    pendingSection.style.cssText = 'margin-top: 30px; padding-top: 20px; border-top: 2px solid #e0e0e0;';
                    pendingSection.innerHTML = '<h3 style="margin-bottom: 15px; color: #ff9800;">🛒 Pending Sites (Payment Required)</h3>' +
                        '<div id="pending-sites-backend" style="margin-bottom: 15px;"></div>' +
                        '<button id="pay-now-btn" class="btn btn-primary" style="width: 100%; padding: 15px; font-size: 16px; font-weight: bold; display: none;">💳 Pay Now</button>';
                    sitesCard.appendChild(pendingSection);
                }
            }
            
            const container = document.getElementById('pending-sites-backend');
            const payBtn = document.getElementById('pay-now-btn');
            
            if (pendingSites.length === 0) {
                if (container) container.style.display = 'none';
                if (payBtn) payBtn.style.display = 'none';
                return;
            }
            
            if (container) {
                container.style.display = 'block';
                container.innerHTML = '';
                
                pendingSites.forEach(pending => {
                    const div = document.createElement('div');
                    div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #fff3e0; border: 2px solid #ff9800; border-radius: 6px; margin-bottom: 8px;';
                    
                    const siteInfo = document.createElement('div');
                    siteInfo.style.cssText = 'flex: 1;';
                    const siteName = escapeHtml(pending.site);
                    siteInfo.innerHTML = '<strong style="color: #e65100;">' + siteName + '</strong>' +
                        '<span style="color: #666; font-size: 12px; margin-left: 10px;">Waiting for payment</span>';
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.style.cssText = 'background: #ff5252; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 10px;';
                    removeBtn.textContent = 'Remove';
                    removeBtn.onclick = () => removePendingSiteFromBackend(pending.site);
                    
                    div.appendChild(siteInfo);
                    div.appendChild(removeBtn);
                    container.appendChild(div);
                });
            }
            
            if (payBtn) {
                payBtn.style.display = 'block';
                payBtn.onclick = payNow;
            }
        }
        
        async function removePendingSiteFromBackend(site) {
            if (!confirm('Remove ' + site + ' from pending list?')) return;
            try {
                const res = await fetch(API_BASE + '/remove-pending-site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ site })
                });
                const data = await res.json();
                if (res.ok) {
                    alert('Site removed from pending list!');
                    loadDashboard();
                } else {
                    alert('Error: ' + (data.error || 'Failed to remove site'));
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }
        async function payNow() {
            const btn = document.getElementById('pay-now-btn');
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Creating checkout...';
            
            try {
                const res = await fetch(API_BASE + '/create-checkout-from-pending', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include'
                });
                const data = await res.json();
                
                if (res.ok && data.url) {
                    // Redirect to Stripe checkout
                    window.location.href = data.url;
                } else {
                    alert('Error: ' + (data.error || 'Failed to create checkout session'));
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            } catch (e) {
                alert('Error: ' + e.message);
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
        // Store pending sites locally before sending to backend
        let localPendingSites = [];
        
        function addSiteToPending() {
            const input = document.getElementById('new-site-input');
            if (!input) {
                console.error('new-site-input not found');
                return;
            }
            
            const site = input.value.trim();
            if (!site) {
                alert('Please enter a site domain');
                return;
            }
            
            // Check if site already exists in pending list
            if (localPendingSites.includes(site)) {
                alert('This site is already in the list');
                return;
            }
            
            // Add to local pending list
            localPendingSites.push(site);
            
            // Clear input
            input.value = '';
            
            // Update UI
            updatePendingSitesList();
        }
        
        function removePendingSiteFromList(site) {
            localPendingSites = localPendingSites.filter(s => s !== site);
            updatePendingSitesList();
        }
        
        function updatePendingSitesList() {
            const container = document.getElementById('pending-sites-list');
            const section = document.getElementById('pending-sites-to-add');
            
            if (localPendingSites.length === 0) {
                section.style.display = 'none';
                return;
            }
            
            section.style.display = 'block';
            container.innerHTML = '';
            
            localPendingSites.forEach(site => {
                const div = document.createElement('div');
                div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f0f7ff; border: 1px solid #b3d9ff; border-radius: 6px;';
                
                const span = document.createElement('span');
                span.style.cssText = 'font-weight: 500; color: #1976d2;';
                span.textContent = site;
                
                const button = document.createElement('button');
                button.style.cssText = 'background: #ff5252; color: white; border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;';
                button.textContent = 'Remove';
                button.onclick = () => removePendingSiteFromList(site);
                
                div.appendChild(span);
                div.appendChild(button);
                container.appendChild(div);
            });
        }
        
        async function addSite() {
            // Send all pending sites to backend in one batch request (prevents race conditions)
            if (localPendingSites.length === 0) {
                alert('Please add at least one site');
                return;
            }
            
            try {
                // Send all sites in one batch request
                const res = await fetch(API_BASE + '/add-sites-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ sites: localPendingSites })
                });
                
                // Handle response - check if it's JSON
                let data;
                try {
                    const text = await res.text();
                    if (!text) {
                        throw new Error('Empty response from server');
                    }
                    data = JSON.parse(text);
                } catch (parseError) {
                    console.error('Failed to parse JSON response:', parseError);
                    alert('Error: Server returned invalid response. Please refresh and try again.');
                    return;
                }
                
                if (res.ok && data.added && data.added.length > 0) {
                    // Clear local pending list
                    localPendingSites = [];
                    updatePendingSitesList();
                    
                    if (data.errors && data.errors.length > 0) {
                        alert('Added ' + data.added.length + ' site(s). Errors: ' + data.errors.join(', '));
                    } else {
                        alert('Successfully added ' + data.added.length + ' site(s) to pending!');
                    }
                    loadDashboard();
                } else {
                    alert('Failed to add sites: ' + (data.error || data.message || 'Unknown error'));
                }
            } catch (e) {
                console.error('Error adding sites:', e);
                alert('Error: ' + e.message);
            }
        }
        async function removeSite(site) {
            if (!confirm('Cancel subscription for ' + site + '? This will remove the site from your subscription. You can subscribe again later.')) return;
            try {
                const res = await fetch(API_BASE + '/remove-site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ site })
                });
                if (res.ok) {
                    alert('Subscription cancelled! The subscription item has been deleted, but you can subscribe again anytime.');
                    loadDashboard();
                } else {
                    const data = await res.json();
                    alert('Error: ' + (data.error || 'Failed to cancel subscription'));
                }
            } catch (e) { 
                alert('Error: ' + e.message); 
            }
        }
        
        async function resubscribeSite(site) {
            if (!confirm('Subscribe to ' + site + '? This will add the site to your subscription and you will be charged.')) return;
            try {
                // Add site back - it will go to pending sites and require payment
                const res = await fetch(API_BASE + '/add-site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ site })
                });
                const data = await res.json();
                if (res.ok) {
                    if (data.pending) {
                        alert('Site added to cart! Click "Pay Now" to complete subscription.');
                    } else {
                        alert('Site subscribed successfully!');
                    }
                    loadDashboard();
                } else {
                    alert('Error: ' + (data.error || 'Failed to subscribe to site'));
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }
        function logout() {
            // Clear session cookie
            document.cookie = 'sb_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
            
            // Hide dashboard content
            const dashboardContent = document.querySelector('.container');
            if (dashboardContent) {
                dashboardContent.style.display = 'none';
            }
            
            // Show login form
            showLoginForm();
        }
        
        function showLoginForm() {
            // Create or show login form
            let loginContainer = document.getElementById('login-container');
            if (!loginContainer) {
                loginContainer = document.createElement('div');
                loginContainer.id = 'login-container';
                loginContainer.style.cssText = 'max-width: 500px; margin: 50px auto; padding: 30px; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);';
                document.body.insertBefore(loginContainer, document.body.firstChild);
            }
            
            loginContainer.innerHTML = 
                '<div style="text-align: center; margin-bottom: 30px;">' +
                    '<h1 style="color: #1976d2; margin-bottom: 10px;">🔐 Login to Dashboard</h1>' +
                    '<p style="color: #666;">Enter your email to receive a magic link</p>' +
                '</div>' +
                '<div id="login-error" style="display: none; background: #ffebee; color: #c62828; padding: 12px; border-radius: 6px; margin-bottom: 20px;"></div>' +
                '<div id="login-form">' +
                    '<div style="margin-bottom: 20px;">' +
                        '<label for="login-email" style="display: block; margin-bottom: 8px; font-weight: 500; color: #333;">Email Address</label>' +
                        '<input type="email" id="login-email" placeholder="your@email.com" required ' +
                            'style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 16px; box-sizing: border-box;" />' +
                    '</div>' +
                    '<button onclick="requestMagicLink()" class="btn btn-primary" ' +
                        'style="width: 100%; padding: 12px; font-size: 16px;">Get Magic Link</button>' +
                '</div>' +
                '<div id="magic-link-result" style="display: none; margin-top: 30px;">' +
                    '<div style="background: #e8f5e9; padding: 20px; border-radius: 8px; border-left: 4px solid #4caf50;">' +
                        '<h3 style="margin-top: 0; color: #2e7d32;">✅ Magic Link Generated!</h3>' +
                        '<p style="color: #555; margin-bottom: 15px;">Click the link below to access your dashboard:</p>' +
                        '<div style="background: white; padding: 15px; border-radius: 6px; margin-bottom: 15px; word-break: break-all;">' +
                            '<a id="magic-link-url" href="#" style="color: #1976d2; text-decoration: none; font-weight: 500;"></a>' +
                        '</div>' +
                        '<button onclick="copyMagicLink()" class="btn btn-primary" ' +
                            'style="width: 100%; margin-bottom: 10px;">📋 Copy Link</button>' +
                        '<button onclick="openMagicLink()" class="btn btn-success" ' +
                            'style="width: 100%;">🚀 Open Dashboard</button>' +
                    '</div>' +
                '</div>';
            
            // Focus on email input
            setTimeout(() => {
                const emailInput = document.getElementById('login-email');
                if (emailInput) {
                    emailInput.focus();
                    // Allow Enter key to submit
                    emailInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            requestMagicLink();
                        }
                    });
                }
            }, 100);
        }
        
        async function requestMagicLink() {
            const emailInput = document.getElementById('login-email');
            const errorDiv = document.getElementById('login-error');
            const loginForm = document.getElementById('login-form');
            const resultDiv = document.getElementById('magic-link-result');
            
            if (!emailInput || !emailInput.value) {
                errorDiv.textContent = 'Please enter your email address';
                errorDiv.style.display = 'block';
                return;
            }
            
            const email = emailInput.value.trim();
            
            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                errorDiv.textContent = 'Please enter a valid email address';
                errorDiv.style.display = 'block';
                return;
            }
            
            // Hide error, show loading
            errorDiv.style.display = 'none';
            const submitBtn = loginForm.querySelector('button');
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Generating...';
            submitBtn.disabled = true;
            
            try {
                const response = await fetch(API_BASE + '/magic-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        email: email,
                        dashboardUrl: window.location.origin + '/auth/callback?token={token}&redirect=/dashboard.html'
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || data.message || 'Failed to generate magic link');
                }
                
                // Success - show magic link
                const magicLink = data.magicLink || (window.location.origin + '/auth/callback?token=' + encodeURIComponent(data.token) + '&redirect=/dashboard.html');
                window.currentMagicLink = magicLink;
                
                const linkElement = document.getElementById('magic-link-url');
                linkElement.href = magicLink;
                linkElement.textContent = magicLink;
                
                loginForm.style.display = 'none';
                resultDiv.style.display = 'block';
                
                // Scroll to result
                resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                
            } catch (error) {
                console.error('Error requesting magic link:', error);
                errorDiv.textContent = 'Error: ' + error.message;
                errorDiv.style.display = 'block';
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
            }
        }
        
        function copyMagicLink() {
            if (window.currentMagicLink) {
                navigator.clipboard.writeText(window.currentMagicLink).then(() => {
                    const btn = event.target;
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.textContent = originalText;
                    }, 2000);
                }).catch(err => {
                    alert('Failed to copy link: ' + err.message);
                });
            }
        }
        
        function openMagicLink() {
            if (window.currentMagicLink) {
                window.location.href = window.currentMagicLink;
            }
        }
           // Try to load data - cookie will be sent automatically by browser
           // HttpOnly cookies can't be read by JS, but browser sends them automatically
           function initDashboard() {
               console.log('Dashboard page loaded, initializing...');
               console.log('API_BASE:', API_BASE);
               console.log('Making API calls - cookie will be sent automatically by browser');
               loadDashboard();
               loadLicenses();
           }
           
           window.addEventListener('DOMContentLoaded', initDashboard);
           
           // Also try to load immediately if DOM is already loaded
           if (document.readyState !== 'loading') {
               console.log('DOM already loaded, initializing immediately...');
               initDashboard();
           }
    </script>
</body>
</html>`;

        return new Response(dashboardHTML, {
          headers: {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return jsonResponse(500, { error: err.message });
    }
  }
};
