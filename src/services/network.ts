import type { NetworkState } from '../types';
export type { NetworkState };
import { db } from '../db/dexie';
import { apiUrl } from './api';

type NetworkListener = (state: NetworkState, pendingCount: number) => void;
const listeners = new Set<NetworkListener>();

let currentState: NetworkState = 'ONLINE_SYNCED';
let currentPendingCount = 0;

/**
 * Is the API server reachable? Handles both local POS server and cloud serverless deployments.
 * Uses a generous 6-second timeout with single retry to prevent false alarms on cold starts or
 * high-latency mobile networks.
 */
export async function verifyServerReachability(): Promise<boolean> {
  const tryPing = async (timeoutMs: number): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(apiUrl('/api/health'), {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  };

  // Attempt with 6-second timeout (sufficient for cloud serverless cold-starts & international latency)
  const firstTry = await tryPing(6000);
  if (firstTry) return true;

  // Retry once with 4-second timeout if first attempt timed out or encountered transient jitter
  await new Promise((r) => setTimeout(r, 400));
  return tryPing(4000);
}

export async function refreshNetworkStatus(): Promise<{ state: NetworkState; pendingCount: number }> {
  const pendingCount = await db.pending_sync.where('sync_status').equals('pending').count();
  currentPendingCount = pendingCount;

  const isOnline = await verifyServerReachability();

  if (!isOnline) {
    currentState = 'OFFLINE';
  } else if (currentState === 'SYNCING') {
    // Keep syncing state if actively processing
  } else if (currentState === 'SYNC_ERROR') {
    // Keep error until resolved
  } else if (pendingCount > 0) {
    currentState = 'ONLINE_PENDING';
  } else {
    currentState = 'ONLINE_SYNCED';
  }

  notify();
  return { state: currentState, pendingCount: currentPendingCount };
}

export function setSyncingState(syncing: boolean, error?: string): void {
  if (syncing) {
    currentState = 'SYNCING';
  } else if (error) {
    currentState = 'SYNC_ERROR';
  } else {
    refreshNetworkStatus();
    return;
  }
  notify();
}

function notify(): void {
  listeners.forEach((l) => {
    try {
      l(currentState, currentPendingCount);
    } catch (e) {}
  });
}

export function subscribeNetworkStatus(listener: NetworkListener): () => void {
  listeners.add(listener);
  listener(currentState, currentPendingCount);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => refreshNetworkStatus());
  // "offline" only means the OS lost a network; re-check the local server instead of assuming.
  window.addEventListener('offline', () => refreshNetworkStatus());
  setInterval(() => refreshNetworkStatus(), 15000);
}
