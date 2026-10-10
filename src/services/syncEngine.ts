import { db, getDeviceId, getSettings, saveSettings } from '../db/dexie';
import { setSyncingState, refreshNetworkStatus } from './network';
import { apiFetch } from './http';
import { getCachedUser, hasUsableToken } from './session';
import { shopCacheKey } from './shopContext';
import type {
  Sale,
  InventoryMovement,
  CustomerReturn,
  Expense,
  SyncPayload,
  SyncResponse,
  Medicine,
  MedicineBatch,
  SyncQueueItem,
  SyncEntityType,
  SyncOperation,
} from '../types';

export type SyncState = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface SyncStatusSummary {
  state: SyncState;
  pendingCount: number;
  lastSyncedAt: Date | null;
  errorMessage?: string;
}

type SyncListener = (status: SyncStatusSummary) => void;
const listeners: Set<SyncListener> = new Set();

let currentSummary: SyncStatusSummary = {
  state: 'idle',
  pendingCount: 0,
  lastSyncedAt: null,
};

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener({ ...currentSummary });
    } catch (e) {
      console.error('Sync listener error:', e);
    }
  });
}

export function subscribeToSyncStatus(listener: SyncListener): () => void {
  listeners.add(listener);
  listener({ ...currentSummary });
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Enqueue an operation into the canonical sync queue
 */
export async function enqueueSyncItem(params: {
  localId: string;
  entityType: SyncEntityType;
  operation: SyncOperation;
  payload: any;
}): Promise<SyncQueueItem> {
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();
  const idempotencyKey = `${deviceId}_${params.entityType}_${params.localId}_${params.operation}`;

  const item: SyncQueueItem = {
    id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    local_id: params.localId,
    entity_type: params.entityType,
    operation: params.operation,
    payload: params.payload,
    device_id: deviceId,
    idempotency_key: idempotencyKey,
    created_at: now,
    updated_at: now,
    version: 1,
    sync_status: 'pending',
    retry_count: 0,
  };

  await db.pending_sync.put(item);
  await refreshPendingCount();
  return item;
}

/**
 * Accurately compute total pending offline items across canonical queue and tables
 */
export async function getPendingCount(): Promise<number> {
  try {
    const [queuePending, pendingSales, pendingReturns, pendingExpenses] = await Promise.all([
      db.pending_sync.where('sync_status').equals('pending').count(),
      db.sales.where('sync_status').equals('pending').count(),
      db.customer_returns.where('sync_status').equals('pending').count(),
      db.expenses.where('sync_status').equals('pending').count(),
    ]);

    // Return the maximum of queued vs direct items to prevent zero-counts
    return Math.max(queuePending, pendingSales + pendingReturns + pendingExpenses);
  } catch (err) {
    console.warn('Error reading pending count:', err);
    return 0;
  }
}

export async function refreshPendingCount(): Promise<number> {
  const count = await getPendingCount();

  currentSummary.pendingCount = count;
  if (count === 0 && currentSummary.state !== 'error') {
    currentSummary.state = 'synced';
  }
  notifyListeners();
  refreshNetworkStatus();
  return count;
}

/**
 * Browser cache refresh. PostgreSQL (behind the local server) is authoritative and every sale /
 * return / expense is completed against it, so there is nothing to "push" from the browser: a sync
 * is a refresh of this browser's cache from the local server. Cloud sync (hybrid mode) is done by
 * the server's own worker, never by the browser. Internet status is irrelevant here: the local
 * server is reachable without internet, so navigator.onLine is not consulted.
 *
 * Items left in the old offline queue (from earlier versions) are NEVER replayed and never marked
 * synced: they are marked 'failed' with a reason so the operator can see and re-enter them.
 */
export async function runSync(_force = false): Promise<boolean> {
  currentSummary.state = 'syncing';
  currentSummary.errorMessage = undefined;
  setSyncingState(true);
  notifyListeners();

  try {
    const stranded = await markLegacyQueueFailed();
    const ok = await syncFromLocalApiToDexie();
    if (!ok) throw new Error('Could not refresh data from the GIGA CHEMIST server.');

    currentSummary.state = stranded > 0 ? 'error' : 'synced';
    currentSummary.errorMessage =
      stranded > 0
        ? `${stranded} item(s) saved only on this browser by an older version were NOT applied to the database. Re-enter them.`
        : undefined;
    currentSummary.lastSyncedAt = new Date();
    currentSummary.pendingCount = await getPendingCount();
    setSyncingState(false, currentSummary.errorMessage);
    notifyListeners();
    refreshNetworkStatus();
    return stranded === 0;
  } catch (error: any) {
    console.warn('[SyncEngine] Sync failed:', error);
    currentSummary.state = error?.status === 0 ? 'offline' : 'error';
    currentSummary.pendingCount = await getPendingCount();
    currentSummary.errorMessage = error?.message || 'Sync failed.';
    setSyncingState(false, currentSummary.errorMessage);
    notifyListeners();
    refreshNetworkStatus();
    return false;
  }
}

/** Marks every still-pending legacy offline item as failed (never synced). Returns how many. */
async function markLegacyQueueFailed(): Promise<number> {
  const reason = 'Not applied: offline-queued writes are not accepted in local mode. Re-enter this record.';
  return db.transaction('rw', [db.pending_sync, db.sales, db.customer_returns, db.expenses], async () => {
    let n = 0;
    for (const q of await db.pending_sync.where('sync_status').equals('pending').toArray()) {
      await db.pending_sync.put({ ...q, sync_status: 'failed', error_message: reason, updated_at: new Date().toISOString() });
      n++;
    }
    for (const s of await db.sales.where('sync_status').equals('pending').toArray()) {
      await db.sales.put({ ...s, sync_status: 'failed' });
      n++;
    }
    for (const r of await db.customer_returns.where('sync_status').equals('pending').toArray()) {
      await db.customer_returns.put({ ...r, sync_status: 'failed' });
      n++;
    }
    for (const e of await db.expenses.where('sync_status').equals('pending').toArray()) {
      await db.expenses.put({ ...e, sync_status: 'failed' });
      n++;
    }
    return n;
  });
}

const CACHE_SHOP_KEY = 'giga_cache_shop';

/** Empties every cached table that holds one shop's business data (online shop switch). */
export async function purgeShopScopedCache(): Promise<void> {
  const tables = [db.categories, db.customers, db.medicines, db.medicine_batches, db.sales, db.customer_returns,
    db.suppliers, db.purchases, db.inventory_movements, db.expenses];
  await db.transaction('rw', tables, async () => {
    for (const t of tables) await t.clear();
  });
  try {
    localStorage.setItem(CACHE_SHOP_KEY, shopCacheKey());
  } catch {
    /* ignore */
  }
}

async function purgeIfShopChanged(): Promise<void> {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(CACHE_SHOP_KEY);
  } catch {
    return;
  }
  // No marker yet = the cache predates shop selection = the default shop (local app: always).
  if ((cached || 'default') !== shopCacheKey()) await purgeShopScopedCache();
}

/**
 * Hydrates this browser's Dexie cache from the authenticated local API (PostgreSQL).
 * Admin-only resources are skipped for Cashiers (the server would answer 403 anyway).
 * Returns false only if the essential catalog (medicines + batches) could not be loaded.
 */
export async function syncFromLocalApiToDexie(): Promise<boolean> {
  if (!hasUsableToken()) return false;
  const isAdmin = getCachedUser()?.role === 'ADMIN';
  console.log('[SyncEngine] Refreshing local cache from the GIGA CHEMIST server (PostgreSQL)...');

  const load = async <T>(label: string, endpoint: string, store: (rows: T) => Promise<void>): Promise<boolean> => {
    try {
      await store(await apiFetch<T>(endpoint));
      return true;
    } catch (err: any) {
      console.error(`[SyncEngine] ${label} hydration failed:`, err?.message || err);
      return false;
    }
  };
  const putAll = async (table: any, rows: unknown) => {
    if (!Array.isArray(rows)) throw new Error('expected a JSON array');
    for (let i = 0; i < rows.length; i += 500) await table.bulkPut(rows.slice(i, i + 500));
  };

  // Online app: the cache holds ONE shop's data. A different selected shop starts from an empty cache,
  // so rows of the previous shop can never be shown under the new shop's name.
  await purgeIfShopChanged();

  // Keyed bulkPut: re-hydration overwrites cached rows with the server version, never duplicates.
  await load('Categories', '/api/categories', (rows) => putAll(db.categories, rows));
  await load('Customers', '/api/customers', (rows) => putAll(db.customers, rows));
  const catalogOk = await replaceCatalog();
  await load<any>('Sales', '/api/sales?limit=500', (data) => putAll(db.sales, Array.isArray(data) ? data : data?.sales || []));
  await load('Returns', '/api/returns', (rows) => putAll(db.customer_returns, rows));
  if (isAdmin) {
    await load('Suppliers', '/api/suppliers', (rows) => putAll(db.suppliers, rows));
    await load('Purchases', '/api/purchases', (rows) => putAll(db.purchases, rows));
    await load('Inventory movements', '/api/inventory/movements', (rows) => putAll(db.inventory_movements, rows));
    await load('Expenses', '/api/expenses', (rows) => putAll(db.expenses, rows));
  }
  await load<any>('Settings', '/api/settings', async (s) => {
    if (s?.pharmacy_name) await saveSettings(s);
  });

  currentSummary.pendingCount = await getPendingCount();
  notifyListeners();
  return catalogOk;
}

/** Fired on window after the cached catalogue was replaced; open screens re-read Dexie. */
export const CATALOG_REFRESHED_EVENT = 'giga:catalog-refreshed';

/**
 * Authoritative catalogue refresh: the server's COMPLETE medicines and batches replace the cached
 * ones in ONE Dexie transaction, so rows removed or re-based on the server never linger here.
 * Both downloads must succeed first; if either fails the existing cache is left untouched.
 *
 * Multi-shop: the snapshot is always the request's shop (the API resolves it), and the replace is
 * total, so a shop switch followed by this call leaves no row of the previous shop in these two
 * tables. Screens listening for CATALOG_REFRESHED_EVENT re-read after the replace commits.
 */
export async function replaceCatalog(): Promise<boolean> {
  let medicines: unknown;
  let batches: unknown;
  try {
    [medicines, batches] = await Promise.all([apiFetch<unknown>('/api/medicines'), apiFetch<unknown>('/api/batches')]);
  } catch (err: any) {
    console.error('[SyncEngine] Catalogue download failed; keeping the cached catalogue:', err?.message || err);
    return false;
  }
  if (!Array.isArray(medicines) || !Array.isArray(batches)) {
    console.error('[SyncEngine] Catalogue download was not a complete list; keeping the cached catalogue.');
    return false;
  }
  try {
    await db.transaction('rw', db.medicines, db.medicine_batches, async () => {
      await db.medicines.clear();
      await db.medicine_batches.clear();
      await db.medicines.bulkPut(medicines as any[]);
      await db.medicine_batches.bulkPut(batches as any[]);
    });
  } catch (err: any) {
    console.error('[SyncEngine] Catalogue cache update failed (rolled back):', err?.message || err);
    return false;
  }
  console.log(`[SyncEngine] Catalogue refreshed: ${medicines.length} medicines, ${batches.length} batches.`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CATALOG_REFRESHED_EVENT, { detail: { medicines: medicines.length, batches: batches.length } }));
  }
  return true;
}

// Global auto-sync lifecycle listeners
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    runSync().catch(() => {});
  });

  window.addEventListener('offline', () => {
    refreshNetworkStatus();
  });

  // Background sync heartbeat every 30 seconds
  setInterval(() => {
    if (typeof navigator !== 'undefined' && currentSummary.state !== 'syncing') {
      getPendingCount().then((count) => {
        if (count > 0) {
          runSync().catch(() => {});
        }
      });
    }
  }, 30000);
}


