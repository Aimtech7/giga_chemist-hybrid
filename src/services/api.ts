/**
 * Centralized API URL resolution for Root, Subpath (e.g. /giga-chemist/), and Custom LAN hosts.
 */
export function getApiBaseUrl(): string {
  if (import.meta.env.VITE_API_URL) {
    return (import.meta.env.VITE_API_URL as string).replace(/\/$/, '');
  }

  if (typeof window !== 'undefined') {
    const pathname = window.location.pathname;
    // Detect Apache subfolder deployment like /giga-chemist/ or /giga-chemist/app/
    if (pathname.includes('/giga-chemist')) {
      return '/giga-chemist/api';
    }
  }

  return '/api';
}

export function apiUrl(endpoint: string): string {
  const base = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (base.endsWith('/api') && cleanEndpoint.startsWith('/api/')) {
    return `${base}${cleanEndpoint.substring(4)}`;
  }
  if (base.endsWith('/api') && cleanEndpoint === '/api') {
    return base;
  }

  return `${base}${cleanEndpoint}`;
}
