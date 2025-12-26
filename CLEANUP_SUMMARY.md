# Codebase Cleanup Summary

## Endpoints to KEEP (Required for Sites, Subscriptions, Quantity Purchase)
1. ✅ `/webhook` - Stripe webhook handler (CRITICAL)
2. ✅ `/dashboard` - Get dashboard data (sites, subscriptions)
3. ✅ `/add-sites-batch` - Add sites to pending list
4. ✅ `/create-checkout-from-pending` - Create checkout for pending sites
5. ✅ `/remove-site` - Remove/unsubscribe site
6. ✅ `/purchase-quantity` - Quantity-based purchase
7. ✅ `/licenses` - Get licenses
8. ✅ `/activate-license` - Activate license
9. ✅ `/deactivate-license` - Deactivate license
10. ✅ `/memberstack-webhook` - Memberstack integration (KEEP - user requirement)

## Endpoints to REMOVE
1. ❌ `/create-checkout-session` - Old endpoint (replaced by `/create-checkout-from-pending`)
2. ❌ `/magic-link` - Not needed (Memberstack handles login)
3. ❌ `/request-magic-link` - Not needed
4. ❌ `/magic-link-handler` - Not needed
5. ❌ `/auth/callback` - Not needed
6. ❌ `/add-site` - Replaced by `/add-sites-batch`
7. ❌ `/get-magic-link` - Not needed
8. ❌ `/remove-pending-site` - Can be handled in frontend
9. ❌ `/success.html` - Not needed
10. ❌ `/dashboard.html` - Not needed
11. ❌ `/generate-missing-licenses` - Utility endpoint (can remove)
12. ❌ `/test-memberstack-link` - Test endpoint (remove)

## Tables to KEEP
- ✅ `users` - User data
- ✅ `customers` - Customer data
- ✅ `subscriptions` - Subscription data
- ✅ `subscription_items` - Subscription items
- ✅ `pending_sites` - Pending sites
- ✅ `licenses` - License keys
- ✅ `sites` - Site details
- ✅ `payments` - Payment records
- ✅ `idempotency_keys` - Webhook idempotency

## Tables to REMOVE
- ❌ `magic_link_tokens` - Not needed (Memberstack handles login)

## Functions to KEEP
- ✅ `getCorsHeaders` - CORS handling
- ✅ `jsonResponse` - Response helper
- ✅ `stripeFetch` - Stripe API calls
- ✅ `getUserByEmail` - Get user data
- ✅ `saveUserByEmail` - Save user data
- ✅ `getLicenseForSite` - Get license
- ✅ `getLicensesForSites` - Get multiple licenses
- ✅ `generateLicenseKey` - Generate license key
- ✅ `generateLicenseKeys` - Generate multiple keys
- ✅ `getCustomerEmail` - Get customer email
- ✅ `addOrUpdateCustomerInUser` - Update customer
- ✅ `saveOrUpdateSiteInDB` - Save site
- ✅ Memberstack functions (KEEP - user requirement):
  - `createMemberstackMember`
  - `getMemberstackMember`
  - `assignMemberstackPlan`
  - `verifyStripeWebhookForMemberstack`
  - `hexToBytesForMemberstack`

## Functions to REMOVE
- ❌ `generateRandomPassword` - Only used by memberstack (KEEP if needed)
- ❌ `signToken` - Not needed (Memberstack handles auth)
- ❌ `verifyToken` - Not needed (Memberstack handles auth)
- ❌ `sendEmail` - Not needed (Memberstack handles emails)
- ❌ Magic link related functions (all of them)

