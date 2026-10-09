import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { hashCredential } from '../auth';
import { HttpError, isValidUuid } from '../db/client';
import { ASSIGNABLE_ROLES, validateCommandPayload, type CommandType } from '../sync/commandSchema';

/**
 * USER MANAGEMENT for GLOBAL Administrators (online). Two kinds of account (giga_cloud.online_users):
 *
 *   GLOBAL_ADMIN  cloud-only, every shop. Created / deactivated / password-reset here.
 *   SHOP_USER     one shop's staff account (local_user_id) with the SAME password at the shop and online.
 *
 * Shop staff changes are made in the cloud login mirror immediately (deactivation blocks online
 * login at once) AND queued as a command for the selected shop, in ONE cloud transaction. The shop
 * applies the command to its own PostgreSQL. Passwords are hashed here and stored only as the hash
 * in the login mirror; commands carry the account id and a credential VERSION — the shop fetches the
 * hash itself through the shop-authenticated gc_fetch_user_credential. No password and no hash is
 * ever written to a command, its display, an audit row, a log line or a response.
 *
 * Shop staff endpoints act on the request's AUTHORIZED shop (X-GIGA-SHOP-ID) and refuse an account of
 * another shop, so a change can never land in a shop the Administrator is not looking at.
 */
export interface UserAdminDeps {
  shopId: (req: Request) => string;
  withCloud: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  route: (label: string, fn: (req: any, res: Response) => Promise<unknown>) => (req: any, res: Response) => Promise<void>;
  isGlobalAdmin: (user: any) => boolean;
  securityEvent: (req: Request, action: string, email: string | null, userId: string | null, details?: Record<string, unknown>) => Promise<void>;
}

/** Same minimum as the shop's user screen (server/db/users.ts MIN_PASSWORD_LENGTH). */
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,49}$/;

function password(v: unknown): string {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  if (v.length > 200) throw new HttpError(400, 'Password is too long.');
  return v;
}
function email(v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e) || e.length > 255) throw new HttpError(400, 'A valid email address is required.');
  return e;
}
function name(v: unknown): string {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 255) throw new HttpError(400, 'Name is required (max 255 characters).');
  return n;
}
function username(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(u)) throw new HttpError(400, 'Username must be 3-50 characters: letters, digits, dot, underscore or hyphen (not an email).');
  return u;
}
function role(v: unknown): string {
  if (typeof v !== 'string' || !(ASSIGNABLE_ROLES as readonly string[]).includes(v)) throw new HttpError(400, `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  return v;
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false.`);
  return v;
}
function clientIp(req: Request): string {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 100);
}

/** Cloud error codes raised by the database functions / triggers. */
function mapDbError(err: any): never {
  if (err instanceof HttpError) throw err;
  if (err?.code === 'PT409') throw new HttpError(409, 'The last active Global Administrator cannot be removed, deactivated or demoted.');
  if (err?.code === 'PT423') throw new HttpError(423, 'Remote changes are disabled for this shop (emergency switch).');
  if (err?.code === 'PT404') throw new HttpError(409, 'The shop is not registered (or inactive) in the cloud.');
  if (err?.code === 'PT403') throw new HttpError(403, 'Forbidden: this account may not manage that shop.');
  if (err?.code === '23505') throw new HttpError(409, 'That email or username is already used by another account.');
  if (err?.code === '42703' || err?.code === '23514') throw new HttpError(503, 'User management needs cloud migration 005 (unified authentication).');
  throw err;
}

async function tx<T>(deps: UserAdminDeps, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return deps.withCloud(async (c) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      mapDbError(err);
    }
  });
}

/** Queues one staff command for the shop inside the caller's transaction (no secret in payload or display). */
async function queue(c: pg.PoolClient, req: any, shopId: string, type: CommandType, payload: Record<string, unknown>, display: Record<string, unknown>) {
  const clean = validateCommandPayload(type, payload);
  const shop = (await c.query('SELECT shop_code, name FROM giga_cloud.shops WHERE shop_id = $1', [shopId])).rows[0];
  const row = (await c.query(
    `SELECT * FROM giga_cloud.queue_online_command($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb)`,
    [shopId, type, JSON.stringify(clean), `online:${req.onlineUser.id}:${crypto.randomUUID()}`, req.onlineUser.id, clientIp(req),
     String(req.headers['user-agent'] || '').slice(0, 300),
     JSON.stringify({ ...display, target_shop: { shop_id: shopId, shop_code: shop?.shop_code ?? null, name: shop?.name ?? null } })]
  )).rows[0];
  return { command_id: row.command_id, command_type: type, status: row.status, shop_id: shopId, shop_code: shop?.shop_code ?? null };
}

const ACCOUNT_COLUMNS = `id, account_type, shop_id, local_user_id, name, email, username, role, active, last_login_at, created_at,
                         credential_version, credential_source, deactivated_at`;

export function buildUserAdminRouter(deps: UserAdminDeps) {
  const r = express.Router();
  const { route } = deps;

  const requireGlobalAdmin = (req: any, res: Response, next: NextFunction) => {
    if (!req.onlineUser) return res.status(401).json({ error: 'Unauthorized: valid Bearer token required.' });
    if (!deps.isGlobalAdmin(req.onlineUser)) return res.status(403).json({ error: 'Forbidden: Global Administrator only.', code: 'GLOBAL_ADMIN_ONLY' });
    next();
  };

  /** The selected shop's staff account (locked); refuses an account of another shop. */
  async function shopUser(c: pg.PoolClient, req: any, localUserId: string) {
    if (!isValidUuid(localUserId)) throw new HttpError(400, 'Staff account id must be a UUID.');
    const shopId = deps.shopId(req);
    const identity = (await c.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM giga_cloud.online_users WHERE local_user_id = $1 AND account_type = 'SHOP_USER' AND shop_id = $2 FOR UPDATE`,
      [localUserId, shopId])).rows[0] || null;
    const profile = (await c.query(`SELECT name, email, role, active FROM giga_cloud.users WHERE shop_id = $1 AND user_id = $2`, [shopId, localUserId])).rows[0] || null;
    if (!identity && !profile) {
      const elsewhere = (await c.query(`SELECT 1 FROM giga_cloud.online_users WHERE local_user_id = $1 UNION ALL SELECT 1 FROM giga_cloud.users WHERE user_id = $1 LIMIT 1`, [localUserId])).rows[0];
      throw new HttpError(elsewhere ? 409 : 404, elsewhere
        ? 'That staff account belongs to another shop. Select its shop first.'
        : 'Staff account not found in the selected shop.');
    }
    return { shopId, identity, profile };
  }

  // ------------------------------------------------------------------ list
  r.get('/admin/accounts', requireGlobalAdmin, route('GET /admin/accounts', async (req) => {
    const q = String(req.query.shop || '').trim().toLowerCase();
    const shopFilter = q === 'all' ? null : isValidUuid(q) ? q : deps.shopId(req);
    return deps.withCloud(async (c) => {
      try {
        const globals = (await c.query(
          `SELECT id, name, email, active, last_login_at, created_at, deactivated_at FROM giga_cloud.online_users
            WHERE account_type = 'GLOBAL_ADMIN' ORDER BY active DESC, email`)).rows;
        const staff = (await c.query(
          `SELECT COALESCE(o.shop_id, p.shop_id) AS shop_id, s.shop_code, s.name AS shop_name,
                  COALESCE(o.local_user_id, p.user_id) AS local_user_id, o.id AS online_account_id,
                  COALESCE(p.name, o.name) AS name, COALESCE(p.email, o.email) AS email, COALESCE(o.username, p.username) AS username,
                  COALESCE(p.role, o.role) AS role, p.active AS shop_active, o.active AS online_active,
                  (o.id IS NOT NULL AND o.active) AS online_login_enabled, o.credential_version, o.last_login_at,
                  (SELECT COUNT(*)::int FROM giga_cloud.commands cm WHERE cm.shop_id = COALESCE(o.shop_id, p.shop_id)
                      AND cm.status IN ('PENDING', 'DELIVERED') AND cm.payload ->> 'user_id' = COALESCE(o.local_user_id, p.user_id)::text) AS open_commands
             FROM (SELECT * FROM giga_cloud.online_users WHERE account_type = 'SHOP_USER' AND local_user_id IS NOT NULL) o
             FULL JOIN giga_cloud.users p ON p.shop_id = o.shop_id AND p.user_id = o.local_user_id
             LEFT JOIN giga_cloud.shops s ON s.shop_id = COALESCE(o.shop_id, p.shop_id)
            WHERE $1::uuid IS NULL OR COALESCE(o.shop_id, p.shop_id) = $1::uuid
            ORDER BY s.shop_code, 6`, [shopFilter])).rows;
        return { shop_filter: shopFilter ?? 'all', global_admins: globals, shop_users: staff };
      } catch (err) {
        mapDbError(err);
      }
    });
  }));

  // ------------------------------------------------------------------ shop staff
  // Create: cloud login identity now (online login works at once) + USER_CREATE for the selected shop.
  r.post('/admin/accounts/shop-users', requireGlobalAdmin, route('POST /admin/accounts/shop-users', async (req, res) => {
    const b = req.body || {};
    const data = { name: name(b.name), email: email(b.email), username: username(b.username), role: role(b.role) };
    const hash = hashCredential(password(b.password)).combined;
    const shopId = deps.shopId(req);
    const localUserId = crypto.randomUUID();
    const out = await tx(deps, async (c) => {
      const taken = (await c.query(
        `SELECT 1 FROM giga_cloud.online_users WHERE lower(email) = $1
         UNION ALL SELECT 1 FROM giga_cloud.users WHERE shop_id = $2 AND lower(email) = $1
         UNION ALL SELECT 1 FROM giga_cloud.users WHERE shop_id = $2 AND $3::text IS NOT NULL AND lower(username) = $3 LIMIT 1`,
        [data.email, shopId, data.username])).rows[0];
      if (taken) throw new HttpError(409, 'That email or username is already used by another account.');
      const account = (await c.query(
        `INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, local_user_id, account_type, username,
                                              credential_version, credential_updated_at, credential_source)
         VALUES ($1, $2, $3, $4, $5, $6, 'SHOP_USER', $7, 1, now(), 'CLOUD') RETURNING ${ACCOUNT_COLUMNS}`,
        [data.email, data.name, data.role, hash, shopId, localUserId, data.username])).rows[0];
      const command = await queue(c, req, shopId, 'USER_CREATE',
        { user_id: localUserId, name: data.name, email: data.email, username: data.username, role: data.role, credential_version: 1 },
        { user_name: data.name, role_after: data.role });
      return { account, command };
    });
    await deps.securityEvent(req, 'USER_CREATED', req.onlineUser.email, req.onlineUser.id,
      { target_local_user_id: localUserId, target_email: data.email, shop_id: shopId, role: data.role, command_id: out.command.command_id });
    res.status(201);
    return out;
  }));

  r.post('/admin/accounts/shop-users/:localUserId/password', requireGlobalAdmin, route('POST shop-user password', async (req) => {
    const hash = hashCredential(password(req.body?.password)).combined;
    const out = await tx(deps, async (c) => {
      const { shopId, identity, profile } = await shopUser(c, req, req.params.localUserId);
      if (!identity) throw new HttpError(409, 'This staff member has no online login yet (the shop has not published its credentials). Reset the password at the shop.');
      const updated = (await c.query(
        `UPDATE giga_cloud.online_users SET password_hash = $2, credential_version = credential_version + 1, credential_updated_at = now(),
                credential_source = 'CLOUD', token_version = token_version + 1, updated_at = now()
          WHERE id = $1 RETURNING credential_version`, [identity.id, hash])).rows[0];
      const command = await queue(c, req, shopId, 'USER_CREDENTIAL_REFRESH',
        { user_id: identity.local_user_id, credential_version: Number(updated.credential_version), reason: 'Password reset by Global Administrator' },
        { user_name: profile?.name || identity.name });
      return { local_user_id: identity.local_user_id, credential_version: Number(updated.credential_version), sessions_revoked: true, command, email: identity.email, shopId };
    });
    const details = { target_local_user_id: out.local_user_id, target_email: out.email, shop_id: out.shopId, credential_version: out.credential_version, command_id: out.command.command_id };
    await deps.securityEvent(req, 'USER_PASSWORD_RESET', req.onlineUser.email, req.onlineUser.id, details);
    await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { ...details, reason: 'password reset' });
    const { email: _e, shopId: _s, ...body } = out;
    return body;
  }));

  r.post('/admin/accounts/shop-users/:localUserId/active', requireGlobalAdmin, route('POST shop-user active', async (req) => {
    const active = bool(req.body?.active, 'active');
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason : active ? 'Reactivated by Global Administrator' : 'Deactivated by Global Administrator';
    const out = await tx(deps, async (c) => {
      const { shopId, identity, profile } = await shopUser(c, req, req.params.localUserId);
      if (identity) {
        await c.query(
          `UPDATE giga_cloud.online_users SET active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END,
                  deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now() WHERE id = $1`, [identity.id, active]);
      }
      const command = await queue(c, req, shopId, 'USER_SET_ACTIVE', { user_id: req.params.localUserId.toLowerCase(), active, reason },
        { user_name: profile?.name || identity?.name, active_before: profile?.active ?? identity?.active ?? null });
      return { local_user_id: req.params.localUserId.toLowerCase(), active, online_login_blocked: !active, command, shopId, before: profile?.active ?? identity?.active ?? null, email: profile?.email || identity?.email };
    });
    await deps.securityEvent(req, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', req.onlineUser.email, req.onlineUser.id,
      { target_local_user_id: out.local_user_id, target_email: out.email, shop_id: out.shopId, active_before: out.before, command_id: out.command.command_id });
    if (!active) await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { target_local_user_id: out.local_user_id, shop_id: out.shopId, reason: 'deactivated' });
    const { shopId: _s, before: _b, email: _e, ...body } = out;
    return body;
  }));

  r.post('/admin/accounts/shop-users/:localUserId/role', requireGlobalAdmin, route('POST shop-user role', async (req) => {
    const newRole = role(req.body?.role);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason : 'Role changed by Global Administrator';
    const out = await tx(deps, async (c) => {
      const { shopId, identity, profile } = await shopUser(c, req, req.params.localUserId);
      const before = profile?.role || identity?.role || null;
      if (identity) {
        await c.query(
          `UPDATE giga_cloud.online_users SET role = $2, token_version = token_version + CASE WHEN role = 'ADMIN' AND $2 <> 'ADMIN' THEN 1 ELSE 0 END,
                  updated_at = now() WHERE id = $1`, [identity.id, newRole]);
      }
      const command = await queue(c, req, shopId, 'USER_ROLE_UPDATE', { user_id: req.params.localUserId.toLowerCase(), role: newRole, reason },
        { user_name: profile?.name || identity?.name, role_before: before, role_after: newRole });
      return { local_user_id: req.params.localUserId.toLowerCase(), role_before: before, role: newRole, command, shopId, email: profile?.email || identity?.email };
    });
    await deps.securityEvent(req, 'USER_ROLE_CHANGED', req.onlineUser.email, req.onlineUser.id,
      { target_local_user_id: out.local_user_id, target_email: out.email, shop_id: out.shopId, role_before: out.role_before, role_after: out.role, command_id: out.command.command_id });
    const { shopId: _s, email: _e, ...body } = out;
    return body;
  }));

  r.post('/admin/accounts/shop-users/:localUserId/revoke-sessions', requireGlobalAdmin, route('POST shop-user revoke', async (req) => {
    const out = await tx(deps, async (c) => {
      const { shopId, identity } = await shopUser(c, req, req.params.localUserId);
      if (!identity) throw new HttpError(409, 'This staff member has no online login.');
      await c.query('UPDATE giga_cloud.online_users SET token_version = token_version + 1, updated_at = now() WHERE id = $1', [identity.id]);
      return { local_user_id: identity.local_user_id, email: identity.email, shopId };
    });
    await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { target_local_user_id: out.local_user_id, target_email: out.email, shop_id: out.shopId });
    return { local_user_id: out.local_user_id, sessions_revoked: true };
  }));

  // "Remove" a staff member = deactivate: historical sales, audits and movements keep the identity.
  r.delete('/admin/accounts/shop-users/:localUserId', requireGlobalAdmin, (_req, res) => {
    res.status(409).json({ error: 'Shop staff accounts are never deleted (historical records reference them). Deactivate the account instead.', code: 'DEACTIVATE_INSTEAD' });
  });

  // ------------------------------------------------------------------ global administrators
  r.post('/admin/accounts/global-admins', requireGlobalAdmin, route('POST global-admin', async (req, res) => {
    const b = req.body || {};
    const data = { name: name(b.name), email: email(b.email) };
    const hash = hashCredential(password(b.password)).combined;
    const account = await tx(deps, async (c) => {
      if ((await c.query('SELECT 1 FROM giga_cloud.online_users WHERE lower(email) = $1', [data.email])).rows[0]) {
        throw new HttpError(409, 'That email is already used by another account.');
      }
      return (await c.query(
        `INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, local_user_id, account_type, credential_source)
         VALUES ($1, $2, 'ADMIN', $3, NULL, NULL, 'GLOBAL_ADMIN', 'CLOUD') RETURNING ${ACCOUNT_COLUMNS}`, [data.email, data.name, hash])).rows[0];
    });
    await deps.securityEvent(req, 'GLOBAL_ADMIN_CREATED', req.onlineUser.email, req.onlineUser.id, { target_id: account.id, target_email: account.email });
    res.status(201);
    return { account };
  }));

  async function globalAdmin(c: pg.PoolClient, id: string) {
    if (!isValidUuid(id)) throw new HttpError(400, 'Account id must be a UUID.');
    const row = (await c.query(`SELECT ${ACCOUNT_COLUMNS} FROM giga_cloud.online_users WHERE id = $1 AND account_type = 'GLOBAL_ADMIN' FOR UPDATE`, [id])).rows[0];
    if (!row) throw new HttpError(404, 'Global Administrator not found.');
    return row;
  }

  r.post('/admin/accounts/global-admins/:id/active', requireGlobalAdmin, route('POST global-admin active', async (req) => {
    const active = bool(req.body?.active, 'active');
    const row = await tx(deps, async (c) => {
      const target = await globalAdmin(c, req.params.id);
      return (await c.query(
        `UPDATE giga_cloud.online_users SET active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END,
                deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now() WHERE id = $1 RETURNING id, email, active`,
        [target.id, active])).rows[0];
    });
    await deps.securityEvent(req, active ? 'GLOBAL_ADMIN_ACTIVATED' : 'GLOBAL_ADMIN_DEACTIVATED', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, target_email: row.email });
    if (!active) await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, reason: 'deactivated' });
    return row;
  }));

  r.post('/admin/accounts/global-admins/:id/password', requireGlobalAdmin, route('POST global-admin password', async (req) => {
    const hash = hashCredential(password(req.body?.password)).combined;
    const row = await tx(deps, async (c) => {
      const target = await globalAdmin(c, req.params.id);
      return (await c.query(
        `UPDATE giga_cloud.online_users SET password_hash = $2, credential_version = credential_version + 1, credential_updated_at = now(),
                credential_source = 'CLOUD', token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING id, email`, [target.id, hash])).rows[0];
    });
    await deps.securityEvent(req, 'USER_PASSWORD_RESET', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, target_email: row.email, account_type: 'GLOBAL_ADMIN' });
    await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, reason: 'password reset' });
    return { id: row.id, sessions_revoked: true, note: row.id === req.onlineUser.id ? 'Your own sessions were revoked: sign in again.' : undefined };
  }));

  r.post('/admin/accounts/global-admins/:id/revoke-sessions', requireGlobalAdmin, route('POST global-admin revoke', async (req) => {
    const row = await tx(deps, async (c) => {
      const target = await globalAdmin(c, req.params.id);
      return (await c.query('UPDATE giga_cloud.online_users SET token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING id, email', [target.id])).rows[0];
    });
    await deps.securityEvent(req, 'SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, target_email: row.email });
    return { id: row.id, sessions_revoked: true };
  }));

  // Permanent deletion only for an account that never acted (no command, no audit trail) and is not
  // the last active Global Administrator (also enforced by a database trigger). Otherwise: deactivate.
  r.delete('/admin/accounts/global-admins/:id', requireGlobalAdmin, route('DELETE global-admin', async (req) => {
    if (req.params.id === req.onlineUser.id) throw new HttpError(409, 'You cannot delete your own account.');
    const row = await tx(deps, async (c) => {
      const target = await globalAdmin(c, req.params.id);
      const refs = (await c.query(
        `SELECT (SELECT COUNT(*) FROM giga_cloud.commands WHERE created_by_user_id = $1)
              + (SELECT COUNT(*) FROM giga_cloud.online_audit WHERE online_user_id = $1) AS n`, [target.id])).rows[0];
      if (Number(refs.n) > 0) throw new HttpError(409, 'This account has history (commands or audit records). Deactivate it instead of deleting.');
      await c.query('DELETE FROM giga_cloud.online_users WHERE id = $1', [target.id]);
      return target;
    });
    await deps.securityEvent(req, 'GLOBAL_ADMIN_DELETED', req.onlineUser.email, req.onlineUser.id, { target_id: row.id, target_email: row.email });
    return { id: row.id, deleted: true };
  }));

  return r;
}
