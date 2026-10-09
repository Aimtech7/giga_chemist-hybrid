# STEP 4 OF 8 - CLOUD AND SHOP IDENTITY
# Proves this PC can reach the cloud, that the shop token authenticates for the production shop,
# and that the local shop identity is consistent. Sends no business data.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 4 OF 8 - CLOUD CONNECTION AND SHOP IDENTITY"

Assert-Admin
Assert-Root
try {
    $r = Invoke-WebRequest -Uri "https://gigachem.vercel.app/api/health" -UseBasicParsing -TimeoutSec 20
    Pass "internet OK (gigachem.vercel.app answers HTTP $($r.StatusCode))"
} catch { Fail "no internet connection to gigachem.vercel.app - connect the PC to the internet and rerun." }

Invoke-Check "cloud"

Done "Step 4 (cloud + shop identity)" "run5.ps1"
