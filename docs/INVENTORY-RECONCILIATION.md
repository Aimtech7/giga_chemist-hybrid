# Inventory reconciliation, reorder, movement analysis, expiry risk, price history

Module: Inventory -> **Stock Insights** (Administrator / Manager; `inventory.view`). Read only; money for
Administrators only. Shop and online (reconciliation and price history: shop computer only).

## Reconciliation

- **Per day** (opening + received + restocked returns + adjustments - sales = closing): Stock History.
- **Ledger vs batches** (`GET /api/inventory/insights/reconciliation`): per medicine, expected = the last
  balance the movement ledger recorded for each batch, actual = batch quantity now -> BALANCED / SHORT /
  OVER / INCOMPLETE_HISTORY (stock with no movement at all, e.g. imported), variance cost, last count, last
  movement. 0.6 s on a Shop 1-sized database.

## Reorder suggestions

`suggested = ceil(avg daily sales x (lead days + cover days)) + reorder level - sellable stock - quantity on
pending purchase drafts` (defaults: 30-day window, 7 lead days, 30 cover days; adjustable). Expired stock is
not sellable. Urgency OUT_OF_STOCK / CRITICAL / LOW / PLAN. Recommendations only: **Create purchase draft**
(Administrator) makes a PENDING draft (`POST /api/purchases/drafts`; online: `PURCHASE_CREATE`), nothing is
received; set the real batch numbers / expiry when receiving.

## Fast / slow / dead stock

Last 30 days: FAST >= 1 unit/day, SLOW < 0.1, else NORMAL; no sale in 30 / 60 / 90 days (thresholds
adjustable). Shows quantity, velocity, stock value, last sale, days since sale.

## Expiry risk

Per batch: days remaining, velocity (last 90 days), estimated days to sell (this and earlier-expiring
batches, FEFO), risk EXPIRED / HIGH / MEDIUM / LOW (rules shown on screen), purchase and retail value.

Online, velocity uses the cloud copy, which holds sales only since syncing started (2026-10-10); the shop
computer uses its full history.

## Price history

Local 023: every change of purchase / selling / wholesale / minimum selling price and of a batch price is
recorded by a **database trigger** (no code path can skip it), attributed to the user and source
(LOCAL_ADMIN, REMOTE_COMMAND, PURCHASE_RECEIPT, BATCH_EDIT; otherwise UNATTRIBUTED). Rows cannot be updated
or deleted. Historical sales keep their own prices. `GET /api/price-history` (Administrator + Manager;
purchase-cost rows Administrator only).

## Tests

`npm run test:stock-history`: IN1-IN20 (reorder, classes, expiry risk, reconciliation, RBAC, drafts),
PH1-PH6 (price history).
