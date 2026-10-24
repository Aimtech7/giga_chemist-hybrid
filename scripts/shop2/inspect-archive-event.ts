import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const MED_ID = '751ea76d-8512-4071-b730-595e6aa318e9';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  console.log('======================================================================');
  console.log(`  STEP 1: INSPECT LOCAL ARCHIVE STATE FOR ${MED_ID}`);
  console.log('======================================================================\n');

  // 1. Medicine
  const med = (await pool.query('SELECT id, name, status, current_stock, version, stock_version FROM medicines WHERE id = $1', [MED_ID])).rows[0];
  console.log('MEDICINE:');
  console.log('  ID:           ', med?.id);
  console.log('  Name:         ', med?.name);
  console.log('  Status:       ', med?.status);
  console.log('  Current Stock:', med?.current_stock);
  console.log('  Version:      ', med?.version);
  console.log('  Stock Version:', med?.stock_version);

  // 2. Batches
  const batches = (await pool.query('SELECT id, batch_number, status, quantity_available, stock_version FROM medicine_batches WHERE medicine_id = $1', [MED_ID])).rows;
  console.log('\nBATCHES:');
  for (const b of batches) {
    console.log(`  Batch ${b.batch_number} (${b.id}): status=${b.status}, qty=${b.quantity_available}, stock_version=${b.stock_version}`);
  }

  // 3. sync_events for this medicine
  const events = (await pool.query(`
    SELECT *
    FROM sync_events
    WHERE entity_id = $1
    ORDER BY created_at DESC
    LIMIT 5
  `, [MED_ID])).rows;

  console.log(`\nSYNC_EVENTS (Latest ${events.length}):`);
  for (const e of events) {
    console.log(`  [seq ${e.local_seq}] id: ${e.id}`);
    console.log(`    event_type:      ${e.event_type}`);
    console.log(`    operation:       ${e.operation}`);
    console.log(`    status:          ${e.status}`);
    console.log(`    next_attempt_at: ${e.next_attempt_at}`);
    console.log(`    processed_at:    ${e.processed_at}`);
    console.log(`    created_at:      ${e.created_at}`);
    console.log(`    last_error:      ${e.last_error}`);
    console.log(`    payload:         ${JSON.stringify(e.payload).slice(0, 200)}...`);
  }

  // 4. Audit Logs
  const audits = (await pool.query(`
    SELECT id, action, entity, entity_id, new_value, created_at
    FROM audit_logs
    WHERE entity_id = $1 OR new_value::text LIKE '%' || $1 || '%'
    ORDER BY created_at DESC
    LIMIT 5
  `, [MED_ID])).rows;

  console.log(`\nAUDIT_LOGS (Latest ${audits.length}):`);
  for (const a of audits) {
    console.log(`  [${a.created_at}] action: ${a.action}, entity: ${a.entity} (${a.entity_id})`);
    console.log(`    new_value: ${JSON.stringify(a.new_value).slice(0, 150)}...`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
