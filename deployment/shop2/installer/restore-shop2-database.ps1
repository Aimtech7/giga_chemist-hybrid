# =====================================================================
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

$backupFile = Join-Path $PSScriptRoot "..\database\giga_chemist_shop2_final.backup"
if (-not (Test-Path $backupFile)) {
    throw "Backup file not found at: $backupFile"
}

$env:PGPASSWORD = $PostgresPassword

# Find pg_restore and psql
$pgBin = "C:\Program Files\PostgreSQL\18\bin"
if (-not (Test-Path $pgBin)) {
    $pgBin = (Get-ChildItem "C:\Program Files\PostgreSQL" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName + "\bin"
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

Write-Host "[OK] Database $DatabaseName restored successfully from final backup." -ForegroundColor Green
