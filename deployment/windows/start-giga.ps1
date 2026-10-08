<#
.SYNOPSIS
  Starts the GIGA CHEMIST server through its scheduled task (same as at boot) and waits for health.
  Use instead of "npm run dev". Run as administrator.
#>
param([string]$ProjectRoot = "C:\GIGA-CHEMIST-POS", [int]$Port = 3000)
$TaskName = "GIGA CHEMIST POS Server"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "Task '$TaskName' is not installed. Run install-giga-service.ps1 first." -ForegroundColor Red; exit 1 }
if ($task.State -eq "Disabled") { Enable-ScheduledTask -TaskName $TaskName | Out-Null; Write-Host "Task re-enabled." }
Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -ErrorAction Stop
        if ($h.system -like "GIGA CHEMIST*") { Write-Host "[ OK ] GIGA CHEMIST is up (mode $($h.app_mode), database connected $($h.database.connected))." -ForegroundColor Green; exit 0 }
    } catch {}
}
Write-Host "[WARN] Not healthy after 120 s. See $ProjectRoot\logs\giga-service.log and logs\server-err.log" -ForegroundColor Yellow
exit 1
