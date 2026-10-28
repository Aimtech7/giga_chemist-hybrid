<#
.SYNOPSIS
  Stops the GIGA CHEMIST server and its supervisor. Without -Disable it starts again at the next
  boot or watchdog run (within 5 minutes); with -Disable it stays stopped until start-giga.ps1.
  Run as administrator. Data is not touched.
#>
param([string]$ProjectRoot = "", [int]$Port = 3000, [switch]$Disable)

if (-not $ProjectRoot) {
    if ($PSScriptRoot) {
        $candidate = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
        if (Test-Path (Join-Path $candidate "server.ts")) { $ProjectRoot = $candidate }
    }
    if (-not $ProjectRoot) {
        if (Test-Path "C:\GIGA-CHEMIST-POS-2\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS-2" }
        elseif (Test-Path "C:\GIGA-CHEMIST-POS\server.ts") { $ProjectRoot = "C:\GIGA-CHEMIST-POS" }
        else { $ProjectRoot = (Get-Location).Path }
    }
}
$TaskName = "GIGA CHEMIST POS Server"
if ($Disable) { Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null; Write-Host "Task disabled (start-giga.ps1 re-enables it)." }
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match "giga-service-runner\.ps1" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") { Stop-Process -Id $p.Id -Force; Write-Host "Stopped server pid $($p.Id)." }
}
if (-not $Disable) { Write-Host "Note: the watchdog / next boot will start it again. Use -Disable to keep it stopped." -ForegroundColor Yellow }
