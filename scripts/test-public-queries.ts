import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const client = createClient(url, anonKey);

async function testPublicQueries() {
  console.log('Testing anon/public queries across all tables...');
  const tables = [
    'categories',
    'suppliers',
    'customers',
    'medicines',
    'medicine_batches',
    'users',
    'settings',
    'sales',
  ];

  for (const table of tables) {
    const { data, error, count } = await client.from(table).select('*', { count: 'exact' }).limit(5);
    if (error) {
      console.log(`- ${table.padEnd(20)}: ERROR (${error.message})`);
    } else {
      console.log(`- ${table.padEnd(20)}: OK (${count} total accessible rows, sample fetched: ${data?.length})`);
    }
  }
}

testPublicQueries().catch(console.error);
