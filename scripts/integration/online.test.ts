import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { api, check, pool, section, startServer, stopServer, upsertFixtureMedicine } from './harness';
import { setupHybridCloud, CLOUD_TEST_DB, type HybridEnv } from './hybrid.test';
import { hashCredential } from '../../server/auth';
import type { Ctx } from './auth-users.test';

/**
 * ONLINE (Vercel) API tests.
 *  1. A real local HYBRID server syncs real activity into a fresh cloud database (same SQL as Supabase).
 *  2. The EXACT Vercel bundle (api/index.js) is served locally against that cloud database, plus the
 *     APP_MODE=online server (SPA + API, as `npm run start` would on any host).
 * The online processes get DATABASE_URL = the cloud test database only (never giga_chemist_dev).
 */
const BUNDLE_PORT = 3198;
const ONLINE_PORT = 3197;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `itest-${crypto.randomUUID()}`;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 25_000): Promise<T> {
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

const procs: ChildProcess[] = [];
async function spawnOnline(cmd: string[], port: number, env: Record<string, string>) {
  let log = '';
  const p = spawn(process.execPath, cmd, {
    env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', PORT: String(port), NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout!.on('data', (d) => (log += d));
  p.stderr!.on('data', (d) => (log += d));
  procs.push(p);
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (p.exitCode !== null) throw new Error(`online process exited: ${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status < 500 || r.status === 503) return { p, log: () => log };
    } catch {}
    await sleep(300);
  }
  throw new Error(`online process not ready: ${log}`);
}
export async function stopOnline() {
  for (const p of procs) if (p.exitCode === null) p.kill();
  procs.length = 0;
}

async function call(port: number, method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, ct, headers: res.headers, data: ct.includes('json') ? await res.json().catch(() => null) : await res.text() };
}

export async function onlineTests(ctx: Ctx, env: HybridEnv) {
  // ------------------------------------------------------------------ 1. real activity -> cloud
  section('ONLINE SETUP: shop activity synced to the cloud');
  const med = await upsertFixtureMedicine('ITEST-ONL-1', 'ZZ ITEST Online Medicine', 150, 90);
  let r = await api('POST', '/api/inventory/physical-count', ctx.adminToken, { medicine_id: med, counts: [{ batch_number: 'ONL-B1', quantity: 40, expiry_date: '2030-12-31' }] });
  const sell = (token: string, qty: number, payment: any = { method: 'Cash', amount_received: 100000 }) =>
    api('POST', '/api/sales/checkout', token, { idempotency_key: key(), items: [{ medicine_id: med, quantity: qty, unit_price: 150 }], payment });
  const s1 = await sell(ctx.cashierToken, 2);
  const s2 = await sell(ctx.cashierToken, 1, { method: 'M-Pesa', reference: 'ONLINE1234' });
  const s3 = await sell(ctx.cashier2Token, 1);
  const it = s1.data?.sale?.items?.[0];
  const rq = await api('POST', '/api/returns', ctx.cashierToken, { sale_id: s1.data?.sale?.id, medicine_id: it?.medicine_id, batch_id: it?.batch_id, quantity: 1, reason: 'ITEST online return' });
  const ap = await api('POST', `/api/returns/${rq.data?.return?.id}/approve`, ctx.adminToken, { restock: true });
  check(r.status === 200 && [s1, s2, s3].every((x) => x.status === 201) && ap.status === 200, 'local POS: count 40, 3 sales (cash, M-Pesa), 1 approved return');
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med], { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  check(boot.status === 0, 'stock/catalog baseline queued for the medicine');
  const allSynced = await waitFor(async () => Number((await pool.query(
    `SELECT COUNT(*) n FROM sync_events WHERE status <> 'SYNCED' AND (actor_user_id IN ($1, $2, $3) OR entity_id = $4)`,
    [ctx.admin.id, ctx.cashier.id, ctx.cashier2.id, med])).rows[0].n), (n) => n === 0, 40_000);
  check(allSynced === 0, 'all events SYNCED to the cloud');
  const localCashierReport = (await api('GET', '/api/reports/summary?range=today', ctx.cashierToken)).data;
  const localStock = Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [med])).rows[0].current_stock);
  await stopServer();

  // Online accounts (cloud only)
  const adminPw = `Onl-${crypto.randomBytes(9).toString('base64url')}`;
  const cashPw = `Onl-${crypto.randomBytes(9).toString('base64url')}`;
  await env.emu.pool.query('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-online-admin@itest.local', 'Online Admin', 'ADMIN', hashCredential(adminPw).combined, env.shopId]);
  await env.emu.pool.query('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, $6)', ['itest-online-cashier@itest.local', 'Online Cashier', 'CASHIER', hashCredential(cashPw).combined, env.shopId, ctx.cashier.id]);

  const onlineEnv = {
    APP_MODE: 'online', DATABASE_URL: cloudUrl(), ONLINE_ALLOW_LOCAL_DB: 'true', SHOP_ID: env.shopId,
    JWT_SECRET: crypto.randomBytes(48).toString('base64url'), ALLOWED_ORIGINS: 'https://gigachem.vercel.app', AUTH_RATE_LIMIT_PER_MINUTE: '100',
  };

  // ------------------------------------------------------------------ 2. Vercel bundle
  for (const [label, cmd, port] of [
    ['VERCEL BUNDLE (api/index.js)', ['scripts/online/serve-vercel-bundle.mjs'], BUNDLE_PORT],
    ['APP_MODE=online SERVER (server.ts)', ['--import', 'tsx', 'server.ts'], ONLINE_PORT],
  ] as const) {
    section(`ONLINE API — ${label}`);
    const proc = await spawnOnline([...cmd], port, onlineEnv);
    const c = (m: string, p: string, t?: string | null, b?: unknown, h?: Record<string, string>) => call(port, m, p, t, b, h);

    const h = await c('GET', '/api/health');
    check(h.status === 200 && h.ct.includes('json') && h.data.mode === 'online' && h.data.read_only === true, '/api/health returns JSON, mode online, read-only', h.data);
    check(h.data.database?.connected === true && h.data.database.cloud_schema && h.data.database.online_views && h.data.database.shop_registered, 'health: cloud DB connected, schemas present, shop registered', h.data.database);
    const hs = JSON.stringify(h.data);
    check(!hs.includes(onlineEnv.JWT_SECRET) && !hs.includes('postgresql://') && !hs.includes(env.token), 'health exposes no secrets / connection strings');
    const nf = await c('GET', '/api/this-does-not-exist');
    check(nf.status === 404 && nf.ct.includes('json'), 'unknown /api route -> JSON 404 (not index.html)', nf.status);

    const bad = await c('POST', '/api/auth/login', null, { email: 'itest-online-admin@itest.local', password: 'wrong-password-1' });
    check(bad.status === 401, 'wrong password -> 401');
    const noUser = await c('POST', '/api/auth/login', null, { email: ctx.admin.email, password: ctx.admin.password });
    check(noUser.status === 401, 'shop staff credentials are NOT valid online (separate accounts, no hash sync)');
    const la = await c('POST', '/api/auth/login', null, { email: 'ITEST-ONLINE-ADMIN@itest.local', password: adminPw });
    const lc = await c('POST', '/api/auth/login', null, { email: 'itest-online-cashier@itest.local', password: cashPw });
    check(la.status === 200 && la.data.user.role === 'ADMIN' && la.data.token && !('password_hash' in la.data.user), 'online Admin login (same-origin POST /api/auth/login)');
    check(lc.status === 200 && lc.data.user.role === 'CASHIER', 'online Cashier login');
    const A = la.data.token;
    const C = lc.data.token;
    const me = await c('GET', '/api/auth/me', A);
    check(me.status === 200 && me.data.user.email === 'itest-online-admin@itest.local', '/api/auth/me');
    check((await c('GET', '/api/medicines')).status === 401, 'unauthenticated data request -> 401');

    const meds = await c('GET', '/api/medicines', A);
    const m1 = Array.isArray(meds.data) ? meds.data.find((x: any) => x.id === med) : null;
    check(meds.status === 200 && m1 && m1.selling_price === 150 && m1.current_stock === localStock && m1.purchase_price === 90, `medicines from the cloud copy (stock ${m1?.current_stock} = local ${localStock})`, m1 && { s: m1.current_stock, p: m1.purchase_price });
    const medsC = await c('GET', '/api/medicines', C);
    check(medsC.status === 200 && medsC.data.every((x: any) => x.purchase_price === 0), 'Cashier sees no purchase prices online');
    const bt = await c('GET', '/api/batches', A);
    check(bt.status === 200 && bt.data.some((b: any) => b.medicine_id === med && b.batch_number === 'ONL-B1'), 'batches from the cloud copy');
    check((await c('GET', '/api/categories', A)).status === 200, 'categories endpoint');

    const sales = await c('GET', '/api/sales?page=1&limit=50', A);
    const ids = new Set((sales.data?.sales || []).map((x: any) => x.id));
    check(sales.status === 200 && [s1, s2, s3].every((x) => ids.has(x.data.sale.id)), 'synced sales listed online (server pagination)', sales.data?.total);
    const os1 = sales.data.sales.find((x: any) => x.id === s1.data.sale.id);
    check(os1?.items?.[0]?.unit_price === 150 && os1.items[0].medicine_name === 'ZZ ITEST Online Medicine' && os1.status === 'partially_returned', 'sale detail: items, historical price, status after return', os1 && { st: os1.status, it: os1.items?.[0] });
    const mp = await c('GET', '/api/sales?page=1&limit=50&paymentMethod=M-Pesa', A);
    check(mp.status === 200 && mp.data.sales.some((x: any) => x.id === s2.data.sale.id && x.payment_reference === 'ONLINE1234'), 'Sales History filter (M-Pesa) online');
    const salesC = await c('GET', '/api/sales?page=1&limit=50', C);
    check(salesC.status === 200 && salesC.data.sales.every((x: any) => x.cashier_id === ctx.cashier.id && x.cost_total === 0) && !salesC.data.sales.some((x: any) => x.id === s3.data.sale.id), 'Cashier online: only own sales, no cost');

    const repC = await c('GET', '/api/reports/summary?range=today', C);
    check(repC.status === 200 && repC.data.grossSales === localCashierReport.grossSales && repC.data.refunds === localCashierReport.refunds && repC.data.netSales === localCashierReport.netSales,
      `report from cloud = report on the shop server (cashier: gross ${repC.data?.grossSales} / ${localCashierReport.grossSales})`);
    const repA = await c('GET', '/api/reports/summary?range=month', A);
    check(repA.status === 200 && repA.data.grossSales >= repC.data.grossSales && repA.data.transactionCount >= 3, 'Admin monthly report online');
    const ts = await c('GET', '/api/sales/today-summary', A);
    check(ts.status === 200 && typeof ts.data.totalSales === 'number', 'today summary online');
    const rets = await c('GET', '/api/returns', A);
    check(rets.status === 200 && rets.data.some((x: any) => x.id === rq.data.return.id && x.status === 'APPROVED'), 'approved return visible online');
    check((await c('GET', '/api/settings')).status === 200, 'settings endpoint');
    const st = await c('GET', '/api/sync/status', A);
    check(st.status === 200 && st.data.mode === 'online' && st.data.read_only === true, 'sync status reports online read-only mode');

    for (const p of ['/api/users', '/api/suppliers', '/api/expenses', '/api/purchases']) {
      check((await c('GET', p, C)).status === 403, `Cashier online ${p} -> 403`);
    }
    check((await c('GET', '/api/users', A)).status === 200, 'Admin online /api/users -> 200');
    for (const [m, p] of [['POST', '/api/sales/checkout'], ['POST', '/api/inventory/physical-count'], ['PUT', '/api/settings'], ['PATCH', `/api/medicines/${med}/pricing`], ['POST', '/api/returns']] as const) {
      const w = await c(m, p, A, {});
      check(w.status === 409 && w.data?.code === 'ONLINE_READ_ONLY', `${m} ${p.replace(med, ':id')} -> 409 read-only (shop POS is the only writer)`);
    }
    const allowed = await c('GET', '/api/health', null, undefined, { Origin: 'https://gigachem.vercel.app' });
    const evil = await c('GET', '/api/health', null, undefined, { Origin: 'https://evil.example' });
    check(allowed.headers.get('access-control-allow-origin') === 'https://gigachem.vercel.app' && evil.headers.get('access-control-allow-origin') === null, 'CORS: only ALLOWED_ORIGINS; never "*"');
    check(!proc.log().includes(onlineEnv.JWT_SECRET) && !proc.log().includes(adminPw), 'online process log contains no secrets');

    if (port === ONLINE_PORT) {
      const spa = await c('GET', '/sales');
      check(spa.status === 200 && spa.ct.includes('text/html') && String(spa.data).includes('<div id="root"'), 'frontend route /sales -> React app (SPA fallback)');
      const apiNav = await c('GET', '/api/nope', null, undefined, { Accept: 'text/html' });
      check(apiNav.status === 404 && apiNav.ct.includes('json'), '/api/* never falls back to index.html, even for browser navigation');
    }
    await stopOnline();
  }

  await remoteAdminTests(ctx, env, { med, onlineEnv, adminPw, cashPw });

  // ------------------------------------------------------------------ 3. config refusals
  section('ONLINE API — refuses shop databases');
  const devUrl = cloudUrl().replace(`/${CLOUD_TEST_DB}`, '/giga_chemist_dev');
  for (const [label, url, allow] of [['giga_chemist_dev (even with local allowed)', devUrl, 'true'], ['localhost without ONLINE_ALLOW_LOCAL_DB', cloudUrl(), ''],
    ['giga_chemist', cloudUrl().replace(`/${CLOUD_TEST_DB}`, '/giga_chemist'), 'true']] as const) {
    await spawnOnline(['scripts/online/serve-vercel-bundle.mjs'], BUNDLE_PORT, { APP_MODE: 'online', DATABASE_URL: url, ONLINE_ALLOW_LOCAL_DB: allow, SHOP_ID: env.shopId, JWT_SECRET: 'x'.repeat(40) });
    const hh = await call(BUNDLE_PORT, 'GET', '/api/health');
    const d = await call(BUNDLE_PORT, 'GET', '/api/settings');
    check(hh.status === 200 && hh.data.database.connected === false && hh.data.database.configured === false && d.status === 503, `refused: ${label}`, hh.data.database?.error);
    await stopOnline();
  }
  const fresh = spawnSync(process.execPath, ['scripts/build-online-api.mjs', '--check'], { encoding: 'utf-8' });
  check(fresh.status === 0, 'committed api/index.js bundle is up to date with the source', fresh.stderr);
}

/**
 * Remote administration end to end: online Admin (Vercel bundle) queues commands; the real local
 * hybrid server pulls, applies them to giga_chemist_dev in its own transactions and syncs back.
 */
async function remoteAdminTests(ctx: Ctx, env: HybridEnv, o: { med: string; onlineEnv: Record<string, string>; adminPw: string; cashPw: string }) {
  section('REMOTE ADMIN — phone -> Vercel API -> cloud command -> shop PostgreSQL -> cloud');
  const { med } = o;
  await startServer(); // the shop server (hybrid, sync worker on)
  await spawnOnline(['scripts/online/serve-vercel-bundle.mjs'], BUNDLE_PORT, o.onlineEnv);
  const c = (m: string, p: string, t?: string | null, b?: unknown) => call(BUNDLE_PORT, m, p, t, b);
  const A = (await c('POST', '/api/auth/login', null, { email: 'itest-online-admin@itest.local', password: o.adminPw })).data?.token;
  const C = (await c('POST', '/api/auth/login', null, { email: 'itest-online-cashier@itest.local', password: o.cashPw })).data?.token;
  check(Boolean(A && C), 'online Admin and Cashier logged in');
  const batchId = (await pool.query(`SELECT id FROM medicine_batches WHERE medicine_id = $1 AND batch_number = 'ONL-B1'`, [med])).rows[0].id;
  const batchQty = async () => Number((await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [batchId])).rows[0].quantity_available);
  const localMed = async () => (await pool.query('SELECT current_stock, selling_price::float AS sp FROM medicines WHERE id = $1', [med])).rows[0];
  const follow = async (id: string, ms = 40_000) => {
    const seen: string[] = [];
    const last = await waitFor(async () => {
      const r = await c('GET', `/api/admin/commands/${id}`, A);
      if (r.data?.status && seen[seen.length - 1] !== r.data.status) seen.push(r.data.status);
      return r.data;
    }, (d) => d?.status === 'APPLIED' || d?.status === 'REJECTED', ms);
    return { ...last, seen };
  };
  const stockAdd = { medicine_id: med, batch_id: batchId, quantity: 7, reason: 'ITEST phone delivery' };

  // Access control and validation
  check((await c('POST', '/api/admin/commands/stock-add', null, stockAdd)).status === 401, 'unauthenticated command request -> 401');
  check((await c('POST', '/api/admin/commands/stock-add', C, stockAdd)).status === 403, 'Cashier cannot queue stock commands -> 403');
  for (const p of ['/api/admin/commands', '/api/admin/remote-status']) check((await c('GET', p, C)).status === 403, `Cashier GET ${p} -> 403`);
  const bad = await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, quantity: 0 });
  check(bad.status === 400 && /whole number/.test(bad.data?.error || ''), 'invalid quantity -> 400 with reason', bad.data);
  const shopOverride = await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, shop_id: crypto.randomUUID() });
  check(shopOverride.status === 400 && /shop_id/.test(shopOverride.data?.error || ''), 'browser cannot choose the shop (shop_id refused; server SHOP_ID used)', shopOverride.data);
  const snap = await c('POST', '/api/admin/commands/stock-set', A, { medicine_id: med, batch_id: batchId, quantity: 5, reason: 'x y z', current_stock: 5 });
  check(snap.status === 400, 'stock snapshot fields refused online too');
  check((await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, medicine_id: crypto.randomUUID() })).status === 404, 'unknown medicine -> 404');
  check((await c('POST', '/api/admin/commands/drop-tables', A, {})).status === 404, 'unknown action -> 404');

  // 1. Queue STOCK_ADD (a retried phone request queues it once)
  const rid = crypto.randomUUID();
  const q0 = await batchQty();
  const s0 = Number((await localMed()).current_stock);
  const q = await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, request_id: rid });
  const q2 = await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, request_id: rid });
  check(q.status === 202 && q.data?.status === 'PENDING' && /^[0-9a-f-]{36}$/.test(q.data?.command_id || ''), 'ADMIN queues STOCK_ADD -> 202 PENDING (not "done")', q.data);
  check(q2.status === 202 && q2.data?.command_id === q.data?.command_id && q2.data?.duplicate === true, 'retried request with the same request_id -> same command (no double queue)', q2.data);
  const cmdRow = (await env.emu.pool.query('SELECT shop_id, created_by, source, created_by_user_id FROM giga_cloud.commands WHERE command_id = $1', [q.data?.command_id])).rows[0];
  check(cmdRow?.shop_id === env.shopId && cmdRow.source === 'ONLINE_ADMIN' && /itest-online-admin@itest\.local/.test(cmdRow.created_by || ''), 'command row: server SHOP_ID, source ONLINE_ADMIN, admin identity', cmdRow);
  check(Number((await env.emu.pool.query(`SELECT COUNT(*) n FROM giga_cloud.online_audit WHERE command_id = $1 AND action = 'REMOTE_COMMAND_QUEUED'`, [q.data?.command_id])).rows[0].n) === 1, 'remote request audited in the cloud (online_audit)');
  const f1 = await follow(q.data?.command_id);
  check(f1.status === 'APPLIED' && f1.result?.delta === 7, `command APPLIED by the shop (statuses seen: ${f1.seen.join(' -> ')})`, f1);
  check((await batchQty()) === q0 + 7 && Number((await localMed()).current_stock) === s0 + 7, `local PostgreSQL stock +7 exactly once (${q0} -> ${await batchQty()})`);
  check(Number((await pool.query('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [q.data?.command_id])).rows[0].n) === 1, 'applied once (sync_inbound_commands)');
  const cloudStock = await waitFor(async () => (await c('GET', '/api/medicines', A)).data?.find((x: any) => x.id === med)?.current_stock, (v) => v === s0 + 7, 15_000);
  check(cloudStock === s0 + 7, `online medicine list shows the shop's new stock (${cloudStock})`);
  const list = await c('GET', '/api/admin/commands?limit=10', A);
  check(list.status === 200 && list.data?.commands?.some((x: any) => x.command_id === q.data?.command_id && x.status === 'APPLIED'), 'GET /api/admin/commands lists it as APPLIED');
  const rs = await c('GET', '/api/admin/remote-status', A);
  check(rs.status === 200 && rs.data?.shop_registered && rs.data.shop_in_contact === true && rs.data.commands?.applied >= 1 && rs.data.last_successful_command?.command_id,
    'remote status: shop registered + in contact, applied count, last successful command', rs.data);

  // 2. Shop offline: the command waits as PENDING, then applies once on reconnect
  await env.emu.stop();
  await sleep(1500);
  const q3 = await c('POST', '/api/admin/commands/stock-remove', A, { medicine_id: med, batch_id: batchId, quantity: 3, reason: 'Damaged' });
  check(q3.status === 202 && q3.data?.status === 'PENDING', 'command accepted while the shop is offline -> PENDING', q3.data);
  const before3 = await batchQty();
  await sleep(4000);
  check((await c('GET', `/api/admin/commands/${q3.data?.command_id}`, A)).data?.status === 'PENDING' && (await batchQty()) === before3, 'still PENDING and nothing applied while offline');
  await env.emu.restart();
  const f3 = await follow(q3.data?.command_id);
  check(f3.status === 'APPLIED' && (await batchQty()) === before3 - 3, 'after reconnect: APPLIED, stock -3 once', f3);

  // 3. Rejected command exposes a safe reason
  const q4 = await c('POST', '/api/admin/commands/stock-remove', A, { medicine_id: med, batch_id: batchId, quantity: 999_999, reason: 'Lost' });
  const f4 = await follow(q4.data?.command_id);
  check(f4.status === 'REJECTED' && /Cannot remove/.test(f4.error || '') && !/postgres|SELECT|\.ts:|at /i.test(f4.error || ''), 'over-removal REJECTED; safe error shown to the Admin', f4.error);
  check((await batchQty()) === before3 - 3, 'stock never negative / unchanged by the rejection');

  // 4. Physical count, price, expiry
  const prev5 = await batchQty();
  const f5 = await follow((await c('POST', '/api/admin/commands/stock-set', A, { medicine_id: med, batch_id: batchId, quantity: 30, reason: 'ITEST phone count' })).data?.command_id);
  check(f5.status === 'APPLIED' && (await batchQty()) === 30 && f5.result?.delta === 30 - prev5, `STOCK_SET -> 30 (delta ${f5.result?.delta})`, f5.result);
  const f6 = await follow((await c('POST', '/api/admin/commands/price-update', A, { medicine_id: med, selling_price: 175, wholesale_price: 160 })).data?.command_id);
  check(f6.status === 'APPLIED' && (await localMed()).sp === 175, 'PRICE_UPDATE from the phone applied (selling 175)', f6);
  const onlinePrice = await waitFor(async () => (await c('GET', '/api/medicines', A)).data?.find((x: any) => x.id === med)?.selling_price, (v) => v === 175, 15_000);
  check(onlinePrice === 175, 'online list shows the new price');
  const f7 = await follow((await c('POST', '/api/admin/commands/batch-expiry', A, { medicine_id: med, batch_id: batchId, expiry_date: '2032-01-31' })).data?.command_id);
  const onlineExp = await waitFor(async () => (await c('GET', '/api/batches', A)).data?.find((x: any) => x.id === batchId)?.expiry_date, (v) => String(v || '').startsWith('2032-01-31'), 15_000);
  check(f7.status === 'APPLIED' && String(onlineExp).startsWith('2032-01-31'), 'batch expiry changed from the phone and visible online', { s: f7.status, onlineExp });

  // 5. Still read-only for operations
  for (const [t, label] of [[A, 'Admin'], [C, 'Cashier']] as const) {
    const w = await c('POST', '/api/sales/checkout', t, { items: [] });
    check(w.status === 409 && w.data?.code === 'ONLINE_READ_ONLY', `${label}: online sales remain read-only (409)`);
  }
  check((await c('POST', '/api/inventory/add-stock', A, {})).status === 409, 'direct stock endpoints stay closed online (only commands)');

  // 5b. Remote operations: health, alerts, insights, staff, emergency controls
  section('REMOTE OPERATIONS — health, alerts, insights, staff, emergency controls');
  const health = await waitFor(async () => (await c('GET', '/api/admin/shop-health', A)).data, (d) => d?.online === true && d?.database === 'HEALTHY', 40_000);
  check(health?.online === true && health.database === 'HEALTHY' && health.sync === 'HEALTHY' && health.heartbeat_age_seconds < 60,
    'shop health from the heartbeat: ONLINE, PostgreSQL HEALTHY, sync HEALTHY', health && { o: health.online, db: health.database, s: health.sync, age: health.heartbeat_age_seconds });
  check(typeof health?.pending_uploads === 'number' && 'failed_events' in health && health.backup && 'uptime_seconds' in health && health.app_version,
    'diagnostics: queues, uptime, version, backup status');
  const healthText = JSON.stringify(health);
  check(!healthText.includes(env.token) && !healthText.includes(env.apiKey) && !healthText.includes(o.onlineEnv.JWT_SECRET) && !/postgres(ql)?:\/\//i.test(healthText) &&
        !healthText.includes(process.env.DB_PASSWORD || '@@none@@'), 'health response contains no secrets');
  await env.emu.pool.query(`UPDATE giga_cloud.shop_runtime_status SET reported_at = now() - interval '10 minutes' WHERE shop_id = $1`, [env.shopId]);
  const stale = (await c('GET', '/api/admin/shop-health', A)).data;
  const staleRs = (await c('GET', '/api/admin/remote-status', A)).data;
  check(stale?.online === false && staleRs?.shop_in_contact === false && staleRs.online_basis === 'heartbeat', 'heartbeat older than the threshold -> shop OFFLINE (not "web app online")', { o: stale?.online, rs: staleRs?.shop_in_contact });
  const alerts = (await c('GET', '/api/admin/alerts', A)).data;
  const offline = alerts?.alerts?.find((a: any) => a.alert_key === 'SHOP_OFFLINE' && a.status === 'ACTIVE');
  check(alerts?.supported === true && Boolean(offline) && offline.severity === 'CRITICAL', 'SHOP_OFFLINE alert raised from heartbeat age', alerts?.alerts?.map((a: any) => a.alert_key));
  const ack = await c('POST', `/api/admin/alerts/${offline?.id}/ack`, A, {});
  check(ack.status === 200 && ack.data.status === 'ACKNOWLEDGED', 'Admin acknowledges an alert');
  const back = await waitFor(async () => (await c('GET', '/api/admin/shop-health', A)).data, (d) => d?.online === true, 40_000);
  const hist = (await c('GET', '/api/admin/alerts?status=all', A)).data;
  check(back?.online === true && hist.alerts.some((a: any) => a.alert_key === 'SHOP_OFFLINE' && a.status === 'RESOLVED'), 'fresh heartbeat -> ONLINE again; offline alert RESOLVED in history');
  const ins = await c('GET', '/api/admin/insights?days=30', A);
  check(ins.status === 200 && Array.isArray(ins.data.low_stock) && Array.isArray(ins.data.reorder_suggestions) && Array.isArray(ins.data.dead_stock) &&
        /Deterministic/.test(ins.data.method) && ins.data.fast_moving.some((x: any) => x.id === med), 'inventory intelligence (deterministic, from the cloud copy)', ins.data?.method);
  for (const p of ['/api/admin/shop-health', '/api/admin/alerts', '/api/admin/insights', '/api/admin/security']) check((await c('GET', p, C)).status === 403, `Cashier GET ${p} -> 403`);
  check((await c('POST', '/api/admin/security/remote-writes', C, { enabled: false })).status === 403, 'Cashier cannot use emergency controls (403)');

  // Staff management through the phone (command -> shop). Staff profiles reach the cloud through
  // the baseline (npm run sync:bootstrap); here only the test cashier's profile is queued.
  const ub = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--users-only', '--user', ctx.cashier2.id],
    { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  const synced = await waitFor(async () => (await env.emu.pool.query('SELECT to_jsonb(u) AS j FROM giga_cloud.users u WHERE shop_id = $1 AND user_id = $2', [env.shopId, ctx.cashier2.id])).rows[0]?.j,
    (j) => Boolean(j), 30_000);
  check(ub.status === 0 && Boolean(synced) && !JSON.stringify(synced).includes('password_hash') && !JSON.stringify(synced).includes('pin_hash'),
    'staff profile baseline reaches the cloud without password / PIN hashes', ub.stderr.slice(0, 300));
  const cred = await c('POST', '/api/admin/commands/user-active', A, { user_id: ctx.cashier2.id, active: false, reason: 'ITEST x', password: 'Secret-123' });
  check(cred.status === 400 && /password/.test(cred.data?.error || ''), 'credentials are refused by the online API (never stored in command history)');
  const off = await follow((await c('POST', '/api/admin/commands/user-active', A, { user_id: ctx.cashier2.id, active: false, reason: 'ITEST phone disable' })).data?.command_id);
  check(off.status === 'APPLIED' && (await pool.query('SELECT active FROM users WHERE id = $1', [ctx.cashier2.id])).rows[0].active === false && off.display?.user_name,
    'Admin deactivates a shop cashier from the phone (APPLIED at the shop)', off);
  const on = await follow((await c('POST', '/api/admin/commands/user-active', A, { user_id: ctx.cashier2.id, active: true, reason: 'ITEST phone enable' })).data?.command_id);
  check(on.status === 'APPLIED' && (await pool.query('SELECT active FROM users WHERE id = $1', [ctx.cashier2.id])).rows[0].active === true, 'and reactivates it');
  const upd = await c('POST', '/api/admin/commands/app-update', A, { target_commit: crypto.randomBytes(20).toString('hex') });
  check(upd.status === 409, 'update approval refused unless it is the version the shop reported available', upd.data);
  const detail = (await c('GET', `/api/admin/commands/${q.data?.command_id}`, A)).data;
  check(detail?.display?.medicine_name === 'ZZ ITEST Online Medicine' && detail.display.batch_number === 'ONL-B1' && detail.audit_reference && detail.created_by && detail.delivered_at && detail.acked_at,
    'activity detail: who, when requested/delivered/applied, target medicine/batch, audit reference', detail && { d: detail.display, a: detail.audit_reference });

  // Emergency switch: block NEW remote changes immediately
  const offW = await c('POST', '/api/admin/security/remote-writes', A, { enabled: false });
  const blocked = await c('POST', '/api/admin/commands/stock-add', A, { ...stockAdd, quantity: 1 });
  check(offW.status === 200 && offW.data.remote_writes_enabled === false && blocked.status === 423, 'remote writes disabled -> new commands refused (423)', [offW.status, blocked.status]);
  const dbBlocked = await env.emu.pool.query(`SELECT * FROM giga_cloud.queue_online_command($1,'STOCK_ADD','{}'::jsonb,$2,(SELECT id FROM giga_cloud.online_users WHERE email = 'itest-online-admin@itest.local'))`,
    [env.shopId, `online:x:${crypto.randomUUID()}`]).then(() => 'queued', (e) => e.code);
  check(dbBlocked === 'PT423', 'the database itself refuses commands while disabled (not only the API)', dbBlocked);
  const onW = await c('POST', '/api/admin/security/remote-writes', A, { enabled: true });
  check(onW.data?.remote_writes_enabled === true, 'remote writes re-enabled');

  // Maintenance mode: only Administrators
  await c('POST', '/api/admin/security/maintenance', A, { enabled: true, message: 'ITEST maintenance' });
  const cm = await c('GET', '/api/medicines', C);
  const cl = await c('POST', '/api/auth/login', null, { email: 'itest-online-cashier@itest.local', password: o.cashPw });
  check(cm.status === 503 && cm.data?.code === 'MAINTENANCE' && cl.status === 503 && (await c('GET', '/api/medicines', A)).status === 200,
    'maintenance mode: Cashier blocked (session + login), Administrator still works', [cm.status, cl.status]);
  await c('POST', '/api/admin/security/maintenance', A, { enabled: false });
  check((await c('GET', '/api/medicines', C)).status === 200, 'maintenance off: Cashier back');

  // Session revocation and account deactivation (stolen phone)
  const sec = (await c('GET', '/api/admin/security', A)).data;
  const cashierAcct = sec?.online_users?.find((u: any) => u.email === 'itest-online-cashier@itest.local');
  const rv = await c('POST', '/api/admin/security/revoke-sessions', A, { user_id: cashierAcct?.id });
  check(rv.status === 200 && (await c('GET', '/api/auth/me', C)).status === 401, 'revoked session rejected (401)');
  const C2 = (await c('POST', '/api/auth/login', null, { email: 'itest-online-cashier@itest.local', password: o.cashPw })).data?.token;
  check(Boolean(C2) && (await c('GET', '/api/auth/me', C2)).status === 200, 'a new login works after revocation');
  await c('POST', `/api/admin/security/online-users/${cashierAcct?.id}/active`, A, { active: false });
  check((await c('POST', '/api/auth/login', null, { email: 'itest-online-cashier@itest.local', password: o.cashPw })).status === 401 && (await c('GET', '/api/auth/me', C2)).status === 401,
    'deactivated online account: login refused and its sessions die');
  await c('POST', `/api/admin/security/online-users/${cashierAcct?.id}/active`, A, { active: true });
  const me = (await c('GET', '/api/auth/me', A)).data;
  const lastAdmin = await c('POST', `/api/admin/security/online-users/${me?.user?.id}/active`, A, { active: false });
  check(lastAdmin.status === 409, 'the last active online Administrator cannot be deactivated', lastAdmin.data);
  const events = (await c('GET', '/api/admin/security', A)).data?.recent_events?.map((e: any) => e.action) || [];
  check(['REMOTE_WRITES_DISABLED', 'MAINTENANCE_ON', 'ONLINE_SESSIONS_REVOKED', 'ONLINE_ACCOUNT_DEACTIVATED', 'ONLINE_LOGIN'].every((a) => events.includes(a)), 'security events audited', events.slice(0, 12));

  // 6. No shop secrets reach the browser
  const bodies = JSON.stringify([q.data, f1, list.data, rs.data, (await c('GET', '/api/health')).data]);
  check(!bodies.includes(env.token) && !bodies.includes(env.apiKey), 'API responses never contain the shop sync token or cloud key');
  const leaks: string[] = [];
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|html|css|json|webmanifest)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf-8');
        for (const needle of ['SYNC_SHOP_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'service_role', env.token]) if (t.includes(needle)) leaks.push(`${p}: ${needle === env.token ? '<token>' : needle}`);
      }
    }
  };
  scan('dist');
  scan('src');
  check(leaks.length === 0, 'frontend source and built bundle contain no SYNC_SHOP_TOKEN / service-role key / DATABASE_URL', leaks);
  await stopOnline();

  // 7. Rate limit on remote changes
  await spawnOnline(['scripts/online/serve-vercel-bundle.mjs'], BUNDLE_PORT, { ...o.onlineEnv, ONLINE_COMMAND_RATE_PER_MINUTE: '4' });
  const A2 = (await c('POST', '/api/auth/login', null, { email: 'itest-online-admin@itest.local', password: o.adminPw })).data?.token;
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await c('POST', '/api/admin/commands/stock-add', A2, { ...stockAdd, quantity: 0 })).status);
  check(codes.slice(0, 4).every((x) => x === 400) && codes.slice(4).every((x) => x === 429), `remote change requests rate-limited per Admin (${codes.join(',')})`);
  await stopOnline();
  await stopServer();
}

/** Unreachable cloud database: data and login answer 503 (never a fake/local fallback). */
export async function onlineUnreachableTests(shopId: string) {
  section('ONLINE API — cloud database unreachable');
  await spawnOnline(['scripts/online/serve-vercel-bundle.mjs'], BUNDLE_PORT, {
    APP_MODE: 'online', DATABASE_URL: 'postgresql://u:p@giga-chemist-nonexistent-host.invalid:6543/postgres', SHOP_ID: shopId, JWT_SECRET: 'y'.repeat(40),
  });
  const h = await call(BUNDLE_PORT, 'GET', '/api/health');
  const l = await call(BUNDLE_PORT, 'POST', '/api/auth/login', null, { email: 'a@b.cd', password: 'whatever-123' });
  const s = await call(BUNDLE_PORT, 'GET', '/api/settings');
  check(h.status === 503 && h.data.database.connected === false, 'health 503 degraded when the cloud DB is unreachable', h.data);
  check(l.status === 503 && l.data.code === 'CLOUD_DB_UNREACHABLE' && s.status === 503, 'login / data answer 503 CLOUD_DB_UNREACHABLE', [l.status, s.status]);
  await stopOnline();
}
