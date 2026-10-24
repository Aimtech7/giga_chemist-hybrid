# =====================================================================
# GIGA CHEMIST SHOP 2 - COPY-READY PACKAGE VERIFICATION
# =====================================================================
$ErrorActionPreference = "Stop"
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  VERIFYING SHOP 2 COPY-READY DEPLOYMENT PACKAGE" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$deployDir = Join-Path $PSScriptRoot ".."
$readyPayload = Join-Path $deployDir "..\shop2-ready\GIGA-CHEMIST-POS"
$finalBackup = Join-Path $deployDir "database\giga_chemist_shop2_final.backup"

# 1. Check final backup
Write-Host ""
Write-Host "1. Checking final backup..."
if (-not (Test-Path $finalBackup)) { throw "Missing $finalBackup" }
$backupSize = (Get-Item $finalBackup).Length
Write-Host "   Backup file: $finalBackup ($([math]::Round($backupSize / 1MB, 2)) MB)"
if ($backupSize -lt 30MB) { throw "Backup file unexpectedly small (< 30 MB)" }
Write-Host "   [OK] Final backup verified." -ForegroundColor Green

# 2. Check ready payload
Write-Host ""
Write-Host "2. Checking ready application payload..."
if (-not (Test-Path $readyPayload)) { throw "Missing $readyPayload" }
$reqFiles = @("package.json", "server.ts", "vite.config.ts", "index.html", ".env.example")
foreach ($f in $reqFiles) {
    $p = Join-Path $readyPayload $f
    if (-not (Test-Path $p)) { throw "Missing required file in payload: $f" }
}

# Verify no forbidden items in payload
$forbidden = @(".git", "node_modules", "backups", "deployment", "shop2 db.sql", "chemist_pos.sql")
foreach ($item in $forbidden) {
    $p = Join-Path $readyPayload $item
    if (Test-Path $p) { throw "Forbidden file/directory found in payload: $item" }
}
Write-Host "   [OK] Payload clean: No .git, node_modules, or raw legacy SQL dumps." -ForegroundColor Green

# 3. Check installer scripts
Write-Host ""
Write-Host "3. Checking installer scripts..."
$installers = @("install-shop2.ps1", "restore-shop2-database.ps1", "install-shop2-runtime.ps1")
foreach ($ins in $installers) {
    $p = Join-Path $deployDir "installer\$ins"
    if (-not (Test-Path $p)) { throw "Missing installer script: $ins" }
}
Write-Host "   [OK] All installer scripts exist." -ForegroundColor Green

# 4. Check verification scripts
Write-Host ""
Write-Host "4. Checking verification scripts..."
$verifiers = @("verify-shop2.ps1", "verify-shop2-cloud.ps1", "verify-copy-ready.ps1")
foreach ($v in $verifiers) {
    $p = Join-Path $deployDir "verification\$v"
    if (-not (Test-Path $p)) { throw "Missing verification script: $v" }
}
Write-Host "   [OK] All verification scripts exist." -ForegroundColor Green

# 5. Check configuration and documentation
Write-Host ""
Write-Host "5. Checking configuration and documentation..."
$docs = @("config\.env.shop2.example", "START-HERE.md", "SHOP2-DEPLOYMENT-CHECKLIST.md")
foreach ($d in $docs) {
    $p = Join-Path $deployDir $d
    if (-not (Test-Path $p)) { throw "Missing file: $d" }
}
Write-Host "   [OK] Documentation and configuration verified." -ForegroundColor Green

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  COPY-READY VERIFICATION: PASS (Package is 100% complete and ready)" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
