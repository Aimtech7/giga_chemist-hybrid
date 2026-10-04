@echo off
TITLE GIGA CHEMIST - Install Cashier Screen Auto-Launch on Login
COLOR 0A

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%STARTUP_FOLDER%\GigaChemistPOS_Client.bat"

echo ======================================================================
echo   GIGA CHEMIST — CASHIER WINDOW AUTO-LAUNCH INSTALLER
echo ======================================================================
echo.
echo Installing startup shortcut to:
echo %TARGET_BAT%
echo.

(
    echo @echo off
    echo call "%~dp0launch-pwa.bat"
) > "%TARGET_BAT%"

if exist "%TARGET_BAT%" (
    echo [SUCCESS] Cashier screen auto-launch installed!
    echo When any user logs in to Windows, the GIGA CHEMIST POS window will open automatically.
) else (
    echo [ERROR] Failed to write to Startup folder.
)

echo.
pause
