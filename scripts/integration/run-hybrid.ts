import { assertDevDatabase, cleanupFixtures, login, pool, startServer, stopServer, summary, upsertFixtureUser, getServerLog } from './harness';
import { hybridTests, setupHybridCloud, type HybridEnv } from './hybrid.test';
import type { Ctx } from './auth-users.test';

/**
 * GIGA CHEMIST hybrid sync suite.
 *
 *   npm run test:hybrid
 *
 * Runs against giga_chemist_dev ONLY plus a throwaway cloud database (giga_chemist_cloud_test,
 * recreated every run) served by the local cloud emulator. Refuses to run when:
 *   - real (non-test) outbox events are waiting: the test worker would ship them to the TEST cloud
 *   - another server process is running the sync worker for this database
 * Test-created outbox rows are removed afterwards and sync_state is restored.
 */
const LEADER_LOCK_KEY = 7_420_317_001;

async function guard() {
  await assertDevDatabase();
  const foreign = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sync_events
      WHERE status <> 'SYNCED'
        AND (actor_user_id IS NULL OR actor_user_id NOT IN (SELECT id FROM users WHERE email LIKE 'itest-%@gigachemist.local'))
        AND NOT (entity_type = 'medicine' AND entity_id IN (SELECT id::text FROM medicines WHERE barcode LIKE 'ITEST-%'))`
  );
  if (foreign.rows[0].n > 0) {
    throw new Error(`${foreign.rows[0].n} real outbox event(s) are not synced yet. Refusing to run: the test worker would deliver them to the TEST cloud.`);
  }
  const lock = await pool.connect();
  try {
    const got = (await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY])).rows[0].ok;
    if (!got) throw new Error('Another GIGA CHEMIST server is running the sync worker on this database. Stop it before running the hybrid suite.');
    await lock.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
  } finally {
    lock.release();
  }
}

async function main() {
  await guard();
  const savedState = (await pool.query('SELECT key, value, updated_at FROM sync_state')).rows;
  console.log('[hybrid] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-admin@gigachemist.local', 'ITest Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-cashier@gigachemist.local', 'ITest Cashier', 'CASHIER');
  const cashier2 = await upsertFixtureUser('itest-cashier2@gigachemist.local', 'ITest Cashier Two', 'CASHIER');

  let env: HybridEnv | null = null;
  try {
    env = await setupHybridCloud();
    await startServer();
    const ctx: Ctx = {
      admin, cashier, cashier2,
      adminToken: await login(admin.email, admin.password),
      cashierToken: await login(cashier.email, cashier.password),
      cashier2Token: await login(cashier2.email, cashier2.password),
    };
    await hybridTests(ctx, env);
  } finally {
    await stopServer();
    if (env) await env.emu.close().catch(() => {});
    console.log('[hybrid] post-run fixture cleanup:', await cleanupFixtures());
    await pool.query('DELETE FROM sync_state');
    for (const r of savedState) {
      await pool.query('INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, $3)', [r.key, r.value, r.updated_at]);
    }
  }
  const failed = summary();
  if (failed && process.env.ITEST_SHOW_SERVER_LOG) console.log(getServerLog());
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch(async (err) => {
    console.error('\n[hybrid] aborted:', err?.message || err);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
    await stopServer();
    process.exitCode = 1;
  })
  .finally(() => pool.end());
