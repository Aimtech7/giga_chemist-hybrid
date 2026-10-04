import type { User } from '../types';
import { apiFetch, ApiError } from './http';
import { getOrRegisterDevice } from './device';
import { syncFromLocalApiToDexie } from './syncEngine';
import {
  getAuthToken,
  setAuthToken,
  getCachedUser,
  setCachedUser,
  clearSession,
  hasUsableToken,
} from './session';

export { getAuthToken, setAuthToken, getCachedUser, setCachedUser, hasUsableToken };

/**
 * Authentication is performed ONLY by the local GIGA CHEMIST server against the PostgreSQL users
 * table (PBKDF2 hashes). The server runs on the same PC, so login works without internet.
 * There are no built-in accounts, no identifier-only offline logins and no client-made tokens.
 */

/** @deprecated Use apiFetch from services/http, which attaches these automatically. */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface LoginResponse {
  success: boolean;
  user: User;
  token: string;
  permissions: string[];
}

export async function loginWithPinOrEmail(identifier: string, secret: string): Promise<User> {
  const email = identifier.trim();
  const cleanSecret = secret.trim();
  if (!email || !cleanSecret) throw new Error('Enter your email and password (or PIN).');

  try {
    // Make sure the terminal id exists before the first request so it is sent as X-Device-Id.
    await getOrRegisterDevice();
    const data = await apiFetch<LoginResponse>('/api/auth/login', {
      auth: false,
      body: { email, password: cleanSecret },
    });
    if (!data?.token || !data.user) throw new Error('The server returned an incomplete login response.');

    setAuthToken(data.token);
    setCachedUser(data.user);

    // Register this terminal in PostgreSQL and hydrate the local cache in the background.
    apiFetch('/api/devices/register', { body: { device_id: (await getOrRegisterDevice()).id } }).catch((e) =>
      console.warn('[Auth] Device registration failed:', e.message)
    );
    syncFromLocalApiToDexie().catch((e) => console.warn('[Auth] Background sync failed:', e));
    return data.user;
  } catch (err: any) {
    if (err instanceof ApiError && err.status === 0) {
      throw new Error('Cannot reach the GIGA CHEMIST server on this PC. Start the POS server and try again.');
    }
    throw new Error(err?.message || 'Login failed.');
  }
}

/**
 * Confirms the stored session with the server. Returns the current user (role/active from the
 * database), null when the session is invalid, or the cached user if the server is unreachable.
 */
export async function verifySession(): Promise<User | null> {
  if (!hasUsableToken()) {
    clearSession();
    return null;
  }
  try {
    const data = await apiFetch<{ user: User }>('/api/auth/me');
    const merged = { ...(getCachedUser() || {}), ...data.user } as User;
    setCachedUser(merged);
    return merged;
  } catch (err: any) {
    if (err instanceof ApiError && err.status === 0) return getCachedUser();
    clearSession();
    return null;
  }
}

export async function logoutUser(_user?: User): Promise<void> {
  clearSession();
}

// Strict RBAC permission predicates (UI only — the server enforces every rule independently)
export function canEditPrice(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canAdjustStock(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canAddOrDeleteMedicine(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canManageBatches(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canManageUsers(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canManageSettings(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canViewAuditLogs(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canReceivePurchases(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canManageSuppliers(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canViewReports(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canVoidSale(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canProcessReturn(user?: User | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'CASHIER';
}
