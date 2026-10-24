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
    WHERE proname = 'register_shop';
  `);
  console.log('Function register_shop definition:');
  console.log(fnRes.rows[0]?.def);

  const cmdCols = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'giga_cloud' AND table_name = 'commands'
    ORDER BY ordinal_position;
  `);
  console.log('\nColumns of giga_cloud.commands:');
  for (const c of cmdCols.rows) {
    console.log(`  ${c.column_name} (${c.data_type})`);
  }

  await client.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
