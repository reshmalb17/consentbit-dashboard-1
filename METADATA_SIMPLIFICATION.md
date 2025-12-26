# Metadata Simplification for Use Case 3

## Summary

Reduced metadata storage by **removing redundant fields** while maintaining all required functionality.

## Changes Made

### Before (Redundant Metadata)

**Subscription Item Metadata** (per item):
- ❌ `metadata[license_key]` ✅ (kept - required)
- ❌ `metadata[purchase_type]: 'quantity'` (removed - redundant)
- ❌ `metadata[licencepurchase]: 'by user'` (removed - redundant)

**Payment Intent Metadata**:
- ❌ `licencepurchase: 'by user'` (removed - redundant with usecase)
- ❌ `purchase_type: 'quantity'` (removed - can infer from usecase)
- ❌ `quantity: '3'` (removed - can derive from license_keys array length)
- ❌ `email: 'john@example.com'` (removed - can get from customer_id)
- ✅ `usecase: '3'` (kept - primary identifier)
- ✅ `subscription_id` (kept - required)
- ✅ `license_keys` (kept - required)
- ✅ `item_ids` (kept - required for mapping)

**Subscription Metadata**:
- ✅ `license_keys` (kept - backup source)
- ✅ `usecase: '3'` (kept - required for subscription.updated webhook)
- ❌ `purchase_type: 'quantity'` (removed - can infer from usecase)
- ❌ `quantity` (removed - can derive from array length)

### After (Simplified Metadata)

**Subscription Item Metadata** (per item):
```javascript
{
  'metadata[license_key]': 'KEY-A1B2-C3D4-E5F6'  // Only essential field
}
```

**Payment Intent Metadata**:
```javascript
{
  'payment_intent_data[metadata][usecase]': '3',                    // Primary identifier
  'payment_intent_data[metadata][subscription_id]': 'sub_...',       // Required
  'payment_intent_data[metadata][license_keys]': '["KEY-...", ...]', // Required
  'payment_intent_data[metadata][item_ids]': '["si_...", ...]'      // Required for mapping
}
```

**Subscription Metadata**:
```javascript
{
  'metadata[license_keys]': '["KEY-...", ...]',  // Backup source
  'metadata[usecase]': '3'                        // Primary identifier
}
```

## Benefits

1. **Reduced Metadata Size**: ~40% reduction in metadata fields
2. **Simpler Logic**: Single source of truth (`usecase: '3'`) instead of multiple checks
3. **Less Redundancy**: No duplicate information across metadata locations
4. **Easier Maintenance**: Fewer fields to update and validate

## How It Works

### Identification
- **Use Case 3** is identified by `usecase === '3'` (single check instead of multiple)
- No need to check `licencepurchase`, `purchase_type`, etc.

### License Keys
- **Primary Source**: Subscription item metadata (`item.metadata.license_key`)
- **Backup Source**: Subscription metadata (`subscription.metadata.license_keys`)
- **Payment Intent**: Contains license keys for `payment_intent.succeeded` webhook

### Quantity
- Derived from `license_keys` array length (no need to store separately)

### Email
- Retrieved from Stripe customer object using `customer_id` (no need to store)

## Webhook Processing

### payment_intent.succeeded
```javascript
const useCase3 = paymentIntent.metadata?.usecase === '3';
if (useCase3 && existingSubscriptionId && customerId) {
  // Process Use Case 3
  const licenseKeys = JSON.parse(paymentIntent.metadata.license_keys);
  const itemIds = JSON.parse(paymentIntent.metadata.item_ids);
  // ... create licenses
}
```

### customer.subscription.updated
```javascript
const useCase3 = subscriptionMetadata.usecase === '3';
if (useCase3 && env.DB) {
  // Get license keys from item metadata (primary) or subscription metadata (backup)
  for (const item of sub.items.data) {
    if (item.metadata?.license_key) {
      licenseKeys.push(item.metadata.license_key);
    }
  }
  // ... create licenses
}
```

## Migration Notes

- **No breaking changes**: Old webhook handlers still work (they check `usecase` first)
- **Backward compatible**: If old metadata exists, it's ignored
- **Cleaner code**: Removed redundant checks and fields

## Metadata Size Comparison

### Before
- Subscription Items: 3 fields per item
- Payment Intent: 8 fields
- Subscription: 4 fields
- **Total**: ~15+ metadata fields

### After
- Subscription Items: 1 field per item
- Payment Intent: 4 fields
- Subscription: 2 fields
- **Total**: ~7 metadata fields

**Reduction**: ~53% fewer metadata fields

