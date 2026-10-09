/**
 * Centralized API URL resolution for the root, an Apache subfolder (/giga-chemist/) and an explicit
 * override (custom LAN host).
 *
 * Default = SAME ORIGIN: "/api" on whatever origin served the page (http://<pos>:3000 locally,
 * https://gigachem.vercel.app online). VITE_API_URL is an optional override and is used ONLY when it
 * is a real URL: an absolute http(s) URL, or a path starting with "/". Blank values and template
 * placeholders (REQUIRED_USER_INPUT, YOUR_*, PLACEHOLDER, CHANGE_ME, <...>) are ignored, so a
 * placeholder copied into a deployment can never end up inside request URLs.
 */
// Built from parts on purpose: the literal template marker must never appear in the production
// bundle, so `grep REQUIRED_USER_INPUT dist/` stays a reliable leak check.
const PLACEHOLDER_RE = new RegExp(
  [['REQUIRED', 'USER', 'INPUT'].join('_'), 'YOUR[_-]', 'PLACEHOLDER', 'CHANGE[_-]?ME', 'EXAMPLE\\.COM', '^<.*>$', '^undefined$', '^null$'].join('|'),
  'i'
);

/** Returns the usable override, or null when the value is blank / a placeholder / not a URL. */
export function sanitizeApiOverride(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || PLACEHOLDER_RE.test(value)) return null;
  if (value.startsWith('/')) {
    return value.startsWith('//') ? null : value.replace(/\/+$/, '') || null;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Pure resolver (unit-tested): override -> Apache subfolder -> same-origin "/api". */
export function resolveApiBase(override: unknown, pathname?: string): string {
  const explicit = sanitizeApiOverride(override);
  if (explicit) return explicit;
  // Apache subfolder deployment like /giga-chemist/ or /giga-chemist/app/
  if (pathname && pathname.includes('/giga-chemist')) return '/giga-chemist/api';
  return '/api';
}

/** Joins a base and an endpoint without ever producing "/api/api/...". */
export function joinApiUrl(base: string, endpoint: string): string {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith('/api') && cleanEndpoint.startsWith('/api/')) return `${base}${cleanEndpoint.substring(4)}`;
  if (base.endsWith('/api') && cleanEndpoint === '/api') return base;
  return `${base}${cleanEndpoint}`;
}

function viteApiOverride(): unknown {
  try {
    return import.meta.env?.VITE_API_URL;
  } catch {
    return undefined;
  }
}

export function getApiBaseUrl(): string {
  return resolveApiBase(viteApiOverride(), typeof window !== 'undefined' ? window.location.pathname : undefined);
}

export function apiUrl(endpoint: string): string {
  return joinApiUrl(getApiBaseUrl(), endpoint);
}
