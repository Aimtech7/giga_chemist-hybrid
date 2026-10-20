import { pgPool, HttpError } from '../db/client';
import { getSyncConfig } from './config';
import { callCloud } from './cloudClient';
import { syncWorker } from './worker';
import { classifyFailure, type FailureCategory } from './conflicts';
import { sanitizeText } from '../ops/runtime';
import { getShopIdentity } from './identity';

export interface FailedEventDiagnostic {
  id: string;
  seq: number;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  last_attempt_at: string | null;
  category: FailureCategory;
}

export interface DiagnosticsReport {
  total_failed: number;
  events: FailedEventDiagnostic[];
  grouped_by_event_type: Record<string, number>;
  grouped_by_category: Record<string, number>;
  sanitized: boolean;
}

export async function getFailedEventsDiagnostics(): Promise<DiagnosticsReport> {
  const res = await pgPool.query(`
    SELECT id, seq, event_type, entity_type, entity_id, attempt_count, last_error, created_at, last_attempt_at
      FROM sync_events
     WHERE status = 'FAILED'
     ORDER BY seq ASC
  `);

  const events: FailedEventDiagnostic[] = [];
  const grouped_by_event_type: Record<string, number> = {};
  const grouped_by_category: Record<string, number> = {};

  for (const r of res.rows) {
    const sanitizedError = sanitizeText(r.last_error || '');
    const cat = classifyFailure(r.event_type, sanitizedError);
    events.push({
      id: r.id,
      seq: Number(r.seq),
      event_type: r.event_type,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      attempt_count: r.attempt_count,
      last_error: sanitizedError,
      created_at: r.created_at,
      last_attempt_at: r.last_attempt_at,
      category: cat,
    });
    grouped_by_event_type[r.event_type] = (grouped_by_event_type[r.event_type] || 0) + 1;
    grouped_by_category[cat] = (grouped_by_category[cat] || 0) + 1;
  }

  return {
    total_failed: events.length,
    events,
    grouped_by_event_type,
    grouped_by_category,
    sanitized: true,
  };
}

export async function safeRetryFailedEvents(
  eventIds?: string[],
  options?: { allowUnverifiedFallback?: boolean }
): Promise<{
  success: boolean;
  total: number;
  already_applied_by_cloud: number;
  requeued_for_retry: number;
}> {
  const query = eventIds && eventIds.length > 0
    ? `SELECT id, seq, idempotency_key, event_type, entity_id FROM sync_events WHERE status = 'FAILED' AND id = ANY($1::uuid[]) ORDER BY seq`
    : `SELECT id, seq, idempotency_key, event_type, entity_id FROM sync_events WHERE status = 'FAILED' ORDER BY seq`;

  const params = eventIds && eventIds.length > 0 ? [eventIds] : [];
  const res = await pgPool.query(query, params);
  const rows = res.rows;

  if (rows.length === 0) {
    return { success: true, total: 0, already_applied_by_cloud: 0, requeued_for_retry: 0 };
  }

  const cfg = getSyncConfig();
  if (cfg.cloudConfigured) {
    let statuses: Array<{ idempotency_key: string; status: string }> = [];
    try {
      const identity = await getShopIdentity();
      const keys = rows.map((r: any) => r.idempotency_key);
      statuses = await callCloud<Array<{ idempotency_key: string; status: string }>>('gc_check_event_statuses', {
        p_shop_id: identity.shop_id,
        p_token: cfg.shopToken,
        p_keys: keys,
      });
    } catch (err: any) {
      if (options?.allowUnverifiedFallback) {
        console.warn(`[SyncRetry] Cloud precheck failed; proceeding with explicit manual fallback: ${err?.message || err}`);
      } else {
        const error = new HttpError(502, `SAFE_RETRY_PRECHECK_FAILED: Cloud event status verification failed (${sanitizeText(err?.message || err)})`);
        (error as any).code = 'SAFE_RETRY_PRECHECK_FAILED';
        throw error;
      }
    }

    if (statuses && Array.isArray(statuses)) {
      const statusMap = new Map((statuses || []).map((s) => [s.idempotency_key, s.status]));
      const toMarkSynced: string[] = [];
      const toRequeue: string[] = [];

      for (const row of rows) {
        const cloudStatus = statusMap.get(row.idempotency_key);
        if (cloudStatus === 'PROCESSED') {
          toMarkSynced.push(row.id);
        } else {
          // NOT_FOUND or REJECTED: requeue original event to be safely processed
          toRequeue.push(row.id);
        }
      }

      if (toMarkSynced.length > 0) {
        await pgPool.query(
          `UPDATE sync_events SET status = 'SYNCED', synced_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
          [toMarkSynced]
        );
      }
      if (toRequeue.length > 0) {
        await pgPool.query(
          `UPDATE sync_events SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
          [toRequeue]
        );
        syncWorker.wake(false);
      }

      return {
        success: true,
        total: rows.length,
        already_applied_by_cloud: toMarkSynced.length,
        requeued_for_retry: toRequeue.length,
      };
    }
  } else if (!options?.allowUnverifiedFallback) {
    const error = new HttpError(502, 'SAFE_RETRY_PRECHECK_FAILED: Cloud is not configured to verify event statuses before retry.');
    (error as any).code = 'SAFE_RETRY_PRECHECK_FAILED';
    throw error;
  }

  // Explicit emergency/manual fallback only
  const ids = rows.map((r: any) => r.id);
  await pgPool.query(
    `UPDATE sync_events SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  syncWorker.wake(false);
  return {
    success: true,
    total: rows.length,
    already_applied_by_cloud: 0,
    requeued_for_retry: rows.length,
  };
}
