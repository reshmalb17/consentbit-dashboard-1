# PowerShell script to create subscription_queue table in D1 database
# Usage: .\create-subscription-queue-table.ps1

$databaseId = "3a0cf7e2-34a9-4d06-a5b7-c1238d13290e"

Write-Host "Creating subscription_queue table in D1 database..." -ForegroundColor Cyan

# Create table
Write-Host "Creating subscription_queue table..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="CREATE TABLE IF NOT EXISTS subscription_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, user_email TEXT NOT NULL, payment_intent_id TEXT NOT NULL, price_id TEXT NOT NULL, license_key TEXT NOT NULL, quantity INTEGER NOT NULL, trial_end INTEGER, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, error_message TEXT, subscription_id TEXT, item_id TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), processed_at INTEGER, next_retry_at INTEGER);"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error creating subscription_queue table" -ForegroundColor Red
    exit 1
}

# Create indexes
Write-Host "Creating indexes..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_status ON subscription_queue(status);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_customer_id ON subscription_queue(customer_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_payment_intent_id ON subscription_queue(payment_intent_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_next_retry_at ON subscription_queue(next_retry_at);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_queue_id ON subscription_queue(queue_id);"
wrangler d1 execute $databaseId --remote --command="CREATE INDEX IF NOT EXISTS idx_subscription_queue_license_key ON subscription_queue(license_key);"

# Verify table was created
Write-Host "Verifying table creation..." -ForegroundColor Yellow
wrangler d1 execute $databaseId --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_queue';"

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Subscription queue table created successfully!" -ForegroundColor Green
} else {
    Write-Host "❌ Error verifying subscription_queue table" -ForegroundColor Red
    exit 1
}

