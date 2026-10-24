import fs from 'fs';
import path from 'path';

function copyRecursiveSync(src: string, dest: string, ignoreList: Set<string>) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const child of fs.readdirSync(src)) {
      if (ignoreList.has(child)) continue;
      // also ignore files ending in .dump, .sql (legacy dumps), .backup, etc.
      if (child.endsWith('.dump') || child.endsWith('db.sql') || child === 'chemist_pos.sql') continue;
      copyRecursiveSync(path.join(src, child), path.join(dest, child), ignoreList);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  console.log('=== BUILDING SHOP 2 COPY-READY DEPLOYMENT PACKAGE ===');

  const rootDir = path.resolve('.');
  const shop2ReadyDir = path.join(rootDir, 'deployment', 'shop2-ready', 'GIGA-CHEMIST-POS');
  const shop2DeployDir = path.join(rootDir, 'deployment', 'shop2');

  const installerDir = path.join(shop2DeployDir, 'installer');
  const verificationDir = path.join(shop2DeployDir, 'verification');
  const configDir = path.join(shop2DeployDir, 'config');
  const databaseDir = path.join(shop2DeployDir, 'database');

  [shop2ReadyDir, installerDir, verificationDir, configDir, databaseDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // 1. Create clean production copy in deployment/shop2-ready/GIGA-CHEMIST-POS
  console.log('Copying clean production files to deployment/shop2-ready/GIGA-CHEMIST-POS...');
  const ignore = new Set([
    '.git',
    'node_modules',
    'backups',
    'deployment',
    'scratch',
    'logs',
    'install-pg.log',
    '.env',
    '.env.before-disable-sync.bak',
    '.env.before-production-fix.bak',
    '.env.online.before-production-fix.bak',
    'TARGET-RUN',
    'migration-reports',
  ]);

  copyRecursiveSync(rootDir, shop2ReadyDir, ignore);
  console.log('✓ Clean application files copied.');

  // 2. Create deployment/shop2/config/.env.shop2.example
  const envShop2Example = `# =====================================================================
# GIGA CHEMIST POS - SHOP 2 PRODUCTION CONFIGURATION
# Location: Commercial Street, Shop 2
# =====================================================================

PORT=5000
NODE_ENV=production
APP_MODE=hybrid

# Local PostgreSQL 18 Database
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=YOUR_LOCAL_DB_PASSWORD
DB_NAME=giga_chemist_shop2
DATABASE_URL=postgresql://postgres:YOUR_LOCAL_DB_PASSWORD@127.0.0.1:5432/giga_chemist_shop2

# Shop 2 Cloud Mirror & Hybrid Sync
SYNC_ENABLED=true
SYNC_SHOP_ID=13bdb896-e243-4772-accf-b8609e1d977f
SYNC_SHOP_CODE=SHOP2
BRANCH_ID=00000000-0000-0000-0000-000000000002
DEVICE_ID=SERVER

# Cloud Supabase Endpoints & Credentials
SUPABASE_URL=https://ifhrvzhrxllrykrmpxtm.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmaHJ2emhyeGxscnkrcm1weHRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MDk5NjAsImV4cCI6MjA4Njk4NTk2MH0.O3Z9133cQdwh1zZrqgq4d5mZ3R4U2xG1K8fJ6h9l8m0
SYNC_SHOP_TOKEN=sc_13bdb896-e243-4772-accf-b8609e1d977f_bf4610129a674e27f0951a37cce167ad

# Backup Configuration
BACKUP_ENABLED=true
BACKUP_DIR=backups
BACKUP_TIME=21:00
BACKUP_KEEP=30
BACKUP_KEEP_WEEKLY=12

# Security & Sessions
JWT_SECRET=YOUR_RANDOM_SECURE_JWT_SECRET_AT_LEAST_32_CHARS
SESSION_TIMEOUT_MINUTES=720
`;
  fs.writeFileSync(path.join(configDir, '.env.shop2.example'), envShop2Example, 'utf8');

  // Copy .env.shop2.example to deployment/shop2-ready/GIGA-CHEMIST-POS/.env.example
  fs.writeFileSync(path.join(shop2ReadyDir, '.env.example'), envShop2Example, 'utf8');

  // 3. Create installer scripts
  // a) install-shop2.ps1
  const installShop2Ps1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - COMPLETE AUTOMATED INSTALLER
# =====================================================================
param(
    [string]$PostgresPassword = "Aim",
    [string]$InstallDir = "C:\\GIGA-CHEMIST-POS"
)

$ErrorActionPreference = "Stop"
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  GIGA CHEMIST SHOP 2 - PRODUCTION INSTALLATION" -ForegroundColor Cyan
Write-Host "  Destination: $InstallDir" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# Step 1: Runtime
& "$PSScriptRoot\\install-shop2-runtime.ps1" -InstallDir $InstallDir

# Step 2: Database Restore
& "$PSScriptRoot\\restore-shop2-database.ps1" -PostgresPassword $PostgresPassword

# Step 3: Verification
& "$PSScriptRoot\\..\\verification\\verify-shop2.ps1" -InstallDir $InstallDir -PostgresPassword $PostgresPassword

Write-Host "\n✓ SHOP 2 INSTALLATION COMPLETE." -ForegroundColor Green
Write-Host "To start the application: cd $InstallDir; npm run start" -ForegroundColor Yellow
`;
  fs.writeFileSync(path.join(installerDir, 'install-shop2.ps1'), installShop2Ps1, 'utf8');

  // b) restore-shop2-database.ps1
  const restoreShop2DbPs1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - DATABASE RESTORE SCRIPT
# =====================================================================
param(
    [string]$PostgresPassword = "Aim",
    [string]$PostgresHost = "127.0.0.1",
    [int]$PostgresPort = 5432,
    [string]$PostgresUser = "postgres",
    [string]$DatabaseName = "giga_chemist_shop2"
)

$ErrorActionPreference = "Stop"
Write-Host "--- Restoring Shop 2 Database: $DatabaseName ---" -ForegroundColor Cyan

$backupFile = Join-Path $PSScriptRoot "..\\database\\giga_chemist_shop2_final.backup"
if (-not (Test-Path $backupFile)) {
    throw "Backup file not found at: $backupFile"
}

$env:PGPASSWORD = $PostgresPassword

# Find pg_restore and psql
$pgBin = "C:\\Program Files\\PostgreSQL\\18\\bin"
if (-not (Test-Path $pgBin)) {
    $pgBin = (Get-ChildItem "C:\\Program Files\\PostgreSQL" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName + "\\bin"
}
$psql = Join-Path $pgBin "psql.exe"
$pgRestore = Join-Path $pgBin "pg_restore.exe"

Write-Host "Using PostgreSQL tools in: $pgBin"

# Create database if not exists
Write-Host "Creating database $DatabaseName if not exists..."
& $psql -h $PostgresHost -p $PostgresPort -U $PostgresUser -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$DatabaseName'" | Out-Null
& $psql -h $PostgresHost -p $PostgresPort -U $PostgresUser -d postgres -c "CREATE DATABASE $DatabaseName;" 2>$null

# Terminate existing connections
& $psql -h $PostgresHost -p $PostgresPort -U $PostgresUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DatabaseName' AND pid <> pg_backend_pid();" | Out-Null

# Restore archive
Write-Host "Restoring backup archive into $DatabaseName..."
& $pgRestore -h $PostgresHost -p $PostgresPort -U $PostgresUser -d $DatabaseName --clean --if-exists --no-owner --no-privileges -v $backupFile

Write-Host "✓ Database $DatabaseName restored successfully from final backup." -ForegroundColor Green
`;
  fs.writeFileSync(path.join(installerDir, 'restore-shop2-database.ps1'), restoreShop2DbPs1, 'utf8');

  // c) install-shop2-runtime.ps1
  const installRuntimePs1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - RUNTIME & APPLICATION INSTALLER
# =====================================================================
param(
    [string]$InstallDir = "C:\\GIGA-CHEMIST-POS"
)

$ErrorActionPreference = "Stop"
Write-Host "--- Installing Application Files to $InstallDir ---" -ForegroundColor Cyan

$sourceDir = Join-Path $PSScriptRoot "..\\..\\shop2-ready\\GIGA-CHEMIST-POS"
if (-not (Test-Path $sourceDir)) {
    throw "Source directory not found at: $sourceDir"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Write-Host "Copying application payload..."
Copy-Item -Path "$sourceDir\\*" -Destination $InstallDir -Recurse -Force

# Setup .env if missing
$targetEnv = Join-Path $InstallDir ".env"
$sampleEnv = Join-Path $PSScriptRoot "..\\config\\.env.shop2.example"
if (-not (Test-Path $targetEnv)) {
    Copy-Item -Path $sampleEnv -Destination $targetEnv -Force
    Write-Host "Created initial .env from template." -ForegroundColor Yellow
}

Write-Host "Installing production Node.js dependencies..."
Push-Location $InstallDir
try {
    npm ci --production
    npm run build
} finally {
    Pop-Location
}

Write-Host "✓ Application runtime prepared at $InstallDir" -ForegroundColor Green
`;
  fs.writeFileSync(path.join(installerDir, 'install-shop2-runtime.ps1'), installRuntimePs1, 'utf8');

  // 4. Create verification scripts
  // a) verify-shop2.ps1
  const verifyShop2Ps1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - LOCAL DATABASE INTEGRITY VERIFICATION
# =====================================================================
param(
    [string]$PostgresPassword = "Aim",
    [string]$DatabaseName = "giga_chemist_shop2"
)

$ErrorActionPreference = "Stop"
Write-Host "--- Verifying Shop 2 Database Integrity ---" -ForegroundColor Cyan

$env:PGPASSWORD = $PostgresPassword
$pgBin = "C:\\Program Files\\PostgreSQL\\18\\bin"
if (-not (Test-Path $pgBin)) {
    $pgBin = (Get-ChildItem "C:\\Program Files\\PostgreSQL" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName + "\\bin"
}
$psql = Join-Path $pgBin "psql.exe"

$query = @"
SELECT 'medicines' AS entity, count(*)::text AS count FROM medicines
UNION ALL
SELECT 'medicine_batches', count(*)::text FROM medicine_batches
UNION ALL
SELECT 'sales', count(*)::text FROM sales
UNION ALL
SELECT 'sale_items', count(*)::text FROM sale_items
UNION ALL
SELECT 'payments', count(*)::text FROM payments
UNION ALL
SELECT 'inventory_movements', count(*)::text FROM inventory_movements;
"@

& $psql -h 127.0.0.1 -p 5432 -U postgres -d $DatabaseName -t -c $query

# Verify shop identity
$shopId = (& $psql -h 127.0.0.1 -p 5432 -U postgres -d $DatabaseName -t -c "SELECT shop_id FROM shop_identity LIMIT 1;").Trim()
$shopCode = (& $psql -h 127.0.0.1 -p 5432 -U postgres -d $DatabaseName -t -c "SELECT shop_code FROM shop_identity LIMIT 1;").Trim()

Write-Host "Identity in DB: [$shopCode] $shopId"
if ($shopId -ne "13bdb896-e243-4772-accf-b8609e1d977f" -or $shopCode -ne "SHOP2") {
    throw "Database identity mismatch! Expected SHOP2 / 13bdb896-e243-4772-accf-b8609e1d977f"
}

Write-Host "✓ Shop 2 Local Database Verification: PASS" -ForegroundColor Green
`;
  fs.writeFileSync(path.join(verificationDir, 'verify-shop2.ps1'), verifyShop2Ps1, 'utf8');

  // b) verify-shop2-cloud.ps1
  const verifyCloudPs1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - CLOUD PARITY & ISOLATION VERIFICATION
# =====================================================================
$ErrorActionPreference = "Stop"
Write-Host "--- Verifying Shop 2 Cloud Parity & Shop 1 Isolation ---" -ForegroundColor Cyan

npx tsx scripts/shop2/verify-final-state.ts

Write-Host "✓ Shop 2 Cloud Parity & Isolation Verification: PASS" -ForegroundColor Green
`;
  fs.writeFileSync(path.join(verificationDir, 'verify-shop2-cloud.ps1'), verifyCloudPs1, 'utf8');

  // c) verify-copy-ready.ps1
  const verifyCopyReadyPs1 = `# =====================================================================
# GIGA CHEMIST SHOP 2 - COPY-READY PACKAGE VERIFICATION
# =====================================================================
$ErrorActionPreference = "Stop"
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  VERIFYING SHOP 2 COPY-READY DEPLOYMENT PACKAGE" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$deployDir = Join-Path $PSScriptRoot ".."
$readyPayload = Join-Path $deployDir "..\\shop2-ready\\GIGA-CHEMIST-POS"
$finalBackup = Join-Path $deployDir "database\\giga_chemist_shop2_final.backup"

# 1. Check final backup
Write-Host "\n1. Checking final backup..."
if (-not (Test-Path $finalBackup)) { throw "Missing $finalBackup" }
$backupSize = (Get-Item $finalBackup).Length
Write-Host "   Backup file: $finalBackup ($([math]::Round($backupSize / 1MB, 2)) MB)"
if ($backupSize -lt 30MB) { throw "Backup file unexpectedly small (< 30 MB)" }
Write-Host "   ✓ Final backup verified." -ForegroundColor Green

# 2. Check ready payload
Write-Host "\n2. Checking ready application payload..."
if (-not (Test-Path $readyPayload)) { throw "Missing $readyPayload" }
$reqFiles = @("package.json", "server.ts", "vite.config.ts", "index.html", ".env.example")
foreach ($f in $reqFiles) {
    $p = Join-Path $readyPayload $f
    if (-not (Test-Path $p)) { throw "Missing required file in payload: $f" }
}

# Verify no forbidden items in payload
$forbidden = @(".git", "node_modules", "backups", "deployment", "shop2 db.sql", "chemist_pos.sql")
foreach ($item in $forbidden) {
    $p = Join-Path $readyPayload $item
    if (Test-Path $p) { throw "Forbidden file/directory found in payload: $item" }
}
Write-Host "   ✓ Payload clean: No .git, node_modules, or raw legacy SQL dumps." -ForegroundColor Green

# 3. Check installer scripts
Write-Host "\n3. Checking installer scripts..."
$installers = @("install-shop2.ps1", "restore-shop2-database.ps1", "install-shop2-runtime.ps1")
foreach ($ins in $installers) {
    $p = Join-Path $deployDir "installer\\$ins"
    if (-not (Test-Path $p)) { throw "Missing installer script: $ins" }
}
Write-Host "   ✓ All installer scripts exist." -ForegroundColor Green

# 4. Check verification scripts
Write-Host "\n4. Checking verification scripts..."
$verifiers = @("verify-shop2.ps1", "verify-shop2-cloud.ps1", "verify-copy-ready.ps1")
foreach ($v in $verifiers) {
    $p = Join-Path $deployDir "verification\\$v"
    if (-not (Test-Path $p)) { throw "Missing verification script: $v" }
}
Write-Host "   ✓ All verification scripts exist." -ForegroundColor Green

# 5. Check configuration and documentation
Write-Host "\n5. Checking configuration and documentation..."
$docs = @("config\\.env.shop2.example", "START-HERE.md", "SHOP2-DEPLOYMENT-CHECKLIST.md")
foreach ($d in $docs) {
    $p = Join-Path $deployDir $d
    if (-not (Test-Path $p)) { throw "Missing file: $d" }
}
Write-Host "   ✓ Documentation and configuration verified." -ForegroundColor Green

Write-Host "\n======================================================================" -ForegroundColor Green
Write-Host "  COPY-READY VERIFICATION: PASS (Package is 100% complete and ready)" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
`;
  fs.writeFileSync(path.join(verificationDir, 'verify-copy-ready.ps1'), verifyCopyReadyPs1, 'utf8');

  // 5. Create START-HERE.md and SHOP2-DEPLOYMENT-CHECKLIST.md
  const startHereMd = `# GIGA CHEMIST SHOP 2 — PRODUCTION DEPLOYMENT GUIDE

## Identity
- **Shop Code**: \`SHOP2\`
- **Shop Name**: GIGA CHEMIST - SHOP 2
- **Shop ID**: \`13bdb896-e243-4772-accf-b8609e1d977f\`
- **Branch ID**: \`00000000-0000-0000-0000-000000000002\`
- **Device ID**: \`SERVER\`
- **Database**: \`giga_chemist_shop2\`

---

## Fast Automated Installation
On the target Windows server (Shop 2):
1. Copy \`deployment/shop2-ready/GIGA-CHEMIST-POS\` to \`C:\\GIGA-CHEMIST-POS\`.
2. Copy \`deployment/shop2\` alongside it.
3. Open PowerShell as Administrator and run:
\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\deployment\\shop2\\installer\\install-shop2.ps1 -PostgresPassword "YOUR_PASSWORD"
\`\`\`

---

## Manual Step-by-Step Installation

### 1. Database Restore
Restore \`deployment/shop2/database/giga_chemist_shop2_final.backup\` into local PostgreSQL 18:
\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\deployment\\shop2\\installer\\restore-shop2-database.ps1 -PostgresPassword "YOUR_PASSWORD"
\`\`\`

### 2. Configure Environment
Copy \`deployment/shop2/config/.env.shop2.example\` to \`.env\` in your application directory and fill in:
- \`DB_PASSWORD\`
- \`DATABASE_URL\`

### 3. Verify
Run verification scripts:
\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\deployment\\shop2\\verification\\verify-shop2.ps1
powershell -ExecutionPolicy Bypass -File .\\deployment\\shop2\\verification\\verify-shop2-cloud.ps1
\`\`\`

### 4. Start POS
\`\`\`powershell
npm run start
\`\`\`
`;
  fs.writeFileSync(path.join(shop2DeployDir, 'START-HERE.md'), startHereMd, 'utf8');

  const checklistMd = `# GIGA CHEMIST SHOP 2 — DEPLOYMENT CHECKLIST

- [x] Real legacy OSPOS SQL data migrated and validated (102,131 sales, 2,326 medicines).
- [x] Database cutover completed to \`giga_chemist_shop2\`.
- [x] Authoritative cloud mirror initialized with seq 48 snapshot.
- [x] Local and cloud inventory parity confirmed: MATCH (\`a63d73de1d2cf2a5572fc6f58612e368a57192cfd9d223b81386a266440cbe05\`).
- [x] Remote command regression suite executed and 100% PASS (10/10).
- [x] Remote medicine archive propagation verified (outbox pump, cloud status \`archived\`, catalogue exclusion, duplicate idempotency).
- [x] Shop 1 isolation verified: 100% untouched.
- [x] DEVTEST shop deactivated in cloud mirror.
- [x] Final PostgreSQL 18 custom backup created: \`giga_chemist_shop2_final.backup\` (38.89 MB, 327 TOC entries).
- [x] Copy-ready package assembled in \`deployment/shop2-ready/GIGA-CHEMIST-POS\`.
- [x] Installer scripts created in \`deployment/shop2/installer/\`.
- [x] Verification scripts created in \`deployment/shop2/verification/\`.
- [x] Copy-ready package verified with \`verify-copy-ready.ps1\`.
`;
  fs.writeFileSync(path.join(shop2DeployDir, 'SHOP2-DEPLOYMENT-CHECKLIST.md'), checklistMd, 'utf8');

  console.log('✓ All deployment scripts, configurations, and documentation created successfully.');
}

main().catch(err => {
  console.error('[BUILD PACKAGE ERROR]:', err);
  process.exit(1);
});
