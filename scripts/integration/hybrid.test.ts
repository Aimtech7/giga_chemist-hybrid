import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { api, check, pool, section, startServer, stopServer, getServerLog, setServerEnv, upsertFixtureMedicine } from './harness';
import { startCloudEmulator, prepareCloudDatabase, registerShop, type CloudEmulator } from '../cloud-emulator';
import type { Ctx } from './auth-users.test';

/**
 * HYBRID sync tests: real local server (child process, APP_MODE=hybrid, SYNC_ENABLED=true) +
 * cloud emulator running the real cloud SQL (giga_chemist_cloud_test). Outages are real network
 * failures seen by the server process: the emulator stops listening (connection refused), hangs
 * (timeout), answers 503, or commits and drops the response.
 */
export const CLOUD_TEST_DB = 'giga_chemist_cloud_test';
/** Runtime state dir of the test server (update-state.json etc.), never the real logs/runtime. */
export const TEST_RUNTIME_DIR = path.join(os.tmpdir(), 'gc-itest-runtime');
const EMU_PORT = Number(process.env.ITEST_CLOUD_PORT || 54399);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `itest-${crypto.randomUUID()}`;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000, stepMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < deadline) {
    await sleep(stepMs);
    v = await fn();
  }
  return v;
}

async function eventsOf(entityId: string, type?: string) {
  const r = await pool.query(
    `SELECT id, idempotency_key, event_type, status, attempt_count, last_error, next_attempt_at, last_attempt_at, payload, seq
       FROM sync_events WHERE entity_id = $1 ${type ? 'AND event_type = $2' : ''} ORDER BY seq`,
    type ? [entityId, type] : [entityId]
  );
  return r.rows;
}
const statusOf = async (entityId: string, type: string) => (await eventsOf(entityId, type))[0]?.status;
const waitStatus = (entityId: string, type: string, want: string, ms = 20_000) =>
  waitFor(() => statusOf(entityId, type), (s) => s === want, ms);

async function localStock(medId: string) {
  return Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [medId])).rows[0].current_stock);
}

export interface HybridEnv {
  emu: CloudEmulator;
  shopId: string;
  token: string;
  apiKey: string;
}

export async function setupHybridCloud(): Promise<HybridEnv> {
  await prepareCloudDatabase(CLOUD_TEST_DB, true);
  const apiKey = `itest-anon-${crypto.randomBytes(16).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const emu = await startCloudEmulator({ port: EMU_PORT, database: CLOUD_TEST_DB, apiKey });
  const shopId = (await pool.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0].shop_id;
  await registerShop(emu.pool, shopId, 'SHOP1', 'GIGA CHEMIST - MAIN (test cloud)', token);
  setServerEnv({
    APP_MODE: 'hybrid',
    SYNC_ENABLED: 'true',
    SUPABASE_URL: emu.url,
    SUPABASE_ANON_KEY: apiKey,
    SUPABASE_SERVICE_ROLE_KEY: '',
    SYNC_SHOP_TOKEN: token,
    SHOP_ID: '',
    SYNC_INTERVAL_SECONDS: '1',
    SYNC_HTTP_TIMEOUT_MS: '1500',
    SYNC_MAX_BACKOFF_SECONDS: '3',
    SYNC_BATCH_SIZE: '25',
    HEARTBEAT_INTERVAL_SECONDS: '15',
    GIGA_RUNTIME_DIR: TEST_RUNTIME_DIR,
  });
  fs.rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
  return { emu, shopId, token, apiKey };
}

export async function hybridTests(ctx: Ctx, env: HybridEnv) {
  const { emu, shopId } = env;
  const cloud = async (sql: string, params: any[] = []) => Number((await emu.pool.query(sql, params)).rows[0].n);
  const med = await upsertFixtureMedicine('ITEST-HYB-1', 'ZZ ITEST Hybrid Medicine', 100, 60);
  await pool.query('UPDATE medicines SET wholesale_price = NULL WHERE id = $1', [med]);
  // The cart always carries the CURRENT price (cloud commands change it during the suite).
  const sell = async (token: string, qty: number, payment: any = { method: 'Cash', amount_received: 1_000_000 }) => {
    const price = Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price);
    return api('POST', '/api/sales/checkout', token, {
      idempotency_key: key(),
      items: [{ medicine_id: med, quantity: qty, unit_price: price }],
      payment,
    });
  };

  // ------------------------------------------------------------------ BASELINE STOCK
  section('HYBRID SETUP');
  let r = await api('POST', '/api/inventory/physical-count', ctx.adminToken, {
    medicine_id: med, counts: [{ batch_number: 'ITEST-HYB-B1', quantity: 200, expiry_date: '2030-12-31' }],
  });
  check(r.status === 200 && (await localStock(med)) === 200, 'physical count sets local stock 200', r.data);
  check((await waitStatus(med, 'PHYSICAL_COUNT', 'SYNCED')) === 'SYNCED', 'setup physical count event SYNCED');
  const batchId = (await pool.query(`SELECT id FROM medicine_batches WHERE medicine_id = $1 AND batch_number = 'ITEST-HYB-B1'`, [med])).rows[0].id;
  const cloudQty = async () => (await emu.pool.query(
    `SELECT last_reported_quantity AS q, delta_since_baseline AS d FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2`,
    [shopId, batchId])).rows[0];

  // ------------------------------------------------------------------ TEST 1
  section('TEST 1 — Online sale');
  const s1 = await sell(ctx.cashierToken, 2);
  const sale1 = s1.data?.sale;
  check(s1.status === 201 && !!sale1?.id, 'sale commits locally (201)', s1.data);
  const ev1 = await eventsOf(sale1.id, 'SALE_COMPLETED');
  check(ev1.length === 1, 'exactly one SALE_COMPLETED outbox event created', ev1.length);
  check(ev1[0]?.payload?.movements?.length === 1 && ev1[0].payload.movements[0].delta === -2, 'event carries the stock movement (delta -2), not a stock snapshot', ev1[0]?.payload?.movements);
  check(!('current_stock' in (ev1[0]?.payload?.data?.sale || {})), 'no current_stock snapshot in payload');
  check((await waitStatus(sale1.id, 'SALE_COMPLETED', 'SYNCED')) === 'SYNCED', 'event becomes SYNCED');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2', [shopId, sale1.id]) === 1, 'cloud sale exists exactly once');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sale_items WHERE sale_id = $1', [sale1.id]) === 1 &&
        await cloud('SELECT COUNT(*) n FROM giga_cloud.payments WHERE sale_id = $1', [sale1.id]) === 1, 'cloud sale_items and payment exist once');
  check((await cloudQty())?.q === 198, 'cloud ledger reports batch quantity 198', await cloudQty());
  const evCount = async () => Number((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE event_type = 'SALE_COMPLETED'`)).rows[0].n);
  const before1b = await evCount();
  const tooMany = await sell(ctx.cashierToken, 999_999);
  check(tooMany.status >= 400 && (await evCount()) === before1b, 'a rejected checkout rolls back and leaves no outbox event', tooMany.status);

  // ------------------------------------------------------------------ TEST 2
  section('TEST 2 — Offline sale (cloud unreachable)');
  await emu.stop();
  await sleep(1500);
  const before2 = await localStock(med);
  const t0 = Date.now();
  const s2 = await sell(ctx.cashierToken, 3);
  const s2ms = Date.now() - t0;
  const sale2 = s2.data?.sale;
  check(s2.status === 201 && !!sale2?.receipt_number, 'offline sale succeeds locally with a receipt number', s2.data);
  check(s2ms < 3000, `checkout not slowed by the outage (${s2ms} ms)`);
  check((await localStock(med)) === before2 - 3, 'local stock decreased by 3');
  const mp = await sell(ctx.cashierToken, 1, { method: 'M-Pesa', reference: 'HYB123OFF' });
  check(mp.status === 201 && mp.data?.sale?.payment_reference === 'HYB123OFF', 'offline M-Pesa sale recorded locally', mp.data);
  const rcpt = await api('GET', `/api/sales?search=${encodeURIComponent(sale2.receipt_number)}`, ctx.cashierToken);
  const listed = (Array.isArray(rcpt.data) ? rcpt.data : rcpt.data?.sales || []).some((x: any) => x.id === sale2.id);
  check(rcpt.status === 200 && listed, 'offline sale visible in local Sales History (receipt reprint data)');
  await sleep(2500);
  check((await statusOf(sale2.id, 'SALE_COMPLETED')) === 'PENDING', 'event remains PENDING while offline');
  const st2 = await api('GET', '/api/sync/status', ctx.adminToken);
  check(st2.status === 200 && st2.data?.cloud_reachable === false && st2.data?.counts?.pending >= 2 && st2.data?.local_database?.connected === true,
    'status: cloud unreachable, events pending, local PostgreSQL connected', { reach: st2.data?.cloud_reachable, counts: st2.data?.counts });

  // ------------------------------------------------------------------ TEST 3
  section('TEST 3 — Reconnect (no app restart)');
  await emu.restart();
  check((await waitStatus(sale2.id, 'SALE_COMPLETED', 'SYNCED', 25_000)) === 'SYNCED', 'pending event syncs automatically after reconnect');
  check((await waitStatus(mp.data.sale.id, 'SALE_COMPLETED', 'SYNCED', 15_000)) === 'SYNCED', 'offline M-Pesa sale synced');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE sale_id = $1', [sale2.id]) === 1, 'no duplicate cloud sale');
  check(await cloud(`SELECT COUNT(*) n FROM giga_cloud.payments WHERE sale_id = $1 AND method = 'M-Pesa' AND reference = 'HYB123OFF'`, [mp.data.sale.id]) === 1, 'cloud has the M-Pesa payment once');
  check((await cloudQty())?.q === (await localStock(med)), 'cloud ledger quantity equals local stock', { cloud: await cloudQty(), local: await localStock(med) });

  // ------------------------------------------------------------------ TEST 4
  section('TEST 4 — Retry on forced cloud failure');
  emu.setFault({ mode: 'error500', functions: ['gc_ingest_events'] });
  const s4 = await sell(ctx.cashierToken, 1);
  check(s4.status === 201, 'local transaction unaffected by cloud failure');
  const ev4 = await waitFor(() => eventsOf(s4.data.sale.id, 'SALE_COMPLETED'), (e) => e[0]?.attempt_count >= 2, 15_000);
  check(ev4[0]?.status === 'PENDING' && ev4[0].attempt_count >= 2, `attempt_count increases (${ev4[0]?.attempt_count}), stays PENDING`);
  check(/503/.test(ev4[0]?.last_error || ''), 'last_error recorded', ev4[0]?.last_error);
  check(new Date(ev4[0]?.next_attempt_at).getTime() > new Date(ev4[0]?.last_attempt_at).getTime(), 'retry scheduled (next_attempt_at after last attempt)');
  emu.setFault({ mode: 'none' });
  check((await waitStatus(s4.data.sale.id, 'SALE_COMPLETED', 'SYNCED')) === 'SYNCED', 'syncs once the cloud recovers');

  // ------------------------------------------------------------------ TEST 5
  section('TEST 5 — Duplicate event delivery');
  emu.setFault({ mode: 'drop_response', functions: ['gc_ingest_events'], times: 1 });
  const s5 = await sell(ctx.cashierToken, 4);
  check(s5.status === 201, 'sale committed');
  check((await waitStatus(s5.data.sale.id, 'SALE_COMPLETED', 'SYNCED')) === 'SYNCED', 'cloud committed but response lost -> retried -> SYNCED');
  const ev5 = (await eventsOf(s5.data.sale.id, 'SALE_COMPLETED'))[0];
  check(ev5?.attempt_count >= 2, `event was delivered more than once (${ev5?.attempt_count} attempts)`);
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE sale_id = $1', [s5.data.sale.id]) === 1 &&
        await cloud('SELECT COUNT(*) n FROM giga_cloud.sale_items WHERE sale_id = $1', [s5.data.sale.id]) === 1 &&
        await cloud('SELECT COUNT(*) n FROM giga_cloud.payments WHERE sale_id = $1', [s5.data.sale.id]) === 1,
    'one sale, one item, one payment in the cloud');
  const movId = ev5.payload.movements[0].id;
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.inventory_movements WHERE movement_id = $1', [movId]) === 1, 'stock movement stored once');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.processed_events WHERE idempotency_key = $1', [ev5.idempotency_key]) === 1, 'idempotency key recorded once');
  // Explicit replay of an already-synced event, twice.
  const row = (await pool.query('SELECT * FROM sync_events WHERE id = $1', [ev5.id])).rows[0];
  const envelope = {
    event_id: row.id, idempotency_key: row.idempotency_key, shop_id: row.shop_id, local_seq: String(row.seq), event_type: row.event_type,
    entity_type: row.entity_type, entity_id: row.entity_id, operation: row.operation, device_id: row.device_id,
    actor_user_id: row.actor_user_id, actor_name: row.actor_name, business_ref: row.business_ref,
    occurred_at: new Date(row.created_at).toISOString(), payload: row.payload,
  };
  const qtyBefore = await cloudQty();
  const replay = async () => {
    const res = await fetch(`${emu.url}/rest/v1/rpc/gc_ingest_events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.apiKey, Authorization: `Bearer ${env.apiKey}` },
      body: JSON.stringify({ p_shop_id: shopId, p_token: env.token, p_events: [envelope] }),
    });
    return res.json();
  };
  const rep1 = await replay();
  const rep2 = await replay();
  check(rep1?.results?.[0]?.status === 'DUPLICATE' && rep2?.results?.[0]?.status === 'DUPLICATE', 'replayed event answered DUPLICATE (twice)', [rep1, rep2]);
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE sale_id = $1', [s5.data.sale.id]) === 1, 'replay created no second sale');
  check(JSON.stringify(await cloudQty()) === JSON.stringify(qtyBefore), 'replay did not change cloud stock', { before: qtyBefore, after: await cloudQty() });

  // ------------------------------------------------------------------ TEST 6
  section('TEST 6 — Server restart while pending');
  await emu.stop();
  const s6 = await sell(ctx.cashierToken, 1);
  const s6b = await sell(ctx.cashierToken, 1);
  check(s6.status === 201 && s6b.status === 201, 'two sales while cloud down');
  // Simulate a crash in the middle of a send: one event left in PROCESSING.
  await pool.query(`UPDATE sync_events SET status = 'PROCESSING', locked_by = 'crashed-worker' WHERE entity_id = $1`, [s6b.data.sale.id]);
  await stopServer();
  check((await statusOf(s6.data.sale.id, 'SALE_COMPLETED')) === 'PENDING', 'event persisted while the server is down');
  await startServer(); // cloud still unreachable: startup must not fail
  const health = await api('GET', '/api/health');
  check(health.status === 200 && health.data?.database?.connected === true, 'server starts while the cloud is unreachable');
  const relog = await api('POST', '/api/auth/login', null, { email: ctx.cashier.email, password: ctx.cashier.password });
  check(relog.status === 200, 'local login works with the cloud down');
  ctx.cashierToken = relog.data?.token || ctx.cashierToken;
  await emu.restart();
  check((await waitStatus(s6.data.sale.id, 'SALE_COMPLETED', 'SYNCED', 25_000)) === 'SYNCED', 'worker resumes after restart and syncs');
  check((await waitStatus(s6b.data.sale.id, 'SALE_COMPLETED', 'SYNCED', 15_000)) === 'SYNCED', 'event stranded in PROCESSING was recovered and synced');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE sale_id = ANY($1::uuid[])', [[s6.data.sale.id, s6b.data.sale.id]]) === 2, 'each sale once in the cloud');

  // ------------------------------------------------------------------ TEST 7
  section('TEST 7 — Physical count offline');
  await emu.stop();
  const prev7 = await localStock(med);
  r = await api('POST', '/api/inventory/physical-count', ctx.adminToken, { medicine_id: med, counts: [{ batch_id: batchId, batch_number: 'ITEST-HYB-B1', quantity: 150 }] });
  check(r.status === 200 && (await localStock(med)) === 150, 'local stock updated to 150 offline', r.data);
  const pc = (await eventsOf(med, 'PHYSICAL_COUNT')).pop();
  check(pc?.status === 'PENDING' && pc.payload.movements[0].delta === 150 - prev7, `event queued with delta ${150 - prev7}`, pc?.payload?.movements);
  await emu.restart();
  check((await waitFor(async () => (await pool.query('SELECT status FROM sync_events WHERE id = $1', [pc.id])).rows[0].status, (s) => s === 'SYNCED', 25_000)) === 'SYNCED', 'physical count event synced');
  check((await cloudQty())?.q === 150, 'cloud ledger shows 150 after the count', await cloudQty());

  // ------------------------------------------------------------------ TEST 8
  section('TEST 8 — Return request + approval offline');
  await emu.stop();
  const s8 = await sell(ctx.cashierToken, 2);
  const item8 = s8.data.sale.items[0];
  const req8 = await api('POST', '/api/returns', ctx.cashierToken, { sale_id: s8.data.sale.id, medicine_id: item8.medicine_id, batch_id: item8.batch_id, quantity: 1, reason: 'ITEST hybrid return' });
  check(req8.status === 201, 'cashier return request accepted offline', req8.data);
  const stockBeforeApprove = await localStock(med);
  const app8 = await api('POST', `/api/returns/${req8.data.return.id}/approve`, ctx.adminToken, { restock: true });
  check(app8.status === 200 && app8.data?.return?.status === 'APPROVED' && (await localStock(med)) === stockBeforeApprove + 1, 'admin approval completes locally offline (stock +1)', app8.data);
  const retId = req8.data.return.id;
  check((await eventsOf(retId)).map((e) => `${e.event_type}:${e.status}`).join(',') === 'RETURN_REQUESTED:PENDING,RETURN_APPROVED:PENDING', 'both return events queued in order');
  await emu.restart();
  check((await waitStatus(retId, 'RETURN_APPROVED', 'SYNCED', 25_000)) === 'SYNCED' && (await statusOf(retId, 'RETURN_REQUESTED')) === 'SYNCED', 'return events synced');
  const cret = (await emu.pool.query('SELECT status, approved_quantity FROM giga_cloud.returns WHERE return_id = $1', [retId])).rows;
  check(cret.length === 1 && cret[0].status === 'APPROVED' && cret[0].approved_quantity === 1, 'cloud has one APPROVED return', cret);
  const csale = (await emu.pool.query('SELECT status FROM giga_cloud.sales WHERE sale_id = $1', [s8.data.sale.id])).rows[0];
  check(csale?.status === 'partially_returned', 'cloud sale status updated by the return', csale);
  check(await cloud(`SELECT COUNT(*) n FROM giga_cloud.inventory_movements WHERE batch_id = $1 AND reason = 'RETURN_APPROVED' AND reference_id = $2`, [batchId, s8.data.sale.receipt_number]) === 1, 'return restock movement once in cloud');

  // ------------------------------------------------------------------ TEST 9
  section('TEST 9 — Purchase received offline');
  const sup = await api('POST', '/api/suppliers', ctx.adminToken, { name: 'ZZ ITEST Hybrid Supplier', phone: '0700000009' });
  check(sup.status === 200, 'supplier saved', sup.data);
  await emu.stop();
  const before9 = await localStock(med);
  const pur = await api('POST', '/api/purchases', ctx.adminToken, {
    supplier_id: sup.data.supplier.id, invoice_number: `ITEST-HYB-${Date.now()}`,
    items: [{ medicine_id: med, batch_number: 'ITEST-HYB-P1', expiry_date: '2031-01-31', quantity: 10, purchase_price: 55 }],
  });
  check(pur.status === 201 && (await localStock(med)) === before9 + 10, 'purchase received offline, local stock +10', pur.data);
  const purId = pur.data.purchase.id;
  check((await statusOf(purId, 'PURCHASE_RECEIVED')) === 'PENDING', 'purchase event queued');
  const exp = await api('POST', '/api/expenses', ctx.adminToken, { category: 'Transport', description: 'ITEST hybrid offline expense', amount: 120, payment_method: 'Cash' });
  check(exp.status === 201 && (await statusOf(exp.data.expense.id, 'EXPENSE_RECORDED')) === 'PENDING', 'expense recorded offline and queued');
  await emu.restart();
  check((await waitStatus(purId, 'PURCHASE_RECEIVED', 'SYNCED', 25_000)) === 'SYNCED', 'purchase event synced');
  check((await waitStatus(exp.data.expense.id, 'EXPENSE_RECORDED', 'SYNCED')) === 'SYNCED' &&
        await cloud('SELECT COUNT(*) n FROM giga_cloud.expenses WHERE expense_id = $1', [exp.data.expense.id]) === 1, 'expense in cloud once');
  check(await cloud('SELECT COUNT(*) n FROM giga_cloud.purchases WHERE purchase_id = $1', [purId]) === 1 &&
        await cloud('SELECT COUNT(*) n FROM giga_cloud.purchase_items WHERE purchase_id = $1', [purId]) === 1, 'cloud purchase + item once');
  const newBatch = (await pool.query(`SELECT id FROM medicine_batches WHERE medicine_id = $1 AND batch_number = 'ITEST-HYB-P1'`, [med])).rows[0].id;
  check(await cloud(`SELECT COALESCE(SUM(delta),0) n FROM giga_cloud.inventory_movements WHERE batch_id = $1`, [newBatch]) === 10, 'cloud ledger +10 on the new batch');

  // ------------------------------------------------------------------ TEST 10
  section('TEST 10 — Cloud timeout during checkout');
  emu.setFault({ mode: 'timeout' });
  await sleep(1200); // the worker is now stuck waiting on the cloud
  const times: number[] = [];
  let ok10 = true;
  const ids10: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const s = await sell(ctx.cashierToken, 1);
    times.push(Date.now() - t);
    ok10 = ok10 && s.status === 201;
    if (s.data?.sale?.id) ids10.push(s.data.sale.id);
  }
  check(ok10, 'checkouts succeed while the cloud hangs');
  check(Math.max(...times) < 1500, `checkout stays fast (max ${Math.max(...times)} ms, cloud timeout is 1500 ms)`, times);
  await sleep(2000);
  check((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE entity_id = ANY($1) AND status IN ('PENDING', 'PROCESSING')`, [ids10])).rows[0].n === '3',
    'timed-out events stay queued (PENDING, or PROCESSING while a request is in flight); none failed or lost');
  check((await pool.query('SELECT COUNT(*) n FROM sales WHERE id = ANY($1::uuid[])', [ids10])).rows[0].n === '3', 'local sales intact');
  emu.setFault({ mode: 'none' });
  const done10 = await waitFor(async () => Number((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE entity_id = ANY($1) AND status = 'SYNCED'`, [ids10])).rows[0].n), (n) => n === 3, 25_000);
  check(done10 === 3, 'all synced after the timeout clears');

  // ------------------------------------------------------------------ TEST 11
  section('TEST 11 — Inbound price command');
  const histPrice = Number((await pool.query('SELECT unit_price FROM sale_items WHERE sale_id = $1', [sale1.id])).rows[0].unit_price);
  const cmd11 = (await emu.pool.query(`SELECT giga_cloud.issue_command($1, 'PRICE_UPDATE', $2::jsonb, $3, 'itest-hq') AS id`,
    [shopId, JSON.stringify({ medicine_id: med, selling_price: 123.45 }), key()])).rows[0].id;
  const price = await waitFor(async () => Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price), (p) => p === 123.45, 20_000);
  check(price === 123.45, 'current local price changed by the cloud command', price);
  check(Number((await pool.query('SELECT unit_price FROM sale_items WHERE sale_id = $1', [sale1.id])).rows[0].unit_price) === histPrice, `historical sale_items price unchanged (${histPrice})`);
  check(Number((await pool.query(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'CLOUD_COMMAND_APPLIED' AND entity_id = $1`, [cmd11])).rows[0].n) === 1 &&
        Number((await pool.query(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'ADMIN_PRICE_UPDATE' AND entity_id = $1 AND user_name LIKE 'CLOUD%'`, [med])).rows[0].n) >= 1,
    'audit rows written (command + price update by CLOUD)');
  const c11 = await waitFor(async () => (await emu.pool.query('SELECT status FROM giga_cloud.commands WHERE command_id = $1', [cmd11])).rows[0].status, (s) => s === 'APPLIED');
  check(c11 === 'APPLIED', 'command acknowledged APPLIED in the cloud');
  const cm = await waitFor(async () => (await emu.pool.query('SELECT selling_price::float AS p FROM giga_cloud.medicines WHERE medicine_id = $1', [med])).rows[0]?.p, (p) => p === 123.45);
  check(cm === 123.45, 'resulting price change synced back to the cloud medicine copy');
  // Conflict: a local, not-yet-synced price change must not be overwritten by a cloud command.
  emu.setFault({ mode: 'error500', functions: ['gc_ingest_events'] });
  r = await api('PATCH', `/api/medicines/${med}/pricing`, ctx.adminToken, { selling_price: 111 });
  check(r.status === 200, 'local admin price change while it cannot sync', r.data);
  const cmdConflict = (await emu.pool.query(`SELECT giga_cloud.issue_command($1, 'PRICE_UPDATE', $2::jsonb, $3, 'itest-hq') AS id`,
    [shopId, JSON.stringify({ medicine_id: med, selling_price: 999 }), key()])).rows[0].id;
  const cc = await waitFor(async () => (await emu.pool.query('SELECT status, error FROM giga_cloud.commands WHERE command_id = $1', [cmdConflict])).rows[0], (x) => x.status === 'REJECTED', 20_000);
  check(cc.status === 'REJECTED' && /CONFLICT/.test(cc.error || ''), 'conflicting cloud command REJECTED (local unsynced change wins)', cc);
  check(Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price) === 111, 'local unsynced price kept (111)');
  const bogus = (await emu.pool.query(`SELECT giga_cloud.issue_command($1, 'PRICE_UPDATE', $2::jsonb, $3, 'itest-hq') AS id`,
    [shopId, JSON.stringify({ medicine_id: med, current_stock: 99999 }), key()])).rows[0].id;
  emu.setFault({ mode: 'none' });
  const cb = await waitFor(async () => (await emu.pool.query('SELECT status, error FROM giga_cloud.commands WHERE command_id = $1', [bogus])).rows[0], (x) => x.status === 'REJECTED', 20_000);
  check(cb.status === 'REJECTED' && /current_stock/.test(cb.error || ''), 'command trying to set stock is REJECTED (no inbound stock overwrite)', cb);
  check((await localStock(med)) !== 99999, 'local stock untouched by cloud');

  // ------------------------------------------------------------------ TEST 12
  section('TEST 12 — Same cloud command delivered twice');
  await waitFor(async () => Number((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE entity_id = $1 AND status <> 'SYNCED'`, [med])).rows[0].n), (n) => n === 0, 20_000);
  emu.setFault({ mode: 'error500', functions: ['gc_ack_command'], times: 3 });
  const key12 = key();
  const cmd12 = (await emu.pool.query(`SELECT giga_cloud.issue_command($1, 'PRICE_UPDATE', $2::jsonb, $3, 'itest-hq') AS id`,
    [shopId, JSON.stringify({ medicine_id: med, selling_price: 130 }), key12])).rows[0].id;
  const again = (await emu.pool.query(`SELECT giga_cloud.issue_command($1, 'PRICE_UPDATE', $2::jsonb, $3, 'itest-hq') AS id`,
    [shopId, JSON.stringify({ medicine_id: med, selling_price: 130 }), key12])).rows[0].id;
  check(again === cmd12, 'cloud re-issue with the same key returns the same command');
  const c12 = await waitFor(async () => (await emu.pool.query('SELECT status, delivery_count FROM giga_cloud.commands WHERE command_id = $1', [cmd12])).rows[0], (x) => x.status === 'APPLIED', 30_000);
  check(c12.status === 'APPLIED' && c12.delivery_count >= 2, `command delivered ${c12.delivery_count} times (ack failures), finally APPLIED`, c12);
  check(Number((await pool.query('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [cmd12])).rows[0].n) === 1, 'recorded once locally');
  check(Number((await pool.query(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'CLOUD_COMMAND_APPLIED' AND entity_id = $1`, [cmd12])).rows[0].n) === 1, 'applied (audited) exactly once');
  check(Number((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE event_type = 'MEDICINE_PRICE_CHANGED' AND payload->'data'->>'command_id' = $1`, [cmd12])).rows[0].n) === 1, 'exactly one outbound price event for it');
  check(Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price) === 130, 'price applied (130)');

  // ------------------------------------------------------------------ TEST 13
  section('TEST 13 — Remote admin stock commands (applied by the shop in its own transaction)');
  const issue = async (type: string, payload: any, k = key()) => (await emu.pool.query(
    `SELECT giga_cloud.issue_command($1, $2, $3::jsonb, $4, 'Remote Admin <itest-online-admin@itest.local>') AS id`,
    [shopId, type, JSON.stringify(payload), k])).rows[0].id as string;
  const cmdRow = async (id: string) => (await emu.pool.query(
    'SELECT status, error, result, delivery_count FROM giga_cloud.commands WHERE command_id = $1', [id])).rows[0];
  const waitFinal = (id: string, ms = 30_000) => waitFor(() => cmdRow(id), (x) => x?.status === 'APPLIED' || x?.status === 'REJECTED', ms);
  const batchQty = async () => Number((await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [batchId])).rows[0].quantity_available);
  const n = async (sql: string, params: any[]) => Number((await pool.query(sql, params)).rows[0].n);
  const sale1Items = async () => JSON.stringify((await pool.query('SELECT medicine_id, batch_id, quantity, unit_price FROM sale_items WHERE sale_id = $1 ORDER BY id', [sale1.id])).rows);
  const itemsBefore = await sale1Items();
  await waitFor(() => n(`SELECT COUNT(*) n FROM sync_events WHERE entity_id = $1 AND status <> 'SYNCED'`, [med]), (x) => x === 0, 20_000);

  // 13a STOCK_ADD delivered several times (acknowledgements fail) -> applied exactly once
  const q0 = await batchQty();
  const s0 = await localStock(med);
  emu.setFault({ mode: 'error500', functions: ['gc_ack_command'], times: 3 });
  const add = await issue('STOCK_ADD', { medicine_id: med, batch_id: batchId, quantity: 20, reason: 'ITEST new delivery' });
  const addR = await waitFor(() => cmdRow(add), (x) => x?.status === 'APPLIED', 30_000);
  emu.setFault({ mode: 'none' });
  check(addR?.status === 'APPLIED' && addR.delivery_count >= 2, `STOCK_ADD APPLIED after ${addR?.delivery_count} deliveries (ack failures)`, addR);
  check((await batchQty()) === q0 + 20 && (await localStock(med)) === s0 + 20, `stock added exactly once (+20: batch ${q0} -> ${await batchQty()})`);
  check(await n('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [add]) === 1, 'command recorded once in sync_inbound_commands');
  const addMovId = addR?.result?.movement_id;
  const mv = (await pool.query('SELECT previous_quantity, new_quantity, adjustment_quantity, notes, movement_type FROM inventory_movements WHERE id = $1', [addMovId])).rows[0];
  check(mv && Number(mv.adjustment_quantity) === 20 && Number(mv.previous_quantity) === q0 && /Remote admin CLOUD \(Remote Admin/.test(mv.notes),
    'inventory movement written (+20, previous quantity, remote admin named)', mv);
  check(await n(`SELECT COUNT(*) n FROM inventory_movements WHERE notes LIKE '%ITEST new delivery%' AND batch_id = $1`, [batchId]) === 1, 'exactly one movement for the command');
  check(await n(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'ADMIN_ADD_STOCK' AND new_value->>'movement_id' = $1 AND user_name LIKE 'CLOUD (%'`, [addMovId]) === 1 &&
        await n(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'CLOUD_COMMAND_APPLIED' AND entity_id = $1`, [add]) === 1,
    'audit: stock change (by the remote admin) + command applied, once each');
  const addEv = (await pool.query(`SELECT status, payload FROM sync_events WHERE event_type = 'STOCK_ADDED' AND payload->'data'->>'command_id' = $1`, [add])).rows;
  check(addEv.length === 1 && addEv[0].payload.movements?.[0]?.delta === 20, 'one STOCK_ADDED outbox event carrying the movement (delta +20)', addEv.length);
  check(addEv[0]?.status === 'SYNCED', 'its event was delivered before the command was acknowledged APPLIED', addEv[0]?.status);
  const cm13 = await waitFor(() => cloudQty(), (x) => x?.q === q0 + 20, 15_000);
  check(cm13?.q === q0 + 20, `cloud stock reflects the shop's movement (${cm13?.q})`, cm13);

  // 13b STOCK_REMOVE larger than the batch -> REJECTED, nothing changes (never negative)
  const q1 = await batchQty();
  const big = await issue('STOCK_REMOVE', { medicine_id: med, batch_id: batchId, quantity: q1 + 1, reason: 'Damaged' });
  const bigR = await waitFinal(big);
  check(bigR?.status === 'REJECTED' && /Cannot remove/.test(bigR.error || '') && !/at |\.ts|SELECT/i.test(bigR.error || ''), 'over-removal REJECTED with a clear, safe reason', bigR?.error);
  check((await batchQty()) === q1 && await n(`SELECT COUNT(*) n FROM sync_events WHERE payload->'data'->>'command_id' = $1`, [big]) === 0, 'stock unchanged, no outbox event for the rejected command');

  // 13c valid STOCK_REMOVE
  const rem = await issue('STOCK_REMOVE', { medicine_id: med, batch_id: batchId, quantity: 5, reason: 'Expired' });
  const remR = await waitFinal(rem);
  check(remR?.status === 'APPLIED' && (await batchQty()) === q1 - 5 && remR.result?.delta === -5, `STOCK_REMOVE applied (-5 -> ${await batchQty()})`, remR);

  // 13d STOCK_SET issued while the shop is offline; a sale happens before it is applied.
  await emu.stop();
  await sleep(1500);
  const setCmd = await issue('STOCK_SET', { medicine_id: med, batch_id: batchId, quantity: 50, reason: 'ITEST shelf count' });
  const offSale = await sell(ctx.cashierToken, 2);
  await sleep(3000);
  check(offSale.status === 201, 'POS keeps selling while the shop is offline', offSale.status);
  check((await cmdRow(setCmd))?.status === 'PENDING' && await n('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [setCmd]) === 0,
    'command stays PENDING (not applied, not reported APPLIED) while the shop is offline');
  const beforeSet = await batchQty();
  await emu.restart();
  const setR = await waitFinal(setCmd);
  check(setR?.status === 'APPLIED', 'command APPLIED once the shop reconnects', setR);
  check((await batchQty()) === 50 && setR?.result?.previous_quantity === beforeSet && setR?.result?.delta === 50 - beforeSet,
    `STOCK_SET uses the quantity locked at apply time (${beforeSet} -> 50, delta ${setR?.result?.delta})`, setR?.result);
  check(await n(`SELECT COUNT(*) n FROM inventory_movements WHERE batch_id = $1 AND movement_type = 'PHYSICAL_STOCK_COUNT' AND notes LIKE '%ITEST shelf count%' AND adjustment_quantity = $2`, [batchId, 50 - beforeSet]) === 1,
    'physical-count movement records the computed delta');
  const setEv = await waitFor(async () => (await pool.query(`SELECT status FROM sync_events WHERE event_type = 'PHYSICAL_COUNT' AND payload->'data'->>'command_id' = $1`, [setCmd])).rows, (r) => r[0]?.status === 'SYNCED');
  check(setEv.length === 1 && setEv[0].status === 'SYNCED', 'PHYSICAL_COUNT event synced back to the cloud');
  const again13 = await issue('STOCK_SET', { medicine_id: med, batch_id: batchId, quantity: 50, reason: 'ITEST shelf count' }, `dup-${setCmd}`);
  await waitFinal(again13);
  check((await batchQty()) === 50, 'a second identical count is harmless (sets 50 again, no drift)');

  // 13e BATCH_EXPIRY_UPDATE
  const expCmd = await issue('BATCH_EXPIRY_UPDATE', { medicine_id: med, batch_id: batchId, expiry_date: '2030-11-30', reason: 'ITEST label check' });
  const expCmdR = await waitFinal(expCmd);
  const localExp = (await pool.query(`SELECT to_char(expiry_date, 'YYYY-MM-DD') AS d FROM medicine_batches WHERE id = $1`, [batchId])).rows[0].d;
  check(expCmdR?.status === 'APPLIED' && localExp === '2030-11-30', 'batch expiry updated by command', { expCmdR, localExp });
  check(await n(`SELECT COUNT(*) n FROM sync_events WHERE event_type = 'BATCH_EXPIRY_CHANGED' AND payload->'data'->>'command_id' = $1`, [expCmd]) === 1 &&
        await n(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'ADMIN_EDIT_EXPIRY' AND entity_id = $1 AND user_name LIKE 'CLOUD (%'`, [batchId]) >= 1,
    'expiry change audited and queued for the cloud');
  const cloudExp = await waitFor(async () => (await emu.pool.query(`SELECT to_char(expiry_date, 'YYYY-MM-DD') AS d FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND batch_id = $2`, [shopId, batchId])).rows[0]?.d, (d) => d === '2030-11-30');
  check(cloudExp === '2030-11-30', 'cloud batch shows the new expiry');

  // 13f invalid commands are REJECTED with safe reasons (validated again by the shop)
  const neg = await issue('STOCK_ADD', { medicine_id: med, batch_id: batchId, quantity: -3, reason: 'bad' });
  const ghost = await issue('STOCK_REMOVE', { medicine_id: med, batch_id: crypto.randomUUID(), quantity: 1, reason: 'Lost' });
  const snap = await issue('STOCK_SET', { medicine_id: med, batch_id: batchId, quantity: 7, reason: 'x', current_stock: 7 });
  const [negR, ghostR, snapR] = [await waitFinal(neg), await waitFinal(ghost), await waitFinal(snap)];
  check(negR?.status === 'REJECTED' && /whole number/.test(negR.error || ''), 'negative quantity REJECTED', negR?.error);
  check(ghostR?.status === 'REJECTED' && /does not exist/.test(ghostR.error || ''), 'unknown batch REJECTED', ghostR?.error);
  check(snapR?.status === 'REJECTED' && /current_stock/.test(snapR.error || ''), 'stock snapshot field refused', snapR?.error);
  check((await batchQty()) === 50, 'rejected commands changed nothing');
  check((await sale1Items()) === itemsBefore, 'historical sale_items untouched by remote stock commands');

  // ------------------------------------------------------------------ TEST 14
  section('TEST 14 — Heartbeat, alerts, staff commands, update approval');
  const rt = await waitFor(async () => (await emu.pool.query(
    `SELECT *, EXTRACT(EPOCH FROM now() - reported_at)::int AS age FROM giga_cloud.shop_runtime_status WHERE shop_id = $1`, [shopId])).rows[0], (x) => Boolean(x), 30_000);
  check(Boolean(rt) && rt.age < 60 && rt.db_healthy === true && rt.worker_healthy === true, 'heartbeat stored in the cloud (db healthy, sync worker healthy)', rt && { age: rt.age, db: rt.db_healthy, w: rt.worker_healthy });
  check(rt?.app_version && rt.device_id && typeof rt.outbound_pending === 'number' && rt.backup && rt.inventory, 'heartbeat carries version, device, queue counts, backup and inventory state');
  const hbText = JSON.stringify(rt?.status || {});
  check(!hbText.includes(env.token) && !hbText.includes(env.apiKey) && !/postgres(ql)?:\/\//i.test(hbText) && !hbText.includes(process.env.DB_PASSWORD || '@@none@@') &&
        !hbText.includes(process.env.JWT_SECRET || '@@none@@'), 'heartbeat contains no token, key, connection string, DB password or JWT secret');
  const before14 = Number(rt?.heartbeats || 0);
  const rt2 = await waitFor(async () => Number((await emu.pool.query('SELECT heartbeats FROM giga_cloud.shop_runtime_status WHERE shop_id = $1', [shopId])).rows[0]?.heartbeats || 0), (n) => n > before14, 30_000);
  check(rt2 > before14, 'heartbeat repeats periodically', { before14, rt2 });
  const shopAlerts = (await emu.pool.query(`SELECT alert_key FROM giga_cloud.alerts WHERE shop_id = $1 AND source = 'SHOP' AND status <> 'RESOLVED'`, [shopId])).rows.map((x) => x.alert_key);
  check(shopAlerts.includes('BACKUP_DISABLED') || shopAlerts.includes('BACKUP_STALE'), 'shop-raised alert stored (backups not enabled on the test server)', shopAlerts);

  // Staff commands (no credentials ever travel)
  const c2 = ctx.cashier2;
  const off = await issue('USER_SET_ACTIVE', { user_id: c2.id, active: false, reason: 'ITEST staff left' });
  const offR = await waitFinal(off);
  const c2row = async () => (await pool.query('SELECT active, role FROM users WHERE id = $1', [c2.id])).rows[0];
  check(offR?.status === 'APPLIED' && (await c2row()).active === false, 'USER_SET_ACTIVE: cashier deactivated by command', offR);
  const denied = await api('POST', '/api/auth/login', null, { email: c2.email, password: c2.password });
  check(denied.status === 401 || denied.status === 403, 'deactivated cashier can no longer log in at the shop', denied.status);
  check(await n(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'REMOTE_USER_DEACTIVATED' AND entity_id = $1 AND new_value->>'command_id' = $2`, [c2.id, off]) === 1 &&
        await n(`SELECT COUNT(*) n FROM sync_events WHERE event_type = 'USER_UPSERTED' AND entity_id = $1 AND created_at > now() - interval '2 minutes'`, [c2.id]) >= 1,
    'audited and synced back (USER_UPSERTED)');
  const role = await issue('USER_ROLE_UPDATE', { user_id: c2.id, role: 'ADMIN', reason: 'ITEST promotion' });
  const roleR = await waitFinal(role);
  check(roleR?.status === 'APPLIED' && (await c2row()).role === 'ADMIN', 'USER_ROLE_UPDATE applied', roleR);
  const badRole = await issue('USER_ROLE_UPDATE', { user_id: c2.id, role: 'SUPERUSER', reason: 'ITEST bad' });
  check((await waitFinal(badRole))?.status === 'REJECTED', 'unknown role REJECTED');
  const pin = await issue('USER_SET_ACTIVE', { user_id: c2.id, active: true, reason: 'ITEST back', pin: '123456' });
  const pinR = await waitFinal(pin);
  check(pinR?.status === 'REJECTED' && /pin/.test(pinR.error || ''), 'credential fields are refused in staff commands', pinR?.error);
  await waitFinal(await issue('USER_ROLE_UPDATE', { user_id: c2.id, role: 'CASHIER', reason: 'ITEST restore' }));
  const onR = await waitFinal(await issue('USER_SET_ACTIVE', { user_id: c2.id, active: true, reason: 'ITEST restore' }));
  check(onR?.status === 'APPLIED' && (await c2row()).active === true && (await c2row()).role === 'CASHIER', 'cashier restored (active CASHIER)');

  // Update approval: only the exact version the shop's updater detected is accepted.
  const fakeSha = crypto.randomBytes(20).toString('hex');
  const noState = await waitFinal(await issue('APP_UPDATE_APPROVE', { target_commit: fakeSha }));
  check(noState?.status === 'REJECTED' && /updater is not installed/.test(noState.error || ''), 'approval REJECTED when the updater has reported nothing', noState?.error);
  fs.writeFileSync(path.join(TEST_RUNTIME_DIR, 'update-state.json'), JSON.stringify({ status: 'UPDATE_AVAILABLE', channel: 'production', current_commit: 'a'.repeat(40), available_commit: fakeSha }));
  const other = await waitFinal(await issue('APP_UPDATE_APPROVE', { target_commit: crypto.randomBytes(20).toString('hex') }));
  check(other?.status === 'REJECTED' && /not the update the shop detected/.test(other.error || ''), 'approval for a different commit REJECTED', other?.error);
  const ok14 = await waitFinal(await issue('APP_UPDATE_APPROVE', { target_commit: fakeSha, reason: 'ITEST approve' }));
  const appr = (await pool.query('SELECT target_commit, consumed_at FROM update_approvals WHERE target_commit = $1', [fakeSha])).rows;
  check(ok14?.status === 'APPLIED' && appr.length === 1 && appr[0].consumed_at === null, 'approval of the detected version recorded locally (updater installs it)', ok14);
  const helper = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/updater/approval.ts', 'get', fakeSha], { encoding: 'utf-8', env: { ...process.env } });
  check(/"approved":true/.test(helper.stdout), 'updater approval helper sees the approval', helper.stdout + helper.stderr);
  spawnSync(process.execPath, ['--import', 'tsx', 'scripts/updater/approval.ts', 'consume', fakeSha, 'ITEST', 'test cleanup'], { encoding: 'utf-8' });
  await pool.query('DELETE FROM update_approvals WHERE target_commit = $1', [fakeSha]);
  fs.rmSync(path.join(TEST_RUNTIME_DIR, 'update-state.json'), { force: true });

  // ------------------------------------------------------------------ SECURITY / STATUS
  section('SYNC STATUS & SECURITY');
  const anon = await api('GET', '/api/sync/status');
  check(anon.status === 401, 'unauthenticated sync status -> 401');
  const cs = await api('GET', '/api/sync/status', ctx.cashierToken);
  check(cs.status === 200 && cs.data.shop_id === undefined && cs.data.last_error === undefined && typeof cs.data.counts?.pending === 'number', 'cashier gets a summary only', cs.data);
  const as = await api('GET', '/api/sync/status', ctx.adminToken);
  check(as.status === 200 && as.data.mode === 'hybrid' && as.data.enabled === true && as.data.shop_id === shopId && as.data.cloud_reachable === true &&
        typeof as.data.counts?.synced === 'number' && 'last_sync' in as.data && 'device_id' in as.data, 'admin status has mode/shop/counts/last_sync/cloud_reachable', as.data);
  const dump = JSON.stringify(as.data) + JSON.stringify(cs.data);
  check(!dump.includes(env.token) && !dump.includes(env.apiKey), 'status responses contain no token or API key');
  const cnow = await api('POST', '/api/sync/now', ctx.cashierToken);
  check(cnow.status === 403, 'cashier cannot trigger Sync Now (403)');
  const anow = await api('POST', '/api/sync/now', ctx.adminToken);
  check(anow.status === 200 && ['scheduled', 'throttled'].includes(anow.data?.result), 'admin Sync Now wakes the worker', anow.data);
  const badShop = await fetch(`${emu.url}/rest/v1/rpc/gc_ingest_events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.apiKey, Authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify({ p_shop_id: crypto.randomUUID(), p_token: env.token, p_events: [] }),
  });
  check(badShop.status === 403, 'cloud rejects an unknown shop id (403)', badShop.status);
  const badTok = await fetch(`${emu.url}/rest/v1/rpc/gc_pull_commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.apiKey, Authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify({ p_shop_id: shopId, p_token: crypto.randomBytes(32).toString('hex') }),
  });
  check(badTok.status === 403, 'cloud rejects a wrong shop token (403)', badTok.status);
  const foreign = await fetch(`${emu.url}/rest/v1/rpc/gc_ingest_events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.apiKey, Authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify({ p_shop_id: shopId, p_token: env.token, p_events: [{ ...envelope, idempotency_key: `x-${crypto.randomUUID()}`, event_id: crypto.randomUUID(), shop_id: crypto.randomUUID() }] }),
  }).then((x) => x.json());
  check(foreign?.results?.[0]?.status === 'REJECTED', 'event claiming another shop is REJECTED', foreign);
  const log = getServerLog();
  check(!log.includes(env.token) && !log.includes(env.apiKey), 'server log never contains the token or API key');
  const userEv = await pool.query(`SELECT payload FROM sync_events WHERE event_type = 'USER_UPSERTED' ORDER BY seq DESC LIMIT 5`);
  check(userEv.rows.every((x) => !JSON.stringify(x.payload).includes('password_hash') && !JSON.stringify(x.payload).includes('pin_hash')), 'user events never carry credential hashes');

  // ------------------------------------------------------------------ BASELINE
  section('STOCK BASELINE (npm run sync:bootstrap)');
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med], {
    env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8',
  });
  check(boot.status === 0 && /Queued 1 baseline/.test(boot.stdout), 'baseline queued for the test medicine', boot.stdout + boot.stderr);
  check((await waitStatus(med, 'MEDICINE_BASELINE', 'SYNCED')) === 'SYNCED', 'baseline event synced');
  const soh = async () => (await emu.pool.query(
    'SELECT has_baseline, quantity::int AS q, drift_detected FROM giga_cloud.stock_on_hand WHERE shop_id = $1 AND batch_id = $2', [shopId, batchId])).rows[0];
  const b1 = async () => Number((await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [batchId])).rows[0].quantity_available);
  const sb = await soh();
  check(sb?.has_baseline === true && sb.q === (await b1()) && sb.drift_detected === false, `cloud stock_on_hand = local batch (${sb?.q} / ${await b1()})`, sb);
  const sAfter = await sell(ctx.cashierToken, 1);
  check(sAfter.status === 201 && (await waitStatus(sAfter.data.sale.id, 'SALE_COMPLETED', 'SYNCED')) === 'SYNCED', 'sale after baseline synced');
  const sa = await soh();
  check(sa?.q === (await b1()) && sa.q === sb.q - 1 && sa.drift_detected === false, 'cloud stock = baseline + ledger delta (-1), no drift', sa);

  // ------------------------------------------------------------------ FINAL CONSISTENCY
  section('FINAL CONSISTENCY (no duplicates, ledger = local stock)');
  const localSales = (await pool.query(
    `SELECT s.id FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE si.medicine_id = $1`, [med])).rows.map((x) => x.id);
  const cloudSales = await cloud('SELECT COUNT(*) n FROM giga_cloud.sales WHERE sale_id = ANY($1::uuid[])', [localSales]);
  const cloudDupes = await cloud('SELECT COUNT(*) n FROM (SELECT sale_id FROM giga_cloud.sales GROUP BY shop_id, sale_id HAVING COUNT(*) > 1) d');
  check(cloudSales === localSales.length && cloudDupes === 0, `every local test sale is in the cloud exactly once (${cloudSales}/${localSales.length})`);
  const localMovs = Number((await pool.query('SELECT COUNT(*) n FROM inventory_movements WHERE medicine_id = $1', [med])).rows[0].n);
  const cloudMovs = await cloud('SELECT COUNT(*) n FROM giga_cloud.inventory_movements WHERE medicine_id = $1', [med]);
  check(localMovs === cloudMovs, `movements: local ${localMovs} = cloud ${cloudMovs}`);
  const ledger = await cloud('SELECT COALESCE(SUM(delta), 0) n FROM giga_cloud.inventory_movements WHERE medicine_id = $1', [med]);
  check(ledger === (await localStock(med)), `cloud ledger sum ${ledger} = local stock ${await localStock(med)}`);
  const leftovers = Number((await pool.query(`SELECT COUNT(*) n FROM sync_events WHERE actor_user_id = ANY($1::uuid[]) AND status <> 'SYNCED'`, [[ctx.admin.id, ctx.cashier.id]])).rows[0].n);
  check(leftovers === 0, 'no test event left unsynced', leftovers);

  // ------------------------------------------------------------------ STARTUP WITH DNS FAILURE
  section('STARTUP — DNS failure / no internet');
  await stopServer();
  setServerEnv({
    APP_MODE: 'hybrid', SYNC_ENABLED: 'true', SUPABASE_URL: 'https://giga-chemist-nonexistent-host.invalid', SUPABASE_ANON_KEY: env.apiKey,
    SUPABASE_SERVICE_ROLE_KEY: '', SYNC_SHOP_TOKEN: env.token, SHOP_ID: '', SYNC_INTERVAL_SECONDS: '1', SYNC_HTTP_TIMEOUT_MS: '1500', SYNC_MAX_BACKOFF_SECONDS: '3',
  });
  await startServer();
  const h2 = await api('GET', '/api/health');
  check(h2.status === 200 && h2.data?.database?.connected === true, 'server starts and PostgreSQL is connected with DNS failing');
  const li = await api('POST', '/api/auth/login', null, { email: ctx.cashier.email, password: ctx.cashier.password });
  check(li.status === 200, 'login works');
  ctx.cashierToken = li.data?.token;
  const s13 = await sell(ctx.cashierToken, 1);
  check(s13.status === 201, 'sale works with DNS failing', s13.data);
  if (s13.status !== 201) return;
  const st13 = await waitFor(async () => (await api('GET', '/api/sync/status', ctx.adminToken)).data, (d) => d?.cloud_reachable === false && /DNS|unreachable/i.test(d?.last_error || ''), 15_000);
  check(st13?.cloud_reachable === false && (await statusOf(s13.data.sale.id, 'SALE_COMPLETED')) === 'PENDING', 'event PENDING; status reports cloud unreachable', { reach: st13?.cloud_reachable, err: st13?.last_error });
}
