import crypto from 'crypto';
import { api, check, login, loginNoShift, pool, section, upsertFixtureMedicine, type Fixture } from './harness';
import type { HybridEnv } from './hybrid.test';

/**
 * ALERTS CENTER suite (run from test:stocktake; hybrid shop server + cloud emulator).
 * Local alerts: RBAC, no duplicates on refresh, acknowledge, auto-resolve, re-open as a NEW row,
 * failed-login security alert (audited without secrets), shift left open; the same shop conditions
 * reach the cloud with the heartbeat.
 */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await fn();
  }
  return v;
}

export async function alertsTests(env: HybridEnv, admin: Fixture, manager: Fixture, cashier: Fixture) {
  section('ALERTS CENTER (local, offline-capable)');
  const A = await login(admin.email, admin.password), M = await login(manager.email, manager.password), C = await login(cashier.email, cashier.password);
  const get = async (tok: string, q = 'refresh=true') => api('GET', `/api/alerts?${q}`, tok);
  check((await get(C)).status === 403, 'AL1: a CASHIER cannot open the Alerts Center (403)');
  const m0 = await get(M);
  check(m0.status === 200 && Array.isArray(m0.data.alerts), 'AL1: MANAGER can view alerts');

  // A data-integrity condition: the medicine total no longer matches its batches (negative stock is refused by a
  // database constraint).
  const med = await upsertFixtureMedicine(`ITEST-AL-${RUN}`, `ZZ ITEST Alerts ${RUN}`, 10, 5);
  await api('POST', '/api/inventory/physical-count', A, { medicine_id: med, counts: [{ batch_number: `AL-${RUN}`, quantity: 3, expiry_date: '2031-01-31' }] });
  await pool.query('UPDATE medicines SET current_stock = 999 WHERE id = $1', [med]);
  let r = await get(A);
  const integ = () => r.data.alerts.filter((a: any) => a.alert_key === 'DATA_INTEGRITY_WARNING');
  check(integ().length === 1 && integ()[0].severity === 'WARNING' && integ()[0].alert_type === 'DATA_INTEGRITY_WARNING' && integ()[0].status === 'OPEN',
    'AL2: medicine total != batches raises one DATA_INTEGRITY_WARNING (OPEN)', integ());
  r = await get(A);
  check(integ().length === 1, 'AL3: refreshing again never duplicates it (one open row per condition)');
  const alertId = integ()[0].id;
  check((await api('POST', `/api/alerts/${alertId}/ack`, M, {})).status === 403, 'AL4: a MANAGER cannot acknowledge (alerts.manage = Administrator)');
  const ak = await api('POST', `/api/alerts/${alertId}/ack`, A, {});
  r = await get(A);
  check(ak.status === 200 && integ()[0]?.status === 'ACKNOWLEDGED' && integ()[0]?.acknowledged_by_name === 'ITest Stocktake Admin', 'AL4: ADMIN acknowledges; refresh keeps it ACKNOWLEDGED', integ());
  check((await api('POST', `/api/alerts/${alertId}/ack`, A, {})).status === 409, 'AL4: acknowledging twice -> 409');
  await pool.query('UPDATE medicines SET current_stock = 3 WHERE id = $1', [med]);
  r = await get(A);
  const all = await get(A, 'status=ALL&refresh=true');
  const rowsForKey = all.data.alerts.filter((a: any) => a.alert_key === 'DATA_INTEGRITY_WARNING');
  check(integ().length === 0 && rowsForKey.some((a: any) => a.id === alertId && a.status === 'RESOLVED' && a.resolved_at), 'AL5: condition fixed -> alert RESOLVED automatically');
  await pool.query('UPDATE medicines SET current_stock = 998 WHERE id = $1', [med]);
  r = await get(A);
  check(integ().length === 1 && integ()[0].id !== alertId && integ()[0].status === 'OPEN', 'AL5: the condition coming back opens a NEW alert (history kept)');
  await pool.query('UPDATE medicines SET current_stock = 3 WHERE id = $1', [med]);

  // The same conditions reach the cloud with the heartbeat (15 s in tests).
  await pool.query('UPDATE medicines SET current_stock = 999 WHERE id = $1', [med]);
  const cloud = await waitFor(() => env.emu.pool.query(`SELECT status FROM giga_cloud.alerts WHERE shop_id = $1 AND alert_key = 'DATA_INTEGRITY_WARNING' AND status <> 'RESOLVED'`, [env.shopId]),
    (x) => x.rows.length === 1, 60_000);
  check(cloud.rows.length === 1, 'AL6: the shop condition reaches the cloud alert list through the heartbeat (one row)');
  await pool.query('UPDATE medicines SET current_stock = 3 WHERE id = $1', [med]);

  section('ALERTS — LOGIN SECURITY + SHIFT LEFT OPEN');
  const bad = `Wrong-${crypto.randomBytes(6).toString('hex')}`;
  for (let i = 0; i < 10; i++) await api('POST', '/api/auth/login', null, { email: cashier.email, password: bad });
  r = await get(A);
  const sec = r.data.alerts.find((a: any) => a.alert_key === 'LOGIN_SECURITY_WARNING');
  check(Boolean(sec) && /failed logins/.test(sec.title), 'AL7: 10 failed logins in an hour -> LOGIN_SECURITY_WARNING', sec);
  const audit = (await pool.query(`SELECT new_value::text AS v FROM audit_logs WHERE action = 'LOGIN_FAILED' AND created_at > now() - interval '5 minutes'`)).rows;
  check(audit.length >= 10 && audit.every((a: any) => !a.v.includes(bad)), 'AL8: failed logins are audited (identifier only, never the password)', audit.length);
  const yesterdayShift = crypto.randomUUID();
  await pool.query(`UPDATE cashier_shifts SET status = 'CLOSED', closed_at = now(), closed_business_date = CURRENT_DATE, actual_cash = 0, expected_cash = 0, cash_variance = 0,
                      close_method = 'ADMIN', admin_close_reason = 'itest' WHERE cashier_id = $1 AND status = 'OPEN'`, [manager.id]);
  await pool.query(`INSERT INTO cashier_shifts (id, shift_number, cashier_id, status, opened_at, opened_business_date, opening_float)
                    VALUES ($1, $2, $3, 'OPEN', now() - interval '1 day', (now() AT TIME ZONE 'Africa/Nairobi')::date - 1, 0)`, [yesterdayShift, `ITEST-AL-${RUN}`, manager.id]);
  r = await get(A);
  const left = r.data.alerts.find((a: any) => a.alert_key === `SHIFT_LEFT_OPEN:${yesterdayShift}`);
  check(left?.alert_type === 'SHIFT_LEFT_OPEN' && left.related_entity === 'shift', 'AL9: a shift still open from yesterday -> SHIFT_LEFT_OPEN alert', left);
  await pool.query(`UPDATE cashier_shifts SET status = 'CLOSED', closed_at = now(), closed_business_date = CURRENT_DATE, actual_cash = 0, expected_cash = 0, cash_variance = 0,
                      close_method = 'ADMIN', admin_close_reason = 'itest' WHERE id = $1`, [yesterdayShift]);
  r = await get(A);
  check(!r.data.alerts.some((a: any) => a.alert_key === `SHIFT_LEFT_OPEN:${yesterdayShift}`), 'AL9: closing the shift resolves the alert');
  check((await api('GET', '/api/alerts', null)).status === 401, 'AL10: anonymous -> 401');
  void loginNoShift;
}
