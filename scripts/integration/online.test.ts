import crypto from 'crypto';
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
