<#
.SYNOPSIS
  GIGA CHEMIST — Windows 11 Autostart Uninstallation Script
.DESCRIPTION
  Stops the GIGA CHEMIST background service, removes the Scheduled Task,
  and optionally cleans up the Windows Firewall rule.
#>

# 1. Require Administrator Privileges
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "Administrator privileges required. Relaunching with elevation..."
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

Clear-Host
Write-Host "======================================================================" -ForegroundColor Red
Write-Host "   GIGA CHEMIST — REMOVE WINDOWS 11 AUTOSTART SERVICE" -ForegroundColor Yellow
Write-Host "======================================================================" -ForegroundColor Red
Write-Host ""

$TaskName = "GigaChemistPOS_Service"
$FirewallRuleName = "GIGA CHEMIST Pharmacy POS (Port 3000)"

# 2. Stop and Delete Scheduled Task
Write-Host "[1/3] Stopping and deleting scheduled task '$TaskName'..." -ForegroundColor Yellow
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "      [SUCCESS] Scheduled task '$TaskName' removed." -ForegroundColor Green
} else {
    Write-Host "      [INFO] Task '$TaskName' was not registered." -ForegroundColor Gray
}

# 3. Terminate Any Lingering Node Process on Port 3000
Write-Host "[2/3] Checking for active GIGA CHEMIST processes on port 3000..." -ForegroundColor Yellow
$Conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($Conn) {
    $PidToStop = $Conn.OwningProcess
    Write-Host "      Stopping process with PID $PidToStop..." -ForegroundColor Yellow
    Stop-Process -Id $PidToStop -Force -ErrorAction SilentlyContinue
    Write-Host "      [SUCCESS] Process stopped." -ForegroundColor Green
} else {
    Write-Host "      [INFO] No active process found on port 3000." -ForegroundColor Gray
}

# 4. Remove Firewall Rule
Write-Host "[3/3] Removing Windows Firewall rule '$FirewallRuleName'..." -ForegroundColor Yellow
$ExistingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($ExistingRule) {
    Remove-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    Write-Host "      [SUCCESS] Firewall rule removed." -ForegroundColor Green
} else {
    Write-Host "      [INFO] Firewall rule was not present." -ForegroundColor Gray
}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "   [SUCCESS] GIGA CHEMIST AUTOSTART SERVICE HAS BEEN REMOVED." -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor White
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
