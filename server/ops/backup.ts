import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { pgPool, getDatabaseConnectionConfig } from '../db/client';

/**
 * PostgreSQL backups with pg_dump (custom format). Never restores anything.
 *
 *  - file: <BACKUP_DIR>/<database>_<YYYY-MM-DD_HHmmss>.dump (Africa/Nairobi time), written as
 *    .partial first and renamed only after verification (pg_restore --list must succeed)
 *  - keeps the newest BACKUP_KEEP files of this database (only files matching that pattern)
 *  - every attempt is recorded in backup_runs and appended to logs/backup.log
 *  - the database password is passed to pg_dump through PGPASSWORD, never on the command line
 *  - one backup at a time per database (advisory lock)
 */
const LOCK_KEY = 7_420_317_003;

export interface BackupConfig {
  enabled: boolean;
  dir: string;
  keep: number;
  time: string;
  pgBinDir: string | null;
}

export function getBackupConfig(): BackupConfig {
  const keep = Number(process.env.BACKUP_KEEP);
  const time = (process.env.BACKUP_TIME || '21:00').trim();
  return {
    enabled: String(process.env.BACKUP_ENABLED || '').toLowerCase() === 'true',
    dir: path.resolve(process.env.BACKUP_DIR || 'backups'),
    keep: Number.isInteger(keep) && keep > 0 ? Math.min(keep, 365) : 14,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '21:00',
    pgBinDir: process.env.PG_BIN_DIR?.trim() || null,
  };
}

/** Locates a PostgreSQL client binary: PG_BIN_DIR, newest C:\Program Files\PostgreSQL\<v>\bin, or PATH. */
export function findPgBinary(name: 'pg_dump' | 'pg_restore'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const cfg = getBackupConfig();
  if (cfg.pgBinDir) return path.join(cfg.pgBinDir, exe);
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    try {
      const versions = fs.readdirSync(base).filter((v) => fs.existsSync(path.join(base, v, 'bin', exe)))
        .sort((a, b) => Number(b) - Number(a));
      if (versions[0]) return path.join(base, versions[0], 'bin', exe);
    } catch {
      /* fall through to PATH */
    }
  }
  return exe;
}

export function connectionParams() {
  const c: any = getDatabaseConnectionConfig();
  if (c.connectionString) {
    const u = new URL(c.connectionString);
    return {
      host: u.hostname, port: String(u.port || 5432), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      ssl: Boolean(c.ssl),
    };
  }
  return { host: c.host, port: String(c.port), user: c.user, password: c.password, database: c.database, ssl: Boolean(c.ssl) };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err.message) }));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function log(line: string) {
  try {
    fs.mkdirSync(path.resolve('logs'), { recursive: true });
    fs.appendFileSync(path.resolve('logs', 'backup.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break a backup */
  }
}

export type BackupTrigger = 'SCHEDULED' | 'MANUAL' | 'CLI' | 'PRE_UPGRADE';

export async function runBackup(trigger: BackupTrigger, overrides: { dir?: string; keep?: number } = {}) {
  const cfg = getBackupConfig();
  const dir = path.resolve(overrides.dir || cfg.dir);
  const keep = overrides.keep || cfg.keep;
  const conn = connectionParams();
  const started = Date.now();
  const lockClient = await pgPool.connect();
  let runId: string | null = null;
  try {
    if (!(await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok) {
      throw new Error('Another backup is already running.');
    }
    runId = (await pgPool.query(
      `INSERT INTO backup_runs (trigger, status, database_name) VALUES ($1, 'RUNNING', $2) RETURNING id`, [trigger, conn.database])).rows[0].id;
    const stamp = (await pgPool.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD_HH24MISS') AS s`)).rows[0].s;
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${conn.database}_${stamp}.dump`);
    const partial = `${finalPath}.partial`;
    const env = { ...process.env, PGPASSWORD: conn.password, PGSSLMODE: conn.ssl ? 'require' : 'prefer' };

    const dump = await run(findPgBinary('pg_dump'), ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-Fc', '-f', partial], env);
    if (dump.code !== 0) throw new Error(`pg_dump failed (exit ${dump.code}): ${dump.stderr.trim().slice(0, 500)}`);
    const size = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (size <= 0) throw new Error('pg_dump produced an empty file.');
    const list = await run(findPgBinary('pg_restore'), ['--list', partial], env);
    const tocEntries = list.stdout.split('\n').filter((l) => /^\d+;/.test(l)).length;
    if (list.code !== 0 || tocEntries === 0) throw new Error(`Backup verification failed (pg_restore --list exit ${list.code}).`);
    fs.renameSync(partial, finalPath);

    // Retention: newest `keep` files of THIS database only.
    const pattern = new RegExp(`^${conn.database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{4}-\\d{2}-\\d{2}_\\d{6}\\.dump$`);
    const files = fs.readdirSync(dir).filter((f) => pattern.test(f)).sort().reverse();
    const removed: string[] = [];
    for (const f of files.slice(keep)) {
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    }
    const duration = Date.now() - started;
    await pgPool.query(
      `UPDATE backup_runs SET status = 'SUCCESS', file_path = $2, size_bytes = $3, duration_ms = $4, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId, finalPath, size, duration]
    );
    log(`SUCCESS ${trigger} ${finalPath} ${size} bytes ${duration} ms toc=${tocEntries} pruned=${removed.length}`);
    return { success: true as const, id: runId, file: finalPath, size_bytes: size, duration_ms: duration, toc_entries: tocEntries, pruned: removed };
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 1000);
    if (runId) {
      await pgPool.query(`UPDATE backup_runs SET status = 'FAILED', error = $2, duration_ms = $3, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [runId, msg, Date.now() - started]).catch(() => {});
    }
    log(`FAILED ${trigger} ${msg}`);
    return { success: false as const, id: runId, error: msg };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
    // Leftover partial files from a failed attempt are removed.
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.dump.partial')) fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

export async function getBackupStatus() {
  const cfg = getBackupConfig();
  const last = (await pgPool.query(`SELECT * FROM backup_runs WHERE status = 'SUCCESS' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  const lastAttempt = (await pgPool.query(`SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  const ageHours = last?.finished_at ? Math.round(((Date.now() - new Date(last.finished_at).getTime()) / 3_600_000) * 10) / 10 : null;
  return {
    enabled: cfg.enabled,
    schedule_time: cfg.time,
    keep: cfg.keep,
    location: cfg.dir,
    last_success_at: last?.finished_at ? new Date(last.finished_at).toISOString() : null,
    last_success_file: last?.file_path ? path.basename(last.file_path) : null,
    last_success_size_bytes: last?.size_bytes ? Number(last.size_bytes) : null,
    age_hours: ageHours,
    last_attempt_status: lastAttempt?.status || null,
    last_error: lastAttempt?.status === 'FAILED' ? lastAttempt.error : null,
    last_error_at: lastAttempt?.status === 'FAILED' && lastAttempt.finished_at ? new Date(lastAttempt.finished_at).toISOString() : null,
  };
}

/** Server-side daily schedule (BACKUP_ENABLED=true): one SCHEDULED backup per Nairobi day after BACKUP_TIME. */
let backupTimer: NodeJS.Timeout | null = null;
export function startBackupScheduler() {
  const cfg = getBackupConfig();
  if (!cfg.enabled || backupTimer) return;
  console.log(`[Backup] Daily backup scheduled at ${cfg.time} Africa/Nairobi -> ${cfg.dir} (keep ${cfg.keep}).`);
  const tick = async () => {
    try {
      const now = (await pgPool.query(
        `SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'HH24:MI') AS t,
                EXISTS (SELECT 1 FROM backup_runs WHERE trigger = 'SCHEDULED' AND status IN ('SUCCESS', 'RUNNING')
                          AND (started_at AT TIME ZONE 'Africa/Nairobi')::date = (now() AT TIME ZONE 'Africa/Nairobi')::date) AS done,
                (SELECT COUNT(*) FROM backup_runs WHERE trigger = 'SCHEDULED' AND status = 'FAILED'
                   AND started_at > now() - interval '1 hour')::int AS recent_failures`)).rows[0];
      // After a failure, retry at most once per 20 minutes (3 per hour).
      if (now.t >= cfg.time && !now.done && now.recent_failures < 3) {
        const r = await runBackup('SCHEDULED');
        console.log(r.success ? `[Backup] Scheduled backup OK: ${path.basename(r.file)}` : `[Backup] Scheduled backup FAILED: ${r.error}`);
      }
    } catch (err: any) {
      console.warn('[Backup] Scheduler check failed:', err?.message || err);
    }
  };
  backupTimer = setInterval(() => void tick(), 20 * 60_000);
  backupTimer.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
}
