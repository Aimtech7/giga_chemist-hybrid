import crypto from 'crypto';
import { api, check, login, pool, section, startServer, stopServer, upsertFixtureMedicine, UUID_RE } from './harness';
import type { Ctx } from './auth-users.test';

/**
 * Stage 1 — Wholesale price. Uses dedicated ITEST medicines only (never real stock):
 *   ITEST-WS-500   retail 500, wholesale 420
 *   ITEST-NOWS-50  retail 50, no wholesale price
 * Stock is set through the real Admin Physical Stock Count API and returned to 0 afterwards.
 */
const key = () => `itest-${crypto.randomUUID()}`;

async function setStock(ctx: Ctx, medicineId: string, qty: number, expiry = '2029-01-31') {
  const r = await api('POST', '/api/inventory/physical-count', ctx.adminToken, {
    medicine_id: medicineId,
    counts: [{ batch_number: 'ITEST-BATCH-1', quantity: qty, expiry_date: expiry }],
  });
  if (r.status !== 200) throw new Error(`setStock failed: ${r.status} ${JSON.stringify(r.data)}`);
}

async function stockOf(medicineId: string) {
  const r = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [medicineId]);
  return Number(r.rows[0].current_stock);
}

function sell(token: string, body: any) {
  return api('POST', '/api/sales/checkout', token, {
    idempotency_key: key(),
    payment: { method: 'Cash', amount_received: 100000 },
    ...body,
  });
}

export async function wholesaleTests(ctx: Ctx) {
  section('WHOLESALE PRICE (Stage 1)');
  const legacyBefore = await pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE price_mode IS NULL');

  const wsId = await upsertFixtureMedicine('ITEST-WS-500', 'ZZ ITEST Wholesale Medicine', 500, 300);
  const noWsId = await upsertFixtureMedicine('ITEST-NOWS-50', 'ZZ ITEST No-Wholesale Medicine', 50, 20);
  await pool.query('UPDATE medicines SET wholesale_price = NULL WHERE id = $1', [noWsId]);

  // Admin sets the wholesale price through the real pricing API
  const setWs = await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.adminToken, { selling_price: 500, wholesale_price: 420 });
  check(setWs.status === 200 && setWs.data?.medicine?.selling_price === 500 && setWs.data?.medicine?.wholesale_price === 420,
    'Admin sets Retail 500 / Wholesale 420', setWs.data);

  // F. permissions
  const cashierEdit = await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.cashierToken, { wholesale_price: 1 });
  check(cashierEdit.status === 403, 'Cashier cannot change wholesale price (403)', cashierEdit.status);
  const cashierRetail = await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.cashierToken, { selling_price: 1 });
  check(cashierRetail.status === 403, 'Cashier cannot change retail price (403)', cashierRetail.status);
  const cashierPut = await api('PUT', `/api/medicines/${wsId}`, ctx.cashierToken, { wholesale_price: 1 });
  check(cashierPut.status === 403, 'Cashier cannot edit medicine record (403)', cashierPut.status);
  const zeroWs = await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.adminToken, { wholesale_price: 0 });
  check(zeroWs.status === 400, 'wholesale price 0 rejected (400)', zeroWs.status);

  const cashierView = await api('GET', '/api/medicines', ctx.cashierToken);
  const seen = Array.isArray(cashierView.data) ? cashierView.data.find((m: any) => m.id === wsId) : null;
  check(seen?.wholesale_price === 420 && seen?.purchase_price === 0, 'Cashier sees wholesale 420 (cost still hidden)', seen);
  const noWsSeen = Array.isArray(cashierView.data) ? cashierView.data.find((m: any) => m.id === noWsId) : null;
  check(noWsSeen && noWsSeen.wholesale_price === null, 'medicine without wholesale price reports null (not retail)', noWsSeen?.wholesale_price);

  await setStock(ctx, wsId, 20);
  await setStock(ctx, noWsId, 20);

  // A. Retail sale, qty 1 -> 500
  const retail = await sell(ctx.cashierToken, { price_mode: 'RETAIL', items: [{ medicine_id: wsId, quantity: 1, unit_price: 500 }] });
  const rs = retail.data?.sale;
  check(retail.status === 201 && UUID_RE.test(rs?.id), 'A: retail sale committed (UUID id)', retail.data);
  check(rs?.total === 500 && rs?.items?.[0]?.unit_price === 500 && rs?.price_mode === 'RETAIL' && rs?.items?.[0]?.price_mode === 'RETAIL',
    'A: retail stored KES 500, mode RETAIL', rs && { total: rs.total, mode: rs.price_mode, item: rs.items?.[0] });
  check(rs?.cashier_id === ctx.cashier.id, 'A: cashier taken from token');
  check(/^RCP-\d{8}-\d{6}$/.test(rs?.receipt_number || ''), 'A: server-generated receipt number', rs?.receipt_number);
  check((await stockOf(wsId)) === 19, 'A: stock 20 -> 19');

  // B. Wholesale sale, qty 1 -> 420
  const ws1 = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 1, unit_price: 420 }] });
  const w1 = ws1.data?.sale;
  check(ws1.status === 201 && w1?.total === 420 && w1?.items?.[0]?.unit_price === 420 && w1?.price_mode === 'WHOLESALE' && w1?.items?.[0]?.price_mode === 'WHOLESALE',
    'B: wholesale stored KES 420, mode WHOLESALE', w1 && { total: w1.total, mode: w1.price_mode, item: w1.items?.[0] });
  check((await stockOf(wsId)) === 18, 'B: stock 19 -> 18');

  // C. Quantity 5 at wholesale -> 2100
  const ws5 = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 5, unit_price: 420 }] });
  check(ws5.status === 201 && ws5.data?.sale?.total === 2100 && ws5.data?.sale?.subtotal === 2100, 'C: 5 x 420 = KES 2,100', ws5.data?.sale?.total);
  check((await stockOf(wsId)) === 13, 'C: stock 18 -> 13');

  // Persisted values in PostgreSQL
  const db = await pool.query(
    `SELECT s.total::float, s.price_mode, si.unit_price::float, si.price_mode AS item_mode, si.quantity
     FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE s.id = ANY($1::uuid[]) ORDER BY s.created_at`,
    [[rs?.id, w1?.id, ws5.data?.sale?.id]]
  );
  check(
    db.rows.length === 3 &&
      db.rows[0].unit_price === 500 && db.rows[0].price_mode === 'RETAIL' &&
      db.rows[1].unit_price === 420 && db.rows[1].item_mode === 'WHOLESALE' &&
      db.rows[2].total === 2100 && db.rows[2].quantity === 5,
    'PostgreSQL rows hold the price and mode actually used', db.rows
  );

  // Price spoofing: browser cannot choose the price
  const spoofWs = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 1, unit_price: 1 }] });
  check(spoofWs.status === 409 && spoofWs.data?.code === 'PRICE_CHANGED', 'wholesale price spoof rejected (409)', spoofWs.data);
  const spoofRetail = await sell(ctx.cashierToken, { price_mode: 'RETAIL', items: [{ medicine_id: wsId, quantity: 1, unit_price: 420 }] });
  check(spoofRetail.status === 409, 'retail sale at wholesale price rejected (409)', spoofRetail.status);
  const mixed = await sell(ctx.cashierToken, { price_mode: 'RETAIL', items: [{ medicine_id: wsId, quantity: 1, price_mode: 'WHOLESALE' }] });
  check(mixed.status === 400, 'wholesale line inside a RETAIL sale rejected (400)', mixed.status);
  const retailInWs = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 1, price_mode: 'RETAIL', retail_fallback_confirmed: true }] });
  check(retailInWs.status === 400, 'retail line for a medicine that HAS a wholesale price rejected in wholesale sale', retailInWs.status);
  check((await stockOf(wsId)) === 13, 'rejected sales did not touch stock');

  // Missing wholesale price: never silently priced
  const missing = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: noWsId, quantity: 1 }] });
  check(missing.status === 409 && missing.data?.code === 'WHOLESALE_PRICE_MISSING', 'missing wholesale price -> 409 WHOLESALE_PRICE_MISSING', missing.data);
  const unconfirmed = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', items: [{ medicine_id: noWsId, quantity: 1, price_mode: 'RETAIL' }] });
  check(unconfirmed.status === 409, 'retail fallback without confirmation rejected (409)', unconfirmed.status);
  const fallback = await sell(ctx.cashierToken, {
    price_mode: 'WHOLESALE',
    items: [
      { medicine_id: wsId, quantity: 1, unit_price: 420 },
      { medicine_id: noWsId, quantity: 2, price_mode: 'RETAIL', retail_fallback_confirmed: true, unit_price: 50 },
    ],
  });
  const fb = fallback.data?.sale;
  const fbWs = fb?.items?.find((i: any) => i.medicine_id === wsId);
  const fbRt = fb?.items?.find((i: any) => i.medicine_id === noWsId);
  check(fallback.status === 201 && fb?.total === 520 && fbWs?.price_mode === 'WHOLESALE' && fbRt?.price_mode === 'RETAIL' && fbRt?.unit_price === 50,
    'confirmed retail fallback: 420 + 2x50 = 520, each line keeps its own mode', fb && { total: fb.total, items: fb.items });

  // Discount on a wholesale sale uses the wholesale price
  const disc = await sell(ctx.cashierToken, { price_mode: 'WHOLESALE', discount_percent: 10, items: [{ medicine_id: wsId, quantity: 1, unit_price: 420 }] });
  check(disc.status === 201 && disc.data?.sale?.total === 378 && disc.data?.sale?.discount_total === 42, 'wholesale + 10% discount = 378', disc.data?.sale);

  // Idempotent retry never creates a second sale
  const k = key();
  const first = await api('POST', '/api/sales/checkout', ctx.cashierToken, { idempotency_key: k, price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 1, unit_price: 420 }], payment: { method: 'Cash', amount_received: 500 } });
  const again = await api('POST', '/api/sales/checkout', ctx.cashierToken, { idempotency_key: k, price_mode: 'WHOLESALE', items: [{ medicine_id: wsId, quantity: 1, unit_price: 420 }], payment: { method: 'Cash', amount_received: 500 } });
  check(first.status === 201 && again.status === 200 && again.data?.duplicate === true && again.data?.sale?.id === first.data?.sale?.id,
    'retried checkout returns the original sale (no duplicate)');
  const dupCount = await pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE idempotency_key = $1', [k]);
  check(dupCount.rows[0].n === 1, 'exactly one sale row for the idempotency key');

  // History shows the price actually used
  const hist = await api('GET', '/api/sales?limit=50', ctx.cashierToken);
  const histSale = hist.data?.sales?.find((s: any) => s.id === w1?.id);
  check(histSale?.items?.[0]?.unit_price === 420 && histSale?.price_mode === 'WHOLESALE', 'sales history shows 420 / WHOLESALE', histSale && { mode: histSale.price_mode, item: histSale.items?.[0] });

  // Later price change never rewrites history
  await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.adminToken, { selling_price: 650, wholesale_price: 555 });
  const after = await pool.query('SELECT unit_price::float FROM sale_items WHERE sale_id = $1', [w1?.id]);
  check(after.rows[0]?.unit_price === 420, 'changing prices later leaves the historical sale at 420');
  const cleared = await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.adminToken, { wholesale_price: null });
  check(cleared.status === 200 && cleared.data?.medicine?.wholesale_price === null, 'Admin can clear a wholesale price (null)');
  await api('PATCH', `/api/medicines/${wsId}/pricing`, ctx.adminToken, { selling_price: 500, wholesale_price: 420 });
  const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'ADMIN_PRICE_UPDATE' AND entity_id = $1 AND created_at > now() - interval '10 minutes'`, [wsId]);
  check(audit.rows[0].n >= 3, 'every price change is audited', audit.rows[0].n);

  const legacyAfter = await pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE price_mode IS NULL');
  check(legacyAfter.rows[0].n === legacyBefore.rows[0].n, 'historical (legacy) sales untouched', { before: legacyBefore.rows[0].n, after: legacyAfter.rows[0].n });

  // E. Restart persistence
  await stopServer();
  await startServer();
  ctx.adminToken = await login(ctx.admin.email, ctx.admin.password);
  ctx.cashierToken = await login(ctx.cashier.email, ctx.cashier.password);
  ctx.cashier2Token = await login(ctx.cashier2.email, ctx.cashier2.password);
  const restarted = await api('GET', '/api/medicines', ctx.cashierToken);
  const again420 = restarted.data?.find?.((m: any) => m.id === wsId);
  check(again420?.wholesale_price === 420 && again420?.selling_price === 500, 'E: wholesale 420 / retail 500 persist after restart', again420);

  // Leave the fixtures with no stock and inactive so they never appear for sale.
  await setStock(ctx, wsId, 0);
  await setStock(ctx, noWsId, 0);
  await pool.query(`UPDATE medicines SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[wsId, noWsId]]);
}
