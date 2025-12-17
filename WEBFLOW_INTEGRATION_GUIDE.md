# Webflow Stripe Checkout Integration Guide

This guide explains how to integrate the Stripe checkout API into your Webflow site.

## Quick Start

### Step 1: Add the JavaScript Code

1. In Webflow, go to your page settings
2. Navigate to **Custom Code** tab
3. Paste the code from `webflow-integration.js` into the **Footer Code** section
4. **Note**: The API URL is already configured in the code:
   ```javascript
   const API_URL = 'https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session';
   ```
   
   If you need to change it, update the `API_URL` constant in the script.

### Step 2: Set Up Your Form/Button

You have multiple options for triggering checkout:

## Option A: Form Submission (Recommended)

1. Create a form in Webflow with:
   - An email input field with ID: `customer-email`
   - A submit button with ID: `checkout-btn`
   - Hidden inputs for site data (see below)

2. Add hidden inputs for each site you want to include:
   ```html
   <input type="hidden" data-site="example.com" data-price="price_xxxxx" />
   <input type="hidden" data-site="another-site.com" data-price="price_yyyyy" />
   ```

3. The form will automatically handle submission and redirect to Stripe checkout.

## Option B: Button with Data Attributes

1. Create a button with class `checkout-button`
2. Add data attributes:
   ```html
   <button 
       class="checkout-button"
       data-email-selector="#email-input"
       data-sites='[{"site":"example.com","price":"price_xxxxx","quantity":1}]'
   >
       Checkout
   </button>
   ```

## Option C: Custom JavaScript Call

You can call the function directly from Webflow interactions:

1. In Webflow, add an **Element Trigger** (e.g., button click)
2. Add a **Custom Code** action
3. Use this code:
   ```javascript
   createCheckoutSession({
     customerEmail: 'user@example.com',
     sites: [
       { site: 'example.com', price: 'price_xxxxx', quantity: 1 }
     ],
     success_url: 'https://yoursite.com/success',
     cancel_url: 'https://yoursite.com/cancel'
   });
   ```

## Configuration

### Required Data Structure

The API expects this JSON structure:
```json
{
  "customerEmail": "user@example.com",
  "sites": [
    {
      "site": "example.com",
      "price": "price_xxxxx",
      "quantity": 1
    }
  ],
  "success_url": "https://yoursite.com/success",
  "cancel_url": "https://yoursite.com/cancel"
}
```

### Getting Price IDs

1. Go to your Stripe Dashboard
2. Navigate to **Products** > **Pricing**
3. Copy the Price ID (starts with `price_`)
4. Use these IDs in your form/button data attributes

### Success and Cancel URLs

- **Success URL**: Where users are redirected after successful payment
- **Cancel URL**: Where users are redirected if they cancel checkout

You can set these:
- In the form/button data attributes: `data-success-url` and `data-cancel-url`
- Or they'll default to: `{your-domain}/success` and `{your-domain}/cancel`

## Example Webflow Setup

### Minimal Example

1. **Form Element**:
   - Email input: ID = `customer-email`
   - Submit button: ID = `checkout-btn`
   - Form ID = `checkout-form`

2. **Hidden Inputs** (add via Custom Code or Embed element):
   ```html
   <input type="hidden" data-site="mysite.com" data-price="price_1234567890" />
   ```

3. **That's it!** The script handles everything else.

### Advanced Example with Multiple Sites

```html
<form id="checkout-form">
  <input type="email" id="customer-email" placeholder="Email" required />
  
  <!-- Site 1 -->
  <input type="hidden" data-site="site1.com" data-price="price_abc123" />
  
  <!-- Site 2 -->
  <input type="hidden" data-site="site2.com" data-price="price_def456" />
  
  <button type="submit" id="checkout-btn">Checkout</button>
</form>
```

## Testing

1. **Development**: Use Stripe test mode
   - Test price IDs start with `price_`
   - Use test card: `4242 4242 4242 4242`
   - Any future expiry date and CVC

2. **Production**: Switch to live mode
   - Update price IDs to live prices
   - Update API URL if using different environment

## Troubleshooting

### Checkout window doesn't open
- Check browser console for errors
- Verify API_URL is correct
- Ensure form fields have correct IDs
- Check that sites array is not empty

### "Missing customerEmail or sites" error
- Ensure email input has ID `customer-email`
- Verify hidden inputs have `data-site` and `data-price` attributes
- Check browser console for data being sent

### CORS errors
- Ensure your Cloudflare Worker allows requests from your Webflow domain
- Add CORS headers if needed (the Worker should handle this)

## Customization

### Custom Loading Message
Modify the `showLoading()` function to match your design.

### Custom Error Handling
Update the error handling in `createCheckoutSession()` to show custom error messages or redirects.

### Multiple Checkout Buttons
Use the class `.checkout-button` on multiple buttons - they'll all work automatically.

## Support

If you encounter issues:
1. Check browser console for errors
2. Verify your API endpoint is working (test in Postman)
3. Ensure all required data is being collected
4. Check Stripe Dashboard for any API errors

