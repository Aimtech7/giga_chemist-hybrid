import { setPriceContext } from './priceHistory';
import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow, cleanUuid, type Queryable } from './client';
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
         p.payment_status, p.notes, p.cancel_reason, p.created_by, u.name AS created_by_name, p.created_at
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
    invoice_number: r.invoice_number || '',
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name || 'Supplier',
    order_date: r.order_date || '',
    received_date: r.received_date || undefined,
    status: r.status,
    total_amount: Number(r.total_amount) || 0,
    payment_status: r.payment_status || 'unpaid',
    notes: r.notes || '',
    cancel_reason: r.cancel_reason || undefined,
    items: byPurchase.get(r.id) || [],
    created_by: r.created_by_name || 'Admin',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    sync_status: 'synced',
  })) as Purchase[];
}

export async function getAllPurchases(q: Queryable = pgPool): Promise<Purchase[]> {
  const res = await q.query(`${PURCHASE_SELECT} ORDER BY p.order_date DESC, p.created_at DESC LIMIT 1000`);
  return hydratePurchases(q, res.rows);
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

interface NormalizedItem {
  medicine_id: string;
  batch_number: string;
  manufacturing_date: string | null;
  expiry_date: string | null;
  quantity: number;
  priceCents: number;
}

const PAYMENT_STATUSES = ['paid', 'partial', 'unpaid'];
/** Purchase lifecycle: pending (draft, nothing in stock) -> received (stock in) | cancelled. */
export const PURCHASE_DRAFT = 'pending';

function normalizeInvoice(v: unknown, required: boolean): string | null {
  const invoice = typeof v === 'string' ? v.trim().toUpperCase().slice(0, 100) : '';
  if (!invoice && required) throw new HttpError(400, 'The supplier invoice number is required.');
  return invoice || null;
}

function normalizePaymentStatus(v: unknown, fallback: string): string {
  const s = v === undefined || v === null || v === '' ? fallback : String(v);
  if (!PAYMENT_STATUSES.includes(s)) throw new HttpError(400, 'payment_status must be paid, partial or unpaid.');
  return s;
}

/** Same line rules for drafts, direct receipts and remote commands. */
export function normalizePurchaseItems(raw: unknown): NormalizedItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'Add at least one item to the purchase.');
  if (raw.length > 500) throw new HttpError(400, 'Too many lines in one purchase.');
  const items = raw.map((it: any, i: number) => {
    const qty = Number(it?.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new HttpError(400, `Line ${i + 1}: quantity must be a whole number of at least 1.`);
    const price = Number(it?.purchase_price);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, `Line ${i + 1}: purchase price must be a non-negative number.`);
    const batchNumber = typeof it?.batch_number === 'string' ? it.batch_number.trim().toUpperCase().slice(0, 100) : '';
    if (!batchNumber) throw new HttpError(400, `Line ${i + 1}: batch number is required.`);
    return {
      medicine_id: requireUuid(it?.medicine_id, 'medicine_id'),
      batch_number: batchNumber,
      manufacturing_date: normalizeExpiryDate(it?.manufacturing_date ?? null),
      expiry_date: normalizeExpiryDate(it?.expiry_date ?? null),
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
  return items;
}

async function activeSupplier(client: pg.PoolClient, supplierId: string) {
  const sup = await client.query('SELECT id, name, status FROM suppliers WHERE id = $1', [supplierId]);
  if (!sup.rows[0]) throw new HttpError(404, 'Supplier not found.');
  if (sup.rows[0].status === 'inactive') throw new HttpError(409, 'This supplier is inactive.');
  return sup.rows[0];
}

async function assertMedicinesExist(client: pg.PoolClient, items: NormalizedItem[]) {
  const ids = [...new Set(items.map((i) => i.medicine_id))];
  const found = await client.query('SELECT COUNT(*)::int AS n FROM medicines WHERE id = ANY($1::uuid[])', [ids]);
  if (found.rows[0].n !== ids.length) throw new HttpError(404, 'One or more medicines were not found.');
}

async function nextOrderNumber(client: pg.PoolClient, today: string): Promise<string> {
  const seq = await client.query(`SELECT nextval('purchase_order_seq') AS n`);
  return `PO-${today.replace(/-/g, '')}-${String(seq.rows[0].n).padStart(5, '0')}`;
}

async function insertItems(client: pg.PoolClient, purchaseId: string, items: NormalizedItem[]) {
  for (const it of items) {
    await client.query(
      `INSERT INTO purchase_items (id, purchase_id, medicine_id, batch_number, manufacturing_date, expiry_date,
         quantity, purchase_price, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [crypto.randomUUID(), purchaseId, it.medicine_id, it.batch_number, it.manufacturing_date, it.expiry_date,
       it.quantity, fromCents(it.priceCents), fromCents(it.priceCents * it.quantity)]
    );
  }
}

async function purchaseEventData(client: pg.PoolClient, purchaseId: string, supplierId: string, extra: Record<string, unknown> = {}) {
  return {
    purchase: await rowJson(client, 'purchases', purchaseId),
    items: await rowsJson(client, 'purchase_items', 'purchase_id', purchaseId),
    supplier: await rowJson(client, 'suppliers', supplierId),
    ...extra,
  };
}

async function readPurchase(client: pg.PoolClient, purchaseId: string): Promise<Purchase> {
  const res = await client.query(`${PURCHASE_SELECT} WHERE p.id = $1`, [purchaseId]);
  return (await hydratePurchases(client, res.rows))[0];
}

/**
 * Puts received goods into stock (shared by a direct receipt and receiving a draft): batch
 * create-or-increment (matched by medicine + batch number), purchase_items (direct receipt only),
 * movements, latest landed cost, medicine stock reconciliation. Caller's transaction.
 */
async function receiveIntoStock(
  client: pg.PoolClient,
  p: { purchaseId: string; orderNumber: string; invoice: string; supplierId: string; items: NormalizedItem[]; insertLines: boolean; today: string; deviceId: string },
  actor: SaleActor
) {
  for (const it of p.items) {
    if (it.expiry_date && it.expiry_date <= p.today) {
      throw new HttpError(400, `Batch ${it.batch_number} is already expired (${it.expiry_date}) and cannot be received.`);
    }
  }
  const medIds = [...new Set(p.items.map((i) => i.medicine_id))].sort();
  const meds = await client.query('SELECT id, name FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [medIds]);
  if (meds.rows.length !== medIds.length) throw new HttpError(404, 'One or more medicines were not found.');

  // Latest landed cost below changes medicine / batch purchase prices: attributed in price_history.
  await setPriceContext(client, actor, 'PURCHASE_RECEIPT', { reference: p.orderNumber, reason: `Purchase ${p.orderNumber} received` });
  const touched = new Map<string, any>();
  for (const it of [...p.items].sort((a, b) => a.medicine_id.localeCompare(b.medicine_id))) {
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
        [next, it.quantity, expiry, deriveExpiryStatus(expiry), fromCents(it.priceCents), p.supplierId, p.invoice, p.today,
         deriveBatchStatus(next, expiry, b.status === 'exhausted' ? 'active' : b.status), b.id]
      );
      saved = upd.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO medicine_batches (id, medicine_id, batch_number, supplier_id, quantity_received, quantity_available,
           purchase_price, manufacturing_date, expiry_date, expiry_status, received_date, purchase_invoice, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [crypto.randomUUID(), it.medicine_id, it.batch_number, p.supplierId, it.quantity, fromCents(it.priceCents),
         it.manufacturing_date, it.expiry_date, deriveExpiryStatus(it.expiry_date), p.today, p.invoice,
         deriveBatchStatus(it.quantity, it.expiry_date), cleanUuid(actor.user_id)]
      );
      saved = ins.rows[0];
    }
    touched.set(saved.id, saved);
    if (p.insertLines) await insertItems(client, p.purchaseId, [it]);
    // Latest landed cost becomes the medicine's cost price (selling price is never changed here).
    await client.query('UPDATE medicines SET purchase_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [fromCents(it.priceCents), it.medicine_id]);
    await insertMovement(
      client,
      {
        medicine_id: it.medicine_id,
        batch_id: saved.id,
        previous_quantity: prev,
        new_quantity: Number(saved.quantity_available),
        movement_type: 'PURCHASE',
        reason: 'PURCHASE_RECEIPT',
        reference_id: p.orderNumber,
        notes: `Received on supplier invoice ${p.invoice} (${p.orderNumber})`,
      },
      actor,
      p.deviceId
    );
  }
  const medicines = [];
  for (const id of medIds) medicines.push(toMedicineStockDto(await reconcileMedicineStock(client, id)));
  return { medicines, batches: [...touched.values()].map((b) => toBatchDto(b)) };
}

async function assertInvoiceFree(client: pg.PoolClient, supplierId: string, invoice: string, exceptId: string | null) {
  const dup = await client.query(
    `SELECT order_number FROM purchases WHERE supplier_id = $1 AND UPPER(invoice_number) = $2
        AND COALESCE(status, 'received') <> 'cancelled' AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
    [supplierId, invoice, exceptId]
  );
  if (dup.rows[0]) throw new HttpError(409, `Invoice ${invoice} from this supplier was already received (${dup.rows[0].order_number}).`);
}

/**
 * Receives supplier goods in ONE transaction (caller's): purchase + purchase_items, stock in,
 * movements, medicine stock reconciliation, audit and outbox event.
 */
export async function receivePurchaseOrderTx(client: pg.PoolClient, purchaseId: string, input: PurchaseInput, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const supplierId = requireUuid(input?.supplier_id, 'supplier_id');
  const invoice = normalizeInvoice(input?.invoice_number, true)!;
  const items = normalizePurchaseItems(input?.items);
  const paymentStatus = normalizePaymentStatus(input?.payment_status, 'paid');

  await activeSupplier(client, supplierId);
  await assertInvoiceFree(client, supplierId, invoice, null);
  const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
  const { date: today } = await businessNow(client);
  const orderNumber = await nextOrderNumber(client, today);
  const totalCents = items.reduce((s, it) => s + it.priceCents * it.quantity, 0);

  await client.query(
    `INSERT INTO purchases (id, order_number, invoice_number, supplier_id, order_date, received_date, status,
       total_amount, payment_status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$5,'received',$6,$7,$8,$9)`,
    [purchaseId, orderNumber, invoice, supplierId, today, fromCents(totalCents), paymentStatus,
     typeof input.notes === 'string' ? input.notes.slice(0, 2000) : null, cleanUuid(actor.user_id)]
  );
  const stock = await receiveIntoStock(client, { purchaseId, orderNumber, invoice, supplierId, items, insertLines: true, today, deviceId }, actor);

  await recordAuditLog(
    {
      user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: deviceId,
      action: 'PURCHASE_GOODS_RECEIVED', entity: 'purchase', entity_id: purchaseId,
      new_value: { order_number: orderNumber, invoice_number: invoice, supplier_id: supplierId, lines: items.length, total: fromCents(totalCents), ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'PURCHASE_RECEIVED', entity_type: 'purchase', entity_id: purchaseId, operation: 'RECEIVE',
    data: () => purchaseEventData(client, purchaseId, supplierId, extra),
    actor, device_id: deviceId, business_ref: invoice,
  });
  return { success: true, purchase: await readPurchase(client, purchaseId), ...stock };
}

export async function receivePurchaseOrder(input: PurchaseInput, actor: SaleActor) {
  // Validate before opening a transaction (same messages as before).
  requireUuid(input?.supplier_id, 'supplier_id');
  normalizeInvoice(input?.invoice_number, true);
  normalizePurchaseItems(input?.items);
  normalizePaymentStatus(input?.payment_status, 'paid');
  return withTransaction((client) => receivePurchaseOrderTx(client, crypto.randomUUID(), input, actor));
}

// ---------------------------------------------------------------------------- draft lifecycle
export interface DraftPurchaseInput {
  supplier_id: string;
  invoice_number?: string | null;
  items: PurchaseItemInput[];
  payment_status?: 'paid' | 'partial' | 'unpaid';
  notes?: string | null;
}

/** A PENDING (draft) purchase: recorded, nothing in stock until it is received. */
export async function createDraftPurchaseTx(client: pg.PoolClient, purchaseId: string, input: DraftPurchaseInput, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const supplierId = requireUuid(input?.supplier_id, 'supplier_id');
  const items = normalizePurchaseItems(input?.items);
  const invoice = normalizeInvoice(input?.invoice_number, false);
  const paymentStatus = normalizePaymentStatus(input?.payment_status, 'unpaid');
  await activeSupplier(client, supplierId);
  await assertMedicinesExist(client, items);
  const { date: today } = await businessNow(client);
  const orderNumber = await nextOrderNumber(client, today);
  const totalCents = items.reduce((s, it) => s + it.priceCents * it.quantity, 0);
  await client.query(
    `INSERT INTO purchases (id, order_number, invoice_number, supplier_id, order_date, received_date, status,
       total_amount, payment_status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10)`,
    [purchaseId, orderNumber, invoice, supplierId, today, PURCHASE_DRAFT, fromCents(totalCents), paymentStatus,
     typeof input.notes === 'string' ? input.notes.slice(0, 2000) : null, cleanUuid(actor.user_id)]
  );
  await insertItems(client, purchaseId, items);
  await recordAuditLog(
    {
      user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: actor.device_id,
      action: 'PURCHASE_DRAFT_CREATED', entity: 'purchase', entity_id: purchaseId,
      new_value: { order_number: orderNumber, supplier_id: supplierId, invoice_number: invoice, lines: items.length, total: fromCents(totalCents), ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'PURCHASE_DRAFTED', entity_type: 'purchase', entity_id: purchaseId, operation: 'CREATE',
    data: () => purchaseEventData(client, purchaseId, supplierId, extra), actor, business_ref: orderNumber,
  });
  return readPurchase(client, purchaseId);
}

async function lockDraft(client: pg.PoolClient, purchaseId: string, doing: string) {
  const r = await client.query('SELECT * FROM purchases WHERE id = $1 FOR UPDATE', [purchaseId]);
  const p = r.rows[0];
  if (!p) throw new HttpError(404, 'Purchase not found.');
  if (p.status === 'received') throw new HttpError(409, `This purchase was already received; it cannot be ${doing}.`);
  if (p.status === 'cancelled') throw new HttpError(409, `This purchase was cancelled; it cannot be ${doing}.`);
  if (p.status !== PURCHASE_DRAFT) throw new HttpError(409, `A purchase with status "${p.status}" cannot be ${doing}.`);
  return p;
}

/** Edits a PENDING purchase (header fields and/or the complete list of lines). */
export async function updateDraftPurchaseTx(client: pg.PoolClient, purchaseId: string, patch: Partial<DraftPurchaseInput>, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const before = await lockDraft(client, purchaseId, 'edited');
  const supplierId = patch.supplier_id !== undefined ? requireUuid(patch.supplier_id, 'supplier_id') : before.supplier_id;
  if (supplierId !== before.supplier_id) await activeSupplier(client, supplierId);
  const invoice = patch.invoice_number !== undefined ? normalizeInvoice(patch.invoice_number, false) : before.invoice_number;
  const paymentStatus = normalizePaymentStatus(patch.payment_status, before.payment_status || 'unpaid');
  const notes = patch.notes !== undefined ? (typeof patch.notes === 'string' ? patch.notes.slice(0, 2000) : null) : before.notes;
  let total = Number(before.total_amount);
  if (patch.items !== undefined) {
    const items = normalizePurchaseItems(patch.items);
    await assertMedicinesExist(client, items);
    await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [purchaseId]);
    await insertItems(client, purchaseId, items);
    total = fromCents(items.reduce((s, it) => s + it.priceCents * it.quantity, 0));
  }
  await client.query(
    `UPDATE purchases SET supplier_id = $2, invoice_number = $3, payment_status = $4, notes = $5, total_amount = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [purchaseId, supplierId, invoice, paymentStatus, notes, total]
  );
  await recordAuditLog(
    {
      user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: actor.device_id,
      action: 'PURCHASE_DRAFT_UPDATED', entity: 'purchase', entity_id: purchaseId,
      previous_value: { supplier_id: before.supplier_id, invoice_number: before.invoice_number, total: Number(before.total_amount), payment_status: before.payment_status },
      new_value: { supplier_id: supplierId, invoice_number: invoice, total, payment_status: paymentStatus, lines_replaced: patch.items !== undefined, ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'PURCHASE_UPDATED', entity_type: 'purchase', entity_id: purchaseId, operation: 'UPDATE',
    data: () => purchaseEventData(client, purchaseId, supplierId, extra), actor, business_ref: before.order_number,
  });
  return readPurchase(client, purchaseId);
}

/** Receives a PENDING purchase: its lines go into stock in this one transaction. */
export async function receiveDraftPurchaseTx(
  client: pg.PoolClient, purchaseId: string, opts: { invoice_number?: string | null; payment_status?: string | null }, actor: SaleActor, extra: Record<string, unknown> = {}
) {
  const draft = await lockDraft(client, purchaseId, 'received again');
  const invoice = normalizeInvoice(opts.invoice_number ?? draft.invoice_number, true)!;
  const paymentStatus = normalizePaymentStatus(opts.payment_status, draft.payment_status || 'paid');
  await activeSupplier(client, draft.supplier_id);
  await assertInvoiceFree(client, draft.supplier_id, invoice, purchaseId);
  const lines = await client.query(
    `SELECT medicine_id, batch_number, manufacturing_date, expiry_date, quantity, purchase_price FROM purchase_items WHERE purchase_id = $1 ORDER BY id`,
    [purchaseId]
  );
  const items = normalizePurchaseItems(lines.rows);
  const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
  const { date: today } = await businessNow(client);
  const stock = await receiveIntoStock(client, { purchaseId, orderNumber: draft.order_number, invoice, supplierId: draft.supplier_id, items, insertLines: false, today, deviceId }, actor);
  await client.query(
    `UPDATE purchases SET status = 'received', received_date = $2, invoice_number = $3, payment_status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [purchaseId, today, invoice, paymentStatus]
  );
  await recordAuditLog(
    {
      user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: deviceId,
      action: 'PURCHASE_GOODS_RECEIVED', entity: 'purchase', entity_id: purchaseId,
      previous_value: { status: PURCHASE_DRAFT },
      new_value: { status: 'received', order_number: draft.order_number, invoice_number: invoice, lines: items.length, total: Number(draft.total_amount), ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'PURCHASE_RECEIVED', entity_type: 'purchase', entity_id: purchaseId, operation: 'RECEIVE',
    data: () => purchaseEventData(client, purchaseId, draft.supplier_id, extra), actor, device_id: deviceId, business_ref: invoice,
  });
  return { success: true, purchase: await readPurchase(client, purchaseId), ...stock };
}

/** Cancels a PENDING purchase. A received purchase is never cancelled or deleted. */
export async function cancelPurchaseTx(client: pg.PoolClient, purchaseId: string, reasonRaw: unknown, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 1000) : '';
  if (reason.length < 3) throw new HttpError(400, 'A cancellation reason (at least 3 characters) is required.');
  const draft = await lockDraft(client, purchaseId, 'cancelled');
  await client.query(
    `UPDATE purchases SET status = 'cancelled', cancel_reason = $2, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [purchaseId, reason]
  );
  await recordAuditLog(
    {
      user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: actor.device_id,
      action: 'PURCHASE_CANCELLED', entity: 'purchase', entity_id: purchaseId,
      previous_value: { status: PURCHASE_DRAFT }, new_value: { status: 'cancelled', reason, order_number: draft.order_number, ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'PURCHASE_CANCELLED', entity_type: 'purchase', entity_id: purchaseId, operation: 'CANCEL',
    data: () => purchaseEventData(client, purchaseId, draft.supplier_id, extra), actor, business_ref: draft.order_number,
  });
  return readPurchase(client, purchaseId);
}
