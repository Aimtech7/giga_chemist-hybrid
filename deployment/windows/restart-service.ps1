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

$TaskName = "GigaChemistPOS_Service"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   GIGA CHEMIST — RESTARTING POS SERVICE" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop Task & Process
Write-Host "[1/3] Stopping current service instance..." -ForegroundColor Yellow
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

$Conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($Conn) {
    Stop-Process -Id $Conn.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# 2. Start Task
Write-Host "[2/3] Starting GIGA CHEMIST Scheduled Task..." -ForegroundColor Yellow
$TaskExists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($TaskExists) {
    Start-ScheduledTask -TaskName $TaskName
} else {
    Write-Warning "Scheduled task '$TaskName' not found. Starting manual runner..."
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $RunnerScript = Join-Path $ScriptDir "service-runner.ps1"
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerScript`"" -WindowStyle Hidden
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
