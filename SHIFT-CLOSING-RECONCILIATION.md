# GIGA CHEMIST — Cashier Shift Closing + Daily Cash Reconciliation

Branch `feature/shift-closing-reconciliation` (from `main` 10a5cbd, which already contains Full-Write Global Admin + History + Stock History).
Local migration **020_cashier_shifts.sql**, cloud migration **009_cashier_shifts.sql**.

---

## 1. Architecture

```
Cashier ──► Local POS API (Shop 1 PC) ──► ONE local PostgreSQL transaction
                                           ├─ cashier_shifts row (open / close / review / correction)
                                           ├─ audit_logs row
                                           └─ sync_events outbox row (SHIFT_OPENED / CLOSED / REVIEWED / CORRECTED)
                                                         │  (whenever the internet is up)
                                                         ▼
                              Supabase giga_cloud.cashier_shifts (reporting copy, per shop_id)
                                                         ▼
                              https://gigachem.vercel.app  — Global Admin: Shift History, dashboard, alerts
```

* The shop's **local PostgreSQL is authoritative**. Opening / closing a shift never calls Supabase, Vercel or the heartbeat: it works with the internet OFF.
* The cloud copy is filled **only** by shop events (idempotent, sequence-guarded). The online API never writes a shift; an online **review** is a `SHIFT_REVIEW` command that the shop applies in its own transaction (same pattern as every Full-Write command).
* One read implementation (`server/db/shifts.ts`) runs over the local tables (shop server) **or** the cloud copy (online API); the browser never chooses which shops it may see.

## 2. Schema (local 020 — additive only)

| Object | Purpose |
|---|---|
| `cashier_shifts` | one row per shift: `id` UUID, `shift_number` (SHIFT-YYYYMMDD-NNNNN), `cashier_id`, `device_id`, `status` OPEN/CLOSED/REVIEWED, `opened_at`, `opened_business_date`, `opening_float`, `opened_by(_name)`, `closed_at`, `closed_business_date`, `closed_by(_name)`, `close_method` CASHIER/ADMIN, `admin_close_reason`, closing figures (`total_transactions`, `total_sales`, `cash/mpesa/card/bank/other_sales`, `units_sold`, `voided_count/total`, `returns_count`, `refund_total`, `cash_refunds`, `cash_expenses`, `expected_cash`, `actual_cash`, `cash_variance`), `closing_notes`, `reviewed_by(_name)`, `reviewed_at`, `review_notes`, timestamps |
| `uq_cashier_shifts_one_open` | UNIQUE (cashier_id) WHERE status='OPEN' — **one active shift per cashier**, enforced by PostgreSQL |
| `cashier_shift_corrections` | audited corrections of a closed shift's counted cash (original figures never rewritten) |
| `sales.shift_id` | the shift a sale was completed in (NULL for all history before 020) |
| `returns.refund_method`, `returns.refund_shift_id` | how an APPROVED refund was paid and from which till |
| `expenses.shift_id` | a CASH expense paid out of an open shift's till (CHECK: only Cash) |
| CHECK constraints | lifecycle (OPEN has no closing figures; CLOSED/REVIEWED have all of them, actual ≥ 0, a non-zero variance has notes, an ADMIN close has a reason), status set, float ≥ 0, review consistency |

Nothing existing is changed: no DROP, no DELETE, no UPDATE of business rows, no stock / sale / payment / user change. Single-shop local DB: no shop column (the shop is `shop_identity`).

Cloud 009: `giga_cloud.cashier_shifts` (PK shop_id + shift_id, typed columns + `data` JSON, `source_seq`), `giga_cloud.cashier_shift_corrections`, indexes (shop+date, shop+cashier+opened_at, shop+status, and expression indexes on the shift ids carried in `sales/returns/expenses.data`), `giga_online.cashier_shifts` view, `giga_online.returns` + `refund_method`/`refund_shift_id` and `giga_online.expenses` + `shift_id` (appended columns — **the online Returns list needs 009 before the new Vercel code**), command type `SHIFT_REVIEW`, functions `upsert_shift`, `sync_shift_variance_alert`, `refresh_shift_alerts`, and the `apply_event` wrapper re-created with the shift branch (re-run 009 after any re-run of 006).

## 3. Expected cash — exact formula

```
EXPECTED CASH = opening float
              + cash sales          (Cash payment lines of the shift's NON-VOIDED sales)
              - cash refunds        (APPROVED returns paid from this till with refund_method = Cash)
              - cash till expenses  (POSTED expenses attributed to this shift; always payment_method Cash)

VARIANCE = actual cash counted - expected cash      → BALANCED (0) / SHORT (< 0) / OVER (> 0)
```

* Computed by the **server** in integer cents from the transactions tagged with the shift (`computeShiftTotals`), never typed by the cashier. The same SQL runs on the cloud copy (the suite proves both give identical totals).
* There is no separate "cash in / cash out" record type in this system; the only legitimate cash leaving a till are cash refunds and till expenses.
* The close request may carry `expected_cash_seen`; if new transactions changed the figure since the close screen opened, the server refuses (`SHIFT_TOTALS_CHANGED`) and the screen reloads it.
* Closing locks the shift row `FOR UPDATE`; checkout, refund approval and till expenses take `FOR SHARE` on it — a close waits for in-flight sales and counts them; nothing can be added after.

## 4. Payments

* Every sale already writes one `payments` row per tender. Cash rows store the **sale share** (change is never included).
* Mixed payment = several lines; each line goes to its own method (`Cash 400 + M-Pesa 600` → cash 400, M-Pesa 600). `mixed_transactions` counts split sales.
* M-Pesa / Card / Bank never change expected cash.

## 5. Returns / refunds

* `PENDING` and `REJECTED` returns affect nothing.
* At approval the Administrator chooses **Refund paid by**: Cash (default; also the default for remote approvals that do not say) / M-Pesa / Card / Bank.
* The refund is attributed to a till: the **requesting cashier's open shift**, else the **approver's own open shift**, else none ("paid outside any till", shown in the approval message). Cash refunds reduce that shift's expected cash; non-cash refunds are reported (refund total) but do not touch the drawer.

## 6. Voids

* A voided sale stays in history (never deleted) and is **excluded** from every sales and cash figure of its shift; it is reported as `voided_count / voided_total`.
* A sale whose shift is already **CLOSED** can no longer be voided (its cash was counted): the server answers `SHIFT_CLOSED` — record a return/refund instead, which belongs to the till that pays it. Legacy sales (no shift) keep the old void rules.

## 7. Expenses

* Expense records are Administrator-only (existing rule). Only a **Cash** expense explicitly recorded as **"Paid from till: <cashier> (SHIFT-…)"** (the expense form lists open tills) reduces a shift's expected cash. The shift must be OPEN at that moment.
* Non-cash expenses and cash expenses not from a till (petty cash box) never touch a shift. A voided till expense stops counting. A till expense keeps payment method Cash, and its amount is frozen once its shift is closed.

## 8. Shift workflow

1. Sign in. POS shows **OPEN SHIFT — Opening Cash Float KES [____]** until a shift is open. Searching medicines, Stock History and other read-only screens stay available; **Tender / F4 / checkout require an OPEN shift** (server: `SHIFT_REQUIRED`).
2. **Policy: every role that sells (Cashier, Manager, Administrator) uses a shift.**
3. Opening the same shift twice returns the existing one (never a second shift).
4. POS strip **CURRENT SHIFT**: opened, float, transactions, sales, cash, M-Pesa (card/bank when used), [Shift Details] [Close Shift]. No profit/cost anywhere.
5. **Close Shift**: shows opening float, cash sales, cash refunds, cash expenses, expected cash (read only) and the medicines sold; the closer enters **Actual Cash Counted** and **Closing Notes** (required when the variance is not zero). Result: BALANCED / SHORT / OVER, then **Print Shift Report** (signature lines). Reprints from history are marked **REPRINT — COPY**.
6. A closed shift is **immutable** to the cashier (no reopen, no edit). Closing changes no stock.
7. **Review** (Administrator / Manager; a Manager cannot review their own shift): CLOSED → REVIEWED with notes (required for a variance). Figures unchanged.
8. **Correction** (Administrator): a separate audited row with the corrected count + reason; the original closing figures stay; the latest correction is the effective count.
9. **Forgotten shift**: never auto-closed. Flagged as *open shift from a previous business day* (dashboard + alerts). An Administrator may close it from Shift History with a **reason** and the cash **they counted** (`close_method = ADMIN`, `closed_by`, audit `SHIFT_CLOSED_BY_ADMIN`).

## 9. Permissions

| Permission | ADMIN | MANAGER | CASHIER |
|---|---|---|---|
| shift.open / shift.close (own) | ✔ | ✔ | ✔ |
| shift.view_own | ✔ | ✔ | ✔ |
| shift.view_all | ✔ | ✔ | — |
| shift.review | ✔ | ✔ (not own) | — |
| shift.correct, close another person's shift | ✔ | — | — |

No `reports.view` is granted for shifts. A cashier sees only their own shifts (another cashier's shift answers 404), never profit, cost, valuation or another person's variance. Navigation: Cashier **History / My Shifts** → tabs *Stock History* and *My Shifts*; Administrator / Manager **History → Shifts**.

## 10. Reads / reports (local and online)

`GET /api/shifts` (filters: Today / Yesterday / This Week / This Month / All / Custom, shop, cashier, status, variance SHORT/OVER/BALANCED/NONZERO/UNREVIEWED, search) returns one page + summary + **Daily Shift Summary** (by day) + **Cashier Reconciliation** (by cashier); the list itself is the **Cash Variance Report**. `GET /api/shifts/export` = CSV. `GET /api/shifts/:id` detail (stored figures, live recount + "changed since close" warning, corrections, refunds, till expenses, voids). `GET /api/shifts/:id/medicines` = medicines sold (sold / returned through this till / net). `GET /api/shifts/overview` = per-shop cards. Shift detail links to Sales History filtered by `shift_id`, Returns and Expenses. Nothing loads every transaction up front.

Local-only writes: `GET /api/shifts/current`, `POST /api/shifts/open`, `POST /api/shifts/:id/close`, `POST /api/shifts/:id/review`, `POST /api/shifts/:id/corrections`, `GET /api/shifts/open-tills`.

## 11. Sync events

`SHIFT_OPENED`, `SHIFT_CLOSED` (cashier or admin closure), `SHIFT_REVIEWED`, `SHIFT_CORRECTED` — through the existing outbox (no second sync engine). Payload: the `cashier_shifts` row, the cashier name and (corrections) the correction row: **business totals only — no password, PIN or token**. Idempotent (`processed_events` idempotency key: a replay is DUPLICATE), shop-scoped (token-authenticated shop id), sequence-safe (`source_seq`: an older event never overwrites a newer row). Shift links in sales / returns / expenses travel inside their existing event rows.

## 12. Global Admin (online)

* **All Shops**: Shift History of every shop with each shift kept in its own shop (Shop column; no cross-shop drawer totals). **Shop 1 / Shop 2**: that shop only. A shop-scoped account cannot read another shop (403).
* **Dashboard** (Global Control Center and local Admin dashboard): per shop — Open shifts, Left open (previous business day), Closed today, Cash variance today, Unreviewed variances, plus a "needs attention" list.
* **Alerts** (`giga_cloud.alerts`): `SHIFT_SHORTAGE` / `SHIFT_OVERAGE` for any non-zero variance (raised by the SHIFT_CLOSED event, resolved by review or a zeroing correction), `SHIFT_LEFT_OPEN` (WARNING, open from the previous business day) and `SHIFT_NOT_CLOSED` (CRITICAL, 2+ days), refreshed with the alert list. Each names shop, cashier, shift and variance. Thresholds: any non-zero variance (configurable later).
* Review online = **Remote command SHIFT_REVIEW** (Administrator; select one shop, not All Shops). Online accounts of role CASHIER see only the shifts of the shop staff account they are linked to (`local_user_id`).

## 13. Shop 1 deployment (controlled)

Order (Shop 2 is not live and is not touched):

1. Apply **cloud 009** to production Supabase (after 008 if not yet applied) — additive; rehearsed on the restored production copy `giga_chemist_cloud_rehearsal` (applied twice, ~0.7 s, existing counts unchanged).
2. Verify the existing online Admin still works (login, overview, history, alerts).
3. Merge the branch to `main` → Vercel deploys; verify `/api/health`, `/api/shifts` (empty), `/api/shifts/overview`.
4. Fast-forward `production` to that commit; **owner approves** the install from the phone (Remote Operations → Health → Software updates).
5. The Shop 1 updater takes its verified backup, updates code, runs `db:migrate` (013…020 as needed — rehearsed on a clone of the Shop 1 data: 8 s, all business checksums identical, `db:check` passed), restarts the server.
6. Verify `/api/health`, Admin login, Cashier login, open shift, one small real shift workflow, sync of SHIFT_* events, Global Admin sees the shift.

Pre-flight safety (record before step 4): Shop 1 healthy + installed commit SHA, backup present/verified, POS + PostgreSQL service up, sync healthy / 0 rejected events, free disk (was 3.6% on 2026-10-12 — must be addressed), SHOP_ID / SYNC_SHOP_TOKEN / DEVICE_ID / DB password unchanged (the updater never touches `.env`).

**Operational note:** after this update every person who sells must open a shift (opening float) before the first sale.

## 14. Rollback

* Application failure → the updater rolls the **code** back to the last good release. The database is **not** restored because of a code failure: 020 is additive and backward compatible (old code ignores the new table/columns; `shift_id` columns are nullable).
* Never roll back real sales made after deployment. A database restore is only for data corruption, decided by the owner.
* Cloud 009 can stay in place under older shop / Vercel code (unused table, wrapper behaves identically for old event types).

## 15. Tests

`npm run test:shifts` (giga_chemist_dev + cloud emulator + online API + synthetic Shop 2; the shop's cloud is unreachable during the whole shift): **121 checks**, covering the 42 required cases — RBAC (own/other cashier, review, admin, Global Admin, Shop 1 vs Shop 2), open (float, duplicate prevention under 6 concurrent requests, offline), sales (cash / M-Pesa / card / bank / mixed / aggregate), returns (cash, non-cash, pending, rejected), voids (excluded, closed-shift void refused), expenses (till cash vs non-cash vs not-from-till), close (expected 2550 = 2000 + 700 − 100 − 50, actual, −200 SHORT, +50 OVER, BALANCED, reason required, immutable, stale-figure guard), offline → reconnect → SYNCED, replay = DUPLICATE, older event cannot reopen a reviewed cloud row, same shift id local/cloud, identical local/cloud totals, alerts, online review command applied by Shop 1, regression (Sales History filter, Stock History daily sold, stock unchanged by close, users/passwords/PINs unchanged).
Regression on this branch (giga_chemist_dev + emulator): integration 285/0, stock-history 63/0, full-write 196/0, hybrid 151/0, online 177/0, unified-auth 96/0, pos-cache 28/0, api-url 30/0, updater 58/0, ops 111/1 (the known dev-PC `upgrade-target.ps1` environment check, unchanged by this work).
Note: after 009, re-running 006 would fail on its `giga_online.returns` view (a view cannot drop columns) — never re-run 006 after 009 (it is already applied in production).
Existing suites updated only in the harness: `login()` opens a float-0 shift for test accounts (checkout now requires one); `loginNoShift()` tests the gate.
