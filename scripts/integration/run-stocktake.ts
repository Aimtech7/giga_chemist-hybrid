import { assertDevDatabase, cleanupFixtures, getServerLog, pool, startServer, stopServer, summary, upsertFixtureUser, check, section } from './harness';
import { setupHybridCloud, type HybridEnv } from './hybrid.test';
import { stocktakeTests } from './stocktake.test';
import { alertsTests } from './alerts.test';
import { stopSyncCenterOnline, syncCenterTests } from './synccenter.test';

/**
 * Formal stocktake + Alerts Center suite.   npm run test:stocktake
 * giga_chemist_dev (shop side, hybrid, worker ON; the cloud emulator is STOPPED for the offline part)
 * + giga_chemist_cloud_test (cloud emulator, recreated with every cloud migration). Same guards as the
 * shift suite: no real pending outbox events, no other running sync worker, local migration 022 applied.
 * Never touches a real cloud, a real shop or the PC2 giga_chemist DB.
 */
const LEADER_LOCK_KEY = 7_420_317_001;

async function guard() {
  await assertDevDatabase();
  const m = (await pool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = '022_stocktakes.sql'`)).rows[0].n;
  if (m !== 1) throw new Error('Local migration 022 must be applied to giga_chemist_dev (npm run db:migrate against the dev database).');
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
  console.log('[stocktake] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-stk-admin@gigachemist.local', 'ITest Stocktake Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-stk-cashier@gigachemist.local', 'ITest Stocktake Cashier', 'CASHIER');
  const manager = await upsertFixtureUser('itest-stk-manager@gigachemist.local', 'ITest Stocktake Manager', 'MANAGER' as any);
  let env: HybridEnv | null = null;
  try {
    process.env.OPS_CHECKS_CACHE_SECONDS = '2'; // alert checks re-evaluated quickly in tests (default 600)
    // Test backups: the harness sends them to a temporary folder (never the real BACKUP_DIR).
    process.env.BACKUP_KEEP = '2';
    process.env.BACKUP_KEEP_WEEKLY = '1';
    env = await setupHybridCloud();
    await startServer();
    await stocktakeTests(env, admin, manager, cashier);
    await alertsTests(env, admin, manager, cashier);
    await syncCenterTests(env, admin, manager, cashier);
  } catch (err: any) {
    section('ABORTED');
    check(false, `suite aborted: ${err?.message || err}`);
    console.error(err?.stack || err);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
  } finally {
    await stopSyncCenterOnline();
    await stopServer();
    if (env) await env.emu.close().catch(() => {});
    console.log('[stocktake] post-run fixture cleanup:', await cleanupFixtures());
    await pool.query('DELETE FROM sync_state');
    for (const r of savedState) await pool.query('INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, $3)', [r.key, r.value, r.updated_at]);
  }
  process.exitCode = summary() ? 1 : 0;
}

main().catch((e) => {
  console.error('[stocktake] fatal:', e?.message || e);
  process.exitCode = 1;
}).finally(() => pool.end());
