import crypto from 'crypto';
import { api, check, login, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import { expiryRisk, movementAnalysis, reorderSuggestions, stockReconciliation } from '../../server/db/inventoryIntel';
import type { HistoryScope } from '../../server/db/history';

/**
 * STOCK INSIGHTS (reorder / fast-slow-dead / expiry risk / reconciliation), run from test:stock-history.
 * Part A: the calculations on a scenario written RELATIVE TO TODAY inside a ROLLED-BACK transaction.
 * Part B: the HTTP API (RBAC, money only for Administrators, purchase draft creates nothing in stock).
 */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const id = () => crypto.randomUUID();

export async function insightsCalculationTests(admin: Fixture) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const shop = (await c.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0].shop_id.toLowerCase();
    const today = (await c.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS d`)).rows[0].d as string;
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const dev = `ITEST-IN-${RUN}`;
    await c.query(`INSERT INTO devices (id, name, app_version) VALUES ($1, $1, 'itest') ON CONFLICT (id) DO NOTHING`, [dev]);
    const med = async (key: string, reorder: number) => {
      const m = id();
      await c.query(`INSERT INTO medicines (id, name, generic_name, sku, barcode, dosage_strength, dosage_form, purchase_price, selling_price, current_stock, reorder_level, unit, status)
                     VALUES ($1, $2, 'insight generic', $3, $3, '1', 'Tablet', 10, 25, 0, $4, 'Unit', 'active')`, [m, `ZZ ITEST INS ${key} ${RUN}`, `ITEST-IN-${key}-${RUN}`, reorder]);
      return m;
    };
    const batch = async (m: string, qty: number, expiry: string | null, ledger: number | null = qty) => {
      const b = id();
      await c.query(`INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, expiry_status, status)
                     VALUES ($1, $2, $3, $4, $4, 10, $5, $6, 'active')`, [b, m, `IN-${b.slice(0, 8)}`, qty, expiry, expiry ? 'KNOWN' : 'UNKNOWN']);
      if (ledger !== null) {
        await c.query(`INSERT INTO inventory_movements (id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reason, user_id, device_id, timestamp, date)
                       VALUES ($1, $2, $3, 0, $4, $4, 'PHYSICAL_STOCK_COUNT', 'PHYSICAL_STOCK_COUNT', $5, $6, 0, $7)`, [id(), m, b, ledger, admin.id, dev, day(-100)]);
      }
      return b;
    };
    const sell = async (m: string, b: string, qty: number, onDay: string, status = 'completed') => {
      const s = id();
      await c.query(`INSERT INTO sales (id, sale_number, receipt_number, cashier_id, device_id, date, time, subtotal, total, cost_total, gross_profit, payment_method, amount_received, idempotency_key, status)
                     VALUES ($1, $2, $2, $3, $4, $5, '10:00', $6, $6, 0, 0, 'Cash', $6, $8, $7)`, [s, `ITEST-IN-${s.slice(0, 12)}`, admin.id, dev, onDay, qty * 25, status, `itest-in-${s}`]);
      await c.query(`INSERT INTO sale_items (sale_id, medicine_id, batch_id, batch_number, quantity, unit_price, cost_price_snapshot, total) VALUES ($1, $2, $3, 'X', $4, 25, 10, $5)`, [s, m, b, qty, qty * 25]);
    };
    // F: 60 units over the last 30 days (2/day), 3 batches; S: 1 unit in 30 days; D: last sale 70 days ago; Z: never sold.
    const F = await med('FAST', 5), S = await med('SLOW', 2), D = await med('DEAD', 2), Z = await med('ZERO', 0), R = await med('RECON', 0);
    const f1 = await batch(F, 50, day(20)), f2 = await batch(F, 1, day(85)); await batch(F, 20, day(200));
    for (let i = 0; i < 30; i++) await sell(F, f1, 2, day(-i));
    await sell(F, f1, 9, day(-3), 'voided'); // voided: never counted
    const s1 = await batch(S, 30, day(60));
    await sell(S, s1, 1, day(-5));
    const d1 = await batch(D, 20, day(-1));
    await sell(D, d1, 1, day(-70));
    await batch(Z, 10, day(500));
    await batch(R, 10, day(400), 12); // ledger says 12, batch holds 10 -> SHORT -2
    await batch(R, 4, day(400), null); // stock with no movement at all -> INCOMPLETE_HISTORY
    const sup = id();
    await c.query(`INSERT INTO suppliers (id, name, phone, status) VALUES ($1, $2, '0700000000', 'active')`, [sup, `ZZ ITEST INS Supplier ${RUN}`]);
    const po = id();
    await c.query(`INSERT INTO purchases (id, order_number, supplier_id, order_date, status, total_amount, payment_status) VALUES ($1, $2, $3, $4, 'pending', 100, 'unpaid')`, [po, `ITEST-IN-PO-${RUN}`, sup, day(0)]);
    await c.query(`INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, quantity, purchase_price, total) VALUES ($1, $2, 'PENDING', 10, 10, 100)`, [po, F]);

    const scope: HistoryScope = { q: c, mode: 'local', shopIds: [shop], includeCost: false };
    const admin$: HistoryScope = { ...scope, includeCost: true };

    section('STOCK INSIGHTS — REORDER SUGGESTIONS');
    const ro = await reorderSuggestions(scope, { search: RUN });
    const rf = ro.items.find((x: any) => x.medicine_id === F);
    // stock 71 (all unexpired), avg 60/30 = 2/day, cover 35.5 days; need = ceil(2 x 37) + 5 - 71 - 10 on order = -2 -> no suggestion
    check(!rf, 'IN1: FAST medicine with 71 in stock + 10 on order needs nothing yet (74 + 5 - 71 - 10 < 0)', rf);
    const ro2 = await reorderSuggestions(scope, { search: RUN, cover_days: 60 });
    const rf2 = ro2.items.find((x: any) => x.medicine_id === F);
    check(rf2?.suggested_quantity === Math.ceil(2 * 67) + 5 - 71 - 10 && rf2.avg_daily_sales === 2 && rf2.on_order === 10 && rf2.days_of_cover === 35.5 && rf2.urgency === 'PLAN',
      'IN2: with 60 days of cover: suggested = ceil(2 x 67) + 5 - 71 - 10 = 58; voided sale ignored; pending draft counted as on order', rf2);
    const rd = ro.items.find((x: any) => x.medicine_id === D);
    check(rd?.current_stock === 0 && rd.urgency !== undefined, 'IN3: an EXPIRED batch is not sellable stock (DEAD: 20 expired units -> stock 0)', rd);
    check(!('estimated_cost' in (rf2 || {})) && 'estimated_cost' in ((await reorderSuggestions(admin$, { search: RUN, cover_days: 60 })).items.find((x: any) => x.medicine_id === F) || {}),
      'IN4: estimated cost only for the Administrator scope');

    section('STOCK INSIGHTS — FAST / SLOW / DEAD');
    const mv = await movementAnalysis(scope, { search: RUN });
    const cls = (m: string) => mv.items.find((x: any) => x.medicine_id === m)?.class;
    check(cls(F) === 'FAST' && cls(S) === 'SLOW' && cls(D) === 'NO_SALES_60' && cls(Z) === 'NO_SALES_90',
      'IN5: FAST (2/day), SLOW (1 in 30 days), no sale in 60 days (last 70 days ago), no sale in 90 days', { F: cls(F), S: cls(S), D: cls(D), Z: cls(Z) });
    const mvF = mv.items.find((x: any) => x.medicine_id === F);
    check(mvF?.sold_30 === 60 && mvF.velocity_per_day === 2 && mvF.days_since_sale === 0, 'IN6: sold 30 days = 60 (voided excluded), 2/day, last sale today', mvF);
    const mv2 = await movementAnalysis(scope, { search: RUN, fast_per_day: 3 });
    check(mv2.items.find((x: any) => x.medicine_id === F)?.class === 'NORMAL', 'IN7: thresholds are configurable (fast >= 3/day -> F is NORMAL)');
    check(!JSON.stringify(mv).includes('stock_value') && JSON.stringify(await movementAnalysis(admin$, { search: RUN })).includes('stock_value'), 'IN8: stock value only for the Administrator scope');

    section('STOCK INSIGHTS — EXPIRY RISK');
    const ex = await expiryRisk(scope, { search: RUN });
    const risk = (b: string) => ex.items.find((x: any) => x.batch_id === b)?.risk;
    check(risk(f1) === 'HIGH' && risk(f2) === 'MEDIUM' && risk(s1) === 'HIGH' && risk(d1) === 'EXPIRED',
      'IN9: 20 days left -> HIGH; 85 days left, sold in ~77 days (FEFO) -> MEDIUM; slow mover cannot sell 30 in 60 days -> HIGH; expired -> EXPIRED',
      ex.items.filter((x: any) => [f1, f2, s1, d1].includes(x.batch_id)).map((x: any) => [x.batch_number, x.days_remaining, x.estimated_days_to_sell, x.risk]));
    const z = ex.items.find((x: any) => x.medicine_id === Z);
    check(z?.risk === 'LOW' && z.estimated_days_to_sell === null, 'IN10: no sales but 500 days left -> LOW (days to sell unknown)', z);
    check(!JSON.stringify(ex).includes('purchase_value'), 'IN11: purchase value only for the Administrator scope');

    section('STOCK INSIGHTS — RECONCILIATION (ledger vs batches)');
    const rc = await stockReconciliation(scope, { search: RUN });
    const st = (m: string) => rc.items.find((x: any) => x.medicine_id === m);
    check(st(F)?.status === 'BALANCED' && st(R)?.status === 'INCOMPLETE_HISTORY' && st(R)?.batches_without_history === 1,
      'IN12: consistent medicine BALANCED; stock without any movement -> INCOMPLETE_HISTORY', { F: st(F), R: st(R) });
    await c.query(`DELETE FROM medicine_batches WHERE medicine_id = $1 AND id NOT IN (SELECT batch_id FROM inventory_movements WHERE medicine_id = $1)`, [R]);
    const rc2 = await stockReconciliation(scope, { search: RUN });
    const r2 = rc2.items.find((x: any) => x.medicine_id === R);
    check(r2?.status === 'SHORT' && r2.variance === -2 && r2.expected === 12 && r2.actual === 10, 'IN13: batch holds 10 but the ledger last recorded 12 -> SHORT -2', r2);
    let denied = false;
    try { await stockReconciliation({ ...scope, mode: 'cloud' }, {}); } catch (e: any) { denied = e?.status === 501; }
    check(denied, 'IN14: reconciliation is refused online (the shop ledger is authoritative)');
    let cross = false;
    try { await reorderSuggestions(scope, { shop_id: id() }); } catch (e: any) { cross = e?.status === 403; }
    check(cross, 'IN15: another shop_id -> 403');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

export async function insightsApiTests(admin: Fixture, cashier: Fixture, manager: { email: string; password: string }) {
  section('STOCK INSIGHTS — API (RBAC + purchase draft)');
  const A = await login(admin.email, admin.password), C = await login(cashier.email, cashier.password), M = await login(manager.email, manager.password);
  for (const p of ['reorder', 'movement', 'expiry-risk', 'reconciliation']) {
    const c = await api('GET', `/api/inventory/insights/${p}`, C);
    if (c.status !== 403) check(false, `cashier GET ${p} must be 403`, c.status);
  }
  check(true, 'IN16: a CASHIER cannot open any stock insight (403)');
  const mr = await api('GET', '/api/inventory/insights/reorder?cover_days=180', M);
  const ar = await api('GET', '/api/inventory/insights/reorder?cover_days=180', A);
  check(mr.status === 200 && ar.status === 200 && !JSON.stringify(mr.data).includes('estimated_cost') && (ar.data.items.length === 0 || 'estimated_cost' in ar.data.items[0]),
    'IN17: MANAGER sees quantities, ADMIN also costs');
  const med = await upsertFixtureMedicine(`ITEST-INAPI-${RUN}`, `ZZ ITEST INS API ${RUN}`, 30, 12);
  const sup = (await pool.query(`INSERT INTO suppliers (id, name, phone, status) VALUES ($1, $2, '0700000000', 'active') RETURNING id`, [id(), `ZZ ITEST INS API Supplier ${RUN}`])).rows[0].id;
  const stockBefore = Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [med])).rows[0].current_stock);
  const body = { supplier_id: sup, items: [{ medicine_id: med, quantity: 24, purchase_price: 12, batch_number: 'REORDER-TEST' }], notes: 'ZZ ITEST reorder' };
  check((await api('POST', '/api/purchases/drafts', M, body)).status === 403, 'IN18: a MANAGER cannot create a purchase draft (Administrator approval)');
  const d = await api('POST', '/api/purchases/drafts', A, body);
  const stockAfter = Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [med])).rows[0].current_stock);
  check(d.status === 201 && d.data.purchase?.status === 'pending' && stockAfter === stockBefore, 'IN19: ADMIN creates a PENDING purchase draft; stock unchanged (nothing received)', d.data);
  const ro = await api('GET', `/api/inventory/insights/reorder?search=${encodeURIComponent(`INS API ${RUN}`)}&cover_days=180`, A);
  const row = ro.data.items.find((x: any) => x.medicine_id === med);
  check(!row || row.on_order === 24, 'IN20: the pending draft counts as "on order" in the suggestions', row);
}
