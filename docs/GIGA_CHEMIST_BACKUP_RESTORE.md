# GIGA CHEMIST — Backup & Restore

> **TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA.**
> Never restore a `giga_chemist_dev` backup into `giga_chemist`. Restore only a backup that was taken
> from the same pharmacy database, and only deliberately, by a person.

## 1. Automatic backups

* `server/ops/backup.ts` — `pg_dump -Fc` of the database configured in `.env`.
* File: `<BACKUP_DIR>/<database>_<YYYY-MM-DD_HHmmss>.dump` (Africa/Nairobi time), e.g.
  `giga_chemist_2026-10-07_180000.dump`. Written as `.partial` and renamed only after verification
  (`pg_restore --list` must read the archive).
* Retention: newest `BACKUP_KEEP` files of that database (default 14); other files are never touched.
* Every attempt is logged to `backup_runs` and `logs/backup.log`. The password is passed to pg_dump
  through `PGPASSWORD`, never on the command line.
* One backup at a time (advisory lock). **Nothing is ever restored automatically; there is no restore API.**

Settings (`.env`):

```
BACKUP_ENABLED=true          # server schedules one backup per day
BACKUP_TIME=21:00            # Africa/Nairobi; retried every 20 min after a failure
BACKUP_DIR=D:\GigaChemistBackups   # preferably a second disk; default .\backups
BACKUP_KEEP=14
PG_BIN_DIR=C:\Program Files\PostgreSQL\18\bin   # optional; auto-detected
```

Ways to run a backup:

| How | Command |
|---|---|
| Automatic (server running) | `BACKUP_ENABLED=true` |
| Admin screen | Settings → System Health → **Back up now** |
| Command line | `npm run backup` (options `--dir <path> --keep <n>`) |
| Windows Task Scheduler (works even if the POS is stopped) | run `scripts\backup\run-backup.bat` daily |

Admin → Settings → System Health shows last successful backup, its age (warning after 36 h), file,
location and last error. Copy backups off the PC regularly (USB / cloud drive): a backup on the same
disk does not survive a disk failure.

Backups are git-ignored (`backups/`, `*.dump`) and must never be committed.

## 2. Verifying a backup

```
"C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --list D:\GigaChemistBackups\giga_chemist_2026-10-07_180000.dump
```
A list of TOC entries = readable archive. For a full proof, use the rehearsal tool (restores into a
scratch database and checks it): `npm run target:rehearse -- --from-dump <file>`.

## 3. Restore (manual, emergency only)

Only when the live database is lost or corrupted, and only from a backup of **this pharmacy's**
database. Restoring discards everything recorded after that backup.

1. Stop the POS (`deployment\windows\restart-service.ps1` stops it; or stop the scheduled task).
2. Keep the damaged database: rename it rather than dropping it.
   ```
   psql -U postgres -c "ALTER DATABASE giga_chemist RENAME TO giga_chemist_broken_YYYYMMDD;"
   ```
3. Create an empty database and restore:
   ```
   psql -U postgres -c "CREATE DATABASE giga_chemist;"
   pg_restore -U postgres -d giga_chemist --no-owner D:\GigaChemistBackups\giga_chemist_<stamp>.dump
   ```
4. `npm run db:migrate` (applies any migration newer than the backup), `npm run db:check`.
5. Start the POS; verify latest sales, stock of a few medicines, users.
6. In hybrid mode: events recorded after the backup were lost locally; the cloud may already hold
   some of them. Do not re-key or reset the outbox; report it.

## 4. Never

* restore `giga_chemist_dev` (or any development dump) into `giga_chemist`
* copy PostgreSQL data folders between PCs
* run `scripts/dev-reset-stock-and-expiry.ts` on a pharmacy PC (it refuses `giga_chemist` anyway)
