import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

import { checkInventoryParity, publishAuthoritativeInventorySnapshot } from '../../server/sync/inventorySnapshot';
import { getShopIdentity } from '../../server/sync/identity';

async function main() {
  const localPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const CLOUD_URL = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
  const cloudClient = new pg.Client({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false } });
  await cloudClient.connect();

  const identity = await getShopIdentity();
  const shopId = identity.shop_id;
  const medId = '751ea76d-8512-4071-b730-595e6aa318e9';

  console.log('=== VERIFYING TEST ITEM STATUS AND FINAL AUTHORITATIVE SNAPSHOT ===');

  const localMed = (await localPool.query('SELECT id, name, status FROM medicines WHERE id = $1', [medId])).rows[0];
  const cloudMed = (await cloudClient.query('SELECT medicine_id, name, status FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [shopId, medId])).rows[0];

  console.log('Local test item:', localMed);
  console.log('Cloud test item:', cloudMed);

  // Publish authoritative snapshot
  console.log('\nPublishing authoritative inventory snapshot...');
  const snapRes = await publishAuthoritativeInventorySnapshot();
  console.log('Snapshot result:', snapRes);

  // Parity check
  console.log('\nChecking parity...');
  const parity = await checkInventoryParity();
  console.log('Parity:', parity);

  // Verify DEVTEST inactive
  const devtest = (await cloudClient.query(
    "SELECT shop_id, name, active FROM giga_cloud.shops WHERE active = false"
  )).rows;
  console.log('\nDEVTEST shops in cloud:', devtest);

  await localPool.end();
  await cloudClient.end();
}

main().catch(console.error);
