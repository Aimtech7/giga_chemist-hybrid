import crypto from 'crypto';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow, type Queryable } from './client';
import { ensureDevice } from './devices';
import { recordAuditLog } from './audit';
import {
  deriveBatchStatus,
  insertMovement,
  reconcileMedicineStock,
  toBatchDto,
  toMedicineStockDto,
  type StockActor,
} from './inventory';
import type { Sale, PaginatedSalesResponse, PaymentMethod, PriceMode, UserRole } from '../../src/types';

// =============================================================================
// Money: all arithmetic in integer cents, converted only at the boundaries.
// =============================================================================
const toCents = (n: number) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;

export const CASHIER_MAX_DISCOUNT_PERCENT = 10;
export const ADMIN_MAX_DISCOUNT_PERCENT = 100;
const PAYMENT_METHODS: PaymentMethod[] = ['Cash', 'M-Pesa', 'Card', 'Bank', 'Mixed'];
const SPLIT_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;
const MPESA_REF = /^[A-Z0-9]{6,20}$/;
const PRICE_MODES: PriceMode[] = ['RETAIL', 'WHOLESALE'];

function requirePriceMode(value: unknown, field: string): PriceMode {
  if (value === undefined || value === null || value === '') return 'RETAIL';
  if (!PRICE_MODES.includes(value as PriceMode)) throw new HttpError(400, `${field} must be RETAIL or WHOLESALE.`);
  return value as PriceMode;
}

export interface SaleActor extends StockActor {
  role: UserRole;
}

// =============================================================================
// Reads
// =============================================================================
const SALE_COLUMNS = `
  s.id, s.branch_id, s.sale_number, s.receipt_number,
  s.cashier_id, u.name AS cashier_name,
  s.customer_id, c.name AS customer_name, c.phone AS customer_phone,
  s.device_id, s.date, s.time,
  COALESCE(s.subtotal, 0)::float AS subtotal,
  COALESCE(s.discount_percent, 0)::float AS discount_percent,
  COALESCE(s.discount_total, 0)::float AS discount_total,
  COALESCE(s.tax_total, 0)::float AS tax_total,
  COALESCE(s.total, 0)::float AS total,
  COALESCE(s.cost_total, 0)::float AS cost_total,
  COALESCE(s.gross_profit, 0)::float AS gross_profit,
  s.payment_method, s.payment_reference,
  COALESCE(s.amount_received, 0)::float AS amount_received,
  COALESCE(s.change_given, 0)::float AS change_given,
  s.status, s.void_reason, s.voided_by, s.idempotency_key, s.price_mode, s.created_at`;

async function hydrateSales(q: Queryable, rows: any[]): Promise<Sale[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [items, payments, returned] = await Promise.all([
    q.query(
      `SELECT si.id, si.sale_id, si.medicine_id, m.name AS medicine_name, m.generic_name,
              si.batch_id, si.batch_number, si.expiry_date,
              si.quantity::int AS quantity, si.unit_price::float AS unit_price, COALESCE(si.discount, 0)::float AS discount,
              si.cost_price_snapshot::float AS cost_price_snapshot, si.total::float AS total, si.price_mode
       FROM sale_items si LEFT JOIN medicines m ON si.medicine_id = m.id
       WHERE si.sale_id = ANY($1::uuid[])
       ORDER BY si.created_at, si.id`,
      [ids]
    ),
    q.query(
      `SELECT sale_id, method, amount::float AS amount, reference FROM payments
       WHERE sale_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [ids]
    ),
    q.query(
      `SELECT sale_id, medicine_id, batch_id, SUM(quantity)::int AS qty, SUM(refund_amount)::float AS refunded
       FROM returns WHERE sale_id = ANY($1::uuid[]) GROUP BY sale_id, medicine_id, batch_id`,
      [ids]
    ),
  ]);

  const itemsBySale = new Map<string, any[]>();
  for (const it of items.rows) {
    const list = itemsBySale.get(it.sale_id) || [];
    list.push({
      id: it.id,
      medicine_id: it.medicine_id,
      medicine_name: it.medicine_name || 'Pharmaceutical Item',
      generic_name: it.generic_name || '',
      batch_id: it.batch_id,
      batch_number: it.batch_number,
      expiry_date: it.expiry_date || '',
      quantity: Number(it.quantity) || 0,
      unit_price: Number(it.unit_price) || 0,
      discount: Number(it.discount) || 0,
      cost_price_snapshot: Number(it.cost_price_snapshot) || 0,
      total: Number(it.total) || 0,
      price_mode: it.price_mode || null,
    });
    itemsBySale.set(it.sale_id, list);
  }
  const paymentsBySale = new Map<string, any[]>();
  for (const p of payments.rows) {
    const list = paymentsBySale.get(p.sale_id) || [];
    list.push({ method: p.method, amount: Number(p.amount) || 0, reference: p.reference || undefined });
    paymentsBySale.set(p.sale_id, list);
  }
  const returnedBySale = new Map<string, { medicine_id: string; batch_id: string; quantity: number; refunded: number }[]>();
  for (const r of returned.rows) {
    const list = returnedBySale.get(r.sale_id) || [];
    list.push({ medicine_id: r.medicine_id, batch_id: r.batch_id, quantity: Number(r.qty) || 0, refunded: Number(r.refunded) || 0 });
    returnedBySale.set(r.sale_id, list);
  }

  return rows.map((r) => {
    const pays = paymentsBySale.get(r.id) || [];
    return {
      id: r.id,
      branch_id: r.branch_id || undefined,
      sale_number: r.sale_number,
      receipt_number: r.receipt_number,
      date: r.date || '',
      time: r.time || '',
      timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      cashier_id: r.cashier_id,
      cashier_name: r.cashier_name || 'Cashier',
      customer_id: r.customer_id || undefined,
      customer_name: r.customer_name || 'Walk-in',
      customer_phone: r.customer_phone || undefined,
      device_id: r.device_id,
      items: itemsBySale.get(r.id) || [],
      price_mode: r.price_mode || null,
      subtotal: Number(r.subtotal) || 0,
      discount_percent: Number(r.discount_percent) || 0,
      discount_total: Number(r.discount_total) || 0,
      tax_total: Number(r.tax_total) || 0,
      total: Number(r.total) || 0,
      cost_total: Number(r.cost_total) || 0,
      gross_profit: Number(r.gross_profit) || 0,
      payment_method: r.payment_method || 'Cash',
      payment_reference: r.payment_reference || undefined,
      amount_received: Number(r.amount_received) || 0,
      change_given: Number(r.change_given) || 0,
      split_payments: r.payment_method === 'Mixed' ? pays : undefined,
      status: r.status || 'completed',
      void_reason: r.void_reason || undefined,
      voided_by: r.voided_by || undefined,
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: r.idempotency_key,
      returned_items: returnedBySale.get(r.id) || [],
    } as Sale;
  });
}

export async function getSaleById(id: string, q: Queryable = pgPool): Promise<Sale | null> {
  const res = await q.query(
    `SELECT ${SALE_COLUMNS} FROM sales s
     LEFT JOIN users u ON s.cashier_id = u.id LEFT JOIN customers c ON s.customer_id = c.id
     WHERE s.id = $1`,
    [requireUuid(id, 'sale id')]
  );
  return (await hydrateSales(q, res.rows))[0] || null;
}

export interface SalesQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  cashierId?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function getAllSales(params?: SalesQueryParams): Promise<Sale[] | PaginatedSalesResponse> {
  const page = Math.max(1, Number(params?.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(params?.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: any[] = [];
  if (params?.search?.trim()) {
    values.push(`%${params.search.trim()}%`);
    conditions.push(`(s.receipt_number ILIKE $${values.length} OR s.sale_number ILIKE $${values.length} OR s.payment_reference ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
  }
  if (params?.startDate) {
    if (!DATE_RE.test(params.startDate)) throw new HttpError(400, 'startDate must be YYYY-MM-DD.');
    values.push(params.startDate);
    conditions.push(`s.date >= $${values.length}`);
  }
  if (params?.endDate) {
    if (!DATE_RE.test(params.endDate)) throw new HttpError(400, 'endDate must be YYYY-MM-DD.');
    values.push(params.endDate);
    conditions.push(`s.date <= $${values.length}`);
  }
  if (params?.cashierId) {
    values.push(requireUuid(params.cashierId, 'cashierId'));
    conditions.push(`s.cashier_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM sales s LEFT JOIN users u ON s.cashier_id = u.id LEFT JOIN customers c ON s.customer_id = c.id`;

  const count = await pgPool.query(`SELECT COUNT(*)::int AS n ${from} ${where}`, values);
  const rows = await pgPool.query(
    `SELECT ${SALE_COLUMNS} ${from} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset]
  );
  const sales = await hydrateSales(pgPool, rows.rows);
  if (params?.page || params?.limit) {
    const total = count.rows[0].n;
    return { sales, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }
  return sales;
}

// =============================================================================
// Checkout
// =============================================================================
export interface CheckoutItemInput {
  medicine_id: string;
  quantity: number;
  /** Price list for this line; defaults to the sale's price_mode. */
  price_mode?: PriceMode;
  /** WHOLESALE sale, medicine without a wholesale price: cashier confirmed selling at retail. */
  retail_fallback_confirmed?: boolean;
  /** The price the cashier saw. Never used for charging; a mismatch is rejected (409). */
  unit_price?: number;
}

export interface CheckoutPaymentInput {
  method: PaymentMethod;
  amount_received?: number;
  reference?: string;
  split?: { method: string; amount: number; reference?: string }[];
}

export interface CheckoutInput {
  idempotency_key: string;
  /** RETAIL (default) or WHOLESALE, chosen at the till. */
  price_mode?: PriceMode;
  items: CheckoutItemInput[];
  discount_percent?: number;
  customer_id?: string | null;
  payment: CheckoutPaymentInput;
}

export function validateDiscount(value: unknown, role: UserRole): number {
  if (value === undefined || value === null || value === '') return 0;
  const d = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(d)) throw new HttpError(400, 'Discount must be a number.');
  if (d < 0) throw new HttpError(400, 'Discount cannot be negative.');
  if (Math.round(d * 100) !== d * 100) throw new HttpError(400, 'Discount may have at most 2 decimal places.');
  const max = role === 'ADMIN' ? ADMIN_MAX_DISCOUNT_PERCENT : CASHIER_MAX_DISCOUNT_PERCENT;
  if (d > max) {
    throw new HttpError(400, role === 'ADMIN' ? `Discount cannot exceed ${max}%.` : `Cashier discount cannot exceed ${max}%.`);
  }
  return d;
}

type NormalizedItem = { medicine_id: string; quantity: number; unit_price?: number; price_mode: PriceMode; retail_fallback_confirmed: boolean };

function normalizeItems(items: unknown, saleMode: PriceMode): NormalizedItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'A sale must contain at least one item.');
  if (items.length > 200) throw new HttpError(400, 'Too many lines in one sale.');
  const merged = new Map<string, NormalizedItem>();
  for (const raw of items as any[]) {
    const id = requireUuid(raw?.medicine_id, 'medicine_id');
    const qty = Number(raw?.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new HttpError(400, 'Each quantity must be a whole number of at least 1.');
    const price = raw?.unit_price === undefined || raw?.unit_price === null ? undefined : Number(raw.unit_price);
    if (price !== undefined && !Number.isFinite(price)) throw new HttpError(400, 'unit_price must be a number.');
    const mode = raw?.price_mode === undefined ? saleMode : requirePriceMode(raw.price_mode, 'Item price_mode');
    if (saleMode === 'RETAIL' && mode === 'WHOLESALE') throw new HttpError(400, 'A RETAIL sale cannot contain wholesale-priced lines.');
    const fallback = raw?.retail_fallback_confirmed === true;
    const existing = merged.get(id);
    if (existing) {
      if (existing.price_mode !== mode) throw new HttpError(400, 'The same medicine appears with two different price modes.');
      existing.quantity += qty;
      if (price !== undefined && existing.unit_price !== undefined && toCents(price) !== toCents(existing.unit_price)) {
        throw new HttpError(400, 'The same medicine appears with two different prices.');
      }
    } else {
      merged.set(id, { medicine_id: id, quantity: qty, unit_price: price, price_mode: mode, retail_fallback_confirmed: fallback });
    }
  }
  return [...merged.values()];
}

interface PaymentPlan {
  method: PaymentMethod;
  reference: string | null;
  amountReceivedCents: number;
  changeCents: number;
  rows: { method: string; amountCents: number; reference: string | null }[];
}

function planPayment(payment: CheckoutPaymentInput | undefined, totalCents: number): PaymentPlan {
  const method = payment?.method;
  if (!method || !PAYMENT_METHODS.includes(method)) {
    throw new HttpError(400, `Payment method must be one of ${PAYMENT_METHODS.join(', ')}.`);
  }
  const ref = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase().slice(0, 100) : null);

  if (method === 'Cash') {
    const received = toCents(Number(payment!.amount_received));
    if (!Number.isFinite(received) || received < totalCents) {
      throw new HttpError(400, `Cash received must be at least the sale total (${fromCents(totalCents).toFixed(2)}).`);
    }
    return { method, reference: null, amountReceivedCents: received, changeCents: received - totalCents, rows: [{ method: 'Cash', amountCents: totalCents, reference: null }] };
  }

  if (method === 'Mixed') {
    const split = payment!.split;
    if (!Array.isArray(split) || split.length < 2) throw new HttpError(400, 'A split payment needs at least two parts.');
    const rows = split.map((p) => {
      if (!SPLIT_METHODS.includes(p?.method as any)) throw new HttpError(400, 'Split payment parts must be Cash, M-Pesa, Card or Bank.');
      const amountCents = toCents(Number(p.amount));
      if (!Number.isFinite(amountCents) || amountCents <= 0) throw new HttpError(400, 'Each split payment amount must be greater than zero.');
      const reference = ref(p.reference);
      if (p.method === 'M-Pesa' && (!reference || !MPESA_REF.test(reference))) {
        throw new HttpError(400, 'The M-Pesa part of a split payment needs a valid transaction code.');
      }
      return { method: p.method, amountCents, reference };
    });
    const sum = rows.reduce((s, r) => s + r.amountCents, 0);
    if (sum !== totalCents) {
      throw new HttpError(400, `Split payments (${fromCents(sum).toFixed(2)}) must equal the sale total (${fromCents(totalCents).toFixed(2)}).`);
    }
    return { method, reference: null, amountReceivedCents: totalCents, changeCents: 0, rows };
  }

  const reference = ref(payment!.reference);
  if (method === 'M-Pesa' && (!reference || !MPESA_REF.test(reference))) {
    throw new HttpError(400, 'A valid M-Pesa transaction code (6-20 letters/digits) is required.');
  }
  return { method, reference, amountReceivedCents: totalCents, changeCents: 0, rows: [{ method, amountCents: totalCents, reference }] };
}

/**
 * Completes a sale in ONE PostgreSQL transaction. The browser only says what to sell; the server
 * decides cashier (token), prices (medicines.selling_price), batches (FEFO, unexpired, active),
 * discount limits, totals and payment validity. Any failure rolls everything back.
 */
export async function checkoutSale(
  input: CheckoutInput,
  actor: SaleActor
): Promise<{ success: true; duplicate: boolean; sale: Sale; medicines: any[]; batches: any[] }> {
  const key = typeof input?.idempotency_key === 'string' ? input.idempotency_key.trim() : '';
  if (key.length < 8 || key.length > 255) throw new HttpError(400, 'idempotency_key (8-255 characters) is required.');
  const saleMode = requirePriceMode(input?.price_mode, 'price_mode');
  const items = normalizeItems(input?.items, saleMode);
  const discountPct = validateDiscount(input?.discount_percent, actor.role);
  const customerId = input?.customer_id ? requireUuid(input.customer_id, 'customer_id') : null;

  return withTransaction(async (client) => {
    // Serialize retries of the same checkout, then return the original sale if it already committed.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const existing = await client.query('SELECT id, cashier_id FROM sales WHERE idempotency_key = $1', [key]);
    if (existing.rows[0]) {
      if (existing.rows[0].cashier_id !== actor.user_id) throw new HttpError(409, 'This idempotency key belongs to another sale.');
      const sale = (await getSaleById(existing.rows[0].id, client))!;
      return { success: true as const, duplicate: true, sale, medicines: [], batches: [] };
    }

    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    const { date: today, time: nowTime } = await businessNow(client);

    if (customerId) {
      const cust = await client.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
      if (!cust.rows[0]) throw new HttpError(400, 'Customer not found.');
    }

    // Lock medicines in a stable order (prevents deadlocks between concurrent checkouts).
    const ids = items.map((i) => i.medicine_id).sort();
    const medRes = await client.query(
      `SELECT id, name, status, selling_price::float AS selling_price, wholesale_price::float AS wholesale_price,
              purchase_price::float AS purchase_price
       FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids]
    );
    const meds = new Map(medRes.rows.map((m) => [m.id, m]));

    type Alloc = { medicine_id: string; batch: any; quantity: number; priceCents: number; costCents: number; priceMode: PriceMode };
    const allocations: Alloc[] = [];
    const priceChanges: { medicine_id: string; name: string; expected: number; current: number; price_mode: PriceMode }[] = [];
    const missingWholesale: { medicine_id: string; name: string; retail_price: number }[] = [];

    for (const item of [...items].sort((a, b) => a.medicine_id.localeCompare(b.medicine_id))) {
      const med = meds.get(item.medicine_id);
      if (!med) throw new HttpError(404, `Medicine ${item.medicine_id} not found.`);
      if (med.status !== 'active') throw new HttpError(409, `${med.name} is not active and cannot be sold.`);
      // The price always comes from PostgreSQL, from the price list this line uses.
      const hasWholesale = med.wholesale_price != null && Number(med.wholesale_price) > 0;
      if (item.price_mode === 'WHOLESALE' && !hasWholesale) {
        missingWholesale.push({ medicine_id: med.id, name: med.name, retail_price: med.selling_price });
        continue;
      }
      if (saleMode === 'WHOLESALE' && item.price_mode === 'RETAIL') {
        if (hasWholesale) throw new HttpError(400, `${med.name} has a wholesale price; a wholesale sale must use it.`);
        if (!item.retail_fallback_confirmed) {
          missingWholesale.push({ medicine_id: med.id, name: med.name, retail_price: med.selling_price });
          continue;
        }
      }
      const unitPrice = item.price_mode === 'WHOLESALE' ? Number(med.wholesale_price) : med.selling_price;
      const priceCents = toCents(unitPrice);
      if (priceCents <= 0) throw new HttpError(409, `${med.name} has no valid ${item.price_mode.toLowerCase()} price.`);
      if (item.unit_price !== undefined && toCents(item.unit_price) !== priceCents) {
        priceChanges.push({ medicine_id: med.id, name: med.name, expected: item.unit_price, current: unitPrice, price_mode: item.price_mode });
        continue;
      }

      // FEFO over sellable stock: active, quantity > 0, not expired (expires ON its date). Unknown expiry last.
      const batches = await client.query(
        `SELECT * FROM medicine_batches
         WHERE medicine_id = $1 AND status = 'active' AND quantity_available > 0
           AND (expiry_date IS NULL OR expiry_date > $2::date)
         ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
         FOR UPDATE`,
        [med.id, today]
      );
      const sellable = batches.rows.reduce((s, b) => s + Number(b.quantity_available), 0);
      if (sellable < item.quantity) {
        const expired = await client.query(
          `SELECT COALESCE(SUM(quantity_available), 0)::int AS qty FROM medicine_batches
           WHERE medicine_id = $1 AND quantity_available > 0 AND expiry_date IS NOT NULL AND expiry_date <= $2::date`,
          [med.id, today]
        );
        const expiredQty = Number(expired.rows[0].qty) || 0;
        throw new HttpError(
          409,
          `Insufficient sellable stock for ${med.name}: requested ${item.quantity}, available ${sellable}` +
            (expiredQty > 0 ? ` (${expiredQty} more units are EXPIRED and cannot be sold).` : '.')
        );
      }
      let remaining = item.quantity;
      for (const b of batches.rows) {
        if (remaining === 0) break;
        const take = Math.min(remaining, Number(b.quantity_available));
        const cost = Number(b.purchase_price) > 0 ? Number(b.purchase_price) : Number(med.purchase_price) || 0;
        allocations.push({ medicine_id: med.id, batch: b, quantity: take, priceCents, costCents: toCents(cost), priceMode: item.price_mode });
        remaining -= take;
      }
    }

    if (missingWholesale.length > 0) {
      throw Object.assign(
        new HttpError(
          409,
          `No wholesale price is set for ${missingWholesale.map((m) => m.name).join(', ')}. ` +
            'Confirm selling at the retail price, or ask an Administrator to set a wholesale price.'
        ),
        { code: 'WHOLESALE_PRICE_MISSING', details: missingWholesale }
      );
    }

    if (priceChanges.length > 0) {
      throw Object.assign(
        new HttpError(409, `Price changed for ${priceChanges.map((p) => p.name).join(', ')}. Refresh the cart and confirm the current price.`),
        { code: 'PRICE_CHANGED', details: priceChanges }
      );
    }

    // Per-line discount derived from the single sale-level percentage, so line totals always add
    // up exactly to the sale total that is charged.
    let subtotalCents = 0;
    let discountCents = 0;
    let costCents = 0;
    const lines = allocations.map((a) => {
      const lineSubtotal = a.priceCents * a.quantity;
      const lineDiscount = Math.round((lineSubtotal * discountPct) / 100);
      subtotalCents += lineSubtotal;
      discountCents += lineDiscount;
      costCents += a.costCents * a.quantity;
      return { ...a, lineSubtotal, lineDiscount, lineTotal: lineSubtotal - lineDiscount };
    });
    const netCents = subtotalCents - discountCents;

    const settings = await client.query('SELECT tax_enabled, tax_rate::float AS tax_rate FROM settings ORDER BY updated_at DESC NULLS LAST LIMIT 1');
    const tax = settings.rows[0];
    const taxCents = tax?.tax_enabled ? Math.round((netCents * (Number(tax.tax_rate) || 0)) / 100) : 0;
    const totalCents = netCents + taxCents;
    const payment = planPayment(input?.payment, totalCents);

    const seq = await client.query(`SELECT nextval('sale_receipt_seq') AS n`);
    const serial = String(seq.rows[0].n).padStart(6, '0');
    const ymd = today.replace(/-/g, '');
    const saleId = crypto.randomUUID();
    const receiptNumber = `RCP-${ymd}-${serial}`;

    await client.query(
      `INSERT INTO sales (
         id, sale_number, receipt_number, cashier_id, customer_id, device_id, date, time,
         subtotal, discount_percent, discount_total, tax_total, total, cost_total, gross_profit,
         payment_method, payment_reference, amount_received, change_given, status, idempotency_key, sync_status, price_mode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'completed',$20,'synced',$21)`,
      [
        saleId, `SALE-${ymd}-${serial}`, receiptNumber, actor.user_id, customerId, deviceId, today, nowTime,
        fromCents(subtotalCents), discountPct, fromCents(discountCents), fromCents(taxCents), fromCents(totalCents),
        fromCents(costCents), fromCents(netCents - costCents),
        payment.method, payment.reference, fromCents(payment.amountReceivedCents), fromCents(payment.changeCents), key,
        saleMode,
      ]
    );

    const touchedBatches = new Map<string, any>();
    for (const l of lines) {
      await client.query(
        `INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, expiry_date,
           quantity, unit_price, discount, cost_price_snapshot, total, price_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          crypto.randomUUID(), saleId, l.medicine_id, l.batch.id, l.batch.batch_number, l.batch.expiry_date,
          l.quantity, fromCents(l.priceCents), fromCents(l.lineDiscount), fromCents(l.costCents), fromCents(l.lineTotal),
          l.priceMode,
        ]
      );
      const prev = Number(l.batch.quantity_available);
      const next = prev - l.quantity;
      const upd = await client.query(
        `UPDATE medicine_batches SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [next, deriveBatchStatus(next, l.batch.expiry_date, l.batch.status), l.batch.id]
      );
      l.batch.quantity_available = next;
      touchedBatches.set(l.batch.id, upd.rows[0]);
      await insertMovement(
        client,
        {
          medicine_id: l.medicine_id,
          batch_id: l.batch.id,
          previous_quantity: prev,
          new_quantity: next,
          movement_type: 'SALE',
          reason: 'SALE',
          reference_id: receiptNumber,
          notes: `Sold on receipt ${receiptNumber}`,
        },
        actor,
        deviceId
      );
    }

    for (const p of payment.rows) {
      await client.query(
        `INSERT INTO payments (id, sale_id, method, amount, reference) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), saleId, p.method, fromCents(p.amountCents), p.reference]
      );
    }

    if (customerId) {
      await client.query(
        `UPDATE customers SET total_spent = COALESCE(total_spent, 0) + $1, last_visit = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [fromCents(totalCents), customerId]
      );
    }

    const medicines = [];
    for (const id of ids) medicines.push(toMedicineStockDto(await reconcileMedicineStock(client, id)));

    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'SALE_COMPLETED',
        entity: 'sale',
        entity_id: saleId,
        new_value: {
          receipt_number: receiptNumber,
          price_mode: saleMode,
          subtotal: fromCents(subtotalCents),
          discount_percent: discountPct,
          discount_total: fromCents(discountCents),
          tax_total: fromCents(taxCents),
          total: fromCents(totalCents),
          payment_method: payment.method,
          lines: lines.length,
        },
      },
      client
    );

    const sale = (await getSaleById(saleId, client))!;
    return {
      success: true as const,
      duplicate: false,
      sale,
      medicines,
      batches: [...touchedBatches.values()].map((b) => toBatchDto(b)),
    };
  });
}

// =============================================================================
// Void (explicit reversal; never re-runs checkout, never deletes history)
// =============================================================================
export async function voidSale(saleIdRaw: string, reasonRaw: unknown, actor: SaleActor) {
  const saleId = requireUuid(saleIdRaw, 'sale id');
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 1000) : '';
  if (!reason) throw new HttpError(400, 'A void reason is required.');

  return withTransaction(async (client) => {
    const found = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    const sale = found.rows[0];
    if (!sale) throw new HttpError(404, 'Sale not found.');
    if (sale.status === 'voided') throw new HttpError(409, 'This sale is already voided.');
    if (sale.status !== 'completed') throw new HttpError(409, `A sale with status "${sale.status}" cannot be voided.`);
    if (String(sale.idempotency_key).startsWith('LEGACY-')) {
      throw new HttpError(409, 'Imported legacy sales cannot be voided. Record a return instead.');
    }
    const hasReturns = await client.query('SELECT 1 FROM returns WHERE sale_id = $1 LIMIT 1', [saleId]);
    if (hasReturns.rows[0]) throw new HttpError(409, 'This sale already has returns; process the remaining items as returns instead of a void.');

    const deviceId = await ensureDevice(client, actor.device_id, actor.user_id);
    const items = await client.query(
      'SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY batch_id, id',
      [saleId]
    );

    const touched = new Map<string, any>();
    const medicineIds = new Set<string>();
    for (const it of items.rows) {
      const qty = Number(it.quantity);
      if (qty <= 0) continue;
      const b = await client.query('SELECT * FROM medicine_batches WHERE id = $1 FOR UPDATE', [it.batch_id]);
      const batch = b.rows[0];
      if (!batch) throw new HttpError(409, `Batch ${it.batch_number} of this sale no longer exists.`);
      const prev = Number(batch.quantity_available);
      const next = prev + qty;
      // Status re-derived: stock returned to an expired batch stays quarantined (not sellable).
      const status = deriveBatchStatus(next, batch.expiry_date, batch.status === 'exhausted' ? 'active' : batch.status);
      const upd = await client.query(
        'UPDATE medicine_batches SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [next, status, batch.id]
      );
      touched.set(batch.id, upd.rows[0]);
      medicineIds.add(it.medicine_id);
      await insertMovement(
        client,
        {
          medicine_id: it.medicine_id,
          batch_id: batch.id,
          previous_quantity: prev,
          new_quantity: next,
          movement_type: 'VOID_REVERSAL',
          reason: 'SALE_VOID',
          reference_id: sale.receipt_number,
          notes: `Void of receipt ${sale.receipt_number}: ${reason}`.slice(0, 1000),
        },
        actor,
        deviceId
      );
    }

    await client.query(
      `UPDATE sales SET status = 'voided', void_reason = $1, voided_by = $2 WHERE id = $3`,
      [reason, actor.user_id, saleId]
    );
    if (sale.customer_id) {
      await client.query(
        'UPDATE customers SET total_spent = GREATEST(0, COALESCE(total_spent, 0) - $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [sale.total, sale.customer_id]
      );
    }
    const medicines = [];
    for (const id of medicineIds) medicines.push(toMedicineStockDto(await reconcileMedicineStock(client, id)));

    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: deviceId,
        action: 'SALE_VOIDED',
        entity: 'sale',
        entity_id: saleId,
        previous_value: { status: sale.status, total: Number(sale.total) },
        new_value: { status: 'voided', void_reason: reason, receipt_number: sale.receipt_number },
      },
      client
    );

    return {
      success: true,
      sale: (await getSaleById(saleId, client))!,
      medicines,
      batches: [...touched.values()].map((b) => toBatchDto(b)),
    };
  });
}

// =============================================================================
// Daily summary (PostgreSQL aggregation, Africa/Nairobi business day)
// =============================================================================
export interface TodaySalesSummary {
  date: string;
  scope: 'cashier' | 'all';
  totalSales: number;
  cashTotal: number;
  mpesaTotal: number;
  otherTotal: number;
  transactionCount: number;
  discountTotal: number;
  refundsTotal: number;
  netSales: number;
  voidedCount: number;
  /** Gross profit of today's non-voided sales (ADMIN only; removed for Cashiers by the route). */
  grossProfit?: number;
}

/**
 * totalSales = final (discounted) totals of today's non-voided sales. Cash/M-Pesa come from the
 * payments table (split payments counted per part). Refunds are reported separately and netSales
 * = totalSales - refundsTotal. Day boundaries are Africa/Nairobi via PostgreSQL.
 */
export async function getTodaySalesSummary(options: { cashierId?: string }): Promise<TodaySalesSummary> {
  const cashierId = options.cashierId ? requireUuid(options.cashierId, 'cashierId') : null;
  const { date: today } = await businessNow();
  const params: any[] = [today];
  const cashierFilter = cashierId ? (params.push(cashierId), `AND s.cashier_id = $2`) : '';

  const totals = await pgPool.query(
    `SELECT COALESCE(SUM(s.total) FILTER (WHERE s.status <> 'voided'), 0)::numeric AS total_sales,
            COALESCE(SUM(s.discount_total) FILTER (WHERE s.status <> 'voided'), 0)::numeric AS discount_total,
            COALESCE(SUM(s.gross_profit) FILTER (WHERE s.status <> 'voided'), 0)::numeric AS gross_profit,
            COUNT(*) FILTER (WHERE s.status <> 'voided')::int AS txn,
            COUNT(*) FILTER (WHERE s.status = 'voided')::int AS voided
     FROM sales s WHERE s.date = $1::date ${cashierFilter}`,
    params
  );
  const pays = await pgPool.query(
    `SELECT p.method, COALESCE(SUM(p.amount), 0)::numeric AS amount
     FROM payments p JOIN sales s ON p.sale_id = s.id
     WHERE s.date = $1::date AND s.status <> 'voided' ${cashierFilter}
     GROUP BY p.method`,
    params
  );
  const refundFilter = cashierId ? `AND r.user_id = $2` : '';
  const refunds = await pgPool.query(
    `SELECT COALESCE(SUM(r.refund_amount), 0)::numeric AS refunds
     FROM returns r WHERE (r.created_at AT TIME ZONE 'Africa/Nairobi')::date = $1::date ${refundFilter}`,
    params
  );

  let cash = 0;
  let mpesa = 0;
  let other = 0;
  for (const row of pays.rows) {
    const cents = toCents(row.amount);
    const m = String(row.method || '').toLowerCase().replace(/[\s_-]/g, '');
    if (m === 'cash') cash += cents;
    else if (m === 'mpesa') mpesa += cents;
    else other += cents;
  }
  const totalSales = toCents(totals.rows[0].total_sales);
  const refundCents = toCents(refunds.rows[0].refunds);
  return {
    date: today,
    scope: cashierId ? 'cashier' : 'all',
    totalSales: fromCents(totalSales),
    cashTotal: fromCents(cash),
    mpesaTotal: fromCents(mpesa),
    otherTotal: fromCents(other),
    transactionCount: Number(totals.rows[0].txn) || 0,
    discountTotal: fromCents(toCents(totals.rows[0].discount_total)),
    refundsTotal: fromCents(refundCents),
    netSales: fromCents(totalSales - refundCents),
    voidedCount: Number(totals.rows[0].voided) || 0,
    grossProfit: fromCents(toCents(totals.rows[0].gross_profit)),
  };
}

