<#
.SYNOPSIS
  Shows the updater task and the last update status (logs\runtime\update-state.json, logs\update.log).
  Exit 0 = task installed and last check succeeded.
#>
param([string]$ProjectRoot = "C:\GIGA-CHEMIST-POS")
$TaskName = "GIGA CHEMIST Updater"
$ok = $true
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "[FAIL] Task '$TaskName' is not installed (install-updater-task.ps1)." -ForegroundColor Red; $ok = $false }
else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "[ OK ] '$TaskName' $($task.State); runs as $($task.Principal.UserId); last run $($info.LastRunTime) result $($info.LastTaskResult); next $($info.NextRunTime)" -ForegroundColor Green
}
$stateFile = Join-Path $ProjectRoot "logs\runtime\update-state.json"
if (Test-Path $stateFile) {
    $s = Get-Content $stateFile -Raw | ConvertFrom-Json
    Write-Host "Status: $($s.status)  channel: $($s.channel)  checked: $($s.checked_at)"
    Write-Host "Installed: $($s.current_version) $($s.current_commit)"
    if ($s.available_commit) { Write-Host "Available: $($s.available_version) $($s.available_commit)" -ForegroundColor Yellow }
    if ($s.last_install) { Write-Host "Last install: $($s.last_install.result) $($s.last_install.at) $($s.last_install.detail)" }
    if ($s.message) { Write-Host "Message: $($s.message)" }
    if ($s.status -eq "CHECK_FAILED") { $ok = $false }
} else {
    Write-Host "[WARN] No update status yet." -ForegroundColor Yellow
}
$log = Join-Path $ProjectRoot "logs\update.log"
if (Test-Path $log) { Write-Host "--- last update log lines ---" -ForegroundColor Cyan; Get-Content $log -Tail 15 }
if ($ok) { exit 0 } else { exit 1 }
