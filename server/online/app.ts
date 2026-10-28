import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { applyCommonMiddleware, apiErrorHandler } from '../http/common';
import { createJwtToken, verifyJwtToken, verifyCredential, hashCredential, hasPermission, ROLE_PERMISSIONS } from '../auth';
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
import { buildRemoteAdminRouter, isAllShopsScope } from './remoteAdmin';
import { buildUserAdminRouter } from './userAdmin';
import { buildHistoryRouter } from '../http/historyRoutes';
import { buildInventoryRouter } from '../http/inventoryRoutes';
import { businessDaySummary } from '../db/businessDay';
import { buildShiftRouter } from '../http/shiftRoutes';
import { executeOnlineSaleCheckout, getOnlineSales } from './sales';
import type { HistoryScope } from '../db/history';
import type { UserRole } from '../../src/types';

/**
 * ONLINE API (APP_MODE=online, e.g. Vercel at https://gigachem.vercel.app/api/*).
 *
 *  - Data source: the CLOUD database (Supabase) — the giga_cloud tables filled by the shop's sync,
 *    read through the giga_online views (cloud migration 002). Never the shop's local PostgreSQL.
 *  - NO DIRECT WRITES: selling, stock, returns, purchases and every other change happen only on the
 *    shop server, whose local PostgreSQL is authoritative. Writes here answer 409 ONLINE_READ_ONLY.
 *  - Administration is FULL-WRITE through commands, ADMIN only: /api/admin/commands/* QUEUES a
 *    remote-administration command (giga_cloud.commands) for the selected shop. Nothing is changed in the cloud copy: the shop's sync
 *    worker pulls the command, applies it in its own PostgreSQL transaction and syncs the result
 *    back. The command's status (PENDING / DELIVERED / APPLIED / REJECTED) is readable here.
 *  - The same report / Sales History SQL as the shop server runs inside a READ ONLY transaction with
 *    search_path = giga_online and giga.shop_id = SHOP_ID, so figures match the shop's definitions.
 *  - Accounts: giga_cloud.online_users (separate from shop staff; shop password/PIN hashes are
 *    never synced). Same JWT format, Online JWT_SECRET, ADMIN / CASHIER RBAC.
 *  - No background workers, no filesystem state, no pg_dump: safe for serverless.
 *  - MULTI-SHOP: every request resolves ONE authorized shop (resolveShop, below) and stores it on
 *    the request object, never in module state, so concurrent requests cannot share a shop. The
 *    optional X-GIGA-SHOP-ID header is a REQUEST, re-authorized on every call:
 *      no header            -> the account's own shop, or SHOP_ID (the default shop) for a global account
 *      global ADMIN         -> any ACTIVE registered shop (online_users.shop_id IS NULL)
 *      shop-scoped account  -> only its own shop (403 otherwise); CASHIER never selects freely
 *      anonymous            -> header ignored; default shop only
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

/**
 * Runs fn in a READ ONLY transaction scoped to ONE shop (works with transaction pooling: the
 * setting is transaction-local, so it can never leak to another request on the same connection).
 */
async function withShop<T>(shopId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const cfg = getOnlineConfig();
  if (cfg.error) throw new HttpError(503, `Online API not configured: ${cfg.error}`);
  if (!isValidUuid(shopId)) throw new HttpError(503, 'Online API: no shop resolved for this request.');
  const client = await getPool(cfg).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('search_path', 'giga_online, pg_catalog', true), set_config('giga.shop_id', $1, true)`, [shopId]);
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
  onlineUser?: {
    id: string; name: string; email: string; role: UserRole; local_user_id: string | null; shop_id: string | null;
    /** GLOBAL_ADMIN (cloud-managed, every shop) or SHOP_USER (exactly one shop). */
    account_type: 'GLOBAL_ADMIN' | 'SHOP_USER'; username?: string | null;
  };
  /** The ONE shop this request is authorized to read / command (set by resolveShop). */
  shopId?: string | null;
}

/** Request header carrying the shop the browser asks for (re-authorized on every request). */
export const SHOP_HEADER = 'x-giga-shop-id';

/** Shop of a request (resolved and authorized by resolveShop). */
export function requestShop(req: Request): string {
  const id = (req as OnlineRequest).shopId;
  if (!id) throw new HttpError(503, 'Online API not configured: SHOP_ID (the default shop) is missing.');
  return id;
}

/** Shop an account uses when the request names none: its own shop, else the default shop (SHOP_ID). */
function homeShop(u: NonNullable<OnlineRequest['onlineUser']>, cfg: OnlineConfig): string | null {
  return u.shop_id ? String(u.shop_id).toLowerCase() : cfg.shopId;
}

/**
 * Only a GLOBAL_ADMIN account may select an arbitrary shop. A shop's own ADMIN role is NOT global
 * authority: the decision rests on account_type, never on role alone.
 */
export function isGlobalAdmin(u: OnlineRequest['onlineUser']): boolean {
  return Boolean(u && u.account_type === 'GLOBAL_ADMIN' && u.role === 'ADMIN' && !u.shop_id);
}

async function resolveShop(req: OnlineRequest, res: Response, next: NextFunction) {
  const cfg = getOnlineConfig();
  const u = req.onlineUser;
  // Anonymous requests (health, login, public settings) never select a shop: default shop only.
  if (!u) {
    req.shopId = cfg.shopId;
    return next();
  }
  const raw = req.headers[SHOP_HEADER] ?? (typeof req.query?.shop_id === 'string' ? req.query.shop_id : undefined);
  if (Array.isArray(raw)) return res.status(400).json({ error: 'Send X-GIGA-SHOP-ID once.', code: 'SHOP_ID_INVALID' });
  const wanted = String(raw || '').trim().toLowerCase();
  if (!wanted) {
    req.shopId = homeShop(u, cfg);
    return next();
  }
  if (!isValidUuid(wanted)) return res.status(400).json({ error: 'X-GIGA-SHOP-ID must be a shop UUID.', code: 'SHOP_ID_INVALID' });
  if (!isGlobalAdmin(u)) {
    if (wanted !== homeShop(u, cfg)) {
      await securityEvent(req, 'SHOP_ACCESS_DENIED', u.email, u.id, { requested_shop_id: wanted });
      return res.status(403).json({ error: 'Forbidden: this account may not access that shop.', code: 'SHOP_ACCESS_DENIED' });
    }
    req.shopId = wanted;
    return next();
  }
  try {
    const shop = (await withCloud((c) => c.query('SELECT 1 FROM giga_cloud.shops WHERE shop_id = $1 AND active', [wanted]))).rows[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found or inactive.', code: 'SHOP_NOT_FOUND' });
  } catch {
    return res.status(503).json({ error: 'Cloud database unavailable: cannot verify the shop.' });
  }
  req.shopId = wanted;
  next();
}

/** Maintenance mode of the request's shop blocks non-Administrators (health stays reachable). */
async function maintenanceGate(req: OnlineRequest, res: Response, next: NextFunction) {
  if (!req.onlineUser || req.onlineUser.role === 'ADMIN' || !req.shopId) return next();
  try {
    const ctl = await getRemoteControl(req.shopId);
    if (ctl.maintenance_mode && !req.path.startsWith('/health')) {
      return res.status(503).json({ error: ctl.maintenance_message || 'The online app is in maintenance. Try again later.', code: 'MAINTENANCE' });
    }
    next();
  } catch {
    res.status(503).json({ error: 'Cloud database unavailable: cannot verify the session.' });
  }
}

const loginAttempts = new Map<string, { n: number; reset: number }>();

// Per-account brute-force brake (per serverless instance, on top of the per-IP limit): 10 failed
// attempts for one identifier lock it for 15 minutes. Same generic answer, so no enumeration.
const loginFailures = new Map<string, { n: number; until: number; first: number }>();
const LOGIN_DUMMY_HASH = hashCredential(crypto.randomBytes(16).toString('hex')).combined;
function identifierLocked(id: string): boolean {
  const f = loginFailures.get(id);
  return Boolean(f && f.until > Date.now());
}
function noteFailedLogin(id: string) {
  const now = Date.now();
  const f = loginFailures.get(id);
  const rec = f && now - f.first < 15 * 60_000 ? f : { n: 0, until: 0, first: now };
  rec.n++;
  if (rec.n >= (Number(process.env.AUTH_ACCOUNT_LOCK_THRESHOLD) || 10)) rec.until = now + 15 * 60_000;
  loginFailures.set(id, rec);
  if (loginFailures.size > 10_000) loginFailures.clear();
}

/** What the browser may know about its own account (never hashes or tokens). */
function accountInfo(u: any) {
  return { type: u.account_type, shop_id: u.shop_id || null, local_user_id: u.local_user_id || null, username: u.username || null };
}
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
    next();
  } catch (err: any) {
    res.status(503).json({ error: 'Cloud database unavailable: cannot verify the session.' });
  }
}

/**
 * Active online account whose shop (if any) is active. Columns of later cloud migrations are optional:
 * before 005 the account type is derived (an ADMIN without a shop = GLOBAL_ADMIN), before 004
 * token_version is 0. Lookup by id, email, or username (username only when exactly ONE active account
 * in all shops uses it — an ambiguous username never authenticates anyone; use the email).
 */
async function findOnlineUser(by: string, column: 'id' | 'email' | 'username' = 'id', withHash = false): Promise<any> {
  const base = `u.id, u.name, u.email, u.role, u.local_user_id, u.shop_id${withHash ? ', u.password_hash' : ''}`;
  const where = column === 'id' ? 'u.id = $1' : column === 'email' ? 'lower(u.email) = $1' : 'lower(u.username) = $1';
  const sql = (cols: string) =>
    `SELECT ${cols} FROM giga_cloud.online_users u LEFT JOIN giga_cloud.shops s ON s.shop_id = u.shop_id
      WHERE ${where} AND u.active AND (u.shop_id IS NULL OR s.active) LIMIT 2`;
  const pick = (rows: any[]) => (rows.length === 1 ? rows[0] : undefined);
  try {
    return pick((await withCloud((c) => c.query(sql(`${base}, u.token_version, u.account_type, u.username`), [by]))).rows);
  } catch (err: any) {
    if (err?.code !== '42703') throw err;
    if (column === 'username') return undefined; // usernames exist online from cloud migration 005
    let row: any;
    try {
      row = pick((await withCloud((c) => c.query(sql(`${base}, u.token_version`), [by]))).rows);
    } catch (err2: any) {
      if (err2?.code !== '42703') throw err2;
      row = pick((await withCloud((c) => c.query(sql(base), [by]))).rows);
    }
    if (row) row.account_type = row.role === 'ADMIN' && !row.shop_id && !row.local_user_id ? 'GLOBAL_ADMIN' : 'SHOP_USER';
    return row ? { ...row, token_version: row.token_version ?? 0 } : row;
  }
}

// Emergency switches (giga_cloud.remote_control, migration 004), per shop, cached briefly per instance.
type ControlValue = { remote_writes_enabled: boolean; maintenance_mode: boolean; maintenance_message: string | null };
const controlCache = new Map<string, { at: number; value: ControlValue }>();
export async function getRemoteControl(shopId: string | null, fresh = false): Promise<ControlValue> {
  const key = String(shopId || '');
  const hit = controlCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.value;
  let value: ControlValue = { remote_writes_enabled: true, maintenance_mode: false, maintenance_message: null };
  try {
    const row = (await withCloud((c) => c.query(
      `SELECT remote_writes_enabled, maintenance_mode, maintenance_message FROM giga_cloud.remote_control WHERE shop_id = $1`, [shopId]
    ))).rows[0];
    if (row) value = row;
  } catch (err: any) {
    if (err?.code !== '42P01') throw err; // table missing = migration 004 not applied = defaults
  }
  controlCache.set(key, { at: Date.now(), value });
  return value;
}
export function clearRemoteControlCache(shopId?: string | null) {
  if (shopId === undefined) controlCache.clear();
  else controlCache.delete(String(shopId || ''));
}

/** Security event in giga_cloud.online_audit, tagged with the request's shop (never passwords/tokens). Best effort. */
export async function securityEvent(req: Request, action: string, email: string | null, userId: string | null, details: Record<string, unknown> = {}) {
  try {
    await withCloud((c) => c.query(
      `INSERT INTO giga_cloud.online_audit (shop_id, online_user_id, user_email, action, details, client_ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [(req as OnlineRequest).shopId || getOnlineConfig().shopId, userId, email ? email.slice(0, 200) : null, action, JSON.stringify(details),
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
  const code = err instanceof HttpError && typeof err.details?.code === 'string' ? { code: err.details.code } : {};
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Cloud database error.' : err.message, ...code });
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
  r.use(resolveShop);
  r.use(maintenanceGate);
  // "All Shops" (X-GIGA-SCOPE: ALL) is a read-only consolidated view: no shop-scoped write may run
  // from it. Only the explicit all-shops fan-out and the (shop-less) Global Administrator accounts.
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !isAllShopsScope(req)) return next();
    if (req.path.startsWith('/admin/all-shops/') || req.path.startsWith('/admin/accounts/global-admins') || req.path.startsWith('/auth/')
        || /^\/history\/sales\/[^/]+\/reprint$/.test(req.path)) return next(); // a reprint changes nothing (audit only)
    res.status(409).json({ error: 'All Shops is a read-only view. Select one shop to change it.', code: 'ALL_SHOPS_READ_ONLY' });
  });

  r.get('/health', async (_req, res) => {
    const cfg = getOnlineConfig();
    const base = { status: 'online', system: 'GIGA CHEMIST POS API', mode: 'online', app_mode: 'online', version, timestamp: Date.now(), read_only: false, cashier_sales: true, remote_admin_commands: true, local_database_required: false };
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

  // ONE login for every account: Global Administrators and shop staff (same password as at the shop).
  // PASSWORD ONLY: a shop PIN is never an internet credential (a "pin" field is ignored entirely).
  r.post('/auth/login', loginRateLimit, async (req, res) => {
    try {
      const identifier = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
      const secret = String(req.body?.password || '').trim();
      if (!identifier || !secret) return res.status(400).json({ error: 'Email/username and password are required.' });
      if (identifierLocked(identifier)) return res.status(429).json({ error: 'Too many failed attempts for this account. Wait 15 minutes.' });
      const user = await findOnlineUser(identifier, identifier.includes('@') ? 'email' : 'username', true);
      // Same answer for unknown user / wrong password / inactive account or shop (no enumeration).
      if (!verifyCredential(secret, user?.password_hash || LOGIN_DUMMY_HASH) || !user) {
        noteFailedLogin(identifier);
        await securityEvent(req, 'ONLINE_LOGIN_FAILED', identifier, user?.id ?? null);
        return res.status(401).json({ error: 'Invalid email/username or password.' });
      }
      loginFailures.delete(identifier);
      const ownShop = user.shop_id ? String(user.shop_id).toLowerCase() : null;
      const shopId = getOnlineConfig().shopId;
      (req as OnlineRequest).shopId = ownShop || shopId;
      if (user.role !== 'ADMIN') {
        const ctl = await getRemoteControl(ownShop || shopId);
        if (ctl.maintenance_mode) return res.status(503).json({ error: ctl.maintenance_message || 'The online app is in maintenance. Try again later.', code: 'MAINTENANCE' });
      }
      await securityEvent(req, 'ONLINE_LOGIN', user.email, user.id, { role: user.role });
      await withCloud((c) => c.query('UPDATE giga_cloud.online_users SET last_login_at = now() WHERE id = $1', [user.id]));
      const token = createJwtToken({ userId: user.id, role: user.role, email: user.email, name: user.name, tv: Number(user.token_version || 0) });
      res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role, active: true },
        permissions: ROLE_PERMISSIONS[user.role as UserRole], account: accountInfo(user) });
    } catch (err) {
      send(res, err, 'POST /auth/login');
    }
  });

  r.get('/auth/me', requireAuth, (req: OnlineRequest, res) => {
    const u = req.onlineUser!;
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, active: true }, permissions: ROLE_PERMISSIONS[u.role], account: accountInfo(u) });
  });

  // Terminals are a shop concept; online browsers are not registered.
  r.post('/devices/register', requireAuth, (_req, res) => res.json({ status: 'not_tracked_online' }));

  r.get('/settings', route('GET /settings', (req) => withShop(requestShop(req), async (c) => {
    try {
      return await getPharmacySettings(c);
    } catch {
      return toSettings({ pharmacy_name: 'GIGA CHEMIST' });
    }
  })));

  r.get('/sync/status', requireAuth, route('GET /sync/status', async (req) => {
    const shop = await withCloud((c) => c.query('SELECT last_event_at FROM giga_cloud.shops WHERE shop_id = $1', [requestShop(req)]));
    return { mode: 'online', enabled: false, read_only: false, cashier_sales: true, remote_admin_commands: true, local_database_required: false, local_database: { connected: true }, cloud_reachable: true, counts: null, last_sync: shop.rows[0]?.last_event_at || null };
  }));

  const stripCost = (req: OnlineRequest, rows: any[], fields: string[]) =>
    req.onlineUser!.role === 'CASHIER' ? rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fields.includes(k) ? 0 : v]))) : rows;

  r.get('/medicines', requirePermission('medicine.view'), route('GET /medicines', async (req) => stripCost(req, await withShop(requestShop(req), (c) => getAllMedicines(c)), ['purchase_price'])));
  r.get('/categories', requirePermission('medicine.view'), route('GET /categories', (req) => withShop(requestShop(req), async (c) => {
    const cats = await getAllCategories(c);
    if (cats.length > 0) return cats;
    // Fallback for shops where medicines do not have category_id foreign keys: derive from medicine categories/types
    const derived = await c.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(m.medicine_type), ''), 'General') AS name
         FROM medicines m
        WHERE COALESCE(m.status, 'active') <> 'archived'
        ORDER BY 1`
    );
    return derived.rows.map((row, idx) => ({
      id: `00000000-0000-0000-0000-${String(idx + 1).padStart(12, '0')}`,
      name: row.name,
    }));
  })));
  r.get('/batches', requirePermission('medicine.view'), route('GET /batches', async (req) => stripCost(req, await withShop(requestShop(req), (c) => getAllBatches(c)), ['purchase_price'])));
  r.get('/customers', requirePermission('sales.view_own'), route('GET /customers', (req) => withShop(requestShop(req), (c) => getAllCustomers(c))));

  r.get('/sales', requirePermission('sales.view_own'), route('GET /sales', async (req) => {
    const q = req.query;
    const isCashier = req.onlineUser!.role === 'CASHIER';
    return await withShop(requestShop(req), (c) => getOnlineSales(c, requestShop(req), {
      page: Number(q.page) || 1, limit: Number(q.limit) || 50, search: q.search as string, startDate: q.startDate as string, endDate: q.endDate as string,
      cashierId: cashierScope(req.onlineUser!) ?? (q.cashierId as string | undefined),
      paymentMethod: (q.paymentMethod as string) || undefined, customerId: (q.customerId as string) || undefined,
      priceMode: (q.priceMode as string) || undefined, status: (q.status as string) || undefined,
    }, isCashier));
  }));

  r.get('/sales/today-summary', requireAuth, route('GET /sales/today-summary', async (req) => {
    const s: any = await withShop(requestShop(req), (c) => getTodaySalesSummary({ cashierId: cashierScope(req.onlineUser!) ?? ((req.query.cashierId as string) || undefined) }, c));
    if (req.onlineUser!.role !== 'ADMIN') delete s.grossProfit;
    return s;
  }));

  r.get('/reports/summary', requirePermission('sales.view_own'), route('GET /reports/summary', (req) => withShop(requestShop(req), async (c) => {
    const isAdmin = req.onlineUser!.role === 'ADMIN';
    const range = await resolveRange(req.query.range, req.query.start, req.query.end, c);
    return getSalesReport(range, { cashierId: isAdmin ? ((req.query.cashierId as string) || null) : cashierScope(req.onlineUser!), includeCost: isAdmin }, c);
  })));

  // --- Online Cashier Sales: Controlled Atomic Write Path ---
  async function handleOnlineCheckout(req: OnlineRequest, res: Response) {
    try {
      const u = req.onlineUser!;
      const shopId = requestShop(req);
      const input = req.body || {};
      const result = await withCloud(async (client) => {
        await client.query('BEGIN');
        try {
          const out = await executeOnlineSaleCheckout(
            client,
            shopId,
            input,
            {
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              local_user_id: u.local_user_id,
              shop_id: u.shop_id,
            }
          );
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err: any) {
      send(res, err, 'POST /sales/checkout');
    }
  }

  r.post('/sales/checkout', requirePermission('sales.create'), handleOnlineCheckout);
  r.post('/sales', requirePermission('sales.create'), handleOnlineCheckout);


  r.get('/returns', requirePermission('returns.create'), route('GET /returns', (req) => withShop(requestShop(req), (c) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.toUpperCase() : undefined;
    return getAllReturns({ userId: cashierScope(req.onlineUser!), status }, c);
  })));

  r.get('/users', requireAdmin, route('GET /users', (req) => withShop(requestShop(req), async (c) =>
    (await c.query('SELECT id, name, email, username, role, active FROM users ORDER BY name')).rows)));
  r.get('/suppliers', requireAdmin, route('GET /suppliers', (req) => withShop(requestShop(req), (c) => getAllSuppliers(c))));
  r.get('/purchases', requireAdmin, route('GET /purchases', (req) => withShop(requestShop(req), (c) => getAllPurchases(c))));
  r.get('/expenses', requireAdmin, route('GET /expenses', (req) => withShop(requestShop(req), (c) => getAllExpenses(c))));

  // Admin HISTORY (sales + supply), read only. Shops are decided HERE: the request's authorized shop,
  // or every active shop for a Global Administrator viewing "All Shops" — never a browser-supplied list.
  // Shops are decided HERE: the request's authorized shop, or every active shop for a Global
  // Administrator viewing "All Shops" — never a browser-supplied list. Read-only transaction.
  const withCloudScope = async <T,>(req: Request, fn: (scope: HistoryScope) => Promise<T>): Promise<T> => {
    const u = (req as OnlineRequest).onlineUser!;
    let shopIds: string[];
    if (isAllShopsScope(req)) {
      if (!isGlobalAdmin(u)) throw new HttpError(403, 'Forbidden: only a Global Administrator can view all shops.');
      shopIds = (await withCloud((c) => c.query('SELECT shop_id FROM giga_cloud.shops WHERE active ORDER BY shop_code'))).rows.map((x: any) => String(x.shop_id));
    } else {
      shopIds = [requestShop(req)];
    }
    return withCloud(async (c) => {
      await c.query('BEGIN READ ONLY');
      try {
        const out = await fn({ q: c, mode: 'cloud', shopIds, includeCost: u.role === 'ADMIN' });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  };

  // Cashier shifts (cloud copy, read only). A shop CASHIER account sees only the shifts of its own shop
  // staff account (local_user_id); Administrators / Managers every shift of their authorized shop(s).
  // Reviewing a shift online = the SHIFT_REVIEW command (Remote administration), applied by the shop.
  //
  // GET /shifts/current: queries giga_cloud.cashier_shifts for the cashier's linked local_user_id and
  // the authorized shop. This handler is registered INSIDE buildShiftRouter before /shifts/:id so the
  // literal path segment "current" is never passed to shiftDetail()'s UUID validator.
  r.use(buildShiftRouter({
    canView: requirePermission('shift.view_own'),
    canViewAll: requirePermission('shift.view_all'),
    viewer: (req) => {
      const u = (req as OnlineRequest).onlineUser!;
      if (hasPermission(u.role, 'shift.view_all')) return { ownCashierId: null };
      if (!u.local_user_id) throw new HttpError(403, 'Forbidden: this online account is not linked to a shop staff account.');
      return { ownCashierId: String(u.local_user_id).toLowerCase() };
    },
    withScope: withCloudScope,
    send: (res, err, label) => send(res, err, label),
    /**
     * GET /shifts/current — cloud-copy implementation (Part 2).
     *
     * For a CASHIER: queries giga_cloud.cashier_shifts using the cashier's local_user_id (the shop
     * staff account that the online account is linked to) and the request's authorized shop_id.
     * Returns the most recent OPEN shift, or { shift: null } when none exists.
     * Never returns a fake / non-UUID shift id.
     *
     * For an Administrator / Manager (shift.view_all): /current is a cashier convenience endpoint.
     * We return null for non-cashier roles (they use /shifts list / /shifts/:id instead).
     */
    getCurrentShift: async (req) => {
      const u = (req as OnlineRequest).onlineUser!;
      // Administrators / Managers see the full shift list; /current is meaningful only for a cashier.
      if (!u.local_user_id) return { shift: null };
      const shopId = requestShop(req);
      const cashierId = String(u.local_user_id).toLowerCase();
      const cfg = getOnlineConfig();
      if (cfg.error) throw new HttpError(503, `Online API not configured: ${cfg.error}`);
      const client = await getPool(cfg).connect();
      try {
        // Query giga_cloud.cashier_shifts directly (the authoritative cloud mirror).
        const row = (await client.query(
          `SELECT shift_id AS id, status, opened_at, opened_business_date, opening_float, cashier_id,
                  cashier_name, shift_number, device_id, shop_id,
                  (data->>'total_transactions')::int      AS total_transactions,
                  (data->>'total_sales')::numeric         AS total_sales,
                  (data->>'cash_sales')::numeric          AS cash_sales,
                  (data->>'mpesa_sales')::numeric         AS mpesa_sales,
                  (data->>'card_sales')::numeric          AS card_sales,
                  (data->>'bank_sales')::numeric          AS bank_sales,
                  (data->>'other_sales')::numeric         AS other_sales,
                  (data->>'units_sold')::int              AS units_sold,
                  (data->>'voided_count')::int            AS voided_count,
                  (data->>'voided_total')::numeric        AS voided_total,
                  (data->>'returns_count')::int           AS returns_count,
                  (data->>'refund_total')::numeric        AS refund_total,
                  (data->>'cash_refunds')::numeric        AS cash_refunds,
                  (data->>'cash_expenses')::numeric       AS cash_expenses,
                  expected_cash, actual_cash, cash_variance,
                  closed_at, closed_business_date,
                  data->>'close_method'       AS close_method,
                  data->>'closing_notes'      AS closing_notes,
                  data->>'reviewed_by_name'   AS reviewed_by_name,
                  data->>'review_notes'       AS review_notes,
                  reviewed_at
             FROM giga_cloud.cashier_shifts
            WHERE shop_id = $1 AND cashier_id = $2 AND status = 'OPEN'
            ORDER BY opened_at DESC
            LIMIT 1`,
          [shopId, cashierId]
        )).rows[0];
        if (!row) return { shift: null };
        // Build live totals from the stored cloud columns (accumulated as SHIFT_OPENED/SHIFT_CLOSED
        // events are ingested; for an OPEN shift these reflect what has synced so far).
        const live = {
          total_transactions: Number(row.total_transactions ?? 0),
          total_sales:        Number(row.total_sales ?? 0),
          cash_sales:         Number(row.cash_sales ?? 0),
          mpesa_sales:        Number(row.mpesa_sales ?? 0),
          card_sales:         Number(row.card_sales ?? 0),
          bank_sales:         Number(row.bank_sales ?? 0),
          other_sales:        Number(row.other_sales ?? 0),
          units_sold:         Number(row.units_sold ?? 0),
          voided_count:       Number(row.voided_count ?? 0),
          voided_total:       Number(row.voided_total ?? 0),
          returns_count:      Number(row.returns_count ?? 0),
          refund_total:       Number(row.refund_total ?? 0),
          cash_refunds:       Number(row.cash_refunds ?? 0),
          cash_expenses:      Number(row.cash_expenses ?? 0),
          expected_cash:      row.expected_cash !== null ? Number(row.expected_cash) : null,
          mixed_transactions: 0,
          non_cash_refunds:   Number(row.refund_total ?? 0) - Number(row.cash_refunds ?? 0),
          net_sales:          Number(row.total_sales ?? 0),
        };
        return { shift: { ...row, live: true }, live };
      } finally {
        client.release();
      }
    },
  }));

  // Business day summary (read only) over the authorized shop(s).
  r.get('/business-day', requirePermission('reports.view'), async (req, res) => {
    try {
      res.json(await withCloudScope(req, (s) => businessDaySummary(s, req.query as any)));
    } catch (err) {
      send(res, err, 'GET /business-day');
    }
  });
  // Inventory intelligence (reorder / movement classes / expiry risk) over the authorized shop(s).
  r.use(buildInventoryRouter({ canView: requirePermission('inventory.view'), withScope: withCloudScope, send: (res, err, label) => send(res, err, label) }));

  r.use(buildHistoryRouter({
    canSales: requirePermission('sales.view_all'),
    canSupplies: requirePermission('stock.receive'),
    // Cashier / Manager / Shop Admin: their own shop only (resolveShop already refused any other shop).
    canStockHistory: requirePermission('history.stock.view'),
    canStockExport: requirePermission('reports.view'),
    mayPickSoldDate: (req) => hasPermission((req as OnlineRequest).onlineUser?.role as any, 'sales.view_all'),
    withScope: withCloudScope,
    auditReprint: (req, sale) => securityEvent(req, 'RECEIPT_REPRINTED', (req as OnlineRequest).onlineUser?.email ?? null, (req as OnlineRequest).onlineUser?.id ?? null,
      { sale_id: sale.id, receipt_number: sale.receipt_number, sale_shop_id: sale.shop_id }),
    send: (res, err, label) => send(res, err, label),
  }));

  // User management (GLOBAL Administrators only): cloud login mirror + staff commands for the selected shop.
  r.use(buildUserAdminRouter({ shopId: requestShop, withCloud, route, isGlobalAdmin, securityEvent }));

  // Remote administration (ADMIN only): queue commands for the shop; never a direct cloud write.
  r.use(buildRemoteAdminRouter({
    shopId: requestShop, withShop: (req, fn) => withShop(requestShop(req), fn), withShopId: withShop, withCloud, requireAdmin, route, getRemoteControl, clearRemoteControlCache, securityEvent,
    isGlobalAdmin,
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
