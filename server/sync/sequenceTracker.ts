import type pg from 'pg';
import { pgPool, HttpError, withTransaction } from '../db/client';
import { getShopIdentity } from './identity';
import { getSyncConfig } from './config';
import { callCloud } from './cloudClient';
import { syncWorker } from './worker';
import { recordAuditLog } from '../db/audit';

export interface SequenceDiagnostics {
  last_local_seq: number;
  last_cloud_confirmed_seq: number;
  oldest_pending_seq: number | null;
  failed_seq_count: number;
  sequence_gap_count: number;
  gaps: Array<{ from: number; to: number; missing_count: number }>;
}

export interface SalesSyncWatermark {
  latest_local_sale_id: string | null;
  latest_local_sale_seq: number | null;
  latest_cloud_confirmed_seq: number | null;
  latest_local_sale_time: string | null;
  latest_cloud_sale_time: string | null;
}

export interface SaleSyncAuditItem {
  sale_id: string;
  receipt_number: string;
  created_at: string;
  total: number;
  status: 'MATCHED' | 'PENDING' | 'FAILED' | 'MISSING_IN_CLOUD';
  outbox_event_id: string | null;
  outbox_seq: number | null;
  outbox_status: string | null;
}

export interface SalesSyncAuditReport {
  timestamp: string;
  total_checked: number;
  matched: number;
  pending: number;
  failed: number;
  missing_in_cloud: number;
  orphaned_sales: SaleSyncAuditItem[];
  watermark: SalesSyncWatermark;
}

/**
 * Detects unexplained sequence gaps in local outbox sync_events table.
 */
export async function detectSequenceGaps(
  client?: pg.PoolClient
): Promise<SequenceDiagnostics> {
  const q = client || pgPool;

  const seqStats = await q.query(`
    SELECT
      COALESCE(MAX(seq), 0)::bigint AS max_seq,
      COALESCE(MIN(seq) FILTER (WHERE status = 'PENDING'), NULL)::bigint AS oldest_pending_seq,
      COALESCE(MAX(seq) FILTER (WHERE status = 'SYNCED'), 0)::bigint AS last_synced_seq,
      COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
      COUNT(*)::bigint AS total_events
    FROM sync_events
  `);

  const maxSeq = Number(seqStats.rows[0].max_seq || 0);
  const oldestPending = seqStats.rows[0].oldest_pending_seq ? Number(seqStats.rows[0].oldest_pending_seq) : null;
  const lastSynced = Number(seqStats.rows[0].last_synced_seq || 0);
  const failedCount = Number(seqStats.rows[0].failed_count || 0);

  // Detect gaps using window functions
  const gapRows = await q.query(`
    WITH ordered AS (
      SELECT seq, LAG(seq) OVER (ORDER BY seq ASC) AS prev_seq
      FROM sync_events
    )
    SELECT prev_seq + 1 AS gap_start, seq - 1 AS gap_end, (seq - prev_seq - 1)::int AS missing_count
    FROM ordered
    WHERE prev_seq IS NOT NULL AND seq > prev_seq + 1
    ORDER BY gap_start ASC
    LIMIT 20
  `);

  const gaps: Array<{ from: number; to: number; missing_count: number }> = gapRows.rows.map((r: any) => ({
    from: Number(r.gap_start),
    to: Number(r.gap_end),
    missing_count: Number(r.missing_count),
  }));

  const totalGapCount = gaps.reduce((sum, g) => sum + g.missing_count, 0);

  return {
    last_local_seq: maxSeq,
    last_cloud_confirmed_seq: lastSynced,
    oldest_pending_seq: oldestPending,
    failed_seq_count: failedCount,
    sequence_gap_count: totalGapCount,
    gaps,
  };
}

/**
 * Sales Synchronization Watermark:
 * Immutable sale UUID + monotonically increasing local sequence.
 */
export async function getSalesSyncWatermark(
  client?: pg.PoolClient
): Promise<SalesSyncWatermark> {
  const q = client || pgPool;

  // Latest local completed sale
  const saleRes = await q.query(`
    SELECT s.id, s.created_at, e.seq, e.status AS outbox_status
    FROM sales s
    LEFT JOIN sync_events e ON e.entity_type = 'sale' AND e.entity_id = s.id::text AND e.event_type = 'SALE_COMPLETED'
    ORDER BY s.created_at DESC
    LIMIT 1
  `);

  const latestSale = saleRes.rows[0];

  // Latest cloud confirmed sale sequence
  const syncedSaleRes = await q.query(`
    SELECT e.seq, s.created_at
    FROM sync_events e
    JOIN sales s ON s.id::text = e.entity_id
    WHERE e.event_type = 'SALE_COMPLETED' AND e.status = 'SYNCED'
    ORDER BY e.seq DESC
    LIMIT 1
  `);

  const latestSyncedSale = syncedSaleRes.rows[0];

  return {
    latest_local_sale_id: latestSale?.id || null,
    latest_local_sale_seq: latestSale?.seq ? Number(latestSale.seq) : null,
    latest_cloud_confirmed_seq: latestSyncedSale?.seq ? Number(latestSyncedSale.seq) : null,
    latest_local_sale_time: latestSale?.created_at ? new Date(latestSale.created_at).toISOString() : null,
    latest_cloud_sale_time: latestSyncedSale?.created_at ? new Date(latestSyncedSale.created_at).toISOString() : null,
  };
}

/**
 * Verifies that every local completed sale has a matching synchronization record.
 * A sale that committed locally but has no outbox event is classified as ORPHANED_LOCAL_SALE.
 */
export async function verifySalesSync(
  limit = 100,
  client?: pg.PoolClient
): Promise<SalesSyncAuditReport> {
  const q = client || pgPool;

  const salesRes = await q.query(`
    SELECT
      s.id, s.receipt_number, s.created_at, s.total,
      e.id AS outbox_id, e.seq AS outbox_seq, e.status AS outbox_status, e.idempotency_key
    FROM sales s
    LEFT JOIN sync_events e ON e.entity_type = 'sale' AND e.entity_id = s.id::text AND e.event_type = 'SALE_COMPLETED'
    ORDER BY s.created_at DESC
    LIMIT $1
  `, [limit]);

  const items: SaleSyncAuditItem[] = [];
  let matched = 0;
  let pending = 0;
  let failed = 0;
  let missing = 0;
  const orphaned: SaleSyncAuditItem[] = [];

  for (const r of salesRes.rows) {
    let status: 'MATCHED' | 'PENDING' | 'FAILED' | 'MISSING_IN_CLOUD';

    if (!r.outbox_id) {
      status = 'MISSING_IN_CLOUD';
      missing++;
    } else if (r.outbox_status === 'SYNCED') {
      status = 'MATCHED';
      matched++;
    } else if (r.outbox_status === 'PENDING' || r.outbox_status === 'PROCESSING') {
      status = 'PENDING';
      pending++;
    } else if (r.outbox_status === 'FAILED') {
      status = 'FAILED';
      failed++;
    } else {
      status = 'MATCHED';
      matched++;
    }

    const item: SaleSyncAuditItem = {
      sale_id: r.id,
      receipt_number: r.receipt_number,
      created_at: new Date(r.created_at).toISOString(),
      total: Number(r.total || 0),
      status,
      outbox_event_id: r.outbox_id || null,
      outbox_seq: r.outbox_seq ? Number(r.outbox_seq) : null,
      outbox_status: r.outbox_status || null,
    };

    items.push(item);
    if (status === 'MISSING_IN_CLOUD') {
      orphaned.push(item);
    }
  }

  const watermark = await getSalesSyncWatermark(q as any);

  return {
    timestamp: new Date().toISOString(),
    total_checked: salesRes.rows.length,
    matched,
    pending,
    failed,
    missing_in_cloud: missing,
    orphaned_sales: orphaned,
    watermark,
  };
}

/**
 * Reconstructs a canonical SALE_COMPLETED outbox event for an orphaned local sale.
 * Zero duplicate stock guarantee: movements are left empty because the local
 * inventory movements already happened at the time of the original sale.
 */
export async function reconstructOrphanSaleEvent(
  saleId: string,
  actor?: { user_id?: string; user_name?: string }
): Promise<{ event_id: string; idempotency_key: string; seq: number }> {
  return withTransaction(async (client) => {
    // 1. Verify sale exists
    const saleRes = await client.query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    const sale = saleRes.rows[0];
    if (!sale) throw new HttpError(404, `Sale ${saleId} not found.`);

    // 2. Verify no SALE_COMPLETED outbox event exists
    const existingEv = await client.query(
      `SELECT id, idempotency_key, seq::bigint AS seq FROM sync_events WHERE entity_type = 'sale' AND entity_id = $1 AND event_type = 'SALE_COMPLETED'`,
      [saleId]
    );
    if (existingEv.rows[0]) {
      return {
        event_id: existingEv.rows[0].id,
        idempotency_key: existingEv.rows[0].idempotency_key,
        seq: Number(existingEv.rows[0].seq),
      };
    }

    // 3. Assemble components
    const identity = await getShopIdentity(client);
    const eventId = crypto.randomUUID();
    const idempotencyKey = `gc:${identity.shop_id}:orphan-sale:${saleId}`;

    const itemsRes = await client.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [saleId]);
    const paymentsRes = await client.query(`SELECT * FROM payments WHERE sale_id = $1`, [saleId]);
    const customerRes = sale.customer_id
      ? await client.query(`SELECT * FROM customers WHERE id = $1`, [sale.customer_id])
      : { rows: [] };

    // Payload: data contains sale, items, payments, customer.
    // Empty movements array guarantees zero double stock deduction!
    const payload = {
      data: {
        sale,
        items: itemsRes.rows,
        payments: paymentsRes.rows,
        customer: customerRes.rows[0] || null,
        cashier_name: actor?.user_name || 'System (orphan recovery)',
        is_reconstructed_orphan: true,
      },
      movements: [], // Zero duplicate stock effect!
      batches: [],
      audit: [],
      actor: {
        user_id: actor?.user_id || null,
        user_name: actor?.user_name || 'System (orphan recovery)',
        role: 'ADMIN',
      },
    };

    const actorUserId =
      actor?.user_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.user_id)
        ? actor.user_id
        : null;

    const insertRes = await client.query(`
      INSERT INTO sync_events (
        id, idempotency_key, shop_id, device_id, event_type, operation, entity_type, entity_id,
        payload, actor_user_id, actor_name, business_ref, status, next_attempt_at
      ) VALUES ($1, $2, $3, $4, 'SALE_COMPLETED', 'CREATE', 'sale', $5, $6, $7, $8, $9, 'PENDING', CURRENT_TIMESTAMP)
      RETURNING id, idempotency_key, seq::bigint AS seq
    `, [
      eventId,
      idempotencyKey,
      identity.shop_id,
      sale.device_id || null,
      saleId,
      JSON.stringify(payload),
      actorUserId,
      actor?.user_name || 'System (orphan recovery)',
      sale.receipt_number || null,
    ]);

    await recordAuditLog({
      action: 'ORPHAN_EVENT_RECONSTRUCTED',
      entity: 'sale',
      entity_id: saleId,
      user_name: actor?.user_name || 'System (orphan recovery)',
      new_value: {
        event_id: eventId,
        idempotency_key: idempotencyKey,
        receipt_number: sale.receipt_number,
        total: sale.total,
      },
    } as any, client);

    syncWorker.wake(false);

    return {
      event_id: insertRes.rows[0].id,
      idempotency_key: insertRes.rows[0].idempotency_key,
      seq: Number(insertRes.rows[0].seq),
    };
  });
}
