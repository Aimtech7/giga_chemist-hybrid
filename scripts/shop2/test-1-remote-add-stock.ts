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
  console.log('======================================================================');
  console.log('  TEST 1 — REMOTE ADD STOCK (+5)');
  console.log('======================================================================\n');

  const localPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cloudClient = new pg.Client({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false } });
  await cloudClient.connect();

  const identity = await getShopIdentity();
  const cfg = getSyncConfig();
  const shop2Id = identity.shop_id;

  console.log(`Operating Shop: [${identity.shop_code}] ${identity.shop_name} (${shop2Id})`);
  console.log(`Protected Shop 1 ID: ${SHOP1_ID}\n`);

  // --------------------------------------------------------------------------
  // STEP 1: CAPTURE SHOP 1 BASELINE STATE
  // --------------------------------------------------------------------------
  console.log('--- 1. CAPTURING SHOP 1 BASELINE STATE ---');
  const shop1ShopRow = (await cloudClient.query(
    'SELECT shop_id, shop_code, shop_snapshot_seq, inventory_fingerprint FROM giga_cloud.shops WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0];

  const shop1MedCount = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1BatchCount = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicine_batches WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1TotalStock = Number((await cloudClient.query(
    'SELECT COALESCE(SUM(last_reported_quantity), 0)::bigint AS total FROM giga_cloud.stock_levels WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].total);

  console.log(`  Shop 1 Medicines Count:   ${shop1MedCount}`);
  console.log(`  Shop 1 Batches Count:     ${shop1BatchCount}`);
  console.log(`  Shop 1 Total Cloud Stock: ${shop1TotalStock}`);
  console.log(`  Shop 1 Snapshot Seq:      ${shop1ShopRow?.shop_snapshot_seq}`);
  console.log(`  Shop 1 Fingerprint:       ${shop1ShopRow?.inventory_fingerprint}\n`);

  // --------------------------------------------------------------------------
  // STEP 2: CAPTURE SHOP 2 STATE & TEST ITEM
  // --------------------------------------------------------------------------
  console.log('--- 2. CAPTURING SHOP 2 LOCAL & CLOUD STATE ---');
  const itemRow = (await localPool.query(`
    SELECT m.id AS medicine_id, m.name, m.current_stock, m.stock_version AS med_stock_version,
           b.id AS batch_id, b.batch_number, b.quantity_available, b.stock_version AS batch_stock_version
    FROM medicines m
    JOIN medicine_batches b ON b.medicine_id = m.id
    WHERE m.name = 'SHOP2 REMOTE TEST ITEM'
    LIMIT 1
  `)).rows[0];

  if (!itemRow) {
    throw new Error('Test item "SHOP2 REMOTE TEST ITEM" not found in local database.');
  }

  const testMedId = itemRow.medicine_id;
  const testBatchId = itemRow.batch_id;
  const localQtyBefore = Number(itemRow.quantity_available);
  const stockVersionBefore = Number(itemRow.batch_stock_version);

  const cloudStockBefore = Number((await cloudClient.query(
    'SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2',
    [shop2Id, testBatchId]
  )).rows[0]?.last_reported_quantity || 0);

  console.log(`  Test Medicine ID:       ${testMedId}`);
  console.log(`  Test Batch ID:          ${testBatchId}`);
  console.log(`  Starting Local Qty:     ${localQtyBefore}`);
  console.log(`  Starting Cloud Qty:     ${cloudStockBefore}`);
  console.log(`  Starting Stock Version: ${stockVersionBefore}\n`);

  if (localQtyBefore !== 10) {
    console.log(`  Resetting test batch from ${localQtyBefore} to 10 for clean test execution...`);
    await localPool.query('UPDATE medicines SET current_stock = 10, stock_version = stock_version + 1 WHERE id = $1', [testMedId]);
    await localPool.query('UPDATE medicine_batches SET quantity_available = 10, stock_version = stock_version + 1 WHERE id = $1', [testBatchId]);
    await publishAuthoritativeInventorySnapshot();
  }

  const freshItem = (await localPool.query(`
    SELECT m.current_stock, b.quantity_available, b.stock_version
    FROM medicines m JOIN medicine_batches b ON b.medicine_id = m.id WHERE m.id = $1 AND b.id = $2
  `, [testMedId, testBatchId])).rows[0];

  const actualLocalBefore = Number(freshItem.quantity_available);
  const actualStockVersionBefore = Number(freshItem.stock_version);

  // --------------------------------------------------------------------------
  // STEP 3: ISSUE REMOTE ADD STOCK (+5) FROM VERCEL GLOBAL ADMIN
  // --------------------------------------------------------------------------
  console.log('--- 3. ISSUING REMOTE COMMAND: STOCK_ADD (+5) ---');
  const requestedAddition = 5;
  const lifecycle: string[] = [];

  const addResp = await vercelFetch('/api/admin/commands/stock-add', {
    method: 'POST',
    headers: { 'X-GIGA-SHOP-ID': shop2Id },
    body: {
      medicine_id: testMedId,
      batch_id: testBatchId,
      quantity: requestedAddition,
      reason: 'RESTOCK',
      expected_quantity: actualLocalBefore,
    },
  });

  console.log(`  Vercel API Status: HTTP ${addResp.status}`);
  console.log('  Vercel API Response:', addResp.data);

  if (!addResp.ok || !addResp.data?.command_id) {
    throw new Error(`Failed to queue stock-add command: ${JSON.stringify(addResp.data)}`);
  }

  const commandId = addResp.data.command_id;
  lifecycle.push('QUEUED');
  console.log(`  ✓ Lifecycle Step 1: QUEUED (command_id: ${commandId})`);

  // Verify status in giga_cloud.commands
  const queuedRow = (await cloudClient.query(
    'SELECT command_id, status FROM giga_cloud.commands WHERE command_id = $1',
    [commandId]
  )).rows[0];
  console.log(`  Cloud Command Table Status: ${queuedRow?.status}`);

  // --------------------------------------------------------------------------
  // STEP 4: PULL COMMAND VIA SYNC WORKER CLIENT (DELIVERED)
  // --------------------------------------------------------------------------
  console.log('\n--- 4. PULLING COMMAND VIA SYNC WORKER (DELIVERED) ---');
  const pullResp = await callCloud<any>('gc_pull_commands', {
    p_shop_id: shop2Id,
    p_token: cfg.shopToken,
    p_limit: 10,
  });

  const cmd = pullResp.commands.find((c: any) => c.command_id === commandId);
  if (!cmd) {
    throw new Error(`Command ${commandId} not returned by gc_pull_commands.`);
  }

  lifecycle.push('DELIVERED');
  console.log(`  ✓ Lifecycle Step 2: DELIVERED (Delivery count: ${cmd.delivery_count})`);

  // Verify cloud status transitioned to DELIVERED
  const deliveredRow = (await cloudClient.query(
    'SELECT status, delivered_at FROM giga_cloud.commands WHERE command_id = $1',
    [commandId]
  )).rows[0];
  console.log(`  Cloud Command Table Status: ${deliveredRow?.status} (delivered_at: ${deliveredRow?.delivered_at})`);

  // --------------------------------------------------------------------------
  // STEP 5: APPLY COMMAND IN LOCAL POSTGRESQL TRANSACTION (APPLYING -> APPLIED)
  // --------------------------------------------------------------------------
  console.log('\n--- 5. APPLYING COMMAND IN LOCAL TRANSACTION ---');
  lifecycle.push('APPLYING');
  console.log('  ✓ Lifecycle Step 3: APPLYING (local row locking & stock mutation)');

  const applyResult = await applyCloudCommand(cmd);
  console.log('  Local Apply Result:', applyResult);

  if (applyResult.status !== 'APPLIED') {
    throw new Error(`Command application failed: ${applyResult.error}`);
  }

  lifecycle.push('APPLIED');
  console.log('  ✓ Lifecycle Step 4: APPLIED (transaction committed locally)');

  // Acknowledge command to Supabase
  console.log('  Acknowledging command to Supabase...');
  const ackResp = await callCloud<any>('gc_ack_command', {
    p_shop_id: shop2Id,
    p_token: cfg.shopToken,
    p_command_id: commandId,
    p_status: applyResult.status,
    p_result: applyResult.result,
  });
  console.log('  Ack Response:', ackResp);

  const ackedRow = (await cloudClient.query(
    'SELECT status, acked_at, result FROM giga_cloud.commands WHERE command_id = $1',
    [commandId]
  )).rows[0];
  console.log(`  Cloud Command Final Status: ${ackedRow?.status} (acked_at: ${ackedRow?.acked_at})`);

  // --------------------------------------------------------------------------
  // STEP 6: PUBLISH AUTHORITATIVE SNAPSHOT (CLOUD REFLECTED / CONFIRMED)
  // --------------------------------------------------------------------------
  console.log('\n--- 6. PUBLISHING AUTHORITATIVE SNAPSHOT TO CLOUD MIRROR ---');
  const snapResult = await publishAuthoritativeInventorySnapshot();
  lifecycle.push('CLOUD REFLECTED / CONFIRMED');
  console.log(`  ✓ Lifecycle Step 5: CLOUD REFLECTED / CONFIRMED (Snapshot: ${snapResult.snapshot_id}, Seq: ${snapResult.snapshot_seq})`);

  // --------------------------------------------------------------------------
  // STEP 7: VERIFY LOCAL POSTGRESQL STATE
  // --------------------------------------------------------------------------
  console.log('\n--- 7. VERIFYING LOCAL SHOP 2 POSTGRESQL STATE ---');
  const updatedItemRow = (await localPool.query(`
    SELECT m.id AS medicine_id, m.name, m.current_stock, m.stock_version AS med_stock_version,
           b.id AS batch_id, b.quantity_available, b.stock_version AS batch_stock_version
    FROM medicines m
    JOIN medicine_batches b ON b.medicine_id = m.id
    WHERE m.id = $1 AND b.id = $2
  `, [testMedId, testBatchId])).rows[0];

  const finalLocalQty = Number(updatedItemRow.quantity_available);
  const finalLocalStock = Number(updatedItemRow.current_stock);
  const stockVersionAfter = Number(updatedItemRow.batch_stock_version);

  console.log(`  Final Local Batch Available: ${finalLocalQty} (Expected: 15)`);
  console.log(`  Final Local Medicine Stock:  ${finalLocalStock} (Expected: 15)`);
  console.log(`  Stock Version Advanced:      ${actualStockVersionBefore} -> ${stockVersionAfter}`);

  // Verify Audit Log entry exists
  const auditRow = (await localPool.query(`
    SELECT id, action, entity, entity_id, new_value, created_at
    FROM audit_logs
    WHERE (new_value::text LIKE '%' || $1 || '%')
    ORDER BY created_at DESC LIMIT 1
  `, [commandId])).rows[0];

  const auditExists = Boolean(auditRow);
  console.log(`  Audit Entry Exists:          ${auditExists ? 'YES' : 'NO'}`);
  if (auditRow) {
    console.log(`  Audit Action:                ${auditRow.action} (${auditRow.entity} ${auditRow.entity_id})`);
  }

  // --------------------------------------------------------------------------
  // STEP 8: VERIFY CLOUD MIRROR & PARITY
  // --------------------------------------------------------------------------
  console.log('\n--- 8. VERIFYING CLOUD MIRROR & PARITY ---');
  const cloudStockAfter = Number((await cloudClient.query(
    'SELECT last_reported_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2',
    [shop2Id, testBatchId]
  )).rows[0]?.last_reported_quantity || 0);

  const parity = await checkInventoryParity();
  console.log(`  Final Cloud Batch Quantity:  ${cloudStockAfter} (Expected: 15)`);
  console.log(`  Local Fingerprint:           ${parity.local_fingerprint}`);
  console.log(`  Cloud Fingerprint:           ${parity.cloud_fingerprint}`);
  console.log(`  Parity Status:               ${parity.parity} (In Sync: ${parity.in_sync})`);

  // --------------------------------------------------------------------------
  // STEP 9: VERIFY SHOP 1 IS COMPLETELY UNCHANGED
  // --------------------------------------------------------------------------
  console.log('\n--- 9. VERIFYING SHOP 1 IS COMPLETELY UNCHANGED ---');
  const shop1MedCountAfter = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1BatchCountAfter = Number((await cloudClient.query(
    'SELECT COUNT(*)::int AS count FROM giga_cloud.medicine_batches WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].count);

  const shop1TotalStockAfter = Number((await cloudClient.query(
    'SELECT COALESCE(SUM(last_reported_quantity), 0)::bigint AS total FROM giga_cloud.stock_levels WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0].total);

  const shop1ShopRowAfter = (await cloudClient.query(
    'SELECT shop_snapshot_seq, inventory_fingerprint FROM giga_cloud.shops WHERE shop_id = $1',
    [SHOP1_ID]
  )).rows[0];

  const shop1Unchanged = (
    shop1MedCount === shop1MedCountAfter &&
    shop1BatchCount === shop1BatchCountAfter &&
    shop1TotalStock === shop1TotalStockAfter &&
    shop1ShopRow.shop_snapshot_seq === shop1ShopRowAfter.shop_snapshot_seq &&
    shop1ShopRow.inventory_fingerprint === shop1ShopRowAfter.inventory_fingerprint
  );

  console.log(`  Shop 1 Medicines:   ${shop1MedCount} -> ${shop1MedCountAfter} (${shop1MedCount === shop1MedCountAfter ? 'MATCH' : 'DIFF'})`);
  console.log(`  Shop 1 Batches:     ${shop1BatchCount} -> ${shop1BatchCountAfter} (${shop1BatchCount === shop1BatchCountAfter ? 'MATCH' : 'DIFF'})`);
  console.log(`  Shop 1 Stock:       ${shop1TotalStock} -> ${shop1TotalStockAfter} (${shop1TotalStock === shop1TotalStockAfter ? 'MATCH' : 'DIFF'})`);
  console.log(`  Shop 1 Snapshot:    Seq ${shop1ShopRow.shop_snapshot_seq} -> ${shop1ShopRowAfter.shop_snapshot_seq}`);
  console.log(`  Shop 1 Unchanged:   ${shop1Unchanged ? 'YES (100% UNTOUCHED)' : 'NO (CHANGED!)'}`);

  // --------------------------------------------------------------------------
  // STEP 10: OVERALL RESULT
  // --------------------------------------------------------------------------
  const pass = (
    finalLocalQty === 15 &&
    finalLocalStock === 15 &&
    cloudStockAfter === 15 &&
    auditExists &&
    stockVersionAfter > actualStockVersionBefore &&
    applyResult.status === 'APPLIED' &&
    ackedRow?.status === 'APPLIED' &&
    parity.in_sync &&
    parity.parity === 'MATCH' &&
    shop1Unchanged
  );

  console.log('\n======================================================================');
  console.log(`  TEST 1 FINAL RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  console.log('======================================================================\n');

  console.log('--- STRUCTURED REPORT ---');
  console.log('TEST 1 — REMOTE ADD STOCK\n');
  console.log(`SHOP2 medicine:      ${testMedId}`);
  console.log(`SHOP2 batch:         ${testBatchId}`);
  console.log(`starting local qty:  ${actualLocalBefore}`);
  console.log(`requested addition:  ${requestedAddition}`);
  console.log(`final local qty:     ${finalLocalQty}`);
  console.log(`final cloud qty:     ${cloudStockAfter}`);
  console.log(`command status:      ${lifecycle.join(' -> ')}`);
  console.log(`audit:               ${auditExists ? 'RECORDED' : 'MISSING'}`);
  console.log(`stock version:       v${actualStockVersionBefore} -> v${stockVersionAfter}`);
  console.log(`SHOP1 before:        ${shop1TotalStock} units (${shop1MedCount} meds, ${shop1BatchCount} batches, seq ${shop1ShopRow?.shop_snapshot_seq})`);
  console.log(`SHOP1 after:         ${shop1TotalStockAfter} units (${shop1MedCountAfter} meds, ${shop1BatchCountAfter} batches, seq ${shop1ShopRowAfter?.shop_snapshot_seq})`);
  console.log(`SHOP1 unchanged:     ${shop1Unchanged ? 'YES' : 'NO'}`);
  console.log(`parity:              ${parity.parity}`);
  console.log(`RESULT:              ${pass ? 'PASS' : 'FAIL'}`);

  await localPool.end();
  await cloudClient.end();

  if (!pass) process.exit(1);
}

main().catch(err => {
  console.error('Test 1 failed with error:', err);
  process.exit(1);
});
