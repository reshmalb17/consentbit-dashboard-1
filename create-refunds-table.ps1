# PowerShell script to create refunds table in D1 database
# Usage: .\create-refunds-table.ps1

$databaseId = "3a0cf7e2-34a9-4d06-a5b7-c1238d13290e"

Write-Host "Creating refunds table in D1 database..." -ForegroundColor Cyan

# Create table
Write-Host "Creating refunds table..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="CREATE TABLE IF NOT EXISTS refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, refund_id TEXT NOT NULL UNIQUE, payment_intent_id TEXT NOT NULL, charge_id TEXT NOT NULL, customer_id TEXT NOT NULL, user_email TEXT, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'succeeded', reason TEXT, queue_id TEXT, license_key TEXT, subscription_id TEXT, attempts INTEGER, metadata TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error creating refunds table" -ForegroundColor Red
    exit 1
}

# Create indexes
Write-Host "Creating indexes..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_refund_id ON refunds(refund_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_payment_intent_id ON refunds(payment_intent_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_charge_id ON refunds(charge_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds(customer_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_user_email ON refunds(user_email);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_queue_id ON refunds(queue_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_license_key ON refunds(license_key);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_subscription_id ON refunds(subscription_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds(created_at);"

# Verify table was created
Write-Host "Verifying table creation..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='refunds';"

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Refunds table created successfully!" -ForegroundColor Green
} else {
    Write-Host "❌ Error verifying refunds table" -ForegroundColor Red
    exit 1
}

