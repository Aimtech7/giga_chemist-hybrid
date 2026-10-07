# GIGA CHEMIST — Hybrid Online/Offline Architecture

Status: implemented and tested on PC2 dev (`giga_chemist_dev`), 2026-10-07. Not yet connected to a real
Supabase project (no credentials are configured); verified against the cloud emulator, which runs the
real cloud SQL.

> **TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA.** Upgrading the pharmacy PC is
> new code + non-destructive migrations on its existing `giga_chemist` database — see
> `GIGA_CHEMIST_TARGET_UPGRADE.md`.

Related: `GIGA_CHEMIST_EMAIL_REPORTS.md` (queued e-mail reports, same offline-first design),
`GIGA_CHEMIST_BACKUP_RESTORE.md`, `GIGA_CHEMIST_PRODUCTION_CHECKLIST.md`. Admin → Settings →
System Health shows PostgreSQL, API, internet (checked by the server), cloud, sync queue, e-mail queue,
backups, disk space, version, shop and device id (`GET /api/admin/health`).

---

## 1. Summary

```
INTERNET AVAILABLE                         INTERNET UNAVAILABLE
Browser → Local Express API                Browser → Local Express API
        → Local PostgreSQL (authoritative)         → Local PostgreSQL (authoritative)
        → sync_events outbox (same tx)             → sync_events outbox (same tx, stays PENDING)
        → background worker → Cloud RPC
```

* **Local PostgreSQL is the shop's source of truth.** Checkout, payments, receipts, returns, purchases,
  stock and login never call the cloud and never wait for it.
* **Every business write records a durable outbox event in the same PostgreSQL transaction.** A sale and
  its sync event commit together or roll back together.
* **A background worker on the local server** delivers events to the cloud when it is reachable, with
  retries, backoff and idempotency. A cloud failure can never roll back a completed sale.
* **The browser never talks to the cloud.** Dexie is only a cache, hydrated from the local server.
* **Stock is synchronized as immutable movements (deltas), never as `current_stock = X`.**

---

## 2. Audit of the cloud code that existed before this change

| Item | Finding | Action |
|---|---|---|
| `server/db/client.ts` `getAppMode()` | Supports `local / hybrid / cloud`, auto-detects when `APP_MODE` is empty. | Kept. |
| `server/db/client.ts` `supabaseAdmin` | A Proxy that always throws; never instantiated. `isSupabaseConfigured` only feeds `/api/health.cloud_ready`. | Kept (inert). Not used by sync. |
| `server/db/categories.ts` | Fell back to `supabaseAdmin` on a PostgreSQL error outside local mode. | **Removed fallback**: PostgreSQL only. |
| `sync_events` table (migration 003) | Existed, **empty**, never written by the API; FK `device_id → devices`, NOT NULL, status default `synced`. | **Extended in place** (migration 013). |
| `SYNC_ENABLED`, `DEVICE_ID`, `SYNC_INTERVAL_SECONDS` | Present in `.env`, not read by any code. | Now read by `server/sync/config.ts`. |
| `POST /api/sync` | Browser cache refresh; refuses browser-queued offline writes (409). | Kept unchanged. |
| `src/services/syncEngine.ts` | Browser cache refresh from the local API; legacy Dexie queues are marked failed, never replayed. `syncFromSupabaseToDexie` reads Supabase directly from the browser but is **not called anywhere**. | Kept; `navigator.onLine` no longer blocks local refresh. `syncFromSupabaseToDexie` is obsolete (unused). |
| `src/lib/supabase.ts` | Browser anon client, `null` unless `VITE_SUPABASE_*` set. | Not used by hybrid sync. |
| `scripts/setup-supabase-schema.ts`, `load-supabase-data.ts`, `migrate-json-to-supabase.ts`, `inspect-supabase.ts`, `verify-supabase-connection.ts` | Old approach: clone the local schema (`schema.sql`) into Supabase and bulk-load it. | Left untouched; **superseded** by `cloud/supabase/migrations/001_giga_cloud_hybrid.sql`. Do not run them against the hybrid project. |
| `branches` | One row `MAIN` (`00000000-0000-0000-0000-000000000001`). | Used as Shop 1's branch. |
| `devices` | 13 rows (terminals, `SERVER`, test devices). | Unchanged. |
| Service-role usage | None at runtime. | Sync uses the anon key + a per-shop token (least privilege); service role optional, backend only. |

---

## 3. Modes

| `APP_MODE` | `SYNC_ENABLED` | Behaviour |
|---|---|---|
| `local` | any | PostgreSQL only. No outbox rows, no worker, no cloud dependency. |
| `hybrid` | `false` | PostgreSQL authoritative **and** outbox rows are recorded. Nothing is sent. (Events wait.) |
| `hybrid` | `true` | As above, plus the worker delivers events and pulls cloud commands. |

Outbox rows are written only in hybrid mode. Changes made while running in `local` mode are **not**
queued for the cloud (see Known limitations).

---

## 4. Shop and device identity

* `shop_identity` (single row, migration 013) holds `shop_id` (UUID), `shop_code` (`SHOP1`),
  `shop_name`, `branch_id` (MAIN). It is generated **once** in PostgreSQL, so it survives restart,
  update, reboot and internet outage, and moves with database backups. It is never derived from
  hostname or IP.
* Shop 1 on PC2 dev: `SHOP1  c2a176c8-a50f-456f-a370-225c11d2e32f`. **The pharmacy PC gets its own id**
  when migration 013 runs on `giga_chemist` (proved in the rehearsal); that target id is the real
  Shop 1 for cloud registration and `.env.online`. Never copy the dev id to the target.
* `SHOP_ID` in `.env` is optional. If set and different from the stored id:
  * no event synced yet → the env id is adopted (stored row + unsynced events updated);
  * events already synced → **sync halts** with an explicit error (identity never changes silently).
* `DEVICE_ID` (`.env`) identifies the server/terminal in status output. Each event also records the
  originating terminal (`X-Device-Id`, resolved through `devices`).
* Shop 2: register another shop id + token in the cloud; nothing in the local code assumes one shop.

---

## 5. Outbox (`sync_events`)

Columns: `id` (event UUID), `seq` (BIGSERIAL, local order), `idempotency_key`
(`gc:<shop_id>:<event_id>`, unique), `shop_id`, `device_id`, `event_type`, `operation`, `entity_type`,
`entity_id`, `payload` (JSONB), `actor_user_id`, `actor_name`, `business_ref` (receipt / invoice),
`status`, `attempt_count`, `last_attempt_at`, `next_attempt_at`, `synced_at`, `last_error`,
`locked_at`, `locked_by`, `created_at`.

States: `PENDING → PROCESSING → SYNCED`; `FAILED` only when the cloud explicitly rejects the event as
invalid. Network failures, DNS failures, timeouts, HTTP 5xx/429 **never** produce `FAILED`.

### Where events are written (inside the business transaction, before COMMIT)

| Operation | Event | Payload `data` (+ `movements`, `batches`, `audit` collected from the same tx) |
|---|---|---|
| Checkout (Cash, M-Pesa, Mixed…) | `SALE_COMPLETED` | sale row, sale_items, payments, customer |
| Void (Admin) | `SALE_VOIDED` | sale row (status voided), customer |
| Return request | `RETURN_REQUESTED` | return row |
| Return approval (Admin) | `RETURN_APPROVED` | return row, sale row (new status), customer |
| Return rejection (Admin) | `RETURN_REJECTED` | return row |
| Purchase receipt | `PURCHASE_RECEIVED` | purchase, purchase_items, supplier |
| Set / add / remove stock | `STOCK_SET` / `STOCK_ADDED` / `STOCK_REMOVED` | ids, reason, notes |
| Physical stock count | `PHYSICAL_COUNT` | medicine id, notes |
| Batch expiry edit | `BATCH_EXPIRY_CHANGED` | batch row |
| Medicine create / edit / price | `MEDICINE_CREATED` / `MEDICINE_UPDATED` / `MEDICINE_PRICE_CHANGED` | medicine metadata (**no `current_stock`**) |
| Supplier / customer upsert | `SUPPLIER_UPSERTED` / `CUSTOMER_UPSERTED` | row |
| Expense | `EXPENSE_RECORDED` | row |
| Settings | `SETTINGS_UPDATED` | settings row |
| User create / edit / role / status | `USER_UPSERTED` | public profile — **password/PIN hashes are stripped** |
| `npm run sync:bootstrap` | `MEDICINE_BASELINE` | medicine + batch quantities (cloud stock starting point) |

Password changes and resets are not synced (credentials never leave the shop).

`server/sync/collector.ts` remembers every `inventory_movements` and audit row written on the
transaction's client; `enqueueSyncEvent()` attaches them to the event. `withTransaction()` resets the
collector at BEGIN and release, so a rolled-back transaction cannot leak rows into a later event.
A rejected checkout leaves **no** outbox row (tested).

---

## 6. Stock conflict strategy

* Each movement carries `id`, `medicine_id`, `batch_id`, `delta`, `previous_quantity`,
  `new_quantity`, `movement_type`, `reason`, `reference_id` (receipt / order), `user_id`,
  `device_id`, `occurred_at`; the event carries `shop_id`, `event_id` and the actor.
* Cloud: `giga_cloud.inventory_movements` is keyed by `(shop_id, movement_id)` — a movement is inserted
  once; **only a newly inserted movement changes cloud stock**.
* Cloud stock per batch (`giga_cloud.stock_on_hand`) = `baseline_quantity` (from `MEDICINE_BASELINE`)
  + `SUM(delta)` of movements with a later local sequence. Ordering-independent and idempotent.
* `last_reported_quantity` (the shop's `new_quantity`) is kept only to flag `drift_detected`; it is
  never used to overwrite anything.
* Inbound: **no command can write stock** (`current_stock` in a command payload → REJECTED; tested).

---

## 7. Cloud (Supabase) — `cloud/supabase/migrations/001_giga_cloud_hybrid.sql`

Purpose: centralized multi-shop reporting + a control channel. Not a clone of the shop database.

* Private schema `giga_cloud` (no table access for `anon` / `authenticated`): `shops`, `devices`,
  `processed_events` (idempotency registry + immutable event log), `rejected_events`, `categories`
  (central), and per-shop reporting copies `medicines`, `medicine_batches`, `inventory_movements`,
  `stock_levels` (+ view `stock_on_hand`), `sales`, `sale_items`, `payments`, `returns`, `purchases`,
  `purchase_items`, `expenses`, `suppliers`, `customers`, `users` (public profile), `shop_settings`,
  `audit_events`, `commands`.
* Only four RPC entry points are executable by API keys, all `SECURITY DEFINER` and each authenticates
  `(shop_id, shop token)` itself: `gc_ping`, `gc_ingest_events`, `gc_pull_commands`, `gc_ack_command`.
* Owner-only helpers (SQL editor): `giga_cloud.register_shop(...)`, `giga_cloud.issue_command(...)`.
* Re-runnable (applied twice in testing).

### Idempotency (cloud)

`gc_ingest_events` processes each event in its own sub-transaction: it inserts the
`idempotency_key` into `processed_events` first (`ON CONFLICT DO NOTHING`); if the key exists the
event is answered `DUPLICATE` and nothing is applied. A concurrent retry of the same key waits on the
uncommitted key row and then sees `DUPLICATE`. Business tables additionally use primary keys with
`ON CONFLICT DO NOTHING` (immutable rows: sale items, payments, movements, purchases, expenses,
audit) or a **sequence guard** (`source_seq`: only a newer local event updates a mutable row: sale
status, return status, medicine metadata, supplier, customer, user, settings). One invalid event is
`REJECTED` (logged in `rejected_events`) without blocking the rest of the batch.

---

## 8. Worker (`server/sync/worker.ts`)

* Starts after the HTTP server is listening; **startup never depends on the cloud**.
* **One worker per database**: a session-level PostgreSQL advisory lock elects the leader on a
  dedicated connection; another process stays idle.
* On acquiring leadership: rows left in `PROCESSING` by a crash return to `PENDING`.
* Each cycle (default every 30 s):
  1. re-acknowledge applied commands whose ack was lost;
  2. claim due events: `UPDATE … WHERE id IN (SELECT … status='PENDING' AND next_attempt_at<=now()
     ORDER BY seq LIMIT n FOR UPDATE SKIP LOCKED)` — a short transaction; **no DB connection is held
     while waiting on the network**;
  3. send the batch (`gc_ingest_events`), mark `SYNCED` / `FAILED` (explicit rejection) / back to
     `PENDING` with backoff;
  4. pull commands (`gc_pull_commands`), apply each once, acknowledge (`gc_ack_command`).
* **Per-event backoff**: `min(SYNC_MAX_BACKOFF_SECONDS, 5 s × 2^(attempt-1))` with ±20 % jitter.
* **Worker backoff** after consecutive failures: `min(max backoff, interval × 2^(n-1))`, so an offline
  shop makes at most one probe per interval/backoff — no rapid retry loop.
* **Reconnect**: the first successful contact after the cloud was unreachable makes backed-off events
  due immediately and pushes them in the same cycle (no restart needed).
* State (`last_success_at`, `last_error`, `last_contact_at`) persists in `sync_state`.
* HTTP: `fetch` with `AbortController` timeout (`SYNC_HTTP_TIMEOUT_MS`, default 10 s).

---

## 9. Inbound commands (cloud → shop)

Supported: `PRICE_UPDATE` (selling / wholesale / min selling / purchase price), `MEDICINE_METADATA_UPDATE`
(name, generic/brand name, manufacturer, description, form, strength, unit, prescription flag, category),
`CATEGORY_UPSERT`, `SETTINGS_UPDATE` (name, tagline, address, phone, email, receipt header/footer).

Per command, in **one** local transaction: validate shape and shop id → advisory lock on the key →
check `sync_inbound_commands` (by `command_id` **or** `idempotency_key`) → apply → write the
`sync_inbound_commands` row → audit (`CLOUD_COMMAND_APPLIED` / `CLOUD_COMMAND_REJECTED`) → COMMIT →
acknowledge. A redelivered command (lost ack) is answered from the recorded outcome and **not applied
again** (tested: delivered 2+ times, applied/audited once). Unknown types, unknown fields
(e.g. `current_stock`), other shops' commands → `REJECTED`. Database errors are not recorded; the
command is retried on the next cycle.

A price/metadata change applied by a command emits its own outbound event, so the cloud copy confirms
the result.

---

## 10. Conflict rules

| Data | Rule |
|---|---|
| Stock | Local event ledger wins. Only movements (deltas) sync; no last-write-wins snapshot either way. |
| Sales | Immutable after completion; only void / return workflows change status (sequence-guarded). |
| Historical sale price | Never replaced: `sale_items.unit_price` is a snapshot; commands change only the current price (tested). |
| Medicine metadata | Cloud may update centrally via `MEDICINE_METADATA_UPDATE`. |
| Price | Central `PRICE_UPDATE` may change the current local price. |
| Local unsynced changes | Never silently overwritten: if the medicine (or settings) has an outbox event not yet `SYNCED`, the command is **REJECTED with `CONFLICT`** and must be re-issued after the shop syncs (tested). |
| Same-entity ordering | Cloud applies an update only when its local `seq` is newer than the stored `source_seq`. |

---

## 11. Security

* Cloud access only from the local server (`server/sync/cloudClient.ts`); the browser receives no
  cloud URL with credentials, no key, no token.
* TLS required: `SUPABASE_URL` must be `https://` (plain `http` accepted only for a loopback emulator).
* Least privilege: the anon key reaches PostgREST; the RPCs require the per-shop `SYNC_SHOP_TOKEN`
  (stored in the cloud only as a SHA-256 hash). The service role key is optional and backend-only.
* Unknown / inactive shop or wrong token → HTTP 403; an event whose `shop_id` differs from the
  authenticated shop → REJECTED; batch size limited to 200.
* Keys and tokens are never logged or returned (tested against the server log and status responses).
* `GET /api/sync/status` requires login; Cashiers get a summary only; `POST /api/sync/now` and
  `POST /api/sync/retry-failed` are Admin-only.
* User events never contain password/PIN hashes (tested).

---

## 12. Environment variables (server)

| Variable | Meaning |
|---|---|
| `APP_MODE` | `local` or `hybrid`. |
| `SYNC_ENABLED` | `true` starts the worker (hybrid only). |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | Gateway key (preferred). |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional, backend only; used only if the anon key is empty. |
| `SYNC_SHOP_TOKEN` | Per-shop secret, ≥ 32 chars, registered with `giga_cloud.register_shop`. |
| `SHOP_ID` | Optional; adopt a cloud-assigned id before the first sync. |
| `DEVICE_ID` | Server/terminal id for status. |
| `SYNC_INTERVAL_SECONDS` (30), `SYNC_BATCH_SIZE` (50), `SYNC_HTTP_TIMEOUT_MS` (10000), `SYNC_MAX_BACKOFF_SECONDS` (120) | Tuning. |

`.env.example` contains placeholders only. `.env` is git-ignored.

---

## 13. Status API and UI

`GET /api/sync/status` (Admin) returns `mode`, `enabled`, `shop_id`, `shop_code`, `branch_id`,
`device_id`, `counts {pending, processing, synced, failed, retrying, oldest_pending_at}`,
`inbound_commands`, `last_sync`, `last_contact`, `last_error`, `cloud {configured, config_error, host,
key_type, reachable}`, `cloud_reachable`, `worker {...}`, `local_database {connected}`.

Header indicator (`SyncIndicator`): `POS SERVER UNREACHABLE` / `DATABASE UNAVAILABLE` (local problems —
selling is affected) are separate from `LOCAL`, `ONLINE — SYNCED`, `ONLINE — SYNCING (n)`,
`OFFLINE — n PENDING`, `SYNC ERROR — n PENDING` (cloud only — selling is not affected). Admins can open
details (counts, last sync, last error, shop ID, device ID) and use **Sync Now** (wakes the worker; it
still only claims due events, rate-limited) and **Retry failed**. The login page shows POS-server
reachability, not `navigator.onLine`. `navigator.onLine` no longer blocks loading data from the local
server.

---

## 14. Deployment (Shop 1)

1. Back up the database. `npm run db:migrate` (applies 013). `npm run db:check`.
2. In the Supabase SQL editor, run `cloud/supabase/migrations/001_giga_cloud_hybrid.sql`.
3. Generate a token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Register the shop (SQL editor, as owner), using the id printed by `npm run db:check`:
   `SELECT giga_cloud.register_shop('<shop_id>', 'SHOP1', 'GIGA CHEMIST - MAIN', '<token>');`
5. `.env`: `APP_MODE=hybrid`, `SYNC_ENABLED=true`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SYNC_SHOP_TOKEN`. Restart the POS server.
6. Optional, once: `npm run sync:bootstrap -- --confirm` (queues a stock/catalog baseline per medicine;
   2,187 events; delivered by the worker in the background).
7. Check the indicator / `GET /api/sync/status`.

Issuing a central price change (SQL editor):
`SELECT giga_cloud.issue_command('<shop_id>', 'PRICE_UPDATE', '{"medicine_id":"<uuid>","selling_price":120}', '<unique-key>', 'HQ');`

---

## 15. Testing

* `npm run test:hybrid` — 108 checks. Real server process in hybrid mode + cloud emulator
  (`scripts/cloud-emulator.ts`) on a throwaway `giga_chemist_cloud_test` database running the real
  cloud SQL. Outages are real network conditions for the server: emulator stopped (connection refused),
  hanging (timeout), HTTP 503, or committing and dropping the response; plus an unresolvable DNS name.
  Covers TEST 1–12 of the specification, security, baseline and a final no-duplicates/ledger check.
  Guarded: refuses to run on another database, when real events are pending, or when another server
  holds the worker lock; removes test outbox rows and restores `sync_state` afterwards.
* `npm run test:integration` — existing suite (forced `APP_MODE=local`); `ITEST_MODE=hybrid npm run
  test:integration` runs the same suite with the outbox enabled.

### Manual offline test

* Cloud emulator on PC2 (no real Supabase yet): `npm run cloud:emulator` with `SUPABASE_URL=http://127.0.0.1:54321`.
  Stop it (Ctrl+C) = cloud outage; start it = restoration. **Unplugging the internet does not affect a
  localhost emulator** — use a real Supabase project for the physical-disconnect test.
* With a real Supabase project: disconnect the internet; login, search, sell (Cash and M-Pesa),
  receipt, Sales History, return request (Cashier), approval (Admin), physical count, purchase all work;
  the indicator shows `OFFLINE — n PENDING`. Reconnect: within one interval (≤ 30 s, or ≤ 2 min if the
  worker had backed off; immediately with **Sync Now**) events become `SYNCED`.

### How to restore sync

* Cloud down / internet out: nothing to do — it resumes automatically.
* `SYNC ERROR` with `FAILED > 0`: the cloud rejected events (see `last_error` / `rejected_events`); fix
  the cause, then **Retry failed** (keeps idempotency keys).
* 403 authentication failed: check `SYNC_SHOP_TOKEN` / shop registration.
* Halted (identity mismatch): correct `SHOP_ID` in `.env`.

---

## 16. Known limitations

* No real Supabase project is configured on PC2; real-cloud TLS/latency has not been exercised.
* Events marked `SYNCED` while pointed at the **emulator** are not re-sent when `.env` is switched to a
  real Supabase project. For a clean start on the real project (safe — the cloud dedupes by key):
  `UPDATE sync_events SET status='PENDING', attempt_count=0, synced_at=NULL, last_error=NULL, next_attempt_at=now();`
  and `DELETE FROM sync_state;` (also needed before `SHOP_ID` can be adopted).
* Historical data (135,819 sales before hybrid mode) is not uploaded; cloud reporting starts at the
  switch to hybrid. Cloud stock needs `npm run sync:bootstrap` to have a baseline (without it cloud
  stock is the net change since sync began).
* Changes made while `APP_MODE=local` are not queued for the cloud.
* `SYNCED` outbox rows are kept indefinitely (audit trail); pruning is not implemented.
* Commands are pulled every interval (no push/realtime).
* Inbound settings/metadata changes are accepted only when no local change of the same entity is
  unsynced; otherwise they are rejected (by design) and must be re-issued.
* Older Supabase scripts in `scripts/` (schema clone / bulk load) are obsolete for hybrid mode.
