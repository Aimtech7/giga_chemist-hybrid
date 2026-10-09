# STEP 7 OF 8 - FINAL REMOTE HEALTH CHECK
# Local API, PostgreSQL, sync worker, heartbeat reaching the cloud, outbox, backups, updater channel,
# Vercel, cloud medicine count.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 7 OF 8 - FINAL REMOTE HEALTH CHECK"

Assert-Admin
Assert-Root
Info "Waiting 90 seconds so at least one heartbeat reaches the cloud..."
Start-Sleep -Seconds 90
Invoke-Check "final"

Write-Host ""
Write-Host "  SUMMARY: the pharmacy PC is serving the POS, syncing, sending heartbeats," -ForegroundColor Green
Write-Host "  backing up nightly and watching the approved update channel." -ForegroundColor Green
Done "Step 7 (final health)" "run8.ps1"
