import crypto from 'crypto';
import type { UserRole } from '../src/types';

const TOKEN_EXPIRY_SECONDS = 12 * 60 * 60; // 12 hours
const MIN_JWT_SECRET_LENGTH = 32;

/** JWT_SECRET is mandatory: there is deliberately no built-in fallback secret. */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LENGTH} characters. ` +
        'Set a long random JWT_SECRET in .env before starting the GIGA CHEMIST server.'
    );
  }
  return secret;
}

/** Called once at startup so a missing secret stops the server instead of failing per request. */
export function assertAuthConfiguration(): void {
  getJwtSecret();
}

function signJwt(encodedHeader: string, encodedPayload: string): string {
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface JwtPayload {
  userId: string;
  role: UserRole;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

// 1. Password & PIN Cryptographic Hashing (PBKDF2 with SHA-512 and Salt)
export function hashCredential(secret: string, customSalt?: string): { hash: string; salt: string; combined: string } {
  const salt = customSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(secret, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt, combined: `${salt}$${hash}` };
}

export function verifyCredential(secret: string, storedHash: string, salt?: string): boolean {
  if (!secret || !storedHash) return false;

  // Handle self-contained salt$hash format
  if (storedHash.includes('$')) {
    const parts = storedHash.split('$');
    const actualSalt = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    const actualHash = parts[parts.length - 1];
    const { hash } = hashCredential(secret, actualSalt);
    try {
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(actualHash, 'hex'));
    } catch (e) {
      return false;
    }
  }

  if (!salt) return false;
  const { hash } = hashCredential(secret, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (e) {
    return false;
  }
}

// 2. JWT Signing & Verification
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

export function createJwtToken(payload: { userId: string; role: UserRole; email: string; name: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  return `${encodedHeader}.${encodedPayload}.${signJwt(encodedHeader, encodedPayload)}`;
}

export function verifyJwtToken(token: string): { valid: boolean; payload?: JwtPayload; error?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token missing or invalid format' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed JWT token structure' };
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  const expected = Buffer.from(signJwt(encodedHeader, encodedPayload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { valid: false, error: 'Invalid token signature' };
  }

  try {
    const payload: JwtPayload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token has expired' };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: 'Failed to decode token payload' };
  }
}

// 3. Centralized Granular Permissions Matrix
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  ADMIN: [
    'medicine.view',
    'medicine.create',
    'medicine.edit',
    'medicine.delete',
    'medicine.change_price',
    'inventory.view',
    'inventory.adjust',
    'stock.receive',
    'sales.create',
    'sales.view_own',
    'sales.view_all',
    'sales.void',
    'returns.create',
    'returns.approve',
    'reports.view',
    'users.manage',
    'audit.view',
    'settings.manage',
    'suppliers.manage',
    'expenses.manage',
    'devices.manage',
  ],
  MANAGER: [
    'medicine.view',
    'medicine.edit',
    'inventory.view',
    'stock.receive',
    'sales.create',
    'sales.view_own',
    'sales.view_all',
    'returns.create',
    'returns.approve',
    'reports.view',
    'suppliers.manage',
    'expenses.manage',
    'customers.manage',
  ],
  CASHIER: [
    'medicine.view',
    'sales.create',
    'sales.view_own',
    'returns.create',
    'customers.manage',
  ],
};

export function hasPermission(role: UserRole, permissionKey: string): boolean {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permissionKey);
}
