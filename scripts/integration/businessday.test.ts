import crypto from 'crypto';
import { api, check, login, pool, section, type Fixture } from './harness';
import type { HistoryScope } from '../../server/db/history';
import { businessDaySummary } from '../../server/db/businessDay';

/**
 * BUSINESS DAY SUMMARY + DATA INTEGRITY (run from test:stock-history).
 * Part A: the summary on a scenario for a FUTURE business date, inside a ROLLED-BACK transaction.
 * Part B: HTTP (RBAC, profit only for Administrators, integrity read only and Administrator only).
 */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const id = () => crypto.randomUUID();

export async function businessDayTests(admin: Fixture) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    section('BUSINESS DAY SUMMARY — CALCULATION (rolled back)');
    const shop = (await c.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0].shop_id.toLowerCase();
    const D = '2031-03-14'; // a future business date nobody else uses
    const dev = `ITEST-BD-${RUN}`;
    await c.query(`INSERT INTO devices (id, name, app_version) VALUES ($1, $1, 'itest') ON CONFLICT (id) DO NOTHING`, [dev]);
    const m = id(), b = id();
    await c.query(`INSERT INTO medicines (id, name, generic_name, sku, barcode, dosage_strength, dosage_form, purchase_price, selling_price, current_stock, reorder_level, unit, status)
                   VALUES ($1, $2, 'bd generic', $3, $3, '1', 'Tablet', 10, 25, 0, 1, 'Unit', 'active')`, [m, `ZZ ITEST BD ${RUN}`, `ITEST-BD-${RUN}`]);
    await c.query(`INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, expiry_status, status)
                   VALUES ($1, $2, 'BD1', 100, 100, 10, '2032-01-01', 'KNOWN', 'active')`, [b, m]);
    const sale = async (total: number, cost: number, qty: number, status: string, pays: [string, number][], change = 0) => {
      const s = id();
      await c.query(`INSERT INTO sales (id, sale_number, receipt_number, cashier_id, device_id, date, time, subtotal, total, cost_total, gross_profit, payment_method, amount_received, change_given, idempotency_key, status)
                     VALUES ($1, $2, $2, $3, $4, $5, '10:00', $6::numeric, $6::numeric, $7::numeric, $6::numeric - $7::numeric, $8, $6::numeric, $9, $10, $11)`,
        [s, `ITEST-BD-${s.slice(0, 12)}`, admin.id, dev, D, total, cost, pays[0][0], change, `itest-bd-${s}`, status]);
      await c.query(`INSERT INTO sale_items (sale_id, medicine_id, batch_id, batch_number, quantity, unit_price, cost_price_snapshot, total) VALUES ($1, $2, $3, 'BD1', $4, $5, 10, $6)`,
        [s, m, b, qty, total / qty, total]);
      for (const [method, amount] of pays) await c.query(`INSERT INTO payments (sale_id, method, amount) VALUES ($1, $2, $3)`, [s, method, amount]);
      return s;
    };
    const s1 = await sale(100, 40, 4, 'completed', [['Cash', 120]], 20); // cash tendered 120, change 20
    await sale(50, 20, 2, 'completed', [['M-Pesa', 50]]);
    await sale(75, 30, 3, 'completed', [['Cash', 25], ['Card', 50]]);
    await sale(999, 1, 1, 'voided', [['Cash', 999]]);
    await c.query(`INSERT INTO returns (sale_id, receipt_number, medicine_id, batch_id, quantity, approved_quantity, unit_price, refund_amount, reason, action, user_id, device_id, status, reviewed_at)
                   VALUES ($1, 'R', $2, $3, 1, 1, 25, 25, 'ITEST', 'restock', $4, $5, 'APPROVED', ($6::date + time '11:00') AT TIME ZONE 'Africa/Nairobi')`, [s1, m, b, admin.id, dev, D]);
    await c.query(`INSERT INTO expenses (id, category, description, amount, payment_method, user_id, date, status, voided_at, void_reason) VALUES ($1, 'Supplies', 'ZZ ITEST BD', 20, 'Cash', $2, $3, 'posted', NULL, NULL),
                   ($4, 'Supplies', 'ZZ ITEST BD void', 70, 'Cash', $2, $3, 'voided', now(), 'ZZ ITEST')`, [id(), admin.id, D, id()]);
    const sup = id();
    await c.query(`INSERT INTO suppliers (id, name, phone, status) VALUES ($1, $2, '0700000000', 'active')`, [sup, `ZZ ITEST BD Supplier ${RUN}`]);
    await c.query(`INSERT INTO purchases (id, order_number, supplier_id, order_date, received_date, status, total_amount, payment_status) VALUES ($1, $2, $3, $4, $4, 'received', 500, 'paid')`,
      [id(), `ITEST-BD-${RUN}`, sup, D]);
    const mv = (type: string, prev: number, next: number) => c.query(
      `INSERT INTO inventory_movements (id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reason, user_id, device_id, timestamp, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 0, $10, ($10::date + time '12:00') AT TIME ZONE 'Africa/Nairobi')`, [id(), m, b, prev, next - prev, next, type, admin.id, dev, D]);
    await mv('DAMAGED', 100, 98);
    await mv('PHYSICAL_STOCK_COUNT', 98, 101);
    await mv('SALE', 101, 92);
    await c.query(`INSERT INTO cashier_shifts (id, shift_number, cashier_id, status, opened_at, opened_business_date, opening_float, closed_at, closed_business_date,
                     actual_cash, expected_cash, cash_variance, close_method, closing_notes)
                   VALUES ($1, $2, $3, 'CLOSED', now(), $4, 0, now(), $4, 95, 100, -5, 'CASHIER', 'ZZ ITEST short')`, [id(), `ITEST-BD-${RUN}`, admin.id, D]);
    const scope: HistoryScope = { q: c, mode: 'local', shopIds: [shop], includeCost: true };
    const d: any = (await businessDaySummary(scope, { date: D })).days[0];
    check(d.gross_sales === 225 && d.transactions === 3 && d.voided_sales === 1 && d.units_sold === 9, 'BD1: gross 225 = 100 + 50 + 75 in 3 sales, 9 units (voided sale excluded)', d);
    check(d.payments.cash === 145 && d.payments.mpesa === 50 && d.payments.card === 50 && d.payments.bank === 0, 'BD2: payments by method (mixed sale split; cash as recorded incl. tendered)', d.payments);
    check(d.returns === 1 && d.refunds === 25 && d.net_sales === 200, 'BD3: approved refund 25 that day -> net sales 200', d);
    check(d.expenses === 20 && d.expenses_count === 1 && d.purchases === 500 && d.purchases_count === 1, 'BD4: expenses (voided excluded) 20; purchases received 500', d);
    check(d.stock_adjustments === 1 && d.adjustment_units === -2 && d.physical_counts === 1 && d.physical_count_units === 3,
      'BD5: adjustments (damaged -2) and physical counts (+3) apart; sales are not adjustments', d);
    check(d.shifts_closed === 1 && d.shifts_short === 1 && d.shift_variance === -5, 'BD6: closed shift short 5', d);
    check(d.cost_of_goods === 90 && d.gross_profit === 225 - 90 - 25, 'BD7: Administrator sees cost of goods 90 and gross profit 110', d);
    const noCost: any = await businessDaySummary({ ...scope, includeCost: false }, { date: D });
    check(!('gross_profit' in noCost.days[0]), 'BD8: no profit without the cost permission');
    let bad = 0;
    for (const q of [{ from: '2031-01-01', to: '2031-12-31' }, { from: '2031-03-14', to: '2031-03-01' }, { date: '2031-02-30' }]) {
      try { await businessDaySummary(scope, q); } catch (e: any) { if (e?.status === 400) bad++; }
    }
    check(bad === 3, 'BD9: > 62 days, reversed range and impossible date -> 400');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

export async function businessDayApiTests(admin: Fixture, cashier: Fixture, manager: { email: string; password: string }) {
  section('BUSINESS DAY + DATA INTEGRITY — API');
  const A = await login(admin.email, admin.password), C = await login(cashier.email, cashier.password), M = await login(manager.email, manager.password);
  check((await api('GET', '/api/business-day', C)).status === 403, 'BD10: CASHIER -> business day 403');
  const mb = await api('GET', '/api/business-day', M), ab = await api('GET', '/api/business-day', A);
  check(mb.status === 200 && !JSON.stringify(mb.data).includes('gross_profit') && ab.status === 200 && 'gross_profit' in ab.data.days[0],
    'BD11: MANAGER without profit, ADMIN with profit (today by default)');
  const snap = async () => (await pool.query(`SELECT (SELECT COUNT(*) FROM sales)::int s, (SELECT COUNT(*) FROM inventory_movements)::int m, (SELECT COUNT(*) FROM medicine_batches)::int b`)).rows[0];
  const before = await snap();
  const ir = await api('GET', '/api/integrity', A);
  const after = await snap();
  check(ir.status === 200 && ir.data.read_only === true && ir.data.checks.length >= 15 && ir.data.checks.every((x: any) => x.severity !== 'UNKNOWN'),
    'IC1: integrity dashboard runs every check (read only, no check errors)', ir.data?.checks?.filter((x: any) => x.severity === 'UNKNOWN'));
  check(JSON.stringify(before) === JSON.stringify(after), 'IC2: running the checks changed nothing');
  check((await api('GET', '/api/integrity', M)).status === 403 && (await api('GET', '/api/integrity', C)).status === 403, 'IC3: integrity is Administrator only');
  check((await api('POST', '/api/integrity', A, {})).status === 404, 'IC4: there is no write / "fix everything" endpoint');
}
