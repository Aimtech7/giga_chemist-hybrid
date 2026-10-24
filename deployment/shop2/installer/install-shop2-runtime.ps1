# =====================================================================
# GIGA CHEMIST SHOP 2 - RUNTIME & APPLICATION INSTALLER
# =====================================================================
param(
    [string]$InstallDir = "C:\GIGA-CHEMIST-POS"
)

$ErrorActionPreference = "Stop"
Write-Host "--- Installing Application Files to $InstallDir ---" -ForegroundColor Cyan

$sourceDir = Join-Path $PSScriptRoot "..\..\shop2-ready\GIGA-CHEMIST-POS"
if (-not (Test-Path $sourceDir)) {
    throw "Source directory not found at: $sourceDir"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Write-Host "Copying application payload..."
Copy-Item -Path "$sourceDir\*" -Destination $InstallDir -Recurse -Force

# Setup .env if missing
$targetEnv = Join-Path $InstallDir ".env"
$sampleEnv = Join-Path $PSScriptRoot "..\config\.env.shop2.example"
if (-not (Test-Path $targetEnv)) {
    Copy-Item -Path $sampleEnv -Destination $targetEnv -Force
    Write-Host "Created initial .env from template." -ForegroundColor Yellow
}

Write-Host "Installing production Node.js dependencies..."
Push-Location $InstallDir
try {
    npm ci --production
    npm run build
} finally {
    Pop-Location
}

Write-Host "[OK] Application runtime prepared at $InstallDir" -ForegroundColor Green
