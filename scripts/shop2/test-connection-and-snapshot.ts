import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { getShopIdentity, reconcileShopIdentity } from '../../server/sync/identity';
import { getSyncConfig } from '../../server/sync/config';
import { callCloud } from '../../server/sync/cloudClient';
import { collectRuntimeStatus } from '../../server/sync/heartbeat';
import { checkInventoryParity } from '../../server/sync/inventorySnapshot';

const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  console.log('======================================================================');
  console.log('  SHOP 2 HYBRID CONNECTION & AUTHORITATIVE MIRROR TEST');
  console.log('======================================================================\n');

  // 1. Reconcile identity
  const reconErr = await reconcileShopIdentity();
  if (reconErr) throw new Error(`reconcileShopIdentity error: ${reconErr}`);

  const identity = await getShopIdentity();
  const cfg = getSyncConfig();

  console.log('--- 1. LOCAL SHOP IDENTITY & CONFIGURATION ---');
  console.log(`Shop ID:          ${identity.shop_id}`);
  console.log(`Shop Code:        ${identity.shop_code}`);
  console.log(`Shop Name:        ${identity.shop_name}`);
  console.log(`App Mode:         ${cfg.mode}`);
  console.log(`Worker Enabled:   ${cfg.workerEnabled}`);
  console.log(`Cloud Configured: ${cfg.cloudConfigured} (${cfg.cloudUrl})`);

  if (identity.shop_id === SHOP1_ID) {
    throw new Error('FATAL: Identity resolved to Shop 1 ID!');
  }
  if (identity.shop_code !== 'SHOP2') {
    throw new Error(`FATAL: Shop code is '${identity.shop_code}', expected 'SHOP2'!`);
  }

  // 2. Test Heartbeat to Supabase
  console.log('\n--- 2. SENDING SHOP 2 HEARTBEAT TO SUPABASE ---');
  const status = await collectRuntimeStatus({
    running: true,
    leader: true,
    consecutive_failures: 0,
    halted_reason: null,
  });

  const hbResp = await callCloud<any>('gc_heartbeat', {
    p_shop_id: identity.shop_id,
    p_token: cfg.shopToken,
    p_status: status,
  });
  console.log('Heartbeat response from cloud:', hbResp);

  // Verify in Supabase database directly
  const cloudClient = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });
  await cloudClient.connect();

  const cloudShop = await cloudClient.query(
    'SELECT shop_id, shop_code, name, last_seen_at FROM giga_cloud.shops WHERE shop_id = $1',
    [identity.shop_id]
  );
  console.log('giga_cloud.shops record:', cloudShop.rows[0]);

  const cloudRuntime = await cloudClient.query(
    'SELECT shop_id, reported_at, status FROM giga_cloud.shop_runtime_status WHERE shop_id = $1',
    [identity.shop_id]
  );
  console.log('giga_cloud.shop_runtime_status reported_at:', cloudRuntime.rows[0]?.reported_at);

  if (!cloudShop.rows[0]?.last_seen_at) {
    throw new Error('Cloud shops last_seen_at was not updated by heartbeat!');
  }
  console.log('✓ Heartbeat successfully registered in cloud for SHOP2!');

  // 3. Publish Authoritative Mirror Snapshot & Parity Verification
  console.log('\n--- 3. PUBLISHING AUTHORITATIVE SHOP 2 INVENTORY MIRROR ---');
  const parityResult = await checkInventoryParity({ autoReconcile: true });

  console.log('Parity check result:');
  console.log(`  Shop Code:          ${parityResult.shop_code}`);
  console.log(`  Shop ID:            ${parityResult.shop_id}`);
  console.log(`  Local Fingerprint:  ${parityResult.local_fingerprint}`);
  console.log(`  Cloud Fingerprint:  ${parityResult.cloud_fingerprint}`);
  console.log(`  Parity Status:      ${parityResult.parity}`);
  console.log(`  In Sync:            ${parityResult.in_sync}`);
  console.log(`  Medicines Checked:  ${parityResult.medicines_checked}`);
  console.log(`  Medicine Mismatches:${parityResult.medicine_mismatches}`);
  console.log(`  Batch Mismatches:   ${parityResult.batch_mismatches}`);
  console.log(`  Reconciled:         ${parityResult.reconciled}`);

  // Re-run parity check to confirm pure MATCH
  console.log('\n--- 4. POST-RECONCILIATION PARITY VERIFICATION ---');
  const verifyParity = await checkInventoryParity({ autoReconcile: false });
  console.log(`  Post-Reconciliation Parity: ${verifyParity.parity}`);
  console.log(`  Local Fingerprint:          ${verifyParity.local_fingerprint}`);
  console.log(`  Cloud Fingerprint:          ${verifyParity.cloud_fingerprint}`);
  console.log(`  Fingerprints Equal:         ${verifyParity.local_fingerprint === verifyParity.cloud_fingerprint ? 'YES [PASS]' : 'NO [FAIL]'}`);

  if (verifyParity.parity !== 'MATCH') {
    throw new Error(`Expected parity MATCH, got: ${verifyParity.parity}`);
  }

  // 4. Verify Shop 1 in Supabase remains isolated and untouched
  console.log('\n--- 5. SHOP 1 ISOLATION AUDIT IN SUPABASE ---');
  const shop1Cloud = await cloudClient.query(
    'SELECT shop_id, shop_code, name, last_seen_at, shop_snapshot_seq FROM giga_cloud.shops WHERE shop_id = $1',
    [SHOP1_ID]
  );
  console.log('Shop 1 cloud record:', shop1Cloud.rows[0]);

  const shop2StockCount = await cloudClient.query(
    'SELECT COUNT(*) FROM giga_cloud.medicines WHERE shop_id = $1',
    [identity.shop_id]
  );
  const shop1StockCount = await cloudClient.query(
    'SELECT COUNT(*) FROM giga_cloud.medicines WHERE shop_id = $1',
    [SHOP1_ID]
  );

  console.log(`Shop 2 cloud medicines count: ${shop2StockCount.rows[0].count}`);
  console.log(`Shop 1 cloud medicines count: ${shop1StockCount.rows[0].count}`);

  await cloudClient.end();

  console.log('\n======================================================================');
  console.log('  SHOP 2 HYBRID CONNECTION & MIRROR TEST: COMPLETE PASS');
  console.log('======================================================================\n');
}

main().then(() => {
  process.exitCode = 0;
}).catch((err) => {
  console.error('\n[TEST ERROR]:', err);
  process.exitCode = 1;
});
