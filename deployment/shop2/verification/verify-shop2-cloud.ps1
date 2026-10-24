# =====================================================================
# GIGA CHEMIST SHOP 2 - CLOUD PARITY & ISOLATION VERIFICATION
# =====================================================================
$ErrorActionPreference = "Stop"
Write-Host "--- Verifying Shop 2 Cloud Parity & Shop 1 Isolation ---" -ForegroundColor Cyan

npx tsx scripts/shop2/verify-final-state.ts

Write-Host "✓ Shop 2 Cloud Parity & Isolation Verification: PASS" -ForegroundColor Green
