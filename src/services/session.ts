import type { User } from '../types';

/**
 * Single owner of the browser-side session: the server-issued JWT and the user it belongs to.
 * The token is the ONLY credential the API accepts; the cached user is display state only.
 */
const SESSION_KEY = 'giga_chemist_current_user';
const TOKEN_KEY = 'giga_chemist_auth_token';

/** Fired on window when the server rejects the session (401) or the token has expired. */
export const SESSION_EXPIRED_EVENT = 'giga:session-expired';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function getCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCachedUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

/** Expiry (ms since epoch) of a server JWT, or null if the value is not a decodable JWT. */
export function getTokenExpiry(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True only for a well-formed server JWT that has not expired (30 s safety margin). */
export function hasUsableToken(): boolean {
  const exp = getTokenExpiry(getAuthToken());
  return exp !== null && exp - 30_000 > Date.now();
}

export function clearSession(): void {
  setAuthToken(null);
  setCachedUser(null);
}

/** Clears the session and tells the app shell to show the login screen. */
export function expireSession(reason: string): void {
  clearSession();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { reason } }));
  }
}
