# Webflow Dashboard Setup Guide

## Overview
This guide shows you how to recreate the dashboard.html design in Webflow and connect it to Memberstack authentication.

---

## Step 1: Elements to Add in Webflow Designer

### 1. **Main Container**
- **Type:** Section or Div Block
- **Class/ID:** `dashboard-container` (optional)
- **Purpose:** Wrapper for all dashboard content

### 2. **Header Section**
- **Type:** Section or Div Block
- **Class/ID:** `dashboard-header`
- **Contains:**
  - **Heading (H1):** "📋 License Dashboard"
  - **Paragraph:** "Manage your sites and license keys"
  - **Button:** Logout button
    - **ID:** `logout-button`
    - **Text:** "Logout"

### 3. **Message Containers** (Hidden by default)
- **Error Message Div:**
  - **ID:** `error-message`
  - **Initial State:** Hidden (display: none)
  - **Style:** Red background, white text
  
- **Success Message Div:**
  - **ID:** `success-message`
  - **Initial State:** Hidden (display: none)
  - **Style:** Green background, white text

### 4. **Sites Section Card**
- **Type:** Section or Div Block
- **Class/ID:** `sites-card`
- **Contains:**
  - **Heading (H2):** "🌐 Your Sites"
  - **Sites Container:**
    - **ID:** `sites-container`
    - **Type:** Div Block (will be populated dynamically)
    - **Layout:** Grid (3 columns on desktop, 1 column on mobile)
  
  - **Add Site Form Section:**
    - **Heading (H3):** "Add New Site"
    - **Form Container:**
      - **ID:** `add-site-form`
      - **Contains:**
        - **Input Field 1:**
          - **ID:** `new-site-input`
          - **Placeholder:** "Enter site domain (e.g., example.com)"
          - **Type:** Text
        - **Input Field 2:**
          - **ID:** `new-site-price`
          - **Placeholder:** "Price ID (e.g., price_xxxxx)"
          - **Type:** Text
        - **Button:**
          - **ID:** `add-site-button`
          - **Text:** "Add Site"

### 5. **Licenses Section Card**
- **Type:** Section or Div Block
- **Class/ID:** `licenses-card`
- **Contains:**
  - **Heading (H2):** "🔑 Your License Keys"
  - **Licenses Container:**
    - **ID:** `licenses-container`
    - **Type:** Div Block (will be populated dynamically)

---

## Step 2: Site Card Template (For Dynamic Content)

When JavaScript creates site cards, each card needs this structure:

```
<div class="site-card">
  <div class="site-header">
    <div class="site-name">[Site Domain]</div>
    <span class="status-badge">[Active/Inactive]</span>
  </div>
  <div class="site-info">
    <div>Item ID: [Item ID]</div>
    <div>Quantity: [Quantity]</div>
    <div>Created: [Date]</div>
  </div>
  <button class="remove-site-button" data-site="[Site Domain]">
    Remove Site
  </button>
</div>
```

---

## Step 3: License Item Template (For Dynamic Content)

When JavaScript creates license items, each item needs this structure:

```
<div class="license-item">
  <div>
    <div class="license-key">[License Key]</div>
    <div class="license-meta">
      Status: [Status] | Created: [Date]
    </div>
  </div>
  <button class="copy-license-button" data-key="[License Key]">
    Copy
  </button>
</div>
```

---

## Step 4: Required IDs Summary

Make sure these elements have these exact IDs:

| Element | ID | Required |
|---------|-----|----------|
| Error message div | `error-message` | ✅ Yes |
| Success message div | `success-message` | ✅ Yes |
| Sites container | `sites-container` | ✅ Yes |
| New site input | `new-site-input` | ✅ Yes |
| New site price input | `new-site-price` | ✅ Yes |
| Add site button | `add-site-button` | ✅ Yes |
| Licenses container | `licenses-container` | ✅ Yes |
| Logout button | `logout-button` | ✅ Yes |

---

## Step 5: Webflow Designer Setup Instructions

### A. Create the Layout Structure

1. **Add a Section** (or use existing page section)
   - Set max-width: 1200px
   - Center it with margin: auto
   - Add padding: 20px

2. **Add Header Section**
   - Create a Div Block
   - Add Heading (H1): "📋 License Dashboard"
   - Add Paragraph: "Manage your sites and license keys"
   - Add Button: "Logout"
   - Assign ID: `logout-button` to the button

3. **Add Message Containers**
   - Create 2 Div Blocks
   - First: ID = `error-message` (red background)
   - Second: ID = `success-message` (green background)
   - Set both to display: none initially

4. **Add Sites Card**
   - Create a Div Block (white background, rounded corners, padding)
   - Add Heading (H2): "🌐 Your Sites"
   - Add Div Block: ID = `sites-container`
   - Set `sites-container` to Grid layout (3 columns desktop, 1 mobile)

5. **Add Add Site Form**
   - Inside Sites Card, add:
     - Heading (H3): "Add New Site"
     - Form or Div Block
     - Input 1: ID = `new-site-input`
     - Input 2: ID = `new-site-price`
     - Button: ID = `add-site-button`

6. **Add Licenses Card**
   - Create a Div Block (white background, rounded corners, padding)
   - Add Heading (H2): "🔑 Your License Keys"
   - Add Div Block: ID = `licenses-container`

---

## Step 6: Styling Recommendations

### Colors (match dashboard.html):
- Primary: #667eea (purple)
- Success: #4caf50 (green)
- Error: #f44336 (red)
- Background: Linear gradient (purple to purple)
- Cards: White background, rounded corners (12px), shadow

### Typography:
- Font: System fonts (-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto)
- Headings: Bold, dark gray (#333)
- Body: Regular, medium gray (#666)

### Spacing:
- Card padding: 30px
- Section margin-bottom: 20px
- Grid gap: 20px

---

## Step 7: Memberstack Integration

### Required Memberstack Setup:
1. **Add Memberstack SDK to Page HEAD:**
   ```html
   <script data-memberstack-app="app_clz9z3q4t00fl0sos3fhy0wft" 
           src="https://static.memberstack.com/scripts/v2/memberstack.js" 
           type="text/javascript"></script>
   ```

2. **Protect the Dashboard Page:**
   - In Webflow Designer → Page Settings
   - Enable Memberstack protection
   - Set required plan (if applicable)

---

## Step 8: JavaScript Code

After creating all elements, you'll need to add JavaScript code that:
1. Checks if user is logged in via Memberstack
2. Gets user email from Memberstack session
3. Fetches dashboard data from your API
4. Populates sites and licenses
5. Handles add/remove site actions
6. Handles logout

**The JavaScript code will be provided in a separate file: `webflow-dashboard-code.html`**

---

## Next Steps

1. ✅ Create all elements listed above in Webflow Designer
2. ✅ Assign the required IDs to each element
3. ✅ Style the elements to match the design
4. ✅ Add Memberstack SDK to page HEAD
5. ✅ Add the JavaScript code (next file)
6. ✅ Test the dashboard with a logged-in user

---

## Quick Checklist

- [ ] Header section with title and logout button
- [ ] Error message container (ID: `error-message`)
- [ ] Success message container (ID: `success-message`)
- [ ] Sites card with heading
- [ ] Sites container (ID: `sites-container`) - Grid layout
- [ ] Add site form with 2 inputs and button
- [ ] Licenses card with heading
- [ ] Licenses container (ID: `licenses-container`)
- [ ] All IDs assigned correctly
- [ ] Memberstack SDK added to HEAD
- [ ] Page protected with Memberstack (optional)

---

**Once you've created all these elements, I'll provide the JavaScript code that connects everything together!**

