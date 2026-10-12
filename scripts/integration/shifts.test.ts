import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { api, check, login, loginNoShift, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import { CLOUD_TEST_DB, type HybridEnv } from './hybrid.test';
import { hashCredential } from '../../server/auth';
import { computeShiftTotals, listShifts, shiftDetail } from '../../server/db/shifts';
import type { HistoryScope } from '../../server/db/history';

/**
 * CASHIER SHIFTS + CASH RECONCILIATION suite (npm run test:shifts).
 *   shop server : giga_chemist_dev, hybrid, sync worker ON, cloud EMULATOR STOPPED first (= Shop 1 with
 *                 NO INTERNET): the whole shift workflow runs offline, then the cloud comes back.
 *   cloud       : giga_chemist_cloud_test (recreated per run with cloud SQL 001-009)
 *   online API  : APP_MODE=online server.ts against the cloud test database (Global Admin views)
 *   Shop 2      : SYNTHETIC (its shift events fed through the real ingestion RPC with its own token)
 * Never touches a real cloud, a real shop or the PC2 giga_chemist database.
 */
const ONLINE_PORT = 3196;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `itest-${crypto.randomUUID()}`;
const pw = () => `Sh-${crypto.randomBytes(10).toString('base64url')}`;
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(300);
    v = await fn();
  }
  return v;
}

function cloudUrl(): string {
  const r = pool.options as any;
  if (r.connectionString) {
    const u = new URL(r.connectionString);
    u.pathname = `/${CLOUD_TEST_DB}`;
    return u.toString();
  }
  return `postgresql://${encodeURIComponent(r.user)}:${encodeURIComponent(r.password)}@${r.host}:${r.port}/${CLOUD_TEST_DB}`;
}

let online: ChildProcess | null = null;
let onlineLog = '';
export async function stopShiftOnline() {
  if (online && online.exitCode === null) online.kill();
  online = null;
}
async function startOnline(shopId: string) {
  onlineLog = '';
  online = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: {
      PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', PORT: String(ONLINE_PORT), NODE_ENV: 'production',
      APP_MODE: 'online', DATABASE_URL: cloudUrl(), ONLINE_ALLOW_LOCAL_DB: 'true', SHOP_ID: shopId,
      JWT_SECRET: crypto.randomBytes(48).toString('base64url'), AUTH_RATE_LIMIT_PER_MINUTE: '1000', ONLINE_COMMAND_RATE_PER_MINUTE: '1000',
      ONLINE_SECURITY_RATE_PER_MINUTE: '1000', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SYNC_SHOP_TOKEN: '', LOCAL_DATABASE_URL: cloudUrl(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  online.stdout!.on('data', (d) => (onlineLog += d));
  online.stderr!.on('data', (d) => (onlineLog += d));
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (online.exitCode !== null) throw new Error(`online server exited: ${onlineLog}`);
    try {
      if ((await fetch(`http://127.0.0.1:${ONLINE_PORT}/api/health`)).status === 200) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`online server not ready: ${onlineLog}`);
}
async function on(method: string, p: string, token?: string | null, body?: unknown, shop?: string | null, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { ...extra };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (shop) h['X-GIGA-SHOP-ID'] = shop;
  const res = await fetch(`http://127.0.0.1:${ONLINE_PORT}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

export async function shiftTests(env: HybridEnv, admin: Fixture, cashier: Fixture, cashier2: Fixture, manager: Fixture) {
  const { emu, shopId: shop1 } = env;
  const lq = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;
  const cq = async (sql: string, params: any[] = []) => (await emu.pool.query(sql, params)).rows;

  // ------------------------------------------------------------------ OFFLINE from here
  section('SETUP — Shop 1 with NO INTERNET (cloud unreachable)');
  await emu.stop();
  await sleep(800);
  const pwBefore = await lq(`SELECT id, password_hash, pin_hash FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, [[admin.id, cashier.id, cashier2.id, manager.id]]);
  const adminToken = await login(admin.email, admin.password); // admin sells too: login opens a float-0 shift
  const med = await upsertFixtureMedicine('ITEST-SHIFT-1', 'ZZ ITEST Shift Medicine', 100, 60);
  await lq('UPDATE medicines SET wholesale_price = NULL WHERE id = $1', [med]);
  let r: any = await api('POST', '/api/inventory/physical-count', adminToken, { medicine_id: med, counts: [{ batch_number: `SH-B1-${RUN}`, quantity: 500, expiry_date: '2031-06-30' }] });
  check(r.status === 200, 'fixture stock counted (500) while offline', r.data);
  const stockOf = async () => Number((await lq('SELECT current_stock FROM medicines WHERE id = $1', [med]))[0].current_stock);

  const cashierToken = await loginNoShift(cashier.email, cashier.password);
  const sell = (token: string, qty: number, payment: any) => api('POST', '/api/sales/checkout', token, {
    idempotency_key: key(), items: [{ medicine_id: med, quantity: qty, unit_price: 100 }], payment,
  });
  const CASH = (n = 1_000_000) => ({ method: 'Cash', amount_received: n });

  // ------------------------------------------------------------------ POS ACCESS / OPEN
  section('POS ACCESS + SHIFT OPEN (offline)');
  r = await api('GET', '/api/shifts/current', cashierToken);
  check(r.status === 200 && r.data.shift === null, 'cashier signed in: no open shift yet', r.data);
  r = await sell(cashierToken, 1, CASH());
  check(r.status === 409 && r.data?.code === 'SHIFT_REQUIRED', 'checkout WITHOUT an open shift is refused (SHIFT_REQUIRED)', r.data);
  check((await api('GET', '/api/medicines', cashierToken)).status === 200, 'without a shift the cashier can still search medicines');
  check((await api('GET', '/api/history/stock', cashierToken)).status === 200, 'without a shift the cashier can still view Stock History');
  check((await api('POST', '/api/shifts/open', cashierToken, { opening_float: -5 })).status === 400, 'negative opening float rejected');
  check((await api('POST', '/api/shifts/open', cashierToken, { opening_float: 'abc' })).status === 400, 'non-numeric opening float rejected');
  check((await api('POST', '/api/shifts/open', cashierToken, { opening_float: 1.234 })).status === 400, 'opening float with 3 decimals rejected');
  r = await api('POST', '/api/shifts/open', cashierToken, { opening_float: 2000 });
  const shiftA = r.data?.shift;
  check(r.status === 201 && r.data.created === true && shiftA?.opening_float === 2000 && shiftA?.status === 'OPEN', 'TEST 1/9: cashier opens a shift; opening float KES 2,000 stored', r.data);
  check(/^SHIFT-\d{8}-\d{5}$/.test(shiftA?.shift_number || ''), 'shift gets a server number SHIFT-YYYYMMDD-NNNNN', shiftA?.shift_number);
  const dbA = (await lq('SELECT * FROM cashier_shifts WHERE id = $1', [shiftA.id]))[0];
  check(Number(dbA.opening_float) === 2000 && dbA.cashier_id === cashier.id && dbA.device_id === 'ITEST-TERMINAL', 'DB row: float 2000, cashier, device recorded', dbA);
  r = await api('POST', '/api/shifts/open', cashierToken, { opening_float: 500 });
  check(r.status === 200 && r.data.created === false && r.data.shift?.id === shiftA.id && r.data.shift?.opening_float === 2000, 'TEST 10: second open returns the SAME open shift (float unchanged)', r.data);
  const c2Token = await loginNoShift(cashier2.email, cashier2.password);
  const races = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/api/shifts/open', c2Token, { opening_float: 1000 })));
  const raceIds = new Set(races.map((x) => x.data?.shift?.id));
  check(races.every((x) => x.status === 200 || x.status === 201) && raceIds.size === 1, '6 concurrent opens -> ONE shift', races.map((x) => x.status));
  check(Number((await lq(`SELECT COUNT(*) n FROM cashier_shifts WHERE cashier_id = $1 AND status = 'OPEN'`, [cashier2.id]))[0].n) === 1, 'DB: exactly one OPEN shift for that cashier');
  const shiftB = races[0].data.shift;
  const audit = await lq(`SELECT action FROM audit_logs WHERE entity = 'cashier_shift' AND entity_id = $1`, [shiftA.id]);
  check(audit.some((a) => a.action === 'SHIFT_OPENED'), 'SHIFT_OPENED audited');
  const evOpen = await lq(`SELECT status FROM sync_events WHERE event_type = 'SHIFT_OPENED' AND entity_id = $1`, [shiftA.id]);
  check(evOpen.length === 1 && evOpen[0].status === 'PENDING', 'TEST 11: opening works OFFLINE (event waits PENDING in the outbox)', evOpen);

  // ------------------------------------------------------------------ SALES
  section('SALES — payments split per method (offline)');
  const sCash = await sell(cashierToken, 3, CASH(500));
  const sMpesa = await sell(cashierToken, 2, { method: 'M-Pesa', reference: `QA${RUN}MP1` });
  const sCard = await sell(cashierToken, 1, { method: 'Card' });
  const sBank = await sell(cashierToken, 1, { method: 'Bank', reference: 'BNK1' });
  const sMixed = await sell(cashierToken, 10, { method: 'Mixed', split: [{ method: 'Cash', amount: 400 }, { method: 'M-Pesa', amount: 600, reference: `QA${RUN}MP2` }] });
  check([sCash, sMpesa, sCard, sBank, sMixed].every((x) => x.status === 201), 'TEST 37: five sales complete offline (existing POS checkout)', [sCash, sMpesa, sCard, sBank, sMixed].map((x) => x.status));
  const tagged = await lq('SELECT COUNT(*)::int n FROM sales WHERE shift_id = $1', [shiftA.id]);
  check(tagged[0].n === 5, 'every sale is tagged with the cashier shift', tagged);
  const cur = async (token = cashierToken) => (await api('GET', '/api/shifts/current', token)).data;
  let c = await cur();
  check(c.live?.cash_sales === 700, 'TEST 12: cash sale adds to cash sales (300 + mixed 400 = 700)', c.live);
  check(c.live?.mpesa_sales === 800, 'TEST 13: M-Pesa counted as M-Pesa (200 + mixed 600 = 800)', c.live);
  check(c.live?.card_sales === 100 && c.live?.bank_sales === 100, 'TEST 14: card / bank counted separately', c.live);
  check(c.live?.mixed_transactions === 1, 'TEST 15: mixed payment split by its lines (1 mixed sale)', c.live);
  check(c.live?.total_transactions === 5 && c.live?.total_sales === 1700 && c.live?.units_sold === 17, 'TEST 16: 5 sales aggregate to 1,700 (17 units)', c.live);
  check(c.live?.expected_cash === 2700, 'expected cash = 2000 float + 700 cash (non-cash ignored)', c.live?.expected_cash);
  const cText = JSON.stringify(c);
  check(!/gross_profit|cost_total|purchase_price|margin/.test(cText), 'NO profit / cost in the cashier shift summary', cText.slice(0, 200));

  // ------------------------------------------------------------------ RETURNS / VOIDS
  section('RETURNS / VOIDS');
  const batchOf = async (saleId: string) => (await lq('SELECT batch_id FROM sale_items WHERE sale_id = $1 LIMIT 1', [saleId]))[0].batch_id;
  const req = (saleId: string, b: string, q = 1) => api('POST', '/api/returns', cashierToken, { sale_id: saleId, medicine_id: med, batch_id: b, quantity: q, reason: 'ZZ ITEST shift return' });
  const rPending = await req(sCash.data.sale.id, await batchOf(sCash.data.sale.id));
  c = await cur();
  check(rPending.status === 201 && c.live.refund_total === 0 && c.live.expected_cash === 2700, 'TEST 19: PENDING return changes nothing', c.live);
  const rRej = await req(sMpesa.data.sale.id, await batchOf(sMpesa.data.sale.id));
  r = await api('POST', `/api/returns/${rRej.data.return.id}/reject`, adminToken, { notes: 'ZZ ITEST not eligible' });
  c = await cur();
  check(r.status === 200 && c.live.refund_total === 0 && c.live.expected_cash === 2700, 'TEST 20: REJECTED return changes nothing', c.live);
  r = await api('POST', `/api/returns/${rPending.data.return.id}/approve`, adminToken, { restock: true, refund_method: 'Cash' });
  c = await cur();
  check(r.status === 200 && r.data.refund_shift_id === shiftA.id && r.data.refund_method === 'Cash', 'cash refund paid from the requesting cashier\'s till', r.data);
  check(c.live.cash_refunds === 100 && c.live.expected_cash === 2600, 'TEST 17: approved CASH refund reduces expected cash (2700 -> 2600)', c.live);
  const rM = await req(sMpesa.data.sale.id, await batchOf(sMpesa.data.sale.id));
  r = await api('POST', `/api/returns/${rM.data.return.id}/approve`, adminToken, { restock: true, refund_method: 'M-Pesa' });
  c = await cur();
  check(r.status === 200 && c.live.refund_total === 200 && c.live.cash_refunds === 100 && c.live.expected_cash === 2600, 'TEST 18: M-Pesa refund counted as refund, physical cash unchanged', c.live);
  check((await api('POST', `/api/returns/${crypto.randomUUID()}/approve`, adminToken, { restock: true, refund_method: 'Cheque' })).status === 400, 'unknown refund method rejected');
  const sVoid = await sell(cashierToken, 2, CASH());
  r = await api('POST', `/api/sales/${sVoid.data.sale.id}/void`, adminToken, { reason: 'ZZ ITEST wrong item' });
  c = await cur();
  check(r.status === 200 && c.live.total_sales === 1700 && c.live.total_transactions === 5 && c.live.voided_count === 1 && c.live.voided_total === 200 && c.live.expected_cash === 2600,
    'TEST 21: voided sale does NOT inflate shift sales / cash (reported as voided)', c.live);
  check((await lq('SELECT status FROM sales WHERE id = $1', [sVoid.data.sale.id]))[0]?.status === 'voided', 'voided sale kept in history (not deleted)');

  // ------------------------------------------------------------------ EXPENSES
  section('EXPENSES — only cash paid from the till');
  r = await api('GET', '/api/shifts/open-tills', adminToken);
  check(r.status === 200 && r.data.tills.some((t: any) => t.id === shiftA.id), 'admin sees open tills to pay an expense from', r.data);
  check((await api('GET', '/api/shifts/open-tills', cashierToken)).status === 403, 'cashier cannot list tills');
  const exp = (body: any) => api('POST', '/api/expenses', adminToken, { category: 'Supplies', description: `ZZ ITEST shift expense ${RUN}`, ...body });
  r = await exp({ amount: 50, payment_method: 'Cash', shift_id: shiftA.id });
  c = await cur();
  check(r.status === 201 && r.data.expense?.shift_id === shiftA.id && c.live.cash_expenses === 50 && c.live.expected_cash === 2550, 'TEST 22: cash till expense reduces expected cash (2600 -> 2550)', c.live);
  r = await exp({ amount: 70, payment_method: 'M-Pesa', shift_id: shiftA.id });
  check(r.status === 400, 'a non-cash expense cannot be paid from a till', r.data);
  await exp({ amount: 80, payment_method: 'M-Pesa' });
  await exp({ amount: 90, payment_method: 'Cash' });
  c = await cur();
  check(c.live.cash_expenses === 50 && c.live.expected_cash === 2550, 'TEST 23: non-cash expense / cash expense not from this till leave the drawer unchanged', c.live);

  // ------------------------------------------------------------------ CLOSE
  section('CLOSE — expected, actual, variance');
  const stockBeforeClose = await stockOf();
  const movesBefore = Number((await lq('SELECT COUNT(*) n FROM inventory_movements WHERE medicine_id = $1', [med]))[0].n);
  check((await api('POST', `/api/shifts/${shiftA.id}/close`, cashierToken, { actual_cash: 2350, closing_notes: 'x', expected_cash_seen: 2400 })).data?.code === 'SHIFT_TOTALS_CHANGED',
    'stale expected cash on the close screen -> refused (SHIFT_TOTALS_CHANGED)');
  r = await api('POST', `/api/shifts/${shiftA.id}/close`, cashierToken, { actual_cash: 2350 });
  check(r.status === 400 && r.data?.code === 'VARIANCE_REASON_REQUIRED', 'TEST 30: non-zero variance requires a reason', r.data);
  check((await api('POST', `/api/shifts/${shiftA.id}/close`, c2Token, { actual_cash: 2550 })).status === 403, 'another cashier cannot close this shift');
  check((await api('POST', `/api/shifts/${shiftA.id}/close`, cashierToken, { actual_cash: -1, closing_notes: 'neg' })).status === 400, 'negative actual cash rejected');
  r = await api('POST', `/api/shifts/${shiftA.id}/close`, cashierToken, { actual_cash: 2350, closing_notes: 'Customer change shortage', expected_cash_seen: 2550 });
  const closedA = r.data?.shift;
  check(r.status === 200 && closedA?.status === 'CLOSED', 'TEST 2: cashier closes own shift', r.data);
  check(closedA?.expected_cash === 2550, 'TEST 24: expected cash = 2000 + 700 - 100 - 50 = 2550', closedA);
  check(closedA?.actual_cash === 2350, 'TEST 25: actual cash stored', closedA?.actual_cash);
  check(closedA?.cash_variance === -200 && closedA?.variance_status === 'SHORT', 'TEST 26/27: variance -200 = SHORT', closedA);
  check(Array.isArray(r.data.medicines) && r.data.medicines[0]?.quantity_sold === 17, 'close shows medicines sold during the shift', r.data.medicines);
  const dbClosed = (await lq('SELECT * FROM cashier_shifts WHERE id = $1', [shiftA.id]))[0];
  check(Number(dbClosed.cash_sales) === 700 && Number(dbClosed.mpesa_sales) === 800 && Number(dbClosed.cash_refunds) === 100 && Number(dbClosed.cash_expenses) === 50
    && Number(dbClosed.voided_total) === 200 && dbClosed.close_method === 'CASHIER' && dbClosed.closing_notes === 'Customer change shortage', 'closing figures stored on the shift row', dbClosed);
  check((await stockOf()) === stockBeforeClose && Number((await lq('SELECT COUNT(*) n FROM inventory_movements WHERE medicine_id = $1', [med]))[0].n) === movesBefore,
    'TEST 41: closing a shift changes NO stock and writes NO movement');
  r = await api('POST', `/api/shifts/${shiftA.id}/close`, cashierToken, { actual_cash: 2550, closing_notes: 'retry to fix' });
  check(r.status === 409, 'TEST 31: a CLOSED shift cannot be closed / edited again by the cashier', r.data);
  check((await api('POST', '/api/shifts/open', cashierToken, { opening_float: 10 })).status === 201, 'cashier can open a NEW shift (old one stays closed)');
  const shiftA2 = (await cur()).shift;
  check(shiftA2?.id !== shiftA.id, 'new shift has a new id');
  r = await api('POST', `/api/sales/${sCash.data.sale.id}/void`, adminToken, { reason: 'ZZ ITEST late void' });
  check(r.status === 409, 'a returned sale of a CLOSED shift cannot be voided', r.data);
  r = await api('POST', `/api/sales/${sCard.data.sale.id}/void`, adminToken, { reason: 'ZZ ITEST late void' });
  check(r.status === 409 && r.data?.code === 'SHIFT_CLOSED', 'void of a counted sale -> SHIFT_CLOSED (use a return)', r.data);
  // close the replacement shift balanced (float 10, nothing sold)
  r = await api('POST', `/api/shifts/${shiftA2.id}/close`, cashierToken, { actual_cash: 10 });
  check(r.status === 200 && r.data.shift.cash_variance === 0 && r.data.shift.variance_status === 'BALANCED', 'TEST 29: zero variance = BALANCED (no reason needed)', r.data?.shift);

  // Cashier 2: float 1000, one cash sale of 100, counts 1150 -> OVER 50
  r = await sell(c2Token, 1, CASH());
  r = await api('POST', `/api/shifts/${shiftB.id}/close`, c2Token, { actual_cash: 1150, closing_notes: 'Counting surplus' });
  check(r.status === 200 && r.data.shift.expected_cash === 1100 && r.data.shift.cash_variance === 50 && r.data.shift.variance_status === 'OVER', 'TEST 28: overage detected (+50 OVER)', r.data?.shift);

  // ------------------------------------------------------------------ RBAC / VIEWS
  section('PERMISSIONS + SHIFT HISTORY');
  r = await api('GET', '/api/shifts', cashierToken);
  check(r.status === 200 && r.data.rows.length >= 2 && r.data.rows.every((x: any) => x.cashier_id === cashier.id), 'TEST 3: cashier sees only OWN shifts', r.data?.rows?.map((x: any) => x.cashier_name));
  r = await api('GET', `/api/shifts?cashier=${cashier2.id}`, cashierToken);
  check(r.status === 200 && r.data.rows.length === 0, 'cashier filtering on another cashier still sees nothing of theirs');
  check((await api('GET', `/api/shifts/${shiftB.id}`, cashierToken)).status === 404, 'TEST 4: cashier cannot open another cashier\'s shift (404)');
  check((await api('GET', `/api/shifts/${shiftB.id}/medicines`, cashierToken)).status === 404, 'nor its medicines');
  check((await api('GET', '/api/shifts/overview', cashierToken)).status === 403, 'cashier has no shop overview');
  check((await api('POST', `/api/shifts/${shiftB.id}/review`, cashierToken, { notes: 'mine now' })).status === 403, 'TEST 5: cashier cannot review a shift');
  check((await api('POST', `/api/shifts/${shiftB.id}/corrections`, cashierToken, { corrected_actual_cash: 1, reason: 'nope' })).status === 403, 'cashier cannot correct a shift');
  const csv = await api('GET', '/api/shifts/export', cashierToken);
  check(csv.status === 200 && !String(csv.data).includes(cashier2.email.split('@')[0]) && !String(csv.data).includes('ITest Shift Cashier Two'), 'cashier export contains only own shifts');
  r = await api('GET', `/api/shifts/${shiftA.id}`, cashierToken);
  check(r.status === 200 && r.data.shift.cash_variance === -200 && !/gross_profit|cost_total/.test(JSON.stringify(r.data)), 'cashier reads own shift detail (no profit)', r.data?.shift);
  r = await api('GET', '/api/shifts', adminToken);
  const ids = new Set(r.data?.rows?.map((x: any) => x.id));
  check(r.status === 200 && ids.has(shiftA.id) && ids.has(shiftB.id), 'TEST 6: admin sees every shift of the shop', r.data?.summary);
  check(r.data.summary.unreviewed_variances >= 2 && r.data.by_cashier.length >= 2 && r.data.by_day.length >= 1, 'reports: summary + cashier reconciliation + daily summary', r.data.summary);
  r = await api('GET', '/api/shifts?variance=SHORT', adminToken);
  check(r.data.rows.some((x: any) => x.id === shiftA.id) && !r.data.rows.some((x: any) => x.id === shiftB.id), 'variance filter SHORT', r.data.rows.length);
  r = await api('GET', `/api/shifts/${shiftA.id}`, adminToken);
  check(r.status === 200 && r.data.recount.changed_since_close === false && r.data.refunds.length === 2 && r.data.expenses.length === 1 && r.data.voided_sales.length === 1,
    'shift detail: refunds, till expenses, voids; recount matches the closing figures', r.data?.recount);
  r = await api('GET', `/api/shifts/${shiftA.id}/medicines`, adminToken);
  check(r.status === 200 && r.data.medicines[0]?.quantity_sold === 17 && r.data.medicines[0]?.returned === 2 && r.data.medicines[0]?.net_sold === 15, 'medicines sold during the shift: 17 sold, 2 returned, 15 net', r.data);
  r = await api('GET', `/api/history/sales?shift_id=${shiftA.id}&page_size=25`, adminToken);
  check(r.status === 200 && r.data.total === 6, 'TEST 38: Sales History filtered to the shift (5 sales + 1 voided)', r.data?.total);
  const managerToken = await login(manager.email, manager.password);
  check((await api('GET', '/api/shifts', managerToken)).status === 200, 'manager sees shop shifts');
  r = await api('POST', `/api/shifts/${shiftA.id}/review`, managerToken, {});
  check(r.status === 400, 'review of a shift with a variance needs notes', r.data);
  r = await api('POST', `/api/shifts/${shiftA.id}/review`, managerToken, { notes: 'Shortage explained, deducted' });
  check(r.status === 200 && r.data.status === 'REVIEWED', 'manager reviews the shift (CLOSED -> REVIEWED)', r.data);
  const revRow = (await lq('SELECT status, actual_cash, cash_variance FROM cashier_shifts WHERE id = $1', [shiftA.id]))[0];
  check(revRow.status === 'REVIEWED' && Number(revRow.actual_cash) === 2350 && Number(revRow.cash_variance) === -200, 'review never changes the closing figures', revRow);
  check((await api('POST', `/api/shifts/${shiftA.id}/review`, adminToken, { notes: 'again' })).status === 409, 'a reviewed shift cannot be reviewed twice');
  check((await api('POST', `/api/shifts/${shiftB.id}/corrections`, managerToken, { corrected_actual_cash: 1100, reason: 'Recount' })).status === 403, 'manager cannot correct counted cash');
  r = await api('POST', `/api/shifts/${shiftB.id}/corrections`, adminToken, { corrected_actual_cash: 1100, reason: 'Recount found 50 belonged to the next day' });
  check(r.status === 201 && r.data.correction.corrected_variance === 0 && r.data.correction.previous_actual_cash === 1150, 'admin correction is a separate audited row', r.data);
  r = await api('GET', `/api/shifts/${shiftB.id}`, adminToken);
  check(r.data.shift.actual_cash === 1150 && r.data.shift.cash_variance === 50 && r.data.shift.effective_variance === 0 && r.data.corrections.length === 1,
    'original closing figures kept; effective variance after correction = 0', r.data.shift);

  // Controlled admin closure of a shift left open from a previous business day.
  const mgrShift = (await cur(managerToken)).shift;
  await lq(`UPDATE cashier_shifts SET opened_business_date = opened_business_date - 1, opened_at = opened_at - interval '1 day' WHERE id = $1`, [mgrShift.id]);
  r = await api('GET', '/api/shifts/overview', adminToken);
  check(r.status === 200 && r.data.flagged.some((f: any) => f.id === mgrShift.id && f.flag === 'SHIFT_LEFT_OPEN') && r.data.shops[0].open_from_previous_day >= 1,
    'overview flags OPEN SHIFT FROM PREVIOUS BUSINESS DAY (not auto-closed)', r.data?.shops);
  check((await lq('SELECT status FROM cashier_shifts WHERE id = $1', [mgrShift.id]))[0].status === 'OPEN', 'left-open shift is NOT auto-closed');
  check((await api('POST', `/api/shifts/${mgrShift.id}/close`, adminToken, { actual_cash: 0 })).status === 400, 'admin closing another person\'s shift needs a reason');
  r = await api('POST', `/api/shifts/${mgrShift.id}/close`, adminToken, { actual_cash: 0, admin_close_reason: 'Manager forgot to close; drawer counted by admin' });
  check(r.status === 200 && r.data.shift.close_method === 'ADMIN' && !!r.data.shift.admin_close_reason && !!r.data.shift.closed_by_name && r.data.shift.actual_cash === 0,
    'controlled admin closure records closed_by + reason + counted cash', r.data?.shift);
  check((await lq(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'SHIFT_CLOSED_BY_ADMIN' AND entity_id = $1`, [mgrShift.id]))[0].n === '1', 'admin closure audited');

  // Regression: stock history daily sold medicines still exact.
  const today = (await lq(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') d`))[0].d;
  r = await api('GET', `/api/history/stock?from=${today}&to=${today}&medicine_id=${med}`, adminToken);
  const sh = (r.data?.rows || []).find((x: any) => x.medicine_id === med);
  const soldToday = Number((await lq(`SELECT COALESCE(SUM(si.quantity),0) n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.medicine_id = $1 AND s.date = $2::date AND s.status <> 'voided'`, [med, today]))[0].n);
  check(r.status === 200 && !!sh && Number(sh.gross_sold) === soldToday, 'TEST 39/40: Stock History daily sold medicines still exact (voided excluded)', { sold: sh?.gross_sold, soldToday });

  // ------------------------------------------------------------------ OFFLINE -> SYNC
  section('OFFLINE -> RECONNECT -> SYNC');
  const shiftEvents = async () => lq(`SELECT id, idempotency_key, event_type, status, entity_id, payload, seq FROM sync_events WHERE entity_type = 'cashier_shift' AND entity_id = ANY($1::uuid[]::text[]) ORDER BY seq`,
    [[shiftA.id, shiftB.id, shiftA2.id, mgrShift.id]]);
  let evs = await shiftEvents();
  check(evs.length >= 9 && evs.every((e) => e.status === 'PENDING' || e.status === 'FAILED'), 'TEST 32: the entire shift workflow ran with the cloud unreachable (events waiting)', evs.map((e) => `${e.event_type}:${e.status}`));
  const payloads = JSON.stringify(evs.map((e) => e.payload));
  check(!/password|pin_hash|"token"|salt/i.test(payloads), 'shift events carry no password / PIN / token', payloads.slice(0, 200));
  await emu.restart();
  evs = await waitFor(shiftEvents, (x) => x.every((e) => e.status === 'SYNCED'), 60_000);
  check(evs.every((e) => e.status === 'SYNCED'), 'TEST 33: after the internet returns every shift event SYNCS', evs.map((e) => `${e.event_type}:${e.status}`));
  const cloudA = (await cq('SELECT * FROM giga_cloud.cashier_shifts WHERE shop_id = $1 AND shift_id = $2', [shop1, shiftA.id]));
  check(cloudA.length === 1 && cloudA[0].status === 'REVIEWED' && Number(cloudA[0].actual_cash) === 2350 && Number(cloudA[0].cash_variance) === -200 && Number(cloudA[0].expected_cash) === 2550,
    'TEST 35: cloud has the SAME shift id with the same closing figures', cloudA[0]);
  check(Number((await cq('SELECT COUNT(*) n FROM giga_cloud.cashier_shifts WHERE shift_id = ANY($1::uuid[])', [[shiftA.id, shiftB.id, shiftA2.id, mgrShift.id]]))[0].n) === 4, 'no duplicate shift rows in the cloud');
  check(Number((await cq(`SELECT COUNT(*) n FROM giga_cloud.sales WHERE shop_id = $1 AND (data->>'shift_id')::uuid = $2`, [shop1, shiftA.id]))[0].n) === 6, 'cloud sales carry their shift');
  check(Number((await cq(`SELECT COUNT(*) n FROM giga_cloud.cashier_shift_corrections WHERE shop_id = $1 AND shift_id = $2`, [shop1, shiftB.id]))[0].n) === 1, 'correction mirrored once');
  // Replays: the same event again is a DUPLICATE; an OLDER copy never overwrites a newer row.
  const token1 = env.token;
  const toWire = (e: any, overrides: any = {}) => ({ event_id: e.id, idempotency_key: e.idempotency_key, shop_id: shop1, local_seq: String(e.seq), event_type: e.event_type,
    entity_type: 'cashier_shift', entity_id: e.entity_id, payload: e.payload, ...overrides });
  const closeEv = evs.find((e) => e.event_type === 'SHIFT_CLOSED' && e.entity_id === shiftA.id)!;
  let ing = (await cq('SELECT public.gc_ingest_events($1, $2, $3::jsonb) AS r', [shop1, token1, JSON.stringify([toWire(closeEv)])]))[0].r;
  check(ing.results[0].status === 'DUPLICATE', 'TEST 34: replayed shift event = DUPLICATE (applied once)', ing);
  const openEv = evs.find((e) => e.event_type === 'SHIFT_OPENED' && e.entity_id === shiftA.id)!;
  ing = (await cq('SELECT public.gc_ingest_events($1, $2, $3::jsonb) AS r', [shop1, token1, JSON.stringify([toWire(openEv, { event_id: crypto.randomUUID(), idempotency_key: `itest-replay-${crypto.randomUUID()}` })])]))[0].r;
  const afterReplay = (await cq('SELECT status FROM giga_cloud.cashier_shifts WHERE shop_id = $1 AND shift_id = $2', [shop1, shiftA.id]))[0];
  check(ing.results[0].status === 'APPLIED' && afterReplay.status === 'REVIEWED', 'an older SHIFT_OPENED re-sent later cannot reopen the reviewed cloud row', { ing, afterReplay });
  const alerts = await cq(`SELECT alert_key, kind, status FROM giga_cloud.alerts WHERE shop_id = $1 AND alert_key = ANY($2::text[])`, [shop1, [`SHIFT_VARIANCE:${shiftA.id}`, `SHIFT_VARIANCE:${shiftB.id}`]]);
  // Retries after the outage may deliver events out of order (due time); whatever the order, a reviewed /
  // corrected-to-zero shift ends with NO active variance alert (raising is covered by Shop 2 below).
  check(!alerts.some((a) => a.status !== 'RESOLVED'), 'no active variance alert left for the reviewed / corrected shifts (order-independent)', alerts);

  // ------------------------------------------------------------------ CLOUD: shop scoping + same formula
  section('CLOUD COPY — same formula, shop scoping, synthetic Shop 2');
  const shop2 = crypto.randomUUID();
  const token2 = crypto.randomBytes(32).toString('base64url');
  await cq('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop2, 'SHOP2', 'GIGA CHEMIST - SHOP 2 (synthetic)', token2]);
  const s2open = crypto.randomUUID(), s2closed = crypto.randomUUID(), s2cashier = crypto.randomUUID();
  const old = new Date(Date.now() - 3 * 86_400_000);
  const oldDate = old.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const s2ev = (seq: number, type: string, shift: any) => ({
    event_id: crypto.randomUUID(), idempotency_key: `itest-sh-s2-${crypto.randomUUID()}`, shop_id: shop2, local_seq: String(seq), event_type: type,
    entity_type: 'cashier_shift', entity_id: shift.id, payload: { data: { shift, cashier_name: 'ZZ S2 Cashier' }, movements: [], batches: [], audit: [] },
  });
  ing = (await cq('SELECT public.gc_ingest_events($1, $2, $3::jsonb) AS r', [shop2, token2, JSON.stringify([
    s2ev(1, 'SHIFT_OPENED', { id: s2open, shift_number: 'S2-SHIFT-1', cashier_id: s2cashier, status: 'OPEN', opened_at: old.toISOString(), opened_business_date: oldDate, opening_float: 500 }),
    s2ev(2, 'SHIFT_CLOSED', { id: s2closed, shift_number: 'S2-SHIFT-2', cashier_id: s2cashier, status: 'CLOSED', opened_at: old.toISOString(), opened_business_date: oldDate, opening_float: 300,
      closed_at: old.toISOString(), closed_business_date: oldDate, close_method: 'CASHIER', total_sales: 900, cash_sales: 400, expected_cash: 700, actual_cash: 650, cash_variance: -50, closing_notes: 'S2 short' }),
  ])]))[0].r;
  check(ing.results.every((x: any) => x.status === 'APPLIED'), 'Shop 2 shift events ingested with its own token', ing);
  await cq('SELECT giga_cloud.refresh_shift_alerts($1)', [shop2]);
  const s2alerts = await cq(`SELECT kind, severity, status FROM giga_cloud.alerts WHERE shop_id = $1 AND status <> 'RESOLVED'`, [shop2]);
  check(s2alerts.some((a) => a.kind === 'SHIFT_NOT_CLOSED' && a.severity === 'CRITICAL') && s2alerts.some((a) => a.kind === 'SHIFT_SHORTAGE'),
    'alerts: SHIFT_NOT_CLOSED (open 3 days) + SHIFT_SHORTAGE for Shop 2', s2alerts);
  check(!(await cq(`SELECT 1 FROM giga_cloud.alerts WHERE shop_id = $1 AND alert_key LIKE 'SHIFT_%' AND alert_key LIKE '%' || $2`, [shop1, s2open])).length, 'Shop 2 alerts never attached to Shop 1');
  const scope = (shopIds: string[]): HistoryScope => ({ q: emu.pool, mode: 'cloud', shopIds, includeCost: false });
  const localScope: HistoryScope = { q: pool, mode: 'local', shopIds: [shop1], includeCost: false };
  const cloudTotals = (await computeShiftTotals(scope([shop1]), [shiftA.id])).get(shiftA.id)!;
  const localTotals = (await computeShiftTotals(localScope, [shiftA.id])).get(shiftA.id)!;
  check(JSON.stringify(cloudTotals) === JSON.stringify(localTotals), 'the SAME formula over the cloud copy gives the same shift totals as the shop', { cloudTotals, localTotals });
  const l1 = await listShifts(scope([shop1]), {}, { ownCashierId: null });
  check(l1.rows.every((x: any) => x.shop_id === shop1) && !l1.rows.some((x: any) => x.id === s2open), 'TEST 36: Shop 1 scope never shows Shop 2 shifts');
  const lAll = await listShifts(scope([shop1, shop2]), {}, { ownCashierId: null });
  check(lAll.rows.some((x: any) => x.id === s2closed && x.shop_id === shop2) && lAll.rows.some((x: any) => x.id === shiftA.id && x.shop_id === shop1), 'All Shops: each shift stays with its real shop');
  let threw = false;
  try { await shiftDetail(scope([shop1]), s2closed, { ownCashierId: null }); } catch (e: any) { threw = e?.status === 404; }
  check(threw, 'TEST 8: a Shop 2 shift is not found in a Shop 1 scope');

  // ------------------------------------------------------------------ ONLINE GLOBAL ADMIN
  section('ONLINE — Global Admin / shop accounts');
  const gaPw = pw(), s1aPw = pw(), oCashPw = pw();
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, NULL, NULL)', ['itest-sh-global@itest.local', 'ITest SH Global Admin', 'ADMIN', hashCredential(gaPw).combined]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-sh-s1admin@itest.local', 'ITest SH Shop1 Admin', 'ADMIN', hashCredential(s1aPw).combined, shop1]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, $6)', ['itest-sh-s1cash@itest.local', 'ITest SH Shop1 Cashier', 'CASHIER', hashCredential(oCashPw).combined, shop1, cashier.id]);
  await startOnline(shop1);
  const onLogin = async (email: string, password: string) => (await on('POST', '/api/auth/login', null, { email, password })).data?.token;
  const GA = await onLogin('itest-sh-global@itest.local', gaPw);
  const S1A = await onLogin('itest-sh-s1admin@itest.local', s1aPw);
  const OCASH = await onLogin('itest-sh-s1cash@itest.local', oCashPw);
  check(Boolean(GA && S1A && OCASH), 'online accounts log in');
  r = await on('GET', '/api/shifts?page_size=100', GA, undefined, null, { 'X-GIGA-SCOPE': 'ALL' });
  check(r.status === 200 && r.data.rows.some((x: any) => x.shop_code === 'SHOP2') && r.data.rows.some((x: any) => x.shop_code === 'SHOP1'), 'TEST 7: Global Admin All Shops shift history (Shop 1 + Shop 2)', r.data?.rows?.length);
  r = await on('GET', '/api/shifts', GA, undefined, shop2);
  check(r.status === 200 && r.data.rows.every((x: any) => x.shop_code === 'SHOP2'), 'Global Admin -> Shop 2 only', r.data?.rows?.length);
  r = await on('GET', '/api/shifts/overview', GA, undefined, null, { 'X-GIGA-SCOPE': 'ALL' });
  const ov2 = r.data?.shops?.find((s: any) => s.shop_code === 'SHOP2');
  check(r.status === 200 && ov2?.open_shifts === 1 && ov2?.open_from_previous_day === 1 && ov2?.unreviewed_variances === 1, 'variance dashboard per shop (Shop 2: 1 open/left open, 1 unreviewed)', r.data?.shops);
  check((await on('GET', '/api/shifts', S1A, undefined, shop2)).status === 403, 'Shop 1 Admin cannot read Shop 2 shifts');
  check((await on('GET', '/api/shifts', S1A, undefined, null, { 'X-GIGA-SCOPE': 'ALL' })).status === 403, 'Shop 1 Admin cannot use All Shops');
  r = await on('GET', '/api/shifts', OCASH);
  check(r.status === 200 && r.data.rows.length >= 2 && r.data.rows.every((x: any) => x.cashier_id === cashier.id), 'online cashier: own shifts only', r.data?.rows?.length);
  check((await on('GET', `/api/shifts/${shiftB.id}`, OCASH)).status === 404, 'online cashier cannot read another cashier\'s shift');
  check((await on('GET', '/api/shifts/overview', OCASH)).status === 403, 'online cashier has no overview');
  r = await on('GET', '/api/admin/alerts', GA, undefined, shop2);
  check(r.status === 200 && r.data.alerts.some((a: any) => a.kind === 'SHIFT_NOT_CLOSED'), 'online alerts list shift alerts', r.data?.alerts?.map((a: any) => a.kind));
  // Online review = command to the shop, applied by Shop 1 (shift B was corrected, still CLOSED).
  r = await on('POST', '/api/admin/commands/shift-review', GA, { shift_id: shiftB.id, notes: 'Reviewed online after recount' }, shop1);
  check(r.status === 202, 'Global Admin queues SHIFT_REVIEW for Shop 1', r.data);
  const cmdId = r.data?.command_id;
  const fin = (await waitFor(() => on('GET', `/api/admin/commands/${cmdId}`, GA, undefined, shop1), (x) => ['APPLIED', 'REJECTED'].includes(x.data?.status))).data;
  check(fin?.status === 'APPLIED', 'Shop 1 applied the remote review', fin);
  check((await lq('SELECT status, review_notes FROM cashier_shifts WHERE id = $1', [shiftB.id]))[0]?.status === 'REVIEWED', 'local shift B now REVIEWED');
  const cloudB = await waitFor(async () => (await cq('SELECT status FROM giga_cloud.cashier_shifts WHERE shop_id = $1 AND shift_id = $2', [shop1, shiftB.id]))[0], (x) => x?.status === 'REVIEWED');
  check(cloudB?.status === 'REVIEWED', 'review synced back to the cloud');
  r = await on('POST', '/api/admin/commands/shift-review', GA, { shift_id: shiftA2.id }, shop1);
  check(r.status === 202 || r.status === 409, 'reviewing a balanced closed shift online is allowed (no notes needed)', r.data);
  r = await on('POST', '/api/admin/commands/shift-review', GA, { shift_id: s2open }, shop2);
  check(r.status === 409, 'an OPEN shift cannot be reviewed online', r.data);
  check((await on('POST', '/api/admin/commands/shift-review', OCASH, { shift_id: shiftA.id }, shop1)).status === 403, 'online cashier cannot review');

  // ------------------------------------------------------------------ REGRESSION
  section('REGRESSION');
  const pwAfter = await lq(`SELECT id, password_hash, pin_hash FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, [[admin.id, cashier.id, cashier2.id, manager.id]]);
  check(JSON.stringify(pwBefore) === JSON.stringify(pwAfter), 'TEST 42: users / passwords / PINs unaffected');
  check((await api('GET', '/api/sales?page=1&limit=5', adminToken)).status === 200, 'existing Sales list works');
}
