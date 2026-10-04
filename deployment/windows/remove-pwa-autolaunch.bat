@echo off
TITLE GIGA CHEMIST - Remove Cashier Screen Auto-Launch
COLOR 0C

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%STARTUP_FOLDER%\GigaChemistPOS_Client.bat"

echo ======================================================================
echo   GIGA CHEMIST — REMOVE CASHIER WINDOW AUTO-LAUNCH
echo ======================================================================
echo.

if exist "%TARGET_BAT%" (
    del /f /q "%TARGET_BAT%"
    echo [SUCCESS] Cashier screen auto-launch removed.
) else (
    echo [INFO] Auto-launch was not installed in Startup folder.
)

echo.
pause
