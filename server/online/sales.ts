import crypto from 'crypto';
import type pg from 'pg';
import { HttpError, requireUuid, isValidUuid } from '../db/client';
import type { Sale, UserRole, PriceMode, PaymentMethod, SplitPayment } from '../../src/types';

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

export interface OnlineCheckoutItemInput {
  medicine_id: string;
  quantity: number;
  unit_price?: number;
  price_mode?: PriceMode;
  retail_fallback_confirmed?: boolean;
}

export interface OnlineCheckoutPaymentInput {
  method: PaymentMethod;
  amount_received?: number;
  reference?: string;
  split?: { method: string; amount: number; reference?: string }[];
}

export interface OnlineCheckoutInput {
  idempotency_key: string;
  price_mode?: PriceMode;
  items: OnlineCheckoutItemInput[];
  discount_percent?: number;
  customer_id?: string | null;
  payment: OnlineCheckoutPaymentInput;
}

type NormalizedItem = {
  medicine_id: string;
  quantity: number;
  unit_price?: number;
  price_mode: PriceMode;
  retail_fallback_confirmed: boolean;
};

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

function planPayment(payment: OnlineCheckoutPaymentInput | undefined, totalCents: number): PaymentPlan {
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
    return {
      method,
      reference: null,
      amountReceivedCents: received,
      changeCents: received - totalCents,
      rows: [{ method: 'Cash', amountCents: totalCents, reference: null }],
    };
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

export interface OnlineUserContext {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  local_user_id: string | null;
  shop_id: string | null;
}

export async function hydrateOnlineSale(client: pg.PoolClient, shopId: string, saleRow: any, isCashier: boolean): Promise<Sale> {
  const [sale] = await hydrateOnlineSalesList(client, shopId, [saleRow], isCashier);
  return sale;
}

export async function hydrateOnlineSalesList(
  client: pg.PoolClient,
  shopId: string,
  saleRows: any[],
  isCashier: boolean
): Promise<Sale[]> {
  if (saleRows.length === 0) return [];
  const saleIds = saleRows.map((r) => r.sale_id || r.id);

  const itemsRes = await client.query(
    `SELECT si.sale_item_id AS id, si.sale_id, si.medicine_id, m.name AS medicine_name, (m.data->>'generic_name')::text AS generic_name,
            si.batch_id, si.batch_number, (si.data->>'expiry_date')::text AS expiry_date,
            si.quantity, si.unit_price::float AS unit_price, si.discount::float AS discount,
            si.cost_price_snapshot::float AS cost_price_snapshot, si.total::float AS total, si.price_mode
     FROM giga_cloud.sale_items si
     LEFT JOIN giga_cloud.medicines m ON m.shop_id = si.shop_id AND m.medicine_id = si.medicine_id
     WHERE si.shop_id = $1 AND si.sale_id = ANY($2::uuid[])
     ORDER BY si.sale_item_id`,
    [shopId, saleIds]
  );

  const paymentsRes = await client.query(
    `SELECT sale_id, method, amount::float AS amount, reference
     FROM giga_cloud.payments
     WHERE shop_id = $1 AND sale_id = ANY($2::uuid[])
     ORDER BY payment_id`,
    [shopId, saleIds]
  );

  const customerIds = [...new Set(saleRows.map((r) => r.customer_id).filter(Boolean))];
  const customerMap = new Map<string, { name: string; phone: string }>();
  if (customerIds.length > 0) {
    const custRes = await client.query(
      'SELECT customer_id, name, phone FROM giga_cloud.customers WHERE shop_id = $1 AND customer_id = ANY($2::uuid[])',
      [shopId, customerIds]
    );
    for (const c of custRes.rows) {
      customerMap.set(c.customer_id, { name: c.name, phone: c.phone });
    }
  }

  const itemsBySale = new Map<string, any[]>();
  for (const it of itemsRes.rows) {
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
      cost_price_snapshot: isCashier ? 0 : Number(it.cost_price_snapshot) || 0,
      total: Number(it.total) || 0,
      price_mode: it.price_mode || null,
    });
    itemsBySale.set(it.sale_id, list);
  }

  const paymentsBySale = new Map<string, any[]>();
  for (const p of paymentsRes.rows) {
    const list = paymentsBySale.get(p.sale_id) || [];
    list.push({
      method: p.method as SplitPayment['method'],
      amount: Number(p.amount) || 0,
      reference: p.reference || undefined,
    });
    paymentsBySale.set(p.sale_id, list);
  }

  return saleRows.map((saleRow) => {
    const saleId = saleRow.sale_id || saleRow.id;
    const items = itemsBySale.get(saleId) || [];
    const payments = paymentsBySale.get(saleId) || [];
    const cust = saleRow.customer_id ? customerMap.get(saleRow.customer_id) : null;
    const d = saleRow.data || {};
    const businessDate = saleRow.business_date ? new Date(saleRow.business_date).toISOString().slice(0, 10) : (d.date || '');

    return {
      id: saleId,
      branch_id: d.branch_id || undefined,
      sale_number: saleRow.sale_number,
      receipt_number: saleRow.receipt_number,
      date: businessDate,
      time: saleRow.business_time || d.time || '',
      timestamp: saleRow.created_at_local ? new Date(saleRow.created_at_local).getTime() : Date.now(),
      cashier_id: saleRow.cashier_id,
      cashier_name: saleRow.cashier_name || 'Cashier',
      customer_id: saleRow.customer_id || undefined,
      customer_name: cust?.name || d.customer_name || 'Walk-in',
      customer_phone: cust?.phone || d.customer_phone || undefined,
      device_id: saleRow.device_id || 'ONLINE_POS',
      items,
      price_mode: saleRow.price_mode || null,
      subtotal: Number(saleRow.subtotal) || 0,
      discount_percent: Number(d.discount_percent || 0),
      discount_total: Number(saleRow.discount_total) || 0,
      tax_total: Number(saleRow.tax_total) || 0,
      total: Number(saleRow.total) || 0,
      cost_total: isCashier ? 0 : Number(saleRow.cost_total) || 0,
      gross_profit: isCashier ? 0 : Number(saleRow.gross_profit) || 0,
      payment_method: saleRow.payment_method || 'Cash',
      payment_reference: d.payment_reference || undefined,
      amount_received: Number(d.amount_received || saleRow.total) || 0,
      change_given: Number(d.change_given || 0),
      split_payments: saleRow.payment_method === 'Mixed' ? payments : undefined,
      status: saleRow.status || 'completed',
      void_reason: saleRow.void_reason || undefined,
      voided_by: saleRow.voided_by || undefined,
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: saleRow.local_idempotency_key || d.idempotency_key,
      returned_items: [],
    };
  });
}

export interface OnlineSalesParams {
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  cashierId?: string;
  paymentMethod?: string;
  customerId?: string;
  priceMode?: string;
  status?: string;
}

export async function getOnlineSales(
  client: pg.PoolClient,
  shopId: string,
  params: OnlineSalesParams,
  isCashier: boolean
): Promise<{ sales: Sale[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(params.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions: string[] = ['s.shop_id = $1'];
  const values: any[] = [shopId];

  if (params.search?.trim()) {
    values.push(`%${params.search.trim()}%`);
    conditions.push(
      `(s.receipt_number ILIKE $${values.length} OR s.sale_number ILIKE $${values.length} OR s.cashier_name ILIKE $${values.length} OR (s.data->>'customer_name') ILIKE $${values.length})`
    );
  }
  if (params.startDate) {
    values.push(params.startDate);
    conditions.push(`s.business_date >= $${values.length}`);
  }
  if (params.endDate) {
    values.push(params.endDate);
    conditions.push(`s.business_date <= $${values.length}`);
  }
  if (params.cashierId) {
    values.push(params.cashierId);
    conditions.push(`s.cashier_id = $${values.length}`);
  }
  if (params.paymentMethod) {
    values.push(params.paymentMethod);
    conditions.push(
      `(s.payment_method = $${values.length} OR EXISTS (SELECT 1 FROM giga_cloud.payments px WHERE px.shop_id = s.shop_id AND px.sale_id = s.sale_id AND px.method = $${values.length}))`
    );
  }
  if (params.customerId) {
    values.push(params.customerId);
    conditions.push(`s.customer_id = $${values.length}`);
  }
  if (params.priceMode) {
    values.push(params.priceMode);
    conditions.push(`COALESCE(s.price_mode, 'RETAIL') = $${values.length}`);
  }
  if (params.status) {
    if (params.status === 'not_voided') {
      conditions.push(`s.status <> 'voided'`);
    } else {
      values.push(params.status);
      conditions.push(`s.status = $${values.length}`);
    }
  }

  const where = conditions.join(' AND ');
  const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM giga_cloud.sales s WHERE ${where}`, values);
  const total = countRes.rows[0]?.n || 0;

  const rowsRes = await client.query(
    `SELECT s.* FROM giga_cloud.sales s WHERE ${where} ORDER BY s.created_at_local DESC, s.sale_id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset]
  );

  const sales = await hydrateOnlineSalesList(client, shopId, rowsRes.rows, isCashier);

  return {
    sales,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/**
 * Executes an atomic online sale transaction against Supabase (giga_cloud schema).
 */
export async function executeOnlineSaleCheckout(
  client: pg.PoolClient,
  shopId: string,
  input: OnlineCheckoutInput,
  user: OnlineUserContext
): Promise<{ success: true; duplicate: boolean; sale: Sale; medicines: any[]; batches: any[] }> {
  const key = typeof input?.idempotency_key === 'string' ? input.idempotency_key.trim() : '';
  if (key.length < 8 || key.length > 255) throw new HttpError(400, 'idempotency_key (8-255 characters) is required.');
  const saleMode = requirePriceMode(input?.price_mode, 'price_mode');
  const items = normalizeItems(input?.items, saleMode);
  const discountPct = validateDiscount(input?.discount_percent, user.role);
  const customerId = input?.customer_id ? requireUuid(input.customer_id, 'customer_id') : null;
  const isCashier = user.role === 'CASHIER';
  const cashierId = user.local_user_id || user.id;

  // 1. Transaction Advisory Lock on shop + idempotency key
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${shopId}:${key}`]);

  // 2. Check for duplicate sale
  const existing = await client.query(
    'SELECT * FROM giga_cloud.sales WHERE shop_id = $1 AND local_idempotency_key = $2',
    [shopId, key]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.cashier_id !== cashierId && row.cashier_id !== user.id) {
      throw new HttpError(409, 'This idempotency key belongs to another sale.');
    }
    const sale = await hydrateOnlineSale(client, shopId, row, isCashier);
    return { success: true as const, duplicate: true, sale, medicines: [], batches: [] };
  }

  // 3. Customer existence check
  let customerName = 'Walk-in';
  let customerPhone: string | undefined = undefined;
  if (customerId) {
    const cust = await client.query('SELECT name, phone FROM giga_cloud.customers WHERE shop_id = $1 AND customer_id = $2', [shopId, customerId]);
    if (!cust.rows[0]) throw new HttpError(400, 'Customer not found.');
    customerName = cust.rows[0].name || customerName;
    customerPhone = cust.rows[0].phone || undefined;
  }

  // 4. Check for open shift
  const openShift = await client.query(
    `SELECT shift_id FROM giga_cloud.cashier_shifts WHERE shop_id = $1 AND cashier_id = $2 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`,
    [shopId, cashierId]
  );
  const shiftId = openShift.rows[0]?.shift_id || null;

  // 5. Lock medicines deterministically
  const ids = items.map((i) => i.medicine_id).sort();
  const medRes = await client.query(
    `SELECT medicine_id AS id, name, status, selling_price::float AS selling_price,
            wholesale_price::float AS wholesale_price, purchase_price::float AS purchase_price,
            stock_version
     FROM giga_cloud.medicines
     WHERE shop_id = $1 AND medicine_id = ANY($2::uuid[])
     ORDER BY medicine_id
     FOR UPDATE`,
    [shopId, ids]
  );
  const meds = new Map(medRes.rows.map((m) => [m.id, m]));

  type Alloc = { medicine_id: string; batch: any; quantity: number; priceCents: number; costCents: number; priceMode: PriceMode };
  const allocations: Alloc[] = [];
  const priceChanges: { medicine_id: string; name: string; expected: number; current: number; price_mode: PriceMode }[] = [];
  const missingWholesale: { medicine_id: string; name: string; retail_price: number }[] = [];

  const todayStr = new Date().toISOString().slice(0, 10);

  // 6. Validate each item & allocate batches in FEFO order
  for (const item of [...items].sort((a, b) => a.medicine_id.localeCompare(b.medicine_id))) {
    const med = meds.get(item.medicine_id);
    if (!med) throw new HttpError(404, `Medicine ${item.medicine_id} not found in this shop.`);
    if (med.status !== 'active') throw new HttpError(409, `${med.name} is not active and cannot be sold.`);

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

    // FEFO over active batches and lock stock_levels rows
    const batchRes = await client.query(
      `SELECT b.batch_id AS id, b.medicine_id, b.batch_number, b.expiry_date, b.status,
              COALESCE((b.data->>'purchase_price')::numeric, 0) AS purchase_price,
              s.has_baseline, s.baseline_quantity, s.delta_since_baseline, s.last_reported_quantity,
              s.stock_version,
              CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE COALESCE(s.last_reported_quantity, 0) END::int AS quantity_available
       FROM giga_cloud.medicine_batches b
       JOIN giga_cloud.stock_levels s ON s.shop_id = b.shop_id AND s.batch_id = b.batch_id
       WHERE b.shop_id = $1
         AND b.medicine_id = $2
         AND b.status = 'active'
         AND (b.expiry_date IS NULL OR b.expiry_date > $3::date)
       ORDER BY b.expiry_date ASC NULLS LAST, b.updated_at ASC, b.batch_id ASC
       FOR UPDATE OF s`,
      [shopId, med.id, todayStr]
    );

    const sellable = batchRes.rows.reduce((s, b) => s + Number(b.quantity_available), 0);
    if (sellable < item.quantity) {
      throw new HttpError(
        409,
        `Insufficient sellable stock for ${med.name}: requested ${item.quantity}, available ${sellable}.`
      );
    }

    let remaining = item.quantity;
    for (const b of batchRes.rows) {
      if (remaining === 0) break;
      const avail = Number(b.quantity_available);
      if (avail <= 0) continue;
      const take = Math.min(remaining, avail);
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

  // 7. Calculate totals
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

  const settingsRes = await client.query('SELECT data FROM giga_cloud.shop_settings WHERE shop_id = $1', [shopId]);
  const sData = settingsRes.rows[0]?.data;
  const taxCents = sData?.tax_enabled ? Math.round((netCents * (Number(sData.tax_rate) || 0)) / 100) : 0;
  const totalCents = netCents + taxCents;
  const payment = planPayment(input?.payment, totalCents);

  // 8. Generate sequence number & receipt number
  const ymd = todayStr.replace(/-/g, '');
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);

  const seqRes = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM '[0-9]+$')::bigint), 0) + 1 AS n
     FROM giga_cloud.sales
     WHERE shop_id = $1 AND business_date = $2::date`,
    [shopId, todayStr]
  );
  const serial = String(seqRes.rows[0].n).padStart(6, '0');
  const saleId = crypto.randomUUID();
  const saleNumber = `SALE-${ymd}-${serial}`;
  const receiptNumber = `RCP-${ymd}-${serial}`;

  const cashierName = user.name || 'Cashier';

  // 9. Full Sale JSON representation
  const saleData = {
    id: saleId,
    sale_number: saleNumber,
    receipt_number: receiptNumber,
    cashier_id: cashierId,
    cashier_name: cashierName,
    customer_id: customerId,
    customer_name: customerName,
    customer_phone: customerPhone,
    device_id: 'ONLINE_POS',
    date: todayStr,
    time: timeStr,
    subtotal: fromCents(subtotalCents),
    discount_percent: discountPct,
    discount_total: fromCents(discountCents),
    tax_total: fromCents(taxCents),
    total: fromCents(totalCents),
    cost_total: fromCents(costCents),
    gross_profit: fromCents(netCents - costCents),
    payment_method: payment.method,
    payment_reference: payment.reference,
    amount_received: fromCents(payment.amountReceivedCents),
    change_given: fromCents(payment.changeCents),
    price_mode: saleMode,
    shift_id: shiftId,
    status: 'completed',
    idempotency_key: key,
    created_at: now.toISOString(),
  };

  // 10. Insert into giga_cloud.sales
  await client.query(
    `INSERT INTO giga_cloud.sales (
       shop_id, sale_id, sale_number, receipt_number, business_date, business_time,
       cashier_id, cashier_name, customer_id, device_id, price_mode, subtotal,
       discount_total, tax_total, total, cost_total, gross_profit, payment_method,
       status, local_idempotency_key, created_at_local, data, source_seq
     ) VALUES (
       $1, $2, $3, $4, $5::date, $6,
       $7, $8, $9, 'ONLINE_POS', $10, $11,
       $12, $13, $14, $15, $16, $17,
       'completed', $18, $19, $20, 0
     )`,
    [
      shopId, saleId, saleNumber, receiptNumber, todayStr, timeStr,
      cashierId, cashierName, customerId, saleMode, fromCents(subtotalCents),
      fromCents(discountCents), fromCents(taxCents), fromCents(totalCents), fromCents(costCents),
      fromCents(netCents - costCents), payment.method,
      key, now.toISOString(), JSON.stringify(saleData),
    ]
  );

  // 11. Insert sale items & deduct batch stock & record inventory movements
  const touchedBatches = new Map<string, any>();
  const returnBatches: any[] = [];

  for (const l of lines) {
    const saleItemId = crypto.randomUUID();
    const itemData = {
      id: saleItemId,
      sale_id: saleId,
      medicine_id: l.medicine_id,
      batch_id: l.batch.id,
      batch_number: l.batch.batch_number,
      expiry_date: l.batch.expiry_date,
      quantity: l.quantity,
      unit_price: fromCents(l.priceCents),
      discount: fromCents(l.lineDiscount),
      cost_price_snapshot: fromCents(l.costCents),
      total: fromCents(l.lineTotal),
      price_mode: l.priceMode,
      created_at: now.toISOString(),
    };

    await client.query(
      `INSERT INTO giga_cloud.sale_items (
         shop_id, sale_item_id, sale_id, medicine_id, batch_id, batch_number,
         quantity, unit_price, discount, cost_price_snapshot, total, price_mode, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        shopId, saleItemId, saleId, l.medicine_id, l.batch.id, l.batch.batch_number,
        l.quantity, fromCents(l.priceCents), fromCents(l.lineDiscount), fromCents(l.costCents),
        fromCents(l.lineTotal), l.priceMode, JSON.stringify(itemData),
      ]
    );

    const prev = Number(l.batch.quantity_available);
    const next = prev - l.quantity;

    // Update stock_levels
    await client.query(
      `UPDATE giga_cloud.stock_levels
       SET delta_since_baseline = delta_since_baseline - $1::int,
           last_reported_quantity = last_reported_quantity - $1::int,
           stock_version = stock_version + 1,
           last_movement_at = now()
       WHERE shop_id = $2 AND batch_id = $3`,
      [l.quantity, shopId, l.batch.id]
    );

    // Update medicine_batches
    await client.query(
      `UPDATE giga_cloud.medicine_batches
       SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{quantity_available}', to_jsonb($1::int)),
           updated_at = now()
       WHERE shop_id = $2 AND batch_id = $3`,
      [next, shopId, l.batch.id]
    );

    // Record movement
    const movementId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await client.query(
      `INSERT INTO giga_cloud.inventory_movements (
         shop_id, movement_id, event_id, local_seq, medicine_id, batch_id, movement_type, reason, delta,
         previous_quantity, new_quantity, reference_id, notes, user_id, device_id, occurred_at
       ) VALUES ($1, $2, $3, 0, $4, $5, 'SALE', 'SALE', $6, $7, $8, $9, $10, $11, 'ONLINE_POS', now())`,
      [
        shopId, movementId, eventId, l.medicine_id, l.batch.id, -l.quantity,
        prev, next, receiptNumber, `Sold on receipt ${receiptNumber}`, cashierId,
      ]
    );

    touchedBatches.set(l.batch.id, {
      id: l.batch.id,
      medicine_id: l.medicine_id,
      batch_number: l.batch.batch_number,
      quantity_available: next,
      status: l.batch.status,
      stock_version: Number(l.batch.stock_version || 1) + 1,
    });
  }

  // 12. Insert payments
  for (const p of payment.rows) {
    const paymentId = crypto.randomUUID();
    const payData = {
      id: paymentId,
      sale_id: saleId,
      method: p.method,
      amount: fromCents(p.amountCents),
      reference: p.reference,
      created_at: now.toISOString(),
    };
    await client.query(
      `INSERT INTO giga_cloud.payments (
         shop_id, payment_id, sale_id, method, amount, reference, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shopId, paymentId, saleId, p.method, fromCents(p.amountCents), p.reference, JSON.stringify(payData)]
    );
  }

  // 13. Update medicines stock version
  const returnMedicines: any[] = [];
  for (const medId of ids) {
    const updMed = await client.query(
      `UPDATE giga_cloud.medicines
       SET stock_version = stock_version + 1,
           updated_at = now()
       WHERE shop_id = $1 AND medicine_id = $2
       RETURNING medicine_id AS id, stock_version`,
      [shopId, medId]
    );
    const stockSumRes = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline ELSE COALESCE(last_reported_quantity, 0) END), 0)::int AS current_stock
       FROM giga_cloud.stock_levels
       WHERE shop_id = $1 AND medicine_id = $2`,
      [shopId, medId]
    );
    returnMedicines.push({
      id: medId,
      current_stock: stockSumRes.rows[0]?.current_stock ?? 0,
      stock_version: Number(updMed.rows[0]?.stock_version || 1),
    });
  }

  // 14. Customer update (if applicable)
  if (customerId) {
    await client.query(
      `UPDATE giga_cloud.customers
       SET data = jsonb_set(
         jsonb_set(COALESCE(data, '{}'::jsonb), '{total_spent}', to_jsonb(COALESCE((data->>'total_spent')::numeric, 0) + $1)),
         '{last_visit}', to_jsonb(now())
       ), updated_at = now()
       WHERE shop_id = $2 AND customer_id = $3`,
      [fromCents(totalCents), shopId, customerId]
    );
  }

  // 15. Shift totals update (if open shift exists)
  if (shiftId) {
    const cashCents = payment.rows.filter((r) => r.method === 'Cash').reduce((s, r) => s + r.amountCents, 0);
    const mpesaCents = payment.rows.filter((r) => r.method === 'M-Pesa').reduce((s, r) => s + r.amountCents, 0);
    const totalUnitsSold = lines.reduce((s, l) => s + l.quantity, 0);

    await client.query(
      `UPDATE giga_cloud.cashier_shifts
       SET data = jsonb_set(
         jsonb_set(
           jsonb_set(
             jsonb_set(
               COALESCE(data, '{}'::jsonb),
               '{total_sales}', to_jsonb(COALESCE((data->>'total_sales')::numeric, 0) + $1)
             ),
             '{total_transactions}', to_jsonb(COALESCE((data->>'total_transactions')::int, 0) + 1)
           ),
           '{cash_sales}', to_jsonb(COALESCE((data->>'cash_sales')::numeric, 0) + $2)
         ),
         '{mpesa_sales}', to_jsonb(COALESCE((data->>'mpesa_sales')::numeric, 0) + $3)
       ),
       units_sold = COALESCE(units_sold, 0) + $4,
       updated_at = now()
       WHERE shop_id = $5 AND shift_id = $6`,
      [fromCents(totalCents), fromCents(cashCents), fromCents(mpesaCents), totalUnitsSold, shopId, shiftId]
    ).catch(() => {});
  }

  // 16. Audit event in online audit
  await client.query(
    `INSERT INTO giga_cloud.online_audit (shop_id, online_user_id, user_email, action, details, client_ip, user_agent)
     VALUES ($1, $2, $3, 'ONLINE_SALE_COMPLETED', $4, 'ONLINE_POS', 'Online POS Terminal')`,
    [
      shopId,
      user.id,
      user.email,
      JSON.stringify({
        sale_id: saleId,
        receipt_number: receiptNumber,
        total: fromCents(totalCents),
        lines_count: lines.length,
        payment_method: payment.method,
      }),
    ]
  ).catch(() => {});

  const sale = await hydrateOnlineSale(
    client,
    shopId,
    {
      sale_id: saleId,
      sale_number: saleNumber,
      receipt_number: receiptNumber,
      business_date: todayStr,
      business_time: timeStr,
      cashier_id: cashierId,
      cashier_name: cashierName,
      customer_id: customerId,
      device_id: 'ONLINE_POS',
      price_mode: saleMode,
      subtotal: fromCents(subtotalCents),
      discount_total: fromCents(discountCents),
      tax_total: fromCents(taxCents),
      total: fromCents(totalCents),
      cost_total: fromCents(costCents),
      gross_profit: fromCents(netCents - costCents),
      payment_method: payment.method,
      status: 'completed',
      local_idempotency_key: key,
      created_at_local: now.toISOString(),
      data: saleData,
    },
    isCashier
  );

  return {
    success: true as const,
    duplicate: false,
    sale,
    medicines: returnMedicines,
    batches: [...touchedBatches.values()],
  };
}
