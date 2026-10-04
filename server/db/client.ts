import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Return PostgreSQL DATE columns as plain 'YYYY-MM-DD' strings. The default parser builds a
// local-midnight JS Date, which shifts the calendar day when serialized to UTC (EAT is UTC+3).
pg.types.setTypeParser(1082, (value: string) => value);

export type AppMode = 'local' | 'cloud' | 'hybrid';

export function getAppMode(): AppMode {
  const envMode = (process.env.APP_MODE || '').toLowerCase().trim();
  if (envMode === 'cloud') return 'cloud';
  if (envMode === 'hybrid') return 'hybrid';
  if (envMode === 'local') return 'local';

  // Auto-detect based on available configuration
  if (process.env.DATABASE_URL && process.env.SUPABASE_URL) return 'hybrid';
  if (process.env.DATABASE_URL) return 'local';
  if (process.env.SUPABASE_URL) return 'cloud';
  return 'local';
}

export function getDatabaseConnectionConfig() {
  const connStr = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;

  if (connStr) {
    const isSsl = connStr.includes('supabase.co') || connStr.includes('sslmode=require') || process.env.DB_SSL === 'true';
    return {
      connectionString: connStr,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  // Individual environment variables
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  const database = process.env.DB_NAME || 'giga_chemist';
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || 'postgres';
  const isSsl = process.env.DB_SSL === 'true';

  return {
    host,
    port,
    database,
    user,
    password,
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 1. PostgreSQL Connection Pool (for Local & Hybrid Modes)
export const pgPool = new Pool(getDatabaseConnectionConfig());

let isPgConnected = false;

export async function checkPgConnection(): Promise<{ connected: boolean; error?: string }> {
  try {
    const client = await pgPool.connect();
    try {
      await client.query('SELECT 1 as health_check;');
      isPgConnected = true;
      return { connected: true };
    } finally {
      client.release();
    }
  } catch (err: any) {
    isPgConnected = false;
    return { connected: false, error: err.message };
  }
}

export async function queryPg<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pgPool.query(text, params);
  return res.rows as T[];
}

// 2. Supabase Client (Lazy-loaded for Cloud & Hybrid Modes only)
let _supabaseAdminInstance: any = null;
export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseServiceKey && !supabaseUrl.includes('placeholder')
);

export const supabaseAdmin = new Proxy({} as any, {
  get(target, prop) {
    if (!isSupabaseConfigured) {
      return () => {
        throw new Error('Supabase is not configured in local development mode.');
      };
    }
    if (!_supabaseAdminInstance) {
      // Dynamic import or require when actually configured in cloud mode
      throw new Error('Supabase cloud operations are disabled in local mode.');
    }
    return _supabaseAdminInstance[prop];
  }
});

export const isLocalMode = getAppMode() === 'local';
export const isCloudMode = getAppMode() === 'cloud';
export const isHybridMode = getAppMode() === 'hybrid';

import crypto from 'crypto';

export function isValidUuid(id?: string | null): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

export function cleanUuid(id?: string | null): string | null {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  return isValidUuid(trimmed) ? trimmed : null;
}

export function ensureUuid(id?: string | null): string {
  if (id && isValidUuid(id)) return id.trim();
  return crypto.randomUUID();
}

/** Error carrying an HTTP status, used for request validation failures (4xx). */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Throws a 400 HttpError unless `id` is a valid UUID. */
export function requireUuid(id: unknown, field: string): string {
  if (typeof id !== 'string' || !isValidUuid(id)) {
    throw new HttpError(400, `${field} must be a valid UUID.`);
  }
  return id.trim();
}


/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Runs fn inside BEGIN/COMMIT on one pooled client; any error triggers ROLLBACK and is rethrown. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr: any) {
      console.error('[Server DB] ROLLBACK failed:', rbErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Rounds a money amount to 2 decimal places (half away from zero). */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Current business date/time from PostgreSQL (timezone Africa/Nairobi), so day boundaries never
 * depend on the Node process or browser clock.
 */
export async function businessNow(q: Queryable = pgPool): Promise<{ date: string; time: string }> {
  const res = await q.query(
    `SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS date,
            to_char(now() AT TIME ZONE 'Africa/Nairobi', 'HH24:MI:SS') AS time`
  );
  return { date: res.rows[0].date, time: res.rows[0].time };
}
