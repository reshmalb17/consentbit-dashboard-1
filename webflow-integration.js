/**
 * Webflow Stripe Checkout Integration
 * 
 * Instructions:
 * 1. Add this code to your Webflow page via Custom Code (in Page Settings > Custom Code > Footer)
 * 2. Update the API_URL to your Cloudflare Worker URL
 * 3. Create a button or form in Webflow with a class or ID to trigger checkout
 * 4. Customize the data collection (customerEmail, sites, etc.) based on your form fields
 */

(function() {
  // ===== CONFIGURATION =====
  // Your Cloudflare Worker URL
  const API_URL = 'https://consentbit-dashboard.web-8fb.workers.dev/create-checkout-session';
  
  // ===== OPTION 1: Button Click Handler =====
  // If you have a button with ID "checkout-btn" or class "checkout-button"
  document.addEventListener('DOMContentLoaded', function() {
    // By ID
    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', handleCheckout);
    }
    
    // By class (for multiple buttons)
    const checkoutButtons = document.querySelectorAll('.checkout-button');
    checkoutButtons.forEach(btn => {
      btn.addEventListener('click', handleCheckout);
    });
    
    // Form submission handler
    const checkoutForm = document.getElementById('checkout-form');
    if (checkoutForm) {
      checkoutForm.addEventListener('submit', function(e) {
        e.preventDefault();
        handleCheckout(e);
      });
    }
  });

  // ===== OPTION 2: Direct Function Call =====
  // You can also call createCheckoutSession() directly from Webflow interactions
  window.createCheckoutSession = createCheckoutSession;

  /**
   * Main checkout handler
   */
  async function handleCheckout(event) {
    event.preventDefault();
    
    // Show loading state
    const button = event.target.closest('button, [data-checkout]');
    if (button) {
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Loading...';
      
      try {
        await createCheckoutSession();
        // Button will be re-enabled after redirect or error
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText;
        alert('Error: ' + error.message);
      }
    } else {
      await createCheckoutSession();
    }
  }

  /**
   * Create checkout session and redirect
   */
  async function createCheckoutSession(customData = null) {
    try {
      // Get form data or use custom data
      const checkoutData = customData || getCheckoutData();
      
      // Validate data
      if (!checkoutData.customerEmail) {
        throw new Error('Email is required');
      }
      if (!checkoutData.sites || checkoutData.sites.length === 0) {
        throw new Error('At least one site is required');
      }

      // Show loading indicator
      showLoading();

      // Call your API
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkoutData)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to create checkout session');
      }

      // Redirect to Stripe checkout
      if (result.url) {
        window.location.href = result.url;
      } else {
        throw new Error('No checkout URL received');
      }
    } catch (error) {
      console.error('Checkout error:', error);
      hideLoading();
      throw error;
    }
  }

  /**
   * Get checkout data from form fields
   * Customize this based on your Webflow form structure
   */
  function getCheckoutData() {
    // Option A: Get from form fields with specific IDs/classes
    const emailInput = document.getElementById('customer-email') || 
                      document.querySelector('[data-email]') ||
                      document.querySelector('input[type="email"]');
    
    const email = emailInput ? emailInput.value : '';
    
    // Option B: Get from data attributes on the button/form
    const form = document.querySelector('[data-checkout-form]');
    const sitesData = form ? form.getAttribute('data-sites') : null;
    
    // Parse sites data (can be JSON string or comma-separated)
    let sites = [];
    if (sitesData) {
      try {
        sites = JSON.parse(sitesData);
      } catch (e) {
        // If not JSON, try to parse as simple format
        sites = sitesData.split(',').map(site => ({
          site: site.trim(),
          price: getPriceForSite(site.trim()) // You'll need to implement this
        }));
      }
    } else {
      // Default: get from hidden inputs or data attributes
      const siteInputs = document.querySelectorAll('[data-site]');
      siteInputs.forEach(input => {
        const site = input.getAttribute('data-site') || input.value;
        const price = input.getAttribute('data-price') || getPriceForSite(site);
        sites.push({ site, price, quantity: 1 });
      });
    }

    // Get success and cancel URLs (optional)
    const successUrl = document.querySelector('[data-success-url]')?.getAttribute('data-success-url') ||
                      window.location.origin + '/success';
    const cancelUrl = document.querySelector('[data-cancel-url]')?.getAttribute('data-cancel-url') ||
                      window.location.origin + '/cancel';

    return {
      customerEmail: email,
      sites: sites,
      success_url: successUrl,
      cancel_url: cancelUrl
    };
  }

  /**
   * Get price ID for a site
   * Customize this based on your pricing logic
   */
  function getPriceForSite(site) {
    // Option 1: Use data attribute
    const siteElement = document.querySelector(`[data-site="${site}"]`);
    if (siteElement) {
      return siteElement.getAttribute('data-price');
    }
    
    // Option 2: Use a price mapping
    const priceMap = {
      'example.com': 'price_xxxxx', // Replace with your actual price IDs
      // Add more mappings as needed
    };
    
    return priceMap[site] || 'price_default'; // Fallback price
  }

  /**
   * Show loading indicator
   */
  function showLoading() {
    // Create or show a loading overlay
    let loader = document.getElementById('checkout-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'checkout-loader';
      loader.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        color: white;
        font-size: 18px;
      `;
      loader.innerHTML = '<div>Redirecting to checkout...</div>';
      document.body.appendChild(loader);
    }
    loader.style.display = 'flex';
  }

  /**
   * Hide loading indicator
   */
  function hideLoading() {
    const loader = document.getElementById('checkout-loader');
    if (loader) {
      loader.style.display = 'none';
    }
  }
})();

