# GIGA CHEMIST — Deep Audit (local mode)

**Date:** 2026-10-04 · **Scope:** `B:\GIGA-CHEMIST-POS` (PC2 development) against `giga_chemist_dev` · `APP_MODE=local`, `SYNC_ENABLED=false`
**Method:** read of the actual code and schema, live database queries, the automated integration suite (`npm run test:integration`, 215 checks), and an API runtime sweep of the running server. Browser DevTools (Console/Network) were **not** inspected by automation in this pass — see §8.

Severity: **CRITICAL** (data loss / false success / security breach in local production) · **HIGH** (must fix before production use) · **MEDIUM** · **LOW** · **INFO**.

---

## 1. Summary

| Severity | Open | Notes |
|---|---|---|
| CRITICAL | **0** | All critical issues found were fixed in this pass (list in §3). |
| HIGH | **4** | H1 known-credential dev accounts · H2 reports from cache · H3 plain HTTP + open CORS on LAN · H4 untested migration run against live DB |
| MEDIUM | 7 | §5 |
| LOW / INFO | 10 | §6 |

## 2. Architecture (as built)

```
React 19 / TypeScript (Vite PWA)  ──apiFetch (Bearer JWT, X-Device-Id)──►  Express (server.ts, server/routes.ts)
        │                                                                          │
   Dexie (IndexedDB) cache  ◄── hydration / committed results only ───   server/db/*.ts  ──►  PostgreSQL 18 (authoritative)
```

* **Single request path:** `src/services/http.ts` `apiFetch` attaches the server JWT and device id, refuses expired tokens, never parses HTML as JSON, and turns any 401 into one logout event. No component sends `x-user-*` headers.
* **Server authority:** every business write is one PostgreSQL transaction in `server/db/*.ts`; errors propagate (no JSON / in-memory / Supabase fallback in local mode). `server/db.ts` (legacy JSON store) and `data/` are kept on disk but **imported by nothing**.
* **Dexie:** cache only. Written after a server commit (`stockCache.refreshCacheAfterCommit`) or by hydration (`syncEngine.syncFromLocalApiToDexie`). `runSync` no longer pushes anything; legacy queued items are marked `failed` (never `synced`, never replayed).

## 3. Fixed in this stabilization (verified by tests)

| Area | Was | Now |
|---|---|---|
| Auth | identifier-only offline login, built-in plaintext PIN users, fake tokens, role quick-switch, hard-coded JWT secret, x-user-role headers | server-only login (PBKDF2), mandatory JWT_SECRET (≥32), per-request DB re-check of user/role/active, constant-time signature check |
| Users | in-memory store, `usr-*` ids, default `Giga@2026`/`1234`, silent PG failures | PostgreSQL only, UUIDs, no defaults, min 8 chars, last-Admin protection, audited |
| Checkout | Dexie-first, browser prices/totals, `sal-*` ids, success on PG failure, `GREATEST(0,…)` overselling | one PG transaction, server prices (retail/wholesale), FEFO on unexpired active batches, integer-cent maths, idempotency key, sequence receipts, payments + movements + audit atomic |
| Wholesale | none (API even returned retail as wholesale) | nullable `wholesale_price`, `price_mode` per sale & line (history untouched), explicit retail-fallback confirmation |
| Returns | Dexie-only, `ret-*` ids, clamped over-returns | server transaction, refund = discounted amount paid, over-return 409, expired/recalled restock 400 |
| Void | re-ran checkout | explicit reversal: sale kept + `voided`, stock restored, reverse movements, payments kept, legacy/returned sales protected |
| Purchases | frontend POST to non-existent route, Dexie-only, `pur-`/`bat-` ids | `POST /api/purchases`, batch create-or-increment, duplicate-invoice and expired-goods protection |
| Expenses / Suppliers / Customers | Dexie-only or silent JSON success, non-UUID ids | server-first, UUIDs, validation, audit |
| Devices | in-memory map | persisted in `devices`, FK row ensured inside each transaction, malformed ids → `SERVER` |
| Settings | queried non-existent `key/value` columns, always failed silently | real column schema, audited |
| Audit | double-encoded JSON, swallowed failures | JSONB objects, failures propagate |
| Dexie | "safe stock merge" kept browser stock over PostgreSQL | removed; cache refreshed from confirmed server state |
| Daily summary | 401 (spoof headers), Dexie fallback, UTC day | PG aggregation, Africa/Nairobi day, Cashier own-scope, voids excluded, refunds separate |
| API errors | unknown `/api` and malformed JSON returned SPA HTML | JSON 404 / JSON 400 |
| Barcodes | NULL branch defeated unique constraint | app check + migration 010 unique normalized index |
| Seed script | created Admin with published password `admin123`/PIN `1234` | creates nothing; points to `create-admin` |

## 4. Open HIGH findings

### H1 — Two active accounts use credentials that were published in source code
* **Module:** PostgreSQL `users` — `admin@gigachemist.co.ke` (ADMIN), `cashier@gigachemist.co.ke` (CASHIER).
* **Root cause:** their password/PIN hashes are the ones that were hard-coded in the former `server/db/users.ts` (visible in git history); the old test script verified PIN `1234` against them.
* **Impact:** anyone with the repository history can log in as Administrator.
* **Correction:** Admin → Users → reset password **and** PIN for both accounts (or deactivate them) before any production use. Do the same on the target PC after migration. Not changed automatically because they may be the accounts currently used for testing.

### H2 — Reports are calculated from the browser cache
* **Module:** `src/components/reports/ReportsDashboard.tsx` (reads `db.sales`, `db.customer_returns`, `db.expenses`).
* **Root cause:** reports predate the server-authoritative design; the cache holds only the latest 500 sales.
* **Impact:** period reports (week/month/custom) can under-report. Daily summary and Dashboard "today" figures are already server-side and correct.
* **Correction:** add server report endpoints (PostgreSQL aggregation by Africa/Nairobi date range) and switch the screen to them — this is the planned "Report filters" stage.

### H3 — LAN exposure without transport security
* **Module:** `server.ts` (listens on `0.0.0.0`, `Access-Control-Allow-Origin: *`, plain HTTP).
* **Impact:** on a shared network, login passwords and bearer tokens travel unencrypted; any LAN device can reach the API.
* **Correction:** for single-PC installs bind to `127.0.0.1`; for multi-terminal installs restrict CORS to the POS origin, firewall port 3000 to known terminals, and/or terminate TLS (reverse proxy). Decide during installer work.

### H4 — Migrations have only been run on a copy of the data
* **Module:** `migrations/001–010`, `npm run db:migrate`.
* **Root cause:** the live DB (like dev) was built from a dump and has no `schema_migrations`; the first run applies 001–010. Verified idempotent on `giga_chemist_dev`, but the live schema may differ.
* **Correction:** back up the live DB, restore it to a scratch database on the target PC, run `db:migrate` + `db:check` there first, then on the real DB. 010 skips itself (NOTICE) if duplicate barcodes exist.

## 5. MEDIUM

1. **Sales History UI lists only the cached latest 500 sales** (`SalesHistory.tsx` reads Dexie). Data is complete in PostgreSQL; add server paging/search to the screen.
2. **PIN login** (4–6 digits) is accepted as an alternative to the password; with the 20/min/IP limiter this is brute-forceable over hours. Consider PIN only for quick re-unlock or longer PINs + lockout.
3. **Cashiers may process refunds on their own sales without Admin approval** (server allows `returns.create` for CASHIER, own sales only). Confirm business rule.
4. **No offline selling:** if the local server/PostgreSQL is down, checkout fails by design (no queued sales). Correct for integrity; needs operational guidance (auto-start service) in the installer stage.
5. **Token in `localStorage`** (XSS would expose it). Low XSS surface (React escaping), but consider httpOnly cookie when TLS is added.
6. **Legacy accounts with non-PBKDF2 hashes** (`admin@gmail.com` active + 4 inactive) cannot log in. Reset their passwords from Users if they are needed.
7. **Service-worker caching:** after an upgrade terminals may keep the old bundle until a hard refresh. Add an update prompt in the PWA layer.

## 6. LOW / INFO

1. `trg_update_medicine_current_stock` exists in the dev DB (from the dump) but in no migration; the app reconciles stock explicitly with the same rule, so a migrations-only DB still works.
2. Migrations 001–003 describe some columns that differ from the real dump (e.g. `users.salt`); harmless because they are `IF NOT EXISTS`.
3. `MANAGER` remains in the permission matrix; no MANAGER users exist and new roles are limited to ADMIN/CASHIER.
4. Admin discount limit is 100% (Cashier 10%) — business decision.
5. `GET /api/settings` is public (pharmacy name/address for landing page) — non-sensitive.
6. Remaining cloud code (not used in local mode): `src/lib/supabase.ts`, `syncFromSupabaseToDexie`, `server/db/client.ts` Supabase proxy, `server/db/categories.ts` non-local branch, `scripts/*supabase*`. Review in the cloud stage.
7. Remaining JSON code: `server/db.ts` + `data/` (unused, kept for review).
8. Vite chunk-size warning (bundle > 500 kB) — performance only.
9. Device ids from older browsers keep their `POS-KITALE-01-XXXX` form (kept so history stays linked); new terminals get `POS-<uuid>`.
10. Inactive test fixtures `ZZ ITEST …` (5 medicines, barcode `ITEST-*`, stock 0) and inactive `itest-*@gigachemist.local` users remain for the integration suite; hidden from POS and from the default Medicines list. The suite deletes its own sales/returns/purchases/expenses/suppliers/customers after each run.

## 7. Module review (status)

| Module | Status | Evidence |
|---|---|---|
| Authentication / RBAC | PASS | AUTH 17 + route sweep (401/403/200 per role) |
| Users | PASS | USERS 32 incl. restart persistence |
| Categories | PASS | real 580 categories, POS dropdown + Medicines filter |
| Medicines | PASS | create/edit, stock never edited by form, duplicate barcode 409 |
| Retail / Wholesale price | PASS | WHOLESALE 34 |
| Stock / Physical count / Expiry | PASS | STOCK regression 0→1→50→60→50→0, expiry 2029-01-31; post-reset live check |
| Sales / Discount / Cash / M-Pesa / Split | PASS | SALES & FAILURES sections |
| Daily summary | PASS | controlled +1900 / +2000 / +3900 / +3, void −2000 |
| Returns / Voids | PASS | partial, full, discounted, over-return, duplicate, double void |
| Purchases / Expenses / Suppliers / Customers | PASS | sections + restart persistence |
| Devices / Audit / Movements | PASS | device FK, JSONB audit, movement quantities |
| Dexie consistency | PASS (code review) | all writes post-commit; stock-merge removed; legacy queue → failed |
| Reports | **H2** | cache-based |
| Offline operation | by design: requires local server | §5.4 |

## 8. Not verified automatically

* Browser DevTools Console/Network inspection (two Chrome profiles are connected to the automation; a manual check is part of acceptance).
* Printing to a physical thermal printer.

## 9. Remaining work before cloud sync / Windows installer

1. Resolve **H1** (rotate known credentials) and run the full manual acceptance test.
2. Rehearse **H4** (migration on a restored copy of the live DB) — then rebuild stock with Physical Stock Count.
3. **H2** server-side reports; **M1** server-paged Sales History.
4. Decide **H3** network posture (bind/CORS/TLS) — feeds the installer design.
5. Installer/autostart: Windows service for `server.ts`, PostgreSQL service dependency, backup schedule (`backup-local-db.bat`), `JWT_SECRET` generation at install time, PWA update prompt.
6. Only then: cloud synchronization design (offline queue semantics must respect server authority).
