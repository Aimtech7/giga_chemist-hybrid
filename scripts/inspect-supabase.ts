import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function inspectSupabase() {
  console.log('====================================================');
  console.log('  GIGA CHEMIST — SUPABASE PROJECT INSPECTION');
  console.log('====================================================');
  console.log(`Supabase Endpoint: ${supabaseUrl}\n`);

  const tables = [
    'branches',
    'roles',
    'permissions',
    'users',
    'categories',
    'suppliers',
    'customers',
    'medicines',
    'medicine_batches',
    'purchases',
    'purchase_items',
    'sales',
    'sale_items',
    'payments',
    'inventory_movements',
    'sync_queue',
    'settings',
    'legacy_migration_map'
  ];

  console.log('Table Existence & Current Row Counts:');
  for (const t of tables) {
    try {
      const { count, error, status } = await supabase.from(t).select('*', { count: 'exact', head: true });
      if (error) {
        console.log(`  - ${t.padEnd(25)}: NOT FOUND IN SCHEMA CACHE [Status ${status}] (${error.message})`);
      } else {
        console.log(`  - ${t.padEnd(25)}: READY (Rows: ${count ?? 0})`);
      }
    } catch (err: any) {
      console.log(`  - ${t.padEnd(25)}: EXCEPTION (${err.message})`);
    }
  }
}

inspectSupabase().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});
