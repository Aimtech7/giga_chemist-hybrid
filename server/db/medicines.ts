import { setPriceContext } from './priceHistory';
import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, roundMoney, cleanUuid } from './client';
import { recordAuditLog } from './audit';
import { enqueueSyncEvent, medicineJson } from '../sync/outbox';
import type { Medicine, UserRole } from '../../src/types';

const MEDICINE_SELECT = `
  SELECT
    m.id, m.branch_id, m.name, m.generic_name, m.brand_name, m.sku, m.barcode,
    COALESCE(c.name, m.medicine_type, 'General') AS category,
    m.medicine_type, m.dosage_strength, m.dosage_form, m.manufacturer, m.description,
    COALESCE(m.purchase_price, 0)::float AS purchase_price,
    COALESCE(m.selling_price, 0)::float AS selling_price,
    m.wholesale_price::float AS wholesale_price,
    COALESCE(m.min_selling_price, m.selling_price, 0)::float AS min_selling_price,
    COALESCE(m.current_stock, 0)::int AS current_stock,
    COALESCE(m.reorder_level, 20)::int AS reorder_level,
    COALESCE(m.unit, 'Unit') AS unit,
    COALESCE(m.prescription_required, false) AS prescription_required,
    COALESCE(m.status, 'active') AS status,
    COALESCE(m.version, 1)::int AS version,
    m.created_at, m.updated_at
  FROM medicines m
  LEFT JOIN categories c ON m.category_id = c.id`;

export function toMedicine(r: any): Medicine {
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    name: r.name,
    generic_name: r.generic_name || r.name,
    brand_name: r.brand_name || '',
    sku: r.sku || '',
    barcode: r.barcode || '',
    category: r.category || 'General',
    medicine_type: r.medicine_type || '',
    dosage_strength: r.dosage_strength || '',
    dosage_form: r.dosage_form || 'Tablet',
    manufacturer: r.manufacturer || '',
    description: r.description || '',
    purchase_price: Number(r.purchase_price) || 0,
    selling_price: Number(r.selling_price) || 0,
    // NULL = no wholesale price set. Never substituted with the retail price.
    wholesale_price: r.wholesale_price != null ? Number(r.wholesale_price) : null,
    min_selling_price: Number(r.min_selling_price) || 0,
    current_stock: Number(r.current_stock) || 0,
    reorder_level: Number(r.reorder_level) || 0,
    unit: r.unit || 'Unit',
    prescription_required: Boolean(r.prescription_required),
    status: r.status || 'active',
    version: Number(r.version) || 1,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    created_by: 'Admin',
    updated_by: 'Admin',
  } as Medicine;
}

/**
 * Operational medicine catalogue. Archived medicines are deliberately excluded so an archive acts
 * like a deletion everywhere the live catalogue is used, while the retained row remains available
 * to historical sales/purchases/audit joins and direct-by-id history lookups.
 */
export async function getAllMedicines(q: Pick<pg.PoolClient, 'query'> = pgPool): Promise<Medicine[]> {
  const res = await q.query(
    `${MEDICINE_SELECT} WHERE COALESCE(m.status, 'active') <> 'archived' ORDER BY m.name ASC`
  );
  return res.rows.map(toMedicine);
}

export async function getMedicineById(id: string, q: Pick<pg.PoolClient, 'query'> = pgPool): Promise<Medicine | null> {
  const res = await q.query(`${MEDICINE_SELECT} WHERE m.id = $1`, [requireUuid(id, 'medicine id')]);
  return res.rows[0] ? toMedicine(res.rows[0]) : null;
}

export interface MedicineActor {
  user_id: string;
  user_name: string;
  role: UserRole;
  device_id?: string;
}

function optionalMoney(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative number.`);
  return roundMoney(n);
}

/** Wholesale price: undefined = unchanged, null/'' = clear (no wholesale price), else must be > 0. */
function optionalWholesale(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = optionalMoney(value, 'Wholesale price')!;
  if (n <= 0) throw new HttpError(400, 'Wholesale price must be greater than zero (leave it empty for no wholesale price).');
  return n;
}

function optionalWholeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative whole number.`);
  return n;
}

function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
}

/** Resolves a category name (case-insensitive) to its id, creating the category if it is new. */
async function resolveCategoryId(client: pg.PoolClient, name: unknown): Promise<string | null> {
  const clean = text(name, 100);
  if (!clean) return null;
  const found = await client.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1', [clean]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await client.query(
    `INSERT INTO categories (id, name) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET updated_at = categories.updated_at RETURNING id`,
    [crypto.randomUUID(), clean]
  );
  return created.rows[0].id;
}

/** Barcodes are unique across medicines (case/space-insensitive); empty barcodes are ignored. */
async function assertBarcodeFree(client: pg.PoolClient, barcode: string | undefined, exceptId?: string) {
  if (!barcode || !barcode.trim()) return;
  const res = await client.query(
    `SELECT name FROM medicines WHERE lower(btrim(barcode)) = lower(btrim($1)) AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
    [barcode, exceptId ?? null]
  );
  if (res.rows[0]) throw new HttpError(409, `Barcode "${barcode.trim()}" is already used by "${res.rows[0].name}".`);
}

function uniqueViolation(err: any, what: string): never {
  if (err?.code === '23505') throw new HttpError(409, `${what} is already used by another medicine.`);
  throw err;
}

/** ADMIN: creates a medicine. Stock always starts at 0 — it is added via Add Stock / Physical Count. */
export async function createMedicine(data: Partial<Medicine>, actor: MedicineActor): Promise<Medicine> {
  validateNewMedicine(data);
  return withTransaction(async (client) => {
    const saved = await createMedicineTx(client, crypto.randomUUID(), data, actor);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_CREATED', entity_type: 'medicine', entity_id: saved.id, operation: 'CREATE',
      data: async () => ({ medicine: await medicineJson(client, saved.id) }),
      actor,
    });
    return saved;
  });
}

function validateNewMedicine(data: Partial<Medicine>) {
  const name = text(data.name, 255);
  if (!name) throw new HttpError(400, 'Medicine name is required.');
  const selling = optionalMoney(data.selling_price, 'Selling price');
  if (selling === undefined || selling <= 0) throw new HttpError(400, 'Selling price must be greater than zero.');
  return { name, selling, purchase: optionalMoney(data.purchase_price, 'Purchase price') ?? 0 };
}

/**
 * createMedicine on the caller's transaction with a caller-chosen id (a remote command announces its
 * id in advance). Audited here; the caller enqueues the outbox event.
 */
export async function createMedicineTx(client: pg.PoolClient, id: string, data: Partial<Medicine>, actor: MedicineActor): Promise<Medicine> {
  const { name, selling, purchase } = validateNewMedicine(data);
  const exists = await client.query('SELECT 1 FROM medicines WHERE id = $1', [id]);
  if (exists.rows[0]) throw new HttpError(409, 'A medicine with this id already exists in the shop.');
  const categoryId = await resolveCategoryId(client, data.category);
  await assertBarcodeFree(client, text(data.barcode, 100));
  try {
    await client.query(
      `INSERT INTO medicines (
         id, name, generic_name, brand_name, sku, barcode, category_id, medicine_type,
         dosage_strength, dosage_form, manufacturer, description,
         purchase_price, selling_price, wholesale_price, min_selling_price,
         current_stock, reorder_level, unit, prescription_required, status, version,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,$18,$19,'active',1,$20,$20)`,
      [
        id, name, text(data.generic_name, 255) || name, text(data.brand_name, 255) || null,
        text(data.sku, 100) || `SKU-${id.slice(0, 8).toUpperCase()}`,
        text(data.barcode, 100) || `GC${id.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
        categoryId, text(data.medicine_type, 100) || null,
        text(data.dosage_strength, 100) || '', text(data.dosage_form, 100) || 'Tablet',
        text(data.manufacturer, 255) || null, text(data.description, 2000) || null,
        purchase, selling,
        optionalWholesale(data.wholesale_price) ?? null,
        optionalMoney(data.min_selling_price, 'Minimum selling price') ?? selling,
        optionalWholeNumber(data.reorder_level, 'Reorder level') ?? 20,
        text(data.unit, 50) || 'Unit', Boolean(data.prescription_required),
        cleanUuid(actor.user_id),
      ]
    );
  } catch (err) {
    uniqueViolation(err, 'This barcode');
  }
  const saved = (await getMedicineById(id, client))!;
  await recordAuditLog(
    { ...actor, action: 'CREATE_MEDICINE', entity: 'medicine', entity_id: id, new_value: saved },
    client
  );
  return saved;
}

/**
 * ADMIN: updates descriptive fields. current_stock is NEVER written here (stock changes only through
 * the audited stock operations). Price fields, if present and changed, go through the audited
 * pricing update inside the same transaction.
 */
export async function updateMedicineDetails(id: string, data: Partial<Medicine>, actor: MedicineActor): Promise<Medicine> {
  requireUuid(id, 'medicine id');
  return withTransaction(async (client) => {
    const saved = await updateMedicineDetailsTx(client, id, data, actor);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_UPDATED', entity_type: 'medicine', entity_id: id, operation: 'UPDATE',
      data: async () => ({ medicine: await medicineJson(client, id) }),
      actor,
    });
    return saved;
  });
}

/** updateMedicineDetails on the caller's transaction (no outbox event; the caller enqueues one). */
export async function updateMedicineDetailsTx(client: pg.PoolClient, id: string, data: Partial<Medicine>, actor: MedicineActor): Promise<Medicine> {
  const locked = await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [id]);
  if (!locked.rows[0]) throw new HttpError(404, 'Medicine not found.');
  const before = (await getMedicineById(id, client))!;

  const categoryId = data.category !== undefined ? await resolveCategoryId(client, data.category) : undefined;
  if (data.barcode !== undefined) await assertBarcodeFree(client, text(data.barcode, 100), id);
  const status = data.status !== undefined ? String(data.status) : undefined;
  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    throw new HttpError(400, 'status must be "active" or "inactive".');
  }
  if (data.name !== undefined && !text(data.name, 255)) throw new HttpError(400, 'Medicine name cannot be empty.');

  try {
    await client.query(
      `UPDATE medicines SET
         name = COALESCE($2, name), generic_name = COALESCE($3, generic_name),
         brand_name = COALESCE($4, brand_name), sku = COALESCE($5, sku), barcode = COALESCE($6, barcode),
         category_id = CASE WHEN $7::boolean THEN $8::uuid ELSE category_id END,
         medicine_type = COALESCE($9, medicine_type), dosage_strength = COALESCE($10, dosage_strength),
         dosage_form = COALESCE($11, dosage_form), manufacturer = COALESCE($12, manufacturer),
         description = COALESCE($13, description), unit = COALESCE($14, unit),
         prescription_required = COALESCE($15, prescription_required), status = COALESCE($16, status),
         updated_by = $17, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        id, text(data.name, 255) || null, text(data.generic_name, 255) || null, text(data.brand_name, 255) ?? null,
        text(data.sku, 100) || null, text(data.barcode, 100) || null,
        categoryId !== undefined, categoryId ?? null,
        text(data.medicine_type, 100) ?? null, text(data.dosage_strength, 100) ?? null,
        text(data.dosage_form, 100) || null, text(data.manufacturer, 255) ?? null,
        text(data.description, 2000) ?? null, text(data.unit, 50) || null,
        data.prescription_required !== undefined ? Boolean(data.prescription_required) : null,
        status ?? null, cleanUuid(actor.user_id),
      ]
    );
  } catch (err) {
    uniqueViolation(err, 'This barcode');
  }

  await recordAuditLog(
    {
      ...actor,
      action: 'UPDATE_MEDICINE',
      entity: 'medicine',
      entity_id: id,
      previous_value: { name: before.name, sku: before.sku, barcode: before.barcode, category: before.category, status: before.status },
      new_value: { name: data.name, sku: data.sku, barcode: data.barcode, category: data.category, status: data.status },
    },
    client
  );

  const priceFields = ['selling_price', 'purchase_price', 'min_selling_price', 'wholesale_price', 'reorder_level'] as const;
  if (priceFields.some((f) => data[f] !== undefined && Number(data[f]) !== Number(before[f]))) {
    return applyPricingUpdate(client, id, data as any, actor);
  }
  return (await getMedicineById(id, client))!;
}

export interface UpdatePricingParams {
  id: string;
  selling_price?: number;
  purchase_price?: number;
  min_selling_price?: number;
  wholesale_price?: number | null;
  reorder_level?: number;
  user_id: string;
  user_name: string;
  role: UserRole;
  device_id?: string;
}

export async function applyPricingUpdate(
  client: pg.PoolClient,
  id: string,
  p: Partial<UpdatePricingParams>,
  actor: MedicineActor
): Promise<Medicine> {
  const selling = optionalMoney(p.selling_price, 'Selling price');
  if (selling !== undefined && selling <= 0) throw new HttpError(400, 'Selling price must be greater than zero.');
  const purchase = optionalMoney(p.purchase_price, 'Purchase/cost price');
  const minSelling = optionalMoney(p.min_selling_price, 'Minimum selling price');
  const wholesale = optionalWholesale(p.wholesale_price);
  const reorder = optionalWholeNumber(p.reorder_level, 'Reorder level');

  const locked = await client.query(
    `SELECT selling_price::float, purchase_price::float, min_selling_price::float, wholesale_price::float,
            reorder_level, name FROM medicines WHERE id = $1 FOR UPDATE`,
    [id]
  );
  const old = locked.rows[0];
  if (!old) throw new HttpError(404, `Medicine "${id}" was not found.`);

  await setPriceContext(client, actor as any, 'LOCAL_ADMIN', { reason: typeof (p as any).reason === 'string' ? (p as any).reason : null });
  await client.query(
    `UPDATE medicines SET
       selling_price = COALESCE($2, selling_price), purchase_price = COALESCE($3, purchase_price),
       min_selling_price = COALESCE($4, min_selling_price),
       wholesale_price = CASE WHEN $8::boolean THEN $5::numeric ELSE wholesale_price END,
       reorder_level = COALESCE($6, reorder_level), updated_by = $7,
       version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, selling ?? null, purchase ?? null, minSelling ?? null, wholesale ?? null, reorder ?? null, cleanUuid(actor.user_id), wholesale !== undefined]
  );
  const saved = (await getMedicineById(id, client))!;

  // Historical sale_items keep their own unit_price snapshot; nothing here touches them.
  await recordAuditLog(
    {
      ...actor,
      action: 'ADMIN_PRICE_UPDATE',
      entity: 'medicine',
      entity_id: id,
      previous_value: {
        selling_price: old.selling_price,
        purchase_price: old.purchase_price,
        min_selling_price: old.min_selling_price,
        wholesale_price: old.wholesale_price,
        reorder_level: old.reorder_level,
      },
      new_value: {
        medicine_name: old.name,
        selling_price: saved.selling_price,
        purchase_price: saved.purchase_price,
        min_selling_price: saved.min_selling_price,
        wholesale_price: saved.wholesale_price,
        reorder_level: saved.reorder_level,
      },
    },
    client
  );
  return saved;
}

/** ADMIN: updates selling/cost price and reorder level atomically with an audit row. */
export async function adminUpdateMedicinePricing(params: UpdatePricingParams): Promise<Medicine> {
  const id = requireUuid(params.id, 'medicine id');
  const fields = ['selling_price', 'purchase_price', 'min_selling_price', 'wholesale_price', 'reorder_level'] as const;
  if (!fields.some((f) => params[f] !== undefined)) {
    throw new HttpError(400, 'At least one of selling_price, purchase_price, min_selling_price, wholesale_price or reorder_level is required.');
  }
  const actor: MedicineActor = {
    user_id: params.user_id,
    user_name: params.user_name,
    role: params.role,
    device_id: params.device_id,
  };
  return withTransaction(async (client) => {
    const saved = await applyPricingUpdate(client, id, params, actor);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_PRICE_CHANGED', entity_type: 'medicine', entity_id: id, operation: 'PRICE',
      data: async () => ({ medicine: await medicineJson(client, id) }),
      actor,
    });
    return saved;
  });
}

/**
 * Computes deterministic canonical SHA-256 fingerprint for a medicine and its active batches.
 */
export function computeMedicineStockFingerprint(
  medicineId: string,
  stockVersion: number | string,
  currentStock: number,
  batches: Array<{ id: string; quantity_available: number; stock_version?: number | string; status: string }>
): string {
  const sortedBatches = [...batches].sort((a, b) => a.id.localeCompare(b.id));
  const raw = [
    medicineId,
    stockVersion,
    currentStock,
    ...sortedBatches.map((b) => `${b.id}:${b.quantity_available}:${b.stock_version ?? 1}:${b.status}`),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface MedicineDeletePreview {
  medicine_id: string;
  name: string;
  sku: string;
  barcode: string;
  current_stock: number;
  status: string;
  version: number;
  batches_count: number;
  references: {
    sales: number;
    sale_items: number;
    purchases: number;
    purchase_items: number;
    returns: number;
    inventory_movements: number;
    stocktakes: number;
    pending_sync_events: number;
  };
  outcome: 'PERMANENT_DELETE' | 'ARCHIVE_REQUIRED';
  stock_blocks_delete: boolean;
  pending_sync_blocks_delete: boolean;
  can_permanent_delete: boolean;
}

/**
 * Previews whether a medicine can be permanently deleted or must be safely archived.
 */
export async function previewMedicineDeletion(
  medicineId: string,
  client?: pg.PoolClient
): Promise<MedicineDeletePreview> {
  const id = requireUuid(medicineId, 'medicine_id');
  const q = client || pgPool;

  const medRes = await q.query(
    'SELECT id, name, sku, barcode, current_stock, status, version FROM medicines WHERE id = $1',
    [id]
  );
  if (medRes.rows.length === 0) throw new HttpError(404, `Medicine ${id} not found.`);
  const m = medRes.rows[0];

  const saleItems = await q.query('SELECT count(*)::int AS c FROM sale_items WHERE medicine_id = $1', [id]);
  const purchaseItems = await q.query('SELECT count(*)::int AS c FROM purchase_items WHERE medicine_id = $1', [id]);
  const returns = await q.query('SELECT count(*)::int AS c FROM returns WHERE medicine_id = $1', [id]);
  const movements = await q.query('SELECT count(*)::int AS c FROM inventory_movements WHERE medicine_id = $1', [id]);
  const stocktakes = await q.query('SELECT count(*)::int AS c FROM stocktake_lines WHERE medicine_id = $1', [id]);
  const batches = await q.query('SELECT count(*)::int AS c FROM medicine_batches WHERE medicine_id = $1', [id]);
  const pendingSync = await q.query("SELECT count(*)::int AS c FROM sync_events WHERE entity_type = 'medicine' AND entity_id = $1 AND status <> 'SYNCED'", [id]);

  const siCount = saleItems.rows[0]?.c || 0;
  const piCount = purchaseItems.rows[0]?.c || 0;
  const retCount = returns.rows[0]?.c || 0;
  const movCount = movements.rows[0]?.c || 0;
  const stCount = stocktakes.rows[0]?.c || 0;
  const batchCount = batches.rows[0]?.c || 0;
  const pendingCount = pendingSync.rows[0]?.c || 0;

  const totalHistory = siCount + piCount + retCount + movCount + stCount;
  const currentStock = Number(m.current_stock) || 0;
  const stockBlocks = currentStock > 0;
  const pendingBlocks = pendingCount > 0;
  const canPermanent = totalHistory === 0 && !stockBlocks && !pendingBlocks;

  return {
    medicine_id: m.id,
    name: m.name,
    sku: m.sku || '',
    barcode: m.barcode || '',
    current_stock: currentStock,
    status: m.status || 'active',
    version: Number(m.version) || 1,
    batches_count: batchCount,
    references: {
      sales: siCount,
      sale_items: siCount,
      purchases: piCount,
      purchase_items: piCount,
      returns: retCount,
      inventory_movements: movCount,
      stocktakes: stCount,
      pending_sync_events: pendingCount,
    },
    outcome: canPermanent ? 'PERMANENT_DELETE' : 'ARCHIVE_REQUIRED',
    stock_blocks_delete: stockBlocks,
    pending_sync_blocks_delete: pendingBlocks,
    can_permanent_delete: canPermanent,
  };
}

export interface AuthoritativeDeletePreflight {
  [key: string]: unknown;
  preflight_id: string;
  medicine_id: string;
  name: string;
  current_version: number;
  current_status: string;
  current_stock: number;
  active_batches: number;
  references: {
    sales: number;
    sale_items: number;
    purchases: number;
    purchase_items: number;
    returns: number;
    inventory_movements: number;
    stocktake_lines: number;
    active_batches: number;
    pending_sync_events: number;
  };
  total_historical_references: number;
  pending_local_sync: number;
  outcome: 'PERMANENT_DELETE' | 'ARCHIVE_REQUIRED' | 'BLOCKED';
  block_reason: string | null;
  generated_at: string;
  expires_at: string;
}

export async function generateAuthoritativeDeletePreflight(
  client: pg.PoolClient | pg.Client | pg.Pool,
  medicineId: string,
  _reason?: string
): Promise<AuthoritativeDeletePreflight> {
  const id = requireUuid(medicineId, 'medicine_id');
  const medRes = await client.query(
    'SELECT id, name, sku, barcode, current_stock, status, version FROM medicines WHERE id = $1',
    [id]
  );
  if (medRes.rows.length === 0) throw new HttpError(404, `Medicine ${id} not found.`);
  const m = medRes.rows[0];

  const salesCountRes = await client.query('SELECT count(DISTINCT sale_id)::int AS c FROM sale_items WHERE medicine_id = $1', [id]);
  const saleItems = await client.query('SELECT count(*)::int AS c FROM sale_items WHERE medicine_id = $1', [id]);
  const purchasesCountRes = await client.query('SELECT count(DISTINCT purchase_id)::int AS c FROM purchase_items WHERE medicine_id = $1', [id]);
  const purchaseItems = await client.query('SELECT count(*)::int AS c FROM purchase_items WHERE medicine_id = $1', [id]);
  const returns = await client.query('SELECT count(*)::int AS c FROM returns WHERE medicine_id = $1', [id]);
  const movements = await client.query('SELECT count(*)::int AS c FROM inventory_movements WHERE medicine_id = $1', [id]);
  const stocktakes = await client.query('SELECT count(*)::int AS c FROM stocktake_lines WHERE medicine_id = $1', [id]);
  const batches = await client.query("SELECT count(*)::int AS c FROM medicine_batches WHERE medicine_id = $1 AND status <> 'exhausted' AND status <> 'archived'", [id]);
  const pendingSync = await client.query("SELECT count(*)::int AS c FROM sync_events WHERE entity_type = 'medicine' AND entity_id = $1 AND status <> 'SYNCED'", [id]);

  const salesCount = salesCountRes.rows[0]?.c || 0;
  const siCount = saleItems.rows[0]?.c || 0;
  const purchasesCount = purchasesCountRes.rows[0]?.c || 0;
  const piCount = purchaseItems.rows[0]?.c || 0;
  const retCount = returns.rows[0]?.c || 0;
  const movCount = movements.rows[0]?.c || 0;
  const stCount = stocktakes.rows[0]?.c || 0;
  const batchCount = batches.rows[0]?.c || 0;
  const pendingCount = pendingSync.rows[0]?.c || 0;

  const totalHistory = siCount + piCount + retCount + movCount + stCount;
  const currentStock = Number(m.current_stock) || 0;
  const stockBlocks = currentStock > 0;
  const pendingBlocks = pendingCount > 0;

  let outcome: 'PERMANENT_DELETE' | 'ARCHIVE_REQUIRED' | 'BLOCKED';
  let blockReason: string | null = null;

  if (stockBlocks) {
    outcome = 'BLOCKED';
    blockReason = `Cannot delete medicine "${m.name}" because it still has sellable stock (${currentStock} units). Stock must be adjusted to 0 first through an auditable workflow.`;
  } else if (pendingBlocks) {
    outcome = 'BLOCKED';
    blockReason = `Cannot delete medicine while ${pendingCount} unsynced events are pending in the local outbox. Wait for sync to complete.`;
  } else if (totalHistory > 0) {
    outcome = 'ARCHIVE_REQUIRED';
  } else {
    outcome = 'PERMANENT_DELETE';
  }

  const preflight_id = crypto.randomUUID();
  const generated_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await client.query(
    `INSERT INTO medicine_delete_preflights (
      preflight_id, medicine_id, current_version, current_status, current_stock,
      active_batches, sales_references, sale_item_references, purchase_references,
      purchase_item_references, returns_references, movement_references,
      stocktake_references, pending_local_sync, outcome, block_reason, generated_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (preflight_id) DO NOTHING`,
    [
      preflight_id, id, Number(m.version) || 1, m.status || 'active', currentStock,
      batchCount, salesCount, siCount, purchasesCount, piCount, retCount, movCount,
      stCount, pendingCount, outcome, blockReason, generated_at, expires_at
    ]
  ).catch(() => {});

  return {
    preflight_id,
    medicine_id: m.id,
    name: m.name,
    current_version: Number(m.version) || 1,
    current_status: m.status || 'active',
    current_stock: currentStock,
    active_batches: batchCount,
    references: {
      sales: salesCount,
      sale_items: siCount,
      purchases: purchasesCount,
      purchase_items: piCount,
      returns: retCount,
      inventory_movements: movCount,
      stocktake_lines: stCount,
      active_batches: batchCount,
      pending_sync_events: pendingCount,
    },
    total_historical_references: totalHistory,
    pending_local_sync: pendingCount,
    outcome,
    block_reason: blockReason,
    generated_at,
    expires_at,
  };
}

/**
 * Atomically deletes or archives a medicine according to historical references and stock rules.
 */
export async function deleteOrArchiveMedicineTx(
  client: pg.PoolClient,
  medicineId: string,
  actor: MedicineActor,
  options?: {
    preflight_id?: string;
    expected_version?: number;
    expected_status?: string;
    expected_current_stock?: number;
    reason?: string;
  }
): Promise<{ action: 'DELETED' | 'ARCHIVED'; medicine_id: string; reason: string }> {
  const id = requireUuid(medicineId, 'medicine_id');

  // Enforce ADMIN role requirement server-side
  if (actor.role !== 'ADMIN') {
    throw new HttpError(403, 'Permission denied: only an Administrator may delete or archive medicines.');
  }

  // Preflight validation if preflight_id provided
  if (options?.preflight_id) {
    const pfRes = await client.query(
      'SELECT preflight_id, expires_at FROM medicine_delete_preflights WHERE preflight_id = $1',
      [options.preflight_id]
    ).catch(() => ({ rows: [] }));
    if (pfRes.rows.length > 0 && new Date(pfRes.rows[0].expires_at).getTime() < Date.now()) {
      throw new HttpError(
        409,
        'DELETE_PREFLIGHT_STALE: Delete preflight has expired. Refresh preview before trying again.',
        { code: 'DELETE_PREFLIGHT_STALE' }
      );
    }
  }

  // Lock medicine row
  const lockedRes = await client.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [id]);
  if (lockedRes.rows.length === 0) {
    const tomb = await client.query('SELECT medicine_id, notes FROM medicine_tombstones WHERE medicine_id = $1', [id]);
    if (tomb.rows.length > 0) {
      return {
        action: 'DELETED',
        medicine_id: id,
        reason: tomb.rows[0].notes || 'Already permanently deleted.',
      };
    }
    throw new HttpError(404, `Medicine ${id} not found.`);
  }
  const m = lockedRes.rows[0];

  // Optimistic concurrency validation (DELETE_PREFLIGHT_STALE if conflict)
  if (options?.expected_version !== undefined && Number(m.version) !== options.expected_version) {
    throw new HttpError(
      409,
      `DELETE_PREFLIGHT_STALE: Medicine version conflict: expected ${options.expected_version}, but currently at ${m.version}. Refresh and retry.`,
      { code: 'DELETE_PREFLIGHT_STALE', expected_version: options.expected_version, current_version: Number(m.version), current_state: { version: Number(m.version), status: m.status, current_stock: Number(m.current_stock) } }
    );
  }
  if (options?.expected_status !== undefined && m.status !== options.expected_status) {
    throw new HttpError(
      409,
      `DELETE_PREFLIGHT_STALE: Medicine status conflict: expected ${options.expected_status}, but currently "${m.status}". Refresh and retry.`,
      { code: 'DELETE_PREFLIGHT_STALE', expected_status: options.expected_status, current_status: m.status, current_state: { version: Number(m.version), status: m.status, current_stock: Number(m.current_stock) } }
    );
  }
  if (options?.expected_current_stock !== undefined && Number(m.current_stock) !== options.expected_current_stock) {
    throw new HttpError(
      409,
      `DELETE_PREFLIGHT_STALE: Medicine stock conflict: expected ${options.expected_current_stock}, but currently ${m.current_stock}. Refresh and retry.`,
      { code: 'DELETE_PREFLIGHT_STALE', expected_current_stock: options.expected_current_stock, current_stock: Number(m.current_stock), current_state: { version: Number(m.version), status: m.status, current_stock: Number(m.current_stock) } }
    );
  }

  const currentStock = Number(m.current_stock) || 0;
  if (currentStock > 0) {
    throw new HttpError(
      409,
      `Cannot delete medicine "${m.name}" because it still has sellable stock (${currentStock} units). Stock must be adjusted to 0 first through an auditable workflow.`
    );
  }

  // Check pending sync events
  const pendingSync = await client.query(
    "SELECT count(*)::int AS c FROM sync_events WHERE entity_type = 'medicine' AND entity_id = $1 AND status <> 'SYNCED'",
    [id]
  );
  if ((pendingSync.rows[0]?.c || 0) > 0) {
    throw new HttpError(409, 'Cannot delete medicine while unsynced events are pending in the outbox. Wait for sync to complete.');
  }

  // Check all historical business references (sequentially to avoid concurrent client.query)
  const si = await client.query('SELECT count(*)::int AS c FROM sale_items WHERE medicine_id = $1', [id]);
  const pi = await client.query('SELECT count(*)::int AS c FROM purchase_items WHERE medicine_id = $1', [id]);
  const ret = await client.query('SELECT count(*)::int AS c FROM returns WHERE medicine_id = $1', [id]);
  const mov = await client.query('SELECT count(*)::int AS c FROM inventory_movements WHERE medicine_id = $1', [id]);
  const st = await client.query('SELECT count(*)::int AS c FROM stocktake_lines WHERE medicine_id = $1', [id]);

  const totalHistory =
    (si.rows[0]?.c || 0) +
    (pi.rows[0]?.c || 0) +
    (ret.rows[0]?.c || 0) +
    (mov.rows[0]?.c || 0) +
    (st.rows[0]?.c || 0);

  if (totalHistory > 0) {
    // -------------------------------------------------------------------------
    // B. ARCHIVE / RETIRE
    // -------------------------------------------------------------------------
    await client.query(
      `UPDATE medicines
          SET status = 'archived', updated_by = $2, updated_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE id = $1`,
      [id, cleanUuid(actor.user_id)]
    );
    await client.query(
      `UPDATE medicine_batches
          SET status = 'archived', updated_at = CURRENT_TIMESTAMP
        WHERE medicine_id = $1 AND status <> 'exhausted'`,
      [id]
    );

    const auditDetail = {
      medicine_name: m.name,
      historical_references: totalHistory,
      reason: options?.reason || 'Historical business records exist; archived to maintain audit integrity',
    };

    await recordAuditLog(
      {
        ...actor,
        action: 'MEDICINE_ARCHIVED_BY_DELETE_REQUEST',
        entity: 'medicine',
        entity_id: id,
        previous_value: { status: m.status },
        new_value: { status: 'archived', details: auditDetail },
      },
      client
    );

    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_ARCHIVED',
      entity_type: 'medicine',
      entity_id: id,
      operation: 'ARCHIVE',
      data: async () => ({ medicine_id: id, status: 'archived', reason: auditDetail.reason }),
      actor,
    });

    return {
      action: 'ARCHIVED',
      medicine_id: id,
      reason: auditDetail.reason,
    };
  }

  // ---------------------------------------------------------------------------
  // A. PERMANENT DELETE (Safe unused medicine)
  // ---------------------------------------------------------------------------
  // Remove safe dependent non-historical rows
  await client.query('DELETE FROM medicine_batches WHERE medicine_id = $1', [id]);
  await client.query('DELETE FROM price_history WHERE medicine_id = $1', [id]);

  // Permanently delete medicine row
  await client.query('DELETE FROM medicines WHERE id = $1', [id]);

  // Record tombstone to prevent resurrection from delayed sync replays
  await client.query(
    `INSERT INTO medicine_tombstones (medicine_id, deletion_seq, actor_id, actor_name, notes)
     VALUES ($1, COALESCE((SELECT MAX(seq) FROM sync_events), 0) + 1, $2, $3, $4)
     ON CONFLICT (medicine_id) DO UPDATE SET deletion_seq = EXCLUDED.deletion_seq`,
    [id, cleanUuid(actor.user_id), actor.user_name, options?.reason || 'Permanent deletion of unused medicine']
  );

  await recordAuditLog(
    {
      ...actor,
      action: 'MEDICINE_PERMANENTLY_DELETED',
      entity: 'medicine',
      entity_id: id,
      previous_value: { name: m.name, sku: m.sku, barcode: m.barcode },
      new_value: null,
    },
    client
  );

  await enqueueSyncEvent(client, {
    event_type: 'MEDICINE_DELETED',
    entity_type: 'medicine',
    entity_id: id,
    operation: 'DELETE',
    data: async () => ({ medicine_id: id, reason: options?.reason || 'Permanent deletion of unused medicine' }),
    actor,
  });

  return {
    action: 'DELETED',
    medicine_id: id,
    reason: options?.reason || 'Permanently deleted from database.',
  };
}

/**
 * Restores an archived medicine back to active status.
 */
export async function restoreMedicineTx(
  client: pg.PoolClient,
  medicineId: string,
  actor: MedicineActor
): Promise<Medicine> {
  const id = requireUuid(medicineId, 'medicine_id');

  if (actor.role !== 'ADMIN') {
    throw new HttpError(403, 'Permission denied: only an Administrator may restore medicines.');
  }

  const lockedRes = await client.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [id]);
  if (lockedRes.rows.length === 0) throw new HttpError(404, `Medicine ${id} not found.`);
  const m = lockedRes.rows[0];

  if (m.status !== 'archived') {
    throw new HttpError(400, `Medicine "${m.name}" is not archived (current status: "${m.status}").`);
  }

  await client.query(
    `UPDATE medicines
        SET status = 'active', updated_by = $2, updated_at = CURRENT_TIMESTAMP, version = version + 1
      WHERE id = $1`,
    [id, cleanUuid(actor.user_id)]
  );

  await client.query(
    `UPDATE medicine_batches
        SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE medicine_id = $1 AND quantity_available > 0`,
    [id]
  );

  const saved = (await getMedicineById(id, client))!;

  await recordAuditLog(
    {
      ...actor,
      action: 'MEDICINE_RESTORED',
      entity: 'medicine',
      entity_id: id,
      previous_value: { status: 'archived' },
      new_value: { status: 'active' },
    },
    client
  );

  await enqueueSyncEvent(client, {
    event_type: 'MEDICINE_UPDATED',
    entity_type: 'medicine',
    entity_id: id,
    operation: 'RESTORE',
    data: async () => ({ medicine: await medicineJson(client, id) }),
    actor,
  });

  return saved;
}

