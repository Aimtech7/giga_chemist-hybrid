import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import type { Customer } from '../../src/types';

export async function getAllCustomers(): Promise<Customer[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        id, branch_id, name, phone, email, address, notes,
        COALESCE(credit_balance, 0)::float as credit_balance,
        COALESCE(total_spent, 0)::float as total_spent,
        last_visit, created_at
      FROM customers
      ORDER BY name ASC
    `);
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        name: r.name,
        phone: r.phone || '',
        email: r.email || '',
        address: r.address || '',
        notes: r.notes || '',
        credit_balance: Number(r.credit_balance) || 0,
        total_spent: Number(r.total_spent) || 0,
        last_visit: r.last_visit ? new Date(r.last_visit).toISOString() : undefined,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('*')
        .order('name');
      if (!error && data && data.length > 0) return data as Customer[];
    } catch (err) {}
  }
  return serverDb.get().customers;
}

export async function upsertCustomer(customer: Partial<Customer> & { name: string }): Promise<Customer> {
  const now = new Date().toISOString();
  const id = customer.id || `cus-${Date.now()}`;
  const fullCustomer: Customer = {
    id,
    name: customer.name,
    phone: customer.phone || '',
    email: customer.email || '',
    address: customer.address || '',
    notes: customer.notes || '',
    credit_balance: Number(customer.credit_balance) || 0,
    total_spent: Number(customer.total_spent) || 0,
    created_at: customer.created_at || now,
    last_visit: customer.last_visit || now,
  };

  try {
    await pgPool.query(`
      INSERT INTO customers (id, name, phone, email, address, notes, credit_balance, total_spent, created_at, last_visit)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        address = EXCLUDED.address,
        notes = EXCLUDED.notes,
        credit_balance = EXCLUDED.credit_balance,
        total_spent = EXCLUDED.total_spent,
        last_visit = EXCLUDED.last_visit
    `, [
      fullCustomer.id, fullCustomer.name, fullCustomer.phone, fullCustomer.email,
      fullCustomer.address, fullCustomer.notes, fullCustomer.credit_balance,
      fullCustomer.total_spent, fullCustomer.created_at, fullCustomer.last_visit
    ]);
  } catch (pgErr) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('customers').upsert(fullCustomer);
    } catch (err) {}
  }

  const store = serverDb.get();
  const index = store.customers.findIndex((c) => c.id === fullCustomer.id);
  if (index >= 0) {
    store.customers[index] = fullCustomer;
  } else {
    store.customers.push(fullCustomer);
  }
  serverDb.persist();
  return fullCustomer;
}
