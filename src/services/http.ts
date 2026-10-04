import { apiUrl } from './api';
import { getAuthToken, hasUsableToken, expireSession } from './session';

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
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `Request failed: ${method} ${endpoint} (HTTP ${res.status})`, data);
  }
  if (!isJson) {
    throw new ApiError(res.status, `Expected JSON from ${endpoint} but the server returned ${res.headers.get('content-type') || 'no content type'}.`);
  }
  return data as T;
}
