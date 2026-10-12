# Shop 1 deployment — feature freeze release

**Not deployed.** Each step below needs the owner's explicit approval. Order matters: cloud first, then
Vercel, then the shop (a shop on this release sends commands / reads functions the old cloud lacks).

| | |
|---|---|
| Shop 1 now | `3c7fc9e` (installed 2026-10-12 19:21 UTC; local migrations up to 020) |
| Release | head of `feature/shop1-final-feature-freeze` (commit given in the final report) |
| Local migrations | 021 `user_name_history`, 022 `stocktakes`, 023 `price_history`, 024 `alerts` (additive) |
| Cloud migration | 010 `user_profile_update` (additive, re-runnable) |
| Interruption | Shop 1 till stops during the install (last install: ~20-30 min incl. backup, npm ci, lint, build); migrations themselves take seconds |

## Rehearsals (done, 2026-10-12/13)

- **Local**: `npm run target:rehearse -- --source-db giga_chemist --rehearsal-db giga_chemist_freeze_migration_test`
  on PC2's copy of Shop 1 (2,181 medicines, 135,915 sales, at 020): backup + restore identical,
  021-024 applied, `db:check` PASS, business data unchanged (counts, stock sums, money sums, users,
  medicines, batches, purchases, returns, latest sales) — **PASS**, 37 s end to end.
- **Cloud**: production `giga_cloud` + `giga_online` copy (backup before 009) restored into a scratch
  database: 009 (505 ms) + 010 (449 ms) + 010 again (329 ms, re-runnable), data intact, new functions and
  command types present — **PASS**.
- **Restore drill** of the Shop 1 copy: **PASS** ([BACKUP-RECOVERY.md](BACKUP-RECOVERY.md)).

## Steps (each after approval)

1. **Pre-flight (read only)**: Shop 1 heartbeat online, outbox 0 pending / 0 failed, disk free, last backup
   < 26 h and verified; Vercel live; note the time.
2. **Cloud backup**: `pg_dump -Fc -n giga_cloud -n giga_online` of production (+ `pg_restore --list`).
   (A full-database dump failed once on 2026-10-12 with an SSL EOF on the large legacy `public.sale_items`;
   the two schemas 010 touches are what matters.)
3. **Cloud 010**: `psql "$PROD" -v ON_ERROR_STOP=1 -f cloud/supabase/migrations/010_user_profile_update.sql`;
   verify: `to_regprocedure('giga_online.sale_cashier_name(uuid,uuid,timestamptz)')` not null, command type
   check contains `USER_PROFILE_UPDATE` and `SYNC_RETRY_FAILED`.
4. **Vercel**: merge the release into `main` and push (auto-deploys); verify `/api/history/sold`,
   `/api/business-day`, `/api/admin/sync-center` answer 401 (route live) not 404.
5. **Shop 1**: fast-forward `production` to the release; wait until Health -> Software updates shows the
   release commit as available; **approve Install at a quiet time**. The updater takes a verified backup,
   installs, migrates 021-024, runs `db:check` and the health gate; on failure it rolls the CODE back
   (never the database).
6. **Verify**: Shop 1 heartbeat shows the release commit; `/api/health` OK; outbox draining; audit shows
   `APP_UPDATE_INSTALLED`; Alerts Center loads; no rejected events.
7. **Optional, separate decision**: Publish existing shop users (dry run first; resolve the Administrator
   EMAIL_CONFLICT; "system admin" needs a password or deactivation).

## Rollback

- Shop: automatic code rollback by the updater; manual on the shop PC:
  `node scripts/updater/updater.mjs rollback` (previous commit, code only). Migrations 021-024 only ADD objects and are harmless to the old code.
- Vercel: revert `main` to the previous commit (old code ignores 010's additions).
- Cloud 010: additive; leave in place (old code works with it). `gc_sync_user_credentials` can be restored
  by re-running 009 then 005 if ever required (not expected).
- Data: restore drill procedure only into a NEW database ([BACKUP-RECOVERY.md](BACKUP-RECOVERY.md)).

## Acceptance tests on Shop 1 (after install)

**Cashier**: log in -> open shift -> sell (cash, M-Pesa, mixed) -> receipt prints -> POS "Today's Sold"
shows the units -> History -> Stock History shows the sale -> close shift with a count.
**Admin**: Stocktakes: create (selected medicines), count, submit, approve -> stock and Stock History
change; Stock Insights tabs load; Alerts Center loads; Sync Center shows sequence and no failed events;
Business Day shows today; Data Integrity runs (INFO findings only, legacy).
**Offline**: unplug the internet: header shows "LOCAL MODE · CLOUD OFFLINE"; sell, open / close shift,
count in a stocktake; reconnect: outbox drains to 0, cloud shows the sales once.
**Online (Global Admin)**: Business Day for Shop 1, Sold Medicines, Sync Center lists Shop 1 with the new
commit.

## Test results

Full regression 2026-10-13 (dev database + cloud emulators; never a real shop or cloud):

| Check | Result |
|---|---|
| lint (tracked files) / build / build:api | pass / pass / pass |
| test:integration | 285 / 0 |
| test:hybrid | 151 / 0 |
| test:online | 177 / 0 |
| test:unified-auth | 126 / 0 (TEST 14 date-seeding flake fixed; verified 00:30 EAT) |
| test:full-write | 196 / 0 |
| test:shifts | 121 / 0 |
| test:stock-history (+ sold medicines, insights, price history, business day, integrity) | 122 / 0 |
| test:stocktake (+ alerts, audit, sync center) | 68 / 0 |
| test:pos-cache / test:api-url | 28 / 0, 30 / 0 |
| test:updater | 58 / 0 |
| test:medicine-search (reads the production catalogue, read only) | 26 / 0 |
| test:ops | 111 / 1: the known PC2-only check (PC2's .env targets giga_chemist, so "refuses a non-giga_chemist database" cannot be exercised there) |
