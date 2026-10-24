import crypto from 'crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

dotenv.config();

const SHOP1_FORBIDDEN_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const TARGET_DB_NAME = 'giga_chemist_shop2';
const SOURCE_DB_NAME = 'giga_chemist';

const pgHost = process.env.DB_HOST || '127.0.0.1';
const pgPort = Number(process.env.DB_PORT) || 5432;
const pgUser = process.env.DB_USER || 'postgres';
const pgPassword = process.env.DB_PASSWORD || '7031';

async function copyTableRows(sourcePool: pg.Pool, targetClient: pg.PoolClient, tableName: string) {
  // Get intersecting columns between source and target table
  const colQuery = `
    SELECT column_name, is_nullable
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `;
  const srcColsRes = await sourcePool.query(colQuery, [tableName]);
  const tgtColsRes = await targetClient.query(colQuery, [tableName]);

  const tgtColsMap = new Map(tgtColsRes.rows.map(r => [r.column_name, r.is_nullable]));
  const commonCols = srcColsRes.rows.map(r => r.column_name).filter(c => tgtColsMap.has(c));

  if (commonCols.length === 0) {
    console.log(`Skipping ${tableName} (no common columns).`);
    return 0;
  }

  const colList = commonCols.map(c => `"${c}"`).join(', ');
  const srcRows = await sourcePool.query(`SELECT ${colList} FROM "${tableName}"`);

  if (srcRows.rows.length === 0) {
    console.log(`- ${tableName}: 0 rows in source.`);
    return 0;
  }

  const placeholders = commonCols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `
    INSERT INTO "${tableName}" (${colList})
    VALUES (${placeholders})
    ON CONFLICT DO NOTHING
  `;

  for (const row of srcRows.rows) {
    const values = commonCols.map(c => {
      let v = row[c];
      if (v === null && tgtColsMap.get(c) === 'NO') {
        if (c === 'salt') v = 'migrated_salt';
        else if (c === 'status') v = 'active';
        else if (c === 'version') v = 1;
        else if (c === 'stock_version') v = 1;
      }
      return v;
    });
    await targetClient.query(insertSql, values);
  }

  console.log(`✓ Copied ${srcRows.rows.length} rows into ${tableName}`);
  return srcRows.rows.length;
}

async function main() {
  console.log('======================================================================');
  console.log('  SHOP 2 DATABASE INITIALIZATION & SANITIZATION PIPELINE');
  console.log('======================================================================\n');

  // 1. Connect to default postgres database to check/create target database
  const adminClient = new pg.Client({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPassword,
    database: 'postgres',
  });

  await adminClient.connect();

  const dbRes = await adminClient.query('SELECT datname FROM pg_database WHERE datname = $1', [TARGET_DB_NAME]);
  if (dbRes.rows.length === 0) {
    console.log(`Creating database: ${TARGET_DB_NAME}...`);
    await adminClient.query(`CREATE DATABASE "${TARGET_DB_NAME}" WITH OWNER = "${pgUser}" ENCODING = 'UTF8'`);
    console.log(`✓ Database ${TARGET_DB_NAME} created successfully.`);
  } else {
    console.log(`Database ${TARGET_DB_NAME} already exists.`);
  }
  await adminClient.end();

  // 2. Connect to TARGET database and run schema migrations
  const targetPool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPassword,
    database: TARGET_DB_NAME,
  });

  const client = await targetPool.connect();

  console.log('\n--- 2. APPLYING SCHEMA MIGRATIONS (001 -> 028) ---');
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationsDir = path.resolve('migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
    if (rows.length === 0) {
      console.log(`Applying migration: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✓ Applied ${file}`);
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Failed to apply migration ${file}:`, err.message);
        throw err;
      }
    }
  }
  console.log('✓ All 28 schema migrations verified on target database.');

  // 3. Connect to SOURCE database (giga_chemist) - READ ONLY to copy master catalogue data
  console.log('\n--- 3. POPULATING MASTER / REFERENCE CATALOGUE FROM SHOP 1 TEMPLATE ---');
  const sourcePool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPassword,
    database: SOURCE_DB_NAME,
  });

  // Reference tables to copy in dependency order
  const refTables = [
    'branches',
    'categories',
    'suppliers',
    'customers',
    'roles',
    'permissions',
    'role_permissions',
    'users',
    'settings',
    'medicines',
    'medicine_batches',
  ];

  for (const t of refTables) {
    await copyTableRows(sourcePool, client, t);
  }

  await sourcePool.end();

  // 4. SANITIZE OPERATIONAL TABLES - Ensure Shop 2 has NO transaction history from Shop 1
  console.log('\n--- 4. SANITIZING OPERATIONAL TRANSACTION TABLES ---');
  const operationalTables = [
    'sales',
    'sale_items',
    'payments',
    'returns',
    'return_items',
    'purchases',
    'purchase_items',
    'inventory_movements',
    'cashier_shifts',
    'cashier_shift_corrections',
    'stocktakes',
    'stocktake_items',
    'price_history',
    'user_name_history',
    'audit_logs',
    'alerts',
    'sync_events',
    'sync_inbound_commands',
    'sync_state',
    'shop_inventory_snapshots',
  ];

  for (const t of operationalTables) {
    try {
      const res = await client.query(`SELECT to_regclass('public."${t}"') IS NOT NULL AS exists`);
      if (res.rows[0].exists) {
        await client.query(`TRUNCATE TABLE "${t}" CASCADE`);
        console.log(`✓ Sanitized / Emptied: ${t}`);
      }
    } catch (e: any) {
      console.warn(`Could not truncate ${t}: ${e.message}`);
    }
  }

  // 5. CONFIGURE SHOP 2 UNIQUE LOCAL IDENTITY
  console.log('\n--- 5. GENERATING UNIQUE SHOP 2 IDENTITY ---');
  const shop2Uuid = crypto.randomUUID();
  const shop2Token = crypto.randomBytes(32).toString('base64url');

  if (shop2Uuid === SHOP1_FORBIDDEN_ID) {
    throw new Error('FATAL: Collision with Shop 1 ID! Aborting.');
  }

  // Update branches: Ensure a branch for Shop 2 exists
  await client.query(`
    INSERT INTO branches (id, code, name, address, phone, is_main_branch, active)
    VALUES ('00000000-0000-0000-0000-000000000002', 'SHOP2', 'GIGA CHEMIST - SHOP 2', 'Shop 2 Branch, Kenya', '+254 700 000 002', FALSE, TRUE)
    ON CONFLICT (id) DO UPDATE SET
      code = 'SHOP2',
      name = 'GIGA CHEMIST - SHOP 2',
      active = TRUE
  `);

  await client.query(`
    INSERT INTO shop_identity (id, shop_id, shop_code, shop_name, branch_id)
    VALUES (1, $1, 'SHOP2', 'GIGA CHEMIST - SHOP 2', '00000000-0000-0000-0000-000000000002')
    ON CONFLICT (id) DO UPDATE SET
      shop_id = EXCLUDED.shop_id,
      shop_code = 'SHOP2',
      shop_name = 'GIGA CHEMIST - SHOP 2',
      branch_id = '00000000-0000-0000-0000-000000000002',
      updated_at = CURRENT_TIMESTAMP
  `, [shop2Uuid]);

  // Ensure SERVER device exists
  await client.query(`
    INSERT INTO devices (id, name, device_type, app_version, status)
    VALUES ('SERVER', 'Shop 2 Server', 'server', '1.0.0', 'active')
    ON CONFLICT (id) DO UPDATE SET
      name = 'Shop 2 Server',
      status = 'active'
  `);

  console.log('✓ Local shop_identity configured:');
  console.log(`  Shop ID:   ${shop2Uuid}`);
  console.log(`  Shop Code: SHOP2`);
  console.log(`  Shop Name: GIGA CHEMIST - SHOP 2`);
  console.log(`  Device:    SERVER (Shop 2 Server)`);

  client.release();
  await targetPool.end();

  // Save credentials to temporary JSON file in scratch directory so registration script can consume it
  const scratchDir = path.resolve('scratch');
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

  const credPath = path.join(scratchDir, 'shop2-identity.json');
  fs.writeFileSync(credPath, JSON.stringify({
    shop_id: shop2Uuid,
    shop_code: 'SHOP2',
    name: 'GIGA CHEMIST - SHOP 2',
    token: shop2Token,
    db_name: TARGET_DB_NAME,
  }, null, 2));

  console.log(`\nShop 2 identity configuration generated and saved to scratch/shop2-identity.json.`);
  console.log('DO NOT commit scratch/shop2-identity.json.');
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]:', err);
  process.exit(1);
});
