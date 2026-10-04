import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, roundMoney } from './client';
import { recordAuditLog } from './audit';
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

export async function getAllMedicines(): Promise<Medicine[]> {
  const res = await pgPool.query(`${MEDICINE_SELECT} ORDER BY m.name ASC`);
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
  const name = text(data.name, 255);
  if (!name) throw new HttpError(400, 'Medicine name is required.');
  const selling = optionalMoney(data.selling_price, 'Selling price');
  if (selling === undefined || selling <= 0) throw new HttpError(400, 'Selling price must be greater than zero.');
  const purchase = optionalMoney(data.purchase_price, 'Purchase price') ?? 0;

  return withTransaction(async (client) => {
    const categoryId = await resolveCategoryId(client, data.category);
    const id = crypto.randomUUID();
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
          actor.user_id,
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
  });
}

/**
 * ADMIN: updates descriptive fields. current_stock is NEVER written here (stock changes only through
 * the audited stock operations). Price fields, if present and changed, go through the audited
 * pricing update inside the same transaction.
 */
export async function updateMedicineDetails(id: string, data: Partial<Medicine>, actor: MedicineActor): Promise<Medicine> {
  requireUuid(id, 'medicine id');
  return withTransaction(async (client) => {
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
          status ?? null, actor.user_id,
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
  });
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

async function applyPricingUpdate(
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

  await client.query(
    `UPDATE medicines SET
       selling_price = COALESCE($2, selling_price), purchase_price = COALESCE($3, purchase_price),
       min_selling_price = COALESCE($4, min_selling_price),
       wholesale_price = CASE WHEN $8::boolean THEN $5::numeric ELSE wholesale_price END,
       reorder_level = COALESCE($6, reorder_level), updated_by = $7,
       version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, selling ?? null, purchase ?? null, minSelling ?? null, wholesale ?? null, reorder ?? null, actor.user_id, wholesale !== undefined]
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
  return withTransaction((client) => applyPricingUpdate(client, id, params, actor));
}
