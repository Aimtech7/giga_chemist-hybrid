import pg from 'pg';

const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const SHOP2_ID = '13bdb896-e243-4772-accf-b8609e1d977f';

async function main() {
  const client = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const s1Shop = (await client.query('SELECT shop_id, shop_code, name, active, last_seen_at, shop_snapshot_seq FROM giga_cloud.shops WHERE shop_id = $1', [SHOP1_ID])).rows[0];
  const s1Meds = Number((await client.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicines WHERE shop_id = $1', [SHOP1_ID])).rows[0].cnt);
  const s1Batches = Number((await client.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicine_batches WHERE shop_id = $1', [SHOP1_ID])).rows[0].cnt);

  const s2Shop = (await client.query('SELECT shop_id, shop_code, name, active, last_seen_at, shop_snapshot_seq FROM giga_cloud.shops WHERE shop_id = $1', [SHOP2_ID])).rows[0];
  const s2Meds = Number((await client.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicines WHERE shop_id = $1', [SHOP2_ID])).rows[0].cnt);
  const s2Batches = Number((await client.query('SELECT count(*)::int AS cnt FROM giga_cloud.medicine_batches WHERE shop_id = $1', [SHOP2_ID])).rows[0].cnt);

  console.log('--- CLOUD SHOPS BASELINE ---');
  console.log(JSON.stringify({
    SHOP1: {
      shop_id: s1Shop.shop_id,
      shop_code: s1Shop.shop_code,
      shop_snapshot_seq: s1Shop.shop_snapshot_seq,
      cloud_medicines_count: s1Meds,
      cloud_batches_count: s1Batches,
    },
    SHOP2_CURRENT: {
      shop_id: s2Shop.shop_id,
      shop_code: s2Shop.shop_code,
      shop_snapshot_seq: s2Shop.shop_snapshot_seq,
      cloud_medicines_count: s2Meds,
      cloud_batches_count: s2Batches,
    }
  }, null, 2));

  await client.end();
}

main().catch(console.error);
