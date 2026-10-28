import crypto from 'crypto';
import express from 'express';
import pg from 'pg';

process.env.ONLINE_DATABASE_URL = 'postgresql://postgres.ifhrvzhrxllrykrmpxtm:0723373424Aim@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
process.env.JWT_SECRET = '7KHVIErOKh-1akMsyNPp4_8qUpcxS17fqUl2IQLwaJVatT7aoOVfyQDy_UQHh3NbaML6IqZsrOECFYT6p_JjIg';

import { buildOnlineRouter } from '../../server/online/app';

const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const SHOP2_ID = '13bdb896-e243-4772-accf-b8609e1d977f';

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`PASS: ${msg}`);
}

async function runTests() {
  console.log('\n======================================================');
  console.log('PHASE 8 & 9 — ONLINE CASHIER SALES & ISOLATION SUITE');
  console.log('======================================================\n');

  let cloudClient: pg.Client | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      cloudClient = new pg.Client({ connectionString: process.env.ONLINE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await cloudClient.connect();
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!cloudClient) throw new Error('Could not connect to cloud DB');

  const app = express();
  app.use(express.json());
  app.use('/api', buildOnlineRouter());

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const req = async (method: string, path: string, token?: string, headers: Record<string, string> = {}, body?: any) => {
    const h: Record<string, string> = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };

  // Record baseline Shop 1 counts to guarantee zero alteration
  const shop1BaselineMeds = (await cloudClient.query('SELECT count(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1', [SHOP1_ID])).rows[0].count;
  const shop1BaselineBatches = (await cloudClient.query('SELECT count(*)::int AS count FROM giga_cloud.medicine_batches WHERE shop_id = $1', [SHOP1_ID])).rows[0].count;
  const shop1BaselineStock = (await cloudClient.query('SELECT sum(last_reported_quantity)::bigint AS stock FROM giga_cloud.stock_levels WHERE shop_id = $1', [SHOP1_ID])).rows[0].stock;

  // Create disposable test medicine for Shop 2
  const testMedId = crypto.randomUUID();
  const testBatchId = crypto.randomUUID();
  const testBarcode = `TEST-S2-${Date.now().toString().slice(-6)}`;
  const testIdempotencyKey = `SALE-TEST-${crypto.randomUUID()}`;

  try {
    console.log('--- 1. CASHIER LOGIN & ACCOUNT RESOLUTION ---');
    const nancyLogin = await req('POST', '/api/auth/login', undefined, {}, { username: 'nancy', password: 'Nancy@2026!' });
    check(nancyLogin.status === 200, 'Nancy login status 200');
    check(nancyLogin.data?.user?.role === 'CASHIER', 'Nancy role is CASHIER');
    check(nancyLogin.data?.account?.shop_id === SHOP2_ID, 'Nancy account scoped to Shop 2');
    const nancyToken = nancyLogin.data?.token;

    const risperLogin = await req('POST', '/api/auth/login', undefined, {}, { username: 'risper', password: 'Risper@2026!' });
    check(risperLogin.status === 200, 'Risper login status 200');
    check(risperLogin.data?.user?.role === 'CASHIER', 'Risper role is CASHIER');
    check(risperLogin.data?.account?.shop_id === SHOP1_ID, 'Risper account scoped to Shop 1');
    const risperToken = risperLogin.data?.token;

    console.log('\n--- 2. SETUP DISPOSABLE SHOP 2 TEST MEDICINE (STOCK = 10) ---');
    await cloudClient.query("DELETE FROM giga_cloud.stock_levels WHERE shop_id = $1 AND medicine_id IN (SELECT medicine_id FROM giga_cloud.medicines WHERE shop_id = $1 AND name = 'DISPOSABLE ONLINE TEST MEDICINE')", [SHOP2_ID]);
    await cloudClient.query("DELETE FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id IN (SELECT medicine_id FROM giga_cloud.medicines WHERE shop_id = $1 AND name = 'DISPOSABLE ONLINE TEST MEDICINE')", [SHOP2_ID]);
    await cloudClient.query("DELETE FROM giga_cloud.medicines WHERE shop_id = $1 AND name = 'DISPOSABLE ONLINE TEST MEDICINE'", [SHOP2_ID]);
    await cloudClient.query(
      `INSERT INTO giga_cloud.medicines (
         shop_id, medicine_id, name, barcode, status, selling_price, purchase_price, local_version, data, source_seq
       ) VALUES ($1, $2, 'DISPOSABLE ONLINE TEST MEDICINE', $3, 'active', 100.00, 40.00, 1, '{}'::jsonb, 0)`,
      [SHOP2_ID, testMedId, testBarcode]
    );

    await cloudClient.query(
      `INSERT INTO giga_cloud.medicine_batches (
         shop_id, batch_id, medicine_id, batch_number, expiry_date, status, data, source_seq
       ) VALUES ($1, $2, $3, 'BATCH-ONLINE-001', '2028-12-31', 'active', '{"quantity_available": 10}'::jsonb, 0)`,
      [SHOP2_ID, testBatchId, testMedId]
    );

    await cloudClient.query(
      `INSERT INTO giga_cloud.stock_levels (
         shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq,
         delta_since_baseline, last_reported_quantity, stock_version
       ) VALUES ($1, $2, $3, true, 10, 0, 0, 10, 1)`,
      [SHOP2_ID, testMedId, testBatchId]
    );
    console.log('PASS: Disposable test medicine created in Supabase with quantity = 10');

    console.log('\n--- 3. COMPLETE ONLINE CASHIER SALE (SELL 2 UNITS) ---');
    const salePayload = {
      idempotency_key: testIdempotencyKey,
      price_mode: 'RETAIL',
      items: [
        {
          medicine_id: testMedId,
          quantity: 2,
          unit_price: 100,
        },
      ],
      payment: {
        method: 'Cash',
        amount_received: 250,
      },
    };

    const checkoutRes = await req('POST', '/api/sales/checkout', nancyToken, {}, salePayload);
    check(checkoutRes.status === 201, `Checkout returned 201 Created (got ${checkoutRes.status})`);
    check(checkoutRes.data?.success === true, 'Checkout response success is true');
    check(checkoutRes.data?.duplicate === false, 'Duplicate is false');

    const sale = checkoutRes.data?.sale;
    check(Boolean(sale?.id), 'Sale ID exists');
    check(Boolean(sale?.receipt_number), `Receipt number generated: ${sale?.receipt_number}`);
    check(sale?.total === 200, `Sale total is 200 (got ${sale?.total})`);
    check(sale?.amount_received === 250, 'Amount received is 250');
    check(sale?.change_given === 50, 'Change given is 50');
    check(sale?.status === 'completed', 'Sale status is completed');
    check(sale?.items?.length === 1, 'Sale has 1 line item');
    check(sale?.items[0]?.quantity === 2, 'Line item quantity is 2');

    // RBAC check: Cost fields must be hidden for Cashier
    check(sale?.cost_total === 0, 'Cost total is hidden (0) for Cashier');
    check(sale?.gross_profit === 0, 'Gross profit is hidden (0) for Cashier');
    check(sale?.items[0]?.cost_price_snapshot === 0, 'Cost price snapshot is hidden (0) for Cashier');

    console.log('\n--- 4. VERIFY CLOUD STOCK DEDUCTION (10 -> 8) ---');
    const stockRow = (await cloudClient.query(
      `SELECT last_reported_quantity, delta_since_baseline, baseline_quantity,
              (CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline ELSE last_reported_quantity END)::int AS effective_qty
       FROM giga_cloud.stock_levels
       WHERE shop_id = $1 AND batch_id = $2`,
      [SHOP2_ID, testBatchId]
    )).rows[0];

    check(stockRow.effective_qty === 8, `Effective stock is exactly 8 (got ${stockRow.effective_qty})`);
    check(stockRow.last_reported_quantity === 8, `last_reported_quantity is 8 (got ${stockRow.last_reported_quantity})`);

    const movementRow = (await cloudClient.query(
      `SELECT movement_type, reason, delta, previous_quantity, new_quantity, reference_id
       FROM giga_cloud.inventory_movements
       WHERE shop_id = $1 AND batch_id = $2`,
      [SHOP2_ID, testBatchId]
    )).rows[0];

    check(movementRow?.movement_type === 'SALE', 'Inventory movement type is SALE');
    check(movementRow?.delta === -2, `Movement delta is -2 (got ${movementRow?.delta})`);
    check(movementRow?.previous_quantity === 10, 'Movement previous_quantity is 10');
    check(movementRow?.new_quantity === 8, 'Movement new_quantity is 8');

    console.log('\n--- 5. IDEMPOTENCY: RETRY WITH SAME IDEMPOTENCY KEY ---');
    const duplicateRes = await req('POST', '/api/sales/checkout', nancyToken, {}, salePayload);
    check(duplicateRes.status === 200, `Duplicate request returns HTTP 200 (got ${duplicateRes.status})`);
    check(duplicateRes.data?.duplicate === true, 'Duplicate flag is true');
    check(duplicateRes.data?.sale?.id === sale.id, 'Returns original sale ID');

    const stockAfterRetry = (await cloudClient.query(
      `SELECT (CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline ELSE last_reported_quantity END)::int AS effective_qty
       FROM giga_cloud.stock_levels
       WHERE shop_id = $1 AND batch_id = $2`,
      [SHOP2_ID, testBatchId]
    )).rows[0].effective_qty;

    check(stockAfterRetry === 8, `Stock remained exactly 8 after duplicate submission (got ${stockAfterRetry})`);

    const saleCount = (await cloudClient.query(
      'SELECT count(*)::int AS count FROM giga_cloud.sales WHERE shop_id = $1 AND local_idempotency_key = $2',
      [SHOP2_ID, testIdempotencyKey]
    )).rows[0].count;
    check(saleCount === 1, 'Exactly ONE sale row exists in giga_cloud.sales');

    console.log('\n--- 6. INSUFFICIENT STOCK PROTECTION ---');
    const oversellPayload = {
      idempotency_key: `SALE-OVERSELL-${crypto.randomUUID()}`,
      price_mode: 'RETAIL',
      items: [
        {
          medicine_id: testMedId,
          quantity: 20, // requested 20 when only 8 available
          unit_price: 100,
        },
      ],
      payment: {
        method: 'Cash',
        amount_received: 2000,
      },
    };

    const oversellRes = await req('POST', '/api/sales/checkout', nancyToken, {}, oversellPayload);
    check(oversellRes.status === 409, `Oversell rejected with HTTP 409 (got ${oversellRes.status})`);
    check(oversellRes.data?.error?.includes('Insufficient sellable stock'), 'Error message states Insufficient sellable stock');

    const stockAfterOversell = (await cloudClient.query(
      `SELECT (CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline ELSE last_reported_quantity END)::int AS effective_qty
       FROM giga_cloud.stock_levels
       WHERE shop_id = $1 AND batch_id = $2`,
      [SHOP2_ID, testBatchId]
    )).rows[0].effective_qty;
    check(stockAfterOversell === 8, 'Stock remains unchanged at 8 after failed checkout');

    console.log('\n--- 7. MULTI-SHOP ISOLATION & FORGERY DEFENSE ---');
    // Nancy (Shop 2) tries to send X-GIGA-SHOP-ID = SHOP1
    const forgedHeaderRes = await req('GET', '/api/medicines', nancyToken, { 'X-GIGA-SHOP-ID': SHOP1_ID });
    check(forgedHeaderRes.status === 403, `Forged X-GIGA-SHOP-ID rejected with 403 (got ${forgedHeaderRes.status})`);
    check(forgedHeaderRes.data?.code === 'SHOP_ACCESS_DENIED', 'Error code is SHOP_ACCESS_DENIED');

    // Nancy (Shop 2) tries to query ?shop_id=SHOP1
    const forgedQueryRes = await req('GET', `/api/medicines?shop_id=${SHOP1_ID}`, nancyToken);
    check(forgedQueryRes.status === 403, `Forged ?shop_id= query rejected with 403 (got ${forgedQueryRes.status})`);
    check(forgedQueryRes.data?.code === 'SHOP_ACCESS_DENIED', 'Error code is SHOP_ACCESS_DENIED');

    // Nancy tries to checkout a Shop 1 medicine
    const shop1MedRow = (await cloudClient.query('SELECT medicine_id FROM giga_cloud.medicines WHERE shop_id = $1 LIMIT 1', [SHOP1_ID])).rows[0];
    const crossShopSaleRes = await req('POST', '/api/sales/checkout', nancyToken, {}, {
      idempotency_key: `SALE-CROSS-${crypto.randomUUID()}`,
      items: [{ medicine_id: shop1MedRow.medicine_id, quantity: 1, unit_price: 100 }],
      payment: { method: 'Cash', amount_received: 100 },
    });
    check(crossShopSaleRes.status === 404, `Cross-shop medicine checkout rejected with 404 (got ${crossShopSaleRes.status})`);

    // Verify Shop 1 remains completely untouched throughout all tests
    const shop1FinalMeds = (await cloudClient.query('SELECT count(*)::int AS count FROM giga_cloud.medicines WHERE shop_id = $1', [SHOP1_ID])).rows[0].count;
    const shop1FinalBatches = (await cloudClient.query('SELECT count(*)::int AS count FROM giga_cloud.medicine_batches WHERE shop_id = $1', [SHOP1_ID])).rows[0].count;
    const shop1FinalStock = (await cloudClient.query('SELECT sum(last_reported_quantity)::bigint AS stock FROM giga_cloud.stock_levels WHERE shop_id = $1', [SHOP1_ID])).rows[0].stock;

    check(shop1FinalMeds === shop1BaselineMeds, `Shop 1 medicines count strictly preserved (${shop1FinalMeds})`);
    check(shop1FinalBatches === shop1BaselineBatches, `Shop 1 batches count strictly preserved (${shop1FinalBatches})`);
    check(shop1FinalStock === shop1BaselineStock, `Shop 1 stock total strictly preserved (${shop1FinalStock})`);

    console.log('\n--- 8. CASHIER OWN SALES HISTORY ---');
    const nancySalesRes = await req('GET', '/api/sales?limit=10', nancyToken);
    check(nancySalesRes.status === 200, 'Nancy can fetch own sales history (HTTP 200)');
    const nancySalesList = nancySalesRes.data?.sales || [];
    const foundOurSale = nancySalesList.find((s: any) => s.id === sale.id);
    check(Boolean(foundOurSale), 'Completed online sale appears in Nancy sales history');
    check(foundOurSale?.cost_total === 0, 'Sales history cost total is hidden (0) for Cashier');

    console.log('\n--- 9. CLEAN UP DISPOSABLE TEST FIXTURES ---');
    await cloudClient.query('DELETE FROM giga_cloud.inventory_movements WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.payments WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, sale.id]);
    await cloudClient.query('DELETE FROM giga_cloud.sale_items WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, sale.id]);
    await cloudClient.query('DELETE FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, sale.id]);
    await cloudClient.query('DELETE FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [SHOP2_ID, testMedId]);
    console.log('PASS: Disposable test fixtures cleanly removed from Supabase');

    console.log('\n======================================================');
    console.log('ALL PHASE 8 & 9 TESTS PASSED PERFECTLY!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await cloudClient.end();
  }
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
