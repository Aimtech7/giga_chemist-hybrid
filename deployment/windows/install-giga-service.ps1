<#
.SYNOPSIS
  Installs GIGA CHEMIST auto-start on the pharmacy PC (Windows 11): the POS server starts at boot,
  without anyone logging in or opening PowerShell, and is restarted if it stops.
.DESCRIPTION
  Registers the scheduled task "GIGA CHEMIST POS Server":
    - runs as NT AUTHORITY\SYSTEM at system startup (no user session needed)
    - a 5-minute watchdog trigger relaunches the supervisor if it was ever stopped
    - the supervisor (giga-service-runner.ps1) waits for PostgreSQL, starts the server, restarts it
  Configuration and secrets stay in <ProjectRoot>\.env; nothing secret is put in the task.
  Removes the older "GigaChemistPOS_Service" task (install-autostart.ps1) if present, because it
  forced APP_MODE=local and would switch hybrid sync (and remote admin) off.
  Optionally opens TCP 3000 for LAN tills on the PRIVATE network profile only. PostgreSQL (5432) is
  never opened.

  Run in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\install-giga-service.ps1
.PARAMETER ProjectRoot  Folder with server.ts, node_modules and .env (default C:\GIGA-CHEMIST-POS).
.PARAMETER Port         POS server port (must match PORT in .env; default 3000).
.PARAMETER NoLanFirewallRule  Do not create the LAN rule for the port.
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [int]$Port = 3000,
    [switch]$NoLanFirewallRule
)

$ErrorActionPreference = "Stop"
$TaskName = "GIGA CHEMIST POS Server"
$LegacyTaskName = "GigaChemistPOS_Service"
$FirewallRuleName = "GIGA CHEMIST POS (LAN tills, TCP $Port)"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Administrator rights are required. Open PowerShell with 'Run as administrator' and run this script again." -ForegroundColor Red
    exit 1
}

function Fail([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "[INFO] $m" -ForegroundColor Gray }

Write-Host "GIGA CHEMIST - auto-start installer" -ForegroundColor Cyan

# 1. Checks
if (-not (Test-Path (Join-Path $ProjectRoot "server.ts"))) { Fail "server.ts not found in $ProjectRoot (use -ProjectRoot)." }
if (-not (Test-Path (Join-Path $ProjectRoot ".env"))) { Fail ".env not found in $ProjectRoot." }
if (-not (Test-Path (Join-Path $ProjectRoot "node_modules\tsx\dist\cli.mjs"))) { Fail "node_modules missing. Run 'npm ci' in $ProjectRoot first." }
$Runner = Join-Path $ProjectRoot "deployment\windows\giga-service-runner.ps1"
if (-not (Test-Path $Runner)) { Fail "Runner script missing: $Runner" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "node.exe is not on the PATH. Install Node.js 20+ (for all users) first." }
$NodeExe = $node.Source
if ($NodeExe -like "*\AppData\*") {
    Write-Host "[WARN] node.exe is installed under a user profile ($NodeExe). The SYSTEM task can usually run it, but a machine-wide Node.js install (C:\Program Files\nodejs) is recommended." -ForegroundColor Yellow
}
Ok "Project: $ProjectRoot"
Ok "Node.js: $NodeExe ($(& $NodeExe --version))"

$appMode = (Select-String -Path (Join-Path $ProjectRoot ".env") -Pattern '^\s*APP_MODE\s*=\s*(\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($appMode) { Info "APP_MODE in .env: $($appMode.Matches[0].Groups[1].Value) (remote admin needs hybrid + SYNC_ENABLED=true)" }

# 2. Legacy task (forced APP_MODE=local)
$legacy = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
if ($legacy) {
    Stop-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false
    Ok "Removed the older task '$LegacyTaskName'."
}

# 3. Task
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Info "Replaced the existing '$TaskName' task."
}
$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`" -ProjectRoot `"$ProjectRoot`" -NodeExe `"$NodeExe`" -Port $Port"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArgs -WorkingDirectory $ProjectRoot
$atBoot = New-ScheduledTaskTrigger -AtStartup
$atBoot.Delay = "PT20S"
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atBoot, $watchdog) -Principal $taskPrincipal -Settings $settings `
    -Description "GIGA CHEMIST pharmacy POS server (local PostgreSQL authoritative; hybrid cloud sync). Configuration in $ProjectRoot\.env." | Out-Null
Ok "Scheduled task '$TaskName' registered (SYSTEM, at startup + 5-minute watchdog)."

# 3b. PostgreSQL must start with Windows (never reinstalled or reconfigured beyond the start type).
$pgServices = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if (-not $pgServices) { Write-Host "[WARN] No postgresql* Windows service found (expected e.g. postgresql-x64-18)." -ForegroundColor Yellow }
foreach ($svc in $pgServices) {
    if ($svc.StartType -ne "Automatic") {
        Set-Service -Name $svc.Name -StartupType Automatic
        Ok "PostgreSQL service $($svc.Name): startup type set to Automatic (was $($svc.StartType))."
    } else { Ok "PostgreSQL service $($svc.Name): Automatic" }
    if ($svc.Status -ne "Running") { Start-Service -Name $svc.Name; Ok "Started $($svc.Name)." }
}

# 3c. Watchdog: hung-server detection + PostgreSQL / supervisor restart, every 5 minutes.
$WatchdogTask = "GIGA CHEMIST Watchdog"
$Watchdog = Join-Path $ProjectRoot "deployment\windows\watchdog.ps1"
if (Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $WatchdogTask -Confirm:$false }
$wdAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Watchdog`" -ProjectRoot `"$ProjectRoot`" -Port $Port" -WorkingDirectory $ProjectRoot
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)
$wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName $WatchdogTask -Action $wdAction -Trigger $wdTrigger -Principal $taskPrincipal -Settings $wdSettings `
    -Description "GIGA CHEMIST watchdog: restarts a hung server, starts PostgreSQL / the supervisor if stopped." | Out-Null
Ok "Scheduled task '$WatchdogTask' registered (SYSTEM, every 5 minutes)."

# 4. LAN firewall rule (Private profile only). PostgreSQL is never opened.
if (-not $NoLanFirewallRule) {
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private `
        -Description "LAN tills reach the GIGA CHEMIST server. Private network profile only." | Out-Null
    Ok "Firewall: TCP $Port allowed on the Private profile only (LAN tills)."
}
$pgOpen = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq "5432" } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" }
if ($pgOpen) { Write-Host "[WARN] An inbound firewall rule allows PostgreSQL port 5432: $($pgOpen.DisplayName -join ', '). Remove it unless you need it." -ForegroundColor Yellow }

# 5. Start now and wait for health
Start-ScheduledTask -TaskName $TaskName
Info "Starting... (waiting up to 120 s for http://127.0.0.1:$Port/api/health)"
$healthy = $false
for ($i = 0; $i -lt 60 -and -not $healthy; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -ErrorAction Stop
        if ($h.system -like "GIGA CHEMIST*") { $healthy = $true; Ok "Server is up: mode=$($h.app_mode) database connected=$($h.database.connected)" }
    } catch {}
}
if (-not $healthy) {
    Write-Host "[WARN] Server not healthy yet. Check: $ProjectRoot\logs\giga-service.log and logs\server-err.log" -ForegroundColor Yellow
    exit 2
}
Write-Host ""
Write-Host "Done. Verify any time with:" -ForegroundColor Cyan
Write-Host "  powershell -ExecutionPolicy Bypass -File $ProjectRoot\deployment\windows\check-giga-service.ps1"
Write-Host "Then RESTART Windows once and run the check again without logging in to any app."
