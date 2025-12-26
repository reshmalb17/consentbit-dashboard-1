# Proration Calculation Fix for Flexible Billing Mode

## Issue

When using flexible billing mode subscriptions, the Upcoming Invoice API fails with:
```
The Upcoming Invoice API does not support `billing_mode = flexible` subscriptions. 
To preview invoices for these subscriptions, use the Create Preview Invoice API instead.
```

## Current Implementation

The code now:
1. ✅ Tries Upcoming Invoice API first
2. ✅ Detects flexible billing mode error
3. ✅ Falls back to Preview Invoice API
4. ✅ Fetches updated subscription with all items
5. ✅ Passes all subscription items to Preview Invoice API
6. ✅ Extracts prorated amount from proration line items

## How It Works

### Step 1: Try Upcoming Invoice API
```javascript
const upcomingInvoiceRes = await stripeFetch(env, `/invoices/upcoming?subscription=${subscriptionId}`);
```

### Step 2: Detect Flexible Billing Mode
```javascript
if (upcomingInvoiceRes.status === 400 && 
    upcomingInvoiceRes.body?.error?.message?.includes('billing_mode = flexible')) {
  // Use Preview Invoice API
}
```

### Step 3: Fetch Updated Subscription
```javascript
// Get subscription with all items (including newly added ones)
const updatedSubRes = await stripeFetch(env, `/subscriptions/${subscriptionId}`);
const updatedSub = updatedSubRes.body;
```

### Step 4: Build Preview Invoice Request
```javascript
const previewForm = {
  'customer': customerId,
  'subscription': subscriptionId,
  'automatic_tax[enabled]': false
};

// Add all subscription items (required for proration calculation)
updatedSub.items.data.forEach((item, index) => {
  previewForm[`subscription_items[${index}][id]`] = item.id;
  previewForm[`subscription_items[${index}][price]`] = item.price.id;
  previewForm[`subscription_items[${index}][quantity]`] = (item.quantity || 1).toString();
});
```

### Step 5: Create Preview Invoice
```javascript
const previewInvoiceRes = await stripeFetch(env, '/invoices', 'POST', previewForm, true);
```

### Step 6: Extract Prorated Amount
```javascript
// Calculate from proration line items (most accurate)
let prorationTotal = 0;
previewInvoice.lines.data.forEach(line => {
  if (line.proration === true) {
    prorationTotal += line.amount || 0;
  }
});

proratedAmount = prorationTotal > 0 ? prorationTotal : previewInvoice.amount_due;
```

## Why This Works

1. ✅ **Fetches Updated Subscription**: Gets all items including newly added ones
2. ✅ **Passes All Items**: Preview Invoice API needs all items to calculate proration
3. ✅ **Extracts Proration Lines**: More accurate than using `amount_due` directly
4. ✅ **Fallback**: If Preview Invoice fails, uses estimated calculation

## Potential Issues & Solutions

### Issue 1: Preview Invoice Returns 0 Amount
**Cause**: Proration might be calculated as credit (negative) or zero
**Solution**: Check both `amount_due` and proration lines, use absolute value if needed

### Issue 2: Preview Invoice Fails
**Cause**: Invalid subscription_items format or missing items
**Solution**: Fallback to estimated calculation based on price

### Issue 3: Proration Not Calculated
**Cause**: Items added without `proration_behavior: 'create_prorations'`
**Solution**: Ensure items are added with proration enabled

## Testing

To test proration calculation:
1. Create subscription with flexible billing mode
2. Add items with `proration_behavior: 'create_prorations'`
3. Check logs for prorated amount
4. Verify amount matches expected calculation

## Expected Log Output

```
[USE CASE 3] Subscription uses flexible billing mode, using Preview Invoice API
[USE CASE 3] ✅ Retrieved prorated amount from preview invoice: 2300 (proration: 2300, total: 2300, usd)
```

## Fallback Calculation

If Preview Invoice fails:
```javascript
proratedAmount = (price.unit_amount || 0) * quantity;
// e.g., (1000 cents) * 3 = 3000 cents = $30.00
```

**Note**: Fallback uses full price, not prorated. This is a safety measure but may overcharge users.

