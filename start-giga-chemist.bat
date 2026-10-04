@echo off
setlocal enabledelayedexpansion
TITLE GIGA CHEMIST Pharmacy POS Server
COLOR 0A

REM Ensure script always executes in the project root directory
cd /d "%~dp0"

echo =============================================================
echo   GIGA CHEMIST - PHARMACY POINT OF SALE AND INVENTORY SYSTEM
echo =============================================================
echo.

REM Verify Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    COLOR 0C
    echo [ERROR] Node.js is not found on your system PATH!
    echo Please install Node.js (v18 or v20 recommended) to run GIGA CHEMIST.
    echo Press any key to exit...
    pause >nul
    exit /b 1
)

echo [1/3] Checking environment configuration...
if not exist ".env" (
    if exist ".env.example" (
        echo Copying .env.example to .env ...
        copy .env.example .env
    )
)

echo [2/3] Checking database connectivity...
call npm run db:check
if %errorlevel% neq 0 (
    COLOR 0E
    echo.
    echo [NOTICE] If this is your first time running GIGA CHEMIST,
    echo run 'npm run db:migrate' to apply the database schema,
    echo followed by 'npm run create-admin' to create an admin account.
    echo.
)

echo [3/3] Starting GIGA CHEMIST Server on port 3000...
echo.
echo Open your web browser and navigate to:
echo   - Local PC:   http://localhost:3000
echo   - LAN Access: http://[SERVER_IP]:3000
echo.
echo Press Ctrl+C to stop the server at any time.
echo =============================================================
echo.

npm run start:local

pause
