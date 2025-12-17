-- Migration: Add site_domain column to licenses table
-- Run this if your licenses table doesn't have the site_domain column

-- Check if column exists and add it if it doesn't
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- So we need to check first or just run the ALTER TABLE (it will fail if column exists, but that's ok)

ALTER TABLE licenses ADD COLUMN site_domain TEXT;

-- If the above fails with "duplicate column name", the column already exists and you can ignore the error

