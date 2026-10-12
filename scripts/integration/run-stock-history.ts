import pg from 'pg';
import { assertDevDatabase, check, cleanupFixtures, getServerLog, pool, section, setServerEnv, startServer, stopServer, summary, upsertFixtureUser } from './harness';
import { prepareCloudDatabase } from '../cloud-emulator';
import { CLOUD_TEST_DB } from './hybrid.test';
import { stockHistoryApiTests, stockHistoryCalculationTests } from './stock-history.test';

/**
 * Daily Stock History suite.   npm run test:stock-history
 * giga_chemist_dev (local source; fixtures in a rolled-back transaction + a private local server whose
 * cloud URL is unreachable = "internet offline") and giga_chemist_cloud_test (cloud source, recreated
 * with cloud SQL 001-008). Never touches a real cloud, a real shop or the PC2 giga_chemist database.
 */
const LEADER_LOCK_KEY = 7_420_317_001;

async function guard() {
  await assertDevDatabase();
  const m = (await pool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version IN ('017_full_write_admin.sql', '018_history_indexes.sql', '019_stock_history_indexes.sql')`)).rows[0].n;
  if (m !== 3) throw new Error('Local migrations 017-019 must be applied to giga_chemist_dev (npm run db:migrate against the dev database).');
  const c = await pool.connect();
  try {
    if (!(await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY])).rows[0].ok) throw new Error('Another GIGA CHEMIST server runs the sync worker on this database. Stop it first.');
    await c.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
  } finally {
    c.release();
  }
}

async function main() {
  await guard();
  console.log('[stock-history] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-sh-admin@gigachemist.local', 'ITest SH Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-sh-cashier@gigachemist.local', 'ITest SH Cashier', 'CASHIER');
  const manager = await upsertFixtureUser('itest-sh-manager@gigachemist.local', 'ITest SH Manager', 'MANAGER' as any);
  await prepareCloudDatabase(CLOUD_TEST_DB, true);
  const cfg = pool.options as any;
  const url = new URL(cfg.connectionString || `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/x`);
  url.pathname = `/${CLOUD_TEST_DB}`;
  const cloudPool = new pg.Pool({ connectionString: url.toString() });
  try {
    await stockHistoryCalculationTests(admin, cloudPool);
    // Shop 1 runs hybrid: same here, with its cloud UNREACHABLE (port 9 refuses) and the worker off.
    setServerEnv({ APP_MODE: 'hybrid', SYNC_ENABLED: 'false', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'itest-offline', SUPABASE_SERVICE_ROLE_KEY: '', SYNC_SHOP_TOKEN: 'itest-offline-token', SHOP_ID: '' });
    await startServer();
    await stockHistoryApiTests(admin, cashier, manager);
  } catch (err: any) {
    section('ABORTED');
    check(false, `suite aborted: ${err?.message || err}`);
    console.error(err?.stack || err);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
  } finally {
    await stopServer();
    await cloudPool.end().catch(() => {});
    console.log('[stock-history] post-run fixture cleanup:', await cleanupFixtures());
  }
  process.exitCode = summary() ? 1 : 0;
}

main().catch((e) => {
  console.error('[stock-history] fatal:', e?.message || e);
  process.exitCode = 1;
}).finally(() => pool.end());
