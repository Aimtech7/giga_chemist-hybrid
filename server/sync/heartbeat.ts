import fs from 'fs';
import path from 'path';
import { pgPool, getAppMode } from '../db/client';
import { getBackupStatus, getBackupConfig } from '../ops/backup';
import { appVersion, currentCommit, readUpdateState, recentRestarts, sanitizeText } from '../ops/runtime';
import { getSyncConfig } from './config';

/**
 * Shop -> cloud HEARTBEAT (public.gc_heartbeat, cloud migration 004).
 *
 * The sync worker reports the shop computer's runtime state every HEARTBEAT_INTERVAL_SECONDS so the
 * Administrator's phone can tell "shop PC online" from "web app online" (by heartbeat age), and see
 * sanitized diagnostics. It also carries the shop-side ALERT conditions; the cloud keeps one alert
 * row per condition and resolves it when the condition disappears.
 *
 * Never sent: connection strings, passwords, keys, tokens, environment values, file contents.
 * Error texts go through sanitizeText(). Collection never throws: a broken part is reported as such.
 */
const STARTED_AT = new Date().toISOString();

export interface ShopAlert {
  key: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  detail?: string;
}

async function q<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  try {
    return (await pgPool.query(sql, params)).rows[0] as T;
  } catch {
    return null;
  }
}

function disk(dir: string) {
  try {
    const s = fs.statfsSync(dir);
    return { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Staff accounts for the online "publish existing shop users" DRY RUN: identity, role, active and
 * whether the stored password is in the publishable PBKDF2 format (a yes/no — never the hash or PIN).
 * pending = changed since the last credential publish. Null before local migration 016.
 */
async function staffCredentialSummary() {
  try {
    return (await pgPool.query(
      `SELECT id AS local_user_id, name, LOWER(email) AS email, LOWER(username) AS username, role, active,
              (password_hash ~ '^[0-9a-f]{32}[$][0-9a-f]{128}$') AS publishable,
              (auth_sync_seq > auth_synced_seq) AS pending
         FROM users ORDER BY role, name LIMIT 200`)).rows;
  } catch {
    return null;
  }
}

/**
 * Slower operational checks (cached 10 minutes): dead stock, data integrity, failed logins. Counts
 * only; null when a check cannot run (e.g. before its migration).
 */
let checksCache: { at: number; value: any } | null = null;
export function resetOperationalChecksCache() {
  checksCache = null;
}
async function operationalChecks() {
  const ttl = (Number(process.env.OPS_CHECKS_CACHE_SECONDS) > 0 ? Number(process.env.OPS_CHECKS_CACHE_SECONDS) : 600) * 1000;
  if (checksCache && Date.now() - checksCache.at < ttl) return checksCache.value;
  const value = await q<any>(`
    SELECT
      (SELECT COUNT(*) FROM medicines m WHERE m.status = 'active' AND m.current_stock > 0
          AND NOT EXISTS (SELECT 1 FROM sale_items i JOIN sales s ON s.id = i.sale_id
                           WHERE i.medicine_id = m.id AND s.status <> 'voided' AND s.date >= (now() AT TIME ZONE 'Africa/Nairobi')::date - 89))::int AS dead_stock,
      (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available < 0)::int AS negative_batches,
      (SELECT COUNT(*) FROM medicines WHERE current_stock < 0)::int AS negative_medicines,
      -- medicines.current_stock is refreshed when a batch changes: a batch that expired since then is still
      -- counted. Mismatch = matches NEITHER the unexpired sum NOR the sum including expired active batches.
      (SELECT COUNT(*) FROM medicines m
        CROSS JOIN LATERAL (SELECT COALESCE(SUM(b.quantity_available) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE), 0) AS fresh,
                                   COALESCE(SUM(b.quantity_available), 0) AS all_active
                              FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active') t
        WHERE m.current_stock <> t.fresh AND m.current_stock <> t.all_active)::int AS stock_mismatch,
      (SELECT COUNT(*) FROM audit_logs WHERE action = 'LOGIN_FAILED' AND created_at > now() - interval '1 hour')::int AS failed_logins_1h`);
  checksCache = { at: Date.now(), value };
  return value;
}

export interface WorkerSnapshot {
  running: boolean;
  leader: boolean;
  consecutive_failures: number;
  halted_reason: string | null;
}

async function buildStatus(worker: WorkerSnapshot) {
  const cfg = getSyncConfig();
  const dbOk = await q<{ ok: number }>('SELECT 1 AS ok');
  const out = await q<any>(`
    SELECT COUNT(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::int AS pending,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           MIN(created_at) FILTER (WHERE status IN ('PENDING', 'PROCESSING')) AS oldest_pending_at,
           MAX(synced_at) AS last_synced_at,
           MAX(seq) AS last_seq, MAX(seq) FILTER (WHERE status = 'SYNCED') AS last_synced_seq
      FROM sync_events`);
  const inbound = await q<any>(`SELECT COUNT(*) FILTER (WHERE acked_at IS NULL)::int AS unacked,
                                       COUNT(*) FILTER (WHERE status = 'REJECTED' AND received_at > now() - interval '1 day')::int AS rejected_24h
                                  FROM sync_inbound_commands`);
  const state = await q<any>(`SELECT MAX(value) FILTER (WHERE key = 'last_success_at') AS last_success_at,
                                     MAX(value) FILTER (WHERE key = 'last_error') AS last_error
                                FROM sync_state`);
  const inv = await q<any>(`
    SELECT (SELECT COALESCE(SUM(current_stock), 0)::int FROM medicines WHERE status <> 'archived') AS stock_total_units,
           (SELECT COUNT(*)::int FROM medicines WHERE status <> 'archived') AS medicine_count,
           (SELECT COUNT(*)::int FROM medicine_batches WHERE status <> 'archived') AS batch_count,
           (SELECT COALESCE(MAX(seq), 0)::bigint FROM sync_events) AS stock_sequence,
           (SELECT MAX(checked_at)::text FROM stock_parity_log) AS stock_parity_checked_at,
           (SELECT COUNT(*)::int FROM stock_parity_log WHERE outcome = 'PERSISTENT_MISMATCH' AND reconciled = FALSE) AS stock_mismatch_count,
       (SELECT COUNT(*) FROM medicines WHERE status = 'active' AND current_stock > 0 AND current_stock <= COALESCE(reorder_level, 0))::int AS low_stock,
           (SELECT COUNT(*) FROM medicines WHERE status = 'active' AND current_stock <= 0)::int AS out_of_stock,
           (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available > 0 AND expiry_date > CURRENT_DATE
              AND expiry_date <= CURRENT_DATE + 30)::int AS near_expiry,
           (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available > 0 AND expiry_date <= CURRENT_DATE)::int AS expired`);
  let backup: any = null;
  try {
    const b = await getBackupStatus();
    backup = {
      enabled: b.enabled, schedule_time: b.schedule_time, keep: b.keep, keep_weekly: (b as any).keep_weekly,
      weekly_count: (b as any).weekly_count, next_backup_at: (b as any).next_backup_at,
      last_success_at: b.last_success_at, last_success_size_bytes: b.last_success_size_bytes,
      last_success_verified: (b as any).last_success_verified, age_hours: b.age_hours,
      last_attempt_status: b.last_attempt_status, last_error: sanitizeText(b.last_error), last_error_at: b.last_error_at,
    };
  } catch (err: any) {
    backup = { error: sanitizeText(err?.message || err) };
  }
  const staff = await staffCredentialSummary();
  const checks = await operationalChecks();
  const update = readUpdateState();
  const d = disk(path.parse(getBackupConfig().dir).root || getBackupConfig().dir) || disk(process.cwd());
  const status = {
    device_id: cfg.deviceId,
    mode: getAppMode(),
    app_version: appVersion(),
    git_commit: currentCommit(),
    sync_protocol_version: 2,
    capabilities: ['MEDICINE_DELETE', 'STOCK_PARITY', 'REJECTED_CHANGES', 'ATOMIC_BASELINE'],
    node_version: process.version,
    started_at: STARTED_AT,
    uptime_seconds: Math.round(process.uptime()),
    db_healthy: Boolean(dbOk),
    worker: { running: worker.running, leader: worker.leader, consecutive_failures: worker.consecutive_failures, halted: sanitizeText(worker.halted_reason) },
    outbound: out ? { pending: out.pending, failed: out.failed, oldest_pending_at: out.oldest_pending_at,
      last_seq: out.last_seq !== null ? Number(out.last_seq) : null, last_synced_seq: out.last_synced_seq !== null ? Number(out.last_synced_seq) : null } : null,
    inbound: inbound ? { unacked: inbound.unacked, rejected_24h: inbound.rejected_24h } : null,
    last_sync_at: state?.last_success_at || (out?.last_synced_at ? new Date(out.last_synced_at).toISOString() : null),
    last_error: sanitizeText(state?.last_error),
    disk: d,
    backup,
    remote_backup: { enabled: String(process.env.REMOTE_BACKUP_ENABLED || '').toLowerCase() === 'true', status: 'NOT_IMPLEMENTED' },
    update: update ? {
      status: update.status, channel: update.channel ?? null, current_commit: update.current_commit ?? null, current_version: update.current_version ?? null,
      available_commit: update.available_commit ?? null, available_version: update.available_version ?? null, checked_at: update.checked_at ?? null,
      last_install: update.last_install ?? null, message: sanitizeText(update.message),
    } : null,
    restarts_last_hour: recentRestarts(1),
    inventory: inv,
    staff,
    checks,
  };
  return status;
}

export async function collectRuntimeStatus(worker: WorkerSnapshot) {
  const status = await buildStatus(worker);
  return { ...status, alerts: deriveAlerts(status) };
}

type Status = Awaited<ReturnType<typeof buildStatus>>;

/** Shop-side alert conditions present NOW (the cloud resolves those that disappear). */
export function deriveAlerts(s: Status): ShopAlert[] {
  const a: ShopAlert[] = [];
  if (!s.db_healthy) a.push({ key: 'DB_UNAVAILABLE', kind: 'DATABASE', severity: 'CRITICAL', title: 'Shop database unavailable' });
  if ((s.worker.consecutive_failures || 0) >= 5) a.push({ key: 'SYNC_FAILING', kind: 'SYNC', severity: 'WARNING', title: 'Sync is failing', detail: s.last_error || undefined });
  if (s.worker.halted) a.push({ key: 'SYNC_HALTED', kind: 'SYNC', severity: 'CRITICAL', title: 'Sync halted', detail: s.worker.halted });
  if ((s.outbound?.failed || 0) > 0) a.push({ key: 'OUTBOUND_REJECTED', kind: 'SYNC', severity: 'WARNING', title: `${s.outbound!.failed} event(s) rejected by the cloud` });
  const b = s.backup || {};
  if (b.last_attempt_status === 'FAILED') a.push({ key: 'BACKUP_FAILED', kind: 'BACKUP', severity: 'CRITICAL', title: 'Last backup FAILED', detail: b.last_error || undefined });
  if (b.enabled === false) a.push({ key: 'BACKUP_DISABLED', kind: 'BACKUP', severity: 'WARNING', title: 'Automatic backups are disabled (BACKUP_ENABLED)' });
  else if (b.enabled && (b.age_hours === null || b.age_hours > 26)) a.push({ key: 'BACKUP_STALE', kind: 'BACKUP', severity: 'WARNING', title: b.age_hours === null ? 'No successful backup yet' : `Last good backup is ${Math.round(b.age_hours)} h old` });
  if (s.disk && s.disk.total_bytes > 0) {
    const pct = (s.disk.free_bytes / s.disk.total_bytes) * 100;
    if (pct < 10 || s.disk.free_bytes < 5 * 1024 ** 3) a.push({ key: 'LOW_DISK', kind: 'DISK', severity: pct < 5 ? 'CRITICAL' : 'WARNING', title: `Low disk space: ${(s.disk.free_bytes / 1024 ** 3).toFixed(1)} GB free (${pct.toFixed(0)}%)` });
  }
  const i = s.inventory;
  if (i?.out_of_stock) a.push({ key: 'OUT_OF_STOCK', kind: 'STOCK', severity: 'WARNING', title: `${i.out_of_stock} active medicine(s) out of stock` });
  if (i?.low_stock) a.push({ key: 'LOW_STOCK', kind: 'STOCK', severity: 'INFO', title: `${i.low_stock} medicine(s) at or below reorder level` });
  if (i?.near_expiry) a.push({ key: 'NEAR_EXPIRY', kind: 'EXPIRY', severity: 'INFO', title: `${i.near_expiry} batch(es) expire within 30 days` });
  if (i?.expired) a.push({ key: 'EXPIRED_STOCK', kind: 'EXPIRY', severity: 'WARNING', title: `${i.expired} batch(es) with expired stock on hand` });
  const li = s.update?.last_install;
  if (li && Date.now() - Date.parse(li.at) < 7 * 86_400_000) {
    if (li.result === 'ROLLED_BACK') a.push({ key: `UPDATE_ROLLBACK:${li.to}`, kind: 'UPDATE', severity: 'CRITICAL', title: 'Update failed - ROLLBACK PERFORMED', detail: sanitizeText(li.detail) || undefined });
    else if (li.result === 'FAILED') a.push({ key: `UPDATE_FAILED:${li.to}`, kind: 'UPDATE', severity: 'CRITICAL', title: 'Update failed', detail: sanitizeText(li.detail) || undefined });
  }
  if (s.restarts_last_hour >= 3) a.push({ key: 'SERVICE_CRASHING', kind: 'SERVICE', severity: 'CRITICAL', title: `Server restarted ${s.restarts_last_hour} times in the last hour` });
  const c = s.checks;
  if (c?.dead_stock) a.push({ key: 'DEAD_STOCK', kind: 'STOCK', severity: 'INFO', title: `${c.dead_stock} medicine(s) in stock with no sale in 90 days` });
  if (c && (c.negative_batches || c.negative_medicines || c.stock_mismatch)) {
    a.push({ key: 'DATA_INTEGRITY_WARNING', kind: 'INTEGRITY', severity: c.negative_batches || c.negative_medicines ? 'CRITICAL' : 'WARNING',
      title: 'Stock data needs attention', detail: `negative batches ${c.negative_batches}, negative medicines ${c.negative_medicines}, medicine total != batches ${c.stock_mismatch}` });
  }
  if ((c?.failed_logins_1h || 0) >= 10) a.push({ key: 'LOGIN_SECURITY_WARNING', kind: 'SECURITY', severity: 'WARNING', title: `${c.failed_logins_1h} failed logins at the shop in the last hour` });
  if ((s.inbound?.rejected_24h || 0) > 0) a.push({ key: 'COMMANDS_REJECTED_24H', kind: 'COMMAND', severity: 'INFO', title: `${s.inbound!.rejected_24h} remote change(s) rejected in the last 24 h` });
  return a;
}
