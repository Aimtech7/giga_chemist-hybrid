/**
 * Email configuration from the server environment. SMTP_PASSWORD never leaves this module:
 * describeEmailConfig() returns only non-secret facts for the Admin screen.
 */
export interface EmailConfig {
  enabled: boolean;
  configured: boolean;
  configError: string | null;
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  password: string;
  from: string;
  defaultRecipients: string[];
  timezone: string;
  defaults: { stockTime: string; businessTime: string };
  workerIntervalMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
  retryBaseSeconds: number;
  timeoutMs: number;
}

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseRecipients(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  return String(raw || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : d;
};

let cached: EmailConfig | null = null;

export function getEmailConfig(): EmailConfig {
  if (cached) return cached;
  const env = process.env;
  const clean = (v?: string) => {
    const s = (v || '').trim();
    return /^(YOUR_|REQUIRED_USER_INPUT)|your-smtp|example\.com$/i.test(s) ? '' : s;
  };
  const host = clean(env.SMTP_HOST);
  const port = num(env.SMTP_PORT, 587, 1, 65535);
  const secure = String(env.SMTP_SECURE || '').toLowerCase() === 'true';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const requireTls = env.SMTP_REQUIRE_TLS !== undefined ? env.SMTP_REQUIRE_TLS === 'true' : !secure && !loopback;
  const from = clean(env.EMAIL_FROM);
  const recipients = parseRecipients(clean(env.STOCK_REPORT_RECIPIENTS));
  const enabled = String(env.EMAIL_ENABLED || '').toLowerCase() === 'true';

  let configError: string | null = null;
  if (!host) configError = 'SMTP_HOST is not set.';
  else if (!from || !EMAIL_RE.test(from.replace(/^.*<(.+)>$/, '$1'))) configError = 'EMAIL_FROM is not a valid address.';
  else if (clean(env.SMTP_USER) && !env.SMTP_PASSWORD) configError = 'SMTP_USER is set but SMTP_PASSWORD is empty.';

  const t = (v: string | undefined, d: string) => (v && TIME_RE.test(v.trim()) ? v.trim() : d);
  cached = {
    enabled,
    configured: !configError,
    configError,
    host,
    port,
    secure,
    requireTls,
    user: clean(env.SMTP_USER),
    password: env.SMTP_PASSWORD || '',
    from,
    defaultRecipients: recipients.filter((r) => EMAIL_RE.test(r)),
    timezone: (env.EMAIL_TIMEZONE || 'Africa/Nairobi').trim(),
    defaults: { stockTime: t(env.STOCK_REPORT_TIME, '18:00'), businessTime: t(env.BUSINESS_REPORT_TIME, '18:05') },
    workerIntervalMs: num(env.EMAIL_WORKER_INTERVAL_SECONDS, 30, 1, 3600) * 1000,
    maxAttempts: Math.round(num(env.EMAIL_MAX_ATTEMPTS, 50, 1, 1000)),
    maxBackoffMs: num(env.EMAIL_MAX_BACKOFF_SECONDS, 1800, 1, 86_400) * 1000,
    retryBaseSeconds: num(env.EMAIL_RETRY_BASE_SECONDS, 60, 1, 3600),
    timeoutMs: num(env.SMTP_TIMEOUT_MS, 20_000, 500, 120_000),
  };
  return cached;
}

export function describeEmailConfig(cfg: EmailConfig = getEmailConfig()) {
  return {
    enabled: cfg.enabled,
    configured: cfg.configured,
    config_error: cfg.configError,
    smtp_host: cfg.host || null,
    smtp_port: cfg.port,
    smtp_secure: cfg.secure,
    smtp_require_tls: cfg.requireTls,
    smtp_user_set: Boolean(cfg.user),
    from: cfg.from || null,
    default_recipients: cfg.defaultRecipients,
    timezone: cfg.timezone,
  };
}
