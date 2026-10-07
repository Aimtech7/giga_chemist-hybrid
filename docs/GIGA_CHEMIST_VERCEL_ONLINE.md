# GIGA CHEMIST — Vercel Online App (same-origin API)

Status 2026-10-07: implemented and tested locally (81 checks against a real synced cloud copy, using
the exact Vercel function bundle). Production at https://gigachem.vercel.app still needs the cloud
setup and Vercel environment variables listed in §6 before any data can be shown.

## 1. Why Vercel was frontend-only

* `vercel.json` built `dist/` and rewrote **every** path, including `/api/*`, to `index.html`.
* There was no `api/` function: the API existed only as `server.ts`, a long-running Express process that
  calls `listen()`, starts Vite in dev, runs background workers and needs a local PostgreSQL.
* Result: `https://gigachem.vercel.app/api/health` returned the HTML page (verified before this change).

## 2. Architecture

```
https://gigachem.vercel.app                         http://<pharmacy-pc>:3000  (unchanged)
  ├── React/Vite frontend (dist/)                     ├── frontend
  └── /api/*  -> api/index.js (Vercel function)       └── /api/*  -> server/routes.ts (local Express)
                  APP_MODE=online, READ-ONLY                         APP_MODE=local | hybrid
                  -> Supabase PostgreSQL                             -> local PostgreSQL (authoritative)
                     giga_cloud (filled by shop sync)                -> outbox -> Supabase (hybrid)
                     via giga_online views
```

| Mode | Where | Data | Writes | Workers |
|---|---|---|---|---|
| `local` | pharmacy PC | local PostgreSQL | yes | backups / email if enabled |
| `hybrid` | pharmacy PC | local PostgreSQL (authoritative) + outbox | yes | sync, backups, email |
| `online` | Vercel (or any host) | Supabase cloud copy | **no — 409 ONLINE_READ_ONLY** | none |

**Why read-only online:** local PostgreSQL is the only authority for stock and sales. A second writer
in the cloud would create conflicting stock and sale histories. Online users can view stock, Sales
History, reports and returns. Selling, stock changes, approvals, purchases and expenses stay on the shop POS.

## 3. How it is built

* `server/online/app.ts` — online router. Each request runs in `BEGIN READ ONLY` with
  `search_path = giga_online` and `giga.shop_id = SHOP_ID`, and calls the **same** read functions as the
  shop server (`getAllSales`, `getSalesReport`, `getAllMedicines`, ...). Totals online therefore use the
  same definitions as on the pharmacy PC (tested: online report = shop report).
* `cloud/supabase/migrations/002_online_api.sql` — `giga_cloud.online_users` and the `giga_online` views
  (local table/column names over the synced `giga_cloud` data, scoped to one shop).
* `server/online/vercel-entry.ts` → bundled by `npm run build:api` into **`api/index.js`** (committed; npm
  packages external). Bundling is needed because Vercel runs each `api/` file as native ESM and the
  project's extensionless imports would not resolve. `npm run build` regenerates it; the online test
  suite fails if the committed bundle is stale.
* `vercel.json` — `/api/(.*)` → the function; only non-API paths fall back to `index.html`; `/api/*` is
  `no-store`. The PWA service worker no longer serves `index.html` for `/api/*` navigations.
* `server.ts` with `APP_MODE=online` serves the same online API + SPA (for testing or another host); it
  never starts the sync, email or backup workers.

## 4. Same-origin API

`src/services/api.ts`: when `VITE_API_URL` is blank the browser calls `/api/...` on the page's own
origin — `http://localhost:3000/api/...` locally, `https://gigachem.vercel.app/api/...` online. No domain
is hard-coded. `VITE_API_URL` remains an optional override.

## 5. Authentication online

* Accounts live in `giga_cloud.online_users` (ADMIN / CASHIER). They are separate from shop staff
  accounts: shop password/PIN hashes are never synced to the cloud.
* Create one: `npm run online:create-user -- --email owner@x --name "Owner" --role ADMIN`
  (connects with `.env.online` DATABASE_URL, or `--print-sql` to paste into the Supabase SQL editor;
  a strong password is generated and shown once unless `ONLINE_USER_PASSWORD` is set).
  A CASHIER can be linked to a shop staff account (`--local-user <uuid>`) to see only own sales.
* Login: `POST /api/auth/login` (same origin), scrypt verification, HS256 JWT signed with the
  **online** `JWT_SECRET`, 12 h expiry, rate-limited. RBAC as on the shop (Cashier: no cost/profit,
  own sales; Admin-only lists are 403).

## 6. Vercel environment variables

Server-side (Production, not exposed to the browser):

| Variable | Value |
|---|---|
| `APP_MODE` | `online` (informational; the function is always online) |
| `DATABASE_URL` | Supabase **Transaction pooler** URL: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `JWT_SECRET` | online secret (≥ 32 chars; `.env.online` has a generated 86-char one) |
| `SHOP_ID` | the registered shop's UUID (the **pharmacy PC's** id after its upgrade) |
| `ALLOWED_ORIGINS` | `https://gigachem.vercel.app` |
| `EMAIL_ENABLED` | `false` |

Frontend: none required (`VITE_API_URL` blank or unset). Do **not** set `VITE_SUPABASE_*`: the browser does
not need them. Not needed on Vercel: `SYNC_SHOP_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
SMTP, backup and sync variables.

## 7. Cloud prerequisites (Supabase SQL editor)

1. **First, lock down the legacy tables:** `cloud/supabase/manual/lockdown_legacy_public_tables.sql`.
   The anon key could read `public.users` including password and PIN hashes. Then change those staff
   passwords and PINs, and rotate the database password.
2. `cloud/supabase/migrations/001_giga_cloud_hybrid.sql`, then `002_online_api.sql`.
3. Register the shop with the pharmacy PC's id: `SELECT giga_cloud.register_shop('<shop_id>', 'SHOP1', 'GIGA CHEMIST - MAIN', '<SYNC_SHOP_TOKEN>');`
4. On the pharmacy PC (hybrid): set the Supabase URL, anon key and shop token, then `npm run sync:bootstrap -- --confirm`.
   This puts the catalog and stock baseline in the cloud; new sales follow automatically.
5. Create online accounts (§5).

## 8. Endpoints online

| Works (read) | Online answer |
|---|---|
| health, auth/login, auth/me, settings, sync/status | yes |
| medicines, categories, batches, customers | yes (Cashier: no purchase price) |
| sales (paging + filters), sales/today-summary, reports/summary | yes (Cashier: own sales via linked staff id) |
| returns | yes |
| users, suppliers, purchases, expenses | Admin |
| inventory/movements, audit, admin/health, email/*, backups/* | 501 `SHOP_SERVER_ONLY` |
| any POST/PUT/PATCH/DELETE except login/devices | 409 `ONLINE_READ_ONLY` |
| unknown `/api/...` | JSON 404 |

## 9. Limits

* Data is what the shop has synced. Without `sync:bootstrap`, only medicines touched since hybrid mode
  started appear. Sales from before hybrid mode (the historical 135k) are not in the cloud.
* Online stock is the cloud ledger (baseline + movements). It shows a medicine's total over all batches,
  whereas the shop excludes expired batches from `current_stock`.
* The POS screens that write (Register, stock, approvals) show the server's read-only message online.
* One shop per deployment (`SHOP_ID`). Multi-shop online views come later.
