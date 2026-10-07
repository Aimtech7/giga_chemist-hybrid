import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { Socket } from 'net';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { getDatabaseConnectionConfig, pgPool } from '../server/db/client';

/**
 * GIGA CHEMIST cloud EMULATOR — a stand-in for Supabase's PostgREST RPC endpoint
 * (POST /rest/v1/rpc/<fn>) backed by a SEPARATE local PostgreSQL database that has the real cloud
 * schema (cloud/supabase/migrations/*.sql) applied. It runs the exact same SQL functions as the
 * real cloud, so idempotency/stock logic is tested for real.
 *
 * Development and automated tests only. Never deploy it. It binds to 127.0.0.1.
 *
 *   npm run cloud:emulator          (uses SUPABASE_URL port + SUPABASE_ANON_KEY + SYNC_SHOP_TOKEN from .env)
 */
const FUNCTIONS: Record<string, [string, string][]> = {
  gc_ping: [['p_shop_id', 'uuid'], ['p_token', 'text']],
  gc_ingest_events: [['p_shop_id', 'uuid'], ['p_token', 'text'], ['p_events', 'jsonb']],
  gc_pull_commands: [['p_shop_id', 'uuid'], ['p_token', 'text'], ['p_limit', 'integer']],
  gc_ack_command: [['p_shop_id', 'uuid'], ['p_token', 'text'], ['p_command_id', 'uuid'], ['p_status', 'text'], ['p_result', 'jsonb'], ['p_error', 'text']],
};

export type FaultMode = 'none' | 'timeout' | 'error500' | 'drop_response';
export interface Fault {
  mode: FaultMode;
  /** Only these RPC names are affected (default: all). */
  functions?: string[];
  /** How many calls to affect (default: unlimited). */
  times?: number;
}

export interface CloudEmulator {
  port: number;
  url: string;
  pool: pg.Pool;
  calls: { fn: string; status: number }[];
  setFault(f: Fault): void;
  /** Stops listening and destroys open sockets: clients then see "connection refused". */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cloud/supabase/migrations');

function adminConfig(database: string) {
  const base: any = { ...getDatabaseConnectionConfig() };
  if (base.connectionString) {
    const u = new URL(base.connectionString);
    u.pathname = `/${database}`;
    base.connectionString = u.toString();
  } else {
    base.database = database;
  }
  delete base.max;
  return base;
}

/** Creates the emulator database if missing (fresh=true drops it first) and applies the cloud schema. */
export async function prepareCloudDatabase(database: string, fresh = false): Promise<void> {
  if (!/^giga_chemist_cloud_(dev|test)$/.test(database)) {
    throw new Error(`Refusing to manage "${database}": emulator databases must be giga_chemist_cloud_dev or giga_chemist_cloud_test.`);
  }
  const admin = new pg.Client(adminConfig('postgres'));
  await admin.connect();
  try {
    if (fresh) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [database]);
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    }
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rows[0]) await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const c = new pg.Client(adminConfig(database));
  await c.connect();
  try {
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
    }
  } finally {
    await c.end();
  }
}

export async function startCloudEmulator(opts: { port: number; database: string; apiKey: string }): Promise<CloudEmulator> {
  const pool = new pg.Pool({ ...adminConfig(opts.database), max: 10 });
  let fault: Fault = { mode: 'none' };
  const calls: { fn: string; status: number }[] = [];
  const sockets = new Set<Socket>();
  const hanging = new Set<http.ServerResponse>();

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const faultApplies = (fn: string) => {
    if (fault.mode === 'none') return false;
    if (fault.functions && !fault.functions.includes(fn)) return false;
    if (fault.times !== undefined) {
      if (fault.times <= 0) return false;
      fault.times--;
    }
    return true;
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !m || !FUNCTIONS[m[1]]) return send(res, 404, { message: 'not found' });
    const fn = m[1];
    const key = req.headers['apikey'];
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (key !== opts.apiKey || bearer !== opts.apiKey) {
      calls.push({ fn, status: 401 });
      return send(res, 401, { message: 'Invalid API key' });
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { message: 'invalid JSON' });
    }

    const active = faultApplies(fn) ? fault.mode : 'none';
    if (active === 'timeout') {
      hanging.add(res); // never answered; the client's own timeout fires
      calls.push({ fn, status: 0 });
      return;
    }
    if (active === 'error500') {
      calls.push({ fn, status: 503 });
      return send(res, 503, { message: 'emulated cloud outage' });
    }

    const params = FUNCTIONS[fn];
    const values = params.map(([name, type]) => {
      const v = body[name];
      if (v === undefined || v === null) return null;
      return type === 'jsonb' ? JSON.stringify(v) : v;
    });
    const sqlArgs = params.map(([name, type], i) => `${name} => $${i + 1}::${type}`).join(', ');
    try {
      const r = await pool.query(`SELECT public.${fn}(${sqlArgs}) AS r`, values);
      if (active === 'drop_response') {
        // The cloud COMMITTED, but the shop never hears back (e.g. timeout on the way back).
        calls.push({ fn, status: -1 });
        req.socket.destroy();
        return;
      }
      calls.push({ fn, status: 200 });
      send(res, 200, r.rows[0].r);
    } catch (err: any) {
      const code: string = err?.code || '';
      const status = /^PT\d{3}$/.test(code) ? Number(code.slice(2)) : code === 'P0001' || code.startsWith('22') ? 400 : 500;
      calls.push({ fn, status });
      send(res, status, { code, message: err?.message || 'error' });
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => send(res, 500, { message: String(err?.message || err) }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  await listen();

  const stop = async () => {
    for (const r of hanging) r.destroy();
    hanging.clear();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };

  return {
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}`,
    pool,
    calls,
    setFault(f: Fault) {
      fault = { ...f };
      if (f.mode !== 'timeout') {
        for (const r of hanging) r.destroy();
        hanging.clear();
      }
    },
    stop,
    restart: listen,
    async close() {
      if (server.listening) await stop();
      await pool.end();
    },
  };
}

/** Registers a shop in the emulator database (owner-only helper in the real cloud). */
export async function registerShop(pool: pg.Pool, shopId: string, code: string, name: string, token: string) {
  await pool.query('SELECT giga_cloud.register_shop($1, $2, $3, $4)', [shopId, code, name, token]);
}

// ---------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const url = new URL(process.env.SUPABASE_URL || 'http://127.0.0.1:54321');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('SUPABASE_URL points to a real cloud; the emulator only runs for a localhost SUPABASE_URL.');
    }
    const apiKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const token = process.env.SYNC_SHOP_TOKEN || '';
    if (!apiKey || token.length < 32) throw new Error('Set SUPABASE_ANON_KEY and SYNC_SHOP_TOKEN (>= 32 chars) in .env first.');
    const database = process.env.CLOUD_EMULATOR_DB || 'giga_chemist_cloud_dev';
    await prepareCloudDatabase(database, false);

    const id = (await pgPool.query('SELECT shop_id, shop_code, shop_name FROM shop_identity WHERE id = 1')).rows[0];
    await pgPool.end();
    if (!id) throw new Error('Local shop_identity missing; run npm run db:migrate.');

    const emu = await startCloudEmulator({ port: Number(url.port || 54321), database, apiKey });
    await registerShop(emu.pool, id.shop_id, id.shop_code, id.shop_name || id.shop_code, token);
    console.log(`[cloud-emulator] ${emu.url} -> database ${database}; shop ${id.shop_code} ${id.shop_id} registered.`);
    console.log('[cloud-emulator] Stop it (Ctrl+C) to simulate a cloud outage; start it again to restore.');
    const shutdown = async () => {
      await emu.close().catch(() => {});
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  })().catch((err) => {
    console.error('[cloud-emulator] failed:', err?.message || err);
    process.exit(1);
  });
}
