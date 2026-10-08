<#
.SYNOPSIS
  Checks the approved production branch and records UPDATE_AVAILABLE / NO_UPDATE (never installs).
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\updater\check-for-update.ps1
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [string]$Commit = ""
)
$runner = Join-Path $PSScriptRoot "run-updater.ps1"
& $runner -Mode check -ProjectRoot $ProjectRoot -Commit $Commit
$code = $LASTEXITCODE
$state = Join-Path $ProjectRoot "logs\runtime\update-state.json"
if (Test-Path $state) { Get-Content $state }
exit $code
