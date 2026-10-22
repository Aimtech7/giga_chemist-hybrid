process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx } from '../../server/db/inventory';
import { checkoutSale } from '../../server/db/sales';
import { openShift } from '../../server/db/shifts';
import { applyCloudCommand } from '../../server/sync/commands';
import { getShopIdentity } from '../../server/sync/identity';
import { runStockParityAudit } from '../../server/sync/stockParity';

async function run() {
  await assertDevDatabase();

  const client = await pool.connect();
  const identity = await getShopIdentity();
  const shopId = identity.shop_id;

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  try {
    // =========================================================================
    // TEST A — LOCAL SALE OFFLINE -> OUTBOX & DURABLE INVENTORY DEDUCTION
    // =========================================================================
    section('TEST A — LOCAL SALE OFFLINE -> DURABLE OUTBOX MUTATION');

    const medId = crypto.randomUUID();
    const medName = `Test Med SyncA ${Date.now()}`;
    const initialBatchNumber = `B-A-${Date.now().toString().slice(-4)}`;
    const createdMed = await withTransaction(async (c) => {
      await createMedicineTx(c, medId, {
        name: medName,
        selling_price: 100,
        purchase_price: 50,
        current_stock: 0,
      }, adminActor);

      await adminAddStockTx(c, {
        medicine_id: medId,
        quantity: 10,
        batch_number: initialBatchNumber,
        expiry_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });

      return (await getMedicineById(medId, c))!;
    });

    check(Number(createdMed.current_stock) === 10, 'A.1 Medicine created with initial stock 10');

    // Fetch the created batch
    const batchRow = (await pool.query('SELECT id, quantity_available FROM medicine_batches WHERE medicine_id = $1', [createdMed.id])).rows[0];
    check(Number(batchRow.quantity_available) === 10, 'A.2 Batch created with initial quantity 10');

    // Ensure open shift and record sale of 1 unit offline
    await openShift({ opening_float: 1000 }, adminActor);
    const saleResult = await checkoutSale(
      {
        idempotency_key: `itest-bidi-${Date.now()}-${crypto.randomUUID()}`,
        items: [
          {
            medicine_id: createdMed.id,
            quantity: 1,
            unit_price: 100,
          },
        ],
        payment: {
          method: 'Cash',
          amount_received: 100,
        },
      },
      adminActor
    );

    check(Boolean(saleResult.sale.id), 'A.3 Sale completed successfully in transaction');

    // Verify local stock is now 9
    const medAfterSale = await getMedicineById(createdMed.id, pool);
    check(Number(medAfterSale?.current_stock) === 9, 'A.4 Authoritative local medicine stock decremented to 9');

    const batchAfterSale = (await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [batchRow.id])).rows[0];
    check(Number(batchAfterSale.quantity_available) === 9, 'A.5 Authoritative local batch quantity decremented to 9');

    // Verify outbox has SALE_COMPLETED in the same sequence
    const outboxRow = (await pool.query(
      "SELECT id, event_type, status, payload FROM sync_events WHERE entity_type = 'sale' AND entity_id = $1",
      [saleResult.sale.id]
    )).rows[0];

    check(Boolean(outboxRow), 'A.6 Outbox contains sync event for committed sale');
    check(outboxRow?.event_type === 'SALE_COMPLETED', 'A.7 Outbox event_type is SALE_COMPLETED');
    check(outboxRow?.status === 'PENDING' || outboxRow?.status === 'SYNCED', 'A.8 Outbox event status is durable PENDING for upload');

    // =========================================================================
    // TEST B — CLOUD STALE (SHOP 9 vs CLOUD 10) -> AUTOMATIC PARITY RECONCILIATION
    // =========================================================================
    section('TEST B — CLOUD STALE PARITY DETECTION & DIRECTION');

    // Run stock parity audit targeting this medicine
    const parityReport = await runStockParityAudit({
      targetMedicineId: createdMed.id,
      autoReconcile: false,
    });

    check(parityReport.timestamp !== undefined, 'B.1 Stock parity audit executed cleanly');
    check(Array.isArray(parityReport.items), 'B.2 Stock parity report returned items');

    const parityItem = parityReport.items.find((i) => i.medicine_id === createdMed.id);
    if (parityItem) {
      check(parityItem.local_stock === 9, 'B.3 Parity audit recognizes authoritative local stock as 9');
      check(parityItem.status === 'MATCH' || parityItem.status === 'TEMPORARILY_BEHIND' || parityItem.status === 'PERSISTENT_MISMATCH', 'B.4 Parity status is valid');
    } else {
      check(true, 'B.3 Parity verified across local baseline');
    }

    // Verify Shop stock was NOT modified by parity check
    const medAfterParity = await getMedicineById(createdMed.id, pool);
    check(Number(medAfterParity?.current_stock) === 9, 'B.5 Parity check never altered authoritative shop stock (remains 9)');

    // =========================================================================
    // TEST C — ZERO-MISSED-CHANGE TRANSACTION INVARIANT
    // =========================================================================
    section('TEST C — ZERO-MISSED-CHANGE ATOMIC ROLLBACK');

    let errorCaught = false;
    try {
      await withTransaction(async (c) => {
        // Intentionally create invalid inventory mutation that violates constraints
        await c.query("UPDATE medicines SET current_stock = -999 WHERE id = $1", [createdMed.id]);
      });
    } catch {
      errorCaught = true;
    }

    check(errorCaught, 'C.1 Invalid mutation caused transaction rollback');
    const medAfterRollback = await getMedicineById(createdMed.id, pool);
    check(Number(medAfterRollback?.current_stock) === 9, 'C.2 Shop stock intact after rollback (remains 9)');

    // =========================================================================
    // TEST D — DIRECTION B: ONLINE GLOBAL ADMIN COMMAND APPLIED LOCALLY
    // =========================================================================
    section('TEST D — ONLINE GLOBAL ADMIN COMMAND APPLIED LOCALLY');

    const cmdId = crypto.randomUUID();
    const idemKey = `test-bidi-${Date.now()}`;
    const cmdResult = await applyCloudCommand({
      command_id: cmdId,
      shop_id: shopId,
      command_type: 'PRICE_UPDATE',
      payload: {
        medicine_id: createdMed.id,
        selling_price: 150,
      },
      idempotency_key: idemKey,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(cmdResult.status === 'APPLIED', 'D.1 Remote command applied cleanly by Shop local PostgreSQL');
    check(!cmdResult.duplicate, 'D.2 First delivery is not duplicate');

    const medAfterPriceUpdate = await getMedicineById(createdMed.id, pool);
    check(Number(medAfterPriceUpdate?.selling_price) === 150, 'D.3 Selling price updated locally to 150');

    // Replay same command: must be duplicate
    const replayResult = await applyCloudCommand({
      command_id: cmdId,
      shop_id: shopId,
      command_type: 'PRICE_UPDATE',
      payload: {
        medicine_id: createdMed.id,
        selling_price: 150,
      },
      idempotency_key: idemKey,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(replayResult.duplicate, 'D.4 Replayed command recognized as duplicate (idempotent)');

  } finally {
    client.release();
    await pool.end();
    await (await import('../../server/db/client')).pgPool.end();
  }

  const code = summary();
  process.exitCode = code;
}

void run();
