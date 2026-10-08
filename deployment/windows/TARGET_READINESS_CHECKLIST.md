# Pharmacy PC readiness checklist (before the owner leaves the site)

Run `deployment\windows\check-giga-service.ps1` (must print `RESULT: HEALTHY`) and
`deployment\windows\updater\check-updater.ps1`, then tick each line.

## Software (verified by the scripts)
- [ ] PostgreSQL service (e.g. `postgresql-x64-18`) startup type **Automatic** and Running
- [ ] Task **GIGA CHEMIST POS Server**: SYSTEM, at boot, watchdog trigger every 5 min
- [ ] Task **GIGA CHEMIST Watchdog**: SYSTEM, every 5 min (hung-server / PostgreSQL / supervisor)
- [ ] Task **GIGA CHEMIST Updater**: SYSTEM, every 10 min, `UPDATE_REQUIRE_APPROVAL=true`
- [ ] Old task `GigaChemistPOS_Service` absent (it forced APP_MODE=local)
- [ ] `.env`: `APP_MODE=hybrid`, `SYNC_ENABLED=true`, `BACKUP_ENABLED=true`, `BACKUP_DIR=C:\GIGA-CHEMIST-BACKUPS`,
      `SHOP_ID=c2a176c8-a50f-456f-a370-225c11d2e32f` (unchanged), `SYNC_SHOP_TOKEN` set (unchanged)
- [ ] PostgreSQL listens on localhost only; no firewall rule opens 5432; port 3000 only on the Private profile
- [ ] Reboot test: restart Windows **without logging in**; within 3 minutes the phone shows Shop PC ONLINE
- [ ] Internet test: unplug / replug the router; the phone shows OFFLINE then ONLINE again; a command
      queued during the outage is APPLIED exactly once
- [ ] First scheduled backup PASS on the phone (Health → Backups)

## Hardware / power (cannot be done by software)
- [ ] BIOS/UEFI: **Restore on AC Power Loss = Power On** (name varies: "AC Recovery", "After Power
      Failure"). Set it manually in the firmware setup if the board supports it; Windows cannot change it.
- [ ] Windows power plan: never sleep / hibernate (`powercfg /change standby-timeout-ac 0`,
      `powercfg /change hibernate-timeout-ac 0`); disable "Fast startup" so boot tasks always run.
- [ ] Windows Update active hours set to night hours; automatic restarts are fine (the POS starts by itself).
- [ ] A UPS is strongly recommended (clean shutdown + router kept up); not a software dependency.
- [ ] Router set to restart automatically after power loss; internet SIM/line has credit.
- [ ] Optional remote desktop prepared and approved by the owner (REMOTE_SUPPORT.md).
