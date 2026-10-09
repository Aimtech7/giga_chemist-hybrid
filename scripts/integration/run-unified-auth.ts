import { assertDevDatabase, cleanupFixtures, getServerLog, pool, startServer, stopServer, summary, upsertFixtureUser, check, section } from './harness';
import { setupHybridCloud, type HybridEnv } from './hybrid.test';
import { stopUnifiedOnline, unifiedAuthTests } from './unified-auth.test';

/**
 * Unified authentication + multi-shop suite.   npm run test:unified-auth
 * giga_chemist_dev (shop side, hybrid, worker ON) + giga_chemist_cloud_test (cloud emulator, recreated).
 * Same guards as the online suite: no real pending outbox events, no other running sync worker,
 * local migration 016 applied. Never touches a real cloud.
 */
const LEADER_LOCK_KEY = 7_420_317_001;

async function guard() {
  await assertDevDatabase();
  const cols = (await pool.query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('credential_version', 'auth_sync_seq')`)).rows[0].n;
  if (cols !== 2) throw new Error('Local migration 016 is not applied to giga_chemist_dev (npm run db:migrate).');
  const foreign = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sync_events WHERE status <> 'SYNCED'
       AND (actor_user_id IS NULL OR actor_user_id NOT IN (SELECT id FROM users WHERE email LIKE 'itest-%@gigachemist.local'))
       AND NOT (entity_type = 'medicine' AND entity_id IN (SELECT id::text FROM medicines WHERE barcode LIKE 'ITEST-%'))`
  );
  if (foreign.rows[0].n > 0) throw new Error(`${foreign.rows[0].n} real outbox event(s) pending; refusing to run (they would go to the TEST cloud).`);
  const c = await pool.connect();
  try {
    if (!(await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY])).rows[0].ok) {
      throw new Error('Another GIGA CHEMIST server runs the sync worker on this database. Stop it first.');
    }
    await c.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
  } finally {
    c.release();
  }
}

async function main() {
  await guard();
  const savedState = (await pool.query('SELECT key, value, updated_at FROM sync_state')).rows;
  console.log('[unified-auth] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-ua-admin@gigachemist.local', 'ITest UA Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-ua-cashier@gigachemist.local', 'ITest UA Cashier', 'CASHIER');
  let env: HybridEnv | null = null;
  try {
    env = await setupHybridCloud();
    // Unified login enabled for the test shop BEFORE its worker starts (the default is OFF).
    await env.emu.pool.query('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [env.shopId]);
    await startServer();
    await unifiedAuthTests(env, admin, cashier);
  } catch (err: any) {
    section('ABORTED');
    check(false, `suite aborted: ${err?.message || err}`);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
  } finally {
    await stopUnifiedOnline();
    await stopServer();
    if (env) await env.emu.close().catch(() => {});
    console.log('[unified-auth] post-run fixture cleanup:', await cleanupFixtures());
    await pool.query('DELETE FROM sync_state');
    for (const r of savedState) await pool.query('INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, $3)', [r.key, r.value, r.updated_at]);
  }
  process.exitCode = summary() ? 1 : 0;
}

main().catch((e) => {
  console.error('[unified-auth] fatal:', e?.message || e);
  process.exitCode = 1;
}).finally(() => pool.end());
