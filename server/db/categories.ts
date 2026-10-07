import { pgPool } from './client';
import type { Category } from '../../src/types';

/**
 * Lists categories from PostgreSQL. PostgreSQL is authoritative in local AND hybrid mode, so errors
 * propagate (there is no cloud fallback: the cloud is never read to serve the POS).
 */
export async function getAllCategories(): Promise<Category[]> {
  const res = await pgPool.query(`SELECT id, name, description, created_at, updated_at FROM categories ORDER BY name ASC`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description || undefined,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
  }));
}
