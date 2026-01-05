# PowerShell script to create price_config table in D1 database
# Run this from the project root directory

$DB_NAME = "consentbit-licenses"

Write-Host "Creating price_config table..." -ForegroundColor Cyan

# Create the table
wrangler d1 execute $DB_NAME --file=create-price-config-table.sql

Write-Host "Price config table created successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Product IDs provided:" -ForegroundColor Yellow
Write-Host "  Monthly Product: prod_Tg3C9VY4GhshdE" -ForegroundColor Cyan
Write-Host "  Yearly Product: prod_Tg3AbI4uIip8oO" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Get Price IDs from Stripe Dashboard:" -ForegroundColor White
Write-Host "   - Go to Products → prod_Tg3C9VY4GhshdE → Find Price ID" -ForegroundColor Gray
Write-Host "   - Go to Products → prod_Tg3AbI4uIip8oO → Find Price ID" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Update the price IDs in the database:" -ForegroundColor White
Write-Host "   wrangler d1 execute $DB_NAME --command=\"UPDATE price_config SET price_id = 'YOUR_MONTHLY_PRICE_ID' WHERE price_type = 'monthly';\"" -ForegroundColor Gray
Write-Host "   wrangler d1 execute $DB_NAME --command=\"UPDATE price_config SET price_id = 'YOUR_YEARLY_PRICE_ID' WHERE price_type = 'yearly';\"" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Or use the admin endpoint: POST /admin/update-price-config" -ForegroundColor White
Write-Host ""
Write-Host "See GET_PRICE_IDS_FROM_PRODUCTS.md for detailed instructions" -ForegroundColor Magenta

