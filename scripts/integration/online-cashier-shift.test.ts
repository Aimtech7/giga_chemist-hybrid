import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import pg from 'pg';
import crypto from 'crypto';
import { buildOnlineRouter } from '../../server/online/app.js';
import { createJwtToken } from '../../server/auth.js';
import { isValidUuid } from '../../server/db/client.js';

// Setup environment for online app
const env = dotenv.parse(fs.readFileSync('.env.online'));
const cloudDbUrl = env.DATABASE_URL;
process.env.ONLINE_DATABASE_URL = cloudDbUrl;
process.env.SHOP_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f'; // Default shop: SHOP1
process.env.JWT_SECRET = env.JWT_SECRET;
process.env.APP_MODE = 'online';

const SHOP1_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const SHOP2_ID = '13bdb896-e243-4772-accf-b8609e1d977f';

function check(cond: boolean, label: string, extra?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${label}`, extra !== undefined ? extra : '');
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`PASS: ${label}`);
}

async function runTests() {
  const cloudClient = new pg.Client({ connectionString: cloudDbUrl, ssl: { rejectUnauthorized: false } });
  await cloudClient.connect();

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

  try {
    console.log('\n======================================================');
    console.log('PART 10 — REGRESSION & VERIFICATION SUITE');
    console.log('======================================================\n');

    // Setup cashier fixtures
    // Shop 2 Cashier: nancy (id: 967301de-ceee-416a-9f7c-3be244b8d859, local_user_id: c629050c-2a19-4c37-aa7d-f65548e23036)
    const nancyToken = createJwtToken({
      userId: '967301de-ceee-416a-9f7c-3be244b8d859',
      role: 'CASHIER',
      email: 'nancy@gigachemist.co.ke',
      name: 'nancy',
      tv: 0,
    });

    // Shop 1 Cashier: Risper (id: 1e55222e-c3df-478d-b0c3-859d53a21782, local_user_id: 5a37a66f-38b7-4184-9953-d02e9baefe2e)
    const risperToken = createJwtToken({
      userId: '1e55222e-c3df-478d-b0c3-859d53a21782',
      role: 'CASHIER',
      email: 'risper@gigachemist.co.ke',
      name: 'Risper',
      tv: 0,
    });

    // 1. ROUTE COLLISION TEST
    console.log('\n--- 1. ROUTE COLLISION: /api/shifts/current must NOT route to /shifts/:id ---');
    const rCurrent = await req('GET', '/api/shifts/current', nancyToken);
    check(rCurrent.status === 200, 'GET /api/shifts/current returns HTTP 200', rCurrent.status);
    check(
      rCurrent.data?.error !== 'Shift id must be a UUID.',
      'GET /api/shifts/current NEVER produces "Shift id must be a UUID."',
      rCurrent.data
    );
    check(rCurrent.data?.shift === null, 'Nancy (Shop 2) currently has no open shift reported -> shift: null', rCurrent.data);

    // 2. NO SHIFT RESPONSE
    console.log('\n--- 2. NO SHIFT RESPONSE ---');
    check(rCurrent.status === 200 && rCurrent.data && rCurrent.data.shift === null, 'No open shift returns 200 { shift: null }', rCurrent.data);

    // 3. EXISTING CLOUD SHIFT RESPONSE
    console.log('\n--- 3. EXISTING CLOUD SHIFT RESPONSE ---');
    // Open a temporary synthetic shift for Nancy in cloud
    const testShiftId = crypto.randomUUID();
    const testShiftNumber = `SHIFT-TEST-${Date.now().toString().slice(-5)}`;
    await cloudClient.query(
      `INSERT INTO giga_cloud.cashier_shifts (
        shop_id, shift_id, shift_number, cashier_id, cashier_name, device_id, status, opened_at, opened_business_date, opening_float, data
      ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', now(), CURRENT_DATE, 500, $7)`,
      [
        SHOP2_ID,
        testShiftId,
        testShiftNumber,
        'c629050c-2a19-4c37-aa7d-f65548e23036',
        'nancy',
        'DEV-TERMINAL',
        JSON.stringify({
          shift_number: testShiftNumber,
          cashier_id: 'c629050c-2a19-4c37-aa7d-f65548e23036',
          opened_at: new Date().toISOString(),
          opened_by_name: 'nancy',
          opening_float: 500,
          total_transactions: 3,
          total_sales: 1200,
          cash_sales: 700,
          mpesa_sales: 500,
          expected_cash: 1200,
        }),
      ]
    );

    try {
      const rOpen = await req('GET', '/api/shifts/current', nancyToken);
      check(rOpen.status === 200, 'GET /api/shifts/current with open shift returns 200', rOpen.status);
      check(rOpen.data?.shift !== null, 'shift is not null', rOpen.data);
      check(rOpen.data.shift.id === testShiftId, 'shift.id matches the real shift UUID', rOpen.data.shift.id);
      check(isValidUuid(rOpen.data.shift.id), 'shift.id is a valid UUID', rOpen.data.shift.id);
      check(rOpen.data.shift.status === 'OPEN', 'shift.status is OPEN', rOpen.data.shift.status);
      check(rOpen.data.shift.cashier_id === 'c629050c-2a19-4c37-aa7d-f65548e23036', 'shift belongs to the correct cashier', rOpen.data.shift.cashier_id);
      check(rOpen.data.shift.shop_id === SHOP2_ID, 'shift belongs to the correct shop (Shop 2)', rOpen.data.shift.shop_id);
      check(rOpen.data.live?.total_sales === 1200, 'live totals returned accurately from cloud', rOpen.data.live);
    } finally {
      // Clean up test shift
      await cloudClient.query('DELETE FROM giga_cloud.cashier_shifts WHERE shift_id = $1', [testShiftId]);
    }

    // 4. CASHIER SHOP ISOLATION
    console.log('\n--- 4. CASHIER SHOP ISOLATION ---');
    // Nancy (Shop 2 cashier):
    const nancyAuth = await req('GET', '/api/auth/me', nancyToken);
    check(nancyAuth.data.account?.shop_id === SHOP2_ID, 'Nancy account is scoped to Shop 2', nancyAuth.data.account?.shop_id);
    const nancyMeds = await req('GET', '/api/medicines', nancyToken);
    check(nancyMeds.status === 200 && Array.isArray(nancyMeds.data), 'Nancy can read medicines', nancyMeds.data?.length);
    check(nancyMeds.data.length === 2137, 'Nancy reads exactly Shop 2 medicines count (2137)', nancyMeds.data.length);

    // Risper (Shop 1 cashier):
    const risperAuth = await req('GET', '/api/auth/me', risperToken);
    check(risperAuth.data.account?.shop_id === SHOP1_ID, 'Risper account is scoped to Shop 1', risperAuth.data.account?.shop_id);
    const risperMeds = await req('GET', '/api/medicines', risperToken);
    check(risperMeds.status === 200 && Array.isArray(risperMeds.data), 'Risper can read medicines', risperMeds.data?.length);
    check(risperMeds.data.length === 2187, 'Risper reads exactly Shop 1 medicines count (2187)', risperMeds.data.length);

    // 5. CATALOGUE COUNTS FOR SHOP 2
    console.log('\n--- 5. CATALOGUE COUNTS FOR SHOP 2 ---');
    const nancyCats = await req('GET', '/api/categories', nancyToken);
    check(nancyCats.status === 200 && Array.isArray(nancyCats.data), 'GET /api/categories returns 200 array for Shop 2', nancyCats.status);
    check(nancyMeds.data.length > 0, `Shop 2 medicines > 0 (count: ${nancyMeds.data.length})`);
    check(nancyCats.data.length > 0, `Shop 2 categories > 0 (count: ${nancyCats.data.length})`);

    // 6. SECURITY: CASHIER CANNOT SWITCH SHOPS
    console.log('\n--- 6. SECURITY: CASHIER CANNOT SWITCH SHOPS ---');
    // Nancy tries to switch to Shop 1 via header X-GIGA-SHOP-ID
    const headerSwitch = await req('GET', '/api/medicines', nancyToken, { 'X-GIGA-SHOP-ID': SHOP1_ID });
    check(headerSwitch.status === 403, 'Switching shop via X-GIGA-SHOP-ID is refused with 403', headerSwitch.status);
    check(headerSwitch.data?.code === 'SHOP_ACCESS_DENIED', 'Rejection code is SHOP_ACCESS_DENIED', headerSwitch.data);

    // Nancy tries to switch to Shop 1 via query parameter ?shop_id=
    const querySwitch = await req('GET', `/api/medicines?shop_id=${SHOP1_ID}`, nancyToken);
    check(querySwitch.status === 403, 'Switching shop via ?shop_id= is refused with 403', querySwitch.status);
    check(querySwitch.data?.code === 'SHOP_ACCESS_DENIED', 'Rejection code is SHOP_ACCESS_DENIED', querySwitch.data);

    // 7. READ-ONLY ARCHITECTURE PROTECTION
    console.log('\n--- 7. READ-ONLY ARCHITECTURE PROTECTION ---');
    const writeOpen = await req('POST', '/api/shifts/open', nancyToken, {}, { opening_float: 100 });
    check(writeOpen.status === 409, 'POST /api/shifts/open refused with 409', writeOpen.status);
    check(writeOpen.data?.code === 'ONLINE_READ_ONLY', 'Write rejection code is ONLINE_READ_ONLY', writeOpen.data);

    const writeClose = await req('POST', `/api/shifts/${crypto.randomUUID()}/close`, nancyToken, {}, { actual_cash: 100 });
    check(writeClose.status === 409, 'POST /api/shifts/:id/close refused with 409', writeClose.status);
    check(writeClose.data?.code === 'ONLINE_READ_ONLY', 'Write rejection code is ONLINE_READ_ONLY', writeClose.data);

    const writeSale = await req('POST', '/api/sales/checkout', nancyToken, {}, { items: [] });
    check(writeSale.status === 409, 'POST /api/sales/checkout refused with 409', writeSale.status);
    check(writeSale.data?.code === 'ONLINE_READ_ONLY', 'Write rejection code is ONLINE_READ_ONLY', writeSale.data);

    console.log('\n======================================================');
    console.log('ALL VERIFICATION SUITE TESTS PASSED SUCCESSFULLY!');
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
