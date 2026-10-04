@echo off
TITLE GIGA CHEMIST - Install Windows 11 Autostart Service
COLOR 0A

:: Check for Administrative Rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ELEVATION REQUIRED] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Run the PowerShell Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"

pause
