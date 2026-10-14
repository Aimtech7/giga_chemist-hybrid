# Backups and recovery

Existing behaviour (unchanged): daily `pg_dump -Fc` at `BACKUP_TIME` (23:00 Kenya) into `BACKUP_DIR`,
written as `.partial` and renamed only after `pg_restore --list` succeeds (verified = true), retention
`BACKUP_KEEP` daily + `BACKUP_KEEP_WEEKLY` weekly copies, every run in `backup_runs`; the updater takes its
own verified backup before every install. Status reaches the online app with the heartbeat (last backup,
age, size, verified; never the file path) and the Sync Center; BACKUP_FAILED / BACKUP_STALE alerts.

New: `BACKUP_SUCCEEDED` / `BACKUP_FAILED` audit rows (no path; error paths redacted).

## Restore drill

```
npm run backup:restore-drill                                  newest *.dump in BACKUP_DIR (incl. weekly)
npm run backup:restore-drill -- --dump <file> --compare-db <live db>   [--keep]
```

Restores into a NEW database `giga_restore_drill_<timestamp>` only (any other name, `giga_chemist` or the
configured database are refused; an existing name is refused). Checks: archive readable, restore exit code,
schema (migrations, core tables), critical counts (users, medicines, batches, sales, sale_items, payments,
movements, audit), orphans, negative stock, optional read-only comparison (restored counts must not exceed
the live database). The temporary database is dropped; a JSON report goes to `logs/`.

### Drill 2026-10-12 (PC2, Shop 1 copy)

| | |
|---|---|
| Archive | `giga_chemist-pc2-shop1-copy.dump`, 58,987,640 bytes, 177 TOC entries, sha256 `c8f15879...be09` |
| Restore | 28 s, exit 0, no errors |
| Schema | 12 migrations (dump taken at 012), no core table missing |
| Counts = PC2 `giga_chemist` | users 7, medicines 2,181, batches 2,181, sales 135,915, sale_items 226,542, payments 135,914, movements 263,648, audit 519 |
| Integrity | 0 orphan lines / payments / batches, 0 negative batches |
| Result | **PASS**, temporary database dropped |

## Real restore (emergency only)

Never restore over a live shop database while it is selling. Procedure: stop the server, restore the
chosen archive into a NEW database, verify it (drill checks), then point `.env` at it; keep the old one.
Data entered after the backup is not in it.

Test servers never write to the real `BACKUP_DIR` and never run the daily scheduler (harness defaults).
