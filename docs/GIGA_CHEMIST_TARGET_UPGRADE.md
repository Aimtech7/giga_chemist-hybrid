# GIGA CHEMIST — Target PC Upgrade (pharmacy PC)

> # TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA.
>
> The pharmacy PC (`C:\GIGA-CHEMIST-POS`, database **`giga_chemist`**) holds real sales, physical
> stock counts and adjustments that do **not** exist in `giga_chemist_dev`. The target database stays
> the source of truth. Deployment = **NEW CODE + NON-DESTRUCTIVE MIGRATIONS + EXISTING TARGET DATABASE.**

## Never do

* restore `giga_chemist_dev` (or any dev dump, `chemist_pos.sql`, `giga_chemist_full.sql`) over `giga_chemist`
* copy PostgreSQL data folders from the dev PC
* zero stock, reset expiry dates, reseed sales/users, run `npm run db:seed`
* run `scripts/dev-reset-stock-and-expiry.ts` (it refuses `giga_chemist` and anything not `giga_chemist_dev`)
* copy the dev `.env` to the target (the target keeps its own `.env`: `DB_NAME=giga_chemist`, its own `JWT_SECRET`, passwords)

## Tools

| Tool | Purpose |
|---|---|
| `npm run target:rehearse` | Copy `giga_chemist` (read-only pg_dump) → `giga_chemist_migration_test`, run all pending migrations there, `db:check`, compare invariants. Never writes to the source. JSON report in `logs\`. |
| `npm run target:rehearse -- --snapshot <file>` / `--compare a b` | Invariants of a database (read-only) / compare two snapshots. |
| `npm run backup -- --pre-upgrade` | Verified pg_dump of the live database. |
| `deployment\windows\upgrade-target.ps1` | Orchestrates everything below with PASS/FAIL per step. `-ValidateOnly` changes nothing. |

Invariants compared: counts of medicines, medicine_batches, sales, sale_items, payments, purchases,
purchase_items, inventory_movements, users, returns, expenses, suppliers, customers, categories,
audit_logs, devices, settings; `SUM(current_stock)`, `SUM(quantity_available)`, sums of sales, payments,
refunds, purchases; content hashes of users (incl. credential hashes), medicines (stock + prices),
batches (quantity + expiry + status), purchases, returns; the 10 latest sales. Migrations may only ADD
rows (devices / audit_logs / settings may grow); any other difference = FAIL.

## Procedure on the pharmacy PC

0. Copy the new code into `C:\GIGA-CHEMIST-POS` (git pull, or copy the repository **without** `.env`,
   `node_modules`, `dist`, `backups`, `logs`). Keep the target's own `.env`. Add the new optional keys
   from `.env.example` (EMAIL_*, BACKUP_*, sync) as needed — they default to off.
1. Open PowerShell **as Administrator**:
   ```
   cd C:\GIGA-CHEMIST-POS
   powershell -ExecutionPolicy Bypass -File deployment\windows\upgrade-target.ps1 -ValidateOnly
   ```
   Must PASS: project path, PostgreSQL service running, configured database is exactly `giga_chemist`,
   development reset not enabled, no `_dev` database configured.
2. Full upgrade (during a quiet period, the POS is stopped for a few minutes):
   ```
   powershell -ExecutionPolicy Bypass -File deployment\windows\upgrade-target.ps1
   ```
   Steps: npm ci → build → stop POS → **rehearsal on giga_chemist_migration_test (must PASS)** →
   verified pre-upgrade backup → invariants before → `db:migrate` on `giga_chemist` → `db:check` →
   invariants after (must equal) → start POS → `/api/health` online with PostgreSQL connected.
   Offline PC with dependencies already installed: add `-SkipInstall`.
3. If any step FAILS the script stops. Nothing is restored automatically. Before the migration step
   the live database is untouched. After it, investigate first; restore only per
   `GIGA_CHEMIST_BACKUP_RESTORE.md` using the pre-upgrade backup printed by the script.
4. After PASS: log in, check today's sales, a few stock levels, Sales History, Reports, Settings →
   System Health.

Manual equivalent (if PowerShell scripting is not possible):
```
npm run target:rehearse -- --source-db giga_chemist      (must print REHEARSAL PASS)
npm run backup -- --pre-upgrade
npm run target:rehearse -- --source-db giga_chemist --snapshot logs\before.json
npm run db:migrate
npm run db:check
npm run target:rehearse -- --source-db giga_chemist --snapshot logs\after.json
npm run target:rehearse -- --compare logs\before.json logs\after.json   (must print INVARIANTS PASS)
```

## Evidence from development (2026-10-07)

* Rehearsal from the pre-hybrid backup of the full dev database (2,186 medicines, 135,819 sales;
  migrations 001–012 applied): 013 + 014 applied, `db:check` PASSED, every invariant unchanged — PASS.
* Rehearsal in source mode (`--source-db giga_chemist_dev`): restored copy identical to the source,
  014 applied, invariants unchanged — PASS.
* `upgrade-target.ps1 -ValidateOnly` on the dev PC refuses (database is `giga_chemist_dev`).

This proves the migrations on a database of the same shape; **the rehearsal must still be run on the
target itself**, because its data and migration level are newer than the dev copy.

## Shop identity after the upgrade

Migration 013 generates the target's own Shop 1 id (`shop_identity`), different from the dev id. That id
is the real Shop 1. Use it (`npm run db:check` prints it) when registering the shop in the cloud and in
`.env.online` (`SHOP_ID`). Do not copy the dev id.
