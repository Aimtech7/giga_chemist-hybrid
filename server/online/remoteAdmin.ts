import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { HttpError, isValidUuid } from '../db/client';
import { validateCommandPayload, STOCK_REMOVE_REASONS, type CommandType } from '../sync/commandSchema';

/**
 * Remote administration from the online app (ADMIN only).
 *
 *   POST /api/admin/commands/<action>   queue one command for THIS deployment's shop (SHOP_ID)
 *   GET  /api/admin/commands            recent commands + their status
 *   GET  /api/admin/commands/:id        one command (poll until APPLIED / REJECTED)
 *   GET  /api/admin/remote-status       is the shop PC in contact? pending / rejected counts
 *
 * Queueing never changes data in the cloud copy. The shop's local PostgreSQL applies the command
 * (stock movements through its own inventory logic) and its sync reports the result back, so a
 * queued command is "PENDING", never "done". shop_id always comes from the server configuration,
 * never from the browser; command ids and idempotency keys are generated here.
 */
export interface RemoteAdminDeps {
  shopId: () => string | null;
  /** Read-only transaction over the giga_online views of this shop. */
  withShop: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  /** Plain connection to the cloud database. */
  withCloud: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  requireAdmin: (req: any, res: Response, next: NextFunction) => unknown;
  route: (label: string, fn: (req: any, res: Response) => Promise<unknown>) => (req: any, res: Response) => Promise<void>;
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
};

/** The shop is considered in contact when its worker called the cloud within this window. */
const SHOP_ONLINE_WINDOW_SECONDS = 150;

// Sliding one-minute window per online user (per serverless instance; the database-side checks
// and idempotency keys are the real guarantees, this only blunts accidental or abusive bursts).
const hits = new Map<string, number[]>();
function commandRateLimit(req: any, res: Response, next: NextFunction) {
  const limit = Number(process.env.ONLINE_COMMAND_RATE_PER_MINUTE) || 30;
  const key = String(req.onlineUser?.id || req.ip || 'anon');
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: `Too many remote changes (limit ${limit} per minute). Wait a minute.`, code: 'RATE_LIMITED' });
  }
  recent.push(now);
  hits.set(key, recent);
  next();
}

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
    created_at: r.created_at,
    created_by: r.created_by,
    source: r.source ?? null,
    delivered_at: r.delivered_at,
    delivery_count: Number(r.delivery_count) || 0,
    acked_at: r.acked_at,
    result: r.result ?? null,
    error: safeError(r.error),
  };
}

function clientIp(req: Request): string {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 100);
}

/** Checks the medicine / batch named in a payload exist in this shop's cloud copy. */
async function assertKnownToCloud(deps: RemoteAdminDeps, p: Record<string, any>) {
  if (!p.medicine_id) return;
  await deps.withShop(async (c) => {
    const m = await c.query('SELECT id FROM medicines WHERE id = $1', [p.medicine_id]);
    if (!m.rows[0]) throw new HttpError(404, 'Medicine not found in the cloud copy of this shop (has the shop synced it yet?).');
    if (p.batch_id) {
      const b = await c.query('SELECT id FROM medicine_batches WHERE id = $1 AND medicine_id = $2', [p.batch_id, p.medicine_id]);
      if (!b.rows[0]) throw new HttpError(404, 'Batch not found for this medicine in the cloud copy.');
    }
  });
}

const COMMAND_COLUMNS = `command_id, command_type, status, payload, created_at, created_by, source, delivered_at, delivery_count, acked_at, result, error`;

export function buildRemoteAdminRouter(deps: RemoteAdminDeps) {
  const r = express.Router();
  const { requireAdmin, route } = deps;

  r.get('/admin/commands/options', requireAdmin, (_req, res) => {
    res.json({ actions: Object.keys(ACTIONS), stock_remove_reasons: STOCK_REMOVE_REASONS });
  });

  r.post('/admin/commands/:action', requireAdmin, commandRateLimit, route('POST /admin/commands', async (req, res) => {
    const type = ACTIONS[String(req.params.action)];
    if (!type) throw new HttpError(404, `Unknown remote action "${req.params.action}".`);
    const shopId = deps.shopId();
    if (!shopId) throw new HttpError(503, 'Online API not configured: SHOP_ID is missing.');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    // Optional client request id: the SAME phone request retried (bad network) queues ONE command.
    const requestId = body.request_id;
    delete body.request_id;
    const payload = validateCommandPayload(type, body);
    await assertKnownToCloud(deps, payload);

    const u = req.onlineUser;
    const key = `online:${u.id}:${isValidUuid(requestId) ? String(requestId).toLowerCase() : crypto.randomUUID()}`;
    let row: any;
    try {
      row = (await deps.withCloud((c) => c.query(
        `SELECT * FROM giga_cloud.queue_online_command($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [shopId, type, JSON.stringify(payload), key, u.id, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300)]
      ))).rows[0];
    } catch (err: any) {
      if (err?.code === 'PT403') throw new HttpError(403, 'Forbidden: this account may not manage the shop remotely.');
      if (err?.code === 'PT404') throw new HttpError(409, 'The shop is not registered (or inactive) in the cloud.');
      if (err?.code === 'PT409') throw new HttpError(409, 'This request id was already used for another command.');
      if (err?.code === '42883' || err?.code === '23514' || err?.code === '42703') {
        throw new HttpError(503, 'Remote administration is not enabled in the cloud yet (apply cloud migration 003).');
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
    const shopId = deps.shopId();
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    const statuses = status ? status.split(',').filter((s: string) => ['PENDING', 'DELIVERED', 'APPLIED', 'REJECTED'].includes(s)) : [];
    const rows = (await deps.withCloud((c) => c.query(
      `SELECT ${COMMAND_COLUMNS} FROM giga_cloud.commands
        WHERE shop_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at DESC LIMIT $3`,
      [shopId, statuses.length ? statuses : null, limit]
    ))).rows;
    return { commands: rows.map(toCommand) };
  }));

  r.get('/admin/commands/:id', requireAdmin, route('GET /admin/commands/:id', async (req) => {
    if (!isValidUuid(req.params.id)) throw new HttpError(400, 'Command id must be a UUID.');
    const row = (await deps.withCloud((c) => c.query(
      `SELECT ${COMMAND_COLUMNS} FROM giga_cloud.commands WHERE command_id = $1 AND shop_id = $2`, [req.params.id, deps.shopId()]
    ))).rows[0];
    if (!row) throw new HttpError(404, 'Command not found.');
    return toCommand(row);
  }));

  r.get('/admin/remote-status', requireAdmin, route('GET /admin/remote-status', async () => {
    const shopId = deps.shopId();
    return deps.withCloud(async (c) => {
      const shop = (await c.query(
        `SELECT shop_code, name, active, last_seen_at, last_event_at, events_received::bigint AS events_received, now() AS server_time,
                (last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(secs => $2)) AS in_contact
           FROM giga_cloud.shops WHERE shop_id = $1`, [shopId, SHOP_ONLINE_WINDOW_SECONDS]
      )).rows[0];
      const counts = (await c.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'APPLIED')::int AS applied,
                COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
                MIN(created_at) FILTER (WHERE status IN ('PENDING', 'DELIVERED')) AS oldest_open_at,
                MAX(acked_at) FILTER (WHERE status = 'APPLIED') AS last_applied_at,
                MAX(acked_at) FILTER (WHERE status = 'REJECTED') AS last_rejected_at
           FROM giga_cloud.commands WHERE shop_id = $1`, [shopId]
      )).rows[0];
      const last = (await c.query(
        `SELECT command_id, command_type, acked_at FROM giga_cloud.commands
          WHERE shop_id = $1 AND status = 'APPLIED' ORDER BY acked_at DESC NULLS LAST LIMIT 1`, [shopId]
      )).rows[0];
      return {
        shop_registered: Boolean(shop),
        shop_active: shop?.active ?? false,
        shop_code: shop?.shop_code ?? null,
        shop_name: shop?.name ?? null,
        shop_in_contact: Boolean(shop?.in_contact),
        contact_window_seconds: SHOP_ONLINE_WINDOW_SECONDS,
        last_shop_contact_at: shop?.last_seen_at ?? null,
        last_shop_event_at: shop?.last_event_at ?? null,
        last_sync_at: shop?.last_event_at ?? null,
        events_received: shop ? Number(shop.events_received) : 0,
        server_time: shop?.server_time ?? new Date().toISOString(),
        commands: {
          pending: counts.pending, delivered: counts.delivered, applied: counts.applied, rejected: counts.rejected,
          oldest_open_at: counts.oldest_open_at, last_applied_at: counts.last_applied_at, last_rejected_at: counts.last_rejected_at,
        },
        last_successful_command: last ? { command_id: last.command_id, command_type: last.command_type, applied_at: last.acked_at } : null,
      };
    });
  }));

  return r;
}
