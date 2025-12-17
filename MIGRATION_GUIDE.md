# Database Migration Guide

## Fix: Add `site_domain` Column to Licenses Table

The error you're seeing:
```
Error: D1_ERROR: no such column: site_domain at offset 20: SQLITE_ERROR
```

This means your `licenses` table doesn't have the `site_domain` column yet.

## Solution: Run Migration

### Option 1: Using Wrangler CLI (Recommended)

Run this command to add the `site_domain` column:

```bash
npx wrangler d1 execute consentbit-licenses --remote --command "ALTER TABLE licenses ADD COLUMN site_domain TEXT;"
```

**For local database:**
```bash
npx wrangler d1 execute consentbit-licenses --local --command "ALTER TABLE licenses ADD COLUMN site_domain TEXT;"
```

### Option 2: Using the Migration File

The migration file `migration_add_site_domain.sql` contains the SQL command. You can run it:

```bash
npx wrangler d1 execute consentbit-licenses --remote --file migration_add_site_domain.sql
```

### Option 3: Verify Column Exists

After running the migration, verify the column was added:

```bash
npx wrangler d1 execute consentbit-licenses --remote --command "PRAGMA table_info(licenses);"
```

You should see `site_domain` in the list of columns.

## What This Does

- Adds a `site_domain TEXT` column to the `licenses` table
- Allows the `/licenses` endpoint to query and return site domains
- Enables the dashboard to show which site each license key belongs to

## Note

If you get an error saying "duplicate column name", the column already exists and you can ignore the error. The code has been updated to handle both cases (with and without the column).

## After Migration

1. Restart your Worker (if needed)
2. Refresh the dashboard
3. License keys should now load without errors
4. Each license will show its associated site domain

