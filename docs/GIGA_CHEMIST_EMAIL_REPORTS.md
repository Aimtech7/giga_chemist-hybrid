# GIGA CHEMIST — Automated Email Reports

Status: implemented 2026-10-07. Tested end-to-end over the real SMTP protocol against a local test
SMTP server (`scripts/integration/fake-smtp.ts`). **No real SMTP provider has been configured or tested
yet** — external delivery is NOT verified.

## 1. Architecture

```
PostgreSQL ──> report generator ──> email_jobs (queue, unique idempotency key) ──> email worker ──> SMTP ──> recipients
                 (server/email/reports.ts)          (migration 014)                (server/email/service.ts)
```

* Runs entirely on the local POS server. The browser does not need to be open.
* **Email never blocks the POS.** No sale, return, purchase or stock operation touches email.
* A report is generated **once**, when its job is queued (the HTML, text and CSV are stored in the job
  row). Retries resend exactly that content.
* One worker per database (PostgreSQL advisory lock).

## 2. Reports

| Type (job_type) | Default schedule (Africa/Nairobi) | Idempotency key | Contents |
|---|---|---|---|
| `DAILY_STOCK` | daily 18:00 | `SHOP1:DAILY_STOCK:YYYY-MM-DD` | summary, expiry, today's inventory activity, low / out-of-stock lists, expiring items + CSV |
| `DAILY_BUSINESS` | daily 18:05 | `SHOP1:DAILY_BUSINESS:YYYY-MM-DD` | gross / net sales, cash, M-Pesa, discounts, approved refunds, expenses, purchases, transactions, voids, cashier totals + CSV |
| `WEEKLY_EXPIRY` | Monday 08:00 | `SHOP1:WEEKLY_EXPIRY:YYYY-MM-DD` | expired / ≤30 / 31–60 / 61–90 days + CSV |
| `LOW_STOCK_DIGEST` | daily 08:00 (off by default) | `SHOP1:LOW_STOCK_DIGEST:YYYY-MM-DD` | low and out-of-stock lists + CSV |
| `TEST` | on demand | `TEST:<uuid>` | delivery check |

The daily stock e-mail ("GIGA CHEMIST — DAILY STOCK REPORT") contains date, shop, generation time; Total
Medicines, In Stock, Low Stock, Out of Stock; Expired, expiring within 30/60/90 days; Units Sold,
Units Received, Approved Returns to Stock, Physical Count Adjustments, Manual Stock Additions, Manual
Stock Removals; the low-stock list (medicine, current stock, reorder level), the out-of-stock list and
expiring items. HTML lists are capped at 200 rows; the attached
`giga-chemist-stock-report-YYYY-MM-DD.csv` always has every row
(`Section, Medicine, Batch, Current Stock, Reorder Level, Expiry Date, Days To Expiry, Batch Quantity`).

### Data rules (PostgreSQL)

* Low stock: active medicine with `0 < current_stock <= reorder_level`. Out of stock: `current_stock <= 0`.
* Expiry: batches with `quantity_available > 0`, not recalled, with a real `expiry_date`.
  Expired = expiry ≤ today; then ≤30, 31–60, 61–90 days. Batches without an expiry date are never guessed.
* Activity comes from the immutable `inventory_movements` ledger (Nairobi day) and `sale_items`.
* Business figures use the same server report as the Reports screen (`GET /api/reports/summary`).

## 3. Scheduling

The worker checks every 30 s (and immediately after a settings change). A report is queued when today's
time (EMAIL_TIMEZONE) has passed its configured time and no job with its key exists. The unique key
guarantees one report per shop/type/day across restarts, reconnects and manual "send now".
If the server was off at 18:00 and starts later the same day, the report is produced on start. Reports
for a day the server never ran are not generated retroactively.

## 4. Delivery, retries and offline behaviour

| Situation | Job state |
|---|---|
| Queued | `PENDING` |
| Being sent | `SENDING` (crash → back to `RETRYING` on restart) |
| SMTP unreachable / DNS / timeout / 4xx | `RETRYING`, backoff `EMAIL_RETRY_BASE_SECONDS × 2^(n-1)` (default 60 s) capped at `EMAIL_MAX_BACKOFF_SECONDS` (30 min) |
| SMTP accepted | `SENT` (`sent_at`, `message_id`) |
| SMTP 5xx refusal (bad mailbox, auth) or `EMAIL_MAX_ATTEMPTS` (50) reached | `FAILED` — Admin **Retry failed** re-queues |

When SMTP comes back, the first successful send makes all backed-off jobs due immediately. Each message
carries a stable `Message-ID: <job-id@giga-chemist.pos>`, so a resend after a crash in the middle of
sending can be recognised by the receiving server.

## 5. Configuration (server `.env` only — never `VITE_*`)

```
EMAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false            # true for port 465 (implicit TLS)
SMTP_USER=...
SMTP_PASSWORD=...            # server only; never returned by any API
EMAIL_FROM=GIGA CHEMIST <reports@your-domain>
STOCK_REPORT_RECIPIENTS=owner@your-domain, manager@your-domain
STOCK_REPORT_TIME=18:00
BUSINESS_REPORT_TIME=18:05
EMAIL_TIMEZONE=Africa/Nairobi
```

STARTTLS is required for non-local SMTP hosts unless `SMTP_REQUIRE_TLS=false`.
Optional: `EMAIL_WORKER_INTERVAL_SECONDS`, `EMAIL_RETRY_BASE_SECONDS`, `EMAIL_MAX_BACKOFF_SECONDS`,
`EMAIL_MAX_ATTEMPTS`, `SMTP_TIMEOUT_MS`.

## 6. Admin screen — Settings → Email Reports

Enable/disable each report, report times, expiry weekday, recipients (empty = `.env` default), include
low-stock / expiry sections, **Send Test Email**, "send today's stock report now" (idempotent), Retry
failed. Shows state (READY / OFFLINE / ERROR / DISABLED), pending, retrying, failed, last successful
e-mail, last error and the last 15 jobs. The SMTP password is never shown.

API (Admin only; Cashier → 403): `GET/PUT /api/email/settings`, `POST /api/email/test`,
`POST /api/email/reports/:type/run`, `GET /api/email/jobs`, `POST /api/email/retry-failed`.

## 7. Tests (`npm run test:ops`)

Scheduler queues and sends the daily stock report once; CSV has correct low-stock, out-of-stock and
expiry rows; HTML summary/expiry/activity; manual re-run and server restart do not duplicate; business
summary matches the server report; test e-mail; SMTP down → RETRYING, POS still sells, state OFFLINE;
server restart with a pending e-mail → sent exactly once after SMTP returns; 550 → FAILED → Admin
re-queue → SENT; 451 → RETRYING → SENT; no message delivered twice; Cashier blocked from every e-mail
endpoint; password never in responses or logs.

## 8. First real SMTP test (to do on site)

1. Fill the SMTP values in `.env`, set `EMAIL_ENABLED=true`, restart the POS.
2. Settings → Email Reports → **Send Test Email**; confirm receipt in the mailbox (check spam).
3. Only then record external delivery as PASS.
