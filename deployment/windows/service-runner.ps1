<#
.SYNOPSIS
  GIGA CHEMIST — Windows 11 Production Service Runner
.DESCRIPTION
  This script is executed by Windows Task Scheduler at system boot.
  It verifies PostgreSQL readiness, ensures the production build exists,
  prevents duplicate server instances, and supervises the production backend.
#>

param(
    [string]$ProjectRoot = ""
)

# 1. Resolve Project Root Directory
if (-not $ProjectRoot -or -not (Test-Path $ProjectRoot)) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ProjectRoot = (Resolve-Path "$ScriptDir\..\..").Path
}

Set-Location -Path $ProjectRoot

# 2. Ensure Logs Directory Exists
$LogDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$StartupLog = Join-Path $LogDir "startup.log"
$ServerLog = Join-Path $LogDir "server.log"

function Write-StartupLog {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Formatted = "[$Timestamp] [$Level] $Message"
    Write-Output $Formatted
    Add-Content -Path $StartupLog -Value $Formatted
}

Write-StartupLog "==================================================================" "START"
Write-StartupLog "GIGA CHEMIST Production Service Runner starting up..." "START"
Write-StartupLog "Working Directory: $ProjectRoot" "INFO"

# 3. Singleton Check: Prevent Duplicate Backend Instances
Write-StartupLog "Checking if port 3000 is already active..." "CHECK"
$PortInUse = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($PortInUse) {
    # Check if responding with GIGA CHEMIST health endpoint
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3 -ErrorAction Stop
        if ($Health -and ($Health.status -eq "ok" -or $Health.status -eq "online")) {
            Write-StartupLog "GIGA CHEMIST backend is already active and healthy on port 3000 (PID: $($PortInUse.OwningProcess)). Exiting runner gracefully." "INFO"
            exit 0
        }
    } catch {
        Write-StartupLog "Port 3000 is in use by PID $($PortInUse.OwningProcess), but healthcheck did not respond. Continuing..." "WARN"
    }
}

# 4. PostgreSQL Service & TCP Port Readiness Check
$PgPort = 5432
$PgHost = "127.0.0.1"
$MaxRetries = 30
$RetryCount = 0
$PgReady = $false

Write-StartupLog "Waiting for local PostgreSQL on $PgHost`:$PgPort..." "CHECK"

# First, attempt to start Windows PostgreSQL service if stopped
$PgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PgService -and $PgService.Status -ne 'Running') {
    Write-StartupLog "PostgreSQL service '$($PgService.Name)' is $($PgService.Status). Attempting to start service..." "INFO"
    try {
        Start-Service -Name $PgService.Name -ErrorAction Stop
        Write-StartupLog "PostgreSQL service start command issued." "INFO"
    } catch {
        Write-StartupLog "Could not directly start service via script (may already be starting by Windows): $_" "WARN"
    }
}

while (-not $PgReady -and $RetryCount -lt $MaxRetries) {
    try {
        $TcpClient = New-Object System.Net.Sockets.TcpClient
        $Connect = $TcpClient.BeginConnect($PgHost, $PgPort, $null, $null)
        $Success = $Connect.AsyncWaitHandle.WaitOne(1500, $false)
        if ($Success -and $TcpClient.Connected) {
            $TcpClient.EndConnect($Connect)
            $TcpClient.Close()
            $PgReady = $true
            break
        }
        $TcpClient.Close()
    } catch {}

    $RetryCount++
    Write-StartupLog "PostgreSQL not yet responding (Attempt $RetryCount/$MaxRetries). Waiting 2 seconds..." "WAIT"
    Start-Sleep -Seconds 2
}

if (-not $PgReady) {
    Write-StartupLog "[FATAL] PostgreSQL on $PgHost`:$PgPort failed to respond after $($MaxRetries * 2) seconds! Backend startup aborted." "ERROR"
    exit 1
}

Write-StartupLog "PostgreSQL is confirmed ONLINE and accepting connections on port $PgPort." "SUCCESS"

# 5. Environment & Production Assets Verification
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Write-StartupLog "'.env' missing! Copying '.env.example' template to '.env'..." "WARN"
        Copy-Item ".env.example" ".env"
    } else {
        Write-StartupLog "[FATAL] Neither '.env' nor '.env.example' found in $ProjectRoot!" "ERROR"
        exit 1
    }
}

$DistIndex = Join-Path $ProjectRoot "dist\index.html"
if (-not (Test-Path $DistIndex)) {
    Write-StartupLog "Production bundle 'dist/index.html' not found. Executing 'npm run build'..." "INFO"
    try {
        & node node_modules/vite/bin/vite.js build 2>&1 | Add-Content -Path $ServerLog
        if (Test-Path $DistIndex) {
            Write-StartupLog "Production build successfully generated." "SUCCESS"
        } else {
            Write-StartupLog "[FATAL] Build failed to generate dist/index.html!" "ERROR"
            exit 1
        }
    } catch {
        Write-StartupLog "[FATAL] Build command encountered an exception: $_" "ERROR"
        exit 1
    }
}

# 6. Set Production Environment Variables
$env:NODE_ENV = "production"
$env:PORT = "3000"
$env:API_HOST = "0.0.0.0"
# APP_MODE is NOT set here: it comes from .env (dotenv never overrides an existing variable, so forcing it would switch hybrid sync off). Superseded by install-giga-service.ps1.

Write-StartupLog "Launching GIGA CHEMIST Production Server on http://0.0.0.0:3000..." "START"

# 7. Start Backend Process and Monitor Output
try {
    # Resolve Node.js binary
    $NodeExe = (Get-Command node -ErrorAction Stop).Source
    $CliScript = Join-Path $ProjectRoot "node_modules\tsx\dist\cli.mjs"
    $ServerScript = Join-Path $ProjectRoot "server.ts"

    if (-not (Test-Path $CliScript)) {
        Write-StartupLog "[FATAL] Cannot find tsx runtime at '$CliScript'!" "ERROR"
        exit 1
    }

    Write-StartupLog "Executing: node `"$CliScript`" server.ts" "INFO"
    
    # Run the server and stream stdout/stderr directly into server.log
    & $NodeExe $CliScript $ServerScript 2>&1 | Tee-Object -FilePath $ServerLog -Append
} catch {
    Write-StartupLog "[FATAL] Server process crashed or terminated with error: $_" "ERROR"
    exit 1
}

Write-StartupLog "GIGA CHEMIST Server process stopped." "INFO"
