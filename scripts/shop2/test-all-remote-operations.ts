import crypto from 'crypto';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

import { getShopIdentity } from '../../server/sync/identity';
import { getSyncConfig } from '../../server/sync/config';
import { callCloud } from '../../server/sync/cloudClient';
import { applyCloudCommand } from '../../server/sync/commands';
import { checkInventoryParity, publishAuthoritativeInventorySnapshot } from '../../server/sync/inventorySnapshot';

const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const VERCEL_URL = 'https://gigachem.vercel.app';
const VERCEL_JWT_SECRET = '7KHVIErOKh-1akMsyNPp4_8qUpcxS17fqUl2IQLwaJVatT7aoOVfyQDy_UQHh3NbaML6IqZsrOECFYT6p_JjIg';
const CLOUD_URL = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

function makeGlobalAdminToken(): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    userId: 'ce096ece-15e4-4651-813a-c2bba081b597',
    email: 'admin@gigachemist.co.ke',
    role: 'ADMIN',
    name: 'GIGA CHEMIST Admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', VERCEL_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

async function vercelFetch(endpoint: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}) {
  const token = makeGlobalAdminToken();
  const res = await fetch(`${VERCEL_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const args = process.argv.slice(2);
  let fromTest = 1;
  for (const arg of args) {
    if (arg.startsWith('--from=')) {
      fromTest = parseInt(arg.split('=')[1], 10) || 1;
    }
  }

  console.log('======================================================================');
  console.log('  SHOP 2 COMPREHENSIVE REMOTE MANAGEMENT & ISOLATION REGRESSION SUITE');
  if (fromTest > 1) {
    console.log(`  [RESUMING FROM TEST ${fromTest}]`);
  }
  console.log('======================================================================\n');

  const localPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cloudClient = new pg.Client({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false } });
  await cloudClient.connect();

  const identity = await getShopIdentity();
  const cfg = getSyncConfig();
  const shop2Id = identity.shop_id;

  console.log(`Operating Shop: [${identity.shop_code}] ${identity.shop_name} (${shop2Id})`);
  console.log(`Protected Shop 1 ID: ${SHOP1_ID}\n`);

  const results: Record<string, 'PASS' | 'FAIL'> = {};

  // --------------------------------------------------------------------------
  // STEP A: CAPTURE SHOP 1 BASELINE
  // --------------------------------------------------------------------------
  console.log('--- BASELINE: CAPTURING SHOP 1 STATE ---');
  const shop1Baseline = (await cloudClient.query(
    'SELECT shop_snapshot_seq, inventory_fingerprint FROM giga_cloud.shops WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0];

  const shop1MedCount = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1TotalStock = Number((await cloudClient.query(
    'SELECT COALESCE(SUM(last_reported_quantity), 0)::bigint AS total FROM giga_cloud.stock_levels WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].total);

  console.log(`  Shop 1 Medicines: ${shop1MedCount}`);
  console.log(`  Shop 1 Stock:     ${shop1TotalStock}`);
  console.log(`  Shop 1 Seq:       ${shop1Baseline.shop_snapshot_seq}`);
  console.log(`  Shop 1 FP:        ${shop1Baseline.inventory_fingerprint}\n`);

  // Helper to pump all pending outbox sync_events into cloud
  async function pumpOutboxEvents(): Promise<number> {
    const pending = await localPool.query(`
      SELECT id, seq, idempotency_key, shop_id, device_id, event_type, operation, entity_type, entity_id,
             payload, actor_user_id, actor_name, business_ref, created_at, attempt_count
      FROM sync_events
      WHERE status IN ('PENDING', 'PROCESSING', 'RETRY')
      ORDER BY seq ASC
    `);

    if (pending.rows.length === 0) return 0;

    const events = pending.rows.map((r) => ({
      event_id: r.id,
      idempotency_key: r.idempotency_key,
      shop_id: r.shop_id,
      local_seq: String(r.seq),
      event_type: r.event_type,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      operation: r.operation,
      device_id: r.device_id,
      actor_user_id: r.actor_user_id,
      actor_name: r.actor_name,
      business_ref: r.business_ref,
      occurred_at: new Date(r.created_at).toISOString(),
      payload: r.payload,
    }));

    const res = await callCloud<any>('gc_ingest_events', {
      p_shop_id: shop2Id,
      p_token: cfg.shopToken,
      p_events: events,
    });

    const byKey = new Map<string, any>();
    for (const r of Array.isArray(res?.results) ? res.results : []) {
      byKey.set(r.idempotency_key, r);
    }

    const synced: string[] = [];
    for (const r of pending.rows) {
      const rRes = byKey.get(r.idempotency_key);
      if (rRes?.status === 'APPLIED' || rRes?.status === 'DUPLICATE') {
        synced.push(r.id);
      } else if (rRes?.status === 'REJECTED') {
        await localPool.query(
          "UPDATE sync_events SET status = 'FAILED', last_error = $2 WHERE id = $1",
          [r.id, `Rejected by cloud: ${String(rRes.error || 'invalid event').slice(0, 1000)}`]
        );
        throw new Error(`Sync event ${r.event_type} (${r.id}) rejected by cloud: ${rRes.error}`);
      }
    }

    if (synced.length > 0) {
      await localPool.query(
        "UPDATE sync_events SET status = 'SYNCED', synced_at = CURRENT_TIMESTAMP, processed_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])",
        [synced]
      );
    }
    return synced.length;
  }

  // Helper to pull, apply, ack and reflect command
  async function executeCommandLifecycle(commandId: string) {
    const pull = await callCloud<any>('gc_pull_commands', { p_shop_id: shop2Id, p_token: cfg.shopToken, p_limit: 10 });
    const cmd = pull.commands.find((c: any) => c.command_id === commandId);
    if (!cmd) throw new Error(`Command ${commandId} not found in gc_pull_commands`);

    const apply = await applyCloudCommand(cmd);
    if (apply.status !== 'APPLIED') throw new Error(`Command ${commandId} application failed: ${apply.error}`);

    await callCloud('gc_ack_command', {
      p_shop_id: shop2Id,
      p_token: cfg.shopToken,
      p_command_id: commandId,
      p_status: apply.status,
      p_result: apply.result,
    });

    // Ingest generated outbox events to cloud
    await pumpOutboxEvents();

    await publishAuthoritativeInventorySnapshot();
    return { cmd, apply };
  }

  // --------------------------------------------------------------------------
  // STEP B: INITIALIZE CONTROLLED TEST MEDICINE IN SHOP 2
  // --------------------------------------------------------------------------
  console.log('--- SETUP: PREPARING DISPOSABLE TEST MEDICINE IN SHOP 2 ---');
  let testMedId = '751ea76d-8512-4071-b730-595e6aa318e9';
  let testBatchId = '101a2418-62a0-42d3-ae13-9669b6fec165';

  const existingMed = (await localPool.query('SELECT id FROM medicines WHERE id = $1', [testMedId])).rows[0];
  const initialQty = fromTest >= 8 ? 10 : 15;
  const initialPrice = fromTest >= 8 ? 175.00 : 100.00;
  const initialExpiry = fromTest >= 8 ? '2029-06-30' : '2028-12-31';

  if (!existingMed) {
    await localPool.query(`
      INSERT INTO medicines (
        id, name, generic_name, sku, barcode, description, dosage_strength, dosage_form, unit,
        current_stock, purchase_price, selling_price, status, version, stock_version
      ) VALUES (
        $1, 'SHOP2 REMOTE TEST ITEM', 'Shop2 Test Molecule', 'SKU-SHOP2-TEST', 'TEST-SHOP2-688771', 'Temporary test medicine',
        '500mg', 'Tablet', 'Tablet',
        $2, 50.00, $3, 'active', 1, 1
      )
    `, [testMedId, initialQty, initialPrice]);
    await localPool.query(`
      INSERT INTO medicine_batches (
        id, medicine_id, batch_number, expiry_date, quantity_received, quantity_available,
        purchase_price, status, stock_version
      ) VALUES (
        $1, $2, 'B-SHOP2-001', $3, $4, $4,
        50.00, 'active', 1
      )
    `, [testBatchId, testMedId, initialExpiry, initialQty]);
  } else {
    await localPool.query(`
      UPDATE medicines SET current_stock = $2, selling_price = $3, status = 'active', stock_version = stock_version + 1 WHERE id = $1
    `, [testMedId, initialQty, initialPrice]);
    await localPool.query(`
      UPDATE medicine_batches SET quantity_available = $2, expiry_date = $3, status = 'active', stock_version = stock_version + 1 WHERE id = $1
    `, [testBatchId, initialQty, initialExpiry]);
  }

  await pumpOutboxEvents();
  await publishAuthoritativeInventorySnapshot();
  console.log(`✓ Test medicine ready: ${testMedId}, batch: ${testBatchId} (Qty: ${initialQty})\n`);

  // --------------------------------------------------------------------------
  // TEST 1: REMOTE REMOVE STOCK (15 -> 12)
  // --------------------------------------------------------------------------
  if (fromTest <= 1) {
    console.log('--- TEST 1: REMOTE REMOVE STOCK (-3) ---');
    const remResp = await vercelFetch('/api/admin/commands/stock-remove', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        quantity: 3,
        reason: 'DAMAGED',
        expected_quantity: 15,
      },
    });
    if (!remResp.ok || !remResp.data?.command_id) throw new Error(`Queue stock-remove failed: ${JSON.stringify(remResp.data)}`);
    await executeCommandLifecycle(remResp.data.command_id);

    const localRem = (await localPool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0].quantity_available;
    const cloudRem = (await cloudClient.query('SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [shop2Id, testBatchId])).rows[0]?.last_reported_quantity;

    console.log(`  Local Qty: ${localRem} (Exp: 12), Cloud Qty: ${cloudRem} (Exp: 12)`);
    if (Number(localRem) === 12 && Number(cloudRem) === 12) {
      results['REMOTE_REMOVE'] = 'PASS';
      console.log('  ✓ REMOTE REMOVE: PASS');
    } else {
      results['REMOTE_REMOVE'] = 'FAIL';
      throw new Error('REMOTE REMOVE failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 2: REMOTE FORCE SET (12 -> 7)
  // --------------------------------------------------------------------------
  if (fromTest <= 2) {
    console.log('\n--- TEST 2: REMOTE FORCE SET (SET = 7) ---');
    const setResp = await vercelFetch('/api/admin/commands/stock-set', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        quantity: 7,
        reason: 'Physical count adjustment',
        expected_quantity: 12,
      },
    });
    if (!setResp.ok || !setResp.data?.command_id) throw new Error(`Queue stock-set failed: ${JSON.stringify(setResp.data)}`);
    await executeCommandLifecycle(setResp.data.command_id);

    const localSet = (await localPool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0].quantity_available;
    const cloudSet = (await cloudClient.query('SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [shop2Id, testBatchId])).rows[0]?.last_reported_quantity;

    console.log(`  Local Qty: ${localSet} (Exp: 7), Cloud Qty: ${cloudSet} (Exp: 7)`);
    if (Number(localSet) === 7 && Number(cloudSet) === 7) {
      results['REMOTE_FORCE_SET'] = 'PASS';
      console.log('  ✓ REMOTE FORCE SET: PASS');
    } else {
      results['REMOTE_FORCE_SET'] = 'FAIL';
      throw new Error('REMOTE FORCE SET failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 3: REMOTE SET ZERO & ZERO-STOCK BATCH ARCHIVE (7 -> 0 -> archived)
  // --------------------------------------------------------------------------
  if (fromTest <= 3) {
    console.log('\n--- TEST 3: REMOTE SET ZERO & ZERO-STOCK BATCH ARCHIVE ---');
    const zeroResp = await vercelFetch('/api/admin/commands/stock-set', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        quantity: 0,
        reason: 'Batch stock depleted to zero',
        expected_quantity: 7,
      },
    });
    if (!zeroResp.ok || !zeroResp.data?.command_id) throw new Error(`Queue stock-set zero failed: ${JSON.stringify(zeroResp.data)}`);
    await executeCommandLifecycle(zeroResp.data.command_id);

    const zeroBatch = (await localPool.query('SELECT quantity_available, status FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0];
    const zeroMed = (await localPool.query('SELECT current_stock FROM medicines WHERE id = $1', [testMedId])).rows[0];
    const cloudZero = (await cloudClient.query('SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [shop2Id, testBatchId])).rows[0]?.last_reported_quantity;

    console.log(`  Local Batch Qty: ${zeroBatch.quantity_available}, Status: '${zeroBatch.status}', Med Stock: ${zeroMed.current_stock}, Cloud Qty: ${cloudZero}`);
    if (Number(zeroBatch.quantity_available) === 0 && zeroBatch.status === 'archived' && Number(zeroMed.current_stock) === 0 && Number(cloudZero) === 0) {
      results['REMOTE_SET_ZERO'] = 'PASS';
      results['ZERO_STOCK_BATCH_ARCHIVE'] = 'PASS';
      console.log('  ✓ REMOTE SET ZERO & BATCH ARCHIVE: PASS');
    } else {
      results['REMOTE_SET_ZERO'] = 'FAIL';
      results['ZERO_STOCK_BATCH_ARCHIVE'] = 'FAIL';
      throw new Error('REMOTE SET ZERO / BATCH ARCHIVE failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 4: ADD STOCK AFTER ZERO / BATCH REACTIVATION (0 -> +8 -> active)
  // --------------------------------------------------------------------------
  if (fromTest <= 4) {
    console.log('\n--- TEST 4: ADD STOCK AFTER ZERO / BATCH REACTIVATION ---');
    const reacResp = await vercelFetch('/api/admin/commands/stock-add', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        quantity: 8,
        reason: 'RESTOCK_AFTER_ZERO',
        expected_quantity: 0,
      },
    });
    if (!reacResp.ok || !reacResp.data?.command_id) throw new Error(`Queue stock-add reactivation failed: ${JSON.stringify(reacResp.data)}`);
    await executeCommandLifecycle(reacResp.data.command_id);

    const reacBatch = (await localPool.query('SELECT quantity_available, status FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0];
    const reacCloud = (await cloudClient.query('SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [shop2Id, testBatchId])).rows[0]?.last_reported_quantity;

    console.log(`  Reactivated Batch Qty: ${reacBatch.quantity_available}, Status: '${reacBatch.status}', Cloud Qty: ${reacCloud}`);
    if (Number(reacBatch.quantity_available) === 8 && reacBatch.status === 'active' && Number(reacCloud) === 8) {
      results['ADD_STOCK_AFTER_ZERO_REACTIVATION'] = 'PASS';
      console.log('  ✓ ADD STOCK AFTER ZERO / REACTIVATION: PASS');
    } else {
      results['ADD_STOCK_AFTER_ZERO_REACTIVATION'] = 'FAIL';
      throw new Error('ADD STOCK AFTER ZERO failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 5: REMOTE PRICE EDIT (selling_price: 100 -> 175)
  // --------------------------------------------------------------------------
  if (fromTest <= 5) {
    console.log('\n--- TEST 5: REMOTE PRICE EDIT ---');
    const currentPriceBefore = Number((await localPool.query('SELECT selling_price FROM medicines WHERE id = $1', [testMedId])).rows[0].selling_price);
    const priceResp = await vercelFetch('/api/admin/commands/price-update', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        selling_price: 175.00,
        reason: 'Inflation adjustment test',
        expected: {
          selling_price: currentPriceBefore,
        },
      },
    });
    if (!priceResp.ok || !priceResp.data?.command_id) throw new Error(`Queue price-update failed: ${JSON.stringify(priceResp.data)}`);
    await executeCommandLifecycle(priceResp.data.command_id);

    const localPrice = (await localPool.query('SELECT selling_price FROM medicines WHERE id = $1', [testMedId])).rows[0].selling_price;
    const cloudPrice = (await cloudClient.query('SELECT selling_price FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [shop2Id, testMedId])).rows[0]?.selling_price;

    console.log(`  Local Selling Price: ${localPrice} (Exp: 175.00), Cloud Selling Price: ${cloudPrice} (Exp: 175.00)`);
    if (Number(localPrice) === 175 && Number(cloudPrice) === 175) {
      results['REMOTE_PRICE_EDIT'] = 'PASS';
      console.log('  ✓ REMOTE PRICE EDIT: PASS');
    } else {
      results['REMOTE_PRICE_EDIT'] = 'FAIL';
      throw new Error('REMOTE PRICE EDIT failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 6: REMOTE BATCH EDIT (expiry: 2028-12-31 -> 2029-06-30)
  // --------------------------------------------------------------------------
  if (fromTest <= 6) {
    console.log('\n--- TEST 6: REMOTE BATCH EDIT ---');
    const batchResp = await vercelFetch('/api/admin/commands/batch-expiry', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        expiry_date: '2029-06-30',
        reason: 'Extension of expiry date test',
      },
    });
    if (!batchResp.ok || !batchResp.data?.command_id) throw new Error(`Queue batch-expiry failed: ${JSON.stringify(batchResp.data)}`);
    await executeCommandLifecycle(batchResp.data.command_id);

    const localExp = (await localPool.query('SELECT expiry_date FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0].expiry_date;
    const cloudExp = (await cloudClient.query('SELECT expiry_date FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND batch_id = $2', [shop2Id, testBatchId])).rows[0]?.expiry_date;

    console.log(`  Local Expiry: ${localExp}, Cloud Expiry: ${cloudExp}`);
    if (String(localExp).includes('2029-06-30') && String(cloudExp).includes('2029-06-30')) {
      results['REMOTE_BATCH_EDIT'] = 'PASS';
      console.log('  ✓ REMOTE BATCH EDIT: PASS');
    } else {
      results['REMOTE_BATCH_EDIT'] = 'FAIL';
      throw new Error('REMOTE BATCH EDIT failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 7: OFFLINE COMMAND QUEUE & RECONNECT PROCESSING & DUPLICATE DELIVERY
  // --------------------------------------------------------------------------
  if (fromTest <= 7) {
    console.log('\n--- TEST 7: OFFLINE QUEUE, RECONNECT & DUPLICATE DELIVERY ---');
    const currentBatchQty7 = Number((await localPool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0].quantity_available);
    const offlineResp = await vercelFetch('/api/admin/commands/stock-add', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        batch_id: testBatchId,
        quantity: 2,
        reason: 'Offline queue test',
        expected_quantity: currentBatchQty7,
      },
    });
    if (!offlineResp.ok || !offlineResp.data?.command_id) throw new Error(`Queue offline command failed: ${JSON.stringify(offlineResp.data)}`);
    const offlineCmdId = offlineResp.data.command_id;

    // 1. Verify queued as PENDING
    const cmdPending = (await cloudClient.query('SELECT status FROM giga_cloud.commands WHERE command_id = $1', [offlineCmdId])).rows[0]?.status;
    console.log(`  Step 1: Queued status in cloud: ${cmdPending} (Expected: PENDING)`);

    // 2. Reconnect / Pull command
    const pullOffline = await callCloud<any>('gc_pull_commands', { p_shop_id: shop2Id, p_token: cfg.shopToken, p_limit: 10 });
    const offlineCmd = pullOffline.commands.find((c: any) => c.command_id === offlineCmdId);
    const cmdDelivered = (await cloudClient.query('SELECT status FROM giga_cloud.commands WHERE command_id = $1', [offlineCmdId])).rows[0]?.status;
    console.log(`  Step 2: Pulled status in cloud: ${cmdDelivered} (Expected: DELIVERED)`);

    // 3. Apply command
    const applyOffline = await applyCloudCommand(offlineCmd);
    await callCloud('gc_ack_command', {
      p_shop_id: shop2Id,
      p_token: cfg.shopToken,
      p_command_id: offlineCmdId,
      p_status: applyOffline.status,
      p_result: applyOffline.result,
    });
    const cmdApplied = (await cloudClient.query('SELECT status FROM giga_cloud.commands WHERE command_id = $1', [offlineCmdId])).rows[0]?.status;
    console.log(`  Step 3: Applied status in cloud: ${cmdApplied} (Expected: APPLIED)`);

    // 4. Test duplicate delivery replay
    const dupApply = await applyCloudCommand(offlineCmd);
    const dupPass = (dupApply.duplicate === true && dupApply.status === 'APPLIED');
    console.log(`  Step 4: Duplicate replay result: duplicate=${dupApply.duplicate}, status=${dupApply.status} -> ${dupPass ? 'PASS' : 'FAIL'}`);

    await pumpOutboxEvents();
    await publishAuthoritativeInventorySnapshot();

    if (cmdPending === 'PENDING' && cmdDelivered === 'DELIVERED' && cmdApplied === 'APPLIED' && dupPass) {
      results['OFFLINE_COMMAND_QUEUE'] = 'PASS';
      results['RECONNECT_PROCESSING'] = 'PASS';
      results['DUPLICATE_COMMAND_DELIVERY'] = 'PASS';
      console.log('  ✓ OFFLINE QUEUE, RECONNECT & DUPLICATE DELIVERY: PASS');
    } else {
      results['OFFLINE_COMMAND_QUEUE'] = 'FAIL';
      results['RECONNECT_PROCESSING'] = 'FAIL';
      results['DUPLICATE_COMMAND_DELIVERY'] = 'FAIL';
      throw new Error('Offline queue / duplicate delivery failed');
    }
  }

  // --------------------------------------------------------------------------
  // TEST 8: MEDICINE DELETE / ARCHIVE
  // --------------------------------------------------------------------------
  if (fromTest <= 8) {
    console.log('\n--- TEST 8: MEDICINE DELETE / ARCHIVE ---');
    // Precondition: Set stock to 0 so medicine can be deleted/archived
    const currentBatchQty8 = Number((await localPool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatchId])).rows[0]?.quantity_available || 0);
    if (currentBatchQty8 > 0) {
      const prepZeroResp = await vercelFetch('/api/admin/commands/stock-set', {
        method: 'POST',
        headers: { 'X-GIGA-SHOP-ID': shop2Id },
        body: {
          medicine_id: testMedId,
          batch_id: testBatchId,
          quantity: 0,
          reason: 'Zero stock before delete test',
          expected_quantity: currentBatchQty8,
        },
      });
      await executeCommandLifecycle(prepZeroResp.data.command_id);
    }

    // Issue remote MEDICINE_DELETE
    const delResp = await vercelFetch('/api/admin/commands/medicine-delete', {
      method: 'POST',
      headers: { 'X-GIGA-SHOP-ID': shop2Id },
      body: {
        medicine_id: testMedId,
        reason: 'Testing remote medicine delete/archive',
      },
    });
    if (!delResp.ok || !delResp.data?.command_id) throw new Error(`Queue medicine-delete failed: ${JSON.stringify(delResp.data)}`);
    const delCmdId = delResp.data.command_id;

    // Pull, apply locally and ACK
    const pull = await callCloud<any>('gc_pull_commands', { p_shop_id: shop2Id, p_token: cfg.shopToken, p_limit: 10 });
    const cmd = pull.commands.find((c: any) => c.command_id === delCmdId);
    if (!cmd) throw new Error(`Command ${delCmdId} not found in gc_pull_commands`);

    const apply = await applyCloudCommand(cmd);
    if (apply.status !== 'APPLIED') throw new Error(`Medicine delete failed locally: ${apply.error}`);
    console.log(`  Step 1: Local command applied with action: ${apply.result?.action || 'ARCHIVED'}`);

    await callCloud('gc_ack_command', {
      p_shop_id: shop2Id,
      p_token: cfg.shopToken,
      p_command_id: delCmdId,
      p_status: apply.status,
      p_result: apply.result,
    });

    // 1. LOCAL medicine status = archived
    const medPostDel = (await localPool.query('SELECT status FROM medicines WHERE id = $1', [testMedId])).rows[0];
    console.log(`  Assertion 1: Local medicine status = '${medPostDel?.status}' (Exp: archived)`);
    if (medPostDel?.status !== 'archived') throw new Error(`Expected local medicine status 'archived', got '${medPostDel?.status}'`);

    // 2. LOCAL associated batches = archived
    const batchesPostDel = (await localPool.query('SELECT id, status FROM medicine_batches WHERE medicine_id = $1', [testMedId])).rows;
    const allBatchesArchived = batchesPostDel.every(b => b.status === 'archived');
    console.log(`  Assertion 2: Local batches (${batchesPostDel.length}) all archived: ${allBatchesArchived ? 'YES' : 'NO'}`);
    if (!allBatchesArchived) throw new Error('Not all local batches archived after medicine delete');

    // 3. MEDICINE_ARCHIVED outbox event exists
    const archiveEventRes = await localPool.query(`
      SELECT * FROM sync_events
      WHERE event_type = 'MEDICINE_ARCHIVED'
        AND (payload->'data'->>'medicine_id' = $1 OR entity_id = $1)
      ORDER BY seq DESC LIMIT 1
    `, [testMedId]);
    const archiveEvent = archiveEventRes.rows[0];
    if (!archiveEvent) throw new Error('MEDICINE_ARCHIVED event was not found in sync_events outbox');
    console.log(`  Assertion 3: MEDICINE_ARCHIVED outbox event exists: seq=${archiveEvent.seq}, id=${archiveEvent.id}`);

    // 4. Outbox event processed successfully
    const pumped = await pumpOutboxEvents();
    const eventPostPump = (await localPool.query('SELECT status, processed_at FROM sync_events WHERE id = $1', [archiveEvent.id])).rows[0];
    console.log(`  Assertion 4: Outbox event status post-pump: status='${eventPostPump?.status}', processed_at=${eventPostPump?.processed_at}`);
    if (eventPostPump?.status !== 'SYNCED') throw new Error(`Expected event status 'SYNCED', got '${eventPostPump?.status}'`);

    // 5. CLOUD medicine status = archived (with bounded polling)
    let cloudMedStatus = '';
    for (let attempt = 1; attempt <= 20; attempt++) {
      const cMed = (await cloudClient.query(
        'SELECT status FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2',
        [shop2Id, testMedId]
      )).rows[0];
      cloudMedStatus = cMed?.status;
      if (cloudMedStatus === 'archived') {
        console.log(`  Assertion 5: Cloud medicine status = 'archived' (confirmed on poll attempt ${attempt})`);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (cloudMedStatus !== 'archived') throw new Error(`Cloud medicine status is '${cloudMedStatus}', expected 'archived'`);

    // 6. CLOUD associated batches = archived
    const cloudBatches = (await cloudClient.query(
      'SELECT batch_id, status FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2',
      [shop2Id, testMedId]
    )).rows;
    const allCloudBatchesArchived = cloudBatches.length > 0 && cloudBatches.every(b => b.status === 'archived');
    console.log(`  Assertion 6: Cloud batches (${cloudBatches.length}) all archived: ${allCloudBatchesArchived ? 'YES' : 'NO'}`);
    if (!allCloudBatchesArchived) throw new Error('Not all cloud batches archived');

    // 7. Absent from operational catalogue
    const opCount = Number((await cloudClient.query(
      "SELECT COUNT(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2 AND status <> 'archived'",
      [shop2Id, testMedId]
    )).rows[0].count);
    console.log(`  Assertion 7: Absent from operational catalogue: count=${opCount} (Exp: 0)`);
    if (opCount !== 0) throw new Error(`Medicine still found in operational catalogue: count=${opCount}`);

    // 8. Historical references remain intact
    const histMovements = Number((await localPool.query(
      'SELECT COUNT(*)::int AS count FROM inventory_movements WHERE medicine_id = $1',
      [testMedId]
    )).rows[0].count);
    console.log(`  Assertion 8: Historical inventory movements intact: ${histMovements} records found`);
    if (histMovements === 0) throw new Error('Historical inventory movements missing!');

    // 9. Verify no duplicate archive event causes unintended side effects
    const dupRes = await callCloud<any>('gc_ingest_events', {
      p_shop_id: shop2Id,
      p_token: cfg.shopToken,
      p_events: [{
        event_id: archiveEvent.id,
        idempotency_key: archiveEvent.idempotency_key,
        shop_id: archiveEvent.shop_id,
        local_seq: String(archiveEvent.seq),
        event_type: archiveEvent.event_type,
        entity_type: archiveEvent.entity_type,
        entity_id: archiveEvent.entity_id,
        operation: archiveEvent.operation,
        device_id: archiveEvent.device_id,
        actor_user_id: archiveEvent.actor_user_id,
        actor_name: archiveEvent.actor_name,
        business_ref: archiveEvent.business_ref,
        occurred_at: new Date(archiveEvent.created_at).toISOString(),
        payload: archiveEvent.payload,
      }],
    });
    const dupStatus = dupRes?.results?.[0]?.status;
    console.log(`  Assertion 9: Duplicate event replay result: status='${dupStatus}' (Exp: DUPLICATE or APPLIED)`);
    if (dupStatus !== 'DUPLICATE' && dupStatus !== 'APPLIED') throw new Error(`Duplicate replay failed: ${JSON.stringify(dupRes)}`);

    // Final snapshot update to verify snapshot parity excludes archived item correctly
    await publishAuthoritativeInventorySnapshot();

    results['MEDICINE_DELETE_ARCHIVE'] = 'PASS';
    console.log('  ✓ TEST 8: MEDICINE DELETE / ARCHIVE: PASS (All assertions satisfied)');
  }

  // --------------------------------------------------------------------------
  // TEST 9: SHOP1 / SHOP2 ISOLATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 9: SHOP1 / SHOP2 ISOLATION VERIFICATION ---');
  const shop1Post = (await cloudClient.query(
    'SELECT shop_snapshot_seq, inventory_fingerprint FROM giga_cloud.shops WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0];

  const shop1MedCountPost = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1TotalStockPost = Number((await cloudClient.query(
    'SELECT COALESCE(SUM(last_reported_quantity), 0)::bigint AS total FROM giga_cloud.stock_levels WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].total);

  const shop1Matches = (
    shop1MedCount === shop1MedCountPost &&
    shop1TotalStock === shop1TotalStockPost &&
    shop1Baseline.shop_snapshot_seq === shop1Post.shop_snapshot_seq &&
    shop1Baseline.inventory_fingerprint === shop1Post.inventory_fingerprint
  );

  console.log(`  Shop 1 Medicines: ${shop1MedCount} -> ${shop1MedCountPost} (${shop1MedCount === shop1MedCountPost ? 'UNCHANGED' : 'CHANGED'})`);
  console.log(`  Shop 1 Stock:     ${shop1TotalStock} -> ${shop1TotalStockPost} (${shop1TotalStock === shop1TotalStockPost ? 'UNCHANGED' : 'CHANGED'})`);
  console.log(`  Shop 1 Seq:       ${shop1Baseline.shop_snapshot_seq} -> ${shop1Post.shop_snapshot_seq} (${shop1Baseline.shop_snapshot_seq === shop1Post.shop_snapshot_seq ? 'UNCHANGED' : 'CHANGED'})`);
  console.log(`  Shop 1 FP:        ${shop1Baseline.inventory_fingerprint === shop1Post.inventory_fingerprint ? 'UNCHANGED' : 'CHANGED'}`);

  if (shop1Matches) {
    results['SHOP1_SHOP2_ISOLATION'] = 'PASS';
    console.log('  ✓ SHOP1 / SHOP2 ISOLATION: PASS (Shop 1 100% untouched)');
  } else {
    results['SHOP1_SHOP2_ISOLATION'] = 'FAIL';
    throw new Error('SHOP1 / SHOP2 ISOLATION failed — Shop 1 was altered!');
  }

  // --------------------------------------------------------------------------
  // TEST 10: FINAL SHOP 2 CLOUD PARITY
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 10: FINAL SHOP 2 PARITY ---');
  const parity = await checkInventoryParity();
  console.log(`  Local Fingerprint: ${parity.local_fingerprint}`);
  console.log(`  Cloud Fingerprint: ${parity.cloud_fingerprint}`);
  console.log(`  Parity Status:     ${parity.parity} (In Sync: ${parity.in_sync})`);

  if (parity.parity === 'MATCH' && parity.in_sync) {
    results['FINAL_SHOP2_PARITY'] = 'PASS';
    console.log('  ✓ FINAL SHOP 2 PARITY: PASS (MATCH)');
  } else {
    results['FINAL_SHOP2_PARITY'] = 'FAIL';
    throw new Error('FINAL SHOP 2 PARITY failed');
  }

  // Print Summary
  console.log('\n======================================================================');
  console.log('  SHOP 2 REMOTE REGRESSION SUITE RESULTS:');
  console.log('======================================================================');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(38)}: ${v}`);
  }

  await localPool.end();
  await cloudClient.end();
}

main().then(() => {
  process.exitCode = 0;
}).catch((err) => {
  console.error('\n[FATAL SUITE ERROR]:', err);
  process.exitCode = 1;
});
