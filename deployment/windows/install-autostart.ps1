<#
.SYNOPSIS
  GIGA CHEMIST — Windows 11 Autostart Installation Script
.DESCRIPTION
  Configures GIGA CHEMIST to launch automatically at Windows boot via Task Scheduler.
  Also configures Windows Firewall to permit LAN counter terminals on port 3000.
#>

# 1. Require Administrator Privileges
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "Administrator privileges required. Relaunching with elevation..."
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

Clear-Host
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   GIGA CHEMIST — WINDOWS 11 AUTOSTART SERVICE INSTALLER" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 2. Resolve Root Directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptDir\..\..").Path
$RunnerScript = Join-Path $ProjectRoot "deployment\windows\service-runner.ps1"

if (-not (Test-Path $RunnerScript)) {
    Write-Error "Could not find runner script at: $RunnerScript"
    exit 1
}

Write-Host "[1/4] Target Project Directory: $ProjectRoot" -ForegroundColor Yellow

# 3. Create or Update Scheduled Task
$TaskName = "GigaChemistPOS_Service"
Write-Host "[2/4] Registering Windows Scheduled Task '$TaskName' (At System Boot)..." -ForegroundColor Yellow

# Remove existing task if present
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Write-Host "      Existing task found. Stopping and unregistering..." -ForegroundColor Gray
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Define Task Components
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerScript`" -ProjectRoot `"$ProjectRoot`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Task Settings: Unlimited runtime, start on battery, restart on failure (1 min, 3 attempts)
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "GIGA CHEMIST Pharmacy POS & Inventory Management Production Server" | Out-Null

Write-Host "      [SUCCESS] Scheduled task '$TaskName' registered." -ForegroundColor Green

# 4. Configure Windows Firewall for LAN Counter Access
Write-Host "[3/4] Configuring Windows Firewall Rule for Port 3000 (LAN Counter Terminals)..." -ForegroundColor Yellow
$FirewallRuleName = "GIGA CHEMIST Pharmacy POS (Port 3000)"

$ExistingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($ExistingRule) {
    Remove-NetFirewallRule -DisplayName $FirewallRuleName
}

New-NetFirewallRule `
    -DisplayName $FirewallRuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 3000 `
    -Description "Permits LAN client connections to GIGA CHEMIST Pharmacy POS server" | Out-Null

Write-Host "      [SUCCESS] Inbound firewall rule created on port 3000." -ForegroundColor Green

# 5. Start the Task and Verify
Write-Host "[4/4] Starting GIGA CHEMIST Service now..." -ForegroundColor Yellow
Start-ScheduledTask -TaskName $TaskName

Write-Host "      Waiting for service initialization (10 seconds)..." -ForegroundColor Gray
Start-Sleep -Seconds 10

# Check Service Health
$ServerReady = $false
try {
    $Health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5 -ErrorAction Stop
    if ($Health -and ($Health.status -eq "ok" -or $Health.status -eq "online")) {
        $ServerReady = $true
    }
} catch {}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
if ($ServerReady) {
    Write-Host "   [SUCCESS] GIGA CHEMIST AUTOSTART IS INSTALLED AND RUNNING!" -ForegroundColor Green
} else {
    Write-Host "   [NOTICE] Task started. Initializing database and assets." -ForegroundColor Yellow
    Write-Host "   Check 'logs\startup.log' or 'logs\server.log' for detailed progress." -ForegroundColor Gray
}
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Useful Commands:" -ForegroundColor White
Write-Host "  - View Logs:    Get-Content `"$ProjectRoot\logs\server.log`" -Tail 50 -Wait" -ForegroundColor Gray
Write-Host "  - Restart POS:  .\deployment\windows\restart-service.bat" -ForegroundColor Gray
Write-Host "  - Remove Auto:  .\deployment\windows\remove-autostart.bat" -ForegroundColor Gray
Write-Host "  - Web Access:   http://localhost:3000 (Local) or http://[PC_LAN_IP]:3000" -ForegroundColor Gray
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor White
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
