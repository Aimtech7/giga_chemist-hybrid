process.env.APP_MODE = 'hybrid';
import crypto from 'crypto';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction } from '../../server/db/client';
import { createMedicineTx, getMedicineById } from '../../server/db/medicines';
import { adminAddStockTx, adminRemoveStockTx } from '../../server/db/inventory';
import { applyCloudCommand } from '../../server/sync/commands';
import { getShopIdentity } from '../../server/sync/identity';

async function run() {
  await assertDevDatabase();

  const identity = await getShopIdentity();
  const shopId = identity.shop_id;

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const, device_id: 'TEST-DEV' };

  try {
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
    // SECTION 1: TEST 5 — FORCE ADD (Cloud displayed = 20, Shop actual = 17, Add 10 -> 27)
    // =========================================================================
    section('1. TEST 5 — FORCE ADD (Cloud=20, Shop=17, Add=10 -> Shop=27)');

    const { med: med1, batch: batch1 } = await createTestMed(`ForceAdd_${Date.now()}`, 17, `B-ADD-${Date.now().toString().slice(-4)}`);
    check(Number(med1.current_stock) === 17, '1.1 Initial shop stock is 17');

    const cmd1Id = crypto.randomUUID();
    const addResult = await applyCloudCommand({
      command_id: cmd1Id,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: med1.id,
        batch_id: batch1.id,
        quantity: 10,
        reason: 'Global Admin physical count addition',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-add-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(addResult.status === 'APPLIED', '1.2 Force Add applied successfully without conflict');
    check(addResult.result?.local_before === 17, '1.3 local_before = 17');
    check(addResult.result?.local_after === 27, '1.4 local_after = 27 (17 + 10 = 27)');

    const med1After = await getMedicineById(med1.id, pool);
    check(Number(med1After?.current_stock) === 27, '1.5 Local PostgreSQL stock is 27');

    // =========================================================================
    // SECTION 2: TEST 6 — FORCE REMOVE (Cloud=20, Shop=17, Remove 5 -> 12)
    // =========================================================================
    section('2. TEST 6 — FORCE REMOVE (Cloud=20, Shop=17, Remove=5 -> Shop=12)');

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
        reason: 'Damaged medicine removed',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-rem-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(remResult.status === 'APPLIED', '2.2 Force Remove applied');
    check(remResult.result?.local_before === 17, '2.3 local_before = 17');
    check(remResult.result?.local_after === 12, '2.4 local_after = 12 (17 - 5 = 12)');

    const med2After = await getMedicineById(med2.id, pool);
    check(Number(med2After?.current_stock) === 12, '2.5 Local PostgreSQL stock is 12');

    // =========================================================================
    // SECTION 3: TEST 7 — FORCE SET (Cloud=20, Shop=17, Set=50 -> Shop=50)
    // =========================================================================
    section('3. TEST 7 — FORCE SET (Cloud=20, Shop=17, Set=50 -> Shop=50)');

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
        reason: 'Physical stocktake adjustment',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `force-set-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(setResult.status === 'APPLIED', '3.2 Force Set applied');
    check(setResult.result?.local_before === 17, '3.3 local_before = 17');
    check(setResult.result?.local_after === 50, '3.4 local_after = 50');

    const med3After = await getMedicineById(med3.id, pool);
    check(Number(med3After?.current_stock) === 50, '3.5 Local stock set to 50');

    // =========================================================================
    // SECTION 4: TEST 8 — SALE DURING ADMIN SCREEN (Admin sees 20, Sale occurs 19, Admin adds 5 -> 24)
    // =========================================================================
    section('4. TEST 8 — Sale during admin screen (Admin sees 20, Sale 19, Add 5 -> 24)');

    const { med: med4, batch: batch4 } = await createTestMed(`SaleRace_${Date.now()}`, 20, `B-SR-${Date.now().toString().slice(-4)}`);

    // A sale occurs locally before the admin's command arrives: 20 -> 19
    await withTransaction(async (c) => {
      await adminRemoveStockTx(c, {
        medicine_id: med4.id,
        batch_id: batch4.id,
        quantity: 1,
        reason: 'Customer purchase',
        user_id: adminActor.user_id,
        user_name: adminActor.user_name,
        role: adminActor.role,
      });
    });

    const med4LocalBefore = await getMedicineById(med4.id, pool);
    check(Number(med4LocalBefore?.current_stock) === 19, '4.1 Stock after sale is 19');

    // Admin (who saw 20) adds 5
    const addDuringSale = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: med4.id,
        batch_id: batch4.id,
        quantity: 5,
        reason: 'Administrative addition',
        cloud_quantity_seen: 20,
      },
      idempotency_key: `sale-race-add-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });

    check(addDuringSale.status === 'APPLIED', '4.2 Admin command applied without conflict rejection');
    check(addDuringSale.result?.local_before === 19, '4.3 Execution used CURRENT local state (19)');
    check(addDuringSale.result?.local_after === 24, '4.4 Final local state is 24 (19 + 5 = 24)');

    const med4LocalAfter = await getMedicineById(med4.id, pool);
    check(Number(med4LocalAfter?.current_stock) === 24, '4.5 Local PostgreSQL stock is 24');

    // =========================================================================
    // SECTION 5: TEST 11 — FORCE COMMAND DUPLICATE IDEMPOTENCY
    // =========================================================================
    section('5. TEST 11 — Duplicate Command Delivery Idempotency');

    const dupCommandId = crypto.randomUUID();
    const dupKey = `dup-key-${Date.now()}`;

    // Delivery 1
    const deliv1 = await applyCloudCommand({
      command_id: dupCommandId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: med1.id,
        batch_id: batch1.id,
        quantity: 3,
        reason: 'First delivery',
      },
      idempotency_key: dupKey,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(deliv1.status === 'APPLIED' && deliv1.duplicate === false, '5.1 First delivery applied (+3 stock)');

    const stockAfterDeliv1 = Number((await getMedicineById(med1.id, pool))?.current_stock);

    // Delivery 2 (exact same command_id and idempotency_key)
    const deliv2 = await applyCloudCommand({
      command_id: dupCommandId,
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_ADD',
      payload: {
        medicine_id: med1.id,
        batch_id: batch1.id,
        quantity: 3,
        reason: 'Second duplicate delivery',
      },
      idempotency_key: dupKey,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(deliv2.duplicate === true, '5.2 Second delivery recognized as duplicate');

    const stockAfterDeliv2 = Number((await getMedicineById(med1.id, pool))?.current_stock);
    check(stockAfterDeliv2 === stockAfterDeliv1, '5.3 Stock was NOT mutated a second time (zero double-adjustments)');

    // =========================================================================
    // SECTION 6: NEGATIVE STOCK SAFEGUARD (Shop=5, Remove 8)
    // =========================================================================
    section('6. Negative stock safeguard & set to zero prompt');

    const { med: med5, batch: batch5 } = await createTestMed(`NegFloor_${Date.now()}`, 5, `B-FL-${Date.now().toString().slice(-4)}`);

    const negRej = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: med5.id,
        batch_id: batch5.id,
        quantity: 8,
        reason: 'Excessive remove',
      },
      idempotency_key: `neg-rej-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(negRej.status === 'REJECTED', '6.1 Negative stock remove refused');
    check(String(negRej.error).includes('Current Shop stock is 5. Removing 8 would produce negative stock'), '6.2 Informative error returned with current shop stock');

    const setZero = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      command_type: 'STOCK_OVERRIDE_REMOVE',
      payload: {
        medicine_id: med5.id,
        batch_id: batch5.id,
        quantity: 8,
        set_zero_if_insufficient: true,
        reason: 'Excessive remove floored to zero',
      },
      idempotency_key: `set-zero-${Date.now()}`,
      created_by: 'Global Administrator <admin@gigachemist.com>',
    });
    check(setZero.status === 'APPLIED', '6.3 Confirmed set_zero_if_insufficient applied');
    check(setZero.result?.local_after === 0, '6.4 Stock floored to zero');

    const med5After = await getMedicineById(med5.id, pool);
    check(Number(med5After?.current_stock) === 0, '6.5 Local PostgreSQL stock is 0');
  } finally {
    await pool.end();
  }

  process.exit(summary());
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
