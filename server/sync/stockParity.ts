import { pgPool, withTransaction, isValidUuid, HttpError } from '../db/client';
import { getShopIdentity } from './identity';
import { getSyncConfig } from './config';
import { callCloud, CloudError } from './cloudClient';
import { enqueueSyncEvent, medicineJson, type SyncActor } from './outbox';
import { notifySyncWake } from './wake';
import { recordAuditLog } from '../db/audit';
import { reconcileMedicineBaseline } from './consistency';

export interface StockParityItem {
  medicine_id: string;
  name: string;
  local_stock: number;
  cloud_stock: number | null;
  difference: number;
  local_stock_version: number;
  cloud_stock_version: number | null;
  local_fingerprint: string | null;
  cloud_fingerprint: string | null;
  status: 'MATCH' | 'TEMPORARILY_BEHIND' | 'PERSISTENT_MISMATCH' | 'RECONCILED';
  pending_sync_count: number;
  mismatch_age_seconds?: number;
  reason?: string;
}

export interface StockParityReport {
  timestamp: string;
  shop_id: string;
  healthy: boolean;
  cloud_accessible: boolean;
  cloud_error?: string | null;
  summary: {
    total_medicines: number;
    matched: number;
    syncing: number;
    mismatch: number;
    reconciled: number;
  };
  items: StockParityItem[];
}

/**
 * Runs continuous stock parity verification against the cloud mirror.
 * Live local PostgreSQL is ALWAYS the authoritative stock authority for Shop 1.
 * Persistent mismatches are either flagged or auto-reconciled atomically.
 */
export async function runStockParityAudit(options?: {
  autoReconcile?: boolean;
  gracePeriodMs?: number;
  targetMedicineId?: string;
  actor?: SyncActor;
}): Promise<StockParityReport> {
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();
  const autoReconcile = Boolean(options?.autoReconcile);
  const gracePeriodMs = options?.gracePeriodMs ?? 30000;
  const now = new Date();

  // 1. Fetch authoritative local medicines and their active batches
  const localQuery = options?.targetMedicineId
    ? `SELECT id, name, current_stock, stock_version, stock_fingerprint
         FROM medicines
        WHERE id = $1 AND status <> 'archived'`
    : `SELECT id, name, current_stock, stock_version, stock_fingerprint
         FROM medicines
        WHERE status <> 'archived'
        ORDER BY name, id`;

  const localParams = options?.targetMedicineId ? [options.targetMedicineId] : [];
  const localMedsRes = await pgPool.query(localQuery, localParams);

  // Check recent outbox events for all relevant medicines
  const outboxRes = await pgPool.query(
    `SELECT entity_id, count(*)::int AS pending_count, MAX(created_at) AS last_created
       FROM sync_events
      WHERE entity_type = 'medicine' AND status <> 'SYNCED'
      GROUP BY entity_id`
  );
  const outboxMap = new Map<string, { pending_count: number; last_created: Date }>();
  for (const r of outboxRes.rows) {
    outboxMap.set(r.entity_id, {
      pending_count: Number(r.pending_count) || 0,
      last_created: new Date(r.last_created),
    });
  }

  // 2. Query cloud mirror via gc_inspect_shop_data
  let cloudAccessible = false;
  let cloudError: string | null = null;
  let cloudMedicinesMap = new Map<string, any>();
  let cloudStockLevelsMap = new Map<string, any[]>();

  if (cfg.cloudConfigured && cfg.shopToken) {
    try {
      const inspectRes = await callCloud<{
        medicines: any[];
        stock_levels: any[];
        tombstones: any[];
      }>('gc_inspect_shop_data', { p_shop_id: identity.shop_id });

      cloudAccessible = true;
      if (Array.isArray(inspectRes.medicines)) {
        for (const m of inspectRes.medicines) {
          cloudMedicinesMap.set(m.medicine_id || m.id, m);
        }
      }
      if (Array.isArray(inspectRes.stock_levels)) {
        for (const sl of inspectRes.stock_levels) {
          const medId = sl.medicine_id;
          if (!cloudStockLevelsMap.has(medId)) {
            cloudStockLevelsMap.set(medId, []);
          }
          cloudStockLevelsMap.get(medId)!.push(sl);
        }
      }
    } catch (err: any) {
      cloudAccessible = false;
      cloudError = err?.message || String(err);
    }
  } else {
    cloudError = 'Sync disabled or cloud credentials not configured.';
  }

  const items: StockParityItem[] = [];
  let matchedCount = 0;
  let syncingCount = 0;
  let mismatchCount = 0;
  let reconciledCount = 0;

  for (const local of localMedsRes.rows) {
    const medId = local.id;
    const localStock = Number(local.current_stock) || 0;
    const localVersion = Number(local.stock_version) || 1;
    const localFp = local.stock_fingerprint || null;

    if (!cloudAccessible) {
      // Cloud is offline or unreachable: offline-safe behavior
      items.push({
        medicine_id: medId,
        name: local.name,
        local_stock: localStock,
        cloud_stock: null,
        difference: 0,
        local_stock_version: localVersion,
        cloud_stock_version: null,
        local_fingerprint: localFp,
        cloud_fingerprint: null,
        status: 'TEMPORARILY_BEHIND',
        pending_sync_count: outboxMap.get(medId)?.pending_count || 0,
        reason: 'WAITING FOR SYNC: cloud mirror currently unreachable.',
      });
      syncingCount++;
      continue;
    }

    const cloudMed = cloudMedicinesMap.get(medId);
    const cloudBatches = cloudStockLevelsMap.get(medId) || [];

    // Derive cloud stock from stock_levels
    let cloudStock = 0;
    let cloudVersion = cloudMed ? Number(cloudMed.stock_version) || 1 : null;
    let cloudFp = cloudMed?.stock_fingerprint || null;

    if (cloudBatches.length > 0) {
      cloudStock = cloudBatches.reduce((acc, b) => acc + (Number(b.quantity) || 0), 0);
      const maxBatchVersion = Math.max(...cloudBatches.map((b) => Number(b.stock_version) || 1));
      if (cloudVersion === null || maxBatchVersion > cloudVersion) {
        cloudVersion = maxBatchVersion;
      }
    } else if (cloudMed && cloudMed.current_stock !== undefined) {
      cloudStock = Number(cloudMed.current_stock) || 0;
    }

    const difference = localStock - cloudStock;
    const outboxInfo = outboxMap.get(medId);
    const pendingCount = outboxInfo?.pending_count || 0;
    const isRecentlyActive = outboxInfo && (now.getTime() - outboxInfo.last_created.getTime() < gracePeriodMs);

    // Parity evaluation
    const stockMatches = difference === 0;
    const fpMatches = !localFp || !cloudFp || localFp === cloudFp;

    if (stockMatches && fpMatches) {
      matchedCount++;
      items.push({
        medicine_id: medId,
        name: local.name,
        local_stock: localStock,
        cloud_stock: cloudStock,
        difference: 0,
        local_stock_version: localVersion,
        cloud_stock_version: cloudVersion,
        local_fingerprint: localFp,
        cloud_fingerprint: cloudFp,
        status: 'MATCH',
        pending_sync_count: pendingCount,
      });
    } else if (isRecentlyActive || pendingCount > 0) {
      // Pending local movement events within grace period
      syncingCount++;
      items.push({
        medicine_id: medId,
        name: local.name,
        local_stock: localStock,
        cloud_stock: cloudStock,
        difference,
        local_stock_version: localVersion,
        cloud_stock_version: cloudVersion,
        local_fingerprint: localFp,
        cloud_fingerprint: cloudFp,
        status: 'TEMPORARILY_BEHIND',
        pending_sync_count: pendingCount,
        reason: 'Pending sync events in transit within grace window.',
      });
    } else {
      // Persistent mismatch detected!
      mismatchCount++;
      const mismatchItem: StockParityItem = {
        medicine_id: medId,
        name: local.name,
        local_stock: localStock,
        cloud_stock: cloudStock,
        difference,
        local_stock_version: localVersion,
        cloud_stock_version: cloudVersion,
        local_fingerprint: localFp,
        cloud_fingerprint: cloudFp,
        status: 'PERSISTENT_MISMATCH',
        pending_sync_count: pendingCount,
        reason: `Stock drift detected: Local ${localStock} vs Cloud ${cloudStock} (version ${localVersion} vs ${cloudVersion}).`,
      };

      // Record audit of mismatch detection
      await recordAuditLog({
        user_id: options?.actor?.user_id || undefined,
        action: 'STOCK_PARITY_MISMATCH_DETECTED',
        entity: 'medicine',
        entity_id: medId,
        user_name: options?.actor?.user_name || 'System Auto-Parity',
        role: (options?.actor?.role as any) || 'ADMIN',
        new_value: {
          medicine_name: local.name,
          local_stock: localStock,
          cloud_stock: cloudStock,
          local_version: localVersion,
          cloud_version: cloudVersion,
          local_fingerprint: localFp,
          cloud_fingerprint: cloudFp,
          difference,
        },
      });

      // Insert into local stock_parity_log
      await pgPool.query(
        `INSERT INTO stock_parity_log (
           medicine_id, local_stock, cloud_stock, local_version, cloud_version,
           local_fingerprint, cloud_fingerprint, status, reconciled, reason, checked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
        [
          medId, localStock, cloudStock, localVersion, cloudVersion,
          localFp, cloudFp, 'PERSISTENT_MISMATCH', false, mismatchItem.reason,
        ]
      );

      if (autoReconcile) {
        // Trigger safe targeted atomic baseline repair
        try {
          await reconcileMedicineBaseline(medId, options?.actor || {
            user_id: '',
            user_name: 'System Auto-Parity',
            role: 'ADMIN',
          });

          await pgPool.query(
            `UPDATE stock_parity_log
                SET reconciled = TRUE, status = 'RECONCILED', updated_at = CURRENT_TIMESTAMP
              WHERE medicine_id = $1 AND reconciled = FALSE`,
            [medId]
          );

          mismatchItem.status = 'RECONCILED';
          mismatchItem.reason = 'Atomically auto-reconciled via STOCK_RECONCILIATION_BASELINE.';
          reconciledCount++;
          mismatchCount--;
        } catch (recErr: any) {
          mismatchItem.reason = `Auto-reconciliation failed: ${recErr?.message || recErr}`;
        }
      }

      items.push(mismatchItem);
    }
  }

  const report: StockParityReport = {
    timestamp: now.toISOString(),
    shop_id: identity.shop_id,
    healthy: cloudAccessible && mismatchCount === 0,
    cloud_accessible: cloudAccessible,
    cloud_error: cloudError,
    summary: {
      total_medicines: localMedsRes.rows.length,
      matched: matchedCount,
      syncing: syncingCount,
      mismatch: mismatchCount,
      reconciled: reconciledCount,
    },
    items,
  };

  return report;
}

/**
 * Reconciles selected medicines by dispatching authoritative baselines to cloud.
 */
export async function reconcileSelectedStockParity(
  medicineIds: string[],
  actor: SyncActor
): Promise<{ reconciledCount: number; medicineIds: string[] }> {
  if (!Array.isArray(medicineIds) || medicineIds.length === 0) {
    throw new HttpError(400, 'medicineIds array is required.');
  }

  let count = 0;
  for (const id of medicineIds) {
    if (!isValidUuid(id)) continue;
    await reconcileMedicineBaseline(id, actor);
    await pgPool.query(
      `UPDATE stock_parity_log
          SET reconciled = TRUE, status = 'RECONCILED', updated_at = CURRENT_TIMESTAMP
        WHERE medicine_id = $1 AND reconciled = FALSE`,
      [id]
    );
    count++;
  }

  notifySyncWake();
  return { reconciledCount: count, medicineIds };
}
