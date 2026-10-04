@echo off
TITLE GIGA CHEMIST Pharmacy POS Server (Production Mode)
COLOR 0A

echo =============================================================
echo   GIGA CHEMIST - PHARMACY POINT OF SALE AND INVENTORY SYSTEM
echo                   Production Standalone Mode
echo =============================================================

echo.

:: 1. Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    COLOR 0C
    echo [ERROR] Node.js is not found on your system PATH!
    echo Please install Node.js (v20+ recommended) to run GIGA CHEMIST.
    pause
    exit /b 1
)

:: 2. Resolve Directory
cd /d "%~dp0..\.."

:: 3. Check Environment
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Copying .env.example to .env ...
        copy .env.example .env
    )
)

:: 4. Ensure Production Frontend Bundle Exists
if not exist "dist\index.html" (
    echo [INFO] Production frontend bundle not found. Building with Vite...
    call npm run build
)

:: 5. Start Production Server
set NODE_ENV=production
set PORT=3000
set API_HOST=0.0.0.0
set APP_MODE=local

echo.
echo [INFO] Starting GIGA CHEMIST Production Server on port 3000...
echo.
echo Access URLs:
echo   - Local PC:   http://localhost:3000
echo   - LAN Access: http://0.0.0.0:3000
echo.
echo Press Ctrl+C to stop the server at any time.
echo =============================================================
echo.

node node_modules\tsx\dist\cli.mjs server.ts

pause
