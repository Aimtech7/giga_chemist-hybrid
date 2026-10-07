import { pgPool, withTransaction, type Queryable } from '../db/client';
import { getSyncConfig } from './config';

export interface ShopIdentity {
  shop_id: string;
  shop_code: string;
  shop_name: string | null;
  branch_id: string | null;
}

let cached: ShopIdentity | null = null;

/** Reads the stored shop identity (migration 013 creates it once). */
export async function getShopIdentity(q: Queryable = pgPool): Promise<ShopIdentity> {
  if (cached) return cached;
  const res = await q.query('SELECT shop_id, shop_code, shop_name, branch_id FROM shop_identity WHERE id = 1');
  if (!res.rows[0]) throw new Error('shop_identity row is missing. Run "npm run db:migrate".');
  cached = res.rows[0] as ShopIdentity;
  return cached;
}

/**
 * Reconciles the stored identity with SHOP_ID from .env (when set).
 *   - same id: nothing to do
 *   - different id and nothing synced yet: the env id is adopted (stored row + unsynced events)
 *   - different id after events were synced: refused — the shop identity never silently changes
 * Returns an error message when sync must stay halted, otherwise null.
 */
export async function reconcileShopIdentity(): Promise<string | null> {
  const cfg = getSyncConfig();
  const stored = await getShopIdentity();
  if (!cfg.envShopId || cfg.envShopId === stored.shop_id.toLowerCase()) return null;

  return withTransaction(async (client) => {
    await client.query('SELECT 1 FROM shop_identity WHERE id = 1 FOR UPDATE');
    const synced = await client.query(`SELECT 1 FROM sync_events WHERE status = 'SYNCED' LIMIT 1`);
    if (synced.rows[0]) {
      return `SHOP_ID in .env (${cfg.envShopId}) differs from this database's shop identity (${stored.shop_id}) ` +
        'and events were already synced under the stored identity. Sync is halted; fix SHOP_ID.';
    }
    await client.query('UPDATE shop_identity SET shop_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [cfg.envShopId]);
    await client.query(`UPDATE sync_events SET shop_id = $1 WHERE status <> 'SYNCED'`, [cfg.envShopId]);
    console.log(`[Sync] Shop identity set from SHOP_ID: ${cfg.envShopId} (previously ${stored.shop_id}, nothing synced yet).`);
    cached = { ...stored, shop_id: cfg.envShopId! };
    return null;
  });
}

/** Test hook: forget the cached identity. */
export function clearShopIdentityCache(): void {
  cached = null;
}
