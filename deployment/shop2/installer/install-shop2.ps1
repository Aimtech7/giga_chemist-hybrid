# =====================================================================
# GIGA CHEMIST SHOP 2 - COMPLETE AUTOMATED INSTALLER
# =====================================================================
param(
    [string]$PostgresPassword = "Aim",
    [string]$InstallDir = "C:\GIGA-CHEMIST-POS"
)

$ErrorActionPreference = "Stop"
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  GIGA CHEMIST SHOP 2 - PRODUCTION INSTALLATION" -ForegroundColor Cyan
Write-Host "  Destination: $InstallDir" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# Step 1: Runtime
& "$PSScriptRoot\install-shop2-runtime.ps1" -InstallDir $InstallDir

# Step 2: Database Restore
& "$PSScriptRoot\restore-shop2-database.ps1" -PostgresPassword $PostgresPassword

# Step 3: Verification
& "$PSScriptRoot\..\verification\verify-shop2.ps1" -InstallDir $InstallDir -PostgresPassword $PostgresPassword

Write-Host ""
Write-Host "[OK] SHOP 2 INSTALLATION COMPLETE." -ForegroundColor Green
Write-Host "To start the application: cd $InstallDir; npm run start" -ForegroundColor Yellow
