/**
 * Shop 2 Isolation and Safety Guard
 *
 * Verifies that the Shop 2 development environment is strictly isolated
 * and cannot accidentally touch Shop 1 databases, Shop 1 cloud records, or live cloud sync.
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const FORBIDDEN_SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const FORBIDDEN_DATABASES = ['giga_chemist', 'giga_chemist_dev'];

export async function assertShop2DevEnvironment(): Promise<void> {
  const appMode = (process.env.APP_MODE || '').toLowerCase().trim();
  const syncEnabled = (process.env.SYNC_ENABLED || '').toLowerCase().trim();
  const shopId = (process.env.SHOP_ID || '').toLowerCase().trim();
  const dbName = (process.env.DB_NAME || '').toLowerCase().trim();
  const dbUrl = (process.env.DATABASE_URL || '').toLowerCase().trim();

  const violations: string[] = [];

  // Check 1: Shop 1 ID guard
  if (shopId === FORBIDDEN_SHOP1_ID.toLowerCase()) {
    violations.push(`FATAL: Shop 1 ID detected in Shop 2 environment: ${shopId}`);
  }

  // Check 2: Database name guard
  if (FORBIDDEN_DATABASES.includes(dbName)) {
    violations.push(`FATAL: Shop 1 database name configured for Shop 2: ${dbName}`);
  }

  // Check 3: Database URL string check (strict word boundary to avoid matching shop2 suffix)
  for (const forbiddenDb of FORBIDDEN_DATABASES) {
    const regex = new RegExp(`[/=]${forbiddenDb}(?:[/?#]|$)`, 'i');
    if (regex.test(dbUrl)) {
      violations.push(`FATAL: DATABASE_URL points to Shop 1 database: ${forbiddenDb}`);
    }
  }

  // Check 4: Development mode must be local
  if (appMode !== 'local') {
    violations.push(`VIOLATION: Shop 2 development workspace must have APP_MODE=local (currently: ${appMode})`);
  }

  // Check 5: Sync must be disabled during development
  if (syncEnabled === 'true' || syncEnabled === '1') {
    violations.push(`VIOLATION: Shop 2 development workspace must have SYNC_ENABLED=false (currently: ${syncEnabled})`);
  }

  // Check 6: Query actual active PostgreSQL database to ensure safety
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });

  try {
    const res = await pool.query('SELECT current_database() as db');
    const actualDb = (res.rows[0]?.db || '').toLowerCase();
    if (FORBIDDEN_DATABASES.includes(actualDb)) {
      violations.push(`CRITICAL RUNTIME BREACH: Connected to forbidden Shop 1 database: ${actualDb}`);
    }
    if (actualDb !== 'giga_chemist_shop2_dev' && actualDb !== 'giga_chemist_shop2') {
      violations.push(`WARNING: Connected database '${actualDb}' is neither 'giga_chemist_shop2_dev' nor 'giga_chemist_shop2'`);
    }
  } catch (err: any) {
    violations.push(`Database connection failed: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  if (violations.length > 0) {
    console.error('\n=============================================================');
    console.error('  SHOP 2 SAFETY GUARD VIOLATIONS DETECTED!');
    console.error('=============================================================');
    violations.forEach((v) => console.error(`  - ${v}`));
    console.error('=============================================================\n');
    throw new Error(`Shop 2 safety guard failed with ${violations.length} violation(s).`);
  }

  console.log('[Shop2SafetyGuard] PASS: Shop 2 development environment is strictly isolated.');
  console.log('  - APP_MODE: local');
  console.log('  - SYNC_ENABLED: false');
  console.log('  - DATABASE: giga_chemist_shop2_dev');
  console.log('  - SHOP_1_LEAKAGE: NONE');
}

assertShop2DevEnvironment()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
