import pg from 'pg';

const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const shopRes = await client.query("SELECT * FROM giga_cloud.shops WHERE shop_code = 'DEVTEST'");
  const shop = shopRes.rows[0];

  if (!shop) {
    console.log('DEVTEST not found');
    await client.end();
    return;
  }

  const id = shop.shop_id;

  const rt = (await client.query('SELECT reported_at, status FROM giga_cloud.shop_runtime_status WHERE shop_id = $1', [id])).rows[0];
  const meds = (await client.query('SELECT COUNT(*) FROM giga_cloud.medicines WHERE shop_id = $1', [id])).rows[0].count;
  const batches = (await client.query('SELECT COUNT(*) FROM giga_cloud.medicine_batches WHERE shop_id = $1', [id])).rows[0].count;
  const cmds = (await client.query('SELECT COUNT(*) FROM giga_cloud.commands WHERE shop_id = $1', [id])).rows[0].count;
  const sales = (await client.query('SELECT COUNT(*) FROM giga_cloud.sales WHERE shop_id = $1', [id])).rows[0].count;
  const events = (await client.query('SELECT COUNT(*) FROM giga_cloud.processed_events WHERE shop_id = $1', [id])).rows[0].count;

  console.log(JSON.stringify({
    shop_id: shop.shop_id,
    shop_code: shop.shop_code,
    name: shop.name,
    active: shop.active,
    last_seen_at: shop.last_seen_at,
    last_event_at: shop.last_event_at,
    events_received: shop.events_received,
    runtime_status: rt ? { reported_at: rt.reported_at } : null,
    medicine_rows: Number(meds),
    batch_rows: Number(batches),
    command_rows: Number(cmds),
    sales_rows: Number(sales),
    processed_events: Number(events),
  }, null, 2));

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
