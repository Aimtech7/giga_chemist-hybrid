import { apiUrl } from './api';
import { getAuthToken, hasUsableToken, expireSession } from './session';
import { isAllShopsScope, selectedShopId, setSelectedShop } from './shopContext';

/**
 * Canonical client for the local GIGA CHEMIST API. Every protected request goes through apiFetch so
 * that it always carries the server JWT (Authorization: Bearer) and the terminal id, never parses
 * HTML as JSON, and turns a rejected session into a single logout event.
 */
export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** Same key as services/device.ts; read synchronously so headers can be built without Dexie. */
const DEVICE_STORAGE_KEY = 'giga_chemist_device_id';

function deviceIdHeader(): string | null {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Public endpoints (login, health) skip the token requirement. */
  auth?: boolean;
}

export async function apiFetch<T = any>(endpoint: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = options.body !== undefined ? 'POST' : 'GET', body, signal, auth = true } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const deviceId = deviceIdHeader();
  if (deviceId) headers['X-Device-Id'] = deviceId;

  if (auth) {
    if (!hasUsableToken()) {
      expireSession('missing_or_expired_token');
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
    headers.Authorization = `Bearer ${getAuthToken()}`;
  }
  // Online app: the shop the Administrator selected (re-authorized by the server on every request).
  // Never set on the local pharmacy app, so local requests are unchanged.
  const allShops = auth && isAllShopsScope();
  const shopId = auth && !allShops ? selectedShopId() : null;
  if (shopId) headers['X-GIGA-SHOP-ID'] = shopId;
  if (allShops) headers['X-GIGA-SCOPE'] = 'ALL'; // read-only consolidated view: the server refuses shop writes

  let res: Response;
  try {
    res = await fetch(apiUrl(endpoint), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the GIGA CHEMIST server. Check that the POS server is running.');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (res.status === 401 && auth) {
    expireSession('rejected_by_server');
    throw new ApiError(401, data?.error || 'Your session has expired. Please log in again.', data);
  }
  if (shopId && ['SHOP_ACCESS_DENIED', 'SHOP_NOT_FOUND', 'SHOP_ID_INVALID'].includes(data?.code)) {
    // The remembered shop is no longer allowed (deactivated, other account): fall back to the default.
    setSelectedShop(null);
    if (typeof window !== 'undefined') window.location.reload();
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `Request failed: ${method} ${endpoint} (HTTP ${res.status})`, data);
  }
  if (!isJson) {
    throw new ApiError(res.status, `Expected JSON from ${endpoint} but the server returned ${res.headers.get('content-type') || 'no content type'}.`);
  }
  return data as T;
}

/**
 * Downloads a file from an authenticated endpoint (history CSV exports), with the same shop context
 * headers as apiFetch. The browser saves it; nothing is cached.
 */
export async function apiDownload(endpoint: string, filename: string): Promise<void> {
  if (!hasUsableToken()) {
    expireSession('missing_or_expired_token');
    throw new ApiError(401, 'Your session has expired. Please log in again.');
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${getAuthToken()}` };
  if (isAllShopsScope()) headers['X-GIGA-SCOPE'] = 'ALL';
  else {
    const shopId = selectedShopId();
    if (shopId) headers['X-GIGA-SHOP-ID'] = shopId;
  }
  const res = await fetch(apiUrl(endpoint), { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error || `Download failed (HTTP ${res.status})`, data);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
