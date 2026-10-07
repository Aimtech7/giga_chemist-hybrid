import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { assertDevDatabase, cleanupFixtures, login, pool, startServer, stopServer, summary, upsertFixtureUser, getServerLog, setServerEnv } from './harness';
import { startFakeSmtp } from './fake-smtp';
import { opsTests } from './ops.test';
import type { Ctx } from './auth-users.test';

/**
 * Operations suite: server-side reports, Sales History, e-mail queue (real SMTP protocol against a
 * local fake SMTP server), backups, health, RBAC, CORS, dev-reset guard, upgrade/rehearsal guards.
 *
 *   npm run test:ops
 *
 * giga_chemist_dev only. Restores email_settings and removes the e-mail jobs, backup runs and
 * backup files it created.
 */
const SMTP_PORT = Number(process.env.ITEST_SMTP_PORT || 2599);

async function main() {
  await assertDevDatabase();
  const runStart = (await pool.query('SELECT now() AS t')).rows[0].t;
  const savedSettings = (await pool.query('SELECT * FROM email_settings WHERE id = 1')).rows[0];
  const backupDir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-itest-backup-')));
  const smtpPassword = `itest-smtp-${crypto.randomBytes(8).toString('hex')}`;
  process.env.ITEST_SMTP_PASSWORD = smtpPassword;

  console.log('[ops] pre-run fixture cleanup:', await cleanupFixtures());
  // Deterministic start: no report is scheduled until a test enables it.
  await pool.query(`UPDATE email_settings SET daily_stock_enabled = false, business_summary_enabled = false,
                      expiry_report_enabled = false, low_stock_digest_enabled = false, recipients = NULL WHERE id = 1`);
  const admin = await upsertFixtureUser('itest-admin@gigachemist.local', 'ITest Admin', 'ADMIN');
  const cashier = await upsertFixtureUser('itest-cashier@gigachemist.local', 'ITest Cashier', 'CASHIER');
  const cashier2 = await upsertFixtureUser('itest-cashier2@gigachemist.local', 'ITest Cashier Two', 'CASHIER');
  const smtp = await startFakeSmtp(SMTP_PORT);
  setServerEnv({
    EMAIL_ENABLED: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_USER: '',
    // Set (but unused without SMTP_USER) to prove it never leaks into responses or logs.
    SMTP_PASSWORD: smtpPassword,
    EMAIL_FROM: 'GIGA CHEMIST ITEST <reports@itest.local>',
    STOCK_REPORT_RECIPIENTS: 'itest-owner@itest.local',
    EMAIL_WORKER_INTERVAL_SECONDS: '1',
    EMAIL_RETRY_BASE_SECONDS: '1',
    EMAIL_MAX_BACKOFF_SECONDS: '3',
    SMTP_TIMEOUT_MS: '2000',
    BACKUP_ENABLED: 'false',
    BACKUP_DIR: backupDir,
    BACKUP_KEEP: '2',
    ALLOWED_ORIGINS: 'https://allowed.example',
  });

  try {
    await startServer();
    const ctx: Ctx = {
      admin, cashier, cashier2,
      adminToken: await login(admin.email, admin.password),
      cashierToken: await login(cashier.email, cashier.password),
      cashier2Token: await login(cashier2.email, cashier2.password),
    };
    await opsTests(ctx, { smtp, backupDir });
  } finally {
    await stopServer();
    await smtp.close().catch(() => {});
    const cols = Object.keys(savedSettings).filter((c) => c !== 'id');
    await pool.query(`UPDATE email_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => savedSettings[c]));
    const removed = {
      email_jobs: (await pool.query('DELETE FROM email_jobs WHERE created_at >= $1', [runStart])).rowCount,
      backup_runs: (await pool.query('DELETE FROM backup_runs WHERE started_at >= $1', [runStart])).rowCount,
    };
    fs.rmSync(backupDir, { recursive: true, force: true });
    console.log('[ops] post-run fixture cleanup:', { ...(await cleanupFixtures()), ...removed });
  }
  const failed = summary();
  if (failed && process.env.ITEST_SHOW_SERVER_LOG) console.log(getServerLog());
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch(async (err) => {
    console.error('\n[ops] aborted:', err?.message || err);
    console.error(getServerLog().split('\n').slice(-40).join('\n'));
    await stopServer();
    process.exitCode = 1;
  })
  .finally(() => pool.end());
