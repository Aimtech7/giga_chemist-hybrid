import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { HttpError, isValidUuid } from '../db/client';
import { getAllMedicines, getMedicineById } from '../db/medicines';
import { classifyConflict } from '../sync/conflicts';
import { classifyRejection, sanitizePayloadPreview } from '../sync/rejectionCategories';
import {
  validateCommandPayload, commandEntity, commandExpectation, STOCK_REMOVE_REASONS, ASSIGNABLE_ROLES, HIGH_CONFLICT_TYPES, ALL_SHOPS_TYPES,
  EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, RETURN_DISPOSITIONS, PRICE_FIELDS, METADATA_FIELDS, type CommandType,
} from '../sync/commandSchema';

/**
 * Remote administration from the online app (ADMIN only).
 *
 *   GET  /api/admin/shops                shops this account may manage (+ the request's selected shop)
 *   POST /api/admin/commands/<action>    queue one command for the request's AUTHORIZED shop
 *   GET  /api/admin/commands[/:id]       commands + lifecycle (PENDING/DELIVERED/APPLIED/REJECTED)
 *   GET  /api/admin/remote-status        short status (shop in contact? counts)
 *   GET  /api/admin/shop-health          heartbeat-based shop PC health + sanitized diagnostics
 *   GET  /api/admin/alerts  POST /api/admin/alerts/:id/ack
 *   GET  /api/admin/insights             inventory intelligence + retail/wholesale split (cloud copy)
 *   GET  /api/admin/security  POST /api/admin/security/*   emergency controls, session revocation
 *   GET  /api/admin/overview             GLOBAL CONTROL CENTER: per-shop health + business totals
 *   POST /api/admin/all-shops/commands/<action>   APPLY TO ALL SHOPS: one independent command per shop
 *
 * "All Shops" is READ-ONLY: a browser in that view sends X-GIGA-SCOPE: ALL and every shop-scoped write
 * is refused (409 ALL_SHOPS_READ_ONLY); only the explicit all-shops endpoint fans out a change.
 *
 * Queueing never changes data in the cloud copy. The shop's local PostgreSQL applies the command
 * and its sync reports the result back, so a queued command is "PENDING", never "done". shop_id
 * always comes from the server-side shop resolution (app.ts resolveShop: X-GIGA-SHOP-ID re-authorized
 * per request, default SHOP_ID otherwise), never from the request body; the database function
 * re-checks the account may manage that shop. Command ids and idempotency keys are generated here.
 * Shop credentials (passwords / PINs) are never accepted.
 */
export interface RemoteControl {
  remote_writes_enabled: boolean;
  maintenance_mode: boolean;
  maintenance_message: string | null;
}

export interface RemoteAdminDeps {
  /** The request's authorized shop (never module state: concurrent requests may target different shops). */
  shopId: (req: Request) => string;
  /** Read-only transaction over the giga_online views of the request's shop. */
  withShop: <T>(req: Request, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  /** Same, for an explicit (already authorized) shop: all-shops fan-out and the overview. */
  withShopId: <T>(shopId: string, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  /** Plain connection to the cloud database. */
  withCloud: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  requireAdmin: (req: any, res: Response, next: NextFunction) => unknown;
  route: (label: string, fn: (req: any, res: Response) => Promise<unknown>) => (req: any, res: Response) => Promise<void>;
  getRemoteControl: (shopId: string | null, fresh?: boolean) => Promise<RemoteControl>;
  clearRemoteControlCache: (shopId?: string | null) => void;
  /** True for an ADMIN account not bound to one shop (online_users.shop_id IS NULL). */
  isGlobalAdmin: (user: any) => boolean;
  securityEvent: (req: Request, action: string, email: string | null, userId: string | null, details?: Record<string, unknown>) => Promise<void>;
}

export const ACTIONS: Record<string, CommandType> = {
  'stock-add': 'STOCK_ADD',
  'stock-remove': 'STOCK_REMOVE',
  'stock-set': 'STOCK_SET',
  'price-update': 'PRICE_UPDATE',
  'medicine-update': 'MEDICINE_METADATA_UPDATE',
  'batch-expiry': 'BATCH_EXPIRY_UPDATE',
  category: 'CATEGORY_UPSERT',
  settings: 'SETTINGS_UPDATE',
  'user-active': 'USER_SET_ACTIVE',
  'user-role': 'USER_ROLE_UPDATE',
  'app-update': 'APP_UPDATE_APPROVE',
  // Full-write Global Admin (cloud migration 006)
  'medicine-create': 'MEDICINE_CREATE',
  'medicine-active': 'MEDICINE_SET_ACTIVE',
  'batch-create': 'BATCH_CREATE',
  'batch-update': 'BATCH_UPDATE',
  'batch-active': 'BATCH_SET_ACTIVE',
  'supplier-create': 'SUPPLIER_CREATE',
  'supplier-update': 'SUPPLIER_UPDATE',
  'supplier-active': 'SUPPLIER_SET_ACTIVE',
  'customer-create': 'CUSTOMER_CREATE',
  'customer-update': 'CUSTOMER_UPDATE',
  'customer-active': 'CUSTOMER_SET_ACTIVE',
  'purchase-create': 'PURCHASE_CREATE',
  'purchase-update': 'PURCHASE_UPDATE_DRAFT',
  'purchase-receive': 'PURCHASE_RECEIVE',
  'purchase-cancel': 'PURCHASE_CANCEL',
  'expense-create': 'EXPENSE_CREATE',
  'expense-update': 'EXPENSE_UPDATE',
  'expense-void': 'EXPENSE_VOID',
  'return-approve': 'RETURN_APPROVE',
  'return-reject': 'RETURN_REJECT',
  'sale-void': 'SALE_VOID',
  'user-session-revoke': 'USER_SESSION_REVOKE',
  'sync-retry-failed': 'SYNC_RETRY_FAILED',
  // Cashier shifts (cloud migration 009)
  'shift-review': 'SHIFT_REVIEW',
};

/**
 * Create commands name their new record by an id chosen HERE (before the shop applies it), so the
 * record can be referenced at once and a re-delivered command never creates it twice. With a client
 * request id the id is derived from it: the same retried request names the same record.
 */
const CREATE_ID_FIELD: Partial<Record<CommandType, string>> = {
  MEDICINE_CREATE: 'medicine_id', BATCH_CREATE: 'batch_id', SUPPLIER_CREATE: 'supplier_id', CUSTOMER_CREATE: 'customer_id',
  PURCHASE_CREATE: 'purchase_id', EXPENSE_CREATE: 'expense_id',
};

/** Deterministic UUID (version-4 layout) from a seed. */
function derivedUuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Header a browser sends while it shows "All Shops" (read-only consolidated view). */
export const SCOPE_HEADER = 'x-giga-scope';
export const isAllShopsScope = (req: Request) => String(req.headers[SCOPE_HEADER] || '').trim().toUpperCase() === 'ALL';

/** Shop PC is ONLINE when its last heartbeat (every ~60 s) is younger than this. */
export const HEARTBEAT_ONLINE_SECONDS = Math.max(60, Number(process.env.HEARTBEAT_ONLINE_SECONDS) || 180);
/** Fallback before the heartbeat exists (cloud migration 004 / older shop): last RPC contact. */
const CONTACT_WINDOW_SECONDS = 150;

// Sliding one-minute window per online user (per serverless instance; the database-side checks
// and idempotency keys are the real guarantees, this only blunts accidental or abusive bursts).
const hits = new Map<string, number[]>();
function rateLimit(bucket: string, envName: string, fallback: number) {
  return (req: any, res: Response, next: NextFunction) => {
    const limit = Number(process.env[envName]) || fallback;
    const key = `${bucket}:${req.onlineUser?.id || req.ip || 'anon'}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: `Too many requests (limit ${limit} per minute). Wait a minute.`, code: 'RATE_LIMITED' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
const commandRateLimit = rateLimit('cmd', 'ONLINE_COMMAND_RATE_PER_MINUTE', 30);
const securityRateLimit = rateLimit('sec', 'ONLINE_SECURITY_RATE_PER_MINUTE', 20);

/** Error text from the shop / cloud, trimmed for the browser (never stack traces or SQL). */
function safeError(e: unknown): string | null {
  if (typeof e !== 'string' || !e) return null;
  return e.replace(/postgres(ql)?:\/\/\S+/gi, '[hidden]').slice(0, 500);
}

function toCommand(r: any) {
  const entity = commandEntity(r.command_type, r.payload);
  return {
    command_id: r.command_id,
    shop_id: r.shop_id ?? null,
    command_type: r.command_type,
    entity: entity?.entity ?? null,
    entity_id: entity?.entity_id ?? null,
    idempotency_key: r.idempotency_key ?? null,
    expected: commandExpectation(r.payload),
    high_conflict: HIGH_CONFLICT_TYPES.includes(r.command_type),
    status: r.status,
    payload: r.payload,
    display: r.display ?? null,
    created_at: r.created_at,
    created_by: r.created_by,
    source: r.source ?? null,
    delivered_at: r.delivered_at,
    delivery_count: Number(r.delivery_count) || 0,
    acked_at: r.acked_at,
    result: r.result ?? null,
    error: safeError(r.error),
    // The shop's audit rows for this change carry the command id (CLOUD_COMMAND_APPLIED / _REJECTED).
    audit_reference: r.status === 'APPLIED' || r.status === 'REJECTED' ? `shop audit_logs entity_id = ${r.command_id}` : null,
  };
}

function clientIp(req: Request): string {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 100);
}

/**
 * Checks every record named in a payload exists in THIS shop's cloud copy (so a command can never
 * address another shop's record) and returns what the Admin was looking at (names, values before the
 * change) for the activity history. Ids of records a create command introduces are not looked up.
 */
async function contextFor(withShop: ShopReader, type: CommandType, p: Record<string, any>): Promise<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  const creates = CREATE_ID_FIELD[type] ?? (type === 'PURCHASE_RECEIVE' && p.items ? 'purchase_id' : null);
  const one = async (c: pg.PoolClient, sql: string, params: unknown[], missing: string) => {
    const row = (await c.query(sql, params)).rows[0];
    if (!row) throw new HttpError(404, missing);
    return row;
  };
  await withShop(async (c) => {
    if (p.medicine_id && creates !== 'medicine_id') {
      const m = await one(c,
        `SELECT name, current_stock, selling_price, wholesale_price, min_selling_price, purchase_price, reorder_level, status FROM medicines WHERE id = $1`,
        [p.medicine_id], 'Medicine not found in the cloud copy of this shop (has the shop synced it yet?).');
      display.medicine_name = m.name;
      display.cloud_stock_before = Number(m.current_stock);
      display.medicine_status_before = m.status;
      if (type === 'PRICE_UPDATE') {
        display.prices_before = {
          selling_price: Number(m.selling_price), wholesale_price: m.wholesale_price === null ? null : Number(m.wholesale_price),
          min_selling_price: m.min_selling_price === null ? null : Number(m.min_selling_price), purchase_price: Number(m.purchase_price),
        };
      }
    }
    if (p.batch_id && creates !== 'batch_id') {
      const b = await one(c, 'SELECT batch_number, quantity_available, expiry_date, status FROM medicine_batches WHERE id = $1 AND medicine_id = $2',
        [p.batch_id, p.medicine_id], 'Batch not found for this medicine in the cloud copy.');
      display.batch_number = b.batch_number;
      display.batch_quantity_before = Number(b.quantity_available);
      display.expiry_before = b.expiry_date ? new Date(b.expiry_date).toISOString().slice(0, 10) : null;
      display.batch_status_before = b.status;
    }
    if (p.user_id) {
      const u = await one(c, 'SELECT name, role, active FROM users WHERE id = $1 AND email IS NOT NULL', [p.user_id], 'Staff account not found in the cloud copy of this shop.');
      display.user_name = u.name;
      display.role_before = u.role;
      display.active_before = u.active;
    }
    if (p.supplier_id && creates !== 'supplier_id') {
      const v = await one(c, 'SELECT name, status FROM suppliers WHERE id = $1', [p.supplier_id], 'Supplier not found in the cloud copy of this shop.');
      display.supplier_name = v.name;
      display.supplier_status_before = v.status;
    }
    if (p.customer_id && creates !== 'customer_id') {
      const v = await one(c, 'SELECT name, active FROM customers WHERE id = $1', [p.customer_id], 'Customer not found in the cloud copy of this shop.');
      display.customer_name = v.name;
      display.customer_active_before = v.active;
    }
    if (p.purchase_id && creates !== 'purchase_id') {
      const v = await one(c, 'SELECT order_number, invoice_number, status, total_amount FROM purchases WHERE id = $1', [p.purchase_id],
        'Purchase not found in the cloud copy of this shop.');
      display.order_number = v.order_number;
      display.purchase_status_before = v.status;
      display.purchase_total_before = v.total_amount === null ? null : Number(v.total_amount);
    }
    if (Array.isArray(p.items)) {
      const ids = [...new Set(p.items.map((i: any) => i.medicine_id))];
      const n = (await c.query('SELECT COUNT(*)::int AS n FROM medicines WHERE id = ANY($1::uuid[])', [ids])).rows[0].n;
      if (n !== ids.length) throw new HttpError(404, 'A purchase line names a medicine that is not in the cloud copy of this shop.');
      display.lines = p.items.length;
      display.total = Math.round(p.items.reduce((sum: number, i: any) => sum + i.quantity * i.purchase_price, 0) * 100) / 100;
    }
    if (p.expense_id && creates !== 'expense_id') {
      const v = await one(c, 'SELECT description, amount, category, status FROM expenses WHERE id = $1', [p.expense_id], 'Expense not found in the cloud copy of this shop.');
      display.expense = { description: v.description, amount: Number(v.amount), category: v.category, status: v.status };
    }
    if (p.return_id) {
      const v = await one(c, 'SELECT receipt_number, quantity, status, requested_refund FROM returns WHERE id = $1', [p.return_id], 'Return not found in the cloud copy of this shop.');
      display.return = { receipt_number: v.receipt_number, quantity: Number(v.quantity), status: v.status, requested_refund: v.requested_refund === null ? null : Number(v.requested_refund) };
    }
    if (p.sale_id) {
      const v = await one(c, 'SELECT receipt_number, total, status, date FROM sales WHERE id = $1', [p.sale_id], 'Sale not found in the cloud copy of this shop.');
      display.sale = { receipt_number: v.receipt_number, total: Number(v.total), status: v.status, date: v.date };
    }
    if (p.shift_id) {
      // giga_online.cashier_shifts (cloud migration 009): the selected shop's shifts only.
      const v = await one(c, 'SELECT shift_number, status, cashier_name, cash_variance FROM cashier_shifts WHERE id = $1', [p.shift_id], 'Shift not found in the cloud copy of this shop.');
      if (v.status !== 'CLOSED') throw new HttpError(409, v.status === 'OPEN' ? 'That shift is still open; it can be reviewed after it is closed.' : 'That shift was already reviewed.');
      display.shift = { shift_number: v.shift_number, status: v.status, cashier_name: v.cashier_name, cash_variance: v.cash_variance === null ? null : Number(v.cash_variance) };
    }
  });
  return display;
}

type ShopReader = <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;

const COMMAND_COLUMNS = `command_id, shop_id, idempotency_key, command_type, status, payload, created_at, created_by, source, delivered_at, delivery_count, acked_at, result, error`;

/** Same query with the display column when migration 004 is applied. */
async function commandQuery(deps: RemoteAdminDeps, where: string, params: unknown[], tail = '') {
  try {
    return (await deps.withCloud((c) => c.query(`SELECT ${COMMAND_COLUMNS}, display FROM giga_cloud.commands WHERE ${where} ${tail}`, params))).rows;
  } catch (err: any) {
    if (err?.code !== '42703') throw err;
    return (await deps.withCloud((c) => c.query(`SELECT ${COMMAND_COLUMNS} FROM giga_cloud.commands WHERE ${where} ${tail}`, params))).rows;
  }
}

async function runtimeRow(deps: RemoteAdminDeps, shopId: string | null) {
  try {
    return (await deps.withCloud((c) => c.query(
      `SELECT *, EXTRACT(EPOCH FROM (now() - reported_at))::int AS age_seconds FROM giga_cloud.shop_runtime_status WHERE shop_id = $1`, [shopId]
    ))).rows[0] || null;
  } catch (err: any) {
    if (err?.code === '42P01') return undefined; // migration 004 not applied
    throw err;
  }
}

export function buildRemoteAdminRouter(deps: RemoteAdminDeps) {
  const r = express.Router();
  const { requireAdmin, route } = deps;

  // Shops this account may manage. Safe fields only (never token_hash or any credential).
  r.get('/admin/shops', requireAdmin, route('GET /admin/shops', async (req) => {
    const u = req.onlineUser;
    const global = deps.isGlobalAdmin(u);
    const selected = deps.shopId(req);
    const select = `SELECT s.shop_id, s.shop_code, s.name, s.active, s.last_seen_at, s.last_event_at FROM giga_cloud.shops s`;
    const rows = await deps.withCloud(async (c) => (global
      ? await c.query(`${select} WHERE s.active ORDER BY s.shop_code, s.shop_id`)
      : await c.query(`${select} WHERE s.shop_id = $1`, [selected])).rows);
    let beats: Record<string, number> = {};
    try {
      beats = Object.fromEntries((await deps.withCloud((c) => c.query(
        `SELECT shop_id, EXTRACT(EPOCH FROM (now() - reported_at))::int AS age FROM giga_cloud.shop_runtime_status WHERE shop_id = ANY($1::uuid[])`,
        [rows.map((x: any) => x.shop_id)]))).rows.map((x: any) => [x.shop_id, Number(x.age)]));
    } catch (err: any) {
      if (err?.code !== '42P01') throw err; // migration 004 not applied: no heartbeat information
    }
    return {
      scope: global ? 'GLOBAL' : 'SHOP',
      selected_shop_id: selected,
      shops: rows.map((x: any) => ({
        shop_id: x.shop_id, shop_code: x.shop_code, name: x.name, active: x.active,
        last_seen_at: x.last_seen_at, last_event_at: x.last_event_at,
        online: x.shop_id in beats ? beats[x.shop_id] <= HEARTBEAT_ONLINE_SECONDS : null,
        heartbeat_age_seconds: beats[x.shop_id] ?? null,
      })),
    };
  }));

  r.get('/admin/commands/options', requireAdmin, (_req, res) => {
    res.json({ actions: Object.keys(ACTIONS), stock_remove_reasons: STOCK_REMOVE_REASONS, assignable_roles: ASSIGNABLE_ROLES });
  });

  /** Shop online? (heartbeat when available, else last contact). null = unknown. */
  async function shopOnline(shopId: string): Promise<boolean | null> {
    const rt = await runtimeRow(deps, shopId);
    if (rt) return rt.age_seconds <= HEARTBEAT_ONLINE_SECONDS;
    if (rt === null) return false;
    const shop = (await deps.withCloud((c) => c.query(
      `SELECT (last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(secs => $2)) AS in_contact FROM giga_cloud.shops WHERE shop_id = $1`,
      [shopId, CONTACT_WINDOW_SECONDS]))).rows[0];
    return shop ? Boolean(shop.in_contact) : null;
  }

  /**
   * Validates, checks against the target shop's cloud copy and queues ONE command for ONE shop.
   * The only queueing path: single-shop requests and the all-shops fan-out both use it.
   */
  async function queueForShop(req: any, shopId: string, type: CommandType, bodyIn: Record<string, any>, seed: string | null, extraDisplay: Record<string, unknown> = {}) {
    const ctl = await deps.getRemoteControl(shopId, true);
    if (!ctl.remote_writes_enabled) throw new HttpError(423, 'Remote changes are disabled (emergency switch). Re-enable them under Security.');
    const u = req.onlineUser;
    let body = bodyIn;
    const createField = CREATE_ID_FIELD[type] ?? (type === 'PURCHASE_RECEIVE' && Array.isArray(body.items) ? 'purchase_id' : undefined);
    if (createField) {
      if (body[createField] !== undefined) throw new HttpError(400, `${createField} of a new record is assigned by the server; do not send it.`);
      body = { ...body, [createField]: seed ? derivedUuid(`${u.id}:${seed}:${type}:${shopId}`) : crypto.randomUUID() };
    }
    const payload = validateCommandPayload(type, body);
    const display = await contextFor((fn) => deps.withShopId(shopId, fn), type, payload);
    // Target shop recorded with the command, so its history always names the shop it was sent to.
    const target = (await deps.withCloud((c) => c.query('SELECT shop_code, name FROM giga_cloud.shops WHERE shop_id = $1', [shopId]))).rows[0];
    display.target_shop = { shop_id: shopId, shop_code: target?.shop_code ?? null, name: target?.name ?? null };
    Object.assign(display, extraDisplay);
    if (type === 'APP_UPDATE_APPROVE') {
      const rt = await runtimeRow(deps, shopId);
      const available = rt?.update_state?.available_commit;
      if (!available || available !== payload.target_commit) {
        throw new HttpError(409, 'That version is not the update the shop computer reported as available on the approved production channel.');
      }
      display.current_commit = rt.update_state.current_commit ?? null;
      display.available_version = rt.update_state.available_version ?? null;
    }
    const online = await shopOnline(shopId);
    const highConflict = HIGH_CONFLICT_TYPES.includes(type);
    if (online === false) display.queued_while_shop_offline = true;

    // Same request (+ same shop for a fan-out) = same key = ONE command, however often it is retried.
    const key = `online:${u.id}:${seed ? `${seed}${extraDisplay.fanout_group ? `:${shopId}` : ''}` : crypto.randomUUID()}`;
    let row: any;
    try {
      row = (await deps.withCloud((c) => c.query(
        `SELECT * FROM giga_cloud.queue_online_command($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb)`,
        [shopId, type, JSON.stringify(payload), key, u.id, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), JSON.stringify(display)]
      ))).rows[0];
    } catch (err: any) {
      if (err?.code === 'PT403') throw new HttpError(403, 'Forbidden: this account may not manage the shop remotely.');
      if (err?.code === 'PT404') throw new HttpError(409, 'The shop is not registered (or inactive) in the cloud.');
      if (err?.code === 'PT409') throw new HttpError(409, 'This request id was already used for another command.');
      if (err?.code === 'PT423') throw new HttpError(423, 'Remote changes are disabled (emergency switch).');
      if (err?.code === '23514') throw new HttpError(503, `The cloud does not accept ${type} yet (apply cloud migration 006).`);
      if (err?.code === '42883' || err?.code === '42703') {
        throw new HttpError(503, 'Remote administration is not fully enabled in the cloud yet (apply cloud migrations 003 and 004).');
      }
      throw err;
    }
    // A replayed request returns the ORIGINAL command: report the record id it really names.
    let entity = commandEntity(type, payload);
    if (row.duplicate) {
      const orig = (await commandQuery(deps, 'command_id = $1', [row.command_id]))[0];
      if (orig) entity = commandEntity(orig.command_type, orig.payload);
    }
    console.log(`[Online] ${u.email} queued ${type} ${row.command_id} for shop ${target?.shop_code || shopId}${row.duplicate ? ' (replayed request)' : ''}`);
    const offlineWarning = highConflict
      ? 'The shop computer is OFFLINE. This stock/financial change waits as PENDING and is re-checked against the shop live data when it arrives; it may be REJECTED if anything changed meanwhile.'
      : 'The shop computer is offline: the change waits as PENDING and is applied when the shop reconnects.';
    return {
      command_id: row.command_id,
      command_type: type,
      shop_id: shopId,
      shop_code: target?.shop_code ?? null,
      shop_name: target?.name ?? null,
      entity: entity?.entity ?? null,
      entity_id: entity?.entity_id ?? null,
      status: row.status,
      created_at: row.created_at,
      duplicate: row.duplicate,
      shop_online: online,
      warning: online === false ? offlineWarning : null,
      message: 'Remote change queued. It is applied when the shop computer picks it up; watch the status.',
    };
  }

  const requestSeed = (requestId: unknown) => (typeof requestId === 'string' && isValidUuid(requestId) ? requestId.toLowerCase() : null);

  r.post('/admin/commands/:action', requireAdmin, commandRateLimit, route('POST /admin/commands', async (req, res) => {
    const type = ACTIONS[String(req.params.action)];
    if (!type) throw new HttpError(404, `Unknown remote action "${req.params.action}".`);
    if (isAllShopsScope(req)) {
      throw new HttpError(409, 'All Shops is a read-only view. Select one shop to change it, or use "Apply to all shops" where it is offered.', { code: 'ALL_SHOPS_READ_ONLY' });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    // Optional client request id: the SAME phone request retried (bad network) queues ONE command.
    const seed = requestSeed(body.request_id);
    delete body.request_id;
    const out = await queueForShop(req, deps.shopId(req), type, body, seed);
    res.status(202);
    return out;
  }));

  /**
   * APPLY TO ALL SHOPS (Global Administrator only; catalogue prices/details, categories, settings):
   * ONE independent shop-scoped command per active shop, never one cross-shop command. A medicine
   * is identified in each shop by its barcode (medicine ids differ per shop); a shop without exactly
   * one matching medicine is SKIPPED and reported. Each shop's command carries that shop's own current
   * cloud values as `expected`, so a shop with newer local changes rejects instead of being overwritten.
   */
  r.post('/admin/all-shops/commands/:action', requireAdmin, commandRateLimit, route('POST /admin/all-shops/commands', async (req, res) => {
    if (!deps.isGlobalAdmin(req.onlineUser)) throw new HttpError(403, 'Forbidden: only a Global Administrator can apply a change to all shops.');
    const type = ACTIONS[String(req.params.action)];
    if (!type || !ALL_SHOPS_TYPES.includes(type)) {
      throw new HttpError(400, `"${req.params.action}" cannot be applied to all shops (allowed: prices, medicine details, categories, settings).`);
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    const seed = requestSeed(body.request_id) || crypto.randomUUID();
    delete body.request_id;
    const sourceShop = typeof body.source_shop_id === 'string' ? body.source_shop_id.toLowerCase() : '';
    delete body.source_shop_id;
    delete body.expected; // each shop gets its own expectation below
    validateCommandPayload(type, body); // the request itself must be valid before anything is queued
    const shops = (await deps.withCloud((c) => c.query('SELECT shop_id, shop_code, name FROM giga_cloud.shops WHERE active ORDER BY shop_code, shop_id'))).rows;

    let barcode: string | null = null;
    if (body.medicine_id) {
      if (!isValidUuid(sourceShop) || !shops.some((x: any) => x.shop_id === sourceShop)) {
        throw new HttpError(400, 'source_shop_id (the shop whose medicine you selected) is required and must be an active shop.');
      }
      const src = (await deps.withShopId(sourceShop, (c) => c.query('SELECT name, barcode FROM medicines WHERE id = $1', [body.medicine_id]))).rows[0];
      if (!src) throw new HttpError(404, 'Medicine not found in the source shop.');
      barcode = typeof src.barcode === 'string' && src.barcode.trim() ? src.barcode.trim() : null;
      if (!barcode) throw new HttpError(409, 'This medicine has no barcode, so it cannot be matched in other shops. Change each shop separately.');
    }
    const fields = Object.keys(body).filter((k) => !['medicine_id', 'reason'].includes(k));
    const allowed: readonly string[] = type === 'PRICE_UPDATE' ? PRICE_FIELDS : METADATA_FIELDS;
    const results: Record<string, any>[] = [];
    for (const shop of shops) {
      const one: Record<string, any> = { shop_id: shop.shop_id, shop_code: shop.shop_code, shop_name: shop.name };
      try {
        const shopBody: Record<string, any> = { ...body };
        if (barcode) {
          const found = (await deps.withShopId(shop.shop_id, (c) => c.query(
            `SELECT id FROM medicines WHERE lower(btrim(barcode)) = lower($1) LIMIT 2`, [barcode]))).rows;
          if (found.length !== 1) {
            results.push({ ...one, status: 'SKIPPED', reason: found.length ? 'more than one medicine has this barcode' : 'no medicine with this barcode' });
            continue;
          }
          // Normalized exactly like the shop reads it (same SELECT), so the comparison is like for like.
          const m: Record<string, any> = (await deps.withShopId(shop.shop_id, (c) => getMedicineById(found[0].id, c)))!;
          shopBody.medicine_id = m.id;
          // This shop's own current values (its cloud copy) are the expectation for this shop.
          const exp = Object.fromEntries(fields.filter((f) => allowed.includes(f)).map((f) => [f, m[f] === undefined ? null : m[f]]));
          if (Object.keys(exp).length) shopBody.expected = exp;
        }
        const q = await queueForShop(req, shop.shop_id, type, shopBody, seed, { fanout_group: seed, applied_to: 'ALL_SHOPS' });
        results.push({ ...one, status: 'QUEUED', command_id: q.command_id, duplicate: q.duplicate, shop_online: q.shop_online, warning: q.warning });
      } catch (err: any) {
        results.push({ ...one, status: 'SKIPPED', reason: err instanceof HttpError ? err.message : 'cloud error' });
      }
    }
    await deps.securityEvent(req, 'REMOTE_COMMAND_ALL_SHOPS', req.onlineUser.email, req.onlineUser.id, {
      command_type: type, fanout_group: seed, queued: results.filter((x) => x.status === 'QUEUED').length, skipped: results.filter((x) => x.status === 'SKIPPED').length,
    });
    res.status(202);
    return { command_type: type, fanout_group: seed, results };
  }));

  r.get('/admin/commands', requireAdmin, route('GET /admin/commands', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    const statuses = status ? status.split(',').filter((s: string) => ['PENDING', 'DELIVERED', 'APPLIED', 'REJECTED'].includes(s)) : [];
    const rows = await commandQuery(deps, `shop_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))`,
      [deps.shopId(req), statuses.length ? statuses : null, limit], 'ORDER BY created_at DESC LIMIT $3');
    return { commands: rows.map(toCommand) };
  }));

  r.get('/admin/commands/:id', requireAdmin, route('GET /admin/commands/:id', async (req) => {
    if (!isValidUuid(req.params.id)) throw new HttpError(400, 'Command id must be a UUID.');
    const row = (await commandQuery(deps, 'command_id = $1 AND shop_id = $2', [req.params.id, deps.shopId(req)]))[0];
    if (!row) throw new HttpError(404, 'Command not found.');
    return toCommand(row);
  }));

  // ------------------------------------------------------------------ health
  async function commandCounts(c: pg.PoolClient, shopId: string | null) {
    return (await c.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
              COUNT(*) FILTER (WHERE status = 'APPLIED')::int AS applied,
              COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              MIN(created_at) FILTER (WHERE status IN ('PENDING', 'DELIVERED')) AS oldest_open_at,
              MAX(acked_at) FILTER (WHERE status = 'APPLIED') AS last_applied_at,
              MAX(acked_at) FILTER (WHERE status = 'REJECTED') AS last_rejected_at
         FROM giga_cloud.commands WHERE shop_id = $1`, [shopId])).rows[0];
  }

  r.get('/admin/remote-status', requireAdmin, route('GET /admin/remote-status', async (req) => {
    const shopId = deps.shopId(req);
    const rt = await runtimeRow(deps, shopId);
    return deps.withCloud(async (c) => {
      const shop = (await c.query(
        `SELECT shop_code, name, active, last_seen_at, last_event_at, events_received::bigint AS events_received, now() AS server_time,
                (last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(secs => $2)) AS in_contact
           FROM giga_cloud.shops WHERE shop_id = $1`, [shopId, CONTACT_WINDOW_SECONDS]
      )).rows[0];
      const counts = await commandCounts(c, shopId);
      const last = (await c.query(
        `SELECT command_id, command_type, acked_at FROM giga_cloud.commands
          WHERE shop_id = $1 AND status = 'APPLIED' ORDER BY acked_at DESC NULLS LAST LIMIT 1`, [shopId]
      )).rows[0];
      const heartbeat = rt ? rt.age_seconds <= HEARTBEAT_ONLINE_SECONDS : null;
      return {
        shop_id: shopId,
        shop_registered: Boolean(shop),
        shop_active: shop?.active ?? false,
        shop_code: shop?.shop_code ?? null,
        shop_name: shop?.name ?? null,
        // Heartbeat age decides ONLINE when the shop sends heartbeats; otherwise last RPC contact.
        shop_in_contact: heartbeat ?? Boolean(shop?.in_contact),
        online_basis: heartbeat === null ? 'last_contact' : 'heartbeat',
        contact_window_seconds: heartbeat === null ? CONTACT_WINDOW_SECONDS : HEARTBEAT_ONLINE_SECONDS,
        last_heartbeat_at: rt?.reported_at ?? null,
        heartbeat_age_seconds: rt?.age_seconds ?? null,
        last_shop_contact_at: shop?.last_seen_at ?? null,
        last_shop_event_at: shop?.last_event_at ?? null,
        last_sync_at: rt?.last_sync_at ?? shop?.last_event_at ?? null,
        events_received: shop ? Number(shop.events_received) : 0,
        server_time: shop?.server_time ?? new Date().toISOString(),
        commands: counts,
        last_successful_command: last ? { command_id: last.command_id, command_type: last.command_type, applied_at: last.acked_at } : null,
      };
    });
  }));

  r.get('/admin/shop-health', requireAdmin, route('GET /admin/shop-health', async (req) => {
    const shopId = deps.shopId(req);
    const rt = await runtimeRow(deps, shopId);
    const ctl = await deps.getRemoteControl(shopId, true);
    const counts = await deps.withCloud((c) => commandCounts(c, shopId));
    if (rt === undefined) return { heartbeat_supported: false, online: null, message: 'Apply cloud migration 004 to receive shop heartbeats.', commands: counts, controls: ctl };
    if (!rt) return { heartbeat_supported: true, online: false, message: 'The shop computer has not sent a heartbeat yet.', commands: counts, controls: ctl };
    const s = rt.status || {};
    return {
      heartbeat_supported: true,
      online: rt.age_seconds <= HEARTBEAT_ONLINE_SECONDS,
      online_threshold_seconds: HEARTBEAT_ONLINE_SECONDS,
      last_heartbeat_at: rt.reported_at,
      heartbeat_age_seconds: rt.age_seconds,
      device_id: rt.device_id,
      app_version: rt.app_version,
      git_commit: rt.git_commit,
      mode: rt.mode,
      server_started_at: rt.started_at,
      uptime_seconds: rt.uptime_seconds !== null ? Number(rt.uptime_seconds) : null,
      database: rt.db_healthy ? 'HEALTHY' : 'UNAVAILABLE',
      sync: rt.worker_healthy ? 'HEALTHY' : 'FAILING',
      worker: s.worker ?? null,
      pending_uploads: rt.outbound_pending,
      failed_events: rt.outbound_failed,
      unacknowledged_commands: rt.inbound_unacked,
      last_sync_at: rt.last_sync_at,
      last_error: s.last_error ?? null,
      disk: rt.disk_total_bytes ? { free_bytes: Number(rt.disk_free_bytes), total_bytes: Number(rt.disk_total_bytes) } : null,
      backup: rt.backup ?? null,
      remote_backup: s.remote_backup ?? null,
      update: rt.update_state ?? null,
      restarts_last_hour: s.restarts_last_hour ?? null,
      inventory: rt.inventory ?? null,
      commands: counts,
      controls: ctl,
    };
  }));

  // ------------------------------------------------------------------ SYNC & CONFLICT CONTROL CENTER
  /**
   * Per shop: contact, heartbeat, last sync, shop outbox sequence vs the cloud's highest processed
   * sequence, outbox / command counts, installed version, device, last backup. Global Administrator:
   * every active shop; a shop Administrator: their own. Read only.
   */
  r.get('/admin/sync-center', requireAdmin, route('GET /admin/sync-center', async (req) => {
    const global = deps.isGlobalAdmin(req.onlineUser);
    const shops = (await deps.withCloud((c) => (global
      ? c.query('SELECT shop_id, shop_code, name FROM giga_cloud.shops WHERE active ORDER BY shop_code, shop_id')
      : c.query('SELECT shop_id, shop_code, name FROM giga_cloud.shops WHERE shop_id = $1', [deps.shopId(req)])))).rows;
    const out: Record<string, unknown>[] = [];
    for (const s of shops) {
      const rt = await runtimeRow(deps, s.shop_id);
      const st = rt?.status || {};
      const row = await deps.withCloud(async (c) => {
        const counts = await commandCounts(c, s.shop_id);
        const extra = (await c.query(
          `SELECT (SELECT MAX(local_seq) FROM giga_cloud.processed_events WHERE shop_id = $1)::bigint AS cloud_last_seq,
                  (SELECT COUNT(*) FROM giga_cloud.commands WHERE shop_id = $1 AND status = 'REJECTED' AND acked_at > now() - interval '7 days')::int AS rejected_7d,
                  (SELECT COUNT(*) FROM giga_cloud.rejected_events WHERE shop_id = $1 AND rejected_at > now() - interval '7 days')::int AS cloud_rejected_events_7d`,
          [s.shop_id])).rows[0];
        return { counts, extra };
      });
      const shopSeq = st.outbound?.last_seq ?? null;
      const cloudSeq = row.extra.cloud_last_seq !== null ? Number(row.extra.cloud_last_seq) : null;
      out.push({
        shop_id: s.shop_id, shop_code: s.shop_code, name: s.name,
        online: rt ? rt.age_seconds <= HEARTBEAT_ONLINE_SECONDS : false, last_heartbeat_at: rt?.reported_at ?? null, heartbeat_age_seconds: rt?.age_seconds ?? null,
        last_sync_at: rt?.last_sync_at ?? null, shop_last_seq: shopSeq, shop_last_synced_seq: st.outbound?.last_synced_seq ?? null, cloud_last_seq: cloudSeq,
        sequence_gap: shopSeq !== null && cloudSeq !== null ? Math.max(0, shopSeq - cloudSeq) : null,
        outbox_pending: rt?.outbound_pending ?? null, outbox_failed: rt?.outbound_failed ?? null, commands_unacknowledged_at_shop: rt?.inbound_unacked ?? null,
        commands_pending: row.counts.pending, commands_delivered: row.counts.delivered, commands_rejected_7d: row.extra.rejected_7d,
        cloud_rejected_events_7d: row.extra.cloud_rejected_events_7d, last_error: safeError(st.last_error ?? null),
        sync_protocol_version: st.sync_protocol_version ?? 2,
        stock_mismatch_count: st.inventory?.stock_mismatch_count ?? 0,
        catalogue_mismatch_count: st.inventory?.stock_mismatch ?? 0,
        installed_commit: rt?.git_commit ?? null, app_version: rt?.app_version ?? null, update_status: rt?.update_state?.status ?? null,
        available_commit: rt?.update_state?.available_commit ?? null, device_id: rt?.device_id ?? null,
        last_backup_at: rt?.backup?.last_success_at ?? null, backup_age_hours: rt?.backup?.age_hours ?? null, backup_verified: rt?.backup?.last_success_verified ?? null,
      });
    }
    return { shops: out, server_time: new Date().toISOString() };
  }));

  /** Rejected commands and cloud-rejected events of the selected shop, with a plain conflict reason. */
  r.get('/admin/sync-center/issues', requireAdmin, route('GET /admin/sync-center/issues', async (req) => {
    const shopId = deps.shopId(req);
    return deps.withCloud(async (c) => {
      const commands = (await c.query(
        `SELECT command_id, command_type, status, error, created_at, acked_at, display, payload
           FROM giga_cloud.commands WHERE shop_id = $1 AND status IN ('REJECTED', 'EXPIRED') ORDER BY COALESCE(acked_at, created_at) DESC LIMIT 100`, [shopId])).rows;
      const events = (await c.query(
        `SELECT id, event_type, error, rejected_at FROM giga_cloud.rejected_events WHERE shop_id = $1 ORDER BY rejected_at DESC LIMIT 100`, [shopId])).rows;
      const retried = new Set((await c.query(
        `SELECT display->>'retry_of' AS r FROM giga_cloud.commands WHERE shop_id = $1 AND display ? 'retry_of'`, [shopId])).rows.map((x: any) => x.r));
      return {
        commands: commands.map((x: any) => ({
          command_id: x.command_id, command_type: x.command_type, status: x.status, error: safeError(x.error), created_at: x.created_at, acked_at: x.acked_at,
          conflict: classifyConflict(x.command_type, x.error), already_retried: retried.has(String(x.command_id)),
          entity: commandEntity(x.command_type, x.payload),
        })),
        rejected_events: events.map((x: any) => ({ id: Number(x.id), event_type: x.event_type, error: safeError(x.error), rejected_at: x.rejected_at, conflict: classifyConflict(x.event_type, x.error) })),
      };
    });
  }));

  /** Rejected Changes Center: Full list of rejected events with safe preview and clear category */
  r.get('/admin/sync/rejected-changes', requireAdmin, route('GET /admin/sync/rejected-changes', async (req) => {
    const global = deps.isGlobalAdmin(req.onlineUser);
    const shopId = isAllShopsScope(req) && global ? null : deps.shopId(req);

    return deps.withCloud(async (c) => {
      const q = shopId
        ? `SELECT r.id, r.shop_id, r.idempotency_key, r.event_type, r.error, r.payload, r.rejected_at,
                  s.shop_code, s.name AS shop_name,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             JOIN giga_cloud.shops s ON s.shop_id = r.shop_id
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            WHERE r.shop_id = $1
            ORDER BY r.rejected_at DESC LIMIT 200`
        : `SELECT r.id, r.shop_id, r.idempotency_key, r.event_type, r.error, r.payload, r.rejected_at,
                  s.shop_code, s.name AS shop_name,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             JOIN giga_cloud.shops s ON s.shop_id = r.shop_id
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            ORDER BY r.rejected_at DESC LIMIT 200`;
      const params = shopId ? [shopId] : [];
      const res = await c.query(q, params);

      const items = res.rows.map((row: any) => {
        const p = row.payload || {};
        const classification = classifyRejection(row.event_type, row.error);
        const cloudStatus = row.already_processed ? 'PROCESSED' : 'REJECTED';
        const preview = sanitizePayloadPreview(row.event_type, p);

        return {
          id: String(row.id),
          shop_id: row.shop_id,
          shop_code: row.shop_code,
          shop_name: row.shop_name,
          idempotency_key: row.idempotency_key,
          event_type: row.event_type,
          entity_type: p.entity_type || (row.event_type.startsWith('SALE') ? 'sale' : row.event_type.startsWith('MEDICINE') ? 'medicine' : 'entity'),
          entity_id: p.entity_id || null,
          local_seq: p.local_seq != null ? Number(p.local_seq) : null,
          business_ref: p.business_ref || null,
          device_id: p.device_id || null,
          actor_name: p.actor_name || null,
          created_at: p.occurred_at || row.rejected_at,
          rejected_at: row.rejected_at,
          cloud_status: cloudStatus,
          rejection: {
            category: classification.category,
            human_reason: classification.human_reason,
            technical_error: classification.technical_error,
            is_eligible_for_retry: classification.is_eligible_for_retry,
            is_permanent_failure: classification.is_permanent_failure,
          },
          sanitized_preview: preview,
        };
      });

      return {
        total: items.length,
        items,
      };
    });
  }));

  /** Safe Retry Preview: prechecks rejected events before retry */
  r.post('/admin/sync/rejected-changes/preview', requireAdmin, route('POST /admin/sync/rejected-changes/preview', async (req) => {
    if (!deps.isGlobalAdmin(req.onlineUser)) {
      throw new HttpError(403, 'Forbidden: Global Administrator only.', { code: 'GLOBAL_ADMIN_ONLY' });
    }
    const ids = Array.isArray(req.body?.event_ids) ? req.body.event_ids.map(String) : [];
    const all = req.body?.all === true;
    const shopId = deps.shopId(req);

    return deps.withCloud(async (c) => {
      const q = all
        ? `SELECT r.id, r.shop_id, r.idempotency_key, r.event_type, r.error, r.payload, r.rejected_at,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            WHERE r.shop_id = $1`
        : `SELECT r.id, r.shop_id, r.idempotency_key, r.event_type, r.error, r.payload, r.rejected_at,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            WHERE r.shop_id = $1 AND (r.id::text = ANY($2::text[]) OR r.idempotency_key = ANY($2::text[]))`;
      const params = all ? [shopId] : [shopId, ids];
      const rows = (await c.query(q, params)).rows;

      let alreadyProcessedCount = 0;
      let safeToRetryCount = 0;
      let stillIncompatibleCount = 0;
      let permanentFailuresCount = 0;
      let conflictsReviewRequiredCount = 0;

      const previewItems = rows.map((r: any) => {
        const classification = classifyRejection(r.event_type, r.error);
        const isProcessed = Boolean(r.already_processed);

        if (isProcessed) {
          alreadyProcessedCount++;
        } else if (classification.is_permanent_failure) {
          permanentFailuresCount++;
        } else if (classification.category === 'PROTOCOL_INCOMPATIBLE' || classification.category === 'UNSUPPORTED_EVENT_TYPE') {
          stillIncompatibleCount++;
        } else if (classification.category === 'CONCURRENCY_CONFLICT') {
          conflictsReviewRequiredCount++;
        } else if (classification.is_eligible_for_retry) {
          safeToRetryCount++;
        } else {
          conflictsReviewRequiredCount++;
        }

        return {
          id: String(r.id),
          idempotency_key: r.idempotency_key,
          event_type: r.event_type,
          cloud_status: isProcessed ? 'PROCESSED' : 'REJECTED',
          category: classification.category,
          human_reason: classification.human_reason,
          safe_to_retry: classification.is_eligible_for_retry && !isProcessed,
          already_processed: isProcessed,
        };
      });

      return {
        selected: rows.length,
        already_processed_count: alreadyProcessedCount,
        safe_to_retry_count: safeToRetryCount,
        still_incompatible_count: stillIncompatibleCount,
        permanent_failures_count: permanentFailuresCount,
        conflicts_review_required_count: conflictsReviewRequiredCount,
        items: previewItems,
      };
    });
  }));

  /** Global Admin manual retry of rejected events (gated server-side) */
  r.post('/admin/sync/rejected-changes/retry', requireAdmin, commandRateLimit, route('POST /admin/sync/rejected-changes/retry', async (req) => {
    if (!deps.isGlobalAdmin(req.onlineUser)) {
      throw new HttpError(403, 'Forbidden: Only Global Administrators may retry rejected changes.', { code: 'GLOBAL_ADMIN_ONLY' });
    }
    const ids = Array.isArray(req.body?.event_ids) ? req.body.event_ids.map(String) : [];
    const allEligible = req.body?.all_eligible === true;
    const shopId = deps.shopId(req);

    return deps.withCloud(async (c) => {
      const q = allEligible
        ? `SELECT r.id, r.idempotency_key, r.event_type, r.error, r.payload,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            WHERE r.shop_id = $1`
        : `SELECT r.id, r.idempotency_key, r.event_type, r.error, r.payload,
                  p.idempotency_key IS NOT NULL AS already_processed
             FROM giga_cloud.rejected_events r
             LEFT JOIN giga_cloud.processed_events p ON p.shop_id = r.shop_id AND p.idempotency_key = r.idempotency_key
            WHERE r.shop_id = $1 AND (r.id::text = ANY($2::text[]) OR r.idempotency_key = ANY($2::text[]))`;
      const params = allEligible ? [shopId] : [shopId, ids];
      const rows = (await c.query(q, params)).rows;

      if (rows.length === 0) {
        return { success: true, retried_count: 0, already_applied_count: 0, message: 'No matching rejected events found.' };
      }

      const alreadyProcessedKeys: string[] = [];
      const eligibleToRetryKeys: string[] = [];
      const eligibleEventIds: string[] = [];

      for (const r of rows) {
        if (r.already_processed) {
          alreadyProcessedKeys.push(r.idempotency_key);
        } else {
          const classification = classifyRejection(r.event_type, r.error);
          if (classification.is_eligible_for_retry) {
            eligibleToRetryKeys.push(r.idempotency_key);
            const evId = r.payload?.event_id;
            if (evId && isValidUuid(evId)) eligibleEventIds.push(evId);
          }
        }
      }

      // Clean up already processed events from cloud rejected_events (zero retransmissions)
      if (alreadyProcessedKeys.length > 0) {
        await c.query(
          `DELETE FROM giga_cloud.rejected_events WHERE shop_id = $1 AND idempotency_key = ANY($2::text[])`,
          [shopId, alreadyProcessedKeys]
        );
      }

      // If eligible events to retry, queue SYNC_RETRY_FAILED command to shop
      let commandId: string | null = null;
      if (eligibleToRetryKeys.length > 0 || eligibleEventIds.length > 0) {
        const cmdPayload: any = {
          reason: `Global Admin manual retry of ${eligibleToRetryKeys.length} rejected event(s)`,
        };
        if (eligibleEventIds.length > 0 && !allEligible) {
          cmdPayload.event_ids = eligibleEventIds;
        }
        const queued = await queueForShop(req, shopId, 'SYNC_RETRY_FAILED', cmdPayload, crypto.randomUUID());
        commandId = queued.command_id;
      }

      // Audit log: GLOBAL_ADMIN_SYNC_RETRY
      await deps.securityEvent(
        req,
        'GLOBAL_ADMIN_SYNC_RETRY',
        req.onlineUser.email,
        req.onlineUser.id,
        {
          shop_id: shopId,
          total_selected: rows.length,
          already_applied_count: alreadyProcessedKeys.length,
          retried_count: eligibleToRetryKeys.length,
          command_id: commandId,
        }
      );

      return {
        success: true,
        total_selected: rows.length,
        already_applied_count: alreadyProcessedKeys.length,
        retried_count: eligibleToRetryKeys.length,
        command_id: commandId,
        message: `Processed ${alreadyProcessedKeys.length} already-applied event(s); queued retry for ${eligibleToRetryKeys.length} eligible event(s).`,
      };
    });
  }));

  /**
   * RETRY a REJECTED / EXPIRED command: ONE new command with the same (re-validated) payload, linked by
   * display.retry_of. A rejected command changed nothing, so this can never apply a change twice; a
   * second retry of the same command is refused. Staff account commands are retried from User
   * management (they also change the cloud login), never here.
   */
  r.post('/admin/commands/:id/retry', requireAdmin, commandRateLimit, route('POST /admin/commands/:id/retry', async (req) => {
    if (!isValidUuid(req.params.id)) throw new HttpError(400, 'Command id must be a UUID.');
    if (isAllShopsScope(req)) throw new HttpError(409, 'Select the command\'s shop to retry it.', { code: 'ALL_SHOPS_READ_ONLY' });
    const shopId = deps.shopId(req);
    const orig = (await deps.withCloud((c) => c.query(
      `SELECT command_id, command_type, status, payload FROM giga_cloud.commands WHERE command_id = $1 AND shop_id = $2`, [req.params.id, shopId]))).rows[0];
    if (!orig) throw new HttpError(404, 'Command not found for the selected shop.');
    if (!['REJECTED', 'EXPIRED'].includes(orig.status)) throw new HttpError(409, `Only a REJECTED or EXPIRED command can be retried (this one is ${orig.status}).`);
    if (String(orig.command_type).startsWith('USER_') || orig.command_type === 'APP_UPDATE_APPROVE') {
      throw new HttpError(409, 'Staff account and update approvals are retried from their own screens (User management / Software updates).');
    }
    const already = (await deps.withCloud((c) => c.query(
      `SELECT 1 FROM giga_cloud.commands WHERE shop_id = $1 AND display->>'retry_of' = $2 LIMIT 1`, [shopId, String(orig.command_id)]))).rows[0];
    if (already) throw new HttpError(409, 'This command was already retried.');
    const body = { ...orig.payload };
    const createField = CREATE_ID_FIELD[orig.command_type as CommandType];
    if (createField) delete body[createField];
    const out = await queueForShop(req, shopId, orig.command_type as CommandType, body, null, { retry_of: String(orig.command_id) });
    await deps.securityEvent(req, 'REMOTE_COMMAND_RETRIED', req.onlineUser.email, req.onlineUser.id, { retry_of: orig.command_id, command_id: out.command_id, command_type: orig.command_type });
    return out;
  }));

  // ------------------------------------------------------------------ GLOBAL CONTROL CENTER
  /**
   * Per-shop health and business figures from the cloud copy, plus consolidated totals. A Global
   * Administrator sees every active shop; a shop Administrator only their own. Each shop is computed
   * in its own shop-scoped read-only transaction; one failing shop never hides the others.
   */
  r.get('/admin/overview', requireAdmin, route('GET /admin/overview', async (req) => {
    const global = deps.isGlobalAdmin(req.onlineUser);
    const shops = (await deps.withCloud((c) => (global
      ? c.query('SELECT shop_id, shop_code, name, last_seen_at, last_event_at FROM giga_cloud.shops WHERE active ORDER BY shop_code, shop_id')
      : c.query('SELECT shop_id, shop_code, name, last_seen_at, last_event_at FROM giga_cloud.shops WHERE shop_id = $1', [deps.shopId(req)])))).rows;
    const out: Record<string, any>[] = [];
    for (const s of shops) {
      const row: Record<string, any> = { shop_id: s.shop_id, shop_code: s.shop_code, name: s.name };
      try {
        const rt = await runtimeRow(deps, s.shop_id);
        const counts = await deps.withCloud((c) => commandCounts(c, s.shop_id));
        const rejected7d = (await deps.withCloud((c) => c.query(
          `SELECT COUNT(*)::int AS n FROM giga_cloud.commands WHERE shop_id = $1 AND status = 'REJECTED' AND acked_at > now() - interval '7 days'`, [s.shop_id]))).rows[0].n;
        const m = await deps.withShopId(s.shop_id, async (c) => {
          const sales = (await c.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS total FROM sales
              WHERE date = (now() AT TIME ZONE 'Africa/Nairobi')::date AND status <> 'voided'`)).rows[0];
          const stock = (await c.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                    COUNT(*) FILTER (WHERE status <> 'active')::int AS inactive,
                    COALESCE(SUM(current_stock) FILTER (WHERE status = 'active'), 0)::bigint AS units,
                    COALESCE(SUM(current_stock * COALESCE(purchase_price, 0)) FILTER (WHERE status = 'active'), 0)::float AS cost_value,
                    COALESCE(SUM(current_stock * COALESCE(selling_price, 0)) FILTER (WHERE status = 'active'), 0)::float AS retail_value,
                    COUNT(*) FILTER (WHERE status = 'active' AND current_stock <= 0)::int AS out_of_stock,
                    COUNT(*) FILTER (WHERE status = 'active' AND current_stock > 0 AND current_stock <= COALESCE(reorder_level, 0))::int AS low_stock
               FROM medicines`)).rows[0];
          const expiry = (await c.query(
            `SELECT COUNT(*) FILTER (WHERE expiry_date > CURRENT_DATE AND expiry_date <= CURRENT_DATE + 30)::int AS expiring_30d,
                    COUNT(*) FILTER (WHERE expiry_date <= CURRENT_DATE)::int AS expired
               FROM medicine_batches WHERE quantity_available > 0 AND expiry_date IS NOT NULL`)).rows[0];
          const staff = (await c.query(`SELECT COUNT(*) FILTER (WHERE active)::int AS active FROM users WHERE email IS NOT NULL`)).rows[0];
          return { sales, stock, expiry, staff };
        });
        Object.assign(row, {
          online: rt ? rt.age_seconds <= HEARTBEAT_ONLINE_SECONDS : rt === null ? false : null,
          last_heartbeat_at: rt?.reported_at ?? null,
          heartbeat_age_seconds: rt?.age_seconds ?? null,
          db_healthy: rt ? Boolean(rt.db_healthy) : null,
          sync_healthy: rt ? Boolean(rt.worker_healthy) : null,
          last_sync_at: rt?.last_sync_at ?? s.last_event_at ?? null,
          app_version: rt?.app_version ?? null,
          git_commit: rt?.git_commit ?? null,
          sales_today: { count: m.sales.n, total: Math.round(m.sales.total * 100) / 100 },
          catalogue: { total: m.stock.total, active: m.stock.active, inactive: m.stock.inactive },
          stock_units: Number(m.stock.units),
          stock_cost_value: Math.round(m.stock.cost_value * 100) / 100,
          stock_retail_value: Math.round(m.stock.retail_value * 100) / 100,
          low_stock: m.stock.low_stock,
          out_of_stock: m.stock.out_of_stock,
          expiring_30d: m.expiry.expiring_30d,
          expired_with_stock: m.expiry.expired,
          active_staff: m.staff.active,
          pending_commands: Number(counts.pending) + Number(counts.delivered),
          rejected_commands_7d: rejected7d,
          error: null,
        });
      } catch (err: any) {
        row.error = err instanceof HttpError ? err.message : 'Could not read this shop from the cloud copy.';
      }
      out.push(row);
    }
    const ok = out.filter((x) => !x.error);
    const sum = (f: (x: any) => number) => Math.round(ok.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;
    return {
      scope: global ? 'GLOBAL' : 'SHOP',
      generated_at: new Date().toISOString(),
      shops: out,
      totals: {
        shops: out.length,
        shops_online: out.filter((x) => x.online === true).length,
        sales_today_count: sum((x) => x.sales_today.count),
        sales_today_total: sum((x) => x.sales_today.total),
        stock_units: sum((x) => x.stock_units),
        stock_cost_value: sum((x) => x.stock_cost_value),
        stock_retail_value: sum((x) => x.stock_retail_value),
        low_stock: sum((x) => x.low_stock),
        out_of_stock: sum((x) => x.out_of_stock),
        expiring_30d: sum((x) => x.expiring_30d),
        active_staff: sum((x) => x.active_staff),
        pending_commands: sum((x) => x.pending_commands),
        rejected_commands_7d: sum((x) => x.rejected_commands_7d),
      },
    };
  }));

  // ------------------------------------------------------------------ ALL SHOPS stock comparison
  /**
   * Global Administrator, All Shops: one row per medicine (matched across shops by barcode, else by
   * exact normalized name), with EACH shop's own stock side by side. Read only; each shop is read in its
   * own shop-scoped transaction; nothing is summed except the separate, labelled `combined` value.
   */
  r.get('/admin/stock-comparison', requireAdmin, route('GET /admin/stock-comparison', async (req) => {
    if (!deps.isGlobalAdmin(req.onlineUser)) throw new HttpError(403, 'Forbidden: only a Global Administrator can compare shops.');
    const shops = (await deps.withCloud((c) => c.query('SELECT shop_id, shop_code, name FROM giga_cloud.shops WHERE active ORDER BY shop_code, shop_id'))).rows;
    const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[-/.,()+_:;'"]/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = new Map<string, any>();
    for (const shop of shops) {
      const meds = await deps.withShopId(shop.shop_id, (c) => getAllMedicines(c));
      for (const m of meds) {
        const key = m.barcode && String(m.barcode).trim() ? `b:${norm(m.barcode)}` : `n:${norm(m.name)}`;
        const row = rows.get(key) || { key, name: m.name, barcode: m.barcode || null, category: m.category || null, per_shop: {} as Record<string, any> };
        row.per_shop[shop.shop_id] = { medicine_id: m.id, name: m.name, stock: Number(m.current_stock) || 0, reorder_level: Number(m.reorder_level) || 0, status: m.status, retail: m.selling_price };
        rows.set(key, row);
      }
    }
    const out = [...rows.values()].map((x) => ({ ...x, combined: Object.values(x.per_shop).reduce((t: number, v: any) => t + v.stock, 0) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { shops: shops.map((x: any) => ({ shop_id: x.shop_id, shop_code: x.shop_code, name: x.name })), rows: out, match_rule: 'barcode, else exact name' };
  }));

  // ------------------------------------------------------------------ alerts
  r.get('/admin/alerts', requireAdmin, route('GET /admin/alerts', async (req) => {
    const shopId = deps.shopId(req);
    const which = String(req.query.status || 'open').toLowerCase();
    try {
      return await deps.withCloud(async (c) => {
        await c.query('SELECT giga_cloud.refresh_cloud_alerts($1, $2)', [shopId, HEARTBEAT_ONLINE_SECONDS]);
        // Cashier shift alerts (cloud migration 009): SHIFT_LEFT_OPEN / SHIFT_NOT_CLOSED. Variance alerts
        // (SHIFT_SHORTAGE / SHIFT_OVERAGE) are raised when the SHIFT_CLOSED event arrives.
        await c.query('SELECT giga_cloud.refresh_shift_alerts($1)', [shopId]).catch((err: any) => {
          if (err?.code !== '42883') throw err; // not applied yet: no shift alerts
        });
        const rows = (await c.query(
          `SELECT id, alert_key, kind, severity, title, detail, source, status, first_seen_at, last_seen_at, acknowledged_by, acknowledged_at, resolved_at
             FROM giga_cloud.alerts WHERE shop_id = $1 AND ($2 = 'all' OR status <> 'RESOLVED')
            ORDER BY (status = 'RESOLVED'), CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 200`,
          [shopId, which === 'all' ? 'all' : 'open'])).rows;
        return { supported: true, alerts: rows.map((a) => ({ ...a, id: Number(a.id), detail: safeError(a.detail) })) };
      });
    } catch (err: any) {
      if (err?.code === '42P01' || err?.code === '42883') return { supported: false, alerts: [], message: 'Apply cloud migration 004 to enable alerts.' };
      throw err;
    }
  }));

  r.post('/admin/alerts/:id/ack', requireAdmin, securityRateLimit, route('POST /admin/alerts/:id/ack', async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Alert id must be a number.');
    const row = (await deps.withCloud((c) => c.query(
      `UPDATE giga_cloud.alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $3, acknowledged_at = now()
        WHERE id = $1 AND shop_id = $2 AND status = 'ACTIVE' RETURNING id, status`, [id, deps.shopId(req), req.onlineUser.email]))).rows[0];
    if (!row) throw new HttpError(404, 'No active alert with that id.');
    await deps.securityEvent(req, 'ALERT_ACKNOWLEDGED', req.onlineUser.email, req.onlineUser.id, { alert_id: id });
    return { id, status: row.status };
  }));

  // ------------------------------------------------------------------ inventory intelligence
  r.get('/admin/insights', requireAdmin, route('GET /admin/insights', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const coverDays = 30;
    return deps.withShop(req, async (c) => {
      const meds = (await c.query(
        `WITH sold AS (
           SELECT si.medicine_id, SUM(si.quantity)::int AS qty, SUM(si.total)::numeric AS revenue
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE s.status <> 'voided' AND s.date >= CURRENT_DATE - $1::int
            GROUP BY si.medicine_id),
         last_sale AS (
           SELECT si.medicine_id, MAX(s.date) AS last_sold
             FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status <> 'voided' GROUP BY si.medicine_id)
         SELECT m.id, m.name, m.current_stock, COALESCE(m.reorder_level, 0) AS reorder_level, m.selling_price, m.purchase_price,
                COALESCE(sold.qty, 0) AS qty, COALESCE(sold.revenue, 0)::float AS revenue, ls.last_sold
           FROM medicines m LEFT JOIN sold ON sold.medicine_id = m.id LEFT JOIN last_sale ls ON ls.medicine_id = m.id
          WHERE m.status = 'active'`, [days])).rows;
      const rows = meds.map((m: any) => {
        const stock = Number(m.current_stock) || 0;
        const velocity = Number(m.qty) / days;
        const cover = velocity > 0 ? stock / velocity : null;
        const target = Math.max(Math.ceil(velocity * coverDays), Number(m.reorder_level));
        const suggest = (stock <= Number(m.reorder_level) || (cover !== null && cover < 14)) ? Math.max(0, target - stock) : 0;
        return {
          id: m.id, name: m.name, stock, reorder_level: Number(m.reorder_level), sold_qty: Number(m.qty), revenue: Number(m.revenue),
          daily_rate: Math.round(velocity * 100) / 100, days_of_cover: cover === null ? null : Math.round(cover),
          last_sold: m.last_sold ? new Date(m.last_sold).toISOString().slice(0, 10) : null,
          cost_value: Math.round(stock * Number(m.purchase_price || 0) * 100) / 100, retail_value: Math.round(stock * Number(m.selling_price || 0) * 100) / 100,
          suggested_reorder_qty: suggest,
        };
      });
      const cut = (a: any[], n = 50) => a.slice(0, n);
      const deadCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const batches = (await c.query(
        `SELECT b.id, b.batch_number, b.quantity_available, b.expiry_date, b.purchase_price, m.name AS medicine_name, m.id AS medicine_id
           FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
          WHERE b.quantity_available > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + 90
          ORDER BY b.expiry_date`)).rows.map((b: any) => ({
            batch_id: b.id, medicine_id: b.medicine_id, medicine_name: b.medicine_name, batch_number: b.batch_number, quantity: Number(b.quantity_available),
            expiry_date: new Date(b.expiry_date).toISOString().slice(0, 10), cost_value: Math.round(Number(b.quantity_available) * Number(b.purchase_price || 0) * 100) / 100,
          }));
      const today = new Date().toISOString().slice(0, 10);
      const split = (await c.query(
        `SELECT COALESCE(price_mode, 'retail') AS mode, COUNT(*)::int AS sales, COALESCE(SUM(total), 0)::float AS total, COALESCE(SUM(gross_profit), 0)::float AS gross_profit
           FROM sales WHERE status <> 'voided' AND date >= CURRENT_DATE - $1::int GROUP BY 1 ORDER BY 1`, [days])).rows;
      return {
        generated_at: new Date().toISOString(),
        window_days: days,
        method: `Deterministic: sales of the last ${days} days from the cloud copy. Suggested reorder = enough for ${coverDays} days at the recent daily rate ` +
          '(never below the reorder level) minus current stock, shown only when stock is at/below the reorder level or under 14 days of cover. Suggestions only.',
        totals: {
          active_medicines: rows.length,
          stock_cost_value: Math.round(rows.reduce((s, x) => s + x.cost_value, 0) * 100) / 100,
          stock_retail_value: Math.round(rows.reduce((s, x) => s + x.retail_value, 0) * 100) / 100,
        },
        out_of_stock: cut(rows.filter((x) => x.stock <= 0).sort((a, b) => b.sold_qty - a.sold_qty)),
        low_stock: cut(rows.filter((x) => x.stock > 0 && x.stock <= x.reorder_level).sort((a, b) => a.stock - b.stock)),
        fast_moving: cut(rows.filter((x) => x.sold_qty > 0).sort((a, b) => b.sold_qty - a.sold_qty), 20),
        slow_moving: cut(rows.filter((x) => x.stock > 0 && x.sold_qty > 0 && (x.days_of_cover || 0) > 90).sort((a, b) => (b.days_of_cover || 0) - (a.days_of_cover || 0))),
        dead_stock: cut(rows.filter((x) => x.stock > 0 && (!x.last_sold || x.last_sold < deadCutoff)).sort((a, b) => b.cost_value - a.cost_value)),
        reorder_suggestions: cut(rows.filter((x) => x.suggested_reorder_qty > 0).sort((a, b) => (a.days_of_cover ?? -1) - (b.days_of_cover ?? -1))),
        expired: cut(batches.filter((b) => b.expiry_date <= today)),
        near_expiry: cut(batches.filter((b) => b.expiry_date > today)),
        retail_vs_wholesale: split,
      };
    });
  }));

  // ------------------------------------------------------------------ emergency controls / sessions
  // Online accounts an Administrator may see and manage for the request's shop ($1 = shop id):
  // a global Administrator: global accounts + that shop's accounts; a shop Administrator: only its shop's.
  const accountScope = (req: any) => (deps.isGlobalAdmin(req.onlineUser) ? '(shop_id IS NULL OR shop_id = $1)' : 'shop_id = $1');

  r.get('/admin/security', requireAdmin, route('GET /admin/security', async (req) => {
    const shopId = deps.shopId(req);
    const controls = await deps.getRemoteControl(shopId, true);
    return deps.withCloud(async (c) => {
      let users;
      try {
        users = (await c.query(
          `SELECT id, email, name, role, active, last_login_at, token_version FROM giga_cloud.online_users
            WHERE ${accountScope(req)} ORDER BY role, email`, [shopId])).rows;
      } catch (err: any) {
        if (err?.code !== '42703') throw err;
        users = (await c.query(`SELECT id, email, name, role, active, last_login_at FROM giga_cloud.online_users WHERE ${accountScope(req)} ORDER BY role, email`, [shopId])).rows;
      }
      const events = (await c.query(
        `SELECT at, user_email, action, command_type, client_ip FROM giga_cloud.online_audit WHERE shop_id = $1 ORDER BY at DESC LIMIT 50`, [shopId])).rows;
      return { controls, online_users: users, recent_events: events };
    });
  }));

  async function setControl(req: any, fields: Partial<RemoteControl>) {
    try {
      await deps.withCloud((c) => c.query(
        `INSERT INTO giga_cloud.remote_control (shop_id, remote_writes_enabled, maintenance_mode, maintenance_message, updated_by, updated_at)
         VALUES ($1, COALESCE($2, TRUE), COALESCE($3, FALSE), $4, $5, now())
         ON CONFLICT (shop_id) DO UPDATE SET remote_writes_enabled = COALESCE($2, giga_cloud.remote_control.remote_writes_enabled),
           maintenance_mode = COALESCE($3, giga_cloud.remote_control.maintenance_mode),
           maintenance_message = CASE WHEN $3 IS NULL THEN giga_cloud.remote_control.maintenance_message ELSE $4 END,
           updated_by = $5, updated_at = now()`,
        [deps.shopId(req), fields.remote_writes_enabled ?? null, fields.maintenance_mode ?? null, fields.maintenance_message ?? null, req.onlineUser.email]));
    } catch (err: any) {
      if (err?.code === '42P01') throw new HttpError(503, 'Apply cloud migration 004 to enable emergency controls.');
      throw err;
    }
    deps.clearRemoteControlCache(deps.shopId(req));
    return deps.getRemoteControl(deps.shopId(req), true);
  }

  const bool = (v: unknown, name: string) => {
    if (typeof v !== 'boolean') throw new HttpError(400, `${name} must be true or false.`);
    return v;
  };

  r.post('/admin/security/remote-writes', requireAdmin, securityRateLimit, route('POST /admin/security/remote-writes', async (req) => {
    const enabled = bool(req.body?.enabled, 'enabled');
    const out = await setControl(req, { remote_writes_enabled: enabled });
    await deps.securityEvent(req, enabled ? 'REMOTE_WRITES_ENABLED' : 'REMOTE_WRITES_DISABLED', req.onlineUser.email, req.onlineUser.id);
    return out;
  }));

  r.post('/admin/security/maintenance', requireAdmin, securityRateLimit, route('POST /admin/security/maintenance', async (req) => {
    const enabled = bool(req.body?.enabled, 'enabled');
    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 300) || null : null;
    const out = await setControl(req, { maintenance_mode: enabled, maintenance_message: message });
    await deps.securityEvent(req, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', req.onlineUser.email, req.onlineUser.id);
    return out;
  }));

  // Revokes online sessions: one account (user_id) or every account of this shop (all: true).
  r.post('/admin/security/revoke-sessions', requireAdmin, securityRateLimit, route('POST /admin/security/revoke-sessions', async (req) => {
    const all = req.body?.all === true;
    const userId = req.body?.user_id;
    if (!all && !isValidUuid(userId)) throw new HttpError(400, 'Give user_id (UUID) or all: true.');
    let n;
    try {
      n = (await deps.withCloud((c) => c.query(
        `UPDATE giga_cloud.online_users SET token_version = token_version + 1, updated_at = now()
          WHERE ${accountScope(req)} AND ($2::boolean OR id = $3::uuid)`, [deps.shopId(req), all, all ? null : userId]))).rowCount;
    } catch (err: any) {
      if (err?.code === '42703') throw new HttpError(503, 'Apply cloud migration 004 to enable session revocation.');
      throw err;
    }
    await deps.securityEvent(req, 'ONLINE_SESSIONS_REVOKED', req.onlineUser.email, req.onlineUser.id, { all, user_id: all ? null : userId, accounts: n });
    return { revoked_accounts: n, note: 'Revoked accounts must log in again (including yours if it was included).' };
  }));

  // Deactivates / reactivates an ONLINE account (compromised phone, departed staff).
  r.post('/admin/security/online-users/:id/active', requireAdmin, securityRateLimit, route('POST /admin/security/online-users/:id/active', async (req) => {
    if (!isValidUuid(req.params.id)) throw new HttpError(400, 'Account id must be a UUID.');
    const active = bool(req.body?.active, 'active');
    const shopId = deps.shopId(req);
    const out = await deps.withCloud(async (c) => {
      await c.query('BEGIN');
      try {
        const target = (await c.query(`SELECT id, email, role, active, local_user_id FROM giga_cloud.online_users WHERE ${accountScope(req).replace(/\$1/g, () => '$2')} AND id = $1 FOR UPDATE`,
          [req.params.id, shopId])).rows[0];
        if (!target) throw new HttpError(404, 'Online account not found.');
        // Emergency switch for the ONLINE login only (unchanged behaviour). For a shop staff login with
        // unified credential sync enabled, a later publish from the shop restores the shop's status:
        // a durable staff deactivation is done under User Management (it also deactivates at the shop).
        if (!active && target.role === 'ADMIN') {
          const others = (await c.query(`SELECT COUNT(*)::int AS n FROM giga_cloud.online_users WHERE role = 'ADMIN' AND active AND id <> $1 AND (shop_id IS NULL OR shop_id = $2)`,
            [target.id, shopId])).rows[0].n;
          if (others === 0) throw new HttpError(409, 'This is the last active online Administrator; it cannot be deactivated.');
        }
        // Deactivation also revokes the account's sessions (token_version, cloud migration 004).
        const res2 = await c.query(
          `UPDATE giga_cloud.online_users SET active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END, updated_at = now()
            WHERE id = $1 RETURNING id, email, active`, [target.id, active]);
        await c.query('COMMIT');
        return res2.rows[0];
      } catch (err: any) {
        await c.query('ROLLBACK').catch(() => {});
        if (err?.code === '42703') throw new HttpError(503, 'Apply cloud migration 004 to manage online accounts.');
        throw err;
      }
    });
    await deps.securityEvent(req, active ? 'ONLINE_ACCOUNT_ACTIVATED' : 'ONLINE_ACCOUNT_DEACTIVATED', req.onlineUser.email, req.onlineUser.id, { account: out.email });
    return out;
  }));

  return r;
}
