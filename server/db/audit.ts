import { pgPool, cleanUuid, ensureUuid, type Queryable } from './client';
import type { AuditLog } from '../../src/types';

export async function getAllAuditLogs(): Promise<AuditLog[]> {
  const res = await pgPool.query(`
    SELECT
      id, user_id, user_name, role, action, entity, entity_id,
      previous_value, new_value, device_id, timestamp, created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 500
  `);
  return res.rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name || 'System User',
    role: r.role || 'ADMIN',
    action: r.action,
    entity: r.entity,
    entity_id: r.entity_id,
    previous_value: r.previous_value,
    new_value: r.new_value,
    device_id: r.device_id || 'SERVER',
    date: r.created_at
      ? new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
      : '',
    timestamp: Number(r.timestamp) || (r.created_at ? new Date(r.created_at).getTime() : Date.now()),
  }));
}

/**
 * audit_logs.previous_value/new_value are JSONB. Callers historically passed JSON.stringify(...)
 * strings, which were then encoded a second time; parse such strings back so they are stored once.
 */
function toJsonb(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

export type AuditEntry = Omit<AuditLog, 'id' | 'timestamp' | 'date' | 'device_id' | 'previous_value' | 'new_value'> & {
  /** Structured JSON (preferred) or a legacy JSON string. */
  previous_value?: unknown;
  new_value?: unknown;
  id?: string;
  timestamp?: number;
  date?: string;
  device_id?: string;
};

/**
 * Writes one audit row. Pass a transaction client to make the audit row part of the business
 * transaction. PostgreSQL errors always propagate — an audit write never silently disappears.
 */
export async function recordAuditLog(log: AuditEntry, q: Queryable = pgPool): Promise<AuditLog> {
  const fullLog: AuditLog = {
    id: ensureUuid(log.id),
    user_id: log.user_id || 'system',
    user_name: log.user_name || 'System User',
    role: log.role || 'ADMIN',
    action: log.action,
    entity: log.entity,
    entity_id: String(log.entity_id || ''),
    previous_value: log.previous_value as any,
    new_value: log.new_value as any,
    device_id: log.device_id || 'SERVER',
    timestamp: log.timestamp || Date.now(),
    date: log.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }),
  };

  await q.query(
    `INSERT INTO audit_logs (
       id, user_id, user_name, role, action, entity, entity_id,
       previous_value, new_value, device_id, timestamp
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fullLog.id,
      cleanUuid(fullLog.user_id),
      fullLog.user_name,
      fullLog.role,
      fullLog.action,
      fullLog.entity,
      fullLog.entity_id,
      toJsonb(fullLog.previous_value),
      toJsonb(fullLog.new_value),
      fullLog.device_id,
      fullLog.timestamp,
    ]
  );
  return fullLog;
}
