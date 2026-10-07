import { pgPool, HttpError, requireUuid, type Queryable } from './client';

/**
 * Server-side reports. Every total is aggregated by PostgreSQL over the full history — never from
 * a browser cache. Business days are Africa/Nairobi dates:
 *   sales      sales.date (business date stamped at checkout)
 *   refunds    APPROVED returns, on the Nairobi date they were approved (reviewed_at)
 *   expenses   expenses.date
 *   purchases  purchases.received_date
 * Money is summed as NUMERIC in SQL and rounded to cents once.
 */
export type ReportRange = 'today' | 'week' | 'month' | 'custom';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;

export interface ResolvedRange {
  range: ReportRange;
  start: string;
  end: string;
  today: string;
}

export async function resolveRange(range: unknown, start?: unknown, end?: unknown, q: Queryable = pgPool): Promise<ResolvedRange> {
  const r = (typeof range === 'string' && range ? range : 'today') as ReportRange;
  const d = (await q.query(`
    SELECT to_char((now() AT TIME ZONE 'Africa/Nairobi')::date, 'YYYY-MM-DD') AS today,
           to_char(date_trunc('week', now() AT TIME ZONE 'Africa/Nairobi')::date, 'YYYY-MM-DD') AS week_start,
           to_char(date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi')::date, 'YYYY-MM-DD') AS month_start`)).rows[0];
  if (r === 'today') return { range: r, start: d.today, end: d.today, today: d.today };
  if (r === 'week') return { range: r, start: d.week_start, end: d.today, today: d.today };
  if (r === 'month') return { range: r, start: d.month_start, end: d.today, today: d.today };
  if (r === 'custom') {
    if (typeof start !== 'string' || !DATE_RE.test(start) || typeof end !== 'string' || !DATE_RE.test(end)) {
      throw new HttpError(400, 'Custom range needs start and end as YYYY-MM-DD.');
    }
    if (start > end) throw new HttpError(400, 'start must not be after end.');
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days > 3700) throw new HttpError(400, 'Custom range is limited to 10 years.');
    return { range: r, start, end, today: d.today };
  }
  throw new HttpError(400, 'range must be today, week, month or custom.');
}

export interface ReportScope {
  /** Restrict to one cashier's sales (Cashier role, or Admin filter). */
  cashierId?: string | null;
  /** Hide cost/profit/expenses/purchases (Cashier role). */
  includeCost: boolean;
}

/** Stock health counts (active medicines). Low = 0 < stock <= reorder level; Out = stock <= 0. */
export async function getStockCounts(q: Queryable = pgPool) {
  const r = (await q.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE current_stock > 0)::int AS in_stock,
           COUNT(*) FILTER (WHERE current_stock > 0 AND current_stock <= COALESCE(reorder_level, 0))::int AS low_stock,
           COUNT(*) FILTER (WHERE current_stock <= 0)::int AS out_of_stock
      FROM medicines WHERE COALESCE(status, 'active') = 'active'`)).rows[0];
  return { totalMedicines: r.total, inStock: r.in_stock, lowStock: r.low_stock, outOfStock: r.out_of_stock };
}

export async function getSalesReport(rangeIn: ResolvedRange, scope: ReportScope, q: Queryable = pgPool) {
  const { start, end } = rangeIn;
  const cashierId = scope.cashierId ? requireUuid(scope.cashierId, 'cashierId') : null;
  const p: any[] = [start, end];
  const saleScope = cashierId ? (p.push(cashierId), `AND s.cashier_id = $3`) : '';

  const totals = (await q.query(
    `SELECT COALESCE(SUM(s.total) FILTER (WHERE s.status <> 'voided'), 0) AS gross,
            COALESCE(SUM(s.discount_total) FILTER (WHERE s.status <> 'voided'), 0) AS discounts,
            COALESCE(SUM(s.cost_total) FILTER (WHERE s.status <> 'voided'), 0) AS cogs,
            COUNT(*) FILTER (WHERE s.status <> 'voided')::int AS txn,
            COUNT(*) FILTER (WHERE s.status = 'voided')::int AS void_count,
            COALESCE(SUM(s.total) FILTER (WHERE s.status = 'voided'), 0) AS void_total
       FROM sales s WHERE s.date BETWEEN $1::date AND $2::date ${saleScope}`, p)).rows[0];

  const units = (await q.query(
    `SELECT COALESCE(SUM(si.quantity), 0)::int AS units
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status <> 'voided' AND s.date BETWEEN $1::date AND $2::date ${saleScope}`, p)).rows[0];

  // Approved refunds on their approval day; cost of returned goods from the original sale line.
  const approvedReturns = `
    FROM returns r JOIN sales s ON s.id = r.sale_id
    WHERE r.status = 'APPROVED'
      AND (COALESCE(r.reviewed_at, r.created_at) AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1::date AND $2::date ${saleScope}`;
  const refunds = (await q.query(
    `SELECT COALESCE(SUM(r.refund_amount), 0) AS refunds, COUNT(*)::int AS n,
            COALESCE(SUM(COALESCE(r.approved_quantity, r.quantity)), 0)::int AS units,
            COALESCE(SUM(COALESCE(r.approved_quantity, r.quantity) * COALESCE((
              SELECT si.cost_price_snapshot FROM sale_items si
               WHERE si.sale_id = r.sale_id AND si.medicine_id = r.medicine_id AND si.batch_id = r.batch_id LIMIT 1), 0)), 0) AS cogs
     ${approvedReturns}`, p)).rows[0];

  const tenders = await q.query(
    `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.status <> 'voided' AND s.date BETWEEN $1::date AND $2::date ${saleScope}
      GROUP BY p.method`, p);
  const tenderStats: Record<string, number> = { Cash: 0, 'M-Pesa': 0, Card: 0, Bank: 0 };
  for (const t of tenders.rows) {
    const m = String(t.method || '').toLowerCase().replace(/[\s_-]/g, '') === 'mpesa' ? 'M-Pesa' : t.method;
    tenderStats[m] = cents((tenderStats[m] || 0) + Number(t.amount));
  }
  const refundTenders = await q.query(
    `SELECT CASE WHEN s.payment_method = 'Mixed' THEN 'Cash' ELSE s.payment_method END AS method,
            COALESCE(SUM(r.refund_amount), 0) AS amount ${approvedReturns} GROUP BY 1`, p);
  for (const t of refundTenders.rows) {
    if (tenderStats[t.method] !== undefined) tenderStats[t.method] = cents(Math.max(0, tenderStats[t.method] - Number(t.amount)));
  }

  const cashiers = await q.query(
    `WITH sold AS (
       SELECT s.cashier_id, COUNT(*)::int AS n, SUM(s.total) AS gross, SUM(s.gross_profit) AS profit
         FROM sales s WHERE s.status <> 'voided' AND s.date BETWEEN $1::date AND $2::date ${saleScope}
        GROUP BY s.cashier_id),
     ref AS (
       SELECT s.cashier_id, SUM(r.refund_amount) AS refunds,
              SUM(r.refund_amount - COALESCE(r.approved_quantity, r.quantity) * COALESCE((
                SELECT si.cost_price_snapshot FROM sale_items si
                 WHERE si.sale_id = r.sale_id AND si.medicine_id = r.medicine_id AND si.batch_id = r.batch_id LIMIT 1), 0)) AS lost_profit
       ${approvedReturns} GROUP BY s.cashier_id)
     SELECT COALESCE(u.name, 'Unknown') AS name, COALESCE(sold.n, 0) AS n, COALESCE(sold.gross, 0) AS gross,
            COALESCE(ref.refunds, 0) AS refunds, COALESCE(sold.profit, 0) - COALESCE(ref.lost_profit, 0) AS profit
       FROM sold FULL JOIN ref ON ref.cashier_id = sold.cashier_id
       LEFT JOIN users u ON u.id = COALESCE(sold.cashier_id, ref.cashier_id)
      ORDER BY 3 DESC`, p);
  const cashierStats: Record<string, { count: number; gross: number; refunds: number; net: number; profit: number }> = {};
  for (const c of cashiers.rows) {
    const prev = cashierStats[c.name] || { count: 0, gross: 0, refunds: 0, net: 0, profit: 0 };
    prev.count += Number(c.n);
    prev.gross = cents(prev.gross + Number(c.gross));
    prev.refunds = cents(prev.refunds + Number(c.refunds));
    prev.net = cents(prev.gross - prev.refunds);
    prev.profit = scope.includeCost ? cents(prev.profit + Number(c.profit)) : 0;
    cashierStats[c.name] = prev;
  }

  const medicines = await q.query(
    `WITH sold AS (
       SELECT si.medicine_id, SUM(si.quantity) AS qty, SUM(si.total) AS revenue,
              SUM(si.total - si.quantity * COALESCE(si.cost_price_snapshot, 0)) AS profit
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.status <> 'voided' AND s.date BETWEEN $1::date AND $2::date ${saleScope}
        GROUP BY si.medicine_id),
     ref AS (
       SELECT r.medicine_id, SUM(COALESCE(r.approved_quantity, r.quantity)) AS qty, SUM(r.refund_amount) AS revenue
       ${approvedReturns} GROUP BY r.medicine_id)
     SELECT COALESCE(m.name, 'Unknown medicine') AS name,
            COALESCE(sold.qty, 0) - COALESCE(ref.qty, 0) AS quantity,
            COALESCE(sold.revenue, 0) - COALESCE(ref.revenue, 0) AS revenue,
            COALESCE(sold.profit, 0) AS profit
       FROM sold FULL JOIN ref ON ref.medicine_id = sold.medicine_id
       LEFT JOIN medicines m ON m.id = COALESCE(sold.medicine_id, ref.medicine_id)
      ORDER BY 2 DESC, 3 DESC LIMIT 200`, p);

  const returnsList = await q.query(
    `SELECT r.id, r.receipt_number,
            to_char((COALESCE(r.reviewed_at, r.created_at) AT TIME ZONE 'Africa/Nairobi')::date, 'YYYY-MM-DD') AS date,
            COALESCE(m.name, '') AS medicine_name, COALESCE(b.batch_number, '') AS batch_number,
            COALESCE(r.approved_quantity, r.quantity) AS quantity, r.refund_amount, r.reason, r.action
     ${approvedReturns.replace('FROM returns r JOIN sales s ON s.id = r.sale_id',
       'FROM returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN medicines m ON m.id = r.medicine_id LEFT JOIN medicine_batches b ON b.id = r.batch_id')}
      ORDER BY COALESCE(r.reviewed_at, r.created_at) DESC LIMIT 1000`, p);

  let expenses: any[] = [];
  let expenseCategoryStats: Record<string, number> = {};
  let operatingExpenses = 0;
  let purchases = { count: 0, total: 0 };
  if (scope.includeCost) {
    const ex = await q.query(
      `SELECT e.id, to_char(e.date, 'YYYY-MM-DD') AS date, e.category, e.description, e.payment_method, e.amount,
              COALESCE(u.name, '') AS user_name
         FROM expenses e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.date BETWEEN $1::date AND $2::date ORDER BY e.date DESC, e.created_at DESC`, [start, end]);
    expenses = ex.rows.map((e) => ({ ...e, amount: cents(e.amount) }));
    for (const e of expenses) {
      expenseCategoryStats[e.category] = cents((expenseCategoryStats[e.category] || 0) + e.amount);
      operatingExpenses = cents(operatingExpenses + e.amount);
    }
    const pu = (await q.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0) AS total FROM purchases
        WHERE COALESCE(received_date, order_date) BETWEEN $1::date AND $2::date`, [start, end])).rows[0];
    purchases = { count: pu.n, total: cents(pu.total) };
  }

  const gross = cents(totals.gross);
  const refundTotal = cents(refunds.refunds);
  const netSales = cents(gross - refundTotal);
  const netCogs = cents(Math.max(0, Number(totals.cogs) - Number(refunds.cogs)));
  const grossProfit = cents(netSales - netCogs);
  const netProfit = cents(grossProfit - operatingExpenses);

  return {
    range: rangeIn.range,
    start,
    end,
    today: rangeIn.today,
    scope: cashierId ? 'cashier' : 'all',
    grossSales: gross,
    discounts: cents(totals.discounts),
    refunds: refundTotal,
    refundCount: refunds.n,
    netSales,
    cash: tenderStats.Cash || 0,
    mpesa: tenderStats['M-Pesa'] || 0,
    tenders: tenderStats,
    voids: { count: totals.void_count, total: cents(totals.void_total) },
    transactionCount: totals.txn,
    unitsSold: units.units,
    unitsReturned: refunds.units,
    netCogs: scope.includeCost ? netCogs : 0,
    grossProfit: scope.includeCost ? grossProfit : 0,
    grossMarginPercent: scope.includeCost && netSales > 0 ? Math.round((grossProfit / netSales) * 1000) / 10 : 0,
    operatingExpenses,
    netProfit: scope.includeCost ? netProfit : 0,
    netMarginPercent: scope.includeCost && netSales > 0 ? Math.round((netProfit / netSales) * 1000) / 10 : 0,
    purchases,
    expenses,
    expenseCategoryStats,
    cashierStats,
    medicines: medicines.rows.map((m) => ({
      name: m.name,
      quantity: Number(m.quantity),
      revenue: cents(m.revenue),
      profit: scope.includeCost ? cents(m.profit) : 0,
    })),
    returns: returnsList.rows.map((r) => ({ ...r, quantity: Number(r.quantity), refund_amount: cents(r.refund_amount) })),
    stock: await getStockCounts(q),
  };
}
