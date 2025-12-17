# Testing Guide for Stripe Checkout Integration

This guide covers multiple ways to test your Stripe checkout integration.

## Prerequisites

1. **Stripe Test Mode**: Make sure you're using Stripe test mode
   - Go to Stripe Dashboard → Toggle "Test mode" ON
   - Get your test API keys from: https://dashboard.stripe.com/test/apikeys

2. **Test Price ID**: Create a test price in Stripe
   - Go to Products → Create Product → Add Price
   - Copy the Price ID (starts with `price_`)
   - Example: `price_1234567890abcdef`

3. **API Endpoint**: Your API is at:
   ```
   https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session
   ```

---

## Method 1: Test with Postman (API Testing)

### Step 1: Set up Postman Request

1. Open Postman
2. Create a new **POST** request
3. URL: `https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session`
4. Headers:
   ```
   Content-Type: application/json
   ```

### Step 2: Request Body

```json
{
  "customerEmail": "test@example.com",
  "sites": [
    {
      "site": "example.com",
      "price": "price_1234567890abcdef",
      "quantity": 1
    }
  ],
  "success_url": "https://example.com/success",
  "cancel_url": "https://example.com/cancel"
}
```

**Replace `price_1234567890abcdef` with your actual test Price ID**

### Step 3: Send Request

You should get a response like:
```json
{
  "sessionId": "cs_test_...",
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

### Step 4: Test Checkout

1. Copy the `url` from the response
2. Paste it in your browser
3. You should see the Stripe checkout page
4. Use Stripe test card: `4242 4242 4242 4242`
5. Any future expiry date (e.g., 12/34)
6. Any 3-digit CVC (e.g., 123)
7. Any ZIP code (e.g., 12345)

---

## Method 2: Test Locally with HTML File

### Step 1: Open the Example File

1. Open `webflow-integration-example.html` in your browser
2. Or serve it with a local server:
   ```bash
   # Using Python
   python -m http.server 8000
   
   # Using Node.js (if you have http-server installed)
   npx http-server
   ```

### Step 2: Update the HTML File

1. Open `webflow-integration-example.html`
2. Find the hidden input with `data-price`
3. Replace `price_xxxxx` with your actual test Price ID:
   ```html
   <input type="hidden" data-site="example.com" data-price="price_1234567890abcdef" />
   ```

### Step 3: Test the Form

1. Enter an email address
2. Click "Proceed to Checkout"
3. You should be redirected to Stripe checkout
4. Complete the test payment

---

## Method 3: Test with cURL (Command Line)

### Windows PowerShell:
```powershell
$body = @{
    customerEmail = "test@example.com"
    sites = @(
        @{
            site = "example.com"
            price = "price_1234567890abcdef"
            quantity = 1
        }
    )
    success_url = "https://example.com/success"
    cancel_url = "https://example.com/cancel"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session" -Method Post -Body $body -ContentType "application/json"
```

### Mac/Linux Terminal:
```bash
curl -X POST https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session \
  -H "Content-Type: application/json" \
  -d '{
    "customerEmail": "test@example.com",
    "sites": [
      {
        "site": "example.com",
        "price": "price_1234567890abcdef",
        "quantity": 1
      }
    ],
    "success_url": "https://example.com/success",
    "cancel_url": "https://example.com/cancel"
  }'
```

Then copy the `url` from the response and open it in your browser.

---

## Method 4: Test in Webflow

### Step 1: Add the JavaScript Code

1. In Webflow Designer, select your page
2. Go to **Page Settings** (gear icon)
3. Click **Custom Code** tab
4. Paste the code from `webflow-integration.js` into **Footer Code**
5. The API URL is already configured

### Step 2: Create a Form

1. Add a **Form Block** to your page
2. Add an **Email Input** field
3. Set the email input ID to: `customer-email`
4. Add a **Submit Button**
5. Set the button ID to: `checkout-btn`
6. Set the form ID to: `checkout-form`

### Step 3: Add Hidden Inputs (Custom Code)

1. Add an **Embed** element inside your form
2. Add this HTML (replace with your Price ID):
   ```html
   <input type="hidden" data-site="example.com" data-price="price_1234567890abcdef" />
   ```

### Step 4: Test

1. Publish your site (or use Webflow's preview)
2. Fill in the email field
3. Click the submit button
4. You should be redirected to Stripe checkout

---

## Method 5: Browser Console Test

### Step 1: Open Browser Console

1. Open your Webflow site (or any page with the integration script)
2. Press `F12` to open Developer Tools
3. Go to the **Console** tab

### Step 2: Call the Function Directly

```javascript
createCheckoutSession({
  customerEmail: 'test@example.com',
  sites: [
    { site: 'example.com', price: 'price_1234567890abcdef', quantity: 1 }
  ],
  success_url: 'https://example.com/success',
  cancel_url: 'https://example.com/cancel'
});
```

This will immediately redirect you to Stripe checkout.

---

## Stripe Test Cards

Use these test card numbers in Stripe checkout:

| Card Number | Description |
|------------|-------------|
| `4242 4242 4242 4242` | Visa (Success) |
| `4000 0000 0000 0002` | Visa (Card Declined) |
| `4000 0000 0000 9995` | Visa (Insufficient Funds) |
| `5555 5555 5555 4444` | Mastercard (Success) |

**For all test cards:**
- Expiry: Any future date (e.g., 12/34)
- CVC: Any 3 digits (e.g., 123)
- ZIP: Any 5 digits (e.g., 12345)

---

## Common Issues & Solutions

### Issue: "Missing customerEmail or sites" error

**Solution:**
- Make sure the email field has ID `customer-email`
- Ensure hidden inputs have `data-site` and `data-price` attributes
- Check browser console for errors

### Issue: CORS error

**Solution:**
- The API already has CORS headers configured
- If you still see CORS errors, check that you're using the correct API URL
- Make sure you're testing from a web page (not file://)

### Issue: "Invalid price" error

**Solution:**
- Verify your Price ID is correct
- Make sure you're using a test Price ID (not live)
- Check that the price exists in your Stripe dashboard

### Issue: Checkout page doesn't open

**Solution:**
- Check browser console for JavaScript errors
- Verify the API response contains a `url` field
- Make sure pop-up blockers aren't blocking the redirect
- Try copying the URL manually and opening it in a new tab

### Issue: API returns 500 error

**Solution:**
- Check Cloudflare Worker logs
- Verify `STRIPE_SECRET_KEY` is set in your Worker environment
- Make sure you're using a valid Stripe secret key (test mode)

---

## Testing Checklist

- [ ] API endpoint responds with 200 status
- [ ] Response contains `sessionId` and `url`
- [ ] Checkout URL opens in browser
- [ ] Can enter test card details
- [ ] Payment succeeds with test card
- [ ] Redirects to success URL after payment
- [ ] Can cancel and redirects to cancel URL
- [ ] Webhook receives `checkout.session.completed` event (if configured)

---

## Next Steps After Testing

1. **Switch to Live Mode**: When ready for production
   - Update Stripe keys to live keys
   - Use live Price IDs
   - Test with real (small) transactions first

2. **Set up Webhooks**: Configure webhook endpoint
   - URL: `https://consentbit-dashboard.web-8fb.workers.dev/webhook`
   - Events to listen for: `checkout.session.completed`

3. **Customize Success/Cancel Pages**: Create proper landing pages

4. **Add Error Handling**: Customize error messages for users

---

## Quick Test Script

Save this as `test.html` and open in browser:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Quick Test</title>
</head>
<body>
    <h1>Stripe Checkout Test</h1>
    <button onclick="testCheckout()">Test Checkout</button>
    
    <script>
        async function testCheckout() {
            const response = await fetch('https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerEmail: 'test@example.com',
                    sites: [
                        { site: 'example.com', price: 'price_1234567890abcdef', quantity: 1 }
                    ],
                    success_url: window.location.href + '?success',
                    cancel_url: window.location.href + '?cancel'
                })
            });
            
            const data = await response.json();
            if (data.url) {
                window.location.href = data.url;
            } else {
                alert('Error: ' + JSON.stringify(data));
            }
        }
    </script>
</body>
</html>
```

**Remember to replace `price_1234567890abcdef` with your actual test Price ID!**

