# =====================================================================
# GIGA CHEMIST SHOP 2 - LOCAL DATABASE INTEGRITY VERIFICATION
# =====================================================================
param(
    [string]$PostgresPassword = "",
    [string]$DatabaseName = "giga_chemist_shop2"
)

$ErrorActionPreference = "Stop"
Write-Host "--- Verifying Shop 2 Database Integrity ---" -ForegroundColor Cyan

# Load .env if present
$envFile = Join-Path $PSScriptRoot "..\..\..\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*DATABASE_URL\s*=\s*(.*)$") {
            $dbUrl = $Matches[1].Trim('"').Trim("'")
            if ($dbUrl -match "://[^:]+:([^@]+)@") {
                if (-not $PostgresPassword) {
                    $PostgresPassword = $Matches[1]
                }
            }
        }
    }
}

if (-not $PostgresPassword) {
    $PostgresPassword = $env:DB_PASSWORD
}

$env:PGPASSWORD = $PostgresPassword
$pgBin = "C:\Program Files\PostgreSQL\18\bin"
if (-not (Test-Path $pgBin)) {
    $pgBin = (Get-ChildItem "C:\Program Files\PostgreSQL" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName + "\bin"
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

Write-Host "[PASS] Shop 2 Local Database Verification: PASS" -ForegroundColor Green
