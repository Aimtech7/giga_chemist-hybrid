import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured, cleanUuid, ensureUuid } from './client';
import { serverDb } from '../db';
import type { AuditLog } from '../../src/types';

export async function getAllAuditLogs(): Promise<AuditLog[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        id, user_id, user_name, role, action, entity, entity_id,
        previous_value, new_value, device_id, timestamp, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 500
    `);
    if (res.rows && res.rows.length > 0) {
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
        date: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : new Date(Number(r.timestamp) || Date.now()).toISOString().split('T')[0],
        timestamp: Number(r.timestamp) || (r.created_at ? new Date(r.created_at).getTime() : Date.now()),
      }));
    }
  } catch (err: any) {
    if (isLocalMode) {
      console.warn('[Server DB] pgPool.query error in getAllAuditLogs:', err.message);
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (!error && data) return data as AuditLog[];
    } catch (err) {
      console.warn('[Server DB] Supabase audit logs query failed:', err);
    }
  }
  return serverDb.get().audit_logs;
}

export async function recordAuditLog(
  log: Omit<AuditLog, 'id' | 'timestamp' | 'date' | 'device_id'> & {
    id?: string;
    timestamp?: number;
    date?: string;
    device_id?: string;
  }
): Promise<AuditLog> {
  const fullLog: AuditLog = {
    id: ensureUuid(log.id),
    user_id: log.user_id || 'system',
    user_name: log.user_name || 'System User',
    role: log.role || 'ADMIN',
    action: log.action,
    entity: log.entity,
    entity_id: String(log.entity_id || ''),
    previous_value: log.previous_value,
    new_value: log.new_value,
    device_id: log.device_id || 'SERVER',
    timestamp: log.timestamp || Date.now(),
    date: log.date || new Date().toISOString().split('T')[0],
  };

  try {
    await pgPool.query(`
      INSERT INTO audit_logs (
        id, user_id, user_name, role, action, entity, entity_id,
        previous_value, new_value, device_id, timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      fullLog.id,
      cleanUuid(fullLog.user_id),
      fullLog.user_name,
      fullLog.role,
      fullLog.action,
      fullLog.entity,
      fullLog.entity_id,
      fullLog.previous_value ? JSON.stringify(fullLog.previous_value) : null,
      fullLog.new_value ? JSON.stringify(fullLog.new_value) : null,
      fullLog.device_id,
      fullLog.timestamp,
    ]);
  } catch (pgErr: any) {
    console.error('[Server DB] recordAuditLog PostgreSQL error:', pgErr.message);
    if (isLocalMode) {
      throw pgErr;
    }
  }

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('audit_logs').insert({
        id: fullLog.id,
        user_id: cleanUuid(fullLog.user_id),
        user_name: fullLog.user_name,
        role: fullLog.role,
        action: fullLog.action,
        entity: fullLog.entity,
        entity_id: fullLog.entity_id,
        previous_value: fullLog.previous_value ? JSON.stringify(fullLog.previous_value) : null,
        new_value: fullLog.new_value ? JSON.stringify(fullLog.new_value) : null,
        device_id: fullLog.device_id,
        timestamp: fullLog.timestamp,
      });
    } catch (err) {
      console.warn('[Server DB] Supabase audit log insert failed:', err);
    }
  }

  const store = serverDb.get();
  store.audit_logs.unshift(fullLog);
  serverDb.persist();
  return fullLog;
}

