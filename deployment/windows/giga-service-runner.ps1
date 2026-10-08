<#
.SYNOPSIS
  GIGA CHEMIST - supervised production server (started by the "GIGA CHEMIST POS Server" task).
.DESCRIPTION
  Runs at Windows startup as SYSTEM (no user logon, no PowerShell window needed):
    1. waits for the local PostgreSQL to accept connections (it never gives up; logs once a minute)
    2. starts "node node_modules\tsx\dist\cli.mjs server.ts" in the project directory
    3. if the server exits, restarts it with back-off (5 s doubling to 60 s; reset after 10 min up)
  All configuration (APP_MODE, SYNC_ENABLED, database, cloud credentials) comes from the project's
  .env file. This script sets ONLY NODE_ENV=production and never reads, prints or stores secrets.
  If a healthy GIGA CHEMIST server is already listening (e.g. started by hand), it does not start a
  second one; it keeps watching and takes over when that one stops.
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [string]$NodeExe = "",
    [int]$Port = 3000
)

$ErrorActionPreference = "Continue"
Set-Location -Path $ProjectRoot

$LogDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$RunnerLog = Join-Path $LogDir "giga-service.log"
$OutLog = Join-Path $LogDir "server-out.log"
$ErrLog = Join-Path $LogDir "server-err.log"

function Write-Log([string]$Message, [string]$Level = "INFO") {
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    try { Add-Content -Path $RunnerLog -Value $line -Encoding UTF8 } catch {}
}

function Rotate-Log([string]$Path, [int]$MaxMB = 10) {
    try {
        if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt ($MaxMB * 1MB))) {
            $old = "$Path.1"
            if (Test-Path $old) { Remove-Item $old -Force }
            Rename-Item -Path $Path -NewName (Split-Path $old -Leaf) -Force
        }
    } catch {}
}

# Reads one NON-SECRET key from .env (DB_HOST / DB_PORT only); never logs other values.
function Get-EnvValue([string]$Key, [string]$Default) {
    $envFile = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path $envFile)) { return $Default }
    foreach ($l in Get-Content $envFile) {
        if ($l -match "^\s*$Key\s*=\s*(.*)\s*$") {
            $v = $Matches[1].Trim().Trim('"').Trim("'")
            if ($v) { return $v }
        }
    }
    return $Default
}

function Test-Tcp([string]$HostName, [int]$TcpPort) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect($HostName, $TcpPort, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(1500, $false) -and $c.Connected) { $c.EndConnect($ar); return $true }
        return $false
    } catch { return $false } finally { $c.Close() }
}

function Test-GigaHealth {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -ErrorAction Stop
        return ($h -and $h.system -like "GIGA CHEMIST*")
    } catch { return $false }
}

# Only one runner at a time (the task's watchdog trigger may fire while one is running).
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\GigaChemistServiceRunner", [ref]$created)
if (-not $created) { exit 0 }

try {
    Rotate-Log $RunnerLog
    Write-Log "Runner starting (project $ProjectRoot, port $Port, pid $PID)." "START"

    if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) { $NodeExe = $cmd.Source }
    }
    $Tsx = Join-Path $ProjectRoot "node_modules\tsx\dist\cli.mjs"
    if (-not $NodeExe -or -not (Test-Path $NodeExe)) { Write-Log "node.exe not found. Re-run install-giga-service.ps1." "FATAL"; exit 1 }
    if (-not (Test-Path $Tsx)) { Write-Log "tsx runtime missing ($Tsx). Run 'npm ci' in $ProjectRoot." "FATAL"; exit 1 }
    if (-not (Test-Path (Join-Path $ProjectRoot ".env"))) { Write-Log ".env missing in $ProjectRoot (configuration and secrets live there)." "FATAL"; exit 1 }

    # 1. Local PostgreSQL (127.0.0.1 only; it is never exposed to the internet).
    $dbHost = Get-EnvValue "DB_HOST" "127.0.0.1"
    $dbPort = [int](Get-EnvValue "DB_PORT" "5432")
    $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    $waited = 0
    while (-not (Test-Tcp $dbHost $dbPort)) {
        if ($pgService -and $pgService.Status -ne "Running" -and ($waited % 60) -eq 0) {
            try { Start-Service -Name $pgService.Name -ErrorAction Stop; Write-Log "Started service $($pgService.Name)." } catch { Write-Log "Could not start $($pgService.Name): $($_.Exception.Message)" "WARN" }
            $pgService.Refresh()
        }
        if (($waited % 60) -eq 0) { Write-Log "Waiting for PostgreSQL on ${dbHost}:$dbPort ..." "WAIT" }
        Start-Sleep -Seconds 5
        $waited += 5
    }
    Write-Log "PostgreSQL is accepting connections on ${dbHost}:$dbPort." "OK"

    if (-not (Test-Path (Join-Path $ProjectRoot "dist\index.html"))) {
        Write-Log "dist\index.html missing: building the web app once (vite build)." "INFO"
        & $NodeExe (Join-Path $ProjectRoot "node_modules\vite\bin\vite.js") build *>> $OutLog
    }

    # 2-3. Start and supervise.
    $env:NODE_ENV = "production"
    $failures = 0
    $RuntimeDir = Join-Path $LogDir "runtime"
    if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
    $MaintLock = Join-Path $RuntimeDir "maintenance.lock"
    $RestartLog = Join-Path $RuntimeDir "restarts.log"
    while ($true) {
        # The updater holds the server down while it replaces the code (maintenance.lock).
        if (Test-Path $MaintLock) {
            if (((Get-Date) - (Get-Item $MaintLock).LastWriteTime).TotalHours -gt 3) {
                Write-Log "Removing a stale maintenance lock (older than 3 h)." "WARN"
                Remove-Item $MaintLock -Force -ErrorAction SilentlyContinue
            } else {
                Start-Sleep -Seconds 3
                continue
            }
        }
        if (Test-GigaHealth) {
            # Someone else (a manual start) already serves the POS: watch it, do not duplicate it.
            Start-Sleep -Seconds 30
            continue
        }
        Rotate-Log $OutLog
        Rotate-Log $ErrLog
        $started = Get-Date
        Write-Log "Starting GIGA CHEMIST server: node tsx server.ts" "START"
        try {
            $p = Start-Process -FilePath $NodeExe -ArgumentList @("`"$Tsx`"", "server.ts") -WorkingDirectory $ProjectRoot `
                -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden -PassThru -ErrorAction Stop
            Write-Log "Server process started (pid $($p.Id))." "OK"
            $p.WaitForExit()
            $code = $p.ExitCode
        } catch {
            $code = -1
            Write-Log "Could not start the server: $($_.Exception.Message)" "ERROR"
        }
        $upMinutes = ((Get-Date) - $started).TotalMinutes
        if (Test-Path $MaintLock) {
            Write-Log "Server stopped for maintenance (update in progress)." "INFO"
            continue
        }
        # One line per unexpected exit: the heartbeat raises SERVICE_CRASHING at 3+ per hour.
        try {
            Add-Content -Path $RestartLog -Value ("{0} exit={1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $code)
            $lines = Get-Content $RestartLog
            if ($lines.Count -gt 500) { $lines | Select-Object -Last 200 | Set-Content $RestartLog }
        } catch {}
        if ($upMinutes -ge 10) { $failures = 0 } else { $failures++ }
        $delay = [Math]::Min(60, 5 * [Math]::Pow(2, [Math]::Min($failures, 4)))
        Write-Log ("Server exited (code {0}) after {1:N1} min; restarting in {2} s. See logs\server-err.log." -f $code, $upMinutes, $delay) "WARN"
        Start-Sleep -Seconds $delay
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
