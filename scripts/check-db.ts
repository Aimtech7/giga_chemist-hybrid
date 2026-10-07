import pg from 'pg';
import dotenv from 'dotenv';
import { getAppMode, getDatabaseConnectionConfig, isSupabaseConfigured } from '../server/db/client.ts';

dotenv.config();

const { Client } = pg;

async function checkDatabase() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — Database Connectivity & Health Check');
  console.log('=============================================================\n');

  const appMode = getAppMode();
  console.log(`Configured Application Mode: [${appMode.toUpperCase()}]`);

  const dbConfig = getDatabaseConnectionConfig();

  if (dbConfig.connectionString) {
    try {
      const urlObj = new URL(dbConfig.connectionString);
      console.log(`Target Database Host:     ${urlObj.hostname}:${urlObj.port || '5432'}`);
      console.log(`Target Database Name:     ${urlObj.pathname.replace('/', '')}`);
      console.log(`Target Database User:     ${urlObj.username}`);
    } catch (e) {
      console.log('Using connection string format.');
    }
  } else {
    console.log(`Target Database Host:     ${dbConfig.host}:${dbConfig.port}`);
    console.log(`Target Database Name:     ${dbConfig.database}`);
    console.log(`Target Database User:     ${dbConfig.user}`);
  }

  const client = new Client(dbConfig);

  try {
    console.log('\nTesting connection to PostgreSQL server...');
    await client.connect();
    console.log('✓ Connected successfully to PostgreSQL!');

    const resVersion = await client.query('SELECT version();');
    console.log(`Server Version: ${resVersion.rows[0].version.split(',')[0]}`);

    const resTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tableNames = resTables.rows.map((r) => r.table_name);
    console.log(`\nFound ${tableNames.length} tables in public schema:`);
    tableNames.forEach((t) => console.log(`  - ${t}`));

    const requiredTables = [
      'users',
      'roles',
      'permissions',
      'devices',
      'medicines',
      'medicine_batches',
      'sales',
      'sale_items',
      'inventory_movements',
      'returns',
      'audit_logs',
      'settings',
      'sync_events',
      'shop_identity',
      'sync_inbound_commands',
      'sync_state',
    ];

    const missing = requiredTables.filter((t) => !tableNames.includes(t));
    if (missing.length > 0) {
      console.warn(`\n[WARNING] Missing expected schema tables (${missing.length}): ${missing.join(', ')}`);
      console.log('Run "npm run db:migrate" to apply the database schema.');
    } else {
      console.log('\n✓ All core schema tables are verified and present.');
    }

    // Columns the stock-management code writes; a missing one fails the check (see migration 007).
    const requiredColumns: [string, string][] = [
      ['inventory_movements', 'reason'],
      ['inventory_movements', 'date'],
      ['inventory_movements', 'movement_type'],
      ['medicine_batches', 'selling_price_override'],
      ['medicine_batches', 'expiry_status'],
      ['medicine_batches', 'updated_at'],
      ['medicines', 'version'],
      // Hybrid outbox (migration 013)
      ['sync_events', 'seq'],
      ['sync_events', 'shop_id'],
      ['sync_events', 'event_type'],
      ['sync_events', 'attempt_count'],
      ['sync_events', 'next_attempt_at'],
      ['sync_events', 'synced_at'],
      ['sync_events', 'last_error'],
    ];
    const colRes = await client.query(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const presentCols = new Set(colRes.rows.map((r) => r.col));
    const missingCols = requiredColumns.map(([t, c]) => `${t}.${c}`).filter((c) => !presentCols.has(c));
    if (missingCols.length > 0) {
      console.error(`\n[ERROR] Missing required columns: ${missingCols.join(', ')}`);
      console.log('Run "npm run db:migrate" (migrations 007 stock columns, 013 hybrid outbox).');
      await client.end();
      process.exit(1);
    }
    console.log('✓ Required stock-management columns are present.');

    const devRes = await client.query(`SELECT 1 FROM devices WHERE id = 'SERVER'`);
    if (devRes.rows.length === 0) {
      console.error('\n[ERROR] Backend device "SERVER" is missing from devices. Run "npm run db:migrate".');
      await client.end();
      process.exit(1);
    }
    console.log('✓ Backend device "SERVER" is registered.');

    const shop = await client.query('SELECT shop_id, shop_code FROM shop_identity WHERE id = 1');
    if (!shop.rows[0]) {
      console.error('\n[ERROR] Shop identity row is missing. Run "npm run db:migrate".');
      await client.end();
      process.exit(1);
    }
    console.log(`✓ Shop identity: ${shop.rows[0].shop_code} ${shop.rows[0].shop_id}`);
    const outbox = await client.query(
      `SELECT status, COUNT(*)::int AS n FROM sync_events GROUP BY status ORDER BY status`
    );
    console.log(`  Sync outbox: ${outbox.rows.length ? outbox.rows.map((r) => `${r.status}=${r.n}`).join(', ') : 'empty'}`);

    if (tableNames.includes('users')) {
      const userCount = await client.query('SELECT COUNT(*) FROM users;');
      console.log(`Total Registered Staff Users: ${userCount.rows[0].count}`);
    }

    if (tableNames.includes('medicines')) {
      const medCount = await client.query('SELECT COUNT(*) FROM medicines;');
      console.log(`Total Formulary Medicines:    ${medCount.rows[0].count}`);
    }

    await client.end();
    console.log('\n=============================================================');
    console.log('  DATABASE CHECK PASSED: Ready for local / production use');
    console.log('=============================================================');
    process.exit(0);
  } catch (err: any) {
    console.error('\n[DATABASE CONNECTION ERROR]:', err.message);
    console.log('\nTroubleshooting Checklist:');
    console.log('1. Is the PostgreSQL service running on the target machine?');
    console.log('2. Does the database exist? (e.g. CREATE DATABASE giga_chemist;)');
    console.log('3. Are credentials in DATABASE_URL correct?');
    console.log('4. Is port 5432 accessible?');
    await client.end().catch(() => {});
    process.exit(1);
  }
}

checkDatabase();
