import crypto from 'crypto';
import { pgPool, HttpError, isValidUuid, withTransaction, type Queryable } from './client';
import { hashCredential, verifyCredential } from '../auth';
import type { User, UserRole } from '../../src/types';

/**
 * Staff accounts live ONLY in the PostgreSQL users table. Credentials are PBKDF2-SHA512 hashes in
 * the self-contained "salt$hash" format (server/auth.ts). Plaintext secrets are never stored or logged.
 */

/** Roles that can be assigned through user management. */
export const ASSIGNABLE_ROLES: UserRole[] = ['ADMIN', 'CASHIER'];
export const MIN_PASSWORD_LENGTH = 8;
const PIN_PATTERN = /^\d{4,6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  phone: string | null;
  active: boolean;
  password_hash: string;
  pin_hash: string;
  created_at: Date | null;
  updated_at: Date | null;
  last_login: Date | null;
}

const PUBLIC_COLUMNS = 'id, name, email, role, phone, active, created_at, updated_at, last_login';

function toUser(r: any): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
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
function unusablePinHash(): string {
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

/** Fresh identity for an authenticated request: role and active flag come from the DB, not the token. */
export async function getActiveUserForSession(id: string): Promise<User | null> {
  const user = await getUserById(id);
  return user && user.active ? user : null;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** A real hash to verify against when the account does not exist, so timing does not reveal it. */
const DUMMY_HASH = hashCredential(crypto.randomBytes(16).toString('hex')).combined;

export async function authenticateUser(identifier: string, secret: string): Promise<User> {
  const email = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
  const cleanSecret = typeof secret === 'string' ? secret.trim() : '';
  if (!email || !cleanSecret) throw new HttpError(400, 'Email and password (or PIN) are required.');

  const res = await pgPool.query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
  const row: UserRow | undefined = res.rows[0];

  if (!row) {
    verifyCredential(cleanSecret, DUMMY_HASH);
    throw new HttpError(401, 'Invalid email or password.');
  }

  const passwordOk = verifyCredential(cleanSecret, row.password_hash);
  const pinOk = !passwordOk && PIN_PATTERN.test(cleanSecret) && verifyCredential(cleanSecret, row.pin_hash);
  if (!passwordOk && !pinOk) throw new HttpError(401, 'Invalid email or password.');

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
  const password = validatePassword(data.password);
  const pinHash = data.pin ? hashCredential(validatePin(String(data.pin))).combined : unusablePinHash();
  const phone = typeof data.phone === 'string' && data.phone.trim() ? data.phone.trim().slice(0, 50) : null;

  try {
    const res = await pgPool.query(
      `INSERT INTO users (id, name, email, role, phone, active, password_hash, pin_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING ${PUBLIC_COLUMNS}`,
      [crypto.randomUUID(), name, email, role, phone, data.active !== false, hashCredential(password).combined, pinHash]
    );
    return toUser(res.rows[0]);
  } catch (err: any) {
    if (uniqueViolation(err)) throw new HttpError(409, `A user account with email "${email}" already exists.`);
    throw err;
  }
}

export async function updateUser(
  id: string,
  updates: Partial<{ name: string; email: string; role: UserRole; phone: string; active: boolean }>,
  actorId?: string
): Promise<User> {
  if (!isValidUuid(id)) throw new HttpError(400, 'User id must be a valid UUID.');
  const name = updates.name !== undefined ? requireName(updates.name) : undefined;
  const email = updates.email !== undefined ? requireEmail(updates.email) : undefined;
  const role = updates.role !== undefined ? requireRole(updates.role) : undefined;
  const active = updates.active !== undefined ? Boolean(updates.active) : undefined;
  const phone =
    updates.phone !== undefined ? (String(updates.phone).trim().slice(0, 50) || null) : undefined;

  return withTransaction(async (client) => {
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
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
         RETURNING ${PUBLIC_COLUMNS}`,
        [name ?? null, email ?? null, role ?? null, phone !== undefined, phone ?? null, active ?? null, id]
      );
      return toUser(res.rows[0]);
    } catch (err: any) {
      if (uniqueViolation(err)) throw new HttpError(409, `Email "${email}" is already in use by another staff member.`);
      throw err;
    }
  });
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
  newPassword: string;
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
