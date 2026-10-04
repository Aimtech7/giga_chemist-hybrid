import { updateUser } from '../../server/db/users';
import { api, check, login, pool, section, startServer, stopServer, UUID_RE, randomPassword, type Fixture } from './harness';

export interface Ctx {
  admin: Fixture;
  cashier: Fixture;
  cashier2: Fixture;
  adminToken: string;
  cashierToken: string;
  cashier2Token: string;
}

export async function authTests(ctx: Ctx) {
  section('AUTH');
  // ---- Login identifiers: email AND username, password AND PIN, for both roles ----
  const tryLogin = (identifier: string, secret: string) => api('POST', '/api/auth/login', null, { email: identifier, password: secret });
  for (const f of [ctx.admin, ctx.cashier]) {
    const label = f.role === 'ADMIN' ? 'Admin' : 'Cashier';
    const byUser = await tryLogin(f.username, f.password);
    check(byUser.status === 200 && byUser.data?.user?.role === f.role, `${label} username + password login`, byUser.status);
    const byUserUpper = await tryLogin(f.username.toUpperCase(), f.password);
    check(byUserUpper.status === 200, `${label} username is case-insensitive`, byUserUpper.status);
    const byEmail = await tryLogin(f.email, f.password);
    check(byEmail.status === 200 && byEmail.data?.user?.id === f.id, `${label} email + password login`, byEmail.status);
    const byUserPin = await tryLogin(f.username, f.pin);
    check(byUserPin.status === 200, `${label} username + station PIN login`, byUserPin.status);
    const byEmailPin = await tryLogin(f.email, f.pin);
    check(byEmailPin.status === 200, `${label} email + station PIN login`, byEmailPin.status);
    const wrongPw = await tryLogin(f.username, 'definitely-wrong-123');
    check(wrongPw.status === 401, `${label} wrong password -> 401`, wrongPw.status);
    const wrongPin = await tryLogin(f.username, f.pin === '111111' ? '222222' : '111111');
    check(wrongPin.status === 401, `${label} wrong PIN -> 401`, wrongPin.status);
    const me = await api('GET', '/api/auth/me', byUser.data?.token);
    check(me.status === 200 && me.data?.user?.role === f.role && me.data?.user?.username === f.username, `${label} token loads ${f.role} role (/auth/me)`, me.data?.user);
    const adminRoute = await api('GET', '/api/users', byUser.data?.token);
    check(adminRoute.status === (f.role === 'ADMIN' ? 200 : 403), `${label} on Admin-only route -> ${f.role === 'ADMIN' ? 200 : 403}`, adminRoute.status);
  }
  const unknownUser = await tryLogin('no-such-user', 'whatever-123');
  const unknownEmail = await tryLogin('no-such-user@gigachemist.local', 'whatever-123');
  const wrongForReal = await tryLogin(ctx.admin.username, 'definitely-wrong-123');
  check(unknownUser.status === 401 && unknownEmail.status === 401 && unknownUser.data?.error === wrongForReal.data?.error && unknownEmail.data?.error === wrongForReal.data?.error,
    'unknown username / unknown email / wrong password share one generic 401 message', [unknownUser.data?.error, wrongForReal.data?.error]);
  // A matching secret on ANOTHER account must never log in (the old server scanned all accounts).
  const crossAccount = await tryLogin(ctx.cashier.username, ctx.admin.password);
  check(crossAccount.status === 401, "another account's password never authenticates this user", crossAccount.status);
  const nameAsId = await tryLogin('ITest Admin', ctx.admin.password);
  check(nameAsId.status === 401, 'display name is not a login identifier', nameAsId.status);

  const health = await api('GET', '/api/health');
  check(health.status === 200 && health.contentType.includes('json'), 'health endpoint returns JSON');

  const unknown = await api('GET', '/api/definitely-not-a-route', ctx.adminToken);
  check(unknown.status === 404 && unknown.contentType.includes('json'), 'unknown /api route -> JSON 404 (not SPA HTML)', unknown.status);

  check(UUID_RE.test(ctx.admin.id) && UUID_RE.test(ctx.cashier.id), 'fixture user ids are UUIDs');
  check(typeof ctx.adminToken === 'string' && ctx.adminToken.split('.').length === 3, 'Admin login returns a JWT');
  check(typeof ctx.cashierToken === 'string' && ctx.cashierToken.split('.').length === 3, 'Cashier login returns a JWT');

  const bad = await api('POST', '/api/auth/login', null, { email: ctx.admin.email, password: 'wrong-password-123' });
  check(bad.status === 401, 'invalid password denied (401)', bad);
  const ghost = await api('POST', '/api/auth/login', null, { email: 'nobody-here@gigachemist.local', password: 'whatever-123' });
  check(ghost.status === 401 && ghost.data?.error === bad.data?.error, 'unknown email denied with the same generic message');
  const empty = await api('POST', '/api/auth/login', null, { email: ctx.admin.email });
  check(empty.status === 400, 'login without secret rejected (400)');

  const noToken = await api('GET', '/api/users');
  check(noToken.status === 401, 'unauthenticated protected endpoint -> 401', noToken.status);
  const garbage = await api('GET', '/api/users', 'not.a.token');
  check(garbage.status === 401, 'garbage token -> 401', garbage.status);
  const spoof = await api('GET', '/api/users', null, undefined, { 'x-user-role': 'ADMIN', 'x-user-id': ctx.admin.id });
  check(spoof.status === 401, 'x-user-role / x-user-id headers grant nothing (401)', spoof.status);

  // Forge a token: same header/signature, payload changed to ADMIN
  const [h, p, sig] = ctx.cashierToken.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, role: 'ADMIN' })).toString('base64url')}.${sig}`;
  const forgedRes = await api('GET', '/api/users', forged);
  check(forgedRes.status === 401, 'tampered token payload rejected (401)', forgedRes.status);

  const cashierAdmin = await api('GET', '/api/users', ctx.cashierToken);
  check(cashierAdmin.status === 403, 'Cashier on Admin endpoint -> 403', cashierAdmin.status);
  const adminOk = await api('GET', '/api/users', ctx.adminToken);
  check(adminOk.status === 200 && Array.isArray(adminOk.data), 'Admin permitted on Admin endpoint');
  check(Array.isArray(adminOk.data) && adminOk.data.every((u: any) => !('password_hash' in u) && !('pin_hash' in u)), 'user list never exposes hashes');

  const me = await api('GET', '/api/auth/me', ctx.cashierToken);
  check(me.status === 200 && me.data?.user?.role === 'CASHIER' && me.data?.user?.id === ctx.cashier.id, '/auth/me returns DB identity');

  // The three previously failing routes must not 401 with a valid Admin token
  const summary = await api('GET', '/api/sales/today-summary', ctx.adminToken);
  check(summary.status === 200, 'GET /sales/today-summary with Admin token -> 200', summary.status);
}

const NEW_ADMIN = 'itest-created-admin@gigachemist.local';
const NEW_CASHIER = 'itest-created-cashier@gigachemist.local';

export async function userTests(ctx: Ctx) {
  section('USERS');
  // Remove leftovers from a previous run (never referenced by sales).
  await pool.query(`DELETE FROM users WHERE email = ANY($1) AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.cashier_id = users.id)`, [[NEW_ADMIN, NEW_CASHIER]]);

  const weak = await api('POST', '/api/users', ctx.adminToken, { name: 'Weak', email: 'weak-pass@gigachemist.local', role: 'CASHIER', password: 'short' });
  check(weak.status === 400, 'create user with short password rejected (400)', weak.status);
  const badRole = await api('POST', '/api/users', ctx.adminToken, { name: 'X', email: 'x-role@gigachemist.local', role: 'SUPERUSER', password: randomPassword() });
  check(badRole.status === 400, 'invalid role rejected (400)', badRole.status);

  const adminPw = randomPassword();
  const createdAdmin = await api('POST', '/api/users', ctx.adminToken, { name: 'ITest Created Admin', email: NEW_ADMIN, role: 'ADMIN', password: adminPw });
  check(createdAdmin.status === 201 && UUID_RE.test(createdAdmin.data?.user?.id), 'Admin creates an Admin (UUID id)', createdAdmin.data);

  const cashierPw = randomPassword();
  const createdCashier = await api('POST', '/api/users', ctx.adminToken, { name: 'ITest Created Cashier', email: NEW_CASHIER, username: 'ITest-Created-Cashier', role: 'CASHIER', password: cashierPw, pin: '4821' });
  const newCashierId: string = createdCashier.data?.user?.id;
  check(createdCashier.status === 201 && UUID_RE.test(newCashierId), 'Admin creates a Cashier (UUID id)', createdCashier.data);

  const dup = await api('POST', '/api/users', ctx.adminToken, { name: 'Dup', email: NEW_CASHIER.toUpperCase(), role: 'CASHIER', password: randomPassword() });
  check(dup.status === 409, 'duplicate email (case-insensitive) -> 409', dup.status);

  const byCashier = await api('POST', '/api/users', ctx.cashierToken, { name: 'Nope', email: 'nope@gigachemist.local', role: 'ADMIN', password: randomPassword() });
  check(byCashier.status === 403, 'Cashier cannot create users (403)', byCashier.status);

  const row = await pool.query('SELECT password_hash, pin_hash FROM users WHERE id = $1', [newCashierId]);
  check(row.rows[0]?.password_hash?.includes('$') && !row.rows[0].password_hash.includes(cashierPw), 'password stored only as salted PBKDF2 hash');

  let token = await login(NEW_CASHIER, cashierPw).catch(() => '');
  check(Boolean(token), 'new Cashier can log in with the set password');
  const pinLogin = await api('POST', '/api/auth/login', null, { email: NEW_CASHIER, password: '4821' });
  check(pinLogin.status === 200, 'new Cashier can log in with PIN');
  check(createdCashier.data?.user?.username === 'itest-created-cashier', 'username stored lower-case', createdCashier.data?.user?.username);
  const unameLogin = await api('POST', '/api/auth/login', null, { email: 'itest-created-cashier', password: cashierPw });
  check(unameLogin.status === 200 && unameLogin.data?.user?.id === newCashierId, 'new Cashier can log in with username');
  const dupUser = await api('POST', '/api/users', ctx.adminToken, { name: 'Dup U', email: 'itest-dup-username@gigachemist.local', username: 'ITEST-CREATED-CASHIER', role: 'CASHIER', password: randomPassword() });
  check(dupUser.status === 409 && /Username/.test(dupUser.data?.error || ''), 'duplicate username (case-insensitive) -> 409', dupUser.data);
  for (const bad of ['ab', 'has space', 'x@y.com', '-lead']) {
    const bu = await api('POST', '/api/users', ctx.adminToken, { name: 'Bad U', email: `itest-bad-${Date.now()}@gigachemist.local`, username: bad, role: 'CASHIER', password: randomPassword() });
    check(bu.status === 400, `invalid username "${bad}" rejected (400)`, bu.status);
  }
  const renamed = await api('PUT', `/api/users/${newCashierId}`, ctx.adminToken, { username: 'itest-renamed-cashier' });
  const oldName = await api('POST', '/api/auth/login', null, { email: 'itest-created-cashier', password: cashierPw });
  const newName = await api('POST', '/api/auth/login', null, { email: 'itest-renamed-cashier', password: cashierPw });
  check(renamed.status === 200 && oldName.status === 401 && newName.status === 200, 'Admin changes username; old username stops working');

  // Edit name/email/role
  const edited = await api('PUT', `/api/users/${newCashierId}`, ctx.adminToken, { name: 'ITest Cashier Renamed', phone: '0700000001' });
  check(edited.status === 200 && edited.data?.user?.name === 'ITest Cashier Renamed', 'Admin edits user name/phone');
  const promoted = await api('PATCH', `/api/users/${newCashierId}/role`, ctx.adminToken, { role: 'ADMIN' });
  check(promoted.status === 200 && promoted.data?.user?.role === 'ADMIN', 'Admin changes role CASHIER -> ADMIN');
  const meAfter = await api('GET', '/api/auth/me', token);
  check(meAfter.data?.user?.role === 'ADMIN', 'role change takes effect on existing session immediately');
  const demoted = await api('PATCH', `/api/users/${newCashierId}/role`, ctx.adminToken, { role: 'CASHIER' });
  check(demoted.status === 200 && demoted.data?.user?.role === 'CASHIER', 'Admin changes role ADMIN -> CASHIER');

  // Password reset by Admin
  const newPw = randomPassword();
  const reset = await api('POST', `/api/users/${newCashierId}/reset-password`, ctx.adminToken, { new_password: newPw });
  check(reset.status === 200, 'Admin resets another user password', reset.data);
  const oldLogin = await api('POST', '/api/auth/login', null, { email: NEW_CASHIER, password: cashierPw });
  check(oldLogin.status === 401, 'old password no longer works');
  token = await login(NEW_CASHIER, newPw).catch(() => '');
  check(Boolean(token), 'new password works');
  const resetByCashier = await api('POST', `/api/users/${ctx.admin.id}/reset-password`, ctx.cashierToken, { new_password: randomPassword() });
  check(resetByCashier.status === 403, 'Cashier cannot reset passwords (403)', resetByCashier.status);

  // Self password change
  const selfPw = randomPassword();
  const wrongCurrent = await api('POST', '/api/users/change-password', token, { current_password: 'not-it-123', new_password: selfPw });
  check(wrongCurrent.status === 400, 'self password change requires the current password');
  const selfChange = await api('POST', '/api/users/change-password', token, { current_password: newPw, new_password: selfPw, confirm_password: selfPw });
  check(selfChange.status === 200, 'user changes own password', selfChange.data);
  token = await login(NEW_CASHIER, selfPw).catch(() => '');
  check(Boolean(token), 'login with self-changed password');

  // Deactivate / reactivate
  const deact = await api('PATCH', `/api/users/${newCashierId}/status`, ctx.adminToken, { active: false });
  check(deact.status === 200 && deact.data?.user?.active === false, 'Admin deactivates user');
  const deadSession = await api('GET', '/api/auth/me', token);
  check(deadSession.status === 401, 'deactivated user existing token -> 401 immediately', deadSession.status);
  const deadLogin = await api('POST', '/api/auth/login', null, { email: NEW_CASHIER, password: selfPw });
  check(deadLogin.status === 403, 'deactivated user cannot log in (403)', deadLogin.status);
  const deadUname = await api('POST', '/api/auth/login', null, { email: 'itest-renamed-cashier', password: selfPw });
  check(deadUname.status === 403, 'deactivated user cannot log in by username either (403)', deadUname.status);
  const deadWrong = await api('POST', '/api/auth/login', null, { email: 'itest-renamed-cashier', password: 'wrong-password-99' });
  check(deadWrong.status === 401, 'deactivated user + wrong password -> generic 401 (status not revealed)', deadWrong.status);
  const react = await api('PATCH', `/api/users/${newCashierId}/status`, ctx.adminToken, { active: true });
  check(react.status === 200 && react.data?.user?.active === true, 'Admin reactivates user');
  check(Boolean(await login(NEW_CASHIER, selfPw).catch(() => '')), 'reactivated user can log in');

  // Last-admin / self protection
  const selfDeact = await api('PATCH', `/api/users/${ctx.admin.id}/status`, ctx.adminToken, { active: false });
  check(selfDeact.status === 409, 'Admin cannot deactivate own account (409)', selfDeact.status);
  const selfDemote = await api('PATCH', `/api/users/${ctx.admin.id}/role`, ctx.adminToken, { role: 'CASHIER' });
  check(selfDemote.status === 409, 'Admin cannot remove own Admin role (409)', selfDemote.status);
  await lastAdminProtection(ctx);

  // Restart persistence: the account must survive a server restart (no in-memory store)
  await stopServer();
  await startServer();
  check(Boolean(await login(NEW_CASHIER, selfPw).catch(() => '')), 'created user persists across server restart');
  check(Boolean(await login(NEW_ADMIN, adminPw).catch(() => '')), 'created Admin persists across server restart');
  ctx.adminToken = await login(ctx.admin.email, ctx.admin.password);
  ctx.cashierToken = await login(ctx.cashier.email, ctx.cashier.password);
  ctx.cashier2Token = await login(ctx.cashier2.email, ctx.cashier2.password);
}

/**
 * Last active Admin guard, exercised for real: every OTHER active Admin is deactivated for a moment
 * (restored in finally), then the repository is asked to deactivate / demote the remaining one.
 */
async function lastAdminProtection(ctx: Ctx) {
  const others = await pool.query(`SELECT id FROM users WHERE role = 'ADMIN' AND active = true AND id <> $1`, [ctx.admin.id]);
  const otherIds: string[] = others.rows.map((r) => r.id);
  try {
    await pool.query(`UPDATE users SET active = false WHERE id = ANY($1)`, [otherIds]);
    const deact = await updateUser(ctx.admin.id, { active: false }).then(() => null, (e) => e);
    check(deact?.status === 409, 'last active Admin cannot be deactivated (409)', deact?.message);
    const demote = await updateUser(ctx.admin.id, { role: 'CASHIER' }).then(() => null, (e) => e);
    check(demote?.status === 409, 'last active Admin cannot be demoted (409)', demote?.message);
  } finally {
    await pool.query(`UPDATE users SET active = true WHERE id = ANY($1)`, [otherIds]);
  }
  const still = await pool.query(`SELECT role, active FROM users WHERE id = $1`, [ctx.admin.id]);
  check(still.rows[0]?.role === 'ADMIN' && still.rows[0]?.active === true, 'guarded Admin unchanged after refused attempts');
}
