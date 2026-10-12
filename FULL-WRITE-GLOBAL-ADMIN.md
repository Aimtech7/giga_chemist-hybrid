# GIGA CHEMIST — Full-Write Global Admin

Branch `feature/full-write-global-admin` (child of `feature/multi-shop-unified-auth` @ `2a3c8f9`).
Production (`main` = `production`) is untouched at `f93c8c42e8a7100734fbae6e9d1f88246a06cf74`.
**Nothing in this phase is deployed.** Shop 1, its database, token, Shop ID and secrets are unchanged; Shop 2 is not created.

---

## 1. Architecture

The online Admin is the **control plane** for every shop; each shop's **local PostgreSQL stays the operational authority**.
"Full write" means every administrative change can be *requested* online — never that the browser or the online API writes business tables in the cloud.

```
Global Admin (browser)
  → online API (Vercel, JWT, request-scoped shop)      validate payload · check records exist in THIS shop's cloud copy
  → giga_cloud.queue_online_command                    re-checks account/shop in the database · idempotency key
  → giga_cloud.commands (PENDING)                      one row = one shop
  → shop sync worker: gc_pull_commands (shop token)    DELIVERED
  → applyCloudCommand: ONE local transaction            validate again · lock rows · concurrency check · business change
                                                        · inventory movement · audit row · outbox event · idempotency row
  → gc_ack_command                                      APPLIED / REJECTED (+ result / conflict details)
  → outbox → gc_ingest_events → cloud copy              the Admin sees the new figures
```

* The command processor (`server/sync/commands.ts`) is the **only** remote write path. Its handlers call the **same transactional
  functions as the shop's own screens** (`server/db/*Tx`: `createSupplierTx`, `receiveDraftPurchaseTx`, `voidExpenseTx`,
  `approveReturnTx`, `voidSaleTx`, `adminCreateBatchTx`, …). No business rule exists twice; the local routes call the same functions.
* One Supabase project for all shops; isolation by `shop_id`. Each shop has its own `SHOP_ID`, `SYNC_SHOP_TOKEN` and `DEVICE_ID`.

## 2. Modules and command types

| Module | Online screen | Command types |
|---|---|---|
| Medicines | Operations → Medicines | `MEDICINE_CREATE`, `MEDICINE_METADATA_UPDATE` (= MEDICINE_UPDATE), `MEDICINE_SET_ACTIVE` (removal = inactive) |
| Pricing | Medicine → Edit Price | `PRICE_UPDATE` (retail, wholesale, minimum, purchase) — one shop or **all shops** |
| Inventory | Medicine → Add / Remove / Physical Count | `STOCK_ADD`, `STOCK_REMOVE`, `STOCK_SET` (count only) |
| Batches / Expiry | Medicine → New / Edit / On-Off batch, Edit Expiry; Expiry filter | `BATCH_CREATE`, `BATCH_UPDATE`, `BATCH_EXPIRY_UPDATE`, `BATCH_SET_ACTIVE` (off = `recalled`) |
| Categories | Settings | `CATEGORY_UPSERT` (one shop or all shops) |
| Suppliers | Directory → Suppliers | `SUPPLIER_CREATE`, `SUPPLIER_UPDATE`, `SUPPLIER_SET_ACTIVE` |
| Customers | Directory → Customers | `CUSTOMER_CREATE`, `CUSTOMER_UPDATE`, `CUSTOMER_SET_ACTIVE` |
| Purchases | Operations → Purchases | `PURCHASE_CREATE` (pending), `PURCHASE_UPDATE_DRAFT`, `PURCHASE_RECEIVE`, `PURCHASE_CANCEL` |
| Expenses | Finance → Expenses | `EXPENSE_CREATE`, `EXPENSE_UPDATE`, `EXPENSE_VOID` |
| Returns | Finance → Returns | `RETURN_APPROVE`, `RETURN_REJECT` (cashier request stays local, PENDING) |
| Sales | Finance → Sales | `SALE_VOID` only — completed sales are never edited |
| Users | Administration → Users | `USER_CREATE`, `USER_SET_ACTIVE`, `USER_ROLE_UPDATE`, `USER_CREDENTIAL_REFRESH`, `USER_SESSION_REVOKE` |
| Settings | Administration → Settings | `SETTINGS_UPDATE` (non-secret fields; some may go to all shops) |
| Remote ops | System → Remote Operations | health, alerts, security switches, `APP_UPDATE_APPROVE` (unchanged) |
| Reports | Finance → Reports | read only (cloud copy; voided expenses and unreceived purchases excluded) |

Online API: `POST /api/admin/commands/<action>` (one shop), `POST /api/admin/all-shops/commands/<action>` (fan-out),
`GET /api/admin/commands[/:id]`, `GET /api/admin/overview` (Global Control Center). Actions are listed in `server/online/remoteAdmin.ts` (`ACTIONS`).

Create commands carry an id **chosen by the online API** (derived from the client request id), so the new record can be referenced
immediately, a retried request names the same record, and a re-delivered command never creates it twice.

## 3. Security model

* **Request-scoped shop**: `X-GIGA-SHOP-ID` is re-authorized on every request (`resolveShop`); no process-global mutable shop.
  GLOBAL_ADMIN → any active registered shop; SHOP admin / manager / cashier → own shop only; anything else → **403**.
* Only ADMIN accounts queue commands (managers and cashiers: 403). `queue_online_command` re-checks the account and shop inside the database.
* Every record named in a payload must exist in the **selected shop's** cloud copy (a Shop 1 id under Shop 2 → 404, nothing queued).
* The shop re-validates every payload and refuses a command addressed to another shop (`403 Command is addressed to a different shop`);
  a shop's token pulls and acknowledges only its own commands.
* **All Shops** is read-only: the browser sends `X-GIGA-SCOPE: ALL`; every shop-scoped write answers `409 ALL_SHOPS_READ_ONLY`.
  Only the explicit all-shops endpoint fans out, and only for prices, medicine details, categories and non-secret settings —
  never stock, sales, returns, purchase receipt, users or device identity.
* Emergency switch per shop (`remote_writes_enabled`), rate limits and maintenance mode are unchanged.

## 4. Shop isolation and cache isolation

* Server: every read runs in a READ ONLY transaction with `giga.shop_id` = the request's authorized shop.
* Browser: the Dexie catalogue is stamped with its shop key in the same transaction that replaces it. Switching shop →
  purge → reload → download medicines + batches for the new shop → validate → transactional replace → stamp → render.
  Screens check `isCatalogForCurrentShop()` first. **All Shops** has its own key (`ALL`) and never caches any shop's catalogue.
* "APPLY TO ALL SHOPS" = one independent command per shop; a medicine is matched in each shop by **barcode** (ids differ per shop);
  shops without exactly one match are reported **SKIPPED**. Each shop's command carries that shop's own current values as `expected`.

## 5. Offline command behaviour

* A command for an offline shop stays **PENDING** and is applied once, when the shop reconnects (pull → apply → ack; re-delivery is a duplicate).
* The API returns `shop_online` and a `warning`. Stock and financial commands (`STOCK_*`, `BATCH_CREATE`, `PURCHASE_RECEIVE`,
  `RETURN_APPROVE`, `SALE_VOID`) get the strong warning: they are re-checked against the shop's live data on arrival and may be REJECTED.
* Lifecycle: `PENDING → DELIVERED → APPLIED | REJECTED`. Listing fields: `command_id, shop_id, command_type, entity, entity_id,
  idempotency_key, expected, created_by (actor), created_at, payload, status, result, error`.

## 6. Optimistic concurrency

The Admin's page can be stale (a cashier sells, sync lags). Edits carry **what the Admin saw**; the shop compares it with the row it
**locks** in the applying transaction and rejects on any difference — newer local activity is never overwritten.

* Stock: `expected_quantity` = the batch quantity shown. **Mandatory for `STOCK_SET`**; optional for add/remove (movements commute,
  and a removal can never go negative). Example: Admin saw 20, sets 30, shop now has 17 →
  `REJECTED: CONFLICT: current stock of batch X changed since the page was loaded: the shop has 17, you saw 20` with
  `result.conflict.quantity = { expected: 20, current: 17 }`.
* Field edits (prices, medicine details, batch, supplier, customer, expense): `expected = { field: value seen }`.
  Field comparison, not `medicines.version`, because the version moves on every sale. Without `expected`, price/detail commands
  keep the older rule (refuse while a local change of that medicine has not synced).
* `BATCH_EXPIRY_UPDATE`: optional `expected_expiry_date`.

## 7. Audit model

* Cloud: every queued command → `giga_cloud.online_audit` `REMOTE_COMMAND_QUEUED` (actor, shop, type, payload, IP, user agent);
  all-shops fan-out → `REMOTE_COMMAND_ALL_SHOPS`; security actions as before.
* Shop: every command → `CLOUD_COMMAND_APPLIED` / `CLOUD_COMMAND_REJECTED` (entity_id = command id) **plus** the business audit row
  written by the shared function (before/after values; actor `CLOUD (<name> <email>)`; `command_id` in `new_value`).
  The audit rows reach the cloud with the outbox event.
* Never in a command, display, result, audit row or log: password, password_hash, PIN, pin_hash, JWT / JWT_SECRET,
  SYNC_SHOP_TOKEN, database password (verified by test 50). Credentials travel only through the dedicated credential RPCs.
  A malformed command that nevertheless carries secret-named fields (`pin`, `password`, `token`, …) is rejected, and those values
  are stored as `[REDACTED]` in `sync_inbound_commands` and the audit trail (`redactSecrets`, server/sync/commands.ts).

## 8. User management

Global Admin manages global admins (cloud) and every shop's staff (cloud login mirror + shop command in one cloud transaction):
create (same password local + online; PIN local only, unusable until set at the shop), deactivate / reactivate, role, password
reset (`USER_CREDENTIAL_REFRESH`: the shop fetches the hash; never in the command), **session revoke** (online `token_version` +
`USER_SESSION_REVOKE`: shop tokens issued before `users.sessions_revoked_at` are refused). "Remove" = deactivate.
The last active GLOBAL_ADMIN cannot be deactivated (database trigger); the last active shop Administrator cannot be deactivated or demoted.

## 9. Schema changes

* Cloud **006** (`cloud/supabase/migrations/006_full_write_admin.sql`): command types; new event types `EXPENSE_UPDATED`,
  `EXPENSE_VOIDED`, `PURCHASE_DRAFTED`, `PURCHASE_UPDATED`, `PURCHASE_CANCELLED`, `BATCH_UPDATED`; `EXPENSE_RECORDED` /
  `PURCHASE_RECEIVED` upsert newer copies; online views gain `expenses.status`, `customers.active`, `purchases.cancel_reason`,
  `returns.reviewed_by_name` (appended). Implemented as a wrapper: 001's function is kept as `apply_event_core`.
  Re-running 001 later requires re-running 006. Cloud 003/004/005 were made safe to re-run after 006: they no longer
  narrow the `command_type` CHECK once a later migration has widened it (found by the unified-auth suite's 005 re-run).
* Local **017** (`migrations/017_full_write_admin.sql`): `customers.active`; expense lifecycle (`status`, `void_*`,
  `created_by_name`, `user_id` optional); `purchases.invoice_number` optional while pending, `cancel_reason/at`;
  `returns.reviewed_by_name` (+ review constraint accepts a named remote reviewer); `users.sessions_revoked_at`. Additive / relaxing only.

## 10. Deployment order (each step needs explicit owner approval)

Prerequisites from the previous phase still apply: cloud **005** → Vercel → Shop 1 update → credential dry-run → enable credential sync.

1. **Cloud 006** in the Supabase SQL editor (after 005). Safe for the current Shop 1 software: it only adds types/functions; existing event types behave the same.
2. **Vercel** (online API + UI). Requires 006 (the views' new columns). Old shop software rejects new command types safely, so do not use the new screens until step 3.
3. **Shop 1 update** through the approved production channel (updater runs `db:migrate` → local 017). Must come **after** 006:
   a shop on this release emits the new event types, which a pre-006 cloud would reject (recorded in `rejected_events`, not lost, but not mirrored).
4. Smoke test with one low-risk command (e.g. a category), then a supplier edit, then a stock add with `expected_quantity`.
5. **PC2 / development**: run `npm run db:migrate` against `giga_chemist` before starting this branch there (the code reads 017's columns).
6. Shop 2 (later phase): register with its own `SHOP_ID` / token / device id; credential sync off until its dry-run passes.

## 11. Rollback

* **Vercel**: redeploy the previous production build — queued commands stay in the cloud; nothing is lost.
* **Shop**: the updater's automatic rollback (previous commit + verified backup) applies; 017 is additive, so the previous release
  runs on a 017 database (it ignores the new columns). Do not drop 017 columns: voided / remote rows rely on them.
* **Cloud 006**: leave in place (additive). To disable full-write without a redeploy: Security → *Remote changes OFF* (per shop).
  To restore the plain 001 event function in an emergency: `ALTER FUNCTION giga_cloud.apply_event_core(uuid, jsonb) RENAME TO apply_event`
  after dropping the wrapper — only if no shop on this release is syncing (it would emit types the core function rejects).
* Pending commands can be neutralised by setting them `REJECTED` with an error text (owner SQL) — never deleted.

## 12. Tests

`npm run test:full-write` — real Shop 1 worker on `giga_chemist_dev`, cloud emulator with cloud SQL 001–006, online API,
synthetic Shop 2 (registered + fed through the real ingestion RPC with its own token; no shop process, so its commands stay PENDING).
Covers the 54-item matrix: auth/roles/403, concurrent shop isolation, every module's commands, stale `expected_quantity` rejection,
no lost cashier movement, idempotency, duplicate delivery, offline PENDING, wrong-shop consumption, audit completeness and secret scans.
Shop-switch cache isolation in the browser is covered by `npm run test:pos-cache`.

---

## 13. History module (sales + supply), read only

Navigation: **Finance → History** (online) / **History** (shop app), tabs *Sales* and *Supply / Purchases*.
Global dashboard: *View All Sales*, *View Supply History*; a shop dashboard shows *Recent sales / supplies* with *View full history*.

* **Access**: Admin and Manager (`sales.view_all`, `stock.receive`); cashiers get 403 (their own Sales History is unchanged).
  Cost / profit only for Administrators. GLOBAL_ADMIN: one shop, or **All Shops** (Shop column + per-shop contribution);
  shop accounts: own shop only (403 otherwise).
* **Scope is decided by the server**: the request's authorized shop, or — only for a Global Administrator in All Shops — every
  active shop. Every relation in `server/db/history.ts` is filtered to that list; ids from another shop answer 404.
* **One implementation, two sources**: the shop server reads its own PostgreSQL; the online API reads `giga_cloud` for the
  authorized shops. Same filters, paging and totals (`server/http/historyRoutes.ts` serves both).
* **Large histories**: filters, counts, summaries and paging run in PostgreSQL; pages of 25 / 50 / 100 (anything else is clamped).
  Measured on the real dataset (135,819 sales / 226,402 lines): one month 21 ms, receipt 0.3 s, medicine search 0.4–0.6 s,
  sale detail 17 ms, all-time totals ~1.1 s (the screen defaults to *This month*). CSV export uses the same filters (max 50,000 rows).
* **Filters**: date presets / range, shop (All Shops), cashier, customer, payment method, status, retail / wholesale, receipt / sale
  number, medicine name / barcode, free search; supplies: supplier, medicine, batch, invoice, order number, payment status, status.
* **Details**: sale → items (batch, qty, unit price, mode, discount, total, cost/profit for Admin), payments, totals, returns,
  void, audit. Purchase → lines (batch, expiry, qty, buy price, line total; current selling prices labelled as *current*), stock movements.
* **Immutability**: no Edit. `PUT/PATCH/DELETE /api/sales/:id` → 405 (online 409), `DELETE /api/purchases/:id` → 405,
  any write under `/api/history/*` → 405. Corrections: void (Admin; online as a `SALE_VOID` command), returns workflow, pending-purchase cancel.
* **Reprint**: `POST /api/history/sales/:id/reprint` re-renders the stored sale stamped *REPRINT — COPY*; audited
  (`RECEIPT_REPRINTED` at the shop, `online_audit` online); creates nothing.
* **Indexes** (checked first; additive): local **018** `purchases(received_date)`, `purchases(supplier_id)`, `sale_items(medicine_id)`,
  `purchase_items(medicine_id)` (sales already indexed); cloud **007** `(shop_id, …)` indexes on sales cashier/status/receipt,
  sale_items medicine, payments, returns, purchases date/supplier, purchase_items, movements reference, audit entity.
  Deploy cloud 007 with 006 (indexes only; safe at any time).
