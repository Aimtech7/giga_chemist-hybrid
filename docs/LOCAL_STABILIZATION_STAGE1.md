# Local Stabilization — Stage 1: Stock / Physical Count

Scope: Admin stock management only (physical count, set exact stock, add stock, remove stock,
batch expiry). No sales, pricing, discount, sync, cloud, installer or UI-redesign changes.

- Source of truth: `D:\GIGA-CHEMIST-POS` (PC2)
- Database: `giga_chemist_dev` on PostgreSQL 18.6 @ 127.0.0.1:5432 (development only)
- Pre-change backup: `C:\Users\wilso\GIGA-CHEMIST-BACKUPS\giga_chemist_dev_pre_stage1_20261004_031834.dump`
  (`pg_dump -Fc`, 59 MB). Restore with `pg_restore -d <db> <file>`.

## 1. Actual dev schema (verified)

| Table | Relevant columns present |
|---|---|
| inventory_movements | `id uuid default uuid_generate_v4()`, `reason varchar`, `date date`, `user_id uuid NULL`, `device_id varchar NOT NULL → devices(id)`, `batch_id uuid NOT NULL → medicine_batches(id)` |
| medicine_batches | `selling_price_override`, `expiry_status`, `expiry_date NULL`, `updated_at` |
| medicines | `current_stock int`, `version int` |
| audit_logs | `id uuid`, `user_id uuid NULL → users(id)` |
| branches | one row: `00000000-…-0001` MAIN |
| devices | `POS-LEGACY-MIGRATED`, `POS-TERMINAL-01`, `SERVER`, `SERVER-POS` |
| schema_migrations | **absent** — the dev DB was built by importing `giga_chemist_full.sql`, never by `db:migrate` |

Baseline: 2181 medicines, 2181 batches (one per medicine, all `expiry_status = UNKNOWN`),
135,818 sales, 263,107 movements, 0 audit logs, and `current_stock = SUM(active batches)` for
all 2181 medicines.

`users` has no `salt` column here, but migration 002 declares `salt NOT NULL`. That's a user-creation
problem, recorded for a later stage.

## 2. Root causes

### ERROR A: `column "reason" of relation "inventory_movements" does not exist`
- `reason` is not in `003_indexes_constraints.sql`, `schema.sql` or `giga_chemist_full.sql`.
  Only migration **005** adds it.
- On a database built from migrations alone, 005 **always failed**. Its `INSERT INTO devices`
  hard-codes `branch_id = '00000000-…-0001'`, and no migration creates that branch, so it hit
  `devices_branch_id_fkey`. The migrator runs each file in one transaction, so the
  `ADD COLUMN reason` in the same file was rolled back, and 006 never ran. This was
  reproduced in a rolled-back scratch schema:
  `ERROR: insert or update on table "devices" violates foreign key constraint "devices_branch_id_fkey"`.
- A database loaded from `schema.sql` / `giga_chemist_full.sql` without running `db:migrate` also
  lacks the column.
- Migration 005 is dated 2026-10-03 22:33, after the error was seen.

### ERROR B: `invalid input syntax for type uuid: "mov-1791032753129-li4q"`
- `1791032753129` is 2026-10-03 16:05:53 EAT.
- At that time, server stock code passed client/route-generated IDs straight into
  `inventory_movements.id` (UUID). Generators: `routes.ts` `/inventory/adjust`
  (`mov-${Date.now()}-…`), `returns.ts`, `purchases.ts`, plus browser `mov-` IDs.
- An `ensureUuid()` patch was added to `server/db/client.ts` at 23:26 the same day, but the
  generators remained.

## 3. Changes

### Migrations
- `005_fix_inventory_movements_and_devices.sql`: the device insert now uses
  `(SELECT id FROM branches WHERE id = '…0001')`, which is NULL if MAIN doesn't exist, so 005 can
  complete on a fresh database. Already-applied databases are unaffected (tracked by filename).
- **New** `007_local_stock_stabilization.sql`: idempotent and non-destructive.
  `ADD COLUMN IF NOT EXISTS` for `inventory_movements.reason/date`,
  `medicine_batches.selling_price_override/expiry_status/updated_at`, `medicines.version/updated_at`.
  It also drops NOT NULL on `inventory_movements.user_id`, sets UUID defaults on movement/batch/audit
  IDs, and registers the `SERVER` device (`ON CONFLICT DO NOTHING`). No DROP, no data rewrite, no
  business rows.
- The fresh 001→007 chain was verified in a rolled-back scratch schema.

### Server (`server/db/inventory.ts`, `server/routes.ts`, `server/db/client.ts`)
- Every Admin stock operation (physical count, set, add, remove, expiry) is **one transaction**:
  `BEGIN → SELECT … FOR UPDATE (medicine, batch) → update batch → reconcile medicines.current_stock
  → insert inventory_movements → insert audit_logs → COMMIT`, with `ROLLBACK` and an HTTP error on any failure.
- All IDs are `crypto.randomUUID()`. Incoming `medicine_id` / `batch_id` / `supplier_id` are validated
  and return **400** if they aren't UUIDs, so bad IDs no longer reach the database as a uuid parse error.
- One status rule (`deriveBatchStatus`): qty 0 → `exhausted`; expiry before today → `quarantined`;
  otherwise `active`. `current_stock` = SUM of `active` batches everywhere. Expiry edit now uses the
  same rule; before, it excluded expired batches while other paths didn't.
- Unknown expiry is supported: `expiry_date = NULL`, `expiry_status = UNKNOWN`. Expiry dates are never
  invented. Before, the client wrote `'2099-12-31'` / `'UNKNOWN'` into Dexie.
- Multi-batch safety: set-stock without `batch_id` on a multi-batch medicine returns 400. Physical
  count applies each counted batch individually and rejects duplicate batches. Quantity is never
  distributed.
- Removing more than is available returns 400. Negative or non-integer quantities return 400.
- `device_id` falls back to `SERVER` when the caller's device isn't registered (devices FK).
- Errors map to status codes: validation → 400, not found → 404, PostgreSQL → 500, with the message
  returned to the UI.
- **Removed** the `x-user-role` / `x-user-id` header authorization fallback. Identity comes only from
  the verified JWT.
- DATE columns are now returned as `YYYY-MM-DD` strings (`pg` type parser). Before, they became
  local-midnight Dates that shifted one day back when serialized in UTC+3.

### Silent fallbacks removed (APP_MODE=local)
- `recordInventoryMovement`: transactional, re-throws, and no longer writes `data/server-db.json`
  in local mode.
- Admin stock functions no longer write `server-db.json`.
- `getAllMedicines`, `getMedicineById`, `getAllBatches`, `getBatchesByMedicine`, `getAllMovements`:
  in local mode they return PostgreSQL rows (even when empty) and raise on error, instead of
  serving demo JSON data.
- `data/server-db.json` is **not deleted**. It holds 4 sales, 10 batches, 1 movement and 2 audit logs
  from earlier fallback writes, to be reviewed in a later stage.

### Client
- `StockAdjustmentModal.tsx`: all four operations send the real Bearer token (`getAuthHeaders()`) plus
  `x-device-id`, instead of `x-user-*` headers, which got 401 in production. Dexie is updated **only
  from the committed server response** (`src/services/stockCache.ts`), not from client arithmetic.
  The `bat-…` Dexie-only batch creation is gone.
- `PhysicalStockCount.tsx` (already used the token): fallback movement ID is now `crypto.randomUUID()`.
- `inventoryEngine.ts`: Dexie movement/audit IDs are now `crypto.randomUUID()`.
- `scripts/check-db.ts`: `db:check` fails if a required stock column or the `SERVER` device is missing.

## 4. Tests

See section 5 (filled in after the run).

## 5. Results

### Migrations on `giga_chemist_dev` (2026-10-04)
The dev DB was restored from a dump and had no `schema_migrations` table, so 005/007 had never run.
Backup taken first (`backups/giga_chemist_dev_pre_stage1_20261004_041427.dump`), then
`npm run db:migrate` applied 001–007 (all idempotent); a re-run reports "already up to date".

### Fixes found during Manual Test 1
- **IndexedDB `objectStore ... not found`** — `PhysicalStockCount.tsx` called `getDeviceId()` (reads
  `db.devices`) inside a Dexie transaction scoped to medicines/batches/movements/audit_logs. The device
  lookup now runs outside the transaction and the cache update reuses `applyServerStockResult`. The Dexie
  schema itself was correct; no version bump.
- **Recovery Screen `Cannot read properties of null (reading 'replace')`** —
  `InventoryManager.tsx` rendered `m.reason.replace(...)`; 263,107 imported legacy movements have
  `reason = NULL`. `getAllMovements` now returns `reason || movement_type`; the UI tolerates cached nulls.
- **Committed vs. cache failure** — a Dexie refresh error after PostgreSQL COMMIT is reported as a cache
  warning ("Do NOT repeat this stock change"), never as a failed operation; stock modal submit locks after commit.
- **Active-stock rule aligned** — a batch is expired ON its expiry date in server code, matching
  `src/utils/expiry.isExpired` and the `trg_update_medicine_stock` trigger.

### Manual Test 1 — PASS
Admin Physical Stock Count 0 → 1 on *Aclosara Sp*: Physical Stock Count, Inventory and POS all show 1,
persists after reload, exactly one `inventory_movements` row and one `ADMIN_PHYSICAL_STOCK_COUNT` audit row,
no UUID / `reason` / IndexedDB errors, no Recovery Screen. All 2,181 medicines reconcile
(`current_stock` = SUM of active, unexpired batches).

## 6. Open issues for the next stage (not stock-related)

- **`[SyncEngine] Categories hydration notice: Unexpected token '<', "<!doctype"... is not valid JSON`** —
  `syncEngine.ts` fetches `/api/categories`, but `server/routes.ts` defines no such route, so the request
  falls through to the SPA `index.html`. Pre-existing; not introduced by the stock changes.
- Non-stock write paths still generate non-UUID IDs (`sal-`, `ret-`, `pur-`, `exp-`, `sup-`, `usr-`,
  `aud-…`) in `server/db/*.ts` and several components (sales, returns, purchases, suppliers, expenses, users).
