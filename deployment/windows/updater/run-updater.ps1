<#
.SYNOPSIS
  Runs the GIGA CHEMIST updater (scripts/updater/updater.mjs) from a COPY in logs\runtime, so the
  file can be replaced by the update it is installing. Used by the "GIGA CHEMIST Updater" task and
  by check-for-update.ps1 / install-update.ps1 / rollback-update.ps1. No secrets are passed.
#>
param(
    [ValidateSet("check", "auto", "install", "rollback")]
    [string]$Mode = "check",
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [string]$NodeExe = "",
    [string]$Commit = ""
)

$runtime = Join-Path $ProjectRoot "logs\runtime"
if (-not (Test-Path $runtime)) { New-Item -ItemType Directory -Path $runtime -Force | Out-Null }
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source } else { Write-Host "node.exe not found"; exit 1 }
}
$src = Join-Path $ProjectRoot "scripts\updater\updater.mjs"
if (-not (Test-Path $src)) { Write-Host "Updater not found: $src"; exit 1 }
$copy = Join-Path $runtime "updater-run.mjs"
Copy-Item -Path $src -Destination $copy -Force

$args2 = @($copy, $Mode, "--root", $ProjectRoot)
if ($Commit) {
    if ($Commit -notmatch '^[0-9a-f]{40}$') { Write-Host "Commit must be a 40-character sha"; exit 2 }
    $args2 += @("--commit", $Commit)
}
Set-Location -Path $ProjectRoot
& $NodeExe @args2
exit $LASTEXITCODE
