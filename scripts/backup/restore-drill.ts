import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import pg from 'pg';
import { connectionParams, findPgBinary, getBackupConfig } from '../../server/ops/backup';

/**
 * RESTORE DRILL — proves a backup can really be restored, WITHOUT touching any live database.
 *
 *   npm run backup:restore-drill                        newest verified *.dump in BACKUP_DIR
 *   npm run backup:restore-drill -- --dump <file.dump>  a specific archive
 *   ... --compare-db <name>                             compare counts with that database (read only)
 *   ... --keep                                          keep the temporary database (inspection)
 *
 * 1. pg_restore --list must read the archive.
 * 2. A NEW database named giga_restore_drill_<timestamp> is created (any other name is refused, and the
 *    drill refuses to run if that name already exists). Nothing is ever restored over giga_chemist or
 *    the configured database.
 * 3. pg_restore into it; then schema checks (schema_migrations, core tables) and critical counts
 *    (users, medicines, medicine_batches, sales, sale_items, payments, inventory_movements, audit_logs),
 *    integrity spot checks (orphans, negative stock), optionally compared with --compare-db
 *    (the restored copy may be OLDER than the live one: counts must not EXCEED it).
 * 4. The temporary database is dropped (unless --keep). A JSON report is written to logs/.
 */
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keep = args.includes('--keep');

function newestDump(dir: string): string | null {
  const files: { f: string; t: number }[] = [];
  for (const d of [dir, path.join(dir, 'weekly')]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.dump')) files.push({ f: path.join(d, f), t: fs.statSync(path.join(d, f)).mtimeMs });
  }
  files.sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

const CRITICAL = ['users', 'medicines', 'medicine_batches', 'sales', 'sale_items', 'payments', 'inventory_movements', 'audit_logs'];

async function counts(client: pg.Client) {
  const out: Record<string, number | null> = {};
  for (const t of CRITICAL) {
    try { out[t] = Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM ${t}`)).rows[0].n); } catch { out[t] = null; }
  }
  return out;
}

async function main() {
  const cp = connectionParams();
  const dump = opt('--dump') ? path.resolve(opt('--dump')!) : newestDump(getBackupConfig().dir);
  if (!dump || !fs.existsSync(dump)) throw new Error(`No backup archive found (${dump || getBackupConfig().dir}).`);
  const env = { ...process.env, PGPASSWORD: cp.password, PGSSLMODE: cp.ssl ? 'require' : 'prefer' };
  const report: Record<string, any> = { started_at: new Date().toISOString(), archive: path.basename(dump), archive_bytes: fs.statSync(dump).size,
    archive_sha256: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex') };

  const list = spawnSync(findPgBinary('pg_restore'), ['--list', dump], { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) throw new Error(`pg_restore --list cannot read the archive: ${String(list.stderr).slice(0, 300)}`);
  report.toc_entries = list.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;

  const target = `giga_restore_drill_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  if (!/^giga_restore_drill_\d{14}$/.test(target) || target === cp.database || target === 'giga_chemist') throw new Error('Refusing: unsafe drill database name.');
  report.drill_database = target;
  const admin = new pg.Client({ host: cp.host, port: Number(cp.port), user: cp.user, password: cp.password, database: 'postgres' });
  await admin.connect();
  try {
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])).rows[0]) throw new Error(`Refusing: ${target} already exists.`);
    await admin.query(`CREATE DATABASE ${target}`);
    const t0 = Date.now();
    const rs = spawnSync(findPgBinary('pg_restore'), ['--no-owner', '--no-privileges', '-h', cp.host, '-p', String(cp.port), '-U', cp.user, '-d', target, dump],
      { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    report.restore_ms = Date.now() - t0;
    report.restore_exit_code = rs.status;
    report.restore_errors = String(rs.stderr || '').split('\n').filter((l) => /error/i.test(l)).slice(0, 10);

    const drill = new pg.Client({ host: cp.host, port: Number(cp.port), user: cp.user, password: cp.password, database: target });
    await drill.connect();
    try {
      report.schema = {
        latest_migration: (await drill.query(`SELECT MAX(version) AS v FROM schema_migrations`).catch(() => ({ rows: [{ v: null }] }))).rows[0].v,
        migrations: Number((await drill.query(`SELECT COUNT(*) AS n FROM schema_migrations`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n),
        missing_tables: [] as string[],
      };
      for (const t of CRITICAL) if (!(await drill.query(`SELECT to_regclass($1) AS r`, [t])).rows[0].r) report.schema.missing_tables.push(t);
      report.counts = await counts(drill);
      report.integrity = (await drill.query(`
        SELECT (SELECT COUNT(*) FROM sale_items i WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = i.sale_id))::int AS orphan_sale_items,
               (SELECT COUNT(*) FROM payments p WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p.sale_id))::int AS orphan_payments,
               (SELECT COUNT(*) FROM medicine_batches b WHERE NOT EXISTS (SELECT 1 FROM medicines m WHERE m.id = b.medicine_id))::int AS orphan_batches,
               (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available < 0)::int AS negative_batches,
               (SELECT COUNT(*) FROM users WHERE active)::int AS active_users`)).rows[0];
    } finally {
      await drill.end();
    }
    const cmp = opt('--compare-db');
    if (cmp) {
      if (cmp === target) throw new Error('compare-db must be another database');
      const live = new pg.Client({ host: cp.host, port: Number(cp.port), user: cp.user, password: cp.password, database: cmp });
      await live.connect();
      try {
        await live.query('BEGIN READ ONLY');
        report.compare_db = cmp;
        report.compare_counts = await counts(live);
        await live.query('ROLLBACK');
      } finally {
        await live.end();
      }
      report.counts_not_exceeding_live = CRITICAL.every((t) => report.counts[t] === null || report.compare_counts[t] === null || report.counts[t] <= report.compare_counts[t]);
    }
    report.passed = rs.status === 0 && report.schema.missing_tables.length === 0 && report.counts.users > 0 && report.counts.medicines > 0
      && report.integrity.orphan_sale_items === 0 && report.integrity.orphan_payments === 0 && report.integrity.orphan_batches === 0
      && report.integrity.negative_batches === 0 && report.counts_not_exceeding_live !== false;
  } finally {
    if (!keep) {
      await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`).catch((e) => { report.drop_error = String(e.message); });
      report.drill_database_dropped = !report.drop_error;
    }
    await admin.end();
  }
  report.finished_at = new Date().toISOString();
  fs.mkdirSync(path.resolve('logs'), { recursive: true });
  const file = path.resolve('logs', `restore-drill-${report.started_at.replace(/\D/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nRESTORE DRILL: ${report.passed ? 'PASS' : 'FAIL'}  (report ${path.relative(process.cwd(), file)})`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((e) => {
  console.error('RESTORE DRILL: FAIL -', e?.message || e);
  process.exitCode = 1;
});
