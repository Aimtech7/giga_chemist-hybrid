import fs from 'fs';
import path from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { applyCommonMiddleware, apiErrorHandler } from '../http/common';
import { createJwtToken, verifyJwtToken, verifyCredential, hasPermission, ROLE_PERMISSIONS } from '../auth';
import { HttpError, isValidUuid } from '../db/client';
import { resolveRange, getSalesReport } from '../db/reports';
import { getAllSales, getTodaySalesSummary } from '../db/sales';
import { getAllMedicines } from '../db/medicines';
import { getAllBatches } from '../db/batches';
import { getAllCategories } from '../db/categories';
import { getAllReturns } from '../db/returns';
import { getAllCustomers } from '../db/customers';
import { getAllSuppliers } from '../db/suppliers';
import { getAllPurchases } from '../db/purchases';
import { getAllExpenses } from '../db/expenses';
import { getPharmacySettings, toSettings } from '../db/settings';
import { buildRemoteAdminRouter } from './remoteAdmin';
import type { UserRole } from '../../src/types';

/**
 * ONLINE API (APP_MODE=online, e.g. Vercel at https://gigachem.vercel.app/api/*).
 *
 *  - Data source: the CLOUD database (Supabase) — the giga_cloud tables filled by the shop's sync,
 *    read through the giga_online views (cloud migration 002). Never the shop's local PostgreSQL.
 *  - READ-ONLY: selling, stock, returns, purchases and every other write happen only on the shop
 *    server, whose local PostgreSQL is authoritative. Writes here answer 409 ONLINE_READ_ONLY.
 *  - ONE exception, ADMIN only: /api/admin/commands/* QUEUES a remote-administration command
 *    (giga_cloud.commands) for the shop. Nothing is changed in the cloud copy: the shop's sync
 *    worker pulls the command, applies it in its own PostgreSQL transaction and syncs the result
 *    back. The command's status (PENDING / DELIVERED / APPLIED / REJECTED) is readable here.
 *  - The same report / Sales History SQL as the shop server runs inside a READ ONLY transaction with
 *    search_path = giga_online and giga.shop_id = SHOP_ID, so figures match the shop's definitions.
 *  - Accounts: giga_cloud.online_users (separate from shop staff; shop password/PIN hashes are
 *    never synced). Same JWT format, Online JWT_SECRET, ADMIN / CASHIER RBAC.
 *  - No background workers, no filesystem state, no pg_dump: safe for serverless.
 */
export interface OnlineConfig {
  databaseUrl: string;
  shopId: string | null;
  error: string | null;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
const SHOP_DATABASES = ['giga_chemist', 'giga_chemist_dev'];

export function getOnlineConfig(): OnlineConfig {
  const databaseUrl = (process.env.ONLINE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  const shopRaw = (process.env.SHOP_ID || '').trim();
  let error: string | null = null;
  if (!databaseUrl || /REQUIRED_USER_INPUT|YOUR_/i.test(databaseUrl)) error = 'DATABASE_URL (cloud) is not configured.';
  else {
    try {
      const u = new URL(databaseUrl);
      const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (SHOP_DATABASES.includes(db)) error = `DATABASE_URL points to a shop database (${db}); the online API uses the cloud database only.`;
      else if (LOCAL_HOSTS.includes(u.hostname) && process.env.ONLINE_ALLOW_LOCAL_DB !== 'true') {
        error = 'DATABASE_URL points to localhost; the online API never uses a local PostgreSQL.';
      }
    } catch {
      error = 'DATABASE_URL is not a valid URL.';
    }
  }
  if (!error && !isValidUuid(shopRaw)) error = 'SHOP_ID (the registered shop UUID) is not configured.';
  return { databaseUrl, shopId: isValidUuid(shopRaw) ? shopRaw.toLowerCase() : null, error };
}

let pool: pg.Pool | null = null;
function getPool(cfg: OnlineConfig): pg.Pool {
  if (pool) return pool;
  const u = new URL(cfg.databaseUrl);
  pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    ssl: LOCAL_HOSTS.includes(u.hostname) ? undefined : { rejectUnauthorized: false },
    max: Number(process.env.ONLINE_DB_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  pool.on('error', (err) => console.error('[Online] database pool error:', err.message));
  return pool;
}

/** Runs fn in a READ ONLY transaction scoped to the configured shop (works with transaction pooling). */
async function withShop<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const cfg = getOnlineConfig();
  if (cfg.error) throw new HttpError(503, `Online API not configured: ${cfg.error}`);
  const client = await getPool(cfg).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('search_path', 'giga_online, pg_catalog', true), set_config('giga.shop_id', $1, true)`, [cfg.shopId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function withCloud<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const cfg = getOnlineConfig();
  if (cfg.error) throw new HttpError(503, `Online API not configured: ${cfg.error}`);
  const client = await getPool(cfg).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

let version = '0.0.0';
try {
  version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version || version;
} catch {
  /* bundled without package.json */
}

// ---------------------------------------------------------------------------- auth
interface OnlineRequest extends Request {
  onlineUser?: { id: string; name: string; email: string; role: UserRole; local_user_id: string | null; shop_id: string | null };
}

const loginAttempts = new Map<string, { n: number; reset: number }>();
function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.reset) loginAttempts.set(ip, { n: 1, reset: now + 60_000 });
  else if (++rec.n > (Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE) || 10)) {
    return res.status(429).json({ error: 'Too many login attempts. Wait one minute.' });
  }
  next();
}

async function authenticate(req: OnlineRequest, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next();
  let check;
  try {
    check = verifyJwtToken(token);
  } catch {
    return res.status(503).json({ error: 'Online API not configured: JWT_SECRET is missing.' });
  }
  if (!check.valid || !check.payload || !isValidUuid(check.payload.userId)) return next();
  try {
    const row = await findOnlineUser(check.payload.userId);
    // Revoked session: the account's token_version moved on after this token was issued.
    if (row && Number(row.token_version || 0) === Number(check.payload.tv || 0)) {
      delete row.token_version;
      req.onlineUser = row;
    }
    if (req.onlineUser && req.onlineUser.role !== 'ADMIN') {
      const ctl = await getRemoteControl();
      if (ctl.maintenance_mode && !req.path.startsWith('/health')) {
        return res.status(503).json({ error: ctl.maintenance_message || 'The online app is in maintenance. Try again later.', code: 'MAINTENANCE' });
      }
    }
    next();
  } catch (err: any) {
    res.status(503).json({ error: 'Cloud database unavailable: cannot verify the session.' });
  }
}

/** Active online account (+ token_version when cloud migration 004 is applied; 0 before). */
async function findOnlineUser(by: string, column: 'id' | 'email' = 'id', withHash = false): Promise<any> {
  const cols = `id, name, email, role, local_user_id, shop_id${withHash ? ', password_hash' : ''}`;
  try {
    return (await withCloud((c) => c.query(`SELECT ${cols}, token_version FROM giga_cloud.online_users WHERE ${column} = $1 AND active`, [by]))).rows[0];
  } catch (err: any) {
    if (err?.code !== '42703') throw err;
    const row = (await withCloud((c) => c.query(`SELECT ${cols} FROM giga_cloud.online_users WHERE ${column} = $1 AND active`, [by]))).rows[0];
    return row ? { ...row, token_version: 0 } : row;
  }
}

// Emergency switches (giga_cloud.remote_control, migration 004), cached briefly per instance.
let controlCache: { at: number; value: { remote_writes_enabled: boolean; maintenance_mode: boolean; maintenance_message: string | null } } | null = null;
export async function getRemoteControl(fresh = false) {
  if (!fresh && controlCache && Date.now() - controlCache.at < 10_000) return controlCache.value;
  let value = { remote_writes_enabled: true, maintenance_mode: false, maintenance_message: null as string | null };
  try {
    const row = (await withCloud((c) => c.query(
      `SELECT remote_writes_enabled, maintenance_mode, maintenance_message FROM giga_cloud.remote_control WHERE shop_id = $1`, [getOnlineConfig().shopId]
    ))).rows[0];
    if (row) value = row;
  } catch (err: any) {
    if (err?.code !== '42P01') throw err; // table missing = migration 004 not applied = defaults
  }
  controlCache = { at: Date.now(), value };
  return value;
}
export function clearRemoteControlCache() {
  controlCache = null;
}

/** Security event in giga_cloud.online_audit (never passwords/tokens). Best effort. */
export async function securityEvent(req: Request, action: string, email: string | null, userId: string | null, details: Record<string, unknown> = {}) {
  try {
    await withCloud((c) => c.query(
      `INSERT INTO giga_cloud.online_audit (shop_id, online_user_id, user_email, action, details, client_ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [getOnlineConfig().shopId, userId, email ? email.slice(0, 200) : null, action, JSON.stringify(details),
       String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 100), String(req.headers['user-agent'] || '').slice(0, 300)]
    ));
  } catch {
    /* auditing must never break login; table may be missing before migration 003 */
  }
}

const requireAuth = (req: OnlineRequest, res: Response, next: NextFunction) =>
  req.onlineUser ? next() : res.status(401).json({ error: 'Unauthorized: valid Bearer token required.' });
const requirePermission = (perm: string) => (req: OnlineRequest, res: Response, next: NextFunction) => {
  if (!req.onlineUser) return res.status(401).json({ error: 'Unauthorized: valid Bearer token required.' });
  if (!hasPermission(req.onlineUser.role, perm)) return res.status(403).json({ error: `Forbidden: role ${req.onlineUser.role} lacks ${perm}.` });
  next();
};
const requireAdmin = (req: OnlineRequest, res: Response, next: NextFunction) => {
  if (!req.onlineUser) return res.status(401).json({ error: 'Unauthorized: valid Bearer token required.' });
  if (req.onlineUser.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden: Administrator only.' });
  next();
};

const CONNECTION_ERRORS = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'];
function send(res: Response, err: any, label: string) {
  if (CONNECTION_ERRORS.includes(err?.code) || /timeout|terminated|Connection/i.test(String(err?.message || ''))) {
    console.error(`[Online] ${label}: cloud database unreachable (${err?.code || err?.message})`);
    return res.status(503).json({ error: 'Cloud database unreachable. Try again shortly.', code: 'CLOUD_DB_UNREACHABLE' });
  }
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) console.error(`[Online] ${label} failed:`, err?.message || err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Cloud database error.' : err.message });
}
const route = (label: string, fn: (req: OnlineRequest, res: Response) => Promise<unknown>) =>
  async (req: OnlineRequest, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      send(res, err, label);
    }
  };

/** Cashier online: own sales only, via the linked shop staff account (none linked = nothing). */
const cashierScope = (u: NonNullable<OnlineRequest['onlineUser']>) =>
  u.role === 'CASHIER' ? (u.local_user_id || '00000000-0000-0000-0000-000000000000') : undefined;

export function buildOnlineRouter() {
  const r = express.Router();
  r.use(authenticate);

  r.get('/health', async (_req, res) => {
    const cfg = getOnlineConfig();
    const base = { status: 'online', system: 'GIGA CHEMIST POS API', mode: 'online', app_mode: 'online', version, timestamp: Date.now(), read_only: true, remote_admin_commands: true };
    if (cfg.error) return res.json({ ...base, database: { provider: 'Supabase PostgreSQL', connected: false, configured: false, error: cfg.error } });
    try {
      const info = await withCloud(async (c) => {
        const schema = (await c.query(`SELECT to_regclass('giga_cloud.shops') IS NOT NULL AS cloud, to_regclass('giga_online.sales') IS NOT NULL AS online,
                                              to_regclass('giga_cloud.online_users') IS NOT NULL AS users`)).rows[0];
        const shop = schema.cloud ? (await c.query(`SELECT shop_code, active, last_event_at FROM giga_cloud.shops WHERE shop_id = $1`, [cfg.shopId])).rows[0] : null;
        return { schema, shop };
      });
      res.json({
        ...base,
        auth_configured: Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32),
        database: {
          provider: 'Supabase PostgreSQL',
          connected: true,
          cloud_schema: info.schema.cloud,
          online_views: info.schema.online,
          online_accounts_table: info.schema.users,
          shop_registered: Boolean(info.shop),
          shop_code: info.shop?.shop_code || null,
          last_shop_event_at: info.shop?.last_event_at || null,
        },
      });
    } catch (err: any) {
      res.status(503).json({ ...base, status: 'degraded', database: { provider: 'Supabase PostgreSQL', connected: false, error: 'Cloud database unreachable.' } });
    }
  });

  r.post('/auth/login', loginRateLimit, async (req, res) => {
    try {
      const identifier = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
      const secret = String(req.body?.password || '').trim();
      if (!identifier || !secret) return res.status(400).json({ error: 'Email and password are required.' });
      const user = await findOnlineUser(identifier, 'email', true);
      const shopId = getOnlineConfig().shopId;
      // Same answer for unknown user / wrong password / other shop.
      if (!user || !verifyCredential(secret, user.password_hash) || (user.shop_id && user.shop_id !== shopId)) {
        await securityEvent(req, 'ONLINE_LOGIN_FAILED', identifier, user?.id ?? null);
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (user.role !== 'ADMIN') {
        const ctl = await getRemoteControl();
        if (ctl.maintenance_mode) return res.status(503).json({ error: ctl.maintenance_message || 'The online app is in maintenance. Try again later.', code: 'MAINTENANCE' });
      }
      await securityEvent(req, 'ONLINE_LOGIN', user.email, user.id, { role: user.role });
      await withCloud((c) => c.query('UPDATE giga_cloud.online_users SET last_login_at = now() WHERE id = $1', [user.id]));
      const token = createJwtToken({ userId: user.id, role: user.role, email: user.email, name: user.name, tv: Number(user.token_version || 0) });
      res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role, active: true }, permissions: ROLE_PERMISSIONS[user.role as UserRole] });
    } catch (err) {
      send(res, err, 'POST /auth/login');
    }
  });

  r.get('/auth/me', requireAuth, (req: OnlineRequest, res) => {
    const u = req.onlineUser!;
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, active: true }, permissions: ROLE_PERMISSIONS[u.role] });
  });

  // Terminals are a shop concept; online browsers are not registered.
  r.post('/devices/register', requireAuth, (_req, res) => res.json({ status: 'not_tracked_online' }));

  r.get('/settings', route('GET /settings', () => withShop(async (c) => {
    try {
      return await getPharmacySettings(c);
    } catch {
      return toSettings({ pharmacy_name: 'GIGA CHEMIST' });
    }
  })));

  r.get('/sync/status', requireAuth, route('GET /sync/status', async () => {
    const cfg = getOnlineConfig();
    const shop = await withCloud((c) => c.query('SELECT last_event_at FROM giga_cloud.shops WHERE shop_id = $1', [cfg.shopId]));
    return { mode: 'online', enabled: false, read_only: true, local_database: { connected: true }, cloud_reachable: true, counts: null, last_sync: shop.rows[0]?.last_event_at || null };
  }));

  const stripCost = (req: OnlineRequest, rows: any[], fields: string[]) =>
    req.onlineUser!.role === 'CASHIER' ? rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fields.includes(k) ? 0 : v]))) : rows;

  r.get('/medicines', requirePermission('medicine.view'), route('GET /medicines', async (req) => stripCost(req, await withShop((c) => getAllMedicines(c)), ['purchase_price'])));
  r.get('/categories', requirePermission('medicine.view'), route('GET /categories', () => withShop((c) => getAllCategories(c))));
  r.get('/batches', requirePermission('medicine.view'), route('GET /batches', async (req) => stripCost(req, await withShop((c) => getAllBatches(c)), ['purchase_price'])));
  r.get('/customers', requirePermission('sales.view_own'), route('GET /customers', () => withShop((c) => getAllCustomers(c))));

  r.get('/sales', requirePermission('sales.view_own'), route('GET /sales', async (req) => {
    const q = req.query;
    const result: any = await withShop((c) => getAllSales({
      page: Number(q.page) || 1, limit: Number(q.limit) || 50, search: q.search as string, startDate: q.startDate as string, endDate: q.endDate as string,
      cashierId: cashierScope(req.onlineUser!) ?? (q.cashierId as string | undefined),
      paymentMethod: (q.paymentMethod as string) || undefined, customerId: (q.customerId as string) || undefined,
      priceMode: (q.priceMode as string) || undefined, status: (q.status as string) || undefined,
    }, c));
    if (req.onlineUser!.role !== 'CASHIER') return result;
    const strip = (s: any) => ({ ...s, cost_total: 0, gross_profit: 0, items: s.items?.map((i: any) => ({ ...i, cost_price_snapshot: 0 })) });
    return { ...result, sales: result.sales.map(strip) };
  }));

  r.get('/sales/today-summary', requireAuth, route('GET /sales/today-summary', async (req) => {
    const s: any = await withShop((c) => getTodaySalesSummary({ cashierId: cashierScope(req.onlineUser!) ?? ((req.query.cashierId as string) || undefined) }, c));
    if (req.onlineUser!.role !== 'ADMIN') delete s.grossProfit;
    return s;
  }));

  r.get('/reports/summary', requirePermission('sales.view_own'), route('GET /reports/summary', (req) => withShop(async (c) => {
    const isAdmin = req.onlineUser!.role === 'ADMIN';
    const range = await resolveRange(req.query.range, req.query.start, req.query.end, c);
    return getSalesReport(range, { cashierId: isAdmin ? ((req.query.cashierId as string) || null) : cashierScope(req.onlineUser!), includeCost: isAdmin }, c);
  })));

  r.get('/returns', requirePermission('returns.create'), route('GET /returns', (req) => withShop((c) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.toUpperCase() : undefined;
    return getAllReturns({ userId: cashierScope(req.onlineUser!), status }, c);
  })));

  r.get('/users', requireAdmin, route('GET /users', () => withShop(async (c) =>
    (await c.query('SELECT id, name, email, username, role, active FROM users ORDER BY name')).rows)));
  r.get('/suppliers', requireAdmin, route('GET /suppliers', () => withShop((c) => getAllSuppliers(c))));
  r.get('/purchases', requireAdmin, route('GET /purchases', () => withShop((c) => getAllPurchases(c))));
  r.get('/expenses', requireAdmin, route('GET /expenses', () => withShop((c) => getAllExpenses(c))));

  // Remote administration (ADMIN only): queue commands for the shop; never a direct cloud write.
  r.use(buildRemoteAdminRouter({
    shopId: () => getOnlineConfig().shopId, withShop, withCloud, requireAdmin, route, getRemoteControl, clearRemoteControlCache, securityEvent,
  }));

  // Shop-only features: not available from the cloud copy (yet).
  for (const p of ['/inventory/movements', '/audit', '/admin/health', '/email/settings', '/email/jobs', '/backups/status']) {
    r.get(p, requireAuth, (_req, res) => res.status(501).json({ error: 'Not available online: this information lives on the shop server.', code: 'SHOP_SERVER_ONLY' }));
  }

  // Every write is refused: the shop's local PostgreSQL is the only writer.
  r.all('*', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.status(409).json({
      error: 'The online app is read-only. Sales, stock, returns, purchases and other changes are made on the shop POS; they reach the cloud through sync. ' +
        'Administrators can request stock, price and catalog changes through Remote Admin (they are applied by the shop computer).',
      code: 'ONLINE_READ_ONLY',
    });
  });
  r.use((req, res) => res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` }));
  return r;
}

/** Mounts the online API at /api (plus JSON error handling) on an Express app. */
export function mountOnlineApi(app: express.Express) {
  applyCommonMiddleware(app);
  app.use('/api', buildOnlineRouter());
  app.use('/api', apiErrorHandler);
}
