import assert from 'node:assert/strict';
import { buildRemoteAdminRouter } from '../../server/online/remoteAdmin';
import { applyCommandDirect } from '../../server/online/directAdmin';

const shopId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
let row: any;
let saved: any;
let fail = false;
let writes = 0;
const statements: string[] = [];
const client: any = { query: async (sql: string, params: any[] = []) => {
  statements.push(sql);
  if (sql === 'BEGIN') saved = row && structuredClone(row);
  if (sql === 'ROLLBACK') row = saved;
  if (sql.includes('SELECT shop_code')) return { rows: [{ shop_code: 'TEST', name: 'Test' }] };
  if (sql.includes('SELECT id FROM giga_cloud.online_users')) return { rows: [{ id: userId }] };
  if (sql.includes('SELECT shop_id FROM giga_cloud.shops')) return { rows: [{ shop_id: shopId }] };
  if (sql.includes('SELECT * FROM giga_cloud.commands')) return { rows: row ? [row] : [] };
  if (sql.includes('INSERT INTO giga_cloud.commands')) {
    row = { command_id: 'command-1', shop_id: shopId, created_by_user_id: userId, command_type: params[1], payload: JSON.parse(params[2]), status: 'APPLIED', created_at: new Date().toISOString() };
    return { rows: [row] };
  }
  if (sql.includes('INSERT INTO giga_cloud.categories')) {
    if (fail) throw new Error('database write failed');
    writes++;
  }
  if (sql.includes('UPDATE giga_cloud.commands')) row.result = JSON.parse(params[1]);
  if (sql.includes('AS current_stock')) return { rows: [{ current_stock: 7 }] };
  return { rows: [], rowCount: 1 };
} };
const withCloud: any = (fn: any) => fn(client);
const router = buildRemoteAdminRouter({
  withCloud, withShopId: (_id: string, fn: any) => fn(client),
  withShop: (_req: any, fn: any) => fn(client), shopId: () => shopId,
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  route: (_label: string, fn: any) => fn,
  getRemoteControl: async () => ({ remote_writes_enabled: true }),
  clearRemoteControlCache: () => {}, isGlobalAdmin: () => true, securityEvent: async () => {},
} as any);
const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/admin/commands/:action').route.stack.at(-1).handle;
const req: any = { params: { action: 'category' }, body: { name: 'Test', request_id: 'direct-admin-request-1' }, headers: {}, onlineUser: { id: userId, name: 'Admin', email: 'admin@example.test' } };
const res: any = { status(code: number) { assert.equal(code, 200); return this; } };

const first = await handler(req, res);
assert.equal(first.status, 'APPLIED');
assert.equal(first.duplicate, false);
assert.equal(writes, 1);
const replay = await handler(req, res);
assert.equal(replay.duplicate, true);
assert.equal(writes, 1, 'retry must not repeat the write');
assert(!statements.some(sql => sql.includes('queue_online_command')));
assert(!statements.some(sql => sql.includes("'PENDING'")));

row = undefined;
fail = true;
await assert.rejects(handler(req, res), /database write failed/);
assert.equal(row, undefined, 'failed change must roll back its history record');
assert.equal(statements.at(-1), 'ROLLBACK');
fail = false;
await handler(req, res);
assert.equal(writes, 2, 'failed request can be retried successfully');

const preflight = await applyCommandDirect(withCloud, withCloud, shopId, 'MEDICINE_DELETE_PREFLIGHT', { medicine_id: userId }, userId);
assert.deepEqual(preflight.result, { current_stock: 7, has_stock: true });
await assert.rejects(applyCommandDirect(withCloud, withCloud, shopId, 'MEDICINE_DELETE', { medicine_id: userId }, userId), /still has 7/);
for (const type of ['APP_UPDATE_APPROVE', 'SYNC_RETRY_FAILED', 'STOCK_SNAPSHOT_REQUEST'] as const) {
  const count = statements.length;
  assert.deepEqual(await applyCommandDirect(withCloud, withCloud, shopId, type, {}, userId), { applied: true });
  assert.equal(statements.length, count, `${type} is a no-op`);
}
console.log('Direct admin: immediate apply, retry, rollback, stock guard and online-only no-op tests passed.');
