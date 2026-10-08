# GIGA CHEMIST — Remote Admin from a phone

> Full operations guide (health, alerts, backups, updates, emergency controls, deployment and the
> phone acceptance test): [GIGA_CHEMIST_REMOTE_OPERATIONS.md](GIGA_CHEMIST_REMOTE_OPERATIONS.md).

The Administrator manages the pharmacy from https://gigachem.vercel.app on a phone. The pharmacy PC's
local PostgreSQL stays **authoritative**: the phone never writes stock in the cloud.

```
Phone (ADMIN) -> Vercel API (JWT, ADMIN only, rate-limited, validated)
  -> giga_cloud.queue_online_command  (command row + online_audit row; shop_id from server SHOP_ID)
  -> gc_pull_commands  <- pharmacy PC sync worker (every SYNC_INTERVAL_SECONDS)
  -> ONE local PostgreSQL transaction: lock rows, same Admin stock functions as the POS,
     inventory movement + audit + outbox event, sync_inbound_commands (exactly once)
  -> gc_ingest_events (the resulting events)  -> gc_ack_command (APPLIED / REJECTED)
  -> phone sees PENDING -> DELIVERED -> APPLIED (or REJECTED with the reason) and the new figures
```

## Commands

| Phone action | Command | Shop behaviour |
|---|---|---|
| Add Stock | `STOCK_ADD` | +quantity (whole number ≥ 1) on an existing batch, or a new batch number (+ expiry) |
| Remove Stock | `STOCK_REMOVE` | −quantity; **REJECTED** if the batch holds less at apply time (never negative). Reasons: Damaged, Expired, Lost, Physical stock correction, Other |
| Set Physical Count | `STOCK_SET` | batch set to the count; delta computed against the quantity **locked when applied** (sales made meanwhile are included) |
| Edit Price | `PRICE_UPDATE` | selling / wholesale / minimum / purchase price. Refused (CONFLICT) while a local price change has not synced |
| Edit Medicine | `MEDICINE_METADATA_UPDATE` | name, generic, brand, form, strength, unit, category, Rx flag… |
| Edit Expiry | `BATCH_EXPIRY_UPDATE` | batch expiry (empty = unknown); batch status re-derived |
| Category | `CATEGORY_UPSERT` | add / update a category |
| Settings | `SETTINGS_UPDATE` | pharmacy name, address, phone, receipt header/footer… |

Historical `sale_items` are never modified. Invalid commands are REJECTED with a readable reason;
network/database outages leave them pending and they are retried.

## API (online deployment only)

`POST /api/admin/commands/{stock-add|stock-remove|stock-set|price-update|medicine-update|batch-expiry|category|settings}`
→ `202 { command_id, status: "PENDING" }` · `GET /api/admin/commands` · `GET /api/admin/commands/:id` ·
`GET /api/admin/remote-status` (shop in contact = it called the cloud in the last 150 s).
All require an online **ADMIN** (Cashier 403, no token 401). An optional `request_id` (UUID) makes a
retried request return the same command. Sales and every other write stay `409 ONLINE_READ_ONLY`.

## One-time setup

1. **Supabase SQL editor**: run `cloud/supabase/migrations/003_remote_admin_commands.sql` (after 001 and 002).
   Non-destructive and re-runnable.
2. **Vercel**: nothing new (deploys from `main`). Online Admin accounts: `npm run online:create-user`.
3. **Pharmacy PC** (`C:\GIGA-CHEMIST-POS`), `.env` must have `APP_MODE=hybrid`, `SYNC_ENABLED=true`,
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SHOP_ID`, `SYNC_SHOP_TOKEN` (do not change SHOP_ID / token).
4. **Auto-start** (elevated PowerShell on the pharmacy PC):
   ```
   powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\install-giga-service.ps1
   powershell -ExecutionPolicy Bypass -File C:\GIGA-CHEMIST-POS\deployment\windows\check-giga-service.ps1
   ```
   Task "GIGA CHEMIST POS Server": SYSTEM, at boot (+20 s) and a 5-minute watchdog; the supervisor
   waits for PostgreSQL, starts `server.ts`, restarts it with back-off. Logs: `logs\giga-service.log`,
   `logs\server-out.log`, `logs\server-err.log`. It replaces the older `GigaChemistPOS_Service`
   task, which forced `APP_MODE=local` (that switched hybrid sync off). Remove with
   `remove-giga-service.ps1`. PostgreSQL is never opened in the firewall; port 3000 only on the
   Private profile for LAN tills.
