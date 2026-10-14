import type pg from 'pg';
import { HttpError, pgPool, requireUuid } from './client';

/**
 * PRICE HISTORY (local migration 023). Rows are written by database triggers on medicines /
 * medicine_batches (every code path), attributed from transaction-local settings set here. Read only.
 */
export type PriceSource = 'LOCAL_ADMIN' | 'REMOTE_COMMAND' | 'PURCHASE_RECEIPT' | 'BATCH_EDIT' | 'MEDICINE_EDIT' | 'IMPORT';

/** Attribution for any price change made later in THIS transaction (is_local = true). */
export async function setPriceContext(client: pg.PoolClient, actor: { user_id?: string | null; user_name?: string | null; command_id?: string | null },
  source: PriceSource, extra: { reason?: string | null; reference?: string | null } = {}) {
  await client.query(
    `SELECT set_config('giga.actor_id', $1, true), set_config('giga.actor_name', $2, true), set_config('giga.price_source', $3, true),
            set_config('giga.price_reason', $4, true), set_config('giga.price_reference', $5, true)`,
    [actor.user_id || '', actor.user_name || '', actor.command_id ? 'REMOTE_COMMAND' : source, (extra.reason || '').slice(0, 500),
     (extra.reference || actor.command_id || '').slice(0, 100)]);
}

const COST_FIELDS = ['purchase_price', 'batch_purchase_price'];

/** Price history (newest first). Purchase-cost rows only for callers allowed to see costs. */
export async function getPriceHistory(query: Record<string, unknown>, includeCost: boolean) {
  const medicineId = typeof query.medicine_id === 'string' && query.medicine_id ? requireUuid(query.medicine_id, 'medicine_id') : null;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof query.from === 'string' && DATE.test(query.from) ? query.from : null;
  const to = typeof query.to === 'string' && DATE.test(query.to) ? query.to : null;
  if ((query.from && !from) || (query.to && !to)) throw new HttpError(400, 'from / to must be YYYY-MM-DD.');
  const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
  const rows = (await pgPool.query(
    `SELECT h.id, h.medicine_id, m.name AS medicine_name, h.batch_id, b.batch_number, h.field, h.old_value::float AS old_value, h.new_value::float AS new_value,
            h.changed_by_name, h.source, h.reason, h.reference, h.changed_at
       FROM price_history h LEFT JOIN medicines m ON m.id = h.medicine_id LEFT JOIN medicine_batches b ON b.id = h.batch_id
      WHERE ($1::uuid IS NULL OR h.medicine_id = $1)
        AND ($2::date IS NULL OR h.changed_at >= ($2::date::timestamp AT TIME ZONE 'Africa/Nairobi'))
        AND ($3::date IS NULL OR h.changed_at < (($3::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
        AND ($4::boolean OR h.field <> ALL($5::text[]))
      ORDER BY h.changed_at DESC, h.id DESC LIMIT $6`,
    [medicineId, from, to, includeCost, COST_FIELDS, limit])).rows;
  return { rows, cost_fields_hidden: !includeCost };
}
