import Stripe from 'stripe';
// const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
//   apiVersion: '2025-04-30.basil',
//   httpClient: Stripe.createFetchHttpClient(),
// });

const STRIPE_BASE = 'https://api.stripe.com/v1';

// Import transaction manager for ACID-like consistency
// Note: Cloudflare Workers don't support ES6 imports from local files in the same way
// We'll inline the transaction logic or use a different approach

async function ensureMemberstackMember(email, env) {
	//const apiKey = env.MEMBERSTACK_SECRET_KEY?.trim();
	const apiKey = 'sk_5a7907c37f1805788976';
	if (!apiKey) {
		throw new Error('MEMBERSTACK_SECRET_KEY not configured');
	}
	console.log(`👤 Ensuring Memberstack member for email: ${email}`);
	const normalizedEmail = email.toLowerCase().trim();

	// Try to get existing member
	try {
		const getMember = await getMemberstackMember(normalizedEmail, apiKey);
		if (getMember) {
			console.log(`👤 Found existing member: ${getMember.id}`);
			return getMember.id;
		}
	} catch (getErr) {
		console.log('👤 Member not found, creating new...');
	}

	// Create new member
	const createRes = await fetch('https://admin.memberstack.com/members', {
		method: 'POST',
		headers: {
			'X-API-KEY': apiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: normalizedEmail,
			password: generateRandomPassword(),
		}),
	});

	if (!createRes.ok) {
		const errorText = await createRes.text();
		throw new Error(`Memberstack create failed: ${createRes.status} - ${errorText}`);
	}

	const newMember = await createRes.json();
	const memberId = newMember.data?.id || newMember.id;
	console.log(`👤 Created new member: ${memberId}`);
	return memberId;
}

// Get existing Memberstack member by email
async function getMemberstackMember(email, apiKey) {
	const res = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
		method: 'GET',
		headers: {
			'X-API-KEY': apiKey,
			'Content-Type': 'application/json',
		},
	});

	if (!res.ok) {
		return null;
	}

	const data = await res.json();
	const members = Array.isArray(data) ? data : data.data || [];

	// Find exact email match
	const member = members.find((m) => {
		const memberEmail = m.auth?.email || m.email || m.data?.email;
		return memberEmail?.toLowerCase().trim() === email.toLowerCase().trim();
	});

	return member || null;
}

// Enqueue site purchase job (Use Case 2 -> process later from sitesqueue)
async function enqueueSiteQueueItem(env, { customerId, userEmail, subscriptionId, sites, billingPeriod, priceId, paymentIntentId }) {
	if (!env.DB) {
		console.warn('[USE CASE 2 - QUEUE] No DB configured, skipping enqueue');
		return null;
	}

	const queueId = `sitequeue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const timestamp = Math.floor(Date.now() / 1000);
	const sitesJson = JSON.stringify(sites || []);

	const res = await env.DB.prepare(
		`
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
  `
	)
		.bind(
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
		)
		.run();

	console.log('[USE CASE 2 - QUEUE] Insert result:', res);

	if (!res.success) {
		console.error('[USE CASE 2 - QUEUE] Failed to enqueue site job', res);
		return null;
	}

	console.log('[USE CASE 2 - QUEUE] Enqueued site job', queueId, 'for', sites.length, 'site(s)');
	return queueId;
}

async function getOrCreateDynamicPrice(env, { productId, billingPeriod, currency, unitAmount }) {
	const period = (billingPeriod || '').toLowerCase().trim();

	// Flatten nested objects for form-encoded Stripe API
	const createBody = {
		product: productId,
		currency: currency || 'usd',
		unit_amount: unitAmount,
		'recurring[interval]': period === 'yearly' ? 'year' : 'month',
	};

	console.log('[USE CASE 2] Dynamic price createBody:', createBody);

	const res = await stripeFetch(env, '/prices', 'POST', createBody, true);

	if (res.status !== 200) {
		console.error('[USE CASE 2] ❌ Failed to create dynamic price', {
			status: res.status,
			body: res.body,
		});
		return null;
	}

	console.log('[USE CASE 2] ✅ Created dynamic price', res.body.id, 'for product', productId);
	return res.body.id;
}

async function processSitesQueue(env, limit = 100) {
	if (!env.DB) {
		console.warn('[SITES QUEUE] No DB, skipping sitesqueue processing');
		return { processed: 0, error: 'No database configured' };
	}

	const timestamp = Math.floor(Date.now() / 1000);
	const fiveMinutesAgo = timestamp - 5 * 60;

	try {
		// Reset stuck processing items
		try {
			const resetResult = await env.DB.prepare(
				`UPDATE sitesqueue 
         SET status = 'pending', updatedat = ?
         WHERE status = 'processing' 
         AND updatedat < ?`
			)
				.bind(timestamp, fiveMinutesAgo)
				.run();

			if (resetResult.meta.changes > 0) {
				console.log(`[SITES QUEUE] 🔄 Reset ${resetResult.meta.changes} stuck 'processing' items back to 'pending'`);
			}
		} catch (resetErr) {
			console.warn(`[SITES QUEUE] ⚠️ Could not reset stuck processing items:`, resetErr);
		}

		// Get pending items
		const queueItems = await env.DB.prepare(
			`
      SELECT * FROM sitesqueue
      WHERE status = 'pending'
      ORDER BY createdat ASC
      LIMIT ?
    `
		)
			.bind(limit)
			.all();

		if (!queueItems.results || queueItems.results.length === 0) {
			console.log(`[SITES QUEUE] ⏸️ No pending queue items found`);
			return { processed: 0, message: 'No pending queue items' };
		}

		console.log(`[SITES QUEUE] 📋 Processing ${queueItems.results.length} queue item(s)...`);
		console.log(
			`[SITES QUEUE] Queue IDs:`,
			queueItems.results.map((j) => j.queueid)
		);

		let successCount = 0;
		let failCount = 0;

		for (const job of queueItems.results) {
			// Atomic lock mechanism
			const lockResult = await env.DB.prepare(
				`UPDATE sitesqueue 
         SET status = 'processing', updatedat = ? 
         WHERE queueid = ? AND status = 'pending'`
			)
				.bind(timestamp, job.queueid)
				.run();

			if (lockResult.meta.changes === 0) {
				console.log(`[SITES QUEUE] ⚠️ Could not acquire lock for queue item ${job.queueid}`);
				continue;
			}

			try {
				console.log('[SITES QUEUE] Processing queueid:', job.queueid);
				console.log('[SITES QUEUE] Queue item details:', {
					queueid: job.queueid,
					customerid: job.customerid,
					useremail: job.useremail,
					sites_json: job.sites_json,
					billingperiod: job.billingperiod,
					priceid: job.priceid,
					paymentintentid: job.paymentintentid,
					status: job.status,
				});

				const sites = JSON.parse(job.sites_json || '[]');
				const customerId = job.customerid;
				const userEmail = job.useremail;
				const billingPeriod = job.billingperiod || 'monthly';
				const priceId = job.priceid;

				console.log(`[SITES QUEUE] Processing ${sites.length} site(s) for customer ${customerId}`);

				const createdSubscriptions = [];

				for (const site of sites) {
					const siteName = site.site || site.site_domain || site;

					// Generate unique license key
					const licenseKey = await generateUniqueLicenseKey(env);

					// Calculate trial end (30 days from now)
					const trialEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

					// Create subscription in Stripe with trial
					const subRes = await stripeFetch(
						env,
						'/subscriptions',
						'POST',
						{
							customer: customerId,
							'items[0][price]': site.price || priceId,
							'items[0][quantity]': 1,
							trial_end: trialEnd.toString(),
							'metadata[license_key]': licenseKey,
							'metadata[usecase]': '2',
							'metadata[purchase_type]': 'site',
							'metadata[site]': siteName,
							collection_method: 'charge_automatically',
						},
						true
					);

					if (subRes.status === 200) {
						const sub = subRes.body;
						const itemId = sub.items?.data?.[0]?.id || null;

						// Save license to database
						const licenseTimestamp = Math.floor(Date.now() / 1000);
						await env.DB.prepare(
							`
              INSERT INTO licenses (
                license_key, customer_id, subscription_id, item_id, site_domain,
                status, purchase_type, billing_period, created_at, updated_at,user_email
              ) VALUES (?, ?, ?, ?, ?, 'active', 'site', ?, ?, ?,?)
            `
						)
							.bind(licenseKey, customerId, sub.id, itemId, siteName, billingPeriod, licenseTimestamp, licenseTimestamp, userEmail)
							.run();

						// Save subscription to database
						await env.DB.prepare(
							`
              INSERT OR REPLACE INTO subscriptions (
                user_email, customer_id, subscription_id, status,
                current_period_start, current_period_end, billing_period,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
						)
							.bind(
								userEmail,
								customerId,
								sub.id,
								sub.status || 'trialing',
								sub.current_period_start || null,
								sub.current_period_end || null,
								billingPeriod,
								licenseTimestamp,
								licenseTimestamp
							)
							.run();

						// Save subscription item
						if (itemId) {
							await env.DB.prepare(
								`
                INSERT OR REPLACE INTO subscription_items (
                  subscription_id, item_id, site_domain, price_id, quantity,
                  status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)
              `
							)
								.bind(sub.id, itemId, siteName, site.price || priceId, licenseTimestamp, licenseTimestamp)
								.run();
						}

						createdSubscriptions.push({
							site: siteName,
							subscriptionId: sub.id,
							licenseKey: licenseKey,
						});

						console.log(`[SITES QUEUE] ✅ Created subscription ${sub.id} for site ${siteName}`);
					} else {
						console.error(`[SITES QUEUE] ❌ Failed to create subscription for site ${siteName}:`, subRes.status, subRes.body);
						throw new Error(`Failed to create subscription: ${subRes.status}`);
					}

					// Small delay between subscriptions
					await new Promise((resolve) => setTimeout(resolve, 100));
				}

				// Mark queue item as completed
				await env.DB.prepare(
					`
          UPDATE sitesqueue
          SET status = 'completed', updatedat = ?
          WHERE queueid = ?
        `
				)
					.bind(timestamp, job.queueid)
					.run();

				successCount++;
				console.log(`[SITES QUEUE] ✅ Completed queueid: ${job.queueid} (${createdSubscriptions.length} subscriptions)`);
			} catch (err) {
				console.error(`[SITES QUEUE] ❌ Error processing queueid ${job.queueid}:`, err);
				await env.DB.prepare(
					`
          UPDATE sitesqueue
          SET status = 'failed', updatedat = ?, errormessage = ?
          WHERE queueid = ?
        `
				)
					.bind(timestamp, err.message || 'Unknown error', job.queueid)
					.run();
				failCount++;
			}
		}

		console.log(`[SITES QUEUE] ✅ Queue processing complete: ${successCount} succeeded, ${failCount} failed`);
		return { processed: queueItems.results.length, successCount, failCount };
	} catch (error) {
		console.error(`[SITES QUEUE] ❌ Error processing queue:`, error);
		return { processed: 0, error: error.message };
	}
}
async function detectPlatform(domain) {
	try {
		const targetUrl = domain.startsWith('http') ? domain : `https://${domain}`;
		const res = await fetch(targetUrl, {
			method: 'GET',
			redirect: 'follow',
			headers: {
				'User-Agent': 'platform-detector-bot',
			},
		});
		const html = await res.text();
		// Check for Framer
		const isFramer = html.includes('events.framer.com/script') || html.includes('data-fid=');
		if (isFramer) return 'framer';
		// Check for Webflow
		const isWebflow = html.includes('webflow.com') || html.includes('data-wf-page');
		if (isWebflow) return 'webflow';
		// Not published or unknown platform
		return 'pending';
	} catch (error) {
		console.error('Platform detection error:', error);
		return 'pending';
	}
}
// :new: Get KV namespaces based on platform
function getKvNamespaces(env, platform) {
	switch (platform) {
		case 'framer':
			return {
				activeSitesKv: env.ACTIVE_SITES_CONSENTBIT_FRAMER,
			};
		case 'webflow':
			return {
				activeSitesKv: env.ACTIVE_SITES_CONSENTBIT,
			};
		case 'pending':
			return {
				activeSitesKv: env.Pending_Active_site,
			};
		default:
			return {
				activeSitesKv: null,
			};
	}
}
// :new: Updated saveLicenseKeyToKV (accepts specific KV + platform)
async function saveLicenseKeyToKVPlatform(
	activeSitesKv,
	license_key,
	customer_id,
	subscription_id,
	email,
	status,
	cancelAtPeriodEnd,
	validatedSiteDomain,
	platform
) {
	if (!activeSitesKv) {
		console.warn(`[saveLicenseKeyToKV] No activeSitesKv provided`);
		return;
	}
	const formattedKey = formatSiteName(validatedSiteDomain); // Your existing function
	const kvData = {
		license_key,
		customer_id,
		subscription_id,
		email,
		status,
		cancelAtPeriodEnd,
		site_domain: validatedSiteDomain,
		platform, // :new:
		updated_at: Math.floor(Date.now() / 1000),
	};
	console.log(`[saveLicenseKeyToKV] Saving to KV ${formattedKey}:`, kvData);
	await activeSitesKv.put(license_key, JSON.stringify(kvData));
	await activeSitesKv.put(formattedKey, JSON.stringify(kvData)); // Also save by domain
	console.log(`[saveLicenseKeyToKV] :white_check_mark: Saved to ${platform} KV namespace`);
}


function getPriceIdFromProduct(productId, billingPeriod, env) {
	const period = (billingPeriod || '').toLowerCase().trim();

	// prod_TiG3c1jjtQHRLK = monthly product
	if (productId === 'prod_TiG3c1jjtQHRLK' && period === 'monthly') {
		return "price_1SkpXkJwcuG9163MTm9SU4Uf" || env.MONTHLY_LICENSE_PRICE_ID; // used for both quantity + sites
	}

	// prod_TiG4YkK61hiKKR = yearly product
	if (productId === 'prod_TiG4YkK61hiKKR' && period === 'yearly') {
		return "price_1SkpYoJwcuG9163MwT7oFyRf" ||env.YEARLY_LICENSE_PRICE_ID; // used for both quantity + sites
	}

	return null;
}

// Generate a single unique license key with database check
function generateTempLicenseKeys(quantity) {
	return Array.from({ length: quantity }, (_, i) => `L${i + 1}`);
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

	// If DB is not available, return a key without uniqueness check
	if (!env?.DB) {
		const key = makeKey();
		console.log(`[generateUniqueLicenseKey] ⚠️ DB not available - returning key without uniqueness check: ${key.substring(0, 10)}...`);
		return key;
	}

	// Try up to 50 times to generate a unique key
	for (let i = 0; i < 50; i++) {
		try {
			const key = makeKey();

			// Check if key exists in database
			const exists = await env.DB.prepare('SELECT license_key FROM licenses WHERE license_key = ? LIMIT 1').bind(key).first();

			if (!exists) {
				if (i > 0) {
					console.log(`[generateUniqueLicenseKey] ✅ Generated unique key after ${i + 1} attempt(s): ${key.substring(0, 10)}...`);
				}
				return key;
			}

			// Key exists, try again
			if (i === 0) {
				console.log(`[generateUniqueLicenseKey] 🔄 Key collision detected, retrying...`);
			}
		} catch (dbError) {
			console.error(`[generateUniqueLicenseKey] ❌ Database error checking key uniqueness (attempt ${i + 1}):`, dbError);
			// If it's a critical error, throw it
			if (dbError.message && dbError.message.includes('no such table: licenses')) {
				// Table doesn't exist - return key without check
				const key = makeKey();
				console.log(`[generateUniqueLicenseKey] ⚠️ Licenses table not found - returning key without check: ${key.substring(0, 10)}...`);
				return key;
			}
			// For other errors, continue trying
			if (i === 49) {
				// Last attempt failed
				throw new Error(`Failed to generate unique license key after 50 attempts. Last error: ${dbError.message}`);
			}
		}
	}

	throw new Error('Failed to generate unique license key after 50 attempts (all keys were duplicates)');
}

// Generate multiple unique license keys
async function generateLicenseKeys(quantity, env) {
	const keys = [];
	for (let i = 0; i < quantity; i++) {
		const key = await generateUniqueLicenseKey(env);
		keys.push(key);
	}
	return keys;
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
		return jsonResponse(
			400,
			{
				error: 'invalid_request',
				message: 'Invalid JSON in request body',
			},
			true,
			request
		);
	}

	const { email: emailParam, sites, billing_period: billingPeriodParam } = body;
	const sitesArray = Array.isArray(sites) ? sites : [];

	if (!sitesArray.length) {
		console.log('[CREATE-SITE-CHECKOUT] ❌ No sites provided');
		return jsonResponse(
			400,
			{
				error: 'missing_sites',
				message: 'At least one site is required',
			},
			true,
			request
		);
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
		return jsonResponse(
			400,
			{
				error: 'no_customer',
				message: 'Customer account required',
			},
			true,
			request
		);
	}

	console.log('[CREATE-SITE-CHECKOUT] ✅ User found with', user.customers.length, 'customer(s)');

	let customerId = null;
	if (user.customers && user.customers.length > 0) {
		customerId = user.customers[0].customerId;
	}

	if (!customerId) {
		return jsonResponse(
			400,
			{
				error: 'no_customer',
				message: 'Customer account required',
			},
			true,
			request
		);
	}

	/* ─────────────────────────────
     PRICE CONFIG (reuse purchase-quantity logic)
  ───────────────────────────── */
	if (!billingPeriodParam) {
		console.log('[CREATE-SITE-CHECKOUT] ❌ Billing period not provided');
		return jsonResponse(
			400,
			{
				error: 'billing_period_required',
				message: 'billing_period is required. Please provide "monthly" or "yearly".',
			},
			true,
			request
		);
	}

	const normalizedPeriod = billingPeriodParam.toLowerCase().trim();
	console.log('[CREATE-SITE-CHECKOUT] 📅 Billing period:', normalizedPeriod);

	let productId, unitAmount;
	const currency = 'usd'; // Default to USD
	if (normalizedPeriod === 'monthly') {
		productId = env.MONTHLY_PRODUCT_ID || env.MONTHLY_LICENSE_PRODUCT_ID || 'prod_TiG3c1jjtQHRLK';
		unitAmount = parseInt(env.MONTHLY_UNIT_AMOUNT || env.MONTHLY_LICENSE_UNIT_AMOUNT || '800');
		console.log('[CREATE-SITE-CHECKOUT] 💰 Monthly config:', { productId, unitAmount, currency });
	} else if (normalizedPeriod === 'yearly') {
		productId = env.YEARLY_PRODUCT_ID || env.YEARLY_LICENSE_PRODUCT_ID || 'prod_TiG4YkK61hiKKR';
		unitAmount = parseInt(env.YEARLY_UNIT_AMOUNT || env.YEARLY_LICENSE_UNIT_AMOUNT || '7200');
		console.log('[CREATE-SITE-CHECKOUT] 💰 Yearly config:', { productId, unitAmount, currency });
	} else {
		console.log('[CREATE-SITE-CHECKOUT] ❌ Invalid billing period:', billingPeriodParam);
		return jsonResponse(
			400,
			{
				error: 'invalid_billing_period',
				message: `Invalid billing_period: ${billingPeriodParam}. Must be "monthly" or "yearly".`,
			},
			true,
			request
		);
	}

	if (!productId) {
		console.log('[CREATE-SITE-CHECKOUT] ❌ Product ID not configured for:', normalizedPeriod);
		return jsonResponse(
			500,
			{
				error: 'product_id_not_configured',
				message: `${normalizedPeriod.charAt(0).toUpperCase() + normalizedPeriod.slice(1)} product ID not configured.`,
			},
			true,
			request
		);
	}

	const storedUnitAmount = unitAmount;
	console.log(`[CREATE-SITE-CHECKOUT] ✅ Price config loaded (${normalizedPeriod}):`, {
		productId,
		storedUnitAmount,
		currency: 'usd',
	});

	/* ─────────────────────────────
     STEP 1: CALCULATE AMOUNT (like purchase-quantity)
  ───────────────────────────── */
	const totalSites = sitesArray.length;
	let totalAmount = storedUnitAmount * totalSites;
	const invoiceCurrency = 'usd'; // Default to USD

	console.log(`[CREATE-SITE-CHECKOUT] Using unit_amount from env: ${storedUnitAmount}, sites: ${totalSites}, total: ${totalAmount}`);

	/* ─────────────────────────────
     STEP 2: PREPARE METADATA FOR AFTER PAYMENT
  ───────────────────────────── */
	try {
		await stripeFetch(
			env,
			`/customers/${customerId}`,
			'POST',
			{
				'metadata[sites_pending]': JSON.stringify(sitesArray),
				'metadata[usecase]': '2',
				'metadata[billing_period]': normalizedPeriod,
			},
			true
		);
	} catch (metadataErr) {
		console.warn('[CREATE-SITE-CHECKOUT] ⚠️ Failed to store metadata in customer:', metadataErr);
		// Non-critical
	}

	/* ─────────────────────────────
     STEP 3: CREATE CHECKOUT SESSION (mode: payment, like purchase-quantity)
  ───────────────────────────── */
	const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard';

	const form = {
		mode: 'payment',
		customer: customerId,
		// Payment method types: Card only
		'payment_method_types[0]': 'card',
		// Enable promotion codes
		allow_promotion_codes: 'true',
		'line_items[0][price_data][currency]': 'usd', // Default to USD
		'line_items[0][price_data][unit_amount]': storedUnitAmount, // Unit price per site
		'line_items[0][price_data][product_data][name]': 'ConsentBit',
		'line_items[0][price_data][product_data][description]': `Billed ${normalizedPeriod === 'yearly' ? 'yearly' : 'monthly'}`,
		'line_items[0][quantity]': totalSites, // Show actual quantity (number of sites)

		'payment_intent_data[metadata][usecase]': '2',
		'payment_intent_data[metadata][customer_id]': customerId,
		'payment_intent_data[metadata][sites_json]': JSON.stringify(sitesArray),
		'payment_intent_data[metadata][billing_period]': normalizedPeriod,
		'payment_intent_data[metadata][product_id]': productId, // 🔴 required for getPriceIdFromProduct
		'payment_intent_data[metadata][currency]': invoiceCurrency,

		'payment_intent_data[setup_future_usage]': 'off_session',
		success_url: `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
		cancel_url: dashboardUrl,
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

		return jsonResponse(
			500,
			{
				error: 'checkout_failed',
				message: 'Failed to create checkout session',
				details: session.body,
			},
			true,
			request
		);
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

async function generateTempLicenceKey(count) {}

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
// function getCorsHeaders(request) {
// 	const origin = request.headers.get('Origin');
// 	const allowedOrigins = [
// 		'https://memberstack-login-test-713fa5.webflow.io',
// 		'https://consentbit-dashboard-test.web-8fb.workers.dev',
// 		'http://localhost:3000',
// 		'http://localhost:3001',
// 		'http://localhost:8080',
// 		'http://localhost:1337',
// 		'http://localhost:5173',
// 		'http://localhost:5174',
// 		'http://localhost:5175',
// 		'https://dashboard.consentbit.com', // <- removed trailing slash
// 	];

// 	const headers = {};

// 	if (origin && allowedOrigins.includes(origin)) {
// 		headers['Access-Control-Allow-Origin'] = origin;
// 		headers['Access-Control-Allow-Credentials'] = 'true';
// 		headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
// 		headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
// 		headers['Vary'] = 'Origin';
// 	}

// 	return headers;
// }

// function jsonResponse(status, body, cors = true, request = null) {
// 	const headers = { 'content-type': 'application/json' };
// 	if (cors) {
// 		if (request) {
// 			const corsHeaders = getCorsHeaders(request);
// 			Object.assign(headers, corsHeaders);
// 		} else {
// 			headers['Access-Control-Allow-Origin'] = '*';
// 			headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
// 			headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
// 		}
// 	}
// 	return new Response(JSON.stringify(body), {
// 		status,
// 		headers,
// 	});
// }
// Final recommended code
function getCorsHeaders(request) {
    const origin = request.headers.get('Origin');
    
    const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, stripe-signature, cookie',
    };

    if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
        headers['Vary'] = 'Origin';
    } else {
        headers['Access-Control-Allow-Origin'] = '*';
    }

    return headers;
}

function jsonResponse(status, body, cors = true, request = null) {
    const headers = { 'content-type': 'application/json' };
    
    if (cors) {
        const corsHeaders = getCorsHeaders(request);
        Object.assign(headers, corsHeaders);
    }
    
    return new Response(JSON.stringify(body), {
        status,
        headers,
    });
}


function getEnvVar(env, key) {
	if (!env[key]) throw new Error(`Missing env var ${key}`);
	return env[key];
}

// Helper function to batch queries and avoid SQLite's 999 variable limit
async function batchQuery(env, ids, queryFn, batchSize = 100) {
	// Reduced batch size to 100 to avoid SQLite's 999 variable limit
	// Each ID in IN clause = 1 variable, plus query columns/parameters can add more
	// With complex queries having many columns (10+ columns), 100 is safer
	// SQLite limit is 999, so 100 leaves plenty of room for additional query parameters
	// For queries with many columns, consider reducing batchSize further (e.g., 50)
	if (ids.length === 0) return { results: [] };

	const results = [];
	for (let i = 0; i < ids.length; i += batchSize) {
		const batch = ids.slice(i, i + batchSize);
		try {
			const batchResults = await queryFn(batch);
			if (batchResults?.results) {
				results.push(...batchResults.results);
			}
		} catch (err) {
			console.error(`[batchQuery] Error processing batch ${i}-${i + batch.length}:`, err);
			throw err; // Re-throw to let caller handle
		}
	}
	return { results };
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
		const user = await env.DB.prepare('SELECT email, created_at, updated_at FROM users WHERE email = ?').bind(normalizedEmail).first();

		if (!user) {
			return null;
		}

		// Get customers for this user
		const customersRes = await env.DB.prepare('SELECT customer_id, created_at FROM customers WHERE user_email = ?')
			.bind(normalizedEmail)
			.all();

		const customers = [];

		if (customersRes && customersRes.results) {
			for (const customerRow of customersRes.results) {
				const customerId = customerRow.customer_id;

				// Get subscriptions for this customer
				// CRITICAL: Include billing_period in SELECT query
				const subscriptionsRes = await env.DB.prepare(
					'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_start, current_period_end, billing_period, created_at FROM subscriptions WHERE customer_id = ? AND user_email = ?'
				)
					.bind(customerId, normalizedEmail)
					.all();

				const subscriptions = [];

				if (subscriptionsRes && subscriptionsRes.results) {
					for (const subRow of subscriptionsRes.results) {
						// Get items for this subscription
						const itemsRes = await env.DB.prepare(
							'SELECT item_id, site_domain, price_id, quantity, status, created_at, removed_at FROM subscription_items WHERE subscription_id = ?'
						)
							.bind(subRow.subscription_id)
							.all();

						const items = [];
						if (itemsRes && itemsRes.results) {
							for (const itemRow of itemsRes.results) {
								// CRITICAL: Skip "site_1" placeholder entries
								if (itemRow.site_domain && /^site_\d+$/.test(itemRow.site_domain)) {
									console.log(`[getUserByEmail] ⚠️ Skipping placeholder site "${itemRow.site_domain}" from subscription_items`);
									continue;
								}

								// Get license for this site
								const licenseRes = await env.DB.prepare(
									'SELECT license_key, status, created_at FROM licenses WHERE site_domain = ? AND subscription_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
								)
									.bind(itemRow.site_domain, subRow.subscription_id, 'active')
									.first();

								items.push({
									item_id: itemRow.item_id,
									site: itemRow.site_domain,
									price: itemRow.price_id,
									quantity: itemRow.quantity,
									status: itemRow.status,
									created_at: itemRow.created_at,
									license: licenseRes
										? {
												license_key: licenseRes.license_key,
												status: licenseRes.status,
												created_at: licenseRes.created_at,
										  }
										: null,
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
							created_at: subRow.created_at,
						});
					}
				}

				customers.push({
					customerId: customerId,
					subscriptions: subscriptions,
					created_at: customerRow.created_at,
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
		)
			.bind(normalizedEmail)
			.all();

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
						created_at: psRow.created_at,
					});
				} else {
					// Duplicate found - log for audit but keep first occurrence
					console.warn(
						`[getUserByEmail] ⚠️ PAYMENT SAFETY: Skipping duplicate pending site "${psRow.site_domain}" to prevent duplicate charges`
					);
				}
			}
		}

		return {
			email: normalizedEmail,
			customers: customers,
			licenses: [], // Licenses are now fetched per item
			pendingSites: pendingSites,
			created_at: user.created_at,
			updated_at: user.updated_at,
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
		await env.DB.prepare('INSERT OR IGNORE INTO users (email, created_at, updated_at) VALUES (?, ?, ?)')
			.bind(normalizedEmail, timestamp, timestamp)
			.run();

		await env.DB.prepare('UPDATE users SET updated_at = ? WHERE email = ?').bind(timestamp, normalizedEmail).run();

		// Update customers
		if (userData.customers && Array.isArray(userData.customers)) {
			for (const customer of userData.customers) {
				// Create or update customer
				await env.DB.prepare('INSERT OR IGNORE INTO customers (user_email, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
					.bind(normalizedEmail, customer.customerId, timestamp, timestamp)
					.run();

				// Update subscriptions
				// CRITICAL: INSERT OR REPLACE only affects the specific subscription_id (UNIQUE constraint)
				// This means we can safely add new subscriptions without affecting existing ones
				if (customer.subscriptions && Array.isArray(customer.subscriptions)) {
					for (const subscription of customer.subscriptions) {
						// Check if subscription already exists in database
						const existingSub = await env.DB.prepare('SELECT subscription_id FROM subscriptions WHERE subscription_id = ?')
							.bind(subscription.subscriptionId)
							.first();

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
							)
								.bind(
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
								)
								.run();
						} catch (billingPeriodError) {
							// If billing_period column doesn't exist, save without it
							// Check for both error message formats: "no such column" and "has no column named"
							const errorMsg = billingPeriodError.message || '';
							if (
								errorMsg.includes('no such column: billing_period') ||
								errorMsg.includes('has no column named billing_period') ||
								errorMsg.includes('billing_period')
							) {
								await env.DB.prepare(
									`INSERT OR REPLACE INTO subscriptions 
                   (user_email, customer_id, subscription_id, status, cancel_at_period_end, cancel_at, 
                    current_period_start, current_period_end, created_at, updated_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
								)
									.bind(
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
									)
									.run();
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
								const siteDomain = item.site || item.site_domain;

								// CRITICAL: Skip saving "site_1" placeholders to subscription_items
								if (siteDomain && /^site_\d+$/.test(siteDomain)) {
									console.log(`[saveUserByEmail] ⚠️ Skipping subscription_items save for placeholder site: "${siteDomain}"`);
									continue; // Skip this item
								}

								await env.DB.prepare(
									`INSERT OR REPLACE INTO subscription_items 
                   (subscription_id, item_id, site_domain, price_id, quantity, status, billing_period, renewal_date, created_at, updated_at, removed_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
								)
									.bind(
										subscription.subscriptionId,
										item.item_id,
										siteDomain,
										item.price || item.price_id,
										item.quantity || 1,
										item.status || 'active',
										billingPeriod,
										renewalDate,
										item.created_at || timestamp,
										timestamp,
										item.removed_at || null
									)
									.run();
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
			pendingSites: userData.pendingSites,
		});

		if (userData.pendingSites !== undefined && Array.isArray(userData.pendingSites)) {
			// Get current pending sites from database (source of truth)
			const currentPendingSitesRes = await env.DB.prepare('SELECT site_domain FROM pending_sites WHERE user_email = ?')
				.bind(normalizedEmail)
				.all();

			const currentPendingSites = new Set();
			if (currentPendingSitesRes && currentPendingSitesRes.results) {
				currentPendingSitesRes.results.forEach((row) => {
					currentPendingSites.add(row.site_domain.toLowerCase().trim());
				});
			}

			console.log(`[saveUserByEmail] Current pending sites in DB: ${currentPendingSites.size}`);

			// Get user object pending sites
			const userPendingSites = new Set();
			userData.pendingSites.forEach((ps) => {
				const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
				if (siteName) {
					userPendingSites.add(siteName);
				}
			});

			console.log(`[saveUserByEmail] User pending sites: ${userPendingSites.size}`);

			// Flatten pendingSites array to handle nested structures
			const flattenedPendingSites = [];
			userData.pendingSites.forEach((ps) => {
				// Handle nested arrays or objects with pendingSites property
				if (Array.isArray(ps)) {
					// If element is an array, extract items
					ps.forEach((item) => {
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
			currentPendingSites.forEach((site) => {
				if (!userPendingSites.has(site)) {
					sitesToDelete.push(site);
				}
			});

			// Find sites to insert (in user object but not in database)
			// Use flattened array to avoid nested structures
			const sitesToInsert = [];
			flattenedPendingSites.forEach((ps) => {
				const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
				if (siteName && !currentPendingSites.has(siteName)) {
					sitesToInsert.push(ps);
				}
			});

			console.log(`[saveUserByEmail] Sites to insert: ${sitesToInsert.length}, Sites to delete: ${sitesToDelete.length}`);

			// Delete sites that are in database but not in user object
			for (const siteToDelete of sitesToDelete) {
				const deleteResult = await env.DB.prepare('DELETE FROM pending_sites WHERE user_email = ? AND LOWER(TRIM(site_domain)) = ?')
					.bind(normalizedEmail, siteToDelete)
					.run();
				console.log(`[saveUserByEmail] 🗑️ Deleted pending site: ${siteToDelete}`, deleteResult.success ? '✅' : '❌');
			}

			// Insert sites that are in user object but not in database
			for (const pendingSite of sitesToInsert) {
				const siteName = pendingSite.site || pendingSite.site_domain;
				const sitePrice = pendingSite.price || pendingSite.price_id;
				try {
					const insertResult = await env.DB.prepare(
						'INSERT INTO pending_sites (user_email, subscription_id, site_domain, price_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)'
					)
						.bind(
							normalizedEmail,
							pendingSite.subscription_id || null,
							siteName,
							sitePrice,
							pendingSite.quantity || 1,
							pendingSite.created_at || timestamp
						)
						.run();

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
			console.log(
				`[saveUserByEmail] ⚠️ Skipping pending sites sync: pendingSites is ${
					userData.pendingSites === undefined ? 'undefined' : 'not an array'
				}`
			);
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
			updated_at: Math.floor(Date.now() / 1000),
		};
	} else {
		console.log(`[addOrUpdateCustomerInUser]   - User exists with ${user.customers?.length || 0} customer(s)`);
	}

	// Find or create customer
	let customer = user.customers.find((c) => c.customerId === customerId);
	if (!customer) {
		console.log(`[addOrUpdateCustomerInUser]   - Creating new customer: ${customerId}`);
		customer = {
			customerId: customerId,
			subscriptions: [],
			created_at: Math.floor(Date.now() / 1000),
		};
		user.customers.push(customer);
	} else {
		console.log(`[addOrUpdateCustomerInUser]   - Customer exists with ${customer.subscriptions?.length || 0} subscription(s)`);
	}

	// Find or create subscription
	let subscription = customer.subscriptions.find((s) => s.subscriptionId === subscriptionId);
	if (!subscription) {
		console.log(`[addOrUpdateCustomerInUser]   - Creating new subscription: ${subscriptionId}`);
		subscription = {
			subscriptionId: subscriptionId,
			status: 'active',
			items: [],
			billingPeriod: billingPeriod, // Add billing period if provided
			created_at: Math.floor(Date.now() / 1000),
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
		const existingItem = subscription.items.find((i) => i.item_id === item.item_id);
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
		const customerRes = await env.DB.prepare('SELECT user_email FROM customers WHERE customer_id = ? LIMIT 1').bind(customerId).first();

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
			canceledAt = null,
		} = siteData;

		// CRITICAL: Prevent saving "site_1", "site_2", etc. placeholders
		if (siteDomain && /^site_\d+$/.test(siteDomain)) {
			console.log(`[saveOrUpdateSiteInDB] ⚠️ Skipping save of placeholder site: "${siteDomain}"`);
			return; // Don't save placeholder sites
		}

		const timestamp = Math.floor(Date.now() / 1000);

		// Check if site already exists (by subscription_id and item_id, not site_domain)
		// This allows us to update placeholder sites with actual site names
		const existing = await env.DB.prepare('SELECT id, site_domain FROM sites WHERE customer_id = ? AND subscription_id = ? AND item_id = ?')
			.bind(customerId, subscriptionId, itemId)
			.first();

		// Also check if there's a placeholder site for this subscription/item that needs updating
		const existingPlaceholder = await env.DB.prepare(
			'SELECT id, site_domain FROM sites WHERE customer_id = ? AND subscription_id = ? AND item_id = ? AND site_domain LIKE "site_%"'
		)
			.bind(customerId, subscriptionId, itemId)
			.first();

		// If there's a placeholder site, update it with the actual site name
		if (existingPlaceholder && existingPlaceholder.site_domain && /^site_\d+$/.test(existingPlaceholder.site_domain)) {
			console.log(`[saveOrUpdateSiteInDB] 🔄 Updating placeholder site "${existingPlaceholder.site_domain}" to "${siteDomain}"`);
			await env.DB.prepare(
				`UPDATE sites SET
          site_domain = ?,
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
        WHERE customer_id = ? AND subscription_id = ? AND item_id = ?`
			)
				.bind(
					siteDomain,
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
					itemId
				)
				.run();
		} else if (existing) {
			// Update existing site (by exact site_domain match)
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
			)
				.bind(
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
				)
				.run();
		} else {
			// Insert new site
			await env.DB.prepare(
				`INSERT INTO sites (
          customer_id, subscription_id, item_id, site_domain, price_id,
          amount_paid, currency, status, current_period_start, current_period_end,
          renewal_date, cancel_at_period_end, canceled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
				.bind(
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
				)
				.run();
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
		)
			.bind(siteDomain, subscriptionId, 'active')
			.first();

		// If not found, try with customer_id
		if (!license) {
			license = await env.DB.prepare(
				'SELECT license_key, status, created_at FROM licenses WHERE site_domain = ? AND customer_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
			)
				.bind(siteDomain, customerId, 'active')
				.first();
		}

		if (license && license.license_key) {
			return {
				license_key: license.license_key,
				status: license.status || 'active',
				created_at: license.created_at,
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
		)
			.bind(subscriptionId, 'active')
			.all();

		if (licenses && licenses.results) {
			licenses.results.forEach((license) => {
				if (license.site_domain && license.license_key) {
					licenseMap[license.site_domain] = {
						license_key: license.license_key,
						status: license.status || 'active',
						created_at: license.created_at,
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
	const sig = await crypto.subtle
		.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
		.then((key) => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
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
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
			'verify',
		]);
		const sig = Uint8Array.from(
			atob(sigB64)
				.split('')
				.map((c) => c.charCodeAt(0))
		);
		const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
		if (!valid) return null;
		const payload = JSON.parse(atob(bodyB64));
		if (payload.exp && payload.exp * 1000 < Date.now()) return null;
		return payload;
	} catch (e) {
		return null;
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
				const result = await env.DB.prepare('SELECT * FROM price_config WHERE price_type = ? AND is_active = 1 LIMIT 1')
					.bind(priceType)
					.first();

				if (result) {
					// Extract available fields (handle missing columns gracefully)
					const config = {
						price_id: result.price_id || null,
						product_id: result.product_id || null,
						unit_amount: result.unit_amount || null,
						currency: result.currency || 'usd',
						discount_allowance: result.discount_allowance || null,
						discount_type: result.discount_type || null,
						coupon_code: result.coupon_code || null,
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
					const basicResult = await env.DB.prepare('SELECT price_id FROM price_config WHERE price_type = ? AND is_active = 1 LIMIT 1')
						.bind(priceType)
						.first();

					if (basicResult && basicResult.price_id) {
						console.log(`[getPriceConfigByBillingPeriod] Found price_id using basic query: ${basicResult.price_id}`);
						return {
							price_id: basicResult.price_id,
							product_id: null,
							unit_amount: null,
							currency: 'usd',
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
			subscriptionId = event.data.object.subscription || event.data.object.id || event.data.object.subscription_id || null;
		}

		// Extract customer ID from event if not provided
		if (!customerId && event.data?.object) {
			customerId = event.data.object.customer || event.data.object.customer_id || null;
		}

		// Prepare event data for storage (store as JSON string)
		const eventData = {
			id: event.id,
			type: event.type,
			created: event.created,
			livemode: event.livemode,
			object: event.data?.object
				? {
						id: event.data.object.id,
						object: event.data.object.object,
						status: event.data.object.status,
						cancel_at_period_end: event.data.object.cancel_at_period_end,
						canceled_at: event.data.object.canceled_at,
						current_period_end: event.data.object.current_period_end,
						current_period_start: event.data.object.current_period_start,
				  }
				: null,
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
		)
			.bind(timestamp, date, eventId, eventType, subscriptionId, customerId, eventDataJson, additionalDataJson, timestamp)
			.run();

		console.log(
			`[Stripe Log] ✅ Logged event ${eventType} for subscription ${subscriptionId || 'N/A'} at ${date} ${new Date(
				timestamp * 1000
			).toISOString()}`
		);
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
async function saveSubscriptionToKV(
	env,
	customerId,
	subscriptionId,
	email,
	siteName,
	subscriptionStatus = 'complete',
	paymentStatus = 'paid',
	cancelAtPeriodEnd = false
) {
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
			cancelAtPeriodEnd: cancelAtPeriodEnd,
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
			lastUpdated: now,
		};

		await env.SUBSCRIPTION_CONSENTBIT.put(subscriptionKey, JSON.stringify(subscriptionData));
		console.log(`[KV] ✅ Saved to SUBSCRIPTION_CONSENTBIT with key: ${subscriptionKey}`);
	} catch (error) {
		console.error('[KV] ❌ Error saving to KV storage:', error);
		// Don't throw - KV storage is optional, don't fail the main operation
	}
}

// Helper function to save license key data to KV storage (for quantity purchases)
async function saveLicenseKeyToKV(
	env,
	licenseKey,
	customerId,
	subscriptionId,
	email,
	subscriptionStatus = 'complete',
	cancelAtPeriodEnd = false,
	siteName = null
) {
	try {
		if (!env.UN_ASSIGNED_LICENSE_KEYS) {
			console.warn('[KV] UN_ASSIGNED_LICENSE_KEYS namespace not configured, skipping KV storage');
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
			cancelAtPeriodEnd: cancelAtPeriodEnd,
		};

		// // If site name is provided (license key is activated), use connectDomain as the KV key
		// if (siteName) {
		// 	const formattedSiteName = formatSiteName(siteName);
		// 	if (formattedSiteName) {
		// 		activeSitesData.connectDomain = formattedSiteName;

		// 		// Use connectDomain as the KV key instead of license key
		// 		await env.ACTIVE_SITES_CONSENTBIT.put(formattedSiteName, JSON.stringify(activeSitesData));
		// 		console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${formattedSiteName} (connectDomain)`);

		// 		// Delete old KV entry if it was keyed by license key (for backward compatibility)
		// 		// Note: This is a safety check - the activate-license endpoint also deletes old entries
		// 		try {
		// 			const oldEntry = await env.ACTIVE_SITES_CONSENTBIT.get(licenseKey);
		// 			if (oldEntry) {
		// 				await env.ACTIVE_SITES_CONSENTBIT.delete(licenseKey);
		// 				console.log(`[KV] 🗑️ Deleted old KV entry keyed by license key: ${licenseKey}`);
		// 			}
		// 		} catch (deleteErr) {
		// 			// Entry might not exist or already deleted - that's okay
		// 			// Non-critical, continue
		// 		}
		// 	} else {
		// 		// If formatting failed, fall back to license key as the key
		// 		await env.ACTIVE_SITES_CONSENTBIT.put(licenseKey, JSON.stringify(activeSitesData));
		// 		console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${licenseKey} (fallback)`);
		// 	}
		// } else {
			// If no site name, use license key as the key (license not activated yet)
			await env.UN_ASSIGNED_LICENSE_KEYS.put(licenseKey, JSON.stringify(activeSitesData));
			console.log(`[KV] ✅ Saved license key to ACTIVE_SITES_CONSENTBIT with key: ${licenseKey} (not activated)`);
		// }
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
	const { customerId, userEmail, paymentIntentId, priceId, licenseKey, quantity, trialEnd } = queueData;

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
		)
			.bind(paymentIntentId, licenseKey)
			.first();

		if (existingQueueItem) {
			console.log(
				`[QUEUE] ⚠️ Queue item already exists for payment_intent_id=${paymentIntentId}, license_key=${licenseKey} (status: ${existingQueueItem.status}, queue_id: ${existingQueueItem.queue_id}). Skipping duplicate entry.`
			);
			return { success: true, queueId: existingQueueItem.queue_id, skipped: true, reason: 'duplicate' };
		}

		await env.DB.prepare(
			`INSERT INTO subscription_queue 
       (queue_id, customer_id, user_email, payment_intent_id, price_id, license_key, quantity, trial_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
		)
			.bind(queueId, customerId, userEmail, paymentIntentId, priceId, licenseKey, quantity, trialEnd || null, timestamp, timestamp)
			.run();

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
	const { queue_id, customer_id, user_email, payment_intent_id, price_id, license_key: originalLicenseKey, trial_end } = queueItem;

	// STEP: Replace temporary license key with real unique key if needed
	let license_key = originalLicenseKey;
	if (isTemporaryLicenseKey(originalLicenseKey)) {
		console.log(`[USE CASE 3 - QUEUE] 🔄 Replacing temporary license key "${originalLicenseKey}" with real unique key...`);
		license_key = await generateUniqueLicenseKey(env);
		console.log(`[USE CASE 3 - QUEUE] ✅ Replaced temporary key "${originalLicenseKey}" with real key "${license_key}"`);

		// Update the queue item with the real license key
		try {
			const timestamp = Math.floor(Date.now() / 1000);
			await env.DB.prepare(`UPDATE subscription_queue SET license_key = ?, updated_at = ? WHERE queue_id = ?`)
				.bind(license_key, timestamp, queue_id)
				.run();
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
		trial_end: trial_end ? new Date(trial_end * 1000).toISOString() : null,
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
			)
				.bind(license_key)
				.first();

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
				)
					.bind(license_key)
					.first();

				if (completedQueueItem && completedQueueItem.subscription_id) {
					existingSubscriptionId = completedQueueItem.subscription_id;
					existingItemId = completedQueueItem.item_id || null;
					console.log(
						`[USE CASE 3 - QUEUE] ✅ Another queue item for license ${license_key} already completed with subscription: ${existingSubscriptionId}`
					);
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
			)
				.bind(existingSubscriptionId, existingItemId, timestamp, timestamp, queue_id)
				.run();

			console.log(`[USE CASE 3 - QUEUE] ✅ Queue item ${queue_id} marked as completed (subscription already existed)`);
			return { success: true, subscriptionId: existingSubscriptionId, itemId: existingItemId, skipped: true };
		}

		// CRITICAL: Final duplicate check right before creating subscription
		// Double-check that no subscription was created while we were processing
		// This is a last line of defense against race conditions
		try {
			const finalCheck = await env.DB.prepare(
				`SELECT subscription_id, item_id FROM licenses WHERE license_key = ? AND subscription_id IS NOT NULL LIMIT 1`
			)
				.bind(license_key)
				.first();

			if (finalCheck && finalCheck.subscription_id) {
				console.log(
					`[USE CASE 3 - QUEUE] ⚠️ Subscription was created for license ${license_key} while processing (race condition detected): ${finalCheck.subscription_id}`
				);
				// Mark queue item as completed with existing subscription
				const timestamp = Math.floor(Date.now() / 1000);
				await env.DB.prepare(
					`UPDATE subscription_queue 
           SET status = 'completed', subscription_id = ?, item_id = ?, processed_at = ?, updated_at = ?
           WHERE queue_id = ?`
				)
					.bind(finalCheck.subscription_id, finalCheck.item_id || null, timestamp, timestamp, queue_id)
					.run();

				return {
					success: true,
					subscriptionId: finalCheck.subscription_id,
					itemId: finalCheck.item_id || null,
					skipped: true,
					reason: 'duplicate_detected',
				};
			}
		} catch (finalCheckErr) {
			console.warn(`[USE CASE 3 - QUEUE] ⚠️ Final duplicate check failed (continuing anyway):`, finalCheckErr);
		}

		// Create subscription
		console.log(`[USE CASE 3 - QUEUE] 🚀 Creating individual subscription for license ${license_key}...`);
		const createSubRes = await stripeFetch(
			env,
			'/subscriptions',
			'POST',
			{
				customer: customer_id,
				'items[0][price]': price_id,
				'items[0][quantity]': 1,
				'metadata[license_key]': license_key,
				'metadata[usecase]': '3',
				'metadata[purchase_type]': 'quantity',
				proration_behavior: 'none',
				collection_method: 'charge_automatically',
				trial_end: trial_end ? trial_end.toString() : undefined,
			},
			true
		);

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
				trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
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
           (license_key, customer_id, subscription_id, item_id, site_domain, used_site_domain, status, purchase_type, billing_period, renewal_date, created_at, updated_at,user_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
					.bind(
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
						timestamp,
						user_email
					)
					.run();

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
						created_at: new Date(timestamp * 1000).toISOString(),
						user_email: user_email
					});

					// Verify the license was saved correctly
					const verifyLicense = await env.DB.prepare(
						`SELECT license_key, subscription_id, item_id, customer_id, purchase_type, billing_period, renewal_date 
             FROM licenses WHERE license_key = ? LIMIT 1`
					)
						.bind(license_key)
						.first();

					if (verifyLicense) {
						console.log(`[USE CASE 3 - QUEUE] ✅ Verified license in database:`, {
							license_key: verifyLicense.license_key,
							subscription_id: verifyLicense.subscription_id,
							item_id: verifyLicense.item_id,
							customer_id: verifyLicense.customer_id,
							purchase_type: verifyLicense.purchase_type,
							billing_period: verifyLicense.billing_period,
							renewal_date: verifyLicense.renewal_date ? new Date(verifyLicense.renewal_date * 1000).toISOString() : null,
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
				)
					.bind(
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
					)
					.run();

				if (subInsertResult.success) {
					subscriptionSaved = true;
					console.log(`[USE CASE 3 - QUEUE] ✅ Subscription record saved to database:`, {
						subscription_id: subscriptionId,
						customer_id,
						user_email,
						status: subscription.status || 'active',
						billing_period: billingPeriod,
						current_period_start: subscription.current_period_start
							? new Date(subscription.current_period_start * 1000).toISOString()
							: null,
						current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
					});

					// Verify the subscription was saved correctly
					const verifySub = await env.DB.prepare(
						`SELECT subscription_id, customer_id, user_email, status, billing_period, current_period_end 
             FROM subscriptions WHERE subscription_id = ? LIMIT 1`
					)
						.bind(subscriptionId)
						.first();

					if (verifySub) {
						console.log(`[USE CASE 3 - QUEUE] ✅ Verified subscription in database:`, {
							subscription_id: verifySub.subscription_id,
							customer_id: verifySub.customer_id,
							user_email: verifySub.user_email,
							status: verifySub.status,
							billing_period: verifySub.billing_period,
							current_period_end: verifySub.current_period_end ? new Date(verifySub.current_period_end * 1000).toISOString() : null,
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
				)
					.bind(subscriptionId, itemId, timestamp, timestamp, queue_id)
					.run();

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
					processed_at: new Date(timestamp * 1000).toISOString(),
				});

				// Verify one-to-one relationship: Each license has exactly one subscription
				const verifyRelationship = await env.DB.prepare(
					`SELECT l.license_key, l.subscription_id, l.item_id, s.subscription_id as sub_id, s.status as sub_status
           FROM licenses l
           LEFT JOIN subscriptions s ON l.subscription_id = s.subscription_id
           WHERE l.license_key = ? LIMIT 1`
				)
					.bind(license_key)
					.first();

				if (verifyRelationship && verifyRelationship.subscription_id === verifyRelationship.sub_id) {
					console.log(
						`[USE CASE 3 - QUEUE] ✅ Verified one-to-one relationship: License ${license_key} → Subscription ${verifyRelationship.subscription_id}`
					);
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
					)
						.bind(
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
						)
						.run();
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
		const nextRetryAt =
			attempts < maxAttempts
				? Math.floor(Date.now() / 1000) + Math.pow(2, attempts) * 60 // Exponential backoff: 2min, 4min, 8min
				: null;
		const status = attempts >= maxAttempts ? 'failed' : 'pending';

		const timestamp = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`UPDATE subscription_queue 
       SET status = ?, attempts = ?, error_message = ?, next_retry_at = ?, updated_at = ?
       WHERE queue_id = ?`
		)
			.bind(status, attempts, error.message || String(error), nextRetryAt, timestamp, queue_id)
			.run();

		console.error(`[QUEUE] ❌ Failed to process queue item ${queue_id} (attempt ${attempts}/${maxAttempts}):`, error);

		if (attempts >= maxAttempts) {
			console.error(
				`[QUEUE] 🚨 Queue item ${queue_id} has exceeded max attempts (${maxAttempts}). Marking as failed - refund will be processed after 12 hours if still incomplete.`
			);
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
	const { queue_id, payment_intent_id, price_id, license_key } = queueItem;

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
			chargeId = typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge.id;
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
			const refundRes = await stripeFetch(
				env,
				'/refunds',
				'POST',
				{
					charge: chargeId,
					amount: refundAmount,
					'metadata[reason]': 'subscription_creation_failed_after_retries',
					'metadata[queue_id]': queue_id,
					'metadata[license_key]': license_key,
					'metadata[payment_intent_id]': payment_intent_id,
					'metadata[attempts]': queueItem.attempts?.toString() || '3',
				},
				true
			);

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
					)
						.bind(
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
								attempts: queueItem.attempts || 3,
							}),
							timestamp,
							timestamp
						)
						.run();
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
				)
					.bind(
						`${queueItem.error_message || 'Subscription creation failed'} | REFUNDED: ${refund.id} (${refundAmount} ${currency})`,
						timestamp,
						queue_id
					)
					.run();

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
	const twelveHoursAgo = timestamp - 12 * 60 * 60; // 12 hours in seconds

	try {
		// Get failed items that are older than 12 hours and haven't been refunded yet
		const failedItems = await env.DB.prepare(
			`SELECT * FROM subscription_queue 
       WHERE status = 'failed' 
       AND created_at <= ?
       AND error_message NOT LIKE '%REFUNDED:%'
       ORDER BY created_at ASC
       LIMIT ?`
		)
			.bind(twelveHoursAgo, limit)
			.all();

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
			await new Promise((resolve) => setTimeout(resolve, 200));
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
	const fiveMinutesAgo = timestamp - 5 * 60; // 5 minutes in seconds

	try {
		// First, reset items stuck in 'processing' status for more than 5 minutes back to 'pending'
		// This handles cases where the worker crashed or timed out while processing
		try {
			const resetResult = await env.DB.prepare(
				`UPDATE subscription_queue 
         SET status = 'pending', updated_at = ?
         WHERE status = 'processing' 
         AND updated_at < ?`
			)
				.bind(timestamp, fiveMinutesAgo)
				.run();

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
		)
			.bind(timestamp, limit)
			.all();

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
			)
				.bind(timestamp, item.queue_id)
				.run();

			// Check if we successfully acquired the lock (rows affected > 0)
			if (lockResult.meta.changes === 0) {
				// Another process already acquired the lock or item is no longer pending
				console.log(
					`[QUEUE] ⚠️ Could not acquire lock for queue item ${item.queue_id} - already being processed by another worker or status changed`
				);
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
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		if (skippedCount > 0) {
			console.log(`[QUEUE] ⚠️ Skipped ${skippedCount} queue items (lock already acquired by another process)`);
		}

		console.log(
			`[QUEUE] ✅ Queue processing complete: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped (lock conflict) out of ${queueItems.results.length} total`
		);

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
			Authorization: `Bearer ${key}`,
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
function initializeStripe(env) {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		apiVersion: '2025-04-30.basil',
		httpClient: Stripe.createFetchHttpClient(),
	});
}

export default {
	// Scheduled event handler
	async scheduled(event, env, ctx) {
		const timestamp = Math.floor(Date.now() / 1000);

		try {
			// Quick check: Are there any pending items or failed items?
			const pendingCheck = await env.DB.prepare(
				`SELECT COUNT(*) as count FROM subscription_queue 
         WHERE status = 'pending' 
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         LIMIT 1`
			)
				.bind(timestamp)
				.first();

			const twelveHoursAgo = timestamp - 12 * 60 * 60;
			const failedCheck = await env.DB.prepare(
				`SELECT COUNT(*) as count FROM subscription_queue 
         WHERE status = 'failed' 
         AND created_at <= ?
         AND error_message NOT LIKE '%REFUNDED:%'
         LIMIT 1`
			)
				.bind(twelveHoursAgo)
				.first();

			// Check for pending sites queue items
			const sitesQueueCheck = await env.DB.prepare(
				`SELECT COUNT(*) as count FROM sitesqueue 
         WHERE status = 'pending'
         LIMIT 1`
			).first();

			const hasPending = (pendingCheck?.count || 0) > 0;
			const hasFailed = (failedCheck?.count || 0) > 0;
			const hasSitesPending = (sitesQueueCheck?.count || 0) > 0;

			console.log(`[SCHEDULED] 📊 Queue status check:`, {
				subscriptionQueuePending: hasPending,
				subscriptionQueueFailed: hasFailed,
				sitesQueuePending: hasSitesPending,
				sitesQueueCount: sitesQueueCheck?.count || 0,
			});

			// Early exit only if nothing to process
			if (!hasPending && !hasFailed && !hasSitesPending) {
				console.log(`[SCHEDULED] ⏸️ No pending items or failed items to process. Skipping execution.`);
				return;
			}

			console.log(`[SCHEDULED] 🕐 Starting scheduled queue processing at ${new Date().toISOString()}`);

			// Process sites queue
			try {
				const sitesQueueResult = await processSitesQueue(env, 100);
				console.log(`[SCHEDULED] Sites queue processing:`, sitesQueueResult);
			} catch (sitesQueueErr) {
				console.error(`[SCHEDULED] Error processing sites queue:`, sitesQueueErr);
			}

			// Process subscription queue
			const queueResult = await processSubscriptionQueue(env, 100);
			console.log(`[SCHEDULED] ✅ Queue processing result:`, queueResult);

			// Process refunds for failed items
			let refundResult = { processed: 0, refunded: 0, message: 'No failed items to refund' };
			if (hasFailed) {
				refundResult = await processRefundsForOldFailedItems(env, 50);
				console.log(`[SCHEDULED] ✅ Refund processing result:`, refundResult);
			}
		} catch (error) {
			console.error(`[SCHEDULED] ❌ Error processing queue:`, error);
		}
	}, // ← Close scheduled handler here

	async fetch(request, env, ctx) {
		const stripe = initializeStripe(env);
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			const origin = request.headers.get('Origin');
			const corsHeaders = getCorsHeaders(request);

			const headers = {
				'Access-Control-Max-Age': '86400',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			};

			if (origin) {
				if (corsHeaders['Access-Control-Allow-Origin']) {
					headers['Access-Control-Allow-Origin'] = origin;
					headers['Access-Control-Allow-Credentials'] = 'true';
				} else if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
					headers['Access-Control-Allow-Origin'] = origin;
					headers['Access-Control-Allow-Credentials'] = 'true';
				}
			}

			if (origin) {
				headers['Vary'] = 'Origin';
			}

			return new Response(null, {
				status: 204,
				headers,
			});
		}

		try {
			// Create checkout session
			if (request.method === 'POST' && pathname === '/create-checkout-session') {
				const data = await request.json();
				const { customerEmail, sites, success_url, cancel_url } = data;

				if (!customerEmail || !Array.isArray(sites) || sites.length === 0) {
					console.error('Validation failed: missing customerEmail or sites');
					return jsonResponse(400, { error: 'missing customerEmail or sites' });
				}

				// Create customer
				const cust = await stripeFetch(env, '/customers', 'POST', { email: customerEmail }, true);
				if (cust.status >= 400) {
					console.error('Stripe customer creation failed:', cust.status);
					return jsonResponse(500, { error: 'stripe customer create failed' });
				}

				const customerId = cust.body.id;
				const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard';

				const form = {
					mode: 'subscription',
					customer: customerId,
					success_url: success_url || `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
					cancel_url: cancel_url || dashboardUrl,
					'metadata[usedfor]': 'dashboard',
					'metadata[usecase]': '1',
				};

				sites.forEach((s, i) => {
					form[`line_items[${i}][price]`] = s.price;
					form[`line_items[${i}][quantity]`] = s.quantity || 1;
					if (s.site) {
						form[`subscription_data[metadata][site_${i}]`] = s.site;
					}
				});

				const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);
				if (session.status >= 400) {
					console.error('Stripe checkout session creation failed:', session.status);
					return jsonResponse(500, { error: 'stripe checkout session failed' });
				}

				const redirect = url.searchParams.get('redirect') === 'true';
				if (redirect && session.body.url) {
					return new Response(null, {
						status: 302,
						headers: { Location: session.body.url },
					});
				}

				return jsonResponse(200, { sessionId: session.body.id, url: session.body.url });
			}
			if (request.method === 'POST' && pathname === '/webhook') {
				const signature = request.headers.get('stripe-signature');
				const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

				if (!signature) {
					console.error('[WEBHOOK] ❌ Missing stripe-signature header');
					return new Response('Missing stripe-signature header', { status: 400 });
				}

				if (!webhookSecret) {
					console.error('[WEBHOOK] ❌ STRIPE_WEBHOOK_SECRET not configured');
					return new Response('Webhook secret not configured', { status: 500 });
				}

				let event;

				try {
					// Get raw body as text/buffer string for signature verification
					const rawBody = await request.text();

					if (!rawBody) {
						console.error('[WEBHOOK] ❌ Empty request body');
						return new Response('Empty request body', { status: 400 });
					}

					console.log('[WEBHOOK] 🔐 Verifying Stripe signature...');

					event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret.trim());

					console.log('[WEBHOOK] ✅ Signature verified successfully');
					console.log('[WEBHOOK] 📨 Event type:', event.type);
					console.log('[WEBHOOK] 🔑 Event ID:', event.id);
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : 'Unknown signature verification error';

					console.error('[WEBHOOK] ❌ Signature verification failed:', errorMessage);
					console.error('[WEBHOOK] ❌ Error details:', err);

					return new Response(
						JSON.stringify({
							error: 'signature_verification_failed',
							message: errorMessage,
						}),
						{ status: 400, headers: { 'Content-Type': 'application/json' } }
					);
				}

				try {
					// Handle checkout.session.completed - save payment details and generate magic link
					if (event.type === 'checkout.session.completed') {
						// CRITICAL: Declare ALL variables IMMEDIATELY at the start of the handler
						// This ensures they're always defined, even if an error occurs early

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

						const checkoutCompleted = event.data.object;

						// Extract necessary information
						let customerId = checkoutCompleted.customer;
						const email = checkoutCompleted.customer_details ? checkoutCompleted.customer_details.email : null;

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
							identifiedUseCase = '2'; // ✅ Use Case 2: Site purchase (now handled here)
						} else if (sessionMode === 'subscription') {
							identifiedUseCase = '1'; // Use Case 1: Direct payment link
						} else {
							console.warn(
								`[checkout.session.completed] ⚠️ Unknown use case - mode: ${sessionMode}, usecase: ${
									sessionUseCase || 'not set'
								}. Defaulting to Use Case 1.`
							);
							identifiedUseCase = '1';
						}

						// ========================================
						// USE CASE 1 HANDLER: Direct Payment Links
						// ========================================
						// This section ONLY processes Use Case 1
						// Use Case 3 is handled above and returns early, so it never reaches here
						if (identifiedUseCase === '1') {
							console.log('[USE CASE 1] 🚀 Processing Use Case 1 - Dashboard Subscription');

							const session = event.data.object;
							const subscriptionId = session.subscription || null;
							const customerId = session.customer || null;

							// ========================================
							// STEP 1: Get Email
							// ========================================
							let email = session.customer_details && session.customer_details.email ? session.customer_details.email : null;

							if (!email && customerId) {
								console.log('[USE CASE 1] 🔍 Email not in session, fetching from customer...');
								email = await getCustomerEmail(env, customerId);
								if (!email) {
									console.log('[USE CASE 1] ❌ Could not get email from customer - exiting');
									return new Response('ok');
								}
							}

							console.log('[USE CASE 1] ✅ Email found:', email);

							// ========================================
							// STEP 2: Extract Custom Field (Site Domain)
							// ========================================
							let customFieldSiteUrl = null;
							if (session.custom_fields && session.custom_fields.length > 0) {
								const siteUrlField = session.custom_fields.find(
									(field) =>
										field.key === 'adddomain' ||
										field.key === 'customdomain' ||
										field.key === 'enteryourlivedomain' ||
										field.key === 'enteryourlivesiteurl' ||
										field.key === 'enteryourlivesiteur' ||
										(field.key && field.key.toLowerCase().includes('domain')) ||
										(field.key && field.key.toLowerCase().includes('site')) ||
										(field.type === 'text' && field.text && field.text.value)
								);



								if (siteUrlField && siteUrlField.type === 'text' && siteUrlField.text && siteUrlField.text.value) {
									customFieldSiteUrl = siteUrlField.text.value.trim();
									console.log(`[USE CASE 1] ✅ Extracted custom field site: ${customFieldSiteUrl}`);
								} else {
									console.log('[USE CASE 1] ⚠️ No custom field found');
								}
							}


							// ========================================
							// STEP 3: Verify this is for Dashboard
							// ========================================
							const sessionUsedFor = session.metadata && session.metadata.usedfor;
							if (sessionUsedFor && sessionUsedFor !== 'dashboard') {
								console.log(`[USE CASE 1] ⏭️ SKIPPING - not for dashboard`);
								return new Response('ok');
							}

							// ========================================
							// STEP 4: Fetch Subscription from Stripe
							// ========================================
							if (!subscriptionId) {
								console.log('[USE CASE 1] ❌ No subscriptionId on session - exiting');
								return new Response('ok');
							}

							console.log('[USE CASE 1] 🔍 Fetching subscription from Stripe...');
							const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
							if (subRes.status !== 200) {
								console.log('[USE CASE 1] ❌ Failed to fetch subscription:', subRes.status);
								return new Response('ok');
							}

							const sub = subRes.body;
							console.log('[USE CASE 1] ✅ Subscription fetched:', {
								id: sub.id,
								status: sub.status,
								items_count: sub.items && sub.items.data ? sub.items.data.length : 0,
							});

							// ========================================
							// STEP 5: Verify Product is for Dashboard
							// ========================================
							if (sub.items && sub.items.data && sub.items.data.length > 0) {
								const firstItem = sub.items.data[0];
								if (firstItem.price && firstItem.price.product) {
									const productId = typeof firstItem.price.product === 'string' ? firstItem.price.product : firstItem.price.product.id;

									try {
										console.log(`[USE CASE 1] 🔍 Fetching product metadata for product: ${productId}`);
										const productRes = await stripeFetch(env, `/products/${productId}`);
										if (productRes.status === 200 && productRes.body && productRes.body.metadata) {
											const productUsedFor = productRes.body.metadata.usedfor;
											console.log('[USE CASE 1] 🏷️ Product metadata usedfor:', productUsedFor);

											if (productUsedFor && productUsedFor !== 'dashboard') {
												console.log(`[USE CASE 1] ⏭️ SKIPPING - product.usedfor is "${productUsedFor}", not "dashboard"`);
												return new Response('ok');
											}
										}
									} catch (productErr) {
										console.warn('[USE CASE 1] ⚠️ Could not fetch product metadata:', productErr);
										// Continue anyway (backward compatibility)
									}
								}
							}

							// ========================================
							// STEP 6: Ensure Memberstack Member Exists
							// ========================================
							console.log('[USE CASE 1] 👤 Ensuring Memberstack member for:', email);
							const memberstackId = await ensureMemberstackMember(email, env);
							if (!memberstackId) {
								console.log('[USE CASE 1] ❌ Failed to ensure Memberstack member - exiting');
								return new Response('ok');
							}
							const normalizedEmail = email.toLowerCase().trim();
							const now = Math.floor(Date.now() / 1000);
							console.log('[USE CASE 1] ✅ Memberstack member ID:', memberstackId);




	const licenseKey1 = await generateUniqueLicenseKey(env);


              //DETECTING PLATFORM FROM METADATA STARTS

              let platform = await detectPlatform(customFieldSiteUrl);
              console.log(`[USE CASE 1] [ Detected platform:] ${platform}`);   
              	// :new: Get platform-specific KV namespace
				    	// const kvNamespaces = getKvNamespaces(env, platform);
				     	// const activeSitesKv = kvNamespaces.activeSitesKv;           
              

/*activeSitesKv,
	license_key,
	customer_id,
	subscription_id,
	email,
	status,
	cancelAtPeriodEnd,
	validatedSiteDomain,
	platform */

       


              //detecting platform from metadata endS








							await env.DB.prepare(
								`
  INSERT OR IGNORE INTO users (email, created_at, updated_at)
  VALUES (?, ?, ?)
`
							)
								.bind(normalizedEmail, now, now)
								.run();
							const response1 = await env.DB.prepare(
								`INSERT INTO customers (customer_id, user_email, created_at, updated_at)
  VALUES (?, ?, ?, ?)`
							)
								.bind(customerId, normalizedEmail, now, now)
								.run();
							console.log('[USE CASE 1] ✅ Customer record ensured:', response1);
							// ========================================
							// STEP 7: Save to Database
							// ========================================
							const billingPeriods = sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
							const amountPaid = sub.latest_invoice && sub.latest_invoice.amount_paid ? sub.latest_invoice.amount_paid : 0;
							console.log('[USE CASE 1] 💾 Saving subscription to database...');

							if (env.DB) {
								try {
									// Save subscription with custom field site
									console.log('[USE CASE 1]  Saving subscription to subscriptions...');
									const response = await env.DB.prepare(
										`INSERT OR REPLACE INTO subscriptions 
   (user_email, subscription_id, customer_id,status, created_at, current_period_start, current_period_end, billing_period)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
									)
										.bind(
											normalizedEmail,
											sub.id,
											customerId,
											sub.status || 'active',
											now,
											sub.current_period_start || now,
											sub.current_period_end || now + 30 * 24 * 60 * 60,
											billingPeriods
										)
										.run();
									console.log('response from insert [SUBSCRIPTIONS]:', response);
								} catch (dbErr) {
									console.error('[USE CASE 1] ❌ Error saving subscription to database:', dbErr);
									// Don't fail the webhook - payment already succeeded
								}
							}

							// ========================================
							// STEP 8: Save Site Details to Sites Table
							// ========================================
							if (env.DB && customFieldSiteUrl) {
								try {
									const now = Math.floor(Date.now() / 1000); // current time in seconds
									const normalizedEmail = email.toLowerCase().trim();

									console.log('[USE CASE 1] 💾 Saving site details to database...');
								
									// Ensure all values are defined, provide fallback if Stripe subscription data missing
									const currentPeriodStart = sub.current_period_start ?? now;
									const currentPeriodEnd = sub.current_period_end ?? now + 30 * 24 * 60 * 60; // +30 days fallback
									const cancelAtPeriodEnd = sub.cancel_at_period_end ? 1 : 0; // store as integer
									const canceledAt = sub.canceled_at ?? null;

									const response = await env.DB.prepare(
										`INSERT INTO sites 
        (
		subscription_id,
         customer_id, 
         site_domain, 
         price_id,
         created_at,
         current_period_start,
         current_period_end,
         renewal_date,
         cancel_at_period_end,
         canceled_at,
         platform,
         currency,
         amount_paid,
		 license_key,
		 user_email,
		 billing_period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?, ?,?)`
									)
										.bind(
											sub.id,
											customerId,
											customFieldSiteUrl,
											null, // price_id fallback (or provide actual if available)
											now, // created_at
											currentPeriodStart, // Stripe or fallback
											currentPeriodEnd, // Stripe or fallback
											currentPeriodEnd, // renewal_date = end of current period
											cancelAtPeriodEnd,
											canceledAt,
											platform,
											'usd',
											amountPaid ,
											licenseKey1,
											normalizedEmail,
											billingPeriods
										)
										.run();

									console.log('[USE CASE 1] ✅[SITES] Site details saved:', response);
								} catch (siteErr) {
									console.error('[USE CASE 1] ⚠️ Error saving site details:', siteErr);
									// Continue anyway - subscription is already saved
								}
							}

							// ========================================
							// STEP 9: Save Subscription Items
							// ========================================
							if (env.DB && sub.items && sub.items.data && sub.items.data.length > 0) {
								try {
									const now = Math.floor(Date.now() / 1000);
									const normalizedEmail = email.toLowerCase().trim();

									console.log('[USE CASE 1] 💾 Saving subscription items...');
									for (let index = 0; index < sub.items.data.length; index++) {
										const item = sub.items.data[index];

										const response = await env.DB.prepare(
											`INSERT OR REPLACE INTO subscription_items 
           (subscription_id, item_id, price_id, quantity, site_domain, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
										)
											.bind(sub.id, item.id, item.price.id, item.quantity || 1, customFieldSiteUrl || null, 'active', now)
											.run();
										console.log(`[USE CASE 1] ✅[SUBSCRIPTION_ITEMS] Saved item ${item.id}:`, response);
									}

									console.log('[USE CASE 1] ✅ Subscription items saved');
								} catch (itemErr) {
									console.error('[USE CASE 1] ⚠️ Error saving subscription items:', itemErr);
									// Continue anyway
								}
							}

							// ========================================
							// STEP 10: Generate License Key
							// ========================================
							try {
							//	const licenseKey = await generateUniqueLicenseKey(env);
								const now = Math.floor(Date.now() / 1000);
								const normalizedEmail = email.toLowerCase().trim();
									   console.log('[USE CASE 1] 🔍 email to save...', normalizedEmail);
								console.log('[USE CASE 1] 🔑 Generated license key:', licenseKey1.substring(0, 10) + '...');

								const response = await env.DB.prepare(
									`
  INSERT INTO licenses 
  (
  license_key, 
  subscription_id,
  customer_id,
   item_id,
    site_domain, 
	status,
	 used_site_domain,
	  purchase_type,
	   created_at, 
	   updated_at,
	    platform,
		user_email)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
								)
									.bind(
										licenseKey1,
										sub.id,
										customerId,
										null,
										customFieldSiteUrl || null,
										'active',
										customFieldSiteUrl || null,
										'site',
										now,
										now,
										platform,
										normalizedEmail
									)
									.run();
								console.log('[USE CASE 1] ✅ [LICENSES] License key saved:', response);
							} catch (licenseErr) {
								console.error('[USE CASE 1] ❌ Error generating/saving license:', licenseErr);
								// Don't fail the webhook - payment already succeeded
							}

							// ========================================
							// STEP 11: Save Payment Record
							// ========================================
							if (env.DB) {
								try {
									const now = Math.floor(Date.now() / 1000);
									const normalizedEmail = email.toLowerCase().trim();
									const amount = session.amount_total || 0;
									const currency = session.currency || 'usd';

									const response = await env.DB.prepare(
										`INSERT INTO payments 
         (subscription_id, customer_id, email, amount, currency, site_domain, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
									)
										.bind(sub.id, customerId, normalizedEmail, amount, currency, customFieldSiteUrl || null, 'succeeded', now)
										.run();

									console.log('[USE CASE 1] ✅ [PAYMENTS] Payment record saved', response);
								} catch (paymentErr) {
									console.error('[USE CASE 1] ⚠️ Error saving payment record:', paymentErr);
									// Continue anyway
								}
							}

							console.log('[USE CASE 1] ✅ Use Case 1 processing completed successfully');
							return new Response('ok');
						}






            //USECASE 1 ENDS HERE
						if (identifiedUseCase === '2') {
							console.log('[USE CASE 2] 🚀 Processing Use Case 2 checkout session');
							const paymentIntentId = session.payment_intent;

							let paymentIntent = null;
							if (paymentIntentId) {
								const piRes = await stripeFetch(env, `/payment_intents/${paymentIntentId}`);
								if (piRes.status === 200) {
									paymentIntent = piRes.body;
								}
							}

							const metadata = (paymentIntent && paymentIntent.metadata) || session.metadata || {};
							console.log('[USE CASE 2 - CS COMPLETED] metadata:', metadata);

							const useCase2CustomerId = metadata.customer_id || customerId;

							const userEmail = await getCustomerEmail(env, useCase2CustomerId);
							if (!userEmail) {
								console.warn('[USE CASE 2] No user email, exiting');
								return new Response('ok');
							}

							// Parse sites
							let siteNames = [];
							try {
								const rawSites = metadata.sites_json || metadata.sites;
								if (rawSites) {
									siteNames = JSON.parse(rawSites);
								}
							} catch (e) {
								console.error('[USE CASE 2] Error parsing sites_json:', e);
							}

							const productId = metadata.product_id;

							// Check product metadata to verify it's for dashboard
							if (productId) {
								try {
									const productRes = await stripeFetch(env, `/products/${productId}`);
									if (productRes.status === 200 && productRes.body?.metadata?.usedfor) {
										const productUsedFor = productRes.body.metadata.usedfor;
										console.log(`[USE CASE 2] 🏷️ Product metadata usedfor: ${productUsedFor}`);

										// Only process if product is for dashboard
										if (productUsedFor !== 'dashboard') {
											console.log(`[USE CASE 2] ⏭️ Skipping - Product usedfor is "${productUsedFor}", not "dashboard"`);
											return new Response('ok'); // Skip processing
										}
									}
								} catch (productErr) {
									console.warn(`[USE CASE 2] ⚠️ Could not fetch product metadata:`, productErr);
									// Continue processing if product fetch fails (backward compatibility)
								}
							}

							const rawPeriod = metadata.billing_period || '';
							const billingPeriod = rawPeriod.toLowerCase().trim(); // "monthly" / "yearly"
							const currency = metadata.currency || 'usd';

							// Derive per-site unit amount
							let unitAmount = null;
							try {
								if (siteNames.length > 0 && typeof session.amount_total === 'number') {
									unitAmount = Math.round(session.amount_total / siteNames.length);
								}
							} catch (_) {}

							// Fallback if needed
							if (!unitAmount) {
								unitAmount = 800; // from your monthly config
							}

							// Create or get dynamic price
							const priceId = await getOrCreateDynamicPrice(env, {
								productId,
								billingPeriod,
								currency,
								unitAmount,
							});

							if (!priceId || siteNames.length === 0) {
								console.warn('[USE CASE 2] Missing priceId or sites after dynamic price create, skipping enqueue', {
									productId,
									billingPeriod,
									priceId,
									siteNamesLength: siteNames.length,
								});
								return new Response('ok');
							}

							const sitesForQueue = siteNames.map((name) => ({
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
								paymentIntentId: paymentIntentId || null,
							});

							console.log('[USE CASE 2] ✅ Enqueued sites job (checkout.session.completed)', {
								queueId,
								sites: siteNames.length,
								siteNames: siteNames,
								paymentIntentId: paymentIntentId,
								customerId: useCase2CustomerId,
								userEmail: userEmail,
							});

							return new Response('ok');
						}
      //USECASE 2 ENDS HERE



					
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
											const useCase3CustomerId = session.customer || metadata.customer_id || paymentIntent.customer;

											// 3) Load license keys (temporary) from metadata / customer
											let licenseKeys = [];
											try {
												if (metadata.license_keys) {
													// Stored directly on payment_intent metadata
													licenseKeys = JSON.parse(metadata.license_keys);
												} else if (metadata.license_keys_source === 'customer_metadata' || metadata.license_keys_count) {
													// For large quantity, keys are on customer metadata
													try {
														const customerRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`);
														if (customerRes.status === 200 && customerRes.body.metadata?.license_keys_pending) {
															licenseKeys = JSON.parse(customerRes.body.metadata.license_keys_pending);
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
												console.error(`[checkout.session.completed] Error parsing license_keys:`, e);
											}

											// If still empty, try again (same logic, but keep as is for idempotency)
											if (licenseKeys.length === 0) {
												console.warn(
													`[checkout.session.completed] ⚠️ No license_keys found in metadata. Available keys: ${Object.keys(metadata).join(
														', '
													)}`
												);
											}

											// 4) Enhanced idempotency check: check payment_intent_id in queue to prevent duplicate processing
											if (env.DB && paymentIntentId) {
												try {
													// Check if queue items already exist for this payment_intent_id
													const queueCheck = await env.DB.prepare(
														`SELECT COUNT(*) as count FROM subscription_queue 
                 WHERE payment_intent_id = ? AND status IN ('pending', 'processing', 'completed')`
													)
														.bind(paymentIntentId)
														.first();

													if (queueCheck && queueCheck.count > 0) {
														console.log(
															`[checkout.session.completed] ℹ️ Use Case 3 already processed (${queueCheck.count} queue item(s) exist for payment_intent_id=${paymentIntentId}), returning early to prevent duplicates.`
														);
														return new Response('ok');
													}

													// Also check if licenses already exist for this payment_intent_id (via queue)
													if (licenseKeys.length > 0) {
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
													}
												} catch (checkErr) {
													console.warn(`[checkout.session.completed] Could not check for existing queue items/licenses:`, checkErr);
												}
											}

											// 5) Resolve user email
											const userEmail = await getCustomerEmail(env, useCase3CustomerId);
											if (!userEmail) {
												console.warn('[checkout.session.completed] User email not found for Use Case 3');
												return new Response('ok');
											}

											// 6) Resolve priceId (from metadata → product → billing_period)
											let priceId = null;
											// CRITICAL FIX: Get quantity from metadata FIRST, don't fall back to licenseKeys.length
											let quantity = parseInt(metadata.quantity) || 0;
											const productIdFromMetadata = metadata.product_id || null;
											let productIdFromCustomer = null;

											console.log(`[checkout.session.completed] 📋 Metadata keys: ${Object.keys(metadata).join(', ')}`);
											console.log(`[checkout.session.completed] 📋 Initial quantity from metadata: ${quantity}`);
											if (productIdFromMetadata) {
												console.log(`[checkout.session.completed] 🆔 Product ID from metadata: ${productIdFromMetadata}`);
											}

											try {
												// Re-load keys if needed (same as above, safe)
												if (metadata.license_keys) {
													licenseKeys = JSON.parse(metadata.license_keys);
													console.log(
														`[checkout.session.completed] ✅ Retrieved ${licenseKeys.length} license keys from payment_intent metadata`
													);
												} else if (metadata.license_keys_source === 'customer_metadata' || metadata.license_keys_count) {
													if (licenseKeys.length === 0) {
														try {
															const customerRes = await stripeFetch(env, `/customers/${useCase3CustomerId}`);
															if (customerRes.status === 200 && customerRes.body.metadata?.license_keys_pending) {
																licenseKeys = JSON.parse(customerRes.body.metadata.license_keys_pending);
																console.log(
																	`[checkout.session.completed] ✅ Retrieved ${licenseKeys.length} license keys from customer metadata`
																);
															}
															if (!productIdFromMetadata && customerRes.body.metadata?.product_id) {
																productIdFromCustomer = customerRes.body.metadata.product_id;
																console.log(`[checkout.session.completed] 🆔 Product ID from customer metadata: ${productIdFromCustomer}`);
															}
														} catch (customerErr) {
															console.error(
																`[checkout.session.completed] ❌ Error fetching license keys from customer metadata:`,
																customerErr
															);
														}
													}
												} else {
													console.warn(`[checkout.session.completed] ⚠️ No license_keys found in metadata.`);
												}

												priceId = metadata.price_id || null;
												// CRITICAL FIX: Update quantity from metadata again (in case it was set after licenseKeys check)
												if (metadata.quantity) {
													quantity = parseInt(metadata.quantity) || quantity;
												}

												// CRITICAL FIX: If quantity is still 0 but we have licenseKeys, use licenseKeys.length
												if (quantity === 0 && licenseKeys.length > 0) {
													quantity = licenseKeys.length;
													console.log(`[checkout.session.completed] ⚠️ Quantity was 0, using licenseKeys.length: ${quantity}`);
												}

												// CRITICAL FIX: If quantity is still 0, this is an error - log it
												if (quantity === 0) {
													console.error(
														`[checkout.session.completed] ❌ CRITICAL: Quantity is 0 and no license keys found! Cannot queue items.`
													);
													console.error(`[checkout.session.completed] ❌ Metadata: ${JSON.stringify(metadata)}`);
												}

												const productIdToUse = productIdFromMetadata || productIdFromCustomer;

												// Check product metadata to verify it's for dashboard
												let productUsedFor = null;
												if (productIdToUse) {
													try {
														const productRes = await stripeFetch(env, `/products/${productIdToUse}`);
														if (productRes.status === 200 && productRes.body?.metadata?.usedfor) {
															productUsedFor = productRes.body.metadata.usedfor;
															console.log(`[checkout.session.completed] 🏷️ Product metadata usedfor: ${productUsedFor}`);

															// Only process if product is for dashboard
															if (productUsedFor !== 'dashboard') {
																console.log(
																	`[checkout.session.completed] ⏭️ Skipping - Product usedfor is "${productUsedFor}", not "dashboard"`
																);
																return new Response('ok'); // Skip processing
															}
														}
													} catch (productErr) {
														console.warn(`[checkout.session.completed] ⚠️ Could not fetch product metadata:`, productErr);
														// Continue processing if product fetch fails (backward compatibility)
													}
												}

												// If price_id not in metadata, try via product
												if (!priceId && productIdToUse) {
													console.log(`[checkout.session.completed] 🔍 price_id not found, fetching from product_id: ${productIdToUse}`);
													try {
														const productRes = await stripeFetch(env, `/products/${productIdToUse}`);
														if (productRes.status === 200 && productRes.body) {
															const pricesRes = await stripeFetch(env, `/prices?product=${productIdToUse}&active=true&limit=1`);
															if (pricesRes.status === 200 && pricesRes.body?.data?.length > 0) {
																priceId = pricesRes.body.data[0].id;
																console.log(`[checkout.session.completed] ✅ Found price_id from product: ${priceId}`);
															} else {
																console.warn(`[checkout.session.completed] ⚠️ No active prices found for product: ${productIdToUse}`);
															}
														}
													} catch (productErr) {
														console.error(`[checkout.session.completed] ❌ Error fetching price_id from product_id:`, productErr);
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
															console.log(`[checkout.session.completed] ✅ Found price_id from billing_period: ${priceId}`);
														}
													} catch (billingErr) {
														console.error(`[checkout.session.completed] ❌ Error getting price_id from billing_period:`, billingErr);
													}
												}
											} catch (parseErr) {
												console.error('[checkout.session.completed] ❌ Error parsing metadata:', parseErr);
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
													console.warn(`[checkout.session.completed] Could not fetch charge for payment method:`, chargeErr);
												}
											}

											const customerIdForPaymentMethod = session.customer || paymentIntent.customer || useCase3CustomerId;

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
														if (errorMessage.includes('already attached') || errorMessage.includes('already been attached')) {
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
													console.error(`[checkout.session.completed] ❌ STEP 1 FAILED: Error attaching payment method:`, attachErr);
												}
											} else {
												console.error(
													`[checkout.session.completed] ❌ STEP 1 FAILED: Missing payment_method or customer. payment_method: ${paymentMethodId}, customer: ${customerIdForPaymentMethod}`
												);
											}

											// 8) ALWAYS QUEUE: no immediate subscription creation, no thresholds
											const customerIdForSubscriptions = customerIdForPaymentMethod || session.customer || useCase3CustomerId;

											// CRITICAL: Add detailed logging before condition check
											console.log(`[USE CASE 3 - QUEUE CHECK] 🔍 Checking queue conditions:`);
											console.log(`[USE CASE 3 - QUEUE CHECK]   - paymentMethodSaved: ${paymentMethodSaved}`);
											console.log(`[USE CASE 3 - QUEUE CHECK]   - priceId: ${priceId}`);
											console.log(`[USE CASE 3 - QUEUE CHECK]   - quantity: ${quantity}`);
											console.log(`[USE CASE 3 - QUEUE CHECK]   - customerIdForSubscriptions: ${customerIdForSubscriptions}`);
											console.log(`[USE CASE 3 - QUEUE CHECK]   - licenseKeys.length: ${licenseKeys ? licenseKeys.length : 'undefined'}`);

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
													const minimumTrialEnd = billingInterval === 'day' ? now + 7 * 24 * 60 * 60 : now + 3600;
													const trialEnd = Math.max(trialEndTime, minimumTrialEnd);

													// CRITICAL FIX: Ensure we have exactly 'quantity' license keys before queuing
													if (!licenseKeys || licenseKeys.length === 0) {
														if (quantity > 0) {
															licenseKeys = generateTempLicenseKeys(quantity);
															console.log(`[USE CASE 3] ✅ Generated ${licenseKeys.length} temporary license keys (quantity: ${quantity})`);
														} else {
															console.error(`[USE CASE 3] ❌ CRITICAL: Cannot generate license keys - quantity is 0!`);
															// This will cause the condition at line 3764 to fail, which is correct
														}
													} else if (licenseKeys.length < quantity) {
														// If we have some keys but not enough, generate the missing ones
														console.warn(
															`[USE CASE 3] ⚠️ Only ${licenseKeys.length} license keys found, but quantity is ${quantity}. Generating ${
																quantity - licenseKeys.length
															} more...`
														);
														const additionalKeys = generateTempLicenseKeys(quantity - licenseKeys.length);
														licenseKeys = [...licenseKeys, ...additionalKeys];
														console.log(`[USE CASE 3] ✅ Now have ${licenseKeys.length} license keys (matches quantity: ${quantity})`);
													} else if (licenseKeys.length > quantity) {
														// If we have more keys than quantity, trim to quantity
														console.warn(
															`[USE CASE 3] ⚠️ Found ${licenseKeys.length} license keys but quantity is ${quantity}. Using first ${quantity} keys.`
														);
														licenseKeys = licenseKeys.slice(0, quantity);
													}

													// CRITICAL: Verify we have the correct number of keys
													if (licenseKeys.length !== quantity) {
														console.error(
															`[USE CASE 3] ❌ CRITICAL MISMATCH: licenseKeys.length (${licenseKeys.length}) != quantity (${quantity})`
														);
													}

													const toQueue = Math.min(licenseKeys.length, quantity);
													console.log(
														`[USE CASE 3 - QUEUE ONLY] 📋 Will queue ${toQueue} items (licenseKeys: ${licenseKeys.length}, quantity: ${quantity})`
													);

													// CRITICAL: Add validation before queuing
													if (toQueue === 0) {
														console.error(`[USE CASE 3 - QUEUE ONLY] ❌ CRITICAL: Cannot queue items - toQueue is 0!`);
														console.error(
															`[USE CASE 3 - QUEUE ONLY] ❌ Debug info: licenseKeys.length=${licenseKeys.length}, quantity=${quantity}, priceId=${priceId}, paymentMethodSaved=${paymentMethodSaved}, customerIdForSubscriptions=${customerIdForSubscriptions}`
														);
													}

													let queuedCount = 0;
													let queueErrors = 0;
													const failedQueueItems = [];

													if (toQueue > 0) {
														console.log(`[USE CASE 3 - QUEUE ONLY] 📋 Adding ${toQueue} items to subscription_queue...`);

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
																		`[USE CASE 3 - QUEUE ONLY] ✅ Queued ${
																			i + 1
																		}/${toQueue} items (${queuedCount} successful, ${queueErrors} errors)`
																	);
																}
															} else {
																queueErrors++;
																failedQueueItems.push({ index: i, licenseKey: licenseKeys[i], error: queueResult.error });
																console.error(
																	`[USE CASE 3 - QUEUE ONLY] ❌ Failed to queue item ${i + 1}/${toQueue} for license ${licenseKeys[i]}:`,
																	queueResult.error
																);
															}
														}

														// Retry failed queue items once
														if (failedQueueItems.length > 0) {
															console.log(`[USE CASE 3 - QUEUE ONLY] 🔄 Retrying ${failedQueueItems.length} failed queue items...`);
															for (const failedItem of failedQueueItems) {
																const retryResult = await addToSubscriptionQueue(env, {
																	customerId: customerIdForSubscriptions,
																	userEmail,
																	paymentIntentId: paymentIntent.id,
																	priceId,
																	licenseKey: failedItem.licenseKey,
																	quantity: 1,
																	trialEnd,
																});

																if (retryResult.success) {
																	queuedCount++;
																	queueErrors--;
																	console.log(`[USE CASE 3 - QUEUE ONLY] ✅ Retry successful for license ${failedItem.licenseKey}`);
																} else {
																	console.error(
																		`[USE CASE 3 - QUEUE ONLY] ❌ Retry failed for license ${failedItem.licenseKey}:`,
																		retryResult.error
																	);
																}
															}
														}

														console.log(
															`[USE CASE 3 - QUEUE ONLY] 📊 Queue Summary: ${queuedCount} queued successfully, ${queueErrors} failed out of ${toQueue} planned (quantity: ${quantity})`
														);

														// CRITICAL: Verify all items were queued
														if (queuedCount !== quantity) {
															console.error(
																`[USE CASE 3 - QUEUE ONLY] ❌ CRITICAL: Only ${queuedCount} out of ${quantity} items were queued successfully!`
															);
														}
													}

													// No subscription creation here. Background worker / cron will call processQueueItem()
													// for each pending row and:
													//  - generate real license key if temporary
													//  - create subscription in Stripe
													//  - create license row in DB
													//  - mark queue row as completed or delete it
												} catch (queueErr) {
													console.error('[checkout.session.completed] ❌ Error queuing subscriptions for Use Case 3:', queueErr);
												}
											} else {
												// Explain why nothing was queued
												console.error(`[USE CASE 3 - QUEUE CHECK] ❌ QUEUE STEP SKIPPED - Conditions not met:`);
												if (!paymentMethodSaved) {
													console.error(`[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Payment method was not saved successfully`);
												}
												if (!priceId) {
													console.error(`[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Missing priceId`);
												}
												if (!quantity || quantity <= 0) {
													console.error(`[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Invalid quantity: ${quantity}`);
												}
												if (!customerIdForSubscriptions) {
													console.error(`[checkout.session.completed] ❌ QUEUE STEP SKIPPED: Missing customerId`);
												}
											}

											// IMPORTANT: no immediate creation, no license DB writes here.
											// Everything happens in queue processor.

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
 //USECASE 3 ENDS HERE
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
							note: 'Subscription status updated by Stripe',
						});

						// Check product metadata to verify it's for dashboard
						if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
							const firstItem = subscription.items.data[0];
							if (firstItem.price && firstItem.price.product) {
								const productId = typeof firstItem.price.product === 'string' ? firstItem.price.product : firstItem.price.product.id;

								try {
									const productRes = await stripeFetch(env, `/products/${productId}`);
									if (productRes.status === 200 && productRes.body?.metadata?.usedfor) {
										const productUsedFor = productRes.body.metadata.usedfor;
										console.log(`[customer.subscription.updated] 🏷️ Product metadata usedfor: ${productUsedFor}`);

										// Only process if product is for dashboard
										if (productUsedFor !== 'dashboard') {
											console.log(`[customer.subscription.updated] ⏭️ Skipping - Product usedfor is "${productUsedFor}", not "dashboard"`);
											return new Response('ok'); // Skip processing
										}
									}
								} catch (productErr) {
									console.warn(`[customer.subscription.updated] ⚠️ Could not fetch product metadata:`, productErr);
									// Continue processing if product fetch fails (backward compatibility)
								}
							}
						}

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
						const subscriptionExists = user.customers.some((c) => c.subscriptions.some((s) => s.subscriptionId === subscriptionId));
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
							const isCancelled =
								sub.status === 'canceled' || (sub.cancel_at_period_end === true && periodEnded) || sub.canceled_at !== null;

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
										)
											.bind(
												finalStatus,
												sub.cancel_at_period_end ? 1 : 0,
												sub.canceled_at || null, // Stripe returns canceled_at, we store it as cancel_at
												sub.current_period_end || null, // Ensure current_period_end is updated from Stripe
												timestamp,
												subscriptionId
											)
											.run();

										// Mark items and licenses as inactive if:
										// 1. Subscription status is 'canceled' (Stripe has cancelled it)
										// 2. OR period has ended and cancel_at_period_end was true
										// This handles both manual cancellations and automatic cancellations at period end
										const shouldMarkInactive = sub.status === 'canceled' || (periodEnded && sub.cancel_at_period_end === true);

										if (shouldMarkInactive) {
											console.log(
												`[subscription.updated] Marking subscription ${subscriptionId} as inactive - status: ${sub.status}, periodEnded: ${periodEnded}, cancel_at_period_end: ${sub.cancel_at_period_end}`
											);

											// Mark all subscription items as inactive
											await env.DB.prepare(
												'UPDATE subscription_items SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
											)
												.bind('inactive', timestamp, subscriptionId, 'active')
												.run();

											// Mark all licenses as inactive for this subscription
											const licenseUpdateResult = await env.DB.prepare(
												'UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?'
											)
												.bind('inactive', timestamp, subscriptionId, 'active')
												.run();

											if (licenseUpdateResult.success) {
												console.log(`[subscription.updated] ✅ Marked licenses as inactive for subscription ${subscriptionId}`);

												// Log the license deactivation
												await logStripeEvent(
													env,
													{
														id: `manual_${timestamp}`,
														type: 'subscription.cancelled',
														data: { object: sub },
														created: timestamp,
													},
													subscriptionId,
													customerId,
													{
														action: 'licenses_marked_inactive',
														period_ended: periodEnded,
														cancel_at_period_end: sub.cancel_at_period_end,
														status: sub.status,
														note: 'Licenses marked inactive due to subscription cancellation',
													}
												);
											} else {
												console.warn(`[subscription.updated] ⚠️ Failed to mark licenses as inactive for subscription ${subscriptionId}`);
											}
										} else {
											console.log(
												`[subscription.updated] Subscription ${subscriptionId} is not yet cancelled - status: ${sub.status}, periodEnded: ${periodEnded}, cancel_at_period_end: ${sub.cancel_at_period_end}`
											);
										}
									} catch (dbErr) {
										console.error('Error updating cancelled subscription in database:', dbErr);
									}
								}
								return new Response('ok');
							}

							const activeItemIds = new Set(sub.items.data.map((item) => item.id));
							const itemIdToSite = new Map(); // Map item_id -> site name from user record

							// Build map of item_id to site name from user record
							Object.keys(user.sites || {}).forEach((site) => {
								const siteData = user.sites[site];
								if (siteData.item_id) {
									itemIdToSite.set(siteData.item_id, site);
								}
							});

							// First, update existing sites and add new ones from Stripe
							const itemsForEmailStructure = [];
							const userEmail = user.email;

							// Fetch all licenses for sites in this subscription (batch fetch for efficiency)
							const siteNames = sub.items.data
								.map((item) => {
									const siteFromMetadata = item.metadata?.site;
									const siteFromUserRecord = itemIdToSite.get(item.id);
									return siteFromMetadata || siteFromUserRecord;
								})
								.filter(Boolean);
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
											)
												.bind(customerId, site, 'active')
												.first();

											if (!existingLicense) {
												// Generate new license key only if subscription is active
												const licenseKey = await generateUniqueLicenseKey(env);
												const timestamp = Math.floor(Date.now() / 1000);
												// Extract billing_period and renewal_date from subscription
												const billingPeriod = extractBillingPeriodFromStripe(sub);
												const renewalDate = sub.current_period_end || null;
												await env.DB.prepare(
													'INSERT INTO licenses (customer_id, subscription_id, item_id, site_domain, license_key, status, billing_period, renewal_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
												)
													.bind(customerId, sub.id, item.id, site, licenseKey, 'active', billingPeriod, renewalDate, timestamp, timestamp)
													.run();
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
									const siteStatus = sub.status === 'canceled' || sub.cancel_at_period_end || sub.canceled_at ? 'inactive' : 'active';
									const siteData = {
										item_id: item.id,
										price: item.price.id,
										quantity: item.quantity,
										status: siteStatus,
										created_at: user.sites[site]?.created_at || Math.floor(Date.now() / 1000),
										subscription_id: sub.id,
										license: license ? license.license_key || license : null, // Add license info to site object
										current_period_start: sub.current_period_start,
										current_period_end: sub.current_period_end,
										renewal_date: sub.current_period_end,
										cancel_at_period_end: sub.cancel_at_period_end || false,
										canceled_at: sub.canceled_at || null,
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
											canceledAt: sub.canceled_at || null,
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
											created_at: Math.floor(Date.now() / 1000),
										};
									}
									user.subscriptions[sub.id].sites[site] = siteData;
									user.subscriptions[sub.id].sitesCount = Object.keys(user.subscriptions[sub.id].sites).length;

									// Prepare item for email-based structure
									itemsForEmailStructure.push({
										item_id: item.id,
										site: site, // Actual site name/domain
										price: item.price.id,
										quantity: item.quantity,
										status: 'active',
										created_at: siteData.created_at,
										license: license || null, // Add license info to item
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
											created_at: Math.floor(Date.now() / 1000),
										};
									}
								}
							}

							// Now, only mark sites as inactive if:
							// 1. They have an item_id
							// 2. That item_id is NOT in the active items
							// 3. They are currently marked as active (don't re-mark already inactive sites)
							Object.keys(user.sites || {}).forEach((site) => {
								const siteData = user.sites[site];
								if (siteData.item_id && siteData.status === 'active') {
									// Only mark as inactive if item no longer exists AND it was previously active
									if (!activeItemIds.has(siteData.item_id)) {
										// Double-check: make sure this item was actually removed, not just being added
										// If the site was just added in checkout.session.completed, it might not be in Stripe yet
										// So we only mark inactive if it's been more than a few seconds since creation
										const timeSinceCreation = Date.now() / 1000 - (siteData.created_at || 0);
										if (timeSinceCreation > 10) {
											// Only mark inactive if created more than 10 seconds ago
											user.sites[site].status = 'inactive';
											if (!user.sites[site].removed_at) {
												user.sites[site].removed_at = Math.floor(Date.now() / 1000);
											}
										} else {
										}
									} else {
										// Item exists - ensure it's active and update quantity
										const currentItem = sub.items.data.find((item) => item.id === siteData.item_id);
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
								Object.keys(user.sites || {}).forEach((site) => {
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
												canceledAt: sub.canceled_at || removedAt,
											}).catch((err) => console.error('Failed to update site in DB:', err));
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
							note: 'Subscription permanently deleted by Stripe',
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
						Object.keys(user.sites || {}).forEach((site) => {
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
										canceledAt: subscription.canceled_at || deletedAt,
									}).catch((err) => console.error('Failed to update site in DB:', err));
								}
							}
						});

						// Update licenses in database
						if (env.DB) {
							try {
								const timestamp = Math.floor(Date.now() / 1000);
								await env.DB.prepare('UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?')
									.bind('inactive', timestamp, subscriptionId, 'active')
									.run();
							} catch (dbError) {
								console.error('Failed to update licenses for deleted subscription:', dbError);
							}
						}

						// If this was the primary subscription, update subscriptionId
						if (user.subscriptionId === subscriptionId) {
							// Find another active subscription
							const activeSub = Object.keys(user.subscriptions || {}).find((subId) => user.subscriptions[subId].status === 'active');
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
										const subscription = customer.subscriptions.find((s) => s.subscriptionId === subscriptionId);
										if (subscription) {
											subscription.status = 'deleted';
											subscription.deleted_at = Math.floor(Date.now() / 1000);
											// Mark items as inactive
											if (subscription.items) {
												subscription.items.forEach((item) => {
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
					// IMPORTANT: This handler ONLY processes Use Case 2 and Use Case 3
					// Use Case 1 (subscription mode) is handled by checkout.session.completed ONLY
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

						// CRITICAL: Skip Use Case 1 - it's handled by checkout.session.completed ONLY
						// If this is a subscription mode checkout (Use Case 1), payment_intent.succeeded should NOT process it
						// Check if this payment intent is associated with a subscription (Use Case 1 indicator)
						if (!useCase2 && !useCase3) {
							// Check if payment intent has an invoice with subscription (Use Case 1 indicator)
							if (paymentIntent.invoice) {
								try {
									const invoiceRes = await stripeFetch(env, `/invoices/${paymentIntent.invoice}`);
									if (invoiceRes.status === 200 && invoiceRes.body.subscription) {
										console.log(
											`[payment_intent.succeeded] ⚠️ Skipping Use Case 1 - payment intent ${paymentIntent.id} is for subscription ${invoiceRes.body.subscription}. Use Case 1 is handled by checkout.session.completed ONLY.`
										);
										return new Response('ok');
									}
								} catch (invoiceErr) {
									// If we can't check invoice, log warning but continue check
									console.warn(`[payment_intent.succeeded] Could not check invoice for subscription:`, invoiceErr);
								}
							}

							// Also check if payment intent metadata indicates subscription mode
							// Use Case 1 subscriptions don't have usecase='2' or '3' in metadata
							// If metadata is empty or doesn't have usecase, and it's not Use Case 2/3, it's likely Use Case 1
							if (!metadata.usecase || (metadata.usecase !== '2' && metadata.usecase !== '3')) {
								console.log(
									`[payment_intent.succeeded] ⚠️ Skipping Use Case 1 - payment intent ${
										paymentIntent.id
									} has no usecase metadata or usecase is not 2/3 (usecase: ${
										metadata.usecase || 'not set'
									}). Use Case 1 is handled by checkout.session.completed ONLY.`
								);
								return new Response('ok');
							}
						}

						// USE CASE 2: Site purchase - Create separate subscription for each site (like Use Case 3 for licenses)
						// DEBUG: always log what we got for this PI
						console.log('[PI DEBUG] payment_intent.succeeded id:', paymentIntent.id);
						console.log('[PI DEBUG] metadata:', metadata);
						console.log('[PI DEBUG] usecase:', metadata.usecase, 'useCase2:', useCase2, 'useCase3:', useCase3);

						// USE CASE 2: Site purchase - enqueue site processing job
						if (useCase2 && useCase2CustomerId) {
							console.log('[USE CASE 2] Handling site purchase (payment_intent.succeeded)');

							const userEmail = await getCustomerEmail(env, useCase2CustomerId);
							console.log('[USE CASE 2] userEmail:', userEmail);

							if (!userEmail) {
								console.warn('[USE CASE 2] No user email, exiting');
								return new Response('ok');
							}

							// Parse sites
							let siteNames = [];
							try {
								const rawSites = metadata.sites_json || metadata.sites;
								console.log('[USE CASE 2] rawSites:', rawSites);
								if (rawSites) {
									siteNames = JSON.parse(rawSites);
								}
							} catch (e) {
								console.error('[USE CASE 2] Error parsing sites_json:', e);
							}

							const productId = metadata.product_id;
							const billingPeriod = (metadata.billing_period || '').toLowerCase().trim() || null;

							console.log('[USE CASE 2] productId:', productId, 'billingPeriod:', billingPeriod);

							// Derive priceId from product + billingPeriod (shared helper)
							const priceId = getPriceIdFromProduct(productId, billingPeriod, env);
							console.log('[USE CASE 2] derived priceId:', priceId);

							if (!priceId || siteNames.length === 0) {
								console.warn('[USE CASE 2] Missing priceId or sites, skipping enqueue', {
									productId,
									billingPeriod,
									priceId,
									siteNamesLength: siteNames.length,
								});
								return new Response('ok');
							}

							// Save payment method
							let paymentMethodId = paymentIntent.payment_method;
							console.log('[USE CASE 2] paymentMethodId from PI:', paymentMethodId);

							if (!paymentMethodId && paymentIntent.latest_charge) {
								try {
									const chargeRes = await stripeFetch(env, `/charges/${paymentIntent.latest_charge}`);
									console.log('[USE CASE 2] chargeRes.status:', chargeRes.status);
									if (chargeRes.status === 200) {
										paymentMethodId = chargeRes.body.payment_method;
									}
								} catch (e) {
									console.warn('[USE CASE 2] Could not fetch charge for payment method:', e);
								}
							}

							if (!paymentMethodId) {
								console.warn('[USE CASE 2] No payment method, skipping enqueue');
								return new Response('ok');
							}

							await stripeFetch(
								env,
								`/payment_methods/${paymentMethodId}/attach`,
								'POST',
								{
									customer: useCase2CustomerId,
								},
								true
							);

							await stripeFetch(
								env,
								`/customers/${useCase2CustomerId}`,
								'POST',
								{
									'invoice_settings[default_payment_method]': paymentMethodId,
								},
								true
							);

							// Enqueue sites job
							const sitesForQueue = siteNames.map((name) => ({
								site: name,
								price: priceId,
								billing_period: billingPeriod,
							}));

							console.log('[USE CASE 2] sitesForQueue:', sitesForQueue);

							const queueId = await enqueueSiteQueueItem(env, {
								customerId: useCase2CustomerId,
								userEmail,
								subscriptionId: null,
								sites: sitesForQueue,
								billingPeriod,
								priceId,
								paymentIntentId: paymentIntent.id,
							});

							console.log('[USE CASE 2] ✅ Enqueued sites job', {
								queueId,
								sites: siteNames.length,
							});

							return new Response('ok');
						}

						// USE CASE 3: Quantity license purchase

						if (useCase3 && useCase3CustomerId) {
							// Check if subscriptions/licenses already exist for this payment intent
							// This indicates checkout.session.completed already processed the purchase
							if (env.DB) {
								try {
									// Method 1: Check if subscriptions exist with payment_intent_id in queue (most reliable)
									// Include 'pending' status because checkout.session.completed adds items with 'pending' status
									const queueCheck = await env.DB.prepare(
										`SELECT COUNT(*) as count FROM subscription_queue 
         WHERE payment_intent_id = ? AND status IN ('pending', 'processing', 'completed')`
									)
										.bind(paymentIntent.id)
										.first();

									if (queueCheck && queueCheck.count > 0) {
										console.log(
											`[USE CASE 3 - payment_intent.succeeded] ⚠️ Skipping duplicate processing - ${queueCheck.count} queue item(s) already exist (status: pending/processing/completed) for payment_intent_id=${paymentIntent.id}. checkout.session.completed webhook already handled this.`
										);
										return new Response('ok');
									}

									// Method 2: Check if licenses exist for this customer with purchase_type='quantity' created recently (within last 10 minutes)
									// This catches cases where checkout.session.completed already processed the purchase
									const recentTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes ago
									const existingLicenses = await env.DB.prepare(
										`SELECT COUNT(*) as count FROM licenses 
         WHERE customer_id = ? AND purchase_type = 'quantity' AND created_at >= ?`
									)
										.bind(useCase3CustomerId, recentTimestamp)
										.first();

									if (existingLicenses && existingLicenses.count > 0) {
										console.log(
											`[USE CASE 3 - payment_intent.succeeded] ⚠️ Skipping duplicate processing - ${existingLicenses.count} license(s) already created by checkout.session.completed webhook`
										);
										return new Response('ok');
									}
								} catch (checkErr) {
									console.warn(`[USE CASE 3 - payment_intent.succeeded] ⚠️ Could not check for existing licenses:`, checkErr);
									// Continue processing if check fails (fallback behavior - but log warning)
									console.warn(
										`[USE CASE 3 - payment_intent.succeeded] ⚠️ Proceeding with fallback processing (may create duplicates if checkout.session.completed already processed)`
									);
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

								console.log(
									`[USE CASE 3 - payment_intent.succeeded] ✅ Generated ${licenseKeys.length} license keys (fallback handler - checkout.session.completed should have handled this)`
								);

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

								await stripeFetch(env, `/payment_methods/${paymentMethodId}/attach`, 'POST', { customer: useCase3CustomerId }, true);

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
											trial_end: trialEnd.toString(),
											'metadata[license_key]': licenseKeys[i],
											'metadata[usecase]': '3',
											'metadata[purchase_type]': 'quantity',
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
										renewalDate: sub.current_period_end || null,
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
            status, purchase_type, created_at, updated_at,user_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
										)
											.bind(l.licenseKey, useCase3CustomerId, l.subscriptionId, l.itemId, 'active', 'quantity', ts, ts,userEmail)
											.run();

										await saveLicenseKeyToKV(env, l.licenseKey, useCase3CustomerId, l.subscriptionId, userEmail, 'complete', false, null);
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
										)
											.bind(useCase3CustomerId, subId, userEmail, perUnit, paymentIntent.currency || 'usd', 'succeeded', ts, ts)
											.run();
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
									const addItemRes = await stripeFetch(
										env,
										'/subscription_items',
										'POST',
										{
											subscription: existingSubscriptionId,
											price: priceId,
											quantity: 1,
											'metadata[site]': site,
											proration_behavior: 'none', // No proration - already paid
										},
										true
									);

									if (addItemRes.status === 200) {
										const newItem = addItemRes.body;

										const siteData = {
											item_id: newItem.id,
											price: newItem.price.id,
											quantity: newItem.quantity,
											status: 'active',
											created_at: Math.floor(Date.now() / 1000),
											subscription_id: existingSubscriptionId,
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
												created_at: Math.floor(Date.now() / 1000),
											};
										}
										user.subscriptions[existingSubscriptionId].sites[site] = siteData;
										user.subscriptions[existingSubscriptionId].sitesCount = Object.keys(
											user.subscriptions[existingSubscriptionId].sites
										).length;

										// Remove from pending sites
										if (user.pendingSites) {
											user.pendingSites = user.pendingSites.filter((p) => (p.site || p).toLowerCase().trim() !== site.toLowerCase().trim());
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
												canceledAt: subDetails.canceled_at || null,
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
												)
													.bind(
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
													)
													.run();
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
												)
													.bind(customerId, existingSubscriptionId, newItem.id, site, licenseKey, 'active', timestamp, timestamp)
													.run();
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
										await addOrUpdateCustomerInUser(
											env,
											user.email,
											customerId,
											existingSubscriptionId,
											sites.map((site, i) => ({
												item_id: user.sites[site]?.item_id,
												site: site,
												price: prices[i],
												quantity: 1,
												status: 'active',
												created_at: Math.floor(Date.now() / 1000),
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
// 					if (event.type === 'invoice.payment_succeeded') {
// 						console.log('[[[[[Handling invoice.payment_succeeded event]]]]]');
// 						const invoice = event.data.object;
// 						const subscriptionId = invoice.subscription;
// 						const customerId = invoice.customer;
                       
// 						// Check product metadata to verify it's for dashboard
// 						if (subscriptionId) {
// 							try {
// 								const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
// 								if (subRes.status === 200 && subRes.body?.items?.data?.length > 0) {
// 									const firstItem = subRes.body.items.data[0];
// 									if (firstItem.price && firstItem.price.product) {
// 										const productId = typeof firstItem.price.product === 'string' ? firstItem.price.product : firstItem.price.product.id;

// 										const productRes = await stripeFetch(env, `/products/${productId}`);
// 										if (productRes.status === 200 && productRes.body?.metadata?.usedfor) {
// 											const productUsedFor = productRes.body.metadata.usedfor;
// 											console.log(`[invoice.payment_succeeded] 🏷️ Product metadata usedfor: ${productUsedFor}`);

// 											// Only process if product is for dashboard
// 											if (productUsedFor !== 'dashboard') {
// 												console.log(`[invoice.payment_succeeded] ⏭️ Skipping - Product usedfor is "${productUsedFor}", not "dashboard"`);
// 												return new Response('ok'); // Skip processing
// 											}
// 										}
// 									}
// 								}
// 							} catch (productErr) {
// 								console.warn(`[invoice.payment_succeeded] ⚠️ Could not fetch product metadata:`, productErr);
// 								// Continue processing if product fetch fails (backward compatibility)
// 							}
// 						}

// 						// Log invoice payment success
// 						await logStripeEvent(env, event, subscriptionId, customerId, {
// 							action: 'invoice_payment_succeeded',
// 							invoice_id: invoice.id,
// 							amount_paid: invoice.amount_paid,
// 							currency: invoice.currency,
// 							period_start: invoice.period_start,
// 							period_end: invoice.period_end,
// 							note: 'Invoice payment succeeded - renewal or initial payment',
// 						});

// 						if (!subscriptionId || !customerId) {
// 							console.error('Missing subscription_id or customer_id in invoice');
// 							return new Response('ok'); // Return ok to prevent retries
// 						}

// 						// Fetch subscription details to get quantity
// 						const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
// 						if (subRes.status !== 200) {
// 							console.error('Failed to fetch subscription:', subRes.status, subRes.body);
// 							return new Response('ok');
// 						}

// 						const subscription = subRes.body;
//   const subscriptionMetadata = subscription.metadata || {};
// 						const isUseCase3 = subscriptionMetadata.purchase_type === 'quantity' || subscriptionMetadata.usecase === '3';
// 						const isusecase1= subscriptionMetadata.usecase === '1'||subscriptionMetadata.paymentby==='directlink';
// 						if(isusecase1){
// 							console.log('Skipping Use Case 1 subscription in invoice.payment_succeeded Saving Site_1 to DB');
// 							return new Response('ok'); // Return ok - Use Case 1 handled elsewhere
// 						}

// 						if (isUseCase3) {
// 							return new Response('ok'); // Return ok - licenses already exist for Use Case 3
// 						}
// 						// CRITICAL: Skip Use Case 3 (quantity purchases) - licenses already exist
// 						// Use Case 3 subscriptions have metadata.purchase_type = 'quantity' and metadata.usecase = '3'
						

// 						// CRITICAL: Check if subscription is cancelled before generating licenses
// 						// Skip license generation for cancelled subscriptions
// 						const isCancelled =
// 							subscription.status === 'canceled' || subscription.cancel_at_period_end === true || subscription.canceled_at !== null;

// 						// Also check database to see if subscription is marked as cancelled
// 						let dbSubscriptionCancelled = false;
// 						if (env.DB) {
// 							try {
// 								const dbSub = await env.DB.prepare(
// 									'SELECT status, cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
// 								)
// 									.bind(subscriptionId)
// 									.first();

// 								if (dbSub) {
// 									dbSubscriptionCancelled = dbSub.status === 'canceled' || dbSub.cancel_at_period_end === 1;
// 								}
// 							} catch (dbErr) {
// 								console.error('Error checking subscription status in database:', dbErr);
// 							}
// 						}

// 						if (isCancelled || dbSubscriptionCancelled) {
// 							return new Response('ok'); // Return ok - don't generate licenses for cancelled subscriptions
// 						}

// 						// Generate one license key per subscription item (site)
// 						// Each subscription item represents one site, regardless of quantity
// 						let siteCount = 1;
// 						if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
// 							// Count number of subscription items (sites), not quantities
// 							siteCount = subscription.items.data.length;
// 						}

// 						// Get user record from database to map sites to subscription items
// 						const userData = (await getUserByCustomerId(env, customerId)) || { sites: {} };

// 						// Check if licenses already exist for this subscription to avoid duplicates
// 						let existingLicenses = [];
// 						if (env.DB) {
// 							try {
// 								const existing = await env.DB.prepare('SELECT license_key, site_domain FROM licenses WHERE subscription_id = ?')
// 									.bind(subscriptionId)
// 									.all();
// 								if (existing.success) {
// 									existingLicenses = existing.results.map((r) => ({ key: r.license_key, site: r.site_domain }));
// 								}
// 							} catch (e) {
// 								console.error('Error checking existing licenses:', e);
// 							}
// 						}

// 						// Map subscription items to sites and generate licenses
// 						const licensesToCreate = [];
// 						subscription.items.data.forEach((item, index) => {
// 							// Get site from item metadata or user record
// 							let site = item.metadata?.site;
// 							if (!site) {
// 								const siteEntry = Object.entries(userData.sites || {}).find(([_, data]) => data.item_id === item.id);
// 								if (siteEntry) {
// 									site = siteEntry[0];
// 								} else {
// 									site = `site_${index + 1}`;
// 								}
// 							}

// 							// Check if license already exists for this site
// 							const existingForSite = existingLicenses.find((l) => l.site === site);
// 							if (!existingForSite) {
// 								licensesToCreate.push({ site, item_id: item.id });
// 							}
// 						});

// 						if (licensesToCreate.length === 0) {
// 							return new Response('ok');
// 						}

// 						// Generate license keys - one per site
// 						const licenseKeys = await generateLicenseKeys(licensesToCreate.length, env);

// 						// Save licenses to D1 database with site mapping
// 						if (env.DB) {
// 							try {
// 								const timestamp = Math.floor(Date.now() / 1000);

// 								// Prepare insert statements with site_domain
// 								const inserts = licenseKeys.map((key, idx) => {
// 									const site = licensesToCreate[idx].site;
// 									return env.DB.prepare(
// 										'INSERT INTO licenses (customer_id, subscription_id, license_key, site_domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
// 									).bind(customerId, subscriptionId, key, site, 'active', timestamp, timestamp);
// 								});

// 								// Execute all inserts in a transaction
// 								const batch = env.DB.batch(inserts);
// 								await batch;
// 							} catch (dbError) {
// 								console.error('Database error saving licenses:', dbError);
// 								// Log but don't fail - Stripe will retry if we return error
// 							}
// 						} else {
// 							console.warn('D1 database not configured. License keys generated but not saved:', licenseKeys);
// 						}

// 						// Licenses are stored in database, no need to update user data structure
// 						// (Licenses are now stored in the licenses table, not in user data)
// 					}

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
							note: 'Invoice payment failed - subscription may be at risk',
						});
					}

					// Log any other unhandled event types
					const handledEventTypes = [
						'checkout.session.completed',
						'payment_intent.succeeded',
						'customer.subscription.updated',
						'customer.subscription.deleted',
						'invoice.payment_succeeded',
						'invoice.payment_failed',
					];

					if (!handledEventTypes.includes(event.type)) {
						const unhandledSubId = event.data?.object?.subscription || event.data?.object?.id || null;
						const unhandledCustId = event.data?.object?.customer || null;
						await logStripeEvent(env, event, unhandledSubId, unhandledCustId, {
							action: 'unhandled_event',
							note: `Unhandled event type: ${event.type}`,
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
						headers: { 'Content-Type': 'application/json' },
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

					const result = await env.DB.prepare(query)
						.bind(...params)
						.all();

					if (!result.success) {
						return jsonResponse(500, { error: 'Failed to fetch logs', details: result.error }, true, request);
					}

					// Parse JSON fields
					const logs = (result.results || []).map((log) => ({
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
						created_at_iso: new Date(log.created_at * 1000).toISOString(),
					}));

					// Return as JSON file download
					const jsonContent = JSON.stringify(logs, null, 2);
					const filename = `stripe-logs-${date || 'all'}-${new Date().toISOString().split('T')[0]}.json`;

					return new Response(jsonContent, {
						headers: {
							'Content-Type': 'application/json',
							'Content-Disposition': `attachment; filename="${filename}"`,
							...corsHeaders,
						},
					});
				} catch (error) {
					console.error('[Export Logs] Error:', error);
					return jsonResponse(500, { error: 'Failed to export logs', message: error.message }, true, request);
				}
			}

			//DASHBOARD STARTS HERE
if (request.method === 'GET' && pathname === '/dashboard') {
  try {
    const url = new URL(request.url);
    // ---------------------------------------------------
    // 1. EMAIL (FROM FRONTEND)
    // ---------------------------------------------------
    const emailParam = url.searchParams.get('email');
    if (!emailParam) {
      return jsonResponse(
        400,
        { error: 'email_required', message: 'Email is required' },
        true,
        request
      );
    }
    const email = emailParam.toLowerCase().trim();
    if (!env.DB) {
      console.error('[DASHBOARD] :x: DB not configured');
      return jsonResponse(500, { error: 'db_not_configured' }, true, request);
    }
    // ---------------------------------------------------
    // 2. FETCH FROM SITES ONLY
    // ---------------------------------------------------
    const sitesRes = await env.DB.prepare(`
      SELECT
        id,
        user_email,
        customer_id,
        subscription_id,
        item_id,
        site_domain,
        price_id,
        amount_paid,
        currency,
        status,
        platform,
        license_key,
        current_period_start,
        current_period_end,
        renewal_date,
        cancel_at_period_end,
        canceled_at,
        created_at
      FROM sites
      WHERE user_email = ?
      ORDER BY created_at DESC
    `)
      .bind(email)
      .all();
    // ---------------------------------------------------
    // 3. BUILD RESPONSE OBJECTS
    // ---------------------------------------------------
    const sites = {};
    const subscriptions = {};
    for (const row of sitesRes.results || []) {
      // -----------------------
      // SITES OBJECT
      // -----------------------
      sites[row.site_domain] = {
        site_domain: row.site_domain,
        subscription_id: row.subscription_id,
        customer_id: row.customer_id,
        item_id: row.item_id,
        price: row.price_id,
        amount_paid: row.amount_paid,
        currency: row.currency,
        status: row.status,
        platform: row.platform,
        // :white_check_mark: LICENSE KEY — ONLY FROM SITES
        license_key: row.license_key,
        current_period_start: row.current_period_start,
        current_period_end: row.current_period_end,
        renewal_date: row.renewal_date,
        cancel_at_period_end: !!row.cancel_at_period_end,
        canceled_at: row.canceled_at,
        created_at: row.created_at,
      };
      // -----------------------
      // SUBSCRIPTIONS (LEGACY)
      // -----------------------
      if (!subscriptions[row.subscription_id]) {
        subscriptions[row.subscription_id] = {
          subscriptionId: row.subscription_id,
          customerId: row.customer_id,
          status: row.status,
          items: [],
          sitesCount: 0,
          purchase_type: 'site',
        };
      }
      subscriptions[row.subscription_id].items.push({
        item_id: row.item_id,
        site_domain: row.site_domain,
        status: row.status,
        license_key: row.license_key,
      });
      subscriptions[row.subscription_id].sitesCount++;
    }
    const subscriptionIds = Object.keys(subscriptions);
    const firstSub = subscriptionIds.length > 0 ? subscriptions[subscriptionIds[0]] : null;
    // ---------------------------------------------------
    // 4. FINAL RESPONSE (FRONTEND SAFE)
    // ---------------------------------------------------
    return jsonResponse(
      200,
      {
        sites,
        subscriptions,
        pendingSites: [],        // kept for compatibility
        paymentHistory: [],      // kept for compatibility
        subscription: firstSub
          ? {
              id: firstSub.subscriptionId,
              customerId: firstSub.customerId,
              email,
            }
          : null,
        subscriptionId: firstSub?.subscriptionId || null,
        customerId: firstSub?.customerId || null,
        allCustomerIds: firstSub?.customerId ? [firstSub.customerId] : [],
        email,
      },
      true,
      request
    );
  } catch (err) {
    console.error('[DASHBOARD] :x: Unexpected error:', err);
    return jsonResponse(
      500,
      { error: 'internal_error', message: err.message },
      true,
      request
    );
  }
}
// DASHBOARD ENDS HERE
			// GET /api/sites/status - Check sites queue processing status
			if (request.method === 'GET' && pathname === '/api/sites/status') {
				try {
					const url = new URL(request.url);
					const emailParam = url.searchParams.get('email');
					const paymentIntentIdParam = url.searchParams.get('payment_intent_id');

					const cookie = request.headers.get('cookie') || '';
					const match = cookie.match(/sb_session=([^;]+)/);

					let email = null;

					if (emailParam) {
						email = emailParam.toLowerCase().trim();
					} else if (match) {
						const token = match[1];
						const payload = await verifyToken(env, token);
						if (!payload) {
							return jsonResponse(401, { error: 'invalid_session', message: 'Session token is invalid or expired' }, true, request);
						}
						email = (payload.email || '').toLowerCase().trim();
					} else {
						return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found' }, true, request);
					}

					if (!env.DB) {
						return jsonResponse(
							200,
							{ status: 'unknown', progress: { total: 0, completed: 0, pending: 0, processing: 0, failed: 0 } },
							true,
							request
						);
					}

					// Find most recent payment_intent_id for this user if not provided
					let paymentIntentId = paymentIntentIdParam;
					if (!paymentIntentId) {
						// Get recent payment intent from recent payments (last 15 minutes)
						const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - 15 * 60;
						const recentPayment = await env.DB.prepare(
							`SELECT payment_intent_id FROM sitesqueue 
         WHERE useremail = ? AND createdat >= ? 
         ORDER BY createdat DESC LIMIT 1`
						)
							.bind(email, fifteenMinutesAgo)
							.first();

						if (recentPayment && recentPayment.payment_intent_id) {
							paymentIntentId = recentPayment.payment_intent_id;
						}
					}

					if (!paymentIntentId) {
						// Fallback: check recent queue items by time
						const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - 15 * 60;
						const recentQueue = await env.DB.prepare(
							`SELECT payment_intent_id, status FROM sitesqueue 
         WHERE useremail = ? AND createdat >= ?
         ORDER BY createdat DESC`
						)
							.bind(email, fifteenMinutesAgo)
							.all();

						if (recentQueue && recentQueue.results && recentQueue.results.length > 0) {
							const queueItem = recentQueue.results[0];
							paymentIntentId = queueItem.payment_intent_id;
						}
					}

					if (!paymentIntentId) {
						return jsonResponse(
							200,
							{
								status: 'not_found',
								progress: { total: 0, completed: 0, pending: 0, processing: 0, failed: 0 },
							},
							true,
							request
						);
					}

					// Get queue items for this payment intent
					const queueItems = await env.DB.prepare(
						`SELECT status FROM sitesqueue 
       WHERE payment_intent_id = ? AND useremail = ?`
					)
						.bind(paymentIntentId, email)
						.all();

					if (!queueItems || !queueItems.results || queueItems.results.length === 0) {
						return jsonResponse(
							200,
							{
								status: 'not_found',
								progress: { total: 0, completed: 0, pending: 0, processing: 0, failed: 0 },
							},
							true,
							request
						);
					}

					const statusCounts = {
						pending: 0,
						processing: 0,
						completed: 0,
						failed: 0,
					};

					queueItems.results.forEach((item) => {
						const status = (item.status || 'pending').toLowerCase();
						if (statusCounts.hasOwnProperty(status)) {
							statusCounts[status]++;
						}
					});

					const total = queueItems.results.length;
					const completed = statusCounts.completed;
					const pending = statusCounts.pending;
					const processing = statusCounts.processing;
					const failed = statusCounts.failed;

					let overallStatus = 'pending';
					if (failed > 0 && completed === 0) {
						overallStatus = 'failed';
					} else if (completed === total) {
						overallStatus = 'completed';
					} else if (processing > 0 || completed > 0) {
						overallStatus = 'processing';
					}

					return jsonResponse(
						200,
						{
							status: overallStatus,
							progress: {
								total,
								completed,
								pending,
								processing,
								failed,
							},
							payment_intent_id: paymentIntentId,
						},
						true,
						request
					);
				} catch (error) {
					console.error('[SITES STATUS] Error:', error);
					return jsonResponse(
						500,
						{
							error: 'Failed to fetch sites status',
							message: error.message || 'An unexpected error occurred',
						},
						true,
						request
					);
				}
			}

			// GET /api/licenses/status
// GET /api/licenses/status - Check subscription queue status by customer_id
if (request.method === 'GET' && pathname === '/api/licenses/status') {
  try {
    const url = new URL(request.url);
    const emailParam = url.searchParams.get('email');
    const cookie = request.headers.get('cookie') || '';
    const match = cookie.match(/sb_session=([^;]+)/);

    let email = null;

    // Resolve email from query param or session cookie
    if (emailParam) {
      email = emailParam.toLowerCase().trim();
    } else if (match) {
      const token = match[1];
      const payload = await verifyToken(env, token);
      if (!payload) {
        return jsonResponse(
          401,
          { error: 'invalid_session', message: 'Session token is invalid or expired' },
          true,
          request
        );
      }
      email = (payload.email || '').toLowerCase().trim();
    } else {
      return jsonResponse(
        401,
        { error: 'unauthenticated', message: 'No session cookie found' },
        true,
        request
      );
    }

    if (!env.DB) {
      console.error('[LICENSE STATUS] ❌ Database not configured (env.DB missing)');
      return jsonResponse(
        500,
        { error: 'Database not configured' },
        true,
        request
      );
    }

    // 1️⃣ Find all customer_ids for this user
    let allCustomerIds = [];
    try {
      const [customersRes, paymentsCustomersRes] = await Promise.all([
        env.DB.prepare('SELECT DISTINCT customer_id FROM customers WHERE user_email = ?')
          .bind(email)
          .all(),
        env.DB.prepare(
          'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
        )
          .bind(email)
          .all(),
      ]);

      if (customersRes?.results) {
        allCustomerIds = customersRes.results.map((r) => r.customer_id).filter(Boolean);
      }

      if (paymentsCustomersRes?.results) {
        const paymentCustomerIds = paymentsCustomersRes.results
          .map((r) => r.customer_id)
          .filter((id) => id && id.startsWith('cus_'));
        allCustomerIds = [...new Set([...allCustomerIds, ...paymentCustomerIds])];
      }
    } catch (err) {
      console.error('[LICENSE STATUS] ❌ Error finding customers by email:', err);
    }

    if (allCustomerIds.length === 0) {
      return jsonResponse(
        200,
        { status: 'completed', progress: { total: 0, completed: 0, pending: 0, processing: 0, failed: 0 } },
        true,
        request
      );
    }

    // 2️⃣ Check subscription_queue for statuses
    let statusCounts = { pending: 0, processing: 0, completed: 0, failed: 0 };
    let totalQueueItems = 0;

    try {
      const queueRes = await batchQuery(env, allCustomerIds, async (batch) => {
        const placeholders = batch.map(() => '?').join(',');
        return await env.DB.prepare(
          `SELECT status
           FROM subscription_queue
           WHERE customer_id IN (${placeholders})`
        )
          .bind(...batch)
          .all();
      });

      if (queueRes?.results?.length > 0) {
        totalQueueItems = queueRes.results.length;
        for (const row of queueRes.results) {
          const s = (row.status || 'pending').toLowerCase();
          if (statusCounts.hasOwnProperty(s)) statusCounts[s]++;
        }
      }
    } catch (err) {
      console.error('[LICENSE STATUS] ❌ Error querying subscription queue:', err);
      return jsonResponse(
        500,
        { error: 'Failed to query subscription queue', message: err.message },
        true,
        request
      );
    }

    // 3️⃣ Determine overall status
    let overallStatus = 'pending';
    if (statusCounts.failed > 0 && statusCounts.pending === 0 && statusCounts.processing === 0) {
      overallStatus = 'failed';
    } else if (statusCounts.completed === totalQueueItems && totalQueueItems > 0) {
      overallStatus = 'completed';
    } else if (statusCounts.processing > 0 || statusCounts.completed > 0) {
      overallStatus = 'processing';
    }

    // 4️⃣ Return response
    return jsonResponse(
      200,
      {
        status: overallStatus,
        progress: {
          total: totalQueueItems,
          completed: statusCounts.completed,
          pending: statusCounts.pending,
          processing: statusCounts.processing,
          failed: statusCounts.failed,
        },
      },
      true,
      request
    );
  } catch (err) {
    console.error('[LICENSE STATUS] ❌ unexpected error:', err);
    return jsonResponse(
      500,
      {
        error: 'internal_error',
        message: err.message || 'An unexpected error occurred',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      },
      true,
      request
    );
  }
}

			//USECASE 2 DASHBOARD - END
			if (request.method === 'POST' && url.pathname === '/create-site-checkout') {
				return handleCreateSiteCheckout(request, env);
			}

			// Add sites batch endpoint - creates checkout session for batch site purchases
			if (request.method === 'POST' && pathname === '/add-sites-batch') {
				try {
					const body = await request.json();
					const { email: emailParam, sites: sitesParam, billing_period: billingPeriodParam } = body;

					// Validate email
					let email = emailParam?.toLowerCase().trim();
					if (!email || !email.includes('@')) {
						return jsonResponse(
							400,
							{
								error: 'invalid_email',
								message: 'Valid email is required',
							},
							true,
							request
						);
					}

					// Validate sites array
					if (!Array.isArray(sitesParam) || sitesParam.length === 0) {
						return jsonResponse(
							400,
							{
								error: 'invalid_sites',
								message: 'Sites array is required and must not be empty',
							},
							true,
							request
						);
					}

					// Validate max 5 sites
					if (sitesParam.length > 5) {
						return jsonResponse(
							400,
							{
								error: 'too_many_sites',
								message: 'Maximum 5 sites allowed per purchase',
							},
							true,
							request
						);
					}

					// Validate and normalize sites
					const validatedSites = [];
					const sitePattern = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

					for (const site of sitesParam) {
						const siteName = typeof site === 'string' ? site.trim() : (site.site || site.site_domain || '').trim();

						if (!siteName) {
							return jsonResponse(
								400,
								{
									error: 'invalid_site',
									message: 'Site name cannot be empty',
								},
								true,
								request
							);
						}

						// Remove www. prefix for validation if present
						const normalizedSite = siteName.replace(/^www\./i, '');

						if (!sitePattern.test(normalizedSite)) {
							return jsonResponse(
								400,
								{
									error: 'invalid_site_format',
									message: `Invalid site format: "${siteName}". Please use format like "example.com" or "www.example.com"`,
								},
								true,
								request
							);
						}

						validatedSites.push(siteName);
					}

					// Check for duplicates
					const uniqueSites = [...new Set(validatedSites.map((s) => s.toLowerCase()))];
					if (uniqueSites.length !== validatedSites.length) {
						return jsonResponse(
							400,
							{
								error: 'duplicate_sites',
								message: 'Duplicate sites are not allowed',
							},
							true,
							request
						);
					}

					// Validate billing period
					if (!billingPeriodParam) {
						return jsonResponse(
							400,
							{
								error: 'billing_period_required',
								message: 'billing_period is required (monthly or yearly)',
							},
							true,
							request
						);
					}

					const normalizedPeriod = billingPeriodParam.toLowerCase().trim();
					if (normalizedPeriod !== 'monthly' && normalizedPeriod !== 'yearly') {
						return jsonResponse(
							400,
							{
								error: 'invalid_billing_period',
								message: 'Billing period must be "monthly" or "yearly"',
							},
							true,
							request
						);
					}

					// Get customer ID
					const customerRes = await env.DB.prepare('SELECT customer_id FROM customers WHERE user_email = ? LIMIT 1').bind(email).first();

					if (!customerRes?.customer_id) {
						return jsonResponse(
							400,
							{
								error: 'no_customer',
								message: 'Customer account required. Please complete a payment first.',
							},
							true,
							request
						);
					}

					const customerId = customerRes.customer_id;

					// Get price configuration
					let productId, unitAmount;
					const currency = 'usd'; // Default to USD
					if (normalizedPeriod === 'monthly') {
						productId = env.MONTHLY_PRODUCT_ID || env.MONTHLY_LICENSE_PRODUCT_ID || 'prod_TiG3c1jjtQHRLK';
						unitAmount = parseInt(env.MONTHLY_UNIT_AMOUNT || env.MONTHLY_LICENSE_UNIT_AMOUNT || '800');
					} else {
						productId = env.YEARLY_PRODUCT_ID || env.YEARLY_LICENSE_PRODUCT_ID || 'prod_TiG4YkK61hiKKR';
						unitAmount = parseInt(env.YEARLY_UNIT_AMOUNT || env.YEARLY_LICENSE_UNIT_AMOUNT || '7200');
					}

					// Calculate total amount (for metadata purposes)
					const totalAmount = unitAmount * validatedSites.length;
					const billingPeriodText = normalizedPeriod === 'yearly' ? 'yearly' : 'monthly';

					// Create checkout session with inline price_data (same as license purchase)
					// Use mode: 'payment' with price_data for one-time payment
					const checkoutForm = {
						mode: 'payment', // One-time payment (same as license purchase)
						customer: customerId,
						// Payment method types: Card only
						'payment_method_types[0]': 'card',
						// Enable promotion codes
						allow_promotion_codes: 'true',
						// Use inline price_data with unit amount and quantity to show proper pricing breakdown
						'line_items[0][price_data][currency]': 'usd', // Default to USD
						'line_items[0][price_data][unit_amount]': unitAmount, // Unit price per site
						'line_items[0][price_data][product_data][name]': 'ConsentBit',
						'line_items[0][price_data][product_data][description]': `Billed ${billingPeriodText}`,
						'line_items[0][quantity]': validatedSites.length, // Show actual quantity (number of sites)
						'payment_intent_data[metadata][usecase]': '2',
						'payment_intent_data[metadata][customer_id]': customerId,
						'payment_intent_data[metadata][sites_json]': JSON.stringify(validatedSites),
						'payment_intent_data[metadata][billing_period]': normalizedPeriod,
						'payment_intent_data[metadata][product_id]': productId,
						'payment_intent_data[metadata][currency]': currency,
						'payment_intent_data[setup_future_usage]': 'off_session',
						success_url: `${
							env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard'
						}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
						cancel_url: env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard',
					};

					const sessionRes = await stripeFetch(env, '/checkout/sessions', 'POST', checkoutForm, true);

					if (sessionRes.status >= 400) {
						console.error('[add-sites-batch] Checkout session creation failed:', sessionRes.body);
						return jsonResponse(
							500,
							{
								error: 'checkout_failed',
								message: 'Failed to create checkout session',
								details: sessionRes.body,
							},
							true,
							request
						);
					}

					const checkoutSession = sessionRes.body;

					return jsonResponse(
						200,
						{
							checkout_url: checkoutSession.url,
							session_id: checkoutSession.id,
							payment_intent_id: checkoutSession.payment_intent,
							sites: validatedSites,
							billing_period: normalizedPeriod,
							amount: totalAmount,
							currency: currency,
						},
						true,
						request
					);
				} catch (error) {
					console.error('[add-sites-batch] Error:', error);
					return jsonResponse(
						500,
						{
							error: 'server_error',
							message: error.message || 'An unexpected error occurred',
						},
						true,
						request
					);
				}
			}

			// if (request.method === 'POST' && url.pathname === '/create-checkout-from-pending') {
			//   return handleCreateCheckoutFromPending(request, env);
			// }
			// Get magic link for a customer (for testing/display after payment)
			// Supports: ?email=... OR ?session_id=... OR ?customer_id=...

			// Get licenses for a customer
			// Get available price options (monthly/yearly) from database

			if (request.method === 'GET' && pathname === '/get-price-options') {
				try {
					// Try to get from database first
					if (env.DB) {
						const monthlyResult = await env.DB.prepare(
							'SELECT price_id, discount_allowance, discount_type, coupon_code FROM price_config WHERE price_type = ? AND is_active = 1'
						)
							.bind('monthly')
							.first();

						const yearlyResult = await env.DB.prepare(
							'SELECT price_id, discount_allowance, discount_type, coupon_code FROM price_config WHERE price_type = ? AND is_active = 1'
						)
							.bind('yearly')
							.first();

						if (monthlyResult || yearlyResult) {
							return jsonResponse(
								200,
								{
									monthly: monthlyResult
										? {
												price_id: monthlyResult.price_id,
												discount_allowance: monthlyResult.discount_allowance || 0,
												discount_type: monthlyResult.discount_type || 'percentage',
												coupon_code: monthlyResult.coupon_code || null,
										  }
										: null,
									yearly: yearlyResult
										? {
												price_id: yearlyResult.price_id,
												discount_allowance: yearlyResult.discount_allowance || 0,
												discount_type: yearlyResult.discount_type || 'percentage',
												coupon_code: yearlyResult.coupon_code || null,
										  }
										: null,
									source: 'database',
								},
								true,
								request
							);
						}
					}

					// Fallback to environment variables if database not available
					return jsonResponse(
						200,
						{
							monthly: env.MONTHLY_PRICE_ID
								? {
										price_id: env.MONTHLY_PRICE_ID,
										discount_allowance: 0,
										discount_type: 'percentage',
										coupon_code: null,
								  }
								: null,
							yearly: env.YEARLY_PRICE_ID
								? {
										price_id: env.YEARLY_PRICE_ID,
										discount_allowance: 0,
										discount_type: 'percentage',
										coupon_code: null,
								  }
								: null,
							default: env.DEFAULT_PRICE_ID || null,
							source: 'environment',
						},
						true,
						request
					);
				} catch (error) {
					console.error('[get-price-options] Error:', error);
					// Fallback to environment variables on error
					return jsonResponse(
						200,
						{
							monthly: env.MONTHLY_PRICE_ID
								? {
										price_id: env.MONTHLY_PRICE_ID,
										discount_allowance: 0,
										discount_type: 'percentage',
										coupon_code: null,
								  }
								: null,
							yearly: env.YEARLY_PRICE_ID
								? {
										price_id: env.YEARLY_PRICE_ID,
										discount_allowance: 0,
										discount_type: 'percentage',
										coupon_code: null,
								  }
								: null,
							default: env.DEFAULT_PRICE_ID || null,
							source: 'environment_fallback',
							error: error.message,
						},
						true,
						request
					);
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
						return jsonResponse(
							401,
							{
								error: 'invalid session',
								message: 'Session token is invalid or expired',
								licenses: [],
								pagination: { total: 0, hasMore: false },
							},
							true,
							request
						);
					}
					email = payload.email;
					customerId = payload.customerId;
				} else {
					return jsonResponse(
						401,
						{ error: 'unauthenticated', message: 'No session cookie found', licenses: [], pagination: { total: 0, hasMore: false } },
						true,
						request
					);
				}

				// CRITICAL: Find ALL customers with the same email to get all licenses
				let allCustomerIds = customerId ? [customerId] : [];
				if (email && env.DB) {
					try {
						// First, get customer IDs from the customers table (primary source)
						const customersRes = await env.DB.prepare('SELECT DISTINCT customer_id FROM customers WHERE user_email = ?')
							.bind(email.toLowerCase().trim())
							.all();

						if (customersRes && customersRes.results) {
							const foundCustomerIds = customersRes.results.map((row) => row.customer_id).filter((id) => id && id.startsWith('cus_'));
							allCustomerIds = [...new Set([...allCustomerIds, ...foundCustomerIds])];
						}

						// Also check payments table for any additional customer IDs
						const paymentsRes = await env.DB.prepare(
							'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
						)
							.bind(email.toLowerCase().trim())
							.all();

						if (paymentsRes && paymentsRes.results) {
							const paymentCustomerIds = paymentsRes.results.map((row) => row.customer_id).filter((id) => id && id.startsWith('cus_'));
							allCustomerIds = [...new Set([...allCustomerIds, ...paymentCustomerIds])];
						}

						// Filter out null values and ensure all are valid customer IDs
						allCustomerIds = allCustomerIds.filter((id) => id && id.startsWith('cus_'));
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
							// Batch query to avoid SQLite's 999 variable limit
							let result = { results: [] };
							try {
								// Use smaller batch size (50) for queries with many columns (11 columns)
								const batchResult = await batchQuery(
									env,
									allCustomerIds,
									async (batch) => {
										const placeholders = batch.map(() => '?').join(',');
										return env.DB.prepare(
											`SELECT license_key, site_domain, used_site_domain, status, purchase_type, created_at, customer_id, subscription_id, item_id, billing_period, renewal_date, platform FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
										)
											.bind(...batch)
											.all();
									},
									50
								);
								result = batchResult;
							} catch (columnErr) {
								// Fallback if new columns don't exist yet
								if (
									columnErr.message &&
									(columnErr.message.includes('no such column: used_site_domain') ||
										columnErr.message.includes('no such column: purchase_type'))
								) {
									try {
										const batchResult = await batchQuery(env, allCustomerIds, async (batch) => {
											const placeholders = batch.map(() => '?').join(',');
											return env.DB.prepare(
												`SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type, billing_period, renewal_date, platform FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
											)
												.bind(...batch)
												.all();
										});
										result = batchResult;
									} catch (fallbackErr) {
										if (fallbackErr.message && fallbackErr.message.includes('no such column: site_domain')) {
											const batchResult = await batchQuery(env, allCustomerIds, async (batch) => {
												const placeholders = batch.map(() => '?').join(',');
												return env.DB.prepare(
													`SELECT license_key, status, created_at, customer_id, platform FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
												)
													.bind(...batch)
													.all();
											});
											result = batchResult;
										} else {
											throw fallbackErr;
										}
									}
								} else {
									throw columnErr;
								}
							}

							// batchQuery returns { results: [] }, not { success, results }
							// Check if results exist (will be empty array if no licenses found)
							if (result && result.results) {
								// Get subscription statuses for all subscription IDs (batched to avoid SQLite limit)
								const subscriptionIds = [...new Set(result.results.map((r) => r.subscription_id).filter(Boolean))];
								const subscriptionStatusMap = {};

								if (subscriptionIds.length > 0 && env.DB) {
									try {
										const subStatusRes = await batchQuery(env, subscriptionIds, async (batch) => {
											const placeholders = batch.map(() => '?').join(',');
											return env.DB.prepare(
												`SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end 
                         FROM subscriptions 
                         WHERE subscription_id IN (${placeholders})`
											)
												.bind(...batch)
												.all();
										});

										if (subStatusRes && subStatusRes.results) {
											subStatusRes.results.forEach((sub) => {
												subscriptionStatusMap[sub.subscription_id] = {
													status: sub.status,
													cancel_at_period_end: sub.cancel_at_period_end === 1,
													cancel_at: sub.cancel_at,
													current_period_end: sub.current_period_end,
												};
											});
										}
									} catch (subErr) {
										console.error('[Licenses] Error fetching subscription statuses:', subErr);
									}
								}

								licenses = result.results.map((row) => {
									const subscriptionInfo = row.subscription_id ? subscriptionStatusMap[row.subscription_id] : null;
									const isSubscriptionCancelled =
										subscriptionInfo &&
										(subscriptionInfo.status === 'canceled' ||
											subscriptionInfo.cancel_at_period_end ||
											subscriptionInfo.cancel_at !== null);

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
										subscription_current_period_end: subscriptionInfo?.current_period_end || null,
                    platform: row.platform || 'unknown',
									};
								});
							} else {
								// No results found (empty array is valid, so this shouldn't happen)
								// But log if result is null/undefined
								if (!result) {
									console.warn(`[Licenses] D1 query returned null/undefined for customer ${customerId}`);
									d1Error = 'D1 query returned no result';
								}
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
								const customerIds = user.customers.map((c) => c.customerId);
								if (customerIds.length > 0) {
									// Fetch licenses from database for all customer IDs (batched to avoid SQLite limit)
									// Handle case where used_site_domain column might not exist
									let licenseRes = { results: [] };
									try {
										// Query ALL licenses (not just active) to show complete history
										licenseRes = await batchQuery(env, customerIds, async (batch) => {
											const placeholders = batch.map(() => '?').join(',');
											return env.DB.prepare(
												`SELECT license_key, site_domain, used_site_domain, purchase_type, status, created_at, customer_id, subscription_id, item_id, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
											)
												.bind(...batch)
												.all();
										});
									} catch (colError) {
										// Fallback if used_site_domain doesn't exist
										if (colError.message && colError.message.includes('no such column: used_site_domain')) {
											try {
												licenseRes = await batchQuery(env, customerIds, async (batch) => {
													const placeholders = batch.map(() => '?').join(',');
													return env.DB.prepare(
														`SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type, billing_period, renewal_date FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
													)
														.bind(...batch)
														.all();
												});
											} catch (colError2) {
												// Fallback if billing_period or renewal_date don't exist
												if (
													colError2.message &&
													(colError2.message.includes('no such column: billing_period') ||
														colError2.message.includes('no such column: renewal_date'))
												) {
													licenseRes = await batchQuery(env, customerIds, async (batch) => {
														const placeholders = batch.map(() => '?').join(',');
														return env.DB.prepare(
															`SELECT license_key, site_domain, status, created_at, customer_id, subscription_id, item_id, purchase_type FROM licenses WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC`
														)
															.bind(...batch)
															.all();
													});
												} else {
													throw colError2;
												}
											}
										} else {
											throw colError;
										}
									}

									// batchQuery returns { results: [] }, check if results exist
									if (licenseRes && licenseRes.results) {
										// Get subscription statuses for fallback licenses too (batched to avoid SQLite limit)
										const fallbackSubscriptionIds = [...new Set(licenseRes.results.map((r) => r.subscription_id).filter(Boolean))];
										const fallbackSubscriptionStatusMap = {};

										if (fallbackSubscriptionIds.length > 0 && env.DB) {
											try {
												const fallbackSubStatusRes = await batchQuery(env, fallbackSubscriptionIds, async (batch) => {
													const placeholders = batch.map(() => '?').join(',');
													return env.DB.prepare(
														`SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end 
                             FROM subscriptions 
                             WHERE subscription_id IN (${placeholders})`
													)
														.bind(...batch)
														.all();
												});

												if (fallbackSubStatusRes && fallbackSubStatusRes.results) {
													fallbackSubStatusRes.results.forEach((sub) => {
														fallbackSubscriptionStatusMap[sub.subscription_id] = {
															status: sub.status,
															cancel_at_period_end: sub.cancel_at_period_end === 1,
															cancel_at: sub.cancel_at,
															current_period_end: sub.current_period_end,
														};
													});
												}
											} catch (fallbackSubErr) {
												console.error('[Licenses] Error fetching subscription statuses for fallback licenses:', fallbackSubErr);
											}
										}

										const userLicenses = licenseRes.results.map((l) => {
											const subscriptionInfo = l.subscription_id ? fallbackSubscriptionStatusMap[l.subscription_id] : null;
											const isSubscriptionCancelled =
												subscriptionInfo &&
												(subscriptionInfo.status === 'canceled' ||
													subscriptionInfo.cancel_at_period_end ||
													subscriptionInfo.cancel_at !== null);

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
												subscription_current_period_end: subscriptionInfo?.current_period_end || null,
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
								d1Error: d1Error,
							},
							licenses: [], // Return empty array so frontend doesn't break
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
							)
								.bind(email.toLowerCase().trim())
								.all();

							if (subsRes && subsRes.results) {
								activeSubscriptions = subsRes.results.map((sub) => ({
									subscription_id: sub.subscription_id,
									status: sub.status,
									cancel_at_period_end: sub.cancel_at_period_end === 1,
									cancel_at: sub.cancel_at,
									current_period_start: sub.current_period_start,
									current_period_end: sub.current_period_end,
									billing_period: sub.billing_period || null,
									created_at: sub.created_at,
								}));
							}
						} catch (subsErr) {
							console.error('[Licenses] Error fetching active subscriptions:', subsErr);
						}
					}

					// Debug: Log what we're returning
					if (licenses.length > 0) {
						// Count by purchase_type
						const quantityLicenses = licenses.filter((l) => l.purchase_type === 'quantity').length;
						const siteLicenses = licenses.filter((l) => l.purchase_type === 'site').length;
					}

					// Return licenses and active subscriptions
					return jsonResponse(200, { success: true, licenses, activeSubscriptions }, true, request);
				} catch (error) {
					console.error(`[Licenses] ❌ Unexpected error fetching licenses:`, error);
					console.error(`[Licenses] ❌ Error details:`, {
						message: error.message,
						stack: error.stack,
						email: email || 'unknown',
						customerId: customerId || 'unknown',
						allCustomerIdsLength: allCustomerIds?.length || 0,
					});
					return jsonResponse(
						500,
						{
							error: 'Failed to fetch licenses',
							message: error.message || 'An unexpected error occurred',
							licenses: [], // Return empty array so frontend doesn't break
							details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
						},
						true,
						request
					);
				}
			}

  if (request.method === 'GET' && pathname === '/licenses') {
  try {
    // Get email from query parameter
    const email = url.searchParams.get('email');
    
    if (!email) {
      return jsonResponse(400, { 
        error: 'missing_email',
        message: 'Email parameter is required' 
      }, true, request);
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate email format
    if (!normalizedEmail.includes('@')) {
      return jsonResponse(400, { 
        error: 'invalid_email',
        message: 'Invalid email format' 
      }, true, request);
    }

    console.log(`[GET /licenses] Fetching licenses for: ${normalizedEmail}`);

    // Fetch licenses from database
    if (!env.DB) {
      return jsonResponse(500, { 
        error: 'database_not_configured',
        message: 'Database is not configured' 
      }, true, request);
    }

    // Query licenses table where user_email matches
    const result = await env.DB.prepare(`
      SELECT 
        license_key,
        user_email,
        customer_id,
        subscription_id,
        item_id,
        site_domain,
        used_site_domain,
        platform,
        status,
        purchase_type,
        billing_period,
        renewal_date,
        created_at,
        updated_at
      FROM licenses
      WHERE LOWER(TRIM(user_email)) = ?
      ORDER BY created_at DESC
    `).bind(normalizedEmail).all();

    if (!result || !result.results) {
      return jsonResponse(200, { 
        success: true,
        licenses: [],
        total: 0
      }, true, request);
    }

    // Format licenses
    const licenses = result.results.map(row => ({
      licenseKey: row.license_key,
      userEmail: row.user_email,
      customerId: row.customer_id,
      subscriptionId: row.subscription_id,
      itemId: row.item_id,
      siteDomain: row.site_domain,
      usedSiteDomain: row.used_site_domain,
      platform: row.platform,
      status: row.status,
      purchaseType: row.purchase_type,
      billingPeriod: row.billing_period,
      renewalDate: row.renewal_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    console.log(`[GET /licenses] Found ${licenses.length} licenses for ${normalizedEmail}`);

    return jsonResponse(200, { 
      success: true,
      licenses,
      total: licenses.length,
      email: normalizedEmail
    }, true, request);

  } catch (error) {
    console.error('[GET /licenses] Error:', error);
    return jsonResponse(500, { 
      error: 'internal_error',
      message: error.message 
    }, true, request);
  }
}


			// Get invoices endpoint - returns paid invoices for a use
				if (request.method === 'GET' && pathname === '/api/invoices') {
				console.log('[Invoices] Endpoint hit:', { pathname, method: request.method, url: request.url });
				try {
					// Try to get email from query parameter (for Memberstack users)
					const emailParam = url.searchParams.get('email');
					console.log('[Invoices] Email param:', emailParam);

					const cookie = request.headers.get('cookie') || '';
					const match = cookie.match(/sb_session=([^;]+)/);
					let payload = null;
					let email = null;

					if (emailParam) {
						email = emailParam.toLowerCase().trim();
					} else if (match) {
						const token = match[1];
						payload = await verifyToken(env, token);
						if (!payload) {
							return jsonResponse(
								401,
								{ error: 'invalid session', message: 'Session token is invalid or expired', invoices: [] },
								true,
								request
							);
						}
						email = payload.email;
					} else {
						return jsonResponse(401, { error: 'unauthenticated', message: 'No session cookie found', invoices: [] }, true, request);
					}

					if (!email || !email.includes('@')) {
						return jsonResponse(400, { error: 'invalid_email', message: 'Valid email is required', invoices: [] }, true, request);
					}

					// Get pagination parameters
					const limit = parseInt(url.searchParams.get('limit')) || 10;
					const offset = parseInt(url.searchParams.get('offset')) || 0;

					// Optimize: Fetch enough invoices to find paid ones
					// For first page, fetch more to ensure we find paid invoices (many might be $0 trial invoices)
					// For subsequent pages, fetch based on offset + limit
					// Increased to 300 to handle customers with many $0 trial invoices before paid ones
					const maxInvoicesPerCustomer = offset === 0 ? 300 : Math.max((offset + limit) * 3, 300);
					const maxCustomersToProcess = 10; // Limit number of customers to prevent timeout

					console.log(`[Invoices] maxInvoicesPerCustomer set to: ${maxInvoicesPerCustomer} (offset: ${offset})`);

					// Get all customer IDs for this email from multiple sources
					let allCustomerIds = [];
					if (env.DB) {
						try {
							console.log(`[Invoices] Searching for customer IDs for email: ${email}`);

							// 1. Get customer IDs from customers table (primary source)
							const customersRes = await env.DB.prepare('SELECT DISTINCT customer_id FROM customers WHERE user_email = ?')
								.bind(email)
								.all();

							if (customersRes && customersRes.results) {
								const foundCustomerIds = customersRes.results.map((row) => row.customer_id).filter((id) => id && id.startsWith('cus_'));
								console.log(`[Invoices] Found ${foundCustomerIds.length} customer ID(s) from customers table:`, foundCustomerIds);
								allCustomerIds = [...new Set([...allCustomerIds, ...foundCustomerIds])];
							} else {
								console.log(`[Invoices] No customer IDs found in customers table for email: ${email}`);
							}

							// 2. Also check payments table
							const paymentsRes = await env.DB.prepare(
								'SELECT DISTINCT customer_id FROM payments WHERE email = ? AND customer_id IS NOT NULL'
							)
								.bind(email)
								.all();

							if (paymentsRes && paymentsRes.results) {
								const paymentCustomerIds = paymentsRes.results.map((row) => row.customer_id).filter((id) => id && id.startsWith('cus_'));
								console.log(`[Invoices] Found ${paymentCustomerIds.length} customer ID(s) from payments table:`, paymentCustomerIds);
								allCustomerIds = [...new Set([...allCustomerIds, ...paymentCustomerIds])];
							} else {
								console.log(`[Invoices] No customer IDs found in payments table for email: ${email}`);
							}

							// 3. Also check subscriptions table (subscriptions also have customer_id)
							const subscriptionsRes = await env.DB.prepare(
								'SELECT DISTINCT customer_id FROM subscriptions WHERE user_email = ? AND customer_id IS NOT NULL'
							)
								.bind(email)
								.all();

							if (subscriptionsRes && subscriptionsRes.results) {
								const subscriptionCustomerIds = subscriptionsRes.results
									.map((row) => row.customer_id)
									.filter((id) => id && id.startsWith('cus_'));
								console.log(
									`[Invoices] Found ${subscriptionCustomerIds.length} customer ID(s) from subscriptions table:`,
									subscriptionCustomerIds
								);
								allCustomerIds = [...new Set([...allCustomerIds, ...subscriptionCustomerIds])];
							} else {
								console.log(`[Invoices] No customer IDs found in subscriptions table for email: ${email}`);
							}

							// 4. Also check licenses table (licenses also have customer_id)
							const licensesRes = await env.DB.prepare('SELECT DISTINCT customer_id FROM licenses WHERE customer_id IS NOT NULL').all();

							if (licensesRes && licensesRes.results) {
								// Filter licenses by checking if they belong to this user's customer IDs
								// Since licenses table doesn't have user_email, we'll check if any license
								// has a customer_id that matches any of the customer IDs we've already found
								// OR we can check via subscriptions that have these customer IDs
								const licenseCustomerIds = licensesRes.results.map((row) => row.customer_id).filter((id) => id && id.startsWith('cus_'));

								// Check which license customer IDs belong to this user by cross-referencing with subscriptions
								const userLicenseCustomerIds = [];
								for (const licenseCustId of licenseCustomerIds) {
									// Check if this customer_id exists in subscriptions for this user
									const subCheck = await env.DB.prepare(
										'SELECT COUNT(*) as count FROM subscriptions WHERE user_email = ? AND customer_id = ?'
									)
										.bind(email, licenseCustId)
										.first();

									if (subCheck && subCheck.count > 0) {
										userLicenseCustomerIds.push(licenseCustId);
									}
								}

								if (userLicenseCustomerIds.length > 0) {
									console.log(
										`[Invoices] Found ${userLicenseCustomerIds.length} additional customer ID(s) from licenses table:`,
										userLicenseCustomerIds
									);
									allCustomerIds = [...new Set([...allCustomerIds, ...userLicenseCustomerIds])];
								}
							}

							// Final filtering and deduplication
							allCustomerIds = [...new Set(allCustomerIds.filter((id) => id && id.startsWith('cus_')))];

							console.log(`[Invoices] Total unique customer IDs found: ${allCustomerIds.length}`);
							if (allCustomerIds.length > 0) {
								console.log(`[Invoices] All customer IDs:`, allCustomerIds);
							}
						} catch (dbErr) {
							console.error('[Invoices] Error finding customers by email:', dbErr);
							console.error('[Invoices] Error details:', {
								message: dbErr.message,
								stack: dbErr.stack,
								email: email,
							});
						}
					} else {
						console.error('[Invoices] Database not available (env.DB is null)');
					}

					if (allCustomerIds.length === 0) {
						console.log('[Invoices] No customer IDs found for email:', email);
						return jsonResponse(
							200,
							{
								invoices: [],
								total: 0,
								hasMore: false,
								offset: offset,
								limit: limit,
							},
							true,
							request
						);
					}

					console.log(`[Invoices] Found ${allCustomerIds.length} customer ID(s) for email ${email}:`, allCustomerIds);

					// Limit number of customers to process to prevent timeout
					const customersToProcess = allCustomerIds.slice(0, maxCustomersToProcess);
					if (allCustomerIds.length > maxCustomersToProcess) {
						console.log(`[Invoices] Limiting to first ${maxCustomersToProcess} customers to prevent timeout`);
					}

					// Fetch invoices from Stripe for customer IDs with pagination
					const allInvoices = [];

					for (const customerId of customersToProcess) {
						try {
							let hasMore = true;
							let startingAfter = null;
							let customerInvoiceCount = 0;

							// Fetch invoices with pagination, but limit per customer to prevent timeout
							let invoicesFetchedForCustomer = 0;

							while (hasMore && invoicesFetchedForCustomer < maxInvoicesPerCustomer) {
								// Calculate how many more we need for this customer
								const remainingNeeded = maxInvoicesPerCustomer - invoicesFetchedForCustomer;
								const fetchLimit = Math.min(100, remainingNeeded); // Stripe max is 100

								let invoiceUrl = `/invoices?customer=${customerId}&limit=${fetchLimit}`;
								if (startingAfter) {
									invoiceUrl += `&starting_after=${startingAfter}`;
								}

								const invoicesRes = await stripeFetch(env, invoiceUrl);

								if (invoicesRes.status === 200 && invoicesRes.body) {
									const invoicesData = invoicesRes.body.data || [];
									const hasMoreFlag = invoicesRes.body.has_more || false;

									console.log(`[Invoices] Fetched ${invoicesData.length} invoices for customer ${customerId} (has_more: ${hasMoreFlag})`);
									console.log(
										`[Invoices] Progress: ${invoicesFetchedForCustomer}/${maxInvoicesPerCustomer} invoices fetched for customer ${customerId}`
									);

									// Filter out $0 invoices and only include paid invoices
									const paidInvoices = invoicesData.filter((invoice) => {
										// Only include invoices that were actually paid (amount_paid > 0)
										return invoice.status === 'paid' && invoice.amount_paid > 0;
									});

									customerInvoiceCount += paidInvoices.length;
									invoicesFetchedForCustomer += invoicesData.length;
									console.log(
										`[Invoices] After this batch: ${invoicesFetchedForCustomer}/${maxInvoicesPerCustomer} total fetched, ${customerInvoiceCount} paid invoices found`
									);

									// Transform invoice data
									const transformedInvoices = paidInvoices.map((invoice) => ({
										id: invoice.id,
										number: invoice.number,
										amount_paid: invoice.amount_paid,
										amount_due: invoice.amount_due,
										currency: invoice.currency,
										status: invoice.status,
										created: invoice.created,
										invoice_pdf: invoice.invoice_pdf,
										hosted_invoice_url: invoice.hosted_invoice_url,
										customer: invoice.customer,
										subscription: invoice.subscription,
										period_start: invoice.period_start,
										period_end: invoice.period_end,
										description: invoice.description || invoice.lines?.data?.[0]?.description || 'Invoice',
										line_items:
											invoice.lines?.data?.map((item) => ({
												description: item.description,
												amount: item.amount,
												quantity: item.quantity,
												price: item.price,
											})) || [],
									}));

									allInvoices.push(...transformedInvoices);

									// Early exit if we have enough paid invoices for pagination (with buffer)
									// Only exit early if we have enough paid invoices, not just raw invoices
									if (allInvoices.length >= offset + limit + 50) {
										console.log(`[Invoices] Early exit: Collected enough paid invoices (${allInvoices.length}) for pagination`);
										hasMore = false;
										break;
									}

									// Continue fetching if there are more invoices and we haven't reached the limit
									// Don't stop just because we fetched 50 - keep going to find paid invoices
									if (hasMoreFlag && invoicesData.length > 0 && invoicesFetchedForCustomer < maxInvoicesPerCustomer) {
										// Get the last invoice ID for pagination
										startingAfter = invoicesData[invoicesData.length - 1].id;
										hasMore = true;
										console.log(
											`[Invoices] Continuing to fetch more invoices for customer ${customerId} (${invoicesFetchedForCustomer} < ${maxInvoicesPerCustomer})`
										);
									} else {
										hasMore = false;
										if (invoicesFetchedForCustomer >= maxInvoicesPerCustomer) {
											console.log(`[Invoices] Reached max invoices per customer (${maxInvoicesPerCustomer}) for customer ${customerId}`);
										} else if (!hasMoreFlag) {
											console.log(`[Invoices] No more invoices available for customer ${customerId} (has_more: false)`);
										} else {
											console.log(`[Invoices] Stopping fetch for customer ${customerId} (invoicesData.length: ${invoicesData.length})`);
										}
									}
								} else {
									console.error(`[Invoices] Failed to fetch invoices for customer ${customerId}:`, invoicesRes.status, invoicesRes.body);
									hasMore = false;
								}
							}

							if (invoicesFetchedForCustomer >= maxInvoicesPerCustomer) {
								console.log(`[Invoices] Reached max invoices per customer (${maxInvoicesPerCustomer}) for customer ${customerId}`);
							}

							console.log(`[Invoices] Total paid invoices for customer ${customerId}: ${customerInvoiceCount}`);
						} catch (stripeErr) {
							console.error(`[Invoices] Error fetching invoices for customer ${customerId}:`, stripeErr);
							// Continue with other customers
						}
					}

					console.log(`[Invoices] Total invoices found across all customers: ${allInvoices.length}`);

					// Sort by created date (most recent first) and remove duplicates
					const uniqueInvoices = Array.from(new Map(allInvoices.map((inv) => [inv.id, inv])).values()).sort(
						(a, b) => b.created - a.created
					);

					const totalCount = uniqueInvoices.length;

					// Apply pagination
					const paginatedInvoices = uniqueInvoices.slice(offset, offset + limit);
					const hasMore = offset + limit < totalCount;

					console.log(`[Invoices] Final unique paid invoices count: ${totalCount} (after deduplication)`);
					console.log(`[Invoices] Pagination: offset=${offset}, limit=${limit}, returned=${paginatedInvoices.length}, hasMore=${hasMore}`);
					console.log(`[Invoices] Customer IDs processed: ${allCustomerIds.length}`);

					return jsonResponse(
						200,
						{
							invoices: paginatedInvoices,
							total: totalCount,
							hasMore: hasMore,
							offset: offset,
							limit: limit,
						},
						true,
						request
					);
				} catch (error) {
					console.error('[Invoices] Error:', error);
					console.error('[Invoices] Error details:', {
						message: error.message,
						stack: error.stack,
						name: error.name,
					});
					return jsonResponse(
						500,
						{
							error: 'Failed to fetch invoices',
							message: error.message || 'An unexpected error occurred',
							invoices: [],
							total: 0,
							hasMore: false,
							offset: offset || 0,
							limit: limit || 10,
						},
						true,
						request
					);
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
					const customer = customerId ? userFromEmail.customers.find((c) => c.customerId === customerId) : userFromEmail.customers[0];

					if (!customer) {
						return jsonResponse(400, { error: 'customer not found', message: 'No customer found for this email' }, true, request);
					}

					customerId = customer.customerId;

					// Get subscription (use provided subscriptionId or first active subscription)
					const subscription = subscriptionId
						? customer.subscriptions.find((s) => s.subscriptionId === subscriptionId)
						: customer.subscriptions.find((s) => s.status === 'active') || customer.subscriptions[0];

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
						defaultPrice: userFromEmail.defaultPrice || null,
					};

					// Convert items to sites format
					customer.subscriptions.forEach((sub) => {
						if (sub.items) {
							sub.items.forEach((item) => {
								if (item.site) {
									user.sites[item.site] = {
										item_id: item.item_id,
										price: item.price,
										quantity: item.quantity || 1,
										status: item.status || 'active',
										created_at: item.created_at,
										subscription_id: sub.subscriptionId,
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
								)
									.bind(email)
									.first();
								if (paymentResult && paymentResult.customer_id) {
									customerId = paymentResult.customer_id;
								}
							} catch (dbError) {
								console.error('[create-checkout-from-pending] Error fetching customer ID from payments:', dbError);
							}
						}

						if (!customerId) {
							return jsonResponse(
								400,
								{ error: 'customer not found', message: 'No customer found for this email. Please complete a payment first.' },
								true,
								request
							);
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
					return jsonResponse(
						400,
						{ error: 'no pending sites to checkout', message: 'Please add sites to the pending list first' },
						true,
						request
					);
				}
				console.log(
					`[USE CASE 2 - CHECKOUT] ✅ Found ${user.pendingSites.length} pending site(s):`,
					user.pendingSites.map((ps) => ps.site || ps.site_domain)
				);

				// CRITICAL: Check if any pending sites already exist in subscription details
				const existingSitesSet = new Set();

				// Check legacy structure (user.sites)
				if (user.sites) {
					Object.keys(user.sites).forEach((site) => {
						if (user.sites[site] && user.sites[site].status === 'active') {
							existingSitesSet.add(site.toLowerCase().trim());
						}
					});
				}

				// Check email-based structure (subscription items)
				if (userFromEmail && userFromEmail.customers) {
					userFromEmail.customers.forEach((customer) => {
						if (customer.subscriptions) {
							customer.subscriptions.forEach((subscription) => {
								if (subscription.items) {
									subscription.items.forEach((item) => {
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
						const pendingSiteNames = user.pendingSites
							.map((ps) => {
								const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
								return siteName;
							})
							.filter((s) => s);

						if (pendingSiteNames.length > 0) {
							// Check each pending site against all database tables (across all users)
							for (const pendingSite of pendingSiteNames) {
								let isDuplicate = false;

								// Check if site exists in subscription_items (across all users)
								const existingInItems = await env.DB.prepare(
									'SELECT site_domain FROM subscription_items WHERE LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
								)
									.bind(pendingSite, 'active')
									.first();

								if (existingInItems) {
									isDuplicate = true;
								}

								// Check if site exists in sites table (across all users)
								if (!isDuplicate) {
									const existingInSites = await env.DB.prepare(
										'SELECT site_domain FROM sites WHERE LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
									)
										.bind(pendingSite, 'active')
										.first();

									if (existingInSites) {
										isDuplicate = true;
									}
								}

								// Check if site exists in licenses table - both site_domain and used_site_domain (across all users)
								if (!isDuplicate) {
									const existingInLicenses = await env.DB.prepare(
										'SELECT site_domain, used_site_domain FROM licenses WHERE (LOWER(TRIM(site_domain)) = ? OR LOWER(TRIM(used_site_domain)) = ?) AND (site_domain IS NOT NULL AND site_domain != "" OR used_site_domain IS NOT NULL AND used_site_domain != "") LIMIT 1'
									)
										.bind(pendingSite, pendingSite)
										.first();

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
					user.pendingSites.forEach((ps) => {
						const siteName = (ps.site || ps.site_domain || '').toLowerCase().trim();
						if (siteName && existingSitesSet.has(siteName)) {
							duplicateSites.push(siteName);
						}
					});
				}

				// If any duplicates found, return error
				if (duplicateSites.length > 0) {
					const duplicateList = duplicateSites.join(', ');
					return jsonResponse(
						400,
						{
							error: 'duplicate_sites',
							message: `The following site(s) already exist and cannot be added (may be in use by another user): ${duplicateList}. Please remove them from the pending list.`,
							duplicateSites: duplicateSites,
						},
						true,
						request
					);
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
						const customer = userFromEmail.customers.find((c) => c.customerId === customerId) || userFromEmail.customers[0];
						if (customer) {
							customer.customerId = customerId;
							await saveUserByEmail(env, email, userFromEmail);
						}
					}
				}

				// After payment, redirect directly to dashboard
				// Users will be automatically logged in via Memberstack session
				const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard';
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
					return jsonResponse(
						400,
						{
							error: 'no_pending_sites',
							message: 'No valid pending sites found to process. Please add sites before checkout.',
						},
						true,
						request
					);
				}

				// USE CASE 2: Create separate subscription for each site (like Use Case 3 for licenses)
				// Use payment mode and handle subscription creation in webhook
				console.log(`[USE CASE 2 - CHECKOUT] 🔍 STEP 2.2: Preparing checkout session for ${uniquePendingSites.length} site(s)`);
				const form = {
					customer: customerId,
					success_url: successUrl,
					cancel_url: cancelUrl,
					mode: 'payment', // Payment mode like Use Case 3
					// Payment method types: Card, Amazon Pay, Cash App Pay, Bank transfer
					'payment_method_types[0]': 'card',
					'payment_method_types[1]': 'link', // Link supports various payment methods
					// Enable promotion codes
					allow_promotion_codes: 'true',
				};

				// Get price ID from billing_period parameter (required - no fallbacks)
				if (!billingPeriodParam) {
					console.log(`[USE CASE 2 - CHECKOUT] ❌ Missing billing_period parameter`);
					return jsonResponse(
						400,
						{
							error: 'missing_billing_period',
							message: 'billing_period parameter is required (monthly or yearly).',
						},
						true,
						request
					);
				}

				console.log(`[USE CASE 2 - CHECKOUT] 🔍 Getting price ID for billing period: ${billingPeriodParam}`);
				const priceId = await getPriceIdByBillingPeriod(env, billingPeriodParam);
				console.log(`[USE CASE 2 - CHECKOUT] ✅ Price ID: ${priceId}`);

				if (!priceId) {
					return jsonResponse(
						400,
						{
							error: 'price_not_configured',
							message: `Price ID not configured for ${billingPeriodParam} billing period. Please configure it in the database or environment variables.`,
						},
						true,
						request
					);
				}

				// Get price details to calculate total amount
				const priceRes = await stripeFetch(env, `/prices/${priceId}`);
				if (priceRes.status !== 200) {
					return jsonResponse(
						400,
						{
							error: 'invalid_price',
							message: 'Invalid price ID. Please add sites again with valid price IDs.',
						},
						true,
						request
					);
				}

				const price = priceRes.body;
				const unitAmount = price.unit_amount || 0;
				const billingPeriodText = billingPeriodParam === 'yearly' ? 'yearly' : 'monthly';

				// Create single line item with unit amount and quantity to show proper pricing breakdown
				// Use the product_id from the price to ensure all site purchases use the same product
				form['line_items[0][price_data][currency]'] = price.currency || 'usd';
				form['line_items[0][price_data][unit_amount]'] = unitAmount; // Unit price per site

				// Use product_data to show proper name and billing period
				form['line_items[0][price_data][product_data][name]'] = 'ConsentBit';
				form['line_items[0][price_data][product_data][description]'] = `Billed ${billingPeriodText}`;

				form['line_items[0][quantity]'] = uniquePendingSites.length; // Show actual quantity (number of sites)

				// Store site names and metadata in payment_intent_data (like Use Case 3 stores license keys)
				const siteNames = uniquePendingSites.map((ps) => ps.site || ps.site_domain);
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
					return jsonResponse(
						500,
						{
							error: 'stripe_checkout_failed',
							message: 'Failed to create checkout session with Stripe. Please try again.',
							details: session.body?.error?.message || 'Unknown error',
						},
						true,
						request
					);
				}

				// Validate session was created successfully
				if (!session.body || !session.body.id || !session.body.url) {
					console.error(`[USE CASE 2 - CHECKOUT] ❌ Invalid checkout session response from Stripe`);
					return jsonResponse(
						500,
						{
							error: 'invalid_checkout_session',
							message: 'Stripe returned an invalid checkout session. Please try again.',
							details: session.body,
						},
						true,
						request
					);
				}

				console.log(`[USE CASE 2 - CHECKOUT] ✅ STEP 2 COMPLETE: Checkout session created - ${session.body.id}`);
				console.log(`[USE CASE 2 - CHECKOUT] 🔗 Checkout URL: ${session.body.url}`);
				return jsonResponse(
					200,
					{
						sessionId: session.body.id,
						url: session.body.url,
					},
					true,
					request
				);
			}

			// Remove a site (delete subscription item from subscription)
			// Uses transaction-like pattern with rollback for consistency
			// Remove a site (cancel subscription at period end for that site/user)
			if (request.method === 'POST' && pathname === '/remove-site') {
				// Support both session cookie and email-based authentication
				const cookie = request.headers.get('cookie') || '';
				const match = cookie.match(/sb_session=([^;]+)/);

				let email = null;
				let customerId = null;

				// Try email from request body (for Memberstack users)
				const body = await request.json();
				const { site, subscription_id } = body;

				if (body.email) {
					email = body.email.toLowerCase().trim();
				} else if (match) {
					const token = match[1];
					const payload = await verifyToken(env, token);
					if (!payload) {
						console.error('[REMOVE-SITE] ❌ Invalid session token');
						return jsonResponse(401, { error: 'invalid session' }, true, request);
					}
					email = payload.email;
					customerId = payload.customerId;
				} else {
					console.error('[REMOVE-SITE] ❌ No authentication found');
					return jsonResponse(401, { error: 'unauthenticated' }, true, request);
				}

				console.log(`[REMOVE-SITE] 🔍 Received request to remove site: ${site} for email: ${email} for subscriptionid ${subscription_id}`);

				if (!site) {
					console.error('[REMOVE-SITE] ❌ Missing site parameter');
					return jsonResponse(400, { error: 'missing site parameter' }, true, request);
				}

				// Get user email if not already set
				if (!email && customerId) {
					email = await getCustomerEmail(env, customerId);
				}

				if (!email) {
					console.error('[REMOVE-SITE] ❌ Email not found');
					return jsonResponse(400, { error: 'email not found' }, true, request);
				}

				// Verify Memberstack session (if configured)
				if (env.MEMBERSTACK_SECRET_KEY) {
					try {
						const normalizedRequestEmail = email.toLowerCase().trim();
						const memberstackMember = await this.getMemberstackMember(email, env);

						if (!memberstackMember) {
							console.error(`[REMOVE-SITE] ❌ Memberstack member not found for email: ${email}`);
							return jsonResponse(
								401,
								{
									error: 'memberstack_authentication_failed',
									message: 'User is not authenticated with Memberstack. Please log in to continue.',
								},
								true,
								request
							);
						}

						const memberEmail =
							memberstackMember.auth?.email ||
							memberstackMember.email ||
							memberstackMember._email ||
							memberstackMember.data?.email ||
							memberstackMember.data?._email ||
							memberstackMember.data?.auth?.email ||
							'N/A';

						const memberId =
							memberstackMember.id || memberstackMember._id || memberstackMember.data?.id || memberstackMember.data?._id || 'N/A';

						const normalizedMemberEmail = memberEmail.toLowerCase().trim();

						if (memberEmail === 'N/A') {
							console.error('[REMOVE-SITE] ❌ Memberstack member has no email address');
							return jsonResponse(
								401,
								{
									error: 'memberstack_email_missing',
									message: 'Memberstack account has no email address. Please contact support.',
								},
								true,
								request
							);
						}

						if (normalizedMemberEmail !== normalizedRequestEmail) {
							console.error('[REMOVE-SITE] ❌ Email mismatch detected:');
							console.error(`[REMOVE-SITE]   Request email (normalized): "${normalizedRequestEmail}"`);
							console.error(`[REMOVE-SITE]   Memberstack email (normalized): "${normalizedMemberEmail}"`);
							console.error(`[REMOVE-SITE]   Original request email: "${email}"`);
							console.error(`[REMOVE-SITE]   Original member email: "${memberEmail}"`);
							return jsonResponse(
								401,
								{
									error: 'email_mismatch',
									message: `Email does not match Memberstack account. Requested: "${email}", Memberstack: "${memberEmail}"`,
								},
								true,
								request
							);
						}

						const isDeleted =
							memberstackMember.deleted === true || memberstackMember.data?.deleted === true || memberstackMember.isDeleted === true;

						const isActive = memberstackMember.active !== false && memberstackMember.data?.active !== false && !isDeleted;

						if (isDeleted) {
							console.error(`[REMOVE-SITE] ❌ Memberstack member is deleted: ID=${memberId}`);
							return jsonResponse(
								401,
								{
									error: 'memberstack_account_deleted',
									message: 'Your Memberstack account has been deleted. Please contact support.',
								},
								true,
								request
							);
						}

						if (!isActive) {
							console.error(`[REMOVE-SITE] ❌ Memberstack member is inactive: ID=${memberId}`);
							return jsonResponse(
								401,
								{
									error: 'memberstack_account_inactive',
									message: 'Your Memberstack account is inactive. Please contact support.',
								},
								true,
								request
							);
						}
					} catch (memberstackError) {
						console.error('[REMOVE-SITE] ❌ Error verifying Memberstack member:', memberstackError);
						return jsonResponse(
							401,
							{
								error: 'memberstack_verification_failed',
								message: 'Failed to verify Memberstack session. Please log in again.',
							},
							true,
							request
						);
					}
				}

				// Idempotency
				const operationId = `remove_site_${email}_${site}_${Date.now()}`;

				if (env.DB) {
					const existingOp = await env.DB.prepare('SELECT operation_data FROM idempotency_keys WHERE operation_id = ? LIMIT 1')
						.bind(operationId)
						.first();
					if (existingOp && existingOp.operation_data) {
						const result = JSON.parse(existingOp.operation_data);
						return jsonResponse(200, { success: true, idempotent: true, ...result }, true, request);
					}
				}

				// Fetch user record
				let user = await getUserByEmail(env, email);
				if (!user) {
					console.error(`[REMOVE-SITE] ❌ User not found in database: ${email}`);
					return jsonResponse(400, { error: 'user not found' }, true, request);
				}

				// ---------- SUBSCRIPTION-LEVEL LOOKUP ----------
				let itemId = null;
				let subscriptionId = subscription_id || null;

				// 1) If subscription_id provided, verify it belongs to this site/user
				if (subscriptionId && env.DB) {
					try {
						const siteRecord = await env.DB.prepare(
							'SELECT item_id FROM sites WHERE subscription_id = ? AND LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
						)
							.bind(subscriptionId, site.toLowerCase().trim(), 'active')
							.first();

						if (siteRecord && siteRecord.item_id) {
							itemId = siteRecord.item_id;
						}
					} catch (err) {
						console.error('[REMOVE-SITE] ⚠️ Error verifying subscription_id in sites:', err);
					}
				}

				// 2) If subscriptionId not known yet, derive via customers → sites
				if (!subscriptionId && env.DB) {
					try {
						const customerIdsRes = await env.DB.prepare('SELECT DISTINCT customer_id FROM customers WHERE user_email = ?')
							.bind(email)
							.all();

						if (customerIdsRes && customerIdsRes.results && customerIdsRes.results.length > 0) {
							const customerIds = customerIdsRes.results.map((r) => r.customer_id);

							for (const cid of customerIds) {
								const siteRecord = await env.DB.prepare(
									'SELECT item_id, subscription_id FROM sites WHERE customer_id = ? AND LOWER(TRIM(site_domain)) = ? AND status = ? LIMIT 1'
								)
									.bind(cid, site.toLowerCase().trim(), 'active')
									.first();

								if (siteRecord && siteRecord.subscription_id) {
									subscriptionId = siteRecord.subscription_id;
									if (siteRecord.item_id) itemId = siteRecord.item_id;
									break;
								}
							}
						}
					} catch (dbError) {
						console.error('[REMOVE-SITE] ❌ Error querying sites table:', dbError);
					}
				}

				// FINAL CHECK
				if (!subscriptionId) {
					console.error(`[REMOVE-SITE] ❌ Subscription not found for site: ${site}, email: ${email}`);
					return jsonResponse(
						400,
						{
							error: 'subscription_not_found_for_site',
							message: `Could not find an active subscription for site "${site}". The site may not exist or may have already been removed.`,
						},
						true,
						request
					);
				}

				// Check if quantity use case
				let isIndividualSubscription = false;
				let purchaseType = 'site';
				if (env.DB && subscriptionId) {
					try {
						const licenseCheck = await env.DB.prepare('SELECT purchase_type FROM licenses WHERE subscription_id = ? LIMIT 1')
							.bind(subscriptionId)
							.first();

						if (licenseCheck && licenseCheck.purchase_type === 'quantity') {
							purchaseType = 'quantity';
							try {
								const subRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
								if (subRes.status === 200) {
									const sub = subRes.body;
									const subMetadata = sub.metadata || {};
									if (subMetadata.purchase_type === 'quantity' && subMetadata.usecase === '3') {
										isIndividualSubscription = true;
									}
								}
							} catch (subErr) {
								console.warn('[REMOVE-SITE] ⚠️ Could not check subscription metadata:', subErr.message);
							}
						}
					} catch (licenseErr) {
						console.warn('[REMOVE-SITE] ⚠️ Could not check license purchase_type:', licenseErr.message);
					}
				}

				const originalUserState = JSON.parse(JSON.stringify(user));
				let originalStripeItem = null;

				try {
					// Step 1: fetch Stripe item only if we have itemId
					if (itemId) {
						const getItemRes = await stripeFetch(env, `/subscription_items/${itemId}`);
						if (getItemRes.status === 200) {
							originalStripeItem = getItemRes.body;
						} else {
							console.error('[REMOVE-SITE] ⚠️ Failed to fetch Stripe item:', getItemRes.status, getItemRes.body);
						}
					}

					// Step 2: DB updates at subscription level (all three tables)
					const removedAt = Math.floor(Date.now() / 1000);

					if (env.DB && subscriptionId) {
						try {
							await env.DB.prepare('UPDATE subscription_items SET status = ?, removed_at = ?, updated_at = ? WHERE subscription_id = ?')
								.bind('inactive', removedAt, removedAt, subscriptionId)
								.run();
						} catch (err) {
							console.error('[REMOVE-SITE] ❌ Failed to update subscription_items:', err);
						}

						try {
							await env.DB.prepare('UPDATE sites SET status = ?, canceled_at = ?, updated_at = ? WHERE subscription_id = ?')
								.bind('inactive', removedAt, removedAt, subscriptionId)
								.run();
						} catch (err) {
							console.error('[REMOVE-SITE] ❌ Failed to update sites:', err);
						}

						try {
							const now = Math.floor(Date.now() / 1000);
							await env.DB.prepare(
								'UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, cancel_at = ?, updated_at = ? WHERE subscription_id = ?'
							)
								.bind('canceled', 1, now, now, subscriptionId)
								.run();
						} catch (err) {
							console.error('[REMOVE-SITE] ❌ Failed to update subscriptions:', err);
						}
					}

					// Update user object
					for (const customer of user.customers || []) {
						for (const subscription of customer.subscriptions || []) {
							if (subscription.subscriptionId === subscriptionId) {
								if (subscription.items) {
									subscription.items.forEach((item) => {
										if (item.status === 'active') {
											item.status = 'inactive';
											item.removed_at = removedAt;
										}
									});
								}
								subscription.status = 'canceled';
							}
						}
					}

					if (user.sites) {
						Object.keys(user.sites).forEach((siteKey) => {
							const siteData = user.sites[siteKey];
							if (siteData.subscription_id === subscriptionId && siteData.status === 'active') {
								siteData.status = 'inactive';
								siteData.removed_at = removedAt;
							}
						});
					}

					// Save user with retry
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
							await new Promise((resolve) => setTimeout(resolve, delay));
						}
					}

					if (!dbSuccess) {
						throw new Error('Failed to update database after 3 retries');
					}

					// Step 3: cancel subscription at period end on Stripe
					const cancelRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`, 'POST', { cancel_at_period_end: true }, true);

					if (cancelRes.status >= 400) {
						console.error(`[REMOVE-SITE] ❌ Stripe cancellation failed (status ${cancelRes.status}), rolling back database update`);
						console.error('[REMOVE-SITE] Stripe error details:', cancelRes.body);
						await saveUserByEmail(env, email, originalUserState);
						console.error('[REMOVE-SITE] ✅ Database rollback completed');
						return jsonResponse(
							500,
							{
								error: 'failed to cancel subscription',
								details: cancelRes.body,
								rolledBack: true,
							},
							true,
							request
						);
					}

					// Update timing fields on subscriptions from Stripe response
					if (env.DB) {
						try {
							const timestamp = Math.floor(Date.now() / 1000);
							const currentPeriodEnd = cancelRes.body?.current_period_end || null;
							const cancelAt = cancelRes.body?.cancel_at || cancelRes.body?.canceled_at || timestamp;

							await env.DB.prepare(
								'UPDATE subscriptions SET cancel_at_period_end = ?, cancel_at = ?, current_period_end = ?, updated_at = ? WHERE subscription_id = ?'
							)
								.bind(1, cancelAt, currentPeriodEnd, timestamp, subscriptionId)
								.run();
						} catch (subUpdateError) {
							console.error('[REMOVE-SITE] ⚠️ Failed to update subscription timing (non-critical):', subUpdateError);
						}
					}

					// Step 4: mark licenses inactive
					let customerIdForLicense = null;
					if (user.customers && user.customers.length > 0) {
						for (const customer of user.customers) {
							if (customer.subscriptions && customer.subscriptions.some((s) => s.subscriptionId === subscriptionId)) {
								customerIdForLicense = customer.customerId;
								break;
							}
						}
						if (!customerIdForLicense && user.customers[0]) {
							customerIdForLicense = user.customers[0].customerId;
						}
					}

					if (env.DB && customerIdForLicense) {
						try {
							const timestamp = Math.floor(Date.now() / 1000);

							await env.DB.prepare(
								'UPDATE licenses SET status = ?, updated_at = ? WHERE customer_id = ? AND site_domain = ? AND status = ?'
							)
								.bind('inactive', timestamp, customerIdForLicense, site, 'active')
								.run();

							await env.DB.prepare('UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ? AND status = ?')
								.bind('inactive', timestamp, subscriptionId, 'active')
								.run();
						} catch (dbError) {
							console.error('[REMOVE-SITE] ⚠️ License status update failed (non-critical):', dbError);
						}
					} else if (!customerIdForLicense) {
						console.warn('[REMOVE-SITE] ⚠️ Could not find customer ID for license update, skipping');
					} else {
						console.warn('[REMOVE-SITE] ⚠️ env.DB not configured, skipping license update');
					}

					// Idempotency record
					if (env.DB) {
						try {
							const resultData = {
								operationId,
								success: true,
								site,
								itemId,
								completedAt: Date.now(),
							};
							await env.DB.prepare('INSERT OR REPLACE INTO idempotency_keys (operation_id, operation_data, created_at) VALUES (?, ?, ?)')
								.bind(operationId, JSON.stringify(resultData), Math.floor(Date.now() / 1000))
								.run();
						} catch (idempotencyError) {
							console.error('[REMOVE-SITE] ⚠️ Failed to save idempotency key (non-critical):', idempotencyError);
						}
					}

					let cancelMessage = '';
					if (isIndividualSubscription) {
						cancelMessage =
							'Subscription canceled successfully. This license has its own individual subscription (Use Case 3), so canceling it will cancel the entire subscription. NO PRORATION applies since each license has its own subscription. The subscription will remain active until the end of the current billing period.';
					} else {
						cancelMessage =
							'Subscription canceled successfully. The subscription has been canceled and will remain active until the end of the current billing period. All sites in this subscription have been marked as inactive. Stripe will prorate the current period and future invoices will be reduced.';
					}

					return jsonResponse(
						200,
						{
							success: true,
							site,
							subscriptionId,
							is_individual_subscription: isIndividualSubscription,
							purchase_type: purchaseType,
							requires_proration: !isIndividualSubscription,
							message: cancelMessage,
						},
						true,
						request
					);
				} catch (error) {
					console.error('[REMOVE-SITE] Attempting database rollback...');
					try {
						await saveUserByEmail(env, email, originalUserState);
						console.error('[REMOVE-SITE] ✅ Database rollback completed');
					} catch (rollbackError) {
						console.error('[REMOVE-SITE] ❌ Failed to rollback database:', rollbackError);
					}

					return jsonResponse(
						500,
						{
							error: 'operation_failed',
							message: error.message,
							rolledBack: true,
						},
						true,
						request
					);
				}
			}

			// Can be called manually to process queue immediately (useful for debugging)
			if (request.method === 'POST' && pathname === '/process-queue') {
				const { limit = 100 } = await request.json().catch(() => ({}));
				console.log(`[ENDPOINT] /process-queue called with limit: ${limit}`);
				const result = await processSubscriptionQueue(env, limit);
				console.log(`[ENDPOINT] /process-queue result:`, result);
				return jsonResponse(200, result, true, request);
			}

			// // Process refunds for failed queue items older than 12 hours
			// if (request.method === 'POST' && pathname === '/process-refunds') {
			//   const { limit = 50 } = await request.json().catch(() => ({}));
			//   const result = await processRefundsForOldFailedItems(env, limit);
			//   return jsonResponse(200, result, true, request);
			// }

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
					)
						.bind(payment_intent_id)
						.all();

					const stats = {
						total: queueItems.results.length,
						pending: queueItems.results.filter((item) => item.status === 'pending').length,
						processing: queueItems.results.filter((item) => item.status === 'processing').length,
						completed: queueItems.results.filter((item) => item.status === 'completed').length,
						failed: queueItems.results.filter((item) => item.status === 'failed').length,
						items: queueItems.results,
					};

					return jsonResponse(200, stats, true, request);
				} catch (error) {
					console.error('[queue-status] Error:', error);
					return jsonResponse(500, { error: error.message }, true, request);
				}
			}

			if (request.method === 'POST' && pathname === '/purchase-quantity') {
				const startTime = Date.now();

				let requestBody;
				try {
					requestBody = await request.json();
				} catch (parseError) {
					return jsonResponse(
						400,
						{
							error: 'invalid_request',
							message: 'Invalid JSON in request body',
						},
						true,
						request
					);
				}

				const { email: emailParam, quantity, billing_period: billingPeriodParam } = requestBody;

				const MAX_QUANTITY = env.MAX_QUANTITY_PER_PURCHASE ? parseInt(env.MAX_QUANTITY_PER_PURCHASE) : 50;
				if (!quantity || quantity < 1 || quantity > MAX_QUANTITY) {
					return jsonResponse(
						400,
						{
							error: 'invalid_quantity',
							message: `Quantity must be between 1 and ${MAX_QUANTITY}`,
						},
						true,
						request
					);
				}

				// Get email from request or session
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
					email = payload.email.toLowerCase().trim();
				}

				if (!email.includes('@')) {
					return jsonResponse(400, { error: 'invalid_email' }, true, request);
				}

				// Get customer ID
				const customerRes = await env.DB.prepare('SELECT customer_id FROM customers WHERE user_email = ? LIMIT 1').bind(email).first();

				if (!customerRes?.customer_id) {
					return jsonResponse(
						400,
						{
							error: 'no_customer',
							message: 'Customer account required',
						},
						true,
						request
					);
				}

				const customerId = customerRes.customer_id;

				// Get price configuration
				if (!billingPeriodParam) {
					return jsonResponse(
						400,
						{
							error: 'billing_period_required',
							message: 'billing_period is required',
						},
						true,
						request
					);
				}

				const normalizedPeriod = billingPeriodParam.toLowerCase().trim();
				let productId, unitAmount,price_id;
				const currency = 'usd'; // Default to USD

				if (normalizedPeriod === 'monthly') {
					productId = env.MONTHLY_PRODUCT_ID || env.MONTHLY_LICENSE_PRODUCT_ID || 'prod_TiG3c1jjtQHRLK';
					unitAmount = parseInt(env.MONTHLY_UNIT_AMOUNT || env.MONTHLY_LICENSE_UNIT_AMOUNT || '800');
					price_id = env.MONTHLY_LICENSE_PRICE_ID || "price_1SkpXkJwcuG9163MTm9SU4Uf";
				} else if (normalizedPeriod === 'yearly') {
					productId = env.YEARLY_PRODUCT_ID || env.YEARLY_LICENSE_PRODUCT_ID || 'prod_TiG4YkK61hiKKR';
					unitAmount = parseInt(env.YEARLY_UNIT_AMOUNT || env.YEARLY_LICENSE_UNIT_AMOUNT || '7200');
					price_id = env.YEARLY_LICENSE_PRICE_ID || "price_1SkpYAJwcuG9163M6U7qf1oD";
				} else {
					return jsonResponse(
						400,
						{
							error: 'invalid_billing_period',
							message: 'Billing period must be "monthly" or "yearly"',
						},
						true,
						request
					);
				}

				if (!productId) {
					return jsonResponse(
						500,
						{
							error: 'product_id_not_configured',
							message: 'Product ID not configured',
						},
						true,
						request
					);
				}

				// Generate temporary license keys and calculate amount
				const licenseKeys = generateTempLicenseKeys(quantity);
				const invoiceCurrency = 'usd'; // Default to USD
				const billingPeriodText = normalizedPeriod === 'yearly' ? 'year' : 'month';

				// Update customer metadata (non-blocking)
				stripeFetch(
					env,
					`/customers/${customerId}`,
					'POST',
					{
						'metadata[license_keys_pending]': JSON.stringify(licenseKeys),
						'metadata[usecase]': '3',
						'metadata[product_id]': productId,
						'metadata[price_id]': price_id,
						'metadata[currency]': invoiceCurrency,
						'metadata[quantity]': quantity.toString(),
						'metadata[billing_period]': normalizedPeriod,
					},
					true
				).catch(() => {}); // Non-critical

				// Create checkout session
				const dashboardUrl = env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard';

				const form = {
					mode: 'payment', // One-time payment for prorated amount
					customer: customerId,
					// Payment method types: Card only
					'payment_method_types[0]': 'card',
					// Enable promotion codes
					allow_promotion_codes: 'true',
					// Use custom price_data with unit amount and quantity to show proper pricing breakdown
					'line_items[0][price_data][currency]': 'usd', // Default to USD
					'line_items[0][price_data][unit_amount]': unitAmount, // Unit price (not multiplied)
					'line_items[0][price_data][product_data][name]': 'ConsentBit',
					'line_items[0][price_data][product_data][description]': `Billed ${billingPeriodText}ly`,
					'line_items[0][quantity]': quantity, // Show actual quantity
					'payment_intent_data[metadata][usecase]': '3', // Primary identifier for Use Case 3
					'payment_intent_data[metadata][customer_id]': customerId, // Required for webhook
					// For large quantities, license_keys may exceed 500 char limit - store in customer metadata instead
					// Only store in payment_intent_data if it fits within Stripe's 500 character limit
					...(JSON.stringify(licenseKeys).length <= 450
						? {
								'payment_intent_data[metadata][license_keys]': JSON.stringify(licenseKeys), // Store if within limit
						  }
						: {
								'payment_intent_data[metadata][license_keys_count]': quantity.toString(), // Store count instead
								'payment_intent_data[metadata][license_keys_source]': 'customer_metadata', // Indicate where to find keys
						  }),
					'payment_intent_data[metadata][product_id]': productId, // Required: to create subscriptions after payment (webhook can get price_id from this)
					'payment_intent_data[metadata][price_id]': price_id, // Required: to create subscriptions after payment
					'payment_intent_data[metadata][quantity]': quantity.toString(), // Required: quantity to create
					'payment_intent_data[metadata][currency]': invoiceCurrency, // Store currency for reference
					'payment_intent_data[metadata][billing_period]': normalizedPeriod, // Store billing period for reference
					'payment_intent_data[setup_future_usage]': 'off_session', // Save payment method for future subscriptions
					success_url: `${dashboardUrl}?session_id={CHECKOUT_SESSION_ID}&payment=success`,
					cancel_url: dashboardUrl,
				};

				const session = await stripeFetch(env, '/checkout/sessions', 'POST', form, true);

				if (session.status >= 400) {
					return jsonResponse(
						500,
						{
							error: 'checkout_failed',
							message: 'Failed to create checkout session',
							details: session.body,
						},
						true,
						request
					);
				}

				const totalTime = Date.now() - startTime;
				console.log(`[PURCHASE-QUANTITY] ✅ Created checkout in ${totalTime}ms`);

				return jsonResponse(
					200,
					{
						checkout_url: session.body.url,
						session_id: session.body.id,
						unit_amount: unitAmount,
						quantity: quantity,
						total_amount: unitAmount * quantity,
						currency: invoiceCurrency,
					},
					true,
					request
				);
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
					return jsonResponse(
						400,
						{
							error: 'missing_site',
							message: 'Site domain is required. Provide it as URL parameter: ?site=example.com or in request body.',
						},
						true,
						request
					);
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
					)
						.bind(normalizedSite, normalizedSite)
						.first();

					if (!licenseRes) {
						console.log(`[check-license-status] ❌ No active license found for site: ${normalizedSite}`);
						return jsonResponse(
							200,
							{
								success: false,
								available: false,
								site: site_domain,
								message: 'No active license found for this site',
								license: null,
							},
							true,
							request
						);
					}

					// If email is provided, verify the license belongs to that user
					if (email) {
						const normalizedEmail = email.toLowerCase().trim();
						const user = await getUserByEmail(env, normalizedEmail);

						if (user && user.customers) {
							const customerIds = user.customers.map((c) => c.customerId);
							if (!customerIds.includes(licenseRes.customer_id)) {
								console.log(`[check-license-status] ❌ License does not belong to user: ${normalizedEmail}`);
								return jsonResponse(
									200,
									{
										success: false,
										available: false,
										site: site_domain,
										message: 'No active license found for this site in your account',
										license: null,
									},
									true,
									request
								);
							}
						}
					}

					// Get subscription details if available
					let subscriptionDetails = null;
					if (licenseRes.subscription_id) {
						try {
							const subRes = await env.DB.prepare(
								'SELECT subscription_id, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
							)
								.bind(licenseRes.subscription_id)
								.first();

							if (subRes) {
								subscriptionDetails = {
									subscription_id: subRes.subscription_id,
									status: subRes.status,
									current_period_end: subRes.current_period_end,
									cancel_at_period_end: subRes.cancel_at_period_end === 1,
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
							const timestamp =
								typeof subscriptionDetails.current_period_end === 'number'
									? subscriptionDetails.current_period_end
									: parseInt(subscriptionDetails.current_period_end);
							const dateInMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
							expirationDate = new Date(dateInMs).toISOString();
						} catch (e) {
							console.warn(`[check-license-status] ⚠️ Error parsing subscription expiration date:`, e);
						}
					}

					console.log(`[check-license-status] ✅ Found active license for site: ${normalizedSite}`);

					return jsonResponse(
						200,
						{
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
								subscription: subscriptionDetails,
							},
						},
						true,
						request
					);
				} catch (error) {
					console.error(`[check-license-status] ❌ Error checking license status:`, error);
					return jsonResponse(
						500,
						{
							error: 'database_error',
							message: 'Failed to check license status',
							details: error.message,
						},
						true,
						request
					);
				}
			}

			if (request.method === 'POST' && pathname === '/activate-license') {
				const body = await request.json();
				const { license_key, site_domain, email: emailParam } = body;

				if (!license_key || !site_domain) {
					return jsonResponse(400, { error: 'missing_fields', message: 'license_key and site_domain are required' }, true, request);
				}

				// Normalize domain early
				const normalizedRequestedSite = site_domain.toLowerCase().trim();

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
					)
						.bind(license_key)
						.first();

					if (!licenseRes) {
						console.error(`[activate-license] :x: License not found: ${license_key}`);
						return jsonResponse(
							404,
							{
								error: 'license_not_found',
								message: 'License key not found. Please check the license key and try again.',
							},
							true,
							request
						);
					}

					// Verify customer ownership
					if (email) {
						const user = await getUserByEmail(env, email);
						if (user && user.customers) {
							const customerIds = user.customers.map((c) => c.customerId);
							if (!customerIds.includes(licenseRes.customer_id)) {
								console.error(`[activate-license] :x: Unauthorized: License ${license_key} does not belong to user ${email}`);
								return jsonResponse(
									403,
									{ error: 'unauthorized', message: 'This license key does not belong to your account' },
									true,
									request
								);
							}
						}
					}

					// Check subscription status if subscription_id exists
					if (licenseRes.subscription_id) {
						try {
							const subRes = await env.DB.prepare(
								'SELECT subscription_id, status, cancel_at_period_end, cancel_at, current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1'
							)
								.bind(licenseRes.subscription_id)
								.first();

							if (!subRes) {
								console.warn(`[activate-license] :warning: Subscription not found in database: ${licenseRes.subscription_id}`);
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
											console.warn(`[activate-license] :warning: Subscription has ended: ${endDate}`);
											return jsonResponse(
												400,
												{
													error: 'subscription_ended',
													message: `This license key's subscription has ended on ${endDate}. Please renew your subscription to continue using this license.`,
													subscription_end_date: periodEnd,
													subscription_end_date_formatted: endDate,
												},
												true,
												request
											);
										}

										// Check if subscription is cancelled
										if (stripeSub.status === 'canceled' || stripeSub.cancel_at_period_end || stripeSub.canceled_at) {
											const cancelDate = stripeSub.cancel_at
												? new Date(stripeSub.cancel_at * 1000).toLocaleDateString()
												: stripeSub.current_period_end
												? new Date(stripeSub.current_period_end * 1000).toLocaleDateString()
												: 'N/A';
											console.warn(`[activate-license] :warning: Subscription is cancelled: ${cancelDate}`);
											return jsonResponse(
												400,
												{
													error: 'subscription_cancelled',
													message: `This license key's subscription has been cancelled. It will end on ${cancelDate}. Please reactivate your subscription to continue using this license.`,
													subscription_cancel_date: stripeSub.cancel_at || stripeSub.current_period_end,
													subscription_cancel_date_formatted: cancelDate,
												},
												true,
												request
											);
										}

										// Check if subscription is not active
										if (stripeSub.status !== 'active' && stripeSub.status !== 'trialing') {
											console.warn(`[activate-license] :warning: Subscription is not active: ${stripeSub.status}`);
											return jsonResponse(
												400,
												{
													error: 'subscription_inactive',
													message: `This license key's subscription is ${stripeSub.status}. Please ensure your subscription is active to use this license.`,
													subscription_status: stripeSub.status,
												},
												true,
												request
											);
										}
									}
								} catch (stripeErr) {
									console.warn(`[activate-license] :warning: Could not fetch subscription from Stripe:`, stripeErr.message);
								}
							} else {
								// Subscription found in database - check status
								const now = Math.floor(Date.now() / 1000);
								const periodEnd = subRes.current_period_end || 0;

								// Check if subscription has ended
								if (periodEnd > 0 && periodEnd < now) {
									const endDate = new Date(periodEnd * 1000).toLocaleDateString();
									console.warn(`[activate-license] :warning: Subscription has ended: ${endDate}`);
									return jsonResponse(
										400,
										{
											error: 'subscription_ended',
											message: `This license key's subscription has ended on ${endDate}. Please renew your subscription to continue using this license.`,
											subscription_end_date: periodEnd,
											subscription_end_date_formatted: endDate,
										},
										true,
										request
									);
								}

								// Check if subscription is cancelled
								if (subRes.status === 'canceled' || subRes.cancel_at_period_end === 1 || subRes.cancel_at) {
									const cancelDate = subRes.cancel_at
										? new Date(subRes.cancel_at * 1000).toLocaleDateString()
										: subRes.current_period_end
										? new Date(subRes.current_period_end * 1000).toLocaleDateString()
										: 'N/A';
									console.warn(`[activate-license] :warning: Subscription is cancelled: ${cancelDate}`);
									return jsonResponse(
										400,
										{
											error: 'subscription_cancelled',
											message: `This license key's subscription has been cancelled. It will end on ${cancelDate}. Please reactivate your subscription to continue using this license.`,
											subscription_cancel_date: subRes.cancel_at || subRes.current_period_end,
											subscription_cancel_date_formatted: cancelDate,
										},
										true,
										request
									);
								}

								// Check if subscription is not active
								if (subRes.status !== 'active' && subRes.status !== 'trialing') {
									console.warn(`[activate-license] :warning: Subscription is not active: ${subRes.status}`);
									return jsonResponse(
										400,
										{
											error: 'subscription_inactive',
											message: `This license key's subscription is ${subRes.status}. Please ensure your subscription is active to use this license.`,
											subscription_status: subRes.status,
										},
										true,
										request
									);
								}
							}
						} catch (subCheckErr) {
							console.error(`[activate-license] :warning: Error checking subscription status:`, subCheckErr.message);
							// Continue with activation if subscription check fails (non-critical)
						}
					}

					// CRITICAL: Check if license is from site-based purchase (has site_domain set)
					// Site-based licenses are pre-assigned to a specific site and cannot be used for other sites
					if (licenseRes.site_domain && licenseRes.site_domain.trim() !== '') {
						const normalizedOriginalSite = licenseRes.site_domain.toLowerCase().trim();

						if (normalizedOriginalSite !== normalizedRequestedSite) {
							console.error(
								`[activate-license] :x: License ${license_key} is tied to site ${licenseRes.site_domain} and cannot be used for ${site_domain}`
							);
							return jsonResponse(
								400,
								{
									error: 'license_site_mismatch',
									message: `This license key is tied to the site "${licenseRes.site_domain}" and cannot be used for other sites. Please use the correct license key for "${site_domain}".`,
									original_site: licenseRes.site_domain,
									requested_site: site_domain,
								},
								true,
								request
							);
						}

						// Site matches - check if already activated
						if (licenseRes.used_site_domain) {
							console.log(
								`[activate-license] :information_source: License ${license_key} is already activated for site ${licenseRes.used_site_domain}`
							);
							// Site-based licenses are already "used" - return success but don't allow reuse
							return jsonResponse(
								400,
								{
									error: 'license_already_used',
									message: `This license key is already activated and tied to "${licenseRes.used_site_domain}". Site-based licenses cannot be reused or transferred.`,
									activated_site: licenseRes.used_site_domain,
								},
								true,
								request
							);
						}
					}

					// Check if license is already activated (for quantity-based purchases)
					const isAlreadyActivated = !!licenseRes.used_site_domain;

					// If already activated, prevent reuse
					if (isAlreadyActivated) {
						console.error(
							`[activate-license] :x: License ${license_key} is already activated for site ${licenseRes.used_site_domain} and cannot be reused`
						);
						return jsonResponse(
							400,
							{
								error: 'license_already_used',
								message: `This license key is already activated and used for "${licenseRes.used_site_domain}". Licenses cannot be reused or transferred to other sites.`,
								activated_site: licenseRes.used_site_domain,
							},
							true,
							request
						);
					}

					// :new: PLATFORM DETECTION - Detect platform before activation
					console.log(`[activate-license] :mag: Detecting platform for site: ${normalizedRequestedSite}`);
					const platform = await detectPlatform(normalizedRequestedSite);
					console.log(`[activate-license] :white_check_mark: Detected platform "${platform}" for ${normalizedRequestedSite}`);

					// :new: Get platform-specific KV namespace
					const kvNamespaces = getKvNamespaces(env, platform);
					const activeSitesKv = kvNamespaces.activeSitesKv;

					if (!activeSitesKv && licenseRes.subscription_id && licenseRes.customer_id) {
						console.warn(`[activate-license] :warning: No KV namespace available for platform "${platform}"`);
					}

					// First-time activation - mark as activated
					console.log(
						`[activate-license] :white_check_mark: Activating license ${license_key} for the first time with site: ${normalizedRequestedSite}, platform: ${platform}`
					);

					// Check if inactive
					if (licenseRes.status !== 'active') {
						console.warn(`[activate-license] :warning: License is not active: ${licenseRes.status}`);
						return jsonResponse(400, { error: 'inactive_license', message: 'This license is not active' }, true, request);
					}

					const timestamp = Math.floor(Date.now() / 1000);

					// Step 1: Update license with used site domain + platform (NEW COLUMN)
					const licenseUpdate = await env.DB.prepare(
						'UPDATE licenses SET used_site_domain = ?, platform = ?, updated_at = ? WHERE license_key = ?'
					)
						.bind(normalizedRequestedSite, platform, timestamp, license_key)
						.run();

						//   //insert sites table 
						// 	await env.DB.prepare(
						// 		'INSERT INTO sites (customer_id, subscription_id, site_domain, price_id, amount_paid, currency, status, renewal_date, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
						// 	).bind(
						// 		licenseRes.customer_id,licenseRes.subscription_id,normalizedRequestedSite,licenseRes.item_id,0,'usd','active',0,platform,timestamp,timestamp
						// 	).run();

					// Step 2: Update KV storage with site details (for license key activation) - PLATFORM AWARE
					if (licenseRes.subscription_id && licenseRes.customer_id && activeSitesKv) {
						console.log(`[activate-license] :floppy_disk: Updating KV storage for license key: ${license_key}, platform: ${platform}`);

						// Always clean up old KV entries before saving new one
						try {
							// 1. Delete old entry keyed by license key (always, for backward compatibility)
							try {
								const oldLicenseKeyEntry = await activeSitesKv.get(license_key);
								if (oldLicenseKeyEntry) {
									await activeSitesKv.delete(license_key);
									console.log(`[activate-license] :wastebasket: Deleted old KV entry keyed by license key: ${license_key}`);
								}
							} catch (deleteLicenseKeyErr) {
								// Entry might not exist, that's okay
								console.log(`[activate-license] :information_source: No existing KV entry found for license key: ${license_key}`);
							}

							// 2. If updating domain (not first activation), delete old domain entry
							if (isAlreadyActivated && licenseRes.used_site_domain && licenseRes.used_site_domain !== normalizedRequestedSite) {
								const oldFormattedDomain = formatSiteName(licenseRes.used_site_domain);
								if (oldFormattedDomain) {
									try {
										const oldDomainEntry = await activeSitesKv.get(oldFormattedDomain);
										if (oldDomainEntry) {
											await activeSitesKv.delete(oldFormattedDomain);
											console.log(`[activate-license] :wastebasket: Deleted old KV entry for previous domain: ${oldFormattedDomain}`);
										}
									} catch (deleteDomainErr) {
										console.warn(`[activate-license] :warning: Could not delete old domain KV entry:`, deleteDomainErr.message);
										// Non-critical, continue
									}
								}
							}
						} catch (deleteErr) {
							console.warn(`[activate-license] :warning: Error during KV cleanup:`, deleteErr.message);
							// Non-critical, continue - we'll still save the new entry
						}

						// Get subscription cancel_at_period_end status for KV storage
						let cancelAtPeriodEnd = false;
						try {
							const subDetails = await env.DB.prepare('SELECT cancel_at_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1')
								.bind(licenseRes.subscription_id)
								.first();
							if (subDetails) {
								cancelAtPeriodEnd = subDetails.cancel_at_period_end === 1;
							}
						} catch (subErr) {
							console.warn(`[activate-license] :warning: Could not fetch subscription cancel status:`, subErr.message);
						}

						// CRITICAL: Ensure site_domain is not item_id - validate it's a proper domain
						let validatedSiteDomain = normalizedRequestedSite;

						if (!normalizedRequestedSite || normalizedRequestedSite.trim() === '') {
							console.error(`[activate-license] :x: Empty site_domain provided`);
							return jsonResponse(
								400,
								{
									error: 'invalid_site_domain',
									message: 'Site domain cannot be empty.',
								},
								true,
								request
							);
						}

						// Check if site_domain is actually an item_id (Stripe item IDs start with 'si_')
						if (
							normalizedRequestedSite.startsWith('si_') ||
							normalizedRequestedSite.startsWith('item_') ||
							normalizedRequestedSite.match(/^[a-z]{2}_[a-zA-Z0-9]+$/)
						) {
							console.error(
								`[activate-license] :x: Invalid site_domain provided: "${normalizedRequestedSite}". This appears to be an item_id, not a domain name.`
							);

							// If updating and we have a previous valid domain, use that instead
							if (
								isAlreadyActivated &&
								licenseRes.used_site_domain &&
								!licenseRes.used_site_domain.startsWith('si_') &&
								!licenseRes.used_site_domain.startsWith('item_')
							) {
								console.warn(`[activate-license] :warning: Using previous valid domain: ${licenseRes.used_site_domain}`);
								validatedSiteDomain = licenseRes.used_site_domain;
							} else {
								return jsonResponse(
									400,
									{
										error: 'invalid_site_domain',
										message: `Invalid site domain provided: "${normalizedRequestedSite}". Expected a domain name (e.g., example.com), not an item ID.`,
									},
									true,
									request
								);
							}
						}

						console.log(
							`[activate-license] :white_check_mark: Using validated site domain: ${validatedSiteDomain} (original: ${normalizedRequestedSite})`
						);

						// :new: Updated saveLicenseKeyToKV with platform and dynamic KV
						await saveLicenseKeyToKVPlatform(
							activeSitesKv, // :new: Pass specific KV namespace
							license_key,
							licenseRes.customer_id,
							licenseRes.subscription_id,
							email,
							'complete', // License is active
							cancelAtPeriodEnd,
							validatedSiteDomain,
							platform // :new: Pass platform to KV payload
						);
					}

					// Step 3: Update or create site entry in sites table - WITH PLATFORM
					if (licenseRes.subscription_id && licenseRes.customer_id) {
						// Check if site already exists
						const existingSite = await env.DB.prepare(
							'SELECT id, site_domain, status FROM sites WHERE customer_id = ? AND site_domain = ? LIMIT 1'
						)
							.bind(licenseRes.customer_id, normalizedRequestedSite)
							.first();

						if (existingSite) {
							// Update existing site entry

							// Get subscription details for renewal date
							let renewalDate = null;
							if (licenseRes.subscription_id) {
								try {
									const subDetails = await env.DB.prepare('SELECT current_period_end FROM subscriptions WHERE subscription_id = ? LIMIT 1')
										.bind(licenseRes.subscription_id)
										.first();
									if (subDetails && subDetails.current_period_end) {
										renewalDate = subDetails.current_period_end;
									}
								} catch (subErr) {
									console.warn(`[activate-license] :warning: Could not fetch subscription details:`, subErr.message);
								}
							}

							await env.DB.prepare(
								'UPDATE sites SET status = ?, updated_at = ?, renewal_date = ?, platform = ? WHERE customer_id = ? AND site_domain = ?'
							)
								.bind('active', timestamp, renewalDate, platform, licenseRes.customer_id, normalizedRequestedSite)
								.run();
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
									)
										.bind(licenseRes.subscription_id)
										.first();

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
												console.warn(`[activate-license] :warning: Could not fetch price details:`, priceErr.message);
											}
										}
									}
								} catch (subErr) {
									console.warn(`[activate-license] :warning: Could not fetch subscription details:`, subErr.message);
								}
							}

							await env.DB.prepare(
								'INSERT INTO sites (customer_id, subscription_id, site_domain, price_id, amount_paid, currency, status, renewal_date, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
							)
								.bind(
									licenseRes.customer_id,
									licenseRes.subscription_id,
									normalizedRequestedSite,
									priceId,
									amountPaid,
									'usd',
									'active',
									renewalDate,
									platform,
									timestamp,
									timestamp
								)
								.run();
						}
					} else {
						console.warn(`[activate-license] :warning: Missing subscription_id or customer_id, skipping sites table update`);
					}

					// Step 4: Update user object sites if available
					if (email && env.KV) {
						try {
							const user = await getUserByEmail(env, email);
							if (user && licenseRes.subscription_id) {
								if (!user.sites) user.sites = {};
								user.sites[normalizedRequestedSite] = {
									subscriptionId: licenseRes.subscription_id,
									site: normalizedRequestedSite,
									status: 'active',
									licenseKey: license_key,
									platform: platform, // :new: Add platform
									updatedAt: timestamp,
								};
								await saveUserByEmail(env, email, user);
							}
						} catch (userErr) {
							console.warn(`[activate-license] :warning: Could not update user object:`, userErr.message);
							// Non-critical, continue
						}
					}

					const actionText = isAlreadyActivated ? 'updated' : 'activated';
					const message = isAlreadyActivated
						? `License site domain updated successfully from ${licenseRes.used_site_domain} to ${normalizedRequestedSite}`
						: `License activated successfully for ${normalizedRequestedSite}`;

					return jsonResponse(
						200,
						{
							success: true,
							message: message,
							license_key: license_key,
							site_domain: normalizedRequestedSite,
							platform: platform, // :new: Include in response
							previous_site: isAlreadyActivated ? licenseRes.used_site_domain : null,
							status: 'used',
							is_used: true,
							is_activated: true,
							was_update: isAlreadyActivated,
						},
						true,
						request
					);
				} catch (error) {
					console.error('[activate-license] :x: Error:', error);
					console.error('[activate-license] :x: Error stack:', error.stack);
					return jsonResponse(500, { error: 'activation_failed', message: error.message }, true, request);
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
		const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

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

		const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signedPayload));

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
		return new Uint8Array(hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
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
			const getRes = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
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
				}

				// Find member with EXACT email match (case-insensitive)
				const searchEmailLower = email.toLowerCase().trim();
				let foundMember = null;

				for (const member of membersArray) {
					// Check all possible email locations (same as getMemberstackMember)
					const memberEmail =
						member.auth?.email || member.email || member._email || member.data?.email || member.data?._email || member.data?.auth?.email;
					const memberEmailLower = memberEmail ? memberEmail.toLowerCase().trim() : null;

					if (memberEmailLower && memberEmailLower === searchEmailLower) {
						foundMember = member;
						console.log(
							`[createMemberstackMember] ✅ Found exact email match: id=${foundMember.id || foundMember._id || 'N/A'}, email=${memberEmail}`
						);
						break; // Found exact match, stop searching
					}
				}

				if (foundMember) {
					// Verify we can extract a valid email from the member
					const memberEmail =
						foundMember.auth?.email || foundMember.email || foundMember._email || foundMember.data?.email || foundMember.data?._email;
					const memberId = foundMember.id || foundMember._id || foundMember.data?.id || foundMember.data?._id || 'N/A';

					// Only return member if we have a valid email that matches
					if (memberEmail && memberEmail.toLowerCase().trim() === searchEmailLower) {
						console.log(`[createMemberstackMember] ✅ Returning existing member: id=${memberId}, email=${memberEmail}`);
						return foundMember;
					} else {
						console.log(
							`[createMemberstackMember] ⚠️ Member found but email extraction failed or doesn't match: extracted=${
								memberEmail || 'N/A'
							}, searching=${searchEmailLower}`
						);
						console.log(`[createMemberstackMember] ⚠️ Will create new member instead`);
						// Don't return - continue to create new member
					}
				} else if (membersArray.length > 0) {
					// Found members but none match the exact email
					const firstMemberEmail = membersArray[0].email || membersArray[0]._email || 'N/A';

					// Don't return - continue to create new member
				}
			} else {
				// GET request failed - log for debugging
				const errorText = await getRes.text();
				console.error(`[getMemberstackMember] ❌ GET member failed (${getRes.status}): ${errorText}`);

				// If it's a 401 error, the secret key is invalid
				if (getRes.status === 401) {
					console.error(`[getMemberstackMember] ❌ CRITICAL: Invalid Memberstack secret key!`);
					console.error(`[getMemberstackMember] ❌ Please update MEMBERSTACK_SECRET_KEY in Cloudflare`);
					throw new Error(`Invalid Memberstack secret key: ${errorText}`);
				}
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
		console.log(`[createMemberstackMember] 🆕 Creating new Memberstack member for email: ${email}`);
		const createMemberPayload = {
			email: email,
			password: generateRandomPassword(), // Generate a secure random password (user will use magic link to login)
			loginRedirect: env.MEMBERSTACK_REDIRECT_URL || 'https://dashboard.consentbit.com/dashboard',
		};

		// Add plans array only if plan ID is configured (matches example format)
		if (env.MEMBERSTACK_PLAN_ID) {
			createMemberPayload.plans = [{ planId: env.MEMBERSTACK_PLAN_ID }];
			console.log(`[createMemberstackMember] 📋 Plan will be assigned: ${env.MEMBERSTACK_PLAN_ID}`);
		} else {
			console.log(`[createMemberstackMember] ℹ️ No plan ID configured - member will be created without plan`);
		}

		console.log(`[createMemberstackMember] 📤 Sending POST request to Memberstack API...`);

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
			console.error(`[createMemberstackMember] ❌ Member creation failed (${res.status}): ${errorText}`);

			// 401 Unauthorized means invalid API key
			if (res.status === 401) {
				console.error(`[createMemberstackMember] ❌ CRITICAL: Invalid Memberstack secret key!`);
				console.error(`[createMemberstackMember] ❌ Please update MEMBERSTACK_SECRET_KEY in Cloudflare`);
				throw new Error(`Invalid Memberstack secret key: ${errorText}`);
			}

			// 409 Conflict means member already exists - try to fetch again
			if (res.status === 409) {
				console.log(`[createMemberstackMember] ⚠️ Member already exists (409), fetching existing member...`);

				// Retry fetching the member with exact email match
				const retryRes = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
					method: 'GET',
					headers: {
						'X-API-KEY': apiKey,
						'Content-Type': 'application/json',
					},
				});
				if (retryRes.ok) {
					const members = await retryRes.json();
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
						// Check all possible email locations
						const memberEmail =
							member.auth?.email || member.email || member._email || member.data?.email || member.data?._email || member.data?.auth?.email;
						const memberEmailLower = memberEmail ? memberEmail.toLowerCase().trim() : null;

						if (memberEmailLower && memberEmailLower === searchEmailLower) {
							foundMember = member;
							console.log(
								`[createMemberstackMember] ✅ Found exact email match in retry: id=${
									foundMember.id || foundMember._id || 'N/A'
								}, email=${memberEmail}`
							);
							break; // Found exact match, stop searching
						}
					}

					if (foundMember) {
						// Verify we can extract a valid email from the member
						const memberEmail =
							foundMember.auth?.email || foundMember.email || foundMember._email || foundMember.data?.email || foundMember.data?._email;
						const memberId = foundMember.id || foundMember._id || foundMember.data?.id || foundMember.data?._id || 'N/A';

						if (memberEmail && memberEmail.toLowerCase().trim() === searchEmailLower) {
							console.log(`[createMemberstackMember] ✅ Returning existing member from 409 retry: id=${memberId}, email=${memberEmail}`);
							return foundMember;
						} else {
							console.log(
								`[createMemberstackMember] ⚠️ Member found in retry but email doesn't match: extracted=${
									memberEmail || 'N/A'
								}, searching=${searchEmailLower}`
							);
						}
					} else {
						console.log(
							`[createMemberstackMember] ⚠️ No exact email match found in retry response (found ${membersArray.length} member(s))`
						);
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

		console.log(`[createMemberstackMember] ✅ Successfully created Memberstack member:`, {
			id: newMemberId,
			email: newMemberEmail,
			has_plan: !!(createdMemberData.plans && createdMemberData.plans.length > 0),
		});

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
		console.log(`[getMemberstackMember] 🔍 Starting member lookup for email: ${email}`);

		if (!env.MEMBERSTACK_SECRET_KEY) {
			console.log(`[getMemberstackMember] ⚠️ MEMBERSTACK_SECRET_KEY not configured`);
			return null;
		}

		const apiKey = env.MEMBERSTACK_SECRET_KEY.trim();

		if (!apiKey || apiKey.length < 10) {
			console.log(`[getMemberstackMember] ⚠️ API key appears invalid (length: ${apiKey.length})`);
			return null;
		}

		const normalizedEmail = email.toLowerCase().trim();
		const apiUrl = `https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`;
		console.log(`[getMemberstackMember] 📤 Sending GET request to: ${apiUrl}`);

		try {
			const getRes = await fetch(apiUrl, {
				method: 'GET',
				headers: {
					'X-API-KEY': apiKey,
					'Content-Type': 'application/json',
				},
			});

			console.log(`[getMemberstackMember] 📥 Response status: ${getRes.status}`);

			if (getRes.ok) {
				const members = await getRes.json();
				console.log(`[getMemberstackMember] 📦 Response received, parsing members...`);

				let membersArray = [];

				// Normalize response to array
				if (Array.isArray(members)) {
					membersArray = members;
					console.log(`[getMemberstackMember] 📋 Found ${membersArray.length} member(s) in array format`);
				} else if (members.data && Array.isArray(members.data)) {
					membersArray = members.data;
					console.log(`[getMemberstackMember] 📋 Found ${membersArray.length} member(s) in data.array format`);
				} else {
					console.log(`[getMemberstackMember] ⚠️ Unexpected response format:`, Object.keys(members));
				}

				// Find member with EXACT email match (case-insensitive)
				const searchEmailLower = normalizedEmail;
				let foundMember = null;
				console.log(`[getMemberstackMember] 🔍 Searching for exact email match: ${searchEmailLower}`);

				for (const member of membersArray) {
					// Check auth.email first (Memberstack API structure)
					const memberEmail =
						member.auth?.email || member.email || member._email || member.data?.email || member.data?._email || member.data?.auth?.email;
					const memberEmailLower = memberEmail ? memberEmail.toLowerCase().trim() : null;

					console.log(
						`[getMemberstackMember] 🔍 Checking member: email=${memberEmailLower || 'N/A'}, id=${member.id || member._id || 'N/A'}`
					);

					if (memberEmailLower && memberEmailLower === searchEmailLower) {
						foundMember = member;
						console.log(`[getMemberstackMember] ✅ Found exact email match!`);
						break; // Found exact match, stop searching
					}
				}

				if (foundMember) {
					// Verify we can extract a valid email from the member
					const memberEmail =
						foundMember.auth?.email || foundMember.email || foundMember._email || foundMember.data?.email || foundMember.data?._email;
					const memberId = foundMember.id || foundMember._id || foundMember.data?.id || foundMember.data?._id || 'N/A';

					// Only return member if we have a valid email that matches
					if (memberEmail && memberEmail.toLowerCase().trim() === searchEmailLower) {
						console.log(`[getMemberstackMember] ✅ Returning existing member: id=${memberId}, email=${memberEmail}`);
						return foundMember;
					} else {
						console.log(
							`[getMemberstackMember] ⚠️ Member found but email extraction failed or doesn't match: extracted=${
								memberEmail || 'N/A'
							}, searching=${searchEmailLower}`
						);
						console.log(`[getMemberstackMember] ⚠️ Treating as no member found - will create new member`);
						return null;
					}
				} else if (membersArray.length > 0) {
					// Found members but none match the exact email
					const firstMemberEmail = membersArray[0].email || membersArray[0]._email || membersArray[0].data?.email || 'N/A';
					console.log(
						`[getMemberstackMember] ⚠️ Found ${membersArray.length} member(s) but none match email ${searchEmailLower}. First member email: ${firstMemberEmail}`
					);
					return null;
				} else {
					console.log(`[getMemberstackMember] ℹ️ No members found for email: ${searchEmailLower}`);
					return null;
				}
			} else {
				// GET request failed - log for debugging
				const errorText = await getRes.text();
				console.error(`[getMemberstackMember] ❌ GET member failed (${getRes.status}): ${errorText}`);

				// If it's a 401 error, the secret key is invalid
				if (getRes.status === 401) {
					console.error(`[getMemberstackMember] ❌ CRITICAL: Invalid Memberstack secret key!`);
					console.error(`[getMemberstackMember] ❌ Please update MEMBERSTACK_SECRET_KEY in Cloudflare`);
					throw new Error(`Invalid Memberstack secret key: ${errorText}`);
				}
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
		const res = await fetch(`https://admin.memberstack.com/members/${memberId}/plans`, {
			method: 'POST',
			headers: {
				'X-API-KEY': apiKey,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				planId: env.MEMBERSTACK_PLAN_ID,
			}),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Plan assignment failed: ${res.status} ${errorText}`);
		}

		return await res.json();
	},
};
