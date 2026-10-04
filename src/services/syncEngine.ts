import { db, getDeviceId, getSettings, saveSettings } from '../db/dexie';
import { setSyncingState, refreshNetworkStatus } from './network';
import { apiFetch } from './http';
import { getCachedUser, hasUsableToken } from './session';
import { supabase } from '../lib/supabase';
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
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  currentSummary.pendingCount = count;
  if (!isOnline) {
    currentSummary.state = 'offline';
  } else if (count === 0 && currentSummary.state !== 'error') {
    currentSummary.state = 'synced';
  }
  notifyListeners();
  refreshNetworkStatus();
  return count;
}

/**
 * Local-mode synchronization. PostgreSQL is authoritative and every sale / return / expense is
 * completed online against it, so there is nothing to "push": a sync is a refresh of this
 * browser's cache from the server.
 *
 * Items left in the old offline queue (from earlier versions) are NEVER replayed and never marked
 * synced: they are marked 'failed' with a reason so the operator can see and re-enter them.
 */
export async function runSync(force = false): Promise<boolean> {
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (!isOnline && !force) {
    currentSummary.state = 'offline';
    notifyListeners();
    return false;
  }

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
    currentSummary.state = isOnline ? 'error' : 'offline';
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

  // Keyed bulkPut: re-hydration overwrites cached rows with the server version, never duplicates.
  await load('Categories', '/api/categories', (rows) => putAll(db.categories, rows));
  await load('Customers', '/api/customers', (rows) => putAll(db.customers, rows));
  const medsOk = await load('Medicines', '/api/medicines', (rows) => putAll(db.medicines, rows));
  const batchesOk = await load('Batches', '/api/batches', (rows) => putAll(db.medicine_batches, rows));
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
  return medsOk && batchesOk;
}

/**
 * Cloud-to-Dexie Hydration Helper (for Vercel & Online Web Mode)
 */
export async function syncFromSupabaseToDexie(): Promise<boolean> {
  // If Supabase is not configured or in local offline mode, use local API hydration
  if (!supabase) {
    return syncFromLocalApiToDexie();
  }

  try {
    console.log('[SyncEngine] Fetching catalog and formulary from Supabase...');

    // 1. Fetch categories
    const { data: categories } = await supabase.from('categories').select('*');
    if (categories && categories.length > 0) {
      await db.categories.bulkPut(categories);
    }

    // 2. Fetch suppliers
    const { data: suppliers } = await supabase.from('suppliers').select('*');
    if (suppliers && suppliers.length > 0) {
      await db.suppliers.bulkPut(suppliers);
    }

    // 3. Fetch customers
    const { data: customers } = await supabase.from('customers').select('*');
    if (customers && customers.length > 0) {
      await db.customers.bulkPut(customers);
    }

    // 4. Fetch all medicines in paginated chunks of 1000
    let allMeds: any[] = [];
    let start = 0;
    const chunkSize = 1000;
    while (true) {
      const { data: chunk, error } = await supabase
        .from('medicines')
        .select('*')
        .range(start, start + chunkSize - 1);

      if (error || !chunk || chunk.length === 0) break;
      allMeds.push(...chunk);
      if (chunk.length < chunkSize) break;
      start += chunkSize;
    }

    if (allMeds.length > 0) {
      await db.medicines.bulkPut(allMeds);
      console.log(`[SyncEngine] Loaded ${allMeds.length} medicines from Supabase into Dexie store.`);
    }

    // 5. Fetch all medicine batches in paginated chunks of 1000
    let allBatches: any[] = [];
    start = 0;
    while (true) {
      const { data: chunk, error } = await supabase
        .from('medicine_batches')
        .select('*')
        .range(start, start + chunkSize - 1);

      if (error || !chunk || chunk.length === 0) break;
      allBatches.push(...chunk);
      if (chunk.length < chunkSize) break;
      start += chunkSize;
    }

    if (allBatches.length > 0) {
      await db.medicine_batches.bulkPut(allBatches);
      console.log(`[SyncEngine] Loaded ${allBatches.length} batches from Supabase into Dexie store.`);
    }

    currentSummary.state = 'synced';
    currentSummary.lastSyncedAt = new Date();
    notifyListeners();
    return true;
  } catch (err) {
    console.warn('[SyncEngine] Cloud sync fallback to local API:', err);
    return syncFromLocalApiToDexie();
  }
}

// Global auto-sync lifecycle listeners
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    runSync().catch(() => {});
  });

  window.addEventListener('offline', () => {
    currentSummary.state = 'offline';
    notifyListeners();
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


