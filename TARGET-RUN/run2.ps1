# STEP 2 OF 8 - MIGRATION REHEARSAL
# Copies giga_chemist into a separate rehearsal database, applies all pending migrations to the COPY
# and proves no business data changes. The real database is only read (pg_dump).
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 2 OF 8 - MIGRATION REHEARSAL (on a copy)"

Assert-Admin
Assert-Root
$envMap = Get-EnvMap
if (-not (Test-Path (Join-Path $GigaRoot "logs\runtime\install-baseline-counts.json"))) { Fail "Step 1 has not passed yet. Run .\run1.ps1 first." }

Info "Rehearsing on a copy of giga_chemist (several minutes for a large database)..."
$node = Get-NodeExe
& $node --import tsx scripts/target/rehearse-migration.ts --source-db giga_chemist
if ($LASTEXITCODE -ne 0) { Fail "the rehearsal did not report PASS - the real database was NOT changed." }
Pass "rehearsal PASS: pending migrations keep all business data unchanged (real database untouched)"

Done "Step 2 (migration rehearsal)" "run3.ps1"
