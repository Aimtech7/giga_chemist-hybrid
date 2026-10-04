import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured, cleanUuid, ensureUuid } from './client';
import { serverDb } from '../db';
import type { MedicineBatch } from '../../src/types';

export async function getAllBatches(): Promise<MedicineBatch[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        b.id,
        b.branch_id,
        b.medicine_id,
        COALESCE(m.name, 'Pharmaceutical Item') as medicine_name,
        b.batch_number,
        b.supplier_id,
        COALESCE(s.name, 'Default Supplier') as supplier_name,
        COALESCE(b.quantity_received, 0)::int as quantity_received,
        COALESCE(b.quantity_available, 0)::int as quantity_available,
        COALESCE(b.purchase_price, 0)::float as purchase_price,
        b.selling_price_override::float as selling_price_override,
        b.manufacturing_date,
        b.expiry_date,
        b.received_date,
        b.purchase_invoice,
        b.expiry_status,
        COALESCE(b.status, 'active') as status,
        b.created_at
      FROM medicine_batches b
      LEFT JOIN medicines m ON b.medicine_id = m.id
      LEFT JOIN suppliers s ON b.supplier_id = s.id
      ORDER BY b.expiry_date ASC NULLS LAST
    `);

    if (isLocalMode || (res.rows && res.rows.length > 0)) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        medicine_id: r.medicine_id,
        medicine_name: r.medicine_name,
        batch_number: r.batch_number,
        supplier_id: r.supplier_id || '',
        supplier_name: r.supplier_name,
        quantity_received: Number(r.quantity_received) || 0,
        quantity_available: Number(r.quantity_available) || 0,
        purchase_price: Number(r.purchase_price) || 0,
        selling_price_override: r.selling_price_override ? Number(r.selling_price_override) : undefined,
        manufacturing_date: r.manufacturing_date ? new Date(r.manufacturing_date).toISOString().split('T')[0] : '',
        expiry_date: r.expiry_date ? new Date(r.expiry_date).toISOString().split('T')[0] : '',
        expiry_status: r.expiry_status || (r.expiry_date ? 'KNOWN' : 'UNKNOWN'),
        received_date: r.received_date ? new Date(r.received_date).toISOString().split('T')[0] : '',
        purchase_invoice: r.purchase_invoice || '',
        created_by: 'Admin',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        status: r.status || 'active',
      }));
    }
  } catch (err: any) {
    if (isLocalMode) {
      console.error('[Server DB] getAllBatches PostgreSQL error:', err.message);
      throw err;
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('medicine_batches')
        .select('*')
        .order('expiry_date', { ascending: true });
      if (!error && data && data.length > 0) return data as MedicineBatch[];
    } catch (err) {}
  }

  return serverDb.get().medicine_batches;
}

export async function getBatchesByMedicine(medicineId: string): Promise<MedicineBatch[]> {
  try {
    const res = await pgPool.query(
      `SELECT b.*, COALESCE(m.name, 'Pharmaceutical Item') as medicine_name, COALESCE(s.name, 'Default Supplier') as supplier_name
       FROM medicine_batches b
       LEFT JOIN medicines m ON b.medicine_id = m.id
       LEFT JOIN suppliers s ON b.supplier_id = s.id
       WHERE b.medicine_id::text = $1
       ORDER BY b.expiry_date ASC NULLS LAST`,
      [medicineId]
    );
    if (isLocalMode || (res.rows && res.rows.length > 0)) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        medicine_id: r.medicine_id,
        medicine_name: r.medicine_name,
        batch_number: r.batch_number,
        supplier_id: r.supplier_id || '',
        supplier_name: r.supplier_name,
        quantity_received: Number(r.quantity_received) || 0,
        quantity_available: Number(r.quantity_available) || 0,
        purchase_price: Number(r.purchase_price) || 0,
        selling_price_override: r.selling_price_override ? Number(r.selling_price_override) : undefined,
        manufacturing_date: r.manufacturing_date ? new Date(r.manufacturing_date).toISOString().split('T')[0] : '',
        expiry_date: r.expiry_date ? new Date(r.expiry_date).toISOString().split('T')[0] : '',
        expiry_status: r.expiry_status || (r.expiry_date ? 'KNOWN' : 'UNKNOWN'),
        received_date: r.received_date ? new Date(r.received_date).toISOString().split('T')[0] : '',
        purchase_invoice: r.purchase_invoice || '',
        created_by: 'Admin',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        status: r.status || 'active',
      }));
    }
  } catch (pgErr: any) {
    if (isLocalMode) {
      console.error('[Server DB] getBatchesByMedicine PostgreSQL error:', pgErr.message);
      throw pgErr;
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('medicine_batches')
        .select('*')
        .eq('medicine_id', medicineId)
        .order('expiry_date', { ascending: true });
      if (!error && data) return data as MedicineBatch[];
    } catch (err) {}
  }

  return serverDb.get().medicine_batches.filter((b) => b.medicine_id === medicineId);
}

export async function upsertBatch(batch: Partial<MedicineBatch> & { medicine_id: string; batch_number: string }): Promise<MedicineBatch> {
  const now = new Date().toISOString();
  const id = ensureUuid(batch.id);
  const fullBatch: MedicineBatch = {
    id,
    medicine_id: batch.medicine_id,
    medicine_name: batch.medicine_name || 'Pharmaceutical Item',
    batch_number: batch.batch_number,
    quantity_received: Number(batch.quantity_received) || 0,
    quantity_available: Number(batch.quantity_available) || 0,
    purchase_price: Number(batch.purchase_price) || 0,
    selling_price_override: batch.selling_price_override,
    manufacturing_date: batch.manufacturing_date || now.split('T')[0],
    expiry_date: batch.expiry_date || '',
    received_date: batch.received_date || now.split('T')[0],
    purchase_invoice: batch.purchase_invoice || '',
    supplier_id: batch.supplier_id || '',
    supplier_name: batch.supplier_name || 'Default Supplier',
    created_by: batch.created_by || 'Admin',
    created_at: batch.created_at || now,
    status: batch.status || 'active',
  };

  try {
    await pgPool.query(`
      INSERT INTO medicine_batches (
        id, medicine_id, batch_number, supplier_id,
        quantity_received, quantity_available, purchase_price,
        selling_price_override, manufacturing_date, expiry_date,
        received_date, purchase_invoice, status, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      )
      ON CONFLICT (medicine_id, batch_number) DO UPDATE SET
        quantity_available = EXCLUDED.quantity_available,
        purchase_price = EXCLUDED.purchase_price,
        status = EXCLUDED.status,
        expiry_date = EXCLUDED.expiry_date
    `, [
      fullBatch.id, fullBatch.medicine_id, fullBatch.batch_number, cleanUuid(fullBatch.supplier_id),
      fullBatch.quantity_received, fullBatch.quantity_available, fullBatch.purchase_price,
      fullBatch.selling_price_override || null, fullBatch.manufacturing_date || null,
      fullBatch.expiry_date || null, fullBatch.received_date || null, fullBatch.purchase_invoice,
      fullBatch.status, fullBatch.created_at
    ]);
  } catch (pgErr: any) {
    console.error('[Server DB] upsertBatch PostgreSQL error:', pgErr.message);
    if (isLocalMode) {
      throw pgErr;
    }
  }


  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('medicine_batches').upsert(fullBatch);
    } catch (err) {}
  }

  const store = serverDb.get();
  const index = store.medicine_batches.findIndex((b) => b.id === fullBatch.id);
  if (index >= 0) {
    store.medicine_batches[index] = fullBatch;
  } else {
    store.medicine_batches.push(fullBatch);
  }
  serverDb.persist();
  return fullBatch;
}
