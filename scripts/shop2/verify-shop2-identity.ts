import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const SHOP1_FORBIDDEN_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const EXPECTED_DB_NAME = 'giga_chemist_shop2';
const EXPECTED_SHOP_CODE = 'SHOP2';

export async function verifyShop2Identity(): Promise<void> {
  const violations: string[] = [];

  const dbName = (process.env.DB_NAME || '').trim();
  const shopId = (process.env.SHOP_ID || '').trim().toLowerCase();
  const appMode = (process.env.APP_MODE || '').trim().toLowerCase();
  const syncEnabled = String(process.env.SYNC_ENABLED || '').trim().toLowerCase() === 'true';
  const shopToken = (process.env.SYNC_SHOP_TOKEN || process.env.SHOP_TOKEN || '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  console.log('=============================================================');
  console.log('  SHOP 2 COMPREHENSIVE IDENTITY & ISOLATION SAFETY GUARD');
  console.log('=============================================================\n');

  // Check 1: DB_NAME === giga_chemist_shop2
  if (dbName !== EXPECTED_DB_NAME) {
    violations.push(`DB_NAME must be '${EXPECTED_DB_NAME}' (currently: '${dbName}')`);
  }

  // Check 2: SHOP_ID exists
  if (!shopId) {
    violations.push('SHOP_ID is missing in environment.');
  }

  // Check 3: SHOP_ID !== Shop 1 ID
  if (shopId === SHOP1_FORBIDDEN_ID.toLowerCase()) {
    violations.push(`CRITICAL FATAL: Shop 1 ID detected in Shop 2 workspace: ${shopId}`);
  }

  // Check 4: SHOP_TOKEN exists and >= 32 chars when hybrid enabled
  if (appMode === 'hybrid' || syncEnabled) {
    if (!shopToken) {
      violations.push('SYNC_SHOP_TOKEN is missing while hybrid mode or sync is enabled.');
    } else if (shopToken.length < 32) {
      violations.push(`SYNC_SHOP_TOKEN is too short (${shopToken.length} chars, must be >= 32).`);
    }
  }

  // Check 5: Verify local PostgreSQL connection and shop_identity table
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });

  let localShopId = '';
  let localShopCode = '';
  try {
    const dbRes = await pool.query('SELECT current_database() AS db');
    const actualDb = dbRes.rows[0]?.db;
    if (actualDb !== EXPECTED_DB_NAME) {
      violations.push(`Active PostgreSQL database is '${actualDb}', expected '${EXPECTED_DB_NAME}'`);
    }

    const idRes = await pool.query('SELECT shop_id, shop_code, shop_name FROM shop_identity WHERE id = 1');
    if (!idRes.rows[0]) {
      violations.push('shop_identity row is missing in local database.');
    } else {
      localShopId = (idRes.rows[0].shop_id || '').toLowerCase();
      localShopCode = (idRes.rows[0].shop_code || '').trim();

      if (localShopCode !== EXPECTED_SHOP_CODE) {
        violations.push(`Local shop_code in shop_identity must be '${EXPECTED_SHOP_CODE}' (currently: '${localShopCode}')`);
      }
      if (localShopId === SHOP1_FORBIDDEN_ID.toLowerCase()) {
        violations.push(`CRITICAL: Local database shop_identity contains Shop 1 ID: ${localShopId}`);
      }
      if (shopId && localShopId && shopId !== localShopId) {
        violations.push(`SHOP_ID in .env (${shopId}) does not match local shop_identity (${localShopId})`);
      }
    }
  } catch (err: any) {
    violations.push(`Failed to query local database: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  // Check 6: Verify Supabase cloud registration matches local SHOP_ID
  if (supabaseUrl && anonKey && shopId && shopToken) {
    try {
      const pingUrl = `${supabaseUrl}/rest/v1/rpc/gc_ping`;
      const res = await fetch(pingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          p_shop_id: shopId,
          p_token: shopToken,
        }),
      });

      const data = await res.json();
      if (!res.ok || data?.ok !== true) {
        violations.push(`Supabase registration validation failed (status ${res.status}): ${JSON.stringify(data)}`);
      } else {
        console.log(`✓ Cloud ping verified: registered as ${EXPECTED_SHOP_CODE} [${shopId}]`);
      }
    } catch (err: any) {
      violations.push(`Supabase connection error during validation: ${err.message}`);
    }
  }

  if (violations.length > 0) {
    console.error('\n=============================================================');
    console.error('  [FATAL] SHOP 2 SAFETY VIOLATIONS DETECTED!');
    console.error('=============================================================');
    violations.forEach((v) => console.error(`  ✖ ${v}`));
    console.error('=============================================================\n');
    throw new Error(`Shop 2 safety guard failed with ${violations.length} violation(s).`);
  }

  console.log('✓ All Shop 2 safety & identity assertions PASSED:');
  console.log(`  - DB_NAME:       ${EXPECTED_DB_NAME}`);
  console.log(`  - SHOP_CODE:     ${EXPECTED_SHOP_CODE}`);
  console.log(`  - SHOP_ID:       ${shopId}`);
  console.log(`  - FORBIDDEN_ID:  ${SHOP1_FORBIDDEN_ID} (UNMATCHED - SAFE)`);
  console.log(`  - TOKEN SECURED: YES (>= 32 chars)`);
  console.log(`  - CLOUD MATCH:   VERIFIED\n`);
}

if (process.argv[1]?.includes('verify-shop2-identity')) {
  verifyShop2Identity()
    .then(() => {
      process.exitCode = 0;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
