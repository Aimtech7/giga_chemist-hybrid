process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx } from '../../server/db/inventory';
import { getShopIdentity } from '../../server/sync/identity';
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

  const identity = await getShopIdentity();
  const shopId = identity.shop_id;
  const cfg = getSyncConfig();

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  try {
    // =========================================================================
    // SECTION 1: DETERMINISTIC CANONICAL FINGERPRINTING
    // =========================================================================
    section('1. Deterministic Canonical Fingerprinting');

    const medA = {
      medicine_id: '11111111-1111-1111-1111-111111111111',
      name: 'Med A',
      sku: 'SKU-A',
      barcode: 'BAR-A',
      status: 'active',
      version: 1,
      stock_version: 1,
      current_stock: 10,
      purchase_price: 50,
      selling_price: 100,
    };
    const medB = {
      medicine_id: '22222222-2222-2222-2222-222222222222',
      name: 'Med B',
      sku: 'SKU-B',
      barcode: 'BAR-B',
      status: 'active',
      version: 2,
      stock_version: 3,
      current_stock: 25,
      purchase_price: 70,
      selling_price: 120,
    };

    const batchA = {
      batch_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      medicine_id: medA.medicine_id,
      batch_number: 'B-A',
      quantity_available: 10,
      status: 'active',
      expiry_date: '2027-01-01',
      purchase_price: 50,
      selling_price_override: null,
      stock_version: 1,
    };
    const batchB = {
      batch_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      medicine_id: medB.medicine_id,
      batch_number: 'B-B',
      quantity_available: 25,
      status: 'active',
      expiry_date: '2027-06-01',
      purchase_price: 70,
      selling_price_override: null,
      stock_version: 3,
    };

    const fp1 = computeInventoryFingerprint([medA, medB], [batchA, batchB]);
    const fp2 = computeInventoryFingerprint([medB, medA], [batchB, batchA]); // Reverse order

    check(typeof fp1 === 'string' && fp1.length === 64, '1.1 Fingerprint is 64-char hex SHA-256');
    check(fp1 === fp2, '1.2 Fingerprint is order-invariant (canonical sorting ensures deterministic hash)');

    // =========================================================================
    // SECTION 2: BATCH TOTAL INVARIANT VERIFICATION
    // =========================================================================
    section('2. Batch Total Invariant Verification');

    const snap = await generateAuthoritativeInventorySnapshot();
    check(!snap.integrity_errors || snap.integrity_errors.length === 0, '2.1 Local PostgreSQL satisfies Batch Total Invariant (current_stock == SUM(active batches))');

    // =========================================================================
    // SECTION 3: AUTOMATIC SELF-HEAL (Shop -> Cloud)
    // =========================================================================
    section('3. Automatic Self-Heal (Shop -> Cloud Mirror Repair)');

    // Check parity before self-heal
    const parityPre = await checkInventoryParity({ autoReconcile: false });
    check(typeof parityPre.parity === 'string', '3.1 Parity state evaluated');

    // Trigger self-heal via checkInventoryParity({ autoReconcile: true })
    const parityPost = await checkInventoryParity({ autoReconcile: true });
    check(parityPost.in_sync === true, '3.2 Post-reconciliation parity is MATCH');
    check(parityPost.parity === 'MATCH', '3.3 Parity status reports MATCH');
    check(parityPost.medicine_mismatches === 0, '3.4 0 medicine mismatches');
    check(parityPost.batch_mismatches === 0, '3.5 0 batch mismatches');

    // Verify Cloud has updated fingerprint
    const cloudFpData = await callCloud<any>('gc_get_inventory_fingerprint', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    check(cloudFpData.fingerprint === parityPost.local_fingerprint, '3.6 Cloud inventory fingerprint matches local Shop fingerprint exactly');

    // =========================================================================
    // SECTION 4: "SYNC FROM SHOP NOW" MANUAL ACTION
    // =========================================================================
    section('4. "SYNC FROM SHOP NOW" Manual Action');

    const manualSyncRes = await publishAuthoritativeInventorySnapshot({
      actor: adminActor,
      reason: 'Global Admin: SYNC FROM SHOP NOW manual action',
    });

    check(manualSyncRes.ok === true, '4.1 SYNC FROM SHOP NOW executes successfully');
    check(manualSyncRes.medicines_count > 0, '4.2 All medicines mirrored to cloud');
    check(manualSyncRes.batches_count > 0, '4.3 All batches mirrored to cloud');

    const parityAfterManual = await checkInventoryParity({ autoReconcile: false });
    check(parityAfterManual.in_sync === true, '4.4 Immediate parity check reports MATCH');
  } finally {
    await pool.end();
  }

  process.exit(summary());
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
