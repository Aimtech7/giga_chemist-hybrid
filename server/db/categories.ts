import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import type { Category } from '../../src/types';

export async function getAllCategories(): Promise<Category[]> {
  try {
    const res = await pgPool.query(`SELECT id, name, description, created_at, updated_at FROM categories ORDER BY name ASC`);
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || undefined,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin.from('categories').select('*').order('name');
      if (!error && data && data.length > 0) return data as Category[];
    } catch (err) {}
  }

  return [
    { id: 'cat-1', name: 'Analgesics & Antipyretics' },
    { id: 'cat-2', name: 'Antibiotics' },
    { id: 'cat-3', name: 'Antihistamines' },
    { id: 'cat-4', name: 'Antidiabetics' },
    { id: 'cat-5', name: 'Gastrointestinal' },
    { id: 'cat-6', name: 'Respiratory' },
    { id: 'cat-7', name: 'Cardiovascular' },
    { id: 'cat-8', name: 'Dermatological' },
  ];
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
