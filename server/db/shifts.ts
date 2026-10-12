import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow, cleanUuid, isValidUuid, type Queryable } from './client';
import { ensureDevice } from './devices';
import { recordAuditLog } from './audit';
import { enqueueSyncEvent, rowJson } from '../sync/outbox';
import type { SaleActor } from './sales';
import type { HistoryScope } from './history';

/**
 * CASHIER SHIFTS + CASH RECONCILIATION (local migration 020, cloud migration 009).
 *
 * Lifecycle:  OPEN (opening float) -> CLOSED (actual cash counted) -> REVIEWED (Administrator / Manager)
 *
 * Writes run ONLY on the shop server, in one local PostgreSQL transaction each (audit + outbox event in
 * the same transaction): opening / closing a shift never needs the internet. The outbox ships
 * SHIFT_OPENED / SHIFT_CLOSED / SHIFT_REVIEWED / SHIFT_CORRECTED to the cloud when it is reachable.
 *
 * What belongs to a shift (tagged when the transaction happens, never guessed from time windows):
 *   sales.shift_id            every sale completed while the seller's shift was open
 *   returns.refund_shift_id   an APPROVED refund paid from that till (the requesting cashier's open shift,
 *                             else the approver's own open shift; else no till)
 *   expenses.shift_id         a CASH expense an Administrator recorded as "paid from this till"
 *
 * EXPECTED CASH = opening float + cash sales - cash refunds - cash till expenses
 *   cash sales     = Cash payment lines of the shift's NON-VOIDED sales (a split sale counts only its
 *                    Cash part; a Cash line stores the sale share, change is never included)
 *   cash refunds   = APPROVED returns attributed to the shift with refund_method Cash
 *   cash expenses  = POSTED expenses attributed to the shift (always payment_method Cash)
 * M-Pesa / Card / Bank never change the drawer. PENDING / REJECTED returns and voided expenses count for
 * nothing. A voided sale is excluded from every sales figure (it is reported as voided). A sale of a
 * CLOSED shift can no longer be voided (its cash was counted): it is returned instead, and that refund
 * belongs to the till that pays it.
 *
 * The figures computed at close are stored on the shift and never rewritten. A later correction of the
 * counted cash is a separate, audited cashier_shift_corrections row.
 */

export type ShiftStatus = 'OPEN' | 'CLOSED' | 'REVIEWED';
export const REFUND_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

const toCents = (n: unknown) => Math.round(Number(n || 0) * 100);
const fromCents = (c: number) => c / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MAX_CASH = 100_000_000;

/** Validates a cash amount typed by a person: >= 0, at most 2 decimals. */
export function parseCash(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') throw new HttpError(400, `${field} is required.`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (n > MAX_CASH) throw new HttpError(400, `${field} is too large.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new HttpError(400, `${field} may have at most 2 decimal places.`);
  return Math.round(n * 100) / 100;
}

export function varianceLabel(variance: number | null | undefined): 'BALANCED' | 'SHORT' | 'OVER' | null {
  if (variance === null || variance === undefined) return null;
  const c = toCents(variance);
  return c === 0 ? 'BALANCED' : c < 0 ? 'SHORT' : 'OVER';
}

// ============================================================================ relations (local / cloud)
const LOCAL = {
  shops: `(SELECT si.shop_id, si.shop_code, COALESCE(si.shop_name, 'This shop') AS shop_name FROM shop_identity si WHERE si.shop_id = ANY($1::uuid[]))`,
  shifts: `(SELECT ($1::uuid[])[1] AS shop_id, x.id, x.shift_number, x.cashier_id, u.name AS cashier_name, x.device_id, x.status,
             x.opened_at, x.opened_business_date, x.opening_float, x.opened_by_name, x.closed_at, x.closed_business_date, x.closed_by_name,
             x.close_method, x.admin_close_reason, x.total_transactions, x.total_sales, x.cash_sales, x.mpesa_sales, x.card_sales, x.bank_sales,
             x.other_sales, x.units_sold, x.voided_count, x.voided_total, x.returns_count, x.refund_total, x.cash_refunds, x.cash_expenses,
             x.expected_cash, x.actual_cash, x.cash_variance, x.closing_notes, x.reviewed_by_name, x.reviewed_at, x.review_notes
             FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id)`,
  corrections: `(SELECT ($1::uuid[])[1] AS shop_id, c.id, c.shift_id, c.previous_actual_cash, c.corrected_actual_cash, c.expected_cash,
             c.corrected_variance, c.reason, c.created_by_name, c.created_at FROM cashier_shift_corrections c)`,
  sales: `(SELECT ($1::uuid[])[1] AS shop_id, s.id, s.shift_id, s.total, s.status, s.receipt_number, s.date, s.time::text AS time, s.payment_method
             FROM sales s)`,
  payments: `(SELECT ($1::uuid[])[1] AS shop_id, p.sale_id, p.method, p.amount FROM payments p)`,
  items: `(SELECT ($1::uuid[])[1] AS shop_id, i.sale_id, i.medicine_id, i.quantity FROM sale_items i)`,
  returns: `(SELECT ($1::uuid[])[1] AS shop_id, r.id, r.sale_id, r.receipt_number, r.refund_shift_id, r.refund_method, r.refund_amount,
             r.approved_quantity, r.medicine_id, r.status, r.reviewed_at FROM returns r)`,
  expenses: `(SELECT ($1::uuid[])[1] AS shop_id, e.id, e.shift_id, e.amount, e.payment_method, e.status, e.category, e.description, e.created_at
             FROM expenses e)`,
  medicines: `(SELECT ($1::uuid[])[1] AS shop_id, m.id, m.name FROM medicines m)`,
};

const CLOUD = {
  shops: `(SELECT s.shop_id, s.shop_code, s.name AS shop_name FROM giga_cloud.shops s WHERE s.shop_id = ANY($1::uuid[]))`,
  shifts: `(SELECT c.shop_id, c.shift_id AS id, c.shift_number, c.cashier_id, COALESCE(u.name, c.cashier_name) AS cashier_name, c.device_id, c.status,
             c.opened_at, c.opened_business_date, c.opening_float, c.data->>'opened_by_name' AS opened_by_name, c.closed_at, c.closed_business_date,
             c.data->>'closed_by_name' AS closed_by_name, c.data->>'close_method' AS close_method, c.data->>'admin_close_reason' AS admin_close_reason,
             (c.data->>'total_transactions')::int AS total_transactions, (c.data->>'total_sales')::numeric AS total_sales,
             (c.data->>'cash_sales')::numeric AS cash_sales, (c.data->>'mpesa_sales')::numeric AS mpesa_sales, (c.data->>'card_sales')::numeric AS card_sales,
             (c.data->>'bank_sales')::numeric AS bank_sales, (c.data->>'other_sales')::numeric AS other_sales, (c.data->>'units_sold')::int AS units_sold,
             (c.data->>'voided_count')::int AS voided_count, (c.data->>'voided_total')::numeric AS voided_total,
             (c.data->>'returns_count')::int AS returns_count, (c.data->>'refund_total')::numeric AS refund_total,
             (c.data->>'cash_refunds')::numeric AS cash_refunds, (c.data->>'cash_expenses')::numeric AS cash_expenses,
             c.expected_cash, c.actual_cash, c.cash_variance, c.data->>'closing_notes' AS closing_notes, c.data->>'reviewed_by_name' AS reviewed_by_name,
             c.reviewed_at, c.data->>'review_notes' AS review_notes
             FROM giga_cloud.cashier_shifts c LEFT JOIN giga_cloud.users u ON u.shop_id = c.shop_id AND u.user_id = c.cashier_id
            WHERE c.shop_id = ANY($1::uuid[]))`,
  corrections: `(SELECT c.shop_id, c.correction_id AS id, c.shift_id, c.previous_actual_cash, c.corrected_actual_cash, c.expected_cash,
             c.corrected_variance, c.reason, c.created_by_name, c.created_at FROM giga_cloud.cashier_shift_corrections c WHERE c.shop_id = ANY($1::uuid[]))`,
  sales: `(SELECT s.shop_id, s.sale_id AS id, (s.data->>'shift_id')::uuid AS shift_id, s.total, s.status, s.receipt_number, s.business_date AS date,
             s.business_time AS time, s.payment_method FROM giga_cloud.sales s WHERE s.shop_id = ANY($1::uuid[]))`,
  payments: `(SELECT p.shop_id, p.sale_id, p.method, p.amount FROM giga_cloud.payments p WHERE p.shop_id = ANY($1::uuid[]))`,
  items: `(SELECT i.shop_id, i.sale_id, i.medicine_id, i.quantity FROM giga_cloud.sale_items i WHERE i.shop_id = ANY($1::uuid[]))`,
  returns: `(SELECT r.shop_id, r.return_id AS id, r.sale_id, r.receipt_number, (r.data->>'refund_shift_id')::uuid AS refund_shift_id,
             r.data->>'refund_method' AS refund_method, r.refund_amount, r.approved_quantity, r.medicine_id, r.status, r.reviewed_at
             FROM giga_cloud.returns r WHERE r.shop_id = ANY($1::uuid[]))`,
  expenses: `(SELECT e.shop_id, e.expense_id AS id, (e.data->>'shift_id')::uuid AS shift_id, e.amount, e.payment_method,
             COALESCE(e.data->>'status', 'posted') AS status, e.category, e.description, NULLIF(e.data->>'created_at', '')::timestamptz AS created_at
             FROM giga_cloud.expenses e WHERE e.shop_id = ANY($1::uuid[]))`,
  medicines: `(SELECT m.shop_id, m.medicine_id AS id, m.name FROM giga_cloud.medicines m WHERE m.shop_id = ANY($1::uuid[]))`,
};
type Rel = typeof LOCAL;
const rel = (s: HistoryScope): Rel => (s.mode === 'local' ? LOCAL : CLOUD);

// ============================================================================ totals (the ONE formula)
export interface ShiftTotals {
  total_transactions: number;
  total_sales: number;
  cash_sales: number;
  mpesa_sales: number;
  card_sales: number;
  bank_sales: number;
  other_sales: number;
  mixed_transactions: number;
  units_sold: number;
  voided_count: number;
  voided_total: number;
  returns_count: number;
  refund_total: number;
  cash_refunds: number;
  non_cash_refunds: number;
  cash_expenses: number;
  net_sales: number;
}

const EMPTY_TOTALS: ShiftTotals = {
  total_transactions: 0, total_sales: 0, cash_sales: 0, mpesa_sales: 0, card_sales: 0, bank_sales: 0, other_sales: 0, mixed_transactions: 0,
  units_sold: 0, voided_count: 0, voided_total: 0, returns_count: 0, refund_total: 0, cash_refunds: 0, non_cash_refunds: 0, cash_expenses: 0, net_sales: 0,
};

/**
 * Live figures of the given shifts from the transactions tagged with them. Same SQL for the shop's own
 * PostgreSQL (local) and for the cloud copy (cloud; there an OPEN shift shows what has synced so far).
 */
export async function computeShiftTotals(scope: HistoryScope, shiftIds: string[]): Promise<Map<string, ShiftTotals>> {
  const out = new Map<string, ShiftTotals>();
  if (shiftIds.length === 0) return out;
  const R = rel(scope);
  const rows = (await scope.q.query(
    `WITH ss AS (
       SELECT s.shop_id, s.shift_id, s.id, s.total, lower(COALESCE(s.status, 'completed')) AS status FROM ${R.sales} s WHERE s.shift_id = ANY($2::uuid[])),
     agg AS (
       SELECT shift_id, COUNT(*) FILTER (WHERE status <> 'voided')::int AS txn,
              COALESCE(SUM(total) FILTER (WHERE status <> 'voided'), 0)::numeric AS total_sales,
              COUNT(*) FILTER (WHERE status = 'voided')::int AS voided_count,
              COALESCE(SUM(total) FILTER (WHERE status = 'voided'), 0)::numeric AS voided_total
         FROM ss GROUP BY shift_id),
     ps AS (
       SELECT ss.shift_id, p.sale_id, lower(regexp_replace(COALESCE(p.method, ''), '[^A-Za-z]', '', 'g')) AS m, p.amount
         FROM ${R.payments} p JOIN ss ON ss.shop_id = p.shop_id AND ss.id = p.sale_id WHERE ss.status <> 'voided'),
     pay AS (
       SELECT shift_id,
              COALESCE(SUM(amount) FILTER (WHERE m = 'cash'), 0)::numeric AS cash,
              COALESCE(SUM(amount) FILTER (WHERE m IN ('mpesa', 'mobilemoney', 'mobile')), 0)::numeric AS mpesa,
              COALESCE(SUM(amount) FILTER (WHERE m = 'card'), 0)::numeric AS card,
              COALESCE(SUM(amount) FILTER (WHERE m = 'bank'), 0)::numeric AS bank,
              COALESCE(SUM(amount) FILTER (WHERE m NOT IN ('cash', 'mpesa', 'mobilemoney', 'mobile', 'card', 'bank')), 0)::numeric AS other
         FROM ps GROUP BY shift_id),
     mix AS (SELECT shift_id, COUNT(*)::int AS n FROM (SELECT shift_id, sale_id FROM ps GROUP BY shift_id, sale_id HAVING COUNT(*) > 1) x GROUP BY shift_id),
     units AS (
       SELECT ss.shift_id, COALESCE(SUM(i.quantity) FILTER (WHERE i.quantity > 0), 0)::int AS units
         FROM ${R.items} i JOIN ss ON ss.shop_id = i.shop_id AND ss.id = i.sale_id WHERE ss.status <> 'voided' GROUP BY ss.shift_id),
     ref AS (
       SELECT r.refund_shift_id AS shift_id, COUNT(*)::int AS n, COALESCE(SUM(r.refund_amount), 0)::numeric AS total,
              COALESCE(SUM(r.refund_amount) FILTER (WHERE COALESCE(r.refund_method, 'Cash') = 'Cash'), 0)::numeric AS cash
         FROM ${R.returns} r WHERE r.refund_shift_id = ANY($2::uuid[]) AND r.status = 'APPROVED' GROUP BY r.refund_shift_id),
     exp AS (
       SELECT e.shift_id, COALESCE(SUM(e.amount), 0)::numeric AS cash
         FROM ${R.expenses} e WHERE e.shift_id = ANY($2::uuid[]) AND lower(e.status) = 'posted' AND e.payment_method = 'Cash' GROUP BY e.shift_id)
     SELECT id.shift_id, agg.txn, agg.total_sales, agg.voided_count, agg.voided_total, pay.cash, pay.mpesa, pay.card, pay.bank, pay.other,
            mix.n AS mixed, units.units, ref.n AS returns_count, ref.total AS refund_total, ref.cash AS cash_refunds, exp.cash AS cash_expenses
       FROM unnest($2::uuid[]) AS id(shift_id)
       LEFT JOIN agg ON agg.shift_id = id.shift_id LEFT JOIN pay ON pay.shift_id = id.shift_id LEFT JOIN mix ON mix.shift_id = id.shift_id
       LEFT JOIN units ON units.shift_id = id.shift_id LEFT JOIN ref ON ref.shift_id = id.shift_id LEFT JOIN exp ON exp.shift_id = id.shift_id`,
    [scope.shopIds, shiftIds]
  )).rows;
  for (const r of rows) {
    const refundTotal = toCents(r.refund_total), cashRefunds = toCents(r.cash_refunds), totalSales = toCents(r.total_sales);
    out.set(String(r.shift_id), {
      total_transactions: Number(r.txn) || 0,
      total_sales: fromCents(totalSales),
      cash_sales: fromCents(toCents(r.cash)),
      mpesa_sales: fromCents(toCents(r.mpesa)),
      card_sales: fromCents(toCents(r.card)),
      bank_sales: fromCents(toCents(r.bank)),
      other_sales: fromCents(toCents(r.other)),
      mixed_transactions: Number(r.mixed) || 0,
      units_sold: Number(r.units) || 0,
      voided_count: Number(r.voided_count) || 0,
      voided_total: fromCents(toCents(r.voided_total)),
      returns_count: Number(r.returns_count) || 0,
      refund_total: fromCents(refundTotal),
      cash_refunds: fromCents(cashRefunds),
      non_cash_refunds: fromCents(refundTotal - cashRefunds),
      cash_expenses: fromCents(toCents(r.cash_expenses)),
      net_sales: fromCents(totalSales - refundTotal),
    });
  }
  return out;
}

/** EXPECTED CASH = opening float + cash sales - cash refunds - cash till expenses (integer cents). */
export function expectedCash(openingFloat: number, t: Pick<ShiftTotals, 'cash_sales' | 'cash_refunds' | 'cash_expenses'>): number {
  return fromCents(toCents(openingFloat) + toCents(t.cash_sales) - toCents(t.cash_refunds) - toCents(t.cash_expenses));
}

// ============================================================================ local writes
const actorName = (a: SaleActor) => (a.user_name || 'Staff').slice(0, 255);

async function shopScope(client: pg.PoolClient): Promise<HistoryScope> {
  const id = (await client.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0]?.shop_id;
  return { q: client, mode: 'local', shopIds: [String(id || '00000000-0000-0000-0000-000000000000').toLowerCase()], includeCost: false };
}

async function enqueueShift(client: pg.PoolClient, type: 'SHIFT_OPENED' | 'SHIFT_CLOSED' | 'SHIFT_REVIEWED' | 'SHIFT_CORRECTED', shiftId: string,
  actor: SaleActor, deviceId: string | null, extra: Record<string, unknown> = {}) {
  await enqueueSyncEvent(client, {
    event_type: type,
    entity_type: 'cashier_shift',
    entity_id: shiftId,
    operation: type.replace('SHIFT_', ''),
    // Business totals only: no password, PIN or token is part of a shift.
    data: async () => {
      const shift = await rowJson(client, 'cashier_shifts', shiftId);
      const cashier = shift ? (await client.query('SELECT name FROM users WHERE id = $1', [shift.cashier_id])).rows[0]?.name ?? null : null;
      return { shift, cashier_name: cashier, ...extra };
    },
    actor,
    device_id: deviceId,
    business_ref: (await client.query('SELECT shift_number FROM cashier_shifts WHERE id = $1', [shiftId])).rows[0]?.shift_number ?? null,
  });
}

/** The actor's OPEN shift (or null). */
export async function getOpenShiftRow(q: Queryable, cashierId: string) {
  return (await q.query(`SELECT * FROM cashier_shifts WHERE cashier_id = $1 AND status = 'OPEN'`, [cashierId])).rows[0] || null;
}

/**
 * Opens the actor's shift. If one is already OPEN it is returned unchanged (never a second one): the
 * unique index uq_cashier_shifts_one_open makes this safe under concurrent requests too.
 */
export async function openShift(input: { opening_float?: unknown }, actor: SaleActor) {
  const userId = cleanUuid(actor.user_id);
  if (!userId) throw new HttpError(403, 'Only a shop staff account can open a shift.');
  const openingFloat = parseCash(input?.opening_float, 'Opening cash float');
  const attempt = () => withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift-open:${userId}`]);
    const existing = await getOpenShiftRow(client, userId);
    if (existing) return { created: false, id: existing.id as string };
    const deviceId = await ensureDevice(client, actor.device_id, userId);
    const { date } = await businessNow(client);
    const seq = (await client.query(`SELECT nextval('cashier_shift_seq') AS n`)).rows[0].n;
    const id = crypto.randomUUID();
    const number = `SHIFT-${date.replace(/-/g, '')}-${String(seq).padStart(5, '0')}`;
    await client.query(
      `INSERT INTO cashier_shifts (id, shift_number, cashier_id, device_id, status, opened_business_date, opening_float, opened_by, opened_by_name)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $3, $7)`,
      [id, number, userId, deviceId, date, openingFloat, actorName(actor)]
    );
    await recordAuditLog({
      user_id: userId, user_name: actor.user_name, role: actor.role, device_id: deviceId,
      action: 'SHIFT_OPENED', entity: 'cashier_shift', entity_id: id,
      new_value: { shift_number: number, opening_float: openingFloat, business_date: date },
    }, client);
    await enqueueShift(client, 'SHIFT_OPENED', id, actor, deviceId);
    return { created: true, id };
  });
  let res: { created: boolean; id: string };
  try {
    res = await attempt();
  } catch (err: any) {
    if (err?.code !== '23505') throw err;
    res = await attempt(); // a concurrent open won the race: return that shift
  }
  return { created: res.created, ...(await currentShiftView(res.id)) };
}

/** The actor's current shift with LIVE totals (POS status strip / close screen). */
export async function getCurrentShift(actor: SaleActor) {
  const userId = cleanUuid(actor.user_id);
  if (!userId) return { shift: null };
  const row = await getOpenShiftRow(pgPool, userId);
  if (!row) return { shift: null };
  return currentShiftView(row.id);
}

async function currentShiftView(shiftId: string) {
  const client = await pgPool.connect();
  try {
    const scope = await shopScope(client);
    const shift = (await client.query(`SELECT x.*, u.name AS cashier_name FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id WHERE x.id = $1`, [shiftId])).rows[0];
    if (!shift) return { shift: null };
    const totals = (await computeShiftTotals(scope, [shiftId])).get(shiftId) || EMPTY_TOTALS;
    const live = { ...totals, expected_cash: expectedCash(Number(shift.opening_float), totals) };
    return { shift: shiftRow(shift, shift.status === 'OPEN' ? live : null), live };
  } finally {
    client.release();
  }
}

/** Medicines sold in a shift (non-voided sales) and returned through refunds paid from it. Read only. */
export async function shiftMedicines(scope: HistoryScope, shiftId: string, shopId?: string | null) {
  if (!isValidUuid(shiftId)) throw new HttpError(400, 'Shift id must be a UUID.');
  const R = rel(scope);
  const rows = (await scope.q.query(
    `WITH ss AS (SELECT s.shop_id, s.id FROM ${R.sales} s WHERE s.shift_id = $2::uuid AND lower(COALESCE(s.status, '')) <> 'voided'
                 AND ($3::uuid IS NULL OR s.shop_id = $3::uuid)),
     sold AS (SELECT i.shop_id, i.medicine_id, SUM(i.quantity)::int AS qty FROM ${R.items} i JOIN ss ON ss.shop_id = i.shop_id AND ss.id = i.sale_id
               WHERE i.quantity > 0 GROUP BY 1, 2),
     ret AS (SELECT r.shop_id, r.medicine_id, SUM(r.approved_quantity)::int AS qty FROM ${R.returns} r
              WHERE r.refund_shift_id = $2::uuid AND r.status = 'APPROVED' AND ($3::uuid IS NULL OR r.shop_id = $3::uuid) GROUP BY 1, 2)
     SELECT COALESCE(sold.medicine_id, ret.medicine_id) AS medicine_id, m.name, COALESCE(sold.qty, 0) AS sold, COALESCE(ret.qty, 0) AS returned
       FROM sold FULL JOIN ret ON ret.shop_id = sold.shop_id AND ret.medicine_id = sold.medicine_id
       LEFT JOIN ${R.medicines} m ON m.shop_id = COALESCE(sold.shop_id, ret.shop_id) AND m.id = COALESCE(sold.medicine_id, ret.medicine_id)
      ORDER BY COALESCE(sold.qty, 0) DESC, m.name NULLS LAST`,
    [scope.shopIds, shiftId, shopId || null]
  )).rows;
  const medicines = rows.map((r: any) => ({
    medicine_id: r.medicine_id, name: r.name || 'Item', quantity_sold: Number(r.sold), returned: Number(r.returned), net_sold: Number(r.sold) - Number(r.returned),
  }));
  return {
    shift_id: shiftId,
    medicines,
    totals: medicines.reduce((t, m) => ({ quantity_sold: t.quantity_sold + m.quantity_sold, returned: t.returned + m.returned, net_sold: t.net_sold + m.net_sold }),
      { quantity_sold: 0, returned: 0, net_sold: 0 }),
  };
}

export interface CloseShiftInput {
  actual_cash?: unknown;
  closing_notes?: unknown;
  /** Expected cash the closer was shown; when it no longer matches the server's figure the close is refused. */
  expected_cash_seen?: unknown;
  /** Required for an Administrator's controlled closure of SOMEONE ELSE's shift. */
  admin_close_reason?: unknown;
}

/**
 * Closes a shift. The cashier closes their own shift; an Administrator may close another person's shift
 * (forgotten shift) only with a reason, entering the cash they counted. Never automatic, never a made-up
 * count. Expected cash, every total and the variance are computed here from the tagged transactions.
 */
export async function closeShift(shiftIdRaw: string, input: CloseShiftInput, actor: SaleActor) {
  const shiftId = requireUuid(shiftIdRaw, 'shift id');
  const userId = cleanUuid(actor.user_id);
  if (!userId) throw new HttpError(403, 'Only a shop staff account can close a shift.');
  const actual = parseCash(input?.actual_cash, 'Actual cash counted');
  const notes = str(input?.closing_notes, 1000) || null;
  return withTransaction(async (client) => {
    // FOR UPDATE: waits for in-flight checkouts / refunds / till expenses of this shift (they hold FOR SHARE).
    const shift = (await client.query('SELECT * FROM cashier_shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.status !== 'OPEN') throw new HttpError(409, `This shift is already ${String(shift.status).toLowerCase()}; a closed shift cannot be changed or reopened.`);
    const own = shift.cashier_id === userId;
    let method: 'CASHIER' | 'ADMIN' = 'CASHIER';
    let adminReason: string | null = null;
    if (!own) {
      if (actor.role !== 'ADMIN') throw new HttpError(403, 'You can only close your own shift.');
      adminReason = str(input?.admin_close_reason, 1000);
      if (adminReason.length < 3) throw new HttpError(400, "A reason is required to close another person's shift.");
      method = 'ADMIN';
    }
    const scope = await shopScope(client);
    const t = (await computeShiftTotals(scope, [shiftId])).get(shiftId) || EMPTY_TOTALS;
    const expected = expectedCash(Number(shift.opening_float), t);
    if (input?.expected_cash_seen !== undefined && input?.expected_cash_seen !== null && input?.expected_cash_seen !== '') {
      const seen = Number(input.expected_cash_seen);
      if (!Number.isFinite(seen) || toCents(seen) !== toCents(expected)) {
        throw Object.assign(new HttpError(409, 'New transactions changed the expected cash since the close screen was opened. Review the figures and close again.'),
          { code: 'SHIFT_TOTALS_CHANGED', details: { expected_cash: expected } });
      }
    }
    const variance = fromCents(toCents(actual) - toCents(expected));
    if (toCents(variance) !== 0 && (!notes || notes.length < 3)) {
      throw Object.assign(new HttpError(400, `The counted cash differs from the expected cash by ${variance.toFixed(2)}. Explain the difference (closing notes).`),
        { code: 'VARIANCE_REASON_REQUIRED' });
    }
    const deviceId = await ensureDevice(client, actor.device_id, userId);
    const { date } = await businessNow(client);
    await client.query(
      `UPDATE cashier_shifts SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_business_date = $2, closed_by = $3, closed_by_name = $4,
         close_method = $5, admin_close_reason = $6,
         total_transactions = $7, total_sales = $8, cash_sales = $9, mpesa_sales = $10, card_sales = $11, bank_sales = $12, other_sales = $13,
         units_sold = $14, voided_count = $15, voided_total = $16, returns_count = $17, refund_total = $18, cash_refunds = $19, cash_expenses = $20,
         expected_cash = $21, actual_cash = $22, cash_variance = $23, closing_notes = $24, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [shiftId, date, userId, actorName(actor), method, adminReason,
        t.total_transactions, t.total_sales, t.cash_sales, t.mpesa_sales, t.card_sales, t.bank_sales, t.other_sales,
        t.units_sold, t.voided_count, t.voided_total, t.returns_count, t.refund_total, t.cash_refunds, t.cash_expenses,
        expected, actual, variance, notes]
    );
    await recordAuditLog({
      user_id: userId, user_name: actor.user_name, role: actor.role, device_id: deviceId,
      action: method === 'ADMIN' ? 'SHIFT_CLOSED_BY_ADMIN' : 'SHIFT_CLOSED', entity: 'cashier_shift', entity_id: shiftId,
      previous_value: { status: 'OPEN' },
      new_value: {
        shift_number: shift.shift_number, opening_float: Number(shift.opening_float), cash_sales: t.cash_sales, cash_refunds: t.cash_refunds,
        cash_expenses: t.cash_expenses, expected_cash: expected, actual_cash: actual, cash_variance: variance, variance_status: varianceLabel(variance),
        closing_notes: notes, ...(adminReason ? { admin_close_reason: adminReason, cashier_id: shift.cashier_id } : {}),
      },
    }, client);
    await enqueueShift(client, 'SHIFT_CLOSED', shiftId, actor, deviceId);
    const saved = (await client.query(`SELECT x.*, u.name AS cashier_name FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id WHERE x.id = $1`, [shiftId])).rows[0];
    return { success: true, shift: shiftRow(saved, null), medicines: (await shiftMedicines(scope, shiftId)).medicines };
  });
}

/** Administrator / Manager review of a CLOSED shift (CLOSED -> REVIEWED). Figures are never changed. */
export async function reviewShiftTx(client: pg.PoolClient, shiftId: string, notesRaw: unknown, actor: SaleActor) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw new HttpError(403, 'Only an Administrator or Manager can review shifts.');
  const notes = str(notesRaw, 1000) || null;
  const shift = (await client.query('SELECT * FROM cashier_shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
  if (!shift) throw new HttpError(404, 'Shift not found.');
  if (shift.status === 'OPEN') throw new HttpError(409, 'An open shift cannot be reviewed; it must be closed first.');
  if (shift.status === 'REVIEWED') throw new HttpError(409, 'This shift was already reviewed.');
  const userId = cleanUuid(actor.user_id);
  if (userId && userId === shift.cashier_id && actor.role !== 'ADMIN') throw new HttpError(403, 'A Manager cannot review their own shift.');
  if (toCents(shift.cash_variance) !== 0 && (!notes || notes.length < 3)) throw new HttpError(400, 'Review notes are required for a shift with a cash variance.');
  const deviceId = await ensureDevice(client, actor.device_id, userId);
  await client.query(
    `UPDATE cashier_shifts SET status = 'REVIEWED', reviewed_by = $2, reviewed_by_name = $3, reviewed_at = CURRENT_TIMESTAMP, review_notes = $4,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [shiftId, userId, actorName(actor), notes]
  );
  await recordAuditLog({
    user_id: userId, user_name: actor.user_name, role: actor.role, device_id: deviceId,
    action: 'SHIFT_REVIEWED', entity: 'cashier_shift', entity_id: shiftId,
    previous_value: { status: shift.status }, new_value: { status: 'REVIEWED', shift_number: shift.shift_number, cash_variance: Number(shift.cash_variance), review_notes: notes, ...(actor.command_id ? { command_id: actor.command_id } : {}) },
  }, client);
  await enqueueShift(client, 'SHIFT_REVIEWED', shiftId, actor, deviceId);
  return { shift_id: shiftId, shift_number: shift.shift_number, status: 'REVIEWED' as const };
}

export async function reviewShift(shiftIdRaw: string, notes: unknown, actor: SaleActor) {
  const shiftId = requireUuid(shiftIdRaw, 'shift id');
  return withTransaction((client) => reviewShiftTx(client, shiftId, notes, actor));
}

/**
 * Administrator correction of a closed shift's COUNTED cash (e.g. a recount found a miscount). The shift
 * keeps its original closing figures; the correction is its own audited row and becomes the effective count.
 */
export async function correctShift(shiftIdRaw: string, input: { corrected_actual_cash?: unknown; reason?: unknown }, actor: SaleActor) {
  const shiftId = requireUuid(shiftIdRaw, 'shift id');
  if (actor.role !== 'ADMIN') throw new HttpError(403, 'Only an Administrator can correct a closed shift.');
  const userId = cleanUuid(actor.user_id);
  const corrected = parseCash(input?.corrected_actual_cash, 'Corrected actual cash');
  const reason = str(input?.reason, 1000);
  if (reason.length < 3) throw new HttpError(400, 'A correction reason is required.');
  return withTransaction(async (client) => {
    const shift = (await client.query('SELECT * FROM cashier_shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.status === 'OPEN') throw new HttpError(409, 'An open shift is closed, not corrected.');
    const last = (await client.query('SELECT corrected_actual_cash FROM cashier_shift_corrections WHERE shift_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [shiftId])).rows[0];
    const previous = Number(last ? last.corrected_actual_cash : shift.actual_cash);
    if (toCents(previous) === toCents(corrected)) throw new HttpError(409, 'The corrected amount equals the current counted cash.');
    const variance = fromCents(toCents(corrected) - toCents(shift.expected_cash));
    const id = crypto.randomUUID();
    const deviceId = await ensureDevice(client, actor.device_id, userId);
    await client.query(
      `INSERT INTO cashier_shift_corrections (id, shift_id, previous_actual_cash, corrected_actual_cash, expected_cash, corrected_variance, reason, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, shiftId, previous, corrected, Number(shift.expected_cash), variance, reason, userId, actorName(actor)]
    );
    await client.query('UPDATE cashier_shifts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [shiftId]);
    await recordAuditLog({
      user_id: userId, user_name: actor.user_name, role: actor.role, device_id: deviceId,
      action: 'SHIFT_CORRECTED', entity: 'cashier_shift', entity_id: shiftId,
      previous_value: { actual_cash: previous }, new_value: { corrected_actual_cash: corrected, corrected_variance: variance, reason, correction_id: id },
    }, client);
    await enqueueShift(client, 'SHIFT_CORRECTED', shiftId, actor, deviceId, { correction: await rowJson(client, 'cashier_shift_corrections', id) });
    return { success: true, correction: { id, shift_id: shiftId, previous_actual_cash: previous, corrected_actual_cash: corrected, corrected_variance: variance, reason } };
  });
}

/**
 * Hooks used by checkout / refunds / expenses (caller's transaction). Each takes a FOR SHARE lock on the
 * OPEN shift row, so a concurrent close (FOR UPDATE) waits for them and then counts them.
 */
export async function requireOpenShiftForSale(client: pg.PoolClient, cashierId: string): Promise<string> {
  const row = (await client.query(`SELECT id FROM cashier_shifts WHERE cashier_id = $1 AND status = 'OPEN' FOR SHARE`, [cashierId])).rows[0];
  if (!row) {
    throw Object.assign(new HttpError(409, 'Open your shift (enter the opening cash float) before completing a sale.'), { code: 'SHIFT_REQUIRED' });
  }
  return row.id;
}

/** Till that pays a refund: the requesting cashier's open shift, else the approver's own open shift, else none. */
export async function refundTill(client: pg.PoolClient, requesterId: string | null, approverId: string | null): Promise<string | null> {
  const ids = [cleanUuid(requesterId), cleanUuid(approverId)].filter((x): x is string => Boolean(x));
  for (const id of ids) {
    const row = (await client.query(`SELECT id FROM cashier_shifts WHERE cashier_id = $1 AND status = 'OPEN' FOR SHARE`, [id])).rows[0];
    if (row) return row.id;
  }
  return null;
}

/** A till expense must name an OPEN shift. */
export async function lockOpenShiftForExpense(client: pg.PoolClient, shiftId: string): Promise<void> {
  const row = (await client.query(`SELECT status FROM cashier_shifts WHERE id = $1 FOR SHARE`, [shiftId])).rows[0];
  if (!row) throw new HttpError(404, 'That shift does not exist.');
  if (row.status !== 'OPEN') throw new HttpError(409, 'That shift is already closed; its cash was counted. Record the expense without a till.');
}

/** A sale of a CLOSED shift cannot be voided any more (its cash was counted): it is returned instead. */
export async function assertSaleShiftOpen(client: pg.PoolClient, shiftId: string | null): Promise<void> {
  if (!shiftId) return;
  const row = (await client.query(`SELECT status, shift_number FROM cashier_shifts WHERE id = $1 FOR SHARE`, [shiftId])).rows[0];
  if (row && row.status !== 'OPEN') {
    throw Object.assign(new HttpError(409, `This sale belongs to shift ${row.shift_number}, which is already closed and counted. Record a return (refund) instead of a void.`),
      { code: 'SHIFT_CLOSED' });
  }
}

/** Open shifts of this shop (Administrator: choose the till an expense is paid from). */
export async function listOpenTills(q: Queryable) {
  return (await q.query(
    `SELECT x.id, x.shift_number, x.cashier_id, u.name AS cashier_name, x.opened_at, x.device_id
       FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id WHERE x.status = 'OPEN' ORDER BY x.opened_at`
  )).rows;
}

// ============================================================================ reads (local + cloud)
export interface ShiftViewer {
  /** Only this cashier's shifts (Cashier: their own). null = every shift in the scope (shift.view_all). */
  ownCashierId: string | null;
}

function shiftRow(r: any, live: (ShiftTotals & { expected_cash: number }) | null) {
  const figure = (k: string) => (live ? (live as any)[k] : num(r[k]));
  const expected = live ? live.expected_cash : num(r.expected_cash);
  const variance = num(r.cash_variance);
  return {
    id: r.id, shop_id: r.shop_id ?? null, shop_code: r.shop_code ?? null, shop_name: r.shop_name ?? null,
    shift_number: r.shift_number, cashier_id: r.cashier_id, cashier_name: r.cashier_name ?? null, device_id: r.device_id ?? null,
    status: r.status as ShiftStatus,
    opened_at: r.opened_at, opened_business_date: r.opened_business_date, opening_float: num(r.opening_float), opened_by_name: r.opened_by_name ?? null,
    closed_at: r.closed_at ?? null, closed_business_date: r.closed_business_date ?? null, closed_by_name: r.closed_by_name ?? null,
    close_method: r.close_method ?? null, admin_close_reason: r.admin_close_reason ?? null,
    total_transactions: figure('total_transactions'), total_sales: figure('total_sales'),
    cash_sales: figure('cash_sales'), mpesa_sales: figure('mpesa_sales'), card_sales: figure('card_sales'), bank_sales: figure('bank_sales'),
    other_sales: figure('other_sales'), units_sold: figure('units_sold'), voided_count: figure('voided_count'), voided_total: figure('voided_total'),
    returns_count: figure('returns_count'), refund_total: figure('refund_total'), cash_refunds: figure('cash_refunds'), cash_expenses: figure('cash_expenses'),
    expected_cash: expected, actual_cash: num(r.actual_cash), cash_variance: variance, variance_status: varianceLabel(r.status === 'OPEN' ? null : variance),
    effective_actual_cash: r.effective_actual_cash !== undefined && r.effective_actual_cash !== null ? num(r.effective_actual_cash) : num(r.actual_cash),
    effective_variance: r.effective_variance !== undefined && r.effective_variance !== null ? num(r.effective_variance) : variance,
    corrected: Boolean(r.correction_count),
    closing_notes: r.closing_notes ?? null,
    reviewed_by_name: r.reviewed_by_name ?? null, reviewed_at: r.reviewed_at ?? null, review_notes: r.review_notes ?? null,
    live: Boolean(live),
  };
}

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

function shiftWhere(scope: HistoryScope, query: Record<string, unknown>, viewer: ShiftViewer) {
  const w = new Where(scope.shopIds);
  const shop = str(query.shop_id, 64).toLowerCase();
  if (shop && shop !== 'all') {
    if (!isValidUuid(shop) || !scope.shopIds.includes(shop)) throw new HttpError(403, 'Forbidden: that shop is not in your scope.');
    w.add((p) => `x.shop_id = ${p}::uuid`, shop);
  }
  const from = str(query.from, 10), to = str(query.to, 10);
  if (from && !DATE_RE.test(from)) throw new HttpError(400, 'from must be YYYY-MM-DD.');
  if (to && !DATE_RE.test(to)) throw new HttpError(400, 'to must be YYYY-MM-DD.');
  if (from) w.add((p) => `x.opened_business_date >= ${p}::date`, from);
  if (to) w.add((p) => `x.opened_business_date <= ${p}::date`, to);
  if (viewer.ownCashierId) w.add((p) => `x.cashier_id = ${p}::uuid`, viewer.ownCashierId);
  const cashier = str(query.cashier, 64);
  if (cashier) {
    if (!isValidUuid(cashier)) throw new HttpError(400, 'cashier must be a staff id.');
    w.add((p) => `x.cashier_id = ${p}::uuid`, cashier);
  }
  const status = str(query.status, 20).toUpperCase();
  if (status) {
    if (!['OPEN', 'CLOSED', 'REVIEWED'].includes(status)) throw new HttpError(400, 'status must be OPEN, CLOSED or REVIEWED.');
    w.add((p) => `x.status = ${p}`, status);
  }
  const variance = str(query.variance, 20).toUpperCase();
  if (variance) {
    if (variance === 'SHORT') w.raw(`x.status <> 'OPEN' AND x.cash_variance < 0`);
    else if (variance === 'OVER') w.raw(`x.status <> 'OPEN' AND x.cash_variance > 0`);
    else if (variance === 'BALANCED') w.raw(`x.status <> 'OPEN' AND x.cash_variance = 0`);
    else if (variance === 'NONZERO') w.raw(`x.status <> 'OPEN' AND x.cash_variance <> 0`);
    else if (variance === 'UNREVIEWED') w.raw(`x.status = 'CLOSED' AND x.cash_variance <> 0`);
    else throw new HttpError(400, 'variance must be SHORT, OVER, BALANCED, NONZERO or UNREVIEWED.');
  }
  const q = str(query.q, 60);
  if (q) w.add((p) => `(x.shift_number ILIKE ${p} OR x.cashier_name ILIKE ${p})`, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return w;
}

const LIST_COLUMNS = (R: Rel) => `x.*, sh.shop_code, sh.shop_name,
  (SELECT COUNT(*) FROM ${R.corrections} c WHERE c.shop_id = x.shop_id AND c.shift_id = x.id)::int AS correction_count,
  (SELECT c.corrected_actual_cash FROM ${R.corrections} c WHERE c.shop_id = x.shop_id AND c.shift_id = x.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS effective_actual_cash,
  (SELECT c.corrected_variance FROM ${R.corrections} c WHERE c.shop_id = x.shop_id AND c.shift_id = x.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS effective_variance`;

/** Shift history: filters + page + summary + per-day / per-cashier reconciliation. Read only. */
export async function listShifts(scope: HistoryScope, query: Record<string, unknown>, viewer: ShiftViewer, opts: { exportPageSize?: number } = {}) {
  const R = rel(scope);
  const w = shiftWhere(scope, query, viewer);
  const size = opts.exportPageSize || ([25, 50, 100].includes(Number(query.page_size)) ? Number(query.page_size) : 25);
  const page = Math.max(1, Math.min(100_000, Math.floor(Number(query.page) || 1)));
  const n = w.params.length;
  const rows = (await scope.q.query(
    `SELECT ${LIST_COLUMNS(R)} FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id ${w.sql}
      ORDER BY x.opened_at DESC, x.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...w.params, size, (page - 1) * size]
  )).rows;
  // OPEN shifts show live figures (computed from the tagged transactions); closed ones their stored figures.
  const openIds = rows.filter((r: any) => r.status === 'OPEN').map((r: any) => String(r.id));
  const live = await computeShiftTotals(scope, openIds);
  const list = rows.map((r: any) => {
    const t = live.get(String(r.id));
    return shiftRow(r, t ? { ...t, expected_cash: expectedCash(Number(r.opening_float), t) } : null);
  });
  const agg = (await scope.q.query(
    `SELECT COUNT(*)::int AS shifts,
            COUNT(*) FILTER (WHERE x.status = 'OPEN')::int AS open,
            COUNT(*) FILTER (WHERE x.status <> 'OPEN')::int AS closed,
            COUNT(*) FILTER (WHERE x.status = 'CLOSED' AND x.cash_variance <> 0)::int AS unreviewed_variances,
            COUNT(*) FILTER (WHERE x.status <> 'OPEN' AND x.cash_variance < 0)::int AS short_count,
            COUNT(*) FILTER (WHERE x.status <> 'OPEN' AND x.cash_variance > 0)::int AS over_count,
            COALESCE(SUM(x.total_sales) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS total_sales,
            COALESCE(SUM(x.cash_sales) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS cash_sales,
            COALESCE(SUM(x.mpesa_sales) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS mpesa_sales,
            COALESCE(SUM(x.card_sales) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS card_sales,
            COALESCE(SUM(x.bank_sales) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS bank_sales,
            COALESCE(SUM(x.refund_total) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS refund_total,
            COALESCE(SUM(x.cash_expenses) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS cash_expenses,
            COALESCE(SUM(x.expected_cash) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS expected_cash,
            COALESCE(SUM(x.actual_cash) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS actual_cash,
            COALESCE(SUM(x.cash_variance) FILTER (WHERE x.status <> 'OPEN'), 0)::float AS cash_variance,
            COALESCE(SUM(x.cash_variance) FILTER (WHERE x.status <> 'OPEN' AND x.cash_variance < 0), 0)::float AS shortages,
            COALESCE(SUM(x.cash_variance) FILTER (WHERE x.status <> 'OPEN' AND x.cash_variance > 0), 0)::float AS overages
       FROM ${R.shifts} x ${w.sql}`, w.params)).rows[0];
  // Cashier reconciliation + daily summary (closed shifts; each row stays in its own shop).
  const byCashier = (await scope.q.query(
    `SELECT x.shop_id, sh.shop_code, x.cashier_id, MAX(x.cashier_name) AS cashier_name, COUNT(*)::int AS shifts,
            COALESCE(SUM(x.total_sales), 0)::float AS total_sales, COALESCE(SUM(x.expected_cash), 0)::float AS expected_cash,
            COALESCE(SUM(x.actual_cash), 0)::float AS actual_cash, COALESCE(SUM(x.cash_variance), 0)::float AS cash_variance,
            COUNT(*) FILTER (WHERE x.cash_variance < 0)::int AS short_count, COUNT(*) FILTER (WHERE x.cash_variance > 0)::int AS over_count
       FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id ${w.sql}${w.sql ? ' AND' : ' WHERE'} x.status <> 'OPEN'
      GROUP BY x.shop_id, sh.shop_code, x.cashier_id ORDER BY sh.shop_code, cashier_name LIMIT 500`, w.params)).rows;
  const byDay = (await scope.q.query(
    `SELECT x.shop_id, sh.shop_code, x.opened_business_date AS date, COUNT(*)::int AS shifts,
            COALESCE(SUM(x.total_sales), 0)::float AS total_sales, COALESCE(SUM(x.cash_sales), 0)::float AS cash_sales,
            COALESCE(SUM(x.expected_cash), 0)::float AS expected_cash, COALESCE(SUM(x.actual_cash), 0)::float AS actual_cash,
            COALESCE(SUM(x.cash_variance), 0)::float AS cash_variance
       FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id ${w.sql}${w.sql ? ' AND' : ' WHERE'} x.status <> 'OPEN'
      GROUP BY x.shop_id, sh.shop_code, x.opened_business_date ORDER BY x.opened_business_date DESC, sh.shop_code LIMIT 400`, w.params)).rows;
  const round = (v: number) => Math.round(Number(v || 0) * 100) / 100;
  const total = Number(agg.shifts) || 0;
  return {
    page, page_size: size, total, pages: Math.max(1, Math.ceil(total / size)),
    summary: {
      shifts: total, open: agg.open, closed: agg.closed, unreviewed_variances: agg.unreviewed_variances, short_count: agg.short_count, over_count: agg.over_count,
      total_sales: round(agg.total_sales), cash_sales: round(agg.cash_sales), mpesa_sales: round(agg.mpesa_sales), card_sales: round(agg.card_sales),
      bank_sales: round(agg.bank_sales), refund_total: round(agg.refund_total), cash_expenses: round(agg.cash_expenses),
      expected_cash: round(agg.expected_cash), actual_cash: round(agg.actual_cash), cash_variance: round(agg.cash_variance),
      shortages: round(agg.shortages), overages: round(agg.overages),
    },
    by_cashier: byCashier.map((x: any) => ({ ...x, total_sales: round(x.total_sales), expected_cash: round(x.expected_cash), actual_cash: round(x.actual_cash), cash_variance: round(x.cash_variance) })),
    by_day: byDay.map((x: any) => ({ ...x, total_sales: round(x.total_sales), cash_sales: round(x.cash_sales), expected_cash: round(x.expected_cash), actual_cash: round(x.actual_cash), cash_variance: round(x.cash_variance) })),
    rows: list,
  };
}

/** One shift exactly: stored closing figures, a live recount of its transactions, corrections, till items. */
export async function shiftDetail(scope: HistoryScope, shiftId: string, viewer: ShiftViewer, expectShopId?: string | null) {
  if (!isValidUuid(shiftId)) throw new HttpError(400, 'Shift id must be a UUID.');
  if (expectShopId && (!isValidUuid(expectShopId) || !scope.shopIds.includes(expectShopId.toLowerCase()))) {
    throw new HttpError(403, 'Forbidden: that shop is not in your scope.');
  }
  const R = rel(scope);
  const head = (await scope.q.query(
    `SELECT ${LIST_COLUMNS(R)} FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id
      WHERE x.id = $2::uuid AND ($3::uuid IS NULL OR x.shop_id = $3::uuid)`, [scope.shopIds, shiftId, expectShopId || null])).rows[0];
  // A cashier asking for someone else's shift gets the same answer as for a missing one.
  if (!head || (viewer.ownCashierId && head.cashier_id !== viewer.ownCashierId)) throw new HttpError(404, 'Shift not found in your scope.');
  const t = (await computeShiftTotals(scope, [shiftId])).get(shiftId) || EMPTY_TOTALS;
  const liveExpected = expectedCash(Number(head.opening_float), t);
  const isOpen = head.status === 'OPEN';
  const p = [scope.shopIds, shiftId, head.shop_id];
  const corrections = (await scope.q.query(
    `SELECT * FROM ${R.corrections} c WHERE c.shift_id = $2::uuid AND c.shop_id = $3::uuid ORDER BY c.created_at, c.id`, p)).rows;
  const refunds = (await scope.q.query(
    `SELECT r.id, r.sale_id, r.receipt_number, r.refund_amount, COALESCE(r.refund_method, 'Cash') AS refund_method, r.approved_quantity, r.reviewed_at, m.name AS medicine_name
       FROM ${R.returns} r LEFT JOIN ${R.medicines} m ON m.shop_id = r.shop_id AND m.id = r.medicine_id
      WHERE r.refund_shift_id = $2::uuid AND r.shop_id = $3::uuid AND r.status = 'APPROVED' ORDER BY r.reviewed_at LIMIT 200`, p)).rows;
  const expenses = (await scope.q.query(
    `SELECT e.id, e.category, e.description, e.amount, e.payment_method, e.status, e.created_at FROM ${R.expenses} e
      WHERE e.shift_id = $2::uuid AND e.shop_id = $3::uuid ORDER BY e.created_at LIMIT 200`, p)).rows;
  const voided = (await scope.q.query(
    `SELECT s.id, s.receipt_number, s.total, s.date, s.time FROM ${R.sales} s
      WHERE s.shift_id = $2::uuid AND s.shop_id = $3::uuid AND lower(s.status) = 'voided' ORDER BY s.date, s.time LIMIT 200`, p)).rows;
  const stored = shiftRow(head, isOpen ? { ...t, expected_cash: liveExpected } : null);
  // For a closed shift: has anything tagged with it changed since it was counted? (shown, never applied)
  const changedSinceClose = !isOpen && (
    toCents(t.total_sales) !== toCents(head.total_sales) || toCents(t.cash_sales) !== toCents(head.cash_sales) ||
    toCents(t.cash_refunds) !== toCents(head.cash_refunds) || toCents(t.cash_expenses) !== toCents(head.cash_expenses));
  return {
    shift: stored,
    recount: { ...t, expected_cash: liveExpected, changed_since_close: changedSinceClose },
    corrections: corrections.map((c: any) => ({
      id: c.id, previous_actual_cash: num(c.previous_actual_cash), corrected_actual_cash: num(c.corrected_actual_cash), expected_cash: num(c.expected_cash),
      corrected_variance: num(c.corrected_variance), variance_status: varianceLabel(num(c.corrected_variance)), reason: c.reason, by: c.created_by_name, at: c.created_at,
    })),
    refunds: refunds.map((r: any) => ({ ...r, refund_amount: num(r.refund_amount), approved_quantity: Number(r.approved_quantity) || 0 })),
    expenses: expenses.map((e: any) => ({ ...e, amount: num(e.amount) })),
    voided_sales: voided.map((v: any) => ({ ...v, total: num(v.total) })),
    formula: 'Expected cash = opening float + cash sales - cash refunds - cash till expenses',
  };
}

/** Dashboard cards per shop: open shifts, left open from a previous day, closed today, variance today, unreviewed. */
export async function shiftOverview(scope: HistoryScope) {
  const R = rel(scope);
  const today = (await scope.q.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS d`)).rows[0].d;
  const per = (await scope.q.query(
    `SELECT sh.shop_id, sh.shop_code, sh.shop_name,
            COUNT(x.id) FILTER (WHERE x.status = 'OPEN')::int AS open_shifts,
            COUNT(x.id) FILTER (WHERE x.status = 'OPEN' AND x.opened_business_date < $2::date)::int AS open_from_previous_day,
            COUNT(x.id) FILTER (WHERE x.status <> 'OPEN' AND x.closed_business_date = $2::date)::int AS closed_today,
            COALESCE(SUM(x.cash_variance) FILTER (WHERE x.status <> 'OPEN' AND x.closed_business_date = $2::date), 0)::float AS variance_today,
            COUNT(x.id) FILTER (WHERE x.status = 'CLOSED' AND x.cash_variance <> 0)::int AS unreviewed_variances
       FROM ${R.shops} sh LEFT JOIN ${R.shifts} x ON x.shop_id = sh.shop_id
      GROUP BY sh.shop_id, sh.shop_code, sh.shop_name ORDER BY sh.shop_code`, [scope.shopIds, today])).rows;
  const flagged = (await scope.q.query(
    `SELECT x.id, x.shop_id, sh.shop_code, x.shift_number, x.cashier_name, x.status, x.opened_at, x.opened_business_date, x.closed_at, x.cash_variance
       FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id
      WHERE (x.status = 'OPEN' AND x.opened_business_date < $2::date) OR (x.status = 'CLOSED' AND x.cash_variance <> 0)
      ORDER BY x.opened_at DESC LIMIT 50`, [scope.shopIds, today])).rows;
  const open = (await scope.q.query(
    `SELECT x.id, x.shop_id, sh.shop_code, x.shift_number, x.cashier_name, x.opened_at, x.opened_business_date, x.opening_float
       FROM ${R.shifts} x LEFT JOIN ${R.shops} sh ON sh.shop_id = x.shop_id WHERE x.status = 'OPEN' ORDER BY x.opened_at LIMIT 50`, [scope.shopIds])).rows;
  return {
    business_date: today,
    shops: per.map((s: any) => ({ ...s, variance_today: num(s.variance_today) })),
    open_shifts: open.map((s: any) => ({ ...s, opening_float: num(s.opening_float), left_open: String(s.opened_business_date).slice(0, 10) < today })),
    flagged: flagged.map((f: any) => ({
      ...f, cash_variance: num(f.cash_variance),
      flag: f.status === 'OPEN' ? 'SHIFT_LEFT_OPEN' : Number(f.cash_variance) < 0 ? 'SHIFT_SHORTAGE' : 'SHIFT_OVERAGE',
    })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** CSV of the filtered shift list (Cash Variance / Cashier Reconciliation report). */
export async function shiftsCsv(scope: HistoryScope, query: Record<string, unknown>, viewer: ShiftViewer): Promise<string> {
  const out = await listShifts(scope, { ...query, page: 1 }, viewer, { exportPageSize: 10_000 });
  const head = ['Shop', 'Shift', 'Cashier', 'Status', 'Opened', 'Closed', 'Opening float', 'Transactions', 'Total sales', 'Cash', 'M-Pesa', 'Card', 'Bank',
    'Refunds', 'Cash refunds', 'Cash expenses', 'Expected cash', 'Actual cash', 'Variance', 'Variance status', 'Closing notes', 'Reviewed by'];
  const lines = [head.join(',')];
  for (const r of out.rows) {
    lines.push([r.shop_code, r.shift_number, r.cashier_name, r.status, r.opened_at ? new Date(r.opened_at).toISOString() : '', r.closed_at ? new Date(r.closed_at).toISOString() : '',
      r.opening_float, r.total_transactions, r.total_sales, r.cash_sales, r.mpesa_sales, r.card_sales, r.bank_sales, r.refund_total, r.cash_refunds,
      r.cash_expenses, r.expected_cash, r.actual_cash, r.cash_variance, r.variance_status, r.closing_notes, r.reviewed_by_name].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
