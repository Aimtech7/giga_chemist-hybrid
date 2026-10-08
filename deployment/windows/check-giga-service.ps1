<#
.SYNOPSIS
  Verifies GIGA CHEMIST auto-start on the pharmacy PC. Exit code 0 = healthy, 1 = problem found.
.DESCRIPTION
  Checks: scheduled task present/enabled/running, server answering /api/health with the database
  connected, .env set for hybrid sync (APP_MODE=hybrid, SYNC_ENABLED=true; values of secrets are
  never printed), PostgreSQL not exposed beyond this PC, recent server errors.
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\check-giga-service.ps1
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [int]$Port = 3000
)

$TaskName = "GIGA CHEMIST POS Server"
$problems = 0
function Ok([string]$m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:problems++ }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

Write-Host "GIGA CHEMIST - service check ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Cyan

# 1. Task
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Bad "Scheduled task '$TaskName' is not installed (run install-giga-service.ps1 as administrator)."
} else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    if ($task.State -eq "Disabled") { Bad "Task is DISABLED." } else { Ok "Task '$TaskName' state: $($task.State)" }
    if ($task.Principal.UserId -notmatch "SYSTEM") { Warn "Task runs as $($task.Principal.UserId) (expected SYSTEM)." } else { Ok "Runs as SYSTEM (no logon needed)" }
    $boot = $task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" }
    if ($boot) { Ok "Starts at system boot" } else { Bad "No at-startup trigger." }
    Write-Host "       last run: $($info.LastRunTime)  result: $($info.LastTaskResult)  next: $($info.NextRunTime)"
}
if (Get-ScheduledTask -TaskName "GigaChemistPOS_Service" -ErrorAction SilentlyContinue) {
    Bad "The older task 'GigaChemistPOS_Service' still exists (it forces APP_MODE=local). Re-run install-giga-service.ps1."
}

foreach ($t in @("GIGA CHEMIST Watchdog", "GIGA CHEMIST Updater")) {
    $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $x) { if ($t -like "*Watchdog") { Bad "Task '$t' missing (re-run install-giga-service.ps1)." } else { Warn "Task '$t' not installed (remote updates disabled; deployment\windows\updater\install-updater-task.ps1)." } }
    elseif ($x.State -eq "Disabled") { Bad "Task '$t' is DISABLED." }
    else { Ok "Task '$t': $($x.State)" }
}
$pgSvc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if (-not $pgSvc) { Bad "No postgresql* Windows service found." }
foreach ($svc in $pgSvc) {
    if ($svc.StartType -eq "Automatic") { Ok "PostgreSQL service $($svc.Name): Automatic, $($svc.Status)" } else { Bad "PostgreSQL service $($svc.Name) startup type is $($svc.StartType) (must be Automatic)." }
    if ($svc.Status -ne "Running") { Bad "PostgreSQL service $($svc.Name) is $($svc.Status)." }
}

# 2. Server
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -ErrorAction Stop
    Ok "Server answers on port $Port (mode: $($h.app_mode), version $($h.version))"
    if ($h.database.connected) { Ok "Local PostgreSQL connected" } else { Bad "Server is up but the database is NOT connected: $($h.database.error)" }
    if ($h.app_mode -ne "hybrid") { Bad "Server runs in '$($h.app_mode)' mode: cloud sync and remote admin need APP_MODE=hybrid." }
} catch {
    Bad "No answer from http://127.0.0.1:$Port/api/health ($($_.Exception.Message))."
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "       listening process: $($proc.ProcessName) (pid $($listener.OwningProcess))"
}

# 3. .env (names and non-secret switches only)
$envFile = Join-Path $ProjectRoot ".env"
if (Test-Path $envFile) {
    $envText = Get-Content $envFile
    $get = { param($k) ($envText | Where-Object { $_ -match "^\s*$k\s*=" } | Select-Object -First 1) -replace "^\s*$k\s*=\s*", "" }
    $mode = (& $get "APP_MODE").Trim()
    $sync = (& $get "SYNC_ENABLED").Trim().ToLower()
    if ($mode -eq "hybrid") { Ok ".env APP_MODE=hybrid" } else { Bad ".env APP_MODE=$mode (remote admin needs hybrid)" }
    if ($sync -eq "true") { Ok ".env SYNC_ENABLED=true" } else { Bad ".env SYNC_ENABLED is not true (commands from the phone would never be pulled)" }
    $bk = (& $get "BACKUP_ENABLED").Trim().ToLower()
    if ($bk -eq "true") { Ok ".env BACKUP_ENABLED=true (daily at $((& $get 'BACKUP_TIME').Trim()), dir $((& $get 'BACKUP_DIR').Trim()))" } else { Bad ".env BACKUP_ENABLED is not true (no automatic backups)" }
    foreach ($k in @("SUPABASE_URL", "SYNC_SHOP_TOKEN", "SHOP_ID")) {
        if ((& $get $k).Trim()) { Ok ".env $k is set (value not shown)" } else { Bad ".env $k is empty" }
    }
} else {
    Bad ".env not found in $ProjectRoot"
}

# 4. PostgreSQL must stay on this PC
$pg = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($pg) {
    $wide = $pg | Where-Object { $_.LocalAddress -in @("0.0.0.0", "::") }
    if ($wide) { Warn "PostgreSQL listens on all interfaces ($($wide.LocalAddress -join ', ')). Prefer listen_addresses = 'localhost' in postgresql.conf." }
    else { Ok "PostgreSQL listens on $((($pg.LocalAddress) | Select-Object -Unique) -join ', ') only" }
} else {
    Bad "Nothing listens on PostgreSQL port 5432."
}
$pgRules = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq "5432" } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" }
if ($pgRules) { Warn "Firewall allows inbound 5432: $($pgRules.DisplayName -join ', ')" } else { Ok "No inbound firewall rule opens PostgreSQL" }

# 5. Recent logs
$runnerLog = Join-Path $ProjectRoot "logs\giga-service.log"
if (Test-Path $runnerLog) {
    Write-Host "--- last runner log lines ---" -ForegroundColor Cyan
    Get-Content $runnerLog -Tail 8
}
$errLog = Join-Path $ProjectRoot "logs\server-err.log"
if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
    Write-Host "--- last server error lines ---" -ForegroundColor Cyan
    Get-Content $errLog -Tail 10
}

Write-Host ""
if ($problems -eq 0) { Write-Host "RESULT: HEALTHY" -ForegroundColor Green; exit 0 }
Write-Host "RESULT: $problems problem(s) found" -ForegroundColor Red
exit 1
