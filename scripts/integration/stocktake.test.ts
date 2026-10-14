import crypto from 'crypto';
import { api, check, login, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import type { HybridEnv } from './hybrid.test';

/**
 * FORMAL STOCKTAKE suite (npm run test:stocktake).
 *   shop server : giga_chemist_dev, hybrid, sync worker ON against the cloud EMULATOR
 *   cloud       : giga_chemist_cloud_test (recreated per run)
 * Covers: DRAFT -> COUNTING -> REVIEW -> COMPLETED / CANCELLED, blind cashier counting, nothing changes
 * stock before approval, variance applied on top of sales made after the count, movements + audit +
 * Stock History, cloud convergence, offline approval, negative-stock refusal, RBAC.
 */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(300);
    v = await fn();
  }
  return v;
}
const qty = async (batchId: string) => Number((await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [batchId])).rows[0].quantity_available);
const stockOf = async (medId: string) => Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [medId])).rows[0].current_stock);

export async function stocktakeTests(env: HybridEnv, admin: Fixture, manager: Fixture, cashier: Fixture) {
  const cq = async (sql: string, params: any[] = []) => (await env.emu.pool.query(sql, params)).rows;
  const A = await login(admin.email, admin.password);
  const M = await login(manager.email, manager.password);
  const C = await login(cashier.email, cashier.password);

  section('SETUP');
  const med = await upsertFixtureMedicine(`ITEST-ST-${RUN}`, `ZZ ITEST Stocktake ${RUN}`, 50, 20);
  let r = await api('POST', '/api/inventory/physical-count', A, { medicine_id: med, counts: [
    { batch_number: `ST-B1-${RUN}`, quantity: 20, expiry_date: '2029-01-31' },
    { batch_number: `ST-B2-${RUN}`, quantity: 10, expiry_date: '2030-06-30' }] });
  check(r.status === 200, 'admin physical count: batch 1 = 20, batch 2 = 10', r.data);
  const batches = (await pool.query('SELECT id, batch_number FROM medicine_batches WHERE medicine_id = $1 ORDER BY batch_number', [med])).rows;
  const b1 = batches.find((b: any) => b.batch_number === `ST-B1-${RUN}`).id, b2 = batches.find((b: any) => b.batch_number === `ST-B2-${RUN}`).id;

  section('CREATE / START (stocktake.create)');
  check((await api('POST', '/api/stocktakes', C, { scope_type: 'MEDICINES', medicine_ids: [med] })).status === 403, 'ST1: a cashier cannot create a stocktake');
  check((await api('POST', '/api/stocktakes', M, { scope_type: 'NOPE' })).status === 400, 'ST2: invalid scope -> 400');
  r = await api('POST', '/api/stocktakes', M, { scope_type: 'MEDICINES', medicine_ids: [med], allow_cashier_count: true, notes: 'ZZ ITEST stocktake' });
  const st = r.data?.id;
  check(r.status === 201 && r.data.status === 'DRAFT' && r.data.lines === 2 && /^ST-\d{8}-\d{4}$/.test(r.data.stocktake_number), 'ST3: MANAGER creates a stocktake: DRAFT, one line per batch, number ST-YYYYMMDD-NNNN', r.data);
  const number = r.data?.stocktake_number;
  let d = await api('GET', `/api/stocktakes/${st}`, M);
  const line = (b: string) => d.data.lines.find((l: any) => l.batch_id === b);
  const l1 = line(b1).id, l2 = line(b2).id;
  check((await api('PUT', `/api/stocktakes/${st}/lines/${l1}`, C, { physical_quantity: 1 })).status === 409, 'ST4: no counting while DRAFT (409 INVALID_STATE)');
  check((await api('POST', `/api/stocktakes/${st}/start`, C)).status === 403, 'ST5: a cashier cannot start it');
  r = await api('POST', `/api/stocktakes/${st}/start`, M);
  check(r.status === 200 && r.data.status === 'COUNTING', 'ST6: start -> COUNTING');

  section('COUNTING (blind for cashiers; nothing changes stock)');
  const cd = await api('GET', `/api/stocktakes/${st}`, C);
  check(cd.status === 200 && cd.data.lines.length === 2 && cd.data.lines.every((l: any) => !('system_quantity' in l) && !('unit_cost' in l) && !('variance' in l))
    && !('short' in cd.data.report), 'ST7: CASHIER sees the session BLIND (no system quantity, cost or variance)', cd.data.lines[0]);
  r = await api('PUT', `/api/stocktakes/${st}/lines/${l1}`, C, { physical_quantity: 18, reason: 'ZZ ITEST two missing' });
  check(r.status === 200 && !('system_quantity' in r.data), 'ST8: cashier counts batch 1 = 18 (response blind)', r.data);
  check((await api('PUT', `/api/stocktakes/${st}/lines/${l1}`, C, { physical_quantity: -1 })).status === 400, 'ST9: negative count -> 400');
  check(await qty(b1) === 20 && await stockOf(med) === 30, 'ST10: counting changed NO stock (batch 1 still 20, medicine 30)');
  // A sale AFTER the count: approval must keep it (variance is applied on top of the stock then).
  const price = Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price);
  const sale = await api('POST', '/api/sales/checkout', C, { idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med, quantity: 1, unit_price: price }], payment: { method: 'Cash', amount_received: 100000 } });
  check(sale.status === 201, 'a sale of 1 unit after the count', sale.data);
  r = await api('PUT', `/api/stocktakes/${st}/lines/${l2}`, M, { physical_quantity: 13 });
  check(r.status === 200 && r.data.system_quantity === 10 && r.data.variance === 3, 'ST11: manager counts batch 2 = 13 (sees system 10, variance +3)', r.data);
  d = await api('GET', `/api/stocktakes/${st}`, M);
  check(d.data.report.total_items === 2 && d.data.report.counted === 2 && d.data.report.short === 1 && d.data.report.over === 1 && d.data.report.uncounted === 0
    && d.data.report.total_variance_units === 1 && d.data.report.variance_cost_value === Number(line(b2).unit_cost) * 3 - Number(line(b1).unit_cost) * 2,
    'ST12: report: 2 items, short 1, over 1, variance +1 unit, variance cost from purchase cost', d.data.report);

  section('REVIEW / APPROVAL (stocktake.approve = Administrator)');
  r = await api('POST', `/api/stocktakes/${st}/submit`, M);
  check(r.status === 200 && r.data.status === 'REVIEW', 'ST13: submit -> REVIEW');
  check((await api('PUT', `/api/stocktakes/${st}/lines/${l1}`, M, { physical_quantity: 5 })).status === 409, 'ST14: no counting during REVIEW');
  check((await api('POST', `/api/stocktakes/${st}/approve`, M, {})).status === 403, 'ST15: a MANAGER cannot approve (changes stock)');
  check((await api('POST', `/api/stocktakes/${st}/approve`, C, {})).status === 403, 'ST15: a CASHIER cannot approve');
  const b1Now = await qty(b1), b2Now = await qty(b2);
  r = await api('POST', `/api/stocktakes/${st}/approve`, A, { notes: 'ZZ ITEST approved' });
  check(r.status === 200 && r.data.status === 'COMPLETED' && r.data.adjusted_batches === 2, 'ST16: ADMIN approves -> COMPLETED (2 batches adjusted)', r.data);
  check(await qty(b1) === b1Now - 2 && await qty(b2) === b2Now + 3 && await stockOf(med) === (b1Now - 2) + (b2Now + 3),
    'ST17: variance applied on top of the stock at approval (sale after the count kept): batch 1 -2, batch 2 +3, medicine reconciled', { b1: await qty(b1), b2: await qty(b2) });
  const mv = (await pool.query(`SELECT batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reason FROM inventory_movements WHERE reference_id = $1 ORDER BY batch_id`, [number])).rows;
  check(mv.length === 2 && mv.every((m: any) => m.movement_type === 'PHYSICAL_STOCK_COUNT' && m.reason === 'STOCKTAKE' && m.new_quantity - m.previous_quantity === m.adjustment_quantity),
    'ST18: one PHYSICAL_STOCK_COUNT movement per adjusted batch (previous / delta / new, reference = stocktake number)', mv);
  check((await api('POST', `/api/stocktakes/${st}/approve`, A, {})).status === 409 && (await api('POST', `/api/stocktakes/${st}/cancel`, A, { reason: 'x' })).status === 409,
    'ST19: a COMPLETED stocktake cannot be approved again or cancelled');
  const sh = await api('GET', `/api/history/stock?q=${encodeURIComponent(`Stocktake ${RUN}`)}`, C);
  const shRow = sh.data?.rows?.find((x: any) => x.medicine_id === med);
  check(shRow?.closing === await stockOf(med) && shRow?.status === 'OK', 'ST20: Stock History reflects the stocktake (closing = stock, ledger consistent)', shRow);
  const aud = (await pool.query(`SELECT action FROM audit_logs WHERE entity_id IN ($1, $2) AND action LIKE 'STOCKTAKE%'`, [st, med])).rows.map((x: any) => x.action);
  check(['STOCKTAKE_CREATED', 'STOCKTAKE_START', 'STOCKTAKE_SUBMIT', 'STOCKTAKE_APPROVED', 'STOCKTAKE_ADJUSTMENT'].every((a) => aud.includes(a)), 'ST21: audited (created, start, submit, approved, per-medicine adjustment)', aud);
  const cm = await waitFor(() => cq(`SELECT COUNT(*)::int n FROM giga_cloud.inventory_movements WHERE reference_id = $1`, [number]), (x) => x[0].n === 2);
  check(cm[0].n === 2, 'ST22: the stock change reaches the cloud (2 movements, idempotent PHYSICAL_COUNT events)');

  section('OFFLINE + REFUSALS');
  await env.emu.stop();
  try {
    r = await api('POST', '/api/stocktakes', A, { scope_type: 'MEDICINES', medicine_ids: [med] });
    const st2 = r.data?.id, n2 = r.data?.stocktake_number;
    await api('POST', `/api/stocktakes/${st2}/start`, A);
    const lines2 = (await api('GET', `/api/stocktakes/${st2}`, A)).data.lines;
    const L1 = lines2.find((l: any) => l.batch_id === b1).id;
    const before1 = await qty(b1);
    await api('PUT', `/api/stocktakes/${st2}/lines/${L1}`, A, { physical_quantity: before1 + 4 });
    await api('POST', `/api/stocktakes/${st2}/submit`, A);
    r = await api('POST', `/api/stocktakes/${st2}/approve`, A, {});
    check(r.status === 200 && await qty(b1) === before1 + 4, 'ST23: whole stocktake works OFFLINE (cloud unreachable): approve +4 applied locally', r.data);
    // Negative: count 0 when the batch had N, then the stock drops below the variance before approval -> refused.
    r = await api('POST', '/api/stocktakes', A, { scope_type: 'MEDICINES', medicine_ids: [med] });
    const st3 = r.data?.id;
    await api('POST', `/api/stocktakes/${st3}/start`, A);
    const L3 = (await api('GET', `/api/stocktakes/${st3}`, A)).data.lines.find((l: any) => l.batch_id === b1).id;
    await api('PUT', `/api/stocktakes/${st3}/lines/${L3}`, A, { physical_quantity: 0 });
    await api('POST', '/api/inventory/set-stock', A, { medicine_id: med, batch_id: b1, new_stock: 2, reason: 'ZZ ITEST set' });
    await api('POST', `/api/stocktakes/${st3}/submit`, A);
    const keep = await qty(b1);
    r = await api('POST', `/api/stocktakes/${st3}/approve`, A, {});
    check(r.status === 409 && /below zero/.test(r.data?.error || '') && await qty(b1) === keep, 'ST24: approval refused when a batch would go negative; NOTHING applied', r.data);
    check((await api('POST', `/api/stocktakes/${st3}/cancel`, A, {})).status === 400, 'ST25: cancel needs a reason');
    r = await api('POST', `/api/stocktakes/${st3}/cancel`, A, { reason: 'ZZ ITEST stock moved' });
    check(r.status === 200 && r.data.status === 'CANCELLED' && await qty(b1) === keep, 'ST25: cancelled with a reason; stock unchanged');
    r = await api('POST', '/api/stocktakes', A, { scope_type: 'MEDICINES', medicine_ids: [med] });
    const st4 = r.data?.id;
    await api('POST', `/api/stocktakes/${st4}/start`, A);
    const L4 = (await api('GET', `/api/stocktakes/${st4}`, A)).data.lines[0].id;
    check((await api('PUT', `/api/stocktakes/${st4}/lines/${L4}`, C, { physical_quantity: 1 })).status === 403
      && (await api('GET', `/api/stocktakes/${st4}`, C)).status === 403, 'ST26: a cashier cannot count / open a stocktake not open to cashier counting');
    const cl = await api('GET', '/api/stocktakes', C);
    check(cl.status === 200 && !cl.data.stocktakes.some((x: any) => x.id === st4 || x.id === st), 'ST27: the cashier list shows only sessions open to cashier counting');
    await api('POST', `/api/stocktakes/${st4}/cancel`, A, { reason: 'ZZ ITEST cleanup' });
    await env.emu.restart();
    const back = await waitFor(() => cq(`SELECT COUNT(*)::int n FROM giga_cloud.inventory_movements WHERE reference_id = $1`, [n2]), (x) => x[0].n === 1);
    check(back[0].n === 1, 'ST28: after reconnect the offline stocktake reaches the cloud once');
  } finally {
    await env.emu.restart().catch(() => {});
  }
  check((await api('GET', '/api/stocktakes', null)).status === 401, 'ST29: anonymous -> 401');
}
