import { apiFetch } from './http';
import { hasUsableToken } from './session';
import { verifyServerReachability } from './network';

/**
 * Browser view of the SERVER's cloud sync (GET /api/sync/status). The browser never talks to the
 * cloud: the local server owns the outbox and the worker. Two things are reported separately:
 *   - local: is this browser reaching the POS server / PostgreSQL? (decides whether the POS works)
 *   - cloud: is the server reaching the cloud? (decides only whether queued events are delivered)
 */
export interface SyncCounts {
  pending: number;
  processing?: number;
  synced?: number;
  failed: number;
  retrying?: number;
  oldest_pending_at?: string | null;
}

export interface ServerSyncStatus {
  mode: 'local' | 'hybrid' | 'cloud' | 'online';
  read_only?: boolean;
  enabled: boolean;
  local_database?: { connected: boolean };
  cloud_reachable: boolean | null;
  counts: SyncCounts | null;
  last_sync: string | null;
  // Admin-only details
  shop_id?: string | null;
  shop_code?: string | null;
  branch_id?: string | null;
  device_id?: string;
  last_error?: string | null;
  last_error_at?: string | null;
  last_contact?: string | null;
  last_event_error?: { event_type: string; error: string; at: string } | null;
  inbound_commands?: { applied: number; rejected: number; unacknowledged: number };
  cloud?: { configured: boolean; config_error: string | null; host: string | null; key_type: string; reachable: boolean | null } | null;
  worker?: { running: boolean; leader: boolean; busy: boolean; halted_reason: string | null; consecutive_failures: number; next_run_at: string | null } | null;
}

export type SyncIndicatorState =
  | 'SERVER_UNREACHABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'LOCAL'
  | 'ONLINE_READONLY'
  | 'LOCAL_SYNC_OFF'
  | 'ONLINE_SYNCED'
  | 'ONLINE_SYNCING'
  | 'OFFLINE_PENDING'
  | 'SYNC_ERROR'
  | 'UNKNOWN';

export interface CloudSyncSnapshot {
  serverReachable: boolean;
  status: ServerSyncStatus | null;
  state: SyncIndicatorState;
  pending: number;
  checkedAt: number | null;
}

type Listener = (s: CloudSyncSnapshot) => void;
const listeners = new Set<Listener>();
let snapshot: CloudSyncSnapshot = { serverReachable: true, status: null, state: 'UNKNOWN', pending: 0, checkedAt: null };
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function deriveState(serverReachable: boolean, s: ServerSyncStatus | null): SyncIndicatorState {
  if (!serverReachable) return 'SERVER_UNREACHABLE';
  if (!s) return 'UNKNOWN';
  if (s.local_database && !s.local_database.connected) return 'DATABASE_UNAVAILABLE';
  if (s.mode === 'online') return 'ONLINE_READONLY';
  if (s.mode !== 'hybrid') return 'LOCAL';
  if (!s.enabled) return 'LOCAL_SYNC_OFF';
  const pending = (s.counts?.pending || 0) + (s.counts?.processing || 0);
  if (s.cloud_reachable === false) return 'OFFLINE_PENDING';
  if ((s.counts?.failed || 0) > 0 || (s.cloud && !s.cloud.configured) || s.worker?.halted_reason) return 'SYNC_ERROR';
  if (pending > 0 && (s.counts?.retrying || 0) > 0) return 'SYNC_ERROR';
  if (pending > 0) return 'ONLINE_SYNCING';
  return 'ONLINE_SYNCED';
}

function emit() {
  for (const l of listeners) {
    try {
      l({ ...snapshot });
    } catch {
      /* listener errors never break polling */
    }
  }
}

export async function refreshCloudSyncStatus(): Promise<CloudSyncSnapshot> {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const reachable = await verifyServerReachability();
    let status: ServerSyncStatus | null = snapshot.status;
    if (reachable && hasUsableToken()) {
      try {
        status = await apiFetch<ServerSyncStatus>('/api/sync/status');
      } catch {
        status = null;
      }
    }
    const pending = status?.counts ? (status.counts.pending || 0) + (status.counts.processing || 0) : 0;
    snapshot = { serverReachable: reachable, status, state: deriveState(reachable, status), pending, checkedAt: Date.now() };
    emit();
    return snapshot;
  } finally {
    inFlight = false;
  }
}

export function subscribeCloudSync(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...snapshot });
  if (!timer) {
    void refreshCloudSyncStatus();
    timer = setInterval(() => void refreshCloudSyncStatus(), 10_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** ADMIN: wakes the server's sync worker. The server keeps its retry and idempotency rules. */
export async function requestSyncNow(): Promise<string> {
  const r = await apiFetch<{ result: string }>('/api/sync/now', { method: 'POST', body: {} });
  setTimeout(() => void refreshCloudSyncStatus(), 1500);
  return r.result;
}

/** ADMIN: re-queues events the cloud rejected. */
export async function requeueFailedEvents(): Promise<number> {
  const r = await apiFetch<{ requeued: number }>('/api/sync/retry-failed', { method: 'POST', body: {} });
  setTimeout(() => void refreshCloudSyncStatus(), 1500);
  return r.requeued;
}
