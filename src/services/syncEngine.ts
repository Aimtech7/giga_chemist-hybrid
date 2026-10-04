import { db, getDeviceId, getSettings, saveSettings } from '../db/dexie';
import { setSyncingState, refreshNetworkStatus } from './network';
import { getAuthHeaders } from './auth';
import { apiUrl } from './api';
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
 * Execute full synchronization between client IndexedDB and server REST API
 * Implements:
 * 1. Transaction-based payloads
 * 2. Stable idempotency keys
 * 3. Safe stock merge (prevents overwriting local unsynced stock)
 * 4. Reliable retry & error reporting
 */
export async function runSync(force = false): Promise<boolean> {
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (!isOnline && !force) {
    currentSummary.state = 'offline';
    currentSummary.pendingCount = await getPendingCount();
    notifyListeners();
    return false;
  }

  currentSummary.state = 'syncing';
  currentSummary.errorMessage = undefined;
  setSyncingState(true);
  notifyListeners();

  try {
    const deviceId = await getDeviceId();

    // 1. Collect pending records
    const [pendingSales, pendingMovements, pendingReturns, pendingExpenses, queueItems] =
      await Promise.all([
        db.sales.where('sync_status').equals('pending').toArray(),
        db.inventory_movements.toArray(),
        db.customer_returns.where('sync_status').equals('pending').toArray(),
        db.expenses.where('sync_status').equals('pending').toArray(),
        db.pending_sync.where('sync_status').equals('pending').toArray(),
      ]);

    // Merge any queued sales/returns not yet flagged in tables
    for (const q of queueItems) {
      if (q.entity_type === 'sale' && q.payload) {
        if (!pendingSales.some((s) => s.id === q.local_id)) {
          pendingSales.push(q.payload);
        }
      } else if (q.entity_type === 'return' && q.payload) {
        if (!pendingReturns.some((r) => r.id === q.local_id)) {
          pendingReturns.push(q.payload);
        }
      } else if (q.entity_type === 'expense' && q.payload) {
        if (!pendingExpenses.some((e) => e.id === q.local_id)) {
          pendingExpenses.push(q.payload);
        }
      }
    }

    const payload: SyncPayload = {
      device_id: deviceId,
      sales: pendingSales,
      movements: pendingMovements.slice(-100),
      returns: pendingReturns,
      expenses: pendingExpenses,
    };

    // Send to canonical server sync endpoint with auth headers
    const authHeaders = getAuthHeaders();
    const response = await fetch(apiUrl('/api/sync'), {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
    }

    const data: SyncResponse = await response.json();
    const nowStr = new Date().toISOString();

    // 2. Mark acknowledged items as synced in atomic transaction
    await db.transaction('rw', [
      db.sales,
      db.customer_returns,
      db.expenses,
      db.pending_sync,
      db.medicines,
      db.medicine_batches,
      db.settings,
      db.sync_metadata,
    ], async () => {
      // Mark sales synced
      for (const saleId of data.synced_sale_ids || []) {
        const sale = await db.sales.get(saleId);
        if (sale) {
          sale.sync_status = 'synced';
          sale.retry_count = 0;
          await db.sales.put(sale);
        }
        // Also update matching queue items
        const qItems = await db.pending_sync.where('local_id').equals(saleId).toArray();
        for (const qi of qItems) {
          qi.sync_status = 'synced';
          qi.updated_at = nowStr;
          await db.pending_sync.put(qi);
        }
      }

      // Mark returns synced
      for (const retId of data.synced_return_ids || []) {
        const ret = await db.customer_returns.get(retId);
        if (ret) {
          ret.sync_status = 'synced';
          await db.customer_returns.put(ret);
        }
        const qItems = await db.pending_sync.where('local_id').equals(retId).toArray();
        for (const qi of qItems) {
          qi.sync_status = 'synced';
          qi.updated_at = nowStr;
          await db.pending_sync.put(qi);
        }
      }

      // Mark expenses synced
      for (const expId of data.synced_expense_ids || []) {
        const exp = await db.expenses.get(expId);
        if (exp) {
          exp.sync_status = 'synced';
          await db.expenses.put(exp);
        }
        const qItems = await db.pending_sync.where('local_id').equals(expId).toArray();
        for (const qi of qItems) {
          qi.sync_status = 'synced';
          qi.updated_at = nowStr;
          await db.pending_sync.put(qi);
        }
      }

      // 3. SAFE STOCK MERGE (PREVENT SILENT STOCK ERASURE):
      // Find remaining unsynced sales/returns to protect local stock counts
      const remainingPendingSales = await db.sales.where('sync_status').equals('pending').toArray();
      const lockedMedicineIds = new Set<string>();
      const lockedBatchIds = new Set<string>();

      for (const s of remainingPendingSales) {
        if (Array.isArray(s.items)) {
          for (const it of s.items) {
            lockedMedicineIds.add(it.medicine_id);
            lockedBatchIds.add(it.batch_id);
          }
        }
      }

      // Merge Authoritative Medicines safely
      if (data.authoritative_medicines && data.authoritative_medicines.length > 0) {
        for (const srvMed of data.authoritative_medicines) {
          const localMed = await db.medicines.get(srvMed.id);
          if (localMed && lockedMedicineIds.has(srvMed.id)) {
            // Unsynced sales exist for this product: update metadata, preserve local deducted stock
            await db.medicines.put({
              ...srvMed,
              current_stock: localMed.current_stock,
            });
          } else {
            // No pending changes: apply authoritative stock
            await db.medicines.put(srvMed);
          }
        }
      }

      // Merge Authoritative Batches safely
      if (data.authoritative_batches && data.authoritative_batches.length > 0) {
        for (const srvBatch of data.authoritative_batches) {
          const localBatch = await db.medicine_batches.get(srvBatch.id);
          if (localBatch && lockedBatchIds.has(srvBatch.id)) {
            // Unsynced local deductions: preserve local available quantity
            await db.medicine_batches.put({
              ...srvBatch,
              quantity_available: localBatch.quantity_available,
              status: localBatch.status,
            });
          } else {
            await db.medicine_batches.put(srvBatch);
          }
        }
      }

      // Save Authoritative Settings
      if (data.authoritative_settings) {
        await saveSettings(data.authoritative_settings);
      }

      await db.sync_metadata.put({ key: 'last_successful_sync', value: nowStr });
    });

    currentSummary.state = 'synced';
    currentSummary.pendingCount = await getPendingCount();
    currentSummary.lastSyncedAt = new Date();
    currentSummary.errorMessage = undefined;
    setSyncingState(false);
    notifyListeners();
    refreshNetworkStatus();
    return true;
  } catch (error: any) {
    console.warn('Sync attempt failed:', error);

    // Increment retry count for pending queue items
    try {
      const pendingItems = await db.pending_sync.where('sync_status').equals('pending').toArray();
      for (const item of pendingItems) {
        item.retry_count = (item.retry_count || 0) + 1;
        item.last_attempt = Date.now();
        item.error_message = error?.message || 'Sync connection failed';
        await db.pending_sync.put(item);
      }
    } catch (e) {}

    currentSummary.state = isOnline ? 'error' : 'offline';
    currentSummary.pendingCount = await getPendingCount();
    currentSummary.errorMessage = error?.message || 'Sync failed. Local data preserved safely.';
    setSyncingState(false, currentSummary.errorMessage);
    notifyListeners();
    refreshNetworkStatus();
    return false;
  }
}

/**
 * Local API to Dexie Hydration Routine (for Standalone Offline-First & Target PC Mode)
 * Populates local Dexie stores directly from authenticated local Express API endpoints
 */
export async function syncFromLocalApiToDexie(): Promise<boolean> {
  try {
    console.log('[SyncEngine] Hydrating formulary and operational data from local Express API (PostgreSQL)...');
    const authHeaders = getAuthHeaders();

    // 1. Fetch Categories
    try {
      const resCat = await fetch(apiUrl('/api/categories'), { headers: authHeaders });
      if (resCat.ok) {
        const categories = await resCat.json();
        if (Array.isArray(categories) && categories.length > 0) {
          await db.categories.bulkPut(categories);
          console.log(`[SyncEngine] Hydrated ${categories.length} categories into Dexie.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Categories hydration notice:', e);
    }

    // 2. Fetch Suppliers
    try {
      const resSup = await fetch(apiUrl('/api/suppliers'), { headers: authHeaders });
      if (resSup.ok) {
        const suppliers = await resSup.json();
        if (Array.isArray(suppliers) && suppliers.length > 0) {
          await db.suppliers.bulkPut(suppliers);
          console.log(`[SyncEngine] Hydrated ${suppliers.length} suppliers into Dexie.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Suppliers hydration notice:', e);
    }

    // 3. Fetch Customers
    try {
      const resCust = await fetch(apiUrl('/api/customers'), { headers: authHeaders });
      if (resCust.ok) {
        const customers = await resCust.json();
        if (Array.isArray(customers) && customers.length > 0) {
          await db.customers.bulkPut(customers);
          console.log(`[SyncEngine] Hydrated ${customers.length} customers into Dexie.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Customers hydration notice:', e);
    }

    // 4. Fetch All Medicines from local PostgreSQL API (Chunked for UI performance)
    try {
      const resMeds = await fetch(apiUrl('/api/medicines'), { headers: authHeaders });
      if (resMeds.ok) {
        const medicines = await resMeds.json();
        if (Array.isArray(medicines) && medicines.length > 0) {
          const chunkSize = 500;
          for (let i = 0; i < medicines.length; i += chunkSize) {
            const chunk = medicines.slice(i, i + chunkSize);
            await db.medicines.bulkPut(chunk);
          }
          console.log(`[SyncEngine] Hydrated ${medicines.length} medicines into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Medicines hydration notice:', e);
    }

    // 5. Fetch Batches from local PostgreSQL API
    try {
      const resBatches = await fetch(apiUrl('/api/batches'), { headers: authHeaders });
      if (resBatches.ok) {
        const batches = await resBatches.json();
        if (Array.isArray(batches) && batches.length > 0) {
          const chunkSize = 500;
          for (let i = 0; i < batches.length; i += chunkSize) {
            const chunk = batches.slice(i, i + chunkSize);
            await db.medicine_batches.bulkPut(chunk);
          }
          console.log(`[SyncEngine] Hydrated ${batches.length} batches into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Batches hydration notice:', e);
    }

    // 6. Fetch Sales History (recent sales into Dexie for instant offline viewing)
    try {
      const resSales = await fetch(apiUrl('/api/sales?limit=500'), { headers: authHeaders });
      if (resSales.ok) {
        const data = await resSales.json();
        const salesList = Array.isArray(data) ? data : (data.sales || []);
        if (Array.isArray(salesList) && salesList.length > 0) {
          const chunkSize = 200;
          for (let i = 0; i < salesList.length; i += chunkSize) {
            const chunk = salesList.slice(i, i + chunkSize);
            await db.sales.bulkPut(chunk);
          }
          console.log(`[SyncEngine] Hydrated ${salesList.length} sales into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Sales hydration notice:', e);
    }

    // 7. Fetch Purchases
    try {
      const resPurchases = await fetch(apiUrl('/api/purchases'), { headers: authHeaders });
      if (resPurchases.ok) {
        const purchases = await resPurchases.json();
        if (Array.isArray(purchases) && purchases.length > 0) {
          await db.purchases.bulkPut(purchases);
          console.log(`[SyncEngine] Hydrated ${purchases.length} purchases into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Purchases hydration notice:', e);
    }

    // 8. Fetch Inventory Movements
    try {
      const resMovements = await fetch(apiUrl('/api/inventory/movements'), { headers: authHeaders });
      if (resMovements.ok) {
        const movements = await resMovements.json();
        if (Array.isArray(movements) && movements.length > 0) {
          const chunkSize = 500;
          for (let i = 0; i < movements.length; i += chunkSize) {
            const chunk = movements.slice(i, i + chunkSize);
            await db.inventory_movements.bulkPut(chunk);
          }
          console.log(`[SyncEngine] Hydrated ${movements.length} movements into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Movements hydration notice:', e);
    }

    // 9. Fetch Returns
    try {
      const resReturns = await fetch(apiUrl('/api/returns'), { headers: authHeaders });
      if (resReturns.ok) {
        const returns = await resReturns.json();
        if (Array.isArray(returns) && returns.length > 0) {
          await db.customer_returns.bulkPut(returns);
          console.log(`[SyncEngine] Hydrated ${returns.length} returns into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Returns hydration notice:', e);
    }

    // 10. Fetch Expenses
    try {
      const resExpenses = await fetch(apiUrl('/api/expenses'), { headers: authHeaders });
      if (resExpenses.ok) {
        const expenses = await resExpenses.json();
        if (Array.isArray(expenses) && expenses.length > 0) {
          await db.expenses.bulkPut(expenses);
          console.log(`[SyncEngine] Hydrated ${expenses.length} expenses into Dexie store.`);
        }
      }
    } catch (e) {
      console.warn('[SyncEngine] Expenses hydration notice:', e);
    }

    // 11. Fetch Settings
    try {
      const resSettings = await fetch(apiUrl('/api/settings'), { headers: authHeaders });
      if (resSettings.ok) {
        const s = await resSettings.json();
        if (s && s.pharmacy_name) {
          await saveSettings(s);
        }
      }
    } catch (e) {}

    currentSummary.state = 'synced';
    currentSummary.lastSyncedAt = new Date();
    currentSummary.pendingCount = await getPendingCount();
    notifyListeners();
    return true;
  } catch (err) {
    console.warn('[SyncEngine] Local API to Dexie hydration notice:', err);
    return false;
  }
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


