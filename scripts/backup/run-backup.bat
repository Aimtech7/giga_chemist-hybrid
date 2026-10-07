@echo off
REM GIGA CHEMIST - one verified PostgreSQL backup (for Windows Task Scheduler).
REM Uses DB settings, BACKUP_DIR and BACKUP_KEEP from the project .env. Never restores.
cd /d "%~dp0\..\.."
call npm run backup >> logs\backup-task.log 2>&1
exit /b %ERRORLEVEL%
