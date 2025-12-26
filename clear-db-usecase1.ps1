# Clear Database for Use Case 1 Testing
# This script clears all data from the D1 database to start fresh for Use Case 1 testing

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "CLEARING DATABASE FOR USE CASE 1 TESTING" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check if wrangler is available
$wranglerCheck = Get-Command wrangler -ErrorAction SilentlyContinue
if (-not $wranglerCheck) {
    Write-Host "❌ ERROR: wrangler CLI not found. Please install it first:" -ForegroundColor Red
    Write-Host "   npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

Write-Host "⚠️  WARNING: This will DELETE ALL DATA from the database!" -ForegroundColor Yellow
Write-Host "   Tables to be cleared:" -ForegroundColor Yellow
Write-Host "   - users" -ForegroundColor Yellow
Write-Host "   - customers" -ForegroundColor Yellow
Write-Host "   - subscriptions" -ForegroundColor Yellow
Write-Host "   - subscription_items" -ForegroundColor Yellow
Write-Host "   - payments" -ForegroundColor Yellow
Write-Host "   - licenses" -ForegroundColor Yellow
Write-Host "   - sites" -ForegroundColor Yellow
Write-Host "   - pending_sites" -ForegroundColor Yellow
Write-Host "   - idempotency_keys" -ForegroundColor Yellow
Write-Host "   - magic_link_tokens" -ForegroundColor Yellow
Write-Host ""

$confirm = Read-Host "Type 'YES' to confirm deletion"
if ($confirm -ne "YES") {
    Write-Host "❌ Cancelled. Database not cleared." -ForegroundColor Red
    exit 0
}

Write-Host ""
Write-Host "🗑️  Clearing database..." -ForegroundColor Yellow

# Read the database name from wrangler.jsonc or use default
$dbName = "consentbit-licenses"
if (Test-Path "wrangler.jsonc") {
    $wranglerConfig = Get-Content "wrangler.jsonc" -Raw | ConvertFrom-Json
    if ($wranglerConfig.databases -and $wranglerConfig.databases[0].database_name) {
        $dbName = $wranglerConfig.databases[0].database_name
    }
}

Write-Host "   Database: $dbName" -ForegroundColor Gray
Write-Host "   Environment: remote" -ForegroundColor Gray
Write-Host ""

# Execute the SQL file
try {
    Write-Host "   Executing clear-all-data-safe.sql..." -ForegroundColor Gray
    wrangler d1 execute $dbName --file=clear-all-data-safe.sql --remote
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✅ Database cleared successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host "READY FOR USE CASE 1 TESTING" -ForegroundColor Cyan
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Yellow
        Write-Host "1. Make a payment through a Stripe Payment Link" -ForegroundColor White
        Write-Host "2. Check the webhook logs for [USE CASE 1] debug statements" -ForegroundColor White
        Write-Host "3. Verify data is saved correctly in the database" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "❌ Error clearing database. Exit code: $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host ""
    Write-Host "❌ Error executing SQL: $_" -ForegroundColor Red
    exit 1
}

