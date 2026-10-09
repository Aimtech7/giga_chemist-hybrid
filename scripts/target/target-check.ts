import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pg from 'pg';
import { spawnSync } from 'child_process';

/**
 * Checks used by TARGET-RUN\run*.ps1 on the pharmacy PC. Prints PASS / FAIL / WARN lines, never a
 * secret value, and exits 1 on any FAIL.
 *
 *   node --import tsx scripts/target/target-check.ts <mode>
 *     preflight        .env sanity + database giga_chemist reachable + business-data counts saved
 *     counts-compare   business data after migrations is still all there (>= the saved counts)
 *     cloud            cloud reachable, shop token authenticates (gc_ping), identity consistent
 *     bootstrap-guard  everything required before the ONE-TIME cloud baseline
 *     sync-wait        waits until the outbox is delivered; fails on rejected events
 *     final            final remote-readiness summary
 */
const PRODUCTION_SHOP_ID = 'c2a176c8-a50f-456f-a370-225c11d2e32f';
const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, 'logs', 'runtime');
const COUNTS_FILE = path.join(RUNTIME, 'install-baseline-counts.json');
const BUSINESS_TABLES = ['medicines', 'medicine_batches', 'sales', 'sale_items', 'payments', 'inventory_movements', 'returns', 'purchases', 'users', 'customers', 'suppliers', 'expenses'];

let failed = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failed++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m: string) => console.log(`  WARN  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

function readEnv(file: string): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(path.join(ROOT, file)));
  } catch {
    return {};
  }
}
const ENV = readEnv('.env');
const ONLINE = readEnv('.env.online');
const PLACEHOLDER = /REQUIRED_USER_INPUT|YOUR_|PLACEHOLDER|CHANGE_?ME|your-project/i;

/** Same precedence as the server (server/db/client.ts): LOCAL_DATABASE_URL / DATABASE_URL, else DB_*. */
const CONN = ENV.LOCAL_DATABASE_URL || ENV.DATABASE_URL || '';
function dbConfig(): pg.ClientConfig {
  if (CONN) return { connectionString: CONN, ssl: String(ENV.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000 };
  return {
    host: ENV.DB_HOST || '127.0.0.1', port: Number(ENV.DB_PORT || 5432), database: ENV.DB_NAME || 'giga_chemist', user: ENV.DB_USER || 'postgres',
    password: ENV.DB_PASSWORD, ssl: String(ENV.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000,
  };
}
function connDbName(): string {
  try {
    return decodeURIComponent(new URL(CONN).pathname.slice(1));
  } catch {
    return '';
  }
}
function connHost(): string {
  try {
    return new URL(CONN).hostname;
  } catch {
    return '';
  }
}

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(dbConfig());
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function counts(c: pg.Client) {
  const out: Record<string, number> = {};
  for (const t of BUSINESS_TABLES) {
    const exists = (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`])).rows[0].ok;
    if (exists) out[t] = Number((await c.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

function envChecks(strict = true) {
  const dbName = CONN ? connDbName() : ENV.DB_NAME || 'giga_chemist';
  if (CONN && ENV.DB_NAME && ENV.DB_NAME !== dbName) fail(`DB_NAME (${ENV.DB_NAME}) and the database URL (${dbName}) disagree`);
  if (CONN && !['127.0.0.1', 'localhost', '::1'].includes(connHost())) fail('the local database URL must point to this PC (127.0.0.1)');
  if (!fs.existsSync(path.join(ROOT, '.env'))) fail('.env is missing');
  else pass('.env present');
  if (!fs.existsSync(path.join(ROOT, '.env.online'))) (strict ? fail : warn)('.env.online is missing');
  else pass('.env.online present');
  dbName === 'giga_chemist' ? pass('database name = giga_chemist') : fail(`database name is "${dbName}" (must be giga_chemist)`);
  for (const k of ['DATABASE_URL', 'LOCAL_DATABASE_URL']) if ((ENV[k] || '').includes('giga_chemist_dev')) fail(`${k} points to giga_chemist_dev`);
  ENV.APP_MODE === 'hybrid' ? pass('APP_MODE=hybrid') : fail(`APP_MODE=${ENV.APP_MODE || '(empty)'} (must be hybrid)`);
  String(ENV.SYNC_ENABLED).toLowerCase() === 'true' ? pass('SYNC_ENABLED=true') : fail('SYNC_ENABLED is not true');
  ENV.SHOP_ID === PRODUCTION_SHOP_ID ? pass(`SHOP_ID = production shop (${PRODUCTION_SHOP_ID})`) : fail('SHOP_ID is not the production shop id');
  (ENV.SYNC_SHOP_TOKEN || '').length >= 32 && !PLACEHOLDER.test(ENV.SYNC_SHOP_TOKEN) ? pass('SYNC_SHOP_TOKEN present (value not shown)') : fail('SYNC_SHOP_TOKEN missing or too short');
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(ENV.SUPABASE_URL || '') ? pass('SUPABASE_URL set (https)') : fail('SUPABASE_URL missing / not a Supabase https URL');
  (ENV.SUPABASE_ANON_KEY || '').length > 20 && !PLACEHOLDER.test(ENV.SUPABASE_ANON_KEY) ? pass('SUPABASE_ANON_KEY present (value not shown)') : fail('SUPABASE_ANON_KEY missing');
  (ENV.JWT_SECRET || '').length >= 32 && !PLACEHOLDER.test(ENV.JWT_SECRET) ? pass('JWT_SECRET present (value not shown)') : fail('JWT_SECRET missing or shorter than 32 characters');
  if (ENV.VITE_API_URL && (PLACEHOLDER.test(ENV.VITE_API_URL) || /vercel\.app/.test(ENV.VITE_API_URL))) fail('VITE_API_URL must be empty on the pharmacy PC');
  for (const k of ['ALLOW_DEV_STOCK_RESET', 'ONLINE_ALLOW_LOCAL_DB', 'CLOUD_EMULATOR_DB']) if (ENV[k] && ENV[k] !== 'false') fail(`development flag ${k} must not be set`);
  String(ENV.BACKUP_ENABLED).toLowerCase() === 'true' ? pass(`automatic backups enabled (dir ${ENV.BACKUP_DIR || 'backups'})`) : fail('BACKUP_ENABLED is not true');
  (ENV.UPDATE_BRANCH || 'production') === 'production' ? pass('UPDATE_BRANCH=production') : fail(`UPDATE_BRANCH=${ENV.UPDATE_BRANCH}`);
}

async function preflight() {
  console.log('Configuration');
  envChecks();
  console.log('Database');
  try {
    await withDb(async (c) => {
      const db = (await c.query('SELECT current_database() AS d, version() AS v')).rows[0];
      db.d === 'giga_chemist' ? pass(`connected to ${db.d}`) : fail(`connected to ${db.d} (must be giga_chemist)`);
      info(String(db.v).split(',')[0]);
      const n = await counts(c);
      if (!n.medicines || !n.sales) fail(`giga_chemist looks empty (medicines ${n.medicines ?? 0}, sales ${n.sales ?? 0}) - wrong database?`);
      else pass(`real data present: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      const ident = (await c.query(`SELECT to_regclass('public.shop_identity') IS NOT NULL AS ok`)).rows[0].ok
        ? (await c.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0]?.shop_id : null;
      info(`local shop identity: ${ident || 'not created yet (created by migrations)'}`);
      fs.mkdirSync(RUNTIME, { recursive: true });
      fs.writeFileSync(COUNTS_FILE, JSON.stringify({ at: new Date().toISOString(), counts: n }, null, 2));
      info(`business-data counts saved to logs\\runtime\\install-baseline-counts.json`);
    });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/password authentication failed/i.test(msg)) fail('PostgreSQL rejected the password: copy DB_PASSWORD from the previous installation .env into C:\\GIGA-CHEMIST-POS\\.env');
    else if (/does not exist/i.test(msg)) fail('database giga_chemist does not exist on this PC');
    else fail(`cannot connect to PostgreSQL: ${msg.replace(/postgres(ql)?:\/\/\S+/g, '[hidden]').slice(0, 200)}`);
  }
}

async function countsCompare() {
  if (!fs.existsSync(COUNTS_FILE)) return fail('no saved counts (run1 must pass first)');
  const before = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf-8')).counts as Record<string, number>;
  await withDb(async (c) => {
    if ((await c.query('SELECT current_database() AS d')).rows[0].d !== 'giga_chemist') return fail('not connected to giga_chemist');
    const after = await counts(c);
    for (const [t, n] of Object.entries(before)) {
      (after[t] ?? -1) >= n ? pass(`${t}: ${n} -> ${after[t]}`) : fail(`${t}: ${n} -> ${after[t] ?? 'missing'} (rows lost!)`);
    }
  });
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${ENV.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ENV.SUPABASE_ANON_KEY, Authorization: `Bearer ${ENV.SUPABASE_ANON_KEY}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, body };
}

async function localQueue(c: pg.Client) {
  if (!(await c.query(`SELECT to_regclass('public.sync_events') IS NOT NULL AS ok`)).rows[0].ok) return null;
  return (await c.query(`SELECT COUNT(*) FILTER (WHERE status IN ('PENDING','PROCESSING'))::int AS pending, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                                COUNT(*) FILTER (WHERE status = 'SYNCED')::int AS synced,
                                COUNT(*) FILTER (WHERE event_type = 'MEDICINE_BASELINE')::int AS baselines FROM sync_events`)).rows[0];
}

async function cloud() {
  console.log('Configuration');
  envChecks();
  console.log('Cloud');
  try {
    const r = await rpc('gc_ping', { p_shop_id: ENV.SHOP_ID, p_token: ENV.SYNC_SHOP_TOKEN });
    if (r.status === 200 && r.body?.ok) pass('Supabase reachable, shop SHOP1 registered, shop token authenticates (gc_ping)');
    else if (r.status === 403 || /authentication failed/.test(JSON.stringify(r.body))) fail('the cloud refused the shop id / token (wrong SYNC_SHOP_TOKEN or shop not registered)');
    else if (r.status === 401) fail('the cloud refused SUPABASE_ANON_KEY');
    else fail(`unexpected cloud answer HTTP ${r.status}`);
    const hb = await rpc('gc_heartbeat', { p_shop_id: '00000000-0000-0000-0000-000000000000', p_token: 'x'.repeat(40), p_status: {} });
    hb.status === 403 || hb.status === 400 ? pass('cloud migration 004 present (heartbeat endpoint answers)') : hb.status === 404 ? fail('cloud migration 004 missing (no gc_heartbeat)') : warn(`heartbeat probe HTTP ${hb.status}`);
  } catch (err: any) {
    fail(`cloud unreachable: ${String(err?.cause?.code || err?.message || err).slice(0, 120)} (internet?)`);
  }
  console.log('Local identity / queue');
  await withDb(async (c) => {
    const ident = (await c.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0]?.shop_id;
    const q = await localQueue(c);
    if (!ident) return fail('shop_identity missing (run3 must apply migrations first)');
    if (ident === ENV.SHOP_ID) pass('local shop identity = SHOP_ID');
    else if (!q || q.synced === 0) pass(`local identity ${ident} will be replaced by SHOP_ID on first start (nothing synced yet: safe)`);
    else fail(`local identity ${ident} differs from SHOP_ID and ${q.synced} event(s) were already synced under it: STOP and contact the developer`);
    if (q) info(`local outbox: pending ${q.pending}, synced ${q.synced}, failed ${q.failed}, baseline events ${q.baselines}`);
    if (q?.failed) fail(`${q.failed} outbox event(s) FAILED earlier`);
  });
}

async function health() {
  const port = Number(ENV.PORT || 3000) || 3000;
  const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(8000) });
  return r.json();
}

async function bootstrapGuard() {
  console.log('Configuration');
  envChecks();
  console.log('Database / server / cloud');
  await withDb(async (c) => {
    const d = (await c.query('SELECT current_database() AS d')).rows[0].d;
    d === 'giga_chemist' && d !== 'giga_chemist_dev' ? pass('connected to giga_chemist') : fail(`connected to ${d}`);
    const m = Number((await c.query(`SELECT COUNT(*) n FROM medicines`)).rows[0].n);
    const b = Number((await c.query(`SELECT COUNT(*) n FROM medicine_batches WHERE quantity_available > 0`)).rows[0].n);
    m > 0 ? pass(`${m} medicines`) : fail('no medicines in giga_chemist');
    b > 0 ? pass(`${b} batches with stock`) : fail('no stocked batches in giga_chemist');
    const q = await localQueue(c);
    if (q?.baselines) fail(`the cloud baseline was already queued (${q.baselines} baseline events). Bootstrap runs ONCE; contact the developer.`);
    else pass('no previous baseline');
    if (q?.failed) fail(`${q.failed} failed outbox events exist`);
    const ident = (await c.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0]?.shop_id;
    ident === PRODUCTION_SHOP_ID ? pass('local shop identity = production SHOP_ID') : fail(`local shop identity ${ident} is not the production shop (is the GIGA service running? it adopts SHOP_ID at start)`);
  });
  if (fs.existsSync(path.join(RUNTIME, 'bootstrap-done.json'))) fail('bootstrap-done marker exists: bootstrap already ran on this PC');
  try {
    const h = await health();
    h?.database?.connected && h.app_mode === 'hybrid' && h.sync_worker?.enabled ? pass('GIGA server healthy, hybrid, sync worker running') : fail('GIGA server not healthy / not hybrid / sync worker not running');
  } catch {
    fail('GIGA server not answering on the local port (run5 must have installed and started it)');
  }
  try {
    const r = await rpc('gc_ping', { p_shop_id: ENV.SHOP_ID, p_token: ENV.SYNC_SHOP_TOKEN });
    r.status === 200 ? pass('cloud reachable and shop authenticated') : fail(`cloud ping HTTP ${r.status}`);
  } catch {
    fail('cloud unreachable');
  }
}

async function syncWait() {
  const deadline = Date.now() + (Number(process.argv[3]) || 30) * 60_000;
  let last = '';
  for (;;) {
    const q = await withDb(localQueue);
    const line = `pending ${q.pending}, synced ${q.synced}, failed ${q.failed}`;
    if (line !== last) info(`${new Date().toLocaleTimeString()}  ${line}`);
    last = line;
    if (q.failed > 0) return fail(`${q.failed} event(s) were REJECTED by the cloud - stop and contact the developer`);
    if (q.pending === 0) return pass(`all events delivered (synced ${q.synced})`);
    if (Date.now() > deadline) return fail(`still ${q.pending} pending after the wait (internet slow? run7 later shows progress)`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function finalCheck() {
  console.log('Local server');
  let h: any = null;
  try {
    h = await health();
    pass(`local API answers (mode ${h.app_mode}, version ${h.app_version}, commit ${String(h.commit || '').slice(0, 12)})`);
    h.database?.connected ? pass('PostgreSQL connected') : fail('PostgreSQL NOT connected');
    h.sync_worker?.enabled ? pass('sync worker running') : fail('sync worker not running');
  } catch {
    fail('local API not answering');
  }
  console.log('Sync / heartbeat / backups / updates');
  await withDb(async (c) => {
    const q = await localQueue(c);
    q.failed === 0 ? pass('no failed outbox events') : fail(`${q.failed} failed outbox events`);
    q.pending <= 50 ? pass(`pending uploads: ${q.pending}`) : warn(`pending uploads: ${q.pending} (still delivering?)`);
    q.baselines > 0 ? pass(`cloud baseline queued (${q.baselines} medicines)`) : fail('cloud baseline not queued (run6)');
    const st = Object.fromEntries((await c.query('SELECT key, value FROM sync_state')).rows.map((r) => [r.key, r.value]));
    const hbAge = st.last_heartbeat_at ? (Date.now() - Date.parse(st.last_heartbeat_at)) / 1000 : null;
    hbAge !== null && hbAge < 180 ? pass(`heartbeat delivered to the cloud ${Math.round(hbAge)} s ago (phone shows ONLINE)`) : fail('no recent heartbeat delivered to the cloud');
    const bk = (await c.query(`SELECT to_regclass('public.backup_runs') IS NOT NULL AS ok`)).rows[0].ok
      ? (await c.query(`SELECT status, finished_at FROM backup_runs ORDER BY started_at DESC LIMIT 1`)).rows[0] : null;
    String(ENV.BACKUP_ENABLED).toLowerCase() === 'true' ? pass(`backup schedule enabled (daily ${ENV.BACKUP_TIME || '21:00'})`) : fail('backups disabled');
    info(`last application backup: ${bk ? `${bk.status} ${bk.finished_at ? new Date(bk.finished_at).toISOString() : ''}` : 'none yet (first scheduled run tonight)'}`);
  });
  try {
    const u = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'update-state.json'), 'utf-8'));
    ['NO_UPDATE', 'UPDATE_AVAILABLE'].includes(u.status) && u.channel === 'production' ? pass(`updater sees the production channel (${u.status})`) : fail(`updater status ${u.status} (${u.message || ''})`);
  } catch {
    fail('updater has not reported yet (run5 installs it)');
  }
  console.log('Online (Vercel)');
  try {
    const r = await fetch('https://gigachem.vercel.app/api/health', { signal: AbortSignal.timeout(15000) });
    const o: any = await r.json();
    o.mode === 'online' && o.database?.connected && o.database?.shop_registered ? pass('https://gigachem.vercel.app/api/health: online, cloud DB connected, shop registered') : fail('Vercel health not OK');
  } catch {
    fail('https://gigachem.vercel.app not reachable');
  }
  if (ONLINE.DATABASE_URL && !PLACEHOLDER.test(ONLINE.DATABASE_URL)) {
    try {
      const c = new pg.Client({ connectionString: ONLINE.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
      await c.connect();
      const n = Number((await c.query('SELECT COUNT(*) n FROM giga_cloud.medicines WHERE shop_id = $1', [PRODUCTION_SHOP_ID])).rows[0].n);
      const rt = (await c.query(`SELECT EXTRACT(EPOCH FROM now() - reported_at)::int AS age FROM giga_cloud.shop_runtime_status WHERE shop_id = $1`, [PRODUCTION_SHOP_ID])).rows[0];
      await c.end();
      n > 0 ? pass(`cloud copy has ${n} medicines for this shop`) : fail('cloud copy has no medicines yet');
      rt && rt.age < 180 ? pass(`cloud sees the shop ONLINE (heartbeat ${rt.age} s ago)`) : fail('cloud has no fresh heartbeat');
    } catch {
      warn('could not query the cloud copy directly (phone check in README covers it)');
    }
  } else warn('.env.online has no cloud DATABASE_URL: cloud counts checked from the phone instead');
}

/** Verified pre-install backup with pg_dump -Fc + pg_restore --list (needs no application table). */
function pgBin(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (ENV.PG_BIN_DIR) return path.join(ENV.PG_BIN_DIR, exe);
  const base = 'C:\\Program Files\\PostgreSQL';
  try {
    const v = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'bin', exe))).sort((a, b) => Number(b) - Number(a))[0];
    if (v) return path.join(base, v, 'bin', exe);
  } catch {
    /* fall back to PATH */
  }
  return exe;
}

async function backup() {
  const dir = process.argv[3] || 'C:\\GIGA-CHEMIST-BACKUPS\\pre-install';
  const cfg: any = dbConfig();
  let p: { host: string; port: string; user: string; password: string; db: string };
  if (cfg.connectionString) {
    const u = new URL(cfg.connectionString);
    p = { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), db: decodeURIComponent(u.pathname.slice(1)) };
  } else {
    p = { host: cfg.host, port: String(cfg.port), user: cfg.user, password: cfg.password || '', db: cfg.database };
  }
  if (p.db !== 'giga_chemist') return fail(`refusing to back up "${p.db}" (expected giga_chemist)`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const file = path.join(dir, `giga_chemist_preinstall_${stamp}.dump`);
  const env = { ...process.env, PGPASSWORD: p.password };
  info(`pg_dump ${p.db} -> ${file}`);
  const d = spawnSync(pgBin('pg_dump'), ['-h', p.host, '-p', p.port, '-U', p.user, '-d', p.db, '-Fc', '-f', file], { env, encoding: 'utf-8', windowsHide: true });
  if (d.status !== 0) return fail(`pg_dump failed (exit ${d.status ?? d.error?.message}): ${String(d.stderr || '').slice(0, 300)}`);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size <= 0) return fail('pg_dump produced an empty file');
  const l = spawnSync(pgBin('pg_restore'), ['--list', file], { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const lines = String(l.stdout || '').split(/\r?\n/);
  const toc = lines.filter((x) => /^\d+;/.test(x)).length;
  if (l.status !== 0 || toc === 0) return fail(`backup verification failed (pg_restore --list exit ${l.status}, ${toc} entries)`);
  const data = lines.filter((x) => / TABLE DATA public (medicines|sales|sale_items|inventory_movements) /.test(x)).length;
  if (data >= 4) pass(`VERIFIED backup: ${(size / 1048576).toFixed(1)} MB, ${toc} TOC entries (medicines / sales / sale_items / movements data present)`);
  else fail('archive readable but business table data entries are missing');
  info(`file: ${file}`);
}


async function main() {
  const mode = process.argv[2];
  const modes: Record<string, () => Promise<void>> = {
    preflight, backup, 'counts-compare': countsCompare, cloud, 'bootstrap-guard': bootstrapGuard, 'sync-wait': syncWait, final: finalCheck,
  };
  if (!modes[mode]) throw new Error(`usage: target-check.ts ${Object.keys(modes).join('|')}`);
  await modes[mode]();
  console.log(failed ? `RESULT: FAILED (${failed} problem(s))` : 'RESULT: PASS');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.log(`  FAIL  ${String(err?.message || err).replace(/postgres(ql)?:\/\/\S+/g, '[hidden]').slice(0, 300)}`);
  console.log('RESULT: FAILED');
  process.exitCode = 1;
});
