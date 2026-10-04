import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured, cleanUuid, ensureUuid } from './client';
import { serverDb } from '../db';
import { recordAuditLog } from './audit';
import type { Medicine, UserRole } from '../../src/types';


export async function getAllMedicines(): Promise<Medicine[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        m.id,
        m.branch_id,
        m.name,
        m.generic_name,
        m.brand_name,
        m.sku,
        m.barcode,
        COALESCE(c.name, m.medicine_type, 'General') as category,
        m.medicine_type,
        m.dosage_strength,
        m.dosage_form,
        m.manufacturer,
        m.description,
        COALESCE(m.purchase_price, 0)::float as purchase_price,
        COALESCE(m.selling_price, 0)::float as selling_price,
        COALESCE(m.wholesale_price, m.selling_price, 0)::float as wholesale_price,
        COALESCE(m.min_selling_price, m.selling_price, 0)::float as min_selling_price,
        COALESCE(m.current_stock, 0)::int as current_stock,
        COALESCE(m.reorder_level, 20)::int as reorder_level,
        COALESCE(m.unit, 'Strips (10 tabs)') as unit,
        COALESCE(m.prescription_required, false) as prescription_required,
        COALESCE(m.status, 'active') as status,
        COALESCE(m.version, 1)::int as version,
        m.created_at,
        m.updated_at
      FROM medicines m
      LEFT JOIN categories c ON m.category_id = c.id
      ORDER BY m.name ASC
    `);

    if (isLocalMode || (res.rows && res.rows.length > 0)) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
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
        wholesale_price: Number(r.wholesale_price) || 0,
        min_selling_price: Number(r.min_selling_price) || 0,
        current_stock: Number(r.current_stock) || 0,
        reorder_level: Number(r.reorder_level) || 20,
        unit: r.unit || 'Strips (10 tabs)',
        prescription_required: Boolean(r.prescription_required),
        status: r.status || 'active',
        version: Number(r.version) || 1,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
        created_by: 'Admin',
        updated_by: 'Admin',
      }));
    }
  } catch (err: any) {
    if (isLocalMode) {
      console.error('[Server DB] getAllMedicines PostgreSQL error:', err.message);
      throw err;
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('medicines')
        .select('*')
        .order('name');
      if (!error && data && data.length > 0) return data as Medicine[];
    } catch (err) {}
  }

  return serverDb.get().medicines;
}

export async function getMedicineById(id: string): Promise<Medicine | null> {
  try {
    const res = await pgPool.query(
      `SELECT m.*, COALESCE(c.name, 'General') as category_name 
       FROM medicines m 
       LEFT JOIN categories c ON m.category_id = c.id 
       WHERE m.id::text = $1 LIMIT 1`,
      [id]
    );
    if (res.rows && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        branch_id: r.branch_id,
        name: r.name,
        generic_name: r.generic_name || r.name,
        brand_name: r.brand_name || '',
        sku: r.sku || '',
        barcode: r.barcode || '',
        category: r.category_name || r.category || 'General',
        medicine_type: r.medicine_type || '',
        dosage_strength: r.dosage_strength || '',
        dosage_form: r.dosage_form || 'Tablet',
        manufacturer: r.manufacturer || '',
        description: r.description || '',
        purchase_price: Number(r.purchase_price) || 0,
        selling_price: Number(r.selling_price) || 0,
        wholesale_price: Number(r.wholesale_price) || 0,
        min_selling_price: Number(r.min_selling_price) || 0,
        current_stock: Number(r.current_stock) || 0,
        reorder_level: Number(r.reorder_level) || 20,
        unit: r.unit || 'Strips (10 tabs)',
        prescription_required: Boolean(r.prescription_required),
        status: r.status || 'active',
        version: Number(r.version) || 1,
        created_at: r.created_at,
        updated_at: r.updated_at,
        created_by: 'Admin',
        updated_by: 'Admin',
      };
    }
  } catch (pgErr: any) {
    if (isLocalMode) {
      console.error('[Server DB] getMedicineById PostgreSQL error:', pgErr.message);
      throw pgErr;
    }
  }
  if (isLocalMode) return null;

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('medicines')
        .select('*')
        .eq('id', id)
        .single();
      if (!error && data) return data as Medicine;
    } catch (err) {}
  }

  return serverDb.get().medicines.find((m) => m.id === id) || null;
}

export async function upsertMedicine(medicine: Partial<Medicine> & { name: string }): Promise<Medicine> {
  const now = new Date().toISOString();
  const id = ensureUuid(medicine.id);
  const fullMed: Medicine = {
    id,
    name: medicine.name,
    generic_name: medicine.generic_name || medicine.name,
    brand_name: medicine.brand_name || '',
    sku: medicine.sku || `SKU-${Date.now().toString().slice(-6)}`,
    barcode: medicine.barcode || `${Math.floor(100000000000 + Math.random() * 900000000000)}`,
    category: medicine.category || 'General',
    medicine_type: medicine.medicine_type || '',
    dosage_strength: medicine.dosage_strength || '',
    dosage_form: medicine.dosage_form || 'Tablet',
    manufacturer: medicine.manufacturer || '',
    description: medicine.description || '',
    purchase_price: Number(medicine.purchase_price) || 0,
    selling_price: Number(medicine.selling_price) || 0,
    wholesale_price: Number(medicine.wholesale_price) || Number(medicine.selling_price) || 0,
    min_selling_price: Number(medicine.min_selling_price) || Number(medicine.selling_price) || 0,
    current_stock: Number(medicine.current_stock) || 0,
    reorder_level: Number(medicine.reorder_level) || 20,
    unit: medicine.unit || 'Strips (10 tabs)',
    prescription_required: Boolean(medicine.prescription_required),
    status: medicine.status || 'active',
    version: (medicine.version || 0) + 1,
    created_at: medicine.created_at || now,
    updated_at: now,
    created_by: medicine.created_by || 'Admin',
    updated_by: medicine.updated_by || 'Admin',
  };

  try {
    await pgPool.query(`
      INSERT INTO medicines (
        id, name, generic_name, brand_name, sku, barcode,
        medicine_type, dosage_strength, dosage_form, manufacturer,
        description, purchase_price, selling_price, wholesale_price,
        min_selling_price, current_stock, reorder_level, unit,
        prescription_required, status, version, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        generic_name = EXCLUDED.generic_name,
        brand_name = EXCLUDED.brand_name,
        sku = EXCLUDED.sku,
        barcode = EXCLUDED.barcode,
        medicine_type = EXCLUDED.medicine_type,
        dosage_strength = EXCLUDED.dosage_strength,
        dosage_form = EXCLUDED.dosage_form,
        manufacturer = EXCLUDED.manufacturer,
        description = EXCLUDED.description,
        purchase_price = EXCLUDED.purchase_price,
        selling_price = EXCLUDED.selling_price,
        wholesale_price = EXCLUDED.wholesale_price,
        min_selling_price = EXCLUDED.min_selling_price,
        current_stock = EXCLUDED.current_stock,
        reorder_level = EXCLUDED.reorder_level,
        unit = EXCLUDED.unit,
        prescription_required = EXCLUDED.prescription_required,
        status = EXCLUDED.status,
        version = EXCLUDED.version,
        updated_at = EXCLUDED.updated_at
    `, [
      fullMed.id, fullMed.name, fullMed.generic_name, fullMed.brand_name, fullMed.sku, fullMed.barcode,
      fullMed.medicine_type, fullMed.dosage_strength, fullMed.dosage_form, fullMed.manufacturer,
      fullMed.description, fullMed.purchase_price, fullMed.selling_price, fullMed.wholesale_price,
      fullMed.min_selling_price, fullMed.current_stock, fullMed.reorder_level, fullMed.unit,
      fullMed.prescription_required, fullMed.status, fullMed.version, fullMed.created_at, fullMed.updated_at
    ]);
  } catch (pgErr: any) {
    console.error('[Server DB] upsertMedicine PostgreSQL error:', pgErr.message);
    if (isLocalMode) {
      throw pgErr;
    }
  }


  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('medicines').upsert(fullMed);
    } catch (err) {}
  }

  // Update in-memory fallback
  const store = serverDb.get();
  const index = store.medicines.findIndex((m) => m.id === fullMed.id);
  if (index >= 0) {
    store.medicines[index] = fullMed;
  } else {
    store.medicines.push(fullMed);
  }
  serverDb.persist();
  return fullMed;
}

export interface UpdatePricingParams {
  id: string;
  selling_price?: number;
  purchase_price?: number;
  min_selling_price?: number;
  wholesale_price?: number;
  reorder_level?: number;
  user_id?: string;
  user_name?: string;
  role?: string;
  device_id?: string;
}

export async function adminUpdateMedicinePricing(params: UpdatePricingParams): Promise<Medicine> {
  const { id } = params;
  if (!id) {
    throw new Error('Medicine ID is required.');
  }

  // Domain & numerical validation
  if (params.selling_price !== undefined) {
    const sp = Number(params.selling_price);
    if (isNaN(sp) || !isFinite(sp)) {
      throw new Error('Selling price must be a valid numeric value.');
    }
    if (sp < 0) {
      throw new Error('Selling price cannot be negative.');
    }
  }

  if (params.purchase_price !== undefined) {
    const pp = Number(params.purchase_price);
    if (isNaN(pp) || !isFinite(pp)) {
      throw new Error('Purchase/cost price must be a valid numeric value.');
    }
    if (pp < 0) {
      throw new Error('Purchase/cost price cannot be negative.');
    }
  }

  if (params.min_selling_price !== undefined) {
    const msp = Number(params.min_selling_price);
    if (isNaN(msp) || !isFinite(msp) || msp < 0) {
      throw new Error('Minimum selling price must be a non-negative numeric value.');
    }
  }

  if (params.wholesale_price !== undefined) {
    const wp = Number(params.wholesale_price);
    if (isNaN(wp) || !isFinite(wp) || wp < 0) {
      throw new Error('Wholesale price must be a non-negative numeric value.');
    }
  }

  if (params.reorder_level !== undefined) {
    const rl = Number(params.reorder_level);
    if (isNaN(rl) || !isFinite(rl) || rl < 0) {
      throw new Error('Reorder level must be a non-negative integer.');
    }
  }

  // Fetch current medicine record
  const existing = await getMedicineById(id);
  if (!existing) {
    throw new Error(`Medicine with ID "${id}" was not found.`);
  }

  const old_selling_price = existing.selling_price;
  const old_purchase_price = existing.purchase_price;
  const old_reorder_level = existing.reorder_level;

  const new_selling_price = params.selling_price !== undefined ? Math.round(Number(params.selling_price) * 100) / 100 : existing.selling_price;
  const new_purchase_price = params.purchase_price !== undefined ? Math.round(Number(params.purchase_price) * 100) / 100 : existing.purchase_price;
  const new_min_selling_price = params.min_selling_price !== undefined ? Math.round(Number(params.min_selling_price) * 100) / 100 : existing.min_selling_price;
  const new_wholesale_price = params.wholesale_price !== undefined ? Math.round(Number(params.wholesale_price) * 100) / 100 : existing.wholesale_price;
  const new_reorder_level = params.reorder_level !== undefined ? Math.max(0, parseInt(String(params.reorder_level), 10)) : existing.reorder_level;

  const updatedMed: Medicine = {
    ...existing,
    selling_price: new_selling_price,
    purchase_price: new_purchase_price,
    min_selling_price: new_min_selling_price,
    wholesale_price: new_wholesale_price,
    reorder_level: new_reorder_level,
    version: (existing.version || 1) + 1,
    updated_at: new Date().toISOString(),
    updated_by: params.user_name || 'Admin',
  };

  // 1. PostgreSQL ACID Update
  try {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE medicines
        SET selling_price = $1,
            purchase_price = $2,
            min_selling_price = $3,
            wholesale_price = $4,
            reorder_level = $5,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id::text = $6
      `, [
        new_selling_price,
        new_purchase_price,
        new_min_selling_price,
        new_wholesale_price,
        new_reorder_level,
        id,
      ]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (pgErr) {}

  // 2. Audit Logging
  await recordAuditLog({
    user_id: params.user_id || 'admin',
    user_name: params.user_name || 'Admin',
    role: (params.role as UserRole) || 'ADMIN',
    action: 'ADMIN_PRICE_UPDATE',
    entity: 'medicine',
    entity_id: id,
    device_id: params.device_id || 'SERVER',
    previous_value: JSON.stringify({
      purchase_price: old_purchase_price,
      selling_price: old_selling_price,
      reorder_level: old_reorder_level,
    }),
    new_value: JSON.stringify({
      medicine_id: id,
      medicine_name: existing.name,
      old_purchase_price,
      new_purchase_price,
      old_selling_price,
      new_selling_price,
      old_reorder_level,
      new_reorder_level,
      performed_by: params.user_name || 'Admin',
    }),
  });

  // 3. In-memory fallback
  const store = serverDb.get();
  const idx = store.medicines.findIndex((m) => m.id === id);
  if (idx >= 0) {
    store.medicines[idx] = updatedMed;
  }
  serverDb.persist();

  return updatedMed;
}

