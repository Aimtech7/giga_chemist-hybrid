import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { api, check, pool, section, startServer, stopServer, upsertFixtureMedicine, BASE, getServerLog } from './harness';
import type { Ctx } from './auth-users.test';
import type { startFakeSmtp } from './fake-smtp';

type Smtp = Awaited<ReturnType<typeof startFakeSmtp>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `itest-${crypto.randomUUID()}`;
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, step = 300): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(step);
    v = await fn();
  }
  return v;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

export interface OpsEnv {
  smtp: Smtp;
  backupDir: string;
}

export async function opsTests(ctx: Ctx, env: OpsEnv) {
  const { smtp, backupDir } = env;
  const today = (await pool.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS d`)).rows[0].d as string;
  const plusDays = async (n: number) => (await pool.query(`SELECT to_char((now() AT TIME ZONE 'Africa/Nairobi')::date + $1::int, 'YYYY-MM-DD') AS d`, [n])).rows[0].d as string;
  const shopCode = (await pool.query('SELECT shop_code FROM shop_identity WHERE id = 1')).rows[0].shop_code;

  // ------------------------------------------------------------------ FIXTURES
  const medA = await upsertFixtureMedicine('ITEST-OPS-A', 'ZZ ITEST Ops Medicine A', 200, 120);
  const medLow = await upsertFixtureMedicine('ITEST-OPS-LOW', 'ZZ ITEST Ops Low Stock', 50, 30);
  const medOut = await upsertFixtureMedicine('ITEST-OPS-OUT', 'ZZ ITEST Ops Out Of Stock', 50, 30);
  await pool.query('UPDATE medicines SET reorder_level = 10, wholesale_price = NULL WHERE id = ANY($1::uuid[])', [[medA, medLow, medOut]]);
  const count = (medicine_id: string, counts: any[]) => api('POST', '/api/inventory/physical-count', ctx.adminToken, { medicine_id, counts });
  const in20 = await plusDays(20);
  let r = await count(medA, [{ batch_number: 'OPS-A1', quantity: 100, expiry_date: '2030-12-31' }, { batch_number: 'OPS-A2', quantity: 5, expiry_date: in20 }]);
  const r2 = await count(medLow, [{ batch_number: 'OPS-L1', quantity: 3, expiry_date: '2030-12-31' }]);
  check(r.status === 200 && r2.status === 200, 'fixtures: stock A=105 (5 expiring in 20 days), LOW=3 (reorder 10), OUT=0', [r.data?.error, r2.data?.error]);

  const sell = (token: string, qty: number, extra: Record<string, unknown> = {}, unit = 200) =>
    api('POST', '/api/sales/checkout', token, { idempotency_key: key(), items: [{ medicine_id: medA, quantity: qty, unit_price: unit }], payment: { method: 'Cash', amount_received: 100000 }, ...extra });

  // ------------------------------------------------------------------ REPORTS
  section('SERVER-SIDE REPORTS (PostgreSQL, Africa/Nairobi day)');
  const rep = async (token: string, qs = 'range=today') => (await api('GET', `/api/reports/summary?${qs}`, token)).data;
  const R0 = await rep(ctx.adminToken);
  const C0 = await rep(ctx.cashierToken);
  const s1 = await sell(ctx.cashierToken, 2);
  const s2 = await sell(ctx.cashierToken, 1, { payment: { method: 'M-Pesa', reference: 'OPSMPESA1' } });
  const s3 = await sell(ctx.cashier2Token, 1, { discount_percent: 10 });
  const s4 = await sell(ctx.adminToken, 1);
  const v4 = await api('POST', `/api/sales/${s4.data?.sale?.id}/void`, ctx.adminToken, { void_reason: 'ITEST ops void' });
  await pool.query('UPDATE medicines SET wholesale_price = 150 WHERE id = $1', [medA]);
  const s5 = await sell(ctx.cashierToken, 2, { price_mode: 'WHOLESALE' }, 150);
  const it1 = s1.data?.sale?.items?.[0];
  const rq = await api('POST', '/api/returns', ctx.cashierToken, { sale_id: s1.data?.sale?.id, medicine_id: it1?.medicine_id, batch_id: it1?.batch_id, quantity: 1, reason: 'ITEST ops return' });
  const ap = await api('POST', `/api/returns/${rq.data?.return?.id}/approve`, ctx.adminToken, { restock: true });
  const ex = await api('POST', '/api/expenses', ctx.adminToken, { category: 'Transport', description: 'ITEST ops expense', amount: 75, payment_method: 'Cash' });
  const sup = await api('POST', '/api/suppliers', ctx.adminToken, { name: 'ZZ ITEST Ops Supplier', phone: '0700000077' });
  const pu = await api('POST', '/api/purchases', ctx.adminToken, { supplier_id: sup.data?.supplier?.id, invoice_number: `ITEST-OPS-${Date.now()}`, items: [{ medicine_id: medA, batch_number: 'OPS-A3', expiry_date: '2031-06-30', quantity: 10, purchase_price: 100 }] });
  check([s1, s2, s3, s4, s5].every((x) => x.status === 201) && v4.status === 200 && ap.status === 200 && ex.status === 201 && pu.status === 201,
    'controlled activity: 5 sales (cash, M-Pesa, 10% discount, voided, wholesale), 1 approved return, 1 expense, 1 purchase',
    [s1, s2, s3, s4, s5, v4, ap, ex, pu].map((x) => x.status));
  const R1 = await rep(ctx.adminToken);
  const d = (k: string) => Math.round((Number(R1[k]) - Number(R0[k])) * 100) / 100;
  check(near(d('grossSales'), 1080), 'Gross Sales +1080 (400+200+180+300; voided excluded)', d('grossSales'));
  check(near(d('discounts'), 20), 'Discounts +20', d('discounts'));
  check(near(d('refunds'), 200), 'Approved refunds +200', d('refunds'));
  check(near(d('netSales'), 880), 'Net Sales +880', d('netSales'));
  check(near(d('cash'), 680), 'Cash +680 (cash taken 880 minus cash refund 200)', d('cash'));
  check(near(d('mpesa'), 200), 'M-Pesa +200', d('mpesa'));
  check(R1.voids.count - R0.voids.count === 1 && near(R1.voids.total - R0.voids.total, 200), 'Voids +1 (200)', R1.voids);
  check(R1.transactionCount - R0.transactionCount === 4, 'Transactions +4', R1.transactionCount - R0.transactionCount);
  check(R1.unitsSold - R0.unitsSold === 6 && R1.unitsReturned - R0.unitsReturned === 1, 'Units sold +6, returned +1');
  check(near(d('operatingExpenses'), 75), 'Expenses +75', d('operatingExpenses'));
  check(R1.purchases.count - R0.purchases.count === 1 && near(R1.purchases.total - R0.purchases.total, 1000), 'Purchases +1 (1000)', R1.purchases);
  const expectedCogs = 2 * 120 + 120 + 120 + 2 * 120 - 120;
  check(near(d('netCogs'), expectedCogs) && near(d('grossProfit'), 880 - expectedCogs), `gross margin from cost snapshots (COGS +${expectedCogs})`, { cogs: d('netCogs'), gp: d('grossProfit') });
  const stockSql = (await pool.query(`SELECT COUNT(*) FILTER (WHERE current_stock > 0 AND current_stock <= COALESCE(reorder_level,0))::int low,
    COUNT(*) FILTER (WHERE current_stock <= 0)::int out FROM medicines WHERE COALESCE(status,'active') = 'active'`)).rows[0];
  check(R1.stock.lowStock === stockSql.low && R1.stock.outOfStock === stockSql.out, 'low-stock / out-of-stock counts match PostgreSQL', [R1.stock, stockSql]);
  const ts = (await api('GET', '/api/sales/today-summary', ctx.adminToken)).data;
  check(near(R1.grossSales, ts.totalSales) && R1.transactionCount === ts.transactionCount, 'report agrees with the existing daily summary endpoint');
  const sqlGross = Number((await pool.query(`SELECT COALESCE(SUM(total),0) g FROM sales WHERE status <> 'voided' AND date = $1::date`, [today])).rows[0].g);
  check(near(R1.grossSales, sqlGross), 'today gross equals a direct SQL sum over all sales (not a cached subset)');
  const W = await rep(ctx.adminToken, 'range=week');
  const M = await rep(ctx.adminToken, 'range=month');
  const Cu = await rep(ctx.adminToken, `range=custom&start=${today}&end=${today}`);
  check(W.grossSales >= R1.grossSales && M.grossSales >= W.grossSales - 0.001 && near(Cu.grossSales, R1.grossSales), 'week ⊇ today, month ⊇ week, custom(today) = today', [W.start, M.start]);
  const bad1 = await api('GET', '/api/reports/summary?range=custom&start=2026-13-01&end=2026-01-01', ctx.adminToken);
  const bad2 = await api('GET', '/api/reports/summary?range=yesterday', ctx.adminToken);
  check(bad1.status === 400 && bad2.status === 400, 'invalid ranges rejected (400)');
  const C1 = await rep(ctx.cashierToken);
  check(C1.scope === 'cashier' && near(C1.grossSales - C0.grossSales, 900) && near(C1.refunds - C0.refunds, 200), 'Cashier report: only own sales (900) and refunds on own sales', { g: C1.grossSales - C0.grossSales });
  check(C1.netCogs === 0 && C1.grossProfit === 0 && C1.operatingExpenses === 0 && C1.purchases.count === 0 && C1.expenses.length === 0, 'Cashier report hides cost, profit, expenses and purchases');
  const spoof = await rep(ctx.cashierToken, `range=today&cashierId=${ctx.cashier2.id}`);
  check(spoof.scope === 'cashier' && near(spoof.grossSales, C1.grossSales), 'Cashier cannot read another cashier via cashierId');
  check((await api('GET', '/api/reports/summary')).status === 401, 'unauthenticated report -> 401');

  // ------------------------------------------------------------------ SALES HISTORY
  section('SALES HISTORY (server pagination & filters)');
  const sh = async (token: string, qs: string) => (await api('GET', `/api/sales?${qs}`, token)).data;
  const sqlCount = Number((await pool.query(`SELECT COUNT(*) n FROM sales WHERE date = $1::date`, [today])).rows[0].n);
  const p1 = await sh(ctx.adminToken, `page=1&limit=3&startDate=${today}&endDate=${today}`);
  const p2 = await sh(ctx.adminToken, `page=2&limit=3&startDate=${today}&endDate=${today}`);
  check(p1.total === sqlCount && p1.sales.length === Math.min(3, sqlCount) && p1.totalPages === Math.ceil(sqlCount / 3), `pagination total = SQL count (${sqlCount})`, p1.total);
  check(!p2.sales.some((x: any) => p1.sales.some((y: any) => y.id === x.id)), 'page 2 does not repeat page 1');
  const byReceipt = await sh(ctx.adminToken, `page=1&limit=10&search=${encodeURIComponent(s2.data.sale.receipt_number)}`);
  check(byReceipt.sales.length >= 1 && byReceipt.sales[0].id === s2.data.sale.id, 'search by receipt number');
  const byMpesa = await sh(ctx.adminToken, `page=1&limit=100&startDate=${today}&paymentMethod=M-Pesa`);
  check(byMpesa.sales.some((x: any) => x.id === s2.data.sale.id) && byMpesa.sales.every((x: any) => x.payment_method === 'M-Pesa' || x.payment_method === 'Mixed'), 'filter by payment method (M-Pesa)');
  const byWs = await sh(ctx.adminToken, `page=1&limit=100&startDate=${today}&priceMode=WHOLESALE`);
  check(byWs.sales.some((x: any) => x.id === s5.data.sale.id) && byWs.sales.every((x: any) => x.price_mode === 'WHOLESALE'), 'filter Retail/Wholesale (WHOLESALE)');
  const byVoid = await sh(ctx.adminToken, `page=1&limit=100&startDate=${today}&status=voided`);
  check(byVoid.sales.some((x: any) => x.id === s4.data.sale.id) && byVoid.sales.every((x: any) => x.status === 'voided'), 'filter by void status');
  const byCashier = await sh(ctx.adminToken, `page=1&limit=100&startDate=${today}&cashierId=${ctx.cashier2.id}`);
  check(byCashier.sales.length >= 1 && byCashier.sales.every((x: any) => x.cashier_id === ctx.cashier2.id), 'Admin filter by cashier');
  const own = await sh(ctx.cashierToken, `page=1&limit=100&startDate=${today}&cashierId=${ctx.cashier2.id}`);
  check(own.sales.every((x: any) => x.cashier_id === ctx.cashier.id), 'Cashier always receives only own sales');
  check(own.sales.every((x: any) => x.cost_total === 0 && x.gross_profit === 0), 'Cashier sales history hides cost/profit');
  const badPm = await api('GET', '/api/sales?page=1&paymentMethod=Bitcoin', ctx.adminToken);
  check(badPm.status === 400, 'invalid filter value rejected (400)');
  await api('PATCH', `/api/medicines/${medA}/pricing`, ctx.adminToken, { selling_price: 260 });
  const hist = await sh(ctx.adminToken, `page=1&limit=5&search=${encodeURIComponent(s1.data.sale.receipt_number)}`);
  check(hist.sales[0]?.items?.[0]?.unit_price === 200, 'historical sale price immutable after a price change (200, current 260)', hist.sales[0]?.items?.[0]?.unit_price);
  await api('PATCH', `/api/medicines/${medA}/pricing`, ctx.adminToken, { selling_price: 200 });

  // ------------------------------------------------------------------ EMAIL
  section('EMAIL REPORTS (queue, SMTP, idempotency)');
  const job = async (k: string) => (await pool.query('SELECT * FROM email_jobs WHERE idempotency_key = $1', [k])).rows;
  const jobById = async (id: string) => (await pool.query('SELECT * FROM email_jobs WHERE id = $1', [id])).rows[0];
  const sentWith = (id: string) => smtp.messages.filter((m) => m.raw.includes(`<${id}@giga-chemist.pos>`)).length;
  for (const [m, p, label] of [
    ['GET', '/api/email/settings', 'read settings'], ['PUT', '/api/email/settings', 'change settings'], ['POST', '/api/email/test', 'send test'],
    ['POST', '/api/email/reports/DAILY_STOCK/run', 'run report'], ['GET', '/api/email/jobs', 'list jobs'], ['POST', '/api/email/retry-failed', 'retry'],
  ] as const) {
    const c = await api(m, p, ctx.cashierToken, m === 'GET' ? undefined : {});
    check(c.status === 403, `Cashier cannot ${label} (403)`, c.status);
  }
  check((await api('GET', '/api/email/settings')).status === 401, 'unauthenticated email settings -> 401');
  const es = await api('GET', '/api/email/settings', ctx.adminToken);
  check(es.status === 200 && es.data.status.config.smtp_host === '127.0.0.1' && es.data.status.state === 'READY', 'Admin reads email settings; state READY', es.data?.status?.state);
  check(!JSON.stringify(es.data).includes(process.env.ITEST_SMTP_PASSWORD || '@@none@@') && !('password' in es.data.status.config), 'SMTP password never returned');
  const badT = await api('PUT', '/api/email/settings', ctx.adminToken, { stock_report_time: '25:99' });
  const badE = await api('PUT', '/api/email/settings', ctx.adminToken, { recipients: 'not-an-email' });
  check(badT.status === 400 && badE.status === 400, 'invalid time / recipient rejected (400)');

  // Scheduler: only the daily stock report enabled, time already passed -> queued once, sent once.
  const sKey = `${shopCode}:DAILY_STOCK:${today}`;
  const set = await api('PUT', '/api/email/settings', ctx.adminToken, {
    daily_stock_enabled: true, stock_report_time: '00:00', business_summary_enabled: false, expiry_report_enabled: false, low_stock_digest_enabled: false,
    include_low_stock: true, include_expiry: true,
  });
  check(set.status === 200, 'Admin enables the daily stock report at 00:00 (already due)', set.data?.error);
  const sched = await waitFor(() => job(sKey), (j) => j[0]?.status === 'SENT', 45_000);
  check(sched.length === 1 && sched[0].status === 'SENT' && sched[0].created_by === 'SCHEDULER', 'server scheduler queued and SENT the daily stock report', sched[0] && { s: sched[0].status, by: sched[0].created_by, err: sched[0].last_error });
  const stockJob = sched[0];
  check(sentWith(stockJob.id) === 1, 'fake SMTP received it exactly once');
  const msg = smtp.messages.find((m) => m.raw.includes(`<${stockJob.id}@giga-chemist.pos>`));
  check(Boolean(msg?.raw.includes(`giga-chemist-stock-report-${today}.csv`)), 'CSV attachment giga-chemist-stock-report-YYYY-MM-DD.csv present in the e-mail');
  const csv: string = stockJob.attachments?.[0]?.content || '';
  check(/LOW_STOCK,ZZ ITEST Ops Low Stock,,3,10/.test(csv), 'CSV: low-stock row correct (stock 3, reorder 10)');
  check(/OUT_OF_STOCK,ZZ ITEST Ops Out Of Stock,,0,10/.test(csv), 'CSV: out-of-stock row correct');
  const a2 = Number((await pool.query(`SELECT quantity_available q FROM medicine_batches WHERE medicine_id = $1 AND batch_number = 'OPS-A2'`, [medA])).rows[0].q);
  check(a2 > 0 && new RegExp(`EXPIRING_30,ZZ ITEST Ops Medicine A,OPS-A2,,,${in20},20,${a2}`).test(csv), `CSV: expiry row correct (batch OPS-A2, 20 days, qty ${a2} from PostgreSQL)`);
  check(!/ZZ ITEST Ops Medicine A,OPS-A1/.test(csv), 'CSV: batch expiring 2030 not listed as expiring');
  const html: string = stockJob.html_body;
  const expSql = (await pool.query(`SELECT COUNT(*) FILTER (WHERE expiry_date <= $1::date)::int ex, COUNT(*) FILTER (WHERE expiry_date > $1::date AND expiry_date <= $1::date + 30)::int e30
      FROM medicine_batches WHERE quantity_available > 0 AND expiry_date IS NOT NULL AND COALESCE(status,'active') <> 'recalled'`, [today])).rows[0];
  check(html.includes('DAILY STOCK REPORT') && html.includes(`>${expSql.e30}<`) && html.includes('Units sold') && html.includes('Low stock ('),
    `HTML has summary, expiry (≤30 days: ${expSql.e30}), activity and lists`);
  const again = await api('POST', '/api/email/reports/DAILY_STOCK/run', ctx.adminToken, {});
  check(again.status === 200 && again.data.job.created === false && (await job(sKey)).length === 1, 'manual re-run of today\'s stock report does not duplicate it');

  const bRun = await api('POST', '/api/email/reports/DAILY_BUSINESS/run', ctx.adminToken, {});
  const bJob = await waitFor(() => jobById(bRun.data?.job?.id), (j) => j?.status === 'SENT');
  check(bRun.status === 202 && bJob?.status === 'SENT', 'daily business summary generated and SENT', bJob?.last_error);
  const fmtK = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const R2 = await rep(ctx.adminToken);
  check(bJob.html_body.includes(fmtK(R2.grossSales)) && bJob.html_body.includes('Cashier totals') && bJob.html_body.includes(fmtK(R2.mpesa)), 'business summary shows gross sales, M-Pesa and cashier totals from the report');

  const t = await api('POST', '/api/email/test', ctx.adminToken, {});
  const tJob = await waitFor(() => jobById(t.data?.job?.id), (j) => j?.status === 'SENT');
  check(t.status === 202 && tJob?.status === 'SENT' && sentWith(tJob.id) === 1, 'Send Test Email delivered');

  // SMTP unavailable -> RETRYING; POS unaffected; restored -> SENT once.
  await smtp.stop();
  const eRun = await api('POST', '/api/email/reports/WEEKLY_EXPIRY/run', ctx.adminToken, {});
  const eJob0 = await waitFor(() => jobById(eRun.data?.job?.id), (j) => j?.status === 'RETRYING' && j.attempt_count >= 1);
  check(eJob0?.status === 'RETRYING' && /ECONNREFUSED|connect/i.test(eJob0.last_error || ''), 'SMTP down: job RETRYING with error recorded', eJob0 && { s: eJob0.status, e: eJob0.last_error });
  const offSale = await sell(ctx.cashierToken, 1);
  check(offSale.status === 201, 'POS sale unaffected while SMTP is down');
  const hDown = (await api('GET', '/api/email/settings', ctx.adminToken)).data.status.state;
  check(hDown === 'OFFLINE', 'email state OFFLINE while SMTP is unreachable', hDown);
  // Server restart while the e-mail is pending.
  await stopServer();
  check((await jobById(eJob0.id)).status === 'RETRYING', 'pending e-mail persisted across server stop');
  await smtp.restart();
  await startServer();
  const eJob1 = await waitFor(() => jobById(eJob0.id), (j) => j?.status === 'SENT', 30_000);
  check(eJob1?.status === 'SENT' && sentWith(eJob0.id) === 1, 'after restart + SMTP back: sent automatically, exactly once', eJob1 && { s: eJob1.status, n: sentWith(eJob0.id), a: eJob1.attempt_count });
  check((await job(`${shopCode}:DAILY_STOCK:${today}`)).length === 1, 'restart did not create a second daily stock report');
  check(sentWith(stockJob.id) === 1, 'restart did not re-send the daily stock report');

  // Permanent refusal -> FAILED; Admin re-queue -> SENT.
  smtp.setMode('reject');
  const lRun = await api('POST', '/api/email/reports/LOW_STOCK_DIGEST/run', ctx.adminToken, {});
  const lJob0 = await waitFor(() => jobById(lRun.data?.job?.id), (j) => j?.status === 'FAILED');
  check(lJob0?.status === 'FAILED' && /550/.test(lJob0.last_error || ''), 'SMTP 550 refusal -> FAILED (not retried forever)', lJob0?.last_error);
  smtp.setMode('tempfail');
  const tf = await api('POST', '/api/email/test', ctx.adminToken, {});
  const tfJob = await waitFor(() => jobById(tf.data?.job?.id), (j) => j?.status === 'RETRYING');
  check(tfJob?.status === 'RETRYING' && /451/.test(tfJob.last_error || ''), 'SMTP 451 temporary failure -> RETRYING', tfJob?.last_error);
  smtp.setMode('accept');
  const rq2 = await api('POST', '/api/email/retry-failed', ctx.adminToken, {});
  const lJob1 = await waitFor(() => jobById(lJob0.id), (j) => j?.status === 'SENT', 30_000);
  const tfJob1 = await waitFor(() => jobById(tfJob.id), (j) => j?.status === 'SENT', 30_000);
  check(rq2.data?.requeued >= 1 && lJob1?.status === 'SENT' && tfJob1?.status === 'SENT', 'Admin retry-failed and automatic retry both deliver');
  const dupMsgs = new Set(smtp.messages.map((m) => /Message-ID: <([^>]+)>/i.exec(m.raw)?.[1])).size === smtp.messages.length;
  check(dupMsgs, `no e-mail was delivered twice (${smtp.messages.length} messages, all distinct)`);

  // ------------------------------------------------------------------ BACKUP
  section('BACKUPS');
  check((await api('POST', '/api/backups/run', ctx.cashierToken, {})).status === 403, 'Cashier cannot run backups (403)');
  check((await api('POST', '/api/backups/restore', ctx.adminToken, {})).status === 404, 'there is no restore endpoint (404)');
  const b1 = await api('POST', '/api/backups/run', ctx.adminToken, {});
  check(b1.status === 200 && /^giga_chemist_dev_\d{4}-\d{2}-\d{2}_\d{6}\.dump$/.test(b1.data?.file || '') && b1.data.size_bytes > 1_000_000, 'manual backup: timestamped, verified file', b1.data);
  const files1 = fs.readdirSync(backupDir).filter((f) => f.endsWith('.dump'));
  check(files1.length === 1 && fs.statSync(path.join(backupDir, files1[0])).size === b1.data.size_bytes, 'backup file exists in BACKUP_DIR with the reported size');
  await sleep(1100);
  const b2 = await api('POST', '/api/backups/run', ctx.adminToken, {});
  await sleep(1100);
  const b3 = await api('POST', '/api/backups/run', ctx.adminToken, {});
  const files3 = fs.readdirSync(backupDir).filter((f) => f.endsWith('.dump')).sort();
  check(b2.status === 200 && b3.status === 200 && files3.length === 2 && !files3.includes(files1[0]), 'retention keeps the newest BACKUP_KEEP=2 generations', files3);
  const st = (await api('GET', '/api/backups/status', ctx.adminToken)).data;
  check(st.last_success_at && st.last_success_file === b3.data.file && st.age_hours !== null && st.location === backupDir, 'backup status: last success, age, location', st);
  const cliDir = path.join(backupDir, 'cli');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup/backup-db.ts', '--dir', cliDir, '--keep', '1'], { encoding: 'utf-8', env: { ...process.env, APP_MODE: 'local' } });
  check(cli.status === 0 && /BACKUP OK/.test(cli.stdout) && fs.readdirSync(cliDir).filter((f) => f.endsWith('.dump')).length === 1, 'CLI backup (npm run backup) succeeds', cli.stderr.slice(0, 300));
  const bad = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup/backup-db.ts', '--dir', cliDir], { encoding: 'utf-8', env: { ...process.env, PG_BIN_DIR: 'C:\\no-such-postgres\\bin' } });
  const lastRun = (await pool.query(`SELECT status, error FROM backup_runs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  check(bad.status === 1 && lastRun.status === 'FAILED' && lastRun.error, 'failed backup returns exit 1 and is logged as FAILED', lastRun);
  check(fs.readFileSync(path.resolve('logs', 'backup.log'), 'utf-8').includes('FAILED CLI'), 'backup log records failures');
  const dumpText = fs.readFileSync(path.join(backupDir, files3[1])).subarray(0, 4096).toString('latin1');
  check(!dumpText.includes(process.env.DB_PASSWORD || '@@none@@'), 'database password not embedded in the backup header');

  // ------------------------------------------------------------------ HEALTH
  section('SYSTEM HEALTH');
  check((await api('GET', '/api/admin/health', ctx.cashierToken)).status === 403, 'Cashier cannot read system health (403)');
  const h = (await api('GET', '/api/admin/health', ctx.adminToken)).data;
  check(h.local_api === 'ONLINE' && h.local_database === 'ONLINE' && ['ONLINE', 'OFFLINE'].includes(h.internet), 'API/PostgreSQL ONLINE, internet checked by the server', { db: h.local_database, net: h.internet, d: h.internet_detail });
  check(h.sync.state === 'LOCAL' && h.cloud === 'NOT_USED', 'sync state reported (LOCAL mode for this test server)', h.sync);
  check(['READY', 'OFFLINE', 'ERROR'].includes(h.email.state) && h.email.last_sent_at, 'email state + last successful email', h.email);
  check(h.backup.last_success_at && h.backup.location === backupDir, 'last successful backup shown');
  check(h.disk.free_bytes > 0 && h.disk.total_bytes >= h.disk.free_bytes, 'disk space reported', h.disk);
  check(h.app_version === JSON.parse(fs.readFileSync('package.json', 'utf-8')).version && /^[0-9a-f-]{36}$/.test(h.shop_id) && h.device_id, 'version, shop id, device id', [h.app_version, h.shop_id, h.device_id]);
  const hs = JSON.stringify(h);
  const secrets = [process.env.JWT_SECRET, process.env.DB_PASSWORD, process.env.ITEST_SMTP_PASSWORD].filter((x): x is string => Boolean(x && x.length >= 4));
  check(secrets.every((s) => !hs.includes(s)), 'health contains no secrets');

  // ------------------------------------------------------------------ SECURITY
  section('SECURITY / RBAC (backend enforced)');
  const retId = (await pool.query(`SELECT id FROM returns WHERE status = 'PENDING' LIMIT 1`)).rows[0]?.id || crypto.randomUUID();
  const denied: [string, string, any][] = [
    ['POST', `/api/returns/${retId}/approve`, { restock: true }],
    ['POST', '/api/inventory/set-stock', { medicine_id: medA, new_stock: 1 }],
    ['POST', '/api/inventory/physical-count', { medicine_id: medA, counts: [{ batch_number: 'X', quantity: 1 }] }],
    ['PATCH', `/api/medicines/${medA}/pricing`, { selling_price: 1 }],
    ['POST', '/api/users', { name: 'x', email: 'x@x.x', role: 'ADMIN', password: 'x' }],
    ['PUT', '/api/settings', { pharmacy_name: 'x' }],
    ['PUT', '/api/email/settings', { daily_stock_enabled: false }],
    ['POST', '/api/backups/run', {}],
    ['POST', '/api/sync/now', {}],
    ['POST', '/api/sync/retry-failed', {}],
    ['GET', '/api/admin/health', undefined],
  ];
  for (const [m, p, b] of denied) {
    const c = await api(m, p, ctx.cashierToken, b);
    check(c.status === 403, `Cashier ${m} ${p.replace(/[0-9a-f-]{36}/, ':id')} -> 403`, c.status);
  }
  const ok = await sell(ctx.cashierToken, 1);
  check(ok.status === 201, 'Cashier can still sell');
  const allowed = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://allowed.example' } });
  const evil = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example' } });
  check(allowed.headers.get('access-control-allow-origin') === 'https://allowed.example' && evil.headers.get('access-control-allow-origin') === null,
    'CORS: only ALLOWED_ORIGINS receive Access-Control-Allow-Origin');
  check(allowed.headers.get('x-content-type-options') === 'nosniff' && allowed.headers.get('x-powered-by') === null, 'security headers (nosniff, no x-powered-by)');
  check(!getServerLog().includes(process.env.ITEST_SMTP_PASSWORD || '@@none@@'), 'server log never contains the SMTP password');

  // ------------------------------------------------------------------ DEV RESET / MIGRATION SAFETY
  section('DEV RESET PROTECTION & MIGRATION SAFETY');
  const stockBefore = (await pool.query('SELECT COALESCE(SUM(quantity_available),0)::bigint s FROM medicine_batches')).rows[0].s;
  const reset = (extra: Record<string, string>, flag = true) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dev-reset-stock-and-expiry.ts', ...(flag ? ['--i-understand-this-zeroes-all-dev-stock'] : [])],
      { encoding: 'utf-8', env: { ...process.env, ...extra } });
  const prodUrl = `postgresql://u:p@127.0.0.1:5432/giga_chemist`;
  const g1 = reset({ ALLOW_DEV_STOCK_RESET: '' });
  const g2 = reset({ ALLOW_DEV_STOCK_RESET: 'true' }, false);
  const g3 = reset({ ALLOW_DEV_STOCK_RESET: 'true', LOCAL_DATABASE_URL: prodUrl, DATABASE_URL: prodUrl, DB_NAME: '' });
  const g4 = reset({ ALLOW_DEV_STOCK_RESET: 'true', DB_NAME: 'giga_chemist' });
  check(g1.status === 2 && /REFUSED/.test(g1.stderr), 'reset refused without ALLOW_DEV_STOCK_RESET');
  check(g2.status === 2 && /REFUSED/.test(g2.stderr), 'reset refused without the confirmation flag');
  check(g3.status === 2 && /PRODUCTION pharmacy database "giga_chemist"/.test(g3.stderr), 'reset refused for giga_chemist via the connection URL (before connecting)', g3.stderr.slice(0, 200));
  check(g4.status === 2 && /REFUSED/.test(g4.stderr), 'reset refused for DB_NAME=giga_chemist');
  check((await pool.query('SELECT COALESCE(SUM(quantity_available),0)::bigint s FROM medicine_batches')).rows[0].s === stockBefore, 'stock untouched by refused resets');
  const rh = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/target/rehearse-migration.ts', '--rehearsal-db', 'giga_chemist'], { encoding: 'utf-8' });
  check(rh.status === 2 && /REFUSED/.test(rh.stderr), 'rehearsal refuses to use giga_chemist as the scratch database');
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'deployment\\windows\\upgrade-target.ps1', '-ProjectRoot', process.cwd(), '-ValidateOnly'], { encoding: 'utf-8' });
    check(ps.status === 1 && /Configured database is 'giga_chemist'/.test(ps.stdout) && /FAIL/.test(ps.stdout), 'upgrade-target.ps1 refuses a non-giga_chemist database (dev PC)', ps.stdout.slice(-300));
  }
}
