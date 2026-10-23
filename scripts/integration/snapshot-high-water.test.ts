process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx, adminRemoveStockTx } from '../../server/db/inventory';
import { getShopIdentity } from '../../server/sync/identity';
import {
  generateAuthoritativeInventorySnapshot,
  publishAuthoritativeInventorySnapshot,
} from '../../server/sync/inventorySnapshot';
import { callCloud } from '../../server/sync/cloudClient';
import { getSyncConfig } from '../../server/sync/config';
import { enqueueSyncEvent } from '../../server/sync/outbox';

async function run() {
  await assertDevDatabase();

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
          selling_price: 200,
          purchase_price: 120,
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
    // SECTION 1: HIGH-WATER MARK CAPTURE IN REPEATABLE READ
    // =========================================================================
    section('1. High-water mark capture in consistent transaction');

    const snap = await generateAuthoritativeInventorySnapshot();
    check(typeof snap.snapshot_seq === 'number', '1.1 snapshot_seq is numeric');
    const currentMaxSeq = Number((await pool.query('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_events')).rows[0].m);
    check(snap.snapshot_seq === currentMaxSeq, '1.2 snapshot_seq matches highest committed sync_events.seq');

    // =========================================================================
    // SECTION 2: TEST 9 — SNAPSHOT RACE (Snapshot through B, Sale B+1)
    // =========================================================================
    section('2. TEST 9 — Snapshot Race (Snapshot at B, Sale at B+1)');

    const { med: med1, batch: batch1 } = await createTestMed(`RaceMed_${Date.now()}`, 50, `B-RACE-${Date.now().toString().slice(-4)}`);

    // Take snapshot at baseline B
    const snapshotB = await generateAuthoritativeInventorySnapshot();
    const baselineSeq = snapshotB.snapshot_seq;

    // Immediately after snapshot B was generated, a local stock removal of 5 units occurs with seq B+1
    await withTransaction(async (c) => {
      await adminRemoveStockTx(c, {
        medicine_id: med1.id,
        batch_id: batch1.id,
        quantity: 5,
        reason: 'Customer sale during snapshot publishing',
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
    });

    const saleRow = (await pool.query(
      "SELECT * FROM sync_events WHERE event_type = 'STOCK_REMOVED' AND entity_id = $1 ORDER BY seq DESC LIMIT 1",
      [med1.id]
    )).rows[0];
    const saleSeq = Number(saleRow.seq);
    check(saleSeq > baselineSeq, '2.1 Sale event sequence B+1 is strictly greater than snapshot baseline B', {
      baselineSeq,
      saleSeq,
    });

    // 1. Cloud applies Snapshot B (stock = 50, shop_snapshot_seq = B)
    const snapAppRes = await callCloud<any>('gc_apply_inventory_snapshot', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
      p_snapshot: {
        snapshot_id: snapshotB.snapshot_id,
        snapshot_seq: snapshotB.snapshot_seq,
        generated_at: snapshotB.generated_at,
        fingerprint: snapshotB.fingerprint,
        medicines: snapshotB.medicines,
        batches: snapshotB.batches,
      },
    });
    check(snapAppRes.ok === true, '2.2 Snapshot B applied to Cloud');

    // 2. Cloud applies Sale event B+1
    const eventPayload = {
      event_id: saleRow.id,
      idempotency_key: saleRow.idempotency_key,
      shop_id: shopId,
      local_seq: String(saleSeq),
      event_type: saleRow.event_type,
      entity_type: saleRow.entity_type,
      entity_id: saleRow.entity_id,
      operation: saleRow.operation,
      occurred_at: new Date().toISOString(),
      payload: typeof saleRow.payload === 'string' ? JSON.parse(saleRow.payload) : saleRow.payload,
    };

    const ingestRes = await callCloud<any>('gc_ingest_events', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
      p_events: [eventPayload],
    });
    check(ingestRes.results?.[0]?.status === 'APPLIED', '2.3 Event B+1 applied on top of snapshot B');

    // Inspect Cloud mirror: final stock should be 50 - 5 = 45 exactly
    const cloudInspect = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    const cloudMed = cloudInspect.medicines?.find((m: any) => (m.medicine_id || m.id) === med1.id);
    const cloudBatch = cloudInspect.stock_levels?.find((b: any) => b.batch_id === batch1.id);

    check(Number(cloudMed?.current_stock) === 45, '2.4 Cloud final stock is 45 (50 - 5)');
    check(Number(cloudBatch?.quantity ?? cloudBatch?.quantity_available) === 45, '2.5 Cloud batch quantity is 45');

    // =========================================================================
    // SECTION 3: TEST 10 — OLD DELAYED EVENT AFTER SNAPSHOT (local_seq < baseline)
    // =========================================================================
    section('3. TEST 10 — Delayed Old Event (local_seq < baseline)');

    // Simulate an old delayed event with seq < baseline arriving at cloud
    const oldDelayedSeq = Math.max(1, baselineSeq - 10);
    const oldEventId = crypto.randomUUID();
    const oldEventKey = `delayed-old-${Date.now()}`;

    const delayedEventPayload = {
      event_id: oldEventId,
      idempotency_key: oldEventKey,
      shop_id: shopId,
      local_seq: String(oldDelayedSeq),
      event_type: 'STOCK_REMOVED',
      entity_type: 'stock_movement',
      entity_id: crypto.randomUUID(),
      operation: 'INSERT',
      occurred_at: new Date(Date.now() - 3600000).toISOString(),
      payload: {
        movements: [
          {
            movement_id: crypto.randomUUID(),
            medicine_id: med1.id,
            batch_id: batch1.id,
            movement_type: 'REMOVE',
            delta: -20,
            quantity: 20,
            previous_quantity: 50,
            new_quantity: 30,
          },
        ],
      },
    };

    const delayedIngestRes = await callCloud<any>('gc_ingest_events', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
      p_events: [delayedEventPayload],
    });

    check(Boolean(delayedIngestRes.results?.[0]), '3.1 Delayed old event ingested');

    // Check that cloud stock was NOT reversed or decremented below 45
    const cloudInspectAfterOld = await callCloud<any>('gc_inspect_shop_data', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
    });
    const cloudMedAfterOld = cloudInspectAfterOld.medicines?.find((m: any) => (m.medicine_id || m.id) === med1.id);

    check(Number(cloudMedAfterOld?.current_stock) === 45, '3.2 Old event with seq < snapshot baseline does not modify final stock (remains 45)');

    // =========================================================================
    // SECTION 4: TEST 12 — RESTART RESILIENCE & IDEMPOTENCY
    // =========================================================================
    section('4. TEST 12 — Idempotent Snapshot Re-application');

    // Re-applying the exact same snapshot id / sequence must be a no-op
    const reapplyRes = await callCloud<any>('gc_apply_inventory_snapshot', {
      p_shop_id: shopId,
      p_token: cfg.shopToken,
      p_snapshot: {
        snapshot_id: snapshotB.snapshot_id,
        snapshot_seq: snapshotB.snapshot_seq,
        generated_at: snapshotB.generated_at,
        fingerprint: snapshotB.fingerprint,
        medicines: snapshotB.medicines,
        batches: snapshotB.batches,
      },
    });

    check(reapplyRes.ok === true || reapplyRes.ignored === true, '4.1 Snapshot re-application accepted idempotently');
  } finally {
    await pool.end();
  }

  process.exit(summary());
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
