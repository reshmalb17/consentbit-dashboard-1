/*
 * Stripe → Memberstack Webhook Handler
 * 
 * This Cloudflare Worker handles Stripe checkout.session.completed webhooks
 * and automatically:
 * 1. Creates/updates Memberstack users
 * 2. Assigns a plan to the user
 * 3. Sends a magic login link
 * 
 * Environment Variables Required:
 * - STRIPE_SECRET_KEY (Secret)
 * - STRIPE_WEBHOOK_SECRET (Secret)
 * - MEMBERSTACK_SECRET_KEY (Secret)
 * - MEMBERSTACK_PLAN_ID (Variable)
 */

export default {
  async fetch(req, env) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const sig = req.headers.get("stripe-signature");
    const body = await req.text();

    // Verify Stripe webhook
    let event;
    try {
      event = await verifyStripeWebhook(
        body,
        sig,
        env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook verification failed:", error);
      return new Response("Invalid signature", { status: 401 });
    }

    if (event.type !== "checkout.session.completed") {
      return new Response("Ignored", { status: 200 });
    }

    const session = event.data.object;
    const email = session.customer_details?.email;

    if (!email) {
      return new Response("Email missing", { status: 400 });
    }

    try {
      // 1️⃣ Create or get Memberstack user
      const member = await createMember(email, env);

      // 2️⃣ Assign plan
      await assignPlan(member.id, env);

      // 3️⃣ Send magic login link
      await sendMagicLink(email, env);

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error processing webhook:", error);
      // Still return 200 to prevent Stripe retries
      // Log error for manual investigation
      return new Response("Error processed", { status: 200 });
    }
  },
};

/* ---------------- HELPERS ---------------- */

/**
 * Creates a Memberstack member or returns existing member
 * @param {string} email - User email
 * @param {object} env - Environment variables
 * @returns {Promise<object>} Member object with id
 */
async function createMember(email, env) {
  // First, try to get existing member by email
  try {
    const getRes = await fetch(
      `https://api.memberstack.com/v1/members?email=${encodeURIComponent(email)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.MEMBERSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (getRes.ok) {
      const members = await getRes.json();
      // If members array is returned and has items, return the first one
      if (Array.isArray(members) && members.length > 0) {
        return members[0];
      }
      // If members is an object with data array
      if (members.data && Array.isArray(members.data) && members.data.length > 0) {
        return members.data[0];
      }
    }
  } catch (error) {
    // If GET fails, try to create (member might not exist)
  }

  // Member doesn't exist, create it
  const res = await fetch("https://api.memberstack.com/v1/members", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MEMBERSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    // 409 Conflict means member already exists - try to fetch again
    if (res.status === 409) {
      // Retry fetching the member
      const retryRes = await fetch(
        `https://api.memberstack.com/v1/members?email=${encodeURIComponent(email)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.MEMBERSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
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
  // Handle different response formats
  return newMember.data || newMember;
}

/**
 * Assigns a plan to a Memberstack member
 * @param {string} memberId - Memberstack member ID
 * @param {object} env - Environment variables
 */
async function assignPlan(memberId, env) {
  const res = await fetch(
    `https://api.memberstack.com/v1/members/${memberId}/plans`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MEMBERSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
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

/**
 * Sends a magic login link to the user
 * @param {string} email - User email
 * @param {object} env - Environment variables
 */
async function sendMagicLink(email, env) {
  const res = await fetch("https://api.memberstack.com/v1/members/magic-link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MEMBERSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      redirect: env.MEMBERSTACK_REDIRECT_URL || "https://yourdomain.com/dashboard",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Magic link send failed: ${res.status} ${errorText}`);
  }

  return await res.json();
}

/**
 * Verifies Stripe webhook signature using HMAC-SHA256
 * @param {string} payload - Raw webhook payload
 * @param {string} sigHeader - Stripe signature header
 * @param {string} secret - Webhook signing secret
 * @returns {Promise<object>} Parsed event object
 */
async function verifyStripeWebhook(payload, sigHeader, secret) {
  if (!sigHeader || !secret) {
    throw new Error("Missing signature or secret");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // Parse signature header: "t=timestamp,v1=signature"
  const parts = sigHeader.split(",");
  let timestamp;
  let signature;

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signature = value;
    }
  }

  if (!timestamp || !signature) {
    throw new Error("Invalid signature format");
  }

  const signedPayload = `${timestamp}.${payload}`;

  // Convert hex signature to bytes
  const signatureBytes = hexToBytes(signature);

  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(signedPayload)
  );

  if (!isValid) {
    throw new Error("Invalid signature");
  }

  return JSON.parse(payload);
}

/**
 * Converts hex string to Uint8Array
 * @param {string} hex - Hex string
 * @returns {Uint8Array} Byte array
 */
function hexToBytes(hex) {
  return new Uint8Array(
    hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
  );
}

