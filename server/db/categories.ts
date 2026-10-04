import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import type { Category } from '../../src/types';

/** Lists categories from PostgreSQL. In local mode PostgreSQL is authoritative: errors propagate. */
export async function getAllCategories(): Promise<Category[]> {
  try {
    const res = await pgPool.query(`SELECT id, name, description, created_at, updated_at FROM categories ORDER BY name ASC`);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
    }));
  } catch (err: any) {
    console.error('[Server DB] getAllCategories PostgreSQL error:', err.message);
    if (isLocalMode || !isSupabaseConfigured) throw err;
  }

  const { data, error } = await supabaseAdmin.from('categories').select('*').order('name');
  if (error) throw error;
  return (data || []) as Category[];
}
