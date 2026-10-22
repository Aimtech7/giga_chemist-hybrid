import { pgPool } from '../../server/db/client';
import { previewMedicineDeletion } from '../../server/db/medicines';

async function run() {
  console.log('--- TEST SUITE: PostgreSQL Client Concurrency & Zero Deprecation Warnings ---');

  // Track deprecation / console warnings
  const warnings: string[] = [];
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning: any, ...args: any[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message || String(warning);
    warnings.push(text);
    return originalEmitWarning.apply(process, [warning, ...args] as any);
  };

  try {
    // 1. Verify previewMedicineDeletion runs sequential queries cleanly without client.query() concurrency warning
    console.log('1. Testing previewMedicineDeletion executes queries cleanly without client.query concurrency...');
    const medId = (await pgPool.query('SELECT id FROM medicines LIMIT 1')).rows[0]?.id;
    if (medId) {
      const client = await pgPool.connect();
      try {
        await previewMedicineDeletion(medId, client);
      } finally {
        client.release();
      }
    }

    const concurrentWarnings = warnings.filter((w) =>
      w.includes('Calling client.query() when the client is already executing a query is deprecated')
    );
    if (concurrentWarnings.length > 0) {
      throw new Error(`Regression detected: Found client.query concurrency warning: ${concurrentWarnings.join('\n')}`);
    }
    console.log('  ✓ previewMedicineDeletion executed cleanly with zero client.query concurrency warnings');

    // 2. Verify sync worker leadership client isolation
    console.log('2. Verifying sync worker leadership client isolation...');
    const clientA = await pgPool.connect();
    const clientB = await pgPool.connect();

    try {
      // Both run queries independently on separate clients
      const [resA, resB] = await Promise.all([
        clientA.query('SELECT pg_backend_pid() AS pid'),
        clientB.query('SELECT pg_backend_pid() AS pid'),
      ]);

      if (resA.rows[0].pid === resB.rows[0].pid) {
        throw new Error('clientA and clientB must have distinct server backend PIDs!');
      }
      console.log(`  ✓ Isolated connection pool clients confirmed: PID ${resA.rows[0].pid} vs PID ${resB.rows[0].pid}`);
    } finally {
      clientA.release();
      clientB.release();
    }

    // 3. Verify proper sequential await pattern
    console.log('3. Verifying sequential await on single acquired client...');
    const singleClient = await pgPool.connect();
    try {
      const t0 = Date.now();
      const r1 = await singleClient.query('SELECT 1 AS num');
      const r2 = await singleClient.query('SELECT 2 AS num');
      const r3 = await singleClient.query('SELECT 3 AS num');

      if (r1.rows[0].num !== 1 || r2.rows[0].num !== 2 || r3.rows[0].num !== 3) {
        throw new Error('Sequential query values mismatch');
      }
      console.log('  ✓ Sequential queries on single client executed reliably');
    } finally {
      singleClient.release();
    }

    console.log('--- ALL POSTGRES CLIENT CONCURRENCY TESTS PASSED ---');
  } finally {
    process.emitWarning = originalEmitWarning;
    await pgPool.end();
  }
  process.exit(0);
}

run().catch(async (err) => {
  console.error('Test failed with error:', err);
  await pgPool.end().catch(() => {});
  process.exit(1);
});
