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

export async function upsertCategory(category: { id?: string; name: string; description?: string }): Promise<Category> {
  const id = category.id || `cat-${Date.now()}`;
  const now = new Date().toISOString();

  try {
    await pgPool.query(`
      INSERT INTO categories (id, name, description, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
    `, [id, category.name, category.description || null, now, now]);
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('categories').upsert({ id, name: category.name, description: category.description });
    } catch (e) {}
  }

  return {
    id,
    name: category.name,
    description: category.description,
    created_at: now,
    updated_at: now,
  };
}
