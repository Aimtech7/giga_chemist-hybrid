import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import pg from 'pg';
import { prepareCloudDatabase, registerShop, startCloudEmulator } from '../cloud-emulator';
import { hashCredential } from '../../server/auth';

/**
 * MANUAL-TEST SANDBOX for the online Global Admin (development PC only).   npm run sandbox:online
 *
 *   shop  : a THROWAWAY COPY of giga_chemist_dev (giga_chemist_sandbox), hybrid, real sync worker, port 3101
 *   cloud : the local cloud emulator on giga_chemist_cloud_dev (cloud SQL 001-006), port 54398
 *   online: APP_MODE=online server + built UI on http://localhost:3102 (run npm run build first)
 *   Shop 2: synthetic (registered + fed through the real ingestion RPC; no shop process = offline)
 *
 * Nothing here can reach the real Supabase, the PC2 giga_chemist database or the dev database's outbox:
 * the shop side runs on the copy. Global Admin login: SANDBOX_GA_EMAIL (default global.admin@sandbox.local)
 * with the password YOU set in SANDBOX_GA_PASSWORD (never printed). Ctrl+C stops everything.
 */
const SHOP_PORT = 3101;
const ONLINE_PORT = 3102;
const EMU_PORT = 54398;
const SOURCE_DB = 'giga_chemist_dev';
const SANDBOX_DB = 'giga_chemist_sandbox';
const CLOUD_DB = 'giga_chemist_cloud_dev';

function baseConfig() {
  const url = process.env.SANDBOX_PG_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 5432}/postgres`;
  return new URL(url);
}
const dbUrl = (db: string) => {
  const u = baseConfig();
  u.pathname = `/${db}`;
  return u.toString();
};

const children: ChildProcess[] = [];
function run(label: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `[${label}] `));
  child.stdout!.on('data', tag);
  child.stderr!.on('data', tag);
  children.push(child);
  return child;
}
async function waitHealthy(port: number) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on port ${port} did not become healthy`);
}

async function main() {
  const gaPw = process.env.SANDBOX_GA_PASSWORD || '';
  const gaEmail = (process.env.SANDBOX_GA_EMAIL || 'global.admin@sandbox.local').toLowerCase();
  if (gaPw.length < 8) throw new Error('Set SANDBOX_GA_PASSWORD (at least 8 characters) for the sandbox Global Administrator.');
  if (!fs.existsSync(path.resolve('dist', 'index.html'))) throw new Error('Run npm run build first (the online server serves dist/).');

  // 1. Throwaway copy of the dev database (the dev database must have no open connections).
  const admin = new pg.Client({ connectionString: dbUrl('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SANDBOX_DB}`);
  try {
    await admin.query(`CREATE DATABASE ${SANDBOX_DB} TEMPLATE ${SOURCE_DB}`);
  } catch (err: any) {
    throw new Error(`Could not copy ${SOURCE_DB} (${err.message}). Stop anything connected to it (test suites, a dev server) and retry.`);
  } finally {
    await admin.end();
  }
  const shopDb = new pg.Pool({ connectionString: dbUrl(SANDBOX_DB) });
  // The copy must never push anything that was pending in the source: start with an empty outbox.
  await shopDb.query(`DELETE FROM sync_events WHERE status <> 'SYNCED'`);
  await shopDb.query('DELETE FROM sync_state');
  const shop1 = (await shopDb.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0].shop_id;
  const migr = spawnSync(process.execPath, ['--import', 'tsx', '-e', `import('./server/db/migrator.ts').then(m => m.runMigrations(process.env.U)).then(r => { if (!r.success) process.exit(1) })`],
    { env: { ...process.env, U: dbUrl(SANDBOX_DB) }, stdio: 'inherit' });
  if (migr.status !== 0) throw new Error('migrations failed on the sandbox copy');

  // 2. Cloud emulator with the real cloud SQL, Shop 1 (the copy) and a synthetic Shop 2.
  await prepareCloudDatabase(CLOUD_DB, true);
  const apiKey = `sandbox-anon-${crypto.randomBytes(12).toString('hex')}`;
  const token1 = crypto.randomBytes(32).toString('base64url');
  const emu = await startCloudEmulator({ port: EMU_PORT, database: CLOUD_DB, apiKey });
  await registerShop(emu.pool, shop1, 'SHOP1', 'GIGA CHEMIST - SHOP 1 (sandbox copy)', token1);
  await emu.pool.query('UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_id = $1', [shop1]);
  const shop2 = crypto.randomUUID();
  const token2 = crypto.randomBytes(32).toString('base64url');
  await registerShop(emu.pool, shop2, 'SHOP2', 'GIGA CHEMIST - SHOP 2 (synthetic, offline)', token2);
  const twins = (await shopDb.query(`SELECT name, barcode, selling_price, purchase_price FROM medicines WHERE status = 'active' AND barcode IS NOT NULL AND barcode <> '' ORDER BY name LIMIT 3`)).rows;
  const events = twins.map((m: any, i: number) => {
    const id = crypto.randomUUID();
    return {
      event_id: crypto.randomUUID(), idempotency_key: `sandbox-s2-${crypto.randomUUID()}`, shop_id: shop2, local_seq: String(i + 1), event_type: 'MEDICINE_BASELINE',
      entity_type: 'medicine', entity_id: id, payload: { movements: [], batches: [], audit: [], data: {
        medicine: { id, name: `${m.name} (Shop 2)`, barcode: m.barcode, selling_price: Number(m.selling_price) + 5, purchase_price: Number(m.purchase_price), status: 'active' },
        batches: [{ id: crypto.randomUUID(), medicine_id: id, batch_number: `S2-${i + 1}`, quantity_available: 10 * (i + 1), status: 'active', expiry_date: '2031-12-31' }] } },
    };
  });
  if (events.length) await emu.pool.query('SELECT public.gc_ingest_events($1, $2, $3::jsonb)', [shop2, token2, JSON.stringify(events)]);
  await emu.pool.query('SELECT giga_cloud.upsert_online_user($1, $2, $3, $4, NULL, NULL)', [gaEmail, 'Sandbox Global Admin', 'ADMIN', hashCredential(gaPw).combined]);

  // 3. Shop 1 server on the copy (hybrid, worker on) + full baseline of its catalogue to the sandbox cloud.
  const runtime = path.join(os.tmpdir(), 'gc-sandbox-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const shopEnv = {
    APP_MODE: 'hybrid', SYNC_ENABLED: 'true', PORT: String(SHOP_PORT), LOCAL_DATABASE_URL: dbUrl(SANDBOX_DB), DATABASE_URL: dbUrl(SANDBOX_DB),
    SUPABASE_URL: `http://127.0.0.1:${EMU_PORT}`, SUPABASE_ANON_KEY: apiKey, SUPABASE_SERVICE_ROLE_KEY: '', SYNC_SHOP_TOKEN: token1, SHOP_ID: '',
    SYNC_INTERVAL_SECONDS: '2', SYNC_BATCH_SIZE: '100', HEARTBEAT_INTERVAL_SECONDS: '15', GIGA_RUNTIME_DIR: runtime,
    BACKUP_ENABLED: 'false', EMAIL_ENABLED: 'false', JWT_SECRET: crypto.randomBytes(48).toString('base64url'), AUTH_RATE_LIMIT_PER_MINUTE: '1000',
  };
  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-bootstrap.ts', '--confirm'], { env: { ...process.env, ...shopEnv }, encoding: 'utf-8' });
  if (boot.status !== 0) throw new Error(`baseline bootstrap failed: ${boot.stderr?.slice(-400)}`);
  run('shop1', shopEnv);
  await waitHealthy(SHOP_PORT);

  // 4. Online API + UI.
  run('online', {
    APP_MODE: 'online', PORT: String(ONLINE_PORT), NODE_ENV: 'production', DATABASE_URL: dbUrl(CLOUD_DB), LOCAL_DATABASE_URL: dbUrl(CLOUD_DB),
    ONLINE_ALLOW_LOCAL_DB: 'true', SHOP_ID: shop1, JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SYNC_SHOP_TOKEN: '',
  });
  await waitHealthy(ONLINE_PORT);

  console.log(`
=====================================================================
 GIGA CHEMIST — ONLINE GLOBAL ADMIN SANDBOX (nothing real is touched)
   Online admin : http://localhost:${ONLINE_PORT}   (login: ${gaEmail} + your SANDBOX_GA_PASSWORD)
   Shop 1 POS   : http://localhost:${SHOP_PORT}   (copy of ${SOURCE_DB}; its staff logins)
   Shop 2       : synthetic, offline (its commands stay PENDING)
   The Shop 1 catalogue baseline is syncing to the sandbox cloud (a minute or two).
   Ctrl+C stops everything. The ${SANDBOX_DB} copy is dropped on the next start.
=====================================================================`);

  const stop = async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await emu.close().catch(() => {});
    await shopDb.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch(async (e) => {
  console.error('[sandbox] failed:', e?.message || e);
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(1);
});
