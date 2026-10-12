# Cashier shifts + cash reconciliation

Released in `66d8523` (live on Shop 1 since 2026-10-12 19:21 UTC with `3c7fc9e`). Full design:
`SHIFT-CLOSING-RECONCILIATION.md` at the repository root.

- Every checkout needs the seller's OPEN shift (`SHIFT_REQUIRED`); one open shift per cashier.
- Open: opening float, cashier, device, opened at, business date.
- Live summary: transactions, totals by method (no profit for cashiers).
- Close: expected cash = float + cash sales - cash refunds - cash expenses paid from the till;
  variance = counted - expected -> BALANCED / SHORT / OVER; a reason is required when not zero.
- Closed shifts are never edited: corrections are separate audited rows; a closed shift's sale cannot be
  voided (refund through a return instead).
- History: cashier = own shifts; Administrator / Manager = the shop; Global Admin = one shop or all shops.

New in the freeze: shift alerts (left open since a previous day, short / over awaiting review) in the
Alerts Center, shift variances in the Business Day summary, the cashier name kept as recorded.
