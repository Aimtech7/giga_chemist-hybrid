import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import pg from 'pg';
import { runMigrations } from '../../server/db/migrator';
import { connectionParams, findPgBinary } from '../../server/ops/backup';

/**
 * TARGET MIGRATION REHEARSAL — proves the pending migrations upgrade a COPY of the real database
 * without losing or changing business data. It never writes to the source database.
 *
 *   npm run target:rehearse                              (source = database configured in .env)
 *   npm run target:rehearse -- --source-db giga_chemist
 *   npm run target:rehearse -- --from-dump D:\backups\giga_chemist_2026-10-07_180000.dump
 *   options: --rehearsal-db giga_chemist_migration_test   --keep (keep the rehearsal db)
 *
 * Steps: (1) invariants of the source (read-only)  (2) pg_dump the source (= pre-upgrade backup)
 * (3) restore into the rehearsal database  (4) invariants of the copy  (5) run ALL pending
 * migrations on the copy  (6) db:check on the copy  (7) invariants after  (8) compare -> PASS/FAIL.
 * A JSON report is written to logs/.
 */
const args = process.argv.slice(2);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const conn = connectionParams();
const sourceDb = opt('--source-db') || conn.database;
const fromDump = opt('--from-dump');
const rehearsalDb = opt('--rehearsal-db') || 'giga_chemist_migration_test';
const keep = args.includes('--keep');
const env = { ...process.env, PGPASSWORD: conn.password };

function fail(msg: string): never {
  console.error(`\n[REHEARSAL REFUSED] ${msg}`);
  process.exit(2);
}
if (!/^[a-z0-9_]+$/.test(rehearsalDb) || !rehearsalDb.endsWith('_migration_test')) fail('The rehearsal database name must end with _migration_test.');
if (!fromDump && rehearsalDb === sourceDb) fail('Rehearsal and source database must differ.');
if (['giga_chemist', 'giga_chemist_dev', 'postgres'].includes(rehearsalDb)) fail(`Refusing to use "${rehearsalDb}" as the rehearsal database.`);
if (fromDump && !fs.existsSync(fromDump)) fail(`Dump file not found: ${fromDump}`);

const cfgFor = (database: string) => ({ host: conn.host, port: Number(conn.port), user: conn.user, password: conn.password, database, ssl: conn.ssl ? { rejectUnauthorized: false } : undefined });
const urlFor = (database: string) =>
  `postgresql://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${database}${conn.ssl ? '?sslmode=require' : ''}`;

function run(cmd: string, a: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, a, { env: { ...env, ...extraEnv }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const COUNT_TABLES = ['medicines', 'medicine_batches', 'sales', 'sale_items', 'payments', 'purchases', 'purchase_items',
  'inventory_movements', 'users', 'returns', 'expenses', 'suppliers', 'customers', 'categories', 'audit_logs', 'devices', 'settings'];
const SUMS: [string, string, string][] = [
  ['sum_current_stock', 'medicines', 'current_stock'],
  ['sum_quantity_available', 'medicine_batches', 'quantity_available'],
  ['sum_sales_total', 'sales', 'total'],
  ['sum_payments', 'payments', 'amount'],
  ['sum_refunds', 'returns', 'refund_amount'],
  ['sum_purchases', 'purchases', 'total_amount'],
];
const HASHES: [string, string, string[], string][] = [
  ['users', 'users', ['id', 'email', 'role', 'active', 'password_hash', 'pin_hash'], 'id'],
  ['medicines', 'medicines', ['id', 'name', 'current_stock', 'selling_price', 'purchase_price', 'wholesale_price', 'reorder_level'], 'id'],
  ['batches', 'medicine_batches', ['id', 'medicine_id', 'batch_number', 'quantity_available', 'expiry_date', 'status'], 'id'],
  ['purchases', 'purchases', ['id', 'invoice_number', 'total_amount', 'status'], 'id'],
  ['returns', 'returns', ['id', 'sale_id', 'quantity', 'refund_amount', 'status'], 'id'],
];

type Snapshot = Record<string, string | number | null>;

async function snapshot(database: string, columnsFrom?: Record<string, string[]>) {
  const c = new pg.Client(cfgFor(database));
  await c.connect();
  try {
    const cols = async (t: string) =>
      (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).rows.map((r) => r.column_name);
    const exists = async (t: string) => (await cols(t)).length > 0;
    const out: Snapshot = {};
    const used: Record<string, string[]> = {};
    for (const t of COUNT_TABLES) out[`count_${t}`] = (await exists(t)) ? Number((await c.query(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n) : null;
    for (const [k, t, col] of SUMS) {
      out[k] = (await cols(t)).includes(col) ? String((await c.query(`SELECT COALESCE(SUM(${col}), 0)::text s FROM ${t}`)).rows[0].s) : null;
    }
    for (const [k, t, wanted, order] of HASHES) {
      const present = await cols(t);
      const use = (columnsFrom?.[k] || wanted).filter((x) => present.includes(x));
      used[k] = use;
      out[`hash_${k}`] = use.length
        ? (await c.query(`SELECT md5(COALESCE(string_agg(concat_ws('|', ${use.map((x) => `${x}::text`).join(', ')}), ',' ORDER BY ${order}), '')) h FROM ${t}`)).rows[0].h
        : null;
    }
    out.latest_sales = (await exists('sales'))
      ? JSON.stringify((await c.query(`SELECT id, receipt_number, total::text, status FROM sales ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 10`)).rows)
      : null;
    out.migrations = (await exists('schema_migrations'))
      ? (await c.query('SELECT string_agg(version, \',\' ORDER BY version) v FROM schema_migrations')).rows[0].v
      : '';
    return { values: out, columns: used };
  } finally {
    await c.end();
  }
}

async function main() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_');
  const report: any = { started_at: new Date().toISOString(), source: fromDump ? { dump: path.resolve(fromDump) } : { database: sourceDb }, rehearsal_db: rehearsalDb, steps: [] };
  const step = (name: string, ok: boolean, detail?: unknown) => {
    report.steps.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    return ok;
  };
  console.log(`GIGA CHEMIST — target migration rehearsal (${fromDump ? `dump ${fromDump}` : `source database ${sourceDb}`} -> ${rehearsalDb})\n`);

  let dumpFile = fromDump ? path.resolve(fromDump) : '';
  let sourceSnap: Awaited<ReturnType<typeof snapshot>> | null = null;
  if (!fromDump) {
    sourceSnap = await snapshot(sourceDb);
    step('source invariants captured (read-only)', true, { medicines: sourceSnap.values.count_medicines, sales: sourceSnap.values.count_sales });
    fs.mkdirSync(path.resolve('backups'), { recursive: true });
    dumpFile = path.resolve('backups', `${sourceDb}_pre_upgrade_${ts}.dump`);
    const d = await run(findPgBinary('pg_dump'), ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', sourceDb, '-Fc', '-f', dumpFile]);
    if (!step('pre-upgrade backup of the source (pg_dump)', d.code === 0 && fs.existsSync(dumpFile) && fs.statSync(dumpFile).size > 0, d.code === 0 ? dumpFile : d.stderr.slice(0, 300))) return finish(report, false);
  }
  const list = await run(findPgBinary('pg_restore'), ['--list', dumpFile]);
  if (!step('backup file is a readable PostgreSQL archive', list.code === 0, `${list.stdout.split('\n').filter((l) => /^\d+;/.test(l)).length} TOC entries`)) return finish(report, false);

  const admin = new pg.Client(cfgFor('postgres'));
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [rehearsalDb]);
  await admin.query(`DROP DATABASE IF EXISTS ${rehearsalDb}`);
  await admin.query(`CREATE DATABASE ${rehearsalDb}`);
  await admin.end();
  const restore = await run(findPgBinary('pg_restore'), ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', rehearsalDb, '--no-owner', '--no-privileges', dumpFile]);
  const restoreErrors = (restore.stderr.match(/^pg_restore: error:/gm) || []).length;
  if (!step('backup restored into the rehearsal database', restore.code === 0 || restoreErrors === 0, restore.code === 0 ? 'clean' : restore.stderr.slice(0, 400))) return finish(report, false);

  const before = await snapshot(rehearsalDb, sourceSnap?.columns);
  report.before = before.values;
  if (sourceSnap) {
    const diff = Object.keys(sourceSnap.values).filter((k) => sourceSnap!.values[k] !== before.values[k]);
    step('restored copy is identical to the source', diff.length === 0, diff.length ? diff : 'all invariants equal');
  }
  const migrationsDir = path.resolve('migrations');
  const allMigrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = String(before.values.migrations || '').split(',').filter(Boolean);
  const pending = allMigrations.filter((m) => !applied.includes(m));
  step('pending migrations detected', true, pending.length ? pending : 'none (already up to date)');

  const mig = await runMigrations(urlFor(rehearsalDb));
  if (!step('all migrations applied to the rehearsal copy', mig.success, mig.success ? mig.applied : String(mig.errors?.message || mig.errors))) return finish(report, false);

  const check = await run(process.execPath, ['--import', 'tsx', 'scripts/check-db.ts'], { LOCAL_DATABASE_URL: urlFor(rehearsalDb), DATABASE_URL: urlFor(rehearsalDb), DB_NAME: rehearsalDb });
  step('db:check passes on the upgraded copy', check.code === 0 && /DATABASE CHECK PASSED/.test(check.stdout), check.code === 0 ? 'PASSED' : (check.stdout + check.stderr).split('\n').filter((l) => /ERROR|WARN/.test(l)).join(' ').slice(0, 400));

  const after = await snapshot(rehearsalDb, before.columns);
  report.after = after.values;
  let ok = true;
  for (const k of Object.keys(before.values)) {
    if (k === 'migrations') continue;
    const b = before.values[k];
    const a = after.values[k];
    if (b === a) continue;
    // Migrations may ADD rows (e.g. a device registration); they must never remove history.
    const growthAllowed = k === 'count_devices' || k === 'count_audit_logs' || k === 'count_settings';
    if (growthAllowed && typeof a === 'number' && typeof b === 'number' && a >= b) continue;
    ok = step(`invariant ${k} unchanged`, false, { before: b, after: a }) && ok;
  }
  if (ok) step('business data unchanged by migrations (counts, stock sums, money sums, users, medicines, batches, purchases, returns, latest sales)', true);
  const schema = new pg.Client(cfgFor(rehearsalDb));
  await schema.connect();
  const newTables = (await schema.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
    [['sync_events', 'shop_identity', 'sync_inbound_commands', 'sync_state', 'email_jobs', 'email_settings', 'backup_runs']])).rows.map((r) => r.table_name).sort();
  const identity = (await schema.query('SELECT shop_id, shop_code FROM shop_identity WHERE id = 1').catch(() => ({ rows: [] }))).rows[0];
  await schema.end();
  step('schema after upgrade has the hybrid/email/backup tables', newTables.length === 7, newTables);
  step('shop identity created', Boolean(identity), identity ? `${identity.shop_code} ${identity.shop_id} (a NEW id is generated per database; set SHOP_ID before the first sync if the cloud already knows this shop)` : 'missing');
  return finish(report, ok && report.steps.every((s: any) => s.ok));
}

async function finish(report: any, pass: boolean) {
  report.result = pass ? 'PASS' : 'FAIL';
  report.finished_at = new Date().toISOString();
  if (!keep) {
    const admin = new pg.Client(cfgFor('postgres'));
    await admin.connect().catch(() => {});
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [rehearsalDb]).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${rehearsalDb}`).catch(() => {});
    await admin.end().catch(() => {});
  }
  fs.mkdirSync(path.resolve('logs'), { recursive: true });
  const file = path.resolve('logs', `migration-rehearsal-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nREHEARSAL ${report.result}  (report: ${file}${keep ? `; rehearsal database ${rehearsalDb} kept` : ''})`);
  process.exitCode = pass ? 0 : 1;
}

const GROWTH_ALLOWED = new Set(['count_devices', 'count_audit_logs', 'count_settings']);

/** --snapshot <file>: write the invariants of the source database (read-only). */
async function snapshotMode(file: string) {
  const s = await snapshot(sourceDb);
  fs.writeFileSync(file, JSON.stringify({ database: sourceDb, taken_at: new Date().toISOString(), ...s }, null, 2));
  console.log(`Invariants of ${sourceDb} written to ${file} (medicines ${s.values.count_medicines}, sales ${s.values.count_sales}).`);
}

/** --compare <before.json> <after.json>: business data must be unchanged (only allowed tables may grow). */
function compareMode(a: string, b: string) {
  const before = JSON.parse(fs.readFileSync(a, 'utf-8')).values;
  const after = JSON.parse(fs.readFileSync(b, 'utf-8')).values;
  const problems = Object.keys(before).filter((k) => k !== 'migrations' && before[k] !== after[k] &&
    !(GROWTH_ALLOWED.has(k) && typeof before[k] === 'number' && after[k] >= before[k]));
  for (const k of problems) console.log(`  FAIL  ${k}: before ${before[k]} after ${after[k]}`);
  console.log(problems.length ? `INVARIANTS FAIL (${problems.length})` : 'INVARIANTS PASS (business data unchanged)');
  process.exitCode = problems.length ? 1 : 0;
}

const snapOut = opt('--snapshot');
const cmpIdx = args.indexOf('--compare');
(snapOut ? snapshotMode(snapOut) : cmpIdx >= 0 ? Promise.resolve(compareMode(args[cmpIdx + 1], args[cmpIdx + 2])) : main()).catch((err) => {
  console.error('[REHEARSAL ERROR]', err?.message || err);
  process.exitCode = 1;
});
