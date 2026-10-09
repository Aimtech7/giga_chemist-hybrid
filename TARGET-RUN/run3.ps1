# STEP 3 OF 8 - APPLY LOCAL MIGRATIONS
# Stops the old POS server (if running), applies the rehearsed migrations to giga_chemist, runs the
# database check and proves every business row is still there. Never seeds or resets data.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 3 OF 8 - APPLY DATABASE MIGRATIONS"

Assert-Admin
Assert-Root
if (-not (Test-Path (Join-Path $GigaRoot "logs\runtime\install-baseline-counts.json"))) { Fail "Step 1 has not passed yet." }
$report = Get-ChildItem (Join-Path $GigaRoot "logs") -Filter "migration-rehearsal-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $report) { Fail "no migration rehearsal report: run .\run2.ps1 first." }
$rr = Get-Content $report.FullName -Raw | ConvertFrom-Json
if ($rr.result -ne "PASS") { Fail "the latest rehearsal ($($report.Name)) is $($rr.result), not PASS. Do not apply migrations." }
if (((Get-Date) - $report.LastWriteTime).TotalHours -gt 24) { Fail "the rehearsal is older than 24 hours: run .\run2.ps1 again." }
Pass "rehearsal PASS found ($($report.Name))"

# The POS is offline from here until step 5 starts the new version.
$legacy = Get-ScheduledTask -TaskName "GigaChemistPOS_Service" -ErrorAction SilentlyContinue
if ($legacy) {
    Stop-ScheduledTask -TaskName "GigaChemistPOS_Service" -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName "GigaChemistPOS_Service" | Out-Null
    Pass "old auto-start task stopped and disabled (removed in step 5)"
}
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") { Stop-Process -Id $p.Id -Force; Pass "stopped the running POS server (pid $($p.Id)) for the upgrade" }
    elseif ($p) { Fail "port 3000 is used by $($p.ProcessName) (pid $($p.Id)), not GIGA CHEMIST. Close it and rerun." }
}

Invoke-Npm @("run", "db:migrate") "database migrations applied"
Invoke-Npm @("run", "db:check") "database check"
Info ""
Info "Comparing business data with the counts saved in step 1..."
Invoke-Check "counts-compare"

Done "Step 3 (migrations; business data verified intact)" "run4.ps1"
