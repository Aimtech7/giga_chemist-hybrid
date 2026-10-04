import dotenv from 'dotenv';
dotenv.config();
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { runMigration } from './migrate-chemist-pos/migrate';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[FATAL] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in .env');
  process.exit(1);
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// Precomputed PBKDF2-SHA512 hashes (zero plaintext passwords)
const ADMIN_PWD_HASH = '779dee3d684fedaf93208ec655922c2d$6c586a0921bc148e975fa3213f5042f3c50f78675973b4ec1f13a0dbe169a264afd8451bc3864cbc23402132c723758f7216c2b0ffcc719352f002dc97446c31';
const ADMIN_PIN_HASH = '779dee3d684fedaf93208ec655922c2d$c8fe04e878654e4c19b6edccfe20e709084e606ddd83c1b8d57f6ef0b98b1da83e12edafa3df59662a165c9e09e41dd9ba2d04cb780d04934f3e09a2e6422524';
const CASHIER_PWD_HASH = '64366af56fd0eaeaf3953cdb930ddbea$0e91b3f2ad71606545da39425918b1e9d32732e29eddb7dd53dfdec87e2bd8629181632b400de352abc3e9054bee69ecfc69d7743a06eb5d98ae4c0e3b9216c0';
const CASHIER_PIN_HASH = '64366af56fd0eaeaf3953cdb930ddbea$29a014b818995f1a6d567e3aa108c65228411a2fbade8e54b7caeea4eeedb8fbc42b2c161c15bdf585be9024d7a61c6d0213b12324f535ca0b510152d21dd654';

async function batchUpsert<T>(
  tableName: string,
  records: T[],
  chunkSize: number = 500,
  concurrency: number = 5,
  onConflict?: string
) {
  const total = records.length;
  let processed = 0;
  const startTime = Date.now();

  const chunks: T[][] = [];
  for (let i = 0; i < total; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize));
  }

  for (let i = 0; i < chunks.length; i += concurrency) {
    const activeChunks = chunks.slice(i, i + concurrency);
    await Promise.all(
      activeChunks.map(async (chunk, chunkIdx) => {
        const query = onConflict
          ? supabase.from(tableName).upsert(chunk as any, { onConflict })
          : supabase.from(tableName).upsert(chunk as any);

        const { error } = await query;
        if (error) {
          throw new Error(`[${tableName}] Failed chunk ${i + chunkIdx + 1}: ${error.message} (details: ${error.details || ''})`);
        }
        processed += chunk.length;
      })
    );

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = Math.round(processed / Math.max(0.1, Number(elapsedSec)));
    process.stdout.write(`\r  -> [${tableName}] ${processed.toLocaleString()} / ${total.toLocaleString()} rows (${rate} rows/sec)...`);
  }
  console.log(` Done in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`);
}

async function loadSupabaseData() {
  console.log('======================================================================');
  console.log('  GIGA CHEMIST — SUPABASE CLOUD DATABASE DATA LOADER');
  console.log('======================================================================');
  console.log(`Endpoint: ${supabaseUrl}\n`);

  const globalStartTime = Date.now();

  // 1. Run Migration Extract
  console.log('Step 1/10: Extracting transformed data from validated pipeline...');
  const { stats, data } = await runMigration(true);

  // 2. Default Branch & Devices
  console.log('\nStep 2/10: Upserting Primary Branch & Devices...');
  const { error: branchErr } = await supabase.from('branches').upsert({
    id: data.branchId,
    name: 'GIGA CHEMIST — Main Pharmacy',
    code: 'MAIN-01',
    address: 'Central Business District, Kitale, Kenya',
    phone: '+254 700 123 456',
    email: 'info@gigachemist.co.ke',
    active: true,
  });
  if (branchErr) throw new Error(`Branch upsert failed: ${branchErr.message}`);

  const { error: devErr } = await supabase.from('devices').upsert([
    {
      id: 'POS-LEGACY-MIGRATED',
      branch_id: data.branchId,
      name: 'Legacy POS Migration Terminal',
      device_type: 'desktop',
      app_version: '2.1.3',
      status: 'active',
    },
    {
      id: 'POS-TERMINAL-01',
      branch_id: data.branchId,
      name: 'Main Dispensing Counter 01',
      device_type: 'desktop',
      app_version: '1.0.0',
      status: 'active',
    },
  ]);
  if (devErr) console.warn('Devices upsert notice:', devErr.message);

  // 3. Roles & Permissions
  console.log('Step 3/10: Upserting Standard Roles & Permissions...');
  const roles = [
    { name: 'ADMIN', description: 'System Administrator with full access' },
    { name: 'MANAGER', description: 'Pharmacy Manager with operational authority' },
    { name: 'CASHIER', description: 'Dispensing Pharmacist / Cashier' },
  ];
  const { error: rolesErr } = await supabase.from('roles').upsert(roles, { onConflict: 'name' });
  if (rolesErr) console.warn('Roles upsert notice:', rolesErr.message);

  // 4. Users (Active ADMIN & CASHIER + Locked Legacy Profiles)
  console.log('Step 4/10: Upserting Users (Active Admin & Cashier + 5 Locked Legacy Staff)...');
  const allUsers = [
    {
      id: '00000000-0000-0000-0000-000000000099',
      branch_id: data.branchId,
      name: 'Administrator',
      email: 'admin@gigachemist.co.ke',
      role: 'ADMIN',
      phone: '+254 700 123 456',
      active: true,
      password_hash: ADMIN_PWD_HASH,
      pin_hash: ADMIN_PIN_HASH,
    },
    {
      id: '00000000-0000-0000-0000-000000000098',
      branch_id: data.branchId,
      name: 'Cashier',
      email: 'cashier@gigachemist.co.ke',
      role: 'CASHIER',
      phone: '+254 700 123 456',
      active: true,
      password_hash: CASHIER_PWD_HASH,
      pin_hash: CASHIER_PIN_HASH,
    },
    ...data.users.map((u) => ({
      id: u.id,
      branch_id: u.branch_id,
      name: u.name,
      email: u.email,
      role: u.role,
      phone: u.phone,
      active: u.active,
      password_hash: u.password_hash,
      pin_hash: u.pin_hash,
    })),
  ];

  await batchUpsert('users', allUsers, 100, 1, 'email');

  // 5. Categories, Suppliers, Customers
  console.log('\nStep 5/10: Loading Categories, Suppliers, and Customers...');
  await batchUpsert('categories', data.categories, 500, 2, 'name');
  await batchUpsert('suppliers', data.suppliers, 500, 1, 'id');
  await batchUpsert('customers', data.customers, 500, 1, 'id');

  // 6. Medicines & Batches
  console.log('\nStep 6/10: Loading Medicines & Opening Batches (Truth-Based Null Expiry)...');
  const medicinesFormatted = data.medicines.map((m) => ({
    id: m.id,
    branch_id: m.branch_id,
    name: m.name,
    generic_name: m.generic_name,
    brand_name: m.brand_name,
    sku: m.sku,
    barcode: m.barcode,
    category_id: m.category_id,
    medicine_type: m.medicine_type,
    dosage_strength: m.dosage_strength,
    dosage_form: m.dosage_form,
    manufacturer: m.manufacturer,
    description: m.description,
    purchase_price: m.purchase_price,
    selling_price: m.selling_price,
    current_stock: m.current_stock,
    reorder_level: m.reorder_level,
    unit: m.unit,
    status: m.status,
  }));
  await batchUpsert('medicines', medicinesFormatted, 500, 4, 'id');

  const batchesFormatted = data.batches.map((b) => ({
    id: b.id,
    branch_id: b.branch_id,
    medicine_id: b.medicine_id,
    batch_number: b.batch_number,
    supplier_id: b.supplier_id,
    quantity_received: b.quantity_received,
    quantity_available: b.quantity_available,
    purchase_price: b.purchase_price,
    manufacturing_date: b.manufacturing_date,
    expiry_date: b.expiry_date,
    received_date: b.received_date,
    expiry_status: b.expiry_status,
    notes: b.notes,
    status: b.status,
  }));
  await batchUpsert('medicine_batches', batchesFormatted, 500, 4, 'id');

  // 7. Purchases & Purchase Items
  console.log('\nStep 7/10: Loading Purchases & Line Items...');
  await batchUpsert('purchases', data.purchases, 500, 2, 'id');
  await batchUpsert('purchase_items', data.purchaseItems, 500, 4, 'id');

  // 8. Sales, Sale Items, Payments
  console.log('\nStep 8/10: Loading Historical Sales, Items, and Payments (Marked as Baseline Synced)...');
  const salesFormatted = data.sales.map((s) => ({
    id: s.id,
    branch_id: s.branch_id,
    sale_number: s.sale_number,
    receipt_number: s.receipt_number,
    cashier_id: s.cashier_id,
    customer_id: s.customer_id,
    device_id: s.device_id,
    date: s.date,
    time: s.time,
    subtotal: s.subtotal,
    discount_total: s.discount_total,
    tax_total: s.tax_total,
    total: s.total,
    cost_total: s.cost_total,
    gross_profit: s.gross_profit,
    payment_method: s.payment_method,
    payment_reference: s.payment_reference,
    amount_received: s.amount_received,
    change_given: s.change_given,
    status: s.status,
    idempotency_key: s.idempotency_key,
    sync_status: 'synced',
    created_at: s.created_at,
  }));
  await batchUpsert('sales', salesFormatted, 1000, 6, 'id');

  await batchUpsert('sale_items', data.saleItems, 1000, 6, 'id');
  await batchUpsert('payments', data.payments, 1000, 6, 'id');

  // 9. Inventory Movements & Legacy Map
  console.log('\nStep 9/10: Loading Inventory Movement Audit History & Traceability Mapping...');
  await batchUpsert('inventory_movements', data.movements, 1000, 6, 'id');
  await batchUpsert('legacy_migration_map', data.migrationMap, 1000, 6, 'id');

  // 10. Verification
  console.log('\nStep 10/10: Verifying Supabase Entity Counts and Integrity...');
  const verifyTables = [
    { name: 'medicines', expected: 2181 },
    { name: 'medicine_batches', expected: 2181 },
    { name: 'categories', expected: 580 },
    { name: 'suppliers', expected: 7 },
    { name: 'customers', expected: 1 },
    { name: 'users', expected: 7 },
    { name: 'purchases', expected: 728 },
    { name: 'purchase_items', expected: 2524 },
    { name: 'sales', expected: 135818 },
    { name: 'sale_items', expected: 226401 },
    { name: 'payments', expected: 135817 },
    { name: 'inventory_movements', expected: 263107 },
  ];

  console.log('\nFinal Supabase Verification:');
  let allPass = true;
  for (const vt of verifyTables) {
    const { count, error } = await supabase.from(vt.name).select('*', { count: 'exact', head: true });
    const actual = count ?? 0;
    const match = actual === vt.expected;
    if (!match) allPass = false;
    console.log(`  - ${vt.name.padEnd(25)}: Actual=${actual.toLocaleString().padStart(8)} | Expected=${vt.expected.toLocaleString().padStart(8)} [${match ? 'PASS' : 'FAIL'}]`);
  }

  // Check stock sum
  const { data: stockData, error: stockErr } = await supabase.from('medicines').select('current_stock');
  let totalStock = 0;
  if (stockData) {
    totalStock = stockData.reduce((acc, m) => acc + (m.current_stock || 0), 0);
  }
  console.log(`  - Total Stock Units        : Actual=${totalStock.toLocaleString().padStart(8)} | Expected=  43,686 [${totalStock === 43686 ? 'PASS' : 'FAIL'}]`);

  const totalDuration = ((Date.now() - globalStartTime) / 1000).toFixed(2);
  console.log('\n======================================================================');
  console.log(`  [SUCCESS] SUPABASE DATA LOAD COMPLETED IN ${totalDuration}s (${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS REQUIRE ATTENTION'})`);
  console.log('======================================================================\n');
}

loadSupabaseData().catch((err) => {
  console.error('\n[LOAD ERROR]', err);
  process.exit(1);
});
