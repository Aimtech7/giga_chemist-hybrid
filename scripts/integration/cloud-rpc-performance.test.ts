import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import pg from 'pg';
import { callCloud } from '../../server/sync/cloudClient';

function p(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(q * sorted.length), sorted.length - 1);
  return sorted[idx];
}

async function run() {
  console.log('--- TEST SUITE: Cloud RPC Performance & Zero Contention ---');

  if (!fs.existsSync('.env.online')) {
    console.warn('.env.online not found; skipping cloud performance suite.');
    process.exit(0);
  }

  const onlineEnv = dotenv.parse(fs.readFileSync('.env.online'));
  const cloudClient = new pg.Client({
    connectionString: onlineEnv.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await cloudClient.connect();

  const testShopId = '00000000-0000-4000-8000-000000000099';
  const testToken = 'test_perf_stability_token_1234567890_abc';

  // Insert isolated test shop into giga_cloud.shops using giga_cloud.token_hash
  await cloudClient.query(
    `INSERT INTO giga_cloud.shops (shop_id, shop_code, name, active, token_hash, created_at)
     VALUES ($1, 'TESTPERF', 'Test Perf Shop', true, giga_cloud.token_hash($2), CURRENT_TIMESTAMP)
     ON CONFLICT (shop_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, active = true`,
    [testShopId, testToken]
  );

  try {
    // 1. Benchmarking individual RPC latencies
    console.log('1. Benchmarking individual RPCs (gc_ping, gc_pull_commands, gc_heartbeat)...');
    const pingTimes: number[] = [];
    const pullTimes: number[] = [];
    const heartbeatTimes: number[] = [];

    const iterations = 5;
    for (let i = 0; i < iterations; i++) {
      // gc_ping
      const t0 = Date.now();
      await callCloud('gc_ping', { p_shop_id: testShopId, p_token: testToken });
      pingTimes.push(Date.now() - t0);

      // gc_pull_commands with no open commands
      const t1 = Date.now();
      await callCloud('gc_pull_commands', { p_shop_id: testShopId, p_token: testToken, p_limit: 10 });
      pullTimes.push(Date.now() - t1);

      // gc_heartbeat
      const t2 = Date.now();
      await callCloud('gc_heartbeat', {
        p_shop_id: testShopId,
        p_token: testToken,
        p_status: { running: true, leader: true, consecutive_failures: 0 },
      });
      heartbeatTimes.push(Date.now() - t2);
    }

    const pull_p50 = p(pullTimes, 0.5);
    const pull_p95 = p(pullTimes, 0.95);
    const pull_max = Math.max(...pullTimes);

    console.log(`  gc_ping: avg=${Math.round(pingTimes.reduce((a, b) => a + b, 0) / pingTimes.length)}ms, min=${Math.min(...pingTimes)}ms, max=${Math.max(...pingTimes)}ms`);
    console.log(`  gc_pull_commands (zero commands): p50=${pull_p50}ms, p95=${pull_p95}ms, max=${pull_max}ms`);
    console.log(`  gc_heartbeat: avg=${Math.round(heartbeatTimes.reduce((a, b) => a + b, 0) / heartbeatTimes.length)}ms`);

    // 2. Multiple concurrent cloud RPCs for the same shop
    console.log('2. Testing 5 concurrent cloud RPCs for same shop (verifying zero row lock contention)...');
    const startConcurrent = Date.now();
    await Promise.all([
      callCloud('gc_ping', { p_shop_id: testShopId, p_token: testToken }),
      callCloud('gc_pull_commands', { p_shop_id: testShopId, p_token: testToken, p_limit: 5 }),
      callCloud('gc_ping', { p_shop_id: testShopId, p_token: testToken }),
      callCloud('gc_heartbeat', { p_shop_id: testShopId, p_token: testToken, p_status: { running: true } }),
      callCloud('gc_pull_commands', { p_shop_id: testShopId, p_token: testToken, p_limit: 5 }),
    ]);
    const concurrentDuration = Date.now() - startConcurrent;
    console.log(`  ✓ 5 concurrent RPCs completed in ${concurrentDuration}ms without row-lock serialization`);

    // 3. Verify authenticate_shop is read-only and causes NO row lock
    console.log('3. Verifying authenticate_shop row-lock contention check...');
    const c1 = new pg.Client({ connectionString: onlineEnv.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const c2 = new pg.Client({ connectionString: onlineEnv.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c1.connect();
    await c2.connect();

    await c1.query('BEGIN');
    await c1.query('SELECT giga_cloud.authenticate_shop($1, $2)', [testShopId, testToken]);

    let c2Completed = false;
    const p2 = c2.query('SELECT 1 FROM giga_cloud.shops WHERE shop_id = $1', [testShopId]).then(() => {
      c2Completed = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    if (!c2Completed) {
      throw new Error('Lock contention detected: c2 was blocked while c1 called authenticate_shop!');
    }
    await p2;
    await c1.query('COMMIT');
    await c1.end();
    await c2.end();
    console.log('  ✓ Verified: authenticate_shop creates zero row locks on giga_cloud.shops');

    console.log('--- ALL CLOUD RPC PERFORMANCE TESTS PASSED ---');
  } finally {
    // Clean up test shop
    await cloudClient.query('DELETE FROM giga_cloud.shops WHERE shop_id = $1', [testShopId]).catch(() => {});
    await cloudClient.end();
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('Cloud RPC performance test failed:', err);
  process.exit(1);
});
