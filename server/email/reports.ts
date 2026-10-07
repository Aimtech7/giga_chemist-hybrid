import { pgPool, type Queryable } from '../db/client';
import { getStockCounts, getSalesReport } from '../db/reports';
import { getShopIdentity } from '../sync/identity';

/**
 * Builds report e-mails from PostgreSQL. A report is generated ONCE when its job is queued; retries
 * re-send exactly the same content (the job row stores it).
 *
 * Stock rules: low stock = 0 < current_stock <= reorder_level; out of stock = current_stock <= 0
 * (active medicines). Expiry counts only batches that still hold stock and are not recalled;
 * batches without an expiry date are never guessed into a category.
 */
export type ReportType = 'DAILY_STOCK' | 'DAILY_BUSINESS' | 'WEEKLY_EXPIRY' | 'LOW_STOCK_DIGEST' | 'TEST';

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; contentType: string; content: string }[];
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (n: number) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const LIST_LIMIT = 200;

function shell(title: string, subtitle: string, body: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:16px 0"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px">
<tr><td style="background:#0f766e;color:#ffffff;padding:16px 20px">
<div style="font-size:18px;font-weight:700;letter-spacing:.3px">${esc(title)}</div>
<div style="font-size:12px;opacity:.9;margin-top:4px">${esc(subtitle)}</div></td></tr>
<tr><td style="padding:16px 20px;font-size:13px;line-height:1.5">${body}</td></tr>
<tr><td style="padding:12px 20px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b">
Generated automatically by the GIGA CHEMIST POS server from the shop's PostgreSQL database. Do not reply.</td></tr>
</table></td></tr></table></body></html>`;
}

const h2 = (t: string) => `<h2 style="font-size:14px;margin:18px 0 8px;color:#0f766e;border-bottom:1px solid #e2e8f0;padding-bottom:4px">${esc(t)}</h2>`;
function kv(rows: [string, string | number][]) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 0;color:#475569">${esc(k)}</td><td style="padding:4px 0;text-align:right;font-weight:600;font-family:Consolas,monospace">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}
function table(header: string[], rows: (string | number)[][], total: number, empty: string) {
  if (rows.length === 0) return `<p style="color:#64748b;margin:4px 0">${esc(empty)}</p>`;
  const more = total > rows.length ? `<p style="color:#64748b;font-size:11px;margin:4px 0">Showing ${rows.length} of ${total}. The attached CSV has the full list.</p>` : '';
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px">
<tr>${header.map((h) => `<th style="text-align:left;padding:5px 6px;background:#f1f5f9;border-bottom:1px solid #cbd5e1">${esc(h)}</th>`).join('')}</tr>
${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:4px 6px;border-bottom:1px solid #f1f5f9">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>${more}`;
}

async function context(q: Queryable, tz: string) {
  const identity = await getShopIdentity(q);
  const settings = (await q.query('SELECT pharmacy_name FROM settings ORDER BY updated_at DESC NULLS LAST LIMIT 1')).rows[0];
  const now = (await q.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS t`, [tz])).rows[0].t;
  return { shopLabel: `${settings?.pharmacy_name || 'GIGA CHEMIST'} (${identity.shop_code})`, identity, generatedAt: now };
}

// ---------------------------------------------------------------------------- data
export async function stockLists(q: Queryable = pgPool) {
  const low = await q.query(
    `SELECT name, current_stock::int AS stock, COALESCE(reorder_level, 0)::int AS reorder
       FROM medicines WHERE COALESCE(status, 'active') = 'active' AND current_stock > 0 AND current_stock <= COALESCE(reorder_level, 0)
      ORDER BY current_stock, name`);
  const out = await q.query(
    `SELECT name, current_stock::int AS stock, COALESCE(reorder_level, 0)::int AS reorder
       FROM medicines WHERE COALESCE(status, 'active') = 'active' AND current_stock <= 0 ORDER BY name`);
  return { low: low.rows, out: out.rows };
}

export async function expiryData(date: string, q: Queryable = pgPool) {
  const rows = (await q.query(
    `SELECT m.name, b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry, b.quantity_available::int AS qty,
            (b.expiry_date - $1::date)::int AS days
       FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.quantity_available > 0 AND b.expiry_date IS NOT NULL AND COALESCE(b.status, 'active') <> 'recalled'
        AND b.expiry_date <= $1::date + 90
      ORDER BY b.expiry_date, m.name`, [date])).rows;
  const bucket = (d: number) => (d <= 0 ? 'EXPIRED' : d <= 30 ? '<=30 days' : d <= 60 ? '31-60 days' : '61-90 days');
  const counts = { expired: 0, within30: 0, within60: 0, within90: 0 };
  for (const r of rows) {
    if (r.days <= 0) counts.expired++;
    else if (r.days <= 30) counts.within30++;
    else if (r.days <= 60) counts.within60++;
    else counts.within90++;
    r.bucket = bucket(r.days);
  }
  return { rows, counts };
}

/** Today's stock activity from the immutable inventory ledger (Nairobi business day). */
export async function activityData(date: string, q: Queryable = pgPool) {
  const sold = (await q.query(
    `SELECT COALESCE(SUM(si.quantity), 0)::int AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status <> 'voided' AND s.date = $1::date`, [date])).rows[0].n;
  const m = (await q.query(
    `SELECT
       COALESCE(SUM(adjustment_quantity) FILTER (WHERE reason = 'PURCHASE_RECEIPT'), 0)::int AS received,
       COALESCE(SUM(adjustment_quantity) FILTER (WHERE reason = 'RETURN_APPROVED'), 0)::int AS returned,
       COUNT(*) FILTER (WHERE reason = 'PHYSICAL_STOCK_COUNT')::int AS count_n,
       COALESCE(SUM(adjustment_quantity) FILTER (WHERE reason = 'PHYSICAL_STOCK_COUNT'), 0)::int AS count_net,
       COALESCE(SUM(adjustment_quantity) FILTER (WHERE reason = 'ADD_STOCK' OR (movement_type = 'CORRECTION' AND adjustment_quantity > 0)), 0)::int AS added,
       COALESCE(-SUM(adjustment_quantity) FILTER (WHERE adjustment_quantity < 0 AND movement_type NOT IN ('SALE', 'PHYSICAL_STOCK_COUNT')
                 AND reason NOT IN ('SALE', 'PHYSICAL_STOCK_COUNT')), 0)::int AS removed
       FROM inventory_movements WHERE (created_at AT TIME ZONE 'Africa/Nairobi')::date = $1::date`, [date])).rows[0];
  return {
    unitsSold: sold,
    unitsReceived: m.received,
    returnsToStock: m.returned,
    physicalCounts: m.count_n,
    physicalCountNet: m.count_net,
    manualAdditions: m.added,
    manualRemovals: m.removed,
  };
}

// ---------------------------------------------------------------------------- builders
export async function buildDailyStockEmail(date: string, opts: { includeLowStock: boolean; includeExpiry: boolean; tz: string }, q: Queryable = pgPool): Promise<BuiltEmail> {
  const ctx = await context(q, opts.tz);
  const [counts, lists, expiry, act] = await Promise.all([getStockCounts(q), stockLists(q), expiryData(date, q), activityData(date, q)]);
  let body = kv([['Date', date], ['Shop', ctx.shopLabel], ['Generated', `${ctx.generatedAt} (${opts.tz})`]]);
  body += h2('Summary') + kv([
    ['Total medicines (active)', counts.totalMedicines], ['In stock', counts.inStock], ['Low stock', counts.lowStock], ['Out of stock', counts.outOfStock],
  ]);
  if (opts.includeExpiry) {
    body += h2('Expiry (batches holding stock)') + kv([
      ['Expired', expiry.counts.expired], ['Expiring within 30 days', expiry.counts.within30],
      ['Expiring in 31–60 days', expiry.counts.within60], ['Expiring in 61–90 days', expiry.counts.within90],
    ]);
  }
  body += h2("Today's inventory activity") + kv([
    ['Units sold', act.unitsSold], ['Units received (purchases)', act.unitsReceived], ['Approved returns to stock', act.returnsToStock],
    ['Physical count adjustments', `${act.physicalCounts} (net ${act.physicalCountNet >= 0 ? '+' : ''}${act.physicalCountNet})`],
    ['Manual stock additions', act.manualAdditions], ['Manual stock removals', act.manualRemovals],
  ]);
  if (opts.includeLowStock) {
    body += h2(`Low stock (${lists.low.length})`) + table(['Medicine', 'Current stock', 'Reorder level'],
      lists.low.slice(0, LIST_LIMIT).map((r) => [r.name, r.stock, r.reorder]), lists.low.length, 'No medicine is low on stock.');
    body += h2(`Out of stock (${lists.out.length})`) + table(['Medicine', 'Current stock', 'Reorder level'],
      lists.out.slice(0, LIST_LIMIT).map((r) => [r.name, r.stock, r.reorder]), lists.out.length, 'No medicine is out of stock.');
  }
  if (opts.includeExpiry) {
    body += h2(`Expired / expiring within 90 days (${expiry.rows.length})`) + table(['Medicine', 'Batch', 'Expiry', 'Days', 'Qty', 'Category'],
      expiry.rows.slice(0, LIST_LIMIT).map((r) => [r.name, r.batch_number, r.expiry, r.days, r.qty, r.bucket]), expiry.rows.length, 'No expired or soon-expiring stock.');
  }
  const csvRows: unknown[][] = [];
  for (const r of lists.low) csvRows.push(['LOW_STOCK', r.name, '', r.stock, r.reorder, '', '', '']);
  for (const r of lists.out) csvRows.push(['OUT_OF_STOCK', r.name, '', r.stock, r.reorder, '', '', '']);
  for (const r of expiry.rows) csvRows.push([r.days <= 0 ? 'EXPIRED' : `EXPIRING_${r.bucket.replace(/[^0-9-]/g, '')}`, r.name, r.batch_number, '', '', r.expiry, r.days, r.qty]);
  const csv = toCsv(['Section', 'Medicine', 'Batch', 'Current Stock', 'Reorder Level', 'Expiry Date', 'Days To Expiry', 'Batch Quantity'], csvRows);
  const text = [
    `GIGA CHEMIST — DAILY STOCK REPORT ${date} — ${ctx.shopLabel}`,
    `Medicines ${counts.totalMedicines} | In stock ${counts.inStock} | Low ${counts.lowStock} | Out ${counts.outOfStock}`,
    `Expired ${expiry.counts.expired} | <=30d ${expiry.counts.within30} | 31-60d ${expiry.counts.within60} | 61-90d ${expiry.counts.within90}`,
    `Sold ${act.unitsSold} | Received ${act.unitsReceived} | Returns to stock ${act.returnsToStock} | Counts ${act.physicalCounts} | Added ${act.manualAdditions} | Removed ${act.manualRemovals}`,
    'Full lists in the attached CSV.',
  ].join('\n');
  return {
    subject: `GIGA CHEMIST — Daily Stock Report ${date} (${ctx.identity.shop_code})`,
    html: shell('GIGA CHEMIST — DAILY STOCK REPORT', `${ctx.shopLabel} · ${date}`, body),
    text,
    attachments: [{ filename: `giga-chemist-stock-report-${date}.csv`, contentType: 'text/csv', content: csv }],
  };
}

export async function buildBusinessSummaryEmail(date: string, opts: { tz: string }, q: Queryable = pgPool): Promise<BuiltEmail> {
  const ctx = await context(q, opts.tz);
  const r = await getSalesReport({ range: 'custom', start: date, end: date, today: date }, { includeCost: true }, q);
  let body = kv([['Date', date], ['Shop', ctx.shopLabel], ['Generated', `${ctx.generatedAt} (${opts.tz})`]]);
  body += h2('Sales') + kv([
    ['Gross sales', money(r.grossSales)], ['Approved refunds', money(r.refunds)], ['Net sales', money(r.netSales)],
    ['Cash', money(r.cash)], ['M-Pesa', money(r.mpesa)], ['Discounts given', money(r.discounts)],
    ['Transactions', r.transactionCount], ['Units sold', r.unitsSold], ['Voided sales', `${r.voids.count} (${money(r.voids.total)})`],
  ]);
  body += h2('Costs') + kv([['Expenses', money(r.operatingExpenses)], ['Purchases received', `${r.purchases.count} (${money(r.purchases.total)})`], ['Gross profit', money(r.grossProfit)]]);
  const cashiers = Object.entries(r.cashierStats);
  body += h2('Cashier totals') + table(['Cashier', 'Transactions', 'Gross', 'Refunds', 'Net'],
    cashiers.map(([n, s]) => [n, s.count, money(s.gross), money(s.refunds), money(s.net)]), cashiers.length, 'No sales today.');
  const csv = toCsv(['Cashier', 'Transactions', 'Gross Sales', 'Refunds', 'Net Sales'], cashiers.map(([n, s]) => [n, s.count, s.gross.toFixed(2), s.refunds.toFixed(2), s.net.toFixed(2)]));
  return {
    subject: `GIGA CHEMIST — Daily Business Summary ${date} (${ctx.identity.shop_code})`,
    html: shell('GIGA CHEMIST — DAILY BUSINESS SUMMARY', `${ctx.shopLabel} · ${date}`, body),
    text: `GIGA CHEMIST — DAILY BUSINESS SUMMARY ${date}\nGross ${money(r.grossSales)} | Refunds ${money(r.refunds)} | Net ${money(r.netSales)} | Cash ${money(r.cash)} | M-Pesa ${money(r.mpesa)} | Discounts ${money(r.discounts)} | Expenses ${money(r.operatingExpenses)} | Transactions ${r.transactionCount}`,
    attachments: [{ filename: `giga-chemist-business-summary-${date}.csv`, contentType: 'text/csv', content: csv }],
  };
}

export async function buildExpiryEmail(date: string, opts: { tz: string }, q: Queryable = pgPool): Promise<BuiltEmail> {
  const ctx = await context(q, opts.tz);
  const e = await expiryData(date, q);
  let body = kv([['Week of', date], ['Shop', ctx.shopLabel], ['Generated', `${ctx.generatedAt} (${opts.tz})`]]);
  body += h2('Expiry summary (batches holding stock)') + kv([
    ['Expired', e.counts.expired], ['Expiring within 30 days', e.counts.within30], ['Expiring in 31–60 days', e.counts.within60], ['Expiring in 61–90 days', e.counts.within90],
  ]);
  body += h2('Batches') + table(['Medicine', 'Batch', 'Expiry', 'Days', 'Qty', 'Category'],
    e.rows.slice(0, LIST_LIMIT).map((r) => [r.name, r.batch_number, r.expiry, r.days, r.qty, r.bucket]), e.rows.length, 'No expired or soon-expiring stock.');
  const csv = toCsv(['Category', 'Medicine', 'Batch', 'Expiry Date', 'Days To Expiry', 'Batch Quantity'], e.rows.map((r) => [r.bucket, r.name, r.batch_number, r.expiry, r.days, r.qty]));
  return {
    subject: `GIGA CHEMIST — Weekly Expiry Report ${date} (${ctx.identity.shop_code})`,
    html: shell('GIGA CHEMIST — WEEKLY EXPIRY REPORT', `${ctx.shopLabel} · ${date}`, body),
    text: `GIGA CHEMIST — WEEKLY EXPIRY REPORT ${date}\nExpired ${e.counts.expired} | <=30d ${e.counts.within30} | 31-60d ${e.counts.within60} | 61-90d ${e.counts.within90}`,
    attachments: [{ filename: `giga-chemist-expiry-report-${date}.csv`, contentType: 'text/csv', content: csv }],
  };
}

export async function buildLowStockDigestEmail(date: string, opts: { tz: string }, q: Queryable = pgPool): Promise<BuiltEmail> {
  const ctx = await context(q, opts.tz);
  const lists = await stockLists(q);
  let body = kv([['Date', date], ['Shop', ctx.shopLabel], ['Low stock', lists.low.length], ['Out of stock', lists.out.length]]);
  body += h2('Low stock') + table(['Medicine', 'Current stock', 'Reorder level'], lists.low.slice(0, LIST_LIMIT).map((r) => [r.name, r.stock, r.reorder]), lists.low.length, 'None.');
  body += h2('Out of stock') + table(['Medicine', 'Current stock', 'Reorder level'], lists.out.slice(0, LIST_LIMIT).map((r) => [r.name, r.stock, r.reorder]), lists.out.length, 'None.');
  const csv = toCsv(['Section', 'Medicine', 'Current Stock', 'Reorder Level'], [
    ...lists.low.map((r) => ['LOW_STOCK', r.name, r.stock, r.reorder]), ...lists.out.map((r) => ['OUT_OF_STOCK', r.name, r.stock, r.reorder]),
  ]);
  return {
    subject: `GIGA CHEMIST — Low / Out of Stock ${date} (${ctx.identity.shop_code})`,
    html: shell('GIGA CHEMIST — LOW / OUT-OF-STOCK DIGEST', `${ctx.shopLabel} · ${date}`, body),
    text: `GIGA CHEMIST — LOW / OUT-OF-STOCK ${date}\nLow ${lists.low.length} | Out ${lists.out.length}`,
    attachments: [{ filename: `giga-chemist-low-stock-${date}.csv`, contentType: 'text/csv', content: csv }],
  };
}

export async function buildTestEmail(opts: { tz: string; requestedBy: string }, q: Queryable = pgPool): Promise<BuiltEmail> {
  const ctx = await context(q, opts.tz);
  return {
    subject: `GIGA CHEMIST — Test email (${ctx.identity.shop_code})`,
    html: shell('GIGA CHEMIST — TEST EMAIL', ctx.shopLabel, `<p>Email delivery from the POS server works.</p>${kv([['Requested by', opts.requestedBy], ['Generated', `${ctx.generatedAt} (${opts.tz})`]])}`),
    text: `GIGA CHEMIST test email from ${ctx.shopLabel}, requested by ${opts.requestedBy} at ${ctx.generatedAt}.`,
    attachments: [],
  };
}
