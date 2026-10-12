<#
.SYNOPSIS
  PC2 / development launcher. Verifies PostgreSQL, starts "tsx server.ts" in the background,
  waits for /api/health and only then opens the browser.
  Does NOT install scheduled tasks, autostart or the updater (those are Shop 1 production only).
  Refuses to start unless .env is APP_MODE=local and SYNC_ENABLED=false, so PC2 can never act as Shop 1.
#>
param([string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\.."), [int]$Port = 3000, [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$healthUrl = "http://127.0.0.1:$Port/api/health"

function Get-Health { try { Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 } catch { $null } }
function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }

# 1. .env safety: PC2 stays local and unsynced.
$envFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $envFile)) { Fail ".env not found in $ProjectRoot" }
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $cfg[$matches[1]] = $matches[2].Trim() }
if ($cfg["APP_MODE"] -ne "local") { Fail "APP_MODE is '$($cfg["APP_MODE"])'; PC2 must be APP_MODE=local." }
if ($cfg["SYNC_ENABLED"] -and $cfg["SYNC_ENABLED"] -ne "false") { Fail "SYNC_ENABLED must be false on PC2." }
Write-Host "[ OK ] .env: APP_MODE=local, SYNC_ENABLED=false, DB_NAME=$($cfg["DB_NAME"])"

# 2. Already running?
$h = Get-Health
if ($h -and $h.system -like "GIGA CHEMIST*") {
    Write-Host "[ OK ] Server already running (mode $($h.app_mode), commit $($h.commit))." -ForegroundColor Green
} else {
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($owner) { Fail "Port $Port is held by PID $($owner.OwningProcess) ($((Get-Process -Id $owner.OwningProcess).ProcessName)) which is not GIGA CHEMIST." }

    # 3. PostgreSQL service + TCP reachability.
    $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $svc) { Fail "No PostgreSQL Windows service found." }
    if ($svc.Status -ne "Running") {
        Write-Host "Starting $($svc.Name)..."
        try { Start-Service $svc.Name } catch { Fail "Cannot start $($svc.Name) (run as administrator): $($_.Exception.Message)" }
    }
    $dbHost = if ($cfg["DB_HOST"]) { $cfg["DB_HOST"] } else { "127.0.0.1" }
    $dbPort = if ($cfg["DB_PORT"]) { [int]$cfg["DB_PORT"] } else { 5432 }
    if (-not (Test-NetConnection $dbHost -Port $dbPort -InformationLevel Quiet -WarningAction SilentlyContinue)) { Fail "PostgreSQL not reachable on ${dbHost}:$dbPort." }
    Write-Host "[ OK ] PostgreSQL $($svc.Name) running on ${dbHost}:$dbPort"

    # 4. Start the server detached, logging to logs\pc2-server*.log.
    $logDir = Join-Path $ProjectRoot "logs"; New-Item -ItemType Directory -Force $logDir | Out-Null
    $out = Join-Path $logDir "pc2-server.log"; $err = Join-Path $logDir "pc2-server-err.log"
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm start" -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    Write-Host "Server starting (PID $($p.Id)); waiting for $healthUrl ..."

    # 5. Wait for health (max 90 s).
    for ($i = 0; $i -lt 45 -and -not ($h -and $h.system -like "GIGA CHEMIST*"); $i++) {
        Start-Sleep -Seconds 2
        if ($p.HasExited) { Get-Content $out, $err -Tail 20 -ErrorAction SilentlyContinue; Fail "Server process exited (code $($p.ExitCode)). See $out / $err" }
        $h = Get-Health
    }
    if (-not $h) { Get-Content $out, $err -Tail 20 -ErrorAction SilentlyContinue; Fail "Server not healthy after 90 s. See $out / $err" }
    Write-Host "[ OK ] GIGA CHEMIST healthy (mode $($h.app_mode), database connected $($h.database.connected), commit $($h.commit))." -ForegroundColor Green
}

if (-not $h.database.connected) { Fail "API is up but the database is NOT connected." }
if ($h.app_mode -ne "local") { Fail "Server reports mode '$($h.app_mode)'; expected local." }

# 6. Browser only after health passes.
if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
