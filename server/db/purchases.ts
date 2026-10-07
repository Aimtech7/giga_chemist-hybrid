import crypto from 'crypto';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow } from './client';
import { ensureDevice } from './devices';
import { recordAuditLog } from './audit';
import { enqueueSyncEvent, rowJson, rowsJson } from '../sync/outbox';
import {
  deriveBatchStatus,
  deriveExpiryStatus,
  normalizeExpiryDate,
  insertMovement,
  reconcileMedicineStock,
  toBatchDto,
  toMedicineStockDto,
} from './inventory';
import type { SaleActor } from './sales';
import type { Purchase } from '../../src/types';

const toCents = (n: number) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;

const PURCHASE_SELECT = `
  SELECT p.id, p.branch_id, p.order_number, p.invoice_number, p.supplier_id, s.name AS supplier_name,
         p.order_date, p.received_date, p.status, COALESCE(p.total_amount, 0)::float AS total_amount,
         p.payment_status, p.notes, p.created_by, u.name AS created_by_name, p.created_at
  FROM purchases p
  LEFT JOIN suppliers s ON p.supplier_id = s.id
  LEFT JOIN users u ON p.created_by = u.id`;

async function hydratePurchases(q: { query: Function }, rows: any[]): Promise<Purchase[]> {
  if (rows.length === 0) return [];
  const items = await (q as any).query(
    `SELECT pi.id, pi.purchase_id, pi.medicine_id, m.name AS medicine_name, pi.batch_number,
            pi.manufacturing_date, pi.expiry_date, pi.quantity::int AS quantity,
            pi.purchase_price::float AS purchase_price, pi.total::float AS total
     FROM purchase_items pi LEFT JOIN medicines m ON pi.medicine_id = m.id
     WHERE pi.purchase_id = ANY($1::uuid[]) ORDER BY pi.created_at, pi.id`,
    [rows.map((r) => r.id)]
  );
  const byPurchase = new Map<string, any[]>();
  for (const it of items.rows) {
    const list = byPurchase.get(it.purchase_id) || [];
    list.push({
      id: it.id,
      medicine_id: it.medicine_id,
      medicine_name: it.medicine_name || 'Pharmaceutical Item',
      batch_number: it.batch_number,
      manufacturing_date: it.manufacturing_date || '',
      expiry_date: it.expiry_date || '',
      quantity: Number(it.quantity) || 0,
      purchase_price: Number(it.purchase_price) || 0,
      total: Number(it.total) || 0,
    });
    byPurchase.set(it.purchase_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    branch_id: r.branch_id || undefined,
    order_number: r.order_number,
    invoice_number: r.invoice_number,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name || 'Supplier',
    order_date: r.order_date || '',
    received_date: r.received_date || undefined,
    status: r.status,
    total_amount: Number(r.total_amount) || 0,
    payment_status: r.payment_status || 'unpaid',
    notes: r.notes || '',
    items: byPurchase.get(r.id) || [],
    created_by: r.created_by_name || 'Admin',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    sync_status: 'synced',
  })) as Purchase[];
}

export async function getAllPurchases(): Promise<Purchase[]> {
  const res = await pgPool.query(`${PURCHASE_SELECT} ORDER BY p.order_date DESC, p.created_at DESC LIMIT 1000`);
  return hydratePurchases(pgPool, res.rows);
}

export interface PurchaseItemInput {
  medicine_id: string;
  batch_number: string;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  quantity: number;
  purchase_price: number;
}

export interface PurchaseInput {
  supplier_id: string;
  invoice_number: string;
  items: PurchaseItemInput[];
  payment_status?: 'paid' | 'partial' | 'unpaid';
  notes?: string;
}

/**
 * Receives supplier goods in ONE transaction: purchase + purchase_items, batch create-or-increment
 * (matched by medicine + batch number), stock movements, medicine stock reconciliation and audit.
 */
export async function receivePurchaseOrder(input: PurchaseInput, actor: SaleActor) {
  const supplierId = requireUuid(input?.supplier_id, 'supplier_id');
  const invoice = typeof input?.invoice_number === 'string' ? input.invoice_number.trim().toUpperCase().slice(0, 100) : '';
  if (!invoice) throw new HttpError(400, 'The supplier invoice number is required.');
  if (!Array.isArray(input?.items) || input.items.length === 0) throw new HttpError(400, 'Add at least one item to the purchase.');
  if (input.items.length > 500) throw new HttpError(400, 'Too many lines in one purchase.');
  const paymentStatus = input.payment_status || 'paid';
  if (!['paid', 'partial', 'unpaid'].includes(paymentStatus)) throw new HttpError(400, 'payment_status must be paid, partial or unpaid.');

  const items = input.items.map((raw, i) => {
    const qty = Number(raw?.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new HttpError(400, `Line ${i + 1}: quantity must be a whole number of at least 1.`);
    const price = Number(raw?.purchase_price);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, `Line ${i + 1}: purchase price must be a non-negative number.`);
    const batchNumber = typeof raw?.batch_number === 'string' ? raw.batch_number.trim().toUpperCase().slice(0, 100) : '';
    if (!batchNumber) throw new HttpError(400, `Line ${i + 1}: batch number is required.`);
    return {
      medicine_id: requireUuid(raw?.medicine_id, 'medicine_id'),
      batch_number: batchNumber,
      manufacturing_date: normalizeExpiryDate(raw?.manufacturing_date ?? null),
      expiry_date: normalizeExpiryDate(raw?.expiry_date ?? null),
      quantity: qty,
      priceCents: toCents(price),
    };
  });
  const seen = new Set<string>();
  for (const it of items) {
    const k = `${it.medicine_id}|${it.batch_number}`;
    if (seen.has(k)) throw new HttpError(400, `Batch ${it.batch_number} appears twice for the same medicine; combine the lines.`);
    seen.add(k);
  }

  return withTransaction(async (client) => {
    const sup = await client.query('SELECT id, name, status FROM suppliers WHERE id = $1', [supplierId]);
    if (!sup.rows[0]) throw new HttpError(404, 'Supplier not found.');
    if (sup.rows[0].status === 'inactive') throw new HttpError(409, 'This supplier is inactive.');
    const dupInvoice = await client.query(
      'SELECT order_number FROM purchases WHERE supplier_id = $1 AND UPPER(invoice_number) = $2 LIMIT 1',
      [supplierId, invoice]
    );
    if (dupInvoice.rows[0]) {
      throw new HttpError(409, `Invoice ${invoice} from this supplier was already received (${dupInvoice.rows[0].order_number}).`);
    }

    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    const { date: today } = await businessNow(client);
    for (const it of items) {
      if (it.expiry_date && it.expiry_date <= today) {
        throw new HttpError(400, `Batch ${it.batch_number} is already expired (${it.expiry_date}) and cannot be received.`);
      }
    }

    const medIds = [...new Set(items.map((i) => i.medicine_id))].sort();
    const meds = await client.query('SELECT id, name FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [medIds]);
    if (meds.rows.length !== medIds.length) throw new HttpError(404, 'One or more medicines were not found.');

    const seq = await client.query(`SELECT nextval('purchase_order_seq') AS n`);
    const orderNumber = `PO-${today.replace(/-/g, '')}-${String(seq.rows[0].n).padStart(5, '0')}`;
    const purchaseId = crypto.randomUUID();
    const totalCents = items.reduce((s, it) => s + it.priceCents * it.quantity, 0);

    await client.query(
      `INSERT INTO purchases (id, order_number, invoice_number, supplier_id, order_date, received_date, status,
         total_amount, payment_status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$5,'received',$6,$7,$8,$9)`,
      [purchaseId, orderNumber, invoice, supplierId, today, fromCents(totalCents), paymentStatus,
       typeof input.notes === 'string' ? input.notes.slice(0, 2000) : null, actor.user_id]
    );

    const touched = new Map<string, any>();
    for (const it of [...items].sort((a, b) => a.medicine_id.localeCompare(b.medicine_id))) {
      const existing = await client.query(
        'SELECT * FROM medicine_batches WHERE medicine_id = $1 AND UPPER(batch_number) = $2 FOR UPDATE',
        [it.medicine_id, it.batch_number]
      );
      let prev = 0;
      let saved: any;
      if (existing.rows[0]) {
        const b = existing.rows[0];
        if (it.expiry_date && b.expiry_date && b.expiry_date !== it.expiry_date) {
          throw new HttpError(409, `Batch ${it.batch_number} already exists with expiry ${b.expiry_date}, not ${it.expiry_date}.`);
        }
        prev = Number(b.quantity_available);
        const next = prev + it.quantity;
        const expiry = it.expiry_date ?? b.expiry_date ?? null;
        const upd = await client.query(
          `UPDATE medicine_batches SET quantity_available = $1, quantity_received = quantity_received + $2,
             expiry_date = $3, expiry_status = $4, purchase_price = $5, supplier_id = $6,
             purchase_invoice = $7, received_date = $8, status = $9, updated_at = CURRENT_TIMESTAMP
           WHERE id = $10 RETURNING *`,
          [next, it.quantity, expiry, deriveExpiryStatus(expiry), fromCents(it.priceCents), supplierId, invoice, today,
           deriveBatchStatus(next, expiry, b.status === 'exhausted' ? 'active' : b.status), b.id]
        );
        saved = upd.rows[0];
      } else {
        const ins = await client.query(
          `INSERT INTO medicine_batches (id, medicine_id, batch_number, supplier_id, quantity_received, quantity_available,
             purchase_price, manufacturing_date, expiry_date, expiry_status, received_date, purchase_invoice, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [crypto.randomUUID(), it.medicine_id, it.batch_number, supplierId, it.quantity, fromCents(it.priceCents),
           it.manufacturing_date, it.expiry_date, deriveExpiryStatus(it.expiry_date), today, invoice,
           deriveBatchStatus(it.quantity, it.expiry_date), actor.user_id]
        );
        saved = ins.rows[0];
      }
      touched.set(saved.id, saved);

      await client.query(
        `INSERT INTO purchase_items (id, purchase_id, medicine_id, batch_number, manufacturing_date, expiry_date,
           quantity, purchase_price, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [crypto.randomUUID(), purchaseId, it.medicine_id, it.batch_number, it.manufacturing_date, it.expiry_date,
         it.quantity, fromCents(it.priceCents), fromCents(it.priceCents * it.quantity)]
      );
      // Latest landed cost becomes the medicine's cost price (selling price is never changed here).
      await client.query(
        'UPDATE medicines SET purchase_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [fromCents(it.priceCents), it.medicine_id]
      );
      await insertMovement(
        client,
        {
          medicine_id: it.medicine_id,
          batch_id: saved.id,
          previous_quantity: prev,
          new_quantity: Number(saved.quantity_available),
          movement_type: 'PURCHASE',
          reason: 'PURCHASE_RECEIPT',
          reference_id: orderNumber,
          notes: `Received on supplier invoice ${invoice} (${orderNumber})`,
        },
        actor,
        deviceId
      );
    }

    const medicines = [];
    for (const id of medIds) medicines.push(toMedicineStockDto(await reconcileMedicineStock(client, id)));

    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'PURCHASE_GOODS_RECEIVED',
        entity: 'purchase',
        entity_id: purchaseId,
        new_value: { order_number: orderNumber, invoice_number: invoice, supplier_id: supplierId, lines: items.length, total: fromCents(totalCents) },
      },
      client
    );
    await enqueueSyncEvent(client, {
      event_type: 'PURCHASE_RECEIVED',
      entity_type: 'purchase',
      entity_id: purchaseId,
      operation: 'RECEIVE',
      data: async () => ({
        purchase: await rowJson(client, 'purchases', purchaseId),
        items: await rowsJson(client, 'purchase_items', 'purchase_id', purchaseId),
        supplier: await rowJson(client, 'suppliers', supplierId),
      }),
      actor,
      device_id: deviceId,
      business_ref: invoice,
    });

    const res = await client.query(`${PURCHASE_SELECT} WHERE p.id = $1`, [purchaseId]);
    const [purchase] = await hydratePurchases(client, res.rows);
    return { success: true, purchase, medicines, batches: [...touched.values()].map((b) => toBatchDto(b)) };
  });
}
