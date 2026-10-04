import { assertDevDatabase, cleanupFixtures, login, pool, startServer, stopServer, summary, upsertFixtureUser, getServerLog } from './harness';
import { authTests, userTests, type Ctx } from './auth-users.test';
import { wholesaleTests } from './wholesale.test';
import { commerceTests } from './commerce.test';

/**
 * GIGA CHEMIST local integration suite.
 *
 *   npm run test:integration
 *
 * Starts its own server on ITEST_PORT (default 3199) against giga_chemist_dev ONLY, exercises the
 * real HTTP API with real JWTs, and verifies results directly in PostgreSQL. Test accounts get new
 * random passwords on every run; nothing secret is printed.
 */
async function main() {
  await assertDevDatabase();
  console.log('[integration] pre-run fixture cleanup:', await cleanupFixtures());
  const admin = await upsertFixtureUser('itest-admin@gigachemist.local', 'ITest Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-cashier@gigachemist.local', 'ITest Cashier', 'CASHIER');
  const cashier2 = await upsertFixtureUser('itest-cashier2@gigachemist.local', 'ITest Cashier Two', 'CASHIER');

  await startServer();
  const ctx: Ctx = {
    admin,
    cashier,
    cashier2,
    adminToken: await login(admin.email, admin.password),
    cashierToken: await login(cashier.email, cashier.password),
    cashier2Token: await login(cashier2.email, cashier2.password),
  };

  const only = (process.env.ITEST_ONLY || '').toLowerCase();
  const run = async (name: string, fn: (c: Ctx) => Promise<void>) => {
    if (only && !only.split(',').includes(name)) return;
    await fn(ctx);
  };

  try {
    await run('auth', authTests);
    await run('users', userTests);
    await run('wholesale', wholesaleTests);
    await run('commerce', commerceTests);
  } finally {
    await stopServer();
    // Remove test transactions, zero/deactivate fixture medicines, deactivate test users.
    console.log('[integration] post-run fixture cleanup:', await cleanupFixtures());
  }
  const failed = summary();
  if (failed && process.env.ITEST_SHOW_SERVER_LOG) console.log(getServerLog());
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch(async (err) => {
    console.error('\n[integration] aborted:', err?.message || err);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
    await stopServer();
    process.exitCode = 1;
  })
  .finally(() => pool.end());
