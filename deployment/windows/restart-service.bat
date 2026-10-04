@echo off
TITLE GIGA CHEMIST - Restart Service
COLOR 0E

:: Check for Administrative Rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ELEVATION REQUIRED] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Run the PowerShell Restarter
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-service.ps1"

pause
