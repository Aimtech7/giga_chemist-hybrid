import { getAppMode } from '../db/client';

/**
 * Hybrid sync configuration, read from the server environment only. Nothing here is ever sent to
 * the browser except through describeSyncConfig(), which carries no secrets.
 *
 *   APP_MODE=hybrid       PostgreSQL authoritative + durable outbox (events are recorded)
 *   SYNC_ENABLED=true     the background worker actually talks to the cloud
 */
export interface SyncConfig {
  mode: 'local' | 'hybrid' | 'cloud';
  /** Outbox rows are written by business transactions (APP_MODE=hybrid). */
  outboxEnabled: boolean;
  /** Worker runs (hybrid + SYNC_ENABLED=true). */
  workerEnabled: boolean;
  /** Cloud endpoint + credentials present and valid. */
  cloudConfigured: boolean;
  /** Why the cloud is not usable (configuration problem), if it is not. */
  configError: string | null;
  cloudUrl: string;
  /** Gateway key for the Supabase REST endpoint (anon key preferred; service role only if set). */
  apiKey: string;
  apiKeyKind: 'anon' | 'service_role' | 'none';
  /** Per-shop sync credential verified by the cloud RPC functions. */
  shopToken: string;
  envShopId: string | null;
  deviceId: string;
  intervalMs: number;
  batchSize: number;
  httpTimeoutMs: number;
  maxBackoffMs: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.max(min, v));
}

function clean(v: string | undefined): string {
  const s = (v || '').trim();
  return /YOUR_|your-project|placeholder/i.test(s) ? '' : s;
}

let cached: SyncConfig | null = null;

export function getSyncConfig(): SyncConfig {
  if (cached) return cached;
  const mode = getAppMode();
  const outboxEnabled = mode === 'hybrid';
  const workerEnabled = outboxEnabled && String(process.env.SYNC_ENABLED || '').toLowerCase().trim() === 'true';

  const cloudUrl = clean(process.env.SUPABASE_URL).replace(/\/+$/, '');
  const anon = clean(process.env.SUPABASE_ANON_KEY);
  const service = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const apiKey = anon || service;
  const shopToken = clean(process.env.SYNC_SHOP_TOKEN);
  const envShopIdRaw = clean(process.env.SHOP_ID);

  let configError: string | null = null;
  if (!cloudUrl) configError = 'SUPABASE_URL is not set.';
  else {
    try {
      const u = new URL(cloudUrl);
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
      // TLS is mandatory for any real cloud. Plain http is accepted only for a loopback emulator.
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
        configError = 'SUPABASE_URL must use https:// (plain http is allowed only for a localhost emulator).';
      }
    } catch {
      configError = 'SUPABASE_URL is not a valid URL.';
    }
  }
  if (!configError && !apiKey) configError = 'SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) is not set.';
  if (!configError && shopToken.length < 32) configError = 'SYNC_SHOP_TOKEN must be at least 32 characters.';
  if (!configError && envShopIdRaw && !UUID_RE.test(envShopIdRaw)) configError = 'SHOP_ID must be a UUID.';

  cached = {
    mode,
    outboxEnabled,
    workerEnabled,
    cloudConfigured: !configError,
    configError,
    cloudUrl,
    apiKey,
    apiKeyKind: anon ? 'anon' : service ? 'service_role' : 'none',
    shopToken,
    envShopId: envShopIdRaw && UUID_RE.test(envShopIdRaw) ? envShopIdRaw.toLowerCase() : null,
    deviceId: (process.env.DEVICE_ID || 'SERVER').trim().slice(0, 100) || 'SERVER',
    intervalMs: num('SYNC_INTERVAL_SECONDS', 30, 1, 3600) * 1000,
    batchSize: Math.round(num('SYNC_BATCH_SIZE', 50, 1, 200)),
    httpTimeoutMs: num('SYNC_HTTP_TIMEOUT_MS', 10_000, 500, 120_000),
    maxBackoffMs: num('SYNC_MAX_BACKOFF_SECONDS', 120, 1, 3600) * 1000,
  };
  return cached;
}

/** Host part of the cloud URL only (no path, no keys) for status/diagnostics. */
export function cloudHost(cfg: SyncConfig = getSyncConfig()): string | null {
  try {
    return cfg.cloudUrl ? new URL(cfg.cloudUrl).host : null;
  } catch {
    return null;
  }
}
