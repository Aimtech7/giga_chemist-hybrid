import { pgPool, withTransaction, HttpError } from '../db/client';
import { recordAuditLog } from '../db/audit';
import { collectRuntimeStatus, resetOperationalChecksCache, type ShopAlert } from '../sync/heartbeat';
import { syncWorker } from '../sync/worker';

/**
 * LOCAL ALERTS CENTER (local migration 024). The shop's alert conditions are derived from the SAME
 * function as the heartbeat (server/sync/heartbeat.ts deriveAlerts) plus shop-only shift checks, so
 * the shop and the cloud agree. Refreshing never duplicates: an open alert per key is updated, an
 * alert whose condition disappeared is RESOLVED, a condition that returns later opens a new row.
 * Works with the internet down (local PostgreSQL only).
 */
export const ALERT_TYPES: Record<string, string> = {
  LOW_STOCK: 'LOW_STOCK', OUT_OF_STOCK: 'OUT_OF_STOCK', NEAR_EXPIRY: 'EXPIRING_SOON', EXPIRED_STOCK: 'EXPIRED', DEAD_STOCK: 'DEAD_STOCK',
  SYNC_FAILING: 'SYNC_FAILURE', SYNC_HALTED: 'SYNC_FAILURE', OUTBOUND_REJECTED: 'SYNC_FAILURE', COMMANDS_REJECTED_24H: 'COMMAND_REJECTED',
  BACKUP_FAILED: 'BACKUP_FAILED', BACKUP_STALE: 'BACKUP_STALE', BACKUP_DISABLED: 'BACKUP_STALE', UPDATE_ROLLBACK: 'UPDATE_FAILED', UPDATE_FAILED: 'UPDATE_FAILED',
  DATA_INTEGRITY_WARNING: 'DATA_INTEGRITY_WARNING', LOGIN_SECURITY_WARNING: 'LOGIN_SECURITY_WARNING', DB_UNAVAILABLE: 'DATA_INTEGRITY_WARNING',
  LOW_DISK: 'SYSTEM_DISK', SERVICE_CRASHING: 'SYSTEM_SERVICE', SHIFT_LEFT_OPEN: 'SHIFT_LEFT_OPEN', SHIFT_SHORTAGE: 'SHIFT_SHORTAGE', SHIFT_OVERAGE: 'SHIFT_OVERAGE',
};
export const alertType = (key: string) => ALERT_TYPES[key.split(':')[0]] || key.split(':')[0];

interface LocalAlert extends ShopAlert { related_entity?: string; related_id?: string }

/** Shop-only alerts (the cloud raises its own from the shift events). */
async function shiftAlerts(): Promise<LocalAlert[]> {
  const out: LocalAlert[] = [];
  try {
    const open = (await pgPool.query(
      `SELECT x.id, x.shift_number, x.opened_business_date::text AS d, COALESCE(user_name_at(x.cashier_id, x.opened_at), u.name) AS cashier
         FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id
        WHERE x.status = 'OPEN' AND x.opened_business_date < (now() AT TIME ZONE 'Africa/Nairobi')::date`)).rows;
    for (const s of open) out.push({ key: `SHIFT_LEFT_OPEN:${s.id}`, kind: 'SHIFT', severity: 'WARNING', title: `Shift ${s.shift_number} (${s.cashier}) still open since ${s.d}`, related_entity: 'shift', related_id: s.id });
    const variance = (await pgPool.query(
      `SELECT x.id, x.shift_number, x.cash_variance::float AS v, COALESCE(user_name_at(x.cashier_id, x.opened_at), u.name) AS cashier
         FROM cashier_shifts x LEFT JOIN users u ON u.id = x.cashier_id
        WHERE x.status = 'CLOSED' AND COALESCE(x.cash_variance, 0) <> 0 AND x.closed_at > now() - interval '14 days'`)).rows;
    for (const s of variance) {
      out.push({ key: `${s.v < 0 ? 'SHIFT_SHORTAGE' : 'SHIFT_OVERAGE'}:${s.id}`, kind: 'SHIFT', severity: 'WARNING',
        title: `Shift ${s.shift_number} (${s.cashier}) cash ${s.v < 0 ? 'SHORT' : 'OVER'} ${Math.abs(s.v).toFixed(2)} — awaiting review`, related_entity: 'shift', related_id: s.id });
    }
  } catch {
    // before local migration 020: no shift alerts
  }
  return out;
}

let lastRefresh = 0;
export async function refreshLocalAlerts(force = false) {
  if (!force && Date.now() - lastRefresh < 30_000) return;
  lastRefresh = Date.now();
  const w = syncWorker.status();
  const status = await collectRuntimeStatus({ running: w.running, leader: w.leader, consecutive_failures: w.consecutive_failures, halted_reason: w.halted_reason });
  const present: LocalAlert[] = [...(status.alerts as LocalAlert[]), ...(await shiftAlerts())];
  await withTransaction(async (c) => {
    // One refresh at a time (two terminals opening the Alerts Center together never duplicate).
    await c.query('SELECT pg_advisory_xact_lock(7420317024)');
    for (const a of present) {
      const upd = await c.query(
        `UPDATE alerts SET last_seen_at = CURRENT_TIMESTAMP, severity = $2, title = $3, detail = $4 WHERE alert_key = $1 AND status <> 'RESOLVED'`,
        [a.key, a.severity, a.title, a.detail ?? null]);
      if (!upd.rowCount) {
        await c.query(
          `INSERT INTO alerts (alert_key, alert_type, kind, severity, title, detail, related_entity, related_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [a.key, alertType(a.key), a.kind, a.severity, a.title, a.detail ?? null, a.related_entity ?? null, a.related_id ?? null]);
      }
    }
    await c.query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP WHERE status <> 'RESOLVED' AND NOT (alert_key = ANY($1::text[]))`,
      [present.map((a) => a.key)]);
  });
}

export async function listLocalAlerts(query: Record<string, unknown>) {
  if (query.refresh === 'true') resetOperationalChecksCache();
  await refreshLocalAlerts(query.refresh === 'true');
  const status = typeof query.status === 'string' ? query.status.toUpperCase() : 'ACTIVE';
  const where = status === 'ALL' ? '' : status === 'RESOLVED' ? `WHERE status = 'RESOLVED'` : `WHERE status <> 'RESOLVED'`;
  const rows = (await pgPool.query(
    `SELECT id, alert_key, alert_type, kind, severity, title, detail, related_entity, related_id, status, first_seen_at, last_seen_at,
            acknowledged_by_name, acknowledged_at, resolved_at
       FROM alerts ${where}
      ORDER BY CASE status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
               CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, last_seen_at DESC
      LIMIT 500`)).rows;
  const counts = (await pgPool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open, COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED')::int AS acknowledged,
            COUNT(*) FILTER (WHERE status <> 'RESOLVED' AND severity = 'CRITICAL')::int AS critical FROM alerts`)).rows[0];
  return { alerts: rows, counts };
}

export async function acknowledgeLocalAlert(id: string, actor: { user_id: string; user_name: string; role: string; device_id?: string }) {
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(400, 'Alert id must be a number.');
  return withTransaction(async (c) => {
    const row = (await c.query(`SELECT id, alert_key, status FROM alerts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new HttpError(404, 'Alert not found.');
    if (row.status !== 'OPEN') throw new HttpError(409, `This alert is already ${row.status}.`);
    await c.query(`UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by_name = $2, acknowledged_at = CURRENT_TIMESTAMP WHERE id = $1`, [id, actor.user_name]);
    await recordAuditLog({ user_id: actor.user_id, user_name: actor.user_name, role: actor.role as any, device_id: actor.device_id,
      action: 'ALERT_ACKNOWLEDGED', entity: 'alert', entity_id: String(id), new_value: { alert_key: row.alert_key } } as any, c);
    return { id: Number(id), status: 'ACKNOWLEDGED' };
  });
}
