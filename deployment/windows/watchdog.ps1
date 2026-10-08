<#
.SYNOPSIS
  GIGA CHEMIST watchdog (task "GIGA CHEMIST Watchdog", SYSTEM, every 5 minutes).
.DESCRIPTION
  Detects what the supervisor cannot: a server process that is alive but HUNG, or a supervisor
  that is not running at all.
    - PostgreSQL service stopped        -> start it (never reinstalls / reconfigures it)
    - supervisor task not running       -> start "GIGA CHEMIST POS Server"
    - server answers no health check 3x -> stop the hung node process; the supervisor restarts it
  Does nothing while the updater holds logs\runtime\maintenance.lock. Logs to logs\watchdog.log.
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [int]$Port = 3000
)
$TaskName = "GIGA CHEMIST POS Server"
$log = Join-Path $ProjectRoot "logs\watchdog.log"
function Write-Log([string]$m) { try { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) } catch {} }
function Test-Health {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 8 -ErrorAction Stop
        return ($h.system -like "GIGA CHEMIST*")
    } catch { return $false }
}

if (Test-Path (Join-Path $ProjectRoot "logs\runtime\maintenance.lock")) { exit 0 }

$pg = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pg -and $pg.Status -ne "Running") {
    try { Start-Service -Name $pg.Name -ErrorAction Stop; Write-Log "PostgreSQL service $($pg.Name) was $($pg.Status); started it." }
    catch { Write-Log "PostgreSQL service $($pg.Name) is $($pg.Status) and could not be started: $($_.Exception.Message)" }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -ne "Running" -and $task.State -ne "Disabled") {
    Start-ScheduledTask -TaskName $TaskName
    Write-Log "Supervisor task was $($task.State); started it."
    exit 0
}

if (Test-Health) { exit 0 }
Start-Sleep -Seconds 20
if (Test-Health) { exit 0 }
Start-Sleep -Seconds 20
if (Test-Health) { exit 0 }

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $p = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Log "Server (pid $($p.Id)) listened on $Port but failed 3 health checks; stopped it so the supervisor restarts it."
    } else {
        Write-Log "Port $Port is held by $($p.ProcessName) (pid $($listener.OwningProcess)), not GIGA CHEMIST. Not touched."
    }
} else {
    Write-Log "No server listening on $Port and health failing; the supervisor should be (re)starting it."
}
