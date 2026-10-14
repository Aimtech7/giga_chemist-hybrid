import crypto from 'crypto';
import pg from 'pg';
import { api, BASE, check, login, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import { stockHistory, stockHistoryDetail } from '../../server/db/stockHistory';
import { salesHistory, soldMedicines, type HistoryScope } from '../../server/db/history';
import { HttpError } from '../../server/db/client';

/**
 * DAILY STOCK HISTORY suite (npm run test:stock-history).
 *
 * Part A — the calculation, on a controlled scenario written INSIDE A TRANSACTION THAT IS ROLLED BACK:
 *   local : giga_chemist_dev tables (shop server source)
 *   cloud : giga_chemist_cloud_test giga_cloud tables (online source; recreated per run), Shop 1 + Shop 2
 * The same business events are written to both, so local and cloud must give identical figures.
 * Part B — the HTTP API on a local shop server whose cloud is UNREACHABLE (internet offline), with real
 * checkouts / void / physical count: cashier read-only access, scope, sensitive fields, admin + manager.
 * Nothing touches a real shop, the PC2 giga_chemist database or a real cloud.
 */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const D1 = '2025-03-10', D2 = '2025-03-11', D3 = '2025-03-12', D4 = '2025-03-13'; // Monday .. Thursday
const at = (d: string, hm: string) => `${d}T${hm}:00+03:00`; // Kenya time (UTC+3, no DST)
const id = () => crypto.randomUUID();

// ------------------------------------------------------------------ the scenario (source-neutral)
interface Med { key: string; id: string; name: string; generic: string; barcode: string; sku: string }
interface Batch { key: string; id: string; med: string; number: string; expiry: string; createdAt: string; finalQty: number; legacyBefore?: boolean }
interface Move { batch: string; prev: number; next: number; type: string; reason: string; ref: string | null; at: string }
interface SaleFx { id: string; receipt: string; date: string; time: string; at: string; status: string; items: { batch: string; qty: number }[] }

function scenario() {
  const meds: Med[] = [
    { key: 'A', id: id(), name: `ZZ ITEST SH Paracetamol ${RUN}`, generic: 'Paracetamol shitest', barcode: `ITEST-SH-A-${RUN}`, sku: `SKU-SHA-${RUN}` },
    { key: 'B', id: id(), name: `ZZ ITEST SH Amoxicillin ${RUN}`, generic: 'Amoxicillin shitest', barcode: `ITEST-SH-B-${RUN}`, sku: `SKU-SHB-${RUN}` },
    { key: 'C', id: id(), name: `ZZ ITEST SH Idle Syrup ${RUN}`, generic: 'Idle shitest', barcode: `ITEST-SH-C-${RUN}`, sku: `SKU-SHC-${RUN}` },
    { key: 'L', id: id(), name: `ZZ ITEST SH Legacy Cream ${RUN}`, generic: 'Legacy shitest', barcode: `ITEST-SH-L-${RUN}`, sku: `SKU-SHL-${RUN}` },
  ];
  const batches: Batch[] = [
    { key: 'A1', id: id(), med: 'A', number: `SH-A1-${RUN}`, expiry: '2027-01-31', createdAt: at(D1, '07:00'), finalQty: 4 },
    { key: 'A2', id: id(), med: 'A', number: `SH-A2-${RUN}`, expiry: '2027-06-30', createdAt: at(D1, '07:00'), finalQty: 7 },
    { key: 'B1', id: id(), med: 'B', number: `SH-B1-${RUN}`, expiry: '2028-01-31', createdAt: at(D2, '10:00'), finalQty: 5 },
    { key: 'C1', id: id(), med: 'C', number: `SH-C1-${RUN}`, expiry: '2028-03-31', createdAt: at(D1, '07:00'), finalQty: 20 },
    // Imported from the old system on D3 10:00 with history before it (no running balances).
    { key: 'L1', id: id(), med: 'L', number: `SH-L1-${RUN}`, expiry: '2028-05-31', createdAt: at(D3, '10:00'), finalQty: 9, legacyBefore: true },
  ];
  const r = (n: number) => `RCP-SH-${RUN}-${n}`;
  const moves: Move[] = [
    // D1 (Monday)
    { batch: 'A1', prev: 0, next: 14, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D1, '07:00') },
    { batch: 'A2', prev: 0, next: 6, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D1, '07:00') },
    { batch: 'C1', prev: 0, next: 20, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D1, '07:00') },
    { batch: 'A1', prev: 14, next: 12, type: 'SALE', reason: 'SALE', ref: r(1), at: at(D1, '08:12') },
    { batch: 'A1', prev: 12, next: 9, type: 'SALE', reason: 'SALE', ref: r(2), at: at(D1, '09:45') },
    { batch: 'A2', prev: 6, next: 5, type: 'SALE', reason: 'SALE', ref: r(3), at: at(D1, '10:00') }, // voided on D2
    { batch: 'A2', prev: 5, next: 4, type: 'DAMAGE', reason: 'DAMAGE', ref: null, at: at(D1, '11:00') },
    { batch: 'A1', prev: 9, next: 8, type: 'EXPIRED_REMOVED', reason: 'EXPIRED_REMOVED', ref: null, at: at(D1, '11:30') },
    { batch: 'A1', prev: 8, next: 7, type: 'LOSS', reason: 'Loss', ref: null, at: at(D1, '12:00') },
    { batch: 'A2', prev: 4, next: 2, type: 'SUPPLIER_RETURN', reason: 'SUPPLIER_RETURN', ref: null, at: at(D1, '12:30') },
    { batch: 'A1', prev: 7, next: 6, type: 'SALE', reason: 'SALE', ref: r(4), at: at(D1, '23:30') }, // 20:30 UTC: still Monday in Kenya
    // D2 (Tuesday)
    { batch: 'A1', prev: 6, next: 5, type: 'SALE', reason: 'SALE', ref: r(5), at: at(D2, '00:30') }, // 21:30 UTC MONDAY: Tuesday in Kenya
    { batch: 'A2', prev: 2, next: 3, type: 'VOID_REVERSAL', reason: 'SALE_VOID', ref: r(3), at: at(D2, '09:00') },
    { batch: 'B1', prev: 0, next: 10, type: 'PURCHASE', reason: 'PURCHASE_RECEIPT', ref: `PO-SH-${RUN}`, at: at(D2, '10:00') },
    { batch: 'B1', prev: 10, next: 5, type: 'SALE', reason: 'SALE', ref: r(6), at: at(D2, '11:00') },
    { batch: 'A1', prev: 5, next: 7, type: 'RETURN_APPROVED', reason: 'RETURN_APPROVED', ref: r(1), at: at(D2, '12:00') },
    { batch: 'A1', prev: 7, next: 7, type: 'RETURN_APPROVED_NOT_RESTOCKED', reason: 'RETURN_APPROVED_DAMAGED', ref: r(2), at: at(D2, '12:10') },
    { batch: 'A2', prev: 3, next: 8, type: 'CORRECTION', reason: 'SET_EXACT_STOCK', ref: null, at: at(D2, '13:00') },
    { batch: 'A2', prev: 8, next: 7, type: 'CORRECTION', reason: 'SET_EXACT_STOCK', ref: null, at: at(D2, '13:30') },
    { batch: 'A1', prev: 7, next: 4, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D2, '17:00') },
    // D3: L1 enters the ledger (count 0 -> 9 when it was imported)
    { batch: 'L1', prev: 0, next: 9, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D3, '10:00') },
  ];
  const sales: SaleFx[] = [
    { id: id(), receipt: r(1), date: D1, time: '08:12:00', at: at(D1, '08:12'), status: 'partially_returned', items: [{ batch: 'A1', qty: 2 }] },
    { id: id(), receipt: r(2), date: D1, time: '09:45:00', at: at(D1, '09:45'), status: 'completed', items: [{ batch: 'A1', qty: 3 }] },
    { id: id(), receipt: r(3), date: D1, time: '10:00:00', at: at(D1, '10:00'), status: 'voided', items: [{ batch: 'A2', qty: 1 }] },
    { id: id(), receipt: r(4), date: D1, time: '23:30:00', at: at(D1, '23:30'), status: 'completed', items: [{ batch: 'A1', qty: 1 }] },
    { id: id(), receipt: r(5), date: D2, time: '00:30:00', at: at(D2, '00:30'), status: 'completed', items: [{ batch: 'A1', qty: 1 }] },
    { id: id(), receipt: r(6), date: D2, time: '11:00:00', at: at(D2, '11:00'), status: 'completed', items: [{ batch: 'B1', qty: 5 }] },
    // Old-system sale of the imported medicine (no movement with a balance): its day is INCOMPLETE but Sold is exact.
    { id: id(), receipt: r(7), date: D1, time: '15:00:00', at: at(D1, '15:00'), status: 'completed', items: [{ batch: 'L1', qty: 5 }] },
  ];
  return { meds, batches, moves, sales };
}
type Scenario = ReturnType<typeof scenario>;

// ------------------------------------------------------------------ writers (inside the caller's transaction)
async function writeLocal(c: pg.PoolClient, sc: Scenario, userId: string) {
  const dev = `ITEST-SH-${RUN}`;
  await c.query(`INSERT INTO devices (id, name, app_version) VALUES ($1, $1, 'itest') ON CONFLICT (id) DO NOTHING`, [dev]);
  for (const m of sc.meds) {
    await c.query(`INSERT INTO medicines (id, name, generic_name, sku, barcode, dosage_strength, dosage_form, purchase_price, selling_price, current_stock, reorder_level, unit, status)
                   VALUES ($1, $2, $3, $4, $5, '1 unit', 'Tablet', 60, 100, 0, 5, 'Unit', 'active')`, [m.id, m.name, m.generic, m.sku, m.barcode]);
  }
  const med = (k: string) => sc.meds.find((m) => m.key === k)!.id;
  const bat = (k: string) => sc.batches.find((b) => b.key === k)!;
  for (const b of sc.batches) {
    await c.query(`INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, expiry_status, status, created_at)
                   VALUES ($1, $2, $3, $4, $4, 60, $5, 'KNOWN', 'active', $6)`, [b.id, med(b.med), b.number, b.finalQty, b.expiry, b.createdAt]);
    if (b.legacyBefore) {
      // Old-system history imported with the batch: deltas only (previous = new = 0), dated BEFORE the batch existed here.
      await c.query(`INSERT INTO inventory_movements (id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reason, reference_id, notes, user_id, device_id, timestamp, created_at, date)
                     VALUES ($1, $2, $3, 0, -5, 0, 'SALE', NULL, $4, 'LEGACY_POS: imported', $5, $6, $7, $8, $9)`,
        [id(), med(b.med), b.id, `LEGACY-${RUN}`, userId, dev, Date.parse(at(D1, '15:00')), at(D1, '15:00'), D1]);
    }
  }
  for (const mv of sc.moves) {
    const b = bat(mv.batch);
    await c.query(`INSERT INTO inventory_movements (id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reason, reference_id, notes, user_id, device_id, timestamp, created_at, date)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13, ($13::timestamptz AT TIME ZONE 'Africa/Nairobi')::date)`,
      [id(), med(b.med), b.id, mv.prev, mv.next - mv.prev, mv.next, mv.type, mv.reason, mv.ref, userId, dev, Date.parse(mv.at), mv.at]);
  }
  for (const s of sc.sales) {
    const total = s.items.reduce((t, i) => t + i.qty * 100, 0);
    await c.query(`INSERT INTO sales (id, sale_number, receipt_number, cashier_id, device_id, date, time, subtotal, total, cost_total, gross_profit, payment_method, amount_received, idempotency_key, status, created_at)
                   VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $7, 0, 0, 'Cash', $7, $8, $9, $10)`, [s.id, s.receipt, userId, dev, s.date, s.time, total, `itest-sh-${s.id}`, s.status, s.at]);
    for (const i of s.items) {
      const b = bat(i.batch);
      await c.query(`INSERT INTO sale_items (sale_id, medicine_id, batch_id, batch_number, quantity, unit_price, cost_price_snapshot, total) VALUES ($1, $2, $3, $4, $5, 100, 60, $6)`,
        [s.id, med(b.med), b.id, b.number, i.qty, i.qty * 100]);
    }
  }
  // Returns in every state. Only the APPROVED + restocked one has a stock effect (its movement above).
  const s1 = sc.sales[0], s2 = sc.sales[1], a1 = bat('A1');
  const ret = (sale: SaleFx, status: string, extra: string, vals: unknown[]) => c.query(
    `INSERT INTO returns (sale_id, receipt_number, medicine_id, batch_id, quantity, unit_price, refund_amount, reason, action, user_id, device_id, status${extra ? `, ${extra}` : ''})
     VALUES ($1, $2, $3, $4, 1, 100, 100, 'ITEST', $5, $6, $7, $8${vals.map((_, n) => `, $${9 + n}`).join('')})`,
    [sale.id, sale.receipt, med('A'), a1.id, status === 'APPROVED' ? 'restock' : 'damaged', userId, dev, status, ...vals]);
  await ret(s1, 'APPROVED', 'approved_quantity, reviewed_at, restocked', [2, at(D2, '12:00'), true]);
  await ret(s2, 'APPROVED', 'approved_quantity, reviewed_at, restocked', [1, at(D2, '12:10'), false]);
  await ret(s2, 'PENDING', '', []);
  await ret(s2, 'REJECTED', 'reviewed_at, reviewed_by_name', [at(D2, '12:20'), 'ITest']);
}

async function writeCloud(c: pg.PoolClient, sc: Scenario, shopId: string, opts: { rebaseAt?: string } = {}) {
  for (const m of sc.meds) {
    await c.query(`INSERT INTO giga_cloud.medicines (shop_id, medicine_id, name, generic_name, barcode, sku, status, data, source_seq) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 1)`,
      [shopId, m.id, m.name, m.generic, m.barcode, m.sku, JSON.stringify({ brand_name: null })]);
  }
  const med = (k: string) => sc.meds.find((m) => m.key === k)!.id;
  const bat = (k: string) => sc.batches.find((b) => b.key === k)!;
  let seq = 100;
  const event = async (type: string, occurred: string, payload: unknown) => {
    seq += 1;
    await c.query(`INSERT INTO giga_cloud.processed_events (idempotency_key, event_id, shop_id, local_seq, event_type, entity_type, entity_id, occurred_at, payload)
                   VALUES ($1, $2, $3, $4, $5, 'x', 'x', $6, $7)`, [`itest-sh-${id()}`, id(), shopId, seq, type, occurred, JSON.stringify(payload)]);
    return seq;
  };
  for (const b of sc.batches) {
    await c.query(`INSERT INTO giga_cloud.medicine_batches (shop_id, batch_id, medicine_id, batch_number, expiry_date, status, data, source_seq) VALUES ($1, $2, $3, $4, $5, 'active', $6, 1)`,
      [shopId, b.id, med(b.med), b.number, b.expiry, JSON.stringify({ created_at: b.createdAt })]);
    // The cloud copy has no old-system history: it knows the imported batch from its sync-start BASELINE.
    if (b.legacyBefore) await event('MEDICINE_BASELINE', b.createdAt, { data: { medicine: { id: med(b.med) }, batches: [{ id: b.id, quantity_available: 0 }] } });
  }
  for (const mv of sc.moves) {
    const b = bat(mv.batch);
    const s = await event('MOVEMENT', mv.at, {});
    await c.query(`INSERT INTO giga_cloud.inventory_movements (shop_id, movement_id, event_id, local_seq, medicine_id, batch_id, movement_type, reason, delta, previous_quantity, new_quantity, reference_id, occurred_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [shopId, id(), id(), s, med(b.med), b.id, mv.type, mv.reason, mv.next - mv.prev, mv.prev, mv.next, mv.ref, mv.at]);
  }
  for (const s of sc.sales) {
    await c.query(`INSERT INTO giga_cloud.sales (shop_id, sale_id, sale_number, receipt_number, business_date, business_time, status, data, source_seq) VALUES ($1, $2, $3, $3, $4, $5, $6, '{}', 1)`,
      [shopId, s.id, s.receipt, s.date, s.time, s.status]);
    for (const i of s.items) {
      const b = bat(i.batch);
      await c.query(`INSERT INTO giga_cloud.sale_items (shop_id, sale_item_id, sale_id, medicine_id, batch_id, batch_number, quantity, data) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`,
        [shopId, id(), s.id, med(b.med), b.id, b.number, i.qty]);
    }
  }
  for (const b of sc.batches) {
    await c.query(`INSERT INTO giga_cloud.stock_levels (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq, delta_since_baseline) VALUES ($1, $2, $3, TRUE, $4, 1, 0)`,
      [shopId, med(b.med), b.id, b.finalQty]);
  }
  if (opts.rebaseAt) {
    // A controlled cloud REBASE: cloud stock_levels reset (here: to a different number) + its audit row. Not a movement.
    await c.query(`UPDATE giga_cloud.stock_levels SET baseline_quantity = 999, baseline_seq = $3 WHERE shop_id = $1 AND batch_id = $2`, [shopId, bat('A1').id, seq + 1]);
    await c.query(`INSERT INTO giga_cloud.online_audit (at, shop_id, action, details) VALUES ($1, $2, 'CLOUD_STOCK_REBASE_FROM_PC2', $3)`,
      [opts.rebaseAt, shopId, JSON.stringify({ source: 'ITEST', batches: 1 })]);
  }
}

// ------------------------------------------------------------------ helpers
const rowOf = (res: any, medId: string, date: string, shop?: string) => res.rows.find((r: any) => r.medicine_id === medId && r.date === date && (!shop || r.shop_id === shop));
const figures = (r: any) => r && [r.status, r.opening, r.gross_sold, r.returned, r.net_sold, r.received, r.adjustments, r.closing].join('|');
const COST_KEYS = /"(purchase_price|cost_price|cost_price_snapshot|cost_total|cost_of_goods|gross_profit|profit|valuation|stock_value|margin|wholesale_price|selling_price)"\s*:/i;

export async function stockHistoryCalculationTests(admin: Fixture, cloudPool: pg.Pool) {
  const sc = scenario();
  const M = Object.fromEntries(sc.meds.map((m) => [m.key, m.id]));
  const lc = await pool.connect();
  const cc = await cloudPool.connect();
  try {
    await lc.query('BEGIN');
    await cc.query('BEGIN');
    const shopId = (await lc.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0].shop_id.toLowerCase();
    await writeLocal(lc, sc, admin.id);
    const local: HistoryScope = { q: lc, mode: 'local', shopIds: [shopId], includeCost: false };

    // Cloud: Shop 1 = the same scenario (+ a cloud stock rebase on D2), Shop 2 = its own stock of the same medicine.
    const s1 = crypto.randomUUID(), s2 = crypto.randomUUID();
    await cc.query(`INSERT INTO giga_cloud.shops (shop_id, shop_code, name, token_hash) VALUES ($1, 'SHOP1', 'ITest Shop 1', 'x'), ($2, 'SHOP2', 'ITest Shop 2', 'y')`, [s1, s2]);
    await writeCloud(cc, sc, s1, { rebaseAt: at(D2, '15:00') });
    const sc2 = scenario();
    sc2.meds = [{ ...sc.meds[0], id: crypto.randomUUID() }];
    sc2.batches = [{ key: 'A1', id: crypto.randomUUID(), med: 'A', number: `S2-A1-${RUN}`, expiry: '2027-01-31', createdAt: at(D1, '07:00'), finalQty: 20 }];
    sc2.moves = [{ batch: 'A1', prev: 0, next: 30, type: 'PHYSICAL_STOCK_COUNT', reason: 'PHYSICAL_STOCK_COUNT', ref: null, at: at(D1, '07:00') },
      { batch: 'A1', prev: 30, next: 20, type: 'SALE', reason: 'SALE', ref: `S2-${RUN}`, at: at(D1, '10:00') }];
    sc2.sales = [{ id: crypto.randomUUID(), receipt: `S2-${RUN}`, date: D1, time: '10:00:00', at: at(D1, '10:00'), status: 'completed', items: [{ batch: 'A1', qty: 10 }] }];
    await writeCloud(cc, sc2, s2);
    const cloud1: HistoryScope = { q: cc, mode: 'cloud', shopIds: [s1], includeCost: false };
    const cloudAll: HistoryScope = { q: cc, mode: 'cloud', shopIds: [s1, s2], includeCost: false };

    const q = { q: RUN, from: D1, to: D4, activity_only: 'false', page_size: 500 };
    const L = await stockHistory(local, q);
    const C = await stockHistory(cloud1, q);

    section('STOCK HISTORY — CALCULATION (local source)');
    const a1 = rowOf(L, M.A, D1), a2 = rowOf(L, M.A, D2), a3 = rowOf(L, M.A, D3);
    check(a1?.opening === 0 && a1?.closing === 8, 'TEST 1/17/18: Monday opening 0 (batches created that morning), remaining 8 = 6 (batch A1) + 2 (batch A2)', a1);
    check(a1?.gross_sold === 6, 'TEST 2/16: Monday gross sold 6 = 2 + 3 + 1 (three valid sales); the VOIDED sale (1) is not counted', a1?.gross_sold);
    const bd1 = Object.fromEntries((a1?.adjustment_breakdown || []).map((b: any) => [b.key, b.quantity]));
    check(bd1.DAMAGE === -1 && bd1.EXPIRY === -1 && bd1.LOSS === -1 && bd1.SUPPLIER_RETURN === -2 && bd1.PHYSICAL_COUNT === 20 && bd1.SALE_LATER_VOIDED === -1,
      'TEST 9/10/11/12: damage -1, expiry -1, loss -1, supplier return -2 itemised; opening count +20; stock of the voided sale -1 shown', bd1);
    check(a1?.adjustments === 14 && a1?.status === 'OK', 'Monday reconciles: 0 - 6 + 0 + 0 + 14 = 8', a1);
    check(a2?.opening === a1?.closing && a2?.opening === 8, 'TEST 19: Tuesday opening = Monday closing (8)');
    check(a2?.gross_sold === 1 && a2?.returned === 2 && a2?.net_sold === -1, 'TEST 5: restocked return +2 shown separately; net sold = 1 - 2', a2);
    const bd2 = Object.fromEntries((a2?.adjustment_breakdown || []).map((b: any) => [b.key, b.quantity]));
    check(bd2.VOID_REVERSAL === 1 && bd2.CORRECTION === 4 && bd2.PHYSICAL_COUNT === -3 && (bd2.RETURN_NOT_RESTOCKED ?? 0) === 0,
      'TEST 13/14: corrections +5 and -1 (= +4); void reversal +1; damaged return moves 0 stock (TEST 6)', bd2);
    check(a2?.closing === 11 && a2?.status === 'OK', 'TEST 15/18: Tuesday remaining 11 = A1 4 (the physical count\'s STORED result) + A2 7', a2);
    check(a2?.adjustments === 2, 'Tuesday adjustments +2 = +1 void reversal +4 corrections -3 count; pending / rejected returns change nothing (TEST 7/8)', a2?.adjustments);
    check(a3?.opening === 11 && a3?.closing === 11 && a3?.gross_sold === 0 && a3?.movements === 0, 'TEST 20: no activity on Wednesday: opening = remaining = 11', a3);
    const b2 = rowOf(L, M.B, D2), b1 = rowOf(L, M.B, D1);
    check(b2?.opening === 0 && b2?.received === 10 && b2?.gross_sold === 5 && b2?.closing === 5, 'TEST 4: purchase receipt +10 under Received (batch created that day: opening 0); remaining 5', b2);
    check(b1?.opening === 0 && b1?.closing === 0, 'medicine whose only batch did not exist yet: 0 / 0 (not unknown)', b1);
    const c2 = rowOf(L, M.C, D2);
    check(c2?.opening === 20 && c2?.closing === 20, 'TEST 20: idle medicine keeps opening = remaining (20)', c2);

    const l1 = rowOf(L, M.L, D1), l3 = rowOf(L, M.L, D3), l4 = rowOf(L, M.L, D4);
    check(l1?.status === 'INCOMPLETE' && l1.opening === null && l1.closing === null && l1.gross_sold === 5 && l1.received === null,
      'TEST 27: day before the import = INCOMPLETE STOCK HISTORY (opening / remaining unknown), only the sales (5) shown', l1);
    check(l3?.status === 'INCOMPLETE' && l3.opening === null && l3.closing === 9, 'import day: opening unknown, remaining 9 after the import', l3);
    check(l4?.status === 'OK' && l4.opening === 9 && l4.closing === 9, 'day after the import: exact (9 / 9)', l4);
    const ledgerL = L.ledger.find((x: any) => x.shop_id === shopId);
    check(Boolean(ledgerL?.exact_from_date), 'the earliest exact day is reported for the shop', ledgerL);

    // Kenya business date: 23:30 Monday and 00:30 Tuesday (= 21:30 UTC Monday).
    const det1 = await stockHistoryDetail(local, M.A, { date: D1 });
    const det2 = await stockHistoryDetail(local, M.A, { date: D2 });
    check(det1.events.some((e: any) => e.reference === `RCP-SH-${RUN}-4` && e.time.startsWith('23:30')) && !det1.events.some((e: any) => e.reference === `RCP-SH-${RUN}-5`)
      && det2.events.some((e: any) => e.reference === `RCP-SH-${RUN}-5` && e.time.startsWith('00:30')),
      'TEST 23: a sale at 00:30 Kenya time (21:30 UTC the day before) belongs to the Kenya business day; 23:30 stays on Monday');
    check(det1.batches.length === 2 && det1.batches.reduce((t: number, b: any) => t + b.closing, 0) === 8 && det1.batches.find((b: any) => b.batch_number === `SH-A1-${RUN}`)?.closing === 6,
      'TEST 3: batch rows aggregate to the medicine (6 + 2 = 8)', det1.batches);
    const ev = det1.events.filter((e: any) => !e.legacy_import);
    check(ev.length === 10 && ev.every((e: any, n: number) => n === 0 || e.at >= ev[n - 1].at) && ev.some((e: any) => e.label === 'Sale' && e.before === 14 && e.after === 12 && e.reference === `RCP-SH-${RUN}-1`),
      'drill-down timeline: chronological, with change, before -> after, reference', ev.map((e: any) => `${e.time} ${e.label} ${e.change}`));
    check(ev.some((e: any) => e.user), 'timeline carries the user');

    // Search + date filters.
    const sB = await stockHistory(local, { q: `amoxicillin ${RUN}`, from: D1, to: D4, activity_only: 'false', page_size: 500 });
    check(sB.rows.length === 4 && sB.rows.every((r: any) => r.medicine_id === M.B), 'TEST 21: search (two words, any order) finds only that medicine, every day');
    const sBar = await stockHistory(local, { q: `ITEST-SH-C-${RUN}`, from: D1, to: D1, activity_only: 'false' });
    const sSku = await stockHistory(local, { q: `sku-shl-${RUN}`, from: D1, to: D1, activity_only: 'false' });
    const sGen = await stockHistory(local, { q: `paracetamol shitest ${RUN}`, from: D1, to: D1 });
    check(sBar.rows.length === 1 && sBar.rows[0].medicine_id === M.C && sSku.rows[0]?.medicine_id === M.L && sGen.rows[0]?.medicine_id === M.A,
      'TEST 21: search by barcode, SKU and generic name');
    const one = await stockHistory(local, { q: RUN, date: D2 });
    check(one.days.length === 1 && one.days[0].date === D2 && one.rows.every((r: any) => r.date === D2), 'TEST 22: date = one business day');
    check(one.rows.length === 2 && !one.rows.some((r: any) => r.medicine_id === M.C), 'default = medicines WITH ACTIVITY only (idle medicine hidden)', one.rows.map((r: any) => r.medicine_name));
    const range = await stockHistory(local, { q: RUN, from: D1, to: D3, activity_only: 'false' });
    check(range.days.map((d: any) => d.date).join() === [D3, D2, D1].join() && range.days[2].heading === 'MONDAY, 10 MARCH 2025', 'TEST 22: range grouped by day, newest first, weekday headings');
    const day1 = (await stockHistory(local, { q: RUN, date: D1 })).days[0].summary;
    check(day1.units_sold === 11 && day1.medicines_sold === 2 && day1.units_received === 0 && day1.closing_units === null && day1.incomplete_medicines === 1,
      'per-day cards from the data (units sold 6 + 5 legacy; remaining INCOMPLETE because one medicine is not provable)', day1);
    let bad = false;
    try { await stockHistory(local, { from: '2025-01-01', to: '2025-06-30' }); } catch (e) { bad = e instanceof HttpError && e.status === 400; }
    check(bad, 'a range longer than 62 days is refused (400)');

    // Daily sold == Sales History units (one definition of "Sold").
    const sh = await salesHistory(local, { from: D1, to: D1, medicine_id: M.A, page_size: 25 });
    check(sh.summary!.units_sold === a1.gross_sold, 'TEST 29: Sales History units for the medicine/day = Stock History gross sold', { sales: sh.summary!.units_sold, stock: a1.gross_sold });

    section('SOLD MEDICINES (POS "Today\'s Sold Medicines") — CALCULATION');
    const sold = await soldMedicines(local, { date: D1, search: RUN }, { allowDate: true });
    const sa = sold.items.find((x: any) => x.medicine_id === M.A), sl = sold.items.find((x: any) => x.medicine_id === M.L);
    check(sold.date === D1 && sa?.gross_sold === 6 && sa.retail_qty === 6 && sa.wholesale_qty === 0 && sa.transactions === 3,
      'SOLD 1: Monday gross sold 6 = 2 + 3 + 1 in 3 sales (the VOIDED sale is excluded); legacy sales without a mode count as retail', sa);
    check(sa?.returned === 3 && sa?.net_sold === 3, 'SOLD 2: returned = APPROVED returns of that day\'s sales (2 restocked + 1 damaged); pending / rejected not counted', sa);
    check(sl?.gross_sold === 5 && sold.totals.gross_sold === 11 && sold.totals.transactions === 4, 'SOLD 3: totals over the day (6 + 5 units; 4 non-voided sales: 3 for A, 1 for L)', sold.totals);
    check(sa?.gross_sold === a1.gross_sold, 'SOLD 3: same "Sold" definition as Stock History', { sold: sa?.gross_sold, stock: a1.gross_sold });
    check(!('revenue' in (sa || {})) && !COST_KEYS.test(JSON.stringify(sold)), 'SOLD 4: no money or cost field without the cost permission');
    const soldCost = await soldMedicines({ ...local, includeCost: true }, { date: D1, search: RUN }, { allowDate: true });
    const sac = soldCost.items.find((x: any) => x.medicine_id === M.A);
    check(sac?.revenue === 600 && sac?.cost === 360 && sac?.refunds === 200 && sac?.gross_profit === 40, 'SOLD 5: Administrator sees revenue 600, refunds 200, cost 360, profit 40', sac);
    const forced = await soldMedicines(local, { date: D1, search: RUN }, { allowDate: false });
    check(forced.date !== D1 && forced.is_today, 'SOLD 6: without the date permission (cashier) the date is always TODAY', forced.date);
    const soldC = await soldMedicines(cloud1, { date: D1, search: RUN }, { allowDate: true });
    check(soldC.items.find((x: any) => x.medicine_id === M.A)?.gross_sold === 6 && !soldC.items.some((x: any) => x.shop_id === s2),
      'SOLD 7: cloud source gives the same gross sold (6) and only the authorized shop');
    const soldAll = await soldMedicines(cloudAll, { date: D1, search: RUN }, { allowDate: true });
    check(soldAll.items.some((x: any) => x.shop_id === s2 && x.gross_sold === 10) && soldAll.items.some((x: any) => x.shop_id === s1), 'SOLD 8: All Shops keeps each shop\'s rows');
    let soldDenied = false;
    try { await soldMedicines(cloud1, { date: D1, shop_id: s2 }, { allowDate: true }); } catch (e) { soldDenied = e instanceof HttpError && e.status === 403; }
    check(soldDenied, 'SOLD 9: a Shop 1 scope asking for Shop 2 -> 403');

    // Never today's stock for a past day: change today's batch quantity in this transaction; Monday is unchanged.
    await lc.query('UPDATE medicine_batches SET quantity_available = 500 WHERE medicine_id = $1', [M.A]);
    const again = rowOf(await stockHistory(local, { q: RUN, date: D1 }), M.A, D1);
    check(figures(again) === figures(a1), 'historical remaining never uses current stock (batches set to 500 now; Monday still 8)', again);

    section('STOCK HISTORY — CLOUD SOURCE, REBASE, MULTI-SHOP');
    const diff = sc.meds.flatMap((m) => [D1, D2, D3, D4].map((d) => ({ m: m.key, d, l: figures(rowOf(L, m.id, d)), c: figures(rowOf(C, m.id, d)) }))).filter((x) => x.l !== x.c);
    check(diff.length === 0, 'TEST 42: local and cloud give the same figures for the same events (every medicine, every day)', diff);
    check(C.boundaries.length === 1 && C.boundaries[0].date === D2 && C.days.find((d: any) => d.date === D2)?.boundaries.length === 1,
      'TEST 28: the cloud stock REBASE is reported as a boundary on its day', C.boundaries);
    check(rowOf(C, M.A, D2)?.closing === 11 && rowOf(C, M.A, D3)?.opening === 11, 'TEST 28: the rebase (cloud stock_levels reset to 999) does not change the ledger figures (11)');
    const ALL = await stockHistory(cloudAll, { q: RUN, date: D1 });
    const p1 = rowOf(ALL, M.A, D1, s1), p2 = rowOf(ALL, sc2.meds[0].id, D1, s2);
    check(p1?.closing === 8 && p2?.closing === 20 && p1.shop_code === 'SHOP1' && p2.shop_code === 'SHOP2', 'TEST 26: All Shops keeps each shop\'s own figures (Shop 1 remaining 8, Shop 2 remaining 20)', [p1, p2]);
    const dAll = ALL.days[0];
    check(dAll.by_shop.length === 2 && dAll.summary.units_sold === dAll.by_shop.reduce((t: number, x: any) => t + x.units_sold, 0),
      'All Shops day: per-shop lines + a combined total kept separate', dAll);
    const s2only = await stockHistory(cloudAll, { q: RUN, date: D1, shop_id: s2 });
    check(s2only.rows.length === 1 && s2only.rows[0].shop_id === s2, 'TEST 25: Global scope narrowed to one shop (Shop 2)');
    let denied = false;
    try { await stockHistory(cloud1, { q: RUN, date: D1, shop_id: s2 }); } catch (e) { denied = e instanceof HttpError && e.status === 403; }
    check(denied, 'TEST 24: a Shop 1 scope asking for Shop 2 -> 403');
    const blob = JSON.stringify([L, C, ALL, det1]);
    check(!COST_KEYS.test(blob), 'no cost / price / profit / valuation field anywhere in stock history responses');
  } finally {
    await lc.query('ROLLBACK').catch(() => {});
    await cc.query('ROLLBACK').catch(() => {});
    lc.release();
    cc.release();
  }
}

// ------------------------------------------------------------------ Part B: HTTP (local shop server, cloud unreachable)
export async function stockHistoryApiTests(admin: Fixture, cashier: Fixture, manager: { email: string; password: string }) {
  section('STOCK HISTORY — LOCAL API, CLOUD UNREACHABLE (tests 30-40)');
  const adminToken = await login(admin.email, admin.password);
  const cashierToken = await login(cashier.email, cashier.password);
  const managerToken = await login(manager.email, manager.password);
  const health = await api('GET', '/api/health', null);
  let cloudDown = false;
  try { await fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(1500) }); } catch { cloudDown = true; }
  check(health.status === 200 && cloudDown, 'shop server healthy while its cloud (SUPABASE_URL) is unreachable', health.data?.app_mode);

  const med = await upsertFixtureMedicine(`ITEST-SHAPI-${RUN}`, `ZZ ITEST SH Api Tabs ${RUN}`, 100, 60);
  let r = await api('POST', '/api/inventory/physical-count', adminToken, { medicine_id: med, counts: [{ batch_number: `SHAPI-${RUN}`, quantity: 25, expiry_date: '2031-06-30' }] });
  check(r.status === 200, 'admin physical count: 25', r.data);
  const price = Number((await pool.query('SELECT selling_price FROM medicines WHERE id = $1', [med])).rows[0].selling_price);
  const sell = (qty: number) => api('POST', '/api/sales/checkout', cashierToken, { idempotency_key: `itest-${crypto.randomUUID()}`, items: [{ medicine_id: med, quantity: qty, unit_price: price }], payment: { method: 'Cash', amount_received: 100000 } });
  const sA = await sell(3), sB = await sell(2);
  check(sA.status === 201 && sB.status === 201, 'cashier sells 3 + 2 at the till (offline from the cloud)');
  r = await api('POST', `/api/sales/${sB.data?.sale?.id}/void`, adminToken, { reason: 'ITEST stock history void' });
  check(r.status === 200, 'admin voids the 2-unit sale', r.data);
  const batchQty = Number((await pool.query('SELECT COALESCE(SUM(quantity_available), 0)::int AS q FROM medicine_batches WHERE medicine_id = $1', [med])).rows[0].q);

  const counts = async () => (await pool.query(`SELECT (SELECT COUNT(*) FROM sales)::int s, (SELECT COUNT(*) FROM inventory_movements)::int m, (SELECT COUNT(*) FROM returns)::int r,
     (SELECT COUNT(*) FROM purchases)::int p, (SELECT COALESCE(SUM(quantity_available), 0) FROM medicine_batches)::bigint q`)).rows[0];
  const before = await counts();

  r = await api('GET', `/api/history/stock?q=${encodeURIComponent(`Api Tabs ${RUN}`)}`, cashierToken);
  const row = r.data?.rows?.find((x: any) => x.medicine_id === med);
  check(r.status === 200 && row, 'TEST 30 / 38: CASHIER opens Stock History (today) from LOCAL PostgreSQL with the cloud unreachable', r.data);
  check(row?.gross_sold === 3 && row?.opening === 0 && row?.closing === batchQty && row?.closing === 22 && row?.status === 'OK',
    'today: sold 3 (voided sale excluded), remaining 22 = the batch now', row);
  const bk = Object.fromEntries((row?.adjustment_breakdown || []).map((b: any) => [b.key, b.quantity]));
  check(bk.PHYSICAL_COUNT === 25 && bk.VOID_REVERSAL === 2 && bk.SALE_LATER_VOIDED === -2, 'today: count +25, voided sale -2 and its void reversal +2 itemised', bk);
  check(r.data?.days?.[0]?.heading && r.data.today === r.data.from, 'defaults to TODAY (Kenya business date) with a weekday heading', r.data?.days?.[0]?.heading);
  const det = await api('GET', `/api/history/stock/${med}?date=${r.data?.today}`, cashierToken);
  check(det.status === 200 && det.data.events.length === 4 && det.data.events[0].label === 'Physical count', 'cashier drill-down: movement timeline (count, 2 sales, void reversal)', det.data?.events?.map((e: any) => e.label));
  const yest = new Date(Date.parse(`${r.data.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const ry = await api('GET', `/api/history/stock?date=${yest}&q=${encodeURIComponent(`Api Tabs ${RUN}`)}&activity_only=false`, cashierToken);
  check(ry.status === 200 && ry.data.rows.length === 1 && ry.data.rows[0].closing === 0, 'date selection: yesterday (medicine did not exist yet: 0)', ry.data?.rows);
  const rb = await api('GET', `/api/history/stock?q=ITEST-SHAPI-${RUN}`, cashierToken);
  check(rb.data?.rows?.[0]?.medicine_id === med, 'search by barcode works for the cashier');

  check(!COST_KEYS.test(JSON.stringify([r.data, det.data])), 'TEST 34 / 35: cashier response has no purchase cost, price, profit or valuation field');
  check((await api('GET', '/api/history/sales', cashierToken)).status === 403, 'TEST 31: CASHIER -> /api/history/sales 403');
  check((await api('GET', `/api/history/sales/${sA.data?.sale?.id}`, cashierToken)).status === 403, 'TEST 31: CASHIER -> sale detail 403');
  check((await api('GET', '/api/history/supplies', cashierToken)).status === 403, 'TEST 32: CASHIER -> /api/history/supplies 403');
  check((await api('GET', '/api/history/export/stock', cashierToken)).status === 403, 'cashier cannot export (CSV is Administrator / Manager)');
  const other = crypto.randomUUID();
  const xs = await api('GET', `/api/history/stock?shop_id=${other}`, cashierToken);
  check(xs.status === 403, 'TEST 33: CASHIER asking for another shop_id -> 403', xs.data);
  check((await api('GET', `/api/history/stock/${med}?shop_id=${other}`, cashierToken)).status === 403, 'TEST 33: detail for another shop -> 403');
  const batchId = (await pool.query('SELECT id FROM medicine_batches WHERE medicine_id = $1 LIMIT 1', [med])).rows[0].id;
  const w1 = await api('POST', '/api/inventory/set-stock', cashierToken, { medicine_id: med, batch_id: batchId, quantity: 99, reason: 'x' });
  const w2 = await api('POST', '/api/inventory/remove-stock', cashierToken, { medicine_id: med, batch_id: batchId, quantity: 1, reason: 'DAMAGE' });
  const w3 = await api('POST', '/api/inventory/add-stock', cashierToken, { medicine_id: med, quantity: 1, batch_number: 'X' });
  check(w1.status === 403 && w2.status === 403 && w3.status === 403, 'TEST 36: CASHIER stock adjustment (set / remove / add) -> 403');
  check((await api('POST', '/api/inventory/physical-count', cashierToken, { medicine_id: med, counts: [{ batch_number: 'X', quantity: 1 }] })).status === 403, 'TEST 37: CASHIER physical count -> 403');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const x = await api(m, `/api/history/stock`, adminToken, {});
    if (x.status !== 405) check(false, `${m} /api/history/stock must be 405`, x.status);
  }
  check((await api('POST', `/api/history/stock/${med}`, adminToken, {})).status === 405, 'Stock History is read only for everyone (writes -> 405)');

  const ra = await api('GET', `/api/history/stock?q=${encodeURIComponent(`Api Tabs ${RUN}`)}`, adminToken);
  check(ra.status === 200 && (await api('GET', '/api/history/sales', adminToken)).status === 200 && (await api('GET', '/api/history/supplies', adminToken)).status === 200,
    'TEST 39: ADMIN still has Sales + Supply + Stock History');
  const ex = await fetch(`${BASE}/api/history/export/stock?q=${encodeURIComponent(`Api Tabs ${RUN}`)}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const csv = await ex.text();
  check(ex.status === 200 && csv.startsWith('GIGA CHEMIST\nDAILY STOCK HISTORY\n') && csv.includes('Remaining') && csv.includes(`ZZ ITEST SH Api Tabs ${RUN}`), 'admin CSV export: heading + columns + rows', csv.slice(0, 200));
  const rm = await api('GET', `/api/history/stock?q=${encodeURIComponent(`Api Tabs ${RUN}`)}`, managerToken);
  check(rm.status === 200 && (await api('GET', '/api/history/sales', managerToken)).status === 200 && (await api('GET', '/api/history/supplies', managerToken)).status === 200
    && (await api('POST', '/api/inventory/set-stock', managerToken, { medicine_id: med, batch_id: batchId, quantity: 99, reason: 'x' })).status === 403,
    'TEST 40: MANAGER: Sales + Supply + Stock History, still no stock adjustment');
  section('SOLD MEDICINES — LOCAL API (cashier / manager / admin)');
  const yday = new Date(Date.parse(`${r.data.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const sc = await api('GET', `/api/history/sold?search=${encodeURIComponent(`Api Tabs ${RUN}`)}&date=${yday}`, cashierToken);
  const srow = sc.data?.items?.find((x: any) => x.medicine_id === med);
  check(sc.status === 200 && sc.data.is_today && srow?.gross_sold === 3 && srow?.net_sold === 3 && srow?.current_stock === 22 && srow?.transactions === 1,
    'SOLD API 1: CASHIER sees today\'s sold medicines (3 sold, voided sale excluded, stock 22); a requested other date is ignored', sc.data);
  check(!COST_KEYS.test(JSON.stringify(sc.data)) && !/"revenue"|"refunds"|"cost"/.test(JSON.stringify(sc.data)), 'SOLD API 2: cashier response has quantities only (no money)');
  const sm = await api('GET', `/api/history/sold?search=${encodeURIComponent(`Api Tabs ${RUN}`)}&date=${yday}`, managerToken);
  check(sm.status === 200 && sm.data.date === yday && !/"revenue"/.test(JSON.stringify(sm.data)), 'SOLD API 3: MANAGER can pick another date; still no money', sm.data?.date);
  const sad = await api('GET', `/api/history/sold?search=${encodeURIComponent(`Api Tabs ${RUN}`)}`, adminToken);
  const arow = sad.data?.items?.find((x: any) => x.medicine_id === med);
  check(sad.status === 200 && arow?.revenue === 3 * price && typeof arow?.gross_profit === 'number', 'SOLD API 4: ADMIN sees revenue / cost / profit', arow);
  check((await api('GET', `/api/history/sold?shop_id=${other}`, cashierToken)).status === 403, 'SOLD API 5: another shop_id -> 403');
  check((await api('POST', '/api/history/sold', adminToken, {})).status === 405, 'SOLD API 6: read only (writes -> 405)');
  check((await api('GET', '/api/history/sold?date=2025-13-40', adminToken)).status === 400, 'SOLD API 7: invalid date -> 400');

  const after = await counts();
  check(JSON.stringify(before) === JSON.stringify(after), 'viewing / exporting stock history changed nothing (sales, movements, returns, purchases, stock)', { before, after });
}
