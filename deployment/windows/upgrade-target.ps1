<#
.SYNOPSIS
  GIGA CHEMIST - SAFE TARGET PC UPGRADE (new code + non-destructive migrations + EXISTING database)

.DESCRIPTION
  TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA.

  This script upgrades the pharmacy PC in place. It keeps the existing giga_chemist database (real
  sales, stock counts, users...) and only applies pending schema migrations, after proving them on a
  rehearsal copy. It NEVER restores a development dump, zeroes stock, resets expiry, seeds demo data,
  replaces sales/users or runs the development reset script.

  Order:
    1  validate project path             7  MANDATORY migration rehearsal on a
    2  validate PostgreSQL service          temporary copy (must PASS)
    3  validate database == giga_chemist  8  pre-upgrade backup (verified)
    4  refuse dev-reset configuration    9  invariants BEFORE (read-only snapshot)
    5  install dependencies + build      10 run migrations on giga_chemist
    6  stop the POS                      11 db:check + invariants AFTER (must match)
                                         12 start the POS + health check -> PASS/FAIL

  Nothing is ever restored automatically. If a step after the migration fails, the script stops and
  prints the backup file to restore MANUALLY (see docs/GIGA_CHEMIST_BACKUP_RESTORE.md).

.PARAMETER ProjectRoot     Default C:\GIGA-CHEMIST-POS
.PARAMETER ExpectedDatabase Default giga_chemist (the script refuses any other database)
.PARAMETER ValidateOnly    Run checks 1-4 only and change nothing.
.PARAMETER SkipInstall     Do not run "npm ci" (offline PC with node_modules already present).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deployment\windows\upgrade-target.ps1 -ValidateOnly
  powershell -ExecutionPolicy Bypass -File deployment\windows\upgrade-target.ps1
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [string]$ExpectedDatabase = "giga_chemist",
    [int]$Port = 3000,
    [switch]$ValidateOnly,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$TaskName = "GigaChemistPOS_Service"
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$Results = New-Object System.Collections.ArrayList
$script:BackupFile = $null

function Step([string]$Name, [bool]$Ok, [string]$Detail = "") {
    [void]$Results.Add([pscustomobject]@{ Step = $Name; Result = $(if ($Ok) { "PASS" } else { "FAIL" }); Detail = $Detail })
    $color = if ($Ok) { "Green" } else { "Red" }
    Write-Host ("  {0}  {1} {2}" -f $(if ($Ok) { "PASS" } else { "FAIL" }), $Name, $(if ($Detail) { "- $Detail" } else { "" })) -ForegroundColor $color
    if (-not $Ok) { Finish $false }
}

function Finish([bool]$Pass) {
    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor Cyan
    $Results | Format-Table -AutoSize | Out-String | Write-Host
    if ($Pass) {
        Write-Host "  UPGRADE RESULT: PASS" -ForegroundColor Green
    } else {
        Write-Host "  UPGRADE RESULT: FAIL - nothing was restored automatically." -ForegroundColor Red
        if ($script:BackupFile) {
            Write-Host "  Pre-upgrade backup: $script:BackupFile" -ForegroundColor Yellow
            Write-Host "  Restore ONLY if instructed, following docs\GIGA_CHEMIST_BACKUP_RESTORE.md" -ForegroundColor Yellow
        }
    }
    Write-Host "======================================================================" -ForegroundColor Cyan
    if ($Pass) { exit 0 } else { exit 1 }
}

function Run-Npm([string]$Arguments, [string]$Label) {
    $log = Join-Path $ProjectRoot "logs\upgrade_$Stamp.log"
    Add-Content -Path $log -Value "`n===== npm $Arguments ====="
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm $Arguments >> `"$log`" 2>&1" -WorkingDirectory $ProjectRoot -NoNewWindow -Wait -PassThru
    return $p.ExitCode
}

function Read-DotEnv([string]$File) {
    $map = @{}
    foreach ($line in Get-Content $File) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $map[$Matches[1]] = $Matches[2].Trim('"') }
    }
    return $map
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   GIGA CHEMIST - SAFE TARGET UPGRADE ($Stamp)" -ForegroundColor Green
Write-Host "   TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA" -ForegroundColor Yellow
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Project path ------------------------------------------------------------------------------
$pkg = Join-Path $ProjectRoot "package.json"
$okPath = (Test-Path $pkg) -and (Test-Path (Join-Path $ProjectRoot "migrations")) -and (Test-Path (Join-Path $ProjectRoot "server.ts")) -and (Test-Path (Join-Path $ProjectRoot ".env"))
Step "Project path $ProjectRoot (package.json, migrations, server.ts, .env)" $okPath
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "logs") | Out-Null
Set-Location $ProjectRoot

# 2. PostgreSQL service ------------------------------------------------------------------------
$svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Running" } | Select-Object -First 1
Step "PostgreSQL service running" ($null -ne $svc) $(if ($svc) { $svc.Name } else { "no running postgresql* service" })

# 3. Database name -----------------------------------------------------------------------------
$envMap = Read-DotEnv (Join-Path $ProjectRoot ".env")
$dbName = $null
foreach ($k in @("LOCAL_DATABASE_URL", "DATABASE_URL")) {
    if ($envMap[$k] -and -not $dbName) {
        try { $dbName = ([System.Uri]$envMap[$k]).AbsolutePath.TrimStart("/") } catch { }
    }
}
if (-not $dbName) { $dbName = $envMap["DB_NAME"] }
Step "Configured database is '$ExpectedDatabase'" ($dbName -eq $ExpectedDatabase) "configured: $dbName"
if ($envMap["DB_NAME"] -and $envMap["DB_NAME"] -ne $ExpectedDatabase) { Step "DB_NAME agrees with the connection URL" $false "DB_NAME=$($envMap["DB_NAME"])" }

# 4. Dev reset / demo data protection ----------------------------------------------------------
$devFlags = ($envMap["ALLOW_DEV_STOCK_RESET"] -eq "true") -or ($env:ALLOW_DEV_STOCK_RESET -eq "true")
Step "Development reset is NOT enabled (ALLOW_DEV_STOCK_RESET)" (-not $devFlags)
$devDumpConfigured = ($dbName -match "_dev$") -or ($envMap["DB_NAME"] -match "_dev$")
Step "No development database configured" (-not $devDumpConfigured)

if ($ValidateOnly) {
    Write-Host "`n  -ValidateOnly: no changes made." -ForegroundColor Yellow
    Finish $true
}

# 5. Dependencies + build (POS still running on the old build) ---------------------------------
if (-not $SkipInstall) {
    $code = Run-Npm "ci" "install"
    Step "npm ci (dependencies)" ($code -eq 0) "see logs\upgrade_$Stamp.log"
}
$code = Run-Npm "run build" "build"
Step "npm run build" ($code -eq 0)

# 6. Stop POS (no sales while the database is copied and upgraded) ----------------------------------------------------------------------------------
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
Step "POS stopped (port $Port free)" ($null -eq $still)

# 7. Mandatory rehearsal on a temporary copy (giga_chemist itself is untouched) ---------------------------------------------------
$code = Run-Npm "run target:rehearse -- --source-db $ExpectedDatabase" "rehearsal"
Step "Migration rehearsal on giga_chemist_migration_test" ($code -eq 0) "report in logs\migration-rehearsal-*.json"

# 8. Pre-upgrade backup ------------------------------------------------------------------------
$code = Run-Npm "run backup -- --pre-upgrade" "backup"
$latest = Get-ChildItem -Path (Join-Path $ProjectRoot "backups") -Filter "$($ExpectedDatabase)_*.dump" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) { $script:BackupFile = $latest.FullName }
Step "Pre-upgrade backup created and verified" (($code -eq 0) -and ($null -ne $latest)) $script:BackupFile

# 9. Invariants BEFORE -------------------------------------------------------------------------
$before = Join-Path $ProjectRoot "logs\invariants_before_$Stamp.json"
$after = Join-Path $ProjectRoot "logs\invariants_after_$Stamp.json"
$code = Run-Npm "run target:rehearse -- --source-db $ExpectedDatabase --snapshot `"$before`"" "snapshot-before"
Step "Invariants captured before migration" ($code -eq 0) $before

# 10. Migrations on the real database ----------------------------------------------------------
$code = Run-Npm "run db:migrate" "migrate"
Step "npm run db:migrate on $ExpectedDatabase" ($code -eq 0)

# 11. db:check + invariants AFTER --------------------------------------------------------------
$code = Run-Npm "run db:check" "check"
Step "npm run db:check" ($code -eq 0)
$code = Run-Npm "run target:rehearse -- --source-db $ExpectedDatabase --snapshot `"$after`"" "snapshot-after"
Step "Invariants captured after migration" ($code -eq 0)
$code = Run-Npm "run target:rehearse -- --compare `"$before`" `"$after`"" "compare"
Step "Business data unchanged (counts, stock sums, money, users, batches, purchases, returns, latest sales)" ($code -eq 0)

# 12. Start POS + health -----------------------------------------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Start-ScheduledTask -TaskName $TaskName
} else {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run start:local >> `"$ProjectRoot\logs\server.log`" 2>&1" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}
$healthy = $false
for ($i = 0; $i -lt 60 -and -not $healthy; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
        $healthy = ($h.status -eq "online") -and ($h.database.connected -eq $true)
    } catch { }
}
Step "POS started; /api/health online with PostgreSQL connected" $healthy "http://127.0.0.1:$Port"
Finish $true
