# STEP 8 OF 8 - REBOOT TEST PREPARATION
# Verifies every auto-start piece, then asks before restarting Windows. After the restart nobody
# should open PowerShell or npm: the POS must come back by itself.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 8 OF 8 - READY TO REBOOT"

Assert-Admin
Assert-Root
foreach ($t in @("GIGA CHEMIST POS Server", "GIGA CHEMIST Watchdog", "GIGA CHEMIST Updater")) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $task) { Fail "task '$t' is missing (rerun step 5)" }
    if ($task.State -eq "Disabled") { Fail "task '$t' is disabled" }
    if ($task.Principal.UserId -notmatch "SYSTEM") { Fail "task '$t' does not run as SYSTEM" }
    Pass "task '$t' enabled, runs as SYSTEM"
}
$boot = (Get-ScheduledTask -TaskName "GIGA CHEMIST POS Server").Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" }
if (-not $boot) { Fail "server task has no at-startup trigger" }
Pass "server starts at Windows boot"
foreach ($svc in (Get-Service -Name "postgresql*")) {
    if ($svc.StartType -ne "Automatic") { Fail "PostgreSQL $($svc.Name) is not Automatic" }
    Pass "PostgreSQL $($svc.Name) starts automatically"
}
if (Get-ScheduledTask -TaskName "GigaChemistPOS_Service" -ErrorAction SilentlyContinue) { Fail "old task GigaChemistPOS_Service still exists" }
Pass "old auto-start task removed"
$h = Test-GigaHealth
if (-not $h) { Fail "the server is not healthy right now" }
Pass "server healthy before reboot"

Write-Host ""
Write-Host "  READY TO REBOOT" -ForegroundColor Green
Write-Host "  After the restart: do NOT open PowerShell or npm. Wait 3 minutes, then do the PHONE TEST" -ForegroundColor Green
Write-Host "  in C:\GIGA-CHEMIST-POS\TARGET-RUN\README-FIRST.txt (phone on MOBILE DATA)." -ForegroundColor Green
Write-Host ""
$a = Read-Host "  Type REBOOT to restart Windows now (anything else = restart later yourself)"
Add-Log "PASS Step 8 (ready to reboot)"
if ($a -ceq "REBOOT") { Restart-Computer -Force }
Write-Host "  Not restarting now. Restart Windows when ready, then follow README-FIRST.txt." -ForegroundColor Yellow
exit 0
