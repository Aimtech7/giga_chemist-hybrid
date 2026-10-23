import crypto from 'crypto';
import pg from 'pg';
import { pgPool, withTransaction, isValidUuid } from '../db/client';
import { getShopIdentity } from './identity';
import { getSyncConfig } from './config';
import { callCloud, CloudError } from './cloudClient';
import { recordAuditLog } from '../db/audit';
import type { SyncActor } from './outbox';

export interface SnapshotMedicine {
  medicine_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  status: string;
  version: number;
  stock_version: number;
  current_stock: number;
  purchase_price: number | null;
  selling_price: number | null;
}

export interface SnapshotBatch {
  batch_id: string;
  medicine_id: string;
  batch_number: string;
  quantity_available: number;
  status: string;
  expiry_date: string | null;
  purchase_price: number | null;
  selling_price_override: number | null;
  stock_version: number;
}

export interface AuthoritativeInventorySnapshot {
  shop_id: string;
  snapshot_id: string;
  snapshot_seq: number;
  generated_at: string;
  fingerprint: string;
  medicines: SnapshotMedicine[];
  batches: SnapshotBatch[];
  integrity_errors?: Array<{ medicine_id: string; name: string; current_stock: number; calculated_stock: number }>;
}

export interface ParityCheckResult {
  shop_id: string;
  shop_code: string;
  timestamp: string;
  in_sync: boolean;
  parity: 'MATCH' | 'CLOUD_BEHIND' | 'CLOUD_AHEAD_INVALID' | 'MISSING_CLOUD_ROW' | 'EXTRA_CLOUD_ROW' | 'VERSION_MISMATCH' | 'AUTHORITATIVE_RECONCILIATION_REQUIRED';
  local_fingerprint: string;
  cloud_fingerprint: string | null;
  snapshot_seq: number;
  medicines_checked: number;
  medicine_mismatches: number;
  batch_mismatches: number;
  missing_cloud: number;
  extra_cloud: number;
  version_mismatches: number;
  reconciled: boolean;
  details?: any;
}

/**
 * Computes deterministic canonical SHA-256 fingerprint for entire shop inventory.
 * Canonical sorted values:
 *   Medicines: id:version:stock_version:current_stock:status
 *   Batches:   id:quantity_available:stock_version:status:expiry_date
 */
export function computeInventoryFingerprint(
  medicines: SnapshotMedicine[],
  batches: SnapshotBatch[]
): string {
  const sortedMeds = [...medicines].sort((a, b) => a.medicine_id.localeCompare(b.medicine_id));
  const sortedBatches = [...batches].sort((a, b) => a.batch_id.localeCompare(b.batch_id));

  const medLines = sortedMeds.map(
    (m) => `M:${m.medicine_id}:${m.version}:${m.stock_version}:${Number(m.current_stock)}:${m.status}`
  );
  const batchLines = sortedBatches.map(
    (b) => `B:${b.batch_id}:${b.medicine_id}:${Number(b.quantity_available)}:${b.stock_version}:${b.status}:${b.expiry_date || ''}`
  );

  const raw = [...medLines, ...batchLines].join('\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generates an authoritative snapshot from local PostgreSQL within a single consistent transaction.
 * High-water mark sequence and all medicine/batch rows are read at the EXACT same instant.
 */
export async function generateAuthoritativeInventorySnapshot(
  poolOrClient?: pg.PoolClient | pg.Pool
): Promise<AuthoritativeInventorySnapshot> {
  const client = poolOrClient || pgPool;
  const identity = await getShopIdentity();

  // If a pool was passed, check out a client and use REPEATABLE READ for true point-in-time isolation
  const isPool = !(poolOrClient && 'release' in poolOrClient);
  const activeClient = isPool ? await pgPool.connect() : (client as pg.PoolClient);

  try {
    if (isPool) {
      await activeClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }

    // 1. Capture high-water sequence inside the consistent snapshot
    const seqRes = await activeClient.query('SELECT COALESCE(MAX(seq), 0)::bigint AS snapshot_seq FROM sync_events');
    const snapshotSeq = Number(seqRes.rows[0]?.snapshot_seq || 0);

    // 2. Fetch all operational medicines
    const medsRes = await activeClient.query(`
      SELECT id AS medicine_id, name, sku, barcode, status,
             COALESCE(version, 1)::int AS version,
             COALESCE(stock_version, 1)::int AS stock_version,
             COALESCE(current_stock, 0)::numeric AS current_stock,
             purchase_price, selling_price
        FROM medicines
       WHERE status <> 'archived'
       ORDER BY id
    `);

    // 3. Fetch all operational batches
    const batchesRes = await activeClient.query(`
      SELECT b.id AS batch_id, b.medicine_id, b.batch_number,
             COALESCE(b.quantity_available, 0)::int AS quantity_available,
             COALESCE(b.status, 'active') AS status,
             b.expiry_date, b.purchase_price, b.selling_price_override,
             COALESCE(b.stock_version, 1)::int AS stock_version
        FROM medicine_batches b
        JOIN medicines m ON m.id = b.medicine_id
       WHERE m.status <> 'archived'
       ORDER BY b.id
    `);

    const medicines: SnapshotMedicine[] = medsRes.rows.map((r) => ({
      medicine_id: r.medicine_id,
      name: r.name,
      sku: r.sku || null,
      barcode: r.barcode || null,
      status: r.status,
      version: Number(r.version),
      stock_version: Number(r.stock_version),
      current_stock: Number(r.current_stock),
      purchase_price: r.purchase_price ? Number(r.purchase_price) : null,
      selling_price: r.selling_price ? Number(r.selling_price) : null,
    }));

    const batches: SnapshotBatch[] = batchesRes.rows.map((r) => ({
      batch_id: r.batch_id,
      medicine_id: r.medicine_id,
      batch_number: r.batch_number,
      quantity_available: Number(r.quantity_available),
      status: r.status,
      expiry_date: r.expiry_date ? new Date(r.expiry_date).toISOString().slice(0, 10) : null,
      purchase_price: r.purchase_price ? Number(r.purchase_price) : null,
      selling_price_override: r.selling_price_override ? Number(r.selling_price_override) : null,
      stock_version: Number(r.stock_version),
    }));

    // 4. Verify batch total invariant (Part 8)
    const batchesByMed = new Map<string, SnapshotBatch[]>();
    for (const b of batches) {
      if (!batchesByMed.has(b.medicine_id)) batchesByMed.set(b.medicine_id, []);
      batchesByMed.get(b.medicine_id)!.push(b);
    }

    const integrityErrors: Array<{ medicine_id: string; name: string; current_stock: number; calculated_stock: number }> = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const m of medicines) {
      const medBatches = batchesByMed.get(m.medicine_id) || [];
      const calculated = medBatches
        .filter((b) => b.status === 'active' && (!b.expiry_date || b.expiry_date > today))
        .reduce((sum, b) => sum + b.quantity_available, 0);

      if (calculated !== m.current_stock) {
        integrityErrors.push({
          medicine_id: m.medicine_id,
          name: m.name,
          current_stock: m.current_stock,
          calculated_stock: calculated,
        });
      }
    }

    if (integrityErrors.length > 0) {
      console.warn(
        `[InventorySnapshot] LOCAL_STOCK_INTEGRITY_ERROR detected on ${integrityErrors.length} medicine(s):`,
        integrityErrors.slice(0, 5)
      );
    }

    // 5. Deterministic fingerprint
    const fingerprint = computeInventoryFingerprint(medicines, batches);
    const snapshotId = crypto.randomUUID();

    if (isPool) {
      await activeClient.query('COMMIT');
    }

    return {
      shop_id: identity.shop_id,
      snapshot_id: snapshotId,
      snapshot_seq: snapshotSeq,
      generated_at: new Date().toISOString(),
      fingerprint,
      medicines,
      batches,
      integrity_errors: integrityErrors.length > 0 ? integrityErrors : undefined,
    };
  } catch (err) {
    if (isPool) {
      await activeClient.query('ROLLBACK').catch(() => {});
    }
    throw err;
  } finally {
    if (isPool) {
      activeClient.release();
    }
  }
}

/**
 * Publishes the local authoritative snapshot directly to the Cloud mirror via gc_apply_inventory_snapshot.
 * Atomically updates Cloud to mirror Shop without modifying physical local stock.
 */
export async function publishAuthoritativeInventorySnapshot(options?: {
  actor?: SyncActor;
  reason?: string;
  client?: pg.PoolClient;
}): Promise<{
  ok: boolean;
  snapshot_id: string;
  snapshot_seq: number;
  fingerprint: string;
  medicines_count: number;
  batches_count: number;
}> {
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();

  if (!cfg.cloudConfigured || !cfg.shopToken) {
    throw new Error('Cloud is not configured; cannot publish authoritative inventory snapshot.');
  }

  // 1. Generate consistent local snapshot
  const snapshot = await generateAuthoritativeInventorySnapshot(options?.client);

  // 2. Dispatch to Supabase Cloud RPC
  const res = await callCloud<any>('gc_apply_inventory_snapshot', {
    p_shop_id: identity.shop_id,
    p_token: cfg.shopToken,
    p_snapshot: {
      snapshot_id: snapshot.snapshot_id,
      snapshot_seq: snapshot.snapshot_seq,
      generated_at: snapshot.generated_at,
      fingerprint: snapshot.fingerprint,
      medicines: snapshot.medicines,
      batches: snapshot.batches,
    },
  });

  if (!res?.ok && !res?.ignored) {
    throw new Error(`Cloud snapshot application failed: ${JSON.stringify(res)}`);
  }

  // 3. Record local audit record
  await recordAuditLog({
    action: 'CLOUD_MIRROR_RECONCILED',
    entity: 'shop',
    entity_id: identity.shop_id,
    user_id: options?.actor?.user_id || undefined,
    user_name: options?.actor?.user_name || 'System Auto-Parity',
    role: (options?.actor?.role as any) || 'ADMIN',
    new_value: {
      snapshot_id: snapshot.snapshot_id,
      snapshot_seq: snapshot.snapshot_seq,
      fingerprint: snapshot.fingerprint,
      medicines_count: snapshot.medicines.length,
      batches_count: snapshot.batches.length,
      reason: options?.reason || 'Authoritative Shop Mirror Reconciliation',
      cloud_response: res,
    },
  }, options?.client);

  // 4. Record in local shop_inventory_snapshots
  const db = options?.client || pgPool;
  await db.query(
    `INSERT INTO shop_inventory_snapshots (
       snapshot_id, snapshot_seq, generated_at, fingerprint, medicines_count, batches_count,
       total_stock, status, cloud_confirmed_at, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9::jsonb)
     ON CONFLICT (snapshot_id) DO UPDATE SET
       cloud_confirmed_at = CURRENT_TIMESTAMP, status = 'CONFIRMED'`,
    [
      snapshot.snapshot_id,
      snapshot.snapshot_seq,
      snapshot.generated_at,
      snapshot.fingerprint,
      snapshot.medicines.length,
      snapshot.batches.length,
      snapshot.medicines.reduce((sum, m) => sum + m.current_stock, 0),
      res?.ignored ? 'SUPERSEDED' : 'CONFIRMED',
      JSON.stringify({ cloud_response: res }),
    ]
  );

  return {
    ok: true,
    snapshot_id: snapshot.snapshot_id,
    snapshot_seq: snapshot.snapshot_seq,
    fingerprint: snapshot.fingerprint,
    medicines_count: snapshot.medicines.length,
    batches_count: snapshot.batches.length,
  };
}

/**
 * Performs fast fingerprint comparison and exhaustive parity check between Shop and Cloud.
 * If drift is detected and autoReconcile is true, immediately self-heals by publishing the snapshot.
 */
export async function checkInventoryParity(options?: {
  autoReconcile?: boolean;
  actor?: SyncActor;
  reason?: string;
}): Promise<ParityCheckResult> {
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();
  const now = new Date().toISOString();

  // 1. Generate local snapshot & fingerprint
  const localSnapshot = await generateAuthoritativeInventorySnapshot();
  const localFp = localSnapshot.fingerprint;

  if (!cfg.cloudConfigured || !cfg.shopToken) {
    return {
      shop_id: identity.shop_id,
      shop_code: identity.shop_code || 'SHOP1',
      timestamp: now,
      in_sync: false,
      parity: 'AUTHORITATIVE_RECONCILIATION_REQUIRED',
      local_fingerprint: localFp,
      cloud_fingerprint: null,
      snapshot_seq: localSnapshot.snapshot_seq,
      medicines_checked: localSnapshot.medicines.length,
      medicine_mismatches: 0,
      batch_mismatches: 0,
      missing_cloud: 0,
      extra_cloud: 0,
      version_mismatches: 0,
      reconciled: false,
      details: { reason: 'Cloud unreachable or not configured' },
    };
  }

  // 2. Fetch cloud fingerprint
  let cloudFpData: any = null;
  try {
    cloudFpData = await callCloud<any>('gc_get_inventory_fingerprint', {
      p_shop_id: identity.shop_id,
      p_token: cfg.shopToken,
    });
  } catch (err: any) {
    console.warn('[InventorySnapshot] Cloud fingerprint fetch failed:', err?.message || err);
  }

  let cloudFp = cloudFpData?.fingerprint || null;

  // 3. Fast Fingerprint Check
  if (cloudFp && localFp === cloudFp) {
    return {
      shop_id: identity.shop_id,
      shop_code: identity.shop_code || 'SHOP1',
      timestamp: now,
      in_sync: true,
      parity: 'MATCH',
      local_fingerprint: localFp,
      cloud_fingerprint: cloudFp,
      snapshot_seq: localSnapshot.snapshot_seq,
      medicines_checked: localSnapshot.medicines.length,
      medicine_mismatches: 0,
      batch_mismatches: 0,
      missing_cloud: 0,
      extra_cloud: 0,
      version_mismatches: 0,
      reconciled: false,
    };
  }

  // 4. Exhaustive parity inspection via gc_inspect_shop_data
  let inspectRes: any = null;
  try {
    inspectRes = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: identity.shop_id,
      p_token: cfg.shopToken,
    });
  } catch (err: any) {
    console.warn('[InventorySnapshot] gc_inspect_shop_data failed:', err?.message || err);
  }

  const cloudMedsMap = new Map<string, any>();
  const cloudBatchesMap = new Map<string, any>();

  if (inspectRes && Array.isArray(inspectRes.medicines)) {
    for (const m of inspectRes.medicines) cloudMedsMap.set(m.medicine_id || m.id, m);
  }
  if (inspectRes && Array.isArray(inspectRes.stock_levels)) {
    for (const b of inspectRes.stock_levels) cloudBatchesMap.set(b.batch_id, b);
  }

  let medicineMismatches = 0;
  let batchMismatches = 0;
  let missingCloud = 0;
  let extraCloud = 0;
  let versionMismatches = 0;

  for (const m of localSnapshot.medicines) {
    const cloudMed = cloudMedsMap.get(m.medicine_id);
    if (!cloudMed) {
      missingCloud++;
      medicineMismatches++;
    } else {
      if (Number(cloudMed.current_stock) !== m.current_stock) medicineMismatches++;
      if (Number(cloudMed.local_version || cloudMed.version || 1) !== m.version) versionMismatches++;
    }
  }

  for (const b of localSnapshot.batches) {
    const cloudBatch = cloudBatchesMap.get(b.batch_id);
    if (!cloudBatch) {
      batchMismatches++;
    } else if (Number(cloudBatch.quantity ?? cloudBatch.quantity_available ?? 0) !== b.quantity_available) {
      batchMismatches++;
    }
  }

  // Check extra rows in cloud
  for (const cloudMedId of cloudMedsMap.keys()) {
    if (!localSnapshot.medicines.some((m) => m.medicine_id === cloudMedId)) {
      extraCloud++;
    }
  }

  let parity: ParityCheckResult['parity'] = 'MATCH';
  if (missingCloud > 0) parity = 'MISSING_CLOUD_ROW';
  else if (extraCloud > 0) parity = 'EXTRA_CLOUD_ROW';
  else if (versionMismatches > 0) parity = 'VERSION_MISMATCH';
  else if (medicineMismatches > 0 || batchMismatches > 0) parity = 'CLOUD_BEHIND';

  let reconciled = false;
  if (options?.autoReconcile || options?.reason) {
    try {
      console.log(`[InventorySnapshot] Auto-reconciling drift (${parity}, ${medicineMismatches} med mismatch, ${batchMismatches} batch mismatch)...`);
      await publishAuthoritativeInventorySnapshot({
        actor: options?.actor,
        reason: options?.reason || `Self-heal from parity state: ${parity}`,
      });
      reconciled = true;
      parity = 'MATCH';
      medicineMismatches = 0;
      batchMismatches = 0;
      missingCloud = 0;
      extraCloud = 0;
      versionMismatches = 0;
      cloudFp = localFp;
    } catch (recErr: any) {
      console.error('[InventorySnapshot] Auto-reconciliation error:', recErr?.message || recErr);
    }
  }

  return {
    shop_id: identity.shop_id,
    shop_code: identity.shop_code || 'SHOP1',
    timestamp: now,
    in_sync: parity === 'MATCH',
    parity,
    local_fingerprint: localFp,
    cloud_fingerprint: cloudFp,
    snapshot_seq: localSnapshot.snapshot_seq,
    medicines_checked: localSnapshot.medicines.length,
    medicine_mismatches: medicineMismatches,
    batch_mismatches: batchMismatches,
    missing_cloud: missingCloud,
    extra_cloud: extraCloud,
    version_mismatches: versionMismatches,
    reconciled,
    details: {
      integrity_errors: localSnapshot.integrity_errors,
    },
  };
}
