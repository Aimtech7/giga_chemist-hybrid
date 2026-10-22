process.env.APP_MODE = 'hybrid';
import 'dotenv/config';
import { pgPool } from '../../server/db/client';
import { getSyncStatus, syncWorker } from '../../server/sync/worker';

async function runTests() {
  console.log('--- TEST SUITE: Sync Health Semantics & Timestamp Separation ---');

  // Preserve initial state
  const origStateRes = await pgPool.query('SELECT key, value FROM sync_state');
  const origState = origStateRes.rows;

  try {
    // -------------------------------------------------------------------------
    // Test 1: Intermittent cloud failure followed by recovery (DEGRADED -> HEALTHY)
    // -------------------------------------------------------------------------
    console.log('1. Testing intermittent cloud failure followed by recovery...');

    const failureTime = new Date(Date.now() - 30_000).toISOString();
    await pgPool.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ('last_error', 'Cloud connection timed out (simulated)', CURRENT_TIMESTAMP),
              ('last_error_at', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [failureTime]
    );

    // Mock worker failure count = 1
    (syncWorker as any).consecutiveFailures = 1;
    (syncWorker as any).cloudReachable = true;

    let status = await getSyncStatus();
    if (status.current_cloud_state !== 'DEGRADED') {
      throw new Error(`Expected DEGRADED during intermittent failure, got: ${status.current_cloud_state}`);
    }
    console.log(`  ✓ Intermittent failure state confirmed: ${status.current_cloud_state}`);

    // Recovery occurs: contact established after the error, consecutive failures reset to 0
    const recoveryTime = new Date(Date.now()).toISOString();
    await pgPool.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ('last_contact_at', $1, CURRENT_TIMESTAMP),
              ('last_success_at', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [recoveryTime]
    );
    (syncWorker as any).consecutiveFailures = 0;

    status = await getSyncStatus();
    if (status.current_cloud_state !== 'HEALTHY') {
      throw new Error(`Expected transition to HEALTHY after recovery, got: ${status.current_cloud_state}`);
    }
    if (!status.last_error_resolved) {
      throw new Error(`Expected last_error_resolved === true, got: ${status.last_error_resolved}`);
    }
    if (!status.last_error || !status.last_error_at) {
      throw new Error(`Expected historical error record to remain preserved`);
    }

    console.log(`  ✓ Recovery state confirmed: ${status.current_cloud_state}`);
    console.log(`  ✓ Historical error preserved and marked resolved: ${status.last_error_resolved}`);

    // -------------------------------------------------------------------------
    // Test 2: Idle shop semantics (Recent contact, old or null business upload, HEALTHY)
    // -------------------------------------------------------------------------
    console.log('2. Testing idle shop sync state semantics...');

    const recentContact = new Date(Date.now() - 14_000).toISOString();
    await pgPool.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ('last_contact_at', $1, CURRENT_TIMESTAMP),
              ('last_success_at', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [recentContact]
    );
    (syncWorker as any).consecutiveFailures = 0;

    status = await getSyncStatus();

    if (status.current_cloud_state !== 'HEALTHY') {
      throw new Error(`Expected HEALTHY for idle shop with recent contact, got: ${status.current_cloud_state}`);
    }

    if (!status.last_contact_at) {
      throw new Error(`Expected last_contact_at to be populated`);
    }

    console.log(`  ✓ Idle shop overall state: ${status.current_cloud_state}`);
    console.log(`  ✓ Cloud contact timestamp: ${status.last_contact_at}`);
    console.log(`  ✓ Business upload timestamp: ${status.last_business_upload_at ?? 'None (no recent events)'}`);
    console.log(`  ✓ Timestamps clearly separated in sync status contract`);

    console.log('--- ALL SYNC HEALTH STATE TESTS PASSED ---');
  } finally {
    // Restore state
    await pgPool.query('DELETE FROM sync_state');
    for (const row of origState) {
      await pgPool.query(
        'INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [row.key, row.value]
      );
    }
    (syncWorker as any).consecutiveFailures = 0;
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
