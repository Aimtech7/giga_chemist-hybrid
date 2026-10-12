import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { api, check, login, loginNoShift, pool, section, upsertFixtureMedicine, upsertFixtureUser, type Fixture } from './harness';
import { CLOUD_TEST_DB, type HybridEnv } from './hybrid.test';
import { hashCredential } from '../../server/auth';

/**
 * UNIFIED AUTHENTICATION + MULTI-SHOP suite (npm run test:unified-auth).
 *   shop server  : giga_chemist_dev in hybrid mode, sync worker ON, against the cloud EMULATOR
 *   cloud        : giga_chemist_cloud_test (recreated per run, real cloud SQL 001-005)
 *   online API   : APP_MODE=online server.ts against the cloud test database
 * SHOP1 = the dev database's shop identity. SHOP2 = a synthetic second shop fed through the real
 * gc_ingest_events / gc_sync_user_credentials RPCs with its own token. Nothing reaches a real cloud.
 * Passwords are random per run and never printed; secret checks compare in memory only.
 */
const ONLINE_PORT = 3196;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pw = () => `Ua-${crypto.randomBytes(10).toString('base64url')}`;
// Accounts created by the suite are unique per run (the dev database keeps earlier runs' users, deactivated).
const RUN = crypto.randomBytes(3).toString('hex');
const LOCAL_EMAIL = `itest-ua-local-${RUN}@gigachemist.local`;
const REMOTE_EMAIL = `itest-ua-remote-${RUN}@gigachemist.local`;
const CONFLICT_EMAIL = `itest-ua-conflict-${RUN}@gigachemist.local`;
const LOCKED_EMAIL = `itest-ua-locked-${RUN}@gigachemist.local`;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
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
export async function stopUnifiedOnline() {
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
async function on(method: string, p: string, token?: string | null, body?: unknown, shop?: string | null) {
  const h: Record<string, string> = {};
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
const onLogin = (email: string, password: string) => on('POST', '/api/auth/login', null, { email, password });

export async function unifiedAuthTests(env: HybridEnv, admin: Fixture, cashier: Fixture) {
  const { emu, shopId: shop1 } = env;
  const cq = async (sql: string, params: any[] = []) => (await emu.pool.query(sql, params)).rows;
  const secrets: string[] = []; // plaintext passwords + hashes used in this run (checked for leaks, never printed)
  const noSecret = (text: string) => !secrets.some((s) => s && text.includes(s));

  // ------------------------------------------------------------------ setup: shops, accounts, data
  section('SETUP: two shops in the cloud, unified login enabled');
  await cq('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [shop1]);
  const shop2 = crypto.randomUUID();
  const token2 = crypto.randomBytes(32).toString('base64url');
  await cq('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop2, 'SHOP2', 'GIGA CHEMIST - SHOP 2 (synthetic)', token2]);
  await cq('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [shop2]);
  const shop3 = crypto.randomUUID(); // registered but INACTIVE
  await cq('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop3, 'SHOP3', 'Inactive shop', crypto.randomBytes(32).toString('base64url')]);
  await cq('UPDATE giga_cloud.shops SET active = FALSE WHERE shop_id = $1', [shop3]);

  // Shop 2 business data, through the REAL ingestion RPC with Shop 2's own token.
  const m2 = crypto.randomUUID(), b2 = crypto.randomUUID(), s2 = crypto.randomUUID(), u2 = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const ev = (seq: number, type: string, data: any) => ({
    event_id: crypto.randomUUID(), idempotency_key: `itest-s2-${crypto.randomUUID()}`, shop_id: shop2, local_seq: String(seq), event_type: type,
    entity_type: 'x', entity_id: 'x', payload: { data, movements: [], batches: [], audit: [] },
  });
  const ing = (await cq('SELECT public.gc_ingest_events($1, $2, $3::jsonb) AS r', [shop2, token2, JSON.stringify([
    ev(1, 'MEDICINE_BASELINE', { medicine: { id: m2, name: 'ZZ SHOP2 ONLY Medicine', selling_price: 50, purchase_price: 20, status: 'active', category: 'S2' },
      batches: [{ id: b2, medicine_id: m2, batch_number: 'S2-B1', quantity_available: 33, status: 'active', expiry_date: '2031-01-01' }] }),
    ev(2, 'USER_UPSERTED', { user: { id: u2, name: 'ZZ Shop2 Cashier', email: 'itest-ua-s2cashier@itest.local', role: 'CASHIER', active: true } }),
    ev(3, 'SALE_COMPLETED', { sale: { id: s2, sale_number: 'S2-1', receipt_number: 'S2-REC-1', date: today, time: '10:00', cashier_id: u2, device_id: 'S2',
      subtotal: 500, discount_total: 0, tax_total: 0, total: 500, cost_total: 200, gross_profit: 300, payment_method: 'Cash', status: 'completed', idempotency_key: 's2-k1', created_at: new Date().toISOString() },
      items: [{ id: crypto.randomUUID(), sale_id: s2, medicine_id: m2, batch_id: b2, batch_number: 'S2-B1', quantity: 10, unit_price: 50, discount: 0, cost_price_snapshot: 20, total: 500 }],
      payments: [{ id: crypto.randomUUID(), sale_id: s2, method: 'Cash', amount: 500 }], cashier_name: 'ZZ Shop2 Cashier' }),
  ])]))[0].r;
  check(ing.results.every((x: any) => x.status === 'APPLIED'), 'shop 2 business data ingested with its own token', ing);

  // Shop 2 staff credential (password hash) through the dedicated credential RPC.
  const s2pw = pw();
  const s2hash = hashCredential(s2pw).combined;
  secrets.push(s2pw, s2hash);
  const sync2 = (await cq('SELECT public.gc_sync_user_credentials($1, $2, $3::jsonb) AS r', [shop2, token2, JSON.stringify([
    { local_user_id: u2, email: 'itest-ua-s2cashier@itest.local', username: 'ua-s2cashier', name: 'ZZ Shop2 Cashier', role: 'CASHIER', active: true,
      password_hash: s2hash, credential_version: 1, credential_updated_at: new Date().toISOString() }])]))[0].r;
  check(sync2.enabled === true && sync2.results[0].status === 'CREATED', 'shop 2 staff credential published (CREATED)', sync2);

  // Online accounts: a Global Administrator, a legacy shop-scoped Shop 1 admin, a Shop 2 admin.
  const gaPw = pw(), s1aPw = pw(), s2aPw = pw();
  secrets.push(gaPw, s1aPw, s2aPw);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, NULL, NULL)', ['itest-ua-global@itest.local', 'ITest Global Admin', 'ADMIN', hashCredential(gaPw).combined]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-ua-s1admin@itest.local', 'ITest Shop1 Admin', 'ADMIN', hashCredential(s1aPw).combined, shop1]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', ['itest-ua-s2admin@itest.local', 'ITest Shop2 Admin', 'ADMIN', hashCredential(s2aPw).combined, shop2]);

  // Shop 1 activity: one medicine baseline + one sale, synced by the real worker.
  const med1 = await upsertFixtureMedicine('ITEST-UA-1', 'ZZ ITEST Unified Shop1 Medicine', 80, 40);
  await api('POST', '/api/inventory/physical-count', admin.password ? await login(admin.email, admin.password) : null,
    { medicine_id: med1, counts: [{ batch_number: 'UA-B1', quantity: 25, expiry_date: '2031-06-30' }] });
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med1],
    { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  check(boot.status === 0, 'shop 1 baseline queued');
  const cashierToken = await login(cashier.email, cashier.password);
  const sale1 = await api('POST', '/api/sales/checkout', cashierToken, {
    idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med1, quantity: 1, unit_price: 80 }], payment: { method: 'Cash', amount_received: 100 } });
  check(sale1.status === 201, 'shop 1 sale made locally');
  const synced = await waitFor(async () => Number((await cq(`SELECT COUNT(*) n FROM giga_cloud.sales WHERE shop_id = $1 AND sale_id = $2`, [shop1, sale1.data?.sale?.id]))[0].n), (n) => n === 1);
  check(synced === 1, 'shop 1 sale reached the cloud');

  await startOnline(shop1);
  const ga = await onLogin('itest-ua-global@itest.local', gaPw);
  const s1a = await onLogin('itest-ua-s1admin@itest.local', s1aPw);
  const s2a = await onLogin('itest-ua-s2admin@itest.local', s2aPw);
  check(ga.status === 200 && ga.data.account?.type === 'GLOBAL_ADMIN' && ga.data.account.shop_id === null, 'Global Admin login: account GLOBAL_ADMIN, no shop', ga.data?.account);
  check(s1a.status === 200 && s1a.data.account?.type === 'SHOP_USER' && s1a.data.account.shop_id === shop1, 'shop-scoped Shop 1 admin login still works (SHOP_USER)', s1a.data?.account);
  check(s2a.status === 200 && s2a.data.account?.shop_id === shop2, 'Shop 2 admin login (its own shop)');
  const GA = ga.data.token, S1A = s1a.data.token, S2A = s2a.data.token;

  // ================================================================== MULTI-SHOP CONTEXT
  section('MULTI-SHOP: request-scoped shop context');
  const idsOf = (rows: any) => new Set((Array.isArray(rows) ? rows : rows?.sales || []).map((x: any) => x.id));
  let r: any = await on('GET', '/api/medicines', GA);
  check(r.status === 200 && idsOf(r.data).has(med1) && !idsOf(r.data).has(m2), 'TEST 1/16: no header -> default Shop 1 (legacy behaviour)');
  r = await on('GET', '/api/medicines', S1A);
  check(r.status === 200 && idsOf(r.data).has(med1) && !idsOf(r.data).has(m2), 'TEST 2: existing shop-scoped Shop 1 admin keeps Shop 1 data with no frontend change');
  r = await on('GET', '/api/admin/shops', GA);
  const codes = (r.data?.shops || []).map((s: any) => s.shop_code).sort();
  check(r.status === 200 && r.data.scope === 'GLOBAL' && codes.join() === 'SHOP1,SHOP2' && !/token|hash/i.test(JSON.stringify(r.data)),
    'TEST 3: Global Admin lists ACTIVE shops only (SHOP1, SHOP2; inactive SHOP3 hidden), no secrets', codes);
  r = await on('GET', '/api/admin/shops', S1A);
  check(r.status === 200 && r.data.scope === 'SHOP' && r.data.shops.length === 1 && r.data.shops[0].shop_id === shop1, 'shop-scoped admin lists only its own shop');
  r = await on('GET', '/api/medicines', GA, undefined, shop2);
  check(r.status === 200 && idsOf(r.data).has(m2) && !idsOf(r.data).has(med1), 'TEST 4/7: Global Admin selects Shop 2 -> Shop 2 medicines only');
  r = await on('GET', '/api/sales?limit=500', GA, undefined, shop2);
  check(r.status === 200 && idsOf(r.data).has(s2) && !idsOf(r.data).has(sale1.data?.sale?.id), 'TEST 8: Shop 1 sales never appear under Shop 2', { status: r.status, has_s2: idsOf(r.data).has(s2), has_s1: idsOf(r.data).has(sale1.data?.sale?.id), n: (r.data?.sales || r.data || []).length, err: r.data?.error });
  r = await on('GET', '/api/users', GA, undefined, shop2);
  check(r.status === 200 && r.data.some((u: any) => u.id === u2) && !r.data.some((u: any) => u.id === cashier.id || u.id === admin.id), 'TEST 9: Shop 1 staff never appear under Shop 2');
  const rep1 = await on('GET', '/api/reports/summary?range=today', GA, undefined, shop1);
  const rep2 = await on('GET', '/api/reports/summary?range=today', GA, undefined, shop2);
  check(rep2.status === 200 && JSON.stringify(rep2.data).includes('500') && JSON.stringify(rep1.data) !== JSON.stringify(rep2.data), 'TEST 14: reports are per shop');
  r = await on('GET', '/api/medicines', S1A, undefined, shop2);
  check(r.status === 403 && r.data?.code === 'SHOP_ACCESS_DENIED', 'TEST 5/27: shop-scoped Shop 1 admin selecting Shop 2 -> 403');
  r = await on('GET', '/api/medicines', S2A, undefined, shop1);
  check(r.status === 403, 'TEST 28: Shop 2 account selecting Shop 1 -> 403');
  r = await on('GET', '/api/medicines', S2A);
  check(r.status === 200 && idsOf(r.data).has(m2) && !idsOf(r.data).has(med1), 'Shop 2 account without header -> its OWN shop (never the default Shop 1)');
  r = await on('GET', '/api/medicines', GA, undefined, crypto.randomUUID());
  check(r.status === 404 && r.data?.code === 'SHOP_NOT_FOUND', 'random UUID -> 404 (no data)');
  r = await on('GET', '/api/medicines', GA, undefined, shop3);
  check(r.status === 404, 'inactive shop -> 404');
  r = await on('GET', '/api/medicines', GA, undefined, 'not-a-uuid');
  check(r.status === 400 && r.data?.code === 'SHOP_ID_INVALID', 'malformed shop id -> 400');
  r = await on('GET', '/api/settings', null, undefined, shop2);
  check(r.status === 200 && !JSON.stringify(r.data).includes('SHOP 2'), 'anonymous request: header ignored (default shop only, no enumeration)');
  check((await on('GET', '/api/admin/shops', null)).status === 401, 'anonymous cannot list shops');

  // Shop health / commands isolation
  const h1 = await waitFor(() => on('GET', '/api/admin/shop-health', GA, undefined, shop1), (x) => x.data?.online === true, 30_000);
  const h2 = await on('GET', '/api/admin/shop-health', GA, undefined, shop2);
  check(h1.data?.online === true && h2.status === 200 && h2.data.online === false, 'TEST 13: health per shop (Shop 1 heartbeat online, Shop 2 none)');
  const c1 = await on('POST', '/api/admin/commands/price-update', GA, { medicine_id: med1, selling_price: 81 }, shop1);
  const c2 = await on('POST', '/api/admin/commands/price-update', GA, { medicine_id: m2, selling_price: 55 }, shop2);
  const row = async (id: string) => (await cq('SELECT shop_id, display FROM giga_cloud.commands WHERE command_id = $1', [id]))[0];
  check(c1.status === 202 && (await row(c1.data.command_id))?.shop_id === shop1 && c1.data.shop_code === 'SHOP1', 'TEST 10: command queued with Shop 1 selected carries Shop 1');
  check(c2.status === 202 && (await row(c2.data.command_id))?.shop_id === shop2 && (await row(c2.data.command_id))?.display?.target_shop?.shop_code === 'SHOP2',
    'TEST 11: command queued with Shop 2 selected carries Shop 2 (+ target shop recorded)');
  const x1 = await on('POST', '/api/admin/commands/price-update', GA, { medicine_id: m2, selling_price: 56 }, shop1);
  check(x1.status === 404, 'a Shop 2 medicine cannot be commanded while Shop 1 is selected');
  const hist1 = await on('GET', '/api/admin/commands?limit=200', GA, undefined, shop1);
  const hist2 = await on('GET', '/api/admin/commands?limit=200', GA, undefined, shop2);
  const ids = (h: any) => new Set((h.data?.commands || []).map((c: any) => c.command_id));
  check(ids(hist1).has(c1.data.command_id) && !ids(hist1).has(c2.data.command_id) && ids(hist2).has(c2.data.command_id) && !ids(hist2).has(c1.data.command_id),
    'TEST 12: command history isolated by shop');
  const shop1Saw = await waitFor(async () => Number((await pool.query('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [c1.data.command_id])).rows[0].n), (n) => n === 1);
  const leak = Number((await pool.query('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [c2.data.command_id])).rows[0].n);
  check(shop1Saw === 1 && leak === 0, 'Shop 1 computer applied its command and never received the Shop 2 command');

  // TEST 15: concurrency
  const runs = await Promise.all(Array.from({ length: 30 }, (_, i) => {
    const shop = i % 2 ? shop2 : shop1;
    return on('GET', '/api/medicines', GA, undefined, shop).then((x) => ({ shop, ids: idsOf(x.data), ok: x.status === 200 }));
  }));
  check(runs.every((x) => x.ok && (x.shop === shop1 ? x.ids.has(med1) && !x.ids.has(m2) : x.ids.has(m2) && !x.ids.has(med1))),
    'TEST 15/33: 30 concurrent interleaved Shop 1 / Shop 2 requests never share shop context');

  // ================================================================== UNIFIED LOGIN
  section('UNIFIED LOGIN: same password local + online, PIN local only');
  const cHash = (await pool.query('SELECT password_hash, pin_hash FROM users WHERE id = $1', [cashier.id])).rows[0];
  secrets.push(cashier.password, cHash.password_hash, cHash.pin_hash, cashier.pin);
  check((await api('POST', '/api/auth/login', null, { email: cashier.email, password: cashier.password })).status === 200, 'TEST 1: existing local user still logs in LOCALLY');
  const mirrored = await waitFor(async () => (await cq(`SELECT active, account_type, shop_id FROM giga_cloud.online_users WHERE local_user_id = $1`, [cashier.id]))[0], (x) => Boolean(x));
  check(mirrored?.account_type === 'SHOP_USER' && mirrored.shop_id === shop1, 'shop published the user to the cloud login mirror (SHOP_USER, Shop 1)');
  let oc = await onLogin(cashier.email, cashier.password);
  check(oc.status === 200 && oc.data.account.type === 'SHOP_USER' && oc.data.account.shop_id === shop1 && oc.data.account.local_user_id === cashier.id,
    'TEST 2: SAME password authenticates online (locked to Shop 1)');
  const byUsername = await on('POST', '/api/auth/login', null, { username: cashier.username, password: cashier.password });
  check(byUsername.status === 200, 'online login by (unique) username works too');
  check((await onLogin(cashier.email, 'Wrong-password-123')).status === 401 && (await api('POST', '/api/auth/login', null, { email: cashier.email, password: 'Wrong-password-123' })).status === 401,
    'TEST 3: wrong password fails both');
  check((await api('POST', '/api/auth/login', null, { email: cashier.email, pin: cashier.pin })).status === 200, 'TEST 5: PIN still works locally');
  const pinOnline = await onLogin(cashier.email, cashier.pin);
  const pinOnly = await on('POST', '/api/auth/login', null, { email: cashier.email, pin: cashier.pin });
  check(pinOnline.status === 401 && pinOnly.status === 400, 'TEST 6: PIN cannot authenticate online (as password: 401; as pin field: 400)');
  const pinInCloud = (await cq(`SELECT COUNT(*) n FROM giga_cloud.online_users WHERE password_hash = $1`, [cHash.pin_hash]))[0].n;
  check(Number(pinInCloud) === 0, 'PIN hash never reached the cloud');
  const CT = oc.data.token;
  r = await on('GET', '/api/medicines', CT, undefined, shop2);
  check(r.status === 403, 'TEST 6 (multi-shop): Shop 1 cashier passing Shop 2 -> 403');
  check((await on('GET', '/api/admin/shops', CT)).status === 403 && (await on('GET', '/api/admin/accounts', CT)).status === 403, 'cashier cannot enumerate shops or accounts');
  check((await on('GET', '/api/admin/accounts', S1A)).status === 403, 'a shop ADMIN is not a Global Admin (no account management)');
  r = await on('POST', '/api/admin/commands/stock-add', CT, { medicine_id: med1, quantity: 1, reason: 'cashier try' });
  check(r.status === 403, 'an online cashier gets no remote-admin powers');

  // TEST 4: inactive
  const adminToken = await login(admin.email, admin.password);
  r = await api('PATCH', `/api/users/${cashier.id}/status`, adminToken, { active: false });
  const blocked = await waitFor(() => onLogin(cashier.email, cashier.password), (x) => x.status === 401);
  const localBlocked = await api('POST', '/api/auth/login', null, { email: cashier.email, password: cashier.password });
  check(r.status === 200 && blocked.status === 401 && localBlocked.status === 403, 'TEST 4: deactivated user cannot log in locally (403) or online (401, after sync)');
  check((await on('GET', '/api/medicines', CT)).status === 401, 'deactivation revoked the existing online session');
  await api('PATCH', `/api/users/${cashier.id}/status`, adminToken, { active: true });
  oc = await waitFor(() => onLogin(cashier.email, cashier.password), (x) => x.status === 200);
  check(oc.status === 200, 'reactivated locally -> online login works again');

  // TEST 10: local-created user
  const localPw = pw();
  secrets.push(localPw);
  r = await api('POST', '/api/users', adminToken, { name: 'ZZ ITest Local Created', email: `${LOCAL_EMAIL}`, username: `itest-ua-local-${RUN}`, role: 'CASHIER', password: localPw, pin: '482913' });
  check(r.status === 201 || r.status === 200, 'local user created at the shop', r.status);
  const localCreated = await waitFor(() => onLogin(`${LOCAL_EMAIL}`, localPw), (x) => x.status === 200);
  check(localCreated.status === 200 && localCreated.data.account.shop_id === shop1, 'TEST 10: locally created user can log in online with the same password');
  check((await onLogin(`${LOCAL_EMAIL}`, '482913')).status === 401, 'its PIN does not work online');

  // Legacy imported staff with a LOCKED marker instead of a password: never published, never blocks the queue.
  const lockedId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role, active, password_hash, pin_hash) VALUES ($1, 'ZZ ITest Locked Legacy', $2, 'CASHIER', true,
       'LOCKED_MIGRATED_LEGACY_STAFF_ACCOUNT', 'LOCKED_MIGRATED_LEGACY_PIN')`, [lockedId, LOCKED_EMAIL]);
  const lockedDone = await waitFor(async () => (await pool.query('SELECT auth_synced_seq >= auth_sync_seq AS done FROM users WHERE id = $1', [lockedId])).rows[0]?.done, (x) => x === true);
  const lockedCloud = Number((await cq('SELECT COUNT(*) n FROM giga_cloud.online_users WHERE local_user_id = $1', [lockedId]))[0].n);
  check(lockedDone === true && lockedCloud === 0, 'a LOCKED legacy account (no usable password) is not published and does not stay queued');

  // TEST 15: local password change -> cloud
  const newLocalPw = pw();
  secrets.push(newLocalPw);
  const lcTok = await login(`${LOCAL_EMAIL}`, localPw);
  r = await api('POST', '/api/users/change-password', lcTok, { current_password: localPw, new_password: newLocalPw, confirm_password: newLocalPw });
  const lcOnline = await waitFor(() => onLogin(`${LOCAL_EMAIL}`, newLocalPw), (x) => x.status === 200);
  check(r.status === 200 && lcOnline.status === 200 && (await onLogin(`${LOCAL_EMAIL}`, localPw)).status === 401,
    'TEST 15: local password change reaches the cloud (new works online, old fails)');
  check((await on('GET', '/api/auth/me', localCreated.data.token)).status === 401, 'local password change revoked older online sessions');

  // ================================================================== GLOBAL ADMIN: shop users
  section('GLOBAL ADMIN: shop users (create, deactivate, role, reset)');
  const remotePw = pw();
  secrets.push(remotePw);
  r = await on('POST', '/api/admin/accounts/shop-users', GA, { name: 'ZZ ITest Remote Created', email: `${REMOTE_EMAIL}`, username: `itest-ua-remote-${RUN}`, role: 'CASHIER', password: remotePw }, shop1);
  const remoteId = r.data?.account?.local_user_id;
  check(r.status === 201 && r.data.command.command_type === 'USER_CREATE' && r.data.command.shop_id === shop1 && !JSON.stringify(r.data).includes('password'),
    'TEST 17/31: Global Admin creates a Shop 1 user; USER_CREATE goes to Shop 1 only; response has no credential', r.data);
  check((await onLogin(`${REMOTE_EMAIL}`, remotePw)).status === 200, 'cloud identity works online immediately');
  const created = await waitFor(async () => (await pool.query('SELECT id, password_hash, role FROM users WHERE id = $1', [remoteId])).rows[0], (x) => Boolean(x));
  if (created) secrets.push(created.password_hash);
  check(Boolean(created) && (await api('POST', '/api/auth/login', null, { email: `${REMOTE_EMAIL}`, password: remotePw })).status === 200,
    'TEST 11: the shop created the local account; the same password works locally');
  const cmdRow = (await cq(`SELECT payload, display, status FROM giga_cloud.commands WHERE command_type = 'USER_CREATE' AND payload ->> 'user_id' = $1`, [remoteId]))[0];
  check(Boolean(cmdRow) && noSecret(JSON.stringify(cmdRow)) && !('password' in cmdRow.payload) && !('password_hash' in cmdRow.payload),
    'TEST 8: USER_CREATE command (payload + display) holds no password and no hash');
  check((await on('POST', '/api/admin/accounts/shop-users', GA, { name: 'x', email: `${REMOTE_EMAIL}`, role: 'CASHIER', password: pw() }, shop1)).status === 409, 'duplicate email refused');
  check((await on('POST', '/api/admin/commands/user-active', GA, { user_id: remoteId, active: false, reason: 'x', password_hash: 'abc' }, shop1)).status === 400, 'commands refuse any credential field');

  // reset password
  const RT = (await onLogin(`${REMOTE_EMAIL}`, remotePw)).data.token;
  const resetPw = pw();
  secrets.push(resetPw);
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/password`, GA, { password: resetPw }, shop1);
  check(r.status === 200 && r.data.command.command_type === 'USER_CREDENTIAL_REFRESH' && r.data.command.shop_id === shop1 && r.data.sessions_revoked, 'TEST 21/32: reset queued for Shop 1 only', r.data);
  check((await on('GET', '/api/auth/me', RT)).status === 401, 'TEST 14: online sessions revoked by the reset');
  check((await onLogin(`${REMOTE_EMAIL}`, resetPw)).status === 200 && (await onLogin(`${REMOTE_EMAIL}`, remotePw)).status === 401,
    'TEST 12/13 (online): new password works, old fails');
  const localReset = await waitFor(() => api('POST', '/api/auth/login', null, { email: `${REMOTE_EMAIL}`, password: resetPw }), (x) => x.status === 200);
  check(localReset.status === 200 && (await api('POST', '/api/auth/login', null, { email: `${REMOTE_EMAIL}`, password: remotePw })).status === 401,
    'TEST 12/13 (local): after the shop applied it, new password works and old fails at the shop');

  // deactivate / reactivate / role
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/active`, GA, { active: false }, shop1);
  check(r.status === 200 && (await onLogin(`${REMOTE_EMAIL}`, resetPw)).status === 401, 'TEST 18: Global Admin deactivation blocks online login IMMEDIATELY');
  const locDeact = await waitFor(() => api('POST', '/api/auth/login', null, { email: `${REMOTE_EMAIL}`, password: resetPw }), (x) => x.status === 403);
  check(locDeact.status === 403, 'deactivation applied at the shop (local login refused)');
  await sleep(2500); // a shop credential sync in between must not re-enable it
  check((await onLogin(`${REMOTE_EMAIL}`, resetPw)).status === 401, 'online stays blocked after the shop synced');
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/active`, GA, { active: true }, shop1);
  const back = await waitFor(() => api('POST', '/api/auth/login', null, { email: `${REMOTE_EMAIL}`, password: resetPw }), (x) => x.status === 200);
  check(r.status === 200 && back.status === 200 && (await onLogin(`${REMOTE_EMAIL}`, resetPw)).status === 200, 'TEST 19: reactivation restores local and online login');
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/role`, GA, { role: 'ADMIN' }, shop1);
  const roleLocal = await waitFor(async () => (await pool.query('SELECT role FROM users WHERE id = $1', [remoteId])).rows[0]?.role, (x) => x === 'ADMIN');
  const roleCloud = (await cq('SELECT role FROM giga_cloud.online_users WHERE local_user_id = $1', [remoteId]))[0]?.role;
  check(r.status === 200 && r.data.command.shop_id === shop1 && roleLocal === 'ADMIN' && roleCloud === 'ADMIN', 'TEST 20: role change applied in the cloud and at Shop 1');
  await on('POST', `/api/admin/accounts/shop-users/${remoteId}/role`, GA, { role: 'CASHIER' }, shop1);
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/revoke-sessions`, GA, {}, shop1);
  check(r.status === 200, 'revoke a shop user\'s online sessions');
  check((await on('DELETE', `/api/admin/accounts/shop-users/${remoteId}`, GA, undefined, shop1)).status === 409, '"remove" a staff member = deactivate (delete refused)');

  // Cross-shop management safety
  r = await on('POST', `/api/admin/accounts/shop-users/${u2}/password`, GA, { password: pw() }, shop1);
  check(r.status === 409 && /another shop/.test(r.data?.error || ''), 'a Shop 2 account cannot be changed while Shop 1 is selected');
  r = await on('POST', `/api/admin/accounts/shop-users/${u2}/active`, GA, { active: false }, shop2);
  check(r.status === 200 && r.data.command.shop_id === shop2 && (await onLogin('itest-ua-s2cashier@itest.local', s2pw)).status === 401, 'TEST 30: Global Admin manages Shop 2 staff (Shop 2 command)');
  await on('POST', `/api/admin/accounts/shop-users/${u2}/active`, GA, { active: true }, shop2);
  r = await on('POST', '/api/admin/accounts/shop-users', GA, { name: 'ZZ S2 New', email: 'itest-ua-s2new@itest.local', role: 'CASHIER', password: pw() }, shop2);
  const s2cmd = r.data?.command?.command_id;
  check(r.status === 201 && r.data.command.shop_id === shop2, 'user creation with Shop 2 selected targets Shop 2');
  await sleep(2500);
  check(Number((await pool.query('SELECT COUNT(*) n FROM sync_inbound_commands WHERE command_id = $1', [s2cmd])).rows[0].n) === 0, 'TEST 31: Shop 1 never receives the Shop 2 user creation');
  const all = await on('GET', '/api/admin/accounts?shop=all', GA);
  const shopsSeen = new Set((all.data?.shop_users || []).map((u: any) => u.shop_code));
  check(all.status === 200 && shopsSeen.has('SHOP1') && shopsSeen.has('SHOP2') && noSecret(all.text) && !/password_hash|pin_hash/.test(all.text), 'Global Admin lists users of all shops (no secrets)');

  // TEST 29: Shop 1's token cannot touch a Shop 2 account
  const before2 = (await cq('SELECT password_hash, credential_version FROM giga_cloud.online_users WHERE local_user_id = $1', [u2]))[0];
  const evil = (await cq('SELECT public.gc_sync_user_credentials($1, $2, $3::jsonb) AS r', [shop1, env.token, JSON.stringify([
    { local_user_id: u2, email: 'itest-ua-s2cashier@itest.local', name: 'evil', role: 'ADMIN', active: true, password_hash: hashCredential('Evil-pass-123').combined, credential_version: 999, credential_updated_at: new Date().toISOString() }])]))[0].r;
  const after2 = (await cq('SELECT password_hash, credential_version, role FROM giga_cloud.online_users WHERE local_user_id = $1', [u2]))[0];
  let crossToken = false;
  try {
    await cq('SELECT public.gc_sync_user_credentials($1, $2, $3::jsonb)', [shop2, env.token, '[]']);
  } catch {
    crossToken = true;
  }
  check(evil.results[0].status === 'EMAIL_CONFLICT' && after2.password_hash === before2.password_hash && after2.role === 'CASHIER' && crossToken,
    'TEST 29: Shop 1 credential sync cannot modify a Shop 2 account; Shop 1 token is refused for Shop 2', evil.results);

  // TEST 16: version ordering (cloud side): an older credential never overwrites a newer one
  const cur = (await cq(`SELECT credential_version, credential_updated_at::text AS at, password_hash FROM giga_cloud.online_users WHERE local_user_id = $1`, [cashier.id]))[0];
  const stale = (await cq('SELECT public.gc_sync_user_credentials($1, $2, $3::jsonb) AS r', [shop1, env.token, JSON.stringify([
    { local_user_id: cashier.id, email: cashier.email, username: cashier.username, name: 'x', role: 'CASHIER', active: true,
      password_hash: hashCredential('Older-pass-123').combined, credential_version: Math.max(1, Number(cur.credential_version) - 1), credential_updated_at: '2001-01-01T00:00:00Z' }])]))[0].r;
  const after = (await cq(`SELECT password_hash FROM giga_cloud.online_users WHERE local_user_id = $1`, [cashier.id]))[0];
  check(stale.results[0].status === 'CLOUD_CREDENTIAL_NEWER' && after.password_hash === cur.password_hash, 'TEST 16: older credential version cannot overwrite a newer one', stale.results);

  // TEST 16 (offline conflict): cloud reset while the shop is offline, then a LATER local change -> local wins on both sides
  const conflictPw = pw(), cloudResetPw = pw(), offlineLocalPw = pw();
  secrets.push(conflictPw, cloudResetPw, offlineLocalPw);
  await api('POST', '/api/users', adminToken, { name: 'ZZ ITest Conflict', email: `${CONFLICT_EMAIL}`, role: 'CASHIER', password: conflictPw });
  const conflictId = (await pool.query('SELECT id FROM users WHERE email = $1', [CONFLICT_EMAIL])).rows[0].id;
  await waitFor(() => onLogin(`${CONFLICT_EMAIL}`, conflictPw), (x) => x.status === 200);
  await emu.stop(); // shop computer loses the internet
  try {
    await cq(`UPDATE giga_cloud.online_users SET password_hash = $2, credential_version = credential_version + 1, credential_updated_at = now(), token_version = token_version + 1 WHERE local_user_id = $1`,
      [conflictId, hashCredential(cloudResetPw).combined]);
    await cq(`SELECT * FROM giga_cloud.queue_online_command($1, 'USER_CREDENTIAL_REFRESH', $2::jsonb, $3, (SELECT id FROM giga_cloud.online_users WHERE email = 'itest-ua-global@itest.local'))`,
      [shop1, JSON.stringify({ user_id: conflictId, credential_version: 2 }), `itest-conflict-${crypto.randomUUID()}`]);
    await sleep(50);
    const ctok = await login(`${CONFLICT_EMAIL}`, conflictPw);
    await api('POST', '/api/users/change-password', ctok, { current_password: conflictPw, new_password: offlineLocalPw, confirm_password: offlineLocalPw });
  } finally {
    await emu.restart();
  }
  const conv = await waitFor(() => onLogin(`${CONFLICT_EMAIL}`, offlineLocalPw), (x) => x.status === 200, 40_000);
  const localKeeps = await api('POST', '/api/auth/login', null, { email: `${CONFLICT_EMAIL}`, password: offlineLocalPw });
  const superseded = (await pool.query(`SELECT result FROM sync_inbound_commands WHERE command_type = 'USER_CREDENTIAL_REFRESH' AND payload ->> 'user_id' = $1`, [conflictId])).rows[0];
  check(conv.status === 200 && localKeeps.status === 200 && (await onLogin(`${CONFLICT_EMAIL}`, cloudResetPw)).status === 401 && superseded?.result?.applied === false,
    'TEST 16: offline conflict -> the NEWER (local) password wins on both sides; the older cloud reset is superseded, not applied');

  // ================================================================== USER PROFILE EDITING (USER_PROFILE_UPDATE)
  section('USER PROFILE: name / username / email / role, both directions');
  const remoteUser = `itest-ua-remote-${RUN}`;
  const onLoginUser = (username: string, password: string) => on('POST', '/api/auth/login', null, { username, password });
  check((await onLoginUser(remoteUser, resetPw)).status === 200, 'P1: username online login works (unique username)');
  const profileNow = async () => (await pool.query('SELECT name, username, email, role, active FROM users WHERE id = $1', [remoteId])).rows[0];
  const cloudNow = async () => (await cq('SELECT id, name, username, email, role, token_version FROM giga_cloud.online_users WHERE local_user_id = $1', [remoteId]))[0];

  // a sale by this account BEFORE the rename (receipt must keep the old name)
  const sellerTok = await login(`${REMOTE_EMAIL}`, resetPw);
  const med1Price = Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med1])).rows[0].selling_price);
  const oldSale = await api('POST', '/api/sales/checkout', sellerTok, {
    idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med1, quantity: 1, unit_price: med1Price }], payment: { method: 'Cash', amount_received: Math.ceil(med1Price) + 100 } });
  const oldSaleId = oldSale.data?.sale?.id;
  const beforeName = (await profileNow()).name;
  const idBefore = (await cloudNow()).id;

  // P2 name
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { name: 'ZZ ITest Renamed', expected: { name: beforeName } }, shop1);
  const named = await waitFor(profileNow, (x) => x.name === 'ZZ ITest Renamed');
  check(r.status === 200 && r.data.command.command_type === 'USER_PROFILE_UPDATE' && named.name === 'ZZ ITest Renamed' && (await cloudNow()).name === 'ZZ ITest Renamed',
    'P2: Global Admin edits NAME -> cloud + Shop 1 local updated', r.data);
  const saleAfter = await api('GET', `/api/sales?limit=50`, adminToken);
  const oldRow = (saleAfter.data?.sales || saleAfter.data || []).find((s: any) => s.id === oldSaleId);
  check(Boolean(oldSaleId) && oldRow?.cashier_name === beforeName, 'P3: old receipt keeps the cashier name it was recorded with (not rewritten)', { oldSale: oldSale.status, oldSaleErr: oldSale.data?.error, found: Boolean(oldRow), name: oldRow?.cashier_name, beforeName });
  const newSale = await api('POST', '/api/sales/checkout', sellerTok, {
    idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med1, quantity: 1, unit_price: med1Price }], payment: { method: 'Cash', amount_received: Math.ceil(med1Price) + 100 } });
  const newRow = ((await api('GET', `/api/sales?limit=50`, adminToken)).data?.sales || []).find((s: any) => s.id === newSale.data?.sale?.id);
  check(newRow?.cashier_name === 'ZZ ITest Renamed', 'P3: new sales use the new name', { newSale: newSale.status, err: newSale.data?.error, name: newRow?.cashier_name });

  // P4 username
  const newUser = `itest-ua-renamed-${RUN}`;
  const tokBeforeLogin = (await onLogin(`${REMOTE_EMAIL}`, resetPw)).data.token;
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { username: newUser, expected: { username: remoteUser } }, shop1);
  check(r.status === 200 && r.data.online_sessions_revoked === true && (await on('GET', '/api/auth/me', tokBeforeLogin)).status === 401, 'P4: username change ends online sessions', r.data);
  await waitFor(profileNow, (x) => x.username === newUser);
  check((await onLoginUser(newUser, resetPw)).status === 200 && (await onLoginUser(remoteUser, resetPw)).status === 401, 'P4: new username logs in ONLINE, old fails');
  check((await api('POST', '/api/auth/login', null, { email: newUser, password: resetPw })).status === 200
    && (await api('POST', '/api/auth/login', null, { email: remoteUser, password: resetPw })).status === 401, 'P4: new username logs in LOCALLY, old fails');

  // P5 email
  const NEW_EMAIL = `itest-ua-newmail-${RUN}@gigachemist.local`;
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { email: NEW_EMAIL, expected: { email: REMOTE_EMAIL } }, shop1);
  await waitFor(profileNow, (x) => x.email === NEW_EMAIL);
  check(r.status === 200 && (await onLogin(NEW_EMAIL, resetPw)).status === 200 && (await onLogin(REMOTE_EMAIL, resetPw)).status === 401, 'P5: new email logs in online, old fails');
  check((await api('POST', '/api/auth/login', null, { email: NEW_EMAIL, password: resetPw })).status === 200
    && (await api('POST', '/api/auth/login', null, { email: REMOTE_EMAIL, password: resetPw })).status === 401, 'P5: new email logs in locally, old fails');
  check((await cloudNow()).id === idBefore && (await pool.query('SELECT 1 FROM users WHERE id = $1', [remoteId])).rows.length === 1, 'P6: online account id and local user id unchanged');

  // P7 MANAGER role (now assignable everywhere)
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/role`, GA, { role: 'MANAGER' }, shop1);
  const mgr = await waitFor(profileNow, (x) => x.role === 'MANAGER');
  check(r.status === 200 && mgr.role === 'MANAGER' && (await cloudNow()).role === 'MANAGER', 'P7: role MANAGER applied online and at Shop 1');
  await on('POST', `/api/admin/accounts/shop-users/${remoteId}/role`, GA, { role: 'CASHIER' }, shop1);
  await waitFor(profileNow, (x) => x.role === 'CASHIER');
  const localMgr = await api('POST', '/api/users', adminToken, { name: 'ZZ ITest Manager', email: `itest-ua-mgr-${RUN}@gigachemist.local`, role: 'MANAGER', password: pw() });
  check(localMgr.status === 201 && localMgr.data.user.role === 'MANAGER', 'P7: a local Admin can create a MANAGER (role was refused before)', localMgr.data);

  // P8 duplicates + stale + validation (online API)
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { email: cashier.email, expected: { email: NEW_EMAIL } }, shop1);
  check(r.status === 409, 'P8: duplicate email refused', r.data);
  const cashierUsername = (await pool.query('SELECT username FROM users WHERE id = $1', [cashier.id])).rows[0]?.username;
  if (cashierUsername) {
    r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { username: cashierUsername, expected: { username: newUser } }, shop1);
    check(r.status === 409, 'P8: duplicate username refused', r.data);
  }
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { name: 'X', expected: { name: 'Not What It Is' } }, shop1);
  check(r.status === 409, 'P8: stale edit refused online (expected differs from cloud)', r.data);
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { name: 'X', password: 'abc', expected: { name: 'ZZ ITest Renamed' } }, shop1);
  const cmdNoPw = (await cq(`SELECT payload::text p FROM giga_cloud.commands WHERE command_type = 'USER_PROFILE_UPDATE'`)).map((x: any) => x.p).join();
  check(!/password|pin/i.test(cmdNoPw), 'P8: USER_PROFILE_UPDATE payloads never carry a password or PIN');
  await waitFor(profileNow, (x) => x.name === 'X');

  // P9 stale at the SHOP: local edit while offline, then an online edit based on the old value -> REJECTED, cloud converges back
  await emu.stop();
  try {
    await api('PUT', `/api/users/${remoteId}`, adminToken, { name: 'ZZ Local Offline Name' });
  } finally {
    await emu.restart();
  }
  r = await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, GA, { name: 'ZZ Online Stale Edit', expected: { name: 'X' } }, shop1);
  const staleCmd = r.data?.command?.command_id;
  const staleRow = await waitFor(async () => (await cq('SELECT status, error FROM giga_cloud.commands WHERE command_id = $1', [staleCmd]))[0], (x) => x && !['PENDING', 'DELIVERED'].includes(x.status), 40_000);
  const conv2 = await waitFor(cloudNow, (x) => x.name === 'ZZ Local Offline Name', 40_000);
  check(staleRow?.status === 'REJECTED' && (await profileNow()).name === 'ZZ Local Offline Name' && conv2.name === 'ZZ Local Offline Name',
    'P9: stale USER_PROFILE_UPDATE REJECTED at the shop; the newer local name wins on both sides', staleRow);

  // P10 local -> online (offline edit syncs after reconnect)
  await emu.stop();
  try {
    await api('PUT', `/api/users/${remoteId}`, adminToken, { username: `itest-ua-local-${RUN}-u` });
  } finally {
    await emu.restart();
  }
  const conv3 = await waitFor(cloudNow, (x) => x.username === `itest-ua-local-${RUN}-u`, 40_000);
  check(conv3.username === `itest-ua-local-${RUN}-u` && (await onLoginUser(`itest-ua-local-${RUN}-u`, resetPw)).status === 200,
    'P10: local profile edit made OFFLINE reaches the cloud after reconnect (new username logs in online)');

  // P11 RBAC
  const cashierTok2 = await loginNoShift(cashier.email, cashier.password);
  check((await api('PUT', `/api/users/${remoteId}`, cashierTok2, { name: 'hack' })).status === 403, 'P11: a cashier cannot edit user accounts locally');
  const cashierOnline = await onLogin(cashier.email, cashier.password);
  check((await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, cashierOnline.data?.token, { name: 'hack', expected: { name: 'x' } })).status === 403,
    'P11: a cashier cannot edit user accounts online');
  check((await on('POST', `/api/admin/accounts/shop-users/${remoteId}/profile`, S1A, { name: 'hack', expected: { name: 'x' } }, shop1)).status === 403,
    'P12: a shop ADMIN (not Global) cannot use Global user management');
  check((await on('POST', `/api/admin/accounts/shop-users/${u2}/profile`, GA, { name: 'hack', expected: { name: 'ZZ Shop2 Cashier' } }, shop1)).status === 409,
    'P13: a Shop 2 account cannot be edited while Shop 1 is selected');
  r = await on('POST', `/api/admin/accounts/shop-users/${u2}/profile`, GA, { name: 'ZZ Shop2 Cashier Edited', expected: { name: 'ZZ Shop2 Cashier' } }, shop2);
  check(r.status === 200 && r.data.command.shop_id === shop2, 'P13: Global Admin edits a Shop 2 account with Shop 2 selected (Shop 2 command)', r.data);

  // P14 publish existing shop users (dry run from the heartbeat; no credential data)
  const prev = await waitFor(() => on('GET', '/api/admin/accounts/publish-preview', GA, undefined, shop1), (x) => x.data?.ready === true, 40_000);
  check(prev.status === 200 && prev.data.ready && prev.data.summary.local_users > 0 && !/password_hash|pin_hash|\$[0-9a-f]{64}/.test(prev.text) && noSecret(prev.text),
    'P14: publish dry run lists local users / matches / to-create / conflicts / missing hashes, without credentials', { ok: prev.status, word: /password_hash|pin_hash/.test(prev.text), hex: /$[0-9a-f]{64}/.test(prev.text), secret_index: secrets.findIndex((x) => x && prev.text.includes(x)) });
  check((await on('POST', '/api/admin/accounts/publish-existing', GA, { confirm_shop_code: 'WRONG' }, shop1)).status === 400, 'P14: publish requires the shop code typed back');
  r = await on('POST', '/api/admin/accounts/publish-existing', GA, { confirm_shop_code: 'SHOP1' }, shop1);
  check(r.status === 200 && r.data.enabled === true, 'P14: publish enables credential publishing for the selected shop', r.data);
  check((await on('GET', '/api/admin/accounts/publish-preview', S1A, undefined, shop1)).status === 403, 'P14: only a Global Admin can run the publish dry run');

  // ================================================================== GLOBAL ADMIN: global admins
  section('GLOBAL ADMIN: global administrators');
  const ga2Pw = pw(), ga3Pw = pw();
  secrets.push(ga2Pw, ga3Pw);
  r = await on('POST', '/api/admin/accounts/global-admins', GA, { name: 'ITest Global Two', email: 'itest-ua-global2@itest.local', password: ga2Pw });
  const ga2 = r.data?.account?.id;
  const ga2Login = await onLogin('itest-ua-global2@itest.local', ga2Pw);
  check(r.status === 201 && ga2Login.status === 200 && ga2Login.data.account.type === 'GLOBAL_ADMIN', 'TEST 22: Global Admin creates another Global Admin (can log in)');
  r = await on('POST', `/api/admin/accounts/global-admins/${ga2}/active`, GA, { active: false });
  check(r.status === 200 && (await onLogin('itest-ua-global2@itest.local', ga2Pw)).status === 401 && (await on('GET', '/api/auth/me', ga2Login.data.token)).status === 401,
    'TEST 23: deactivates another Global Admin (login + sessions blocked)');
  const meId = ga.data.user.id;
  r = await on('POST', `/api/admin/accounts/global-admins/${meId}/active`, GA, { active: false });
  check(r.status === 409, 'TEST 24: the last active Global Admin cannot be deactivated', r.data);
  let trig = false;
  try {
    await cq(`UPDATE giga_cloud.online_users SET active = FALSE WHERE id = $1`, [meId]);
  } catch (e: any) {
    trig = e?.code === 'PT409';
  }
  check(trig, 'database trigger also refuses a direct deactivation of the last Global Admin');
  let trigDel = false;
  try {
    await cq('DELETE FROM giga_cloud.online_users WHERE id = $1', [meId]);
  } catch (e: any) {
    trigDel = e?.code === 'PT409';
  }
  check(trigDel && (await on('DELETE', `/api/admin/accounts/global-admins/${meId}`, GA)).status === 409, 'TEST 25: the last active Global Admin cannot be deleted');
  r = await on('POST', '/api/admin/accounts/global-admins', GA, { name: 'ITest Global Three', email: 'itest-ua-global3@itest.local', password: ga3Pw });
  const ga3 = r.data?.account?.id;
  check((await on('DELETE', `/api/admin/accounts/global-admins/${ga3}`, GA)).status === 200, 'a never-used Global Admin can be permanently deleted');
  check((await on('DELETE', `/api/admin/accounts/global-admins/${ga2}`, GA)).status === 409, 'a Global Admin with history cannot be deleted (deactivate instead)');
  await on('POST', `/api/admin/accounts/global-admins/${ga2}/active`, GA, { active: true });
  const ga2New = pw();
  secrets.push(ga2New);
  r = await on('POST', `/api/admin/accounts/global-admins/${ga2}/password`, GA, { password: ga2New });
  check(r.status === 200 && (await onLogin('itest-ua-global2@itest.local', ga2New)).status === 200, 'Global Admin password reset works');
  const ga2Tok = (await onLogin('itest-ua-global2@itest.local', ga2New)).data.token;
  r = await on('POST', `/api/admin/accounts/global-admins/${ga2}/profile`, GA, { name: 'ITest Global Two Renamed', email: 'itest-ua-global2b@itest.local', expected: { name: 'ITest Global Two', email: 'itest-ua-global2@itest.local' } });
  check(r.status === 200 && r.data.sessions_revoked && (await on('GET', '/api/auth/me', ga2Tok)).status === 401
    && (await onLogin('itest-ua-global2b@itest.local', ga2New)).status === 200 && (await onLogin('itest-ua-global2@itest.local', ga2New)).status === 401,
    'G1: Global Admin edits another Global Admin name + email (new email logs in, old fails, sessions end)', r.data);
  check((await on('POST', `/api/admin/accounts/global-admins/${ga2}/profile`, GA, { account_type: 'SHOP_USER', expected: {} })).status === 400,
    'G2: a Global Admin cannot be converted into shop staff by profile editing');
  check((await cq(`SELECT account_type, shop_id FROM giga_cloud.online_users WHERE id = $1`, [ga2]))[0]?.account_type === 'GLOBAL_ADMIN', 'G2: account type unchanged');
  check((await on('POST', '/api/admin/accounts/global-admins', S1A, { name: 'x', email: 'itest-ua-x@itest.local', password: pw() })).status === 403, 'a shop ADMIN cannot create Global Admins');

  // ================================================================== AUDIT + SECRET HYGIENE
  section('AUDIT + SECRET HYGIENE');
  const audit = await cq(`SELECT action, details::text AS d FROM giga_cloud.online_audit`);
  const actions = new Set(audit.map((a: any) => a.action));
  const need = ['USER_CREATED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_ROLE_CHANGED', 'USER_PASSWORD_RESET', 'GLOBAL_ADMIN_CREATED', 'GLOBAL_ADMIN_DEACTIVATED', 'SESSIONS_REVOKED', 'USER_PROFILE_UPDATED', 'GLOBAL_ADMIN_UPDATED', 'SHOP_USERS_PUBLISH_ENABLED'];
  check(need.every((a) => actions.has(a)), 'TEST 26: every user-management action is audited', need.filter((a) => !actions.has(a)));
  check(noSecret(JSON.stringify(audit)) && !/password_hash|pin_hash/.test(JSON.stringify(audit)), 'TEST 9: cloud audit holds no password, hash or PIN', audit.filter((a: any) => !noSecret(a.d) || /password_hash|pin_hash/.test(a.d)).map((a: any) => ({ action: a.action, secret_index: secrets.findIndex((x) => x && a.d.includes(x)), hash_word: /password_hash|pin_hash/.test(a.d) })));
  const cmds = await cq(`SELECT payload::text p, COALESCE(display::text, '') d, COALESCE(result::text, '') r FROM giga_cloud.commands`);
  check(noSecret(JSON.stringify(cmds)) && !/password/.test(cmds.map((c: any) => c.p).join()), 'TEST 8: no password / hash in any command payload, display or result');
  const events = await cq(`SELECT payload::text p FROM giga_cloud.processed_events UNION ALL SELECT payload::text FROM giga_cloud.rejected_events`);
  check(noSecret(JSON.stringify(events)) && !/password_hash|pin_hash/.test(JSON.stringify(events)), 'no hash in cloud business events (processed / rejected)');
  const localAudit = (await pool.query(`SELECT COALESCE(previous_value::text, '') || COALESCE(new_value::text, '') AS t FROM audit_logs WHERE created_at > now() - interval '1 hour'`)).rows;
  const outbox = (await pool.query(`SELECT payload::text t FROM sync_events WHERE created_at > now() - interval '1 hour'`)).rows;
  check(noSecret(JSON.stringify(localAudit)) && noSecret(JSON.stringify(outbox)) && !/password_hash|pin_hash/.test(JSON.stringify(outbox)),
    'TEST 9: shop audit log and outbox hold no password, hash or PIN');
  const apis = [await on('GET', '/api/users', GA), await on('GET', '/api/admin/security', GA), await on('GET', '/api/admin/commands?limit=200', GA), await on('GET', '/api/auth/me', GA)];
  check(apis.every((x) => noSecret(x.text) && !/password_hash|pin_hash/.test(x.text)), 'TEST 7: no password hash in any API response');
  check(noSecret(onlineLog) && !/\$[0-9a-f]{64,}/.test(onlineLog), 'online server log holds no secret');

  // ================================================================== migration: existing admin -> GLOBAL_ADMIN
  section('CLOUD MIGRATION 005: existing online Admin preserved as GLOBAL_ADMIN (re-run)');
  const legacyPw = pw();
  secrets.push(legacyPw);
  await cq('ALTER TABLE giga_cloud.online_users ALTER COLUMN account_type DROP NOT NULL');
  await cq(`INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, account_type) VALUES ('itest-ua-legacy@itest.local', 'Legacy Admin', 'ADMIN', $1, $2, NULL)`,
    [hashCredential(legacyPw).combined, shop1]);
  const legacyLogin = await onLogin('itest-ua-legacy@itest.local', legacyPw);
  const beforeShops = await on('GET', '/api/admin/shops', legacyLogin.data?.token);
  const sql005 = fs.readFileSync(path.resolve('cloud/supabase/migrations/005_unified_auth_multishop.sql'), 'utf-8');
  await emu.pool.query(sql005); // re-runnable: applied a second time over live data
  const legacyRow = (await cq(`SELECT account_type, shop_id FROM giga_cloud.online_users WHERE email = 'itest-ua-legacy@itest.local'`))[0];
  const afterShops = await on('GET', '/api/admin/shops', legacyLogin.data?.token);
  check(legacyLogin.status === 200 && beforeShops.data?.scope === 'SHOP' && legacyRow.account_type === 'GLOBAL_ADMIN' && legacyRow.shop_id === null,
    'pre-005 Admin (shop-scoped, no staff link) becomes GLOBAL_ADMIN on migration', legacyRow);
  check(afterShops.status === 200 && afterShops.data.scope === 'GLOBAL' && (await onLogin('itest-ua-legacy@itest.local', legacyPw)).status === 200,
    'its existing session and password keep working (no lock-out)');
  const stillOk = await onLogin(cashier.email, cashier.password);
  check(stillOk.status === 200, 'migration re-run left shop users intact');
}
