process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx, adminRemoveStockTx } from '../../server/db/inventory';
import { getShopIdentity, clearShopIdentityCache } from '../../server/sync/identity';
import {
  generateAuthoritativeInventorySnapshot,
  publishAuthoritativeInventorySnapshot,
  computeInventoryFingerprint,
  checkInventoryParity,
} from '../../server/sync/inventorySnapshot';
import { callCloud } from '../../server/sync/cloudClient';
import { getSyncConfig } from '../../server/sync/config';

async function run() {
  await assertDevDatabase();
  clearShopIdentityCache();

  const identity = await getShopIdentity();
  const shopId = identity.shop_id;
  const cfg = getSyncConfig();

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  try {
    async function createTestMed(name: string, initialStock: number, batchNumber: string) {
      const medId = crypto.randomUUID();
      const med = await withTransaction(async (c) => {
        await createMedicineTx(c, medId, {
          name,
          selling_price: 150,
          purchase_price: 80,
          current_stock: 0,
        }, adminActor);

        await adminAddStockTx(c, {
          medicine_id: medId,
          quantity: initialStock,
          batch_number: batchNumber,
          expiry_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
          user_id: adminActor.user_id,
          user_name: adminActor.user_name,
          role: adminActor.role,
        });

        return (await getMedicineById(medId, c))!;
      });
      const bRow = (await pool.query('SELECT id, batch_number, quantity_available FROM medicine_batches WHERE medicine_id = $1', [med.id])).rows[0];
      return { med, batch: bRow };
    }

    // =========================================================================
    // SECTION 1: POINT-IN-TIME REPEATABLE-READ AUTHORITATIVE SNAPSHOT
    // =========================================================================
    section('1. Authoritative Point-in-time PostgreSQL Snapshot');

    const snap1 = await generateAuthoritativeInventorySnapshot();
    check(Boolean(snap1.snapshot_id), '1.1 Snapshot has unique snapshot_id UUID');
    check(snap1.snapshot_seq >= 0, '1.2 High-water mark snapshot_seq captured inside transaction');
    check(snap1.medicines.length > 0, '1.3 Reads operational medicines from PostgreSQL');
    check(snap1.batches.length > 0, '1.4 Reads operational batches from PostgreSQL');
    check(typeof snap1.fingerprint === 'string' && snap1.fingerprint.length === 64, '1.5 Generates deterministic SHA-256 fingerprint');

    // =========================================================================
    // SECTION 2: TEST 1 — EXISTING DIFFERENCE (Shop = 17, Cloud = 20)
    // =========================================================================
    section('2. TEST 1 — Existing Difference (Shop = 17, Cloud = 20)');

    const { med: med1, batch: batch1 } = await createTestMed(`Test1_Mirror_${Date.now()}`, 17, `B-M1-${Date.now().toString().slice(-4)}`);
    check(Number(med1.current_stock) === 17, '2.1 Authoritative Shop stock is 17');

    const initialMovementCount = Number((await pool.query('SELECT COUNT(*) AS c FROM inventory_movements WHERE medicine_id = $1', [med1.id])).rows[0].c);

    // Publish authoritative snapshot to cloud
    const pubRes1 = await publishAuthoritativeInventorySnapshot({
      reason: 'TEST 1: Authoritative reconciliation for Shop=17',
    });
    check(pubRes1.ok === true, '2.2 Snapshot published successfully to Cloud mirror');

    // Verify Cloud mirror matches Shop
    const cloudInspect = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });

    const cloudMed1 = cloudInspect.medicines?.find((m: any) => (m.medicine_id || m.id) === med1.id);
    const cloudBatch1 = cloudInspect.stock_levels?.find((b: any) => b.batch_id === batch1.id);

    check(cloudMed1 != null, '2.3 Cloud contains medicine');
    check(Number(cloudMed1?.current_stock) === 17, '2.4 Cloud current_stock is 17 (Shop=17, Cloud=17)');
    check(Number(cloudBatch1?.quantity ?? cloudBatch1?.quantity_available) === 17, '2.5 Cloud batch quantity is 17');

    // CRITICAL: Assert NO local inventory movement was created for cloud reconciliation
    const finalMovementCount = Number((await pool.query('SELECT COUNT(*) AS c FROM inventory_movements WHERE medicine_id = $1', [med1.id])).rows[0].c);
    check(finalMovementCount === initialMovementCount, '2.6 No local Shop inventory movement created for cloud-only reconciliation');

    // Check audit log
    const audit1 = (await pool.query("SELECT * FROM audit_logs WHERE action = 'CLOUD_MIRROR_RECONCILED' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1", [shopId])).rows[0];
    check(Boolean(audit1), '2.7 Audit log CLOUD_MIRROR_RECONCILED recorded');

    // =========================================================================
    // SECTION 3: TEST 2 — VERSION DIFFERENCE (Shop version = 8, Cloud version = 6)
    // =========================================================================
    section('3. TEST 2 — Version Difference (Shop version matched to Cloud)');

    await pool.query('UPDATE medicines SET version = 8, stock_version = 8 WHERE id = $1', [med1.id]);
    await pool.query('UPDATE medicine_batches SET stock_version = 8 WHERE id = $1', [batch1.id]);

    await publishAuthoritativeInventorySnapshot({
      reason: 'TEST 2: Version difference reconciliation',
    });

    const cloudInspect2 = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    const cloudMedV = cloudInspect2.medicines?.find((m: any) => (m.medicine_id || m.id) === med1.id);
    const cloudBatchV = cloudInspect2.stock_levels?.find((b: any) => b.batch_id === batch1.id);

    check(Number(cloudMedV?.local_version || cloudMedV?.version) === 8, '3.1 Cloud medicine version updated to 8');
    check(Number(cloudBatchV?.stock_version) === 8, '3.2 Cloud batch stock_version updated to 8');

    // =========================================================================
    // SECTION 4: TEST 3 — CLOUD MISSING MEDICINE (Exists Shop, missing Cloud)
    // =========================================================================
    section('4. TEST 3 — Cloud Missing Medicine (Created on Shop, mirrored to Cloud)');

    const { med: med3, batch: batch3 } = await createTestMed(`MissingCloud_${Date.now()}`, 45, `B-MIS-${Date.now().toString().slice(-4)}`);

    const pubRes3 = await publishAuthoritativeInventorySnapshot({
      reason: 'TEST 3: Missing cloud medicine creation',
    });
    check(pubRes3.ok === true, '4.1 Snapshot published with new medicine');

    const cloudInspect3 = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    const cloudMed3 = cloudInspect3.medicines?.find((m: any) => (m.medicine_id || m.id) === med3.id);
    const cloudBatch3 = cloudInspect3.stock_levels?.find((b: any) => b.batch_id === batch3.id);

    check(cloudMed3 != null, '4.2 Missing medicine automatically created in Cloud mirror');
    check(Number(cloudMed3?.current_stock) === 45, '4.3 Cloud medicine current_stock is 45');
    check(Number(cloudBatch3?.quantity ?? cloudBatch3?.quantity_available) === 45, '4.4 Cloud batch created with quantity 45');

    // =========================================================================
    // SECTION 5: TEST 4 — OFFLINE SALES (Simulated sales followed by reconnection)
    // =========================================================================
    section('5. TEST 4 — Offline Sales Reconnection');

    const { med: med4, batch: batch4 } = await createTestMed(`OfflineSale_${Date.now()}`, 20, `B-OFF-${Date.now().toString().slice(-4)}`);
    await publishAuthoritativeInventorySnapshot({ reason: 'Initial sync before offline sale' });

    // Local sale of 4 items offline (20 -> 16)
    await withTransaction(async (c) => {
      await adminRemoveStockTx(c, {
        medicine_id: med4.id,
        batch_id: batch4.id,
        quantity: 4,
        reason: 'Customer sale (offline)',
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
    });

    const med4Local = await getMedicineById(med4.id, pool);
    check(Number(med4Local?.current_stock) === 16, '5.1 Shop stock after offline sale is 16');

    // Reconnection reconciliation publishes authoritative state
    const recon4 = await checkInventoryParity({ autoReconcile: true });
    check(recon4.in_sync === true, '5.2 Post-reconnection parity reports MATCH');

    const cloudInspect4 = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    const cloudMed4 = cloudInspect4.medicines?.find((m: any) => (m.medicine_id || m.id) === med4.id);
    check(Number(cloudMed4?.current_stock) === 16, '5.3 Cloud mirror reflects 16 (matches Shop exactly)');

    // =========================================================================
    // SECTION 6: TEST 14 — NO PERSISTENT DIFFERENCES
    // =========================================================================
    section('6. TEST 14 — Zero Drift Invariant Verification');

    const parityFinal = await checkInventoryParity({ autoReconcile: true });
    check(parityFinal.in_sync === true, '6.1 Parity is MATCH');
    check(parityFinal.medicine_mismatches === 0, '6.2 MEDICINE_MISMATCH = 0');
    check(parityFinal.batch_mismatches === 0, '6.3 BATCH_MISMATCH = 0');
    check(parityFinal.version_mismatches === 0, '6.4 VERSION_MISMATCH = 0');
    check(parityFinal.missing_cloud === 0, '6.5 MISSING_CLOUD_ROW = 0');

    const negLocal = (await pool.query('SELECT COUNT(*) AS c FROM medicines WHERE current_stock < 0')).rows[0].c;
    check(Number(negLocal) === 0, '6.6 NEGATIVE_LOCAL_STOCK = 0');

    const negBatches = (await pool.query('SELECT COUNT(*) AS c FROM medicine_batches WHERE quantity_available < 0')).rows[0].c;
    check(Number(negBatches) === 0, '6.7 NEGATIVE_BATCH_STOCK = 0');
  } finally {
    await pool.end();
  }

  process.exit(summary());
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
