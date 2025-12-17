# Pretty Database Viewer for D1
# Usage: .\view-db-pretty.ps1

function Format-Currency {
    param([int]$Amount, [string]$Currency = "usd")
    $amountInDollars = $Amount / 100
    return "$($Currency.ToUpper()) $($amountInDollars.ToString('F2'))"
}

function Show-Payments {
    Write-Host "`n" -NoNewline
    Write-Host "=" * 80 -ForegroundColor Cyan
    Write-Host "💳 PAYMENTS TABLE" -ForegroundColor Yellow
    Write-Host "=" * 80 -ForegroundColor Cyan
    
    $output = npx wrangler d1 execute consentbit-licenses --remote --command "SELECT id, customer_id, email, amount, currency, status, CASE WHEN magic_link IS NOT NULL THEN 'Yes' ELSE 'No' END as has_magic_link, datetime(created_at, 'unixepoch') as created_at FROM payments ORDER BY created_at DESC LIMIT 20;" 2>&1
    
    # Extract JSON from output
    $jsonMatch = $output | Select-String -Pattern '\[[\s\S]*\]' | ForEach-Object { $_.Matches[0].Value }
    
    if ($jsonMatch) {
        try {
            $payments = $jsonMatch | ConvertFrom-Json
            
            if ($payments.Count -eq 0) {
                Write-Host "No payments found" -ForegroundColor Gray
            } else {
                foreach ($p in $payments) {
                    Write-Host "`n[Payment #$($p.id)]" -ForegroundColor Green
                    Write-Host "  Customer ID: " -NoNewline
                    Write-Host $p.customer_id -ForegroundColor White
                    Write-Host "  Email: " -NoNewline
                    Write-Host $p.email -ForegroundColor White
                    Write-Host "  Amount: " -NoNewline
                    Write-Host (Format-Currency -Amount $p.amount -Currency $p.currency) -ForegroundColor Yellow
                    Write-Host "  Status: " -NoNewline
                    $statusColor = if ($p.status -eq "succeeded") { "Green" } else { "Red" }
                    Write-Host $p.status -ForegroundColor $statusColor
                    Write-Host "  Magic Link: " -NoNewline
                    Write-Host $p.has_magic_link -ForegroundColor $(if ($p.has_magic_link -eq "Yes") { "Green" } else { "Gray" })
                    Write-Host "  Created: " -NoNewline
                    Write-Host $p.created_at -ForegroundColor Gray
                }
            }
        } catch {
            Write-Host "Error parsing payments: $_" -ForegroundColor Red
            Write-Host "Raw output: $output" -ForegroundColor Gray
        }
    } else {
        Write-Host "No data returned" -ForegroundColor Gray
    }
}

function Show-Licenses {
    Write-Host "`n" -NoNewline
    Write-Host "=" * 80 -ForegroundColor Cyan
    Write-Host "🔑 LICENSES TABLE" -ForegroundColor Yellow
    Write-Host "=" * 80 -ForegroundColor Cyan
    
    $output = npx wrangler d1 execute consentbit-licenses --remote --command "SELECT id, customer_id, subscription_id, license_key, status, datetime(created_at, 'unixepoch') as created_at FROM licenses ORDER BY created_at DESC LIMIT 20;" 2>&1
    
    $jsonMatch = $output | Select-String -Pattern '\[[\s\S]*\]' | ForEach-Object { $_.Matches[0].Value }
    
    if ($jsonMatch) {
        try {
            $licenses = $jsonMatch | ConvertFrom-Json
            
            if ($licenses.Count -eq 0) {
                Write-Host "No licenses found" -ForegroundColor Gray
            } else {
                foreach ($l in $licenses) {
                    Write-Host "`n[License #$($l.id)]" -ForegroundColor Green
                    Write-Host "  Customer ID: " -NoNewline
                    Write-Host $l.customer_id -ForegroundColor White
                    Write-Host "  Subscription ID: " -NoNewline
                    Write-Host $l.subscription_id -ForegroundColor White
                    Write-Host "  License Key: " -NoNewline
                    Write-Host $l.license_key -ForegroundColor Cyan
                    Write-Host "  Status: " -NoNewline
                    $statusColor = if ($l.status -eq "active") { "Green" } else { "Red" }
                    Write-Host $l.status -ForegroundColor $statusColor
                    Write-Host "  Created: " -NoNewline
                    Write-Host $l.created_at -ForegroundColor Gray
                }
            }
        } catch {
            Write-Host "Error parsing licenses: $_" -ForegroundColor Red
            Write-Host "Raw output: $output" -ForegroundColor Gray
        }
    } else {
        Write-Host "No data returned" -ForegroundColor Gray
    }
}

function Show-Summary {
    Write-Host "`n" -NoNewline
    Write-Host "=" * 80 -ForegroundColor Cyan
    Write-Host "📈 SUMMARY" -ForegroundColor Yellow
    Write-Host "=" * 80 -ForegroundColor Cyan
    
    $paymentCountOutput = npx wrangler d1 execute consentbit-licenses --remote --command "SELECT COUNT(*) as count FROM payments;" 2>&1
    $licenseCountOutput = npx wrangler d1 execute consentbit-licenses --remote --command "SELECT COUNT(*) as count FROM licenses;" 2>&1
    $activeLicenseOutput = npx wrangler d1 execute consentbit-licenses --remote --command "SELECT COUNT(*) as count FROM licenses WHERE status = 'active';" 2>&1
    
    $paymentCount = ($paymentCountOutput | Select-String -Pattern '\[[\s\S]*\]').Matches[0].Value | ConvertFrom-Json | Select-Object -ExpandProperty count
    $licenseCount = ($licenseCountOutput | Select-String -Pattern '\[[\s\S]*\]').Matches[0].Value | ConvertFrom-Json | Select-Object -ExpandProperty count
    $activeCount = ($activeLicenseOutput | Select-String -Pattern '\[[\s\S]*\]').Matches[0].Value | ConvertFrom-Json | Select-Object -ExpandProperty count
    
    Write-Host "`nTotal Payments: " -NoNewline
    Write-Host $paymentCount -ForegroundColor Yellow
    Write-Host "Total Licenses: " -NoNewline
    Write-Host $licenseCount -ForegroundColor Yellow
    Write-Host "Active Licenses: " -NoNewline
    Write-Host $activeCount -ForegroundColor Green
}

# Main
Clear-Host
Write-Host "`n📊 DATABASE VIEWER - ConsentBit Dashboard" -ForegroundColor Magenta
Write-Host "=" * 80 -ForegroundColor Cyan

Show-Payments
Show-Licenses
Show-Summary

Write-Host "`n" -NoNewline
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host "`nDone! 🎉" -ForegroundColor Green

