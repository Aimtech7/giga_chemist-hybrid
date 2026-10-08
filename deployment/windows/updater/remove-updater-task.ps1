<#
.SYNOPSIS
  Removes the "GIGA CHEMIST Updater" task. The installed version keeps running; no update is
  installed afterwards until the task is reinstalled. Run as administrator.
#>
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host "Run as administrator." -ForegroundColor Red; exit 1 }
$TaskName = "GIGA CHEMIST Updater"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[ OK ] Removed '$TaskName'." -ForegroundColor Green
} else {
    Write-Host "[INFO] '$TaskName' was not installed."
}
