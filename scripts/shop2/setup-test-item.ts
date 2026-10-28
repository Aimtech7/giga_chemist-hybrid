import crypto from 'crypto';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

import { getShopIdentity } from '../../server/sync/identity';
import { publishAuthoritativeInventorySnapshot, checkInventoryParity } from '../../server/sync/inventorySnapshot';

const CLOUD_URL = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  console.log('======================================================================');
  console.log('  SHOP 2 — SETUP DISPOSABLE REMOTE TEST MEDICINE & BATCH');
  console.log('======================================================================\n');

  const localPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cloudClient = new pg.Client({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false } });
  await cloudClient.connect();

  const identity = await getShopIdentity();
  const shop2Id = identity.shop_id;

  console.log(`Operating Shop: [${identity.shop_code}] ${identity.shop_name} (${shop2Id})`);

  // Check if test item already exists
  const existing = await localPool.query(`
    SELECT m.id AS medicine_id, m.name, m.current_stock, m.selling_price, m.purchase_price, m.stock_version,
           b.id AS batch_id, b.batch_number, b.quantity_available, b.status AS batch_status
    FROM medicines m
    LEFT JOIN medicine_batches b ON b.medicine_id = m.id
    WHERE m.name = 'SHOP2 REMOTE TEST ITEM'
  `);

  let medicineId: string;
  let batchId: string;

  if (existing.rows.length > 0 && existing.rows[0].batch_id) {
    const row = existing.rows[0];
    medicineId = row.medicine_id;
    batchId = row.batch_id;
    console.log(`✓ Existing test item found:`);
    console.log(`  - Medicine ID: ${medicineId}`);
    console.log(`  - Batch ID:    ${batchId}`);
    console.log(`  - Local Current Stock: ${row.current_stock}`);
    console.log(`  - Batch Available:     ${row.quantity_available}`);

    // Reset to starting quantity 10 if needed
    if (Number(row.quantity_available) !== 10 || Number(row.current_stock) !== 10) {
      console.log('Resetting quantities to 10 for test preparation...');
      await localPool.query('UPDATE medicines SET current_stock = 10, status = $1, stock_version = stock_version + 1 WHERE id = $2', ['active', medicineId]);
      await localPool.query('UPDATE medicine_batches SET quantity_available = 10, quantity_received = 10, status = $1, stock_version = stock_version + 1 WHERE id = $2', ['active', batchId]);
    }
  } else {
    medicineId = crypto.randomUUID();
    batchId = crypto.randomUUID();
    const barcode = `TEST-SHOP2-${Date.now().toString().slice(-6)}`;

    console.log('Creating new disposable test medicine and batch in SHOP2 local DB...');
    await localPool.query(`
      INSERT INTO medicines (
        id, name, generic_name, sku, barcode, description, dosage_strength, dosage_form, unit,
        current_stock, purchase_price, selling_price, status, version, stock_version
      ) VALUES (
        $1, 'SHOP2 REMOTE TEST ITEM', 'Shop2 Test Molecule', 'SKU-SHOP2-TEST', $2, 'Temporary test medicine for remote operations',
        '500mg', 'Tablet', 'Tablet',
        10, 50.00, 100.00, 'active', 1, 1
      )
    `, [medicineId, barcode]);

    await localPool.query(`
      INSERT INTO medicine_batches (
        id, medicine_id, batch_number, expiry_date, quantity_received, quantity_available,
        purchase_price, status, stock_version
      ) VALUES (
        $1, $2, 'B-SHOP2-001', '2028-12-31', 10, 10,
        50.00, 'active', 1
      )
    `, [batchId, medicineId]);

    console.log(`✓ Created test medicine: ${medicineId} with batch ${batchId}`);
  }

  // Publish authoritative mirror to cloud
  console.log('Publishing authoritative snapshot to cloud mirror...');
  const snapResult = await publishAuthoritativeInventorySnapshot();
  console.log(`✓ Snapshot published: ${snapResult.snapshot_id} (Fingerprint: ${snapResult.fingerprint})`);

  // Verify in cloud mirror
  const cloudMed = (await cloudClient.query(
    'SELECT medicine_id, name, selling_price FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2',
    [shop2Id, medicineId]
  )).rows[0];

  const cloudStock = (await cloudClient.query(
    'SELECT batch_id, last_reported_quantity, baseline_quantity FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2',
    [shop2Id, batchId]
  )).rows[0];

  const parity = await checkInventoryParity();

  console.log('\n--- TEST ITEM RECORD ---');
  console.log(`medicine_id:            ${medicineId}`);
  console.log(`batch_id:               ${batchId}`);
  console.log(`initial quantity:       10`);
  console.log(`initial retail price:   100.00`);
  console.log(`initial purchase price: 50.00`);
  console.log(`Cloud medicine name:    ${cloudMed?.name}`);
  console.log(`Cloud batch quantity:   ${cloudStock?.last_reported_quantity}`);
  console.log(`Parity Status:          ${parity.parity} (In Sync: ${parity.in_sync})`);

  await localPool.end();
  await cloudClient.end();
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
