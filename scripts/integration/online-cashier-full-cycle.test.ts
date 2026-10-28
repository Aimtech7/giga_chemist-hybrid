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
  console.log('ONLINE CASHIER FULL CYCLE: SHIFTS + LIVE SALES TEST');
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
    return { status: res.status, data };
  };

  const testMedId = crypto.randomUUID();
  const testBatchId = crypto.randomUUID();
  const testIdempotencyKey = `KEY-${crypto.randomUUID()}`;
  let openShiftId: string | null = null;

  try {
    // 1. CASHIER LOGIN
    console.log('--- 1. CASHIER LOGIN ---');
    const nancyRes = await req('POST', '/api/auth/login', undefined, {}, { username: 'nancy', password: 'Nancy@2026!' });
    check(nancyRes.status === 200, 'Nancy login status 200');
    const nancyToken = nancyRes.data?.token;
    check(nancyRes.data?.account?.shop_id === SHOP2_ID, 'Nancy scoped to Shop 2');

    // Clean up any stale open shift for Nancy before starting test
    await cloudClient.query(
      `UPDATE giga_cloud.cashier_shifts SET status = 'CLOSED', closed_at = now() WHERE shop_id = $1 AND cashier_id = $2 AND status = 'OPEN'`,
      [SHOP2_ID, nancyRes.data?.account?.local_user_id || nancyRes.data?.user?.id]
    );

    // 2. CHECK INITIAL CURRENT SHIFT IS NULL
    console.log('\n--- 2. INITIAL CURRENT SHIFT CHECK ---');
    const initialShiftRes = await req('GET', '/api/shifts/current', nancyToken);
    check(initialShiftRes.status === 200, 'GET /shifts/current returns 200');
    check(initialShiftRes.data?.shift === null, 'Initial shift is null');

    // 3. OPEN SHIFT ONLINE
    console.log('\n--- 3. OPEN SHIFT ONLINE ---');
    const openRes = await req('POST', '/api/shifts/open', nancyToken, {}, { opening_float: 500 });
    check(openRes.status === 201, `POST /shifts/open returns 201 (got ${openRes.status})`);
    check(openRes.data?.created === true, 'Shift created flag is true');
    const shift = openRes.data?.shift;
    openShiftId = shift?.id;
    check(Boolean(openShiftId), `Open shift ID generated: ${openShiftId}`);
    check(shift?.status === 'OPEN', 'Shift status is OPEN');
    check(shift?.opening_float === 500, 'Opening float is 500');
    check(openRes.data?.live?.total_sales === 0, 'Initial live sales is 0');
    check(openRes.data?.live?.expected_cash === 500, 'Initial expected cash is 500');

    // 4. VERIFY GET /shifts/current RETURNS THE OPEN SHIFT
    console.log('\n--- 4. VERIFY GET /shifts/current ---');
    const currentRes = await req('GET', '/api/shifts/current', nancyToken);
    check(currentRes.status === 200, 'GET /shifts/current returns 200');
    check(currentRes.data?.shift?.id === openShiftId, 'Current shift matches opened shift ID');
    check(currentRes.data?.shift?.status === 'OPEN', 'Current shift status is OPEN');

    // 5. SETUP TEST MEDICINE IN SHOP 2
    console.log('\n--- 5. SETUP TEST MEDICINE IN SHOP 2 (STOCK = 10) ---');
    await cloudClient.query(
      `INSERT INTO giga_cloud.medicines (
         shop_id, medicine_id, name, barcode, status, selling_price, purchase_price, local_version, data, source_seq
       ) VALUES ($1, $2, 'ONLINE FULL CYCLE TEST TABLET', 'BC-FC-001', 'active', 100.00, 40.00, 1, '{}'::jsonb, 0)`,
      [SHOP2_ID, testMedId]
    );

    await cloudClient.query(
      `INSERT INTO giga_cloud.medicine_batches (
         shop_id, batch_id, medicine_id, batch_number, expiry_date, status, data, source_seq
       ) VALUES ($1, $2, $3, 'BATCH-ONLINE-FC', '2028-12-31', 'active', '{"quantity_available": 10}'::jsonb, 0)`,
      [SHOP2_ID, testBatchId, testMedId]
    );

    await cloudClient.query(
      `INSERT INTO giga_cloud.stock_levels (
         shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq,
         delta_since_baseline, last_reported_quantity, stock_version
       ) VALUES ($1, $2, $3, true, 10, 0, 0, 10, 1)`,
      [SHOP2_ID, testMedId, testBatchId]
    );
    console.log('PASS: Test medicine and batch created');

    // 6. COMPLETE ONLINE SALE (SELL 3 UNITS @ 100 = 300)
    console.log('\n--- 6. COMPLETE ONLINE SALE WITH OPEN SHIFT ---');
    const salePayload = {
      idempotency_key: testIdempotencyKey,
      price_mode: 'RETAIL',
      items: [{ medicine_id: testMedId, quantity: 3, unit_price: 100 }],
      payment: { method: 'Cash', amount_received: 500 },
    };

    const checkoutRes = await req('POST', '/api/sales/checkout', nancyToken, {}, salePayload);
    check(checkoutRes.status === 201, 'Checkout returns 201 Created');
    const completedSale = checkoutRes.data?.sale;
    check(completedSale?.total === 300, 'Sale total is 300');
    check(completedSale?.status === 'completed', 'Sale status is completed');

    // 7. VERIFY SHIFT LIVE TOTALS UPDATED AUTOMATICALLY
    console.log('\n--- 7. VERIFY SHIFT LIVE TOTALS UPDATED ---');
    const updatedShiftRes = await req('GET', '/api/shifts/current', nancyToken);
    const live = updatedShiftRes.data?.live;
    check(live?.total_transactions === 1, `Live total_transactions is 1 (got ${live?.total_transactions})`);
    check(live?.total_sales === 300, `Live total_sales is 300 (got ${live?.total_sales})`);
    check(live?.cash_sales === 300, `Live cash_sales is 300 (got ${live?.cash_sales})`);
    check(live?.units_sold === 3, `Live units_sold is 3 (got ${live?.units_sold})`);
    check(live?.expected_cash === 800, `Live expected_cash is 800 (500 float + 300 cash, got ${live?.expected_cash})`);

    // 8. CLOSE SHIFT ONLINE WITH RECONCILIATION
    console.log('\n--- 8. CLOSE SHIFT ONLINE ---');
    const closeRes = await req('POST', `/api/shifts/${openShiftId}/close`, nancyToken, {}, {
      actual_cash: 800,
      closing_notes: 'Shift balanced perfectly. Ready for close.',
    });
    check(closeRes.status === 200, `POST /shifts/:id/close returns 200 (got ${closeRes.status})`);
    check(closeRes.data?.success === true, 'Close response success is true');
    check(closeRes.data?.shift?.status === 'CLOSED', 'Shift status updated to CLOSED');
    check(closeRes.data?.shift?.actual_cash === 800, 'Actual cash recorded as 800');
    check(closeRes.data?.shift?.expected_cash === 800, 'Expected cash recorded as 800');
    check(closeRes.data?.shift?.cash_variance === 0, 'Cash variance is 0 (balanced)');

    // 9. VERIFY CURRENT SHIFT IS NOW NULL AGAIN
    console.log('\n--- 9. VERIFY SHIFT IS CLOSED ---');
    const finalShiftRes = await req('GET', '/api/shifts/current', nancyToken);
    check(finalShiftRes.data?.shift === null, 'Shift is now closed and null');

    // 10. CLEAN UP TEST FIXTURES
    console.log('\n--- 10. CLEAN UP TEST FIXTURES ---');
    await cloudClient.query('DELETE FROM giga_cloud.inventory_movements WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.payments WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, completedSale?.id]);
    await cloudClient.query('DELETE FROM giga_cloud.sale_items WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, completedSale?.id]);
    await cloudClient.query('DELETE FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2', [SHOP2_ID, completedSale?.id]);
    await cloudClient.query('DELETE FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND batch_id = $2', [SHOP2_ID, testBatchId]);
    await cloudClient.query('DELETE FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [SHOP2_ID, testMedId]);
    if (openShiftId) {
      await cloudClient.query('DELETE FROM giga_cloud.cashier_shifts WHERE shop_id = $1 AND shift_id = $2', [SHOP2_ID, openShiftId]);
    }
    console.log('PASS: Disposable test fixtures cleanly removed from Supabase');

    console.log('\n======================================================');
    console.log('ALL ONLINE SHIFT & CASHIER SALE TESTS PASSED PERFECTLY!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await cloudClient.end();
  }
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});

