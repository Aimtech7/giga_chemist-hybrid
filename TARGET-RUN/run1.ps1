# STEP 1 OF 8 - PREFLIGHT + VERIFIED BACKUP
# Checks this PC, the copied project and its configuration, then makes a VERIFIED backup of the
# real database (giga_chemist) to C:\GIGA-CHEMIST-BACKUPS\pre-install. Changes nothing else.
. (Join-Path $PSScriptRoot "lib\common.ps1")
Write-Title "STEP 1 OF 8 - PREFLIGHT + VERIFIED BACKUP"

Assert-Admin
Assert-Root

# PostgreSQL service
$pg = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pg) { Fail "No PostgreSQL Windows service found (expected e.g. postgresql-x64-18)." }
if ($pg.Status -ne "Running") {
    Info "PostgreSQL service $($pg.Name) is $($pg.Status); starting it..."
    Start-Service -Name $pg.Name
    Start-Sleep -Seconds 5
}
Pass "PostgreSQL service $($pg.Name) is running (startup type $($pg.StartType))"

# Node.js >= 20, npm, Git
$node = Get-NodeExe
$ver = (& $node --version).Trim()
if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 20) { Fail "Node.js $ver is too old (need 20 or newer)." }
Pass "Node.js $ver"
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail "npm is not available." }
Pass "npm available"
$git = Get-GitExe
Pass "Git: $git"

# Git working copy of the approved production channel
if (-not (Test-Path (Join-Path $GigaRoot ".git"))) { Fail ".git folder missing: copy the WHOLE GIGA-CHEMIST-POS folder from the flash drive (hidden files included)." }
$origin = Invoke-Git @("remote", "get-url", "origin")
if ($origin.Code -ne 0 -or $origin.Out -notmatch "Aimtech7/giga_chemist-hybrid") { Fail "git origin is not Aimtech7/giga_chemist-hybrid." }
Pass "git origin = Aimtech7/giga_chemist-hybrid"
$fetch = Invoke-Git @("fetch", "--quiet", "origin", "+refs/heads/production:refs/remotes/origin/production")
if ($fetch.Code -eq 0) { Pass "fetched the approved production branch" } else { Warn "could not fetch from GitHub now (internet?); using the copy on the flash drive" }
$head = (Invoke-Git @("rev-parse", "HEAD")).Out
$anc = Invoke-Git @("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/production")
if ($anc.Code -ne 0) { Fail "the installed code ($($head.Substring(0,12))) is not part of the approved production branch." }
Pass "installed commit $($head.Substring(0,12)) belongs to origin/production"
$dirty = (Invoke-Git @("status", "--porcelain", "--untracked-files=no")).Out
if ($dirty) { Fail "tracked files were modified after copying: $dirty" }
Pass "code is unmodified"

# Pre-installed dependencies and build
if (-not (Test-Path (Join-Path $GigaRoot "node_modules\tsx\dist\cli.mjs"))) { Fail "node_modules missing: copy the complete folder from the flash drive." }
Pass "dependencies present (node_modules)"
if (-not (Test-Path (Join-Path $GigaRoot "dist\index.html"))) { Fail "dist\index.html missing: copy the complete folder from the flash drive." }
Pass "web app build present (dist)"

# Older installation still running? (it is stopped in step 3)
if (Get-ScheduledTask -TaskName "GigaChemistPOS_Service" -ErrorAction SilentlyContinue) { Warn "old auto-start task GigaChemistPOS_Service exists (removed in step 5)" }
$old = Test-GigaHealth
if ($old) { Warn "a GIGA CHEMIST server is running now (mode $($old.app_mode)); step 3 stops it before upgrading the database" }
$free = (Get-PSDrive -Name C).Free
if ($free -lt 5GB) { Warn ("only {0:N1} GB free on C: (backups need space)" -f ($free / 1GB)) } else { Pass ("{0:N0} GB free on C:" -f ($free / 1GB)) }

# Configuration + database (no secret is printed)
Info ""
Info "Checking configuration and the giga_chemist database..."
Invoke-Check "preflight"

# Verified backup BEFORE anything changes
Info ""
Info "Creating a VERIFIED backup of giga_chemist (this can take a few minutes)..."
Invoke-Check "backup" @("C:\GIGA-CHEMIST-BACKUPS\pre-install")

Done "Step 1 (preflight + verified backup)" "run2.ps1"
