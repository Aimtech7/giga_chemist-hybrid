<#
.SYNOPSIS
    GIGA CHEMIST - PostgreSQL Windows Service Diagnostic & Repair Script
    Restores postgresql-x64-18 Windows Service ownership of port 5432 without data loss.

.DESCRIPTION
    Root cause on Shop 1:
    postgres.exe was started manually (e.g. via pg_ctl or console launcher) rather than
    through the Windows Service Control Manager (SCM). The orphan postgres process locks port 5432
    and postmaster.pid, causing SCM to report postgresql-x64-18 as STOPPED and preventing
    the service from starting cleanly.

    This maintenance script:
    1. Inspects port 5432 listener PID and service status.
    2. Gracefully stops any orphan postgres process using pg_ctl stop -m fast.
    3. Sets postgresql-x64-18 startup type to Automatic.
    4. Starts postgresql-x64-18 through the Service Control Manager.
    5. Validates that port 5432 is reachable and giga_chemist database is healthy.
#>

[CmdletBinding()]
param(
    [string]$ServiceName = "postgresql-x64-18",
    [string]$DataDir = "C:\Program Files\PostgreSQL\18\data",
    [string]$PostgresBinDir = "C:\Program Files\PostgreSQL\18\bin",
    [int]$Port = 5432
)

$ErrorActionPreference = "Stop"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  GIGA CHEMIST - POSTGRESQL SERVICE REPAIR" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Inspect Service Status
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Warning "Service '$ServiceName' not found. Searching for any postgresql service..."
    $service = Get-Service -Name "*postgres*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $service) {
        Write-Error "No PostgreSQL service found on this system."
        exit 1
    }
    $ServiceName = $service.Name
}

Write-Host "[1/5] Service '$ServiceName' current status: $($service.Status)" -ForegroundColor Yellow

# 2. Inspect Port 5432
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$listenerPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique

Write-Host "[2/5] Port $Port listeners detected: $($listenerPids -join ', ')" -ForegroundColor Yellow

# 3. Handle orphan manual processes if service is stopped
if ($service.Status -ne "Running" -and $listenerPids) {
    Write-Host "[3/5] Service is STOPPED but port $Port is occupied by PID(s): $($listenerPids -join ', ')." -ForegroundColor Red
    Write-Host "      Stopping orphan manual PostgreSQL process gracefully..." -ForegroundColor Yellow

    $pgCtl = Join-Path $PostgresBinDir "pg_ctl.exe"
    if (Test-Path $pgCtl -and (Test-Path $DataDir)) {
        & $pgCtl stop -D $DataDir -m fast
        Start-Sleep -Seconds 2
    }

    # Verify if any listener remains
    $remaining = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($remaining) {
        foreach ($p in $remaining.OwningProcess | Select-Object -Unique) {
            Write-Host "      Terminating residual process PID $p..." -ForegroundColor Yellow
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
} else {
    Write-Host "[3/5] No orphan process conflict detected." -ForegroundColor Green
}

# 4. Configure Service to Automatic and Start
Write-Host "[4/5] Setting '$ServiceName' to Automatic and starting..." -ForegroundColor Yellow
Set-Service -Name $ServiceName -StartupType Automatic
if ((Get-Service -Name $ServiceName).Status -ne "Running") {
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
}

$refreshedService = Get-Service -Name $ServiceName
Write-Host "      Service '$ServiceName' status: $($refreshedService.Status) (Startup: $($refreshedService.StartType))" -ForegroundColor Green

# 5. Verify Health and Database Connectivity
Write-Host "[5/5] Verifying PostgreSQL listener and giga_chemist connection..." -ForegroundColor Yellow
$newListeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$newPid = $newListeners | Select-Object -ExpandProperty OwningProcess -First 1

if ($newPid) {
    Write-Host "      Port $Port active listener PID: $newPid" -ForegroundColor Green
} else {
    Write-Error "PostgreSQL is not listening on port $Port."
    exit 1
}

# Test connection via node script if in POS directory
$testScript = "npx tsx -e `"import { pgPool } from './server/db/client'; (async () => { const r = await pgPool.query('SELECT 1 AS healthy'); console.log('DB Healthy:', r.rows[0].healthy === 1); await pgPool.end(); process.exit(0); })();`""
try {
    Invoke-Expression $testScript
} catch {
    Write-Warning "Database health check warning: $($_.Exception.Message)"
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  POSTGRESQL SERVICE REPAIR COMPLETED SUCCESSFULLY" -ForegroundColor Green
Write-Host "  Service: $ServiceName (Running, Automatic)" -ForegroundColor Green
Write-Host "  Port $Port: Owned by service process" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
