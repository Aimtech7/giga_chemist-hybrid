@echo off
TITLE GIGA CHEMIST — Local PostgreSQL Database Backup
COLOR 0B

echo =============================================================
echo   GIGA CHEMIST — Automated Local PostgreSQL Backup
echo =============================================================
echo.

REM Create backups directory if missing
if not exist "data\backups" (
    mkdir "data\backups"
)

REM Set timestamp for backup filename
for /f "tokens=2-4 delims=/ " %%a in ('date /t') do (set mydate=%%c%%a%%b)
for /f "tokens=1-2 delims=/:" %%a in ("%TIME%") do (set mytime=%%a%%b)
set mytime=%mytime: =0%
set BACKUP_FILE=data\backups\giga_chemist_%mydate%_%mytime%.dump

echo [1/2] Backing up PostgreSQL database 'giga_chemist' to:
echo       %BACKUP_FILE%
echo.

REM Read connection string from .env if present or use default local postgres
set PG_HOST=127.0.0.1
set PG_PORT=5432
set PG_USER=postgres
set PG_DB=giga_chemist

REM Run pg_dump
pg_dump -h %PG_HOST% -p %PG_PORT% -U %PG_USER% -F c -b -v -f "%BACKUP_FILE%" %PG_DB%

if %errorlevel% equ 0 (
    COLOR 0A
    echo.
    echo =============================================================
    echo   [SUCCESS] Backup created successfully:
    echo   %BACKUP_FILE%
    echo =============================================================
) else (
    COLOR 0C
    echo.
    echo =============================================================
    echo   [ERROR] Backup failed. Ensure PostgreSQL service is running.
    echo =============================================================
)

echo.
pause
