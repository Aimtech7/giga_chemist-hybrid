@echo off
TITLE GIGA CHEMIST - Remove Windows 11 Autostart Service
COLOR 0C

:: Check for Administrative Rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ELEVATION REQUIRED] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Run the PowerShell Uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-autostart.ps1"

pause
