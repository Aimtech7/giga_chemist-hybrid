import crypto from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { api, check, login, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import { CLOUD_TEST_DB, type HybridEnv } from './hybrid.test';
import { hashCredential } from '../../server/auth';
import { applyCloudCommand } from '../../server/sync/commands';

/**
 * FULL-WRITE GLOBAL ADMIN suite (npm run test:full-write).
 *   shop server : giga_chemist_dev, hybrid, sync worker ON, against the cloud EMULATOR (Shop 1)
 *   cloud       : giga_chemist_cloud_test (recreated per run, real cloud SQL 001-006)
 *   online API  : APP_MODE=online server.ts against the cloud test database
 *   Shop 2      : SYNTHETIC (registered + fed through the real ingestion RPC with its own token;
 *                 no shop process: its commands stay PENDING = the "shop offline" case)
 * Every write goes Global Admin -> online API -> shop-scoped command -> Shop 1 worker -> local
 * PostgreSQL transaction (+ audit + outbox) -> cloud. Nothing reaches a real cloud or a real shop.
 */
const ONLINE_PORT = 3197;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const pw = () => `Fw-${crypto.randomBytes(10).toString('base64url')}`;

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
export async function stopFullWriteOnline() {
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

export async function fullWriteTests(env: HybridEnv, admin: Fixture, cashier: Fixture) {
  const { emu, shopId: shop1 } = env;
  const cq = async (sql: string, params: any[] = []) => (await emu.pool.query(sql, params)).rows;
  const lq = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;
  const secrets: string[] = [];
  const runStart = (await pool.query('SELECT now() AS t')).rows[0].t;
  const applied: string[] = []; // command ids the shop APPLIED (audit check)

  // ------------------------------------------------------------------ setup
  section('SETUP: Shop 1 (real worker) + synthetic Shop 2 + online accounts');
  await cq('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [shop1]);
  const shop2 = crypto.randomUUID();
  const token2 = crypto.randomBytes(32).toString('base64url');
  await cq('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop2, 'SHOP2', 'GIGA CHEMIST - SHOP 2 (synthetic)', token2]);

  // Shop 1 fixtures: one medicine with one counted batch, made known to the cloud by a baseline.
  const adminToken = await login(admin.email, admin.password);
  const cashierToken = await login(cashier.email, cashier.password);
  const med = await upsertFixtureMedicine('ITEST-FW-1', 'ZZ ITEST FullWrite Medicine', 100, 60);
  // min_selling_price NULL on purpose: the all-shops fan-out must compare like the shop reads it (NULL -> selling price).
  await lq('UPDATE medicines SET wholesale_price = NULL, min_selling_price = NULL, reorder_level = 5 WHERE id = $1', [med]);
  let r: any = await api('POST', '/api/inventory/physical-count', adminToken, { medicine_id: med, counts: [{ batch_number: `FW-B1-${RUN}`, quantity: 40, expiry_date: '2031-06-30' }] });
  check(r.status === 200, 'local physical count: batch of 40', r.data);
  const batch1 = (await lq('SELECT id FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2', [med, `FW-B1-${RUN}`]))[0].id;
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med], { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  check(boot.status === 0, 'Shop 1 medicine baseline queued', boot.stderr?.slice(-300));
  const cloudBatchQty = async (id: string) => Number((await cq(
    `SELECT CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline ELSE last_reported_quantity END AS q FROM giga_cloud.stock_levels WHERE shop_id = $1 AND batch_id = $2`, [shop1, id]))[0]?.q ?? -1);
  check((await waitFor(() => cloudBatchQty(batch1), (q) => q === 40)) === 40, 'cloud copy shows the batch at 40');

  // Synthetic Shop 2: a medicine with the SAME barcode (cross-shop apply) and one Shop 2-only medicine.
  const m2 = crypto.randomUUID(), m2only = crypto.randomUUID(), b2 = crypto.randomUUID();
  const s2sale = crypto.randomUUID(), s2pur = crypto.randomUUID(), s2sup = crypto.randomUUID();
  const todayEAT = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const ev = (seq: number, type: string, data: any) => ({
    event_id: crypto.randomUUID(), idempotency_key: `itest-fw-s2-${crypto.randomUUID()}`, shop_id: shop2, local_seq: String(seq), event_type: type,
    entity_type: 'x', entity_id: 'x', payload: { data, movements: [], batches: [], audit: [] },
  });
  const ing = (await cq('SELECT public.gc_ingest_events($1, $2, $3::jsonb) AS r', [shop2, token2, JSON.stringify([
    ev(1, 'MEDICINE_BASELINE', { medicine: { id: m2, name: 'ZZ ITEST FullWrite Medicine (Shop 2)', barcode: 'ITEST-FW-1', selling_price: 110, purchase_price: 60, status: 'active', category: 'S2' },
      batches: [{ id: b2, medicine_id: m2, batch_number: 'S2-FW-B1', quantity_available: 12, status: 'active', expiry_date: '2031-01-01' }] }),
    ev(2, 'MEDICINE_BASELINE', { medicine: { id: m2only, name: 'ZZ SHOP2 ONLY', barcode: 'S2-ONLY-1', selling_price: 10, purchase_price: 5, status: 'active' }, batches: [] }),
    // History fixtures for Shop 2: one completed sale and one received purchase (business date = today, Nairobi).
    ev(3, 'SALE_COMPLETED', { sale: { id: s2sale, sale_number: `S2-HIST-${RUN}`, receipt_number: `S2-HIST-${RUN}`, date: todayEAT, time: '11:00:00', cashier_id: null, device_id: 'S2',
      subtotal: 220, discount_total: 0, tax_total: 0, total: 220, cost_total: 120, gross_profit: 100, payment_method: 'Cash', status: 'completed', idempotency_key: `s2h-${RUN}`, created_at: new Date().toISOString() },
      items: [{ id: crypto.randomUUID(), sale_id: s2sale, medicine_id: m2, batch_id: b2, batch_number: 'S2-FW-B1', quantity: 2, unit_price: 110, discount: 0, cost_price_snapshot: 60, total: 220 }],
      payments: [{ id: crypto.randomUUID(), sale_id: s2sale, method: 'Cash', amount: 220 }], cashier_name: 'ZZ S2 Cashier' }),
    ev(4, 'PURCHASE_RECEIVED', { purchase: { id: s2pur, order_number: `S2-PO-${RUN}`, invoice_number: `S2-INV-${RUN}`, supplier_id: s2sup, order_date: todayEAT, received_date: todayEAT,
      status: 'received', total_amount: 120, payment_status: 'paid' },
      items: [{ id: crypto.randomUUID(), purchase_id: s2pur, medicine_id: m2, batch_number: 'S2-FW-B2', quantity: 4, purchase_price: 30, total: 120 }],
      supplier: { id: s2sup, name: 'ZZ S2 Supplier', status: 'active' } }),
  ])]))[0].r;
  check(ing.results.every((x: any) => x.status === 'APPLIED'), 'Shop 2 data ingested with its own token', ing);

  const gaPw = pw(), s1aPw = pw(), s2aPw = pw(), mgrPw = pw(), oCashPw = pw();
  secrets.push(gaPw, s1aPw, s2aPw, mgrPw, oCashPw, admin.password, cashier.password, cashier.pin, admin.pin);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, NULL, NULL)', ['itest-fw-global@itest.local', 'ITest FW Global Admin', 'ADMIN', hashCredential(gaPw).combined]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-fw-s1admin@itest.local', 'ITest FW Shop1 Admin', 'ADMIN', hashCredential(s1aPw).combined, shop1]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-fw-s2admin@itest.local', 'ITest FW Shop2 Admin', 'ADMIN', hashCredential(s2aPw).combined, shop2]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-fw-s1mgr@itest.local', 'ITest FW Shop1 Manager', 'MANAGER', hashCredential(mgrPw).combined, shop1]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-fw-s1cash@itest.local', 'ITest FW Shop1 Cashier', 'CASHIER', hashCredential(oCashPw).combined, shop1]);
  await startOnline(shop1);
  const onLogin = async (email: string, password: string) => (await on('POST', '/api/auth/login', null, { email, password }));
  const ga = await onLogin('itest-fw-global@itest.local', gaPw);
  const GA = ga.data?.token, GA_ID = ga.data?.user?.id;
  const S1A = (await onLogin('itest-fw-s1admin@itest.local', s1aPw)).data?.token;
  const S2A = (await onLogin('itest-fw-s2admin@itest.local', s2aPw)).data?.token;
  const MGR = (await onLogin('itest-fw-s1mgr@itest.local', mgrPw)).data?.token;
  const OCASH = (await onLogin('itest-fw-s1cash@itest.local', oCashPw)).data?.token;
  check(Boolean(GA && S1A && S2A && MGR && OCASH), 'all online accounts log in');
  check((await waitFor(() => on('GET', '/api/admin/shop-health', GA, undefined, shop1), (x) => x.data?.online === true)).data?.online === true, 'Shop 1 heartbeat: ONLINE');

  // Command helpers: queue for a shop, then wait for the Shop 1 worker to apply / reject it.
  const cmd = (action: string, body: any, shop: string | null = shop1, token = GA) => on('POST', `/api/admin/commands/${action}`, token, body, shop);
  const final = async (id: string, shop = shop1) => (await waitFor(() => on('GET', `/api/admin/commands/${id}`, GA, undefined, shop), (x) => ['APPLIED', 'REJECTED'].includes(x.data?.status))).data;
  const run = async (action: string, body: any, label: string) => {
    const q = await cmd(action, body);
    if (q.status !== 202) {
      check(false, `${label}: queued`, q.data);
      return { q, f: null as any };
    }
    const f = await final(q.data.command_id);
    if (f?.status === 'APPLIED') applied.push(q.data.command_id);
    return { q, f };
  };
  const ok = (x: { q: any; f: any }) => x.q.status === 202 && x.f?.status === 'APPLIED';
  const cloudHas = (sql: string, params: any[]) => waitFor(async () => (await cq(sql, params)).length, (n) => n > 0);

  // ================================================================== AUTH
  section('AUTH / SHOP CONTEXT (tests 1-7)');
  r = await on('GET', '/api/admin/overview', GA);
  const codes = (r.data?.shops || []).map((s: any) => s.shop_code).sort().join();
  check(r.status === 200 && r.data.scope === 'GLOBAL' && codes === 'SHOP1,SHOP2', 'TEST 1: Global Admin overview covers every active shop', codes);
  r = await on('GET', '/api/admin/overview', S1A);
  check(r.status === 200 && r.data.shops.length === 1 && r.data.shops[0].shop_id === shop1, 'TEST 2: Shop Admin overview = own shop only');
  check((await cmd('price-update', { medicine_id: m2, selling_price: 1 }, shop2, S1A)).status === 403, 'TEST 2: Shop 1 Admin commanding Shop 2 -> 403');
  check((await on('GET', '/api/medicines', MGR, undefined, shop2)).status === 403, 'TEST 3: Manager selecting another shop -> 403');
  check((await on('GET', '/api/medicines', MGR)).status === 200, 'TEST 3: Manager reads own shop');
  check((await cmd('price-update', { medicine_id: med, selling_price: 1 }, null, MGR)).status === 403, 'TEST 3: Manager cannot queue remote changes (Administrator only)');
  check((await on('GET', '/api/medicines', OCASH, undefined, shop2)).status === 403, 'TEST 4: Cashier selecting another shop -> 403');
  check((await cmd('price-update', { medicine_id: med, selling_price: 1 }, null, OCASH)).status === 403, 'TEST 4: Cashier cannot queue remote changes');
  check((await cmd('stock-add', { medicine_id: med, batch_id: batch1, quantity: 1, reason: 'cross shop' }, shop2)).status === 404,
    'TEST 5: a Shop 1 record cannot be commanded while Shop 2 is selected (404, nothing queued)');
  const idsOf = (rows: any) => new Set((Array.isArray(rows) ? rows : []).map((x: any) => x.id));
  const conc = await Promise.all(Array.from({ length: 24 }, (_, i) => {
    const shop = i % 2 ? shop2 : shop1;
    return on('GET', '/api/medicines', GA, undefined, shop).then((x) => ({ shop, ids: idsOf(x.data), ok: x.status === 200 }));
  }));
  check(conc.every((x) => x.ok && (x.shop === shop1 ? x.ids.has(med) && !x.ids.has(m2only) : x.ids.has(m2only) && !x.ids.has(med))),
    'TEST 6: 24 concurrent interleaved Shop 1 / Shop 2 requests stay isolated');
  const allScope = await on('POST', '/api/admin/commands/price-update', GA, { medicine_id: med, selling_price: 1 }, shop1, { 'X-GIGA-SCOPE': 'ALL' });
  check(allScope.status === 409 && allScope.data?.code === 'ALL_SHOPS_READ_ONLY', 'All Shops view is read-only for shop-scoped writes (409 ALL_SHOPS_READ_ONLY)', allScope.data);
  const allScope2 = await on('POST', '/api/admin/accounts/shop-users', GA, { name: 'x' }, shop1, { 'X-GIGA-SCOPE': 'ALL' });
  check(allScope2.status === 409, 'All Shops view: staff changes refused too');
  check(true, 'TEST 7: shop-switch cache isolation is covered by npm run test:pos-cache (browser Dexie suite)');

  // ================================================================== MEDICINES / PRICING
  section('MEDICINES + PRICING (tests 8-12)');
  const newName = `ZZ ITEST FW Created ${RUN}`;
  const c8 = await run('medicine-create', { name: newName, barcode: `ITEST-FW-NEW-${RUN}`, selling_price: 120, purchase_price: 70, category: 'ITEST FW', reorder_level: 5, dosage_form: 'Tablet' }, 'TEST 8');
  const newMed = c8.q.data?.entity_id;
  const local8 = (await lq('SELECT name, status, current_stock, selling_price::float FROM medicines WHERE id = $1', [newMed]))[0];
  check(ok(c8) && local8?.name === newName && local8.status === 'active' && local8.current_stock === 0 && local8.selling_price === 120,
    'TEST 8: MEDICINE_CREATE applied in the shop (stock 0, server-assigned id)', { f: c8.f?.error, local8 });
  check((await cloudHas('SELECT 1 FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [shop1, newMed])) > 0, 'new medicine synced back to the cloud');
  const c9 = await run('medicine-update', { medicine_id: newMed, name: `${newName} EDITED`, dosage_strength: '500mg', expected: { name: newName } }, 'TEST 9');
  check(ok(c9) && (await lq('SELECT name FROM medicines WHERE id = $1', [newMed]))[0].name === `${newName} EDITED`, 'TEST 9: medicine edit applied (expected name matched)', c9.f?.error);
  const c9b = await run('medicine-update', { medicine_id: newMed, name: 'ZZ ITEST stale', expected: { name: 'a name nobody saw' } }, 'TEST 9b');
  check(c9b.f?.status === 'REJECTED' && /CONFLICT/.test(c9b.f.error) && c9b.f.result?.conflict?.name, 'stale medicine edit REJECTED with the conflicting field', c9b.f);
  const c10 = await run('medicine-active', { medicine_id: newMed, active: false, reason: 'ITEST discontinued' }, 'TEST 10');
  check(ok(c10) && (await lq('SELECT status FROM medicines WHERE id = $1', [newMed]))[0].status === 'inactive', 'TEST 10: deactivate = status inactive (not deleted)', c10.f?.error);
  check((await lq('SELECT COUNT(*)::int n FROM medicines WHERE id = $1', [newMed]))[0].n === 1, 'deactivated medicine still exists');

  const cloudPrice = async () => Number((await cq('SELECT selling_price FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [shop1, med]))[0]?.selling_price);
  const c11 = await run('price-update', { medicine_id: med, selling_price: 101, expected: { selling_price: await cloudPrice() } }, 'TEST 11');
  check(ok(c11) && Number((await lq('SELECT selling_price FROM medicines WHERE id = $1', [med]))[0].selling_price) === 101, 'TEST 11: price applied to ONE shop', c11.f?.error);
  check((await waitFor(cloudPrice, (p) => p === 101)) === 101, 'new price synced to the cloud copy');
  const fan = await on('POST', '/api/admin/all-shops/commands/price-update', GA,
    { source_shop_id: shop1, medicine_id: med, selling_price: 102, wholesale_price: 95, min_selling_price: 90, reason: 'ITEST all shops' });
  const res1 = fan.data?.results?.find((x: any) => x.shop_id === shop1), res2 = fan.data?.results?.find((x: any) => x.shop_id === shop2);
  check(fan.status === 202 && res1?.status === 'QUEUED' && res2?.status === 'QUEUED' && res1.command_id !== res2.command_id,
    'TEST 12: APPLY TO ALL SHOPS = one independent command per shop', fan.data);
  const shopOf = async (id: string) => (await cq('SELECT shop_id, payload FROM giga_cloud.commands WHERE command_id = $1', [id]))[0];
  const s2cmd = res2 ? await shopOf(res2.command_id) : null;
  check(s2cmd?.shop_id === shop2 && s2cmd.payload.medicine_id === m2 && Number(s2cmd.payload.expected?.selling_price) === 110
    && Number(s2cmd.payload.expected?.min_selling_price) === 110,
    'Shop 2 command names Shop 2\'s own medicine (matched by barcode) and Shop 2\'s own current price as expected', s2cmd?.payload);
  const f12 = res1 ? await final(res1.command_id) : null;
  if (f12?.status === 'APPLIED') applied.push(res1.command_id);
  const p12 = (await lq('SELECT selling_price::float s, wholesale_price::float w, min_selling_price::float m FROM medicines WHERE id = $1', [med]))[0];
  check(f12?.status === 'APPLIED' && p12.s === 102 && p12.w === 95 && p12.m === 90, 'Shop 1 applied retail 102 / wholesale 95 / minimum 90', { f12: f12?.error, p12 });
  check(res2?.warning && /offline/i.test(res2.warning) && (await shopOf(res2.command_id)) && (await on('GET', `/api/admin/commands/${res2.command_id}`, GA, undefined, shop2)).data?.status === 'PENDING',
    'TEST 45: Shop 2 is offline -> its command waits PENDING (with an offline warning)');
  check((await on('POST', '/api/admin/all-shops/commands/stock-add', GA, { medicine_id: med, quantity: 1 })).status === 400, 'stock changes can never be applied to all shops');
  check((await on('POST', '/api/admin/all-shops/commands/price-update', S1A, { source_shop_id: shop1, medicine_id: med, selling_price: 1 })).status === 403,
    'only a Global Administrator can apply to all shops');

  // ================================================================== STOCK
  section('STOCK + OPTIMISTIC CONCURRENCY (tests 13-17)');
  const qty = async (b: string) => Number((await lq('SELECT quantity_available FROM medicine_batches WHERE id = $1', [b]))[0].quantity_available);
  const c13 = await run('stock-add', { medicine_id: med, batch_id: batch1, quantity: 5, reason: 'ITEST delivery', expected_quantity: 40 }, 'TEST 13');
  check(ok(c13) && (await qty(batch1)) === 45 && c13.f.result?.previous_quantity === 40 && c13.f.result?.delta === 5, 'TEST 13: STOCK_ADD 40 -> 45 (movement recorded)', c13.f);
  const c14 = await run('stock-remove', { medicine_id: med, batch_id: batch1, quantity: 3, reason: 'Damaged', expected_quantity: 45 }, 'TEST 14');
  check(ok(c14) && (await qty(batch1)) === 42, 'TEST 14: STOCK_REMOVE 45 -> 42', c14.f?.error);
  check((await cmd('stock-set', { medicine_id: med, batch_id: batch1, quantity: 50, reason: 'ITEST count' })).status === 400, 'STOCK_SET without expected_quantity is refused (400)');
  const c15 = await run('stock-set', { medicine_id: med, batch_id: batch1, quantity: 50, reason: 'ITEST count', expected_quantity: 42 }, 'TEST 15');
  check(ok(c15) && (await qty(batch1)) === 50, 'TEST 15: STOCK_SET (physical count) 42 -> 50', c15.f?.error);
  const mv = (await lq(`SELECT movement_type, previous_quantity, new_quantity, notes FROM inventory_movements WHERE batch_id = $1 ORDER BY created_at DESC, timestamp DESC LIMIT 1`, [batch1]))[0];
  check(mv?.previous_quantity === 42 && mv.new_quantity === 50 && /Remote admin/.test(mv.notes || ''), 'movement records previous/new quantity, delta and the remote actor', mv);
  // A cashier sells while the Administrator's page still shows 50.
  const seen = 50;
  const price = async () => Number((await lq('SELECT selling_price FROM medicines WHERE id = $1', [med]))[0].selling_price);
  const sale = await api('POST', '/api/sales/checkout', cashierToken, { idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med, quantity: 2, unit_price: await price() }], payment: { method: 'Cash', amount_received: 100000 } });
  check(sale.status === 201 && (await qty(batch1)) === 48, 'TEST 51: local POS sale still works (stock 50 -> 48)');
  const c16 = await run('stock-set', { medicine_id: med, batch_id: batch1, quantity: 60, reason: 'ITEST stale count', expected_quantity: seen }, 'TEST 16');
  check(c16.f?.status === 'REJECTED' && /CONFLICT/.test(c16.f.error) && c16.f.result?.conflict?.quantity?.current === 48 && c16.f.result.conflict.quantity.expected === 50,
    'TEST 16: stale STOCK_SET REJECTED (CONFLICT: shop has 48, Admin saw 50)', c16.f);
  check((await qty(batch1)) === 48, 'TEST 17: the cashier movement is kept (no lost sale; 48 unchanged)');
  const saleMv = (await lq(`SELECT COUNT(*)::int n FROM inventory_movements WHERE batch_id = $1 AND reference_id = $2`, [batch1, sale.data?.sale?.receipt_number]))[0].n;
  check(saleMv === 1, 'TEST 17: the sale movement exists exactly once');
  const c16b = await run('stock-remove', { medicine_id: med, batch_id: batch1, quantity: 1000, reason: 'Lost' }, 'never negative');
  check(c16b.f?.status === 'REJECTED' && (await qty(batch1)) === 48, 'STOCK_REMOVE larger than the batch is REJECTED (never negative)');

  // ================================================================== BATCHES / EXPIRY
  section('BATCHES + EXPIRY (tests 18-20)');
  const c18 = await run('batch-create', { medicine_id: med, batch_number: `FW-B2-${RUN}`, expiry_date: '2032-01-31', quantity: 5, purchase_price: 30 }, 'TEST 18');
  const b2id = c18.q.data?.entity_id;
  const lb = (await lq('SELECT quantity_available, purchase_price::float pp, expiry_date FROM medicine_batches WHERE id = $1', [b2id]))[0];
  check(ok(c18) && lb?.quantity_available === 5 && lb.pp === 30, 'TEST 18: BATCH_CREATE (opening 5 as an audited movement)', { f: c18.f?.error, lb });
  check((await cloudHas('SELECT 1 FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND batch_id = $2', [shop1, b2id])) > 0, 'new batch synced to the cloud');
  check((await run('batch-create', { medicine_id: med, batch_number: `FW-B2-${RUN}`, quantity: 1 }, 'dup batch')).f?.status === 'REJECTED', 'creating an existing batch number is REJECTED');
  const c19 = await run('batch-update', { medicine_id: med, batch_id: b2id, purchase_price: 31, expected: { purchase_price: 30 } }, 'TEST 19');
  check(ok(c19) && (await lq('SELECT purchase_price::float pp FROM medicine_batches WHERE id = $1', [b2id]))[0].pp === 31, 'TEST 19: BATCH_UPDATE applied', c19.f?.error);
  const c20 = await run('batch-expiry', { medicine_id: med, batch_id: b2id, expiry_date: '2032-06-30', expected_expiry_date: '2032-01-31' }, 'TEST 20');
  check(ok(c20) && (await lq('SELECT expiry_date FROM medicine_batches WHERE id = $1', [b2id]))[0].expiry_date === '2032-06-30', 'TEST 20: expiry updated (expected expiry matched)', c20.f?.error);
  const c20b = await run('batch-active', { medicine_id: med, batch_id: b2id, active: false, reason: 'ITEST recall' }, 'batch off');
  check(ok(c20b) && (await lq('SELECT status FROM medicine_batches WHERE id = $1', [b2id]))[0].status === 'recalled', 'BATCH_SET_ACTIVE false = recalled (quantity kept, not sellable)');
  const c20c = await run('batch-active', { medicine_id: med, batch_id: b2id, active: true, reason: 'ITEST release' }, 'batch on');
  check(ok(c20c) && (await lq('SELECT status FROM medicine_batches WHERE id = $1', [b2id]))[0].status === 'active', 'BATCH_SET_ACTIVE true = active again');

  // ================================================================== SUPPLIERS / CUSTOMERS
  section('SUPPLIERS + CUSTOMERS (tests 21-25)');
  const c21 = await run('supplier-create', { name: `ZZ ITEST FW Supplier ${RUN}`, phone: '0700000001', contact_person: 'ITest' }, 'TEST 21');
  const sup = c21.q.data?.entity_id;
  check(ok(c21) && (await lq('SELECT name FROM suppliers WHERE id = $1', [sup]))[0]?.name === `ZZ ITEST FW Supplier ${RUN}`, 'TEST 21: supplier created', c21.f?.error);
  await cloudHas('SELECT 1 FROM giga_cloud.suppliers WHERE shop_id = $1 AND supplier_id = $2', [shop1, sup]);
  const c22 = await run('supplier-update', { supplier_id: sup, phone: '0700000002', expected: { phone: '0700000001' } }, 'TEST 22');
  check(ok(c22) && (await lq('SELECT phone FROM suppliers WHERE id = $1', [sup]))[0].phone === '0700000002', 'TEST 22: supplier updated (other fields kept)', c22.f?.error);
  const c23 = await run('supplier-active', { supplier_id: sup, active: false, reason: 'ITEST pause' }, 'TEST 23');
  check(ok(c23) && (await lq('SELECT status FROM suppliers WHERE id = $1', [sup]))[0].status === 'inactive', 'TEST 23: supplier deactivated (not deleted)');
  await run('supplier-active', { supplier_id: sup, active: true, reason: 'ITEST resume' }, 'supplier on');
  const reqId = crypto.randomUUID();
  const c24 = await cmd('customer-create', { name: `ZZ ITEST FW Customer ${RUN}`, phone: '0711000001', request_id: reqId });
  const c24dup = await cmd('customer-create', { name: `ZZ ITEST FW Customer ${RUN}`, phone: '0711000001', request_id: reqId });
  check(c24.status === 202 && c24dup.status === 202 && c24dup.data.duplicate === true && c24dup.data.command_id === c24.data.command_id && c24dup.data.entity_id === c24.data.entity_id,
    'TEST 43: same request id twice = ONE command, same new customer id', { a: c24.data, b: c24dup.data });
  const f24 = await final(c24.data.command_id);
  if (f24?.status === 'APPLIED') applied.push(c24.data.command_id);
  const cus = c24.data.entity_id;
  check(f24?.status === 'APPLIED' && (await lq('SELECT COUNT(*)::int n FROM customers WHERE id = $1', [cus]))[0].n === 1, 'TEST 24: customer created exactly once');
  await cloudHas('SELECT 1 FROM giga_cloud.customers WHERE shop_id = $1 AND customer_id = $2', [shop1, cus]);
  const c25 = await run('customer-update', { customer_id: cus, email: 'zz-itest@example.com', expected: { phone: '0711000001' } }, 'TEST 25');
  check(ok(c25) && (await lq('SELECT email, phone FROM customers WHERE id = $1', [cus]))[0].email === 'zz-itest@example.com', 'TEST 25: customer updated', c25.f?.error);
  const c25b = await run('customer-active', { customer_id: cus, active: false, reason: 'ITEST closed' }, 'cust off');
  check(ok(c25b) && (await lq('SELECT active FROM customers WHERE id = $1', [cus]))[0].active === false, 'customer deactivated (kept for history)');

  // ================================================================== PURCHASES
  section('PURCHASES (tests 26-29)');
  const stockBefore = Number((await lq('SELECT current_stock FROM medicines WHERE id = $1', [med]))[0].current_stock);
  const c26 = await run('purchase-create', { supplier_id: sup, invoice_number: `ITEST-INV-${RUN}`, items: [{ medicine_id: med, batch_number: `FW-P1-${RUN}`, expiry_date: '2033-01-31', quantity: 7, purchase_price: 33 }] }, 'TEST 26');
  const pur = c26.q.data?.entity_id;
  const lp = (await lq('SELECT status, order_number FROM purchases WHERE id = $1', [pur]))[0];
  check(ok(c26) && lp?.status === 'pending' && Number((await lq('SELECT current_stock FROM medicines WHERE id = $1', [med]))[0].current_stock) === stockBefore,
    'TEST 26: purchase created as PENDING (nothing in stock yet)', { f: c26.f?.error, lp });
  check((await cloudHas(`SELECT 1 FROM giga_cloud.purchases WHERE shop_id = $1 AND purchase_id = $2 AND data->>'status' = 'pending'`, [shop1, pur])) > 0, 'pending purchase mirrored in the cloud (PURCHASE_DRAFTED)');
  const c27 = await run('purchase-receive', { purchase_id: pur }, 'TEST 27');
  const after = Number((await lq('SELECT current_stock FROM medicines WHERE id = $1', [med]))[0].current_stock);
  const pb = (await lq('SELECT id, quantity_available FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2', [med, `FW-P1-${RUN}`]))[0];
  const pmv = (await lq('SELECT COUNT(*)::int n FROM inventory_movements WHERE batch_id = $1 AND reference_id = $2', [pb?.id, lp?.order_number]))[0]?.n;
  check(ok(c27) && (await lq('SELECT status FROM purchases WHERE id = $1', [pur]))[0].status === 'received', 'TEST 27: PURCHASE_RECEIVE applied (status received)', c27.f?.error);
  check(after === stockBefore + 7 && pb?.quantity_available === 7 && pmv === 1, 'TEST 28: stock +7, batch created, one movement — in the same transaction', { stockBefore, after, pb, pmv });
  check((await cloudHas(`SELECT 1 FROM giga_cloud.purchases WHERE shop_id = $1 AND purchase_id = $2 AND data->>'status' = 'received'`, [shop1, pur])) > 0, 'cloud copy shows the purchase received (draft row updated)');
  const c29a = await run('purchase-create', { supplier_id: sup, items: [{ medicine_id: med, batch_number: `FW-P2-${RUN}`, quantity: 3, purchase_price: 30 }] }, 'draft 2');
  await cloudHas('SELECT 1 FROM giga_cloud.purchases WHERE shop_id = $1 AND purchase_id = $2', [shop1, c29a.q.data?.entity_id]);
  const c29 = await run('purchase-cancel', { purchase_id: c29a.q.data?.entity_id, reason: 'ITEST ordered by mistake' }, 'TEST 29');
  check(ok(c29) && (await lq('SELECT status FROM purchases WHERE id = $1', [c29a.q.data?.entity_id]))[0].status === 'cancelled', 'TEST 29: pending purchase cancelled', c29.f?.error);
  const c29b = await run('purchase-cancel', { purchase_id: pur, reason: 'ITEST too late' }, 'cancel received');
  check(c29b.f?.status === 'REJECTED' && /already received/.test(c29b.f.error), 'a RECEIVED purchase cannot be cancelled (REJECTED)');

  // ================================================================== EXPENSES
  section('EXPENSES (tests 30-32)');
  const c30 = await run('expense-create', { category: 'Supplies', description: `ZZ ITEST FW expense ${RUN}`, amount: 123.45, payment_method: 'Cash' }, 'TEST 30');
  const exp = c30.q.data?.entity_id;
  check(ok(c30) && Number((await lq('SELECT amount FROM expenses WHERE id = $1', [exp]))[0]?.amount) === 123.45, 'TEST 30: expense recorded (no shop user: created_by_name)', c30.f?.error);
  await cloudHas('SELECT 1 FROM giga_cloud.expenses WHERE shop_id = $1 AND expense_id = $2', [shop1, exp]);
  const c31 = await run('expense-update', { expense_id: exp, amount: 150, expected: { amount: 123.45 } }, 'TEST 31');
  check(ok(c31) && Number((await lq('SELECT amount FROM expenses WHERE id = $1', [exp]))[0].amount) === 150, 'TEST 31: expense corrected', c31.f?.error);
  check((await waitFor(async () => Number((await cq('SELECT amount FROM giga_cloud.expenses WHERE shop_id = $1 AND expense_id = $2', [shop1, exp]))[0]?.amount), (a) => a === 150)) === 150,
    'edited expense mirrored in the cloud (EXPENSE_UPDATED upserts)');
  const c32 = await run('expense-void', { expense_id: exp, reason: 'ITEST duplicate entry' }, 'TEST 32');
  check(ok(c32) && (await lq('SELECT status FROM expenses WHERE id = $1', [exp]))[0].status === 'voided', 'TEST 32: expense VOIDED (kept, not deleted)', c32.f?.error);
  const rep = await api('GET', '/api/reports/summary?range=today', adminToken);
  check(rep.status === 200 && !(rep.data?.expenses || []).some((e: any) => e.id === exp), 'voided expense excluded from the shop report');
  check((await run('expense-update', { expense_id: exp, amount: 1 }, 'edit voided')).f?.status === 'REJECTED', 'a voided expense cannot be edited');
  const onlineExp = await waitFor(() => on('GET', '/api/expenses', GA, undefined, shop1), (x) => (x.data || []).some((e: any) => e.id === exp && e.status === 'voided'));
  check((onlineExp.data || []).some((e: any) => e.id === exp && e.status === 'voided'), 'online expense list shows it voided (cloud migration 006 view)');

  // ================================================================== RETURNS / SALES
  section('RETURNS + SALES (tests 33-34, sale void)');
  const sell = async () => api('POST', '/api/sales/checkout', cashierToken, { idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med, quantity: 1, unit_price: await price() }], payment: { method: 'Cash', amount_received: 100000 } });
  const sA = (await sell()).data?.sale, sB = (await sell()).data?.sale, sC = (await sell()).data?.sale;
  const lineBatch = (s: any) => s?.items?.[0]?.batch_id;
  const rA = await api('POST', '/api/returns', cashierToken, { sale_id: sA?.id, medicine_id: med, batch_id: lineBatch(sA), quantity: 1, reason: 'ITEST customer returned' });
  const rB = await api('POST', '/api/returns', cashierToken, { sale_id: sB?.id, medicine_id: med, batch_id: lineBatch(sB), quantity: 1, reason: 'ITEST customer returned' });
  const retA = rA.data?.return?.id, retB = rB.data?.return?.id;
  check(rA.status === 201 && rB.status === 201, 'cashier return requests are PENDING locally');
  await cloudHas(`SELECT 1 FROM giga_cloud.returns WHERE shop_id = $1 AND return_id = $2`, [shop1, retA]);
  await cloudHas(`SELECT 1 FROM giga_cloud.returns WHERE shop_id = $1 AND return_id = $2`, [shop1, retB]);
  await cloudHas(`SELECT 1 FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2`, [shop1, sC?.id]);
  const bq = await qty(lineBatch(sA));
  const c33 = await run('return-approve', { return_id: retA, restock: true, notes: 'ITEST ok' }, 'TEST 33');
  const la = (await lq('SELECT status, reviewed_by, reviewed_by_name FROM returns WHERE id = $1', [retA]))[0];
  check(ok(c33) && la.status === 'APPROVED' && la.reviewed_by === null && /CLOUD/.test(la.reviewed_by_name || '') && (await qty(lineBatch(sA))) === bq + 1,
    'TEST 33: return APPROVED remotely (restocked +1, refund, reviewer recorded by name)', { f: c33.f?.error, la });
  const c34 = await run('return-reject', { return_id: retB, reason: 'ITEST not eligible' }, 'TEST 34');
  check(ok(c34) && (await lq('SELECT status FROM returns WHERE id = $1', [retB]))[0].status === 'REJECTED' && (await qty(lineBatch(sA))) === bq + 1,
    'TEST 34: return REJECTED (no stock effect)', c34.f?.error);
  const qC = await qty(lineBatch(sC));
  const cv = await run('sale-void', { sale_id: sC?.id, reason: 'ITEST wrong item' }, 'SALE_VOID');
  const sv = (await lq('SELECT status, void_reason, total::float t FROM sales WHERE id = $1', [sC?.id]))[0];
  check(ok(cv) && sv.status === 'voided' && /voided remotely/.test(sv.void_reason) && (await qty(lineBatch(sC))) === qC + 1, 'SALE_VOID: sale voided, stock reversed, actor named', { f: cv.f?.error, sv });
  check(sv.t === Number(sC?.total), 'voided sale keeps its original total (receipt never rewritten)');
  check((await on('PUT', `/api/sales/${sC?.id}`, GA, { total: 1 }, shop1)).status === 409, 'raw historical sale edit refused online (409 ONLINE_READ_ONLY)');
  check((await cmd('sale-update', { sale_id: sC?.id, total: 1 })).status === 404, 'no command exists to edit a completed sale');

  // ================================================================== USERS
  section('USERS (tests 35-41)');
  const staffEmail = `itest-fw-staff-${RUN.toLowerCase()}@gigachemist.local`;
  const staffPw = pw(), staffPw2 = pw();
  secrets.push(staffPw, staffPw2);
  const waitCmd = async (q: any) => {
    const id = q.data?.command?.command_id || q.data?.shop_sessions?.command_id;
    if (!id) return null;
    const f = await final(id);
    if (f?.status === 'APPLIED') applied.push(id);
    return f;
  };
  let u = await on('POST', '/api/admin/accounts/shop-users', GA, { name: `ZZ ITest FW Staff ${RUN}`, email: staffEmail, role: 'CASHIER', password: staffPw }, shop1);
  const staffId = u.data?.account?.local_user_id;
  const f35 = await waitCmd(u);
  check(u.status === 201 && f35?.status === 'APPLIED' && (await api('POST', '/api/auth/login', null, { email: staffEmail, password: staffPw })).status === 200,
    'TEST 35: staff created online -> exists at the shop with the SAME password', { s: u.status, d: u.data, f: f35?.error });
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/active`, GA, { active: false, reason: 'ITEST leave' }, shop1);
  check((await waitCmd(u))?.status === 'APPLIED' && (await lq('SELECT active FROM users WHERE id = $1', [staffId]))[0].active === false
    && [401, 403].includes((await api('POST', '/api/auth/login', null, { email: staffEmail, password: staffPw })).status), 'TEST 36: deactivated (shop login refused)');
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/active`, GA, { active: true, reason: 'ITEST back' }, shop1);
  check((await waitCmd(u))?.status === 'APPLIED' && (await lq('SELECT active FROM users WHERE id = $1', [staffId]))[0].active === true, 'TEST 37: reactivated');
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/role`, GA, { role: 'ADMIN', reason: 'ITEST promote' }, shop1);
  check((await waitCmd(u))?.status === 'APPLIED' && (await lq('SELECT role FROM users WHERE id = $1', [staffId]))[0].role === 'ADMIN', 'TEST 38: role changed to ADMIN');
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/role`, GA, { role: 'CASHIER', reason: 'ITEST demote' }, shop1);
  await waitCmd(u);
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/password`, GA, { password: staffPw2 }, shop1);
  check((await waitCmd(u))?.status === 'APPLIED' && (await api('POST', '/api/auth/login', null, { email: staffEmail, password: staffPw2 })).status === 200
    && (await api('POST', '/api/auth/login', null, { email: staffEmail, password: staffPw })).status === 401, 'TEST 39: password reset applies at the shop (old password refused)');
  const oldToken = await login(staffEmail, staffPw2);
  check((await api('GET', '/api/auth/me', oldToken)).status === 200, 'staff shop session works before revocation');
  await sleep(1100);
  u = await on('POST', `/api/admin/accounts/shop-users/${staffId}/revoke-sessions`, GA, { reason: 'ITEST lost phone' }, shop1);
  const f40 = await waitCmd(u);
  await sleep(1100);
  check(u.status === 200 && f40?.status === 'APPLIED' && (await api('GET', '/api/auth/me', oldToken)).status === 401, 'TEST 40: session revoke signs the account out of the shop terminals', { s: u.status, f: f40?.error });
  check((await api('GET', '/api/auth/me', await login(staffEmail, staffPw2))).status === 200, 'a fresh login after revocation works');
  const lastGa = await on('POST', `/api/admin/accounts/global-admins/${GA_ID}/active`, GA, { active: false });
  check(lastGa.status === 409, 'TEST 41: the last active Global Administrator cannot be deactivated', lastGa.data);

  // ================================================================== SETTINGS
  section('SETTINGS (test 42)');
  const before42 = (await lq(`SELECT receipt_footer, low_stock_threshold FROM settings WHERE branch_id = '00000000-0000-0000-0000-000000000001'`))[0];
  await waitFor(async () => (await lq(`SELECT COUNT(*)::int n FROM sync_events WHERE event_type = 'SETTINGS_UPDATED' AND status <> 'SYNCED'`))[0].n, (n) => n === 0);
  const c42 = await run('settings', { receipt_footer: `ITEST footer ${RUN}`, low_stock_threshold: 7 }, 'TEST 42');
  const s42 = (await lq(`SELECT receipt_footer, low_stock_threshold FROM settings WHERE branch_id = '00000000-0000-0000-0000-000000000001'`))[0];
  check(ok(c42) && s42.receipt_footer === `ITEST footer ${RUN}` && s42.low_stock_threshold === 7, 'TEST 42: selected shop settings updated', c42.f?.error);
  await lq(`UPDATE settings SET receipt_footer = $1, low_stock_threshold = $2 WHERE branch_id = '00000000-0000-0000-0000-000000000001'`, [before42?.receipt_footer, before42?.low_stock_threshold]);

  // ================================================================== COMMAND ENGINE
  section('COMMAND ENGINE (tests 43-48)');
  const movesOf = async () => (await lq('SELECT COUNT(*)::int n FROM inventory_movements WHERE batch_id = $1', [batch1]))[0].n;
  const m0 = await movesOf(), q0 = await qty(batch1);
  await cq(`UPDATE giga_cloud.commands SET status = 'DELIVERED', acked_at = NULL WHERE command_id = $1`, [c13.q.data.command_id]);
  const redo = await waitFor(async () => (await cq('SELECT status, delivery_count FROM giga_cloud.commands WHERE command_id = $1', [c13.q.data.command_id]))[0], (x) => x.status === 'APPLIED');
  check(redo.status === 'APPLIED' && (await movesOf()) === m0 && (await qty(batch1)) === q0, 'TEST 44: a re-delivered STOCK_ADD is harmless (no second movement)', redo);
  check(c13.f?.status === 'APPLIED' && c16.f?.status === 'REJECTED' && Boolean(c16.f.error), 'TEST 46/47: APPLIED and REJECTED statuses with clear errors');
  const list = await on('GET', '/api/admin/commands?limit=200', GA, undefined, shop1);
  const listed = (list.data?.commands || []).find((c: any) => c.command_id === c16.q.data.command_id);
  check(listed && listed.entity === 'batch' && listed.entity_id === batch1 && listed.expected?.quantity === 50 && listed.idempotency_key && listed.shop_id === shop1,
    'command listing: shop_id, entity, idempotency key, expected value, actor, status', listed);
  const pull2 = (await cq('SELECT public.gc_pull_commands($1, $2, 100) AS r', [shop2, token2]))[0].r.commands;
  check(pull2.length > 0 && pull2.every((c: any) => c.shop_id === shop2) && !pull2.some((c: any) => applied.includes(c.command_id)),
    'TEST 48: Shop 2 credentials pull only Shop 2 commands');
  let ackErr = '';
  try {
    await cq('SELECT public.gc_ack_command($1, $2, $3, $4)', [shop2, token2, c13.q.data.command_id, 'APPLIED']);
  } catch (e: any) {
    ackErr = e.message;
  }
  check(/unknown command for this shop/.test(ackErr), 'TEST 48: Shop 2 cannot acknowledge a Shop 1 command');
  let pullErr = '';
  try {
    await cq('SELECT public.gc_pull_commands($1, $2, 10)', [shop1, token2]);
  } catch (e: any) {
    pullErr = e.message;
  }
  check(/authentication failed/.test(pullErr), 'TEST 48: Shop 2 token cannot pull Shop 1 commands');
  // A malformed command carrying a secret-named field is rejected AND the value is never stored.
  const hostile = await applyCloudCommand({ command_id: crypto.randomUUID(), shop_id: shop1, command_type: 'USER_SET_ACTIVE', idempotency_key: `itest-fw-hostile-${crypto.randomUUID()}`,
    payload: { user_id: cashier.id, active: true, reason: 'ITEST hostile', pin: '481516', password: 'Fw-not-a-real-password' }, created_by: 'ITest hostile' });
  const stored = JSON.stringify(await lq(`SELECT payload FROM sync_inbound_commands WHERE command_id = $1::uuid UNION ALL SELECT new_value FROM audit_logs WHERE entity_id = $1::text`, [hostile.command_id]));
  check(hostile.status === 'REJECTED' && !stored.includes('481516') && !stored.includes('Fw-not-a-real-password') && stored.includes('[REDACTED]'),
    'rejected command with secret-named fields: values redacted in the inbound log and audit', stored.slice(0, 300));
  const stray = await applyCloudCommand({ command_id: crypto.randomUUID(), shop_id: shop2, command_type: 'STOCK_ADD', idempotency_key: `itest-fw-stray-${crypto.randomUUID()}`,
    payload: { medicine_id: med, batch_id: batch1, quantity: 1, reason: 'stray' }, created_by: 'ITest stray' });
  check(stray.status === 'REJECTED' && /different shop/.test(stray.error || '') && (await qty(batch1)) === q0, 'TEST 48: Shop 1 refuses a command addressed to Shop 2');
  const off = await cmd('customer-create', { name: `ZZ ITEST FW Shop2 Customer ${RUN}` }, shop2);
  check(off.status === 202 && off.data.shop_online === false && Boolean(off.data.warning) && off.data.status === 'PENDING', 'TEST 45: offline shop -> PENDING with a warning', off.data);
  const hc = await cmd('purchase-receive', { supplier_id: sup, invoice_number: 'X', items: [{ medicine_id: med, batch_number: 'X1', quantity: 1, purchase_price: 1 }] }, shop2);
  check(hc.status === 404, 'records of another shop cannot be referenced (purchase lines checked against Shop 2)');

  // ================================================================== OVERVIEW
  section('GLOBAL CONTROL CENTER');
  const ov = await on('GET', '/api/admin/overview', GA);
  const o1 = ov.data?.shops?.find((x: any) => x.shop_id === shop1), o2 = ov.data?.shops?.find((x: any) => x.shop_id === shop2);
  check(o1?.online === true && o1.sales_today.count >= 3 && o1.catalogue.total >= 2 && typeof o1.stock_units === 'number' && o1.error === null, 'Shop 1 card: online, sales today, catalogue, stock', o1);
  check(o2?.online === false && o2.pending_commands >= 2 && o2.catalogue.total === 2, 'Shop 2 card: offline, pending commands, its own catalogue', o2);
  check(ov.data?.totals?.shops === 2 && ov.data.totals.shops_online === 1 && ov.data.totals.pending_commands >= o2.pending_commands, 'consolidated totals', ov.data?.totals);

  // ================================================================== HISTORY (sales + supply)
  section('HISTORY: sales + supply, shop-scoped, paginated, read only');
  const hq = (path: string, token: string, shop: string | null = shop1, extra: Record<string, string> = {}) => on('GET', `/api/history/${path}`, token, undefined, shop, extra);
  const ALLS = { 'X-GIGA-SCOPE': 'ALL' };
  const recA = sA?.receipt_number, recS2 = `S2-HIST-${RUN}`;
  const recs = (x: any) => new Set((x.data?.rows || []).map((r: any) => r.receipt_number));
  const day1 = `from=${todayEAT}&to=${todayEAT}`;
  let h: any = await hq(`sales?${day1}&page_size=100`, GA, shop1);
  check(h.status === 200 && recs(h).has(recA) && !recs(h).has(recS2) && h.data.rows.every((r: any) => r.shop_id === shop1), 'H1: Global Admin sees Shop 1 sales (only Shop 1)', h.data?.error);
  h = await hq(`sales?${day1}`, GA, shop2);
  check(h.status === 200 && recs(h).has(recS2) && !recs(h).has(recA), 'H2: Global Admin sees Shop 2 synthetic sales (only Shop 2)', h.data?.error);
  h = await hq(`sales?${day1}&page_size=100`, GA, null, ALLS);
  const shopsIn = new Set((h.data?.rows || []).map((r: any) => r.shop_code));
  check(h.status === 200 && recs(h).has(recA) && recs(h).has(recS2) && shopsIn.has('SHOP1') && shopsIn.has('SHOP2') && h.data.summary.by_shop.length === 2,
    'H3: All Shops combines both (Shop column + per-shop totals)', h.data?.summary);
  check(Math.abs(h.data.summary.net_sales - h.data.summary.by_shop.reduce((t: number, x: any) => t + x.net_sales, 0)) < 0.01, 'combined totals = sum of shop contributions');
  check((await hq(`sales?${day1}`, S1A, shop2)).status === 403, 'H4: Shop 1 Admin cannot see Shop 2 sales (403)');
  check((await hq(`sales?${day1}`, S1A, null, ALLS)).status === 403, 'H4: Shop 1 Admin cannot use All Shops (403)');
  h = await hq(`sales?${day1}`, S2A, null);
  check(h.status === 200 && recs(h).has(recS2) && !recs(h).has(recA), 'H5: Shop 2 Admin sees only Shop 2 (own shop, no header)');
  check((await hq(`sales?${day1}`, S2A, shop1)).status === 403, 'H5: Shop 2 Admin cannot see Shop 1 sales (403)');
  check((await hq(`sales?${day1}`, OCASH, null)).status === 403 && (await api('GET', '/api/history/sales', cashierToken)).status === 403,
    'cashiers get no history administration (online + local 403)');
  const mgr = await hq(`sales?${day1}`, MGR, null);
  check(mgr.status === 200 && mgr.data.rows.every((r: any) => r.gross_profit === undefined) && mgr.data.summary.gross_profit === undefined, 'Manager: own shop, no cost / profit');

  // Large local history (giga_chemist_dev holds the real ~135k-sale dataset)
  const p1 = await api('GET', '/api/history/sales?page_size=25', adminToken);
  const p2 = await api('GET', '/api/history/sales?page_size=25&page=2', adminToken);
  const ids1 = new Set((p1.data?.rows || []).map((r: any) => r.id));
  check(p1.status === 200 && p1.data.total > 25 && p1.data.rows.length === 25 && p2.data.rows.length === 25 && !p2.data.rows.some((r: any) => ids1.has(r.id)),
    `H6: pagination over ${p1.data?.total} local sales (pages disjoint)`);
  const big = await api('GET', '/api/history/sales?page_size=100000', adminToken);
  check(big.status === 200 && big.data.rows.length === 25 && big.data.page_size === 25, 'H21: an oversized page_size is clamped (25/50/100 only); never the whole history');
  check((await api('GET', '/api/history/sales?from=2099-01-01&to=2099-01-31', adminToken)).data?.total === 0
    && (await api('GET', `/api/history/sales?${day1}`, adminToken)).data?.rows.some((r: any) => r.receipt_number === recA), 'H7: date filter');
  h = await hq(`sales?receipt=${encodeURIComponent(recA)}`, GA, shop1);
  check(h.status === 200 && h.data.total === 1 && h.data.rows[0].receipt_number === recA, 'H8: receipt search finds exactly one sale');
  h = await api('GET', `/api/history/sales?${day1}&cashier=${cashier.id}&page_size=100`, adminToken);
  check(h.status === 200 && h.data.total >= 4 && h.data.rows.every((r: any) => r.cashier_id === cashier.id), 'H9: cashier filter', h.data?.total);
  h = await hq(`sales?${day1}&medicine=${encodeURIComponent('ZZ ITEST FullWrite')}`, GA, shop1);
  check(h.status === 200 && recs(h).has(recA), 'H10: medicine search');
  h = await hq(`sales?${day1}&payment_method=Cash&status=voided`, GA, shop1);
  check(h.status === 200 && h.data.rows.length >= 1 && h.data.rows.every((r: any) => r.status === 'voided' && r.payment_method === 'Cash'), 'payment + status filters (voided sale found)');
  const det = await hq(`sales/${sA?.id}`, GA, shop1);
  check(det.status === 200 && det.data.items.length === 1 && det.data.payments.length >= 1 && det.data.returns.length === 1 && det.data.items[0].cost_price_snapshot !== undefined
    && det.data.audit.length >= 1, 'sale detail: items, payments, its return, audit, cost for the Administrator', { i: det.data?.items?.length, r: det.data?.returns?.length, a: det.data?.audit?.length });
  check((await hq(`sales/${s2sale}`, GA, shop1)).status === 404, 'a Shop 2 sale id is not found under Shop 1 (no cross-shop detail)');

  // Supply history
  const orders = (x: any) => new Set((x.data?.rows || []).map((r: any) => r.order_number));
  h = await hq(`supplies?${day1}&status=received`, GA, shop1);
  check(h.status === 200 && orders(h).has(lp?.order_number) && !orders(h).has(`S2-PO-${RUN}`), 'H11: Global Admin sees Shop 1 supply history', h.data?.error);
  h = await hq(`supplies?${day1}`, GA, shop2);
  check(h.status === 200 && orders(h).has(`S2-PO-${RUN}`) && !orders(h).has(lp?.order_number), 'H12: Global Admin sees Shop 2 synthetic supplies');
  h = await hq(`supplies?${day1}`, GA, null, ALLS);
  check(h.status === 200 && orders(h).has(lp?.order_number) && orders(h).has(`S2-PO-${RUN}`) && h.data.summary.by_shop.length === 2, 'All Shops supply history combines both');
  check((await hq('supplies', S1A, shop2)).status === 403 && !orders(await hq(`supplies?${day1}`, S2A, null)).has(lp?.order_number), 'H13: supply history is shop-isolated');
  h = await hq(`supplies?supplier=${sup}`, GA, shop1);
  check(h.status === 200 && h.data.rows.length >= 1 && h.data.rows.every((r: any) => r.supplier_id === sup), 'H14: supplier filter');
  h = await hq(`supplies?invoice=${encodeURIComponent(`ITEST-INV-${RUN}`)}`, GA, shop1);
  check(h.status === 200 && h.data.total === 1 && h.data.rows[0].id === pur, 'H15: invoice search');
  h = await hq(`supplies?medicine=${encodeURIComponent('ZZ ITEST FullWrite')}&status=received&${day1}`, GA, shop1);
  check(h.status === 200 && orders(h).has(lp?.order_number), 'H16: medicine filter on supplies');
  const sd = await hq(`supplies/${pur}`, GA, shop1);
  const line = sd.data?.items?.[0];
  check(sd.status === 200 && sd.data.items.length === 1 && line.batch_number === `FW-P1-${RUN}` && line.quantity === 7 && line.purchase_price === 33 && line.expiry_date?.startsWith('2033-01-31')
    && sd.data.movements.length >= 1 && sd.data.purchase.supplier_name === `ZZ ITEST FW Supplier ${RUN}`, 'H17: purchase detail: lines, batch, expiry, buy price, supplier, stock movements', sd.data);
  const lsd = await api('GET', `/api/history/supplies/${pur}`, adminToken);
  check(lsd.status === 200 && lsd.data.items.length === 1 && lsd.data.movements.length === 1, 'same purchase detail on the shop server (local history)');

  // Immutability + reprint
  check((await api('PUT', `/api/sales/${sA?.id}`, adminToken, { total: 1 })).status === 405 && (await on('PUT', `/api/sales/${sA?.id}`, GA, { total: 1 }, shop1)).status === 409
    && (await api('PATCH', `/api/history/sales/${sA?.id}`, adminToken, { total: 1 })).status === 405, 'H18: a completed sale cannot be raw-edited (local 405, online 409, history 405)');
  check((await api('DELETE', `/api/purchases/${pur}`, adminToken)).status === 405 && (await on('DELETE', `/api/purchases/${pur}`, GA, undefined, shop1)).status === 409
    && (await lq('SELECT COUNT(*)::int n FROM purchases WHERE id = $1', [pur]))[0].n === 1, 'H19: a received purchase cannot be raw-deleted');
  const salesBefore = (await lq('SELECT COUNT(*)::int n FROM sales'))[0].n;
  const rp = await api('POST', `/api/history/sales/${sA?.id}/reprint`, adminToken, {});
  const rpo = await on('POST', `/api/history/sales/${sA?.id}/reprint`, GA, {}, shop1);
  const rpAudit = (await lq(`SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'RECEIPT_REPRINTED' AND entity_id = $1`, [sA?.id]))[0].n;
  check(rp.status === 200 && rp.data.reprint?.copy === true && rpo.status === 200 && (await lq('SELECT COUNT(*)::int n FROM sales'))[0].n === salesBefore && rpAudit >= 1,
    'H20: receipt reprint (local + online) marks a COPY, is audited, creates no sale');

  // Concurrency
  const hcc = await Promise.all(Array.from({ length: 20 }, (_, i) => {
    const shop = i % 2 ? shop2 : shop1;
    return hq(`sales?${day1}&page_size=100`, GA, shop).then((x) => ({ shop, r: recs(x), ok: x.status === 200 }));
  }));
  check(hcc.every((x) => x.ok && (x.shop === shop1 ? x.r.has(recA) && !x.r.has(recS2) : x.r.has(recS2) && !x.r.has(recA))), 'H22: 20 concurrent Shop 1 / Shop 2 history requests never mix');
  const csv = await fetch(`http://127.0.0.1:${ONLINE_PORT}/api/history/export/sales?${day1}`, { headers: { Authorization: `Bearer ${GA}`, 'X-GIGA-SHOP-ID': shop1 } });
  const csvText = await csv.text();
  check(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && csvText.includes(recA) && !csvText.includes(recS2)
    && !secrets.some((x) => x && csvText.includes(x)), 'CSV export uses the filters and the shop scope (no secrets)');

  // ================================================================== EXACT SALE DETAIL
  section('EXACT SALE DETAIL: stored values, items, payments, returns, void');
  const med2 = await upsertFixtureMedicine('ITEST-FW-2', 'ZZ ITEST FullWrite Second', 50, 20);
  await lq('UPDATE medicines SET wholesale_price = 40, min_selling_price = NULL WHERE id = $1', [med2]);
  r = await api('POST', '/api/inventory/physical-count', adminToken, { medicine_id: med2, counts: [{ batch_number: `FW2-B1-${RUN}`, quantity: 100, expiry_date: '2031-01-01' }] });
  check(r.status === 200, 'second medicine stocked (100)', r.data);
  // Like every real medicine, the fixture must exist in the cloud copy (the online search reads it there).
  const boot2 = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med2], { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  check(boot2.status === 0 && (await cloudHas('SELECT 1 FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2', [shop1, med2])) > 0, 'second medicine baseline synced to the cloud');
  const buyer = await api('POST', '/api/customers', cashierToken, { name: `ZZ ITEST FW Buyer ${RUN}`, phone: '0722000001' });
  const buyerId = buyer.data?.customer?.id;
  const pRetail = await price();
  const ck = (body: any) => api('POST', '/api/sales/checkout', cashierToken, { idempotency_key: `itest-${crypto.randomUUID()}`, ...body });
  const multi = (await ck({ items: [{ medicine_id: med, quantity: 2, unit_price: pRetail }, { medicine_id: med2, quantity: 3, unit_price: 50 }], discount_percent: 10, customer_id: buyerId,
    payment: { method: 'Cash', amount_received: 1000 } })).data?.sale;
  const ws = (await ck({ price_mode: 'WHOLESALE', items: [{ medicine_id: med2, quantity: 4, unit_price: 40, price_mode: 'WHOLESALE' }], payment: { method: 'M-Pesa', reference: 'QWE123RTY9' } })).data?.sale;
  const mix = (await ck({ items: [{ medicine_id: med2, quantity: 2, unit_price: 50 }], payment: { method: 'Mixed', split: [{ method: 'Cash', amount: 60 }, { method: 'M-Pesa', amount: 40, reference: 'ABC123XYZ9' }] } })).data?.sale;
  check(Boolean(multi?.id && ws?.id && mix?.id), 'multi-item / wholesale / split-payment sales recorded locally', { multi: !!multi, ws: !!ws, mix: !!mix });
  const med2Line = multi?.items?.find((i: any) => i.medicine_id === med2);
  const pend = await api('POST', '/api/returns', cashierToken, { sale_id: multi?.id, medicine_id: med2, batch_id: med2Line?.batch_id, quantity: 1, reason: 'ITEST pending return' });
  check(pend.status === 201, 'pending return requested on the multi-item sale');
  for (const s of [multi, ws, mix]) await cloudHas('SELECT 1 FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2', [shop1, s?.id]);
  await cloudHas('SELECT 1 FROM giga_cloud.returns WHERE shop_id = $1 AND return_id = $2', [shop1, pend.data?.return?.id]);

  // Snapshot: viewing history must change NOTHING.
  const snap = async () => JSON.stringify((await lq(`SELECT (SELECT COUNT(*) FROM sales) s, (SELECT COUNT(*) FROM sale_items) i, (SELECT COUNT(*) FROM payments) p,
    (SELECT COUNT(*) FROM returns) r, (SELECT COUNT(*) FROM inventory_movements) m, (SELECT COUNT(*) FROM users) u,
    (SELECT COALESCE(SUM(quantity_available), 0) FROM medicine_batches) q, (SELECT COALESCE(SUM(total), 0) FROM sales) t`))[0]);
  const before = await snap();
  const D = async (id: string, token = GA, shop: string | null = shop1, extra: Record<string, string> = {}) => (await on('GET', `/api/history/sales/${id}?shop_id=${shop || ''}`, token, undefined, shop, extra));
  const dm = (await D(multi.id)).data, dws = (await D(ws.id)).data, dmix = (await D(mix.id)).data;
  const dA = (await D(sA.id)).data, dB = (await D(sB.id)).data, dC = (await D(sC.id)).data;
  const near = (a: number, b: number) => Math.abs(Number(a) - Number(b)) < 0.011;
  check(dA?.items?.length === 1 && dA.items[0].medicine_name === 'ZZ ITEST FullWrite Medicine' && dA.items[0].quantity === 1, 'E1: one-item sale shows the exact medicine and quantity');
  const iMed = dm?.items?.find((i: any) => i.medicine_id === med), iMed2 = dm?.items?.find((i: any) => i.medicine_id === med2);
  check(dm?.items?.length === 2 && Boolean(iMed && iMed2), 'E2: multi-item sale shows every item');
  check(iMed?.quantity === 2 && iMed2?.quantity === 3 && dm.quantities.total_units === 5 && dm.quantities.different_medicines === 2, 'E3: exact quantities (2 + 3 = 5 units, 2 medicines)', dm?.quantities);
  // Today's price changes; the history keeps the price charged then (local and cloud detail).
  await lq('UPDATE medicines SET selling_price = 777 WHERE id = $1', [med2]);
  const local = (await api('GET', `/api/history/sales/${multi.id}`, adminToken)).data;
  await lq('UPDATE medicines SET selling_price = 50 WHERE id = $1', [med2]);
  check(iMed2?.unit_price === 50 && local?.items?.find((i: any) => i.medicine_id === med2)?.unit_price === 50 && iMed?.unit_price === pRetail,
    'E4: historical unit price shown (50 stored), not today\'s price (777)');
  check(dm.sale.price_mode === 'RETAIL' && dm.items.every((i: any) => i.price_mode === 'RETAIL'), 'E5: retail sale identified');
  check(dws?.sale?.price_mode === 'WHOLESALE' && dws.items[0].price_mode === 'WHOLESALE' && dws.items[0].unit_price === 40, 'E6: wholesale sale identified (wholesale unit price 40)', dws?.sale);
  const sub = 2 * pRetail + 3 * 50;
  check(Number(dm.sale.discount_percent) === 10 && near(dm.sale.discount_total, sub * 0.1), 'E7: sale-level discount: 10% and the stored amount', { pct: dm.sale.discount_percent, d: dm.sale.discount_total });
  check(dm.items.every((i: any) => Number(i.discount) > 0) && near(dm.items.reduce((t: number, i: any) => t + Number(i.discount), 0), dm.sale.discount_total), 'E8: line discounts shown and add up to the sale discount');
  check(dm.items.every((i: any) => near(i.total, i.quantity * i.unit_price - i.discount)), 'E9: line totals = qty x unit price - line discount');
  check(near(dm.sale.subtotal, sub), 'E10: subtotal exact', dm.sale.subtotal);
  check(near(dm.sale.total, Number(dm.sale.subtotal) - Number(dm.sale.discount_total) + Number(dm.sale.tax_total || 0)), 'E11: final total exact', dm.sale.total);
  check(dm.payments.length === 1 && dm.payments[0].method === 'Cash' && near(dm.payments[0].amount, dm.sale.total) && dm.sale.amount_received === 1000 && near(dm.sale.change_given, 1000 - dm.sale.total),
    'E12: cash payment, amount received and change', { p: dm.payments, rec: dm.sale.amount_received, ch: dm.sale.change_given });
  check(dws.sale.payment_method === 'M-Pesa' && (dws.sale.payment_reference === 'QWE123RTY9' || dws.payments.some((p: any) => p.reference === 'QWE123RTY9')), 'E13: M-Pesa payment and its reference', { s: dws.sale, p: dws.payments });
  check(dmix?.payments?.length === 2 && dmix.payments.some((p: any) => p.method === 'Cash' && p.amount === 60) && dmix.payments.some((p: any) => p.method === 'M-Pesa' && p.reference === 'ABC123XYZ9')
    && near(dmix.total_paid, dmix.sale.total), 'E14: split payment shows each part (Cash 60 + M-Pesa 40 ref ABC123XYZ9)', dmix?.payments);
  check(dm.sale.customer_name === `ZZ ITEST FW Buyer ${RUN}` && dm.sale.customer_phone === '0722000001' && dm.sale.walk_in === false, 'E15: customer shown (name + phone)');
  check(dA.sale.walk_in === true && dA.sale.customer_name === null, 'E16: walk-in handled (no invented customer)');
  check(dm.sale.cashier_name === 'ITest FW Cashier', 'E17: cashier shown', dm.sale.cashier_name);
  check(iMed?.batch_number === `FW-B1-${RUN}` && iMed2?.batch_number === `FW2-B1-${RUN}`, 'E18: batch numbers shown', dm.items.map((i: any) => i.batch_number));
  check(dm.returns.some((x: any) => x.status === 'PENDING' && x.quantity === 1 && x.original_quantity === 3) && iMed2.pending_return_quantity === 1 && iMed2.net_quantity === 3,
    'E19: pending return displayed (sold 3, 1 pending, net still 3)', { r: dm.returns, i: iMed2 });
  check(dA.returns.some((x: any) => x.status === 'APPROVED' && x.approved_quantity === 1 && x.reviewed_by) && dA.items[0].returned_quantity === 1 && dA.items[0].net_quantity === 0,
    'E20: approved return displayed (returned 1, net 0, reviewer)', { r: dA.returns, i: dA.items[0] });
  check(dB.returns.some((x: any) => x.status === 'REJECTED' && x.reviewed_at) && dB.items[0].returned_quantity === 0 && dB.items[0].net_quantity === 1, 'E21: rejected return displayed (no quantity effect)');
  check(dC.void && dC.items.length === 1 && dC.items[0].quantity === 1 && near(dC.sale.total, sC.total), 'E22: voided sale still shows the original transaction');
  check(/ITEST wrong item/.test(dC.void?.reason || '') && Boolean(dC.void?.voided_by), 'E23: void reason (and who) displayed', dC.void);
  const salesN = (await lq('SELECT COUNT(*)::int n FROM sales'))[0].n;
  const rp2 = await on('POST', `/api/history/sales/${multi.id}/reprint?shop_id=${shop1}`, GA, {}, shop1);
  check(rp2.status === 200 && rp2.data.reprint.copy && near(rp2.data.sale.total, dm.sale.total) && (await lq('SELECT COUNT(*)::int n FROM sales'))[0].n === salesN, 'E24: reprint uses the stored sale and creates nothing');
  check((await D(s2sale, S1A, shop1)).status === 404 && (await on('GET', `/api/history/sales/${s2sale}?shop_id=${shop2}`, S1A, undefined, shop1)).status === 403
    && (await D(multi.id, S2A, null)).status === 404, 'E25: a Shop 1 user cannot open Shop 2 detail (and vice versa)');
  const g2 = await on('GET', `/api/history/sales/${s2sale}?shop_id=${shop2}`, GA, undefined, null, ALLS);
  const gWrong = await on('GET', `/api/history/sales/${s2sale}?shop_id=${shop1}`, GA, undefined, null, ALLS);
  check(g2.status === 200 && g2.data.sale.shop_code === 'SHOP2' && g2.data.items[0].unit_price === 110 && (await D(multi.id, GA, shop1)).status === 200 && gWrong.status === 404,
    'E26: Global Admin opens either shop\'s sale, always from its own shop (wrong shop -> 404)');
  h = await hq(`sales?${day1}&medicine=${encodeURIComponent('ZZ ITEST FullWrite Second')}&page_size=100`, GA, shop1);
  const mrec = recs(h);
  check(mrec.has(multi.receipt_number) && mrec.has(ws.receipt_number) && mrec.has(mix.receipt_number) && !mrec.has(recA), 'E27: medicine search returns exactly the receipts containing it');
  h = await hq(`sales?q=${encodeURIComponent(multi.receipt_number)}`, GA, shop1);
  check(h.data?.total === 1 && h.data.rows[0].id === multi.id && h.data.rows[0].item_count === 2 && h.data.rows[0].units === 5, 'E28: receipt search (row shows items 2, units 5)');
  h = await hq(`sales?${day1}&page_size=100`, GA, shop1);
  check(h.data.rows.length <= 100 && h.data.rows.every((x: any) => x.items === undefined) && h.data.summary.units_sold >= 5 && h.data.summary.cost_of_goods !== undefined,
    'E29: list stays lightweight + paginated (no item arrays); summary has units sold and cost of goods');
  const md = (await D(multi.id, MGR, null)).data;
  check(md?.items?.length === 2 && md.items.every((i: any) => i.cost_price_snapshot === undefined && i.profit === undefined) && md.sale.gross_profit === undefined && md.sale.cost_total === undefined
    && (await hq(`sales?${day1}`, MGR, null)).data.summary.cost_of_goods === undefined && dm.items[0].cost_price_snapshot !== undefined,
    'E30: cost / profit hidden from a Manager, shown to the Administrator');
  check((await snap()) === before, 'viewing sales history changed nothing (sales, items, payments, returns, movements, users, stock, totals)');
  h = await hq(`sales?${day1}&payment_method=Mixed`, GA, shop1);
  check(recs(h).has(mix.receipt_number) && (await hq(`sales?${day1}&payment_method=M-Pesa`, GA, shop1)).data.rows.some((x: any) => x.id === mix.id),
    'payment filter: Mixed, and M-Pesa also finds the split sale');
  h = await hq(`sales?${day1}&price_mode=WHOLESALE`, GA, shop1);
  check(h.data.rows.length >= 1 && h.data.rows.every((x: any) => x.price_mode === 'WHOLESALE') && recs(h).has(ws.receipt_number), 'price-mode filter (wholesale)');

  // ================================================================== MEDICINES CATALOGUE (online)
  section('MEDICINES: full catalogue per shop, offline browsing, All Shops comparison');
  const c1 = await on('GET', '/api/medicines', GA, undefined, shop1), c2 = await on('GET', '/api/medicines', GA, undefined, shop2);
  const ids1m = new Set((c1.data || []).map((m: any) => m.id)), ids2m = new Set((c2.data || []).map((m: any) => m.id));
  check(c1.status === 200 && c2.status === 200 && ![...ids2m].some((id) => ids1m.has(id)) && ids2m.has(m2) && !ids1m.has(m2), 'M21: Shop 1 and Shop 2 catalogues never mix');
  check(c2.data.length === 2 && (await on('GET', '/api/batches', GA, undefined, shop2)).data.some((b: any) => b.id === b2)
    && (await on('GET', '/api/admin/shop-health', GA, undefined, shop2)).data?.online === false, 'M22: Shop 2 is offline and its catalogue + batches still load from the cloud copy');
  check((c1.data || []).some((m: any) => m.current_stock <= 0) && (c1.data || []).some((m: any) => m.status !== 'active'), 'zero-stock and inactive medicines are delivered to the Admin (not hidden)');
  const cmp = await on('GET', '/api/admin/stock-comparison', GA, undefined, null, ALLS);
  const twin = cmp.data?.rows?.find((x: any) => x.barcode === 'ITEST-FW-1');
  check(cmp.status === 200 && twin && twin.per_shop[shop1] && twin.per_shop[shop2]?.stock === 12 && twin.per_shop[shop1].medicine_id === med
    && twin.combined === twin.per_shop[shop1].stock + 12, 'All Shops comparison: same medicine (barcode) per shop side by side, separate combined column', twin);
  check(cmp.data?.rows?.some((x: any) => x.per_shop[shop2] && !x.per_shop[shop1]) , 'a Shop 2-only medicine appears only under Shop 2');
  check((await on('GET', '/api/admin/stock-comparison', S1A, undefined, null)).status === 403, 'comparison is Global Administrator only');

  // ================================================================== AUDIT
  section('AUDIT (tests 49-50)');
  const auditRows = await lq(`SELECT entity_id FROM audit_logs WHERE action = 'CLOUD_COMMAND_APPLIED' AND entity_id = ANY($1::text[])`, [applied]);
  const audited = new Set(auditRows.map((x: any) => x.entity_id));
  check(applied.length >= 30 && applied.every((id) => audited.has(id)), `TEST 49: every applied command (${applied.length}) has a shop audit row`, applied.filter((id) => !audited.has(id)));
  const bizAudit = await lq(`SELECT COUNT(*)::int n FROM audit_logs WHERE new_value->>'command_id' = ANY($1::text[])`, [applied]);
  check(bizAudit[0].n >= 15, 'business audit rows carry the command id', bizAudit[0].n);
  const queued = await cq(`SELECT COUNT(DISTINCT command_id)::int n FROM giga_cloud.online_audit WHERE action = 'REMOTE_COMMAND_QUEUED' AND command_id = ANY($1::uuid[])`, [applied]);
  check(queued[0].n === applied.length, 'every command also audited in the cloud when queued (actor, shop)');
  const blobs = [
    JSON.stringify(await lq(`SELECT previous_value, new_value FROM audit_logs WHERE created_at >= $1`, [runStart])),
    JSON.stringify(await cq('SELECT payload, display, result, error FROM giga_cloud.commands')),
    JSON.stringify(await cq('SELECT details FROM giga_cloud.online_audit')),
    JSON.stringify(await cq('SELECT payload FROM giga_cloud.processed_events')),
    onlineLog,
  ];
  const leaked = blobs.some((b) => secrets.some((x) => x && b.includes(x)));
  const keyRe = /.{0,80}"(password|password_hash|pin|pin_hash|jwt|jwt_secret|sync_shop_token|token)"\s*:(?!\s*"\[REDACTED\]").{0,40}/i; // redacted placeholders are the fix, not a leak
  const keyHits = ['audit_logs', 'commands', 'online_audit', 'processed_events'].map((name, i) => ({ name, hit: blobs[i].match(keyRe)?.[0] || null })).filter((x) => x.hit);
  check(!leaked && keyHits.length === 0, 'TEST 50: no password / hash / PIN / token in audit, commands, events or logs', { leaked, keyHits });

  // Leave nothing pending for a real cloud: wait until every test outbox event reached the TEST cloud.
  const pending = await waitFor(async () => (await lq(`SELECT COUNT(*)::int n FROM sync_events WHERE status <> 'SYNCED'`))[0].n, (n) => n === 0, 60_000);
  check(pending === 0, 'all outbox events produced by the suite synced to the test cloud');
}
