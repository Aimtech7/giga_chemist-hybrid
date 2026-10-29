import assert from 'node:assert/strict';
import { buildRestBridgeRouter } from '../../server/online/restBridge';

const shopId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const statements: string[] = [];

const client: any = {
  query: async (sql: string, params: any[] = []) => {
    statements.push(sql);
    if (sql.includes('SELECT * FROM medicines WHERE id')) {
      return { rows: [{ id: params[0], name: 'Paracetamol 500mg', current_stock: 50, selling_price: 15 }] };
    }
    if (sql.includes('SELECT * FROM medicine_batches WHERE id')) {
      return { rows: [{ id: params[0], batch_number: 'BATCH-001', quantity_available: 50 }] };
    }
    if (sql.includes('SELECT * FROM customers WHERE id')) {
      return { rows: [{ id: params[0], name: 'John Doe', phone: '0712345678' }] };
    }
    if (sql.includes('SELECT * FROM suppliers WHERE id')) {
      return { rows: [{ id: params[0], name: 'PharmaDist Ltd', contact_person: 'Alice' }] };
    }
    if (sql.includes('SELECT * FROM expenses WHERE id')) {
      return { rows: [{ id: params[0], category: 'Utilities', amount: 1200 }] };
    }
    if (sql.includes('SELECT * FROM purchases WHERE id')) {
      return { rows: [{ id: params[0], invoice_number: 'INV-999', total_amount: 5000 }] };
    }
    if (sql.includes('FROM giga_cloud.inventory_movements')) {
      return { rows: [{ movement_id: 'mov-1', medicine_name: 'Paracetamol', delta: 50, reason: 'Stock adjustment' }] };
    }
    if (sql.includes('FROM giga_cloud.commands')) {
      return { rows: [{ command_id: 'cmd-1', action: 'STOCK_SET', user_name: 'Admin' }] };
    }
    if (sql.includes('INSERT INTO giga_cloud.stock_levels')) {
      return { rows: [{ baseline_quantity: 50, delta_since_baseline: 0 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO giga_cloud.inventory_movements')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
};

const withCloud: any = (fn: any) => fn(client);
const withShopId: any = (_id: string, fn: any) => fn(client);

const router = buildRestBridgeRouter({
  withCloud,
  withShopId,
  requestShop: () => shopId,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  route: (_label: string, fn: any) => async (req: any, res: any) => {
    try {
      const data = await fn(req, res);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
  send: (res: any, err: any) => res.status(err.status || 500).json({ error: err.message }),
});

function findRoute(path: string, method: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Route not found: ${method} ${path}`);
  return layer.route.stack.at(-1).handle;
}

// 1. Test GET /realtime/config
{
  const handler = findRoute('/realtime/config', 'GET');
  let result: any = null;
  const res: any = { json: (d: any) => { result = d; } };
  await handler({ onlineUser: { id: userId } }, res);
  assert.equal(result.shopId, shopId);
}

// 2. Test POST /medicines (MEDICINE_CREATE bridge)
{
  const handler = findRoute('/medicines', 'POST');
  let result: any = null;
  let code = 200;
  const res: any = {
    status: (c: number) => { code = c; return res; },
    json: (d: any) => { result = d; },
  };
  await handler({
    body: { name: 'Paracetamol 500mg', selling_price: 15 },
    onlineUser: { id: userId },
  }, res);
  assert.equal(code, 201);
  assert.equal(result.medicine.name, 'Paracetamol 500mg');
  assert(statements.some(s => s.includes('INSERT INTO giga_cloud.medicines')));
}

// 3. Test POST /inventory/set-stock (STOCK_SET bridge & movement logging)
{
  const handler = findRoute('/inventory/set-stock', 'POST');
  let result: any = null;
  const res: any = { json: (d: any) => { result = d; } };
  await handler({
    body: { medicine_id: '10000000-0000-4000-8000-000000000010', batch_id: '10000000-0000-4000-8000-000000000020', new_stock: 50, reason: 'Physical count' },
    onlineUser: { id: userId },
  }, res);
  assert.equal(result.success, true);
  assert.equal(result.medicine.current_stock, 50);
  assert(statements.some(s => s.includes('INSERT INTO giga_cloud.stock_levels')));
  assert(statements.some(s => s.includes('INSERT INTO giga_cloud.inventory_movements')));
}

// 4. Test GET /inventory/movements (ledger)
{
  const handler = findRoute('/inventory/movements', 'GET');
  let result: any = null;
  const res: any = { json: (d: any) => { result = d; } };
  await handler({ onlineUser: { id: userId } }, res);
  assert(Array.isArray(result));
  assert.equal(result[0].medicine_name, 'Paracetamol');
}

// 5. Test POST /customers (CUSTOMER_CREATE bridge)
{
  const handler = findRoute('/customers', 'POST');
  let result: any = null;
  let code = 200;
  const res: any = {
    status: (c: number) => { code = c; return res; },
    json: (d: any) => { result = d; },
  };
  await handler({
    body: { name: 'John Doe', phone: '0712345678' },
    onlineUser: { id: userId },
  }, res);
  assert.equal(code, 201);
  assert.equal(result.customer.name, 'John Doe');
  assert(statements.some(s => s.includes('INSERT INTO giga_cloud.customers')));
}

console.log('RestBridge router unit tests: all tests passed.');
