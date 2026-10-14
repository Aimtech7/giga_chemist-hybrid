import { HttpError } from './client';
import type { HistoryScope } from './history';

/**
 * BUSINESS DAY SUMMARY (read only) — one row per Kenya business date for the authorized shop(s):
 * gross / net sales, units, transactions, payments by method, returns + refunds, expenses, purchases
 * received, stock adjustments, physical counts and cashier shift variances. Same SQL over the shop's
 * PostgreSQL (local) or the cloud copy (online). No day is locked or changed (no "close" yet).
 */
const TZ = 'Africa/Nairobi';
const LOCAL = {
  sales: `(SELECT ($1::uuid[])[1] AS shop_id, s.id, s.date AS d, s.total, s.cost_total, s.status FROM sales s)`,
  items: `(SELECT ($1::uuid[])[1] AS shop_id, i.sale_id, i.quantity FROM sale_items i)`,
  payments: `(SELECT ($1::uuid[])[1] AS shop_id, p.sale_id, p.method, p.amount FROM payments p)`,
  returns: `(SELECT ($1::uuid[])[1] AS shop_id, r.id, (r.reviewed_at AT TIME ZONE '${TZ}')::date AS d, r.status, COALESCE(r.approved_quantity, r.quantity) AS qty, r.refund_amount FROM returns r)`,
  expenses: `(SELECT ($1::uuid[])[1] AS shop_id, e.date AS d, e.amount, COALESCE(e.status, 'active') AS status FROM expenses e)`,
  purchases: `(SELECT ($1::uuid[])[1] AS shop_id, p.received_date AS d, COALESCE(p.status, 'received') AS status, p.total_amount FROM purchases p)`,
  movements: `(SELECT ($1::uuid[])[1] AS shop_id, (mv.created_at AT TIME ZONE '${TZ}')::date AS d, mv.movement_type, mv.adjustment_quantity AS delta FROM inventory_movements mv)`,
  shifts: `(SELECT ($1::uuid[])[1] AS shop_id, x.closed_business_date AS d, x.status, x.cash_variance FROM cashier_shifts x)`,
  shops: `(SELECT si.shop_id, si.shop_code FROM shop_identity si WHERE si.shop_id = ANY($1::uuid[]))`,
};
const CLOUD = {
  sales: `(SELECT s.shop_id, s.sale_id AS id, s.business_date AS d, s.total, s.cost_total, s.status FROM giga_cloud.sales s WHERE s.shop_id = ANY($1::uuid[]))`,
  items: `(SELECT i.shop_id, i.sale_id, i.quantity FROM giga_cloud.sale_items i WHERE i.shop_id = ANY($1::uuid[]))`,
  payments: `(SELECT p.shop_id, p.sale_id, p.method, p.amount FROM giga_cloud.payments p WHERE p.shop_id = ANY($1::uuid[]))`,
  returns: `(SELECT r.shop_id, r.return_id AS id, (r.reviewed_at AT TIME ZONE '${TZ}')::date AS d, r.status, COALESCE(r.approved_quantity, r.quantity) AS qty, r.refund_amount
             FROM giga_cloud.returns r WHERE r.shop_id = ANY($1::uuid[]))`,
  expenses: `(SELECT e.shop_id, e.expense_date AS d, e.amount, COALESCE(e.data->>'status', 'active') AS status FROM giga_cloud.expenses e WHERE e.shop_id = ANY($1::uuid[]))`,
  purchases: `(SELECT p.shop_id, p.received_date AS d, COALESCE(p.data->>'status', 'received') AS status, p.total_amount FROM giga_cloud.purchases p WHERE p.shop_id = ANY($1::uuid[]))`,
  movements: `(SELECT mv.shop_id, (mv.occurred_at AT TIME ZONE '${TZ}')::date AS d, mv.movement_type, mv.delta FROM giga_cloud.inventory_movements mv WHERE mv.shop_id = ANY($1::uuid[]))`,
  shifts: `(SELECT x.shop_id, x.closed_business_date AS d, x.status, x.cash_variance FROM giga_cloud.cashier_shifts x WHERE x.shop_id = ANY($1::uuid[]))`,
  shops: `(SELECT s.shop_id, s.shop_code FROM giga_cloud.shops s WHERE s.shop_id = ANY($1::uuid[]))`,
};
/** Movements that are NOT adjustments (everything else is: corrections, removals by reason, add stock, ...). */
const NOT_ADJUSTMENT = ['SALE', 'PURCHASE', 'VOID_REVERSAL', 'CUSTOMER_RETURN', 'RETURN_APPROVED', 'RETURN_APPROVED_NOT_RESTOCKED', 'PHYSICAL_STOCK_COUNT', 'DEV_STOCK_RESET'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;

export async function businessDaySummary(scope: HistoryScope, query: Record<string, unknown>) {
  const R = scope.mode === 'local' ? LOCAL : CLOUD;
  const today = (await scope.q.query(`SELECT to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d`)).rows[0].d as string;
  const valid = (v: unknown) => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  const from = valid(query.from) ? String(query.from) : valid(query.date) ? String(query.date) : today;
  const to = valid(query.to) ? String(query.to) : valid(query.date) ? String(query.date) : from;
  if ((query.from && !valid(query.from)) || (query.to && !valid(query.to)) || (query.date && !valid(query.date))) throw new HttpError(400, 'Dates must be valid YYYY-MM-DD.');
  if (to < from) throw new HttpError(400, 'to must not be before from.');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 62) throw new HttpError(400, 'At most 62 days at a time.');
  const want = typeof query.shop_id === 'string' ? query.shop_id.toLowerCase() : '';
  if (want && !scope.shopIds.includes(want)) throw new HttpError(403, 'Forbidden: that shop is not in your authorized scope.');
  const ids = want ? [want] : scope.shopIds;
  const p = [ids, from, to, NOT_ADJUSTMENT];
  const rows = (await scope.q.query(
    `WITH days AS (SELECT sh.shop_id, sh.shop_code, g::date AS d FROM ${R.shops} sh CROSS JOIN generate_series($2::date, $3::date, interval '1 day') g),
          s AS (SELECT shop_id, d, COUNT(*) FILTER (WHERE status <> 'voided')::int AS transactions, COUNT(*) FILTER (WHERE status = 'voided')::int AS voided,
                       COALESCE(SUM(total) FILTER (WHERE status <> 'voided'), 0) AS gross, COALESCE(SUM(cost_total) FILTER (WHERE status <> 'voided'), 0) AS cost
                  FROM ${R.sales} WHERE d BETWEEN $2 AND $3 GROUP BY 1, 2),
          u AS (SELECT x.shop_id, x.d, COALESCE(SUM(i.quantity), 0)::int AS units FROM ${R.sales} x JOIN ${R.items} i ON i.shop_id = x.shop_id AND i.sale_id = x.id
                 WHERE x.d BETWEEN $2 AND $3 AND x.status <> 'voided' GROUP BY 1, 2),
          pay AS (SELECT x.shop_id, x.d,
                         COALESCE(SUM(pm.amount) FILTER (WHERE lower(pm.method) = 'cash'), 0) AS cash,
                         COALESCE(SUM(pm.amount) FILTER (WHERE lower(replace(pm.method, '-', '')) = 'mpesa'), 0) AS mpesa,
                         COALESCE(SUM(pm.amount) FILTER (WHERE lower(pm.method) = 'card'), 0) AS card,
                         COALESCE(SUM(pm.amount) FILTER (WHERE lower(pm.method) = 'bank'), 0) AS bank,
                         COALESCE(SUM(pm.amount) FILTER (WHERE lower(pm.method) NOT IN ('cash', 'card', 'bank') AND lower(replace(pm.method, '-', '')) <> 'mpesa'), 0) AS other
                    FROM ${R.sales} x JOIN ${R.payments} pm ON pm.shop_id = x.shop_id AND pm.sale_id = x.id
                   WHERE x.d BETWEEN $2 AND $3 AND x.status <> 'voided' GROUP BY 1, 2),
          ret AS (SELECT shop_id, d, COUNT(*)::int AS returns, COALESCE(SUM(qty), 0)::int AS returned_units, COALESCE(SUM(refund_amount), 0) AS refunds
                    FROM ${R.returns} WHERE status = 'APPROVED' AND d BETWEEN $2 AND $3 GROUP BY 1, 2),
          ex AS (SELECT shop_id, d, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM ${R.expenses}
                  WHERE d BETWEEN $2 AND $3 AND lower(status) <> 'voided' GROUP BY 1, 2),
          pu AS (SELECT shop_id, d, COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0) AS total FROM ${R.purchases}
                  WHERE d BETWEEN $2 AND $3 AND lower(status) = 'received' GROUP BY 1, 2),
          mv AS (SELECT shop_id, d,
                        COUNT(*) FILTER (WHERE NOT (movement_type = ANY($4::text[])))::int AS adjustments,
                        COALESCE(SUM(delta) FILTER (WHERE NOT (movement_type = ANY($4::text[]))), 0)::int AS adjustment_units,
                        COUNT(*) FILTER (WHERE movement_type = 'PHYSICAL_STOCK_COUNT')::int AS counts, COALESCE(SUM(delta) FILTER (WHERE movement_type = 'PHYSICAL_STOCK_COUNT'), 0)::int AS count_units
                   FROM ${R.movements} WHERE d BETWEEN $2 AND $3 GROUP BY 1, 2),
          sv AS (SELECT shop_id, d, COUNT(*)::int AS closed, COUNT(*) FILTER (WHERE cash_variance < 0)::int AS short, COUNT(*) FILTER (WHERE cash_variance > 0)::int AS over,
                        COALESCE(SUM(cash_variance), 0) AS variance
                   FROM ${R.shifts} WHERE status IN ('CLOSED', 'REVIEWED') AND d BETWEEN $2 AND $3 GROUP BY 1, 2)
     SELECT days.shop_id, days.shop_code, to_char(days.d, 'YYYY-MM-DD') AS date,
            COALESCE(s.transactions, 0) AS transactions, COALESCE(s.voided, 0) AS voided, COALESCE(s.gross, 0) AS gross, COALESCE(s.cost, 0) AS cost,
            COALESCE(u.units, 0) AS units, COALESCE(pay.cash, 0) AS cash, COALESCE(pay.mpesa, 0) AS mpesa, COALESCE(pay.card, 0) AS card, COALESCE(pay.bank, 0) AS bank, COALESCE(pay.other, 0) AS other,
            COALESCE(ret.returns, 0) AS returns, COALESCE(ret.returned_units, 0) AS returned_units, COALESCE(ret.refunds, 0) AS refunds,
            COALESCE(ex.n, 0) AS expenses_count, COALESCE(ex.total, 0) AS expenses, COALESCE(pu.n, 0) AS purchases_count, COALESCE(pu.total, 0) AS purchases,
            COALESCE(mv.adjustments, 0) AS adjustments, COALESCE(mv.adjustment_units, 0) AS adjustment_units, COALESCE(mv.counts, 0) AS physical_counts, COALESCE(mv.count_units, 0) AS count_units,
            COALESCE(sv.closed, 0) AS shifts_closed, COALESCE(sv.short, 0) AS shifts_short, COALESCE(sv.over, 0) AS shifts_over, COALESCE(sv.variance, 0) AS shift_variance
       FROM days
       LEFT JOIN s ON s.shop_id = days.shop_id AND s.d = days.d LEFT JOIN u ON u.shop_id = days.shop_id AND u.d = days.d
       LEFT JOIN pay ON pay.shop_id = days.shop_id AND pay.d = days.d LEFT JOIN ret ON ret.shop_id = days.shop_id AND ret.d = days.d
       LEFT JOIN ex ON ex.shop_id = days.shop_id AND ex.d = days.d LEFT JOIN pu ON pu.shop_id = days.shop_id AND pu.d = days.d
       LEFT JOIN mv ON mv.shop_id = days.shop_id AND mv.d = days.d LEFT JOIN sv ON sv.shop_id = days.shop_id AND sv.d = days.d
      ORDER BY days.d DESC, days.shop_code`, p)).rows;
  const days = rows.map((r: any) => ({
    shop_id: r.shop_id, shop_code: r.shop_code, date: r.date,
    gross_sales: r2(r.gross), net_sales: r2(Number(r.gross) - Number(r.refunds)), units_sold: Number(r.units), transactions: Number(r.transactions), voided_sales: Number(r.voided),
    payments: { cash: r2(r.cash), mpesa: r2(r.mpesa), card: r2(r.card), bank: r2(r.bank), other: r2(r.other) },
    returns: Number(r.returns), returned_units: Number(r.returned_units), refunds: r2(r.refunds),
    expenses: r2(r.expenses), expenses_count: Number(r.expenses_count), purchases: r2(r.purchases), purchases_count: Number(r.purchases_count),
    stock_adjustments: Number(r.adjustments), adjustment_units: Number(r.adjustment_units), physical_counts: Number(r.physical_counts), physical_count_units: Number(r.count_units),
    shifts_closed: Number(r.shifts_closed), shifts_short: Number(r.shifts_short), shifts_over: Number(r.shifts_over), shift_variance: r2(r.shift_variance),
    ...(scope.includeCost ? { cost_of_goods: r2(r.cost), gross_profit: r2(Number(r.gross) - Number(r.cost) - Number(r.refunds)) } : {}),
  }));
  return { from, to, today, closed: false, note: 'Read-only summary (no day is locked). Net sales = gross sales - approved refunds of that day.', days };
}
