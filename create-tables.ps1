# PowerShell script to create D1 database tables
# Run this from the project root directory

# Note: Update DB_NAME to match your actual D1 database name from wrangler.jsonc
$DB_NAME = "consentbit-licenses"

Write-Host "Creating payments table..." -ForegroundColor Cyan
wrangler d1 execute $DB_NAME --command="CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, subscription_id TEXT NOT NULL, email TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'succeeded', site_domain TEXT, magic_link TEXT, magic_link_generated INTEGER DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));"

Write-Host "Creating licenses table..." -ForegroundColor Cyan
wrangler d1 execute $DB_NAME --command="CREATE TABLE IF NOT EXISTS licenses (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, subscription_id TEXT NOT NULL, license_key TEXT NOT NULL UNIQUE, site_domain TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));"

Write-Host "Creating magic_link_tokens table..." -ForegroundColor Cyan
wrangler d1 execute $DB_NAME --command="CREATE TABLE IF NOT EXISTS magic_link_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, email TEXT NOT NULL, member_id TEXT, customer_id TEXT, ip_address TEXT, used INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), used_at INTEGER);"

Write-Host "Creating indexes..." -ForegroundColor Cyan
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_payments_subscription_id ON payments(subscription_id);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_licenses_customer_id ON licenses(customer_id);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_licenses_subscription_id ON licenses(subscription_id);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON licenses(license_key);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_licenses_site_domain ON licenses(site_domain);"

Write-Host "Creating security indexes for magic_link_tokens..." -ForegroundColor Cyan
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_tokens_token ON magic_link_tokens(token);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_tokens_email ON magic_link_tokens(email);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_tokens_expires ON magic_link_tokens(expires_at);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_tokens_used ON magic_link_tokens(used);"
wrangler d1 execute $DB_NAME --command="CREATE INDEX IF NOT EXISTS idx_tokens_ip ON magic_link_tokens(ip_address);"

Write-Host "✅ Tables and indexes created successfully!" -ForegroundColor Green

