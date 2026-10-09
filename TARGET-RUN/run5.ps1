# STEP 5 OF 8 - INSTALL THE WINDOWS SERVICES
# Installs (as SYSTEM, no logon needed): GIGA CHEMIST POS Server, GIGA CHEMIST Watchdog,
# PostgreSQL Automatic startup, GIGA CHEMIST Updater. Uses ONLY the new PowerShell 5.1 scripts.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 5 OF 8 - INSTALL AUTO-START, WATCHDOG AND UPDATER"

Assert-Admin
Assert-Root
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

Info "Installing the server + watchdog tasks (old GigaChemistPOS_Service task is removed)..."
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GigaRoot "deployment\windows\install-giga-service.ps1") -ProjectRoot $GigaRoot
if ($LASTEXITCODE -ne 0) { Fail "install-giga-service.ps1 failed (exit $LASTEXITCODE). See logs\giga-service.log and logs\server-err.log" }
Pass "server + watchdog installed, PostgreSQL set to Automatic, server started"

Info "Installing the updater task (approved production channel only)..."
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GigaRoot "deployment\windows\updater\install-updater-task.ps1") -ProjectRoot $GigaRoot
if ($LASTEXITCODE -ne 0) { Fail "install-updater-task.ps1 failed (exit $LASTEXITCODE)" }
Pass "updater installed"

Info "Waiting for the server to report healthy..."
$h = $null
for ($i = 0; $i -lt 40 -and -not $h; $i++) { Start-Sleep -Seconds 3; $h = Test-GigaHealth }
if (-not $h) { Fail "the server did not become healthy. See logs\giga-service.log and logs\server-err.log" }
if ($h.app_mode -ne "hybrid") { Fail "server runs in mode '$($h.app_mode)' (must be hybrid)" }
Pass "server healthy (mode hybrid, version $($h.app_version))"

& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GigaRoot "deployment\windows\check-giga-service.ps1") -ProjectRoot $GigaRoot
if ($LASTEXITCODE -ne 0) { Fail "check-giga-service.ps1 reported problems (FAIL lines above)" }
Pass "service check HEALTHY"

& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GigaRoot "deployment\windows\updater\check-updater.ps1") -ProjectRoot $GigaRoot
if ($LASTEXITCODE -ne 0) { Fail "updater check failed" }
Pass "updater check OK"

Done "Step 5 (services installed and healthy)" "run6.ps1"
