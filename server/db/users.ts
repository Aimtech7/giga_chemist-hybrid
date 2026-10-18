import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, isValidUuid, withTransaction, type Queryable } from './client';
import { hashCredential, verifyCredential } from '../auth';
import type { User, UserRole } from '../../src/types';
import { enqueueSyncEvent, userJson } from '../sync/outbox';

/**
 * Staff accounts live ONLY in the PostgreSQL users table. Credentials are PBKDF2-SHA512 hashes in
 * the self-contained "salt$hash" format (server/auth.ts). Plaintext secrets are never stored or logged.
 */

/** Roles that can be assigned through user management: every RBAC role (server/auth.ts). */
export const ASSIGNABLE_ROLES: UserRole[] = ['ADMIN', 'MANAGER', 'CASHIER'];
export const MIN_PASSWORD_LENGTH = 8;
const PIN_PATTERN = /^\d{4,6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same rule as chk_users_username_format (migration 011); stored lower-case. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;

interface UserRow {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: UserRole;
  phone: string | null;
  active: boolean;
  password_hash: string;
  pin_hash: string;
  created_at: Date | null;
  updated_at: Date | null;
  last_login: Date | null;
}

const PUBLIC_COLUMNS = 'id, name, email, username, role, phone, active, created_at, updated_at, last_login';

function toUser(r: any): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    username: r.username || undefined,
    role: r.role,
    phone: r.phone || undefined,
    active: Boolean(r.active),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
    last_login: r.last_login ? new Date(r.last_login).toISOString() : undefined,
  } as User;
}

function requireRole(role: unknown): UserRole {
  if (typeof role !== 'string' || !ASSIGNABLE_ROLES.includes(role as UserRole)) {
    throw new HttpError(400, `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  }
  return role as UserRole;
}

function requireEmail(email: unknown): string {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(clean) || clean.length > 255) throw new HttpError(400, 'A valid email address is required.');
  return clean;
}

/** undefined = unchanged; null/'' = remove username; otherwise 3-50 chars [a-z0-9._-], stored lower-case. */
function optionalUsername(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(clean)) {
    throw new HttpError(400, 'Username must be 3-50 characters: letters, digits, dot, underscore or hyphen (not an email).');
  }
  return clean;
}

/** Maps a unique violation to the field that collided. */
function duplicateMessage(err: any, email?: string, username?: string | null): string {
  return String(err?.constraint || '').includes('username')
    ? `Username "${username}" is already in use by another staff member.`
    : `A user account with email "${email}" already exists.`;
}

function requireName(name: unknown): string {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > 255) throw new HttpError(400, 'Name is required (max 255 characters).');
  return clean;
}

export function validatePassword(password: unknown, field = 'Password'): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `${field} must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  if (password.length > 200) throw new HttpError(400, `${field} is too long.`);
  return password;
}

function validatePin(pin: unknown): string {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
    throw new HttpError(400, 'PIN must be 4 to 6 digits.');
  }
  return pin;
}

/** pin_hash is NOT NULL: accounts without a PIN get a hash of random bytes nobody knows. */
export function unusablePinHash(): string {
  return hashCredential(crypto.randomBytes(32).toString('hex')).combined;
}

function uniqueViolation(err: any): boolean {
  return err?.code === '23505';
}

/** Throws 409 unless at least one OTHER active ADMIN remains. Locks the admin rows to serialize. */
async function assertAnotherActiveAdmin(q: Queryable, excludingUserId: string) {
  const res = await q.query(
    `SELECT id FROM users WHERE role = 'ADMIN' AND active = true AND id <> $1 FOR UPDATE`,
    [excludingUserId]
  );
  if (res.rows.length === 0) {
    throw new HttpError(409, 'There must be at least one active Administrator. This change would remove the last one.');
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAllUsers(): Promise<User[]> {
  const res = await pgPool.query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY name`);
  return res.rows.map(toUser);
}

export async function getUserById(id: string): Promise<User | null> {
  if (!isValidUuid(id)) return null;
  const res = await pgPool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

let sessionRevocationSupported: boolean | null = null;

/**
 * Fresh identity for an authenticated request: role and active flag come from the DB, not the token.
 * A token issued (iat, seconds) before users.sessions_revoked_at (migration 017; set by a remote
 * USER_SESSION_REVOKE) is refused, so revoking signs the account out of every shop terminal.
 */
export async function getActiveUserForSession(id: string, issuedAt?: number): Promise<User | null> {
  const user = await getUserById(id);
  if (!user || !user.active) return null;
  if (issuedAt !== undefined && sessionRevocationSupported !== false) {
    try {
      const r = await pgPool.query('SELECT EXTRACT(EPOCH FROM sessions_revoked_at)::bigint AS at FROM users WHERE id = $1', [id]);
      sessionRevocationSupported = true;
      const at = r.rows[0]?.at;
      if (at !== null && at !== undefined && Number(issuedAt) < Number(at)) return null;
    } catch (err: any) {
      if (err?.code !== '42703') throw err;
      sessionRevocationSupported = false; // migration 017 not applied yet: no revocation marker exists
    }
  }
  return user;
}

/** Signs one account out of every shop terminal (tokens issued before now are refused). */
export async function revokeUserSessionsTx(client: pg.PoolClient, userId: string): Promise<string> {
  const r = await client.query('UPDATE users SET sessions_revoked_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING sessions_revoked_at', [userId]);
  if (!r.rows[0]) throw new HttpError(404, 'This user does not exist in the shop.');
  return new Date(r.rows[0].sessions_revoked_at).toISOString();
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** A real hash to verify against when the account does not exist, so timing does not reveal it. */
const DUMMY_HASH = hashCredential(crypto.randomBytes(16).toString('hex')).combined;

export async function authenticateUser(identifier: string, secret: string): Promise<User> {
  const login = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
  const cleanSecret = typeof secret === 'string' ? secret.trim() : '';
  if (!login || !cleanSecret) throw new HttpError(400, 'Email or username and password (or PIN) are required.');

  // The identifier must resolve to exactly one account: email if it contains '@', otherwise the
  // username. The secret is only ever checked against THAT account.
  const res = login.includes('@')
    ? await pgPool.query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [login])
    : await pgPool.query(`SELECT * FROM users WHERE LOWER(username) = $1 LIMIT 1`, [login]);
  const row: UserRow | undefined = res.rows[0];

  if (!row) {
    verifyCredential(cleanSecret, DUMMY_HASH);
    throw new HttpError(401, 'Invalid email/username or password.');
  }

  const passwordOk = verifyCredential(cleanSecret, row.password_hash);
  const pinOk = !passwordOk && PIN_PATTERN.test(cleanSecret) && verifyCredential(cleanSecret, row.pin_hash);
  if (!passwordOk && !pinOk) throw new HttpError(401, 'Invalid email/username or password.');

  if (!row.active) {
    throw new HttpError(403, 'This staff account has been deactivated. Please contact an Administrator.');
  }

  await pgPool.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
  return toUser({ ...row, last_login: new Date() });
}

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

export async function createUser(data: {
  name: string;
  email: string;
  username?: string | null;
  role: UserRole;
  password?: string;
  pin?: string;
  phone?: string;
  active?: boolean;
  created_by?: string;
}): Promise<User> {
  const name = requireName(data.name);
  const email = requireEmail(data.email);
  const role = requireRole(data.role);
  const username = optionalUsername(data.username) ?? null;
  const password = validatePassword(data.password);
  const pinHash = data.pin ? hashCredential(validatePin(String(data.pin))).combined : unusablePinHash();
  const phone = typeof data.phone === 'string' && data.phone.trim() ? data.phone.trim().slice(0, 50) : null;

  try {
    return await withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO users (id, name, email, username, role, phone, active, password_hash, pin_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING ${PUBLIC_COLUMNS}`,
        [crypto.randomUUID(), name, email, username, role, phone, data.active !== false, hashCredential(password).combined, pinHash]
      );
      const user = toUser(res.rows[0]);
      await enqueueSyncEvent(client, {
        event_type: 'USER_UPSERTED', entity_type: 'user', entity_id: user.id, operation: 'CREATE',
        data: async () => ({ user: await userJson(client, user.id) }),
        actor: { user_id: data.created_by || null },
      });
      return user;
    });
  } catch (err: any) {
    if (uniqueViolation(err)) throw new HttpError(409, duplicateMessage(err, email, username));
    throw err;
  }
}

export async function updateUser(
  id: string,
  updates: Partial<{ name: string; email: string; username: string | null; role: UserRole; phone: string; active: boolean; pin?: string }>,
  actorId?: string
): Promise<User> {
  return withTransaction((client) => updateUserTx(client, id, updates, actorId));
}

/** updateUser on the caller's transaction (used by inbound cloud commands). */
export async function updateUserTx(
  client: pg.PoolClient,
  id: string,
  updates: Partial<{ name: string; email: string; username: string | null; role: UserRole; phone: string; active: boolean; pin?: string }>,
  actorId?: string
): Promise<User> {
  if (!isValidUuid(id)) throw new HttpError(400, 'User id must be a valid UUID.');
  const name = updates.name !== undefined ? requireName(updates.name) : undefined;
  const email = updates.email !== undefined ? requireEmail(updates.email) : undefined;
  const username = optionalUsername(updates.username);
  const role = updates.role !== undefined ? requireRole(updates.role) : undefined;
  const active = updates.active !== undefined ? Boolean(updates.active) : undefined;
  const phone =
    updates.phone !== undefined ? (String(updates.phone).trim().slice(0, 50) || null) : undefined;
  const pinHash =
    updates.pin !== undefined && updates.pin !== null && String(updates.pin).trim() !== ''
      ? hashCredential(validatePin(String(updates.pin))).combined
      : undefined;

  const found = await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [id]);
  const target: UserRow | undefined = found.rows[0];
  if (!target) throw new HttpError(404, 'User not found.');

  const losingAdmin =
    target.role === 'ADMIN' && target.active && ((role !== undefined && role !== 'ADMIN') || active === false);
  if (losingAdmin) {
    if (actorId && actorId === id) {
      throw new HttpError(409, 'You cannot remove your own Administrator role or deactivate your own account.');
    }
    await assertAnotherActiveAdmin(client, id);
  }

  try {
    const res = await client.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         role = COALESCE($3, role),
         phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
         active = COALESCE($6, active),
         username = CASE WHEN $8::boolean THEN $9 ELSE username END,
         pin_hash = CASE WHEN $10::boolean THEN $11 ELSE pin_hash END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        name ?? null,
        email ?? null,
        role ?? null,
        phone !== undefined,
        phone ?? null,
        active ?? null,
        id,
        username !== undefined,
        username ?? null,
        pinHash !== undefined,
        pinHash ?? null,
      ]
    );
    const user = toUser(res.rows[0]);
    await enqueueSyncEvent(client, {
      event_type: 'USER_UPSERTED', entity_type: 'user', entity_id: id, operation: 'UPDATE',
      data: async () => ({ user: await userJson(client, id) }),
      actor: { user_id: actorId || null },
    });
    return user;
  } catch (err: any) {
    if (uniqueViolation(err)) throw new HttpError(409, duplicateMessage(err, email, username));
    throw err;
  }
}

export async function toggleUserStatus(id: string, active: boolean, actorId?: string): Promise<User> {
  return updateUser(id, { active }, actorId);
}

export async function changeUserPassword(data: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; message: string }> {
  const newPassword = validatePassword(data.newPassword, 'New password');
  if (!isValidUuid(data.userId)) throw new HttpError(400, 'Invalid user.');

  const res = await pgPool.query(`SELECT password_hash FROM users WHERE id = $1`, [data.userId]);
  if (!res.rows[0]) throw new HttpError(404, 'User not found.');
  if (!verifyCredential(String(data.currentPassword || ''), res.rows[0].password_hash)) {
    throw new HttpError(400, 'Incorrect current password.');
  }
  await pgPool.query(
    `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [hashCredential(newPassword).combined, data.userId]
  );
  return { success: true, message: 'Password changed successfully.' };
}

export async function adminResetUserPassword(data: {
  targetUserId: string;
  newPassword?: string;
  newPin?: string;
  adminUserId?: string;
  adminPassword?: string;
}): Promise<{ success: boolean; message: string }> {
  if (!data.newPassword && !data.newPin) throw new HttpError(400, 'Provide a new password and/or a new PIN.');
  const passwordHash = data.newPassword
    ? hashCredential(validatePassword(data.newPassword, 'New password')).combined
    : null;
  if (!isValidUuid(data.targetUserId)) throw new HttpError(400, 'User id must be a valid UUID.');

  // Optional re-confirmation of the acting Administrator's own password.
  if (data.adminPassword) {
    const admin = await pgPool.query(`SELECT password_hash, role FROM users WHERE id = $1`, [data.adminUserId]);
    if (!admin.rows[0] || admin.rows[0].role !== 'ADMIN' || !verifyCredential(data.adminPassword, admin.rows[0].password_hash)) {
      throw new HttpError(403, 'Administrator confirmation password incorrect.');
    }
  }

  const pinHash = data.newPin ? hashCredential(validatePin(String(data.newPin))).combined : null;
  const res = await pgPool.query(
    `UPDATE users SET password_hash = COALESCE($1, password_hash), pin_hash = COALESCE($2, pin_hash),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 RETURNING name`,
    [passwordHash, pinHash, data.targetUserId]
  );
  if (!res.rows[0]) throw new HttpError(404, 'Target user account not found.');
  const what = passwordHash && pinHash ? 'Password and PIN' : passwordHash ? 'Password' : 'PIN';
  return { success: true, message: `${what} for ${res.rows[0].name} was successfully reset.` };
}

export async function adminSetUserPin(
  targetUserId: string,
  newPin: string,
  adminUserId?: string
): Promise<{ success: boolean; message: string }> {
  return adminResetUserPassword({ targetUserId, newPin, adminUserId });
}

export interface DeleteOrArchiveResult {
  action: 'deleted' | 'archived';
  id: string;
  user?: User;
  reason: string;
}

/**
 * Safely deletes or archives a user.
 * - Current admin cannot delete themselves.
 * - Last active admin cannot be deleted or archived.
 * - If account has historical references (sales, shifts, audit, movements, purchases, etc.):
 *     archived and deactivated (active = false, sessions revoked).
 * - If account has zero historical references:
 *     permanently deleted from users table and sync event emitted.
 */
export async function deleteOrArchiveUser(
  userId: string,
  actorId?: string
): Promise<DeleteOrArchiveResult> {
  if (!isValidUuid(userId)) throw new HttpError(400, 'User id must be a valid UUID.');
  if (actorId && actorId === userId) {
    throw new HttpError(409, 'You cannot delete or archive your own account.');
  }

  return withTransaction(async (client) => {
    const found = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const target: UserRow | undefined = found.rows[0];
    if (!target) throw new HttpError(404, 'User not found.');

    // Protect last active administrator
    if (target.role === 'ADMIN' && target.active) {
      await assertAnotherActiveAdmin(client, userId);
    }

    // Check historical transaction references
    const tablesToCheck = [
      { table: 'sales', cols: ['cashier_id', 'voided_by'] },
      { table: 'cashier_shifts', cols: ['cashier_id', 'opened_by', 'closed_by', 'reviewed_by'] },
      { table: 'cashier_shift_corrections', cols: ['created_by'] },
      { table: 'inventory_movements', cols: ['user_id'] },
      { table: 'audit_logs', cols: ['user_id'] },
      { table: 'purchases', cols: ['created_by'] },
      { table: 'returns', cols: ['user_id', 'reviewed_by'] },
      { table: 'expenses', cols: ['user_id'] },
      { table: 'medicines', cols: ['created_by', 'updated_by'] },
      { table: 'medicine_batches', cols: ['created_by'] },
      { table: 'stocktakes', cols: ['started_by', 'approved_by'] },
      { table: 'stocktake_lines', cols: ['counted_by'] },
      { table: 'sync_events', cols: ['actor_user_id'] },
    ];

    let totalReferences = 0;
    for (const { table, cols } of tablesToCheck) {
      const conditions = cols.map((col) => `${col} = $1`).join(' OR ');
      try {
        const r = await client.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${conditions}`, [userId]);
        totalReferences += Number(r.rows[0]?.count || 0);
      } catch (err: any) {
        // Table may not exist in minimal test schemas; continue checking
      }
    }

    if (totalReferences > 0) {
      // Historical references exist -> ARCHIVE / DEACTIVATE
      const res = await client.query(
        `UPDATE users SET active = FALSE, sessions_revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
        [userId]
      );
      const user = toUser(res.rows[0]);
      await enqueueSyncEvent(client, {
        event_type: 'USER_UPSERTED',
        entity_type: 'user',
        entity_id: userId,
        operation: 'UPDATE',
        data: async () => ({ user: await userJson(client, userId) }),
        actor: { user_id: actorId || null },
      });
      return {
        action: 'archived',
        id: userId,
        user,
        reason: `User has ${totalReferences} historical transaction record(s). The account has been archived and deactivated instead of permanently deleted.`,
      };
    } else {
      // Zero references -> PERMANENT DELETE
      try {
        await client.query('DELETE FROM user_name_history WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        await client.query('UPDATE devices SET current_user_id = NULL WHERE current_user_id = $1', [userId]);
      } catch (err: any) {
        // Ignored if optional tables are not present
      }

      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await enqueueSyncEvent(client, {
        event_type: 'USER_DELETED',
        entity_type: 'user',
        entity_id: userId,
        operation: 'DELETE',
        data: { user: { id: userId, email: target.email, username: target.username } },
        actor: { user_id: actorId || null },
      });

      return {
        action: 'deleted',
        id: userId,
        reason: 'User had no historical transaction records and has been permanently deleted.',
      };
    }
  });
}

