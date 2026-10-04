import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured, cleanUuid, ensureUuid, HttpError, requireUuid } from './client';
import { serverDb } from '../db';
import type { InventoryMovement } from '../../src/types';

export async function getAllMovements(): Promise<InventoryMovement[]> {
  try {
    const res = await pgPool.query(`
      SELECT
        im.id, im.medicine_id, m.name as medicine_name,
        im.batch_id, b.batch_number,
        COALESCE(im.previous_quantity, 0)::int as previous_quantity,
        COALESCE(im.adjustment_quantity, 0)::int as adjustment_quantity,
        COALESCE(im.new_quantity, 0)::int as new_quantity,
        im.reason, im.movement_type, im.reference_id, im.notes,
        im.user_id, u.name as user_name,
        im.device_id, im.date, im.created_at
      FROM inventory_movements im
      LEFT JOIN medicines m ON im.medicine_id = m.id
      LEFT JOIN medicine_batches b ON im.batch_id = b.id
      LEFT JOIN users u ON im.user_id = u.id
      ORDER BY im.created_at DESC
      LIMIT 1000
    `);
    if (isLocalMode || (res.rows && res.rows.length > 0)) {
      return res.rows.map((r) => ({
        id: r.id,
        medicine_id: r.medicine_id,
        medicine_name: r.medicine_name || 'Item',
        batch_id: r.batch_id,
        batch_number: r.batch_number || 'Batch',
        previous_quantity: Number(r.previous_quantity) || 0,
        adjustment_quantity: Number(r.adjustment_quantity) || 0,
        new_quantity: Number(r.new_quantity) || 0,
        // Legacy imported rows predate the reason column (NULL); their meaning is in movement_type.
        reason: r.reason || r.movement_type || 'UNSPECIFIED',
        movement_type: r.movement_type || undefined,
        reference_id: r.reference_id || undefined,
        notes: r.notes || undefined,
        user_id: r.user_id || 'admin',
        user_name: r.user_name || 'Staff',
        device_id: r.device_id || 'SERVER',
        date: r.date || '',
        timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      }));
    }
  } catch (err: any) {
    if (isLocalMode) {
      console.error('[Server DB] getAllMovements PostgreSQL error:', err.message);
      throw err;
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('inventory_movements')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) return data as InventoryMovement[];
    } catch (err) {
      console.warn('[Server DB] Supabase inventory movements query failed:', err);
    }
  }
  return serverDb.get().inventory_movements;
}

// ---------------------------------------------------------------------------
// Shared stock helpers
// ---------------------------------------------------------------------------

/** Server-local calendar date as YYYY-MM-DD (en-CA formats ISO-style). */
export function localDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA');
}

/**
 * Single source of truth for a batch's status after a stock change.
 * Only 'active' batches count towards medicines.current_stock and are sellable.
 * A batch is expired ON its expiry date (matches src/utils/expiry isExpired and the
 * trg_update_medicine_stock trigger: expiry_date > CURRENT_DATE is sellable).
 */
export function deriveBatchStatus(quantity: number, expiryDate: string | null | undefined, currentStatus?: string): string {
  if (quantity <= 0) return 'exhausted';
  if (expiryDate && expiryDate <= localDateStr()) return 'quarantined';
  if (currentStatus === 'recalled') return 'recalled';
  return 'active';
}

export function deriveExpiryStatus(expiryDate: string | null | undefined): 'KNOWN' | 'UNKNOWN' | 'EXPIRED' {
  if (!expiryDate) return 'UNKNOWN';
  return expiryDate <= localDateStr() ? 'EXPIRED' : 'KNOWN';
}

/** Validates an optional YYYY-MM-DD expiry date. Empty → null (UNKNOWN expiry). */
export function normalizeExpiryDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'expiry_date must be a YYYY-MM-DD string or null.');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())) {
    throw new HttpError(400, `Invalid expiry date "${trimmed}". Use YYYY-MM-DD.`);
  }
  return trimmed;
}

function requireWholeNumber(value: unknown, field: string, { allowZero }: { allowZero: boolean }): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new HttpError(400, `${field} must be a ${allowZero ? 'non-negative' : 'positive'} whole number.`);
  }
  return n;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr: any) {
      console.error('[Server DB] ROLLBACK failed:', rbErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function lockMedicine(client: pg.PoolClient, medicineId: string) {
  const res = await client.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [medicineId]);
  if (res.rows.length === 0) throw new HttpError(404, `Medicine ${medicineId} not found.`);
  return res.rows[0];
}

async function lockBatch(client: pg.PoolClient, batchId: string, medicineId: string) {
  const res = await client.query(
    'SELECT * FROM medicine_batches WHERE id = $1 AND medicine_id = $2 FOR UPDATE',
    [batchId, medicineId]
  );
  if (res.rows.length === 0) throw new HttpError(404, `Batch ${batchId} not found for this medicine.`);
  return res.rows[0];
}

/**
 * Recomputes medicines.current_stock as the SUM of its active, unexpired batches —
 * the same predicate as the trg_update_medicine_stock trigger, so both always agree.
 */
async function reconcileMedicineStock(client: pg.PoolClient, medicineId: string) {
  const res = await client.query(`
    UPDATE medicines
    SET current_stock = COALESCE((
          SELECT SUM(quantity_available)
          FROM medicine_batches
          WHERE medicine_id = $1 AND status = 'active'
            AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
        ), 0),
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `, [medicineId]);
  return res.rows[0];
}

/** Falls back to the 'SERVER' device when the caller's device is not registered (devices FK). */
async function resolveDeviceId(client: pg.PoolClient, deviceId?: string): Promise<string> {
  if (deviceId && deviceId !== 'SERVER') {
    const res = await client.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]);
    if (res.rows.length > 0) return deviceId;
  }
  return 'SERVER';
}

interface StockActor {
  user_id: string;
  user_name: string;
  role?: string;
  device_id?: string;
}

async function insertMovement(
  client: pg.PoolClient,
  m: {
    medicine_id: string;
    batch_id: string;
    previous_quantity: number;
    new_quantity: number;
    movement_type: string;
    reason: string;
    notes?: string | null;
    reference_id?: string | null;
  },
  actor: StockActor,
  deviceId: string
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await client.query(`
    INSERT INTO inventory_movements (
      id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity,
      movement_type, reason, reference_id, notes, user_id, device_id, date, timestamp
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    id, m.medicine_id, m.batch_id, m.previous_quantity, m.new_quantity - m.previous_quantity, m.new_quantity,
    m.movement_type, m.reason, m.reference_id || null, m.notes || null,
    cleanUuid(actor.user_id), deviceId, localDateStr(), now,
  ]);
  return { id, batch_id: m.batch_id, previous_quantity: m.previous_quantity, new_quantity: m.new_quantity, delta: m.new_quantity - m.previous_quantity };
}

async function insertAudit(
  client: pg.PoolClient,
  a: { action: string; entity: string; entity_id: string; previous_value?: unknown; new_value?: unknown },
  actor: StockActor,
  deviceId: string
) {
  await client.query(`
    INSERT INTO audit_logs (
      id, user_id, user_name, role, action, entity, entity_id,
      previous_value, new_value, device_id, timestamp
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    crypto.randomUUID(), cleanUuid(actor.user_id), actor.user_name || 'Admin', actor.role || 'ADMIN',
    a.action, a.entity, a.entity_id,
    a.previous_value !== undefined ? JSON.stringify(a.previous_value) : null,
    a.new_value !== undefined ? JSON.stringify(a.new_value) : null,
    deviceId, Date.now(),
  ]);
}

/** Normalizes a medicine_batches row into the client MedicineBatch shape. */
export function toBatchDto(r: any, medicineName?: string) {
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    medicine_id: r.medicine_id,
    medicine_name: medicineName || r.medicine_name || '',
    batch_number: r.batch_number,
    supplier_id: r.supplier_id || '',
    quantity_received: Number(r.quantity_received) || 0,
    quantity_available: Number(r.quantity_available) || 0,
    purchase_price: Number(r.purchase_price) || 0,
    selling_price_override: r.selling_price_override != null ? Number(r.selling_price_override) : undefined,
    manufacturing_date: r.manufacturing_date || '',
    expiry_date: r.expiry_date || '',
    expiry_status: r.expiry_status || (r.expiry_date ? 'KNOWN' : 'UNKNOWN'),
    received_date: r.received_date || '',
    purchase_invoice: r.purchase_invoice || '',
    status: r.status || 'active',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
  };
}

/** Stock-relevant medicine fields returned to the client after a stock change. */
export function toMedicineStockDto(r: any) {
  return {
    id: r.id,
    name: r.name,
    current_stock: Number(r.current_stock) || 0,
    version: Number(r.version) || 1,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Generic movement recorder (purchases, returns, legacy adjust endpoint)
// ---------------------------------------------------------------------------

export async function recordInventoryMovement(movement: InventoryMovement): Promise<InventoryMovement> {
  const movementRecord: InventoryMovement = {
    ...movement,
    id: ensureUuid(movement.id),
    date: movement.date || localDateStr(),
    timestamp: movement.timestamp || Date.now(),
  };

  try {
    await withTransaction(async (client) => {
      const deviceId = await resolveDeviceId(client, movementRecord.device_id);
      await client.query(`
        INSERT INTO inventory_movements (
          id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity,
          movement_type, reason, reference_id, notes, user_id, device_id, date, timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        movementRecord.id,
        movementRecord.medicine_id,
        movementRecord.batch_id,
        movementRecord.previous_quantity || 0,
        movementRecord.adjustment_quantity || 0,
        movementRecord.new_quantity || 0,
        ((movementRecord as any).movement_type || movementRecord.reason || 'STOCK_ADJUSTMENT').toUpperCase(),
        movementRecord.reason || 'stock_adjustment',
        movementRecord.reference_id || null,
        movementRecord.notes || null,
        cleanUuid(movementRecord.user_id),
        deviceId,
        movementRecord.date,
        movementRecord.timestamp || Date.now(),
      ]);

      if (movementRecord.batch_id) {
        await client.query(`
          UPDATE medicine_batches
          SET
            quantity_available = GREATEST(0, quantity_available + $1),
            status = CASE WHEN quantity_available + $1 <= 0 THEN 'exhausted' ELSE 'active' END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `, [movementRecord.adjustment_quantity, movementRecord.batch_id]);
      }

      if (movementRecord.medicine_id) {
        await reconcileMedicineStock(client, movementRecord.medicine_id);
      }
    });
  } catch (pgErr: any) {
    console.error('[Server DB] recordInventoryMovement PostgreSQL error:', pgErr.message);
    if (isLocalMode) {
      throw pgErr;
    }
  }

  // PostgreSQL is authoritative in local mode: no secondary JSON / cloud writes.
  if (isLocalMode) return movementRecord;

  if (isSupabaseConfigured) {
    try {
      const { error: movError } = await supabaseAdmin
        .from('inventory_movements')
        .insert(movementRecord);
      if (movError) throw movError;

      const { data: batchData } = await supabaseAdmin
        .from('medicine_batches')
        .select('quantity_available')
        .eq('id', movementRecord.batch_id)
        .single();

      if (batchData) {
        const updatedQty = Math.max(0, batchData.quantity_available + movementRecord.adjustment_quantity);
        await supabaseAdmin
          .from('medicine_batches')
          .update({
            quantity_available: updatedQty,
            status: updatedQty === 0 ? 'exhausted' : 'active',
          })
          .eq('id', movementRecord.batch_id);
      }
    } catch (err) {
      console.warn('[Server DB] Supabase recordInventoryMovement failed:', err);
    }
  }

  const store = serverDb.get();
  store.inventory_movements.unshift(movementRecord);
  const targetBatch = store.medicine_batches.find((b) => b.id === movementRecord.batch_id);
  if (targetBatch) {
    targetBatch.quantity_available = Math.max(0, targetBatch.quantity_available + movementRecord.adjustment_quantity);
    targetBatch.status = targetBatch.quantity_available === 0 ? 'exhausted' : 'active';
  }
  const targetMed = store.medicines.find((m) => m.id === movementRecord.medicine_id);
  if (targetMed) {
    const activeBatches = store.medicine_batches.filter(
      (b) => b.medicine_id === targetMed.id && b.status === 'active'
    );
    targetMed.current_stock = activeBatches.reduce((acc, b) => acc + b.quantity_available, 0);
  }
  serverDb.persist();

  return movementRecord;
}

// ---------------------------------------------------------------------------
// ADMIN stock operations — each is one PostgreSQL transaction:
//   lock rows → update batch → reconcile medicine → movement → audit → COMMIT
// ---------------------------------------------------------------------------

export interface AdminSetStockParams extends StockActor {
  medicine_id: string;
  batch_id?: string;
  new_stock: number;
  reason?: string;
  notes?: string;
}

export async function adminSetStock(params: AdminSetStockParams) {
  const medicineId = requireUuid(params.medicine_id, 'medicine_id');
  const batchIdParam = params.batch_id ? requireUuid(params.batch_id, 'batch_id') : undefined;
  const newStock = requireWholeNumber(params.new_stock, 'new_stock', { allowZero: true });

  return withTransaction(async (client) => {
    const deviceId = await resolveDeviceId(client, params.device_id);
    const medicine = await lockMedicine(client, medicineId);
    const previousTotal = Number(medicine.current_stock) || 0;

    let batch: any;
    if (batchIdParam) {
      batch = await lockBatch(client, batchIdParam, medicineId);
    } else {
      const all = await client.query(
        'SELECT * FROM medicine_batches WHERE medicine_id = $1 ORDER BY created_at ASC FOR UPDATE',
        [medicineId]
      );
      if (all.rows.length > 1) {
        throw new HttpError(400, 'This medicine has multiple batches. Select the batch to set stock for.');
      }
      batch = all.rows[0];
    }

    let previousQty = 0;
    let saved: any;
    if (batch) {
      previousQty = Number(batch.quantity_available) || 0;
      const upd = await client.query(`
        UPDATE medicine_batches
        SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `, [newStock, deriveBatchStatus(newStock, batch.expiry_date, batch.status), batch.id]);
      saved = upd.rows[0];
    } else {
      // Medicine has no batch yet: create one with UNKNOWN expiry (never invent an expiry date).
      const now = new Date();
      const batchNumber = `BATCH-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const ins = await client.query(`
        INSERT INTO medicine_batches (
          id, medicine_id, batch_number, quantity_received, quantity_available,
          purchase_price, expiry_date, expiry_status, received_date, status, created_at
        ) VALUES ($1, $2, $3, $4, $4, $5, NULL, 'UNKNOWN', $6, $7, CURRENT_TIMESTAMP)
        RETURNING *
      `, [crypto.randomUUID(), medicineId, batchNumber, newStock, Number(medicine.purchase_price) || 0, localDateStr(), deriveBatchStatus(newStock, null)]);
      saved = ins.rows[0];
    }

    const updatedMedicine = await reconcileMedicineStock(client, medicineId);
    const movement = await insertMovement(client, {
      medicine_id: medicineId,
      batch_id: saved.id,
      previous_quantity: previousQty,
      new_quantity: newStock,
      movement_type: 'CORRECTION',
      reason: params.reason?.trim() || 'SET_EXACT_STOCK',
      notes: params.notes?.trim() || `Admin set exact stock from ${previousQty} to ${newStock}`,
    }, params, deviceId);

    await insertAudit(client, {
      action: 'ADMIN_SET_STOCK',
      entity: 'medicine',
      entity_id: medicineId,
      previous_value: { current_stock: previousTotal, batch_id: saved.id, batch_quantity: previousQty },
      new_value: {
        current_stock: Number(updatedMedicine.current_stock),
        batch_id: saved.id,
        batch_quantity: newStock,
        delta: newStock - previousQty,
        reason: params.reason,
        notes: params.notes,
        movement_id: movement.id,
      },
    }, params, deviceId);

    return {
      success: true,
      medicine: toMedicineStockDto(updatedMedicine),
      batch: toBatchDto(saved, medicine.name),
      movement,
      delta: newStock - previousQty,
      new_stock: newStock,
    };
  });
}

export interface AdminAddStockParams extends StockActor {
  medicine_id: string;
  quantity: number;
  batch_number: string;
  expiry_date?: string | null;
  supplier_id?: string;
  purchase_price?: number;
  selling_price_override?: number;
  notes?: string;
}

export async function adminAddStock(params: AdminAddStockParams) {
  const medicineId = requireUuid(params.medicine_id, 'medicine_id');
  const quantity = requireWholeNumber(params.quantity, 'quantity', { allowZero: false });
  const batchNumber = (params.batch_number || '').trim().toUpperCase();
  if (!batchNumber) throw new HttpError(400, 'Batch number is required.');
  const expiryDate = normalizeExpiryDate(params.expiry_date);
  const supplierId = params.supplier_id ? requireUuid(params.supplier_id, 'supplier_id') : null;
  for (const [field, value] of [['purchase_price', params.purchase_price], ['selling_price_override', params.selling_price_override]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new HttpError(400, `${field} must be a non-negative number.`);
    }
  }

  return withTransaction(async (client) => {
    const deviceId = await resolveDeviceId(client, params.device_id);
    const medicine = await lockMedicine(client, medicineId);

    const existingRes = await client.query(
      'SELECT * FROM medicine_batches WHERE medicine_id = $1 AND UPPER(batch_number) = $2 FOR UPDATE',
      [medicineId, batchNumber]
    );

    let previousQty = 0;
    let saved: any;
    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      previousQty = Number(existing.quantity_available) || 0;
      const newQty = previousQty + quantity;
      const effectiveExpiry = expiryDate ?? existing.expiry_date ?? null;
      const upd = await client.query(`
        UPDATE medicine_batches
        SET quantity_available = $1,
            quantity_received = quantity_received + $2,
            expiry_date = $3,
            expiry_status = $4,
            supplier_id = COALESCE($5, supplier_id),
            purchase_price = COALESCE($6, purchase_price),
            selling_price_override = COALESCE($7, selling_price_override),
            status = $8,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $9
        RETURNING *
      `, [
        newQty, quantity, effectiveExpiry, deriveExpiryStatus(effectiveExpiry), supplierId,
        params.purchase_price ?? null, params.selling_price_override ?? null,
        deriveBatchStatus(newQty, effectiveExpiry, existing.status), existing.id,
      ]);
      saved = upd.rows[0];
    } else {
      const ins = await client.query(`
        INSERT INTO medicine_batches (
          id, medicine_id, batch_number, supplier_id, quantity_received, quantity_available,
          purchase_price, selling_price_override, expiry_date, expiry_status,
          received_date, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
        RETURNING *
      `, [
        crypto.randomUUID(), medicineId, batchNumber, supplierId, quantity,
        params.purchase_price ?? (Number(medicine.purchase_price) || 0),
        params.selling_price_override ?? null, expiryDate, deriveExpiryStatus(expiryDate),
        localDateStr(), deriveBatchStatus(quantity, expiryDate),
      ]);
      saved = ins.rows[0];
    }

    const updatedMedicine = await reconcileMedicineStock(client, medicineId);
    const movement = await insertMovement(client, {
      medicine_id: medicineId,
      batch_id: saved.id,
      previous_quantity: previousQty,
      new_quantity: Number(saved.quantity_available),
      movement_type: 'PURCHASE',
      reason: 'ADD_STOCK',
      notes: params.notes?.trim() || `Admin added ${quantity} units to batch ${batchNumber}`,
    }, params, deviceId);

    await insertAudit(client, {
      action: 'ADMIN_ADD_STOCK',
      entity: 'medicine_batch',
      entity_id: saved.id,
      previous_value: { batch_quantity: previousQty, current_stock: Number(medicine.current_stock) || 0 },
      new_value: {
        medicine_id: medicineId,
        batch_number: batchNumber,
        quantity_added: quantity,
        batch_quantity: Number(saved.quantity_available),
        current_stock: Number(updatedMedicine.current_stock),
        movement_id: movement.id,
      },
    }, params, deviceId);

    return {
      success: true,
      medicine: toMedicineStockDto(updatedMedicine),
      batch: toBatchDto(saved, medicine.name),
      movement,
      added_quantity: quantity,
    };
  });
}

export interface AdminRemoveStockParams extends StockActor {
  medicine_id: string;
  batch_id: string;
  quantity: number;
  reason: string;
  notes?: string;
}

export async function adminRemoveStock(params: AdminRemoveStockParams) {
  const medicineId = requireUuid(params.medicine_id, 'medicine_id');
  const batchId = requireUuid(params.batch_id, 'batch_id');
  const quantity = requireWholeNumber(params.quantity, 'quantity', { allowZero: false });
  const reason = (params.reason || 'DAMAGE').trim();

  return withTransaction(async (client) => {
    const deviceId = await resolveDeviceId(client, params.device_id);
    const medicine = await lockMedicine(client, medicineId);
    const batch = await lockBatch(client, batchId, medicineId);
    const previousQty = Number(batch.quantity_available) || 0;

    if (quantity > previousQty) {
      throw new HttpError(400, `Cannot remove ${quantity} units. Batch only has ${previousQty} units available.`);
    }

    const newQty = previousQty - quantity;
    const upd = await client.query(`
      UPDATE medicine_batches
      SET quantity_available = $1, status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [newQty, deriveBatchStatus(newQty, batch.expiry_date, batch.status), batchId]);
    const saved = upd.rows[0];

    const updatedMedicine = await reconcileMedicineStock(client, medicineId);
    const movement = await insertMovement(client, {
      medicine_id: medicineId,
      batch_id: batchId,
      previous_quantity: previousQty,
      new_quantity: newQty,
      movement_type: reason.toUpperCase().replace(/\s+/g, '_').slice(0, 50),
      reason: reason.slice(0, 100),
      notes: params.notes?.trim() || `Admin removed ${quantity} units (${reason})`,
    }, params, deviceId);

    await insertAudit(client, {
      action: 'ADMIN_REMOVE_STOCK',
      entity: 'medicine_batch',
      entity_id: batchId,
      previous_value: { batch_quantity: previousQty, current_stock: Number(medicine.current_stock) || 0 },
      new_value: {
        removed_quantity: quantity,
        batch_quantity: newQty,
        current_stock: Number(updatedMedicine.current_stock),
        reason,
        notes: params.notes,
        movement_id: movement.id,
      },
    }, params, deviceId);

    return {
      success: true,
      medicine: toMedicineStockDto(updatedMedicine),
      batch: toBatchDto(saved, medicine.name),
      movement,
      removed_quantity: quantity,
    };
  });
}

export interface AdminEditExpiryParams extends StockActor {
  batch_id: string;
  expiry_date: string | null;
}

export async function adminEditBatchExpiry(params: AdminEditExpiryParams) {
  const batchId = requireUuid(params.batch_id, 'batch_id');
  const expiryDate = normalizeExpiryDate(params.expiry_date);
  const expiryStatus = deriveExpiryStatus(expiryDate);

  return withTransaction(async (client) => {
    const deviceId = await resolveDeviceId(client, params.device_id);
    const found = await client.query('SELECT medicine_id FROM medicine_batches WHERE id = $1', [batchId]);
    if (found.rows.length === 0) throw new HttpError(404, `Batch ${batchId} not found.`);
    const medicineId = found.rows[0].medicine_id;

    const medicine = await lockMedicine(client, medicineId);
    const previous = await lockBatch(client, batchId, medicineId);
    const qty = Number(previous.quantity_available) || 0;
    const newStatus = deriveBatchStatus(qty, expiryDate, previous.status);

    const upd = await client.query(`
      UPDATE medicine_batches
      SET expiry_date = $1, expiry_status = $2, status = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [expiryDate, expiryStatus, newStatus, batchId]);
    const saved = upd.rows[0];

    const updatedMedicine = await reconcileMedicineStock(client, medicineId);

    await insertAudit(client, {
      action: 'ADMIN_EDIT_EXPIRY',
      entity: 'medicine_batch',
      entity_id: batchId,
      previous_value: { expiry_date: previous.expiry_date, expiry_status: previous.expiry_status, status: previous.status },
      new_value: { expiry_date: expiryDate, expiry_status: expiryStatus, status: newStatus },
    }, params, deviceId);

    return {
      success: true,
      medicine: toMedicineStockDto(updatedMedicine),
      batch: toBatchDto(saved, medicine.name),
    };
  });
}

export interface PhysicalCountBatchInput {
  batch_id?: string;
  batch_number: string;
  quantity: number;
  expiry_date?: string | null;
  expiry_status?: 'KNOWN' | 'UNKNOWN' | 'EXPIRED';
  supplier_id?: string;
  purchase_price?: number;
  selling_price_override?: number;
}

export interface AdminPhysicalStockCountParams extends StockActor {
  medicine_id: string;
  counts: PhysicalCountBatchInput[];
  notes?: string;
}

/**
 * ADMIN direct physical stock count. The counted quantity per batch is authoritative and is
 * applied immediately (no approval step). Each batch must be counted explicitly — quantities are
 * never distributed across batches.
 */
export async function adminPhysicalStockCount(params: AdminPhysicalStockCountParams) {
  const medicineId = requireUuid(params.medicine_id, 'medicine_id');
  const { counts, notes } = params;
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new HttpError(400, 'At least one batch physical count must be provided.');
  }

  const parsed = counts.map((c) => ({
    batchId: c.batch_id ? requireUuid(c.batch_id, 'batch_id') : undefined,
    batchNumber: (c.batch_number || '').trim().toUpperCase(),
    quantity: requireWholeNumber(c.quantity, `Physical quantity for batch "${c.batch_number}"`, { allowZero: true }),
    // Only overwrite expiry when the client explicitly sent the field.
    expiryProvided: c.expiry_date !== undefined,
    expiryDate: normalizeExpiryDate(c.expiry_date),
    purchasePrice: c.purchase_price,
    sellingPriceOverride: c.selling_price_override,
  }));
  for (const p of parsed) {
    if (!p.batchId && !p.batchNumber) throw new HttpError(400, 'Each new batch count requires a batch number.');
  }
  const seen = new Set<string>();
  for (const p of parsed) {
    const key = p.batchId || `num:${p.batchNumber}`;
    if (seen.has(key)) throw new HttpError(400, `Batch "${p.batchNumber || p.batchId}" was counted twice.`);
    seen.add(key);
  }

  return withTransaction(async (client) => {
    const deviceId = await resolveDeviceId(client, params.device_id);
    const medicine = await lockMedicine(client, medicineId);
    const previousTotal = Number(medicine.current_stock) || 0;

    const updatedBatches: any[] = [];
    const movements: any[] = [];

    for (const p of parsed) {
      let existing: any = null;
      if (p.batchId) {
        existing = await lockBatch(client, p.batchId, medicineId);
      } else {
        const r = await client.query(
          'SELECT * FROM medicine_batches WHERE medicine_id = $1 AND UPPER(batch_number) = $2 FOR UPDATE',
          [medicineId, p.batchNumber]
        );
        existing = r.rows[0] || null;
      }

      let previousQty = 0;
      let saved: any;
      if (existing) {
        previousQty = Number(existing.quantity_available) || 0;
        const effectiveExpiry = p.expiryProvided ? p.expiryDate : existing.expiry_date;
        const upd = await client.query(`
          UPDATE medicine_batches
          SET quantity_available = $1, expiry_date = $2, expiry_status = $3, status = $4,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $5
          RETURNING *
        `, [
          p.quantity, effectiveExpiry, deriveExpiryStatus(effectiveExpiry),
          deriveBatchStatus(p.quantity, effectiveExpiry, existing.status), existing.id,
        ]);
        saved = upd.rows[0];
      } else {
        const ins = await client.query(`
          INSERT INTO medicine_batches (
            id, medicine_id, batch_number, quantity_received, quantity_available,
            purchase_price, selling_price_override, expiry_date, expiry_status,
            received_date, status, created_at
          ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          RETURNING *
        `, [
          crypto.randomUUID(), medicineId, p.batchNumber, p.quantity,
          p.purchasePrice ?? (Number(medicine.purchase_price) || 0),
          p.sellingPriceOverride ?? null, p.expiryDate, deriveExpiryStatus(p.expiryDate),
          localDateStr(), deriveBatchStatus(p.quantity, p.expiryDate),
        ]);
        saved = ins.rows[0];
      }

      updatedBatches.push(saved);
      const movement = await insertMovement(client, {
        medicine_id: medicineId,
        batch_id: saved.id,
        previous_quantity: previousQty,
        new_quantity: p.quantity,
        movement_type: 'PHYSICAL_STOCK_COUNT',
        reason: 'PHYSICAL_STOCK_COUNT',
        notes: notes?.trim() || `Admin direct physical stock count (batch ${saved.batch_number})`,
      }, params, deviceId);
      movements.push({ ...movement, batch_number: saved.batch_number });
    }

    const updatedMedicine = await reconcileMedicineStock(client, medicineId);
    const newTotal = Number(updatedMedicine.current_stock) || 0;

    await insertAudit(client, {
      action: 'ADMIN_PHYSICAL_STOCK_COUNT',
      entity: 'medicine',
      entity_id: medicineId,
      previous_value: { current_stock: previousTotal },
      new_value: { current_stock: newTotal, delta: newTotal - previousTotal, batches: movements, notes },
    }, params, deviceId);

    return {
      success: true,
      medicine: toMedicineStockDto(updatedMedicine),
      batches: updatedBatches.map((b) => toBatchDto(b, medicine.name)),
      movements,
      total_stock: newTotal,
      previous_stock: previousTotal,
      delta: newTotal - previousTotal,
    };
  });
}

