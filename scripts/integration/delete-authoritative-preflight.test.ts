process.env.APP_MODE = 'hybrid';
import { pgPool, withTransaction } from '../../server/db/client';
import {
  createMedicineTx,
  generateAuthoritativeDeletePreflight,
  deleteOrArchiveMedicineTx,
} from '../../server/db/medicines';
import { applyCloudCommand } from '../../server/sync/commands';
import { classifyConflict } from '../../server/sync/conflicts';

async function run() {
  console.log('--- TEST SUITE: Authoritative Delete Preflight & Optimistic Concurrency ---');

  let adminActor = {
    user_id: '11111111-1111-4111-8111-111111111111',
    user_name: 'Super Admin',
    role: 'ADMIN' as const,
  };

  const existingAdmin = (await pgPool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (existingAdmin) {
    adminActor.user_id = existingAdmin.id;
    adminActor.user_name = existingAdmin.name;
  }

  // 1. Cloud preview version 1 / Shop version 2
  console.log('1. Testing Cloud preview v1 vs Shop Authority v2...');
  const uid = Math.floor(Math.random() * 1000000);
  const medId = crypto.randomUUID();

  // Create medicine in Shop (starts at version 1)
  await withTransaction(async (client) => {
    await createMedicineTx(client, medId, {
      name: `Preflight Authority Test Med ${uid}`,
      sku: `SKU-PF-${uid}`,
      barcode: `BAR-PF-${uid}`,
      selling_price: 100,
      purchase_price: 60,
      current_stock: 0,
    }, adminActor);

    // Bump version locally in Shop to version 2 (simulating a local edit not yet reflected in cloud)
    await client.query('UPDATE medicines SET version = 2, name = $2 WHERE id = $1', [medId, `Preflight Authority Test Med ${uid} (Updated Locally)`]);
  });

  // Verify Shop is at version 2
  const localShopCheck = (await pgPool.query('SELECT version FROM medicines WHERE id = $1', [medId])).rows[0];
  if (localShopCheck.version !== 2) {
    throw new Error(`Expected shop version 2, got ${localShopCheck.version}`);
  }

  // Request authoritative preflight from Shop
  const preflight = await generateAuthoritativeDeletePreflight(pgPool, medId);
  if (preflight.current_version !== 2) {
    throw new Error(`Preflight should return authoritative version 2, got ${preflight.current_version}`);
  }
  if (preflight.outcome !== 'PERMANENT_DELETE') {
    throw new Error(`Expected PERMANENT_DELETE for medicine with zero history, got ${preflight.outcome}`);
  }
  console.log('  ✓ Authoritative preflight correctly returned Shop version 2 (not stale cloud v1)');

  // 2. Reject stale delete if expected_version is 1
  console.log('2. Testing stale delete rejection when client sends expected_version 1...');
  let staleRejected = false;
  try {
    await withTransaction(async (client) => {
      await deleteOrArchiveMedicineTx(client, medId, adminActor, {
        preflight_id: preflight.preflight_id,
        expected_version: 1, // Stale!
        expected_current_stock: 0,
      });
    });
  } catch (err: any) {
    staleRejected = true;
    if (!err.message.includes('DELETE_PREFLIGHT_STALE') && !err.message.includes('version conflict')) {
      throw new Error(`Expected DELETE_PREFLIGHT_STALE or version conflict, got: ${err.message}`);
    }
    const conflictType = classifyConflict('MEDICINE_DELETE', err.message);
    if (conflictType !== 'DELETE_PREFLIGHT_STALE') {
      throw new Error(`classifyConflict should classify error as DELETE_PREFLIGHT_STALE, got: ${conflictType}`);
    }
  }
  if (!staleRejected) throw new Error('Expected delete with stale version 1 to be rejected!');
  console.log('  ✓ Stale expected_version 1 rejected with DELETE_PREFLIGHT_STALE');

  // 3. Medicine changes after preflight was issued
  console.log('3. Testing rejection when medicine changes after preflight generation...');
  // Bump version to 3
  await pgPool.query('UPDATE medicines SET version = 3 WHERE id = $1', [medId]);
  let postPreflightChangeRejected = false;
  try {
    await withTransaction(async (client) => {
      await deleteOrArchiveMedicineTx(client, medId, adminActor, {
        preflight_id: preflight.preflight_id,
        expected_version: 2, // Was valid when preflight generated, but changed meanwhile!
        expected_current_stock: 0,
      });
    });
  } catch (err: any) {
    postPreflightChangeRejected = true;
    if (!err.message.includes('DELETE_PREFLIGHT_STALE')) {
      throw new Error(`Expected DELETE_PREFLIGHT_STALE, got: ${err.message}`);
    }
  }
  if (!postPreflightChangeRejected) throw new Error('Expected post-preflight change to reject delete!');
  console.log('  ✓ Post-preflight modification correctly rejected with DELETE_PREFLIGHT_STALE');

  // 4. Fresh preflight followed by permanent deletion
  console.log('4. Testing fresh authoritative preflight followed by permanent deletion...');
  const freshPreflight = await generateAuthoritativeDeletePreflight(pgPool, medId);
  if (freshPreflight.current_version !== 3) {
    throw new Error(`Expected version 3, got ${freshPreflight.current_version}`);
  }

  const deleteResult = await withTransaction(async (client) => {
    return deleteOrArchiveMedicineTx(client, medId, adminActor, {
      preflight_id: freshPreflight.preflight_id,
      expected_version: freshPreflight.current_version,
      expected_status: freshPreflight.current_status,
      expected_current_stock: freshPreflight.current_stock,
      reason: 'Automated test permanent delete',
    });
  });

  if (deleteResult.action !== 'DELETED') {
    throw new Error(`Expected DELETED, got ${deleteResult.action}`);
  }

  // Verify medicine row is deleted
  const medCheck = (await pgPool.query('SELECT 1 FROM medicines WHERE id = $1', [medId])).rows[0];
  if (medCheck) throw new Error('Medicine should have been removed from medicines table!');

  // Verify tombstone created
  const tombCheck = (await pgPool.query('SELECT 1 FROM medicine_tombstones WHERE medicine_id = $1', [medId])).rows[0];
  if (!tombCheck) throw new Error('Tombstone should have been created in medicine_tombstones!');

  // Verify outbox sync event enqueued
  const outboxCheck = (await pgPool.query("SELECT 1 FROM sync_events WHERE entity_id = $1 AND event_type = 'MEDICINE_DELETED'", [medId])).rows[0];
  if (!outboxCheck) throw new Error('Outbox event MEDICINE_DELETED should have been enqueued!');
  console.log('  ✓ Permanent delete verified: row removed, tombstone created, outbox event queued');

  // 5. Archive-required medicine when historical sales exist
  console.log('5. Testing archive-required medicine when historical sales exist...');
  const archiveMedId = crypto.randomUUID();
  const histUid = Math.floor(Math.random() * 1000000);
  await withTransaction(async (client) => {
    await createMedicineTx(client, archiveMedId, {
      name: `Historical Archive Med ${histUid}`,
      sku: `SKU-HIST-${histUid}`,
      barcode: `BAR-HIST-${histUid}`,
      selling_price: 200,
      purchase_price: 120,
      current_stock: 0,
    }, adminActor);

    // Insert historical sale item reference
    const dummySaleId = crypto.randomUUID();
    await client.query(
      `INSERT INTO sales (id, sale_number, receipt_number, cashier_id, subtotal, total, amount_received, change_given, payment_method, status, device_id, date, time, idempotency_key)
       VALUES ($1, $2, $3, $4, 200, 200, 200, 0, 'Cash', 'completed', 'SERVER', '2026-10-22', '12:00:00', $5) ON CONFLICT DO NOTHING`,
      [dummySaleId, `SALE-PF-${histUid}`, `REC-PF-${histUid}`, adminActor.user_id, crypto.randomUUID()]
    );
    const batchRes = await client.query(
      `INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, status)
       VALUES (gen_random_uuid(), $1, $2, 10, 0, 120, '2028-12-31', 'exhausted') RETURNING id`,
      [archiveMedId, `BAT-HIST-${histUid}`]
    );
    const batchId = batchRes.rows[0].id;

    await client.query(
      `INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, quantity, unit_price, total)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, 200, 200)`,
      [dummySaleId, archiveMedId, batchId, `BAT-HIST-${histUid}`]
    );
  });

  const archivePreflight = await generateAuthoritativeDeletePreflight(pgPool, archiveMedId);
  if (archivePreflight.outcome !== 'ARCHIVE_REQUIRED') {
    throw new Error(`Expected ARCHIVE_REQUIRED due to historical sales, got ${archivePreflight.outcome}`);
  }
  if (archivePreflight.references.sale_items < 1) {
    throw new Error('Historical sale item reference count should be >= 1');
  }

  const archiveResult = await withTransaction(async (client) => {
    return deleteOrArchiveMedicineTx(client, archiveMedId, adminActor, {
      preflight_id: archivePreflight.preflight_id,
      expected_version: archivePreflight.current_version,
      expected_status: archivePreflight.current_status,
      expected_current_stock: archivePreflight.current_stock,
      reason: 'Automated test archive',
    });
  });

  if (archiveResult.action !== 'ARCHIVED') {
    throw new Error(`Expected ARCHIVED, got ${archiveResult.action}`);
  }

  const archivedMedRow = (await pgPool.query('SELECT status FROM medicines WHERE id = $1', [archiveMedId])).rows[0];
  if (archivedMedRow.status !== 'archived') {
    throw new Error(`Expected medicine status to be archived, got ${archivedMedRow.status}`);
  }
  console.log('  ✓ Archive-required verified: historical record preserved, status set to archived');

  // 6. Blocked when medicine has stock
  console.log('6. Testing BLOCKED outcome when medicine still has stock...');
  const stockMedId = crypto.randomUUID();
  const stockUid = Math.floor(Math.random() * 1000000);
  await withTransaction(async (client) => {
    await createMedicineTx(client, stockMedId, {
      name: `Stocked Medicine ${stockUid}`,
      sku: `SKU-STK-${stockUid}`,
      barcode: `BAR-STK-${stockUid}`,
      selling_price: 50,
      purchase_price: 30,
    }, adminActor);
    await client.query('UPDATE medicines SET current_stock = 15 WHERE id = $1', [stockMedId]);
  });

  const stockPreflight = await generateAuthoritativeDeletePreflight(pgPool, stockMedId);
  if (stockPreflight.outcome !== 'BLOCKED') {
    throw new Error(`Expected BLOCKED outcome when current_stock > 0, got ${stockPreflight.outcome}`);
  }
  if (!stockPreflight.block_reason || !stockPreflight.block_reason.includes('still has sellable stock')) {
    throw new Error(`Expected descriptive block_reason, got: ${stockPreflight.block_reason}`);
  }
  console.log('  ✓ Deletion correctly BLOCKED when medicine has stock');

  console.log('--- ALL AUTHORITATIVE PREFLIGHT TESTS PASSED ---');
  await pgPool.end();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('Test failed with error:', err);
  await pgPool.end().catch(() => {});
  process.exit(1);
});
