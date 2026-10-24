import pg from 'pg';

const CLOUD_URL = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const SHOP2_ID = '13bdb896-e243-4772-accf-b8609e1d977f';
const MED_ID = '751ea76d-8512-4071-b730-595e6aa318e9';

async function main() {
  const client = new pg.Client({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('--- SUPABASE CLOUD MEDICINE & BATCH INSPECTION ---');
  const cloudMed = (await client.query(
    'SELECT shop_id, medicine_id, name, status, local_version, stock_version FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2',
    [SHOP2_ID, MED_ID]
  )).rows[0];
  console.log('Cloud medicine:', cloudMed);

  const cloudBatches = (await client.query(
    'SELECT shop_id, batch_id, medicine_id, batch_number, status FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2',
    [SHOP2_ID, MED_ID]
  )).rows;
  console.log('Cloud batches:', cloudBatches);

  // Check apply_event_core definition
  const fnRes = (await client.query(`
    SELECT pg_get_functiondef(oid) AS def
    FROM pg_proc
    WHERE proname = 'apply_event_core'
  `)).rows[0];

  console.log('\n--- CHECKING apply_event_core FOR MEDICINE_ARCHIVED ---');
  const def = fnRes?.def || '';
  const idx = def.indexOf('MEDICINE_ARCHIVED');
  if (idx !== -1) {
    console.log('Found MEDICINE_ARCHIVED in apply_event_core:');
    console.log(def.slice(idx - 50, idx + 350));
  } else {
    console.log('MEDICINE_ARCHIVED NOT found in apply_event_core!');
  }

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
