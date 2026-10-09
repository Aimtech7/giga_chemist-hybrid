import 'dotenv/config';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import pg from 'pg';
import { getDatabaseConnectionConfig } from '../../server/db/client';
import { hashCredential } from '../../server/auth';

/**
 * Shared harness for the local integration suite. It starts its OWN server process (default port
 * 3199) against the configured PostgreSQL database, and refuses to run unless that database is the
 * PC2 development database.
 */
export const REQUIRED_DB = 'giga_chemist_dev';
export const PORT = Number(process.env.ITEST_PORT || 3199);
export const BASE = `http://127.0.0.1:${PORT}`;

export const pool = new pg.Pool(getDatabaseConnectionConfig());

export async function assertDevDatabase(): Promise<void> {
  const res = await pool.query('SELECT current_database() AS db');
  if (res.rows[0].db !== REQUIRED_DB) {
    throw new Error(`Refusing to run integration tests against "${res.rows[0].db}" (only ${REQUIRED_DB}).`);
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSection = '';

export function section(name: string) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

export function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = `${currentSection} :: ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`;
    failures.push(msg);
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

export function summary(): number {
  console.log(`\n=============================================================`);
  console.log(`  RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log(`=============================================================`);
  return failed;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------
let server: ChildProcess | null = null;
let serverLog = '';
let serverEnv: Record<string, string> = {};

/**
 * Mode of the private test server. Never inherited from .env: the regular suite runs APP_MODE=local
 * (or ITEST_MODE=hybrid: outbox on, worker off). The hybrid suite sets its own cloud env here.
 */
export function setServerEnv(env: Record<string, string>): void {
  serverEnv = env;
}

function modeEnv(): Record<string, string> {
  const hybrid = (process.env.ITEST_MODE || '').toLowerCase() === 'hybrid';
  return {
    APP_MODE: hybrid ? 'hybrid' : 'local',
    SYNC_ENABLED: 'false',
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SYNC_SHOP_TOKEN: '',
    SHOP_ID: '',
  };
}

export async function startServer(): Promise<void> {
  serverLog = '';
  server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    // Higher login rate limit for this private test server only (the suite logs in many times).
    env: { ...process.env, ...modeEnv(), ...serverEnv, PORT: String(PORT), AUTH_RATE_LIMIT_PER_MINUTE: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stream = Boolean(process.env.ITEST_STREAM_SERVER_LOG);
  const onData = (d: Buffer) => {
    serverLog += d.toString();
    if (stream) process.stdout.write(d.toString().replace(/^(?=.)/gm, '    [server] '));
  };
  server.stdout!.on('data', onData);
  server.stderr!.on('data', onData);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${serverLog}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become healthy:\n${serverLog}`);
}

export async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server!.once('exit', r));
  server.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  server = null;
}

export function getServerLog(): string {
  return serverLog;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export interface ApiResult {
  status: number;
  data: any;
  contentType: string;
}

export async function api(method: string, path: string, token?: string | null, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { 'X-Device-Id': 'ITEST-TERMINAL', ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data, contentType };
}

export async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/api/auth/login', null, { email, password });
  if (r.status !== 200 || !r.data?.token) throw new Error(`Login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

// ---------------------------------------------------------------------------
// Fixtures (dev database only). Passwords are random per run and never printed.
// ---------------------------------------------------------------------------
export interface Fixture {
  id: string;
  email: string;
  /** Login username = email local part (e.g. itest-admin). */
  username: string;
  password: string;
  /** Random 6-digit station PIN for this run (never printed). */
  pin: string;
  role: 'ADMIN' | 'CASHIER';
}

export function randomPassword(): string {
  return `It-${crypto.randomBytes(12).toString('base64url')}`;
}

export async function upsertFixtureUser(email: string, name: string, role: 'ADMIN' | 'CASHIER'): Promise<Fixture> {
  const password = randomPassword();
  const pin = String(crypto.randomInt(100000, 1000000));
  const username = email.split('@')[0];
  const res = await pool.query(
    `INSERT INTO users (id, name, email, username, role, active, password_hash, pin_hash)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, role = EXCLUDED.role, active = true,
       password_hash = EXCLUDED.password_hash, pin_hash = EXCLUDED.pin_hash, updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [crypto.randomUUID(), name, email, username, role, hashCredential(password).combined, hashCredential(pin).combined]
  );
  return { id: res.rows[0].id, email, username, password, pin, role };
}

/** Test medicines are identified by barcode; created once, re-activated per run, priced fresh. */
export async function upsertFixtureMedicine(barcode: string, name: string, selling: number, cost: number): Promise<string> {
  const existing = await pool.query('SELECT id FROM medicines WHERE barcode = $1 LIMIT 1', [barcode]);
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE medicines SET name = $2, selling_price = $3, purchase_price = $4, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.rows[0].id, name, selling, cost]
    );
    return existing.rows[0].id;
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO medicines (id, name, generic_name, sku, barcode, dosage_strength, dosage_form,
       purchase_price, selling_price, current_stock, reorder_level, unit, status)
     VALUES ($1, $2, $2, $3, $3, '1 unit', 'Tablet', $4, $5, 0, 5, 'Unit', 'active')`,
    [id, name, barcode, cost, selling]
  );
  return id;
}

// ---------------------------------------------------------------------------
// Fixture hygiene. Runs before and after every suite run. Only touches records that the tests
// created and that are unambiguously identifiable:
//   users      email LIKE 'itest-%@gigachemist.local'
//   medicines  barcode LIKE 'ITEST-%'
//   suppliers / customers  name LIKE 'ZZ ITEST%'
// Sales are deleted only when made by an itest user AND every line is an ITEST medicine.
// ---------------------------------------------------------------------------
export async function cleanupFixtures(): Promise<Record<string, number>> {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query('BEGIN');
    // Outbox rows produced by test actions (hybrid runs): never left behind to reach a real cloud.
    const itestUsers = `SELECT id FROM users WHERE email LIKE 'itest-%@gigachemist.local'`;
    const itestMeds = `SELECT id::text FROM medicines WHERE barcode LIKE 'ITEST-%'`;
    counts.sync_events = (await client.query(
      `DELETE FROM sync_events WHERE actor_user_id IN (${itestUsers})
         OR (entity_type = 'medicine' AND entity_id IN (${itestMeds}))
         OR (entity_type = 'medicine_batch' AND entity_id IN (SELECT b.id::text FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.barcode LIKE 'ITEST-%'))
         OR (entity_type = 'user' AND entity_id IN (SELECT id::text FROM users WHERE email LIKE 'itest-%@gigachemist.local'))`
    )).rowCount || 0;
    counts.sync_inbound_commands = (await client.query(
      `DELETE FROM sync_inbound_commands WHERE payload->>'medicine_id' IN (${itestMeds}) OR payload->>'name' LIKE 'ZZ ITEST%'`
    )).rowCount || 0;
    const testSales = `
      SELECT s.id FROM sales s JOIN users u ON u.id = s.cashier_id
      WHERE u.email LIKE 'itest-%@gigachemist.local'
        AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN medicines m ON m.id = si.medicine_id
                        WHERE si.sale_id = s.id AND m.barcode NOT LIKE 'ITEST-%')`;
    counts.returns = (await client.query(`DELETE FROM returns WHERE sale_id IN (${testSales})`)).rowCount || 0;
    counts.sales = (await client.query(`DELETE FROM sales WHERE id IN (${testSales})`)).rowCount || 0; // items/payments cascade
    const testPurchases = `SELECT p.id FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE s.name LIKE 'ZZ ITEST%'`;
    counts.purchases = (await client.query(`DELETE FROM purchases WHERE id IN (${testPurchases})`)).rowCount || 0;
    counts.expenses = (await client.query(
      `DELETE FROM expenses WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'itest-%@gigachemist.local')`
    )).rowCount || 0;
    counts.movements = (await client.query(
      `DELETE FROM inventory_movements WHERE medicine_id IN (SELECT id FROM medicines WHERE barcode LIKE 'ITEST-%')`
    )).rowCount || 0;
    await client.query(
      `UPDATE medicine_batches SET quantity_available = 0, status = 'exhausted', supplier_id = NULL
       WHERE medicine_id IN (SELECT id FROM medicines WHERE barcode LIKE 'ITEST-%')`
    );
    await client.query(
      `UPDATE medicines SET current_stock = 0, status = 'inactive' WHERE barcode LIKE 'ITEST-%'`
    );
    counts.customers = (await client.query(
      `DELETE FROM customers c WHERE c.name LIKE 'ZZ ITEST%' AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id)`
    )).rowCount || 0;
    counts.suppliers = (await client.query(
      `DELETE FROM suppliers s WHERE s.name LIKE 'ZZ ITEST%' AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.supplier_id = s.id)`
    )).rowCount || 0;
    counts.users_deactivated = (await client.query(
      `UPDATE users SET active = false WHERE email LIKE 'itest-%@gigachemist.local' AND active`
    )).rowCount || 0;
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
