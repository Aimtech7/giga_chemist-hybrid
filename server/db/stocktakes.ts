import crypto from 'crypto';
import type pg from 'pg';
import { HttpError, pgPool, requireUuid, withTransaction, type Queryable } from './client';
import { recordAuditLog } from './audit';
import { ensureDevice } from './devices';
import { deriveBatchStatus, insertAudit, insertMovement, lockBatch, lockMedicine, reconcileMedicineStock, type StockActor } from './inventory';
import { enqueueSyncEvent } from '../sync/outbox';

/**
 * FORMAL STOCKTAKE SESSIONS (local migration 022). The shop's PostgreSQL is authoritative.
 *
 *   create  (stocktake.create: Administrator / Manager)  DRAFT with one line per batch in scope
 *   start   -> COUNTING
 *   count   (stocktake.count) records physical quantity + the system quantity AT THAT MOMENT;
 *           a cashier may count only in a session that allows cashier counting, and counts BLIND
 *           (no system quantity, no cost)
 *   submit  -> REVIEW;  reopen -> COUNTING
 *   approve (stocktake.approve: Administrator) -> COMPLETED: for every counted line with a variance,
 *           new = batch now + (physical - system at count) through the normal stock path (movement,
 *           medicine reconciliation, audit, PHYSICAL_COUNT sync event). Refused if any batch would go
 *           negative. Before approval NOTHING changes stock.
 *   cancel  any state except COMPLETED.
 */
export type StocktakeRole = 'ADMIN' | 'MANAGER' | 'CASHIER' | string;
export interface StocktakeActor extends StockActor { role: StocktakeRole }

const SCOPES = ['ALL', 'CATEGORY', 'MEDICINES'] as const;
const OPEN = ['DRAFT', 'COUNTING', 'REVIEW'];

const text = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

async function businessDate(q: Queryable): Promise<string> {
  return (await q.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS d`)).rows[0].d;
}

async function lockSession(client: pg.PoolClient, id: string) {
  const r = await client.query('SELECT * FROM stocktakes WHERE id = $1 FOR UPDATE', [requireUuid(id, 'stocktake id')]);
  if (!r.rows[0]) throw new HttpError(404, 'Stocktake not found.');
  return r.rows[0];
}

function requireStatus(s: any, allowed: string[], action: string) {
  if (!allowed.includes(s.status)) throw new HttpError(409, `Cannot ${action} a stocktake that is ${s.status}.`, { code: 'INVALID_STATE' } as any);
}

async function audit(client: pg.PoolClient, actor: StocktakeActor, action: string, s: any, value: Record<string, unknown>) {
  await recordAuditLog({
    user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: actor.device_id,
    action, entity: 'stocktake', entity_id: s.id, new_value: { stocktake_number: s.stocktake_number, ...value },
  } as any, client);
}

// ------------------------------------------------------------------ create / state changes
export async function createStocktake(actor: StocktakeActor, body: Record<string, any>) {
  const scopeType = String(body?.scope_type || 'ALL').toUpperCase();
  if (!(SCOPES as readonly string[]).includes(scopeType)) throw new HttpError(400, `scope_type must be one of: ${SCOPES.join(', ')}.`);
  let scopeValue: any = null;
  if (scopeType === 'CATEGORY') {
    const c = text(body?.category, 100);
    if (!c) throw new HttpError(400, 'category is required for a CATEGORY stocktake.');
    scopeValue = { category: c };
  }
  if (scopeType === 'MEDICINES') {
    const ids = Array.isArray(body?.medicine_ids) ? [...new Set(body.medicine_ids.map((x: unknown) => requireUuid(x, 'medicine_ids')))] : [];
    if (!ids.length || ids.length > 5000) throw new HttpError(400, 'medicine_ids must list 1-5000 medicines.');
    scopeValue = { medicine_ids: ids };
  }
  return withTransaction(async (client) => {
    const date = await businessDate(client);
    const n = (await client.query(`SELECT nextval('stocktake_seq') AS n`)).rows[0].n;
    const id = crypto.randomUUID();
    const number = `ST-${date.replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO stocktakes (id, stocktake_number, status, scope_type, scope_value, allow_cashier_count, notes, started_by, started_by_name, business_date)
       VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, $8, $9)`,
      [id, number, scopeType, scopeValue ? JSON.stringify(scopeValue) : null, body?.allow_cashier_count === true, text(body?.notes), actor.user_id, actor.user_name, date]);
    const filter = scopeType === 'CATEGORY' ? `AND m.category_id IN (SELECT c.id FROM categories c WHERE LOWER(c.name) = LOWER($2))`
      : scopeType === 'MEDICINES' ? `AND m.id = ANY($2::uuid[])` : '';
    const params: unknown[] = [id];
    if (scopeType === 'CATEGORY') params.push(scopeValue.category);
    if (scopeType === 'MEDICINES') params.push(scopeValue.medicine_ids);
    const ins = await client.query(
      `INSERT INTO stocktake_lines (id, stocktake_id, medicine_id, batch_id, batch_number, expiry_date, unit_cost)
       SELECT gen_random_uuid(), $1, b.medicine_id, b.id, b.batch_number, b.expiry_date,
              COALESCE(NULLIF(b.purchase_price, 0), m.purchase_price, 0)
         FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
        WHERE m.status = 'active' AND (b.quantity_available > 0 OR b.status = 'active') ${filter}`, params);
    if (!ins.rowCount) throw new HttpError(400, 'No stock batch matches this scope: nothing to count.');
    const s = (await client.query('SELECT * FROM stocktakes WHERE id = $1', [id])).rows[0];
    await audit(client, actor, 'STOCKTAKE_CREATED', s, { scope_type: scopeType, scope_value: scopeValue, lines: ins.rowCount, allow_cashier_count: s.allow_cashier_count });
    return { id, stocktake_number: number, status: 'DRAFT', lines: ins.rowCount };
  });
}

async function transition(id: string, actor: StocktakeActor, from: string[], to: string, action: string, extra: (client: pg.PoolClient, s: any) => Promise<Record<string, unknown> | void> = async () => {}) {
  return withTransaction(async (client) => {
    const s = await lockSession(client, id);
    requireStatus(s, from, action);
    const more = (await extra(client, s)) || {};
    await client.query(`UPDATE stocktakes SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [s.id, to]);
    await audit(client, actor, `STOCKTAKE_${action.toUpperCase().replace(/ /g, '_')}`, s, { from: s.status, to, ...more });
    return { id: s.id, stocktake_number: s.stocktake_number, status: to, ...more };
  });
}

export const startCounting = (id: string, actor: StocktakeActor) => transition(id, actor, ['DRAFT'], 'COUNTING', 'start', async (client, s) => {
  await client.query('UPDATE stocktakes SET counting_started_at = CURRENT_TIMESTAMP WHERE id = $1', [s.id]);
});
export const submitStocktake = (id: string, actor: StocktakeActor) => transition(id, actor, ['COUNTING'], 'REVIEW', 'submit', async (client, s) => {
  const counted = Number((await client.query('SELECT COUNT(*) FILTER (WHERE physical_quantity IS NOT NULL) AS n FROM stocktake_lines WHERE stocktake_id = $1', [s.id])).rows[0].n);
  if (!counted) throw new HttpError(409, 'Nothing has been counted yet.');
  await client.query('UPDATE stocktakes SET submitted_at = CURRENT_TIMESTAMP, submitted_by_name = $2 WHERE id = $1', [s.id, actor.user_name]);
  return { counted };
});
export const reopenStocktake = (id: string, actor: StocktakeActor) => transition(id, actor, ['REVIEW'], 'COUNTING', 'reopen');
export const cancelStocktake = (id: string, actor: StocktakeActor, reasonRaw: unknown) => {
  const reason = text(reasonRaw, 500);
  if (!reason) throw new HttpError(400, 'A reason is required to cancel a stocktake.');
  return transition(id, actor, OPEN, 'CANCELLED', 'cancel', async (client, s) => {
    await client.query('UPDATE stocktakes SET cancelled_at = CURRENT_TIMESTAMP, cancelled_by_name = $2, cancel_reason = $3 WHERE id = $1', [s.id, actor.user_name, reason]);
    return { reason };
  });
};

// ------------------------------------------------------------------ counting
export async function countLine(id: string, lineId: string, actor: StocktakeActor, body: Record<string, any>) {
  const qty = body?.physical_quantity;
  if (qty !== null && (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000)) throw new HttpError(400, 'physical_quantity must be a whole number from 0 (or null to clear).');
  return withTransaction(async (client) => {
    const s = await lockSession(client, id);
    requireStatus(s, ['COUNTING'], 'count');
    if (actor.role === 'CASHIER' && !s.allow_cashier_count) throw new HttpError(403, 'This stocktake is not open to cashier counting.');
    const line = (await client.query('SELECT * FROM stocktake_lines WHERE id = $1 AND stocktake_id = $2 FOR UPDATE', [requireUuid(lineId, 'line id'), s.id])).rows[0];
    if (!line) throw new HttpError(404, 'Stocktake line not found.');
    const system = qty === null ? null : Number((await client.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [line.batch_id])).rows[0]?.quantity_available ?? 0);
    await client.query(
      `UPDATE stocktake_lines SET physical_quantity = $2, system_quantity = $3, reason = COALESCE($4, reason),
              counted_by = $5, counted_by_name = $6, counted_at = CASE WHEN $2::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id = $1`,
      [line.id, qty, system, text(body?.reason, 500), qty === null ? null : actor.user_id, qty === null ? null : actor.user_name]);
    const out: Record<string, unknown> = { line_id: line.id, physical_quantity: qty };
    if (actor.role !== 'CASHIER') Object.assign(out, { system_quantity: system, variance: qty === null ? null : qty - (system ?? 0) });
    return out;
  });
}

// ------------------------------------------------------------------ approval (the only stock change)
export async function approveStocktake(id: string, actor: StocktakeActor, body: Record<string, any>) {
  const approvalNotes = text(body?.notes, 1000);
  return withTransaction(async (client) => {
    const s = await lockSession(client, id);
    requireStatus(s, ['REVIEW'], 'approve');
    const deviceId = await ensureDevice(client, actor.device_id);
    const lines = (await client.query(
      `SELECT l.*, m.name AS medicine_name FROM stocktake_lines l JOIN medicines m ON m.id = l.medicine_id
        WHERE l.stocktake_id = $1 AND l.physical_quantity IS NOT NULL AND l.physical_quantity <> l.system_quantity
        ORDER BY l.medicine_id, l.batch_id`, [s.id])).rows;
    const byMedicine = new Map<string, any[]>();
    for (const l of lines) byMedicine.set(l.medicine_id, [...(byMedicine.get(l.medicine_id) || []), l]);
    const problems: string[] = [];
    let applied = 0;
    for (const [medicineId, mls] of byMedicine) {
      const medicine = await lockMedicine(client, medicineId);
      const before = Number(medicine.current_stock) || 0;
      const moves: any[] = [];
      for (const l of mls) {
        const batch = await lockBatch(client, l.batch_id, medicineId);
        const now = Number(batch.quantity_available) || 0;
        const variance = Number(l.physical_quantity) - Number(l.system_quantity);
        const next = now + variance;
        if (next < 0) {
          problems.push(`${l.medicine_name} batch ${l.batch_number}: ${now} now, variance ${variance}`);
          continue;
        }
        await client.query(`UPDATE medicine_batches SET quantity_available = $2, status = $3, stock_version = stock_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [batch.id, next, deriveBatchStatus(next, batch.expiry_date, batch.status)]);
        const mv = await insertMovement(client, {
          medicine_id: medicineId, batch_id: batch.id, previous_quantity: now, new_quantity: next,
          movement_type: 'PHYSICAL_STOCK_COUNT', reason: 'STOCKTAKE', reference_id: s.stocktake_number,
          notes: `Stocktake ${s.stocktake_number}: counted ${l.physical_quantity}, system ${l.system_quantity} at count${l.reason ? ` (${l.reason})` : ''}`,
        }, actor, deviceId);
        await client.query('UPDATE stocktake_lines SET applied_quantity_before = $2, applied_quantity_after = $3, movement_id = $4 WHERE id = $1', [l.id, now, next, mv.id]);
        moves.push({ batch_number: batch.batch_number, previous_quantity: now, delta: variance, new_quantity: next });
        applied++;
      }
      if (problems.length) continue;
      const updated = await reconcileMedicineStock(client, medicineId);
      await insertAudit(client, {
        action: 'STOCKTAKE_ADJUSTMENT', entity: 'medicine', entity_id: medicineId,
        previous_value: { current_stock: before }, new_value: { current_stock: Number(updated.current_stock), stocktake_id: s.id, stocktake_number: s.stocktake_number, batches: moves },
      }, actor, deviceId);
      await enqueueSyncEvent(client, {
        event_type: 'PHYSICAL_COUNT', entity_type: 'medicine', entity_id: medicineId, operation: 'COUNT',
        data: { medicine_id: medicineId, notes: `Stocktake ${s.stocktake_number}`, stocktake_id: s.id, stocktake_number: s.stocktake_number },
        actor, device_id: deviceId,
      });
    }
    if (problems.length) {
      throw new HttpError(409, `Approval refused: these batches would go below zero (stock moved since counting). Recount them: ${problems.slice(0, 10).join('; ')}`);
    }
    await client.query(
      `UPDATE stocktakes SET status = 'COMPLETED', approved_at = CURRENT_TIMESTAMP, approved_by = $2, approved_by_name = $3, approval_notes = $4,
              completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [s.id, actor.user_id, actor.user_name, approvalNotes]);
    const report = await stocktakeReport(client, s.id);
    await audit(client, actor, 'STOCKTAKE_APPROVED', s, { adjusted_batches: applied, report, notes: approvalNotes });
    return { id: s.id, stocktake_number: s.stocktake_number, status: 'COMPLETED', adjusted_batches: applied, report };
  });
}

// ------------------------------------------------------------------ reads
export async function stocktakeReport(q: Queryable, id: string) {
  const r = (await q.query(
    `SELECT COUNT(*)::int AS total_items,
            COUNT(*) FILTER (WHERE physical_quantity IS NOT NULL)::int AS counted,
            COUNT(*) FILTER (WHERE physical_quantity IS NOT NULL AND physical_quantity = system_quantity)::int AS matched,
            COUNT(*) FILTER (WHERE physical_quantity < system_quantity)::int AS short,
            COUNT(*) FILTER (WHERE physical_quantity > system_quantity)::int AS over,
            COUNT(*) FILTER (WHERE physical_quantity IS NULL)::int AS uncounted,
            COALESCE(SUM(physical_quantity - system_quantity) FILTER (WHERE physical_quantity IS NOT NULL), 0)::int AS total_variance_units,
            COALESCE(SUM((physical_quantity - system_quantity) * unit_cost) FILTER (WHERE physical_quantity IS NOT NULL), 0)::float AS variance_cost_value
       FROM stocktake_lines WHERE stocktake_id = $1`, [id])).rows[0];
  return { ...r, variance_cost_value: Math.round(Number(r.variance_cost_value) * 100) / 100 };
}

const SESSION_COLS = `id, stocktake_number, status, scope_type, scope_value, allow_cashier_count, notes, started_by_name, created_at, counting_started_at,
  submitted_at, submitted_by_name, approved_at, approved_by_name, approval_notes, completed_at, cancelled_at, cancelled_by_name, cancel_reason, business_date`;

export async function listStocktakes(role: StocktakeRole, query: Record<string, unknown>) {
  const status = typeof query.status === 'string' ? query.status.toUpperCase() : '';
  const rows = (await pgPool.query(
    `SELECT ${SESSION_COLS},
            (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id)::int AS lines,
            (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.physical_quantity IS NOT NULL)::int AS counted
       FROM stocktakes s
      WHERE ($1 = '' OR s.status = $1) AND ($2::boolean OR (s.allow_cashier_count AND s.status = 'COUNTING'))
      ORDER BY s.created_at DESC LIMIT 200`, [status, role !== 'CASHIER'])).rows;
  return { stocktakes: rows };
}

export async function getStocktake(id: string, role: StocktakeRole, query: Record<string, unknown>) {
  const s = (await pgPool.query(`SELECT ${SESSION_COLS} FROM stocktakes WHERE id = $1`, [requireUuid(id, 'stocktake id')])).rows[0];
  if (!s) throw new HttpError(404, 'Stocktake not found.');
  const cashier = role === 'CASHIER';
  if (cashier && !(s.allow_cashier_count && s.status === 'COUNTING')) throw new HttpError(403, 'This stocktake is not open to cashier counting.');
  const search = typeof query.search === 'string' && query.search.trim() ? `%${query.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const filter = typeof query.filter === 'string' ? query.filter : 'all';
  const cond = filter === 'uncounted' ? 'AND l.physical_quantity IS NULL' : filter === 'variance' ? 'AND l.physical_quantity IS NOT NULL AND l.physical_quantity <> l.system_quantity' : '';
  const lines = (await pgPool.query(
    `SELECT l.id, l.medicine_id, m.name AS medicine_name, m.generic_name, m.barcode, l.batch_id, l.batch_number, l.expiry_date,
            l.physical_quantity, l.reason, l.counted_by_name, l.counted_at
            ${cashier ? '' : `, l.system_quantity, l.unit_cost::float AS unit_cost,
            CASE WHEN l.physical_quantity IS NULL THEN NULL ELSE l.physical_quantity - l.system_quantity END AS variance,
            CASE WHEN l.physical_quantity IS NULL THEN NULL ELSE ((l.physical_quantity - l.system_quantity) * l.unit_cost)::float END AS variance_cost,
            b.quantity_available AS current_quantity, l.applied_quantity_before, l.applied_quantity_after`}
       FROM stocktake_lines l JOIN medicines m ON m.id = l.medicine_id JOIN medicine_batches b ON b.id = l.batch_id
      WHERE l.stocktake_id = $1 ${cond} AND ($2::text IS NULL OR m.name ILIKE $2 OR m.generic_name ILIKE $2 OR m.barcode ILIKE $2 OR l.batch_number ILIKE $2)
      ORDER BY m.name, l.batch_number LIMIT 5000`, [s.id, search])).rows;
  const report = await stocktakeReport(pgPool, s.id);
  if (cashier) {
    const { counted, uncounted, total_items } = report;
    return { stocktake: s, lines, report: { total_items, counted, uncounted } };
  }
  return { stocktake: s, lines, report };
}
