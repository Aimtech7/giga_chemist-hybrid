import { db } from '../db/dexie';
import type { MedicineBatch } from '../types';

/** Shown when PostgreSQL committed but the local Dexie cache could not be refreshed. */
export const CACHE_REFRESH_WARNING =
  'Saved to the database. The local cache could not refresh, so this screen may show old stock — reload the page. Do NOT repeat this stock change.';

/**
 * Refreshes the Dexie cache after a COMMITTED server stock operation. A cache failure here must
 * never be reported as a failed stock operation (the Admin would re-submit and duplicate it),
 * so the error is logged and a warning string returned instead of throwing.
 */
export async function refreshCacheAfterCommit(refresh: () => Promise<void>): Promise<string | null> {
  try {
    await refresh();
    return null;
  } catch (err) {
    console.error('[StockCache] Dexie refresh failed after committed stock operation:', err);
    return CACHE_REFRESH_WARNING;
  }
}

/**
 * Applies the authoritative result of a server stock operation to the Dexie cache.
 * Only called after PostgreSQL has committed; values come from the server response,
 * never from client-side arithmetic.
 */
export async function applyServerStockResult(result: {
  medicine?: { id: string; current_stock: number; version?: number; updated_at?: string };
  batch?: Partial<MedicineBatch> & { id: string };
  batches?: (Partial<MedicineBatch> & { id: string })[];
}): Promise<void> {
  const batches = [...(result.batches || []), ...(result.batch ? [result.batch] : [])];

  await db.transaction('rw', [db.medicines, db.medicine_batches], async () => {
    for (const b of batches) {
      const existing = await db.medicine_batches.get(b.id);
      await db.medicine_batches.put({
        ...(existing || {}),
        ...b,
        medicine_name: b.medicine_name || existing?.medicine_name || '',
        supplier_name: existing?.supplier_name || '',
        created_by: existing?.created_by || 'Admin',
      } as MedicineBatch);
    }

    if (result.medicine) {
      await db.medicines.update(result.medicine.id, {
        current_stock: Number(result.medicine.current_stock) || 0,
        ...(result.medicine.version !== undefined ? { version: result.medicine.version } : {}),
        ...(result.medicine.updated_at ? { updated_at: result.medicine.updated_at } : {}),
      });
    }
  });
}
