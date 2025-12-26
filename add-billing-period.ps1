# Add billing_period column to subscriptions table
# This script adds the billing_period column to track recurring billing frequency

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "ADDING billing_period COLUMN TO subscriptions TABLE" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check if wrangler is available
$wranglerCheck = Get-Command wrangler -ErrorAction SilentlyContinue
if (-not $wranglerCheck) {
    Write-Host "❌ ERROR: wrangler CLI not found. Please install it first:" -ForegroundColor Red
    Write-Host "   npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

# Read the database name from wrangler.jsonc or use default
$dbName = "consentbit-licenses"
if (Test-Path "wrangler.jsonc") {
    try {
        $wranglerConfig = Get-Content "wrangler.jsonc" -Raw | ConvertFrom-Json
        if ($wranglerConfig.d1_databases -and $wranglerConfig.d1_databases[0].database_name) {
            $dbName = $wranglerConfig.d1_databases[0].database_name
        }
    } catch {
        Write-Host "⚠️  Could not parse wrangler.jsonc, using default database name" -ForegroundColor Yellow
    }
}

Write-Host "   Database: $dbName" -ForegroundColor Gray
Write-Host "   Environment: remote" -ForegroundColor Gray
Write-Host ""

# Execute the SQL file
try {
    Write-Host "   Adding billing_period column..." -ForegroundColor Gray
    wrangler d1 execute $dbName --file=add-billing-period-column.sql --remote
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✅ billing_period column added successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host "COLUMN ADDED SUCCESSFULLY" -ForegroundColor Cyan
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "The billing_period column will now store:" -ForegroundColor Yellow
        Write-Host "  - 'monthly' for monthly subscriptions" -ForegroundColor White
        Write-Host "  - 'yearly' for yearly subscriptions" -ForegroundColor White
        Write-Host "  - 'weekly' for weekly subscriptions" -ForegroundColor White
        Write-Host "  - 'daily' for daily subscriptions" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "❌ Error adding column. Exit code: $LASTEXITCODE" -ForegroundColor Red
        Write-Host ""
        Write-Host "Note: If the column already exists, this is expected." -ForegroundColor Yellow
        Write-Host "The column may have been added in a previous run." -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host ""
    Write-Host "❌ Error executing SQL: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Note: If you see 'duplicate column name', the column already exists." -ForegroundColor Yellow
    exit 1
}

