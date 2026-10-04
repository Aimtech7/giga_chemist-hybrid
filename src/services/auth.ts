import type { User, UserRole } from '../types';
import { db, getDeviceId } from '../db/dexie';
import { apiUrl } from './api';
import { supabase } from '../lib/supabase';
import { verifyBrowserCredential } from '../lib/crypto';
import { syncFromLocalApiToDexie, syncFromSupabaseToDexie } from './syncEngine';

export interface StoredUser extends User {
  pin?: string;
  passwordHash?: string;
}

export const INITIAL_USERS: StoredUser[] = [
  {
    id: 'usr-admin-01',
    name: 'Administrator',
    email: 'admin@gigachemist.co.ke',
    role: 'ADMIN',
    phone: '+254 700 123 456',
    active: true,
    created_at: '2026-01-01',
    pin: '1234',
  },
  {
    id: 'usr-cashier-01',
    name: 'Cashier',
    email: 'cashier@gigachemist.co.ke',
    role: 'CASHIER',
    phone: '+254 700 123 456',
    active: true,
    created_at: '2026-01-01',
    pin: '2026',
  },
];

const SESSION_KEY = 'giga_chemist_current_user';
const TOKEN_KEY = 'giga_chemist_auth_token';
const OFFLINE_SESSION_KEY = 'offline_session';
const OFFLINE_VALIDITY_HOURS = 24;

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) {}
}

export function getCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export function setCachedUser(user: User | null): void {
  try {
    if (user) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch (e) {}
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function loginWithPinOrEmail(identifier: string, secret: string): Promise<User> {
  const cleanId = identifier.trim();
  const cleanSecret = secret.trim();

  // 1. Attempt Server-Side Authentication
  try {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanId,
        username: cleanId,
        pin: cleanSecret || cleanId,
        password: cleanSecret,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user && data.token) {
        setAuthToken(data.token);
        setCachedUser(data.user);

        // Trigger background local API catalog & data sync into Dexie
        syncFromLocalApiToDexie().catch((e) => console.warn('[Auth] Background sync notice:', e));

        // Cache offline session in Dexie metadata for resilient PWA operation
        await db.meta.put({
          key: OFFLINE_SESSION_KEY,
          value: {
            user: data.user,
            token: data.token,
            cached_at: Date.now(),
            valid_until: Date.now() + OFFLINE_VALIDITY_HOURS * 3600 * 1000,
          },
        });

        // Audit log
        const deviceId = await getDeviceId();
        await db.audit_logs.put({
          id: `aud-login-${Date.now()}`,
          user_id: data.user.id,
          user_name: data.user.name,
          role: data.user.role,
          action: 'USER_LOGIN',
          entity: 'auth_session',
          entity_id: data.user.id,
          previous_value: 'offline_or_logged_out',
          new_value: 'logged_in_online',
          device_id: deviceId,
          timestamp: Date.now(),
          date: new Date().toISOString().split('T')[0],
        });

        return data.user;
      }
    } else {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        throw new Error(errData.error || 'Invalid credentials or inactive account.');
      }
    }
  } catch (netErr: any) {
    if (netErr.message && (netErr.message.includes('Invalid credentials') || netErr.message.includes('deactivated'))) {
      throw netErr;
    }
    // Network unreachable: Fallback to cached offline session
    console.warn('[Auth Service] Server unreachable, attempting offline session login...', netErr);
  }

  // 2. Attempt Cloud / Supabase Authentication (For Vercel / Remote Web Mode)
  if (supabase) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
      let query = supabase.from('users').select('*').eq('active', true);

      if (isUuid) {
        query = query.or(`email.ilike.${cleanId},name.ilike.${cleanId},id.eq.${cleanId}`);
      } else if (cleanId.includes('@') || (isNaN(Number(cleanId)) && cleanId.length > 0)) {
        query = query.or(`email.ilike.${cleanId},name.ilike.${cleanId}`);
      }

      const { data: cloudUsers, error: cloudErr } = await query;

      if (!cloudErr && cloudUsers && cloudUsers.length > 0) {
        for (const u of cloudUsers) {
          let isMatch = false;
          // Verify password hash if secret provided
          if (cleanSecret && u.password_hash) {
            isMatch = await verifyBrowserCredential(cleanSecret, u.password_hash);
          }
          // Verify pin hash if password didn't match or identifier was pin
          if (!isMatch && (cleanSecret || cleanId) && u.pin_hash) {
            isMatch = await verifyBrowserCredential(cleanSecret || cleanId, u.pin_hash);
          }

          if (isMatch) {
            const authenticatedUser: User = {
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              phone: u.phone,
              active: u.active,
              created_at: u.created_at,
            };

            const cloudToken = `cloud_session_${btoa(JSON.stringify({ id: u.id, role: u.role, time: Date.now() }))}`;
            setAuthToken(cloudToken);
            setCachedUser(authenticatedUser);

            // Cache offline session in Dexie metadata
            await db.meta.put({
              key: OFFLINE_SESSION_KEY,
              value: {
                user: authenticatedUser,
                token: cloudToken,
                cached_at: Date.now(),
                valid_until: Date.now() + OFFLINE_VALIDITY_HOURS * 3600 * 1000,
              },
            });

            // Trigger background catalog sync from Supabase into Dexie
            syncFromSupabaseToDexie().catch((e) => console.warn('[Sync] Background sync notice:', e));

            // Audit log
            const deviceId = await getDeviceId();
            await db.audit_logs.put({
              id: `aud-login-cloud-${Date.now()}`,
              user_id: authenticatedUser.id,
              user_name: authenticatedUser.name,
              role: authenticatedUser.role,
              action: 'USER_LOGIN_CLOUD',
              entity: 'auth_session',
              entity_id: authenticatedUser.id,
              previous_value: 'offline_or_logged_out',
              new_value: 'logged_in_supabase_cloud',
              device_id: deviceId,
              timestamp: Date.now(),
              date: new Date().toISOString().split('T')[0],
            });

            return authenticatedUser;
          }
        }
        throw new Error('Invalid credentials. Please verify your password or PIN.');
      }
    } catch (cloudAuthErr: any) {
      if (cloudAuthErr.message && cloudAuthErr.message.includes('Invalid credentials')) {
        throw cloudAuthErr;
      }
      console.warn('[Auth Service] Cloud Supabase authentication notice:', cloudAuthErr);
    }
  }

  // 3. Safe Offline Cached Session Authentication Policy
  const offlineSessionRecord = await db.meta.get(OFFLINE_SESSION_KEY);
  if (offlineSessionRecord && offlineSessionRecord.value) {
    const session = offlineSessionRecord.value;
    const now = Date.now();

    if (now <= session.valid_until) {
      const cachedUser = session.user as User;
      if (!cachedUser.active) {
        throw new Error('This user account has been disabled.');
      }

      // Verify offline matching user
      if (
        cachedUser.email.toLowerCase() === cleanId.toLowerCase() ||
        cachedUser.name.toLowerCase() === cleanId.toLowerCase() ||
        cachedUser.id === cleanId
      ) {
        setCachedUser(cachedUser);
        setAuthToken(session.token);

        const deviceId = await getDeviceId();
        await db.audit_logs.put({
          id: `aud-login-offline-${Date.now()}`,
          user_id: cachedUser.id,
          user_name: cachedUser.name,
          role: cachedUser.role,
          action: 'USER_LOGIN_OFFLINE',
          entity: 'auth_session',
          entity_id: cachedUser.id,
          previous_value: 'logged_out',
          new_value: 'logged_in_offline_cache',
          device_id: deviceId,
          timestamp: Date.now(),
          date: new Date().toISOString().split('T')[0],
        });

        return cachedUser;
      }
    }
  }

  // 4. Safe Standalone Offline Initial User Fallback (For offline setups without initial server sync)
  const matchingInitialUser = INITIAL_USERS.find(
    (u) =>
      u.email.toLowerCase() === cleanId.toLowerCase() ||
      u.name.toLowerCase() === cleanId.toLowerCase() ||
      u.id === cleanId
  );

  if (matchingInitialUser) {
    if (matchingInitialUser.pin && (cleanSecret === matchingInitialUser.pin || cleanId === matchingInitialUser.pin)) {
      const offlineUser: User = {
        id: matchingInitialUser.id,
        name: matchingInitialUser.name,
        email: matchingInitialUser.email,
        role: matchingInitialUser.role,
        phone: matchingInitialUser.phone,
        active: matchingInitialUser.active,
        created_at: matchingInitialUser.created_at,
      };

      const offlineToken = `offline_token_${Date.now()}`;
      setCachedUser(offlineUser);
      setAuthToken(offlineToken);

      await db.meta.put({
        key: OFFLINE_SESSION_KEY,
        value: {
          user: offlineUser,
          token: offlineToken,
          cached_at: Date.now(),
          valid_until: Date.now() + OFFLINE_VALIDITY_HOURS * 3600 * 1000,
        },
      });

      return offlineUser;
    }
  }

  throw new Error('Unable to authenticate. Please verify your credentials or check connection.');
}

export async function logoutUser(user?: User): Promise<void> {
  const currentUser = user || getCachedUser();
  if (currentUser) {
    const deviceId = await getDeviceId();
    await db.audit_logs.put({
      id: `aud-logout-${Date.now()}`,
      user_id: currentUser.id,
      user_name: currentUser.name,
      role: currentUser.role,
      action: 'USER_LOGOUT',
      entity: 'auth_session',
      entity_id: currentUser.id,
      previous_value: 'active_session',
      new_value: 'logged_out',
      device_id: deviceId,
      timestamp: Date.now(),
      date: new Date().toISOString().split('T')[0],
    });
  }
  setCachedUser(null);
  setAuthToken(null);
}

// Strict RBAC permission predicates
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
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
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
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}

export function canManageSuppliers(user?: User | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}

export function canViewReports(user?: User | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}

export function canVoidSale(user?: User | null): boolean {
  return user?.role === 'ADMIN';
}

export function canProcessReturn(user?: User | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}
