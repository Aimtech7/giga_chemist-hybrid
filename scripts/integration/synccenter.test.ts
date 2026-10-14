import crypto from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { api, check, login, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import { CLOUD_TEST_DB, type HybridEnv } from './hybrid.test';
import { hashCredential } from '../../server/auth';
import { classifyConflict } from '../../server/sync/conflicts';

/**
 * SYNC & CONFLICT CONTROL CENTER suite (run from test:stocktake; hybrid shop server + cloud emulator +
 * an online API on the cloud test database). Retries must never duplicate: an event keeps its
 * idempotency key (the cloud answers DUPLICATE), a rejected command is re-sent ONCE as a new command.
 */
const ONLINE_PORT = 3197;
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(400);
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
export async function stopSyncCenterOnline() {
  if (online && online.exitCode === null) online.kill();
  online = null;
}
async function startOnline(shopId: string) {
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
    if (online.exitCode !== null) throw new Error(`online server exited: ${onlineLog.slice(-2000)}`);
    try { if ((await fetch(`http://127.0.0.1:${ONLINE_PORT}/api/health`)).status === 200) return; } catch {}
    await sleep(300);
  }
  throw new Error('online server not ready');
}
async function on(method: string, p: string, token?: string | null, body?: unknown) {
  const h: Record<string, string> = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${ONLINE_PORT}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text };
}

export async function syncCenterTests(env: HybridEnv, admin: Fixture, manager: Fixture, cashier: Fixture) {
  const cq = async (sql: string, params: any[] = []) => (await env.emu.pool.query(sql, params)).rows;
  section('SYNC CENTER — conflict reasons');
  const cases: [string, string, string][] = [
    ['USER_PROFILE_UPDATE', 'This account was changed at the shop meanwhile (name). Reload and edit again.', 'USER_CHANGED_LOCALLY'],
    ['STOCK_SET', 'Stock changed meanwhile: expected_quantity 5, now 3', 'STOCK_CHANGED'],
    ['PRICE_UPDATE', 'The medicine was changed meanwhile (selling_price).', 'STALE_VERSION'],
    ['SALE_VOID', 'Sale not found.', 'RECORD_NOT_FOUND'],
    ['USER_CREATE', 'Another staff account in this shop already uses that username.', 'DUPLICATE_USERNAME'],
    ['USER_CREATE', 'Another staff account in this shop already uses that email.', 'DUPLICATE_EMAIL'],
    ['STOCKTAKE', 'Cannot approve a stocktake that is COMPLETED.', 'INVALID_STATE'],
  ];
  const wrong = cases.filter(([t, e, want]) => classifyConflict(t, e) !== want);
  check(!wrong.length, 'SC1: conflict reasons STALE_VERSION / USER_CHANGED_LOCALLY / STOCK_CHANGED / RECORD_NOT_FOUND / DUPLICATE_USERNAME / DUPLICATE_EMAIL / INVALID_STATE', wrong);

  section('SYNC CENTER — shop computer');
  const A = await login(admin.email, admin.password), M = await login(manager.email, manager.password), C = await login(cashier.email, cashier.password);
  check((await api('GET', '/api/sync/center', M)).status === 403 && (await api('GET', '/api/sync/center', C)).status === 403, 'SC2: only an Administrator opens the shop Sync Center');
  const med = await upsertFixtureMedicine(`ITEST-SC-${RUN}`, `ZZ ITEST SyncCenter ${RUN}`, 40, 15);
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm', '--medicine', med], { env: { ...process.env, APP_MODE: 'hybrid' }, encoding: 'utf-8' });
  check(boot.status === 0, 'medicine baseline queued for the cloud');
  const ev = await waitFor(async () => (await pool.query(
    `SELECT id, idempotency_key, status FROM sync_events WHERE entity_type = 'medicine' AND entity_id = $1 ORDER BY seq DESC LIMIT 1`, [med])).rows[0], (x) => x?.status === 'SYNCED');
  check(ev?.status === 'SYNCED', 'baseline event synced');
  await pool.query(`UPDATE sync_events SET status = 'FAILED', last_error = 'Rejected by cloud: medicine not found' WHERE id = $1`, [ev.id]);
  let sc = await api('GET', '/api/sync/center', A);
  const fe = sc.data?.failed_events?.find((x: any) => x.id === ev.id);
  check(sc.status === 200 && fe?.conflict === 'RECORD_NOT_FOUND' && typeof sc.data.sequence.last_seq === 'number', 'SC3: failed event listed with its conflict reason; outbox sequence shown', fe);
  check((await api('POST', `/api/sync/events/${crypto.randomUUID()}/retry`, A, {})).status === 409, 'SC4: retrying an event that is not FAILED -> 409');
  const rr = await api('POST', `/api/sync/events/${ev.id}/retry`, A, {});
  const resent = await waitFor(async () => (await pool.query('SELECT status FROM sync_events WHERE id = $1', [ev.id])).rows[0], (x) => x.status === 'SYNCED');
  const copies = await cq(`SELECT COUNT(*)::int AS n FROM giga_cloud.processed_events WHERE idempotency_key = $1`, [ev.idempotency_key]);
  check(rr.status === 200 && resent.status === 'SYNCED' && copies[0].n === 1, 'SC4: retry re-sends the SAME event (same idempotency key): synced, still ONE copy in the cloud', { copies: copies[0].n });

  section('SYNC CENTER — online (Global Admin)');
  const gaPw = `Sc-${crypto.randomBytes(10).toString('base64url')}`, saPw = `Sc-${crypto.randomBytes(10).toString('base64url')}`;
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, NULL, NULL)', [`itest-sc-global-${RUN}@itest.local`, 'ITest SC Global', 'ADMIN', hashCredential(gaPw).combined]);
  await cq('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, $5, NULL)', [`itest-sc-shopadmin-${RUN}@itest.local`, 'ITest SC Shop Admin', 'ADMIN', hashCredential(saPw).combined, env.shopId]);
  const shop2 = crypto.randomUUID();
  await cq('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shop2, `SC2${RUN}`.slice(0, 10), 'ITest SC Shop 2 (synthetic)', crypto.randomBytes(32).toString('base64url')]);
  await startOnline(env.shopId);
  const GA = (await on('POST', '/api/auth/login', null, { email: `itest-sc-global-${RUN}@itest.local`, password: gaPw })).data?.token;
  const SA = (await on('POST', '/api/auth/login', null, { email: `itest-sc-shopadmin-${RUN}@itest.local`, password: saPw })).data?.token;
  const cen = await waitFor(() => on('GET', '/api/admin/sync-center', GA), (x) => x.status === 200 && x.data.shops.some((s: any) => s.shop_id === env.shopId && s.shop_last_seq !== null));
  const s1 = cen.data?.shops?.find((s: any) => s.shop_id === env.shopId);
  check(cen.status === 200 && s1 && typeof s1.cloud_last_seq === 'number' && s1.device_id && 'installed_commit' in s1 && 'last_backup_at' in s1 && cen.data.shops.some((s: any) => s.shop_id === shop2),
    'SC5: Global Admin sees every shop: heartbeat, shop vs cloud sequence, outbox, commands, version, device, backup', s1);
  const own = await on('GET', '/api/admin/sync-center', SA);
  check(own.status === 200 && own.data.shops.length === 1 && own.data.shops[0].shop_id === env.shopId, 'SC6: a shop Administrator sees only their own shop');

  // A REJECTED price change (it changed nothing at the shop): listed with a reason, retried ONCE.
  const cmdId = crypto.randomUUID();
  const ga = (await cq(`SELECT id FROM giga_cloud.online_users WHERE lower(email) = lower($1)`, [`itest-sc-global-${RUN}@itest.local`]))[0].id;
  await cq(`INSERT INTO giga_cloud.commands (command_id, shop_id, command_type, payload, idempotency_key, status, created_by, created_by_user_id, error, acked_at, display)
            VALUES ($1, $2, 'PRICE_UPDATE', $3::jsonb, $4, 'REJECTED', 'itest', $5, 'The medicine was changed meanwhile (selling_price).', now(), '{}'::jsonb)`,
    [cmdId, env.shopId, JSON.stringify({ medicine_id: med, selling_price: 44, reason: 'ZZ ITEST retry' }), `itest-sc-${cmdId}`, ga]);
  const iss = await on('GET', '/api/admin/sync-center/issues', GA);
  const ic = iss.data?.commands?.find((x: any) => x.command_id === cmdId);
  check(iss.status === 200 && ic?.conflict === 'STALE_VERSION' && ic.already_retried === false, 'SC7: rejected command listed with conflict STALE_VERSION', ic);
  const rt = await on('POST', `/api/admin/commands/${cmdId}/retry`, GA, {});
  check(rt.status === 200 && rt.data.command_type === 'PRICE_UPDATE' && rt.data.command_id !== cmdId, 'SC8: retry queues ONE new linked command', rt.data);
  check((await on('POST', `/api/admin/commands/${cmdId}/retry`, GA, {})).status === 409, 'SC9: a second retry of the same command is refused');
  const applied = await waitFor(async () => (await cq('SELECT status FROM giga_cloud.commands WHERE command_id = $1', [rt.data?.command_id]))[0], (x) => x?.status === 'APPLIED');
  const price = Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price);
  check(applied?.status === 'APPLIED' && price === 44, 'SC10: the retried change is applied once at the shop (price 44)', { applied, price });
  const appliedTwice = await cq(`SELECT COUNT(*)::int AS n FROM giga_cloud.commands WHERE shop_id = $1 AND display->>'retry_of' = $2`, [env.shopId, cmdId]);
  check(appliedTwice[0].n === 1, 'SC10: exactly one retry exists');
  const okCmd = (await cq(`SELECT command_id FROM giga_cloud.commands WHERE shop_id = $1 AND status = 'APPLIED' LIMIT 1`, [env.shopId]))[0];
  check((await on('POST', `/api/admin/commands/${okCmd.command_id}/retry`, GA, {})).status === 409, 'SC11: an APPLIED command can never be retried');

  // SYNC_RETRY_FAILED: the online Administrator asks the shop to re-send its failed events.
  await pool.query(`UPDATE sync_events SET status = 'FAILED', last_error = 'Rejected by cloud: itest' WHERE id = $1`, [ev.id]);
  const q = await on('POST', '/api/admin/commands/sync-retry-failed', GA, { reason: 'ZZ ITEST sync center' });
  const done = await waitFor(async () => (await cq('SELECT status, result FROM giga_cloud.commands WHERE command_id = $1', [q.data?.command_id]))[0], (x) => x?.status === 'APPLIED');
  const back = await waitFor(async () => (await pool.query('SELECT status FROM sync_events WHERE id = $1', [ev.id])).rows[0], (x) => x.status === 'SYNCED');
  const copies2 = await cq(`SELECT COUNT(*)::int AS n FROM giga_cloud.processed_events WHERE idempotency_key = $1`, [ev.idempotency_key]);
  check(q.status === 202 && done?.status === 'APPLIED' && Number(done.result?.requeued) >= 1 && back.status === 'SYNCED' && copies2[0].n === 1,
    'SC12: SYNC_RETRY_FAILED from the online app re-sends the failed event once (still one cloud copy)', { done, copies: copies2[0].n });
  check((await on('GET', '/api/admin/sync-center', null)).status === 401, 'SC13: anonymous -> 401');
  await stopSyncCenterOnline();
}
