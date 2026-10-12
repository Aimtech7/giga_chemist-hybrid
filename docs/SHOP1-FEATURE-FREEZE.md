# GIGA CHEMIST — Shop 1 feature freeze

Branch `feature/shop1-final-feature-freeze`, started from `main` = `production` = `3c7fc9e` (2026-10-12).
Nothing on this branch is deployed. Deployment steps: [SHOP1-DEPLOYMENT.md](SHOP1-DEPLOYMENT.md).

## What the freeze adds

| Area | Status | Where |
|---|---|---|
| Unified local + online accounts, full user editing | complete | [UNIFIED-AUTH.md](UNIFIED-AUTH.md) |
| Sales / supply / stock / shift history | complete (earlier) + Sold Medicines | [STOCK-HISTORY.md](STOCK-HISTORY.md) |
| Cashier shifts + cash reconciliation | complete (earlier, live on Shop 1) | [SHIFT-RECONCILIATION.md](SHIFT-RECONCILIATION.md) |
| Formal stocktake sessions | new | [STOCKTAKE.md](STOCKTAKE.md) |
| Inventory reconciliation, reorder, fast/slow/dead, expiry risk, price history | new | [INVENTORY-RECONCILIATION.md](INVENTORY-RECONCILIATION.md) |
| Alerts Center | new | [ALERTS.md](ALERTS.md) |
| Audit trail completion | new | [ALERTS.md](ALERTS.md#audit-trail) |
| Sync & conflict control center | new | [SYNC-OPERATIONS.md](SYNC-OPERATIONS.md) |
| Backups + restore drill | new | [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md) |
| Update manager (lint hotfix, update audit) | hardened | [UPDATE-MANAGER.md](UPDATE-MANAGER.md) |
| Synthetic multi-shop isolation | tested | [MULTI-SHOP-ISOLATION.md](MULTI-SHOP-ISOLATION.md) |
| Business day summary, data integrity, LOCAL MODE health, printing | new | this file |

## Database changes (all additive)

Local (shop PostgreSQL), applied by the updater's `npm run db:migrate`:

| Migration | Adds |
|---|---|
| `021_user_name_history.sql` | table `user_name_history`, trigger on `users` (name changes), functions `user_name_at`, `sale_cashier_name` |
| `022_stocktakes.sql` | tables `stocktakes`, `stocktake_lines`, sequence `stocktake_seq` |
| `023_price_history.sql` | table `price_history` (immutable), triggers on `medicines` / `medicine_batches` price columns |
| `024_alerts.sql` | table `alerts` (one open row per condition) |

Cloud (Supabase), applied by an operator before the Vercel deploy:

| Migration | Adds |
|---|---|
| `010_user_profile_update.sql` | command types `USER_PROFILE_UPDATE`, `SYNC_RETRY_FAILED`; `gc_sync_user_credentials` re-created (profile hold + session end on login change); `giga_online.sale_cashier_name`, `giga_online.user_name_at` |

No table, column or row is dropped or rewritten. No stock is reset. No sale is rewritten.

## Permissions (server `server/auth.ts` = client `src/services/permissions.ts`)

| Permission | ADMIN | MANAGER | CASHIER |
|---|---|---|---|
| `history.stock.view` (Stock History, Sold Medicines today) | yes | yes | yes (quantities only) |
| `stocktake.create` / `stocktake.view` | yes | yes | no |
| `stocktake.count` | yes | yes | only in sessions opened to cashiers, blind |
| `stocktake.approve` | yes | no | no |
| `inventory.view` (Stock Insights) | yes | yes | no |
| `reports.view` (Business Day, price history) | yes | yes | no |
| `alerts.view` / `alerts.manage` | yes / yes | yes / no | no |
| `integrity.view`, `backup.view`, `update.approve` | yes | no | no |
| Sync Center | Administrator only | no | no |

Money (cost, profit, valuation) is sent by the server to Administrators only. A Global Administrator
(online) has Administrator rights over the shop selected server-side.

## New screens

POS: **Today's Sold** button. History: **Sold Medicines** tab. Inventory: **Stocktakes**, **Stock Insights**
(reorder, fast/slow/dead, expiry risk, reconciliation, price history). Reports: **Business Day**. System:
**Alerts Center**, **Sync Center**, **Data Integrity**. Header: connection status (LOCAL SERVER / DATABASE /
INTERNET / CLOUD SYNC) for every role; "LOCAL MODE · CLOUD OFFLINE" when the internet is down.

## Business day summary

`GET /api/business-day?from&to` (shop and online, `reports.view`, max 62 days): per Kenya business date
gross / net sales, units, transactions (+ voided), payments by method, returns / refunds, expenses (voided
excluded), purchases received, stock adjustments, physical counts, shift variances; cost / profit for
Administrators. Read only: no day is locked (a formal "close day" is a later step).

## Data integrity dashboard

`GET /api/integrity` (shop, Administrator): 18 read-only checks (negative stock, totals vs lines,
payments - change vs total, orphans, missing links, duplicate barcodes, stale outbox, rejected commands,
...). Findings in data imported from the old system are reported apart as INFO. There is no repair
endpoint. On PC2's Shop 1 copy: every structural check clean; INFO only (1 legacy sale without a payment,
10 legacy cash rounding differences, 1,697 legacy sales dated 1980-2013, 1 active account without a
password: "system admin").

## Shop configuration

Already separated by where each value lives: **global** = cloud (`giga_cloud.shops` flags such as
`credential_sync_enabled`, `remote_control` emergency switches, online accounts); **shop** = each shop's
PostgreSQL `pharmacy_settings` (name, address, phone, receipt header/footer, tax, low stock threshold,
expiry warning, printer width), changed locally or by `SETTINGS_UPDATE` per shop (fan-out to all shops
only for these safe fields); **device** = the `devices` table + each terminal browser (device id).
There are no global feature flags yet.

## Tests (dev database + emulator; never a real shop or cloud)

`npm run test:unified-auth`, `test:stock-history` (also insights, price history, business day,
integrity), `test:stocktake` (also alerts, audit, sync center), plus the earlier suites. Results:
[SHOP1-DEPLOYMENT.md](SHOP1-DEPLOYMENT.md#test-results).
