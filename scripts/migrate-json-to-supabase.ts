import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { serverDb } from '../server/db';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function runMigration() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — JSON to Supabase PostgreSQL Migration');
  console.log('=============================================================');

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const jsonDb = serverDb.get();
  console.log(`Loaded JSON Database with:`);
  console.log(`- ${jsonDb.medicines.length} Medicines`);
  console.log(`- ${jsonDb.medicine_batches.length} Batches`);
  console.log(`- ${jsonDb.suppliers.length} Suppliers`);
  console.log(`- ${jsonDb.customers.length} Customers`);
  console.log(`- ${jsonDb.sales.length} Sales`);
  console.log(`- ${jsonDb.inventory_movements.length} Movements`);
  console.log(`- ${jsonDb.audit_logs.length} Audit Logs`);

  const summary = {
    suppliers: 0,
    medicines: 0,
    batches: 0,
    customers: 0,
    sales: 0,
    errors: [] as string[],
  };

  // 1. Migrate Suppliers
  console.log('\n[1/5] Migrating Suppliers...');
  for (const s of jsonDb.suppliers) {
    const { error } = await supabase.from('suppliers').upsert({
      id: s.id,
      name: s.name,
      contact_person: s.contact_person || '',
      phone: s.phone,
      email: s.email || '',
      address: s.address || '',
      tax_pin: s.tax_pin || '',
      balance: s.balance || 0,
      status: s.status || 'active',
    });
    if (error) {
      summary.errors.push(`Supplier ${s.name}: ${error.message}`);
    } else {
      summary.suppliers++;
    }
  }

  // 2. Migrate Medicines
  console.log('[2/5] Migrating Medicines...');
  for (const m of jsonDb.medicines) {
    const { error } = await supabase.from('medicines').upsert({
      id: m.id,
      name: m.name,
      generic_name: m.generic_name,
      brand_name: m.brand_name || '',
      sku: m.sku,
      barcode: m.barcode,
      category_id: null,
      medicine_type: m.medicine_type || '',
      dosage_strength: m.dosage_strength,
      dosage_form: m.dosage_form,
      manufacturer: m.manufacturer || '',
      description: m.description || '',
      purchase_price: m.purchase_price,
      selling_price: m.selling_price,
      wholesale_price: m.wholesale_price || m.selling_price,
      min_selling_price: m.min_selling_price || m.selling_price,
      current_stock: m.current_stock,
      reorder_level: m.reorder_level,
      unit: m.unit,
      prescription_required: Boolean(m.prescription_required),
      status: m.status || 'active',
      version: m.version || 1,
    });
    if (error) {
      summary.errors.push(`Medicine ${m.name}: ${error.message}`);
    } else {
      summary.medicines++;
    }
  }

  // 3. Migrate Batches
  console.log('[3/5] Migrating Medicine Batches...');
  for (const b of jsonDb.medicine_batches) {
    const { error } = await supabase.from('medicine_batches').upsert({
      id: b.id,
      medicine_id: b.medicine_id,
      batch_number: b.batch_number,
      supplier_id: b.supplier_id || null,
      quantity_received: b.quantity_received,
      quantity_available: b.quantity_available,
      purchase_price: b.purchase_price,
      manufacturing_date: b.manufacturing_date,
      expiry_date: b.expiry_date,
      received_date: b.received_date,
      purchase_invoice: b.purchase_invoice || '',
      status: b.status || 'active',
    });
    if (error) {
      summary.errors.push(`Batch ${b.batch_number}: ${error.message}`);
    } else {
      summary.batches++;
    }
  }

  // 4. Migrate Customers
  console.log('[4/5] Migrating Customers...');
  for (const c of jsonDb.customers) {
    const { error } = await supabase.from('customers').upsert({
      id: c.id,
      name: c.name,
      phone: c.phone || '',
      email: c.email || '',
      address: c.address || '',
      credit_balance: c.credit_balance || 0,
      total_spent: c.total_spent || 0,
    });
    if (error) {
      summary.errors.push(`Customer ${c.name}: ${error.message}`);
    } else {
      summary.customers++;
    }
  }

  // 5. Migrate Settings
  console.log('[5/5] Migrating Settings...');
  const st = jsonDb.settings;
  const { error: setErr } = await supabase.from('settings').upsert({
    branch_id: '00000000-0000-0000-0000-000000000000',
    pharmacy_name: st.pharmacy_name,
    tagline: st.tagline,
    address: st.address,
    phone: st.phone,
    email: st.email,
    currency: st.currency,
    tax_rate: st.tax_rate,
    tax_enabled: st.tax_enabled,
    receipt_header: st.receipt_header,
    receipt_footer: st.receipt_footer,
    printer_type: st.printer_type,
    auto_print_receipt: st.auto_print_receipt,
    low_stock_threshold: st.low_stock_threshold,
    expiry_warning_days: st.expiry_warning_days,
    version: st.version,
  });
  if (setErr) {
    summary.errors.push(`Settings: ${setErr.message}`);
  }

  console.log('\n=============================================================');
  console.log('  MIGRATION SUMMARY');
  console.log('=============================================================');
  console.log(`Suppliers Migrated: ${summary.suppliers}`);
  console.log(`Medicines Migrated: ${summary.medicines}`);
  console.log(`Batches Migrated:   ${summary.batches}`);
  console.log(`Customers Migrated: ${summary.customers}`);
  if (summary.errors.length > 0) {
    console.warn(`\nWarnings/Errors encountered (${summary.errors.length}):`);
    summary.errors.forEach((e) => console.warn(`- ${e}`));
  } else {
    console.log('\nAll core records migrated cleanly with zero errors!');
  }
}

runMigration().catch((err) => {
  console.error('Migration failed with unexpected error:', err);
  process.exit(1);
});
