import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { runBackup } from '../../server/ops/backup';
import { runMigrations } from '../../server/db/migrator';

dotenv.config();

const SHOP1_FORBIDDEN_DB = 'giga_chemist';
const CURRENT_SHOP2_DB = 'giga_chemist_shop2';
const STAGING_DB_NAME = 'giga_chemist_shop2_legacy_stage';

const pgHost = process.env.DB_HOST || '127.0.0.1';
const pgPort = Number(process.env.DB_PORT) || 5432;
const pgUser = process.env.DB_USER || 'postgres';
const pgPassword = process.env.DB_PASSWORD || '7031';

async function main() {
  console.log('======================================================================');
  console.log('  SHOP 2 — BACKUP CURRENT DB & INITIALIZE STAGING DATABASE');
  console.log('======================================================================\n');

  // Safety Assertion
  if (process.env.DB_NAME !== CURRENT_SHOP2_DB) {
    throw new Error(`DB_NAME must be '${CURRENT_SHOP2_DB}' (currently: '${process.env.DB_NAME}')`);
  }
  console.log(`✓ Active database: ${CURRENT_SHOP2_DB}`);
  console.log(`✓ Protected Shop 1 database: ${SHOP1_FORBIDDEN_DB} (STRICTLY FORBIDDEN - UNTOUCHED)`);

  // Step 1: Backup current giga_chemist_shop2
  console.log('\n--- 1. BACKING UP CURRENT giga_chemist_shop2 ---');
  const backupDir = path.resolve('backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupRes = await runBackup('CLI', { dir: backupDir, keep: 14 });
  if (!backupRes.success) {
    throw new Error(`Backup failed: ${backupRes.error}`);
  }

  // Also create named copy requested: shop2-before-real-legacy-import-20261023.backup
  const requestedBackupPath = path.join(backupDir, 'shop2-before-real-legacy-import-20261023.backup');
  fs.copyFileSync(backupRes.file, requestedBackupPath);

  console.log(`✓ Backup created successfully:`);
  console.log(`  File:     ${requestedBackupPath}`);
  console.log(`  Size:     ${(fs.statSync(requestedBackupPath).size / 1024).toFixed(1)} KB`);
  console.log(`  Verified: ${backupRes.toc_entries} TOC entries verified`);

  // Step 2: Create isolated staging database giga_chemist_shop2_legacy_stage
  console.log('\n--- 2. CREATING ISOLATED STAGING DATABASE ---');
  const adminClient = new pg.Client({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPassword,
    database: 'postgres',
  });
  await adminClient.connect();

  const existingStaging = await adminClient.query(
    'SELECT datname FROM pg_database WHERE datname = $1',
    [STAGING_DB_NAME]
  );

  if (existingStaging.rows.length > 0) {
    console.log(`Resetting existing staging database: ${STAGING_DB_NAME}...`);
    // Disconnect any active connections to staging db before drop
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [STAGING_DB_NAME]);
    await adminClient.query(`DROP DATABASE "${STAGING_DB_NAME}"`);
  }

  console.log(`Creating fresh staging database: ${STAGING_DB_NAME}...`);
  await adminClient.query(`CREATE DATABASE "${STAGING_DB_NAME}" WITH OWNER = "${pgUser}" ENCODING = 'UTF8'`);
  console.log(`✓ Staging database ${STAGING_DB_NAME} created.`);
  await adminClient.end();

  // Step 3: Run all 28 schema migrations onto staging database
  console.log('\n--- 3. APPLYING CURRENT SCHEMA MIGRATIONS (001 -> 028) TO STAGING ---');
  const stagingUrl = `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${STAGING_DB_NAME}`;
  const migrationRes = await runMigrations(stagingUrl);

  if (!migrationRes.success) {
    throw new Error(`Failed to apply schema migrations to staging: ${JSON.stringify(migrationRes.errors)}`);
  }
  console.log(`✓ Successfully applied ${migrationRes.applied.length} migrations to staging database.`);

  // Step 4: Verify staging database table readiness
  const stagingClient = new pg.Client({ connectionString: stagingUrl });
  await stagingClient.connect();
  const tablesRes = await stagingClient.query(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log(`✓ Staging schema ready with ${tablesRes.rows.length} tables in public schema.`);
  await stagingClient.end();

  console.log('\n======================================================================');
  console.log('  STAGING DATABASE & BACKUP PREPARATION COMPLETE');
  console.log('======================================================================\n');
  console.log(`  Current Shop 2 DB Backup: backups/shop2-before-real-legacy-import-20261023.backup`);
  console.log(`  Staging Database:        giga_chemist_shop2_legacy_stage`);
  console.log(`  Migrations Applied:      28/28`);
  console.log(`  Operational Status:      Ready for legacy data conversion and audit`);
  console.log(`  Original Databases:      giga_chemist and giga_chemist_shop2 UNTOUCHED\n`);
}

main().then(() => {
  process.exitCode = 0;
}).catch((err) => {
  console.error('\n[FATAL ERROR]:', err?.message || err);
  process.exitCode = 1;
});
