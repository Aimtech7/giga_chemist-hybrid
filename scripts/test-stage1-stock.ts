/**
 * Stage 1 stock verification against a RUNNING server and the configured PostgreSQL DB.
 *
 * Runs Tests A–H from docs/LOCAL_STABILIZATION_STAGE1.md through the real HTTP API (same
 * endpoints the UI calls, authenticated with real JWTs) and verifies every result directly in
 * PostgreSQL: batch quantity, medicines.current_stock, inventory_movements row, audit_logs row.
 *
 * Usage (server must be running on BASE_URL, default http://localhost:3000):
 *   STAGE1_ADMIN_EMAIL=... STAGE1_ADMIN_PASSWORD=... \
 *   STAGE1_CASHIER_EMAIL=... STAGE1_CASHIER_PASSWORD=... \
 *   STAGE1_MEDICINE_ID=<uuid of a single-batch medicine> \
 *   npx tsx scripts/test-stage1-stock.ts
 *
 * WARNING: modifies stock of STAGE1_MEDICINE_ID. Use only on a development database.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { getDatabaseConnectionConfig } from '../server/db/client';

dotenv.config();

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const MED = process.env.STAGE1_MEDICINE_ID || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = new pg.Pool(getDatabaseConnectionConfig());
let failures = 0;

function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data: any = await res.json();
  if (!res.ok || !data.token) throw new Error(`Login failed for ${email}: ${data.error || res.status}`);
  return data.token;
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function dbState() {
  const m = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [MED]);
  const b = await pool.query(
    'SELECT id, batch_number, quantity_available, status, expiry_date, expiry_status FROM medicine_batches WHERE medicine_id = $1 ORDER BY created_at',
    [MED]
  );
  const sum = await pool.query(
    "SELECT COALESCE(SUM(quantity_available),0)::int AS s FROM medicine_batches WHERE medicine_id = $1 AND status = 'active'",
    [MED]
  );
  return { current_stock: Number(m.rows[0]?.current_stock), batches: b.rows, activeSum: Number(sum.rows[0].s) };
}

async function verifyMovementAndAudit(label: string, since: Date, expect: { prev: number; next: number; reason: string; action: string; userId: string }) {
  const mv = await pool.query(
    `SELECT id, previous_quantity, adjustment_quantity, new_quantity, reason, user_id, device_id
     FROM inventory_movements WHERE medicine_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 1`,
    [MED, since]
  );
  const row = mv.rows[0];
  check(!!row, `${label}: inventory_movements row created`);
  if (row) {
    check(UUID_RE.test(row.id), `${label}: movement id is a UUID (${row.id})`);
    check(row.previous_quantity === expect.prev && row.new_quantity === expect.next && row.adjustment_quantity === expect.next - expect.prev,
      `${label}: movement prev=${expect.prev} new=${expect.next} delta=${expect.next - expect.prev}`, row);
    check(row.reason === expect.reason, `${label}: movement reason=${expect.reason}`, row.reason);
    check(row.user_id === expect.userId, `${label}: movement user_id is the Admin`, row.user_id);
  }
  const au = await pool.query(
    `SELECT id, action, user_id FROM audit_logs WHERE created_at >= $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
    [since, expect.action]
  );
  check(!!au.rows[0], `${label}: audit_logs ${expect.action} row created`);
  if (au.rows[0]) check(au.rows[0].user_id === expect.userId, `${label}: audit user_id is the Admin`);
}

async function main() {
  if (!UUID_RE.test(MED)) throw new Error('Set STAGE1_MEDICINE_ID to a medicine UUID.');
  const adminToken = await login(process.env.STAGE1_ADMIN_EMAIL!, process.env.STAGE1_ADMIN_PASSWORD!);
  const cashierToken = await login(process.env.STAGE1_CASHIER_EMAIL!, process.env.STAGE1_CASHIER_PASSWORD!);
  const adminId = (await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [process.env.STAGE1_ADMIN_EMAIL])).rows[0].id;

  const initial = await dbState();
  if (initial.batches.length !== 1) throw new Error(`Test medicine must have exactly one batch (has ${initial.batches.length}).`);
  const batch = initial.batches[0];
  console.log(`Medicine ${MED}, batch ${batch.batch_number} (${batch.id}), starting stock ${initial.current_stock}`);

  const step = async (label: string, prev: number, next: number, reason: string, action: string, req: () => Promise<{ status: number; data: any }>) => {
    console.log(`\n${label}`);
    const since = new Date(Date.now() - 1000);
    const r = await req();
    check(r.status === 200, `${label}: HTTP 200`, r);
    const s = await dbState();
    check(s.batches[0].quantity_available === next, `${label}: batch quantity_available = ${next}`, s.batches[0].quantity_available);
    check(s.current_stock === next, `${label}: medicines.current_stock = ${next}`, s.current_stock);
    check(s.current_stock === s.activeSum, `${label}: current_stock equals SUM(active batches)`, s);
    check(r.data?.medicine?.current_stock === next, `${label}: API response current_stock = ${next}`, r.data?.medicine);
    await verifyMovementAndAudit(label, since, { prev, next, reason, action, userId: adminId });
  };

  // Bring to a known 0 baseline (Set Stock) only if needed
  if (initial.current_stock !== 0 || batch.quantity_available !== 0) {
    await call('POST', '/api/inventory/set-stock', adminToken, { medicine_id: MED, batch_id: batch.id, new_stock: 0, reason: 'STAGE1_TEST_BASELINE' });
  }

  const count = (q: number) => () => call('POST', '/api/inventory/physical-count', adminToken, {
    medicine_id: MED, counts: [{ batch_id: batch.id, batch_number: batch.batch_number, quantity: q, expiry_date: null }], notes: 'Stage 1 test',
  });

  await step('TEST A  Physical Count 0 -> 1', 0, 1, 'PHYSICAL_STOCK_COUNT', 'ADMIN_PHYSICAL_STOCK_COUNT', count(1));
  await step('TEST B  Physical Count 1 -> 50', 1, 50, 'PHYSICAL_STOCK_COUNT', 'ADMIN_PHYSICAL_STOCK_COUNT', count(50));
  await step('TEST C  Set Stock 50 -> 30', 50, 30, 'Stage1 set', 'ADMIN_SET_STOCK',
    () => call('POST', '/api/inventory/set-stock', adminToken, { medicine_id: MED, batch_id: batch.id, new_stock: 30, reason: 'Stage1 set' }));
  await step('TEST D  Add Stock 30 + 20 = 50', 30, 50, 'ADD_STOCK', 'ADMIN_ADD_STOCK',
    () => call('POST', '/api/inventory/add-stock', adminToken, { medicine_id: MED, quantity: 20, batch_number: batch.batch_number }));
  await step('TEST E  Remove Stock 50 - 10 = 40', 50, 40, 'Damaged', 'ADMIN_REMOVE_STOCK',
    () => call('POST', '/api/inventory/remove-stock', adminToken, { medicine_id: MED, batch_id: batch.id, quantity: 10, reason: 'Damaged' }));

  console.log('\nTEST E2 Remove more than available is rejected');
  const over = await call('POST', '/api/inventory/remove-stock', adminToken, { medicine_id: MED, batch_id: batch.id, quantity: 41, reason: 'Damaged' });
  check(over.status === 400, 'over-removal returns 400', over);
  check((await dbState()).current_stock === 40, 'stock unchanged after rejected removal');

  await step('TEST F  Set Stock 40 -> 0', 40, 0, 'Stage1 zero', 'ADMIN_SET_STOCK',
    () => call('POST', '/api/inventory/set-stock', adminToken, { medicine_id: MED, batch_id: batch.id, new_stock: 0, reason: 'Stage1 zero' }));

  console.log('\nTEST G  Edit expiry (set date, then back to UNKNOWN)');
  const since = new Date(Date.now() - 1000);
  const g1 = await call('PATCH', `/api/batches/${batch.id}/expiry`, adminToken, { expiry_date: '2028-06-30' });
  check(g1.status === 200, 'set expiry HTTP 200', g1);
  let s = await dbState();
  check(s.batches[0].expiry_date === '2028-06-30' && s.batches[0].expiry_status === 'KNOWN', 'expiry_date=2028-06-30, expiry_status=KNOWN', s.batches[0]);
  const g2 = await call('PATCH', `/api/batches/${batch.id}/expiry`, adminToken, { expiry_date: null });
  check(g2.status === 200, 'clear expiry HTTP 200', g2);
  s = await dbState();
  check(s.batches[0].expiry_date === null && s.batches[0].expiry_status === 'UNKNOWN', 'expiry_date=NULL, expiry_status=UNKNOWN', s.batches[0]);
  const ga = await pool.query("SELECT count(*)::int c FROM audit_logs WHERE action = 'ADMIN_EDIT_EXPIRY' AND created_at >= $1", [since]);
  check(ga.rows[0].c === 2, 'two ADMIN_EDIT_EXPIRY audit rows', ga.rows[0]);
  const bad = await call('PATCH', `/api/batches/${batch.id}/expiry`, adminToken, { expiry_date: '30/06/2028' });
  check(bad.status === 400, 'invalid expiry format returns 400', bad);

  console.log('\nTEST H  Authorization');
  const before = await dbState();
  for (const [path, body] of [
    ['/api/inventory/set-stock', { medicine_id: MED, batch_id: batch.id, new_stock: 99 }],
    ['/api/inventory/add-stock', { medicine_id: MED, quantity: 5, batch_number: batch.batch_number }],
    ['/api/inventory/remove-stock', { medicine_id: MED, batch_id: batch.id, quantity: 1 }],
    ['/api/inventory/physical-count', { medicine_id: MED, counts: [{ batch_id: batch.id, batch_number: batch.batch_number, quantity: 99 }] }],
  ] as const) {
    const c = await call('POST', path, cashierToken, body);
    check(c.status === 403, `CASHIER ${path} -> 403`, c.status);
    const u = await call('POST', path, null, body);
    check(u.status === 401, `unauthenticated ${path} -> 401`, u.status);
  }
  const spoof = await fetch(`${BASE}/api/inventory/set-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-role': 'ADMIN', 'x-user-id': adminId, 'x-user-name': 'Spoof' },
    body: JSON.stringify({ medicine_id: MED, batch_id: batch.id, new_stock: 99 }),
  });
  check(spoof.status === 401, 'x-user-role: ADMIN header without token -> 401', spoof.status);
  const ce = await call('PATCH', `/api/batches/${batch.id}/expiry`, cashierToken, { expiry_date: '2029-01-01' });
  check(ce.status === 403, 'CASHIER expiry edit -> 403', ce.status);
  check(JSON.stringify(await dbState()) === JSON.stringify(before), 'stock and expiry unchanged after unauthorized attempts');

  console.log('\nTEST I  Validation');
  const badId = await call('POST', '/api/inventory/set-stock', adminToken, { medicine_id: 'mov-1791032753129-li4q', new_stock: 1 });
  check(badId.status === 400, 'non-UUID medicine_id -> 400 (no DB uuid error)', badId);
  const neg = await call('POST', '/api/inventory/set-stock', adminToken, { medicine_id: MED, batch_id: batch.id, new_stock: -5 });
  check(neg.status === 400, 'negative stock -> 400', neg.status);

  console.log(`\n${failures === 0 ? 'ALL STAGE 1 STOCK TESTS PASSED' : `${failures} CHECK(S) FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Test run aborted:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
