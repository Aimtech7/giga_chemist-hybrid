import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import type pg from 'pg';
import { HttpError } from '../db/client';
import { applyCommandDirect } from './directAdmin';

export interface RestBridgeDeps {
  withCloud: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  withShopId: <T>(shopId: string, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  requestShop: (req: Request) => string;
  requireAuth: express.Handler;
  requirePermission: (perm: any) => express.Handler;
  requireAdmin: express.Handler;
  route: (label: string, fn: (req: Request, res: Response) => Promise<any>) => express.Handler;
  send: (res: Response, err: any, label: string) => void;
}

export function buildRestBridgeRouter(deps: RestBridgeDeps): express.Router {
  const r = express.Router();
  const { withCloud, withShopId, requestShop, requireAuth, requirePermission, requireAdmin, route, send } = deps;

  const currentUserId = (req: Request): string => {
    const u = (req as any).onlineUser;
    return u?.id || u?.local_user_id || '00000000-0000-0000-0000-000000000000';
  };

  // ------------------------------------------------------------------ Realtime configuration
  r.get('/realtime/config', requireAuth, (req, res) => {
    const shopId = requestShop(req);
    res.json({
      enabled: Boolean(process.env.SUPABASE_URL),
      url: process.env.SUPABASE_URL || '',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      shopId,
    });
  });

  // ------------------------------------------------------------------ Inventory Movements (audit ledger)
  r.get('/inventory/movements', requireAuth, route('GET /inventory/movements', async (req) => {
    const shopId = requestShop(req);
    return withCloud(async (c) => {
      const rows = await c.query(
        `SELECT
           im.movement_id AS id,
           im.medicine_id,
           COALESCE(m.name, im.notes, 'Item') AS medicine_name,
           im.batch_id,
           COALESCE(b.batch_number, 'Batch') AS batch_number,
           COALESCE(im.previous_quantity, 0)::int AS previous_quantity,
           COALESCE(im.delta, 0)::int AS adjustment_quantity,
           COALESCE(im.new_quantity, 0)::int AS new_quantity,
           COALESCE(im.reason, im.movement_type, 'UNSPECIFIED') AS reason,
           im.movement_type,
           im.reference_id,
           im.notes,
           im.user_id,
           COALESCE(u.name, 'Staff') AS user_name,
           im.device_id,
           im.occurred_at AS created_at
         FROM giga_cloud.inventory_movements im
         LEFT JOIN giga_cloud.medicines m ON im.shop_id = m.shop_id AND im.medicine_id = m.medicine_id
         LEFT JOIN giga_cloud.medicine_batches b ON im.shop_id = b.shop_id AND im.batch_id = b.batch_id
         LEFT JOIN giga_cloud.online_users u ON im.user_id = u.id
         WHERE im.shop_id = $1
         ORDER BY im.occurred_at DESC
         LIMIT 1000`,
        [shopId]
      );
      return rows.rows;
    });
  }));

  // ------------------------------------------------------------------ Audit Log
  r.get('/audit', requireAdmin, route('GET /audit', async (req) => {
    const shopId = requestShop(req);
    return withCloud(async (c) => {
      const rows = await c.query(
        `SELECT
           c.command_id AS id,
           c.created_by_user_id AS user_id,
           COALESCE(u.name, u.email, 'Admin') AS user_name,
           u.role,
           c.command_type AS action,
           c.command_type AS entity,
           c.command_id AS entity_id,
           c.payload AS new_value,
           c.result AS previous_value,
           'ONLINE_CLOUD' AS device_id,
           c.created_at AS timestamp,
           c.created_at
         FROM giga_cloud.commands c
         LEFT JOIN giga_cloud.online_users u ON c.created_by_user_id = u.id
         WHERE c.shop_id = $1
         ORDER BY c.created_at DESC
         LIMIT 500`,
        [shopId]
      );
      return rows.rows;
    });
  }));

  // ------------------------------------------------------------------ Medicines Master Catalog
  r.post('/medicines', requirePermission('inventory.edit'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const applied = await applyCommandDirect(withCloud, withShopId, shopId, 'MEDICINE_CREATE', req.body || {}, userId);
      const medId = (applied.result?.medicine_id as string) || req.body?.id;
      const medicine = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM medicines WHERE id = $1', [medId])).rows[0];
        return row || { id: medId, ...req.body };
      });
      res.status(201).json({ medicine });
    } catch (err: any) {
      send(res, err, 'POST /medicines');
    }
  });

  r.put('/medicines/:id', requirePermission('inventory.edit'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const medicine_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'MEDICINE_METADATA_UPDATE', { ...req.body, medicine_id }, userId);
      const medicine = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM medicines WHERE id = $1', [medicine_id])).rows[0];
        return row || { id: medicine_id, ...req.body };
      });
      res.json({ medicine });
    } catch (err: any) {
      send(res, err, 'PUT /medicines/:id');
    }
  });

  r.patch('/medicines/:id/pricing', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const medicine_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'PRICE_UPDATE', { ...req.body, medicine_id }, userId);
      const medicine = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM medicines WHERE id = $1', [medicine_id])).rows[0];
        return row || { id: medicine_id, ...req.body };
      });
      res.json({ medicine });
    } catch (err: any) {
      send(res, err, 'PATCH /medicines/:id/pricing');
    }
  });

  r.delete('/medicines/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const medicine_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'MEDICINE_DELETE', { medicine_id, reason: req.body?.reason }, userId);
      res.json({ success: true, message: 'Medicine deleted successfully.' });
    } catch (err: any) {
      send(res, err, 'DELETE /medicines/:id');
    }
  });

  r.post('/medicines/:id/restore', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const medicine_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'MEDICINE_SET_ACTIVE', { medicine_id, active: true }, userId);
      res.json({ success: true, message: 'Medicine restored successfully.' });
    } catch (err: any) {
      send(res, err, 'POST /medicines/:id/restore');
    }
  });

  // ------------------------------------------------------------------ Inventory Adjustments
  r.post('/inventory/set-stock', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const { medicine_id, batch_id, new_stock, reason, notes } = req.body;
      if (!medicine_id || new_stock === undefined || new_stock === null || new_stock === '') {
        throw new HttpError(400, 'medicine_id and new_stock are required.');
      }
      const applied = await applyCommandDirect(
        withCloud, withShopId, shopId, 'STOCK_SET',
        { medicine_id, batch_id, quantity: Number(new_stock), reason, notes },
        userId
      );
      const effectiveBatchId = (applied.result?.batch_id as string) || batch_id;
      const [medicine, batch] = await withShopId(shopId, async (c) => {
        const m = (await c.query('SELECT * FROM medicines WHERE id = $1', [medicine_id])).rows[0];
        const b = effectiveBatchId ? (await c.query('SELECT * FROM medicine_batches WHERE id = $1', [effectiveBatchId])).rows[0] : null;
        return [m, b];
      });
      res.json({ success: true, medicine, batch });
    } catch (err: any) {
      send(res, err, 'POST /inventory/set-stock');
    }
  });

  r.post('/inventory/add-stock', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const { medicine_id, quantity, batch_number, expiry_date, supplier_id, purchase_price, selling_price_override, notes } = req.body;
      if (!medicine_id || !quantity) throw new HttpError(400, 'medicine_id and quantity are required.');
      const applied = await applyCommandDirect(
        withCloud, withShopId, shopId, 'STOCK_ADD',
        { medicine_id, quantity: Number(quantity), batch_number, expiry_date, supplier_id, purchase_price, selling_price_override, notes },
        userId
      );
      const effectiveBatchId = applied.result?.batch_id as string;
      const [medicine, batch] = await withShopId(shopId, async (c) => {
        const m = (await c.query('SELECT * FROM medicines WHERE id = $1', [medicine_id])).rows[0];
        const b = effectiveBatchId
          ? (await c.query('SELECT * FROM medicine_batches WHERE id = $1', [effectiveBatchId])).rows[0]
          : (batch_number ? (await c.query('SELECT * FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2 LIMIT 1', [medicine_id, batch_number])).rows[0] : null);
        return [m, b];
      });
      res.json({ success: true, medicine, batch });
    } catch (err: any) {
      send(res, err, 'POST /inventory/add-stock');
    }
  });

  r.post('/inventory/remove-stock', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const { medicine_id, batch_id, quantity, reason, notes } = req.body;
      if (!medicine_id || !batch_id || !quantity) throw new HttpError(400, 'medicine_id, batch_id, and quantity are required.');
      await applyCommandDirect(
        withCloud, withShopId, shopId, 'STOCK_REMOVE',
        { medicine_id, batch_id, quantity: Number(quantity), reason, notes },
        userId
      );
      const [medicine, batch] = await withShopId(shopId, async (c) => {
        const m = (await c.query('SELECT * FROM medicines WHERE id = $1', [medicine_id])).rows[0];
        const b = (await c.query('SELECT * FROM medicine_batches WHERE id = $1', [batch_id])).rows[0];
        return [m, b];
      });
      res.json({ success: true, medicine, batch });
    } catch (err: any) {
      send(res, err, 'POST /inventory/remove-stock');
    }
  });

  r.post('/batches/:id/expiry', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const batch_id = req.params.id;
      const { expiry_date, reason } = req.body;
      await applyCommandDirect(withCloud, withShopId, shopId, 'BATCH_EXPIRY_UPDATE', { batch_id, expiry_date, reason }, userId);
      const batch = await withShopId(shopId, async (c) => {
        return (await c.query('SELECT * FROM medicine_batches WHERE id = $1', [batch_id])).rows[0];
      });
      res.json({ success: true, batch });
    } catch (err: any) {
      send(res, err, 'POST /batches/:id/expiry');
    }
  });

  // ------------------------------------------------------------------ Customers
  r.post('/customers', requirePermission('customers.manage'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const isUpdate = Boolean(req.body?.id);
      const type = isUpdate ? 'CUSTOMER_UPDATE' : 'CUSTOMER_CREATE';
      const payload = isUpdate ? { customer_id: req.body.id, ...req.body } : req.body;
      const applied = await applyCommandDirect(withCloud, withShopId, shopId, type, payload, userId);
      const customerId = isUpdate ? req.body.id : (applied.result?.customer_id as string);
      const customer = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM customers WHERE id = $1', [customerId])).rows[0];
        return row || { id: customerId, ...req.body };
      });
      res.status(isUpdate ? 200 : 201).json({ customer });
    } catch (err: any) {
      send(res, err, 'POST /customers');
    }
  });

  r.put('/customers/:id', requirePermission('customers.manage'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const customer_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'CUSTOMER_UPDATE', { customer_id, ...req.body }, userId);
      const customer = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM customers WHERE id = $1', [customer_id])).rows[0];
        return row || { id: customer_id, ...req.body };
      });
      res.json({ customer });
    } catch (err: any) {
      send(res, err, 'PUT /customers/:id');
    }
  });

  r.delete('/customers/:id', requirePermission('customers.manage'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'CUSTOMER_SET_ACTIVE', { customer_id: req.params.id, active: false }, userId);
      res.json({ success: true });
    } catch (err: any) {
      send(res, err, 'DELETE /customers/:id');
    }
  });

  // ------------------------------------------------------------------ Suppliers
  r.post('/suppliers', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const isUpdate = Boolean(req.body?.id);
      const type = isUpdate ? 'SUPPLIER_UPDATE' : 'SUPPLIER_CREATE';
      const payload = isUpdate ? { supplier_id: req.body.id, ...req.body } : req.body;
      const applied = await applyCommandDirect(withCloud, withShopId, shopId, type, payload, userId);
      const supplierId = isUpdate ? req.body.id : (applied.result?.supplier_id as string);
      const supplier = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM suppliers WHERE id = $1', [supplierId])).rows[0];
        return row || { id: supplierId, ...req.body };
      });
      res.status(isUpdate ? 200 : 201).json({ supplier });
    } catch (err: any) {
      send(res, err, 'POST /suppliers');
    }
  });

  r.put('/suppliers/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const supplier_id = req.params.id;
      await applyCommandDirect(withCloud, withShopId, shopId, 'SUPPLIER_UPDATE', { supplier_id, ...req.body }, userId);
      const supplier = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id])).rows[0];
        return row || { id: supplier_id, ...req.body };
      });
      res.json({ supplier });
    } catch (err: any) {
      send(res, err, 'PUT /suppliers/:id');
    }
  });

  r.delete('/suppliers/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'SUPPLIER_SET_ACTIVE', { supplier_id: req.params.id, status: 'inactive' }, userId);
      res.json({ success: true });
    } catch (err: any) {
      send(res, err, 'DELETE /suppliers/:id');
    }
  });

  // ------------------------------------------------------------------ Expenses
  r.post('/expenses', requirePermission('expenses.manage'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const applied = await applyCommandDirect(withCloud, withShopId, shopId, 'EXPENSE_CREATE', req.body || {}, userId);
      const expenseId = applied.result?.expense_id as string;
      const expense = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM expenses WHERE id = $1', [expenseId])).rows[0];
        return row || { id: expenseId, ...req.body };
      });
      res.status(201).json({ expense });
    } catch (err: any) {
      send(res, err, 'POST /expenses');
    }
  });

  r.delete('/expenses/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'EXPENSE_VOID', { expense_id: req.params.id, reason: req.body?.reason || 'Voided by admin' }, userId);
      res.json({ success: true });
    } catch (err: any) {
      send(res, err, 'DELETE /expenses/:id');
    }
  });

  // ------------------------------------------------------------------ Purchases
  r.post('/purchases', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const { items, ...header } = req.body || {};
      const appliedCreate = await applyCommandDirect(withCloud, withShopId, shopId, 'PURCHASE_CREATE', { ...header, items }, userId);
      const purchaseId = (appliedCreate.result?.purchase_id as string) || crypto.randomUUID();
      // If purchase was already marked paid/received, finalize receive
      if (req.body?.payment_status === 'paid' || req.body?.status === 'received' || Array.isArray(items)) {
        await applyCommandDirect(withCloud, withShopId, shopId, 'PURCHASE_RECEIVE', { purchase_id: purchaseId, ...header, items }, userId);
      }
      const [purchase, medicines, batches] = await withShopId(shopId, async (c) => {
        const p = (await c.query('SELECT * FROM purchases WHERE id = $1', [purchaseId])).rows[0];
        const medIds = (items || []).map((i: any) => i.medicine_id).filter(Boolean);
        const meds = medIds.length > 0 ? (await c.query(`SELECT * FROM medicines WHERE id = ANY($1)`, [medIds])).rows : [];
        const btchs = medIds.length > 0 ? (await c.query(`SELECT * FROM medicine_batches WHERE medicine_id = ANY($1)`, [medIds])).rows : [];
        return [p || { id: purchaseId, ...req.body }, meds, btchs];
      });
      res.status(201).json({ purchase, medicines, batches });
    } catch (err: any) {
      send(res, err, 'POST /purchases');
    }
  });

  r.post('/purchases/drafts', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const applied = await applyCommandDirect(withCloud, withShopId, shopId, 'PURCHASE_CREATE', req.body || {}, userId);
      const purchaseId = applied.result?.purchase_id as string;
      const purchase = await withShopId(shopId, async (c) => {
        const row = (await c.query('SELECT * FROM purchases WHERE id = $1', [purchaseId])).rows[0];
        return row || { id: purchaseId, ...req.body };
      });
      res.status(201).json({ purchase });
    } catch (err: any) {
      send(res, err, 'POST /purchases/drafts');
    }
  });

  r.post('/purchases/:id/receive', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'PURCHASE_RECEIVE', { purchase_id: req.params.id, ...req.body }, userId);
      res.json({ success: true });
    } catch (err: any) {
      send(res, err, 'POST /purchases/:id/receive');
    }
  });

  r.post('/purchases/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'PURCHASE_CANCEL', { purchase_id: req.params.id, ...req.body }, userId);
      res.json({ success: true });
    } catch (err: any) {
      send(res, err, 'POST /purchases/:id/cancel');
    }
  });

  // ------------------------------------------------------------------ Returns
  r.post('/returns', requirePermission('returns.create'), async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      const { sale_id, medicine_id, batch_id, quantity, reason, requested_refund, auto_approve } = req.body || {};
      const returnId = crypto.randomUUID();
      const seq = String(BigInt(Date.now()) * 1000n);

      await withCloud(async (c) => {
        await c.query(
          `INSERT INTO giga_cloud.returns (
             shop_id, return_id, sale_id, medicine_id, batch_id, quantity, approved_quantity,
             reason, requested_refund, status, data, source_seq, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, now())`,
          [
            shopId, returnId, sale_id ?? null, medicine_id ?? null, batch_id ?? null,
            quantity ?? 1, auto_approve ? quantity ?? 1 : null, reason ?? 'Customer return',
            requested_refund ?? 0, auto_approve ? 'approved' : 'pending',
            JSON.stringify(req.body || {}), seq,
          ]
        );
      });

      if (auto_approve) {
        await applyCommandDirect(
          withCloud, withShopId, shopId, 'RETURN_APPROVE',
          { return_id: returnId, approved_quantity: quantity, refund_amount: requested_refund, restock: true },
          userId
        );
      }

      res.status(201).json({ success: true, return_id: returnId, return: { id: returnId, ...req.body } });
    } catch (err: any) {
      send(res, err, 'POST /returns');
    }
  });

  // ------------------------------------------------------------------ Sales Void
  r.post('/sales/:id/void', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'SALE_VOID', { sale_id: req.params.id, reason: req.body?.reason }, userId);
      res.json({ success: true, message: 'Sale voided successfully.' });
    } catch (err: any) {
      send(res, err, 'POST /sales/:id/void');
    }
  });

  // ------------------------------------------------------------------ Settings
  const handleSettingsUpdate = async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'SETTINGS_UPDATE', req.body || {}, userId);
      res.json({ settings: req.body });
    } catch (err: any) {
      send(res, err, `${req.method} /settings`);
    }
  };
  r.post('/settings', requireAdmin, handleSettingsUpdate);
  r.put('/settings', requireAdmin, handleSettingsUpdate);

  // ------------------------------------------------------------------ Categories
  r.post('/categories', requireAdmin, async (req: Request, res: Response) => {
    try {
      const shopId = requestShop(req);
      const userId = currentUserId(req);
      await applyCommandDirect(withCloud, withShopId, shopId, 'CATEGORY_UPSERT', req.body || {}, userId);
      res.json({ category: { id: crypto.randomUUID(), name: req.body?.name, description: req.body?.description } });
    } catch (err: any) {
      send(res, err, 'POST /categories');
    }
  });

  return r;
}
