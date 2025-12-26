# Activate License API - All Response Types

## Endpoint: `POST /activate-license`

### Request Body
```json
{
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.example.com",
  "email": "user@example.com"  // Optional
}
```

---

## Response Types

### 1. ✅ Success - License Activated (New Activation)

**Status Code:** `200 OK`

**Response:**
```json
{
  "success": true,
  "message": "License activated successfully",
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.example.com",
  "previous_site": null,
  "status": "used",
  "is_used": true,
  "was_update": false
}
```

**When:** License was successfully activated for the first time.

---

### 2. ✅ Success - License Site Updated

**Status Code:** `200 OK`

**Response:**
```json
{
  "success": true,
  "message": "License site updated successfully from www.old-site.com to www.new-site.com",
  "license_key": "KEY-XXXX-XXXX-XXXX",
  "site_domain": "www.new-site.com",
  "previous_site": "www.old-site.com",
  "status": "used",
  "is_used": true,
  "was_update": true
}
```

**When:** License was already used and site domain was successfully updated.

---

### 3. ❌ Error - License Key Not Found

**Status Code:** `404 Not Found`

**Response:**
```json
{
  "error": "license_not_found",
  "message": "License key not found. Please check the license key and try again."
}
```

**When:** The provided license key does not exist in the database.

**Frontend Handling:** Shows error message to user.

---

### 4. ❌ Error - Unauthorized (License Doesn't Belong to User)

**Status Code:** `403 Forbidden`

**Response:**
```json
{
  "error": "unauthorized",
  "message": "This license key does not belong to your account"
}
```

**When:** The license key exists but belongs to a different customer/user.

**Frontend Handling:** Shows error message asking user to verify the license key.

---

### 5. ❌ Error - Subscription Ended

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "error": "subscription_ended",
  "message": "This license key's subscription has ended on 12/25/2025. Please renew your subscription to continue using this license.",
  "subscription_end_date": 1767304777,
  "subscription_end_date_formatted": "12/25/2025"
}
```

**When:** The subscription associated with the license has ended (`current_period_end < now`).

**Frontend Handling:** Shows error with end date and suggests renewing subscription.

---

### 6. ❌ Error - Subscription Cancelled

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "error": "subscription_cancelled",
  "message": "This license key's subscription has been cancelled. It will end on 12/25/2025. Please reactivate your subscription to continue using this license.",
  "subscription_cancel_date": 1767304777,
  "subscription_cancel_date_formatted": "12/25/2025"
}
```

**When:** The subscription is cancelled (`status === 'canceled'`, `cancel_at_period_end === true`, or `canceled_at` is set).

**Frontend Handling:** Shows error with cancellation date and suggests reactivating subscription.

---

### 7. ❌ Error - Subscription Inactive

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "error": "subscription_inactive",
  "message": "This license key's subscription is past_due. Please ensure your subscription is active to use this license.",
  "subscription_status": "past_due"
}
```

**When:** The subscription status is not `'active'` or `'trialing'` (e.g., `'past_due'`, `'unpaid'`, `'incomplete'`, etc.).

**Frontend Handling:** Shows error with subscription status and suggests ensuring subscription is active.

---

### 8. ❌ Error - License Inactive

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "error": "inactive_license",
  "message": "This license is not active"
}
```

**When:** The license status in the database is not `'active'` (e.g., `'inactive'`).

**Frontend Handling:** Shows error message.

---

### 9. ❌ Error - Missing Required Fields

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "error": "missing_fields",
  "message": "license_key and site_domain are required"
}
```

**When:** Request body is missing `license_key` or `site_domain`.

**Frontend Handling:** Should not happen if frontend validates, but shows error if it does.

---

### 10. ❌ Error - Unauthenticated

**Status Code:** `401 Unauthorized`

**Response:**
```json
{
  "error": "unauthenticated",
  "message": "No email or session provided"
}
```

**When:** No email parameter provided and no valid session cookie found.

**Frontend Handling:** Redirects to login or shows authentication error.

---

### 11. ❌ Error - Invalid Session

**Status Code:** `401 Unauthorized`

**Response:**
```json
{
  "error": "invalid_session",
  "message": "Invalid or expired session"
}
```

**When:** Session cookie exists but is invalid or expired.

**Frontend Handling:** Redirects to login.

---

### 12. ❌ Error - Database Not Configured

**Status Code:** `500 Internal Server Error`

**Response:**
```json
{
  "error": "database_not_configured",
  "message": "Database is not available"
}
```

**When:** D1 database is not configured or not available.

**Frontend Handling:** Shows system error message.

---

### 13. ❌ Error - Activation Failed (General)

**Status Code:** `500 Internal Server Error`

**Response:**
```json
{
  "error": "activation_failed",
  "message": "Error message describing what went wrong"
}
```

**When:** An unexpected error occurred during activation (database error, Stripe API error, etc.).

**Frontend Handling:** Shows error message to user.

---

## Response Summary Table

| Status Code | Error Code | Description |
|------------|------------|-------------|
| 200 | - | Success - License activated |
| 200 | - | Success - License site updated |
| 404 | `license_not_found` | License key doesn't exist |
| 403 | `unauthorized` | License doesn't belong to user |
| 400 | `subscription_ended` | Subscription has ended |
| 400 | `subscription_cancelled` | Subscription is cancelled |
| 400 | `subscription_inactive` | Subscription is not active/trialing |
| 400 | `inactive_license` | License status is not active |
| 400 | `missing_fields` | Missing required fields |
| 401 | `unauthenticated` | No email or session |
| 401 | `invalid_session` | Invalid/expired session |
| 500 | `database_not_configured` | Database unavailable |
| 500 | `activation_failed` | General activation error |

---

## Frontend Error Handling Example

```javascript
try {
  const response = await fetch(`${API_BASE}/activate-license`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: key,
      site_domain: siteDomain.trim(),
      email: currentUserEmail
    })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    // Handle specific error types
    let errorMessage = data.message || 'Failed to activate license';
    
    switch (data.error) {
      case 'license_not_found':
        errorMessage = 'License key not found. Please check the license key and try again.';
        break;
      case 'subscription_ended':
        errorMessage = `This license key's subscription has ended on ${data.subscription_end_date_formatted}. Please renew your subscription.`;
        break;
      case 'subscription_cancelled':
        errorMessage = `This license key's subscription has been cancelled. It will end on ${data.subscription_cancel_date_formatted}. Please reactivate your subscription.`;
        break;
      case 'subscription_inactive':
        errorMessage = `This license key's subscription is ${data.subscription_status}. Please ensure your subscription is active.`;
        break;
      case 'inactive_license':
        errorMessage = 'This license is not active.';
        break;
      case 'unauthorized':
        errorMessage = 'This license key does not belong to your account.';
        break;
      case 'unauthenticated':
      case 'invalid_session':
        // Redirect to login
        window.location.href = '/login';
        return;
      default:
        errorMessage = data.message || 'Failed to activate license';
    }
    
    showError(errorMessage);
    return;
  }
  
  // Success
  showSuccess(data.message);
  reloadLicenses();
  
} catch (error) {
  showError('Network error: ' + error.message);
}
```

---

## Notes

1. **Success Responses:** Always include `success: true` and `is_used: true`
2. **Update vs Activation:** Check `was_update` field to distinguish between new activation and site update
3. **Date Formats:** All dates are provided in both Unix timestamp and formatted string
4. **Error Messages:** All error messages are user-friendly and actionable
5. **Subscription Validation:** Checks both database and Stripe API for most up-to-date status

