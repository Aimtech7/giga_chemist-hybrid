import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import type { Supplier } from '../../src/types';

export async function getAllSuppliers(): Promise<Supplier[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        id, name, contact_person, phone, email, address, tax_pin,
        COALESCE(balance, 0)::float as balance,
        COALESCE(status, 'active') as status,
        created_at
      FROM suppliers
      ORDER BY name ASC
    `);
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        contact_person: r.contact_person || '',
        phone: r.phone || '',
        email: r.email || '',
        address: r.address || '',
        tax_pin: r.tax_pin || undefined,
        balance: Number(r.balance) || 0,
        status: r.status || 'active',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('suppliers')
        .select('*')
        .order('name');
      if (!error && data && data.length > 0) return data as Supplier[];
    } catch (err) {}
  }
  return serverDb.get().suppliers;
}

export async function upsertSupplier(supplier: Partial<Supplier> & { name: string }): Promise<Supplier> {
  const now = new Date().toISOString();
  const id = supplier.id || `sup-${Date.now()}`;
  const fullSupplier: Supplier = {
    id,
    name: supplier.name,
    contact_person: supplier.contact_person || '',
    phone: supplier.phone || '',
    email: supplier.email || '',
    address: supplier.address || '',
    tax_pin: supplier.tax_pin || '',
    balance: Number(supplier.balance) || 0,
    status: supplier.status || 'active',
    created_at: supplier.created_at || now,
  };

  try {
    await pgPool.query(`
      INSERT INTO suppliers (id, name, contact_person, phone, email, address, tax_pin, balance, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        contact_person = EXCLUDED.contact_person,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        address = EXCLUDED.address,
        tax_pin = EXCLUDED.tax_pin,
        balance = EXCLUDED.balance,
        status = EXCLUDED.status
    `, [
      fullSupplier.id, fullSupplier.name, fullSupplier.contact_person, fullSupplier.phone,
      fullSupplier.email, fullSupplier.address, fullSupplier.tax_pin, fullSupplier.balance,
      fullSupplier.status, fullSupplier.created_at
    ]);
  } catch (pgErr) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('suppliers').upsert(fullSupplier);
    } catch (err) {}
  }

  const store = serverDb.get();
  const index = store.suppliers.findIndex((s) => s.id === fullSupplier.id);
  if (index >= 0) {
    store.suppliers[index] = fullSupplier;
  } else {
    store.suppliers.push(fullSupplier);
  }
  serverDb.persist();
  return fullSupplier;
}
