# Stock History, Sold Medicines, Sales / Supply / Shift history

All read only; one SQL implementation runs on the shop (local PostgreSQL) and online (cloud copy) over the
server-authorized shop scope (a browser never chooses its shops).

## Stock History (History -> Stock History)

Per Kenya business day and medicine: opening, gross sold, returned/restocked, net sold, received, other
adjustments (itemised), closing. Reconstructed from the movement ledger; a day the ledger cannot prove is
shown as **INCOMPLETE STOCK HISTORY** (never today's stock). Drill-down: time, movement type, change,
before -> after, reference, user, batch. Permission `history.stock.view` (cashier included: quantities only,
no costs, no other history). Tests: `npm run test:stock-history`.

## Sold Medicines (POS "Today's Sold", History -> Sold Medicines)

`GET /api/history/sold?date&search&shop_id`: per medicine retail qty, wholesale qty, gross sold, returned
(approved returns of that day's sales), net sold, current stock, number of sales. Voided sales excluded.
Cashier: today only, quantities only. Administrator / Manager: any date; money (revenue, refunds, cost,
profit) for Administrators only. Same definition of "sold" as Stock History (test SOLD 3).

## Sales history

Each sale exactly as recorded: receipt, date/time, cashier (name as recorded), customer, payment
breakdown, items with batch, historical unit price, price mode, line discount, totals, returns, void
details, audit. Reprint = COPY of the stored sale (audited).

## Supply history

Purchases with lines, batches, expiry, quantities, buy price, received by, stock movements; printable goods
received note (copy). Received purchases are never edited (corrections: audited stock correction).

## Shift history

See [SHIFT-RECONCILIATION.md](SHIFT-RECONCILIATION.md).
