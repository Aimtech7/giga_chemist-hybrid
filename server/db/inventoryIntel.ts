import { HttpError, type Queryable } from './client';
import type { HistoryScope } from './history';

/**
 * INVENTORY INTELLIGENCE (read only) — shared by the shop server (local PostgreSQL) and the online API
 * (cloud copy) through the same authorized HistoryScope as History:
 *
 *   reorderSuggestions   current stock vs recent sales velocity, reorder level, lead time and pending
 *                        purchase drafts -> suggested order quantity (a RECOMMENDATION: nothing is
 *                        ordered or received here; "Create purchase draft" is a separate, explicit action)
 *   movementAnalysis     FAST / NORMAL / SLOW / NO SALES 30 / 60 / 90 days (configurable thresholds)
 *   expiryRisk           per batch: days remaining vs estimated days to sell (FEFO) -> LOW / MEDIUM / HIGH / EXPIRED
 *   stockReconciliation  (local) per medicine: batch quantities vs the movement ledger's last balance
 *                        -> BALANCED / SHORT / OVER / INCOMPLETE_HISTORY, last count, last movement
 *
 * Money (cost / value) only when scope.includeCost (Administrator). Kenya business date for "today".
 */
const LOCAL = {
  meds: `(SELECT ($1::uuid[])[1] AS shop_id, m.id, m.name, m.generic_name, m.barcode, cat.name AS category, m.status,
             COALESCE(m.reorder_level, 0)::int AS reorder_level, COALESCE(m.purchase_price, 0) AS purchase_price, COALESCE(m.selling_price, 0) AS selling_price
             FROM medicines m LEFT JOIN categories cat ON cat.id = m.category_id)`,
  batches: `(SELECT ($1::uuid[])[1] AS shop_id, b.id, b.medicine_id, b.batch_number, b.expiry_date, COALESCE(b.quantity_available, 0)::int AS qty,
             COALESCE(NULLIF(b.purchase_price, 0), m.purchase_price, 0) AS unit_cost, COALESCE(b.selling_price_override, m.selling_price, 0) AS unit_price
             FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id)`,
  lines: `(SELECT ($1::uuid[])[1] AS shop_id, i.medicine_id, i.quantity, s.date
             FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.status <> 'voided' AND s.date >= $2::date)`,
  onOrder: `(SELECT ($1::uuid[])[1] AS shop_id, pi.medicine_id, SUM(pi.quantity)::int AS qty
             FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE p.status = 'pending' GROUP BY pi.medicine_id)`,
  shops: `(SELECT si.shop_id, si.shop_code FROM shop_identity si WHERE si.shop_id = ANY($1::uuid[]))`,
};
const CLOUD = {
  meds: `(SELECT m.shop_id, m.medicine_id AS id, m.name, m.generic_name, m.barcode, m.category, m.status,
             COALESCE(m.reorder_level, 0)::int AS reorder_level, COALESCE(m.purchase_price, 0) AS purchase_price, COALESCE(m.selling_price, 0) AS selling_price
             FROM giga_cloud.medicines m WHERE m.shop_id = ANY($1::uuid[]))`,
  batches: `(SELECT b.shop_id, b.batch_id AS id, b.medicine_id, b.batch_number, b.expiry_date,
             COALESCE(CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE s.last_reported_quantity END, 0)::int AS qty,
             COALESCE(NULLIF(NULLIF(b.data->>'purchase_price', '')::numeric, 0), m.purchase_price, 0) AS unit_cost,
             COALESCE(NULLIF(b.data->>'selling_price_override', '')::numeric, m.selling_price, 0) AS unit_price
             FROM giga_cloud.medicine_batches b
             JOIN giga_cloud.medicines m ON m.shop_id = b.shop_id AND m.medicine_id = b.medicine_id
             LEFT JOIN giga_cloud.stock_levels s ON s.shop_id = b.shop_id AND s.batch_id = b.batch_id
            WHERE b.shop_id = ANY($1::uuid[]))`,
  lines: `(SELECT i.shop_id, i.medicine_id, i.quantity, s.business_date AS date
             FROM giga_cloud.sale_items i JOIN giga_cloud.sales s ON s.shop_id = i.shop_id AND s.sale_id = i.sale_id
            WHERE i.shop_id = ANY($1::uuid[]) AND s.status <> 'voided' AND s.business_date >= $2::date)`,
  onOrder: `(SELECT pi.shop_id, pi.medicine_id, SUM(pi.quantity)::int AS qty
             FROM giga_cloud.purchase_items pi JOIN giga_cloud.purchases p ON p.shop_id = pi.shop_id AND p.purchase_id = pi.purchase_id
            WHERE pi.shop_id = ANY($1::uuid[]) AND COALESCE(p.data->>'status', 'received') = 'pending' GROUP BY pi.shop_id, pi.medicine_id)`,
  shops: `(SELECT s.shop_id, s.shop_code FROM giga_cloud.shops s WHERE s.shop_id = ANY($1::uuid[]))`,
};
const rel = (s: HistoryScope) => (s.mode === 'local' ? LOCAL : CLOUD);

const intIn = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : def;
};
const numIn = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : def;
};
const r2 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function today(q: Queryable): Promise<string> {
  return (await q.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS d`)).rows[0].d;
}
const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Optional narrowing to one AUTHORIZED shop (never widens). */
function shopIds(scope: HistoryScope, query: Record<string, unknown>): string[] {
  const want = typeof query.shop_id === 'string' ? query.shop_id.toLowerCase() : '';
  if (!want) return scope.shopIds;
  if (!scope.shopIds.includes(want)) throw new HttpError(403, 'Forbidden: that shop is not in your authorized scope.');
  return [want];
}

/** Sellable stock per medicine: unexpired batches only (expired stock cannot be sold). */
const SELLABLE = (R: typeof LOCAL, day: string) => `(SELECT b.shop_id, b.medicine_id, SUM(GREATEST(b.qty, 0))::int AS qty FROM ${R.batches} b
   WHERE b.expiry_date IS NULL OR b.expiry_date > '${day}'::date GROUP BY b.shop_id, b.medicine_id)`;

// ------------------------------------------------------------------ reorder suggestions
export async function reorderSuggestions(scope: HistoryScope, query: Record<string, unknown>) {
  const R = rel(scope);
  const day = await today(scope.q);
  const windowDays = intIn(query.window_days, 30, 7, 180);
  const leadDays = intIn(query.lead_days, 7, 0, 60);
  const coverDays = intIn(query.cover_days, 30, 1, 180);
  const ids = shopIds(scope, query);
  const search = typeof query.search === 'string' && query.search.trim() ? like(query.search.trim()) : null;
  const rows = (await scope.q.query(
    `WITH sold AS (SELECT l.shop_id, l.medicine_id, SUM(l.quantity)::int AS qty FROM ${R.lines} l GROUP BY 1, 2),
          stock AS ${SELLABLE(R, day)}
     SELECT m.shop_id, sh.shop_code, m.id AS medicine_id, m.name, m.generic_name, m.category, m.reorder_level, m.purchase_price,
            COALESCE(st.qty, 0) AS current_stock, COALESCE(so.qty, 0) AS sold, COALESCE(oo.qty, 0) AS on_order
       FROM ${R.meds} m
       LEFT JOIN stock st ON st.shop_id = m.shop_id AND st.medicine_id = m.id
       LEFT JOIN sold so ON so.shop_id = m.shop_id AND so.medicine_id = m.id
       LEFT JOIN ${R.onOrder} oo ON oo.shop_id = m.shop_id AND oo.medicine_id = m.id
       LEFT JOIN ${R.shops} sh ON sh.shop_id = m.shop_id
      WHERE m.status = 'active' AND (COALESCE(so.qty, 0) > 0 OR COALESCE(st.qty, 0) <= m.reorder_level)
        AND ($3::text IS NULL OR m.name ILIKE $3 OR m.generic_name ILIKE $3 OR m.barcode ILIKE $3)`,
    [ids, minusDays(day, windowDays - 1), search])).rows;
  const out = rows.map((r: any) => {
    const avg = Number(r.sold) / windowDays;
    const cover = avg > 0 ? Number(r.current_stock) / avg : null;
    const need = Math.ceil(avg * (leadDays + coverDays)) + Number(r.reorder_level) - Number(r.current_stock) - Number(r.on_order);
    const suggested = Math.max(0, need);
    const urgency = Number(r.current_stock) <= 0 && avg > 0 ? 'OUT_OF_STOCK'
      : cover !== null && cover < leadDays ? 'CRITICAL'
      : Number(r.current_stock) <= Number(r.reorder_level) || (cover !== null && cover < leadDays + 7) ? 'LOW' : 'PLAN';
    return {
      shop_id: r.shop_id, shop_code: r.shop_code, medicine_id: r.medicine_id, name: r.name, generic_name: r.generic_name, category: r.category,
      current_stock: Number(r.current_stock), reorder_level: Number(r.reorder_level), sold_in_window: Number(r.sold), avg_daily_sales: r2(avg),
      days_of_cover: cover === null ? null : Math.round(cover * 10) / 10, on_order: Number(r.on_order), suggested_quantity: suggested, urgency,
      ...(scope.includeCost ? { unit_cost: r2(r.purchase_price), estimated_cost: r2(suggested * Number(r.purchase_price)) } : {}),
    };
  }).filter((x) => x.suggested_quantity > 0);
  const order = { OUT_OF_STOCK: 0, CRITICAL: 1, LOW: 2, PLAN: 3 } as Record<string, number>;
  out.sort((a, b) => order[a.urgency] - order[b.urgency] || (a.days_of_cover ?? -1) - (b.days_of_cover ?? -1) || b.avg_daily_sales! - a.avg_daily_sales!);
  return {
    as_of: day, params: { window_days: windowDays, lead_days: leadDays, cover_days: coverDays },
    rule: 'suggested = ceil(avg daily sales x (lead days + cover days)) + reorder level - current sellable stock - quantity on pending purchase drafts',
    items: out.slice(0, 1000), total: out.length,
    ...(scope.includeCost ? { estimated_total_cost: r2(out.reduce((t, x: any) => t + (x.estimated_cost || 0), 0)) } : {}),
  };
}

// ------------------------------------------------------------------ fast / slow / dead stock
export const MOVEMENT_CLASSES = ['FAST', 'NORMAL', 'SLOW', 'NO_SALES_30', 'NO_SALES_60', 'NO_SALES_90'] as const;
export async function movementAnalysis(scope: HistoryScope, query: Record<string, unknown>) {
  const R = rel(scope);
  const day = await today(scope.q);
  const fast = numIn(query.fast_per_day, 1, 0.01, 1000);
  const slow = numIn(query.slow_per_day, 0.1, 0, fast);
  const ids = shopIds(scope, query);
  const search = typeof query.search === 'string' && query.search.trim() ? like(query.search.trim()) : null;
  const rows = (await scope.q.query(
    `WITH sold AS (SELECT l.shop_id, l.medicine_id,
                          COALESCE(SUM(l.quantity) FILTER (WHERE l.date >= $3::date), 0)::int AS s30,
                          COALESCE(SUM(l.quantity) FILTER (WHERE l.date >= $4::date), 0)::int AS s60,
                          COALESCE(SUM(l.quantity) FILTER (WHERE l.date >= $5::date), 0)::int AS s90,
                          MAX(l.date) AS last_sale
                     FROM ${R.lines} l GROUP BY 1, 2),
          stock AS (SELECT b.shop_id, b.medicine_id, SUM(GREATEST(b.qty, 0))::int AS qty, SUM(GREATEST(b.qty, 0) * b.unit_cost) AS value
                      FROM ${R.batches} b GROUP BY 1, 2)
     SELECT m.shop_id, sh.shop_code, m.id AS medicine_id, m.name, m.generic_name, m.category,
            COALESCE(st.qty, 0) AS qty, COALESCE(st.value, 0) AS value, COALESCE(so.s30, 0) AS s30, COALESCE(so.s60, 0) AS s60, COALESCE(so.s90, 0) AS s90,
            so.last_sale::text AS last_sale
       FROM ${R.meds} m
       LEFT JOIN stock st ON st.shop_id = m.shop_id AND st.medicine_id = m.id
       LEFT JOIN sold so ON so.shop_id = m.shop_id AND so.medicine_id = m.id
       LEFT JOIN ${R.shops} sh ON sh.shop_id = m.shop_id
      WHERE m.status = 'active' AND (COALESCE(st.qty, 0) > 0 OR COALESCE(so.s90, 0) > 0)
        AND ($6::text IS NULL OR m.name ILIKE $6 OR m.generic_name ILIKE $6 OR m.barcode ILIKE $6)`,
    [ids, minusDays(day, 364), minusDays(day, 29), minusDays(day, 59), minusDays(day, 89), search])).rows;
  const items = rows.map((r: any) => {
    const v30 = Number(r.s30) / 30;
    const cls = Number(r.s30) > 0 ? (v30 >= fast ? 'FAST' : v30 < slow ? 'SLOW' : 'NORMAL')
      : Number(r.s60) > 0 ? 'NO_SALES_30' : Number(r.s90) > 0 ? 'NO_SALES_60' : 'NO_SALES_90';
    const since = r.last_sale ? Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.last_sale}T00:00:00Z`)) / 86_400_000) : null;
    return {
      shop_id: r.shop_id, shop_code: r.shop_code, medicine_id: r.medicine_id, name: r.name, generic_name: r.generic_name, category: r.category,
      class: cls, current_quantity: Number(r.qty), sold_30: Number(r.s30), sold_60: Number(r.s60), sold_90: Number(r.s90), velocity_per_day: r2(v30),
      last_sale: r.last_sale, days_since_sale: since, ...(scope.includeCost ? { stock_value: r2(r.value) } : {}),
    };
  });
  const summary = Object.fromEntries(MOVEMENT_CLASSES.map((c) => {
    const xs = items.filter((x) => x.class === c);
    return [c, { medicines: xs.length, units: xs.reduce((t, x) => t + x.current_quantity, 0), ...(scope.includeCost ? { value: r2(xs.reduce((t, x: any) => t + (x.stock_value || 0), 0)) } : {}) }];
  }));
  const want = typeof query.class === 'string' && (MOVEMENT_CLASSES as readonly string[]).includes(query.class) ? query.class : null;
  const list = (want ? items.filter((x) => x.class === want) : items)
    .sort((a, b) => (scope.includeCost ? Number((b as any).stock_value) - Number((a as any).stock_value) : b.current_quantity - a.current_quantity) || a.name.localeCompare(b.name));
  return {
    as_of: day, params: { fast_per_day: fast, slow_per_day: slow },
    rule: 'last 30 days: FAST >= fast_per_day units/day, SLOW < slow_per_day, else NORMAL; no sale in 30 / 60 / 90 days otherwise (only medicines with stock or recent sales)',
    summary, items: list.slice(0, 2000), total: list.length,
  };
}

// ------------------------------------------------------------------ expiry risk
export const EXPIRY_RISKS = ['EXPIRED', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export async function expiryRisk(scope: HistoryScope, query: Record<string, unknown>) {
  const R = rel(scope);
  const day = await today(scope.q);
  const ids = shopIds(scope, query);
  const search = typeof query.search === 'string' && query.search.trim() ? like(query.search.trim()) : null;
  const rows = (await scope.q.query(
    `WITH sold AS (SELECT l.shop_id, l.medicine_id, SUM(l.quantity)::int AS s90 FROM ${R.lines} l GROUP BY 1, 2),
          b AS (SELECT b.*, SUM(b.qty) OVER (PARTITION BY b.shop_id, b.medicine_id ORDER BY b.expiry_date NULLS LAST, b.id) AS through_qty
                  FROM ${R.batches} b WHERE b.qty > 0)
     SELECT b.shop_id, sh.shop_code, b.medicine_id, m.name, m.generic_name, b.id AS batch_id, b.batch_number, b.expiry_date::text AS expiry_date, b.qty,
            b.unit_cost, b.unit_price, b.through_qty, COALESCE(so.s90, 0) AS s90, (b.expiry_date - $3::date) AS days_remaining
       FROM b JOIN ${R.meds} m ON m.shop_id = b.shop_id AND m.id = b.medicine_id
       LEFT JOIN sold so ON so.shop_id = b.shop_id AND so.medicine_id = b.medicine_id
       LEFT JOIN ${R.shops} sh ON sh.shop_id = b.shop_id
      WHERE ($4::text IS NULL OR m.name ILIKE $4 OR m.generic_name ILIKE $4 OR m.barcode ILIKE $4 OR b.batch_number ILIKE $4)`,
    [ids, minusDays(day, 89), day, search])).rows;
  const items = rows.map((r: any) => {
    const v = Number(r.s90) / 90;
    const days = r.days_remaining === null ? null : Number(r.days_remaining);
    const toSell = v > 0 ? Math.ceil(Number(r.through_qty) / v) : null;
    let risk: string;
    if (days === null) risk = 'UNKNOWN';
    else if (days <= 0) risk = 'EXPIRED';
    else if (toSell === null) risk = days <= 180 ? 'HIGH' : days <= 365 ? 'MEDIUM' : 'LOW';
    else risk = days <= 30 || toSell > days ? 'HIGH' : days <= 90 || toSell > days * 0.75 ? 'MEDIUM' : 'LOW';
    return {
      shop_id: r.shop_id, shop_code: r.shop_code, medicine_id: r.medicine_id, name: r.name, generic_name: r.generic_name, batch_id: r.batch_id,
      batch_number: r.batch_number, quantity: Number(r.qty), expiry_date: r.expiry_date, days_remaining: days,
      avg_daily_sales: r2(v), estimated_days_to_sell: toSell, risk, retail_value: r2(Number(r.qty) * Number(r.unit_price)),
      ...(scope.includeCost ? { purchase_value: r2(Number(r.qty) * Number(r.unit_cost)) } : {}),
    };
  });
  const summary = Object.fromEntries(EXPIRY_RISKS.map((k) => {
    const xs = items.filter((x) => x.risk === k);
    return [k, { batches: xs.length, units: xs.reduce((t, x) => t + x.quantity, 0), retail_value: r2(xs.reduce((t, x) => t + (x.retail_value || 0), 0)),
      ...(scope.includeCost ? { purchase_value: r2(xs.reduce((t, x: any) => t + (x.purchase_value || 0), 0)) } : {}) }];
  }));
  const want = typeof query.risk === 'string' && (EXPIRY_RISKS as readonly string[]).includes(query.risk) ? query.risk : null;
  const order = { EXPIRED: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 } as Record<string, number>;
  const list = (want ? items.filter((x) => x.risk === want) : items).sort((a, b) => order[a.risk] - order[b.risk] || (a.days_remaining ?? 99999) - (b.days_remaining ?? 99999));
  return {
    as_of: day,
    rule: 'velocity = units sold in the last 90 days / 90; days to sell = units of this and earlier-expiring batches (FEFO) / velocity. EXPIRED: expiry reached; HIGH: <= 30 days left or cannot be sold in time (no sales: <= 180 days); MEDIUM: <= 90 days or > 75% of the time left (no sales: <= 365 days); LOW otherwise',
    summary, items: list.slice(0, 3000), total: list.length,
  };
}

// ------------------------------------------------------------------ stock reconciliation (local ledger)
export const RECON_STATUSES = ['BALANCED', 'SHORT', 'OVER', 'INCOMPLETE_HISTORY'] as const;
export async function stockReconciliation(scope: HistoryScope, query: Record<string, unknown>) {
  if (scope.mode !== 'local') throw new HttpError(501, 'Stock reconciliation runs on the shop computer (its movement ledger is authoritative).');
  const search = typeof query.search === 'string' && query.search.trim() ? like(query.search.trim()) : null;
  const rows = (await scope.q.query(
    `WITH last AS (
       SELECT b.id AS batch_id, b.medicine_id, COALESCE(b.quantity_available, 0)::int AS actual, lm.new_quantity AS ledger, lm.created_at AS last_movement,
              COALESCE(NULLIF(b.purchase_price, 0), m.purchase_price, 0) AS unit_cost
         FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
         LEFT JOIN LATERAL (SELECT mv.new_quantity, mv.created_at FROM inventory_movements mv WHERE mv.batch_id = b.id
                             ORDER BY mv.created_at DESC, mv.id DESC LIMIT 1) lm ON TRUE)
     SELECT m.id AS medicine_id, m.name, m.generic_name, (SELECT cat.name FROM categories cat WHERE cat.id = m.category_id) AS category, COALESCE(m.current_stock, 0)::int AS medicine_stock,
            COALESCE(SUM(l.actual), 0)::int AS actual,
            COALESCE(SUM(COALESCE(l.ledger, 0)), 0)::int AS ledger,
            COUNT(*) FILTER (WHERE l.batch_id IS NOT NULL AND l.ledger IS NULL AND l.actual <> 0)::int AS batches_without_history,
            COALESCE(SUM((l.actual - COALESCE(l.ledger, l.actual)) * l.unit_cost), 0) AS variance_cost,
            MAX(l.last_movement) AS last_movement,
            (SELECT MAX(c.created_at) FROM inventory_movements c WHERE c.medicine_id = m.id AND c.movement_type = 'PHYSICAL_STOCK_COUNT') AS last_count
       FROM medicines m LEFT JOIN last l ON l.medicine_id = m.id
      WHERE m.status = 'active' AND ($1::text IS NULL OR m.name ILIKE $1 OR m.generic_name ILIKE $1 OR m.barcode ILIKE $1)
      GROUP BY m.id`, [search])).rows;
  const items = rows.map((r: any) => {
    const variance = Number(r.actual) - Number(r.ledger);
    const status = Number(r.batches_without_history) > 0 ? 'INCOMPLETE_HISTORY' : variance === 0 ? 'BALANCED' : variance < 0 ? 'SHORT' : 'OVER';
    return {
      medicine_id: r.medicine_id, name: r.name, generic_name: r.generic_name, category: r.category,
      expected: Number(r.ledger), actual: Number(r.actual), variance, status,
      batches_without_history: Number(r.batches_without_history), last_count: r.last_count, last_movement: r.last_movement,
      ...(scope.includeCost ? { variance_cost: r2(r.variance_cost) } : {}),
    };
  });
  const summary = Object.fromEntries(RECON_STATUSES.map((k) => [k, items.filter((x) => x.status === k).length]));
  const want = typeof query.status === 'string' && (RECON_STATUSES as readonly string[]).includes(query.status) ? query.status : null;
  const order = { SHORT: 0, OVER: 1, INCOMPLETE_HISTORY: 2, BALANCED: 3 } as Record<string, number>;
  const list = (want ? items.filter((x) => x.status === want) : items).sort((a, b) => order[a.status] - order[b.status] || Math.abs(b.variance) - Math.abs(a.variance) || a.name.localeCompare(b.name));
  return {
    rule: 'expected = the last balance the movement ledger recorded for each batch; actual = the batch quantity now. A batch holding stock with no movement at all = INCOMPLETE_HISTORY (imported stock). Day-by-day opening / sold / received / adjustments / closing: History -> Stock History.',
    summary, items: list.slice(0, 3000), total: list.length,
  };
}
