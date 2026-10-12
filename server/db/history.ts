import { HttpError, isValidUuid, type Queryable } from './client';

/**
 * ADMIN TRANSACTION HISTORY (sales + supply/purchases), READ ONLY.
 *
 * One implementation for both places it runs:
 *   local  — the shop server, its own PostgreSQL (one shop: its identity)
 *   cloud  — the online API over giga_cloud, for the shops the REQUEST is authorized for
 *            (one selected shop, or every active shop for a Global Administrator in "All Shops")
 * Each source is a set of derived tables with the SAME column names; every filter, page and summary
 * below is written once against them. `shopIds` is always computed by the server (never taken from the
 * browser), and every relation is restricted to it, so one shop's history cannot leak into another's.
 *
 * Large histories (100k+ sales): filtering, counting, summaries and paging run in PostgreSQL; the
 * browser only ever receives one page (max 100 rows) and the totals. Nothing here writes.
 */
export interface HistoryScope {
  q: Queryable;
  mode: 'local' | 'cloud';
  /** Authorized shops (server-computed). */
  shopIds: string[];
  /** Cost / profit visible (Administrator only). */
  includeCost: boolean;
}

const LOCAL = {
  shops: `(SELECT si.shop_id, si.shop_code, COALESCE(si.shop_name, 'This shop') AS shop_name FROM shop_identity si WHERE si.shop_id = ANY($1::uuid[]))`,
  sales: `(SELECT ($1::uuid[])[1] AS shop_id, s.id, s.sale_number, s.receipt_number, s.cashier_id, COALESCE(user_name_at(s.cashier_id, s.created_at), u.name) AS cashier_name, s.customer_id, s.device_id,
             s.date, s.time::text AS time, s.subtotal, s.discount_total, s.tax_total, s.total, s.cost_total, s.gross_profit, s.payment_method,
             s.payment_reference, s.amount_received, s.change_given, s.status, s.void_reason, s.price_mode, s.created_at,
             s.discount_percent, s.voided_by, vb.name AS voided_by_name, s.shift_id
             FROM sales s LEFT JOIN users u ON u.id = s.cashier_id LEFT JOIN users vb ON vb.id = s.voided_by)`,
  items: `(SELECT ($1::uuid[])[1] AS shop_id, i.id, i.sale_id, i.medicine_id, i.batch_id, i.batch_number, i.expiry_date, i.quantity, i.unit_price,
             i.discount, i.cost_price_snapshot, i.total, i.price_mode FROM sale_items i)`,
  payments: `(SELECT ($1::uuid[])[1] AS shop_id, p.sale_id, p.method, p.amount, p.reference FROM payments p)`,
  customers: `(SELECT ($1::uuid[])[1] AS shop_id, c.id, c.name, c.phone FROM customers c)`,
  medicines: `(SELECT ($1::uuid[])[1] AS shop_id, m.id, m.name, m.generic_name, m.brand_name, m.barcode, m.selling_price, m.wholesale_price FROM medicines m)`,
  returns: `(SELECT ($1::uuid[])[1] AS shop_id, r.id, r.sale_id, r.medicine_id, r.batch_id, r.quantity, r.approved_quantity, r.refund_amount,
             r.requested_refund, r.status, r.reason, r.restocked, r.created_at, r.reviewed_at, COALESCE(rv.name, r.reviewed_by_name) AS reviewed_by_name,
             r.refund_method, r.refund_shift_id
             FROM returns r LEFT JOIN users rv ON rv.id = r.reviewed_by)`,
  purchases: `(SELECT ($1::uuid[])[1] AS shop_id, p.id, p.order_number, p.invoice_number, p.supplier_id, p.order_date, p.received_date,
             COALESCE(p.status, 'received') AS status, p.total_amount, p.payment_status, p.notes, u.name AS received_by, p.created_at
             FROM purchases p LEFT JOIN users u ON u.id = p.created_by)`,
  purchase_items: `(SELECT ($1::uuid[])[1] AS shop_id, i.id, i.purchase_id, i.medicine_id, i.batch_number, i.expiry_date, i.quantity,
             i.purchase_price, i.total FROM purchase_items i)`,
  suppliers: `(SELECT ($1::uuid[])[1] AS shop_id, v.id, v.name FROM suppliers v)`,
  batches: `(SELECT ($1::uuid[])[1] AS shop_id, b.id, b.medicine_id, b.batch_number, b.selling_price_override FROM medicine_batches b)`,
  movements: `(SELECT ($1::uuid[])[1] AS shop_id, mv.id, mv.medicine_id, mv.batch_id, mv.previous_quantity, mv.adjustment_quantity AS delta,
             mv.new_quantity, mv.movement_type, mv.reason, mv.reference_id, mv.notes, mv.created_at AS occurred_at FROM inventory_movements mv)`,
  audit: `(SELECT ($1::uuid[])[1] AS shop_id, a.action, a.entity, a.entity_id, a.user_name, a.created_at AS occurred_at, a.new_value FROM audit_logs a)`,
};

const CLOUD = {
  shops: `(SELECT s.shop_id, s.shop_code, s.name AS shop_name FROM giga_cloud.shops s WHERE s.shop_id = ANY($1::uuid[]))`,
  sales: `(SELECT s.shop_id, s.sale_id AS id, s.sale_number, s.receipt_number, s.cashier_id, COALESCE(s.cashier_name, u.name) AS cashier_name,
             s.customer_id, s.device_id, s.business_date AS date, s.business_time AS time, s.subtotal, s.discount_total, s.tax_total, s.total,
             s.cost_total, s.gross_profit, s.payment_method, s.data->>'payment_reference' AS payment_reference,
             NULLIF(s.data->>'amount_received', '')::numeric AS amount_received, NULLIF(s.data->>'change_given', '')::numeric AS change_given,
             s.status, s.void_reason, s.price_mode, s.created_at_local AS created_at,
             NULLIF(s.data->>'discount_percent', '')::numeric AS discount_percent, s.voided_by, vb.name AS voided_by_name,
             (s.data->>'shift_id')::uuid AS shift_id
             FROM giga_cloud.sales s LEFT JOIN giga_cloud.users u ON u.shop_id = s.shop_id AND u.user_id = s.cashier_id
             LEFT JOIN giga_cloud.users vb ON vb.shop_id = s.shop_id AND vb.user_id = s.voided_by
            WHERE s.shop_id = ANY($1::uuid[]))`,
  items: `(SELECT i.shop_id, i.sale_item_id AS id, i.sale_id, i.medicine_id, i.batch_id, i.batch_number, NULLIF(i.data->>'expiry_date', '')::date AS expiry_date,
             i.quantity, i.unit_price, i.discount, i.cost_price_snapshot, i.total, i.price_mode FROM giga_cloud.sale_items i WHERE i.shop_id = ANY($1::uuid[]))`,
  payments: `(SELECT p.shop_id, p.sale_id, p.method, p.amount, p.reference FROM giga_cloud.payments p WHERE p.shop_id = ANY($1::uuid[]))`,
  customers: `(SELECT c.shop_id, c.customer_id AS id, c.name, c.phone FROM giga_cloud.customers c WHERE c.shop_id = ANY($1::uuid[]))`,
  medicines: `(SELECT m.shop_id, m.medicine_id AS id, m.name, m.data->>'generic_name' AS generic_name, m.data->>'brand_name' AS brand_name, m.barcode,
             m.selling_price, m.wholesale_price FROM giga_cloud.medicines m WHERE m.shop_id = ANY($1::uuid[]))`,
  returns: `(SELECT r.shop_id, r.return_id AS id, r.sale_id, r.medicine_id, r.batch_id, r.quantity, r.approved_quantity, r.refund_amount, r.requested_refund,
             r.status, r.data->>'reason' AS reason, r.restocked, NULLIF(r.data->>'created_at', '')::timestamptz AS created_at, r.reviewed_at,
             COALESCE(rv.name, r.data->>'reviewed_by_name') AS reviewed_by_name,
             r.data->>'refund_method' AS refund_method, (r.data->>'refund_shift_id')::uuid AS refund_shift_id
             FROM giga_cloud.returns r LEFT JOIN giga_cloud.users rv ON rv.shop_id = r.shop_id AND rv.user_id = r.reviewed_by
            WHERE r.shop_id = ANY($1::uuid[]))`,
  purchases: `(SELECT p.shop_id, p.purchase_id AS id, p.order_number, p.invoice_number, p.supplier_id, NULLIF(p.data->>'order_date', '')::date AS order_date,
             p.received_date, COALESCE(p.data->>'status', 'received') AS status, p.total_amount, p.payment_status, p.data->>'notes' AS notes,
             u.name AS received_by, NULLIF(p.data->>'created_at', '')::timestamptz AS created_at
             FROM giga_cloud.purchases p LEFT JOIN giga_cloud.users u ON u.shop_id = p.shop_id AND u.user_id::text = p.data->>'created_by'
            WHERE p.shop_id = ANY($1::uuid[]))`,
  purchase_items: `(SELECT i.shop_id, i.purchase_item_id AS id, i.purchase_id, i.medicine_id, i.batch_number, NULLIF(i.data->>'expiry_date', '')::date AS expiry_date,
             i.quantity, i.purchase_price, i.total FROM giga_cloud.purchase_items i WHERE i.shop_id = ANY($1::uuid[]))`,
  suppliers: `(SELECT v.shop_id, v.supplier_id AS id, v.name FROM giga_cloud.suppliers v WHERE v.shop_id = ANY($1::uuid[]))`,
  batches: `(SELECT b.shop_id, b.batch_id AS id, b.medicine_id, b.batch_number, NULLIF(b.data->>'selling_price_override', '')::numeric AS selling_price_override
             FROM giga_cloud.medicine_batches b WHERE b.shop_id = ANY($1::uuid[]))`,
  movements: `(SELECT mv.shop_id, mv.movement_id AS id, mv.medicine_id, mv.batch_id, mv.previous_quantity, mv.delta, mv.new_quantity, mv.movement_type,
             mv.reason, mv.reference_id, mv.notes, mv.occurred_at FROM giga_cloud.inventory_movements mv WHERE mv.shop_id = ANY($1::uuid[]))`,
  audit: `(SELECT a.shop_id, a.action, a.entity, a.entity_id, a.user_name, a.occurred_at, a.new_value FROM giga_cloud.audit_events a WHERE a.shop_id = ANY($1::uuid[]))`,
};

type Rel = typeof LOCAL;
const rel = (s: HistoryScope): Rel => (s.mode === 'local' ? LOCAL : CLOUD);

export const PAGE_SIZES = [25, 50, 100] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

/** Internal (export) callers may page in larger steps; browser requests get 25 / 50 / 100 only. */
interface Opts { exportPageSize?: number; summary?: boolean }
function paging(query: Record<string, unknown>, opts: Opts = {}) {
  const size = opts.exportPageSize || (PAGE_SIZES.includes(Number(query.page_size) as any) ? Number(query.page_size) : 25);
  const page = Math.max(1, Math.min(100_000, Math.floor(Number(query.page) || 1)));
  return { size, page, offset: (page - 1) * size };
}

/** Builds WHERE conditions with numbered parameters; $1 is always the authorized shop list. */
class Where {
  conds: string[] = [];
  params: unknown[];
  constructor(shopIds: string[]) {
    this.params = [shopIds];
  }
  add(sql: (p: string) => string, value: unknown) {
    this.params.push(value);
    this.conds.push(sql(`$${this.params.length}`));
  }
  raw(sql: string) {
    this.conds.push(sql);
  }
  get sql() {
    return this.conds.length ? `WHERE ${this.conds.join(' AND ')}` : '';
  }
}

/** All-shops narrowing to ONE of the authorized shops (never widens the authorization). */
function shopFilter(w: Where, scope: HistoryScope, alias: string, query: Record<string, unknown>) {
  const shop = str(query.shop_id, 64).toLowerCase();
  if (!shop || shop === 'all') return;
  if (!isValidUuid(shop) || !scope.shopIds.includes(shop)) throw new HttpError(403, 'Forbidden: that shop is not in your history scope.');
  w.add((p) => `${alias}.shop_id = ${p}::uuid`, shop);
}

function dateRange(w: Where, expr: string, query: Record<string, unknown>) {
  const from = str(query.from, 10), to = str(query.to, 10);
  if (from && !DATE_RE.test(from)) throw new HttpError(400, 'from must be YYYY-MM-DD.');
  if (to && !DATE_RE.test(to)) throw new HttpError(400, 'to must be YYYY-MM-DD.');
  if (from) w.add((p) => `${expr} >= ${p}::date`, from);
  if (to) w.add((p) => `${expr} <= ${p}::date`, to);
}

// ============================================================================ SALES
function salesWhere(scope: HistoryScope, query: Record<string, unknown>) {
  const R = rel(scope);
  const w = new Where(scope.shopIds);
  shopFilter(w, scope, 's', query);
  dateRange(w, 's.date', query);
  const cashier = str(query.cashier, 64);
  if (cashier) {
    if (!isValidUuid(cashier)) throw new HttpError(400, 'cashier must be a staff id.');
    w.add((p) => `s.cashier_id = ${p}::uuid`, cashier);
  }
  const customer = str(query.customer);
  if (customer) {
    if (isValidUuid(customer)) w.add((p) => `s.customer_id = ${p}::uuid`, customer);
    else w.add((p) => `(s.shop_id, s.customer_id) IN (SELECT c.shop_id, c.id FROM ${R.customers} c WHERE c.name ILIKE ${p} OR c.phone ILIKE ${p})`, like(customer));
  }
  const method = str(query.payment_method, 40);
  if (method) w.add((p) => `(lower(s.payment_method) = lower(${p}) OR (s.shop_id, s.id) IN (SELECT x.shop_id, x.sale_id FROM ${R.payments} x WHERE lower(x.method) = lower(${p})))`, method);
  const status = str(query.status, 100).toLowerCase();
  if (status) w.add((p) => `lower(s.status) = ANY(string_to_array(${p}, ','))`, status);
  const mode = str(query.price_mode, 20).toUpperCase();
  if (mode) {
    if (!['RETAIL', 'WHOLESALE'].includes(mode)) throw new HttpError(400, 'price_mode must be RETAIL or WHOLESALE.');
    w.add((p) => `COALESCE(upper(s.price_mode), 'RETAIL') = ${p}`, mode);
  }
  // One cashier shift (Shift detail -> "View sales of this shift").
  const shift = str(query.shift_id, 64);
  if (shift) {
    if (!isValidUuid(shift)) throw new HttpError(400, 'shift_id must be a UUID.');
    w.add((p) => `s.shift_id = ${p}::uuid`, shift);
  }
  const receipt = str(query.receipt, 60);
  if (receipt) w.add((p) => `(s.receipt_number ILIKE ${p} OR s.sale_number ILIKE ${p})`, like(receipt));
  // Exact medicine (Stock History -> "View sales": the receipts behind one day's Sold figure).
  const medicineId = str(query.medicine_id, 64);
  if (medicineId) {
    if (!isValidUuid(medicineId)) throw new HttpError(400, 'medicine_id must be a UUID.');
    w.add((p) => `(s.shop_id, s.id) IN (SELECT i.shop_id, i.sale_id FROM ${R.items} i WHERE i.medicine_id = ${p}::uuid)`, medicineId);
  }
  const medicine = str(query.medicine);
  if (medicine) {
    w.add((p) => `(s.shop_id, s.id) IN (SELECT i.shop_id, i.sale_id FROM ${R.items} i WHERE (i.shop_id, i.medicine_id) IN
                    (SELECT m.shop_id, m.id FROM ${R.medicines} m WHERE m.name ILIKE ${p} OR m.barcode ILIKE ${p}))`, like(medicine));
  }
  const q = str(query.q);
  if (q) {
    w.add((p) => `(s.receipt_number ILIKE ${p} OR s.sale_number ILIKE ${p} OR s.cashier_name ILIKE ${p}
                    OR (s.shop_id, s.customer_id) IN (SELECT c.shop_id, c.id FROM ${R.customers} c WHERE c.name ILIKE ${p} OR c.phone ILIKE ${p})
                    OR (s.shop_id, s.id) IN (SELECT i.shop_id, i.sale_id FROM ${R.items} i WHERE (i.shop_id, i.medicine_id) IN
                         (SELECT m.shop_id, m.id FROM ${R.medicines} m WHERE m.name ILIKE ${p} OR m.barcode ILIKE ${p})))`, like(q));
  }
  return w;
}

export async function salesHistory(scope: HistoryScope, query: Record<string, unknown>, opts: Opts = {}) {
  const R = rel(scope);
  const { size, page, offset } = paging(query, opts);
  const w = salesWhere(scope, query);
  const n = w.params.length;
  const list = await scope.q.query(
    `SELECT s.*, sh.shop_code, sh.shop_name, c.name AS customer_name,
            (SELECT COUNT(*)::int FROM ${R.items} i WHERE i.shop_id = s.shop_id AND i.sale_id = s.id) AS item_count,
            (SELECT COALESCE(SUM(i.quantity), 0)::int FROM ${R.items} i WHERE i.shop_id = s.shop_id AND i.sale_id = s.id) AS units
       FROM ${R.sales} s
       LEFT JOIN ${R.shops} sh ON sh.shop_id = s.shop_id
       LEFT JOIN ${R.customers} c ON c.shop_id = s.shop_id AND c.id = s.customer_id
       ${w.sql}
      ORDER BY s.date DESC NULLS LAST, s.time DESC NULLS LAST, s.id DESC
      LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...w.params, size, offset]
  );
  const rows = list.rows.map((r: any) => saleRow(r, scope.includeCost));
  if (opts.summary === false) return { page, page_size: size, total: null, pages: null, summary: null, rows };
  const summary = await salesSummary(scope, w);
  return { page, page_size: size, total: summary.transactions, pages: Math.max(1, Math.ceil(summary.transactions / size)), summary, rows };
}

function saleRow(r: any, cost: boolean) {
  return {
    id: r.id, shop_id: r.shop_id, shop_code: r.shop_code ?? null, shop_name: r.shop_name ?? null,
    date: r.date, time: r.time ? String(r.time).slice(0, 8) : null, receipt_number: r.receipt_number, sale_number: r.sale_number,
    cashier_id: r.cashier_id, cashier_name: r.cashier_name ?? null, customer_id: r.customer_id, customer_name: r.customer_name ?? null,
    item_count: Number(r.item_count) || 0, units: Number(r.units) || 0, price_mode: r.price_mode || 'RETAIL',
    subtotal: num(r.subtotal), discount_total: num(r.discount_total), tax_total: num(r.tax_total), total: num(r.total),
    discount_percent: r.discount_percent === null || r.discount_percent === undefined ? null : num(r.discount_percent),
    payment_method: r.payment_method, payment_reference: r.payment_reference ?? null, status: r.status, void_reason: r.void_reason ?? null,
    device_id: r.device_id ?? null, shift_id: r.shift_id ?? null,
    ...(cost ? { cost_total: num(r.cost_total), gross_profit: num(r.gross_profit) } : {}),
  };
}

async function salesSummary(scope: HistoryScope, w: Where) {
  const R = rel(scope);
  const base = `SELECT s.shop_id, s.id, s.subtotal, s.discount_total, s.total, s.cost_total, s.gross_profit, s.status FROM ${R.sales} s ${w.sql}`;
  // One pass over each table: sales aggregate, payments by kind, approved refunds (joined per shop).
  const per = (await scope.q.query(
    `WITH f AS (${base}),
     agg AS (
       SELECT f.shop_id, COUNT(*)::int AS transactions,
              COUNT(*) FILTER (WHERE lower(f.status) = 'voided')::int AS voided,
              COALESCE(SUM(f.subtotal) FILTER (WHERE lower(f.status) <> 'voided'), 0)::float AS gross,
              COALESCE(SUM(f.discount_total) FILTER (WHERE lower(f.status) <> 'voided'), 0)::float AS discounts,
              COALESCE(SUM(f.total) FILTER (WHERE lower(f.status) <> 'voided'), 0)::float AS net,
              COALESCE(SUM(f.gross_profit) FILTER (WHERE lower(f.status) <> 'voided'), 0)::float AS profit,
              COALESCE(SUM(f.cost_total) FILTER (WHERE lower(f.status) <> 'voided'), 0)::float AS cost
         FROM f GROUP BY f.shop_id),
     units AS (
       SELECT x.shop_id, COALESCE(SUM(i.quantity), 0)::bigint AS units
         FROM ${R.items} i JOIN f x ON x.shop_id = i.shop_id AND x.id = i.sale_id
        WHERE lower(x.status) <> 'voided' AND i.quantity > 0 GROUP BY x.shop_id),
     pay AS (
       SELECT x.shop_id,
              COALESCE(SUM(p.amount) FILTER (WHERE lower(p.method) = 'cash'), 0)::float AS cash,
              COALESCE(SUM(p.amount) FILTER (WHERE replace(replace(lower(p.method), '-', ''), ' ', '') IN ('mpesa', 'mobilemoney', 'mobile')), 0)::float AS mobile,
              COALESCE(SUM(p.amount), 0)::float AS paid
         FROM ${R.payments} p JOIN f x ON x.shop_id = p.shop_id AND x.id = p.sale_id
        WHERE lower(x.status) <> 'voided' GROUP BY x.shop_id),
     ref AS (
       SELECT x.shop_id, COALESCE(SUM(r.refund_amount), 0)::float AS refunds
         FROM ${R.returns} r JOIN f x ON x.shop_id = r.shop_id AND x.id = r.sale_id
        WHERE r.status = 'APPROVED' GROUP BY x.shop_id)
     SELECT agg.*, COALESCE(pay.cash, 0) AS cash, COALESCE(pay.mobile, 0) AS mobile, COALESCE(pay.paid, 0) AS paid, COALESCE(ref.refunds, 0) AS refunds,
            COALESCE(units.units, 0) AS units
       FROM agg LEFT JOIN pay ON pay.shop_id = agg.shop_id LEFT JOIN ref ON ref.shop_id = agg.shop_id LEFT JOIN units ON units.shop_id = agg.shop_id`,
    w.params
  )).rows;
  const shops = new Map((await scope.q.query(`SELECT * FROM ${R.shops} sh`, [scope.shopIds])).rows.map((x: any) => [x.shop_id, x]));
  const round = (v: number) => Math.round(v * 100) / 100;
  const byShop = per.map((x: any) => ({
    shop_id: x.shop_id, shop_code: shops.get(x.shop_id)?.shop_code ?? null, shop_name: shops.get(x.shop_id)?.shop_name ?? null,
    transactions: x.transactions, voided: x.voided, units_sold: Number(x.units), gross_sales: round(x.gross), discounts: round(x.discounts), net_sales: round(x.net),
    cash: round(x.cash), mobile_money: round(x.mobile), other_payments: round(x.paid - x.cash - x.mobile), refunds: round(x.refunds),
    ...(scope.includeCost ? { cost_of_goods: round(x.cost), gross_profit: round(x.profit) } : {}),
  }));
  const sum = (k: string) => round(byShop.reduce((t: number, x: any) => t + (Number(x[k]) || 0), 0));
  return {
    transactions: byShop.reduce((t: number, x: any) => t + x.transactions, 0),
    voided: byShop.reduce((t: number, x: any) => t + x.voided, 0),
    units_sold: byShop.reduce((t: number, x: any) => t + x.units_sold, 0),
    gross_sales: sum('gross_sales'), discounts: sum('discounts'), net_sales: sum('net_sales'), cash: sum('cash'),
    mobile_money: sum('mobile_money'), other_payments: sum('other_payments'), refunds: sum('refunds'),
    ...(scope.includeCost ? { cost_of_goods: sum('cost_of_goods'), gross_profit: sum('gross_profit') } : {}),
    by_shop: byShop,
  };
}

/**
 * One sale EXACTLY as stored at the time of sale: sale_items quantity / unit_price / discount / total /
 * price_mode / batch, the sale's own subtotal / discount / tax / total / payments. Nothing is derived from
 * today's medicine prices. `expectShopId` (All Shops: the row's shop) must match the sale's real shop.
 */
export async function saleDetail(scope: HistoryScope, saleId: string, expectShopId?: string | null) {
  if (!isValidUuid(saleId)) throw new HttpError(400, 'Sale id must be a UUID.');
  if (expectShopId && (!isValidUuid(expectShopId) || !scope.shopIds.includes(expectShopId.toLowerCase()))) {
    throw new HttpError(403, 'Forbidden: that shop is not in your history scope.');
  }
  const R = rel(scope);
  const head = (await scope.q.query(
    `SELECT s.*, sh.shop_code, sh.shop_name, c.name AS customer_name, c.phone AS customer_phone
       FROM ${R.sales} s LEFT JOIN ${R.shops} sh ON sh.shop_id = s.shop_id
       LEFT JOIN ${R.customers} c ON c.shop_id = s.shop_id AND c.id = s.customer_id
      WHERE s.id = $2::uuid AND ($3::uuid IS NULL OR s.shop_id = $3::uuid)`, [scope.shopIds, saleId, expectShopId || null])).rows[0];
  if (!head) throw new HttpError(404, 'Sale not found in your history scope.');
  const p = [scope.shopIds, saleId, head.shop_id];
  const items = (await scope.q.query(
    `SELECT i.*, m.name AS medicine_name, m.generic_name, m.brand_name, m.barcode FROM ${R.items} i LEFT JOIN ${R.medicines} m ON m.shop_id = i.shop_id AND m.id = i.medicine_id
      WHERE i.sale_id = $2::uuid AND i.shop_id = $3::uuid ORDER BY m.name NULLS LAST, i.id`, p)).rows;
  const payments = (await scope.q.query(`SELECT method, amount, reference FROM ${R.payments} p WHERE p.sale_id = $2::uuid AND p.shop_id = $3::uuid ORDER BY method`, p)).rows;
  const returns = (await scope.q.query(
    `SELECT r.*, m.name AS medicine_name FROM ${R.returns} r LEFT JOIN ${R.medicines} m ON m.shop_id = r.shop_id AND m.id = r.medicine_id
      WHERE r.sale_id = $2::uuid AND r.shop_id = $3::uuid ORDER BY r.created_at`, p)).rows;
  const audit = (await scope.q.query(
    `SELECT a.action, a.user_name, a.occurred_at FROM ${R.audit} a
      WHERE a.shop_id = $3::uuid AND (a.entity_id = $2::text OR a.entity_id IN (SELECT r.id::text FROM ${R.returns} r WHERE r.sale_id = $2::uuid AND r.shop_id = $3::uuid))
      ORDER BY a.occurred_at LIMIT 100`, p)).rows;
  const cost = scope.includeCost;
  // Per sold line (medicine + batch): quantities returned by APPROVED returns and still PENDING.
  const lineKey = (m: unknown, b: unknown) => `${m}|${b}`;
  const approved = new Map<string, number>(), pending = new Map<string, number>(), sold = new Map<string, number>();
  for (const r of returns) {
    const k = lineKey(r.medicine_id, r.batch_id);
    if (r.status === 'APPROVED') approved.set(k, (approved.get(k) || 0) + Number(r.approved_quantity || 0));
    if (r.status === 'PENDING') pending.set(k, (pending.get(k) || 0) + Number(r.quantity || 0));
  }
  for (const i of items) sold.set(lineKey(i.medicine_id, i.batch_id), (sold.get(lineKey(i.medicine_id, i.batch_id)) || 0) + Number(i.quantity));
  const voidAudit = audit.find((a: any) => a.action === 'SALE_VOIDED');
  const totalPaid = payments.reduce((t: number, x: any) => t + Number(x.amount || 0), 0);
  const isVoided = String(head.status).toLowerCase() === 'voided';
  return {
    sale: {
      ...saleRow(head, cost), customer_phone: head.customer_phone ?? null, amount_received: num(head.amount_received), change_given: num(head.change_given),
      created_at: head.created_at, walk_in: !head.customer_id,
    },
    items: items.map((i: any) => {
      const k = lineKey(i.medicine_id, i.batch_id);
      const share = Number(i.quantity) / (sold.get(k) || Number(i.quantity) || 1);
      const returned = Math.round((approved.get(k) || 0) * share);
      return {
        medicine_id: i.medicine_id, batch_id: i.batch_id ?? null, medicine_name: i.medicine_name || 'Item', generic_name: i.generic_name ?? null, brand_name: i.brand_name ?? null,
        barcode: i.barcode ?? null, batch_number: i.batch_number, expiry_date: i.expiry_date ?? null,
        quantity: Number(i.quantity), returned_quantity: returned, pending_return_quantity: Math.round((pending.get(k) || 0) * share),
        net_quantity: isVoided ? 0 : Number(i.quantity) - returned,
        unit_price: num(i.unit_price), price_mode: i.price_mode || head.price_mode || 'RETAIL', discount: num(i.discount), total: num(i.total),
        ...(cost ? { cost_price_snapshot: num(i.cost_price_snapshot), profit: num(Number(i.total) - Number(i.cost_price_snapshot || 0) * Number(i.quantity)) } : {}),
      };
    }),
    quantities: {
      different_medicines: new Set(items.map((i: any) => i.medicine_id)).size,
      total_units: items.reduce((t: number, i: any) => t + Number(i.quantity), 0),
      returned_units: [...approved.values()].reduce((t, n) => t + n, 0),
      net_units: isVoided ? 0 : items.reduce((t: number, i: any) => t + Number(i.quantity), 0) - [...approved.values()].reduce((t, n) => t + n, 0),
    },
    payments: payments.map((x: any) => ({ method: x.method, amount: num(x.amount), reference: x.reference ?? null })),
    total_paid: num(totalPaid),
    returns: returns.map((r: any) => ({
      id: r.id, medicine_name: r.medicine_name || 'Item', original_quantity: sold.get(lineKey(r.medicine_id, r.batch_id)) ?? null,
      quantity: Number(r.quantity), approved_quantity: r.approved_quantity ?? null, status: r.status,
      reason: r.reason ?? null, requested_refund: num(r.requested_refund), refund_amount: num(r.refund_amount), restocked: r.restocked ?? null,
      created_at: r.created_at, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by_name ?? null,
      refund_method: r.refund_method ?? null, refund_shift_id: r.refund_shift_id ?? null,
    })),
    void: isVoided ? { reason: head.void_reason ?? null, voided_by: head.voided_by_name ?? voidAudit?.user_name ?? null, voided_at: voidAudit?.occurred_at ?? null } : null,
    audit: audit.map((a: any) => ({ action: a.action, by: a.user_name, at: a.occurred_at })),
  };
}

// ============================================================================ SUPPLY / PURCHASES
function suppliesWhere(scope: HistoryScope, query: Record<string, unknown>) {
  const R = rel(scope);
  const w = new Where(scope.shopIds);
  shopFilter(w, scope, 'p', query);
  dateRange(w, 'COALESCE(p.received_date, p.order_date)', query);
  const supplier = str(query.supplier, 100);
  if (supplier) {
    if (isValidUuid(supplier)) w.add((x) => `p.supplier_id = ${x}::uuid`, supplier);
    else w.add((x) => `(p.shop_id, p.supplier_id) IN (SELECT v.shop_id, v.id FROM ${R.suppliers} v WHERE v.name ILIKE ${x})`, like(supplier));
  }
  const invoice = str(query.invoice, 100);
  if (invoice) w.add((x) => `p.invoice_number ILIKE ${x}`, like(invoice));
  const order = str(query.order, 100);
  if (order) w.add((x) => `p.order_number ILIKE ${x}`, like(order));
  const status = str(query.status, 40).toLowerCase();
  if (status) w.add((x) => `lower(p.status) = ${x}`, status);
  const pay = str(query.payment_status, 20).toLowerCase();
  if (pay) w.add((x) => `lower(p.payment_status) = ${x}`, pay);
  const medicineId = str(query.medicine_id, 64);
  if (medicineId) {
    if (!isValidUuid(medicineId)) throw new HttpError(400, 'medicine_id must be a UUID.');
    w.add((x) => `(p.shop_id, p.id) IN (SELECT i.shop_id, i.purchase_id FROM ${R.purchase_items} i WHERE i.medicine_id = ${x}::uuid)`, medicineId);
  }
  const medicine = str(query.medicine);
  if (medicine) {
    w.add((x) => `(p.shop_id, p.id) IN (SELECT i.shop_id, i.purchase_id FROM ${R.purchase_items} i WHERE (i.shop_id, i.medicine_id) IN
                   (SELECT m.shop_id, m.id FROM ${R.medicines} m WHERE m.name ILIKE ${x} OR m.barcode ILIKE ${x}))`, like(medicine));
  }
  const batch = str(query.batch, 100);
  if (batch) w.add((x) => `(p.shop_id, p.id) IN (SELECT i.shop_id, i.purchase_id FROM ${R.purchase_items} i WHERE i.batch_number ILIKE ${x})`, like(batch));
  const q = str(query.q);
  if (q) {
    w.add((x) => `(p.order_number ILIKE ${x} OR p.invoice_number ILIKE ${x}
                   OR (p.shop_id, p.supplier_id) IN (SELECT v.shop_id, v.id FROM ${R.suppliers} v WHERE v.name ILIKE ${x})
                   OR (p.shop_id, p.id) IN (SELECT i.shop_id, i.purchase_id FROM ${R.purchase_items} i WHERE i.batch_number ILIKE ${x}
                        OR (i.shop_id, i.medicine_id) IN (SELECT m.shop_id, m.id FROM ${R.medicines} m WHERE m.name ILIKE ${x} OR m.barcode ILIKE ${x})))`, like(q));
  }
  return w;
}

export async function supplyHistory(scope: HistoryScope, query: Record<string, unknown>, opts: Opts = {}) {
  const R = rel(scope);
  const { size, page, offset } = paging(query, opts);
  const w = suppliesWhere(scope, query);
  const n = w.params.length;
  const list = await scope.q.query(
    `SELECT p.*, sh.shop_code, sh.shop_name, v.name AS supplier_name,
            (SELECT COUNT(*)::int FROM ${R.purchase_items} i WHERE i.shop_id = p.shop_id AND i.purchase_id = p.id) AS item_count,
            (SELECT COALESCE(SUM(i.quantity), 0)::int FROM ${R.purchase_items} i WHERE i.shop_id = p.shop_id AND i.purchase_id = p.id) AS units
       FROM ${R.purchases} p
       LEFT JOIN ${R.shops} sh ON sh.shop_id = p.shop_id
       LEFT JOIN ${R.suppliers} v ON v.shop_id = p.shop_id AND v.id = p.supplier_id
       ${w.sql}
      ORDER BY COALESCE(p.received_date, p.order_date) DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC
      LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...w.params, size, offset]
  );
  const rows = list.rows.map((r: any) => ({
    id: r.id, shop_id: r.shop_id, shop_code: r.shop_code ?? null, shop_name: r.shop_name ?? null,
    received_date: r.received_date ?? null, order_date: r.order_date ?? null, order_number: r.order_number, invoice_number: r.invoice_number ?? null,
    supplier_id: r.supplier_id, supplier_name: r.supplier_name ?? null, item_count: Number(r.item_count) || 0, units: Number(r.units) || 0,
    total_amount: num(r.total_amount), payment_status: r.payment_status ?? null, status: r.status, received_by: r.received_by ?? null,
    reference: r.notes ?? null,
  }));
  if (opts.summary === false) return { page, page_size: size, total: null, pages: null, summary: null, rows };
  const sums = (await scope.q.query(
    `WITH f AS (SELECT p.shop_id, p.id, p.supplier_id, p.total_amount, p.status FROM ${R.purchases} p ${w.sql})
     SELECT f.shop_id, COUNT(*)::int AS supplies,
            COALESCE((SELECT SUM(i.quantity) FROM ${R.purchase_items} i JOIN f x ON x.shop_id = i.shop_id AND x.id = i.purchase_id WHERE x.shop_id = f.shop_id), 0)::int AS units,
            COALESCE(SUM(f.total_amount), 0)::float AS value,
            COUNT(DISTINCT f.supplier_id)::int AS suppliers
       FROM f GROUP BY f.shop_id`, w.params)).rows;
  const shops = new Map((await scope.q.query(`SELECT * FROM ${R.shops} sh`, [scope.shopIds])).rows.map((x: any) => [x.shop_id, x]));
  const byShop = sums.map((x: any) => ({
    shop_id: x.shop_id, shop_code: shops.get(x.shop_id)?.shop_code ?? null, shop_name: shops.get(x.shop_id)?.shop_name ?? null,
    supplies: x.supplies, units_received: x.units, purchase_value: Math.round(x.value * 100) / 100, suppliers_used: x.suppliers,
  }));
  const supplies = byShop.reduce((t: number, x: any) => t + x.supplies, 0);
  const suppliersUsed = (await scope.q.query(
    `SELECT COUNT(DISTINCT (p.shop_id, p.supplier_id))::int AS n FROM ${R.purchases} p ${w.sql}`, w.params)).rows[0].n;
  return {
    page, page_size: size, total: supplies, pages: Math.max(1, Math.ceil(supplies / size)),
    summary: {
      supplies,
      units_received: byShop.reduce((t: number, x: any) => t + x.units_received, 0),
      purchase_value: Math.round(byShop.reduce((t: number, x: any) => t + x.purchase_value, 0) * 100) / 100,
      suppliers_used: suppliersUsed,
      by_shop: byShop,
    },
    rows,
  };
}

export async function supplyDetail(scope: HistoryScope, purchaseId: string) {
  if (!isValidUuid(purchaseId)) throw new HttpError(400, 'Purchase id must be a UUID.');
  const R = rel(scope);
  const head = (await scope.q.query(
    `SELECT p.*, sh.shop_code, sh.shop_name, v.name AS supplier_name FROM ${R.purchases} p
       LEFT JOIN ${R.shops} sh ON sh.shop_id = p.shop_id LEFT JOIN ${R.suppliers} v ON v.shop_id = p.shop_id AND v.id = p.supplier_id
      WHERE p.id = $2::uuid`, [scope.shopIds, purchaseId])).rows[0];
  if (!head) throw new HttpError(404, 'Purchase not found in your history scope.');
  const p = [scope.shopIds, purchaseId, head.shop_id];
  const items = (await scope.q.query(
    `SELECT i.*, m.name AS medicine_name, m.barcode, m.selling_price, m.wholesale_price, b.selling_price_override
       FROM ${R.purchase_items} i
       LEFT JOIN ${R.medicines} m ON m.shop_id = i.shop_id AND m.id = i.medicine_id
       LEFT JOIN ${R.batches} b ON b.shop_id = i.shop_id AND b.medicine_id = i.medicine_id AND upper(b.batch_number) = upper(i.batch_number)
      WHERE i.purchase_id = $2::uuid AND i.shop_id = $3::uuid ORDER BY m.name NULLS LAST, i.id`, p)).rows;
  const movements = head.order_number ? (await scope.q.query(
    `SELECT mv.*, m.name AS medicine_name FROM ${R.movements} mv LEFT JOIN ${R.medicines} m ON m.shop_id = mv.shop_id AND m.id = mv.medicine_id
      WHERE mv.shop_id = $2::uuid AND mv.reference_id = $3 ORDER BY mv.occurred_at, mv.id LIMIT 500`, [scope.shopIds, head.shop_id, head.order_number])).rows : [];
  return {
    purchase: {
      id: head.id, shop_id: head.shop_id, shop_code: head.shop_code ?? null, shop_name: head.shop_name ?? null, order_number: head.order_number,
      invoice_number: head.invoice_number ?? null, supplier_id: head.supplier_id, supplier_name: head.supplier_name ?? null,
      order_date: head.order_date ?? null, received_date: head.received_date ?? null, received_by: head.received_by ?? null,
      payment_status: head.payment_status ?? null, status: head.status, total_amount: num(head.total_amount), notes: head.notes ?? null,
    },
    items: items.map((i: any) => ({
      medicine_id: i.medicine_id, medicine_name: i.medicine_name || 'Item', barcode: i.barcode ?? null, batch_number: i.batch_number,
      expiry_date: i.expiry_date ?? null, quantity: Number(i.quantity), purchase_price: num(i.purchase_price), total: num(i.total),
      // Selling prices are NOT recorded on a purchase: these are the batch override / medicine prices as they are now.
      batch_selling_override: num(i.selling_price_override), current_selling_price: num(i.selling_price), current_wholesale_price: num(i.wholesale_price),
    })),
    movements: movements.map((m: any) => ({
      medicine_name: m.medicine_name || 'Item', movement_type: m.movement_type, previous_quantity: m.previous_quantity, delta: m.delta,
      new_quantity: m.new_quantity, occurred_at: m.occurred_at, notes: m.notes ?? null,
    })),
  };
}

// ============================================================================ CSV export
const csvCell = (v: unknown) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
/** Filtered history as CSV (same filters as the screen), capped so one export cannot exhaust the server. */
export const EXPORT_MAX_ROWS = 50_000;
export async function historyCsv(scope: HistoryScope, kind: 'sales' | 'supplies', query: Record<string, unknown>): Promise<string> {
  const rows: any[] = [];
  const opts = { exportPageSize: 1000, summary: false };
  for (let page = 1; rows.length < EXPORT_MAX_ROWS; page++) {
    const r = kind === 'sales' ? await salesHistory(scope, { ...query, page }, opts) : await supplyHistory(scope, { ...query, page }, opts);
    rows.push(...r.rows);
    if (r.rows.length < 1000) break;
  }
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]).filter((k) => !k.endsWith('_id') || k === 'shop_id');
  return [cols.join(','), ...rows.slice(0, EXPORT_MAX_ROWS).map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
}
