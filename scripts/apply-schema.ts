import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

async function applySchema() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — Applying PostgreSQL Schema to Supabase');
  console.log('=============================================================');

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set in .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('Connecting to PostgreSQL database at Supabase...');
    await client.connect();
    console.log('Connected successfully!');

    const schemaPath = path.resolve('schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    console.log('Executing schema.sql DDL and RLS policies...');
    await client.query(sql);
    console.log('Schema applied successfully!');

    // Verify tables created
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\nVerified Created Tables in Supabase:');
    res.rows.forEach((r) => console.log(`- ${r.table_name}`));

    await client.end();
  } catch (err) {
    console.error('Failed to apply schema:', err);
    await client.end().catch(() => {});
    process.exit(1);
  }
}

applySchema();
