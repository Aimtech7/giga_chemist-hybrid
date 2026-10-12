import { HttpError, isValidUuid } from './client';
import type { HistoryScope } from './history';

/**
 * DAILY STOCK HISTORY (History -> Stock History), READ ONLY.
 *
 * Per business day (Africa/Nairobi) and medicine: opening stock, gross sold, restocked returns, net sold,
 * received, other adjustments and END-OF-DAY remaining stock. One implementation for the shop server
 * (local PostgreSQL) and the online API (giga_cloud copy), like the sales / supply history.
 *
 * Where the numbers come from
 *  - Opening / closing: ONLY the inventory movement ledger. A batch's quantity at an instant is the
 *    new_quantity of its last movement at or before it. Today's stock (medicines.current_stock) is never
 *    used for a past day.
 *  - Every batch has an ANCHOR: the instant from which this ledger holds every change of that batch.
 *      local : the batch's creation in this system. Batches IMPORTED with history from the old system
 *              (movements dated before the batch was created, carrying only deltas: previous = new = 0)
 *              have no provable balance before the anchor.
 *      cloud : the shop's MEDICINE_BASELINE event (sync start); batches created later anchor at creation.
 *    Before the anchor a batch is either 0 (it did not exist yet) or UNKNOWN (it existed outside this
 *    ledger). A day touching UNKNOWN shows INCOMPLETE STOCK HISTORY with sales only — never a guess.
 *  - Gross sold: sale_items of valid sales on that business date (voided sales excluded).
 *  - Received: PURCHASE movements (supplier receipts + stock added). Returned: RETURN_APPROVED movements
 *    (restocked only; approved-not-restocked moves 0, pending / rejected returns move nothing).
 *  - Adjustments: every other movement (physical count, correction, damage, expiry, loss, supplier
 *    return, void reversal...), itemised; plus stock taken by sales that were later voided.
 *  - The day must reconcile: opening - sold + returned + received + adjustments = closing. If the stored
 *    ledger does not add up the row is flagged (MISMATCH) and nothing is corrected.
 *  - The cloud stock REBASE (CLOUD_STOCK_REBASE_FROM_PC2) reset the cloud's stock_levels only; it is not a
 *    movement and does not change these figures. It is reported as a boundary on its day.
 *
 * Quantities only: no cost, price, valuation or profit field is ever returned (cashier-safe).
 */
export const TZ = 'Africa/Nairobi';
export const MAX_RANGE_DAYS = 62;
export const STOCK_PAGE_SIZES = [50, 100, 250, 500] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------- per-source relations
// Same column names in both modes. $1 is always the authorized shop list (server-computed).
interface Rel {
  shops: string;
  medicines: string;
  anchors: string;
  moves: string;
  /** Movement belongs to the batch's provable ledger (at / after its anchor). Aliases: x = move, a = anchor. */
  post: string;
  sales: string;
  items: string;
  users: string;
  boundaries: string;
}

const LOCAL: Rel = {
  shops: `(SELECT si.shop_id, si.shop_code, COALESCE(si.shop_name, 'This shop') AS shop_name FROM shop_identity si WHERE si.shop_id = ANY($1::uuid[]))`,
  medicines: `(SELECT ($1::uuid[])[1] AS shop_id, m.id, m.name, m.generic_name, m.brand_name, m.barcode, m.sku, COALESCE(m.status, 'active') AS status FROM medicines m)`,
  anchors: `(SELECT ($1::uuid[])[1] AS shop_id, b.id AS batch_id, b.medicine_id, b.batch_number, b.expiry_date,
                    COALESCE(b.created_at, '-infinity'::timestamptz) AS anchor_at, NULL::bigint AS anchor_seq,
                    EXISTS (SELECT 1 FROM inventory_movements p WHERE p.batch_id = b.id AND p.created_at < b.created_at) AS pre_unknown,
                    NULL::int AS baseline_qty, b.quantity_available AS fallback_qty
               FROM medicine_batches b)`,
  moves: `(SELECT ($1::uuid[])[1] AS shop_id, mv.id, mv.medicine_id, mv.batch_id, mv.previous_quantity AS before_qty, mv.new_quantity AS after_qty,
                  mv.adjustment_quantity AS delta, upper(COALESCE(mv.movement_type, '')) AS movement_type, upper(COALESCE(mv.reason, '')) AS reason,
                  mv.reference_id, mv.notes, mv.user_id, mv.created_at AS occurred_at, mv.timestamp AS seq
             FROM inventory_movements mv)`,
  post: `x.occurred_at >= a.anchor_at`,
  sales: `(SELECT ($1::uuid[])[1] AS shop_id, s.id, s.date, lower(COALESCE(s.status, 'completed')) AS status FROM sales s)`,
  items: `(SELECT ($1::uuid[])[1] AS shop_id, i.sale_id, i.medicine_id, i.batch_id, i.quantity FROM sale_items i)`,
  users: `(SELECT ($1::uuid[])[1] AS shop_id, u.id, u.name FROM users u)`,
  // The cloud rebase never happened in a shop database: no local boundary rows.
  boundaries: `(SELECT NULL::uuid AS shop_id, NULL::timestamptz AS at, NULL::text AS action, NULL::jsonb AS details WHERE FALSE AND $1::uuid[] IS NOT NULL)`,
};

const CLOUD: Rel = {
  shops: `(SELECT s.shop_id, s.shop_code, s.name AS shop_name FROM giga_cloud.shops s WHERE s.shop_id = ANY($1::uuid[]))`,
  medicines: `(SELECT m.shop_id, m.medicine_id AS id, m.name, m.generic_name, m.data->>'brand_name' AS brand_name, m.barcode, m.sku, COALESCE(m.status, 'active') AS status
                 FROM giga_cloud.medicines m WHERE m.shop_id = ANY($1::uuid[]))`,
  anchors: `(SELECT b.shop_id, b.batch_id, b.medicine_id, b.batch_number, b.expiry_date,
                    COALESCE(bl.occurred_at, NULLIF(b.data->>'created_at', '')::timestamptz, '-infinity'::timestamptz) AS anchor_at,
                    COALESCE(bl.seq, 0) AS anchor_seq, (bl.batch_id IS NOT NULL) AS pre_unknown, bl.qty AS baseline_qty,
                    COALESCE(CASE WHEN sl.has_baseline THEN sl.baseline_quantity + sl.delta_since_baseline ELSE sl.last_reported_quantity END, 0)::int AS fallback_qty
               FROM giga_cloud.medicine_batches b
               LEFT JOIN (SELECT DISTINCT ON (p.shop_id, e->>'id') p.shop_id, (e->>'id')::uuid AS batch_id, (e->>'quantity_available')::int AS qty,
                                 p.occurred_at, p.local_seq AS seq
                            FROM giga_cloud.processed_events p, jsonb_array_elements(COALESCE(p.payload->'data'->'batches', '[]'::jsonb)) e
                           WHERE p.event_type = 'MEDICINE_BASELINE' AND p.shop_id = ANY($1::uuid[]) AND (e->>'id') ~* '^[0-9a-f-]{36}$'
                           ORDER BY p.shop_id, e->>'id', p.local_seq) bl ON bl.shop_id = b.shop_id AND bl.batch_id = b.batch_id
               LEFT JOIN giga_cloud.stock_levels sl ON sl.shop_id = b.shop_id AND sl.batch_id = b.batch_id
              WHERE b.shop_id = ANY($1::uuid[]))`,
  moves: `(SELECT mv.shop_id, mv.movement_id AS id, mv.medicine_id, mv.batch_id, mv.previous_quantity AS before_qty, mv.new_quantity AS after_qty,
                  mv.delta, upper(COALESCE(mv.movement_type, '')) AS movement_type, upper(COALESCE(mv.reason, '')) AS reason,
                  mv.reference_id, mv.notes, mv.user_id, mv.occurred_at, mv.local_seq AS seq
             FROM giga_cloud.inventory_movements mv WHERE mv.shop_id = ANY($1::uuid[]))`,
  // Movements already contained in the batch's baseline (lower local_seq) are not counted again.
  post: `x.seq > a.anchor_seq`,
  sales: `(SELECT s.shop_id, s.sale_id AS id, s.business_date AS date, lower(COALESCE(s.status, 'completed')) AS status FROM giga_cloud.sales s WHERE s.shop_id = ANY($1::uuid[]))`,
  items: `(SELECT i.shop_id, i.sale_id, i.medicine_id, i.batch_id, i.quantity FROM giga_cloud.sale_items i WHERE i.shop_id = ANY($1::uuid[]))`,
  users: `(SELECT u.shop_id, u.user_id AS id, u.name FROM giga_cloud.users u WHERE u.shop_id = ANY($1::uuid[]))`,
  boundaries: `(SELECT o.shop_id, o.at, o.action, o.details FROM giga_cloud.online_audit o WHERE o.shop_id = ANY($1::uuid[]) AND o.action LIKE 'CLOUD_STOCK_REBASE%')`,
};
const rel = (s: HistoryScope): Rel => (s.mode === 'local' ? LOCAL : CLOUD);

/** Movement category (SQL over alias x). Received / returned / sale are their own columns; the rest are adjustments. */
const CATEGORY = `CASE
    WHEN x.movement_type = 'SALE' THEN 'SALE'
    WHEN x.movement_type = 'PURCHASE' AND x.reason = 'ADD_STOCK' THEN 'STOCK_ADDED'
    WHEN x.movement_type = 'PURCHASE' THEN 'PURCHASE_RECEIPT'
    WHEN x.movement_type = 'RETURN_APPROVED' THEN 'RETURN_RESTOCKED'
    WHEN x.movement_type LIKE 'RETURN_APPROVED_NOT%' THEN 'RETURN_NOT_RESTOCKED'
    WHEN x.movement_type = 'VOID_REVERSAL' THEN 'VOID_REVERSAL'
    WHEN x.movement_type = 'PHYSICAL_STOCK_COUNT' OR x.reason = 'PHYSICAL_STOCK_COUNT' THEN 'PHYSICAL_COUNT'
    WHEN x.movement_type LIKE '%SUPPLIER%' OR x.reason LIKE '%SUPPLIER%' THEN 'SUPPLIER_RETURN'
    WHEN x.movement_type LIKE '%DAMAG%' OR x.reason LIKE '%DAMAG%' THEN 'DAMAGE'
    WHEN x.movement_type LIKE '%EXPIR%' OR x.reason LIKE '%EXPIR%' THEN 'EXPIRY'
    WHEN x.movement_type ~ '(LOSS|LOST|THEFT|MISSING)' OR x.reason ~ '(LOSS|LOST|THEFT|MISSING)' THEN 'LOSS'
    WHEN x.movement_type = 'CORRECTION' THEN 'CORRECTION'
    WHEN x.movement_type = 'ADJUSTMENT' THEN 'ADJUSTMENT'
    ELSE 'OTHER' END`;
const NOT_ADJUSTMENT = `('SALE', 'PURCHASE_RECEIPT', 'STOCK_ADDED', 'RETURN_RESTOCKED')`;

export const CATEGORY_LABELS: Record<string, string> = {
  SALE: 'Sale', PURCHASE_RECEIPT: 'Purchase receipt', STOCK_ADDED: 'Stock added', RETURN_RESTOCKED: 'Customer return (restocked)',
  RETURN_NOT_RESTOCKED: 'Customer return (not restocked)', VOID_REVERSAL: 'Void reversal', PHYSICAL_COUNT: 'Physical count',
  SUPPLIER_RETURN: 'Supplier return', DAMAGE: 'Damaged', EXPIRY: 'Expired', LOSS: 'Lost', CORRECTION: 'Correction',
  ADJUSTMENT: 'Adjustment', OTHER: 'Other', SALE_LATER_VOIDED: 'Sold, sale later voided',
  SALE_LEDGER_DIFFERENCE: 'Sale movements without a matching valid sale',
};

// ---------------------------------------------------------------------------- request parsing
export interface StockQuery {
  from: string;
  to: string;
  shop: string | null;
  medicineId: string | null;
  tokens: string[];
  activityOnly: boolean;
  newestFirst: boolean;
  page: number;
  size: number;
}

/** Validates the request; `today` is the shop's business date (from PostgreSQL). */
export function parseStockQuery(scope: HistoryScope, query: Record<string, unknown>, today: string, opts: { maxSize?: number } = {}): StockQuery {
  const date = str(query.date, 10), fromRaw = str(query.from, 10), toRaw = str(query.to, 10);
  for (const [k, v] of [['date', date], ['from', fromRaw], ['to', toRaw]] as const) {
    if (v && (!DATE_RE.test(v) || isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new HttpError(400, `${k} must be YYYY-MM-DD.`);
  }
  let from = date || fromRaw || toRaw || today;
  let to = date || toRaw || fromRaw || today;
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, `Choose at most ${MAX_RANGE_DAYS} days at a time.`);

  const shopRaw = str(query.shop_id ?? query.shop, 64).toLowerCase();
  let shop: string | null = null;
  if (shopRaw && shopRaw !== 'all') {
    // Narrowing to ONE authorized shop only; never widens the server-computed scope.
    if (!isValidUuid(shopRaw) || !scope.shopIds.includes(shopRaw)) throw new HttpError(403, 'Forbidden: that shop is not in your history scope.');
    shop = shopRaw;
  }
  const medicineRaw = str(query.medicine_id, 64);
  if (medicineRaw && !isValidUuid(medicineRaw)) throw new HttpError(400, 'medicine_id must be a UUID.');
  const text = str(query.q ?? query.medicine, 120).toLowerCase();
  const tokens = text.split(/\s+/).filter(Boolean).slice(0, 8).map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const sizes: readonly number[] = STOCK_PAGE_SIZES;
  const wanted = Number(query.page_size);
  const size = opts.maxSize ? Math.min(opts.maxSize, Math.max(1, wanted || opts.maxSize)) : sizes.includes(wanted) ? wanted : 100;
  const all = String(query.activity_only ?? '').toLowerCase();
  return {
    from, to, shop, medicineId: medicineRaw ? medicineRaw.toLowerCase() : null, tokens,
    activityOnly: !(all === 'false' || all === '0' || String(query.show_all ?? '') === '1' || String(query.show_all ?? '').toLowerCase() === 'true'),
    newestFirst: String(query.order ?? '').toLowerCase() !== 'asc',
    page: Math.max(1, Math.min(100_000, Math.floor(Number(query.page) || 1))),
    size,
  };
}

export async function businessToday(scope: HistoryScope): Promise<string> {
  return (await scope.q.query(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
}

// ---------------------------------------------------------------------------- the calculation
/**
 * CTE chain shared by the list, the summary, the batch detail and the export.
 * Parameters: $1 shops, $2 from, $3 to, $4 one shop or NULL, $5 medicine id or NULL, $6 search patterns.
 * Produces `bd` (one row per batch per day) and `md` (one row per medicine per day).
 */
function gridSql(scope: HistoryScope): string {
  const R = rel(scope);
  return `
  WITH days AS (
         SELECT g::date AS d, (g::date::timestamp AT TIME ZONE '${TZ}') AS s, ((g::date + 1)::timestamp AT TIME ZONE '${TZ}') AS e
           FROM generate_series($2::date, $3::date, interval '1 day') g),
       rng AS (SELECT MIN(s) AS s0, MAX(e) AS e1 FROM days),
       meds AS (
         SELECT m.* FROM ${R.medicines} m
          WHERE ($4::uuid IS NULL OR m.shop_id = $4::uuid) AND ($5::uuid IS NULL OR m.id = $5::uuid)
            AND lower(concat_ws(' ', m.name, m.generic_name, m.brand_name, m.barcode, m.sku)) LIKE ALL ($6::text[])),
       a0 AS (SELECT a.* FROM ${R.anchors} a JOIN meds m ON m.shop_id = a.shop_id AND m.id = a.medicine_id),
       -- Quantity at the start of the range and when the batch entered the ledger (indexed LIMIT 1 lookups).
       a AS (
         SELECT a0.*,
                (SELECT x.after_qty FROM ${R.moves} x WHERE x.shop_id = a0.shop_id AND x.batch_id = a0.batch_id
                    AND ${R.post.replace(/a\./g, 'a0.')} AND x.occurred_at < (SELECT s0 FROM rng)
                  ORDER BY x.occurred_at DESC, x.seq DESC, x.id DESC LIMIT 1) AS qty_before_range,
                (SELECT x.before_qty FROM ${R.moves} x WHERE x.shop_id = a0.shop_id AND x.batch_id = a0.batch_id
                    AND ${R.post.replace(/a\./g, 'a0.')}
                  ORDER BY x.occurred_at, x.seq, x.id LIMIT 1) AS first_before_qty
           FROM a0),
       ab AS (
         SELECT a.*, COALESCE(a.baseline_qty, a.first_before_qty, a.fallback_qty) AS anchor_qty,
                COALESCE(a.qty_before_range, a.baseline_qty, a.first_before_qty, a.fallback_qty) AS base_qty
           FROM a),
       mv AS (
         SELECT x.*, (x.occurred_at AT TIME ZONE '${TZ}')::date AS d, ${CATEGORY} AS cat
           FROM ${R.moves} x JOIN ab a ON a.shop_id = x.shop_id AND a.batch_id = x.batch_id
          WHERE ${R.post} AND x.occurred_at >= (SELECT s0 FROM rng) AND x.occurred_at < (SELECT e1 FROM rng)),
       dm AS (
         SELECT mv.shop_id, mv.batch_id, mv.d,
                (array_agg(mv.after_qty ORDER BY mv.occurred_at DESC, mv.seq DESC, mv.id DESC))[1] AS last_after,
                COUNT(*)::int AS moves,
                COALESCE(-SUM(mv.delta) FILTER (WHERE mv.cat = 'SALE'), 0)::int AS ledger_sold,
                COALESCE(SUM(mv.delta) FILTER (WHERE mv.cat IN ('PURCHASE_RECEIPT', 'STOCK_ADDED')), 0)::int AS received,
                COALESCE(SUM(mv.delta) FILTER (WHERE mv.cat = 'RETURN_RESTOCKED'), 0)::int AS returned,
                COALESCE(SUM(mv.delta) FILTER (WHERE mv.cat NOT IN ${NOT_ADJUSTMENT}), 0)::int AS ledger_adjust,
                COALESCE(SUM(mv.delta), 0)::int AS net_delta
           FROM mv GROUP BY 1, 2, 3),
       sold_b AS (
         SELECT i.shop_id, i.batch_id, s.date AS d,
                COALESCE(SUM(i.quantity) FILTER (WHERE s.status <> 'voided'), 0)::int AS gross_sold,
                COALESCE(SUM(i.quantity) FILTER (WHERE s.status = 'voided'), 0)::int AS voided_units
           FROM ${R.sales} s JOIN ${R.items} i ON i.shop_id = s.shop_id AND i.sale_id = s.id
           JOIN meds m ON m.shop_id = i.shop_id AND m.id = i.medicine_id
          WHERE s.date BETWEEN $2::date AND $3::date GROUP BY 1, 2, 3),
       g AS (
         SELECT ab.shop_id, ab.medicine_id, ab.batch_id, ab.batch_number, ab.expiry_date, ab.anchor_at, ab.pre_unknown, ab.base_qty,
                days.d, days.s, days.e, dm.last_after, COALESCE(dm.moves, 0) AS moves, COALESCE(dm.ledger_sold, 0) AS ledger_sold,
                COALESCE(dm.received, 0) AS received, COALESCE(dm.returned, 0) AS returned, COALESCE(dm.ledger_adjust, 0) AS ledger_adjust,
                COALESCE(dm.net_delta, 0) AS net_delta, COALESCE(sb.gross_sold, 0) AS gross_sold, COALESCE(sb.voided_units, 0) AS voided_units
           FROM ab CROSS JOIN days
           LEFT JOIN dm ON dm.shop_id = ab.shop_id AND dm.batch_id = ab.batch_id AND dm.d = days.d
           LEFT JOIN sold_b sb ON sb.shop_id = ab.shop_id AND sb.batch_id = ab.batch_id AND sb.d = days.d),
       g1 AS (SELECT g.*, COUNT(g.last_after) OVER (PARTITION BY g.shop_id, g.batch_id ORDER BY g.d) AS grp FROM g),
       g2 AS (SELECT g1.*, FIRST_VALUE(g1.last_after) OVER (PARTITION BY g1.shop_id, g1.batch_id, g1.grp ORDER BY g1.d) AS carried FROM g1),
       g3 AS (SELECT g2.*, LAG(g2.carried) OVER (PARTITION BY g2.shop_id, g2.batch_id ORDER BY g2.d) AS carried_prev FROM g2),
       bd AS (
         SELECT g3.*,
                CASE WHEN g3.s < g3.anchor_at THEN CASE WHEN g3.pre_unknown THEN NULL ELSE 0 END
                     ELSE COALESCE(g3.carried_prev, g3.base_qty) END AS opening,
                CASE WHEN g3.e <= g3.anchor_at THEN CASE WHEN g3.pre_unknown THEN NULL ELSE 0 END
                     ELSE COALESCE(g3.carried, g3.base_qty) END AS closing
           FROM g3),
       sold_m AS (
         SELECT i.shop_id, i.medicine_id, s.date AS d,
                COALESCE(SUM(i.quantity) FILTER (WHERE s.status <> 'voided'), 0)::int AS gross_sold,
                COALESCE(SUM(i.quantity) FILTER (WHERE s.status = 'voided'), 0)::int AS voided_units,
                COUNT(DISTINCT s.id) FILTER (WHERE s.status <> 'voided')::int AS receipts
           FROM ${R.sales} s JOIN ${R.items} i ON i.shop_id = s.shop_id AND i.sale_id = s.id
           JOIN meds m ON m.shop_id = i.shop_id AND m.id = i.medicine_id
          WHERE s.date BETWEEN $2::date AND $3::date GROUP BY 1, 2, 3),
       cat_m AS (
         SELECT c.shop_id, c.medicine_id, c.d, jsonb_object_agg(c.cat, jsonb_build_object('qty', c.qty, 'n', c.n)) AS cats
           FROM (SELECT mv.shop_id, mv.medicine_id, mv.d, mv.cat, SUM(mv.delta)::int AS qty, COUNT(*)::int AS n
                   FROM mv WHERE mv.cat NOT IN ${NOT_ADJUSTMENT} GROUP BY 1, 2, 3, 4) c
          GROUP BY 1, 2, 3),
       bm AS (
         SELECT bd.shop_id, bd.medicine_id, bd.d,
                CASE WHEN bool_or(bd.opening IS NULL) THEN NULL ELSE SUM(bd.opening) END::int AS opening,
                CASE WHEN bool_or(bd.closing IS NULL) THEN NULL ELSE SUM(bd.closing) END::int AS closing,
                SUM(bd.moves)::int AS moves, SUM(bd.ledger_sold)::int AS ledger_sold, SUM(bd.received)::int AS received,
                SUM(bd.returned)::int AS returned, SUM(bd.ledger_adjust)::int AS ledger_adjust, SUM(bd.net_delta)::int AS net_delta,
                COUNT(*)::int AS batches
           FROM bd GROUP BY 1, 2, 3),
       md AS (
         SELECT m.shop_id, m.id AS medicine_id, m.name, m.generic_name, m.brand_name, m.barcode, m.sku, m.status AS medicine_status, days.d,
                CASE WHEN bm.batches IS NULL THEN 0 ELSE bm.opening END AS opening,
                CASE WHEN bm.batches IS NULL THEN 0 ELSE bm.closing END AS closing,
                COALESCE(bm.moves, 0) AS moves, COALESCE(bm.ledger_sold, 0) AS ledger_sold, COALESCE(bm.received, 0) AS received,
                COALESCE(bm.returned, 0) AS returned, COALESCE(bm.ledger_adjust, 0) AS ledger_adjust, COALESCE(bm.net_delta, 0) AS net_delta,
                COALESCE(sm.gross_sold, 0) AS gross_sold, COALESCE(sm.voided_units, 0) AS voided_units, COALESCE(sm.receipts, 0) AS receipts,
                cm.cats
           FROM meds m CROSS JOIN days
           LEFT JOIN bm ON bm.shop_id = m.shop_id AND bm.medicine_id = m.id AND bm.d = days.d
           LEFT JOIN sold_m sm ON sm.shop_id = m.shop_id AND sm.medicine_id = m.id AND sm.d = days.d
           LEFT JOIN cat_m cm ON cm.shop_id = m.shop_id AND cm.medicine_id = m.id AND cm.d = days.d)`;
}

interface Row {
  date: string; heading: string; shop_id: string; shop_code: string | null; shop_name: string | null;
  medicine_id: string; medicine_name: string; generic_name: string | null; brand_name: string | null; barcode: string | null; sku: string | null;
  status: 'OK' | 'INCOMPLETE' | 'MISMATCH';
  opening: number | null; gross_sold: number; returned: number | null; net_sold: number | null; received: number | null;
  adjustments: number | null; closing: number | null; adjustment_breakdown: { key: string; label: string; quantity: number; movements: number }[];
  voided_sale_units: number; receipts: number; movements: number; difference: number | null;
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
/** "MONDAY, 12 OCTOBER 2026" from the business date itself (calendar arithmetic, no time zone involved). */
export const heading = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  return `${WEEKDAYS[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
const isoDay = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

/**
 * One medicine-day exactly as the ledger proves it. Unknown opening / closing (before a batch's anchor)
 * => INCOMPLETE: only the sales are shown, every stock figure is null.
 */
function toRow(r: any, shops: Map<string, any>): Row {
  const date = isoDay(r.d);
  const known = r.opening !== null && r.closing !== null;
  const gross = Number(r.gross_sold) || 0;
  const base = {
    date, heading: heading(date), shop_id: r.shop_id, shop_code: shops.get(r.shop_id)?.shop_code ?? null, shop_name: shops.get(r.shop_id)?.shop_name ?? null,
    medicine_id: r.medicine_id, medicine_name: r.name, generic_name: r.generic_name ?? null, brand_name: r.brand_name ?? null, barcode: r.barcode ?? null, sku: r.sku ?? null,
    gross_sold: gross, voided_sale_units: Number(r.voided_units) || 0, receipts: Number(r.receipts) || 0, movements: Number(r.moves) || 0,
  };
  if (!known) {
    return { ...base, status: 'INCOMPLETE', opening: r.opening ?? null, closing: r.closing ?? null, returned: null, net_sold: null, received: null, adjustments: null, adjustment_breakdown: [], difference: null };
  }
  const breakdown = Object.entries((r.cats || {}) as Record<string, { qty: number; n: number }>)
    .map(([key, v]) => ({ key, label: CATEGORY_LABELS[key] || key, quantity: Number(v.qty) || 0, movements: Number(v.n) || 0 }));
  // Stock taken by sale movements that are not in today's valid sales (sales voided afterwards: their
  // stock comes back as a Void reversal on the void day). Kept visible, never hidden in "Sold".
  const ledgerSold = Number(r.ledger_sold) || 0;
  const voidedOut = Math.min(Math.max(0, ledgerSold - gross), Number(r.voided_units) || 0);
  const unexplained = ledgerSold - gross - voidedOut;
  if (voidedOut) breakdown.push({ key: 'SALE_LATER_VOIDED', label: CATEGORY_LABELS.SALE_LATER_VOIDED, quantity: -voidedOut, movements: 0 });
  if (unexplained) {
    breakdown.push({ key: 'SALE_LEDGER_DIFFERENCE', label: unexplained > 0 ? CATEGORY_LABELS.SALE_LEDGER_DIFFERENCE : 'Sales recorded without a stock movement', quantity: -unexplained, movements: 0 });
  }
  breakdown.sort((x, y) => Math.abs(y.quantity) - Math.abs(x.quantity) || x.label.localeCompare(y.label));
  const adjustments = (Number(r.ledger_adjust) || 0) - voidedOut - unexplained;
  const opening = Number(r.opening), closing = Number(r.closing), received = Number(r.received) || 0, returned = Number(r.returned) || 0;
  const difference = closing - (opening - gross + returned + received + adjustments);
  return {
    ...base, status: difference === 0 ? 'OK' : 'MISMATCH', opening, closing, received, returned, net_sold: gross - returned, adjustments,
    adjustment_breakdown: breakdown, difference: difference === 0 ? null : difference,
  };
}

const ACTIVE = `(md.moves > 0 OR md.gross_sold > 0 OR md.voided_units > 0)`;

/**
 * GET /history/stock — medicine rows per day (one page) + per-day summary cards (whole filtered set) +
 * the ledger boundaries (earliest exact day per shop, cloud rebase) for the request.
 */
export async function stockHistory(scope: HistoryScope, query: Record<string, unknown>, opts: { maxSize?: number } = {}) {
  const R = rel(scope);
  const today = await businessToday(scope);
  const p = parseStockQuery(scope, query, today, opts);
  const params = [scope.shopIds, p.from, p.to, p.shop, p.medicineId, p.tokens.length ? p.tokens : ['%']];
  const order = `md.d ${p.newestFirst ? 'DESC' : 'ASC'}, lower(md.name), md.medicine_id, md.shop_id`;
  const res = (await scope.q.query(
    `${gridSql(scope)},
       f AS (SELECT md.* FROM md ${p.activityOnly ? `WHERE ${ACTIVE}` : ''})
     SELECT (SELECT COUNT(*)::int FROM f) AS total,
            (SELECT COALESCE(json_agg(x), '[]'::json) FROM (SELECT md.* FROM f md ORDER BY ${order} LIMIT $7 OFFSET $8) x) AS rows,
            (SELECT COALESCE(json_agg(y ORDER BY y.d ${p.newestFirst ? 'DESC' : 'ASC'}, y.shop_id), '[]'::json) FROM (
               SELECT md.d, md.shop_id,
                      COUNT(*) FILTER (WHERE md.gross_sold > 0)::int AS medicines_sold,
                      COALESCE(SUM(md.gross_sold), 0)::int AS units_sold,
                      COUNT(*) FILTER (WHERE ${ACTIVE})::int AS medicines_with_activity,
                      COUNT(*) FILTER (WHERE md.opening IS NULL OR md.closing IS NULL)::int AS incomplete,
                      COALESCE(SUM(md.received) FILTER (WHERE md.opening IS NOT NULL AND md.closing IS NOT NULL), 0)::int AS units_received,
                      COALESCE(SUM(md.returned) FILTER (WHERE md.opening IS NOT NULL AND md.closing IS NOT NULL), 0)::int AS units_returned,
                      CASE WHEN bool_or(md.opening IS NULL) THEN NULL ELSE SUM(md.opening) END::int AS opening_units,
                      CASE WHEN bool_or(md.closing IS NULL) THEN NULL ELSE SUM(md.closing) END::int AS closing_units,
                      COALESCE(SUM(md.ledger_sold) FILTER (WHERE md.opening IS NOT NULL AND md.closing IS NOT NULL), 0)::int AS ledger_sold,
                      COALESCE(SUM(md.gross_sold) FILTER (WHERE md.opening IS NOT NULL AND md.closing IS NOT NULL), 0)::int AS known_sold,
                      COALESCE(SUM(md.ledger_adjust) FILTER (WHERE md.opening IS NOT NULL AND md.closing IS NOT NULL), 0)::int AS ledger_adjust
                 FROM md GROUP BY md.d, md.shop_id) y) AS days`,
    [...params, p.size, (p.page - 1) * p.size]
  )).rows[0];
  const shops = new Map((await scope.q.query(`SELECT * FROM ${R.shops} sh`, [scope.shopIds])).rows.map((x: any) => [x.shop_id, x]));
  const rows = (res.rows as any[]).map((r) => toRow(r, shops));
  const ledger = await ledgerInfo(scope, p.from, p.to);

  // Per-day cards: per shop, plus a combined line for All Shops (stock is never merged silently).
  const byDay = new Map<string, any[]>();
  for (const y of res.days as any[]) {
    const date = isoDay(y.d);
    // Adjustments in the cards follow the same rule as the rows (stock taken by sales voided later counts).
    const adjustments = y.ledger_adjust - (y.ledger_sold - y.known_sold);
    const entry = {
      shop_id: y.shop_id, shop_code: shops.get(y.shop_id)?.shop_code ?? null, shop_name: shops.get(y.shop_id)?.shop_name ?? null,
      medicines_sold: y.medicines_sold, units_sold: y.units_sold, units_received: y.units_received, units_returned: y.units_returned,
      adjustments, opening_units: y.opening_units, closing_units: y.closing_units, medicines_with_activity: y.medicines_with_activity,
      incomplete_medicines: y.incomplete,
    };
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(entry);
  }
  const days = [...byDay.entries()].map(([date, perShop]) => {
    const sum = (k: string) => perShop.reduce((t, x) => t + (Number(x[k]) || 0), 0);
    const anyNull = (k: string) => perShop.some((x) => x[k] === null);
    return {
      date, heading: heading(date), status: perShop.some((x) => x.incomplete_medicines > 0) ? 'INCOMPLETE' : 'OK',
      summary: {
        medicines_sold: sum('medicines_sold'), units_sold: sum('units_sold'), units_received: sum('units_received'), units_returned: sum('units_returned'),
        adjustments: sum('adjustments'), medicines_with_activity: sum('medicines_with_activity'), incomplete_medicines: sum('incomplete_medicines'),
        // A combined stock figure across shops is labelled as such in the UI; per-shop figures stay in by_shop.
        opening_units: anyNull('opening_units') ? null : sum('opening_units'), closing_units: anyNull('closing_units') ? null : sum('closing_units'),
      },
      by_shop: perShop,
      boundaries: ledger.boundaries.filter((b) => b.date === date),
    };
  });
  return {
    from: p.from, to: p.to, today, timezone: TZ, activity_only: p.activityOnly, order: p.newestFirst ? 'desc' : 'asc',
    page: p.page, page_size: p.size, total: res.total, pages: Math.max(1, Math.ceil(res.total / p.size)),
    days, rows, ledger: ledger.shops, boundaries: ledger.boundaries,
  };
}

/**
 * Earliest exact day per shop (after the last anchor that has unknown history before it) and the
 * cloud stock-rebase boundaries. Cheap: one anchor scan per shop.
 */
async function ledgerInfo(scope: HistoryScope, from: string, to: string) {
  const R = rel(scope);
  const shops = (await scope.q.query(
    `SELECT a.shop_id, MAX(a.anchor_at) FILTER (WHERE a.pre_unknown AND a.anchor_at > '-infinity'::timestamptz) AS unknown_before,
            to_char((MAX(a.anchor_at) FILTER (WHERE a.pre_unknown AND a.anchor_at > '-infinity'::timestamptz) AT TIME ZONE '${TZ}'), 'YYYY-MM-DD HH24:MI') AS unknown_before_local,
            COUNT(*)::int AS batches, COUNT(*) FILTER (WHERE a.pre_unknown)::int AS imported_batches
       FROM ${R.anchors} a GROUP BY a.shop_id`, [scope.shopIds])).rows;
  const ledger = shops.map((x: any) => {
    // Exact from the first full day after the anchor (the anchor day itself is exact only after the anchor time).
    const at = x.unknown_before ? new Date(x.unknown_before) : null;
    let exactFrom: string | null = null;
    if (at) {
      const local = String(x.unknown_before_local);
      const d = local.slice(0, 10);
      exactFrom = local.slice(11) === '00:00' ? d : isoDay(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString());
    }
    return {
      shop_id: x.shop_id, batches: x.batches, anchored_batches: x.imported_batches,
      exact_from_date: exactFrom, ledger_starts_at: at ? at.toISOString() : null,
      note: at
        ? scope.mode === 'local'
          ? `Stock balances are exact from ${exactFrom}. Earlier records were imported from the previous system without running balances: days before show sales only (INCOMPLETE STOCK HISTORY).`
          : `The online copy holds this shop's stock ledger from ${exactFrom} (sync start). Earlier days show sales only; the shop's own History has the full local ledger.`
        : 'Every batch is covered by the movement ledger since it was created.',
    };
  });
  const boundaries = (await scope.q.query(
    `SELECT b.shop_id, b.at, b.action, to_char((b.at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS d, to_char((b.at AT TIME ZONE '${TZ}'), 'HH24:MI') AS t, b.details->>'source' AS source
       FROM ${R.boundaries} b WHERE (b.at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date ORDER BY b.at`, [scope.shopIds, from, to])).rows
    .map((b: any) => ({
      shop_id: b.shop_id, date: b.d, time: b.t, at: b.at, kind: b.action,
      note: `Cloud stock rebase at ${b.t} (${b.action}${b.source ? `, source ${b.source}` : ''}): the online catalogue stock was reset. It is not a stock movement; the figures here follow the shop's own movement ledger and are not changed by it.`,
    }));
  return { shops: ledger, boundaries };
}

/**
 * GET /history/stock/:medicineId?date= — one medicine on one business day: per-batch figures and the
 * chronological movement timeline (time, type, change, before -> after, reference, user, batch).
 */
export async function stockHistoryDetail(scope: HistoryScope, medicineId: string, query: Record<string, unknown>) {
  if (!isValidUuid(medicineId)) throw new HttpError(400, 'Medicine id must be a UUID.');
  const R = rel(scope);
  const today = await businessToday(scope);
  const date = str(query.date, 10) || str(query.from, 10) || today;
  const p = parseStockQuery(scope, { date, shop_id: query.shop_id }, today);
  const shopIds = p.shop ? [p.shop] : scope.shopIds;
  if (!p.shop && scope.shopIds.length > 1) throw new HttpError(400, 'Choose the shop (shop_id) for the medicine detail.');
  const params = [shopIds, p.from, p.to, shopIds[0], medicineId.toLowerCase(), ['%']];
  const grid = (await scope.q.query(
    `${gridSql(scope)}
     SELECT (SELECT row_to_json(x) FROM (SELECT md.* FROM md LIMIT 1) x) AS medicine,
            (SELECT COALESCE(json_agg(b ORDER BY b.expiry_date NULLS LAST, b.batch_number), '[]'::json) FROM (
               SELECT bd.batch_id, bd.batch_number, bd.expiry_date, bd.opening, bd.closing, bd.gross_sold, bd.voided_units, bd.ledger_sold,
                      bd.received, bd.returned, bd.ledger_adjust, bd.moves FROM bd) b) AS batches`, params)).rows[0];
  if (!grid.medicine) throw new HttpError(404, 'Medicine not found in your history scope.');
  const shops = new Map((await scope.q.query(`SELECT * FROM ${R.shops} sh`, [shopIds])).rows.map((x: any) => [x.shop_id, x]));
  const summary = toRow(grid.medicine, shops);
  const batches = (grid.batches as any[]).map((b) => {
    const known = b.opening !== null && b.closing !== null;
    const voidedOut = Math.min(Math.max(0, b.ledger_sold - b.gross_sold), b.voided_units);
    const adj = b.ledger_adjust - (b.ledger_sold - b.gross_sold);
    return {
      batch_id: b.batch_id, batch_number: b.batch_number, expiry_date: b.expiry_date ? isoDay(b.expiry_date) : null,
      status: known ? 'OK' : 'INCOMPLETE', opening: b.opening ?? null, sold: b.gross_sold,
      returned: known ? b.returned : null, received: known ? b.received : null, adjustments: known ? adj : null, closing: b.closing ?? null,
      voided_sale_units: voidedOut, movements: b.moves,
    };
  }).filter((b) => b.movements > 0 || b.sold > 0 || (b.opening ?? 0) !== 0 || (b.closing ?? 0) !== 0 || b.status === 'INCOMPLETE');

  // Timeline: every movement of the medicine that day (ledger order). Imported legacy records (no balance)
  // are listed but marked: they never feed opening / closing.
  const events = (await scope.q.query(
    `SELECT x.id, x.occurred_at, to_char((x.occurred_at AT TIME ZONE '${TZ}'), 'HH24:MI:SS') AS t, x.movement_type, x.reason, ${CATEGORY} AS cat,
            x.delta, x.before_qty, x.after_qty, x.reference_id, x.notes, u.name AS user_name, a.batch_number, (${R.post}) AS in_ledger
       FROM ${R.moves} x
       JOIN ${R.anchors} a ON a.shop_id = x.shop_id AND a.batch_id = x.batch_id
       LEFT JOIN ${R.users} u ON u.shop_id = x.shop_id AND u.id = x.user_id
      WHERE x.shop_id = $2::uuid AND x.medicine_id = $3::uuid
        AND x.occurred_at >= ($4::date::timestamp AT TIME ZONE '${TZ}') AND x.occurred_at < (($4::date + 1)::timestamp AT TIME ZONE '${TZ}')
      ORDER BY x.occurred_at, x.seq, x.id LIMIT 2000`, [shopIds, shopIds[0], medicineId.toLowerCase(), p.from])).rows;
  const voidedSales = (await scope.q.query(
    `SELECT COUNT(DISTINCT s.id)::int AS n FROM ${R.sales} s JOIN ${R.items} i ON i.shop_id = s.shop_id AND i.sale_id = s.id
      WHERE s.shop_id = $2::uuid AND i.medicine_id = $3::uuid AND s.date = $4::date AND s.status = 'voided'`, [shopIds, shopIds[0], medicineId.toLowerCase(), p.from])).rows[0].n;
  const ledger = await ledgerInfo(scope, p.from, p.to);
  return {
    date: p.from, heading: heading(p.from), shop_id: shopIds[0], shop_code: shops.get(shopIds[0])?.shop_code ?? null, shop_name: shops.get(shopIds[0])?.shop_name ?? null,
    medicine: { id: summary.medicine_id, name: summary.medicine_name, generic_name: summary.generic_name, brand_name: summary.brand_name, barcode: summary.barcode, sku: summary.sku },
    summary, batches, voided_sales: voidedSales,
    events: events.map((e: any) => ({
      time: e.t, at: e.occurred_at, type: e.cat, label: CATEGORY_LABELS[e.cat] || e.movement_type, movement_type: e.movement_type, reason: e.reason || null,
      change: Number(e.delta), before: e.in_ledger ? e.before_qty : null, after: e.in_ledger ? e.after_qty : null, reference: e.reference_id ?? null,
      user: e.user_name ?? null, batch_number: e.batch_number, notes: e.notes ?? null, legacy_import: !e.in_ledger,
    })),
    ledger: ledger.shops.filter((x) => x.shop_id === shopIds[0]), boundaries: ledger.boundaries.filter((b) => b.shop_id === shopIds[0]),
  };
}

// ---------------------------------------------------------------------------- CSV
const csvCell = (v: unknown) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
/** Same filters as the screen, every page (max 62 days x the whole catalogue). */
export async function stockHistoryCsv(scope: HistoryScope, query: Record<string, unknown>): Promise<string> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const r = await stockHistory(scope, { ...query, page, page_size: 5000 }, { maxSize: 5000 });
    out.push(...r.rows);
    if (page >= r.pages || out.length >= 200_000) break;
  }
  const multi = new Set(out.map((r) => r.shop_id)).size > 1 || scope.shopIds.length > 1;
  const head = ['Date', 'Day', ...(multi ? ['Shop'] : []), 'Medicine', 'Barcode', 'Opening', 'Sold', 'Returned', 'Net sold', 'Received', 'Adjustments', 'Remaining', 'Status'];
  const lines = out.map((r) => [r.date, r.heading.split(',')[0], ...(multi ? [r.shop_code] : []), r.medicine_name, r.barcode, r.opening, r.gross_sold, r.returned,
    r.net_sold, r.received, r.adjustments, r.closing, r.status === 'INCOMPLETE' ? 'INCOMPLETE STOCK HISTORY' : r.status].map(csvCell).join(','));
  return ['GIGA CHEMIST', 'DAILY STOCK HISTORY', head.join(','), ...lines].join('\n');
}
