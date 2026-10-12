import { assertDevDatabase, cleanupFixtures, getServerLog, pool, startServer, stopServer, summary, upsertFixtureUser, check, section } from './harness';
import { setupHybridCloud, type HybridEnv } from './hybrid.test';
import { fullWriteTests, stopFullWriteOnline } from './full-write.test';

/**
 * Full-write Global Admin suite.   npm run test:full-write
 * giga_chemist_dev (shop side, hybrid, worker ON) + giga_chemist_cloud_test (cloud emulator, recreated
 * with cloud SQL 001-006) + online API + synthetic Shop 2. Same guards as the unified-auth suite:
 * no real pending outbox events, no other running sync worker, local migrations 016 + 017 applied.
 * Never touches a real cloud, a real shop or the PC2 giga_chemist database.
 */
const LEADER_LOCK_KEY = 7_420_317_001;

async function guard() {
  await assertDevDatabase();
  const m = (await pool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version IN ('016_unified_auth_credentials.sql', '017_full_write_admin.sql')`)).rows[0].n;
  if (m !== 2) throw new Error('Local migrations 016 and 017 must be applied to giga_chemist_dev (npm run db:migrate against the dev database).');
  const foreign = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sync_events WHERE status <> 'SYNCED'
       AND (actor_user_id IS NULL OR actor_user_id NOT IN (SELECT id FROM users WHERE email LIKE 'itest-%@gigachemist.local'))
       AND COALESCE(actor_name, '') NOT LIKE 'CLOUD (ITest%'
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
  console.log('[full-write] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-fw-admin@gigachemist.local', 'ITest FW Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-fw-cashier@gigachemist.local', 'ITest FW Cashier', 'CASHIER');
  let env: HybridEnv | null = null;
  try {
    env = await setupHybridCloud();
    await env.emu.pool.query('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [env.shopId]);
    await startServer();
    await fullWriteTests(env, admin, cashier);
  } catch (err: any) {
    section('ABORTED');
    check(false, `suite aborted: ${err?.message || err}`);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
  } finally {
    await stopFullWriteOnline();
    await stopServer();
    if (env) await env.emu.close().catch(() => {});
    console.log('[full-write] post-run fixture cleanup:', await cleanupFixtures());
    await pool.query('DELETE FROM sync_state');
    for (const r of savedState) await pool.query('INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, $3)', [r.key, r.value, r.updated_at]);
  }
  process.exitCode = summary() ? 1 : 0;
}

main().catch((e) => {
  console.error('[full-write] fatal:', e?.message || e);
  process.exitCode = 1;
}).finally(() => pool.end());
