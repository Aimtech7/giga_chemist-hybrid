# Shared helpers for TARGET-RUN\run*.ps1 (dot-sourced). Windows PowerShell 5.1, ASCII only.
# Never prints secret values: .env is read into memory and only compared / length-checked.

$ErrorActionPreference = "Stop"
$Global:GigaRoot = "C:\GIGA-CHEMIST-POS"
$Global:ProductionShopId = "c2a176c8-a50f-456f-a370-225c11d2e32f"
$Global:StepLog = Join-Path $GigaRoot "logs\target-install.log"

function Write-Title([string]$Title) {
    Write-Host ""
    Write-Host "=====================================================================" -ForegroundColor Cyan
    Write-Host "  GIGA CHEMIST - $Title" -ForegroundColor Cyan
    Write-Host "=====================================================================" -ForegroundColor Cyan
    Add-Log "START $Title"
}
function Add-Log([string]$m) {
    try {
        $d = Split-Path $StepLog
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        Add-Content -Path $StepLog -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m)
    } catch {}
}
function Pass([string]$m) { Write-Host "  PASS  $m" -ForegroundColor Green; Add-Log "PASS $m" }
function Info([string]$m) { Write-Host "        $m" }
function Warn([string]$m) { Write-Host "  WARN  $m" -ForegroundColor Yellow; Add-Log "WARN $m" }
function Fail([string]$m) {
    Write-Host "  FAIL  $m" -ForegroundColor Red
    Add-Log "FAIL $m"
    Write-Host ""
    Write-Host "  RESULT: FAILED - do NOT continue to the next step. Send logs\target-install.log to the developer." -ForegroundColor Red
    exit 1
}
function Done([string]$step, [string]$next) {
    Add-Log "PASS $step"
    Write-Host ""
    Write-Host "  RESULT: PASS - $step completed." -ForegroundColor Green
    if ($next) { Write-Host "  Next: .\$next" -ForegroundColor Green }
    exit 0
}

function Assert-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail "Open PowerShell with 'Run as administrator' and run this script again." }
    Pass "running as Administrator"
}
function Assert-Root {
    if (-not (Test-Path (Join-Path $GigaRoot "server.ts"))) { Fail "The project must be at $GigaRoot (server.ts not found)." }
    Set-Location $GigaRoot
    Pass "project folder $GigaRoot"
}

# .env as a hashtable (values stay in memory, never printed)
function Get-EnvMap([string]$File = ".env") {
    $map = @{}
    $p = Join-Path $GigaRoot $File
    if (-not (Test-Path $p)) { return $map }
    foreach ($l in Get-Content $p) {
        if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $map[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
    }
    return $map
}

function Get-NodeExe {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if (-not $n) { Fail "Node.js is not installed (node.exe not on PATH). Install Node.js 20 LTS or newer for all users." }
    return $n.Source
}
function Get-GitExe {
    foreach ($p in @("C:\Program Files\Git\cmd\git.exe", "C:\Program Files (x86)\Git\cmd\git.exe")) { if (Test-Path $p) { return $p } }
    $g = Get-Command git -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }
    Fail "Git for Windows is not installed (needed for safe updates). Install it from https://git-scm.com/download/win"
}
function Invoke-Git([string[]]$GitArgs) {
    $git = Get-GitExe
    # PS 5.1 turns redirected native stderr into errors; keep them as text here.
    $ErrorActionPreference = "Continue"
    $out = & $git -c "safe.directory=C:/GIGA-CHEMIST-POS" -C $GigaRoot @GitArgs 2>&1
    return @{ Code = $LASTEXITCODE; Out = ($out | Out-String).Trim() }
}

# Runs scripts/target/target-check.ts <mode>; fails the step unless it reports PASS.
function Invoke-Check([string]$Mode, [string[]]$Extra = @()) {
    $node = Get-NodeExe
    & $node --import tsx scripts/target/target-check.ts $Mode @Extra
    if ($LASTEXITCODE -ne 0) { Fail "check '$Mode' did not pass (see the FAIL lines above)" }
}

# Runs an npm script; fails the step on a non-zero exit code.
function Invoke-Npm([string[]]$NpmArgs, [string]$What) {
    Info "npm $($NpmArgs -join ' ')"
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (npm exit $LASTEXITCODE)" }
    Pass $What
}

function Test-GigaHealth([int]$Port = 3000) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -ErrorAction Stop
        if ($h.system -like "GIGA CHEMIST*") { return $h }
    } catch {}
    return $null
}

function Confirm-Text([string]$Prompt, [string]$Expected) {
    Write-Host ""
    Write-Host "  $Prompt" -ForegroundColor Yellow
    $answer = Read-Host "  Type exactly: $Expected"
    if ($answer -cne $Expected) { Fail "Confirmation text did not match. Nothing was done." }
    Pass "operator confirmed"
}
