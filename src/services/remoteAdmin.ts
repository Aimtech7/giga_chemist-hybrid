import { apiFetch } from './http';
import { apiUrl } from './api';

/**
 * Remote administration from the online app (https://gigachem.vercel.app), ADMIN only.
 * The browser only QUEUES commands on the Vercel API; the shop computer applies them to its own
 * PostgreSQL and syncs the result back. A queued command is PENDING — never shown as "done" until
 * the shop reports it APPLIED.
 */
export type CommandStatus = 'PENDING' | 'DELIVERED' | 'APPLIED' | 'REJECTED';

export type RemoteAction =
  | 'stock-add'
  | 'stock-remove'
  | 'stock-set'
  | 'price-update'
  | 'medicine-update'
  | 'batch-expiry'
  | 'category'
  | 'settings';

export interface RemoteCommand {
  command_id: string;
  command_type: string;
  status: CommandStatus;
  payload: Record<string, any>;
  created_at: string;
  created_by: string | null;
  delivered_at: string | null;
  delivery_count: number;
  acked_at: string | null;
  result: Record<string, any> | null;
  error: string | null;
}

export interface QueuedCommand {
  command_id: string;
  command_type: string;
  status: CommandStatus;
  created_at: string;
  duplicate: boolean;
}

export interface RemoteStatus {
  shop_registered: boolean;
  shop_active: boolean;
  shop_code: string | null;
  shop_name: string | null;
  shop_in_contact: boolean;
  contact_window_seconds: number;
  last_shop_contact_at: string | null;
  last_shop_event_at: string | null;
  last_sync_at: string | null;
  server_time: string;
  commands: {
    pending: number;
    delivered: number;
    applied: number;
    rejected: number;
    oldest_open_at: string | null;
    last_applied_at: string | null;
    last_rejected_at: string | null;
  };
  last_successful_command: { command_id: string; command_type: string; applied_at: string } | null;
}

export const STOCK_REMOVE_REASONS = ['Damaged', 'Expired', 'Lost', 'Physical stock correction', 'Other'] as const;

export const isFinal = (s: CommandStatus) => s === 'APPLIED' || s === 'REJECTED';

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/**
 * Queues one command. The request id makes a retried tap/request queue ONE command; pass the same
 * id when retrying the same confirmation.
 */
export function queueRemoteCommand(action: RemoteAction, payload: Record<string, unknown>, requestId: string = newRequestId()) {
  return apiFetch<QueuedCommand>(`/api/admin/commands/${action}`, { method: 'POST', body: { ...payload, request_id: requestId } });
}

export const createRequestId = newRequestId;

export const getRemoteCommand = (id: string) => apiFetch<RemoteCommand>(`/api/admin/commands/${encodeURIComponent(id)}`);
export const listRemoteCommands = (limit = 30) => apiFetch<{ commands: RemoteCommand[] }>(`/api/admin/commands?limit=${limit}`);
export const getRemoteStatus = () => apiFetch<RemoteStatus>('/api/admin/remote-status');

// ---------------------------------------------------------------- server mode (online vs shop)
let modePromise: Promise<string | null> | null = null;

/** 'online' on the Vercel deployment; 'local' / 'hybrid' on the shop server. Cached per page load. */
export function getServerMode(): Promise<string | null> {
  if (!modePromise) {
    modePromise = fetch(apiUrl('/api/health'), { headers: { Accept: 'application/json' } })
      .then((r) => (r.headers.get('content-type') || '').includes('json') ? r.json() : null)
      .then((d) => (d && typeof d.mode === 'string' ? d.mode : null))
      .catch(() => {
        modePromise = null;
        return null;
      });
  }
  return modePromise;
}

export const COMMAND_LABELS: Record<string, string> = {
  STOCK_ADD: 'Add stock',
  STOCK_REMOVE: 'Remove stock',
  STOCK_SET: 'Physical count',
  PRICE_UPDATE: 'Price change',
  MEDICINE_METADATA_UPDATE: 'Medicine details',
  BATCH_EXPIRY_UPDATE: 'Batch expiry',
  CATEGORY_UPSERT: 'Category',
  SETTINGS_UPDATE: 'Pharmacy settings',
};
