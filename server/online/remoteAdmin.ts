import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { HttpError, isValidUuid } from '../db/client';
import { validateCommandPayload, STOCK_REMOVE_REASONS, ASSIGNABLE_ROLES, type CommandType } from '../sync/commandSchema';

/**
 * Remote administration from the online app (ADMIN only).
 *
 *   POST /api/admin/commands/<action>    queue one command for THIS deployment's shop (SHOP_ID)
 *   GET  /api/admin/commands[/:id]       commands + lifecycle (PENDING/DELIVERED/APPLIED/REJECTED)
 *   GET  /api/admin/remote-status        short status (shop in contact? counts)
 *   GET  /api/admin/shop-health          heartbeat-based shop PC health + sanitized diagnostics
 *   GET  /api/admin/alerts  POST /api/admin/alerts/:id/ack
 *   GET  /api/admin/insights             inventory intelligence + retail/wholesale split (cloud copy)
 *   GET  /api/admin/security  POST /api/admin/security/*   emergency controls, session revocation
 *
 * Queueing never changes data in the cloud copy. The shop's local PostgreSQL applies the command
 * and its sync reports the result back, so a queued command is "PENDING", never "done". shop_id
 * always comes from the server configuration, never from the browser; command ids and
 * idempotency keys are generated here. Shop credentials (passwords / PINs) are never accepted.
 */
export interface RemoteControl {
  remote_writes_enabled: boolean;
  maintenance_mode: boolean;
  maintenance_message: string | null;
}

export interface RemoteAdminDeps {
  shopId: () => string | null;
  /** Read-only transaction over the giga_online views of this shop. */
  withShop: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  /** Plain connection to the cloud database. */
  withCloud: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  requireAdmin: (req: any, res: Response, next: NextFunction) => unknown;
  route: (label: string, fn: (req: any, res: Response) => Promise<unknown>) => (req: any, res: Response) => Promise<void>;
  getRemoteControl: (fresh?: boolean) => Promise<RemoteControl>;
  clearRemoteControlCache: () => void;
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
};

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
  return {
    command_id: r.command_id,
    command_type: r.command_type,
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
 * Checks the medicine / batch / user named in a payload exist in this shop's cloud copy and returns
 * what the Admin was looking at (names, values before the change) for the activity history.
 */
async function contextFor(deps: RemoteAdminDeps, type: CommandType, p: Record<string, any>): Promise<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  await deps.withShop(async (c) => {
    if (p.medicine_id) {
      const m = (await c.query(
        `SELECT name, current_stock, selling_price, wholesale_price, min_selling_price, purchase_price, reorder_level, status FROM medicines WHERE id = $1`,
        [p.medicine_id])).rows[0];
      if (!m) throw new HttpError(404, 'Medicine not found in the cloud copy of this shop (has the shop synced it yet?).');
      display.medicine_name = m.name;
      display.cloud_stock_before = Number(m.current_stock);
      if (type === 'PRICE_UPDATE') {
        display.prices_before = {
          selling_price: Number(m.selling_price), wholesale_price: m.wholesale_price === null ? null : Number(m.wholesale_price),
          min_selling_price: m.min_selling_price === null ? null : Number(m.min_selling_price), purchase_price: Number(m.purchase_price),
        };
      }
    }
    if (p.batch_id) {
      const b = (await c.query('SELECT batch_number, quantity_available, expiry_date FROM medicine_batches WHERE id = $1 AND medicine_id = $2',
        [p.batch_id, p.medicine_id])).rows[0];
      if (!b) throw new HttpError(404, 'Batch not found for this medicine in the cloud copy.');
      display.batch_number = b.batch_number;
      display.batch_quantity_before = Number(b.quantity_available);
      display.expiry_before = b.expiry_date ? new Date(b.expiry_date).toISOString().slice(0, 10) : null;
    }
    if (p.user_id) {
      const u = (await c.query('SELECT name, role, active FROM users WHERE id = $1 AND email IS NOT NULL', [p.user_id])).rows[0];
      if (!u) throw new HttpError(404, 'Staff account not found in the cloud copy of this shop.');
      display.user_name = u.name;
      display.role_before = u.role;
      display.active_before = u.active;
    }
  });
  return display;
}

const COMMAND_COLUMNS = `command_id, command_type, status, payload, created_at, created_by, source, delivered_at, delivery_count, acked_at, result, error`;

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

  r.get('/admin/commands/options', requireAdmin, (_req, res) => {
    res.json({ actions: Object.keys(ACTIONS), stock_remove_reasons: STOCK_REMOVE_REASONS, assignable_roles: ASSIGNABLE_ROLES });
  });

  r.post('/admin/commands/:action', requireAdmin, commandRateLimit, route('POST /admin/commands', async (req, res) => {
    const type = ACTIONS[String(req.params.action)];
    if (!type) throw new HttpError(404, `Unknown remote action "${req.params.action}".`);
    const shopId = deps.shopId();
    if (!shopId) throw new HttpError(503, 'Online API not configured: SHOP_ID is missing.');
    const ctl = await deps.getRemoteControl(true);
    if (!ctl.remote_writes_enabled) throw new HttpError(423, 'Remote changes are disabled (emergency switch). Re-enable them under Security.');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    // Optional client request id: the SAME phone request retried (bad network) queues ONE command.
    const requestId = body.request_id;
    delete body.request_id;
    const payload = validateCommandPayload(type, body);
    const display = await contextFor(deps, type, payload);
    if (type === 'APP_UPDATE_APPROVE') {
      const rt = await runtimeRow(deps, shopId);
      const available = rt?.update_state?.available_commit;
      if (!available || available !== payload.target_commit) {
        throw new HttpError(409, 'That version is not the update the shop computer reported as available on the approved production channel.');
      }
      display.current_commit = rt.update_state.current_commit ?? null;
      display.available_version = rt.update_state.available_version ?? null;
    }

    const u = req.onlineUser;
    const key = `online:${u.id}:${isValidUuid(requestId) ? String(requestId).toLowerCase() : crypto.randomUUID()}`;
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
      if (err?.code === '42883' || err?.code === '23514' || err?.code === '42703') {
        throw new HttpError(503, 'Remote administration is not fully enabled in the cloud yet (apply cloud migrations 003 and 004).');
      }
      throw err;
    }
    console.log(`[Online] ${u.email} queued ${type} ${row.command_id}${row.duplicate ? ' (replayed request)' : ''}`);
    res.status(202);
    return {
      command_id: row.command_id,
      command_type: type,
      status: row.status,
      created_at: row.created_at,
      duplicate: row.duplicate,
      message: 'Remote change queued. It is applied when the shop computer picks it up; watch the status.',
    };
  }));

  r.get('/admin/commands', requireAdmin, route('GET /admin/commands', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    const statuses = status ? status.split(',').filter((s: string) => ['PENDING', 'DELIVERED', 'APPLIED', 'REJECTED'].includes(s)) : [];
    const rows = await commandQuery(deps, `shop_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))`,
      [deps.shopId(), statuses.length ? statuses : null, limit], 'ORDER BY created_at DESC LIMIT $3');
    return { commands: rows.map(toCommand) };
  }));

  r.get('/admin/commands/:id', requireAdmin, route('GET /admin/commands/:id', async (req) => {
    if (!isValidUuid(req.params.id)) throw new HttpError(400, 'Command id must be a UUID.');
    const row = (await commandQuery(deps, 'command_id = $1 AND shop_id = $2', [req.params.id, deps.shopId()]))[0];
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

  r.get('/admin/remote-status', requireAdmin, route('GET /admin/remote-status', async () => {
    const shopId = deps.shopId();
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

  r.get('/admin/shop-health', requireAdmin, route('GET /admin/shop-health', async () => {
    const shopId = deps.shopId();
    const rt = await runtimeRow(deps, shopId);
    const ctl = await deps.getRemoteControl(true);
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

  // ------------------------------------------------------------------ alerts
  r.get('/admin/alerts', requireAdmin, route('GET /admin/alerts', async (req) => {
    const shopId = deps.shopId();
    const which = String(req.query.status || 'open').toLowerCase();
    try {
      return await deps.withCloud(async (c) => {
        await c.query('SELECT giga_cloud.refresh_cloud_alerts($1, $2)', [shopId, HEARTBEAT_ONLINE_SECONDS]);
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
        WHERE id = $1 AND shop_id = $2 AND status = 'ACTIVE' RETURNING id, status`, [id, deps.shopId(), req.onlineUser.email]))).rows[0];
    if (!row) throw new HttpError(404, 'No active alert with that id.');
    await deps.securityEvent(req, 'ALERT_ACKNOWLEDGED', req.onlineUser.email, req.onlineUser.id, { alert_id: id });
    return { id, status: row.status };
  }));

  // ------------------------------------------------------------------ inventory intelligence
  r.get('/admin/insights', requireAdmin, route('GET /admin/insights', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const coverDays = 30;
    return deps.withShop(async (c) => {
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
  r.get('/admin/security', requireAdmin, route('GET /admin/security', async () => {
    const shopId = deps.shopId();
    const controls = await deps.getRemoteControl(true);
    return deps.withCloud(async (c) => {
      let users;
      try {
        users = (await c.query(
          `SELECT id, email, name, role, active, last_login_at, token_version FROM giga_cloud.online_users
            WHERE shop_id IS NULL OR shop_id = $1 ORDER BY role, email`, [shopId])).rows;
      } catch (err: any) {
        if (err?.code !== '42703') throw err;
        users = (await c.query(`SELECT id, email, name, role, active, last_login_at FROM giga_cloud.online_users WHERE shop_id IS NULL OR shop_id = $1 ORDER BY role, email`, [shopId])).rows;
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
        [deps.shopId(), fields.remote_writes_enabled ?? null, fields.maintenance_mode ?? null, fields.maintenance_message ?? null, req.onlineUser.email]));
    } catch (err: any) {
      if (err?.code === '42P01') throw new HttpError(503, 'Apply cloud migration 004 to enable emergency controls.');
      throw err;
    }
    deps.clearRemoteControlCache();
    return deps.getRemoteControl(true);
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
          WHERE (shop_id IS NULL OR shop_id = $1) AND ($2::boolean OR id = $3::uuid)`, [deps.shopId(), all, all ? null : userId]))).rowCount;
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
    const shopId = deps.shopId();
    const out = await deps.withCloud(async (c) => {
      await c.query('BEGIN');
      try {
        const target = (await c.query(`SELECT id, email, role, active FROM giga_cloud.online_users WHERE id = $1 AND (shop_id IS NULL OR shop_id = $2) FOR UPDATE`,
          [req.params.id, shopId])).rows[0];
        if (!target) throw new HttpError(404, 'Online account not found.');
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
