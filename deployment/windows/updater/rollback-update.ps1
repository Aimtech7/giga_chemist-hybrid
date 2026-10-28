<#
.SYNOPSIS
  Returns the CODE to the previous known-good version (or -Commit <sha>), rebuilds, restarts and checks health. The database is not restored.
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\updater\rollback-update.ps1
#>
param(
    [string]$ProjectRoot = "",
    [string]$Commit = ""
)

if (-not $ProjectRoot) {
    if ($PSScriptRoot) {
        $candidate = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
        if (Test-Path (Join-Path $candidate "server.ts")) { $ProjectRoot = $candidate }
    }
    if (-not $ProjectRoot) {
        if (Test-Path "C:\GIGA-CHEMIST-POS-2\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS-2" }
        elseif (Test-Path "C:\GIGA-CHEMIST-POS\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS" }
        else { $ProjectRoot = (Get-Location).Path }
    }
}
$runner = Join-Path $PSScriptRoot "run-updater.ps1"
& $runner -Mode rollback -ProjectRoot $ProjectRoot -Commit $Commit
$code = $LASTEXITCODE
$state = Join-Path $ProjectRoot "logs\runtime\update-state.json"
if (Test-Path $state) { Get-Content $state }
exit $code
