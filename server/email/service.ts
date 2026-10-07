import crypto from 'crypto';
import pg from 'pg';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { pgPool, getDatabaseConnectionConfig, HttpError } from '../db/client';
import { getShopIdentity } from '../sync/identity';
import { getEmailConfig, describeEmailConfig, parseRecipients, EMAIL_RE, TIME_RE } from './config';
import {
  buildDailyStockEmail, buildBusinessSummaryEmail, buildExpiryEmail, buildLowStockDigestEmail, buildTestEmail,
  type ReportType, type BuiltEmail,
} from './reports';

/**
 * Queued e-mail reports.
 *
 *   scheduler (server, every minute) -> generate report from PostgreSQL -> email_jobs (unique
 *   idempotency key, e.g. SHOP1:DAILY_STOCK:2026-10-07) -> worker -> SMTP
 *
 * Nothing here can block or fail a POS operation. SMTP/internet down: jobs stay PENDING/RETRYING
 * with backoff and are delivered automatically later. Permanent SMTP refusals (5xx) or too many
 * attempts -> FAILED (Admin can re-queue). One worker per database (advisory lock).
 */
const LEADER_LOCK_KEY = 7_420_317_002;

export interface EmailSettings {
  daily_stock_enabled: boolean;
  business_summary_enabled: boolean;
  expiry_report_enabled: boolean;
  low_stock_digest_enabled: boolean;
  stock_report_time: string;
  business_report_time: string;
  expiry_report_time: string;
  expiry_report_weekday: number;
  low_stock_digest_time: string;
  recipients: string | null;
  include_low_stock: boolean;
  include_expiry: boolean;
  updated_at?: string;
}

export async function getEmailSettings(): Promise<EmailSettings & { effective_recipients: string[] }> {
  const row = (await pgPool.query('SELECT * FROM email_settings WHERE id = 1')).rows[0];
  if (!row) throw new Error('email_settings row missing; run npm run db:migrate.');
  const cfg = getEmailConfig();
  const recipients = row.recipients ? parseRecipients(row.recipients) : cfg.defaultRecipients;
  return { ...row, effective_recipients: recipients };
}

const BOOL_FIELDS = ['daily_stock_enabled', 'business_summary_enabled', 'expiry_report_enabled', 'low_stock_digest_enabled', 'include_low_stock', 'include_expiry'] as const;
const TIME_FIELDS = ['stock_report_time', 'business_report_time', 'expiry_report_time', 'low_stock_digest_time'] as const;

export async function updateEmailSettings(input: Record<string, unknown>, actor: { user_id: string; user_name: string; role: string; device_id?: string }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  for (const f of BOOL_FIELDS) {
    if (input[f] === undefined) continue;
    if (typeof input[f] !== 'boolean') throw new HttpError(400, `${f} must be true or false.`);
    push(f, input[f]);
  }
  for (const f of TIME_FIELDS) {
    if (input[f] === undefined) continue;
    if (typeof input[f] !== 'string' || !TIME_RE.test(input[f] as string)) throw new HttpError(400, `${f} must be HH:MM (24h).`);
    push(f, input[f]);
  }
  if (input.expiry_report_weekday !== undefined) {
    const d = Number(input.expiry_report_weekday);
    if (!Number.isInteger(d) || d < 1 || d > 7) throw new HttpError(400, 'expiry_report_weekday must be 1 (Monday) to 7 (Sunday).');
    push('expiry_report_weekday', d);
  }
  if (input.recipients !== undefined) {
    if (input.recipients === null || input.recipients === '') push('recipients', null);
    else {
      const list = parseRecipients(input.recipients);
      const bad = list.filter((r) => !EMAIL_RE.test(r));
      if (bad.length || list.length === 0) throw new HttpError(400, `Invalid recipient e-mail address(es): ${bad.join(', ') || '(none given)'}.`);
      if (list.length > 20) throw new HttpError(400, 'At most 20 recipients.');
      push('recipients', list.join(', '));
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'No e-mail settings were provided.');
  const before = (await pgPool.query('SELECT * FROM email_settings WHERE id = 1')).rows[0];
  vals.push(actor.user_id);
  await pgPool.query(`UPDATE email_settings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP, updated_by = $${vals.length} WHERE id = 1`, vals);
  const { recordAuditLog } = await import('../db/audit');
  const after = await getEmailSettings();
  await recordAuditLog({
    user_id: actor.user_id, user_name: actor.user_name, role: actor.role as any, device_id: actor.device_id || 'SERVER',
    action: 'EMAIL_SETTINGS_UPDATED', entity: 'email_settings', entity_id: '1',
    previous_value: before, new_value: after,
  });
  emailWorker.wake();
  return after;
}

// ---------------------------------------------------------------------------- queue
export async function businessDate(): Promise<{ date: string; time: string; isoDow: number }> {
  const cfg = getEmailConfig();
  const r = (await pgPool.query(
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE $1, 'HH24:MI') AS t,
            EXTRACT(ISODOW FROM now() AT TIME ZONE $1)::int AS dow`, [cfg.timezone])).rows[0];
  return { date: r.d, time: r.t, isoDow: r.dow };
}

export async function buildReport(type: ReportType, date: string, extra: { requestedBy?: string } = {}): Promise<BuiltEmail> {
  const cfg = getEmailConfig();
  const s = await getEmailSettings();
  switch (type) {
    case 'DAILY_STOCK': return buildDailyStockEmail(date, { includeLowStock: s.include_low_stock, includeExpiry: s.include_expiry, tz: cfg.timezone });
    case 'DAILY_BUSINESS': return buildBusinessSummaryEmail(date, { tz: cfg.timezone });
    case 'WEEKLY_EXPIRY': return buildExpiryEmail(date, { tz: cfg.timezone });
    case 'LOW_STOCK_DIGEST': return buildLowStockDigestEmail(date, { tz: cfg.timezone });
    case 'TEST': return buildTestEmail({ tz: cfg.timezone, requestedBy: extra.requestedBy || 'Admin' });
  }
}

/**
 * Generates and queues a report. Returns { created:false } when a job with the same idempotency key
 * already exists (the report is never generated or sent twice).
 */
export async function enqueueReport(type: ReportType, date: string, opts: { key?: string; recipients?: string[]; createdBy?: string } = {}) {
  const identity = await getShopIdentity();
  const key = opts.key || `${identity.shop_code}:${type}:${date}`;
  const exists = await pgPool.query('SELECT id, status FROM email_jobs WHERE idempotency_key = $1', [key]);
  if (exists.rows[0]) return { created: false, id: exists.rows[0].id as string, key, status: exists.rows[0].status as string };
  const recipients = opts.recipients?.length ? opts.recipients : (await getEmailSettings()).effective_recipients;
  if (recipients.length === 0) throw new HttpError(400, 'No report recipients configured (Settings → Email Reports, or STOCK_REPORT_RECIPIENTS).');
  const built = await buildReport(type, date, { requestedBy: opts.createdBy });
  const res = await pgPool.query(
    `INSERT INTO email_jobs (job_type, shop_id, report_date, recipients, subject, html_body, text_body, attachments, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [type, identity.shop_id, type === 'TEST' ? null : date, recipients, built.subject, built.html, built.text,
     JSON.stringify(built.attachments), key, opts.createdBy || 'SCHEDULER']
  );
  if (!res.rows[0]) {
    const again = (await pgPool.query('SELECT id, status FROM email_jobs WHERE idempotency_key = $1', [key])).rows[0];
    return { created: false, id: again.id as string, key, status: again.status as string };
  }
  emailWorker.wake();
  return { created: true, id: res.rows[0].id as string, key, status: 'PENDING' };
}

export async function enqueueTestEmail(recipients: string[] | undefined, actorName: string) {
  const list = (recipients && recipients.length ? recipients : (await getEmailSettings()).effective_recipients).map((r) => r.trim());
  const bad = list.filter((r) => !EMAIL_RE.test(r));
  if (bad.length) throw new HttpError(400, `Invalid e-mail address(es): ${bad.join(', ')}.`);
  const { date } = await businessDate();
  return enqueueReport('TEST', date, { key: `TEST:${crypto.randomUUID()}`, recipients: list, createdBy: actorName });
}

export async function getEmailStatus() {
  const cfg = getEmailConfig();
  const c = (await pgPool.query(`
    SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'SENDING')::int AS sending,
           COUNT(*) FILTER (WHERE status = 'RETRYING')::int AS retrying,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent,
           MAX(sent_at) AS last_sent_at
      FROM email_jobs`)).rows[0];
  const lastErr = (await pgPool.query(
    `SELECT job_type, last_error, last_attempt_at FROM email_jobs WHERE last_error IS NOT NULL AND status <> 'SENT'
      ORDER BY last_attempt_at DESC NULLS LAST LIMIT 1`)).rows[0];
  const state = !cfg.enabled ? 'DISABLED'
    : !cfg.configured ? 'ERROR'
    : c.failed > 0 ? 'ERROR'
    : emailWorker.smtpReachable === false || c.retrying > 0 ? 'OFFLINE'
    : 'READY';
  return {
    state,
    config: describeEmailConfig(cfg),
    counts: { pending: c.pending + c.sending, retrying: c.retrying, failed: c.failed, sent: c.sent },
    last_sent_at: c.last_sent_at ? new Date(c.last_sent_at).toISOString() : null,
    last_error: lastErr ? { job_type: lastErr.job_type, error: lastErr.last_error, at: lastErr.last_attempt_at } : null,
    worker: emailWorker.status(),
  };
}

export async function listEmailJobs(limit = 50) {
  const r = await pgPool.query(
    `SELECT id, job_type, report_date, recipients, subject, status, attempt_count, next_attempt_at, last_attempt_at, sent_at,
            last_error, idempotency_key, created_by, created_at, jsonb_array_length(attachments) AS attachment_count
       FROM email_jobs ORDER BY created_at DESC LIMIT $1`, [Math.min(200, Math.max(1, limit))]);
  return r.rows;
}

export async function requeueFailedEmails(): Promise<number> {
  const r = await pgPool.query(`UPDATE email_jobs SET status = 'RETRYING', next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'FAILED'`);
  emailWorker.wake();
  return r.rowCount || 0;
}

// ---------------------------------------------------------------------------- scheduler
/** Queues every report whose scheduled time today has passed (idempotent per day/week). */
export async function runScheduler(): Promise<string[]> {
  const cfg = getEmailConfig();
  if (!cfg.enabled) return [];
  const s = await getEmailSettings();
  if (s.effective_recipients.length === 0) return [];
  const now = await businessDate();
  const queued: string[] = [];
  const due = (t: string) => now.time >= t;
  const tryQueue = async (type: ReportType, date: string) => {
    const r = await enqueueReport(type, date);
    if (r.created) queued.push(r.key);
  };
  if (s.daily_stock_enabled && due(s.stock_report_time)) await tryQueue('DAILY_STOCK', now.date);
  if (s.business_summary_enabled && due(s.business_report_time)) await tryQueue('DAILY_BUSINESS', now.date);
  if (s.low_stock_digest_enabled && due(s.low_stock_digest_time)) await tryQueue('LOW_STOCK_DIGEST', now.date);
  if (s.expiry_report_enabled && now.isoDow === s.expiry_report_weekday && due(s.expiry_report_time)) await tryQueue('WEEKLY_EXPIRY', now.date);
  return queued;
}

// ---------------------------------------------------------------------------- worker
function isPermanent(err: any): boolean {
  const code = Number(err?.responseCode);
  return Number.isFinite(code) && code >= 500 && code < 600;
}

class EmailWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;
  private wakePending = false;
  private leader: pg.Client | null = null;
  private isLeader = false;
  private consecutiveFailures = 0;
  private lastSchedulerRun = 0;
  private forceScheduler = false;
  smtpReachable: boolean | null = null;
  private transporter: nodemailer.Transporter | null = null;

  start() {
    const cfg = getEmailConfig();
    if (this.started || !cfg.enabled) return;
    this.started = true;
    if (!cfg.configured) console.warn(`[Email] Email enabled but not configured: ${cfg.configError} Reports will queue locally.`);
    else console.log(`[Email] Worker started (SMTP ${cfg.host}:${cfg.port}, every ${cfg.workerIntervalMs / 1000}s).`);
    this.schedule(1500);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + 10_000;
    while (this.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (this.leader) await this.leader.end().catch(() => {});
    this.leader = null;
    this.isLeader = false;
    this.transporter?.close();
  }

  wake() {
    if (!this.started || this.stopped) return;
    this.forceScheduler = true;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    this.schedule(0);
  }

  status() {
    return { running: this.started && !this.stopped, leader: this.isLeader, consecutive_failures: this.consecutiveFailures, smtp_reachable: this.smtpReachable };
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), ms);
    this.timer.unref?.();
  }

  private async cycle() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (await this.ensureLeader()) {
        if (Date.now() - this.lastSchedulerRun >= 30_000 || this.forceScheduler) {
          this.lastSchedulerRun = Date.now();
          this.forceScheduler = false;
          const q = await runScheduler().catch((e) => {
            console.error('[Email] Scheduler error:', e?.message || e);
            return [];
          });
          if (q.length) console.log(`[Email] Report(s) queued: ${q.join(', ')}`);
        }
        await this.sendDue();
      }
    } catch (err: any) {
      console.error('[Email] Cycle error:', err?.message || err);
    } finally {
      this.running = false;
      const cfg = getEmailConfig();
      const again = this.wakePending;
      this.wakePending = false;
      const delay = this.consecutiveFailures ? Math.min(cfg.maxBackoffMs, cfg.workerIntervalMs * 2 ** Math.min(this.consecutiveFailures - 1, 10)) : cfg.workerIntervalMs;
      this.schedule(again ? 0 : delay);
    }
  }

  private async ensureLeader(): Promise<boolean> {
    if (this.isLeader && this.leader) return true;
    try {
      if (!this.leader) {
        const conf: any = { ...getDatabaseConnectionConfig() };
        delete conf.max;
        delete conf.idleTimeoutMillis;
        const c = new pg.Client(conf);
        c.on('error', () => {
          this.isLeader = false;
          this.leader = null;
        });
        await c.connect();
        this.leader = c;
      }
      if (!(await this.leader.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY])).rows[0].ok) return false;
      this.isLeader = true;
      // A crash during SENDING: the job is retried (SMTP has a stable Message-ID per job).
      const r = await pgPool.query(`UPDATE email_jobs SET status = 'RETRYING', next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'SENDING'`);
      if (r.rowCount) console.log(`[Email] Recovered ${r.rowCount} job(s) left in SENDING.`);
      return true;
    } catch (err: any) {
      console.warn('[Email] Leadership unavailable (database?):', err?.message || err);
      if (this.leader) await this.leader.end().catch(() => {});
      this.leader = null;
      return false;
    }
  }

  private getTransport() {
    if (this.transporter) return this.transporter;
    const cfg = getEmailConfig();
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTls,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      connectionTimeout: cfg.timeoutMs,
      greetingTimeout: cfg.timeoutMs,
      socketTimeout: cfg.timeoutMs,
      pool: false,
    } as SMTPTransport.Options);
    return this.transporter;
  }

  private async sendDue() {
    const cfg = getEmailConfig();
    if (!cfg.configured) return;
    for (let i = 0; i < 20 && !this.stopped; i++) {
      const claimed = (await pgPool.query(
        `UPDATE email_jobs SET status = 'SENDING', attempt_count = attempt_count + 1, last_attempt_at = CURRENT_TIMESTAMP
          WHERE id = (SELECT id FROM email_jobs WHERE status IN ('PENDING', 'RETRYING') AND next_attempt_at <= CURRENT_TIMESTAMP
                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`)).rows[0];
      if (!claimed) return;
      try {
        const info = await this.getTransport().sendMail({
          from: cfg.from,
          to: claimed.recipients,
          subject: claimed.subject,
          html: claimed.html_body,
          text: claimed.text_body || undefined,
          messageId: `<${claimed.id}@giga-chemist.pos>`,
          attachments: (claimed.attachments || []).map((a: any) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        });
        await pgPool.query(
          `UPDATE email_jobs SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, last_error = NULL, message_id = $2 WHERE id = $1`,
          [claimed.id, String(info?.messageId || '').slice(0, 300)]
        );
        if (this.smtpReachable === false || this.consecutiveFailures > 0) {
          console.log('[Email] SMTP reachable again.');
          await pgPool.query(`UPDATE email_jobs SET next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'RETRYING' AND next_attempt_at > CURRENT_TIMESTAMP`);
        }
        this.smtpReachable = true;
        this.consecutiveFailures = 0;
        console.log(`[Email] Sent ${claimed.job_type} (${claimed.idempotency_key}).`);
      } catch (err: any) {
        const msg = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 500);
        const permanent = isPermanent(err) || claimed.attempt_count >= cfg.maxAttempts;
        this.smtpReachable = err?.responseCode ? true : false;
        this.transporter?.close();
        this.transporter = null;
        await pgPool.query(
          `UPDATE email_jobs SET status = $2, last_error = $3,
                  next_attempt_at = CURRENT_TIMESTAMP + make_interval(secs => LEAST($4::float8, $5::float8 * power(2, LEAST(attempt_count - 1, 12))) * (0.8 + random() * 0.4))
            WHERE id = $1`,
          [claimed.id, permanent ? 'FAILED' : 'RETRYING', msg, cfg.maxBackoffMs / 1000, cfg.retryBaseSeconds]
        );
        this.consecutiveFailures++;
        if (this.consecutiveFailures === 1 || permanent) console.warn(`[Email] ${claimed.job_type} not sent (${permanent ? 'FAILED' : 'will retry'}): ${msg}`);
        if (!permanent) return; // SMTP down: stop this cycle, back off
      }
    }
  }
}

export const emailWorker = new EmailWorker();

export function startEmailWorker() {
  try {
    emailWorker.start();
  } catch (err: any) {
    console.error('[Email] Worker failed to start (POS continues):', err?.message || err);
  }
}
