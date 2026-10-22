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
    // Helper to create a fresh test medicine with a specific stock
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
    // SECTION 1: FORCE ADD (Cloud=20, Shop=17, Add=10 -> Shop=27)
    // =========================================================================
    section('1. FORCE ADD (Cloud=20, Shop=17, Add=10 -> Shop=27)');

    const { med: med1, batch: batch1 } = await createTestMed(`ForceAdd_${Date.now()}`, 17, `B-ADD-${Date.now().toString().slice(-4)}`);
    check(Number(med1.current_stock) === 17, '1.1 Initial authoritative shop stock is 17');

    const cmd1Id = crypto.randomUUID();
    const addResult = await applyCloudCommand({
      command_id: cmd1Id,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: med1.id,
        batch_id: batch1.id,
        quantity: 10,
        reason: 'Physical count correction',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-add-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(addResult.status === 'APPLIED', '1.2 Force Add applied successfully');
    check(addResult.result?.local_before === 17, '1.3 local_before = 17 recorded');
    check(addResult.result?.local_after === 27, '1.4 local_after = 27 recorded (17 + 10)');
    check(addResult.result?.medicine_total_after === 27, '1.5 medicine_total_after = 27');

    const med1After = await getMedicineById(med1.id, pool);
    check(Number(med1After?.current_stock) === 27, '1.6 Local stock is 27 (NEVER 20 + 10 = 30)');

    const audit1 = (await pool.query(
      "SELECT new_value FROM audit_logs WHERE action = 'GLOBAL_ADMIN_STOCK_OVERRIDE' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1",
      [med1.id]
    )).rows[0]?.new_value;
    const a1 = typeof audit1 === 'string' ? JSON.parse(audit1) : audit1;
    check(a1.online_quantity_shown === 20, '1.7 Audit: online_quantity_shown = 20');
    check(a1.actual_quantity_before === 17, '1.8 Audit: actual_quantity_before = 17');
    check(a1.requested_amount === 10, '1.9 Audit: requested_amount = 10');
    check(a1.actual_quantity_after === 27, '1.10 Audit: actual_quantity_after = 27');
    check(a1.difference === 10, '1.11 Audit: difference = 10');

    // =========================================================================
    // SECTION 2: FORCE REMOVE (Cloud=20, Shop=17, Remove=5 -> Shop=12)
    // =========================================================================
    section('2. FORCE REMOVE (Cloud=20, Shop=17, Remove=5 -> Shop=12)');

    const { med: med2, batch: batch2 } = await createTestMed(`ForceRem_${Date.now()}`, 17, `B-REM-${Date.now().toString().slice(-4)}`);
    check(Number(med2.current_stock) === 17, '2.1 Initial shop stock is 17');

    const remResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: med2.id,
        batch_id: batch2.id,
        quantity: 5,
        reason: 'Damaged stock',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-rem-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(remResult.status === 'APPLIED', '2.2 Force Remove applied successfully');
    check(remResult.result?.local_before === 17, '2.3 local_before = 17');
    check(remResult.result?.local_after === 12, '2.4 local_after = 12 (17 - 5)');

    const med2After = await getMedicineById(med2.id, pool);
    check(Number(med2After?.current_stock) === 12, '2.5 Local authoritative stock is 12 (NEVER 20 - 5 = 15)');

    // =========================================================================
    // SECTION 3: FORCE SET PHYSICAL COUNT (Cloud=20, Shop=17, Set=50 -> Shop=50)
    // =========================================================================
    section('3. FORCE SET PHYSICAL COUNT (Cloud=20, Shop=17, Set=50 -> Shop=50)');

    const { med: med3, batch: batch3 } = await createTestMed(`ForceSet_${Date.now()}`, 17, `B-SET-${Date.now().toString().slice(-4)}`);
    check(Number(med3.current_stock) === 17, '3.1 Initial shop stock is 17');

    const setResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_SET',
      payload: {
        medicine_id: med3.id,
        batch_id: batch3.id,
        quantity: 50,
        reason: 'Stock entry correction',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-set-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(setResult.status === 'APPLIED', '3.2 Force Set applied successfully');
    check(setResult.result?.local_before === 17, '3.3 local_before = 17');
    check(setResult.result?.local_after === 50, '3.4 local_after = 50');

    const med3After = await getMedicineById(med3.id, pool);
    check(Number(med3After?.current_stock) === 50, '3.5 Authoritative stock set to 50 regardless of previous values');

    const audit3 = (await pool.query(
      "SELECT new_value FROM audit_logs WHERE action = 'GLOBAL_ADMIN_STOCK_OVERRIDE' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1",
      [med3.id]
    )).rows[0]?.new_value;
    const a3 = typeof audit3 === 'string' ? JSON.parse(audit3) : audit3;
    check(a3.difference === 33, '3.6 Audit: difference = +33 (50 - 17)');

    // =========================================================================
    // SECTION 4: NO REJECTION ON STALE EXPECTED QUANTITY FOR GLOBAL ADMIN
    // =========================================================================
    section('4. NO REJECTION ON STALE EXPECTED QUANTITY FOR GLOBAL ADMIN');

    const { med: med4, batch: batch4 } = await createTestMed(`NoConflict_${Date.now()}`, 15, `B-NC-${Date.now().toString().slice(-4)}`);

    // Global Admin STOCK_ADD with expected_quantity = 999 (totally mismatched)
    const gaAddResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_ADD',
      payload: {
        medicine_id: med4.id,
        batch_id: batch4.id,
        quantity: 5,
        expected_quantity: 999, // Stale/mismatched preview
        reason: 'Unrecorded delivery',
      },
      idempotency_key: `ga-add-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(gaAddResult.status === 'APPLIED', '4.1 Global Admin STOCK_ADD not rejected by mismatched expected_quantity');
    check(Number(gaAddResult.result?.new_quantity) === 20, '4.2 Calculated from local authority: 15 + 5 = 20');

    // Global Admin STOCK_SET with expected_quantity = 888
    const gaSetResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_SET',
      payload: {
        medicine_id: med4.id,
        batch_id: batch4.id,
        quantity: 40,
        expected_quantity: 888,
        reason: 'Opening balance correction',
      },
      idempotency_key: `ga-set-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(gaSetResult.status === 'APPLIED', '4.3 Global Admin STOCK_SET not rejected by mismatched expected_quantity');
    const med4After = await getMedicineById(med4.id, pool);
    check(Number(med4After?.current_stock) === 40, '4.4 Authoritative stock forced to 40');

    // =========================================================================
    // SECTION 5: NEGATIVE STOCK SAFEGUARD & SET TO ZERO
    // =========================================================================
    section('5. NEGATIVE STOCK SAFEGUARD & SET TO ZERO');

    const { med: med5, batch: batch5 } = await createTestMed(`NegSafe_${Date.now()}`, 5, `B-NEG-${Date.now().toString().slice(-4)}`);

    // Case A: Remove 8 from 5 without set_zero_if_insufficient -> rejected with safe prompt
    const negReject = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: med5.id,
        batch_id: batch5.id,
        quantity: 8,
        reason: 'Expired stock',
      },
      idempotency_key: `neg-reject-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(negReject.status === 'REJECTED', '5.1 Excessive remove is rejected');
    check(String(negReject.error).includes('Current Shop stock is 5. Removing 8 would produce negative stock'), '5.2 Error prompts user with current shop stock');

    // Case B: Global admin confirms [ SET STOCK TO ZERO ]
    const setZeroResult = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: med5.id,
        batch_id: batch5.id,
        quantity: 8,
        set_zero_if_insufficient: true,
        reason: 'Expired stock',
      },
      idempotency_key: `neg-setzero-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(setZeroResult.status === 'APPLIED', '5.3 Confirmed set_zero_if_insufficient applied');
    check(setZeroResult.result?.local_after === 0, '5.4 Stock set to zero');
    check(setZeroResult.result?.operation === 'SET_TO_ZERO', '5.5 Operation logged as SET_TO_ZERO');

    const med5After = await getMedicineById(med5.id, pool);
    check(Number(med5After?.current_stock) === 0, '5.6 Authoritative local medicine stock is now 0');

    // =========================================================================
    // SECTION 6: IMMUTABLE AUDIT REGISTER RECORD & ALL 22 REQUIRED FIELDS
    // =========================================================================
    section('6. IMMUTABLE AUDIT REGISTER RECORD (ALL 22 FIELDS)');

    const auditRow = (await pool.query(
      `SELECT new_value FROM audit_logs 
       WHERE action = 'GLOBAL_ADMIN_STOCK_OVERRIDE' AND entity_id = $1 
       ORDER BY timestamp DESC LIMIT 1`,
      [med5.id]
    )).rows[0]?.new_value;
    const aRecord = typeof auditRow === 'string' ? JSON.parse(auditRow) : auditRow;

    check(Boolean(aRecord.override_id), '6.1 Field 1: override_id');
    check(Boolean(aRecord.command_id), '6.2 Field 2: command_id');
    check(Boolean(aRecord.shop_id), '6.3 Field 3: shop_id');
    check(Boolean(aRecord.shop_name), '6.4 Field 4: shop_name');
    check(Boolean(aRecord.medicine_id), '6.5 Field 5: medicine_id');
    check(Boolean(aRecord.medicine_name), '6.6 Field 6: medicine_name');
    check('sku' in aRecord, '6.7 Field 7: sku');
    check('barcode' in aRecord, '6.8 Field 8: barcode');
    check(Boolean(aRecord.batch_id), '6.9 Field 9: batch_id');
    check(Boolean(aRecord.batch_number), '6.10 Field 10: batch_number');
    check('expiry_date' in aRecord, '6.11 Field 11: expiry_date');
    check(Boolean(aRecord.admin_name), '6.12 Field 12: admin_name');
    check(Boolean(aRecord.admin_email), '6.13 Field 13: admin_email');
    check(aRecord.action === 'SET_TO_ZERO', '6.14 Field 14: action');
    check('online_quantity_shown' in aRecord, '6.15 Field 15: online_quantity_shown');
    check(aRecord.actual_quantity_before === 5, '6.16 Field 16: actual_quantity_before = 5');
    check(aRecord.requested_amount === 8, '6.17 Field 17: requested_amount = 8');
    check(aRecord.actual_quantity_after === 0, '6.18 Field 18: actual_quantity_after = 0');
    check(aRecord.difference === -5, '6.19 Field 19: difference = -5');
    check(Boolean(aRecord.reason), '6.20 Field 20: reason');
    check(Boolean(aRecord.date_submitted), '6.21 Field 21: date_submitted');
    check(Boolean(aRecord.date_applied), '6.22 Field 22: date_applied');
    check(aRecord.result === 'APPLIED', '6.23 Result confirmed APPLIED');

  } finally {
    client.release();
    await pool.end();
    await (await import('../../server/db/client')).pgPool.end();
  }

  const code = summary();
  process.exitCode = code;
}

void run();
