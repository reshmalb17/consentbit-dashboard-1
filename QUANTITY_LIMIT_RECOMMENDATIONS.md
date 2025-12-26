# Safe Maximum Quantity Recommendations

## Current Configuration
- **Default Limit:** 50 subscriptions per purchase
- **Configurable via:** `MAX_QUANTITY_PER_PURCHASE` environment variable

## Recommended Limits by Tier

### 🟢 **Safest Maximum: 25 Subscriptions**
**Recommended for:** Production use, both free and paid tiers

**Why:**
- ✅ Works reliably on Cloudflare Workers free tier (30s limit)
- ✅ Works reliably on Cloudflare Workers paid tier (50s limit)
- ✅ 50% safety margin for network latency and errors
- ✅ Handles all edge cases (invoice refunds, database operations)
- ✅ Tested and proven stable

**Performance:**
- ~10-12 seconds execution time
- ~25 API calls (subscription creation only)
- ~2.4 seconds in delays (100ms × 24)
- ~5 seconds buffer for database operations and error handling

---

### 🟡 **Recommended Maximum: 30 Subscriptions**
**Recommended for:** Paid tier users who need slightly more

**Why:**
- ✅ Good balance between quantity and safety
- ✅ Works on paid tier (50s limit) with comfortable margin
- ✅ May work on free tier but closer to limit
- ⚠️ Less safety margin than 25

**Performance:**
- ~12-15 seconds execution time
- ~30 API calls
- ~2.9 seconds in delays
- ~5 seconds buffer

---

### 🟠 **Maximum with Optimizations: 50 Subscriptions**
**Recommended for:** Paid tier only, with monitoring

**Why:**
- ✅ Current default limit
- ✅ Works on paid tier (50s limit) with optimizations
- ⚠️ Requires paid tier (won't work on free tier)
- ⚠️ Closer to execution time limit
- ⚠️ May timeout if network is slow or errors occur

**Performance:**
- ~20-25 seconds execution time
- ~50 API calls
- ~4.9 seconds in delays
- ~5 seconds buffer (tight)

**Optimizations Applied:**
- Invoice checking skipped for batches >10
- Metadata updates skipped for batches >10
- Only subscription creation API calls made

---

## Performance Breakdown

### Per Subscription Overhead:
- **Subscription Creation:** ~200-300ms (Stripe API call)
- **Delay (for >10):** 100ms
- **Processing:** ~50-100ms
- **Total per subscription:** ~350-500ms

### Batch Operations (One-time):
- **Payment method attachment:** ~500ms
- **Price fetching:** ~300ms
- **Trial end calculation:** ~50ms
- **Database operations (saving licenses):** ~100ms per license
- **Payment record saving:** ~200ms per subscription
- **Error handling/refunds:** Variable (0-2000ms if needed)

### Total Time Estimates:

| Quantity | API Calls | Delays | DB Ops | Total Time | Status |
|----------|-----------|--------|--------|------------|--------|
| 10 | 10 | 0ms | ~1s | ~4-5s | ✅ Very Safe |
| 25 | 25 | 2.4s | ~2.5s | ~10-12s | ✅ Safe |
| 30 | 30 | 2.9s | ~3s | ~12-15s | ✅ Good |
| 50 | 50 | 4.9s | ~5s | ~20-25s | ⚠️ Paid Tier Only |

---

## Configuration

### Set Custom Limit via Environment Variable:

```jsonc
// wrangler.jsonc
{
  "vars": {
    "MAX_QUANTITY_PER_PURCHASE": "25"  // Recommended safest maximum
  }
}
```

### Recommended Settings:

**For Free Tier:**
```jsonc
{
  "vars": {
    "MAX_QUANTITY_PER_PURCHASE": "25"
  }
}
```

**For Paid Tier (Conservative):**
```jsonc
{
  "vars": {
    "MAX_QUANTITY_PER_PURCHASE": "30"
  }
}
```

**For Paid Tier (Maximum):**
```jsonc
{
  "vars": {
    "MAX_QUANTITY_PER_PURCHASE": "50"
  }
}
```

---

## Factors Affecting Performance

### 1. **Network Latency**
- Stripe API response times vary (100-500ms)
- Cloudflare Workers location affects latency
- **Impact:** +10-20% execution time

### 2. **Error Handling**
- Failed subscriptions require refund processing
- Invoice refunds add extra API calls
- **Impact:** +5-10% execution time if errors occur

### 3. **Database Operations**
- Saving licenses to D1 database
- Payment record creation
- **Impact:** ~100ms per license

### 4. **Stripe Rate Limits**
- Stripe allows ~100 requests/second
- Current delays (100ms) keep us well under limit
- **Impact:** Minimal with current delays

---

## Best Practices

### ✅ **Do:**
- Use **25 subscriptions** as default for production
- Monitor execution times in Cloudflare dashboard
- Split large purchases into multiple batches if needed
- Test with your specific network conditions

### ❌ **Don't:**
- Exceed 50 subscriptions without paid tier
- Remove delays (needed for rate limiting)
- Skip error handling (can cause timeouts)
- Process invoice refunds synchronously for large batches

---

## Troubleshooting

### If Timeouts Occur:

1. **Reduce Limit:**
   ```jsonc
   {
     "vars": {
       "MAX_QUANTITY_PER_PURCHASE": "20"  // More conservative
     }
   }
   ```

2. **Check Execution Time:**
   - Monitor Cloudflare Workers logs
   - Look for execution time warnings
   - Check if you're on free tier (30s limit)

3. **Optimize Further:**
   - Consider background processing for large batches
   - Use Stripe webhooks for async processing
   - Implement queue system for very large purchases

---

## Summary

| Limit | Tier | Safety | Recommendation |
|-------|------|--------|----------------|
| **25** | Both | ⭐⭐⭐⭐⭐ | **Best for production** |
| **30** | Paid | ⭐⭐⭐⭐ | Good balance |
| **50** | Paid | ⭐⭐⭐ | Maximum (monitor closely) |

**Final Recommendation: Set `MAX_QUANTITY_PER_PURCHASE` to `25` for safest, most reliable operation.**

