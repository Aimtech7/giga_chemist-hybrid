GIGA CHEMIST - PHARMACY PC INSTALLATION (READ FIRST)
====================================================

BEFORE YOU START
  * The PC must have: PostgreSQL with the real database "giga_chemist", Node.js 20 or newer,
    Git for Windows, and an internet connection.
  * The POS is OFFLINE from step 3 until step 5 finishes (about 10-30 minutes). Do it after hours.

0. IF AN OLDER GIGA CHEMIST IS ALREADY IN C:\GIGA-CHEMIST-POS
   Rename that folder to C:\GIGA-CHEMIST-POS-OLD (do NOT delete it; its .env is the fallback for
   the database password).

1. Copy the folder GIGA-CHEMIST-POS from the flash drive to:
       C:\GIGA-CHEMIST-POS
   Copy the WHOLE folder, including hidden items (.git, .env, .env.online) and node_modules.

2. Open PowerShell as Administrator
   (Start menu -> type PowerShell -> right-click -> Run as administrator).

3. Run:
       Set-ExecutionPolicy -Scope Process Bypass -Force
       cd C:\GIGA-CHEMIST-POS\TARGET-RUN

4. Execute, ONE AT A TIME, and continue ONLY when the script ends with "RESULT: PASS":
       .\run1.ps1    preflight + VERIFIED backup of giga_chemist
       .\run2.ps1    migration rehearsal on a COPY of the database
       .\run3.ps1    apply database migrations (stops the old POS server)
       .\run4.ps1    cloud connection + shop identity
       .\run5.ps1    install auto-start, watchdog, updater (POS starts again here)
       .\run6.ps1    ONE-TIME cloud baseline (asks you to type: BOOTSTRAP TARGET SHOP1)
       .\run7.ps1    final remote health check
       .\run8.ps1    ready-to-reboot check (asks before restarting)

5. NEVER skip a step that FAILED. Stop and send C:\GIGA-CHEMIST-POS\logs\target-install.log
   to the developer.
   If run1 says "PostgreSQL rejected the password": open C:\GIGA-CHEMIST-POS\.env in Notepad,
   set DB_PASSWORD (and the password inside DATABASE_URL / LOCAL_DATABASE_URL) to the value from
   C:\GIGA-CHEMIST-POS-OLD\.env, save, and run run1.ps1 again.

6. NEVER run any "dev-reset" script.
7. NEVER restore giga_chemist_dev (or any development backup) onto this PC.
8. NEVER run the bootstrap (run6) more than once unless the developer tells you to.
9. Never run "npm run dev" on this PC: the POS starts by itself.

AFTER run8 AND THE REBOOT
  * Do NOT open PowerShell or npm. Wait 3 minutes. The POS is at http://localhost:3000
    (and http://<this-PC-LAN-IP>:3000 for other tills).

PHONE ACCEPTANCE TEST (phone on MOBILE DATA, Wi-Fi OFF - not the shop Wi-Fi)
  1.  Open https://gigachem.vercel.app
  2.  Log in as the online ADMIN.
  3.  Remote Admin -> Health must show "Shop PC: ONLINE", PostgreSQL HEALTHY, Sync HEALTHY.
  4.  Medicines: real medicines and real stock are visible.
  5.  Choose one medicine and one known batch; note its quantity.
  6.  Add Stock: +1, reason "REMOTE ACCEPTANCE TEST" -> Confirm.
      Watch: PENDING -> DELIVERED -> APPLIED.
  7.  The quantity is +1 on the phone AND on the pharmacy PC.
  8.  Remove Stock: 1, reason "Physical stock correction", notes "UNDO REMOTE ACCEPTANCE TEST"
      -> APPLIED; quantity back to the original.
  9.  Edit Price: change one medicine's selling price temporarily -> APPLIED; the PC shows it.
  10. Edit Price again: restore the original price -> APPLIED.
  11. Open Alerts, Reports, Activity (tap a change: who/when/result), Staff and Health.
  12. Health -> Software updates: shows the installed version and "NO_UPDATE" (approved channel
      "production"). Do not install anything.
  If a step fails: Health and Alerts show why; send screenshots to the developer.
