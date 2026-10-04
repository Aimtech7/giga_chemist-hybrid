import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import type { Expense } from '../../src/types';

export async function getAllExpenses(): Promise<Expense[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        e.id, e.branch_id, e.category, e.description,
        COALESCE(e.amount, 0)::float as amount,
        e.payment_method, e.reference, e.user_id, u.name as user_name,
        e.date, e.created_at
      FROM expenses e
      LEFT JOIN users u ON e.user_id = u.id
      ORDER BY e.date DESC, e.created_at DESC
    `);
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        category: r.category,
        description: r.description,
        amount: Number(r.amount) || 0,
        payment_method: r.payment_method,
        reference: r.reference || undefined,
        user_id: r.user_id,
        user_name: r.user_name || 'Staff',
        date: r.date ? new Date(r.date).toISOString().split('T')[0] : '',
        sync_status: 'synced',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('expenses')
        .select('*')
        .order('date', { ascending: false });
      if (!error && data) return data as Expense[];
    } catch (err) {
      console.warn('[Server DB] Supabase expenses query failed:', err);
    }
  }
  return serverDb.get().expenses;
}

export async function recordExpense(expense: Expense): Promise<Expense> {
  const processedExpense: Expense = {
    ...expense,
    id: expense.id || `exp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    created_at: expense.created_at || new Date().toISOString(),
    sync_status: 'synced',
  };

  try {
    await pgPool.query(`
      INSERT INTO expenses (id, category, description, amount, payment_method, reference, user_id, date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        category = EXCLUDED.category,
        description = EXCLUDED.description,
        amount = EXCLUDED.amount,
        payment_method = EXCLUDED.payment_method,
        reference = EXCLUDED.reference
    `, [
      processedExpense.id,
      processedExpense.category,
      processedExpense.description,
      processedExpense.amount,
      processedExpense.payment_method,
      processedExpense.reference || null,
      processedExpense.user_id || null,
      processedExpense.date,
    ]);
  } catch (pgErr) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('expenses').insert({
        id: processedExpense.id,
        category: processedExpense.category,
        description: processedExpense.description,
        amount: processedExpense.amount,
        payment_method: processedExpense.payment_method,
        reference: processedExpense.reference || null,
        user_id: processedExpense.user_id || 'admin',
        date: processedExpense.date,
      });
    } catch (err) {
      console.warn('[Server DB] Supabase expense insert failed:', err);
    }
  }

  const store = serverDb.get();
  store.expenses.unshift(processedExpense);
  serverDb.persist();
  return processedExpense;
}
