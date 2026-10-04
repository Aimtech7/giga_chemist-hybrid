@echo off
TITLE GIGA CHEMIST — Local PostgreSQL Database Restore
COLOR 0E

echo =============================================================
echo   GIGA CHEMIST — PostgreSQL Database Disaster Recovery / Restore
echo =============================================================
echo.

set /p BACKUP_FILE="Enter the full path to the .dump backup file to restore: "

if not exist "%BACKUP_FILE%" (
    COLOR 0C
    echo [ERROR] Backup file not found: %BACKUP_FILE%
    pause
    exit /b 1
)

set PG_HOST=127.0.0.1
set PG_PORT=5432
set PG_USER=postgres
set PG_DB=giga_chemist

echo.
echo WARNING: This will overwrite the existing '%PG_DB%' database tables.
set /p CONFIRM="Type 'RESTORE' to proceed: "
if not "%CONFIRM%"=="RESTORE" (
    echo Restore cancelled by user.
    pause
    exit /b 0
)

echo.
echo [1/1] Restoring database from: %BACKUP_FILE% ...
pg_restore -h %PG_HOST% -p %PG_PORT% -U %PG_USER% -d %PG_DB% --clean --if-exists -v "%BACKUP_FILE%"

if %errorlevel% equ 0 (
    COLOR 0A
    echo.
    echo =============================================================
    echo   [SUCCESS] Database restore completed successfully!
    echo =============================================================
) else (
    COLOR 0C
    echo.
    echo =============================================================
    echo   [NOTICE] Restore finished with exit code %errorlevel%.
    echo   Check logs above for details.
    echo =============================================================
)

echo.
pause
