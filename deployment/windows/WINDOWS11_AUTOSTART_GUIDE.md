# GIGA CHEMIST — Windows 11 Production Autostart & Service Guide

This guide describes how to configure, supervise, and troubleshoot the **GIGA CHEMIST Pharmacy POS & Inventory System** to run automatically at system boot on Windows 11 without requiring manual command prompt launches.

---

## 1. Architecture Overview

```
                          [ Windows 11 Boot ]
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  Windows Service Startup  │
                    │  - postgresql-x64-16      │ (Binds strictly to 127.0.0.1:5432)
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │ Windows Task Scheduler    │
                    │ Task: GigaChemistPOS_     │
                    │       Service (AtStartup) │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │ service-runner.ps1        │
                    │ 1. Port 3000 singleton chk│
                    │ 2. PostgreSQL healthcheck │ (Waits up to 60s for DB readiness)
                    │ 3. Production asset check │ (Ensures dist/index.html exists)
                    │ 4. Starts Node Production │
                    └─────────────┬─────────────┘
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        ▼                                                   ▼
┌───────────────────────────────┐           ┌───────────────────────────────┐
│ Local Cashier Terminal        │           │ LAN Counter Terminals         │
│ http://localhost:3000         │           │ http://[SERVER_IP]:3000       │
│ (Optional PWA Auto-Launch)    │           │ (Allowed via Port 3000 Rule)  │
└───────────────────────────────┘           └───────────────────────────────┘
```

### Key Safety & Reliability Features
1. **Zero Manual Daily Operations:** Starts automatically before any user logs in.
2. **PostgreSQL Dependency Guard:** Verifies local PostgreSQL on `127.0.0.1:5432` is accepting connections before launching the backend (with automated retries up to 60 seconds).
3. **Singleton Enforcement:** Detects if a backend process is already running on port 3000 to prevent duplicate processes or port collisions.
4. **Crash Recovery & Auto-Restart:** Task Scheduler is configured with `RestartCount = 3` and `RestartInterval = 1 minute`.
5. **Network Security:** Local PostgreSQL is isolated to `127.0.0.1` (never exposed directly to LAN). Only the Express backend port 3000 is open to local network counter terminals.
6. **Detailed Logging:** All stdout/stderr and lifecycle events are streamed to `logs/startup.log` and `logs/server.log`.

---

## 2. Directory Structure

```
GIGA-CHEMIST-POS/
├── deployment/
│   ├── postgresql/
│   │   ├── giga_chemist_full.sql      <- Full 242 MB database export
│   │   └── verify-import.sql          <- Integrity verification script
│   └── windows/
│       ├── install-autostart.bat      <- Double-click to install autostart
│       ├── install-autostart.ps1      <- PowerShell task registration logic
│       ├── remove-autostart.bat       <- Double-click to remove autostart
│       ├── remove-autostart.ps1       <- PowerShell task removal logic
│       ├── restart-service.bat        <- Double-click to restart backend
│       ├── restart-service.ps1        <- PowerShell service restarter
│       ├── service-runner.ps1         <- Production background runner
│       ├── start-giga-chemist.bat     <- Manual interactive launcher
│       ├── launch-pwa.bat             <- Standalone app-window launcher
│       ├── install-pwa-autolaunch.bat <- Auto-open POS window on user login
│       └── remove-pwa-autolaunch.bat  <- Remove login window auto-launch
├── logs/
│   ├── startup.log                    <- Boot & healthcheck lifecycle log
│   └── server.log                     <- Live backend stdout/stderr log
├── .env.example                       <- Canonical template
└── .env                               <- Runtime configuration (DB password)
```

---

## 3. How to Install Autostart

1. Open `File Explorer` and navigate to `C:\GIGA-CHEMIST-POS\deployment\windows\`.
2. **Right-click** on [`install-autostart.bat`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/install-autostart.bat) and select **Run as administrator** (or double-click; it will prompt for elevation).
3. The installer will:
   - Register the Windows Scheduled Task `GigaChemistPOS_Service`.
   - Configure automatic recovery on failure.
   - Create the Windows Firewall inbound rule for port 3000.
   - Start the service immediately.

---

## 4. How to Verify Autostart After Boot

### A. Healthcheck in Browser
Open your browser and navigate to:
- Local PC: `http://localhost:3000/api/health`
- Expected response:
  ```json
  {"status":"ok","mode":"local","timestamp":"2026-10-02T03:00:00.000Z"}
  ```

### B. Task Scheduler GUI
1. Press `Win + R`, type `taskschd.msc`, and press **Enter**.
2. Click **Task Scheduler Library**.
3. Look for `GigaChemistPOS_Service`. Its status should display **Running**.

### C. Check via PowerShell
Run in PowerShell:
```powershell
Get-ScheduledTask -TaskName "GigaChemistPOS_Service"
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

---

## 5. How to Check Logs

All server output and startup diagnostics are saved in `logs/`:

- **Startup Lifecycle Log:** `C:\GIGA-CHEMIST-POS\logs\startup.log`
- **Server Application Log:** `C:\GIGA-CHEMIST-POS\logs\server.log`

### Live Log Streaming (PowerShell):
```powershell
Get-Content C:\GIGA-CHEMIST-POS\logs\server.log -Tail 50 -Wait
```

---

## 6. How to Restart the POS

If you make changes to `.env` or need to restart the backend:
1. Navigate to `C:\GIGA-CHEMIST-POS\deployment\windows\`.
2. Run [`restart-service.bat`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/restart-service.bat) as Administrator.

---

## 7. How to Disable / Remove Autostart

If you want to uninstall the background autostart service:
1. Navigate to `C:\GIGA-CHEMIST-POS\deployment\windows\`.
2. Run [`remove-autostart.bat`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/remove-autostart.bat) as Administrator.
3. The scheduled task and firewall rule will be cleanly removed.

---

## 8. Optional: Cashier Window Auto-Launch on User Login

To have the GIGA CHEMIST POS window open in **standalone fullscreen/app mode** as soon as the cashier logs in to Windows:
1. Double-click [`deployment/windows/install-pwa-autolaunch.bat`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/install-pwa-autolaunch.bat).
2. This creates a startup trigger in the user's Windows Startup folder that launches Chrome or Edge with `--app=http://localhost:3000`.
3. To disable, double-click [`deployment/windows/remove-pwa-autolaunch.bat`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/remove-pwa-autolaunch.bat).

---

## 9. Troubleshooting

| Symptom | Probable Cause | Resolution |
|---|---|---|
| **Port 3000 not responding** | PostgreSQL service stopped | Open `services.msc`, locate `postgresql-x64-16`, right-click and select **Start**. Verify startup type is set to **Automatic**. |
| **`FATAL` in `startup.log`** | Missing `.env` file or invalid DB credentials | Verify `.env` exists in root and contains correct `DB_PASSWORD` or `LOCAL_DATABASE_URL`. |
| **LAN terminals cannot connect** | Windows Firewall blocked port 3000 | Re-run `install-autostart.bat` or manually allow TCP port 3000 in Windows Defender Firewall. |
| **Blank screen on client** | Cached old service worker / relative assets | Hard refresh (`Ctrl + F5`) or clear site data in DevTools. Verify `base: '/'` is used in production build. |
