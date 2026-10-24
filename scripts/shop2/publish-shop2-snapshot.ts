import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { getShopIdentity, reconcileShopIdentity } from '../../server/sync/identity';
import { getSyncConfig } from '../../server/sync/config';
import { callCloud } from '../../server/sync/cloudClient';
import { collectRuntimeStatus } from '../../server/sync/heartbeat';
import { publishAuthoritativeInventorySnapshot, checkInventoryParity } from '../../server/sync/inventorySnapshot';

const SHOP1_FORBIDDEN_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const EXPECTED_SHOP2_ID = '13bdb896-e243-4772-accf-b8609e1d977f';
const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  console.log('======================================================================');
  console.log('  STEPS 12, 13 & 14: SHOP 2 HEARTBEAT & AUTHORITATIVE SNAPSHOT PUBLICATION');
  console.log('======================================================================\n');

  // 1. Safety & Identity
  const reconErr = await reconcileShopIdentity();
  if (reconErr) throw new Error(`reconcileShopIdentity error: ${reconErr}`);

  const identity = await getShopIdentity();
  const cfg = getSyncConfig();

  if (identity.shop_id === SHOP1_FORBIDDEN_ID) {
    throw new Error('FATAL: Identity resolved to Shop 1 ID!');
  }
  if (identity.shop_id !== EXPECTED_SHOP2_ID || identity.shop_code !== 'SHOP2') {
    throw new Error(`FATAL: Unexpected identity: ${JSON.stringify(identity)}`);
  }

  console.log('--- 1. CONFIRMED LOCAL SHOP 2 IDENTITY ---');
  console.log(`  Shop ID:        ${identity.shop_id}`);
  console.log(`  Shop Code:      ${identity.shop_code}`);
  console.log(`  Shop Name:      ${identity.shop_name}`);
  console.log(`  Sync Mode:      ${cfg.mode}`);
  console.log(`  Worker Enabled: ${cfg.workerEnabled}`);
  console.log(`  Cloud URL:      ${cfg.cloudUrl}`);

  // 2. Send Heartbeat to Supabase
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
  console.log('  Heartbeat RPC Response:', hbResp);

  const cloudClient = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });
  await cloudClient.connect();

  const hbCheck = (await cloudClient.query(`
    SELECT shop_id, EXTRACT(EPOCH FROM (now() - reported_at))::int AS age_seconds, status
    FROM giga_cloud.shop_runtime_status
    WHERE shop_id = $1
  `, [identity.shop_id])).rows[0];

  console.log(`  Cloud Runtime Status Record:`);
  console.log(`    - Age:        ${hbCheck?.age_seconds} seconds ago`);
  console.log(`    - Is Online:  ${Number(hbCheck?.age_seconds) <= 60 ? 'YES [ONLINE IN VERCEL]' : 'NO'}`);
  if (!hbCheck || Number(hbCheck.age_seconds) > 60) {
    throw new Error('Heartbeat verification failed in cloud!');
  }

  // 3. Purge provisional cloud mirror data for SHOP2 ONLY before authoritative publish
  console.log('\n--- 3. PURGING PROVISIONAL SHOP 2 CLOUD MIRROR DATA ---');
  await cloudClient.query('DELETE FROM giga_cloud.stock_levels WHERE shop_id = $1', [identity.shop_id]);
  await cloudClient.query('DELETE FROM giga_cloud.medicine_batches WHERE shop_id = $1', [identity.shop_id]);
  await cloudClient.query('DELETE FROM giga_cloud.medicines WHERE shop_id = $1', [identity.shop_id]);
  console.log('  ✓ Purged provisional SHOP2 cloud mirror records.');

  // 4. Publish Authoritative Inventory Snapshot
  console.log('\n--- 4. PUBLISHING AUTHORITATIVE SHOP 2 INVENTORY SNAPSHOT ---');
  const pubRes = await publishAuthoritativeInventorySnapshot({ reason: 'Shop 2 Real Migration Authoritative Cutover Snapshot' });
  console.log('  Snapshot Dispatch Result:');
  console.log(`    - Snapshot ID:         ${pubRes.snapshot_id}`);
  console.log(`    - Sequence:            ${pubRes.snapshot_seq}`);
  console.log(`    - Fingerprint:         ${pubRes.fingerprint}`);
  console.log(`    - Medicines Count:     ${pubRes.medicines_count}`);
  console.log(`    - Batches Count:       ${pubRes.batches_count}`);
  console.log(`    - Ignored:             ${pubRes.ignored}`);

  // 5. Verify Parity MATCH
  console.log('\n--- 5. POST-PUBLISH PARITY VERIFICATION ---');
  const verifyResult = await checkInventoryParity({ autoReconcile: false });
  console.log(`    - Local Fingerprint:   ${verifyResult.local_fingerprint}`);
  console.log(`    - Cloud Fingerprint:   ${verifyResult.cloud_fingerprint}`);
  console.log(`    - Parity:              ${verifyResult.parity}`);
  console.log(`    - Fingerprints Equal:  ${verifyResult.local_fingerprint === verifyResult.cloud_fingerprint ? 'MATCH [100% PARITY]' : 'MISMATCH'}`);

  if (verifyResult.parity !== 'MATCH' || verifyResult.local_fingerprint !== verifyResult.cloud_fingerprint) {
    throw new Error(`Inventory parity mismatch: ${verifyResult.parity}`);
  }

  // 6. Cloud counts check for SHOP2
  const s2Meds = Number((await cloudClient.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicines WHERE shop_id = $1', [identity.shop_id])).rows[0].cnt);
  const s2Batches = Number((await cloudClient.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicine_batches WHERE shop_id = $1', [identity.shop_id])).rows[0].cnt);
  console.log(`\n  Shop 2 Cloud Database Counts:`);
  console.log(`    - Active Cloud Medicines: ${s2Meds} (Expected: 2,137) -> ${s2Meds === 2137 ? 'PASS' : 'FAIL'}`);
  console.log(`    - Active Cloud Batches:   ${s2Batches} (Expected: 2,137) -> ${s2Batches === 2137 ? 'PASS' : 'FAIL'}`);
  if (s2Meds !== 2137 || s2Batches !== 2137) {
    throw new Error(`Shop 2 cloud counts mismatch: Meds=${s2Meds}, Batches=${s2Batches}`);
  }

  // 7. Cross-Shop Safety Verification: Verify SHOP1 is completely untouched
  console.log('\n--- 6. CROSS-SHOP SAFETY AUDIT: VERIFY SHOP 1 UNTOUCHED ---');
  const s1Meds = Number((await cloudClient.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicines WHERE shop_id = $1', [SHOP1_FORBIDDEN_ID])).rows[0].cnt);
  const s1Batches = Number((await cloudClient.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicine_batches WHERE shop_id = $1', [SHOP1_FORBIDDEN_ID])).rows[0].cnt);
  const s1Shop = (await cloudClient.query('SELECT shop_id, shop_code, name, active, last_seen_at FROM giga_cloud.shops WHERE shop_id = $1', [SHOP1_FORBIDDEN_ID])).rows[0];

  console.log(`  Shop 1 Verification:`);
  console.log(`    - Shop ID:             ${s1Shop.shop_id}`);
  console.log(`    - Shop Code:           ${s1Shop.shop_code}`);
  console.log(`    - Medicines Count:     ${s1Meds} (Baseline: 2,187) -> ${s1Meds === 2187 ? 'PASS [UNTOUCHED]' : 'FAIL'}`);
  console.log(`    - Batches Count:       ${s1Batches} (Baseline: 2,243) -> ${s1Batches === 2243 ? 'PASS [UNTOUCHED]' : 'FAIL'}`);

  if (s1Meds !== 2187 || s1Batches !== 2243) {
    throw new Error('CRITICAL SAFETY VIOLATION: Shop 1 cloud records were altered!');
  }

  await cloudClient.end();

  console.log('\n======================================================================');
  console.log('✓ SHOP 2 SNAPSHOT PUBLISHED & VERIFIED WITH 100% CLOUD PARITY');
  console.log('======================================================================\n');
}

main().catch(err => {
  console.error('\n[SNAPSHOT PUBLICATION FAILED]:', err.message);
  process.exit(1);
});
