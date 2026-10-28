<#
.SYNOPSIS
  GIGA CHEMIST — Windows 11 Service Restart Script
.DESCRIPTION
  Restarts the GIGA CHEMIST autostart service or running backend instance.
#>

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "Administrator privileges required. Relaunching with elevation..."
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

param(
    [string]$ProjectRoot = ""
)

if (-not $ProjectRoot) {
    if ($PSScriptRoot) {
        $candidate = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
        if (Test-Path (Join-Path $candidate "server.ts")) { $ProjectRoot = $candidate }
    }
    if (-not $ProjectRoot) {
        if (Test-Path "C:\GIGA-CHEMIST-POS-2\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS-2" }
        elseif (Test-Path "C:\GIGA-CHEMIST-POS\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS" }
        else { $ProjectRoot = (Get-Location).Path }
    }
}

$PrimaryTask = "GIGA CHEMIST POS Server"
$LegacyTask = "GigaChemistPOS_Service"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   GIGA CHEMIST — RESTARTING POS SERVICE" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop Task & Process
Write-Host "[1/3] Stopping current service instance..." -ForegroundColor Yellow
Stop-ScheduledTask -TaskName $PrimaryTask -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $LegacyTask -ErrorAction SilentlyContinue

$Conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($Conn) {
    Stop-Process -Id $Conn.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# 2. Start Task
Write-Host "[2/3] Starting GIGA CHEMIST Scheduled Task..." -ForegroundColor Yellow
$task = Get-ScheduledTask -TaskName $PrimaryTask -ErrorAction SilentlyContinue
if (-not $task) {
    $task = Get-ScheduledTask -TaskName $LegacyTask -ErrorAction SilentlyContinue
}
if ($task) {
    Start-ScheduledTask -TaskName $task.TaskName
} else {
    Write-Warning "Scheduled task not found. Starting manual runner from $ProjectRoot..."
    $RunnerScript = Join-Path $ProjectRoot "deployment\windows\giga-service-runner.ps1"
    if (-not (Test-Path $RunnerScript)) {
        $RunnerScript = Join-Path $ProjectRoot "deployment\windows\service-runner.ps1"
    }
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerScript`" -ProjectRoot `"$ProjectRoot`"" -WindowStyle Hidden
}

# 3. Verify Health
Write-Host "[3/3] Checking service health (waiting 10 seconds)..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

$ServerReady = $false
try {
    $Health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5 -ErrorAction Stop
    if ($Health -and $Health.status -eq "ok") {
        $ServerReady = $true
    }
} catch {}

Write-Host ""
if ($ServerReady) {
    Write-Host "[SUCCESS] GIGA CHEMIST has been restarted and is HEALTHY on http://localhost:3000" -ForegroundColor Green
} else {
    Write-Host "[NOTICE] Service restart triggered. Check 'logs\server.log' for details." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor White
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
