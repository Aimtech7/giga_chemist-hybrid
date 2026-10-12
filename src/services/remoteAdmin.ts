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
  | 'settings'
  | 'user-active'
  | 'user-role'
  | 'app-update'
  // Full-write Global Admin
  | 'medicine-create'
  | 'medicine-active'
  | 'batch-create'
  | 'batch-update'
  | 'batch-active'
  | 'supplier-create'
  | 'supplier-update'
  | 'supplier-active'
  | 'customer-create'
  | 'customer-update'
  | 'customer-active'
  | 'purchase-create'
  | 'purchase-update'
  | 'purchase-receive'
  | 'purchase-cancel'
  | 'expense-create'
  | 'expense-update'
  | 'expense-void'
  | 'return-approve'
  | 'return-reject'
  | 'sale-void'
  | 'user-session-revoke'
  // Cashier shifts (cloud migration 009)
  | 'shift-review';

/** Actions a Global Administrator may apply to ALL shops (one independent command per shop). */
export const ALL_SHOPS_ACTIONS: RemoteAction[] = ['price-update', 'medicine-update', 'category', 'settings'];

export interface RemoteCommand {
  command_id: string;
  command_type: string;
  shop_id?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  expected?: Record<string, unknown> | null;
  high_conflict?: boolean;
  status: CommandStatus;
  payload: Record<string, any>;
  display?: Record<string, any> | null;
  audit_reference?: string | null;
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
  shop_id?: string;
  shop_code?: string | null;
  shop_name?: string | null;
  /** The record the command is about (a create command: the id the new record will have). */
  entity?: string | null;
  entity_id?: string | null;
  shop_online?: boolean | null;
  /** Set when the shop is offline (stronger wording for stock / financial changes). */
  warning?: string | null;
}

export interface AllShopsResult {
  command_type: string;
  fanout_group: string;
  results: { shop_id: string; shop_code: string | null; shop_name: string | null; status: 'QUEUED' | 'SKIPPED'; command_id?: string; reason?: string; warning?: string | null }[];
}

export interface RemoteStatus {
  shop_id?: string;
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

/**
 * APPLY TO ALL SHOPS: the server queues one independent command per active shop (a medicine is matched
 * in each shop by barcode; shops without it are reported SKIPPED). Global Administrator only.
 */
export function queueAllShopsCommand(action: RemoteAction, payload: Record<string, unknown>, sourceShopId: string | null, requestId: string = newRequestId()) {
  return apiFetch<AllShopsResult>(`/api/admin/all-shops/commands/${action}`, {
    method: 'POST', body: { ...payload, ...(sourceShopId ? { source_shop_id: sourceShopId } : {}), request_id: requestId },
  });
}

export interface ShopOverview {
  shop_id: string;
  shop_code: string | null;
  name: string | null;
  online: boolean | null;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  db_healthy: boolean | null;
  sync_healthy: boolean | null;
  last_sync_at: string | null;
  app_version: string | null;
  git_commit: string | null;
  sales_today: { count: number; total: number };
  catalogue: { total: number; active: number; inactive: number };
  stock_units: number;
  stock_cost_value: number;
  stock_retail_value: number;
  low_stock: number;
  out_of_stock: number;
  expiring_30d: number;
  expired_with_stock: number;
  active_staff: number;
  pending_commands: number;
  rejected_commands_7d: number;
  error: string | null;
}
export interface Overview {
  scope: 'GLOBAL' | 'SHOP';
  generated_at: string;
  shops: ShopOverview[];
  totals: Record<string, number>;
}
export const getOverview = () => apiFetch<Overview>('/api/admin/overview');

export const getRemoteCommand = (id: string) => apiFetch<RemoteCommand>(`/api/admin/commands/${encodeURIComponent(id)}`);
export const listRemoteCommands = (limit = 30, status?: string) =>
  apiFetch<{ commands: RemoteCommand[] }>(`/api/admin/commands?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ''}`);
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
  USER_SET_ACTIVE: 'Staff account on/off',
  USER_ROLE_UPDATE: 'Staff role',
  APP_UPDATE_APPROVE: 'Software update approval',
  USER_CREATE: 'New staff account',
  USER_CREDENTIAL_REFRESH: 'Staff password reset',
  MEDICINE_CREATE: 'New medicine',
  MEDICINE_SET_ACTIVE: 'Medicine on/off',
  BATCH_CREATE: 'New batch',
  BATCH_UPDATE: 'Batch details',
  BATCH_SET_ACTIVE: 'Batch on/off',
  SUPPLIER_CREATE: 'New supplier',
  SUPPLIER_UPDATE: 'Supplier details',
  SUPPLIER_SET_ACTIVE: 'Supplier on/off',
  CUSTOMER_CREATE: 'New customer',
  CUSTOMER_UPDATE: 'Customer details',
  CUSTOMER_SET_ACTIVE: 'Customer on/off',
  PURCHASE_CREATE: 'New purchase (pending)',
  PURCHASE_UPDATE_DRAFT: 'Edit pending purchase',
  PURCHASE_RECEIVE: 'Receive purchase',
  PURCHASE_CANCEL: 'Cancel purchase',
  EXPENSE_CREATE: 'New expense',
  EXPENSE_UPDATE: 'Correct expense',
  EXPENSE_VOID: 'Void expense',
  RETURN_APPROVE: 'Approve return',
  RETURN_REJECT: 'Reject return',
  SALE_VOID: 'Void sale',
  USER_SESSION_REVOKE: 'Sign out staff everywhere',
  SHIFT_REVIEW: 'Review cashier shift',
};

// ---------------------------------------------------------------- health, alerts, insights, security
export const getShopHealth = () => apiFetch<any>('/api/admin/shop-health');
export const getAlerts = (all = false) => apiFetch<{ supported: boolean; alerts: any[]; message?: string }>(`/api/admin/alerts?status=${all ? 'all' : 'open'}`);
export const ackAlert = (id: number) => apiFetch<any>(`/api/admin/alerts/${id}/ack`, { method: 'POST', body: {} });
export const getInsights = (days = 30) => apiFetch<any>(`/api/admin/insights?days=${days}`);
export const getReport = (range: 'today' | 'week' | 'month') => apiFetch<any>(`/api/reports/summary?range=${range}`);
export const getStaff = () => apiFetch<any[]>('/api/users');
export const getSecurity = () => apiFetch<any>('/api/admin/security');
export const setRemoteWrites = (enabled: boolean) => apiFetch<any>('/api/admin/security/remote-writes', { method: 'POST', body: { enabled } });
export const setMaintenance = (enabled: boolean, message?: string) => apiFetch<any>('/api/admin/security/maintenance', { method: 'POST', body: { enabled, message } });
export const revokeSessions = (body: { all: true } | { user_id: string }) => apiFetch<any>('/api/admin/security/revoke-sessions', { method: 'POST', body });
export const setOnlineUserActive = (id: string, active: boolean) => apiFetch<any>(`/api/admin/security/online-users/${id}/active`, { method: 'POST', body: { active } });

/** CSV download of rows (client side; no server state). */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- multi-shop + user management (online)
export interface OnlineShop {
  shop_id: string;
  shop_code: string | null;
  name: string | null;
  active: boolean;
  last_seen_at: string | null;
  last_event_at: string | null;
  online: boolean | null;
  heartbeat_age_seconds: number | null;
}
export const getShops = () => apiFetch<{ scope: 'GLOBAL' | 'SHOP'; selected_shop_id: string; shops: OnlineShop[] }>('/api/admin/shops');

export const getAccounts = (shop: 'all' | 'selected' = 'selected') =>
  apiFetch<{ shop_filter: string; global_admins: any[]; shop_users: any[] }>(`/api/admin/accounts${shop === 'all' ? '?shop=all' : ''}`);
export const createShopUser = (body: { name: string; email: string; username?: string; role: string; password: string }) =>
  apiFetch<any>('/api/admin/accounts/shop-users', { body });
const su = (id: string, action: string) => `/api/admin/accounts/shop-users/${encodeURIComponent(id)}/${action}`;
export const resetShopUserPassword = (localUserId: string, password: string) => apiFetch<any>(su(localUserId, 'password'), { body: { password } });
export const setShopUserActive = (localUserId: string, active: boolean, reason?: string) => apiFetch<any>(su(localUserId, 'active'), { body: { active, reason } });
export const setShopUserRole = (localUserId: string, role: string, reason?: string) => apiFetch<any>(su(localUserId, 'role'), { body: { role, reason } });
export const revokeShopUserSessions = (localUserId: string) => apiFetch<any>(su(localUserId, 'revoke-sessions'), { body: {} });
export const createGlobalAdmin = (body: { name: string; email: string; password: string }) => apiFetch<any>('/api/admin/accounts/global-admins', { body });
const ga = (id: string, action: string) => `/api/admin/accounts/global-admins/${encodeURIComponent(id)}/${action}`;
export const setGlobalAdminActive = (id: string, active: boolean) => apiFetch<any>(ga(id, 'active'), { body: { active } });
export const resetGlobalAdminPassword = (id: string, password: string) => apiFetch<any>(ga(id, 'password'), { body: { password } });
export const revokeGlobalAdminSessions = (id: string) => apiFetch<any>(ga(id, 'revoke-sessions'), { body: {} });
export const deleteGlobalAdmin = (id: string) => apiFetch<any>(`/api/admin/accounts/global-admins/${encodeURIComponent(id)}`, { method: 'DELETE' });
