import crypto from 'crypto';
import { api, check, login, pool, section, startServer, stopServer, upsertFixtureMedicine, UUID_RE, BASE } from './harness';
import type { Ctx } from './auth-users.test';

/**
 * Stock, sales, payments, discounts, daily summary, returns, voids, purchases, expenses, suppliers,
 * customers, devices, audit, movements, hydration endpoints, failure handling and restart
 * persistence. Uses ITEST fixtures only; harness cleanup removes the transactional rows afterwards.
 */
const key = () => `itest-${crypto.randomUUID()}`;
const cash = (amount = 1_000_000) => ({ method: 'Cash', amount_received: amount });

async function stock(id: string) {
  return Number((await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [id])).rows[0].current_stock);
}
async function batchQty(medicineId: string, batch: string) {
  const r = await pool.query('SELECT quantity_available FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2', [medicineId, batch]);
  return r.rows[0] ? Number(r.rows[0].quantity_available) : null;
}
async function count(sql: string, params: any[] = []) {
  return Number((await pool.query(sql, params)).rows[0].n);
}
async function physical(ctx: Ctx, medicineId: string, qty: number, expiry = '2029-01-31', batch = 'ITEST-BATCH-1') {
  return api('POST', '/api/inventory/physical-count', ctx.adminToken, {
    medicine_id: medicineId,
    counts: [{ batch_number: batch, quantity: qty, expiry_date: expiry }],
  });
}
function sale(token: string, medicineId: string, qty: number, unitPrice: number, extra: Record<string, unknown> = {}) {
  return api('POST', '/api/sales/checkout', token, {
    idempotency_key: key(),
    items: [{ medicine_id: medicineId, quantity: qty, unit_price: unitPrice }],
    payment: cash(),
    ...extra,
  });
}

export async function commerceTests(ctx: Ctx) {
  const med = await upsertFixtureMedicine('ITEST-SALE-1000', 'ZZ ITEST Sale Medicine', 1000, 600);
  const expMed = await upsertFixtureMedicine('ITEST-EXPIRED-50', 'ZZ ITEST Expired Medicine', 50, 20);
  await pool.query('UPDATE medicines SET wholesale_price = NULL WHERE id = ANY($1::uuid[])', [[med, expMed]]);
  const persisted: Record<string, string> = {};

  // ------------------------------------------------------------------ STOCK (regression Q)
  section('STOCK OPERATIONS (regression)');
  let r = await physical(ctx, med, 0);
  r = await physical(ctx, med, 1);
  check(r.status === 200 && (await stock(med)) === 1 && (await batchQty(med, 'ITEST-BATCH-1')) === 1, 'Physical count 0 -> 1', r.data);
  const batchId = (await pool.query(`SELECT id FROM medicine_batches WHERE medicine_id = $1 AND batch_number = 'ITEST-BATCH-1'`, [med])).rows[0].id;
  check(UUID_RE.test(batchId), 'batch id is a UUID');
  r = await api('POST', '/api/inventory/set-stock', ctx.adminToken, { medicine_id: med, batch_id: batchId, new_stock: 50 });
  check(r.status === 200 && (await stock(med)) === 50, 'Set stock 1 -> 50', r.data);
  r = await api('POST', '/api/inventory/add-stock', ctx.adminToken, { medicine_id: med, quantity: 10, batch_number: 'ITEST-BATCH-1' });
  check(r.status === 200 && (await stock(med)) === 60, 'Add 50 + 10 = 60', r.data);
  r = await api('POST', '/api/inventory/remove-stock', ctx.adminToken, { medicine_id: med, batch_id: batchId, quantity: 10, reason: 'DAMAGE' });
  check(r.status === 200 && (await stock(med)) === 50, 'Remove 60 - 10 = 50', r.data);
  r = await api('POST', '/api/inventory/set-stock', ctx.adminToken, { medicine_id: med, batch_id: batchId, new_stock: 0 });
  check(r.status === 200 && (await stock(med)) === 0, 'Set 50 -> 0', r.data);
  r = await api('PATCH', `/api/batches/${batchId}/expiry`, ctx.adminToken, { expiry_date: '2029-01-31' });
  const exp = await pool.query('SELECT expiry_date, expiry_status FROM medicine_batches WHERE id = $1', [batchId]);
  check(r.status === 200 && exp.rows[0].expiry_date === '2029-01-31' && exp.rows[0].expiry_status === 'KNOWN', 'Expiry = 2029-01-31 (KNOWN)');
  const movs = await pool.query(`SELECT reason FROM inventory_movements WHERE medicine_id = $1 ORDER BY created_at`, [med]);
  check(movs.rows.length >= 6 && movs.rows.every((m) => m.reason), 'every stock operation wrote a movement with a reason', movs.rows.length);
  const audits = await count(`SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'ADMIN_%' AND (entity_id = $1 OR entity_id = $2) AND created_at > now() - interval '15 minutes'`, [med, batchId]);
  check(audits >= 6, 'every stock operation wrote an audit row', audits);
  for (const [path, body] of [
    ['/api/inventory/physical-count', { medicine_id: med, counts: [{ batch_number: 'ITEST-BATCH-1', quantity: 5 }] }],
    ['/api/inventory/set-stock', { medicine_id: med, batch_id: batchId, new_stock: 5 }],
    ['/api/inventory/add-stock', { medicine_id: med, quantity: 5, batch_number: 'ITEST-BATCH-1' }],
    ['/api/inventory/remove-stock', { medicine_id: med, batch_id: batchId, quantity: 1 }],
  ] as const) {
    const c = await api('POST', path, ctx.cashierToken, body);
    check(c.status === 403, `Cashier ${path} -> 403`, c.status);
  }
  const badUuid = await api('POST', '/api/inventory/set-stock', ctx.adminToken, { medicine_id: 'mov-123-abc', new_stock: 1 });
  check(badUuid.status === 400 && /UUID/.test(badUuid.data?.error || ''), 'invalid UUID rejected (400), no DB error', badUuid.data);
  const negative = await api('POST', '/api/inventory/set-stock', ctx.adminToken, { medicine_id: med, batch_id: batchId, new_stock: -3 });
  check(negative.status === 400, 'negative stock rejected (400)', negative.status);

  // ------------------------------------------------------------------ CATEGORIES / MEDICINES / HYDRATION
  section('CATEGORIES, MEDICINES & HYDRATION ENDPOINTS');
  for (const path of ['/api/categories', '/api/medicines', '/api/batches', '/api/customers', '/api/returns', '/api/sales?limit=5']) {
    const c = await api('GET', path, ctx.cashierToken);
    check(c.status === 200 && c.contentType.includes('json'), `Cashier GET ${path} -> JSON 200`, c.status);
  }
  for (const path of ['/api/suppliers', '/api/purchases', '/api/expenses', '/api/inventory/movements', '/api/audit']) {
    const a = await api('GET', path, ctx.adminToken);
    const c = await api('GET', path, ctx.cashierToken);
    check(a.status === 200 && Array.isArray(a.data) && c.status === 403, `GET ${path}: Admin 200 / Cashier 403`, [a.status, c.status]);
  }
  const cats = await api('GET', '/api/categories', ctx.adminToken);
  check(Array.isArray(cats.data) && cats.data.length > 0 && new Set(cats.data.map((c: any) => c.id)).size === cats.data.length, 'categories: real, unique ids');
  await pool.query(`DELETE FROM medicines WHERE barcode = 'ITEST-CREATED' AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.medicine_id = medicines.id)`);
  const created = await api('POST', '/api/medicines', ctx.adminToken, { name: 'ZZ ITEST Created Medicine', barcode: 'ITEST-CREATED', selling_price: 75, purchase_price: 40, category: cats.data[0].name, current_stock: 999 });
  check(created.status === 201 && UUID_RE.test(created.data?.medicine?.id) && created.data.medicine.current_stock === 0, 'Admin creates medicine (UUID, stock forced to 0)', created.data);
  const dupBarcode = await api('POST', '/api/medicines', ctx.adminToken, { name: 'Dup', barcode: 'ITEST-CREATED', selling_price: 5 });
  check(dupBarcode.status === 409, 'duplicate barcode -> 409', dupBarcode.status);
  const upd = await api('PUT', `/api/medicines/${created.data?.medicine?.id}`, ctx.adminToken, { name: 'ZZ ITEST Created Medicine (edited)', current_stock: 500 });
  check(upd.status === 200 && upd.data?.medicine?.current_stock === 0, 'medicine edit never changes stock', upd.data?.medicine);
  const cashierCreate = await api('POST', '/api/medicines', ctx.cashierToken, { name: 'X', selling_price: 1 });
  check(cashierCreate.status === 403, 'Cashier cannot create medicines (403)');

  // ------------------------------------------------------------------ SALES, PAYMENTS, DISCOUNTS, FAILURES
  section('SALES, PAYMENTS & DISCOUNTS');
  await physical(ctx, med, 100);
  const s0 = await stock(med);
  r = await sale(ctx.cashierToken, med, 1, 1000);
  check(r.status === 201 && r.data?.sale?.total === 1000 && r.data?.sale?.payment_method === 'Cash', 'Cash sale 1000', r.data?.sale?.total);
  const pay = await pool.query('SELECT method, amount::float FROM payments WHERE sale_id = $1', [r.data?.sale?.id]);
  check(pay.rows.length === 1 && pay.rows[0].method === 'Cash' && pay.rows[0].amount === 1000, 'cash payment row persisted with the sale');
  const change = await sale(ctx.cashierToken, med, 1, 1000, { payment: { method: 'Cash', amount_received: 1500 } });
  check(change.status === 201 && change.data?.sale?.change_given === 500, 'cash change computed by server (500)');
  const shortCash = await sale(ctx.cashierToken, med, 1, 1000, { payment: { method: 'Cash', amount_received: 999 } });
  check(shortCash.status === 400, 'cash below total rejected (400)');
  const mp = await sale(ctx.cashierToken, med, 1, 1000, { payment: { method: 'M-Pesa', reference: 'qwe123rty' } });
  check(mp.status === 201 && mp.data?.sale?.payment_reference === 'QWE123RTY', 'M-Pesa sale with reference', mp.data?.sale?.payment_reference);
  const mpNoRef = await sale(ctx.cashierToken, med, 1, 1000, { payment: { method: 'M-Pesa' } });
  check(mpNoRef.status === 400, 'M-Pesa without transaction code rejected (400)');
  const split = await sale(ctx.cashierToken, med, 2, 1000, { payment: { method: 'Mixed', split: [{ method: 'Cash', amount: 800 }, { method: 'M-Pesa', amount: 1200, reference: 'ABC123XYZ' }] } });
  const splitRows = await pool.query('SELECT method, amount::float FROM payments WHERE sale_id = $1 ORDER BY method', [split.data?.sale?.id]);
  check(split.status === 201 && splitRows.rows.length === 2 && splitRows.rows[0].amount === 800 && splitRows.rows[1].amount === 1200, 'split payment: one sale, two payment rows (800 + 1200)', splitRows.rows);
  const splitBad = await sale(ctx.cashierToken, med, 2, 1000, { payment: { method: 'Mixed', split: [{ method: 'Cash', amount: 800 }, { method: 'M-Pesa', amount: 1000, reference: 'ABC123XYZ' }] } });
  check(splitBad.status === 400, 'split payments not equal to total rejected (400)');
  for (const d of [0, 5, 10]) {
    const ds = await sale(ctx.cashierToken, med, 1, 1000, { discount_percent: d });
    check(ds.status === 201 && ds.data?.sale?.total === 1000 - d * 10 && ds.data?.sale?.discount_total === d * 10, `Cashier discount ${d}% accepted -> ${1000 - d * 10}`, ds.data?.sale?.total);
  }
  for (const d of [10.01, 11, 50, -1]) {
    const ds = await sale(ctx.cashierToken, med, 1, 1000, { discount_percent: d });
    check(ds.status === 400, `Cashier discount ${d}% rejected (400)`, ds.status);
  }
  const adminDisc = await sale(ctx.adminToken, med, 1, 1000, { discount_percent: 50 });
  check(adminDisc.status === 201 && adminDisc.data?.sale?.total === 500, 'Admin discount 50% allowed (Admin limit 100%)');
  const disc10 = (await sale(ctx.cashierToken, med, 1, 1000, { discount_percent: 10 })).data?.sale;
  const hist = await api('GET', '/api/sales?limit=100', ctx.cashierToken);
  const h = hist.data?.sales?.find((s: any) => s.id === disc10?.id);
  check(h?.total === 900 && h?.discount_percent === 10 && h?.discount_total === 100 && h?.items?.[0]?.unit_price === 1000, 'history shows subtotal 1000, 10%, -100, total 900');
  check(h?.cost_total === 0 && h?.gross_profit === 0, 'Cashier history hides cost/profit');

  section('SALE FAILURES & ROLLBACK');
  const before = await stock(med);
  const salesBefore = await count('SELECT COUNT(*) n FROM sales');
  const tooMany = await sale(ctx.cashierToken, med, 100000, 1000);
  check(tooMany.status === 409 && /Insufficient/.test(tooMany.data?.error || ''), 'insufficient stock rejected (409)', tooMany.data?.error);
  const rollback = await api('POST', '/api/sales/checkout', ctx.cashierToken, {
    idempotency_key: key(),
    items: [{ medicine_id: med, quantity: 1, unit_price: 1000 }, { medicine_id: expMed, quantity: 1, unit_price: 50 }],
    payment: cash(),
  });
  check(rollback.status === 409, 'sale with one unsellable line rejected (409)', rollback.data?.error);
  check((await stock(med)) === before && (await count('SELECT COUNT(*) n FROM sales')) === salesBefore, 'rollback: no sale row and no stock change for the valid line');
  await physical(ctx, expMed, 7, '2020-01-31', 'ITEST-EXPIRED-BATCH');
  const expired = await sale(ctx.cashierToken, expMed, 1, 50);
  check(expired.status === 409 && /EXPIRED/.test(expired.data?.error || ''), 'expired stock cannot be sold (409, says EXPIRED)', expired.data?.error);
  const negQty = await sale(ctx.cashierToken, med, -2, 1000);
  check(negQty.status === 400, 'negative quantity rejected (400)');
  const zeroQty = await sale(ctx.cashierToken, med, 0, 1000);
  check(zeroQty.status === 400, 'zero quantity rejected (400)');
  const badMed = await sale(ctx.cashierToken, 'sal-1791032753129-li4q', 1, 1000);
  check(badMed.status === 400 && /UUID/.test(badMed.data?.error || ''), 'non-UUID medicine id rejected (400)');
  const spoofCashier = await api('POST', '/api/sales/checkout', ctx.cashierToken, { idempotency_key: key(), cashier_id: ctx.admin.id, items: [{ medicine_id: med, quantity: 1, unit_price: 1000 }], payment: cash() });
  check(spoofCashier.status === 201 && spoofCashier.data?.sale?.cashier_id === ctx.cashier.id, 'browser-sent cashier_id ignored (token identity used)');
  const noItems = await api('POST', '/api/sales/checkout', ctx.cashierToken, { idempotency_key: key(), items: [], payment: cash() });
  check(noItems.status === 400, 'empty sale rejected (400)');
  const badJson = await fetch(`${BASE}/api/sales/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.cashierToken}` }, body: '{"items": [' });
  const badJsonBody = await badJson.json().catch(() => null);
  check(badJson.status === 400 && badJsonBody?.error === 'Request body is not valid JSON.', 'malformed JSON -> 400 JSON error (not HTML)', badJson.status);
  const noAuth = await api('POST', '/api/sales/checkout', null, { idempotency_key: key(), items: [{ medicine_id: med, quantity: 1 }], payment: cash() });
  check(noAuth.status === 401, 'checkout without login -> 401');
  const sm = await pool.query(`SELECT previous_quantity, new_quantity, adjustment_quantity, reason, device_id FROM inventory_movements WHERE reference_id = $1`, [r.data?.sale?.receipt_number]);
  check(sm.rows.length === 1 && sm.rows[0].adjustment_quantity === -1 && sm.rows[0].new_quantity === sm.rows[0].previous_quantity - 1 && sm.rows[0].reason === 'SALE',
    'sale movement: correct previous/new quantity and reason', sm.rows[0]);
  check((await stock(med)) < s0, 'stock deducted by completed sales');

  // ------------------------------------------------------------------ DAILY SUMMARY (controlled delta)
  section('DAILY SUMMARY (controlled)');
  const sum = async (token: string) => (await api('GET', '/api/sales/today-summary', token)).data;
  const c2Before = await sum(ctx.cashier2Token);
  const c1Before = await sum(ctx.cashierToken);
  const adminBefore = await sum(ctx.adminToken);
  const sale1 = await sale(ctx.cashier2Token, med, 1, 1000);
  const sale2 = await sale(ctx.cashier2Token, med, 2, 1000, { payment: { method: 'M-Pesa', reference: 'SUMTEST01' } });
  const sale3 = await sale(ctx.cashier2Token, med, 1, 1000, { discount_percent: 10 });
  check([sale1, sale2, sale3].every((x) => x.status === 201), 'controlled sales committed (1000 cash, 2000 M-Pesa, 900 cash after 10%)');
  const c2After = await sum(ctx.cashier2Token);
  const d = (k: string) => Math.round((c2After[k] - c2Before[k]) * 100) / 100;
  check(d('cashTotal') === 1900 && d('mpesaTotal') === 2000 && d('totalSales') === 3900 && d('transactionCount') === 3,
    'Cash +1900, M-Pesa +2000, Total +3900, Transactions +3', { cash: d('cashTotal'), mpesa: d('mpesaTotal'), total: d('totalSales'), txn: d('transactionCount') });
  check(c2After.scope === 'cashier' && c2After.grossProfit === undefined, 'Cashier summary is own-scope and hides profit');
  const c1After = await sum(ctx.cashierToken);
  check(c1After.totalSales === c1Before.totalSales, "another Cashier's sales do not appear in my summary");
  const adminAfter = await sum(ctx.adminToken);
  check(Math.round((adminAfter.totalSales - adminBefore.totalSales) * 100) / 100 === 3900 && adminAfter.scope === 'all' && typeof adminAfter.grossProfit === 'number',
    'Admin summary includes all cashiers (+3900) and gross profit');
  check(/^\d{4}-\d{2}-\d{2}$/.test(c2After.date), 'summary reports the Africa/Nairobi business date', c2After.date);

  // ------------------------------------------------------------------ VOID
  section('VOID');
  const stockBeforeVoid = await stock(med);
  const v = await api('POST', `/api/sales/${sale2.data.sale.id}/void`, ctx.adminToken, { void_reason: 'ITEST void' });
  check(v.status === 200 && v.data?.sale?.status === 'voided' && v.data?.sale?.void_reason === 'ITEST void', 'Admin voids sale (kept, marked voided)', v.data?.error);
  check((await stock(med)) === stockBeforeVoid + 2, 'void restored 2 units to stock');
  const rev = await count(`SELECT COUNT(*) n FROM inventory_movements WHERE reference_id = $1 AND movement_type = 'VOID_REVERSAL'`, [sale2.data.sale.receipt_number]);
  check(rev === 1, 'reverse inventory movement written', rev);
  const keptPay = await count('SELECT COUNT(*) n FROM payments WHERE sale_id = $1', [sale2.data.sale.id]);
  check(keptPay === 1, 'original payment record preserved');
  const afterVoid = await sum(ctx.cashier2Token);
  check(Math.round((c2After.totalSales - afterVoid.totalSales) * 100) / 100 === 2000 && afterVoid.mpesaTotal === c2After.mpesaTotal - 2000 && afterVoid.voidedCount === c2After.voidedCount + 1,
    'void removed 2000 from totals and M-Pesa; voided count +1');
  const again = await api('POST', `/api/sales/${sale2.data.sale.id}/void`, ctx.adminToken, { void_reason: 'again' });
  check(again.status === 409, 'second void rejected (409)', again.status);
  const cashierVoid = await api('POST', `/api/sales/${sale1.data.sale.id}/void`, ctx.cashierToken, { void_reason: 'nope' });
  check(cashierVoid.status === 403, 'Cashier cannot void (403)');
  const noReason = await api('POST', `/api/sales/${sale1.data.sale.id}/void`, ctx.adminToken, {});
  check(noReason.status === 400, 'void without reason rejected (400)');
  const legacy = (await pool.query(`SELECT id FROM sales WHERE idempotency_key LIKE 'LEGACY-%' LIMIT 1`)).rows[0];
  if (legacy) {
    const lv = await api('POST', `/api/sales/${legacy.id}/void`, ctx.adminToken, { void_reason: 'test' });
    check(lv.status === 409, 'imported legacy sale cannot be voided (409)', lv.status);
  }
  persisted.voidedSale = sale2.data.sale.id;

  // ------------------------------------------------------------------ RETURNS
  section('RETURNS — REQUEST / APPROVE / REJECT');
  const request = (token: string, s: any, qty: number, reason = 'ITEST return') =>
    api('POST', '/api/returns', token, { sale_id: s.id, medicine_id: s.items[0].medicine_id, batch_id: s.items[0].batch_id, quantity: qty, reason });
  const approve = (token: string, id: string, restock: boolean, extra: Record<string, unknown> = {}) =>
    api('POST', `/api/returns/${id}/approve`, token, { restock, ...extra });
  const reject = (token: string, id: string, notes = 'ITEST rejected') => api('POST', `/api/returns/${id}/reject`, token, { notes });

  const rs = await sale(ctx.cashierToken, med, 3, 1000, { discount_percent: 10 }); // 3 x 1000 - 10% = 2700 paid
  const rsale = rs.data.sale;
  const movementsFor = async () => count(`SELECT COUNT(*) n FROM inventory_movements WHERE reference_id = $1 AND movement_type LIKE 'RETURN%'`, [rsale.receipt_number]);

  // TEST A — Cashier request: PENDING, nothing else changes
  const stockA = await stock(med);
  const sumA = await sum(ctx.cashierToken);
  const reqA = await request(ctx.cashierToken, rsale, 1, 'ITEST A');
  check(reqA.status === 201 && UUID_RE.test(reqA.data?.return?.id) && reqA.data?.return?.status === 'PENDING', 'A: Cashier request -> PENDING (UUID)', reqA.data);
  check(reqA.data?.return?.refund_amount === 0 && reqA.data?.return?.requested_refund === 900, 'A: no refund finalised; requested refund 900 (discounted price)', reqA.data?.return);
  check((await stock(med)) === stockA && (await movementsFor()) === 0, 'A: stock unchanged and no return movement while PENDING');
  const sumAfterA = await sum(ctx.cashierToken);
  check(sumAfterA.refundsTotal === sumA.refundsTotal && sumAfterA.totalSales === sumA.totalSales, 'A: daily totals unchanged while PENDING');
  check(reqA.data?.sale?.status === 'completed', 'A: sale status unchanged while PENDING');
  const auditReq = await count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'RETURN_REQUESTED' AND entity_id = $1`, [reqA.data?.return?.id]);
  check(auditReq === 1, 'A: RETURN_REQUESTED audited');

  // RBAC — D / E / stock bypass / unauthenticated
  const cashierApprove = await approve(ctx.cashierToken, reqA.data.return.id, true);
  check(cashierApprove.status === 403, 'D: Cashier approve -> 403', cashierApprove.status);
  const cashierReject = await reject(ctx.cashierToken, reqA.data.return.id);
  check(cashierReject.status === 403, 'D: Cashier reject -> 403', cashierReject.status);
  for (const [method, path] of [['PATCH', `/api/returns/${reqA.data.return.id}`], ['PUT', `/api/returns/${reqA.data.return.id}`], ['PATCH', `/api/returns/${reqA.data.return.id}/status`]] as const) {
    const r = await api(method, path, ctx.cashierToken, { status: 'APPROVED' });
    check(r.status === 403, `E: Cashier ${method} ${path.replace(reqA.data.return.id, ':id')} -> 403`, r.status);
  }
  const adminDirect = await api('PATCH', `/api/returns/${reqA.data.return.id}`, ctx.adminToken, { status: 'APPROVED' });
  check(adminDirect.status === 405, 'E: even Admin cannot edit status directly (405)', adminDirect.status);
  const bypass = await api('POST', '/api/inventory/add-stock', ctx.cashierToken, { medicine_id: med, quantity: 1, batch_number: 'ITEST-BATCH-1' });
  check(bypass.status === 403, 'Cashier direct stock-restoration endpoint -> 403', bypass.status);
  const anonReq = await api('POST', '/api/returns', null, { sale_id: rsale.id });
  const anonApprove = await api('POST', `/api/returns/${reqA.data.return.id}/approve`, null, { restock: true });
  check(anonReq.status === 401 && anonApprove.status === 401, 'unauthenticated request/approve -> 401');
  const spoofRole = await api('POST', `/api/returns/${reqA.data.return.id}/approve`, ctx.cashierToken, { restock: true }, { 'x-user-role': 'ADMIN' });
  check(spoofRole.status === 403, 'x-user-role: ADMIN header does not grant approval (403)');
  check(await count(`SELECT COUNT(*) n FROM returns WHERE id = $1 AND status = 'PENDING'`, [reqA.data.return.id]) === 1, 'still PENDING after all rejected attempts');

  // TEST B — Admin approves with restock
  const stockB = await stock(med);
  const sumB = await sum(ctx.cashierToken);
  const apB = await approve(ctx.adminToken, reqA.data.return.id, true, { notes: 'sealed pack' });
  check(apB.status === 200 && apB.data?.return?.status === 'APPROVED' && apB.data?.refund_amount === 900, 'B: Admin approve -> APPROVED, refund 900', apB.data?.error || apB.data?.return?.status);
  check((await stock(med)) === stockB + 1, 'B: stock +1 after approval (restock YES)');
  const mvB = await pool.query(`SELECT movement_type, adjustment_quantity, user_id, notes FROM inventory_movements WHERE reference_id = $1 AND movement_type LIKE 'RETURN%'`, [rsale.receipt_number]);
  check(mvB.rows.length === 1 && mvB.rows[0].movement_type === 'RETURN_APPROVED' && mvB.rows[0].adjustment_quantity === 1 && mvB.rows[0].user_id === ctx.admin.id && mvB.rows[0].notes.includes(reqA.data.return.id),
    'B: RETURN_APPROVED movement +1 by the Admin, referencing the return id', mvB.rows[0]);
  check(apB.data?.return?.reviewed_by_name === 'ITest Admin' && apB.data?.return?.reviewed_at && apB.data?.return?.review_notes === 'sealed pack', 'B: reviewer, time and notes recorded');
  check(await count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'RETURN_APPROVED' AND entity_id = $1`, [reqA.data.return.id]) === 1, 'B: RETURN_APPROVED audited');
  const sumAfterB = await sum(ctx.cashierToken);
  check(Math.round((sumAfterB.refundsTotal - sumB.refundsTotal) * 100) / 100 === 900 && sumAfterB.totalSales === sumB.totalSales, 'B: daily refunds +900 only after approval; sales total unchanged');
  check(apB.data?.sale?.status === 'partially_returned', 'B: sale partially_returned after approval');

  // TEST F — approve twice / reject after approve
  const twice = await approve(ctx.adminToken, reqA.data.return.id, true);
  const rejectAfter = await reject(ctx.adminToken, reqA.data.return.id);
  check(twice.status === 409 && rejectAfter.status === 409 && (await stock(med)) === stockB + 1, 'F: second approval and later rejection refused (409); no duplicate stock');

  // TEST C — another request, rejected
  const stockC = await stock(med);
  const sumC = await sum(ctx.cashierToken);
  const reqC = await request(ctx.cashierToken, rsale, 1, 'ITEST C');
  const rejC = await reject(ctx.adminToken, reqC.data?.return?.id, 'customer opened the pack');
  check(reqC.status === 201 && rejC.status === 200 && rejC.data?.return?.status === 'REJECTED' && rejC.data?.return?.review_notes === 'customer opened the pack', 'C: Admin rejects with reason -> REJECTED');
  const sumAfterC = await sum(ctx.cashierToken);
  check((await stock(med)) === stockC && sumAfterC.refundsTotal === sumC.refundsTotal && sumAfterC.totalSales === sumC.totalSales, 'C: rejection changes no stock, refunds or revenue');
  check(await count(`SELECT COUNT(*) n FROM inventory_movements WHERE notes LIKE $1`, [`%${reqC.data?.return?.id}%`]) === 0, 'C: no movement for the rejected return');
  const approveRejected = await approve(ctx.adminToken, reqC.data?.return?.id, true);
  check(approveRejected.status === 409, 'F: approval after rejection refused (409)');
  check(await count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'RETURN_REJECTED' AND entity_id = $1`, [reqC.data?.return?.id]) === 1, 'C: RETURN_REJECTED audited');
  const mine = await api('GET', '/api/returns', ctx.cashierToken);
  check(mine.data?.some?.((r: any) => r.id === reqC.data?.return?.id && r.status === 'REJECTED' && r.review_notes === 'customer opened the pack'), 'C: Cashier sees REJECTED with the Admin reason');
  const others = await api('GET', '/api/returns', ctx.cashier2Token);
  check(Array.isArray(others.data) && !others.data.some((r: any) => r.id === reqC.data?.return?.id), "another Cashier cannot see my requests");

  // TEST G / H — quantity limits (sold 3: 1 approved, 1 rejected -> 2 still returnable)
  const retTooMany = await request(ctx.cashierToken, rsale, 3);
  check(retTooMany.status === 409, 'G: requesting more than remaining (3 > 2) rejected (409)', retTooMany.data?.error);
  const reqH1 = await request(ctx.cashierToken, rsale, 1, 'ITEST H1');
  const dupPending = await request(ctx.cashierToken, rsale, 2, 'ITEST H dup');
  check(reqH1.status === 201 && dupPending.status === 409, 'H: pending requests count against the remaining quantity (no duplicate over-claim)', dupPending.data?.error);
  const reqH2 = await request(ctx.cashierToken, rsale, 1, 'ITEST H2');
  check(reqH2.status === 201, 'H: second valid partial request accepted');
  const zeroLeft = await request(ctx.cashierToken, rsale, 1);
  check(zeroLeft.status === 409, 'H: nothing left to request once approved + pending = sold (409)');
  // TEST K — non-restockable approval: refund finalised, stock unchanged
  const stockK = await stock(med);
  const apK = await approve(ctx.adminToken, reqH1.data?.return?.id, false, { disposition: 'damaged' });
  check(apK.status === 200 && apK.data?.refund_amount === 900 && apK.data?.return?.restocked === false && (await stock(med)) === stockK, 'K: approved without restock -> refund 900, stock unchanged', apK.data?.error);
  const mvK = await pool.query(`SELECT movement_type, adjustment_quantity FROM inventory_movements WHERE notes LIKE $1`, [`%${reqH1.data?.return?.id}%`]);
  check(mvK.rows[0]?.movement_type === 'RETURN_APPROVED_NOT_RESTOCKED' && mvK.rows[0]?.adjustment_quantity === 0, 'K: zero-quantity RETURN_APPROVED_NOT_RESTOCKED movement records the decision');
  const apH2 = await approve(ctx.adminToken, reqH2.data?.return?.id, true);
  check(apH2.status === 200 && apH2.data?.refund_amount === 900 && apH2.data?.sale?.status === 'returned', 'H: final unit approved; sale fully returned');
  const refunded = await pool.query(`SELECT COALESCE(SUM(refund_amount), 0)::float s, COALESCE(SUM(approved_quantity), 0)::int q FROM returns WHERE sale_id = $1 AND status = 'APPROVED'`, [rsale.id]);
  check(refunded.rows[0].q === 3 && refunded.rows[0].s === 2700, 'H: cumulative approved quantity = sold (3), refunds = paid (2700)', refunded.rows[0]);
  const retZeroQty = await request(ctx.cashierToken, rsale, 0);
  check(retZeroQty.status === 400, 'invalid quantity (0) rejected (400)');
  const retNoReason = await api('POST', '/api/returns', ctx.cashierToken, { sale_id: rsale.id, medicine_id: med, batch_id: rsale.items[0].batch_id, quantity: 1 });
  check(retNoReason.status === 400, 'request without reason rejected (400)');
  const otherCashierSale = await request(ctx.cashier2Token, rsale, 1);
  check(otherCashierSale.status === 403, "Cashier cannot request a return on another cashier's sale (403)");

  // TEST I — discount (covered above: 10% -> 900 per unit). TEST J — wholesale sale
  await api('PATCH', `/api/medicines/${med}/pricing`, ctx.adminToken, { wholesale_price: 800 });
  const ws = await api('POST', '/api/sales/checkout', ctx.cashierToken, {
    idempotency_key: key(), price_mode: 'WHOLESALE', items: [{ medicine_id: med, quantity: 2, unit_price: 800 }], payment: cash(),
  });
  const reqJ = await request(ctx.cashierToken, ws.data?.sale, 1, 'ITEST J');
  await api('PATCH', `/api/medicines/${med}/pricing`, ctx.adminToken, { selling_price: 1200, wholesale_price: 950 }); // price changes after the sale
  const apJ = await approve(ctx.adminToken, reqJ.data?.return?.id, true);
  check(ws.status === 201 && apJ.status === 200 && apJ.data?.refund_amount === 800, 'J: wholesale return refunds the wholesale price charged (800), not today\'s price', apJ.data?.refund_amount);
  await api('PATCH', `/api/medicines/${med}/pricing`, ctx.adminToken, { selling_price: 1000, wholesale_price: null });

  // Expired batch cannot be restocked; refund-only approval still allowed
  const exSale = await (async () => {
    await physical(ctx, expMed, 3, '2029-01-31', 'ITEST-GOOD-BATCH');
    return (await sale(ctx.cashierToken, expMed, 1, 50)).data?.sale;
  })();
  await pool.query(`UPDATE medicine_batches SET expiry_date = '2020-01-31' WHERE id = $1`, [exSale?.items?.[0]?.batch_id]);
  const reqEx = await request(ctx.cashierToken, exSale, 1, 'expired item');
  const apExRestock = await approve(ctx.adminToken, reqEx.data?.return?.id, true);
  check(apExRestock.status === 400 && /expired/i.test(apExRestock.data?.error || ''), 'restocking an expired batch refused at approval (400)');
  check(await count(`SELECT COUNT(*) n FROM returns WHERE id = $1 AND status = 'PENDING'`, [reqEx.data?.return?.id]) === 1, 'failed approval rolled back: request still PENDING');
  const apExNo = await approve(ctx.adminToken, reqEx.data?.return?.id, false, { disposition: 'dispose' });
  check(apExNo.status === 200 && apExNo.data?.return?.restocked === false, 'expired item: refund-only approval succeeds');

  // Races: two simultaneous approvals of one request -> exactly one succeeds
  const raceSale = (await sale(ctx.cashierToken, med, 1, 1000)).data?.sale;
  const raceReq = await request(ctx.cashierToken, raceSale, 1, 'race');
  const stockRace = await stock(med);
  const [r1, r2] = await Promise.all([approve(ctx.adminToken, raceReq.data?.return?.id, true), approve(ctx.adminToken, raceReq.data?.return?.id, true)]);
  check([r1.status, r2.status].sort().join(',') === '200,409' && (await stock(med)) === stockRace + 1, 'concurrent approvals: one 200, one 409, stock +1 once', [r1.status, r2.status]);

  // Void rules interact with returns
  const voidWithReturns = await api('POST', `/api/sales/${rsale.id}/void`, ctx.adminToken, { void_reason: 'x' });
  check(voidWithReturns.status === 409, 'sale with approved returns cannot be voided (409)');
  const pendSale = (await sale(ctx.cashierToken, med, 1, 1000)).data?.sale;
  await request(ctx.cashierToken, pendSale, 1, 'pending then void');
  const voidPending = await api('POST', `/api/sales/${pendSale.id}/void`, ctx.adminToken, { void_reason: 'x' });
  check(voidPending.status === 409, 'sale with a pending return cannot be voided (409)');
  const voidedSale = (await sale(ctx.cashierToken, med, 1, 1000)).data?.sale;
  await api('POST', `/api/sales/${voidedSale.id}/void`, ctx.adminToken, { void_reason: 'void first' });
  const reqOnVoided = await request(ctx.cashierToken, voidedSale, 1);
  check(reqOnVoided.status === 409, 'no return request on a voided sale (409)');

  persisted.returnId = reqA.data?.return?.id;
  persisted.rejectedReturnId = reqC.data?.return?.id;

  section('SUPPLIERS & PURCHASES');
  const sup = await api('POST', '/api/suppliers', ctx.adminToken, { name: 'ZZ ITEST Supplier', phone: '0700000000' });
  check(sup.status === 200 && UUID_RE.test(sup.data?.supplier?.id), 'Admin creates supplier (UUID)', sup.data);
  const supEdit = await api('POST', '/api/suppliers', ctx.adminToken, { id: sup.data?.supplier?.id, name: 'ZZ ITEST Supplier Ltd', phone: '0700000001' });
  check(supEdit.status === 200 && supEdit.data?.supplier?.name === 'ZZ ITEST Supplier Ltd' && supEdit.data?.supplier?.id === sup.data?.supplier?.id, 'Admin edits supplier (same id)');
  const supCashier = await api('POST', '/api/suppliers', ctx.cashierToken, { name: 'ZZ ITEST Nope' });
  check(supCashier.status === 403, 'Cashier cannot manage suppliers (403)');
  const supBadId = await api('POST', '/api/suppliers', ctx.adminToken, { id: 'sup-001', name: 'ZZ ITEST Bad' });
  check(supBadId.status === 400, 'non-UUID supplier id rejected (400)');
  const existingBefore = await batchQty(med, 'ITEST-BATCH-1');
  const medStockBefore = await stock(med);
  const invoice = `ITEST-INV-${Date.now()}`;
  const pur = await api('POST', '/api/purchases', ctx.adminToken, {
    supplier_id: sup.data.supplier.id,
    invoice_number: invoice,
    items: [
      { medicine_id: med, batch_number: 'ITEST-BATCH-1', expiry_date: '2029-01-31', quantity: 12, purchase_price: 610 },
      { medicine_id: med, batch_number: 'ITEST-NEW-BATCH', expiry_date: '2030-06-30', quantity: 8, purchase_price: 620 },
    ],
  });
  check(pur.status === 201 && UUID_RE.test(pur.data?.purchase?.id) && pur.data?.purchase?.total_amount === 12 * 610 + 8 * 620, 'purchase received (UUID, server-computed total)', pur.data?.error || pur.data?.purchase?.total_amount);
  check((await batchQty(med, 'ITEST-BATCH-1')) === existingBefore! + 12 && (await batchQty(med, 'ITEST-NEW-BATCH')) === 8 && (await stock(med)) === medStockBefore + 20,
    'existing batch +12, new batch created with 8, medicine stock +20');
  const pmov = await count(`SELECT COUNT(*) n FROM inventory_movements WHERE reference_id = $1 AND reason = 'PURCHASE_RECEIPT'`, [pur.data?.purchase?.order_number]);
  check(pmov === 2, 'two purchase movements written', pmov);
  const pitems = await count('SELECT COUNT(*) n FROM purchase_items WHERE purchase_id = $1', [pur.data?.purchase?.id]);
  check(pitems === 2, 'two purchase_items rows');
  const cost = await pool.query('SELECT purchase_price::float AS p, selling_price::float AS s FROM medicines WHERE id = $1', [med]);
  check(cost.rows[0].s === 1000, 'receiving goods never changes the selling price', cost.rows[0]);
  const dupInv = await api('POST', '/api/purchases', ctx.adminToken, { supplier_id: sup.data.supplier.id, invoice_number: invoice, items: [{ medicine_id: med, batch_number: 'X1', expiry_date: '2029-01-31', quantity: 1, purchase_price: 1 }] });
  check(dupInv.status === 409, 'same supplier invoice cannot be received twice (409)');
  const expiredGoods = await api('POST', '/api/purchases', ctx.adminToken, { supplier_id: sup.data.supplier.id, invoice_number: `${invoice}-B`, items: [{ medicine_id: med, batch_number: 'OLD', expiry_date: '2020-01-01', quantity: 1, purchase_price: 1 }] });
  check(expiredGoods.status === 400, 'already-expired goods cannot be received (400)');
  const purCashier = await api('POST', '/api/purchases', ctx.cashierToken, { supplier_id: sup.data.supplier.id, invoice_number: 'Z', items: [] });
  check(purCashier.status === 403, 'Cashier cannot receive purchases (403)');
  persisted.purchaseId = pur.data?.purchase?.id;
  persisted.supplierId = sup.data?.supplier?.id;

  // ------------------------------------------------------------------ EXPENSES
  section('EXPENSES');
  const ex = await api('POST', '/api/expenses', ctx.adminToken, { category: 'Transport', description: 'ITEST delivery', amount: 350.5, payment_method: 'Cash' });
  check(ex.status === 201 && UUID_RE.test(ex.data?.expense?.id) && ex.data?.expense?.amount === 350.5 && ex.data?.expense?.user_id === ctx.admin.id, 'Admin records expense (UUID, actor from token)', ex.data);
  for (const [label, body] of [
    ['zero amount', { category: 'Transport', description: 'x', amount: 0 }],
    ['negative amount', { category: 'Transport', description: 'x', amount: -5 }],
    ['unknown category', { category: 'Party', description: 'x', amount: 5 }],
    ['missing description', { category: 'Transport', amount: 5 }],
  ] as const) {
    const bad = await api('POST', '/api/expenses', ctx.adminToken, body);
    check(bad.status === 400, `expense ${label} rejected (400)`, bad.status);
  }
  const exCashier = await api('POST', '/api/expenses', ctx.cashierToken, { category: 'Transport', description: 'x', amount: 5 });
  check(exCashier.status === 403, 'Cashier cannot record expenses (403)');
  persisted.expenseId = ex.data?.expense?.id;

  // ------------------------------------------------------------------ CUSTOMERS
  section('CUSTOMERS');
  const cu = await api('POST', '/api/customers', ctx.cashierToken, { name: 'ZZ ITEST Customer', phone: '0711000000', total_spent: 999999 });
  check(cu.status === 200 && UUID_RE.test(cu.data?.customer?.id) && cu.data?.customer?.total_spent === 0, 'Cashier creates customer (UUID; spend not settable by client)', cu.data);
  const cuEdit = await api('POST', '/api/customers', ctx.cashierToken, { id: cu.data?.customer?.id, name: 'ZZ ITEST Customer Edited', phone: '0711000001' });
  check(cuEdit.status === 200 && cuEdit.data?.customer?.name === 'ZZ ITEST Customer Edited', 'customer edited');
  const cs = await sale(ctx.cashierToken, med, 1, 1000, { customer_id: cu.data?.customer?.id });
  const spent = await pool.query('SELECT total_spent::float AS t FROM customers WHERE id = $1', [cu.data?.customer?.id]);
  check(cs.status === 201 && cs.data?.sale?.customer_id === cu.data?.customer?.id && spent.rows[0].t === 1000, 'sale linked to customer; total_spent maintained by server');
  const ghostCustomer = await sale(ctx.cashierToken, med, 1, 1000, { customer_id: crypto.randomUUID() });
  check(ghostCustomer.status === 400, 'unknown customer rejected (400)');
  persisted.customerId = cu.data?.customer?.id;

  // ------------------------------------------------------------------ DEVICES / AUDIT
  section('DEVICES & AUDIT');
  const dev = await pool.query('SELECT device_id FROM sales WHERE id = $1', [r.data?.sale?.id]);
  const devRow = await count(`SELECT COUNT(*) n FROM devices WHERE id = 'ITEST-TERMINAL'`);
  check(dev.rows[0]?.device_id === 'ITEST-TERMINAL' && devRow === 1, 'X-Device-Id persisted in devices and referenced by the sale');
  const weird = await api('POST', '/api/sales/checkout', ctx.cashierToken, { idempotency_key: key(), items: [{ medicine_id: med, quantity: 1, unit_price: 1000 }], payment: cash() }, { 'X-Device-Id': "bad id'; DROP TABLE x;--" });
  const weirdDev = await pool.query('SELECT device_id FROM sales WHERE id = $1', [weird.data?.sale?.id]);
  check(weird.status === 201 && weirdDev.rows[0]?.device_id === 'SERVER', 'malformed device id safely mapped to SERVER (FK always valid)');
  const devId = `POS-${crypto.randomUUID()}`;
  const reg = await api('POST', '/api/devices/register', ctx.cashierToken, { device_id: devId, name: 'ITEST device' });
  check(reg.status === 200 && reg.data?.device?.id === devId, 'device registration persists a UUID-based terminal id');
  const regNoAuth = await api('POST', '/api/devices/register', null, { device_id: devId });
  check(regNoAuth.status === 401, 'device registration requires login (401)');
  persisted.deviceId = devId;
  for (const action of ['SALE_COMPLETED', 'SALE_VOIDED', 'RETURN_PROCESSED', 'PURCHASE_GOODS_RECEIVED', 'EXPENSE_RECORDED', 'SUPPLIER_CREATED', 'CUSTOMER_CREATED', 'CREATE_MEDICINE']) {
    const n = await count(`SELECT COUNT(*) n FROM audit_logs WHERE action = $1 AND created_at > now() - interval '15 minutes'`, [action]);
    check(n > 0, `audit row written: ${action}`, n);
  }
  const auditTyped = await pool.query(`SELECT jsonb_typeof(new_value) t FROM audit_logs WHERE action = 'SALE_COMPLETED' ORDER BY created_at DESC LIMIT 1`);
  check(auditTyped.rows[0]?.t === 'object', 'audit values stored as JSON objects (not double-encoded strings)');

  // ------------------------------------------------------------------ RESTART PERSISTENCE
  section('RESTART PERSISTENCE');
  persisted.returnStockAfter = String(await stock(med));
  await stopServer();
  await startServer();
  ctx.adminToken = await login(ctx.admin.email, ctx.admin.password);
  ctx.cashierToken = await login(ctx.cashier.email, ctx.cashier.password);
  ctx.cashier2Token = await login(ctx.cashier2.email, ctx.cashier2.password);
  const salesAfter = await api('GET', '/api/sales?limit=200', ctx.adminToken);
  check(salesAfter.data?.sales?.some((s: any) => s.id === persisted.voidedSale && s.status === 'voided'), 'voided sale persists after restart');
  const retAfter = await api('GET', '/api/returns', ctx.adminToken);
  check(retAfter.data?.some?.((x: any) => x.id === persisted.returnId && x.status === 'APPROVED') && retAfter.data?.some?.((x: any) => x.id === persisted.rejectedReturnId && x.status === 'REJECTED'), 'L: return statuses persist after restart (APPROVED / REJECTED)');
  check(String(await stock(med)) === persisted.returnStockAfter, 'L: stock after returns unchanged by restart');
  const purAfter = await api('GET', '/api/purchases', ctx.adminToken);
  check(purAfter.data?.some?.((x: any) => x.id === persisted.purchaseId), 'purchase persists after restart');
  const expAfter = await api('GET', '/api/expenses', ctx.adminToken);
  check(expAfter.data?.some?.((x: any) => x.id === persisted.expenseId), 'expense persists after restart');
  const supAfter = await api('GET', '/api/suppliers', ctx.adminToken);
  check(supAfter.data?.some?.((x: any) => x.id === persisted.supplierId), 'supplier persists after restart');
  const cusAfter = await api('GET', '/api/customers', ctx.cashierToken);
  check(cusAfter.data?.some?.((x: any) => x.id === persisted.customerId), 'customer persists after restart');
  check((await count('SELECT COUNT(*) n FROM devices WHERE id = $1', [persisted.deviceId])) === 1, 'device persists after restart');
}
