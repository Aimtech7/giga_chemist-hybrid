import fs from 'fs';
import path from 'path';
import { checkPgConnection } from '../db/client';
import { getSyncStatus } from '../sync/worker';
import { getEmailStatus } from '../email/service';
import { getBackupStatus, getBackupConfig } from './backup';
import { getShopIdentity } from '../sync/identity';

/**
 * Admin system health. Local PostgreSQL / local API decide whether the POS works; internet, cloud,
 * email and backups are reported separately and never affect selling. No secrets are returned.
 */
let appVersion = '0.0.0';
try {
  appVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version || appVersion;
} catch {
  /* keep default */
}
export const APP_VERSION = appVersion;

let internetCache: { at: number; online: boolean; detail: string } | null = null;

/** Real reachability check from the SERVER (not the browser's navigator.onLine). Cached 30 s. */
export async function checkInternet(): Promise<{ online: boolean; detail: string }> {
  if (internetCache && Date.now() - internetCache.at < 30_000) return internetCache;
  const url = process.env.INTERNET_CHECK_URL || 'https://www.gstatic.com/generate_204';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4000);
  let result: { online: boolean; detail: string };
  try {
    const r = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' as RequestCache });
    result = { online: r.status < 500, detail: `HTTP ${r.status}` };
  } catch (err: any) {
    const code = err?.cause?.code || err?.name;
    result = { online: false, detail: code === 'AbortError' ? 'timeout' : String(code || err?.message || 'unreachable') };
  } finally {
    clearTimeout(t);
  }
  internetCache = { at: Date.now(), ...result };
  return result;
}

function diskSpace(dir: string) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: dir, total_bytes: total, free_bytes: free, free_percent: total ? Math.round((free / total) * 1000) / 10 : null };
  } catch (err: any) {
    return { path: dir, error: String(err?.message || err) };
  }
}

export async function getSystemHealth() {
  const [pg, internet, sync, email, backup, identity] = await Promise.all([
    checkPgConnection(),
    checkInternet(),
    getSyncStatus().catch((e) => ({ error: String(e?.message || e) }) as any),
    getEmailStatus().catch((e) => ({ state: 'ERROR', error: String(e?.message || e) }) as any),
    getBackupStatus().catch((e) => ({ error: String(e?.message || e) }) as any),
    getShopIdentity().catch(() => null),
  ]);
  const counts = sync?.counts;
  const syncState = sync?.mode !== 'hybrid' ? 'LOCAL'
    : !sync.enabled ? 'DISABLED'
    : (counts?.failed || 0) > 0 ? 'ERROR'
    : (counts?.retrying || 0) > 0 ? 'RETRYING'
    : (counts?.pending || 0) + (counts?.processing || 0) > 0 ? 'PENDING'
    : 'SYNCED';
  const cloudState = sync?.mode !== 'hybrid' || !sync.enabled ? 'NOT_USED'
    : sync.cloud_reachable === true ? 'CONNECTED'
    : sync.cloud_reachable === false ? 'OFFLINE'
    : sync.cloud?.configured === false ? 'NOT_CONFIGURED' : 'UNKNOWN';
  return {
    generated_at: new Date().toISOString(),
    app_version: APP_VERSION,
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
    local_api: 'ONLINE',
    local_database: pg.connected ? 'ONLINE' : 'OFFLINE',
    local_database_error: pg.connected ? null : pg.error,
    internet: internet.online ? 'ONLINE' : 'OFFLINE',
    internet_detail: internet.detail,
    cloud: cloudState,
    sync: {
      state: syncState,
      mode: sync?.mode,
      enabled: sync?.enabled,
      pending: counts ? counts.pending + counts.processing : 0,
      retrying: counts?.retrying || 0,
      failed: counts?.failed || 0,
      last_sync: sync?.last_sync || null,
      last_error: sync?.last_error || null,
    },
    email: {
      state: email.state,
      pending: email.counts?.pending || 0,
      retrying: email.counts?.retrying || 0,
      failed: email.counts?.failed || 0,
      last_sent_at: email.last_sent_at || null,
      last_error: email.last_error?.error || email.error || null,
    },
    backup,
    disk: diskSpace(getBackupConfig().dir.split(path.sep).slice(0, 1).join(path.sep) + path.sep),
    shop_id: identity?.shop_id || null,
    shop_code: identity?.shop_code || null,
    device_id: sync?.device_id || process.env.DEVICE_ID || null,
  };
}
