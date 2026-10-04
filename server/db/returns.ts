import crypto from 'crypto';
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

const RETURN_ACTIONS = ['return_to_stock', 'damaged', 'quarantine', 'dispose'] as const;
type ReturnActionValue = (typeof RETURN_ACTIONS)[number];

const toCents = (n: number) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;

export async function getAllReturns(options: { userId?: string } = {}): Promise<CustomerReturn[]> {
  const params: any[] = [];
  const filter = options.userId ? (params.push(options.userId), 'WHERE r.user_id = $1') : '';
  const res = await pgPool.query(
    `SELECT r.id, r.branch_id, r.sale_id, r.receipt_number, r.medicine_id, m.name AS medicine_name,
            r.batch_id, b.batch_number, r.quantity::int AS quantity, r.unit_price::float AS unit_price,
            r.refund_amount::float AS refund_amount, r.reason, r.action, r.user_id, u.name AS user_name,
            r.device_id, r.created_at
     FROM returns r
     LEFT JOIN medicines m ON r.medicine_id = m.id
     LEFT JOIN medicine_batches b ON r.batch_id = b.id
     LEFT JOIN users u ON r.user_id = u.id
     ${filter}
     ORDER BY r.created_at DESC
     LIMIT 1000`,
    params
  );
  return res.rows.map((r) => ({
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
    effective_unit_price: r.quantity ? Math.round((Number(r.refund_amount) / Number(r.quantity)) * 100) / 100 : 0,
    refund_amount: Number(r.refund_amount) || 0,
    reason: r.reason,
    action: r.action,
    user_id: r.user_id,
    user_name: r.user_name || 'Staff',
    device_id: r.device_id,
    date: r.created_at ? new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }) : '',
    timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    sync_status: 'synced',
  })) as CustomerReturn[];
}

export interface ReturnInput {
  sale_id: string;
  medicine_id: string;
  batch_id: string;
  quantity: number;
  reason: string;
  action: ReturnActionValue;
}

/**
 * Records a customer return in ONE transaction. The refund is the share of what the customer
 * actually paid for those units (the discounted line total, plus any tax share), never the
 * current medicine price. Stock is restored only for 'return_to_stock' into a non-expired,
 * non-recalled batch; other actions keep the goods out of sellable stock.
 */
export async function processCustomerReturn(input: ReturnInput, actor: SaleActor) {
  const saleId = requireUuid(input?.sale_id, 'sale_id');
  const medicineId = requireUuid(input?.medicine_id, 'medicine_id');
  const batchId = requireUuid(input?.batch_id, 'batch_id');
  const qty = Number(input?.quantity);
  if (!Number.isInteger(qty) || qty < 1) throw new HttpError(400, 'Return quantity must be a whole number of at least 1.');
  const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
  if (!reason) throw new HttpError(400, 'A return reason is required.');
  const action = input?.action;
  if (!RETURN_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${RETURN_ACTIONS.join(', ')}.`);

  return withTransaction(async (client) => {
    const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    const sale = saleRes.rows[0];
    if (!sale) throw new HttpError(404, 'Original sale not found.');
    if (sale.status === 'voided') throw new HttpError(409, 'This sale was voided; nothing can be returned.');
    if (actor.role === 'CASHIER' && sale.cashier_id !== actor.user_id) {
      throw new HttpError(403, 'Cashiers can only process returns for their own sales.');
    }

    const sold = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS qty, COALESCE(SUM(total), 0)::numeric AS total,
              MAX(unit_price)::float AS unit_price
       FROM sale_items WHERE sale_id = $1 AND medicine_id = $2 AND batch_id = $3 AND quantity > 0`,
      [saleId, medicineId, batchId]
    );
    const soldQty = Number(sold.rows[0].qty) || 0;
    if (soldQty === 0) throw new HttpError(400, 'That medicine/batch is not part of this sale.');
    const soldCents = toCents(sold.rows[0].total);

    const prior = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS qty, COALESCE(SUM(refund_amount), 0)::numeric AS refunded
       FROM returns WHERE sale_id = $1 AND medicine_id = $2 AND batch_id = $3`,
      [saleId, medicineId, batchId]
    );
    const returnedQty = Number(prior.rows[0].qty) || 0;
    const remaining = soldQty - returnedQty;
    if (qty > remaining) {
      throw new HttpError(409, `Only ${remaining} unit(s) of this item can still be returned (sold ${soldQty}, already returned ${returnedQty}).`);
    }

    // Proportional share of the discounted line total; the final return takes the exact remainder
    // so the sum of refunds can never exceed what was paid.
    let refundCents =
      qty === remaining
        ? soldCents - toCents(prior.rows[0].refunded)
        : Math.round((soldCents * qty) / soldQty);
    const saleTaxCents = toCents(sale.tax_total || 0);
    if (saleTaxCents > 0) {
      const netCents = toCents(sale.total) - saleTaxCents;
      if (netCents > 0) refundCents += Math.round((saleTaxCents * refundCents) / netCents);
    }

    const batchRes = await client.query('SELECT * FROM medicine_batches WHERE id = $1 AND medicine_id = $2 FOR UPDATE', [batchId, medicineId]);
    const batch = batchRes.rows[0];
    if (!batch) throw new HttpError(409, 'The batch of the original sale no longer exists.');

    const { date: today } = await businessNow(client);
    const expired = batch.expiry_date && batch.expiry_date <= today;
    if (action === 'return_to_stock' && (expired || batch.status === 'recalled')) {
      throw new HttpError(
        400,
        `Batch ${batch.batch_number} is ${expired ? 'expired' : 'recalled'} and cannot be restocked. Choose quarantine or dispose.`
      );
    }

    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    const returnId = crypto.randomUUID();
    await client.query(
      `INSERT INTO returns (id, sale_id, receipt_number, medicine_id, batch_id, quantity, unit_price,
         refund_amount, reason, action, user_id, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [returnId, saleId, sale.receipt_number, medicineId, batchId, qty, Number(sold.rows[0].unit_price) || 0,
       fromCents(refundCents), reason, action, actor.user_id, deviceId]
    );

    const prev = Number(batch.quantity_available);
    const restock = action === 'return_to_stock';
    const next = restock ? prev + qty : prev;
    let savedBatch = batch;
    if (restock) {
      const status = deriveBatchStatus(next, batch.expiry_date, batch.status === 'exhausted' ? 'active' : batch.status);
      const upd = await client.query(
        'UPDATE medicine_batches SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [next, status, batchId]
      );
      savedBatch = upd.rows[0];
    }
    await insertMovement(
      client,
      {
        medicine_id: medicineId,
        batch_id: batchId,
        previous_quantity: prev,
        new_quantity: next,
        movement_type: restock ? 'CUSTOMER_RETURN' : 'RETURN_NOT_RESTOCKED',
        reason: restock ? 'CUSTOMER_RETURN' : `RETURN_${action.toUpperCase()}`,
        reference_id: sale.receipt_number,
        notes: `${qty} unit(s) returned on ${sale.receipt_number} (${action}): ${reason}`.slice(0, 1000),
      },
      actor,
      deviceId
    );

    const totalReturned = returnedQty + qty;
    const allItems = await client.query(
      `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id = $1 AND quantity > 0)::int AS sold,
              (SELECT COALESCE(SUM(quantity), 0) FROM returns WHERE sale_id = $1)::int AS returned`,
      [saleId]
    );
    const fully = Number(allItems.rows[0].returned) >= Number(allItems.rows[0].sold);
    await client.query(`UPDATE sales SET status = $1 WHERE id = $2`, [fully ? 'returned' : 'partially_returned', saleId]);
    if (sale.customer_id) {
      await client.query(
        'UPDATE customers SET total_spent = GREATEST(0, COALESCE(total_spent, 0) - $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [fromCents(refundCents), sale.customer_id]
      );
    }
    const medicine = toMedicineStockDto(await reconcileMedicineStock(client, medicineId));

    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'RETURN_PROCESSED',
        entity: 'return',
        entity_id: returnId,
        new_value: {
          sale_id: saleId,
          receipt_number: sale.receipt_number,
          medicine_id: medicineId,
          batch_id: batchId,
          quantity: qty,
          refund_amount: fromCents(refundCents),
          action,
          restocked: restock,
          item_returned_total: totalReturned,
        },
      },
      client
    );

    const [ret] = (await getAllReturnsById(client, returnId));
    return {
      success: true,
      return: ret,
      refund_amount: fromCents(refundCents),
      sale: (await getSaleById(saleId, client))!,
      medicine,
      batch: toBatchDto(savedBatch),
    };
  });
}

async function getAllReturnsById(client: any, id: string): Promise<CustomerReturn[]> {
  const res = await client.query(
    `SELECT r.*, r.quantity::int AS quantity, r.unit_price::float AS unit_price, r.refund_amount::float AS refund_amount,
            m.name AS medicine_name, b.batch_number, u.name AS user_name
     FROM returns r LEFT JOIN medicines m ON r.medicine_id = m.id
     LEFT JOIN medicine_batches b ON r.batch_id = b.id LEFT JOIN users u ON r.user_id = u.id
     WHERE r.id = $1`,
    [id]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    sale_id: r.sale_id,
    receipt_number: r.receipt_number,
    medicine_id: r.medicine_id,
    medicine_name: r.medicine_name || 'Item',
    batch_id: r.batch_id,
    batch_number: r.batch_number || 'Batch',
    quantity: r.quantity,
    unit_price: r.unit_price,
    effective_unit_price: Math.round((r.refund_amount / r.quantity) * 100) / 100,
    refund_amount: r.refund_amount,
    reason: r.reason,
    action: r.action,
    user_id: r.user_id,
    user_name: r.user_name || 'Staff',
    device_id: r.device_id,
    date: new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }),
    timestamp: new Date(r.created_at).getTime(),
    sync_status: 'synced',
  }));
}
