# GIGA CHEMIST — Remote operations (manage the pharmacy from a phone)

The owner manages the pharmacy from **https://gigachem.vercel.app** without physical access to the
pharmacy PC. The pharmacy PC's **local PostgreSQL stays authoritative**: the cloud (Supabase) is a
copy plus a command channel. Nothing on the phone writes business data in the cloud directly.

```
PHONE ──HTTPS/JWT──> Vercel API (ADMIN only, validated, rate-limited, audited)
                       │  giga_cloud.queue_online_command  (kill switch, idempotency, online_audit)
                       ▼
                 giga_cloud.commands  ──gc_pull_commands──>  PHARMACY PC sync worker
                                                               │ ONE local transaction:
                                                               │ same inventory/user logic as the POS,
                                                               │ movement + audit + outbox + sync_inbound_commands
                                                               ▼
   phone sees PENDING → DELIVERED → APPLIED / REJECTED  <──gc_ingest_events + gc_ack_command──
   phone sees shop health / alerts                       <──gc_heartbeat (every 60 s)──

GitHub "production" branch ──(phone approval: APP_UPDATE_APPROVE)──> updater task on the PC:
   verify tip of production → healthy now? → verified pg_dump → stop → checkout → npm ci → lint
   → build → db:migrate → db:check → start → health gate → SUCCESS   or   automatic CODE ROLLBACK
```

## 1. What the Administrator can do from the phone

| Area | Phone | Mechanism |
|---|---|---|
| Stock | Add, Remove, Set Physical Count per batch | `STOCK_ADD` / `STOCK_REMOVE` / `STOCK_SET` (count applied against the quantity locked when applied; never negative) |
| Prices | retail, wholesale, minimum, purchase | `PRICE_UPDATE` (sale_items snapshots never change; refused if a local price change has not synced) |
| Medicine | name, generic, brand, manufacturer, description, form, strength, unit, category, Rx, SKU, barcode, reorder level, active/inactive | `MEDICINE_METADATA_UPDATE` (each field validated; barcode uniqueness enforced by the shop) |
| Expiry | per batch, set / correct / clear (unknown) | `BATCH_EXPIRY_UPDATE` |
| Catalog / settings | categories, pharmacy name, address, receipt texts | `CATEGORY_UPSERT`, `SETTINGS_UPDATE` (no infrastructure setting is reachable) |
| Staff | activate / deactivate, role ADMIN / CASHIER | `USER_SET_ACTIVE`, `USER_ROLE_UPDATE` (last active Admin protected) |
| Updates | see installed / available, **Install update** | `APP_UPDATE_APPROVE` (approval only; the updater verifies independently) |
| Health | shop PC ONLINE/OFFLINE by heartbeat age (180 s), PostgreSQL, sync, queues, uptime, last restart, disk, backups, version, last error | `gc_heartbeat` → `giga_cloud.shop_runtime_status` |
| Alerts | active / history / acknowledge | `giga_cloud.alerts` (shop: DB, sync, rejected events, backup failed/stale/disabled, low disk, low/out of stock, near-expiry/expired, update failed/rollback, crash loop; cloud: shop offline, command rejected) |
| Reports | today / week / month sales, cash, M-Pesa, tender split, gross profit, cashier totals, top medicines, returns, purchases; inventory intelligence (low, out, fast, slow, dead stock, near-expiry, expired, valuation, retail vs wholesale, **reorder suggestions**) with CSV | cloud copy (read-only views); deterministic formulas, labelled as suggestions |
| Activity | every command: who, requested / delivered / applied times, target, before → after, result or rejection reason, audit reference | `giga_cloud.commands` (+ `display`) |
| Security | disable remote changes (kill switch), maintenance mode, sign out one / all online accounts, deactivate a compromised online account | `giga_cloud.remote_control`, `online_users.token_version` |

**Not enabled: remote password / PIN reset.** A command payload is stored in the cloud command
history; a hashed 6-digit PIN there could be brute-forced offline, and a one-time reset needs a
second secure channel to the cashier. Reset passwords/PINs on the pharmacy PC (Users screen), or
deactivate the account remotely and reactivate it after an on-site reset.

Sales, checkout (cash / M-Pesa), purchase receiving and return approval remain **shop-only**
(online answers `409 ONLINE_READ_ONLY`).

## 2. Approved production channel (software updates)

* `main` = development. **Never installed** on the pharmacy PC.
* `production` = approved pharmacy build. The updater only ever installs the **tip of
  `origin/production`**, and (with `UPDATE_REQUIRE_APPROVAL=true`, the default) only after the
  Administrator taps **Install update** for that exact commit.
* The repository is public: the PC needs no GitHub credential. If it ever becomes private, create a
  fine-grained **read-only** token for this one repository and store it in *Windows Credential
  Manager* for the SYSTEM account via Git Credential Manager — never in `.env`, scripts or task
  arguments.

Releasing (on the development PC, after all suites pass):

```
git checkout production          # first time: git checkout -b production origin/main
git merge --ff-only main         # or merge a specific tested commit: git merge --ff-only <sha>
git push origin production
git checkout main
```

Within 10 minutes the phone shows **UPDATE AVAILABLE** (Health → Software updates). Tap **Install
update** → command APPLIED = approval recorded → the updater installs it on its next run and
reports SUCCESS, or FAILED / ROLLED_BACK. Never force-push `production` to an older commit to
"downgrade"; release a fixed commit instead (or use `rollback-update.ps1` on the PC).

Update pipeline: deployment lock → fetch → target must equal the production tip → working copy clean
→ `.env` / `.env.online` untracked and absent from the target commit → current version healthy →
**verified pg_dump** (`PRE_UPGRADE`) → maintenance lock (supervisor holds the server down) → stop
server → `git checkout --detach` → `npm ci` → `npm run lint` → `npm run build` → optional
`npm run target:rehearse` (`UPDATE_REHEARSE_MIGRATIONS=true`) → `npm run db:migrate` →
`npm run db:check` → start → health gate (API up, PostgreSQL connected, running commit = target,
mode as configured, sync worker running in hybrid) → **SUCCESS**. Any failure after the code
changed → checkout previous commit → `npm ci` → build → start → health → **ROLLED_BACK** (alert on
the phone). The database is never restored automatically: migrations must stay additive /
forward-compatible so the previous version runs on the newer schema.

Logs: `logs\update.log`; status `logs\runtime\update-state.json` (sent with every heartbeat).

## 3. Backups

* Daily at `BACKUP_TIME` (server scheduler, `BACKUP_ENABLED=true`), `pg_dump -Fc`, written as
  `.partial`, accepted only if pg_dump exit 0, size > 0 and `pg_restore --list` reads a non-empty
  table of contents; recorded in `backup_runs` (`verified`, `toc_entries`, size, tier).
* Retention: newest `BACKUP_KEEP` daily (default 14; set 7 for the 7-day policy) + a weekly copy
  in `<BACKUP_DIR>\weekly` (newest `BACKUP_KEEP_WEEKLY`, default 4).
* Production: `BACKUP_DIR=C:\GIGA-CHEMIST-BACKUPS` (outside the code folder; untouched by updates).
* Phone: Health → Backups (last backup, PASS/FAIL, size, verification, next backup) + alerts.
* **Off-site encrypted backup is NOT implemented.** Supabase Storage could hold encrypted archives
  (private bucket, client-side AES-256-GCM with `BACKUP_ENCRYPTION_KEY` kept only on the PC,
  upload through a short-lived signed URL issued by a server function — the service-role key never
  on the PC). That needs a bucket, a signing function and key custody decided by the owner; until
  then `REMOTE_BACKUP_ENABLED=false` and the phone shows "Off-site backup: not configured".
  Interim: copy `C:\GIGA-CHEMIST-BACKUPS\weekly` to an external drive monthly.

## 4. Emergency controls

* **Disable remote changes**: new commands refused by the API (423) *and* by the database function
  (`PT423`). Commands already queued still reach the shop.
* **Maintenance mode**: only Administrators can use the online app (cashier sessions/logins get 503).
* **Sign out**: bumps `token_version`; every older online token for that account (or all) is
  rejected immediately. **Deactivate online account**: login refused and sessions revoked; the last
  active online Administrator cannot be deactivated.
* All of these, every login (success / failure) and every queued command are written to
  `giga_cloud.online_audit` (no passwords or tokens).
* Disabling a shop cashier remotely: Staff → Deactivate (command, applied by the shop).

## 5. Security summary

ADMIN-only mutation routes (401 / 403 otherwise), shop_id only from the server's `SHOP_ID`,
server-generated command ids and idempotency keys, explicit per-field validation on the API **and**
again on the shop, parameterized SQL, no credentials in commands, rate limits (30 commands / 20
security actions per minute per Admin), secure headers (nosniff, frame DENY, HSTS on HTTPS,
no-store on `/api`), session revocation, kill switch, audit trails on both sides. The browser never
receives `SYNC_SHOP_TOKEN`, the service-role key, `DATABASE_URL`, DB password, `JWT_SECRET` or SMTP
password (`npm run scan:dist` checks the build for names **and** the actual `.env` values).

## 6. One-time setup

### Supabase (SQL editor, in order; all re-runnable, non-destructive)
1. `cloud/supabase/migrations/001_giga_cloud_hybrid.sql` (if not yet applied)
2. `cloud/supabase/migrations/002_online_api.sql` (if not yet applied)
3. `cloud/supabase/migrations/003_remote_admin_commands.sql`
4. `cloud/supabase/migrations/004_remote_operations.sql`

Check: `SELECT to_regprocedure('public.gc_heartbeat(uuid,text,jsonb)'), to_regclass('giga_cloud.alerts');`
(both non-NULL).

### Vercel
No new variables. Required: `DATABASE_URL` = Supabase **transaction pooler** URL, `SHOP_ID` =
`c2a176c8-a50f-456f-a370-225c11d2e32f`, `JWT_SECRET` (≥ 32 chars). Optional:
`HEARTBEAT_ONLINE_SECONDS` (default 180), `ONLINE_COMMAND_RATE_PER_MINUTE` (30).

### Pharmacy PC `.env` (add / confirm; never change SHOP_ID or SYNC_SHOP_TOKEN)
```
APP_MODE=hybrid
SYNC_ENABLED=true
BACKUP_ENABLED=true
BACKUP_TIME=23:00
BACKUP_DIR=C:\GIGA-CHEMIST-BACKUPS
BACKUP_KEEP=7
BACKUP_KEEP_WEEKLY=4
HEARTBEAT_INTERVAL_SECONDS=60
UPDATE_BRANCH=production
UPDATE_REQUIRE_APPROVAL=true
REMOTE_BACKUP_ENABLED=false
```

### Pharmacy PC deployment (operator on site, elevated PowerShell, `C:\GIGA-CHEMIST-POS`)
1. `npm run backup -- --dir C:\GIGA-CHEMIST-BACKUPS\pre-deploy` (verified backup of `giga_chemist`).
2. Get the code as a **git clone** (required for updates): if the folder is not a clone yet, clone
   `https://github.com/Aimtech7/giga_chemist-hybrid.git` next to it, copy `.env` / `.env.online` /
   `logs` / `backups` in, and switch folders; otherwise `git fetch` + `git checkout --detach <released sha>`.
3. `npm ci` · `npm run build` · `npm run target:rehearse` (PASS required) · `npm run db:migrate` · `npm run db:check`.
4. `powershell -ExecutionPolicy Bypass -File deployment\windows\install-giga-service.ps1`
   (server task + watchdog task; PostgreSQL set to Automatic; LAN rule on Private profile only).
5. `powershell -ExecutionPolicy Bypass -File deployment\windows\updater\install-updater-task.ps1`.
6. `npm run sync:bootstrap -- --confirm` **on the pharmacy PC only, once** (stock baseline + staff
   profiles without credentials). Never on the development PC.
7. `powershell -ExecutionPolicy Bypass -File deployment\windows\check-giga-service.ps1` → HEALTHY,
   `deployment\windows\updater\check-updater.ps1` → task installed.
8. Restart Windows, do not log in to anything, wait 3 minutes, run the check again; then the phone
   acceptance test below.

## 7. Phone acceptance test (before leaving the pharmacy PC)

A. **Target local** — log in at the PC; medicines, real stock, prices and today's sales visible.
B. **Cloud baseline** — phone (Remote Admin → Medicines) shows the same medicines and quantities.
C. **Phone on mobile data** (Wi-Fi off), log in as the online Admin; banner shows
   "ONLINE — CLOUD COPY · REMOTE ADMIN ENABLED"; Health shows **Shop PC ONLINE** (< 2 min).
D. **Remote price** — change one controlled medicine's price: PENDING → DELIVERED → APPLIED; the PC
   shows the new price; the phone list shows it; Activity shows old → new.
E. **Remote stock add** — +2 on a controlled batch: APPLIED; PC stock +2; Inventory movement and
   audit rows (user "CLOUD (…)") exist; phone shows the new quantity.
F. **Remote stock remove** — −2 (reason Damaged): same lifecycle. Then try removing more than the
   batch holds: REJECTED with "Cannot remove…".
G. **Internet outage** — unplug the PC's internet; queue +1: stays PENDING; Health turns OFFLINE
   within ~3 min and an alert appears; reconnect: APPLIED exactly once (check the movement count).
H. **Reboot** — restart Windows, do **not** open PowerShell or log in; within ~3 min the phone shows
   Shop PC ONLINE, PostgreSQL HEALTHY, Sync HEALTHY; perform another remote change → APPLIED.
I. **Backup** — Health → Backups shows PASS with size and verification after the first scheduled run
   (or run `npm run backup` once at the PC; the phone shows it at the next heartbeat).
J. **Update** — Health → Software updates shows the installed commit and status `NO_UPDATE` or
   `NO_CHANNEL` (no production branch yet) — proving the updater runs and reports, without installing
   anything.
Finally undo the test changes (price back, Set Physical Count to the real count).
