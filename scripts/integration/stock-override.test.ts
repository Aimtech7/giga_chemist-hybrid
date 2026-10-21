process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx } from '../../server/db/inventory';
import { applyCloudCommand } from '../../server/sync/commands';
import { getShopIdentity } from '../../server/sync/identity';

async function run() {
  await assertDevDatabase();

  const client = await pool.connect();
  const identity = await getShopIdentity();
  const shopId = identity.shop_id;

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  try {
    // Helper to create a fresh test medicine
    async function createTestMed(name: string, initialStock: number, batchNumber: string) {
      const medId = crypto.randomUUID();
      const med = await withTransaction(async (c) => {
        await createMedicineTx(c, medId, {
          name,
          selling_price: 100,
          purchase_price: 60,
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
    // TEST C — ONLINE ADD OVERRIDE
    // =========================================================================
    section('TEST C — ONLINE ADD OVERRIDE (Cloud=10, Shop=9, Add=5 -> Shop=14)');

    const { med: medC, batch: batchC } = await createTestMed(`OverrideAdd ${Date.now()}`, 9, `B-ADD-${Date.now().toString().slice(-4)}`);
    check(Number(medC.current_stock) === 9, 'C.1 Initial shop stock is 9');

    const addCmdId = crypto.randomUUID();
    const addResult = await applyCloudCommand({
      command_id: addCmdId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: medC.id,
        batch_id: batchC.id,
        quantity: 5,
        reason: 'Physical recount by Global Administrator',
        cloud_quantity_seen: 10,
      },
      idempotency_key: `override-add-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(addResult.status === 'APPLIED', 'C.2 Override Add applied successfully');
    check(addResult.result?.local_before === 9, 'C.3 Result recorded local_before = 9');
    check(addResult.result?.local_after === 14, 'C.4 Result recorded local_after = 14');
    check(addResult.result?.medicine_total_after === 14, 'C.5 Medicine total after is 14');

    const medCAfter = await getMedicineById(medC.id, pool);
    check(Number(medCAfter?.current_stock) === 14, 'C.6 Authoritative local medicine stock updated to 14 (9 + 5)');

    // =========================================================================
    // TEST D — ONLINE REMOVE OVERRIDE
    // =========================================================================
    section('TEST D — ONLINE REMOVE OVERRIDE (Cloud=10, Shop=9, Remove=3 -> Shop=6)');

    const { med: medD, batch: batchD } = await createTestMed(`OverrideRemove ${Date.now()}`, 9, `B-REM-${Date.now().toString().slice(-4)}`);
    check(Number(medD.current_stock) === 9, 'D.1 Initial shop stock is 9');

    const removeCmdId = crypto.randomUUID();
    const remResult = await applyCloudCommand({
      command_id: removeCmdId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: medD.id,
        batch_id: batchD.id,
        quantity: 3,
        reason: 'Damaged bottles removed by Administrator',
        cloud_quantity_seen: 10,
      },
      idempotency_key: `override-rem-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(remResult.status === 'APPLIED', 'D.2 Override Remove applied successfully');
    check(remResult.result?.local_before === 9, 'D.3 Result recorded local_before = 9');
    check(remResult.result?.local_after === 6, 'D.4 Result recorded local_after = 6');

    const medDAfter = await getMedicineById(medD.id, pool);
    check(Number(medDAfter?.current_stock) === 6, 'D.5 Authoritative local medicine stock updated to 6 (9 - 3)');

    // =========================================================================
    // TEST E — ONLINE SET OVERRIDE
    // =========================================================================
    section('TEST E — ONLINE SET OVERRIDE (Cloud=10, Shop=9, Set=12 -> Shop=12)');

    const { med: medE, batch: batchE } = await createTestMed(`OverrideSet ${Date.now()}`, 9, `B-SET-${Date.now().toString().slice(-4)}`);

    const setCmdId = crypto.randomUUID();
    const setResult = await applyCloudCommand({
      command_id: setCmdId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_SET',
      payload: {
        medicine_id: medE.id,
        batch_id: batchE.id,
        quantity: 12,
        reason: 'Physical count verified by Global Admin',
        cloud_quantity_seen: 10,
      },
      idempotency_key: `override-set-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(setResult.status === 'APPLIED', 'E.1 Override Set applied successfully');
    check(setResult.result?.local_before === 9, 'E.2 Result recorded local_before = 9');
    check(setResult.result?.local_after === 12, 'E.3 Result recorded local_after = 12');
    check(setResult.result?.medicine_total_after === 12, 'E.4 Result recorded medicine_total_after = 12');

    const medEAfter = await getMedicineById(medE.id, pool);
    check(Number(medEAfter?.current_stock) === 12, 'E.5 Authoritative local stock set to 12');

    // Check audit log for GLOBAL_ADMIN_STOCK_OVERRIDE
    const auditRow = (await pool.query(
      "SELECT action, new_value FROM audit_logs WHERE action = 'GLOBAL_ADMIN_STOCK_OVERRIDE' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1",
      [medE.id]
    )).rows[0];

    check(Boolean(auditRow), 'E.6 Audit log contains GLOBAL_ADMIN_STOCK_OVERRIDE');
    const val = typeof auditRow.new_value === 'string' ? JSON.parse(auditRow.new_value) : auditRow.new_value;
    check(val.cloud_quantity_seen === 10, 'E.7 Audit records cloud_quantity_seen = 10');
    check(val.local_quantity_before === 9, 'E.8 Audit records local_quantity_before = 9');
    check(val.local_quantity_after === 12, 'E.9 Audit records local_quantity_after = 12');

    // =========================================================================
    // TEST F — NEGATIVE STOCK BLOCK
    // =========================================================================
    section('TEST F — NEGATIVE STOCK BLOCK (Shop=2, Remove=5 -> REJECTED)');

    const { med: medF, batch: batchF } = await createTestMed(`OverrideNeg ${Date.now()}`, 2, `B-NEG-${Date.now().toString().slice(-4)}`);

    const negResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: medF.id,
        batch_id: batchF.id,
        quantity: 5,
        reason: 'Attempt invalid removal',
      },
      idempotency_key: `override-neg-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(negResult.status === 'REJECTED', 'F.1 Excessive remove command REJECTED');
    check(String(negResult.error).includes('INSUFFICIENT_LOCAL_STOCK'), 'F.2 Rejection error cites INSUFFICIENT_LOCAL_STOCK');

    const medFAfter = await getMedicineById(medF.id, pool);
    check(Number(medFAfter?.current_stock) === 2, 'F.3 Local stock remains unchanged at 2');

    // =========================================================================
    // TEST G & H — ORDINARY CONFLICT vs EXPLICIT OVERRIDE
    // =========================================================================
    section('TEST G & H — ORDINARY CONFLICT REJECTION vs EXPLICIT OVERRIDE');

    const { med: medGH, batch: batchGH } = await createTestMed(`ConflictMed ${Date.now()}`, 9, `B-GH-${Date.now().toString().slice(-4)}`);

    // Normal STOCK_SET with expected_quantity = 10 (when shop is actually 9)
    const normResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_SET',
      payload: {
        medicine_id: medGH.id,
        batch_id: batchGH.id,
        quantity: 11,
        expected_quantity: 10,
        reason: 'Normal count check',
      },
      idempotency_key: `norm-conflict-${Date.now()}`,
      created_by: 'Shop Manager <manager@gigachemist.com>',
    });

    check(normResult.status === 'REJECTED', 'G.1 Normal STOCK_SET with stale expected quantity is REJECTED');
    check(String(normResult.error).toLowerCase().includes('quantity') || String(normResult.error).toLowerCase().includes('conflict'), 'G.2 Reason explains quantity difference');

    const medGHAfterReject = await getMedicineById(medGH.id, pool);
    check(Number(medGHAfterReject?.current_stock) === 9, 'G.3 Stock was NOT overwritten (remains 9)');

    // TEST H: Explicit override with reason
    const overrideResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_SET',
      payload: {
        medicine_id: medGH.id,
        batch_id: batchGH.id,
        quantity: 11,
        reason: 'Administrator override acknowledging physical variance',
        cloud_quantity_seen: 10,
      },
      idempotency_key: `override-after-conflict-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(overrideResult.status === 'APPLIED', 'H.1 Explicit stock override applied successfully');
    const medGHAfterOverride = await getMedicineById(medGH.id, pool);
    check(Number(medGHAfterOverride?.current_stock) === 11, 'H.2 Authoritative stock now 11');

    // =========================================================================
    // TEST I — DUPLICATE OVERRIDE DELIVERY
    // =========================================================================
    section('TEST I — DUPLICATE OVERRIDE DELIVERY IDEMPOTENCY');

    const dupKey = `dup-override-${Date.now()}`;
    const dupCmdId = crypto.randomUUID();
    const r1 = await applyCloudCommand({
      command_id: dupCmdId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: { medicine_id: medGH.id, batch_id: batchGH.id, quantity: 2, reason: 'Duplicate test' },
      idempotency_key: dupKey,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });
    check(r1.status === 'APPLIED' && !r1.duplicate, 'I.1 First override delivery applied');

    const r2 = await applyCloudCommand({
      command_id: dupCmdId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: { medicine_id: medGH.id, batch_id: batchGH.id, quantity: 2, reason: 'Duplicate test' },
      idempotency_key: dupKey,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });
    check(r2.duplicate, 'I.2 Second delivery recognized as duplicate');

    const medAfterDup = await getMedicineById(medGH.id, pool);
    check(Number(medAfterDup?.current_stock) === 13, 'I.3 Stock incremented exactly once (11 + 2 = 13)');

    // =========================================================================
    // TEST J — EXPIRED OVERRIDE COMMAND REJECTION
    // =========================================================================
    section('TEST J — EXPIRED OVERRIDE COMMAND REJECTION');

    // Command created 15 minutes ago
    const expiredTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const expResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      created_at: expiredTimestamp,
      payload: {
        medicine_id: medGH.id,
        batch_id: batchGH.id,
        quantity: 5,
        created_at: expiredTimestamp,
        expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        reason: 'Expired command attempt',
      },
      idempotency_key: `expired-override-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(expResult.status === 'REJECTED', 'J.1 Expired stock override command is REJECTED');
    check(String(expResult.error).includes('STOCK_OVERRIDE_EXPIRED'), 'J.2 Rejection cites STOCK_OVERRIDE_EXPIRED');

    const medAfterExp = await getMedicineById(medGH.id, pool);
    check(Number(medAfterExp?.current_stock) === 13, 'J.3 Stock remains completely unchanged');

    // =========================================================================
    // TEST K — MULTIPLE ACTIVE BATCHES ALLOCATION REQUIREMENT
    // =========================================================================
    section('TEST K — MULTIPLE ACTIVE BATCHES ALLOCATION');

    const medKId = crypto.randomUUID();
    const medK = await withTransaction(async (c) => {
      await createMedicineTx(c, medKId, {
        name: `MultiBatchMed ${Date.now()}`,
        selling_price: 100,
        purchase_price: 60,
        current_stock: 0,
      }, adminActor);
      await adminAddStockTx(c, {
        medicine_id: medKId,
        quantity: 5,
        batch_number: 'BATCH-A',
        expiry_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
      await adminAddStockTx(c, {
        medicine_id: medKId,
        quantity: 4,
        batch_number: 'BATCH-B',
        expiry_date: new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10),
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
      return (await getMedicineById(medKId, c))!;
    });

    // Attempt ambiguous medicine-level Set=20 without batch allocation
    const ambigResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_SET',
      payload: {
        medicine_id: medK.id,
        quantity: 20,
        reason: 'Ambiguous set without batch allocation',
      },
      idempotency_key: `ambig-set-${Date.now()}`,
      created_by: 'Global Admin <admin@gigachemist.com>',
    });

    check(ambigResult.status === 'REJECTED', 'K.1 Ambiguous medicine-level set without batch allocation is REJECTED');
    check(String(ambigResult.error).includes('multiple active batches') || String(ambigResult.error).includes('Reconciliation Wizard'), 'K.2 Rejection instructs use of Reconciliation Wizard');

    const medKAfterAmbig = await getMedicineById(medK.id, pool);
    check(Number(medKAfterAmbig?.current_stock) === 9, 'K.3 Stock remains safe at 9');

  } finally {
    client.release();
  }

  const code = summary();
  process.exit(code);
}

void run();
