# STEP 6 OF 8 - ONE-TIME CLOUD BASELINE (BOOTSTRAP)
# The ONLY step that runs "npm run sync:bootstrap -- --confirm": it queues the real stock baseline
# (every medicine + batch quantities) and staff profiles (no passwords / PINs) for the cloud copy.
# Runs ONCE. Local data is not changed.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 6 OF 8 - ONE-TIME CLOUD BASELINE"

Assert-Admin
Assert-Root
$marker = Join-Path $GigaRoot "logs\runtime\bootstrap-done.json"
if (Test-Path $marker) { Fail "the baseline was already sent from this PC (logs\runtime\bootstrap-done.json). Do NOT run it again." }

Info "Checking that everything is ready (real database, server, cloud)..."
Invoke-Check "bootstrap-guard"

Confirm-Text "This sends the shop's real stock baseline to the cloud. Run it ONLY ONCE." "BOOTSTRAP TARGET SHOP1"

Invoke-Npm @("run", "sync:bootstrap", "--", "--confirm") "baseline queued"
Set-Content -Path $marker -Value ("{{""at"":""{0}"",""by"":""{1}""}}" -f (Get-Date).ToString("o"), $env:USERNAME)
Pass "marker written (prevents a second bootstrap)"

Info ""
Info "Waiting for the sync worker to deliver everything to the cloud (up to 45 minutes)..."
Invoke-Check "sync-wait" @("45")

Done "Step 6 (cloud baseline delivered)" "run7.ps1"
