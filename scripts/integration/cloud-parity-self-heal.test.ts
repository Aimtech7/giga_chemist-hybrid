process.env.APP_MODE = 'hybrid';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { getShopIdentity } from '../../server/sync/identity';
import {
  generateAuthoritativeInventorySnapshot,
  publishAuthoritativeInventorySnapshot,
  computeInventoryFingerprint,
  checkInventoryParity,
} from '../../server/sync/inventorySnapshot';

async function run() {
  await assertDevDatabase();

  const identity = await getShopIdentity();
  const shopId = identity.shop_id;

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  // Isolated in-memory cloud mirror. This suite must NEVER write the development clone into
  // Shop 1's live Supabase mirror; live RPC compatibility is covered by separate integration suites.
  let cloudState: {
    snapshotSeq: number;
    fingerprint: string | null;
    medicines: any[];
    stockLevels: any[];
    batches: any[];
  } = { snapshotSeq: 0, fingerprint: null, medicines: [], stockLevels: [], batches: [] };
  let snapshotApplyCalls = 0;

  const fakeCloud = async <T = any>(fn: any, args: Record<string, any>): Promise<T> => {
    if (fn === 'gc_get_inventory_fingerprint') {
      return {
        ok: true,
        fingerprint: cloudState.fingerprint,
        snapshot_seq: cloudState.snapshotSeq,
        medicines_count: cloudState.medicines.length,
        batches_count: cloudState.stockLevels.length,
      } as T;
    }
    if (fn === 'gc_inspect_shop_data') {
      return {
        medicines: cloudState.medicines,
        stock_levels: cloudState.stockLevels,
        batches: cloudState.batches,
      } as T;
    }
    if (fn === 'gc_apply_inventory_snapshot') {
      snapshotApplyCalls++;
      const s = args.p_snapshot || {};
      const seq = Number(s.snapshot_seq || 0);
      if (seq < cloudState.snapshotSeq) {
        return {
          ok: false,
          ignored: true,
          reason: 'OLDER_SNAPSHOT_SUPERSEDED',
          current_snapshot_seq: cloudState.snapshotSeq,
          attempted_seq: seq,
        } as T;
      }
      cloudState = {
        snapshotSeq: seq,
        fingerprint: s.fingerprint || null,
        medicines: (s.medicines || []).map((m: any) => ({ ...m, id: m.medicine_id })),
        stockLevels: (s.batches || []).map((b: any) => ({
          medicine_id: b.medicine_id,
          batch_id: b.batch_id,
          quantity: b.quantity_available,
          quantity_available: b.quantity_available,
          stock_version: b.stock_version,
        })),
        batches: (s.batches || []).map((b: any) => ({ ...b })),
      };
      return { ok: true, ignored: false, snapshot_seq: seq, fingerprint: cloudState.fingerprint } as T;
    }
    throw new Error(`Unexpected fake cloud RPC: ${String(fn)}`);
  };

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
    const parityPre = await checkInventoryParity({ autoReconcile: false, cloudCall: fakeCloud as any });
    check(typeof parityPre.parity === 'string', '3.1 Parity state evaluated');

    // Trigger self-heal via checkInventoryParity({ autoReconcile: true })
    const parityPost = await checkInventoryParity({ autoReconcile: true, cloudCall: fakeCloud as any });
    check(parityPost.in_sync === true, '3.2 Post-reconciliation parity is MATCH');
    check(parityPost.parity === 'MATCH', '3.3 Parity status reports MATCH');
    check(parityPost.medicine_mismatches === 0, '3.4 0 medicine mismatches');
    check(parityPost.batch_mismatches === 0, '3.5 0 batch mismatches');

    // Verify isolated Cloud has updated fingerprint
    const cloudFpData = await fakeCloud<any>('gc_get_inventory_fingerprint', { p_shop_id: shopId });
    check(cloudFpData.fingerprint === parityPost.local_fingerprint, '3.6 Cloud inventory fingerprint matches local Shop fingerprint exactly');

    // =========================================================================
    // SECTION 4: "SYNC FROM SHOP NOW" MANUAL ACTION
    // =========================================================================
    section('4. "SYNC FROM SHOP NOW" Manual Action');

    const manualSyncRes = await publishAuthoritativeInventorySnapshot({
      actor: adminActor,
      reason: 'Global Admin: SYNC FROM SHOP NOW manual action',
      cloudCall: fakeCloud as any,
    });

    check(manualSyncRes.ok === true, '4.1 SYNC FROM SHOP NOW executes successfully');
    check(manualSyncRes.medicines_count > 0, '4.2 All medicines mirrored to cloud');
    check(manualSyncRes.batches_count > 0, '4.3 All batches mirrored to cloud');

    const parityAfterManual = await checkInventoryParity({ autoReconcile: false, cloudCall: fakeCloud as any });
    check(parityAfterManual.in_sync === true, '4.4 Immediate parity check reports MATCH');

    // =========================================================================
    // SECTION 5: SUPERSEDED SNAPSHOT MUST NEVER FALSE-GREEN
    // =========================================================================
    section('5. High-water supersession safety');

    const localNow = await generateAuthoritativeInventorySnapshot();
    cloudState.snapshotSeq = localNow.snapshot_seq + 100;
    cloudState.fingerprint = 'cloud-newer-fingerprint';
    const applyCallsBeforeCloudAheadCheck = snapshotApplyCalls;

    const superseded = await checkInventoryParity({ autoReconcile: true, cloudCall: fakeCloud as any });
    check(superseded.in_sync === false, '5.1 Cloud-ahead state is NOT reported in sync');
    check(superseded.parity === 'CLOUD_AHEAD_INVALID', '5.2 Higher cloud high-water reports CLOUD_AHEAD_INVALID');
    check(snapshotApplyCalls === applyCallsBeforeCloudAheadCheck, '5.3 Cloud-ahead state does not attempt an older snapshot overwrite');
    check(Number(superseded.details?.cloud_snapshot_seq) > superseded.snapshot_seq, '5.4 Diagnostics preserve the higher cloud snapshot sequence');
  } finally {
    await pool.end();
  }

  process.exit(summary());
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
