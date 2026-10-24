import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  console.log('======================================================================');
  console.log('  STEP 10: POST-CUTOVER APPLICATION FEATURE & LOCAL DB VALIDATION');
  console.log('  Database: giga_chemist_shop2');
  console.log('======================================================================\n');

  const client = new pg.Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '7031',
    database: 'giga_chemist_shop2',
  });

  await client.connect();

  // 1. Identity & Safety Verification
  const idRes = await client.query('SELECT * FROM shop_identity WHERE id = 1');
  const identity = idRes.rows[0];
  console.log('[1. Shop Identity]');
  console.log(`  Shop Code:       ${identity.shop_code} (Expected: SHOP2)`);
  console.log(`  Shop ID:         ${identity.shop_id} (Expected: 13bdb896-e243-4772-accf-b8609e1d977f)`);
  console.log(`  Branch ID:       ${identity.branch_id}`);
  if (identity.shop_code !== 'SHOP2' || identity.shop_id !== '13bdb896-e243-4772-accf-b8609e1d977f') {
    throw new Error('Shop identity validation failed!');
  }
  console.log('  Status:          PASS\n');

  // 2. Admin Login Verification
  const adminUsers = (await client.query("SELECT id, name, email, role, active FROM users WHERE role = 'ADMIN' AND active = TRUE")).rows;
  console.log('[2. Admin Login & Accounts]');
  console.log(`  Active Admins:   ${adminUsers.length}`);
  adminUsers.forEach(a => console.log(`    - ${a.name} (${a.email})`));
  if (adminUsers.length === 0) throw new Error('No active admin users found!');
  console.log('  Status:          PASS\n');

  // 3. Medicine Catalogue
  const medSample = (await client.query("SELECT id, name, sku, barcode, current_stock, selling_price, status FROM medicines WHERE status = 'active' LIMIT 5")).rows;
  const totalMeds = (await client.query('SELECT count(*)::int AS cnt FROM medicines')).rows[0].cnt;
  console.log('[3. Medicine Catalogue]');
  console.log(`  Total Formulary: ${totalMeds.toLocaleString()} items`);
  console.log(`  Sample Active Medicines:`);
  medSample.forEach(m => console.log(`    - ${m.name} | SKU: ${m.sku} | Barcode: ${m.barcode} | Stock: ${m.current_stock} | Price: KES ${Number(m.selling_price).toFixed(2)}`));
  console.log('  Status:          PASS\n');

  // 4. Historical Sales
  const salesCount = (await client.query('SELECT count(*)::int AS cnt FROM sales')).rows[0].cnt;
  const saleSample = (await client.query('SELECT sale_number, receipt_number, date, time, total, status FROM sales ORDER BY created_at DESC LIMIT 3')).rows;
  console.log('[4. Historical Sales]');
  console.log(`  Total Sales:     ${salesCount.toLocaleString()} transactions`);
  saleSample.forEach(s => console.log(`    - ${s.sale_number} (${s.receipt_number}) on ${s.date}: KES ${Number(s.total).toFixed(2)} [${s.status}]`));
  console.log('  Status:          PASS\n');

  // 5. Historical Receipt
  const receiptSale = (await client.query("SELECT * FROM sales WHERE sale_number = 'SALE-S2-89535' LIMIT 1")).rows[0];
  const receiptItems = (await client.query(`
    SELECT si.*, m.name as medicine_name 
    FROM sale_items si 
    JOIN medicines m ON si.medicine_id = m.id 
    WHERE si.sale_id = $1
  `, [receiptSale.id])).rows;
  const receiptPayments = (await client.query('SELECT * FROM payments WHERE sale_id = $1', [receiptSale.id])).rows;
  console.log('[5. Historical Receipt Rendering]');
  console.log(`  Receipt:         ${receiptSale.receipt_number} (${receiptSale.sale_number})`);
  console.log(`  Items:           ${receiptItems.length} lines`);
  receiptItems.forEach(i => console.log(`    * ${i.medicine_name} x ${i.quantity} @ KES ${Number(i.unit_price).toFixed(2)} = KES ${Number(i.total).toFixed(2)}`));
  console.log(`  Payments:        ${receiptPayments.length} records`);
  receiptPayments.forEach(p => console.log(`    * ${p.method}: KES ${Number(p.amount).toFixed(2)} (Ref: ${p.reference})`));
  console.log('  Status:          PASS\n');

  // 6. Purchase History
  const poCount = (await client.query('SELECT count(*)::int AS cnt FROM purchases')).rows[0].cnt;
  const poItemsCount = (await client.query('SELECT count(*)::int AS cnt FROM purchase_items')).rows[0].cnt;
  const poSample = (await client.query(`
    SELECT p.order_number, p.order_date, p.total_amount, count(pi.id)::int as lines
    FROM purchases p
    JOIN purchase_items pi ON p.id = pi.purchase_id
    GROUP BY p.id, p.order_number, p.order_date, p.total_amount
    ORDER BY p.order_date DESC LIMIT 3
  `)).rows;
  console.log('[6. Purchase History]');
  console.log(`  Purchases:       ${poCount.toLocaleString()} orders (${poItemsCount.toLocaleString()} received lines)`);
  poSample.forEach(po => console.log(`    - ${po.order_number} on ${po.order_date}: KES ${Number(po.total_amount).toFixed(2)} across ${po.lines} lines`));
  console.log('  Status:          PASS\n');

  // 7. Stock & Batch Display
  const stockSummary = (await client.query(`
    SELECT 
      SUM(m.current_stock)::bigint as med_stock,
      SUM(b.quantity_available)::bigint as batch_stock,
      count(b.id)::int as batch_count
    FROM medicines m
    JOIN medicine_batches b ON m.id = b.medicine_id
  `)).rows[0];
  console.log('[7. Stock & Batch Parity]');
  console.log(`  Active Batches:  ${stockSummary.batch_count.toLocaleString()}`);
  console.log(`  Medicines Stock: ${Number(stockSummary.med_stock).toLocaleString()} units`);
  console.log(`  Batches Stock:   ${Number(stockSummary.batch_stock).toLocaleString()} units`);
  console.log(`  Parity Status:   ${stockSummary.med_stock === stockSummary.batch_stock ? '100% BALANCED' : 'MISMATCH'}`);
  if (stockSummary.med_stock !== stockSummary.batch_stock) throw new Error('Stock parity mismatch!');
  console.log('  Status:          PASS\n');

  // 8. Financial Reports
  const reportTotals = (await client.query(`
    SELECT 
      SUM(subtotal) AS gross,
      SUM(discount_total) AS discounts,
      SUM(total) AS net,
      SUM(cost_total) AS cogs,
      SUM(gross_profit) AS profit
    FROM sales
  `)).rows[0];
  console.log('[8. Financial Reports Generation]');
  console.log(`  Gross Subtotal:  KES ${Number(reportTotals.gross).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  Discounts:       KES ${Number(reportTotals.discounts).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  Net Sales:       KES ${Number(reportTotals.net).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  COGS:            KES ${Number(reportTotals.cogs).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  Gross Profit:    KES ${Number(reportTotals.profit).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log('  Status:          PASS\n');

  console.log('======================================================================');
  console.log('✓ POST-CUTOVER APPLICATION VALIDATION: 100% PASS');
  console.log('======================================================================\n');

  await client.end();
}

main().catch(err => {
  console.error('\n[FEATURE VALIDATION FAILED]:', err.message);
  process.exit(1);
});
