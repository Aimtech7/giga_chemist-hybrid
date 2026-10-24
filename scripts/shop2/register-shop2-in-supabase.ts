import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  console.log('======================================================================');
  console.log('  SHOP 2 SUPABASE CLOUD REGISTRATION');
  console.log('======================================================================\n');

  // 1. Read generated Shop 2 identity
  const credPath = path.resolve('scratch/shop2-identity.json');
  if (!fs.existsSync(credPath)) {
    throw new Error('scratch/shop2-identity.json not found! Run setup-shop2-db.ts first.');
  }

  const shop2Data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  const { shop_id, shop_code, name, token } = shop2Data;

  console.log(`Target Shop 2 ID:   ${shop_id}`);
  console.log(`Target Shop Code:   ${shop_code}`);
  console.log(`Target Shop Name:   ${name}`);
  console.log(`Token Length:       ${token.length} chars`);

  // Explicit safety check: Shop 2 ID MUST NOT equal Shop 1 ID
  if (shop_id === SHOP1_ID) {
    throw new Error('FATAL SAFETY VIOLATION: Shop 2 ID matches Shop 1 ID! Aborting immediately.');
  }
  console.log('✓ Safety check passed: Shop 2 ID !== Shop 1 ID.');

  // 2. Connect to Supabase Cloud Database
  const client = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('✓ Connected to Supabase Cloud PostgreSQL.');

  // Read Shop 1 row for verification (read-only)
  const shop1Res = await client.query('SELECT shop_id, shop_code, name, active, last_seen_at FROM giga_cloud.shops WHERE shop_id = $1', [SHOP1_ID]);
  if (shop1Res.rows.length === 0) {
    console.warn('[WARNING] Shop 1 not found in giga_cloud.shops!');
  } else {
    console.log(`✓ Verified Shop 1 status in cloud: [${shop1Res.rows[0].shop_code}] ${shop1Res.rows[0].name} (active: ${shop1Res.rows[0].active})`);
  }

  // 3. Call giga_cloud.register_shop(...)
  console.log('\nRegistering Shop 2 via giga_cloud.register_shop()...');
  await client.query('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop_id, shop_code, name, token]);
  console.log('✓ giga_cloud.register_shop executed.');

  // 4. Verify both shops in giga_cloud.shops
  const allShops = await client.query('SELECT shop_id, shop_code, name, active, created_at FROM giga_cloud.shops WHERE active ORDER BY shop_code');
  console.log('\nActive shops in giga_cloud.shops:');
  for (const s of allShops.rows) {
    console.log(`  - [${s.shop_code}] ${s.shop_id} | ${s.name} (active: ${s.active})`);
  }

  const shop2Cloud = allShops.rows.find(s => s.shop_id === shop_id);
  if (!shop2Cloud) {
    throw new Error('Shop 2 registration verification failed: row not found in giga_cloud.shops!');
  }
  console.log('✓ Shop 2 successfully registered and active in cloud!');

  await client.end();

  // 5. Test gc_ping RPC via HTTP PostgREST endpoint
  console.log('\n--- 5. TESTING gc_ping RPC VIA SUPABASE REST ENDPOINT ---');
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }

  const pingUrl = `${supabaseUrl}/rest/v1/rpc/gc_ping`;
  const pingResp = await fetch(pingUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      p_shop_id: shop_id,
      p_token: token,
    }),
  });

  const pingResult = await pingResp.json();
  console.log('gc_ping response:', pingResult);
  if (!pingResp.ok || pingResult?.ok !== true) {
    throw new Error(`gc_ping failed with status ${pingResp.status}: ${JSON.stringify(pingResult)}`);
  }
  console.log(`✓ gc_ping SUCCESS: Server verified Shop 2 token with cloud! (Cloud time: ${pingResult.time})`);

  // Cross-token security check: Shop 1 ID with Shop 2 token MUST be rejected
  const crossPing = await fetch(pingUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      p_shop_id: SHOP1_ID,
      p_token: token, // shop 2 token
    }),
  });
  const crossResult = await crossPing.json();
  if (crossPing.ok && crossResult?.ok === true) {
    throw new Error('CRITICAL SECURITY BREACH: Shop 1 accepted Shop 2 token!');
  }
  console.log(`✓ Cross-token security check PASSED: Cloud rejected Shop 1 query with Shop 2 token (status: ${crossPing.status}, error: ${crossResult?.message || crossResult?.error || 'Rejected'}).`);

  console.log('\n======================================================================');
  console.log('  SHOP 2 CLOUD REGISTRATION COMPLETED AND VERIFIED');
  console.log('======================================================================\n');
}

main().catch(err => {
  console.error('\n[REGISTRATION ERROR]:', err);
  process.exit(1);
});
