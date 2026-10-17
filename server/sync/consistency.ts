import { pgPool, withTransaction, isValidUuid, HttpError } from '../db/client';
import { getShopIdentity } from './identity';
import { getSyncConfig } from './config';
import { callCloud, CloudError } from './cloudClient';
import { enqueueSyncEvent, medicineJson, userJson, type SyncActor } from './outbox';
import { pushUserCredentials } from './credentials';
import { notifySyncWake } from './wake';
import { recordAuditLog } from '../db/audit';

export interface ConsistencyStockIssue {
  medicine_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  local_stock: number;
  cloud_stock: number | null;
  difference: number;
  negative_cloud: boolean;
  requires_baseline: boolean;
}

export interface ConsistencyCatalogueIssue {
  medicine_id: string;
  name: string;
  type: 'MISSING_IN_CLOUD' | 'MISSING_IN_LOCAL' | 'FIELD_MISMATCH';
  details: Record<string, { local: any; cloud: any }> | string;
}

export interface ConsistencyUserIssue {
  user_id: string;
  name: string;
  email: string;
  type: 'MISSING_ONLINE_USER' | 'MISSING_LOCAL_USER' | 'CREDENTIAL_SYNC_PENDING';
  details: string;
}

export interface ConsistencyReport {
  timestamp: string;
  shop_id: string;
  healthy: boolean;
  cloud_accessible: boolean;
  cloud_error?: string | null;
  summary: {
    negative_local_stock: number;
    negative_cloud_stock: number;
    stock_mismatches: number;
    catalogue_missing_cloud: number;
    catalogue_missing_local: number;
    catalogue_field_mismatches: number;
    users_missing_online_login: number;
    pending_sync_events: number;
    failed_sync_events: number;
    sequence_gaps: number;
  };
  stock_issues: ConsistencyStockIssue[];
  catalogue_issues: ConsistencyCatalogueIssue[];
  user_issues: ConsistencyUserIssue[];
  sync_sequence: {
    last_local_seq: number | null;
    last_synced_seq: number | null;
    gap_count: number;
  };
}

/**
 * READ-ONLY consistency audit between authoritative local PostgreSQL and cloud.
 * Never modifies or repairs anything automatically.
 */
export async function runShopConsistencyCheck(): Promise<ConsistencyReport> {
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();

  // 1. Gather local data
  const [localMeds, localBatches, localUsers, syncSeqs, outboxStatus] = await Promise.all([
    pgPool.query(`
      SELECT id, name, sku, barcode, purchase_price, selling_price, wholesale_price,
             min_selling_price, current_stock, reorder_level, status
        FROM medicines ORDER BY name, id
    `),
    pgPool.query(`
      SELECT id, medicine_id, batch_number, quantity_available, expiry_date, status
        FROM medicine_batches ORDER BY medicine_id, id
    `),
    pgPool.query(`
      SELECT id, name, email, username, role, active, auth_sync_seq, auth_synced_seq
        FROM users ORDER BY name, id
    `),
    pgPool.query(`
      SELECT MAX(seq)::bigint AS last_seq,
             MAX(seq) FILTER (WHERE status = 'SYNCED')::bigint AS last_synced_seq,
             COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count
        FROM sync_events
    `),
    pgPool.query(`
      SELECT seq FROM sync_events ORDER BY seq ASC
    `),
  ]);

  // Check sequence continuity
  const seqRows = outboxStatus.rows.map((r) => Number(r.seq));
  let sequenceGaps = 0;
  for (let i = 1; i < seqRows.length; i++) {
    if (seqRows[i] !== seqRows[i - 1] + 1) {
      sequenceGaps++;
    }
  }

  const report: ConsistencyReport = {
    timestamp: new Date().toISOString(),
    shop_id: identity.shop_id,
    healthy: true,
    cloud_accessible: false,
    cloud_error: null,
    summary: {
      negative_local_stock: 0,
      negative_cloud_stock: 0,
      stock_mismatches: 0,
      catalogue_missing_cloud: 0,
      catalogue_missing_local: 0,
      catalogue_field_mismatches: 0,
      users_missing_online_login: 0,
      pending_sync_events: syncSeqs.rows[0]?.pending_count || 0,
      failed_sync_events: syncSeqs.rows[0]?.failed_count || 0,
      sequence_gaps: sequenceGaps,
    },
    stock_issues: [],
    catalogue_issues: [],
    user_issues: [],
    sync_sequence: {
      last_local_seq: syncSeqs.rows[0]?.last_seq ? Number(syncSeqs.rows[0].last_seq) : null,
      last_synced_seq: syncSeqs.rows[0]?.last_synced_seq ? Number(syncSeqs.rows[0].last_synced_seq) : null,
      gap_count: sequenceGaps,
    },
  };

  // Local negative stock check
  for (const m of localMeds.rows) {
    if (Number(m.current_stock) < 0) {
      report.summary.negative_local_stock++;
      report.stock_issues.push({
        medicine_id: m.id,
        name: m.name,
        sku: m.sku,
        barcode: m.barcode,
        local_stock: Number(m.current_stock),
        cloud_stock: null,
        difference: 0,
        negative_cloud: false,
        requires_baseline: true,
      });
    }
  }

  // 2. Query cloud if configured
  if (!cfg.cloudConfigured) {
    report.cloud_error = cfg.configError || 'Cloud not configured.';
    report.healthy = report.summary.negative_local_stock === 0 && report.summary.failed_sync_events === 0;
    return report;
  }

  try {
    const cloudData: any = await callCloud('gc_inspect_shop_data', {
      p_shop_id: identity.shop_id,
      p_token: cfg.shopToken,
    });
    report.cloud_accessible = true;

    const cloudMeds = new Map<string, any>(
      (cloudData?.medicines || []).map((m: any) => [m.id || m.medicine_id, m])
    );
    const cloudStocks = new Map<string, number>(
      (cloudData?.stock_levels || []).map((s: any) => [s.medicine_id, Number(s.quantity ?? s.current_stock ?? 0)])
    );
    const cloudUsers = new Map<string, any>(
      (cloudData?.users || []).map((u: any) => [u.user_id || u.id, u])
    );
    const cloudOnlineUsers = new Map<string, any>(
      (cloudData?.online_users || []).map((ou: any) => [ou.local_user_id, ou])
    );

    // Compare stock
    for (const m of localMeds.rows) {
      const cStock = cloudStocks.get(m.id);
      const lStock = Number(m.current_stock);
      if (cStock !== undefined) {
        if (cStock < 0) {
          report.summary.negative_cloud_stock++;
        }
        if (cStock !== lStock) {
          report.summary.stock_mismatches++;
          report.stock_issues.push({
            medicine_id: m.id,
            name: m.name,
            sku: m.sku,
            barcode: m.barcode,
            local_stock: lStock,
            cloud_stock: cStock,
            difference: lStock - cStock,
            negative_cloud: cStock < 0,
            requires_baseline: true,
          });
        }
      } else {
        // Missing in cloud stock
        report.summary.stock_mismatches++;
        report.stock_issues.push({
          medicine_id: m.id,
          name: m.name,
          sku: m.sku,
          barcode: m.barcode,
          local_stock: lStock,
          cloud_stock: null,
          difference: lStock,
          negative_cloud: false,
          requires_baseline: true,
        });
      }

      // Catalogue presence & field parity
      const cm = cloudMeds.get(m.id);
      if (!cm) {
        report.summary.catalogue_missing_cloud++;
        report.catalogue_issues.push({
          medicine_id: m.id,
          name: m.name,
          type: 'MISSING_IN_CLOUD',
          details: 'Medicine exists in local database but was never published to cloud.',
        });
      } else {
        const mismatches: Record<string, { local: any; cloud: any }> = {};
        if (cm.name && cm.name.trim() !== m.name.trim()) mismatches.name = { local: m.name, cloud: cm.name };
        if (cm.barcode && cm.barcode !== m.barcode) mismatches.barcode = { local: m.barcode, cloud: cm.barcode };
        if (cm.sku && cm.sku !== m.sku) mismatches.sku = { local: m.sku, cloud: cm.sku };
        if (Object.keys(mismatches).length > 0) {
          report.summary.catalogue_field_mismatches++;
          report.catalogue_issues.push({
            medicine_id: m.id,
            name: m.name,
            type: 'FIELD_MISMATCH',
            details: mismatches,
          });
        }
      }
    }

    // User parity
    for (const u of localUsers.rows) {
      if (u.active) {
        const onlineIdentity = cloudOnlineUsers.get(u.id);
        const cloudUser = cloudUsers.get(u.id);
        if (!onlineIdentity && !cloudUser) {
          report.summary.users_missing_online_login++;
          report.user_issues.push({
            user_id: u.id,
            name: u.name,
            email: u.email,
            type: 'MISSING_ONLINE_USER',
            details: 'Active local account has no cloud user record.',
          });
        } else if (!onlineIdentity) {
          report.summary.users_missing_online_login++;
          report.user_issues.push({
            user_id: u.id,
            name: u.name,
            email: u.email,
            type: 'MISSING_ONLINE_USER',
            details: 'Account profile exists in cloud but credentials have not been published (NO ONLINE LOGIN).',
          });
        } else if (Number(u.auth_sync_seq) > Number(u.auth_synced_seq)) {
          report.user_issues.push({
            user_id: u.id,
            name: u.name,
            email: u.email,
            type: 'CREDENTIAL_SYNC_PENDING',
            details: 'Local password/role change is waiting to be pushed to cloud.',
          });
        }
      }
    }
  } catch (err: any) {
    report.cloud_accessible = false;
    report.cloud_error = err?.message || String(err);
  }

  report.healthy =
    report.summary.negative_local_stock === 0 &&
    report.summary.negative_cloud_stock === 0 &&
    report.summary.stock_mismatches === 0 &&
    report.summary.catalogue_missing_cloud === 0 &&
    report.summary.catalogue_missing_local === 0 &&
    report.summary.catalogue_field_mismatches === 0 &&
    report.summary.users_missing_online_login === 0 &&
    report.summary.failed_sync_events === 0 &&
    report.summary.sequence_gaps === 0;

  return report;
}

/**
 * Controlled Repair Action 1: Re-publish medicine baseline.
 * Authoritatively locks local medicine, snapshots local stock & batches, enqueues MEDICINE_BASELINE.
 * Cloud atomically replaces broken baseline and resets delta_since_baseline = 0.
 */
export async function reconcileMedicineBaseline(
  medicineId: string,
  actor: SyncActor
): Promise<{ success: boolean; medicineId: string; baseline_quantity: number; batches_count: number }> {
  if (!isValidUuid(medicineId)) throw new HttpError(400, 'Invalid medicine UUID.');

  return withTransaction(async (client) => {
    const locked = await client.query('SELECT id, current_stock, name FROM medicines WHERE id = $1 FOR UPDATE', [medicineId]);
    if (!locked.rows[0]) throw new HttpError(404, 'Medicine not found.');

    const batches = (await client.query(
      `SELECT id, medicine_id, batch_number, quantity_available, expiry_date, expiry_status, status, supplier_id,
              purchase_price, selling_price_override, received_date, manufacturing_date, purchase_invoice, notes, created_by
         FROM medicine_batches WHERE medicine_id = $1 ORDER BY id`,
      [medicineId]
    )).rows;

    const totalStock = batches.reduce((sum, b) => sum + Number(b.quantity_available || 0), 0);

    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_BASELINE',
      entity_type: 'medicine',
      entity_id: medicineId,
      operation: 'RECONCILIATION',
      data: async () => ({
        medicine: await medicineJson(client, medicineId),
        batches,
      }),
      actor,
      business_ref: 'CLOUD_STOCK_RECONCILIATION',
    });

    await recordAuditLog({
      action: 'CLOUD_STOCK_RECONCILIATION',
      entity: 'medicine',
      entity_id: medicineId,
      user_id: actor.user_id || undefined,
      user_name: actor.user_name || 'Admin',
      role: actor.role as any || 'ADMIN',
      new_value: {
        medicine_name: locked.rows[0].name,
        baseline_quantity: totalStock,
        batches_count: batches.length,
      },
    });

    // Post-commit wake will trigger automatically via registerAfterCommit!
    return {
      success: true,
      medicineId,
      baseline_quantity: totalStock,
      batches_count: batches.length,
    };
  });
}

/**
 * Controlled Repair Action 2: Re-publish catalogue metadata for a medicine.
 */
export async function reconcileCatalogueMetadata(
  medicineId: string,
  actor: SyncActor
): Promise<{ success: boolean; medicineId: string }> {
  if (!isValidUuid(medicineId)) throw new HttpError(400, 'Invalid medicine UUID.');

  return withTransaction(async (client) => {
    const locked = await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [medicineId]);
    if (!locked.rows[0]) throw new HttpError(404, 'Medicine not found.');

    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_UPDATED',
      entity_type: 'medicine',
      entity_id: medicineId,
      operation: 'CATALOGUE_RECONCILIATION',
      data: async () => ({ medicine: await medicineJson(client, medicineId) }),
      actor,
      business_ref: 'CATALOGUE_RECONCILIATION',
    });

    return { success: true, medicineId };
  });
}

/**
 * Controlled Repair Action 3: Re-publish user profile.
 */
export async function reconcileUserProfile(
  userId: string,
  actor: SyncActor
): Promise<{ success: boolean; userId: string }> {
  if (!isValidUuid(userId)) throw new HttpError(400, 'Invalid user UUID.');

  return withTransaction(async (client) => {
    const locked = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!locked.rows[0]) throw new HttpError(404, 'User not found.');

    await enqueueSyncEvent(client, {
      event_type: 'USER_UPSERTED',
      entity_type: 'user',
      entity_id: userId,
      operation: 'PROFILE_RECONCILIATION',
      data: async () => ({ user: await userJson(client, userId) }),
      actor,
      business_ref: 'USER_PROFILE_RECONCILIATION',
    });

    return { success: true, userId };
  });
}

/**
 * Controlled Repair Action 4: Push user credentials to cloud login mirror.
 */
export async function reconcileUserCredentials(): Promise<{ outcome: string }> {
  const outcome = await pushUserCredentials();
  notifySyncWake();
  return { outcome };
}
