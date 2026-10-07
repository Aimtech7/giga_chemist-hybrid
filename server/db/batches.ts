import { pgPool, requireUuid, type Queryable } from './client';
import type { MedicineBatch } from '../../src/types';

/**
 * Read-only batch queries. Batches are created and changed ONLY by the audited, transactional
 * stock operations (inventory.ts), purchases, sales, returns and voids — never by a generic upsert.
 * DATE columns arrive as 'YYYY-MM-DD' strings (type parser in client.ts).
 */
const BATCH_SELECT = `
  SELECT b.id, b.branch_id, b.medicine_id, COALESCE(m.name, 'Pharmaceutical Item') AS medicine_name,
         b.batch_number, b.supplier_id, COALESCE(s.name, '') AS supplier_name,
         COALESCE(b.quantity_received, 0)::int AS quantity_received,
         COALESCE(b.quantity_available, 0)::int AS quantity_available,
         COALESCE(b.purchase_price, 0)::float AS purchase_price,
         b.selling_price_override::float AS selling_price_override,
         b.manufacturing_date, b.expiry_date, b.received_date, b.purchase_invoice, b.expiry_status,
         COALESCE(b.status, 'active') AS status, b.created_at
  FROM medicine_batches b
  LEFT JOIN medicines m ON b.medicine_id = m.id
  LEFT JOIN suppliers s ON b.supplier_id = s.id`;

function toBatch(r: any): MedicineBatch {
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    medicine_id: r.medicine_id,
    medicine_name: r.medicine_name,
    batch_number: r.batch_number,
    supplier_id: r.supplier_id || '',
    supplier_name: r.supplier_name || '',
    quantity_received: Number(r.quantity_received) || 0,
    quantity_available: Number(r.quantity_available) || 0,
    purchase_price: Number(r.purchase_price) || 0,
    selling_price_override: r.selling_price_override != null ? Number(r.selling_price_override) : undefined,
    manufacturing_date: r.manufacturing_date || '',
    expiry_date: r.expiry_date || '',
    expiry_status: r.expiry_status || (r.expiry_date ? 'KNOWN' : 'UNKNOWN'),
    received_date: r.received_date || '',
    purchase_invoice: r.purchase_invoice || '',
    created_by: 'Admin',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    status: r.status || 'active',
  } as MedicineBatch;
}

export async function getAllBatches(q: Queryable = pgPool): Promise<MedicineBatch[]> {
  const res = await q.query(`${BATCH_SELECT} ORDER BY b.expiry_date ASC NULLS LAST, b.created_at ASC`);
  return res.rows.map(toBatch);
}

export async function getBatchesByMedicine(medicineId: string): Promise<MedicineBatch[]> {
  const res = await pgPool.query(`${BATCH_SELECT} WHERE b.medicine_id = $1 ORDER BY b.expiry_date ASC NULLS LAST`, [
    requireUuid(medicineId, 'medicine id'),
  ]);
  return res.rows.map(toBatch);
}
