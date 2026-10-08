<#
.SYNOPSIS
  Removes GIGA CHEMIST auto-start (the "GIGA CHEMIST POS Server" task) and stops the server it runs.
  Data, .env, logs and the database are not touched.
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\remove-giga-service.ps1
.PARAMETER KeepFirewallRule  Leave the LAN firewall rule in place.
.PARAMETER KeepRunning       Remove auto-start but leave the current server process running.
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [int]$Port = 3000,
    [switch]$KeepFirewallRule,
    [switch]$KeepRunning
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Administrator rights are required (Run as administrator)." -ForegroundColor Red
    exit 1
}

$TaskName = "GIGA CHEMIST POS Server"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[ OK ] Removed task '$TaskName'." -ForegroundColor Green
} else {
    Write-Host "[INFO] Task '$TaskName' was not installed."
}

if (Get-ScheduledTask -TaskName "GIGA CHEMIST Watchdog" -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName "GIGA CHEMIST Watchdog" -Confirm:$false
    Write-Host "[ OK ] Removed task 'GIGA CHEMIST Watchdog'." -ForegroundColor Green
}

if (-not $KeepRunning) {
    # The supervisor (powershell running giga-service-runner.ps1) first, then its node server.
    $root = [Regex]::Escape($ProjectRoot)
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match "giga-service-runner\.ps1" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[ OK ] Stopped supervisor pid $($_.ProcessId)" -ForegroundColor Green }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match "server\.ts" -and ($_.CommandLine -match $root -or $_.ExecutablePath) } |
        Where-Object { (Get-NetTCPConnection -OwningProcess $_.ProcessId -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[ OK ] Stopped server pid $($_.ProcessId)" -ForegroundColor Green }
}

if (-not $KeepFirewallRule) {
    $rule = Get-NetFirewallRule -DisplayName "GIGA CHEMIST POS (LAN tills, TCP $Port)" -ErrorAction SilentlyContinue
    if ($rule) { $rule | Remove-NetFirewallRule; Write-Host "[ OK ] Removed LAN firewall rule." -ForegroundColor Green }
}
Write-Host "Auto-start removed. Start the POS by hand with 'npm run start' in $ProjectRoot, or reinstall with install-giga-service.ps1."
