# PowerShell script to query D1 database
# Usage: .\query-db.ps1

Write-Host "=== Payments Table ===" -ForegroundColor Cyan
npx wrangler d1 execute consentbit-licenses --remote --command "SELECT * FROM payments ORDER BY created_at DESC LIMIT 10;"

Write-Host "`n=== Licenses Table ===" -ForegroundColor Cyan
npx wrangler d1 execute consentbit-licenses --remote --command "SELECT * FROM licenses ORDER BY created_at DESC LIMIT 10;"

Write-Host "`n=== Payment Count ===" -ForegroundColor Cyan
npx wrangler d1 execute consentbit-licenses --remote --command "SELECT COUNT(*) as total_payments FROM payments;"

Write-Host "`n=== License Count ===" -ForegroundColor Cyan
npx wrangler d1 execute consentbit-licenses --remote --command "SELECT COUNT(*) as total_licenses FROM licenses;"

Write-Host "`n=== Recent Payments with Magic Links ===" -ForegroundColor Cyan
npx wrangler d1 execute consentbit-licenses --remote --command "SELECT id, customer_id, email, amount, currency, status, magic_link, datetime(created_at, 'unixepoch') as created_at_formatted FROM payments ORDER BY created_at DESC LIMIT 5;"

