import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow } from './client';
import { ensureDevice } from './devices';
import { recordAuditLog } from './audit';
import {
  deriveBatchStatus,
  insertMovement,
  reconcileMedicineStock,
  toBatchDto,
  toMedicineStockDto,
} from './inventory';
import { getSaleById, type SaleActor } from './sales';
import type { CustomerReturn } from '../../src/types';

/**
 * Return workflow (migration 012):
 *   request  (Cashier or Admin) -> PENDING   : nothing applied (no stock, refund, movement, reporting)
 *   approve  (Admin only)       -> APPROVED  : one transaction applies refund + optional restock +
 *                                              movement + sale status + customer spend + audit
 *   reject   (Admin only)       -> REJECTED  : decision recorded, no effects
 * Refunds are always computed from the ORIGINAL sale lines (discounted / wholesale price actually
 * paid), never from today's medicine price.
 */
export type ReturnStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
const NON_RESTOCK_DISPOSITIONS = ['quarantine', 'damaged', 'dispose'] as const;
type Disposition = (typeof NON_RESTOCK_DISPOSITIONS)[number];

const toCents = (n: number) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const RETURN_SELECT = `
  SELECT r.id, r.branch_id, r.sale_id, r.receipt_number, r.medicine_id, m.name AS medicine_name,
         r.batch_id, b.batch_number, r.quantity::int AS quantity, r.unit_price::float AS unit_price,
         r.refund_amount::float AS refund_amount, r.requested_refund::float AS requested_refund,
         r.approved_quantity, r.restocked, r.reason, r.action, r.status,
         r.user_id, u.name AS user_name, r.device_id, r.created_at,
         r.reviewed_by, rv.name AS reviewed_by_name, r.reviewed_at, r.review_notes,
         s.date AS sale_date, s.time AS sale_time, s.status AS sale_status, s.price_mode AS sale_price_mode,
         COALESCE(s.discount_percent, 0)::float AS sale_discount_percent,
         c.name AS customer_name,
         li.sold_qty, li.sold_total, li.line_discount,
         (SELECT COALESCE(SUM(r2.approved_quantity), 0) FROM returns r2
           WHERE r2.sale_id = r.sale_id AND r2.medicine_id = r.medicine_id AND r2.batch_id = r.batch_id
             AND r2.status = 'APPROVED' AND r2.id <> r.id)::int AS other_approved_qty
  FROM returns r
  JOIN sales s ON s.id = r.sale_id
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN medicines m ON m.id = r.medicine_id
  LEFT JOIN medicine_batches b ON b.id = r.batch_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(si.quantity), 0)::int AS sold_qty, COALESCE(SUM(si.total), 0)::float AS sold_total,
           COALESCE(SUM(si.discount), 0)::float AS line_discount
    FROM sale_items si
    WHERE si.sale_id = r.sale_id AND si.medicine_id = r.medicine_id AND si.batch_id = r.batch_id AND si.quantity > 0
  ) li ON true`;

function toReturn(r: any): CustomerReturn & Record<string, any> {
  const paidPerUnit = r.sold_qty ? Math.round((r.sold_total / r.sold_qty) * 100) / 100 : 0;
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    sale_id: r.sale_id,
    receipt_number: r.receipt_number,
    medicine_id: r.medicine_id,
    medicine_name: r.medicine_name || 'Item',
    batch_id: r.batch_id,
    batch_number: r.batch_number || 'Batch',
    quantity: Number(r.quantity) || 0,
    unit_price: Number(r.unit_price) || 0,
    effective_unit_price: paidPerUnit,
    refund_amount: Number(r.refund_amount) || 0,
    requested_refund: r.requested_refund != null ? Number(r.requested_refund) : undefined,
    approved_quantity: r.approved_quantity ?? undefined,
    restocked: r.restocked ?? undefined,
    reason: r.reason,
    action: r.action,
    status: r.status,
    user_id: r.user_id,
    user_name: r.user_name || 'Staff',
    device_id: r.device_id,
    reviewed_by: r.reviewed_by || undefined,
    reviewed_by_name: r.reviewed_by_name || undefined,
    reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : undefined,
    review_notes: r.review_notes || undefined,
    sale_date: r.sale_date || '',
    sale_time: r.sale_time || '',
    sale_status: r.sale_status,
    sale_price_mode: r.sale_price_mode || null,
    sale_discount_percent: Number(r.sale_discount_percent) || 0,
    customer_name: r.customer_name || undefined,
    sold_quantity: Number(r.sold_qty) || 0,
    sold_total: Number(r.sold_total) || 0,
    sold_line_discount: Number(r.line_discount) || 0,
    other_approved_quantity: Number(r.other_approved_qty) || 0,
    date: r.created_at ? new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }) : '',
    timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    sync_status: 'synced',
  } as any;
}

export async function getAllReturns(options: { userId?: string; status?: string } = {}): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (options.userId) {
    params.push(options.userId);
    where.push(`r.user_id = $${params.length}`);
  }
  if (options.status) {
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(options.status)) throw new HttpError(400, 'status must be PENDING, APPROVED or REJECTED.');
    params.push(options.status);
    where.push(`r.status = $${params.length}`);
  }
  const res = await pgPool.query(
    `${RETURN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT 1000`,
    params
  );
  return res.rows.map(toReturn);
}

async function getReturnById(q: Pick<pg.PoolClient, 'query'>, id: string) {
  const res = await q.query(`${RETURN_SELECT} WHERE r.id = $1`, [id]);
  return res.rows[0] ? toReturn(res.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Shared helpers (all run inside the caller's transaction)
// ---------------------------------------------------------------------------
async function soldLine(client: pg.PoolClient, saleId: string, medicineId: string, batchId: string) {
  const sold = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS qty, COALESCE(SUM(total), 0)::numeric AS total,
            MAX(unit_price)::float AS unit_price
     FROM sale_items WHERE sale_id = $1 AND medicine_id = $2 AND batch_id = $3 AND quantity > 0`,
    [saleId, medicineId, batchId]
  );
  return { qty: Number(sold.rows[0].qty) || 0, totalCents: toCents(sold.rows[0].total), unitPrice: Number(sold.rows[0].unit_price) || 0 };
}

/** Quantities already APPROVED and still PENDING for this sale line (optionally excluding one return). */
async function claimedQuantities(client: pg.PoolClient, saleId: string, medicineId: string, batchId: string, excludeId?: string) {
  const res = await client.query(
    `SELECT COALESCE(SUM(approved_quantity) FILTER (WHERE status = 'APPROVED'), 0)::int AS approved,
            COALESCE(SUM(quantity) FILTER (WHERE status = 'PENDING'), 0)::int AS pending,
            COALESCE(SUM(refund_amount) FILTER (WHERE status = 'APPROVED'), 0)::numeric AS refunded
     FROM returns
     WHERE sale_id = $1 AND medicine_id = $2 AND batch_id = $3 AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [saleId, medicineId, batchId, excludeId ?? null]
  );
  return { approved: Number(res.rows[0].approved), pending: Number(res.rows[0].pending), refundedCents: toCents(res.rows[0].refunded) };
}

/**
 * Share of what the customer actually paid for `qty` units (discounted / wholesale line totals,
 * plus any tax share). When these units complete the line, the exact remainder is used so total
 * refunds can never exceed what was paid.
 */
function refundCents(sale: any, line: { qty: number; totalCents: number }, qty: number, approvedQty: number, refundedCents: number) {
  let cents = qty === line.qty - approvedQty ? line.totalCents - refundedCents : Math.round((line.totalCents * qty) / line.qty);
  const saleTaxCents = toCents(sale.tax_total || 0);
  if (saleTaxCents > 0) {
    const netCents = toCents(sale.total) - saleTaxCents;
    if (netCents > 0) cents += Math.round((saleTaxCents * cents) / netCents);
  }
  return cents;
}

// ---------------------------------------------------------------------------
// 1. Request (Cashier or Admin) -> PENDING, no effects
// ---------------------------------------------------------------------------
export interface ReturnRequestInput {
  sale_id: string;
  medicine_id: string;
  batch_id: string;
  quantity: number;
  reason: string;
}

export async function requestReturn(input: ReturnRequestInput, actor: SaleActor) {
  const saleId = requireUuid(input?.sale_id, 'sale_id');
  const medicineId = requireUuid(input?.medicine_id, 'medicine_id');
  const batchId = requireUuid(input?.batch_id, 'batch_id');
  const qty = Number(input?.quantity);
  if (!Number.isInteger(qty) || qty < 1) throw new HttpError(400, 'Return quantity must be a whole number of at least 1.');
  const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
  if (!reason) throw new HttpError(400, 'A return reason is required.');

  return withTransaction(async (client) => {
    // Lock the sale: serialises concurrent requests/approvals for the same sale.
    const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    const sale = saleRes.rows[0];
    if (!sale) throw new HttpError(404, 'Original sale not found.');
    if (sale.status === 'voided') throw new HttpError(409, 'This sale was voided; nothing can be returned.');
    if (actor.role !== 'ADMIN' && sale.cashier_id !== actor.user_id) {
      throw new HttpError(403, 'Cashiers can only request returns for their own sales.');
    }

    const line = await soldLine(client, saleId, medicineId, batchId);
    if (line.qty === 0) throw new HttpError(400, 'That medicine/batch is not part of this sale.');
    const claimed = await claimedQuantities(client, saleId, medicineId, batchId);
    const remaining = line.qty - claimed.approved - claimed.pending;
    if (qty > remaining) {
      throw new HttpError(
        409,
        `Only ${Math.max(0, remaining)} unit(s) can still be requested (sold ${line.qty}, approved ${claimed.approved}, pending approval ${claimed.pending}).`
      );
    }

    const estimate = refundCents(sale, line, qty, claimed.approved, claimed.refundedCents);
    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO returns (id, sale_id, receipt_number, medicine_id, batch_id, quantity, unit_price,
         refund_amount, requested_refund, reason, action, status, user_id, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7, 0, $8, $9, 'pending_review', 'PENDING', $10, $11)`,
      [id, saleId, sale.receipt_number, medicineId, batchId, qty, line.unitPrice, fromCents(estimate), reason, actor.user_id, deviceId]
    );
    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'RETURN_REQUESTED',
        entity: 'return',
        entity_id: id,
        new_value: { sale_id: saleId, receipt_number: sale.receipt_number, medicine_id: medicineId, batch_id: batchId, quantity: qty, requested_refund: fromCents(estimate), reason },
      },
      client
    );
    return { success: true, return: (await getReturnById(client, id))!, sale: (await getSaleById(saleId, client))! };
  });
}

/** Locks the sale then the return (same order as requestReturn, so they cannot deadlock). */
async function lockPendingReturn(client: pg.PoolClient, returnId: string) {
  const head = await client.query('SELECT sale_id FROM returns WHERE id = $1', [returnId]);
  if (!head.rows[0]) throw new HttpError(404, 'Return request not found.');
  const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [head.rows[0].sale_id]);
  const ret = (await client.query('SELECT * FROM returns WHERE id = $1 FOR UPDATE', [returnId])).rows[0];
  if (ret.status !== 'PENDING') throw new HttpError(409, `This return was already ${ret.status.toLowerCase()}.`);
  return { ret, sale: saleRes.rows[0] };
}

// ---------------------------------------------------------------------------
// 2. Approve (Admin) -> APPROVED, all effects in one transaction
// ---------------------------------------------------------------------------
export interface ApproveReturnInput {
  restock: boolean;
  disposition?: Disposition;
  notes?: string;
}

export async function approveReturn(returnIdRaw: string, input: ApproveReturnInput, actor: SaleActor) {
  const returnId = requireUuid(returnIdRaw, 'return id');
  if (actor.role !== 'ADMIN') throw new HttpError(403, 'Only an Administrator can approve returns.');
  if (typeof input?.restock !== 'boolean') throw new HttpError(400, 'restock must be true (return to sellable stock) or false.');
  const restock = input.restock;
  const disposition: string = restock ? 'return_to_stock' : (input.disposition || 'quarantine');
  if (!restock && !NON_RESTOCK_DISPOSITIONS.includes(disposition as Disposition)) {
    throw new HttpError(400, `disposition must be one of ${NON_RESTOCK_DISPOSITIONS.join(', ')} when not restocking.`);
  }
  const notes = typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) || null : null;

  return withTransaction(async (client) => {
    const { ret, sale } = await lockPendingReturn(client, returnId);
    if (!sale) throw new HttpError(409, 'The original sale no longer exists.');
    if (sale.status === 'voided') throw new HttpError(409, 'The original sale has been voided; reject this return instead.');

    // Re-validate against ORIGINAL sale data and other APPROVED returns at approval time.
    const line = await soldLine(client, ret.sale_id, ret.medicine_id, ret.batch_id);
    const claimed = await claimedQuantities(client, ret.sale_id, ret.medicine_id, ret.batch_id, returnId);
    const qty = Number(ret.quantity);
    if (qty > line.qty - claimed.approved) {
      throw new HttpError(409, `Only ${Math.max(0, line.qty - claimed.approved)} unit(s) of this item remain returnable.`);
    }
    const cents = refundCents(sale, line, qty, claimed.approved, claimed.refundedCents);

    const batch = (await client.query('SELECT * FROM medicine_batches WHERE id = $1 AND medicine_id = $2 FOR UPDATE', [ret.batch_id, ret.medicine_id])).rows[0];
    if (!batch) throw new HttpError(409, 'The batch of the original sale no longer exists.');
    const { date: today } = await businessNow(client);
    const expired = batch.expiry_date && batch.expiry_date <= today;
    if (restock && (expired || batch.status === 'recalled')) {
      throw new HttpError(400, `Batch ${batch.batch_number} is ${expired ? 'expired' : 'recalled'} and cannot be restocked. Approve with "return to sellable stock: NO".`);
    }

    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    await client.query(
      `UPDATE returns SET status = 'APPROVED', approved_quantity = $2, refund_amount = $3, restocked = $4, action = $5,
         reviewed_by = $6, reviewed_at = CURRENT_TIMESTAMP, review_notes = $7
       WHERE id = $1`,
      [returnId, qty, fromCents(cents), restock, disposition, actor.user_id, notes]
    );

    const prev = Number(batch.quantity_available);
    const next = restock ? prev + qty : prev;
    let savedBatch = batch;
    if (restock) {
      const status = deriveBatchStatus(next, batch.expiry_date, batch.status === 'exhausted' ? 'active' : batch.status);
      savedBatch = (await client.query(
        'UPDATE medicine_batches SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [next, status, batch.id]
      )).rows[0];
    }
    await insertMovement(
      client,
      {
        medicine_id: ret.medicine_id,
        batch_id: ret.batch_id,
        previous_quantity: prev,
        new_quantity: next,
        movement_type: restock ? 'RETURN_APPROVED' : 'RETURN_APPROVED_NOT_RESTOCKED',
        reason: restock ? 'RETURN_APPROVED' : `RETURN_APPROVED_${disposition.toUpperCase()}`,
        reference_id: ret.receipt_number,
        notes: `Return ${returnId} (sale ${ret.sale_id}): ${qty} unit(s) approved by ${actor.user_name}; ${restock ? 'returned to sellable stock' : disposition + ' (not restocked)'}`.slice(0, 1000),
      },
      actor,
      deviceId
    );

    // Sale status from APPROVED quantities only.
    const totals = await client.query(
      `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id = $1 AND quantity > 0)::int AS sold,
              (SELECT COALESCE(SUM(approved_quantity), 0) FROM returns WHERE sale_id = $1 AND status = 'APPROVED')::int AS returned`,
      [ret.sale_id]
    );
    const fully = Number(totals.rows[0].returned) >= Number(totals.rows[0].sold);
    await client.query(`UPDATE sales SET status = $1 WHERE id = $2`, [fully ? 'returned' : 'partially_returned', ret.sale_id]);
    if (sale.customer_id) {
      await client.query(
        'UPDATE customers SET total_spent = GREATEST(0, COALESCE(total_spent, 0) - $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [fromCents(cents), sale.customer_id]
      );
    }
    const medicine = toMedicineStockDto(await reconcileMedicineStock(client, ret.medicine_id));

    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'RETURN_APPROVED',
        entity: 'return',
        entity_id: returnId,
        previous_value: { status: 'PENDING', requested_by: ret.user_id, quantity: qty },
        new_value: {
          status: 'APPROVED',
          sale_id: ret.sale_id,
          receipt_number: ret.receipt_number,
          approved_quantity: qty,
          refund_amount: fromCents(cents),
          restocked: restock,
          disposition,
          notes,
        },
      },
      client
    );

    return {
      success: true,
      return: (await getReturnById(client, returnId))!,
      refund_amount: fromCents(cents),
      sale: (await getSaleById(ret.sale_id, client))!,
      medicine,
      batch: toBatchDto(savedBatch),
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Reject (Admin) -> REJECTED, no effects
// ---------------------------------------------------------------------------
export async function rejectReturn(returnIdRaw: string, notesRaw: unknown, actor: SaleActor) {
  const returnId = requireUuid(returnIdRaw, 'return id');
  if (actor.role !== 'ADMIN') throw new HttpError(403, 'Only an Administrator can reject returns.');
  const notes = typeof notesRaw === 'string' ? notesRaw.trim().slice(0, 1000) : '';
  if (!notes) throw new HttpError(400, 'A rejection reason is required.');

  return withTransaction(async (client) => {
    const { ret } = await lockPendingReturn(client, returnId);
    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    await client.query(
      `UPDATE returns SET status = 'REJECTED', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_notes = $3 WHERE id = $1`,
      [returnId, actor.user_id, notes]
    );
    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'RETURN_REJECTED',
        entity: 'return',
        entity_id: returnId,
        previous_value: { status: 'PENDING', requested_by: ret.user_id, quantity: Number(ret.quantity) },
        new_value: { status: 'REJECTED', sale_id: ret.sale_id, receipt_number: ret.receipt_number, reason: notes },
      },
      client
    );
    return { success: true, return: (await getReturnById(client, returnId))!, sale: (await getSaleById(ret.sale_id, client))! };
  });
}
