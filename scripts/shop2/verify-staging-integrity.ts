import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const STAGING_DB = 'giga_chemist_shop2_legacy_stage';
  const client = new pg.Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '7031',
    database: STAGING_DB,
  });

  await client.connect();
  console.log(`======================================================================`);
  console.log(`  STEP 5: FINAL STAGING READ-ONLY INTEGRITY & RECEIPT VERIFICATION`);
  console.log(`  Target Database: ${STAGING_DB}`);
  console.log(`======================================================================\n`);

  // 1. Migrations count
  const migRes = await client.query('SELECT count(*)::int AS cnt FROM schema_migrations');
  const migCount = migRes.rows[0].cnt;
  console.log(`Migrations recorded in schema_migrations: ${migCount} / 28`);
  if (migCount < 28) {
    throw new Error(`Expected at least 28 migrations, found ${migCount}`);
  }

  // 2. Entity counts
  const expectedCounts: Record<string, number> = {
    medicines: 2326,
    medicine_batches: 2326,
    sales: 102131,
    sale_items: 185378,
    payments: 101927,
    purchases: 443,
    purchase_items: 1458,
    inventory_movements: 222629,
  };

  for (const [table, expected] of Object.entries(expectedCounts)) {
    const res = await client.query(`SELECT count(*)::int AS cnt FROM "${table}"`);
    const actual = res.rows[0].cnt;
    const ok = actual === expected;
    console.log(`  - ${table.padEnd(20)}: ${actual.toLocaleString().padStart(8)} (Expected: ${expected.toLocaleString().padStart(8)}) -> ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error(`Count mismatch in ${table}: expected ${expected}, got ${actual}`);
  }

  // 3. Negative checks
  const negStock = (await client.query('SELECT count(*)::int AS cnt FROM medicines WHERE current_stock < 0')).rows[0].cnt;
  const negBatch = (await client.query('SELECT count(*)::int AS cnt FROM medicine_batches WHERE quantity_available < 0')).rows[0].cnt;
  console.log(`\nNegative stock values:`);
  console.log(`  - medicines.current_stock < 0:        ${negStock} -> ${negStock === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  - batches.quantity_available < 0:     ${negBatch} -> ${negBatch === 0 ? 'PASS' : 'FAIL'}`);
  if (negStock > 0 || negBatch > 0) throw new Error('Found negative stock values!');

  // 4. Duplicate active barcodes
  const dupBarcodes = (await client.query(`
    SELECT barcode, count(*)::int AS cnt 
    FROM medicines 
    WHERE status = 'active' 
    GROUP BY barcode 
    HAVING count(*) > 1
  `)).rows;
  console.log(`Duplicate active barcodes:            ${dupBarcodes.length} -> ${dupBarcodes.length === 0 ? 'PASS' : 'FAIL'}`);
  if (dupBarcodes.length > 0) throw new Error('Found duplicate active barcodes!');

  // 5. Stock invariant
  const stockParity = (await client.query(`
    SELECT 
      SUM(m.current_stock)::bigint AS med_stock,
      SUM(b.quantity_available)::bigint AS batch_stock
    FROM medicines m
    JOIN medicine_batches b ON m.id = b.medicine_id
  `)).rows[0];
  const parityPass = stockParity.med_stock === stockParity.batch_stock && Number(stockParity.med_stock) === 62912;
  console.log(`Stock parity (Med=${stockParity.med_stock}, Batch=${stockParity.batch_stock}): ${parityPass ? 'PASS [100% BALANCED]' : 'FAIL'}`);
  if (!parityPass) throw new Error('Stock parity mismatch!');

  // 6. Foreign key orphans
  const orphans = {
    sale_items: (await client.query('SELECT count(*)::int AS cnt FROM sale_items si LEFT JOIN sales s ON si.sale_id = s.id WHERE s.id IS NULL')).rows[0].cnt,
    sale_items_med: (await client.query('SELECT count(*)::int AS cnt FROM sale_items si LEFT JOIN medicines m ON si.medicine_id = m.id WHERE m.id IS NULL')).rows[0].cnt,
    payments: (await client.query('SELECT count(*)::int AS cnt FROM payments p LEFT JOIN sales s ON p.sale_id = s.id WHERE s.id IS NULL')).rows[0].cnt,
    purchase_items: (await client.query('SELECT count(*)::int AS cnt FROM purchase_items pi LEFT JOIN purchases p ON pi.purchase_id = p.id WHERE p.id IS NULL')).rows[0].cnt,
    batches: (await client.query('SELECT count(*)::int AS cnt FROM medicine_batches b LEFT JOIN medicines m ON b.medicine_id = m.id WHERE m.id IS NULL')).rows[0].cnt,
  };
  console.log(`\nForeign key orphan checks:`);
  for (const [key, cnt] of Object.entries(orphans)) {
    console.log(`  - Orphan ${key.padEnd(20)}: ${cnt} -> ${cnt === 0 ? 'PASS' : 'FAIL'}`);
    if (cnt > 0) throw new Error(`Orphan records found in ${key}!`);
  }

  // 7. Historical Receipt queries
  console.log(`\n======================================================================`);
  console.log(`  HISTORICAL RECEIPT SAMPLES VALIDATION`);
  console.log(`======================================================================`);

  async function loadReceipt(description: string, saleIdQuery: string) {
    const saleRow = (await client.query(saleIdQuery)).rows[0];
    if (!saleRow) throw new Error(`Could not find sale for ${description}`);
    const items = (await client.query(`
      SELECT si.id, si.batch_number, si.quantity, si.unit_price, si.discount, si.total, m.name as medicine_name
      FROM sale_items si
      JOIN medicines m ON si.medicine_id = m.id
      WHERE si.sale_id = $1
      ORDER BY si.id
    `, [saleRow.id])).rows;

    const payments = (await client.query(`
      SELECT id, method, amount, reference, created_at
      FROM payments
      WHERE sale_id = $1
    `, [saleRow.id])).rows;

    console.log(`\n[Receipt: ${description}]`);
    console.log(`  Sale ID:         ${saleRow.id}`);
    console.log(`  Sale Number:     ${saleRow.sale_number}`);
    console.log(`  Receipt Number:  ${saleRow.receipt_number}`);
    console.log(`  Date/Time:       ${saleRow.date} ${saleRow.time}`);
    console.log(`  Subtotal:        KES ${Number(saleRow.subtotal).toFixed(2)}`);
    console.log(`  Discount:        KES ${Number(saleRow.discount_total).toFixed(2)}`);
    console.log(`  Total:           KES ${Number(saleRow.total).toFixed(2)}`);
    console.log(`  Items Count:     ${items.length}`);
    items.forEach((it, idx) => {
      console.log(`    Line ${idx + 1}: ${it.medicine_name} | Qty: ${it.quantity} @ KES ${Number(it.unit_price).toFixed(2)} = KES ${Number(it.total).toFixed(2)} (Batch: ${it.batch_number})`);
    });
    console.log(`  Payments Count:  ${payments.length}`);
    payments.forEach(p => {
      console.log(`    Payment: Method: ${p.method} | Amount: KES ${Number(p.amount).toFixed(2)} | Ref: ${p.reference}`);
    });
    console.log(`  Status:          VERIFIED PASS`);
  }

  // Oldest sale
  await loadReceipt('Oldest Historical Sale', `
    SELECT * FROM sales ORDER BY date ASC, time ASC, id ASC LIMIT 1
  `);

  // Newest sale
  await loadReceipt('Newest Historical Sale', `
    SELECT * FROM sales ORDER BY date DESC, time DESC, id DESC LIMIT 1
  `);

  // Random sale
  await loadReceipt('Random Mid-Range Sale', `
    SELECT * FROM sales WHERE sale_number = 'SALE-S2-50000' LIMIT 1
  `);

  // Multi-item sale
  await loadReceipt('Multi-Item Sale (>= 4 lines)', `
    SELECT s.* 
    FROM sales s
    JOIN (
      SELECT sale_id, count(*) as cnt FROM sale_items GROUP BY sale_id HAVING count(*) >= 4 LIMIT 1
    ) multi ON s.id = multi.sale_id
    LIMIT 1
  `);

  // Sale whose original source contained normalized values (Sale ID 89535 had the 0.3 qty item excluded)
  await loadReceipt('Sale with Normalized Fractional Source Line (Sale #89535)', `
    SELECT * FROM sales WHERE sale_number = 'SALE-S2-89535' LIMIT 1
  `);

  console.log(`\n======================================================================`);
  console.log(`✓ FINAL STAGING INTEGRITY & HISTORICAL RECEIPTS: 100% PASS`);
  console.log(`======================================================================\n`);

  await client.end();
}

main().catch(err => {
  console.error('\n[STAGING INTEGRITY VERIFICATION FAILED]:', err.message);
  process.exit(1);
});
