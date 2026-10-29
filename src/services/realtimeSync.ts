import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { apiFetch } from './http';
import { selectedShopId } from './shopContext';
import { hasUsableToken } from './session';
import { CATALOG_REFRESHED_EVENT } from './syncEngine';

export type RealtimeStatus = 'disabled' | 'connecting' | 'connected' | 'error' | 'disconnected';

export interface RealtimeChangeEvent {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  record: any;
  oldRecord?: any;
}

type RealtimeListener = (event: RealtimeChangeEvent) => void;

let supabase: SupabaseClient | null = null;
let channel: RealtimeChannel | null = null;
let currentStatus: RealtimeStatus = 'disabled';
let activeShopId: string | null = null;
const listeners = new Set<RealtimeListener>();

export function getRealtimeStatus(): RealtimeStatus {
  return currentStatus;
}

export function onRealtimeChange(listener: RealtimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(event: RealtimeChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn('[Realtime] listener error:', e);
    }
  }
}

/**
 * Connects to Supabase Realtime using credentials fetched from /api/realtime/config.
 * Listens for stock, medicine, and sales changes across all terminals in this shop.
 */
export async function startRealtimeSync(): Promise<void> {
  if (!hasUsableToken()) return;

  const targetShopId = selectedShopId();
  if (channel && activeShopId === targetShopId && currentStatus === 'connected') {
    return;
  }

  stopRealtimeSync();
  currentStatus = 'connecting';

  try {
    const config = await apiFetch<{
      enabled: boolean;
      url: string;
      anonKey: string;
      shopId: string;
    }>('/api/realtime/config');

    if (!config.enabled || !config.url || !config.anonKey) {
      currentStatus = 'disabled';
      return;
    }

    const shopId = targetShopId || config.shopId;
    if (!shopId) {
      currentStatus = 'disabled';
      return;
    }

    activeShopId = shopId;
    supabase = createClient(config.url, config.anonKey, {
      auth: { persistSession: false },
    });

    const channelName = `shop-pos:${shopId}`;
    channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'giga_cloud', table: 'stock_levels', filter: `shop_id=eq.${shopId}` },
        (payload) => {
          handleIncomingChange('stock_levels', payload);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'giga_cloud', table: 'medicines', filter: `shop_id=eq.${shopId}` },
        (payload) => {
          handleIncomingChange('medicines', payload);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'giga_cloud', table: 'medicine_batches', filter: `shop_id=eq.${shopId}` },
        (payload) => {
          handleIncomingChange('medicine_batches', payload);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'giga_cloud', table: 'sales', filter: `shop_id=eq.${shopId}` },
        (payload) => {
          handleIncomingChange('sales', payload);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          currentStatus = 'connected';
        } else if (status === 'CHANNEL_ERROR') {
          currentStatus = 'error';
        } else if (status === 'CLOSED') {
          currentStatus = 'disconnected';
        }
      });
  } catch (err: any) {
    currentStatus = 'error';
    console.warn('[Realtime] Failed to initialize Supabase Realtime sync:', err?.message || err);
  }
}

function handleIncomingChange(table: string, payload: any) {
  const event: RealtimeChangeEvent = {
    table,
    eventType: payload.eventType || '*',
    record: payload.new,
    oldRecord: payload.old,
  };

  notifyListeners(event);

  // When stock, batch, or medicine is modified by another terminal, trigger catalog refresh
  if (table === 'stock_levels' || table === 'medicines' || table === 'medicine_batches') {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(CATALOG_REFRESHED_EVENT, {
          detail: { source: 'supabase_realtime', table, eventType: payload.eventType },
        })
      );
    }
  }

  // Also dispatch sales event so open cashier shift totals can refresh
  if (table === 'sales' && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('giga:sale-recorded', {
        detail: { sale: payload.new },
      })
    );
  }
}

export function stopRealtimeSync(): void {
  if (channel && supabase) {
    supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
  supabase = null;
  activeShopId = null;
  currentStatus = 'disabled';
}
