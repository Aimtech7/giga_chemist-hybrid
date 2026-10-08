<#
.SYNOPSIS
  Installs the "GIGA CHEMIST Updater" scheduled task: every 10 minutes (as SYSTEM, no logon) it
  checks the APPROVED production branch and installs an update only after an Administrator approved
  it from the phone (UPDATE_REQUIRE_APPROVAL=true, the default). Run as administrator:
    powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\updater\install-updater-task.ps1
  The repository is public, so no GitHub credential is stored. If it ever becomes private, see
  docs/GIGA_CHEMIST_REMOTE_OPERATIONS.md (read-only token in Windows Credential Manager).
#>
param(
    [string]$ProjectRoot = "C:\GIGA-CHEMIST-POS",
    [int]$IntervalMinutes = 10
)
$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host "Run as administrator." -ForegroundColor Red; exit 1 }

$TaskName = "GIGA CHEMIST Updater"
$runner = Join-Path $ProjectRoot "deployment\windows\updater\run-updater.ps1"
if (-not (Test-Path $runner)) { Write-Host "Missing $runner" -ForegroundColor Red; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "node.exe not on PATH" -ForegroundColor Red; exit 1 }
$gitOk = (Test-Path "C:\Program Files\Git\cmd\git.exe") -or (Get-Command git -ErrorAction SilentlyContinue)
if (-not $gitOk) { Write-Host "Git for Windows is required (C:\Program Files\Git)." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $ProjectRoot ".git"))) { Write-Host "$ProjectRoot is not a git working copy (clone it from GitHub to enable updates)." -ForegroundColor Red; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Mode auto -ProjectRoot `"$ProjectRoot`" -NodeExe `"$node`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArgs -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings `
    -Description "GIGA CHEMIST approved-channel updater (production branch; installs only approved versions; backup + automatic rollback)." | Out-Null
Write-Host "[ OK ] Task '$TaskName' registered (SYSTEM, every $IntervalMinutes minutes)." -ForegroundColor Green

& $runner -Mode check -ProjectRoot $ProjectRoot -NodeExe $node
Get-Content (Join-Path $ProjectRoot "logs\runtime\update-state.json") -ErrorAction SilentlyContinue
