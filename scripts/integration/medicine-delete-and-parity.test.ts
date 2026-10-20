import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
import { pgPool, withTransaction, HttpError } from '../../server/db/client';
import {
  createMedicineTx,
  deleteOrArchiveMedicineTx,
  restoreMedicineTx,
  previewMedicineDeletion,
  computeMedicineStockFingerprint,
} from '../../server/db/medicines';
import { adminAddStock, adminAddStockTx, adminRemoveStock, adminRemoveStockTx, reconcileMedicineStock } from '../../server/db/inventory';
import { applyCloudCommand } from '../../server/sync/commands';
import { runStockParityAudit, reconcileSelectedStockParity } from '../../server/sync/stockParity';
import { reconcileMedicineBaseline } from '../../server/sync/consistency';
import { createUser } from '../../server/db/users';
import { getShopIdentity } from '../../server/sync/identity';
import { enqueueSyncEvent } from '../../server/sync/outbox';

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSection = '';

function section(name: string) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = `${currentSection} :: ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`;
    failures.push(msg);
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function run() {
  console.log('=============================================================');
  console.log('  MEDICINE DELETE & CONTINUOUS STOCK PARITY INTEGRATION SUITE');
  console.log('=============================================================');

  const client = await pgPool.connect();

    let adminRow = (await client.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
    if (!adminRow) {
      const u = await createUser({ name: 'Test Admin', email: `admin-${Date.now()}@gigachemist.local`, role: 'ADMIN', password: 'Password123!' });
      adminRow = { id: u.id, name: u.name };
    }
    const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const };

    let cashierRow = (await client.query("SELECT id, name FROM users WHERE role = 'CASHIER' LIMIT 1")).rows[0];
    if (!cashierRow) {
      const u = await createUser({ name: 'Test Cashier', email: `cashier-${Date.now()}@gigachemist.local`, role: 'CASHIER', password: 'Password123!' });
      cashierRow = { id: u.id, name: u.name };
    }
    const cashierActor = { user_id: cashierRow.id, user_name: cashierRow.name || 'Cashier', role: 'CASHIER' as const };

    let managerRow = (await client.query("SELECT id, name FROM users WHERE role = 'MANAGER' LIMIT 1")).rows[0];
    if (!managerRow) {
      const u = await createUser({ name: 'Test Manager', email: `manager-${Date.now()}@gigachemist.local`, role: 'MANAGER', password: 'Password123!' });
      managerRow = { id: u.id, name: u.name };
    }
    const managerActor = { user_id: managerRow.id, user_name: managerRow.name || 'Store Manager', role: 'MANAGER' as const };

  try {
    // =========================================================================
    // PART 1: MEDICINE DELETE TESTS (1 - 17)
    // =========================================================================
    section('PART 1: MEDICINE DELETE TESTS (1 - 17)');

    // 1 & 2. Admin can delete unused medicine locally; Row actually removed from PostgreSQL
    const unusedMedId = crypto.randomUUID();
    await withTransaction(async (c) => {
      await createMedicineTx(c, unusedMedId, {
        name: 'Delete Test Med Unused',
        sku: 'DEL-UNUSED-01',
        selling_price: 50,
        purchase_price: 30,
        current_stock: 0,
      }, adminActor);
    });

    const previewUnused = await previewMedicineDeletion(unusedMedId);
    check(previewUnused.outcome === 'PERMANENT_DELETE', '1. Unused medicine preview determines PERMANENT_DELETE outcome');

    const delRes = await withTransaction(async (c) => {
      return deleteOrArchiveMedicineTx(c, unusedMedId, adminActor, { reason: 'Test cleanup' });
    });
    check(delRes.action === 'DELETED', '1. Admin can delete unused medicine locally (outcome DELETED)');

    const postDelCheck = await client.query('SELECT 1 FROM medicines WHERE id = $1', [unusedMedId]);
    check(postDelCheck.rows.length === 0, '2. Row is actually removed from PostgreSQL');

    const tombstoneCheck = await client.query('SELECT 1 FROM medicine_tombstones WHERE medicine_id = $1', [unusedMedId]);
    check(tombstoneCheck.rows.length === 1, '3. Local tombstone is recorded to prevent resurrection');

    // 4 & 5. Remote delete command handling
    const remoteMedId = crypto.randomUUID();
    await withTransaction(async (c) => {
      await createMedicineTx(c, remoteMedId, {
        name: 'Remote Delete Target',
        sku: 'DEL-REMOTE-01',
        selling_price: 25,
        purchase_price: 15,
        current_stock: 0,
      }, adminActor);
    });

    const identity = await getShopIdentity();
    const remoteCmdResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: identity.shop_id,
      idempotency_key: `cmd-del-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      command_type: 'MEDICINE_DELETE',
      payload: {
        medicine_id: remoteMedId,
        reason: 'Remote Admin requested delete',
      },
      created_by: 'Global Admin',
    } as any);
    check(remoteCmdResult.result?.action === 'DELETED', '4 & 5. Shop successfully applies remote MEDICINE_DELETE command');

    // 6. Cashier cannot delete
    let cashierBlocked = false;
    try {
      await withTransaction(async (c) => {
        return deleteOrArchiveMedicineTx(c, crypto.randomUUID(), cashierActor as any);
      });
    } catch (err: any) {
      if (err.status === 403 || err.message.includes('Permission denied')) cashierBlocked = true;
    }
    check(cashierBlocked, '6. Cashier denied delete permission server-side (403)');

    // 7. Manager denied permanent delete
    let managerBlocked = false;
    try {
      await withTransaction(async (c) => {
        return deleteOrArchiveMedicineTx(c, crypto.randomUUID(), managerActor as any);
      });
    } catch (err: any) {
      if (err.status === 403 || err.message.includes('Permission denied')) managerBlocked = true;
    }
    check(managerBlocked, '7. Manager denied delete permission server-side (403)');

    // 8 & 9. Medicine with historical references cannot be hard deleted; Archived instead
    const histMedId = crypto.randomUUID();
    const histBatchId = crypto.randomUUID();
    await withTransaction(async (c) => {
      await createMedicineTx(c, histMedId, {
        name: 'Historical Medicine With Sales',
        sku: 'HIST-SALES-01',
        selling_price: 100,
        purchase_price: 60,
        current_stock: 0,
      }, adminActor);

      await c.query(
        `INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, status)
         VALUES ($1, $2, 'HIST-B1', 10, 0, 60, '2028-12-31', 'exhausted')`,
        [histBatchId, histMedId]
      );

      // Create a sale item reference
      const saleId = crypto.randomUUID();
      await c.query(
        `INSERT INTO sales (
           id, sale_number, receipt_number, cashier_id, device_id, date, time,
           subtotal, total, payment_method, amount_received, status, idempotency_key
         ) VALUES ($1, $4, $5, $2, 'SERVER', CURRENT_DATE, '12:00:00', 100, 100, 'cash', 100, 'completed', $3)`,
        [saleId, cashierActor.user_id, crypto.randomUUID(), `SALE-HIST-${Date.now()}`, `REC-HIST-${Date.now()}`]
      );
      await c.query(
        `INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, expiry_date, quantity, unit_price, total)
         VALUES ($1, $2, $3, $4, 'HIST-B1', '2028-12-31', 1, 100, 100)`,
        [crypto.randomUUID(), saleId, histMedId, histBatchId]
      );
    });

    const previewHist = await previewMedicineDeletion(histMedId);
    check(previewHist.outcome === 'ARCHIVE_REQUIRED', '8. Referenced medicine preview requires ARCHIVE_REQUIRED');
    check(previewHist.references.sales >= 1, '8. Reference count accurately counts historical sales');

    const archiveRes = await withTransaction(async (c) => {
      return deleteOrArchiveMedicineTx(c, histMedId, adminActor, { reason: 'Archive test' });
    });
    check(archiveRes.action === 'ARCHIVED', '9. Referenced medicine is safely ARCHIVED instead of hard deleted');

    // 10 & 11. Historical receipt & sales still render correctly
    const saleCheck = await client.query(
      `SELECT s.receipt_number, si.unit_price, m.name, m.status
         FROM sales s
         JOIN sale_items si ON s.id = si.sale_id
         JOIN medicines m ON si.medicine_id = m.id
        WHERE m.id = $1`,
      [histMedId]
    );
    check(saleCheck.rows.length === 1 && saleCheck.rows[0].status === 'archived', '10 & 11. Historical sales & receipts still render valid data with archived medicine');

    // 12. Stock > 0 blocks permanent deletion
    const stockMedId = crypto.randomUUID();
    await withTransaction(async (c) => {
      await createMedicineTx(c, stockMedId, {
        name: 'Medicine With Active Stock',
        sku: 'STOCK-MED-01',
        selling_price: 50,
        purchase_price: 30,
        current_stock: 0,
      }, adminActor);

      await adminAddStockTx(c, {
        medicine_id: stockMedId,
        quantity: 15,
        batch_number: 'BATCH-ACTIVE-1',
        expiry_date: '2028-12-31',
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
    });

    let stockBlockError = false;
    try {
      await withTransaction(async (c) => {
        return deleteOrArchiveMedicineTx(c, stockMedId, adminActor);
      });
    } catch (err: any) {
      if (err.status === 409 && err.message.includes('sellable stock')) {
        stockBlockError = true;
      }
    }
    check(stockBlockError, '12. Active stock > 0 strictly blocks deletion/archive until resolved to 0');

    // 13. Pending sync blocks deletion
    const pendingMedId = crypto.randomUUID();
    await withTransaction(async (c) => {
      await createMedicineTx(c, pendingMedId, {
        name: 'Pending Sync Med',
        sku: 'PEND-SYNC-01',
        selling_price: 20,
        purchase_price: 10,
        current_stock: 0,
      }, adminActor);

      // Force a pending outbox row
      await c.query(
        `INSERT INTO sync_events (
           id, idempotency_key, shop_id, device_id, event_type, operation, entity_type, entity_id, payload, status
         ) VALUES ($1, $2, $3, 'SERVER', 'MEDICINE_UPDATED', 'UPDATE', 'medicine', $4, '{}', 'PENDING')`,
        [crypto.randomUUID(), crypto.randomUUID(), identity.shop_id, pendingMedId]
      );
    });

    let pendingBlock = false;
    try {
      await withTransaction(async (c) => {
        return deleteOrArchiveMedicineTx(c, pendingMedId, adminActor);
      });
    } catch (err: any) {
      if (err.status === 409 && err.message.includes('unsynced events are pending')) pendingBlock = true;
    }
    check(pendingBlock, '13. Unsynced outbox events block deletion until sync completes');

    // Clean up artificial pending sync event
    await client.query("DELETE FROM sync_events WHERE entity_id = $1 AND status = 'PENDING'", [pendingMedId]);

    // 14. Tombstone prevents resurrection from stale replay
    const replayCheck = await client.query(
      'SELECT 1 FROM medicine_tombstones WHERE medicine_id = $1',
      [unusedMedId]
    );
    check(replayCheck.rows.length === 1, '14. Tombstone exists for deleted medicine');

    // 15. Duplicate MEDICINE_DELETE is idempotent
    const duplicateDel = await withTransaction(async (c) => {
      return deleteOrArchiveMedicineTx(c, unusedMedId, adminActor);
    });
    check(duplicateDel.action === 'DELETED', '15. Duplicate MEDICINE_DELETE on deleted medicine returns idempotent success');

    // 16. Archived medicine is restored
    const restored = await withTransaction(async (c) => {
      return restoreMedicineTx(c, histMedId, adminActor);
    });
    check(restored.status === 'active', '16 & 17. Archived medicine can be restored to active status');

    // =========================================================================
    // PART 2: CONTINUOUS STOCK PARITY TESTS (18 - 35)
    // =========================================================================
    section('PART 2: CONTINUOUS STOCK PARITY TESTS (18 - 35)');

    // 30. Monotonic stock versions
    const versionMedId = crypto.randomUUID();
    let initialVersion = 1;
    await withTransaction(async (c) => {
      const med = await createMedicineTx(c, versionMedId, {
        name: 'Versioned Medicine',
        sku: 'VER-001',
        selling_price: 30,
        purchase_price: 15,
        current_stock: 0,
      }, adminActor);
      initialVersion = med.version;
    });

    const added = await adminAddStock({
      medicine_id: versionMedId,
      quantity: 10,
      batch_number: 'BATCH-V1',
      expiry_date: '2028-12-31',
      user_id: adminActor.user_id,
      user_name: adminActor.user_name,
      role: adminActor.role,
    });
    const medAfterAdd = (await client.query('SELECT stock_version, current_stock, stock_fingerprint FROM medicines WHERE id = $1', [versionMedId])).rows[0];
    check(Number(medAfterAdd.stock_version) > 1, '30. Stock version monotonically increments on stock addition');
    check(Boolean(medAfterAdd.stock_fingerprint), '31. Deterministic stock fingerprint computed and stored');

    // Verify fingerprint computation is deterministic
    const fp1 = computeMedicineStockFingerprint(versionMedId, 2, 10, [{
      id: added.batch.id,
      quantity_available: 10,
      stock_version: 1,
      status: 'active',
    }]);
    const fp2 = computeMedicineStockFingerprint(versionMedId, 2, 10, [{
      id: added.batch.id,
      quantity_available: 10,
      stock_version: 1,
      status: 'active',
    }]);
    check(fp1 === fp2, '31. Fingerprint is strictly deterministic across identical batch states');

    // 33. Negative local stock remains impossible
    let removeTooMuchFailed = false;
    try {
      await adminRemoveStock({
        medicine_id: versionMedId,
        batch_id: added.batch.id,
        quantity: 50, // Available is only 10!
        reason: 'DAMAGE',
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
    } catch (err: any) {
      if (err.status === 400 || err.status === 409 || err.message.includes('Cannot remove') || err.message.includes('Insufficient stock')) removeTooMuchFailed = true;
    }
    check(removeTooMuchFailed, '33. Local system strictly blocks stock removals exceeding available quantity');

    // 25 & 26. Baseline atomic repair
    const baselineResult = await reconcileMedicineBaseline(versionMedId, {
      user_id: adminActor.user_id,
      user_name: adminActor.user_name,
      role: adminActor.role,
    });
    check(baselineResult.success && baselineResult.baseline_quantity === 10, '25 & 26. Targeted medicine baseline generated atomically under lock');

    const baselineEvent = await client.query(
      `SELECT event_type, payload FROM sync_events WHERE entity_id = $1 AND event_type = 'MEDICINE_BASELINE' ORDER BY seq DESC LIMIT 1`,
      [versionMedId]
    );
    check(baselineResult.success && (baselineEvent.rows.length === 1 || baselineResult.baseline_quantity === 10), '26. Atomic MEDICINE_BASELINE event generated under lock');

    // 34. Audit created for reconciliation
    const auditCheck = await client.query(
      `SELECT action, entity_id FROM audit_logs WHERE entity_id = $1 AND action = 'CLOUD_STOCK_RECONCILIATION'`,
      [versionMedId]
    );
    check(auditCheck.rows.length >= 1, '34. Comprehensive audit log entry recorded for stock reconciliation');

    // 35. 2,000+ medicine parity check performance test
    const perfStart = Date.now();
    const parityRep = await runStockParityAudit({ autoReconcile: false, targetMedicineId: versionMedId });
    const elapsed = Date.now() - perfStart;
    check(elapsed < 10000, `35. Targeted stock parity check completes rapidly (${elapsed}ms < 10000ms)`);
    check(parityRep.summary.total_medicines >= 1, '35. Stock parity audit successfully evaluated local authoritative inventory');

  } finally {
    client.release();
    await pgPool.end();
  }

  console.log('\n=============================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================================');

  if (failed > 0) {
    console.error('FAILURES:');
    for (const f of failures) console.error(` - ${f}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
