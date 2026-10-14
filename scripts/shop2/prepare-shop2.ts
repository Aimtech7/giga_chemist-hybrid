import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import pg from 'pg';
import { connectionParams, findPgBinary } from '../../server/ops/backup';

/**
 * PREPARE A NEW SHOP DATABASE FROM A SHOP 1 DATABASE (catalogue + staff, zero stock, no history).
 *
 *   npx tsx scripts/shop2/prepare-shop2.ts --source-db giga_chemist_shop1_copy --target-db giga_chemist \
 *       [--shop-code SHOP2] [--shop-name "GIGA CHEMIST - SHOP 2"] [--shop-id <uuid>] [--replace]
 *   npx tsx scripts/shop2/prepare-shop2.ts --from-dump <shop1 backup .dump> --target-db giga_chemist ...
 *
 * The SOURCE is only read (a dump is restored into a temporary database that is dropped afterwards).
 * The TARGET is created new (refused if it exists, unless --replace, which only drops a target that
 * holds NO sales, purchases or stock movements). Copied unchanged: categories, suppliers, medicines
 * (prices, reorder levels, barcodes ...), batch records, pharmacy settings, staff accounts (ids, names,
 * logins, roles, active, password + PIN hashes). Set to zero: every batch quantity / medicine stock.
 * NOT copied: sales, payments, returns, purchases, expenses, customers, stock movements, audit,
 * shifts, stocktakes, alerts, price history, devices, outbox / inbox, sync state.
 * The new shop gets its OWN shop_identity (new shop id unless given, shop code, name).
 * Never touches the cloud. A JSON report (no secrets) is written to logs/.
 */
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const cp = connectionParams();
const target = opt('--target-db') || '';
const sourceDbArg = opt('--source-db');
const fromDump = opt('--from-dump');
const shopCode = (opt('--shop-code') || 'SHOP2').toUpperCase();
const shopName = opt('--shop-name') || 'GIGA CHEMIST - SHOP 2';
const shopId = (opt('--shop-id') || crypto.randomUUID()).toLowerCase();
const replace = args.includes('--replace');
const ident = /^[a-z][a-z0-9_]{2,62}$/;

function fail(m: string): never { console.error(`\n[PREPARE REFUSED] ${m}`); process.exit(2); }
if (!ident.test(target)) fail('--target-db must be a plain database name.');
if (!sourceDbArg && !fromDump) fail('Give --source-db <shop 1 database> or --from-dump <shop 1 backup>.');
if (sourceDbArg && !ident.test(sourceDbArg)) fail('--source-db must be a plain database name.');
if (sourceDbArg === target) fail('Source and target must differ.');
if (!/^[A-Z0-9_-]{2,20}$/.test(shopCode) || shopCode === 'SHOP1') fail('--shop-code must be a new code (not SHOP1).');
if (!/^[0-9a-f-]{36}$/.test(shopId)) fail('--shop-id must be a UUID.');

const client = (database: string) => new pg.Client({ host: cp.host, port: Number(cp.port), user: cp.user, password: cp.password, database });
const env = { ...process.env, PGPASSWORD: cp.password };

// Copied tables in dependency order, with per-row overrides.
const COPY: { table: string; zero?: Record<string, unknown> }[] = [
  { table: 'branches' },
  { table: 'categories' },
  { table: 'users' },
  { table: 'suppliers' },
  { table: 'settings' },
  { table: 'medicines', zero: { current_stock: 0 } },
  { table: 'medicine_batches', zero: { quantity_available: 0, quantity_received: 0 } },
];
const EMPTY_CHECK = ['sales', 'purchases', 'inventory_movements'];

async function columns(c: pg.Client, table: string) {
  return (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name as string);
}

async function main() {
  const report: Record<string, any> = { started_at: new Date().toISOString(), target, shop_code: shopCode, shop_name: shopName, shop_id: shopId };
  const admin = client('postgres');
  await admin.connect();
  let sourceDb = sourceDbArg!;
  let tempSource: string | null = null;
  try {
    // 1. Source (a dump is restored into a temporary database).
    if (fromDump) {
      if (!fs.existsSync(fromDump)) fail(`Dump not found: ${fromDump}`);
      tempSource = `giga_shop_source_tmp_${Date.now()}`;
      await admin.query(`CREATE DATABASE ${tempSource}`);
      const r = spawnSync(findPgBinary('pg_restore'), ['--no-owner', '--no-privileges', '-h', cp.host, '-p', String(cp.port), '-U', cp.user, '-d', tempSource, path.resolve(fromDump)], { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`pg_restore of the source dump failed: ${String(r.stderr).slice(0, 300)}`);
      sourceDb = tempSource;
      report.source = { dump: path.basename(fromDump), bytes: fs.statSync(fromDump).size };
    } else report.source = { database: sourceDb };
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [sourceDb])).rows[0]) fail(`Source database ${sourceDb} not found.`);

    // 2. Target: new (or an empty-of-business one with --replace).
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])).rows[0]) {
      if (!replace) fail(`Target ${target} already exists (use --replace only for a target with no business data).`);
      const t = client(target);
      await t.connect();
      try {
        for (const tb of EMPTY_CHECK) {
          const n = await t.query(`SELECT COUNT(*)::int AS n FROM ${tb}`).then((x) => x.rows[0].n).catch(() => 0);
          if (n > 0) fail(`Target ${target} holds ${n} ${tb} rows: refusing to replace a database with business data.`);
        }
      } finally { await t.end(); }
      await admin.query(`DROP DATABASE ${target} WITH (FORCE)`);
      report.replaced_empty_target = true;
    }
    await admin.query(`CREATE DATABASE ${target}`);

    // 3. Schema: every migration on the target.
    const url = `postgresql://${encodeURIComponent(cp.user)}:${encodeURIComponent(cp.password)}@${cp.host}:${cp.port}/${target}`;
    const mig = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-migrations.ts'], { env: { ...process.env, DATABASE_URL: url, LOCAL_DATABASE_URL: url, DB_NAME: target }, encoding: 'utf-8' });
    if (mig.status !== 0) throw new Error(`Migrations on ${target} failed: ${String(mig.stdout + mig.stderr).slice(-400)}`);

    // 4. Copy catalogue + staff (stock zeroed).
    const src = client(sourceDb), dst = client(target);
    await src.connect();
    await dst.connect();
    try {
      await src.query('BEGIN READ ONLY');
      await dst.query('BEGIN');
      // Seeded defaults of a fresh schema are replaced by Shop 1's (settings, categories, users).
      for (const { table } of [...COPY].reverse()) await dst.query(`DELETE FROM ${table}`);
      report.copied = {};
      for (const { table, zero } of COPY) {
        const sc = await columns(src, table), dc = await columns(dst, table);
        const cols = dc.filter((c) => sc.includes(c));
        const rows = (await src.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`)).rows.map((r) => {
          return { ...r, ...(zero || {}) };
        });
        for (let i = 0; i < rows.length; i += 500) {
          await dst.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')})
                           SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM json_populate_recordset(NULL::${table}, $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
        }
        report.copied[table] = rows.length;
      }
      await dst.query(`UPDATE medicines SET current_stock = 0`);
      const mainBranch = (await dst.query(`SELECT id FROM branches ORDER BY (code = 'MAIN') DESC, is_main_branch DESC LIMIT 1`)).rows[0]?.id ?? null;
      await dst.query(`UPDATE shop_identity SET shop_id = $1, shop_code = $2, shop_name = $3, branch_id = $4, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [shopId, shopCode, shopName, mainBranch]);
      // Verification inside the transaction (no secret is printed: hashes compared as digests).
      const digest = async (c: pg.Client) => (await c.query(`SELECT md5(string_agg(id::text || ':' || password_hash || ':' || COALESCE(pin_hash, '') || ':' || role || ':' || active::text, ',' ORDER BY id)) AS d FROM users`)).rows[0].d;
      const counts = async (c: pg.Client) => (await c.query(`SELECT (SELECT COUNT(*) FROM users)::int users, (SELECT COUNT(*) FROM medicines)::int medicines, (SELECT COUNT(*) FROM medicine_batches)::int batches,
          (SELECT COUNT(*) FROM categories)::int categories, (SELECT COUNT(*) FROM suppliers)::int suppliers,
          (SELECT md5(string_agg(id::text || COALESCE(selling_price::text, '') || COALESCE(wholesale_price::text, '') || COALESCE(purchase_price::text, '') || COALESCE(barcode, ''), ',' ORDER BY id)) FROM medicines) AS prices`)).rows[0];
      const s = await counts(src), d = await counts(dst);
      const biz = (await dst.query(`SELECT (SELECT COUNT(*) FROM sales)::int sales, (SELECT COUNT(*) FROM purchases)::int purchases, (SELECT COUNT(*) FROM inventory_movements)::int movements,
          (SELECT COALESCE(SUM(quantity_available), 0)::int FROM medicine_batches) batch_stock, (SELECT COALESCE(SUM(current_stock), 0)::int FROM medicines) medicine_stock`)).rows[0];
      report.verify = {
        counts_equal: ['users', 'medicines', 'batches', 'categories', 'suppliers'].every((k) => s[k] === d[k]), source: { ...s, prices: undefined }, target: { ...d, prices: undefined },
        prices_and_barcodes_equal: s.prices === d.prices, staff_credentials_equal: (await digest(src)) === (await digest(dst)), business_data: biz,
      };
      if (!report.verify.counts_equal || !report.verify.prices_and_barcodes_equal || !report.verify.staff_credentials_equal
        || biz.sales || biz.purchases || biz.movements || biz.batch_stock || biz.medicine_stock) {
        throw new Error(`Verification failed: ${JSON.stringify(report.verify)}`);
      }
      await dst.query('COMMIT');
      await src.query('ROLLBACK');
    } catch (err) {
      await dst.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await src.end();
      await dst.end();
    }
    const chk = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-db.ts'], { env: { ...process.env, DATABASE_URL: url, LOCAL_DATABASE_URL: url, DB_NAME: target }, encoding: 'utf-8' });
    report.db_check = chk.status === 0 ? 'PASSED' : `FAILED: ${String(chk.stdout + chk.stderr).slice(-300)}`;
    report.passed = chk.status === 0;
  } finally {
    if (tempSource) await admin.query(`DROP DATABASE IF EXISTS ${tempSource} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
  report.finished_at = new Date().toISOString();
  fs.mkdirSync('logs', { recursive: true });
  const file = path.join('logs', `prepare-${shopCode.toLowerCase()}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nPREPARE ${shopCode}: ${report.passed ? 'PASS' : 'FAIL'}  (report ${file})`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((e) => { console.error('PREPARE FAILED -', e?.message || e); process.exitCode = 1; });
