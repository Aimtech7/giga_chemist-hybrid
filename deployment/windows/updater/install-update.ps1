<#
.SYNOPSIS
  Installs the tip of the approved production branch NOW (operator on the PC): verified backup, build, migrate, restart, health check, automatic rollback.
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\updater\install-update.ps1
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [string]$Commit = ""
)
$runner = Join-Path $PSScriptRoot "run-updater.ps1"
& $runner -Mode install -ProjectRoot $ProjectRoot -Commit $Commit
$code = $LASTEXITCODE
$state = Join-Path $ProjectRoot "logs\runtime\update-state.json"
if (Test-Path $state) { Get-Content $state }
exit $code
