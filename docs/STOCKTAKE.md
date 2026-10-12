# Formal stocktake sessions

Local migration 022. Shop computer only (works offline). Module: Inventory -> **Stocktakes**.

## Workflow

`DRAFT -> COUNTING -> REVIEW -> COMPLETED` (approval), `REVIEW -> COUNTING` (re-open), any open state ->
`CANCELLED` (reason required). APPROVED is recorded as `approved_at / approved_by` on the COMPLETED session.

| Step | Who | What |
|---|---|---|
| Create | `stocktake.create` (Admin, Manager) | scope ALL / one CATEGORY / selected MEDICINES; one line per batch; optional "cashiers may count" |
| Start | create | DRAFT -> COUNTING |
| Count | `stocktake.count` | physical quantity + the **system quantity at that moment**; counter + time stored. A cashier counts only in sessions opened to cashiers and BLIND (no system quantity, cost or variance). |
| Submit | create | COUNTING -> REVIEW (at least one line counted) |
| Approve | `stocktake.approve` (Admin) | the only stock change |

**Before approval nothing changes stock.** On approval each counted line with a variance applies
`new = batch now + (counted - system at count)`, so sales made after the count are kept. Each change goes
through the normal stock path: `PHYSICAL_STOCK_COUNT` movement (reason `STOCKTAKE`, reference = the
stocktake number, previous / delta / new), medicine stock reconciliation, `STOCKTAKE_ADJUSTMENT` audit and
the existing `PHYSICAL_COUNT` sync event (the cloud and Stock History see it like any count). If any batch
would go below zero, the whole approval is refused and nothing is applied (recount).

## Report

Items, counted, matched, short, over, uncounted, total variance units, variance cost (purchase cost;
Administrator / Manager). Printable.

## API

`GET /api/stocktakes`, `GET /api/stocktakes/:id`, `POST /api/stocktakes`, `POST .../start`,
`PUT .../lines/:lineId`, `POST .../submit`, `POST .../reopen`, `POST .../approve`, `POST .../cancel`.

## Tests

`npm run test:stocktake` (ST1-ST29): blind counting, no change before approval, sale after count kept,
movements + audit + Stock History, cloud convergence, approval offline, negative refusal, RBAC.
