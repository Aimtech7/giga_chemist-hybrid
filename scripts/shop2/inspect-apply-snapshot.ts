import pg from 'pg';

const cloudUrl = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new pg.Client({
    connectionString: cloudUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const fnRes = await client.query(`
    SELECT proname, pg_get_functiondef(oid) AS def
    FROM pg_proc
    WHERE proname = 'gc_apply_inventory_snapshot';
  `);

  console.log(fnRes.rows[0]?.def);
  await client.end();
}

main().catch(console.error);
