import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('[ERROR] Missing DATABASE_URL in .env');
  process.exit(1);
}

async function alignSupabaseSchema() {
  console.log('====================================================');
  console.log('  GIGA CHEMIST — ALIGN SUPABASE SCHEMA VIA DIRECT PG');
  console.log('====================================================');
  console.log(`Connecting to: ${databaseUrl.split('@')[1] || 'database'}\n`);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    const client = await pool.connect();
    console.log('[SUCCESS] Connected to Supabase PostgreSQL database.');

    // Check existing tables in public schema
    const { rows: existingTables } = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log(`\nCurrent tables in public schema (${existingTables.length}):`);
    existingTables.forEach((r) => console.log(` - ${r.table_name}`));

    console.log('\nApplying schema.sql to Supabase database...');
    const schemaSql = fs.readFileSync(path.resolve('schema.sql'), 'utf-8');
    
    await client.query(schemaSql);
    console.log('[SUCCESS] Applied schema.sql successfully!');

    // Re-check tables
    const { rows: updatedTables } = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log(`\nUpdated tables in public schema (${updatedTables.length}):`);
    updatedTables.forEach((r) => console.log(` - ${r.table_name}`));

    // Reload postgrest schema cache
    console.log('\nReloading PostgREST schema cache...');
    await client.query(`NOTIFY pgrst, 'reload schema';`);
    console.log('[SUCCESS] PostgREST schema cache reload notification sent.');

    client.release();
    await pool.end();
  } catch (err: any) {
    console.error('[ERROR] Failed to align Supabase schema:', err);
    process.exit(1);
  }
}

alignSupabaseSchema().catch((err) => {
  console.error(err);
  process.exit(1);
});
