import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const client = createClient(url, anonKey);

async function test() {
  console.log('Testing anon key query against Supabase...');
  const { data: users, error } = await client
    .from('users')
    .select('id, name, email, role, active, password_hash, pin_hash')
    .eq('active', true);

  if (error) {
    console.error('Error fetching users with anon key:', error);
    return;
  }

  console.log('Active users accessible via anon key:', users.length);
  for (const u of users) {
    console.log(`- ${u.email} (${u.role}) -> password_hash prefix: ${u.password_hash?.substring(0, 20)}...`);
  }
}

test().catch(console.error);
