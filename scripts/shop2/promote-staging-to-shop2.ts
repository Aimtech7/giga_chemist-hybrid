import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SHOP1_FORBIDDEN_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const SOURCE_STAGING_DB = 'giga_chemist_shop2_legacy_stage';
const TARGET_PRODUCTION_DB = 'giga_chemist_shop2';
const EXPECTED_SHOP_CODE = 'SHOP2';
const EXPECTED_SHOP_ID = '13bdb896-e243-4772-accf-b8609e1d977f';
const SHOP2_BRANCH_ID = '00000000-0000-0000-0000-000000000002';

const pgHost = process.env.DB_HOST || '127.0.0.1';
const pgPort = Number(process.env.DB_PORT) || 5432;
const pgUser = process.env.DB_USER || 'postgres';
const pgPassword = process.env.DB_PASSWORD || '7031';
const pgBinDir = 'C:\\Program Files\\PostgreSQL\\18\\bin';

function runProc(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('error', reject);
    p.on('close', code => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function main() {
  console.log('======================================================================');
  console.log('  STEP 9: CONTROLLED PROMOTION OF VALIDATED STAGING DATA TO SHOP 2');
  console.log(`  Source: ${SOURCE_STAGING_DB}`);
  console.log(`  Target: ${TARGET_PRODUCTION_DB}`);
  console.log('======================================================================\n');

  // 1. Safety Guards
  if (process.env.SHOP_ID?.toLowerCase() === SHOP1_FORBIDDEN_ID.toLowerCase()) {
    throw new Error('CRITICAL FATAL: Shop 1 ID detected in environment! Aborting.');
  }
  if (process.env.DB_NAME !== TARGET_PRODUCTION_DB) {
    throw new Error(`DB_NAME must be '${TARGET_PRODUCTION_DB}' (currently: '${process.env.DB_NAME}')`);
  }

  // 2. Verify pre-cutover backup exists
  const backupFile = path.resolve('backups', 'shop2-pre-real-data-cutover-20261023.backup');
  if (!fs.existsSync(backupFile)) {
    throw new Error(`CRITICAL: Pre-cutover backup missing: ${backupFile}`);
  }
  const bSize = fs.statSync(backupFile).size;
  if (bSize === 0) {
    throw new Error('CRITICAL: Pre-cutover backup file is 0 bytes!');
  }
  console.log(`✓ Confirmed existing pre-cutover backup: ${backupFile} (${(bSize / 1024).toFixed(1)} KB)`);

  // 3. Connect to Staging and verify readiness
  const stagingClient = new pg.Client({
    host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: SOURCE_STAGING_DB,
  });
  await stagingClient.connect();
  const stMeds = (await stagingClient.query('SELECT count(*)::int AS cnt FROM medicines')).rows[0].cnt;
  const stSales = (await stagingClient.query('SELECT count(*)::int AS cnt FROM sales')).rows[0].cnt;
  const stMovements = (await stagingClient.query('SELECT count(*)::int AS cnt FROM inventory_movements')).rows[0].cnt;
  await stagingClient.end();

  if (stMeds !== 2326 || stSales !== 102131 || stMovements !== 222629) {
    throw new Error(`Staging database numbers invalid (Meds: ${stMeds}, Sales: ${stSales}, Movements: ${stMovements})`);
  }
  console.log(`✓ Validated source staging dataset: 2,326 medicines, 102,131 sales, 222,629 movements`);

  // 4. Connect to Target giga_chemist_shop2 and capture identity
  const targetClient = new pg.Client({
    host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: TARGET_PRODUCTION_DB,
  });
  await targetClient.connect();

  const idCheck = await targetClient.query('SELECT * FROM shop_identity WHERE id = 1');
  const existingIdentity = idCheck.rows[0];
  if (!existingIdentity || existingIdentity.shop_code !== EXPECTED_SHOP_CODE || existingIdentity.shop_id !== EXPECTED_SHOP_ID) {
    throw new Error(`Target database identity mismatch: ${JSON.stringify(existingIdentity)}`);
  }
  console.log(`✓ Confirmed target shop identity: ${existingIdentity.shop_code} (${existingIdentity.shop_id})`);

  // Capture existing admin users to preserve logins
  const existingUsers = (await targetClient.query("SELECT * FROM users WHERE role = 'ADMIN'")).rows;
  console.log(`✓ Captured ${existingUsers.length} admin user(s) to preserve`);

  // 5. Dump validated tables from staging
  console.log('\nExporting validated business data from staging database...');
  const dumpFile = path.resolve('backups', 'temp-staging-data-promotion.dump');
  if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);

  const pgDumpExe = path.join(pgBinDir, 'pg_dump.exe');
  const pgRestoreExe = path.join(pgBinDir, 'pg_restore.exe');

  const businessTables = [
    'categories', 'suppliers', 'customers',
    'medicines', 'medicine_batches', 'purchases', 'purchase_items',
    'sales', 'sale_items', 'payments', 'inventory_movements'
  ];

  const dumpArgs = [
    '-h', pgHost,
    '-p', String(pgPort),
    '-U', pgUser,
    '-d', SOURCE_STAGING_DB,
    '-F', 'c',
    '-b',
    '-a', // data only
    '-f', dumpFile,
  ];
  for (const t of businessTables) {
    dumpArgs.push('-t', t);
  }

  const dumpRes = await runProc(pgDumpExe, dumpArgs, { PGPASSWORD: pgPassword });
  if (dumpRes.code !== 0 || !fs.existsSync(dumpFile)) {
    throw new Error(`pg_dump failed: ${dumpRes.stderr || dumpRes.stdout}`);
  }
  console.log(`✓ Dumped staging data archive: ${(fs.statSync(dumpFile).size / 1024 / 1024).toFixed(2)} MB`);

  // 6. Truncate business tables in giga_chemist_shop2
  console.log('\nTruncating provisional data from giga_chemist_shop2...');
  await targetClient.query(`
    TRUNCATE TABLE 
      inventory_movements, 
      payments, 
      sale_items, 
      sales, 
      purchase_items, 
      purchases, 
      medicine_batches, 
      medicines, 
      customers, 
      suppliers, 
      categories 
    CASCADE;
  `);
  console.log('✓ Target business tables truncated.');

  // 7. Restore data into giga_chemist_shop2
  console.log('\nRestoring validated business data into giga_chemist_shop2...');
  const restoreArgs = [
    '-h', pgHost,
    '-p', String(pgPort),
    '-U', pgUser,
    '-d', TARGET_PRODUCTION_DB,
    '--data-only',
    '--disable-triggers',
    dumpFile,
  ];

  const restoreRes = await runProc(pgRestoreExe, restoreArgs, { PGPASSWORD: pgPassword });
  // Note: pg_restore can exit with 0 or 1 (warnings on disable-triggers/session_replication_role)
  if (restoreRes.code > 1) {
    throw new Error(`pg_restore failed with code ${restoreRes.code}: ${restoreRes.stderr}`);
  }
  console.log(`✓ Business data restored into ${TARGET_PRODUCTION_DB}.`);

  // Clean up temporary dump
  if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);

  // 8. Copy staff users from staging into target without overwriting existing admins
  console.log('\nSynchronizing locked staff user identities...');
  const stagingUsersClient = new pg.Client({
    host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: SOURCE_STAGING_DB,
  });
  await stagingUsersClient.connect();
  const stUsers = (await stagingUsersClient.query('SELECT * FROM users')).rows;
  await stagingUsersClient.end();

  for (const u of stUsers) {
    await targetClient.query(`
      INSERT INTO users (
        id, branch_id, name, email, role, phone, active, password_hash, pin_hash, salt
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (email) DO NOTHING
    `, [
      u.id, SHOP2_BRANCH_ID, u.name, u.email, u.role, u.phone, u.active, u.password_hash, u.pin_hash, u.salt
    ]);
  }

  // Ensure preserved admin users remain active
  await targetClient.query("UPDATE users SET active = TRUE WHERE role = 'ADMIN'");

  // 9. Reassert Shop 2 identity and branch
  console.log('\nReasserting Shop 2 identity and branch references...');
  await targetClient.query(`
    INSERT INTO branches (id, code, name, address, phone, is_main_branch, active)
    VALUES ($1, 'SHOP2', 'GIGA CHEMIST - SHOP 2', 'Shop 2 Branch, Kitale, Kenya', '+254 700 000 002', FALSE, TRUE)
    ON CONFLICT (id) DO UPDATE SET
      code = 'SHOP2',
      name = 'GIGA CHEMIST - SHOP 2',
      active = TRUE
  `, [SHOP2_BRANCH_ID]);

  await targetClient.query(`
    INSERT INTO shop_identity (id, shop_id, shop_code, shop_name, branch_id)
    VALUES (1, $1, 'SHOP2', 'GIGA CHEMIST - SHOP 2', $2)
    ON CONFLICT (id) DO UPDATE SET
      shop_id = EXCLUDED.shop_id,
      shop_code = EXCLUDED.shop_code,
      shop_name = EXCLUDED.shop_name,
      branch_id = EXCLUDED.branch_id
  `, [EXPECTED_SHOP_ID, SHOP2_BRANCH_ID]);

  // 10. Post-promotion deep validation on giga_chemist_shop2
  console.log(`\n======================================================================`);
  console.log(`  POST-PROMOTION VERIFICATION ON ${TARGET_PRODUCTION_DB}`);
  console.log(`======================================================================`);

  const expectedCounts: Record<string, number> = {
    categories: 572,
    suppliers: 5,
    customers: 1,
    medicines: 2326,
    medicine_batches: 2326,
    sales: 102131,
    sale_items: 185378,
    payments: 101927,
    purchases: 443,
    purchase_items: 1458,
    inventory_movements: 222629,
  };

  for (const [table, expected] of Object.entries(expectedCounts)) {
    const actual = Number((await targetClient.query(`SELECT count(*)::int AS cnt FROM "${table}"`)).rows[0].cnt);
    const ok = actual === expected;
    console.log(`  - ${table.padEnd(20)}: ${actual.toLocaleString().padStart(8)} (Expected: ${expected.toLocaleString().padStart(8)}) -> ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error(`Integrity check failed: ${table} count is ${actual}, expected ${expected}`);
  }

  // Stock Invariant check
  const stockRes = (await targetClient.query(`
    SELECT 
      SUM(m.current_stock)::bigint AS med_stock,
      SUM(b.quantity_available)::bigint AS batch_stock
    FROM medicines m
    JOIN medicine_batches b ON m.id = b.medicine_id
  `)).rows[0];
  const parityPass = stockRes.med_stock === stockRes.batch_stock && Number(stockRes.med_stock) === 62912;
  console.log(`\nStock Parity (Med=${stockRes.med_stock}, Batch=${stockRes.batch_stock}): ${parityPass ? 'PASS [100% BALANCED]' : 'FAIL'}`);
  if (!parityPass) throw new Error('Stock parity mismatch in target production database!');

  // Orphan checks
  const orphanSaleItems = (await targetClient.query('SELECT count(*)::int AS cnt FROM sale_items si LEFT JOIN sales s ON si.sale_id = s.id WHERE s.id IS NULL')).rows[0].cnt;
  const orphanPurchaseItems = (await targetClient.query('SELECT count(*)::int AS cnt FROM purchase_items pi LEFT JOIN purchases p ON pi.purchase_id = p.id WHERE p.id IS NULL')).rows[0].cnt;
  const orphanPayments = (await targetClient.query('SELECT count(*)::int AS cnt FROM payments p LEFT JOIN sales s ON p.sale_id = s.id WHERE s.id IS NULL')).rows[0].cnt;
  const orphanBatches = (await targetClient.query('SELECT count(*)::int AS cnt FROM medicine_batches b LEFT JOIN medicines m ON b.medicine_id = m.id WHERE m.id IS NULL')).rows[0].cnt;

  console.log(`Orphan checks:`);
  console.log(`  - orphanSaleItems:     ${orphanSaleItems}`);
  console.log(`  - orphanPurchaseItems: ${orphanPurchaseItems}`);
  console.log(`  - orphanPayments:      ${orphanPayments}`);
  console.log(`  - orphanBatches:       ${orphanBatches}`);

  if (orphanSaleItems > 0 || orphanPurchaseItems > 0 || orphanPayments > 0 || orphanBatches > 0) {
    throw new Error('Orphan records detected in target production database!');
  }

  await targetClient.end();
  console.log(`\n✓ TARGET DATABASE PROMOTION & VERIFICATION: 100% SUCCESSFUL.`);
}

main().catch(err => {
  console.error('\n[PROMOTION FAILED]:', err.message);
  process.exit(1);
});
