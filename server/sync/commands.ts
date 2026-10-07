import type pg from 'pg';
import { HttpError, isValidUuid, withTransaction } from '../db/client';
import { recordAuditLog } from '../db/audit';
import { applyPricingUpdate, updateMedicineDetailsTx, type MedicineActor } from '../db/medicines';
import { updatePharmacySettingsTx } from '../db/settings';
import { enqueueSyncEvent, medicineJson } from './outbox';
import { getShopIdentity } from './identity';

/**
 * Inbound cloud -> shop commands. Conservative by design:
 *   - only the command types below exist; anything else is REJECTED
 *   - every command is validated, then applied in ONE PostgreSQL transaction together with its
 *     sync_inbound_commands row (idempotency) and an audit row
 *   - a command never writes stock, never touches historical sale_items
 *   - a command never silently overwrites a local change that has not reached the cloud yet
 */
export interface CloudCommand {
  command_id: string;
  shop_id: string;
  command_type: string;
  payload: any;
  idempotency_key: string;
  created_by?: string | null;
}

export interface CommandOutcome {
  command_id: string;
  status: 'APPLIED' | 'REJECTED';
  result: Record<string, unknown> | null;
  error: string | null;
  duplicate: boolean;
}

// user_id null: medicines.updated_by / audit user_id are UUID columns; the actor is recorded by name.
const CLOUD_ACTOR: MedicineActor = { user_id: null as unknown as string, user_name: 'CLOUD', role: 'ADMIN' as any, device_id: 'SERVER' };

const PRICE_FIELDS = ['selling_price', 'wholesale_price', 'min_selling_price', 'purchase_price'] as const;
const METADATA_FIELDS = [
  'name', 'generic_name', 'brand_name', 'manufacturer', 'description', 'dosage_form',
  'dosage_strength', 'unit', 'prescription_required', 'category',
] as const;
const SETTINGS_FIELDS = ['pharmacy_name', 'tagline', 'address', 'phone', 'email', 'receipt_header', 'receipt_footer'] as const;

function requireMedicineId(payload: any): string {
  const id = payload?.medicine_id;
  if (typeof id !== 'string' || !isValidUuid(id)) throw new HttpError(400, 'payload.medicine_id must be a UUID.');
  return id;
}

function pick(payload: any, fields: readonly string[], what: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'payload must be an object.');
  const unknown = Object.keys(payload).filter((k) => k !== 'medicine_id' && k !== 'reason' && !fields.includes(k));
  if (unknown.length) throw new HttpError(400, `${what} does not allow: ${unknown.join(', ')}.`);
  const out: Record<string, unknown> = {};
  for (const f of fields) if (payload[f] !== undefined) out[f] = payload[f];
  if (Object.keys(out).length === 0) throw new HttpError(400, `${what} needs at least one of: ${fields.join(', ')}.`);
  return out;
}

/** LOCAL UNSYNCED CHANGES are never overwritten silently: refuse while one is still queued. */
async function assertNoUnsyncedMedicineChange(client: pg.PoolClient, medicineId: string) {
  const res = await client.query(
    `SELECT event_type FROM sync_events
      WHERE entity_type = 'medicine' AND entity_id = $1 AND status <> 'SYNCED'
        AND event_type IN ('MEDICINE_CREATED', 'MEDICINE_UPDATED', 'MEDICINE_PRICE_CHANGED')
      LIMIT 1`,
    [medicineId]
  );
  if (res.rows[0]) {
    throw new HttpError(409, `CONFLICT: this medicine has a local ${res.rows[0].event_type} change that has not synced yet; ` +
      'the cloud command was not applied. Re-issue it after the shop has synced.');
  }
}

async function lockExistingMedicine(client: pg.PoolClient, medicineId: string) {
  const r = await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [medicineId]);
  if (!r.rows[0]) throw new HttpError(404, `Medicine ${medicineId} does not exist in this shop.`);
}

type Handler = (client: pg.PoolClient, cmd: CloudCommand) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, Handler> = {
  // Changes the CURRENT price only. sale_items keep their own price snapshot (never rewritten).
  async PRICE_UPDATE(client, cmd) {
    const medicineId = requireMedicineId(cmd.payload);
    const fields = pick(cmd.payload, PRICE_FIELDS, 'PRICE_UPDATE');
    await lockExistingMedicine(client, medicineId);
    await assertNoUnsyncedMedicineChange(client, medicineId);
    const saved = await applyPricingUpdate(client, medicineId, fields as any, CLOUD_ACTOR);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_PRICE_CHANGED', entity_type: 'medicine', entity_id: medicineId, operation: 'CLOUD_COMMAND',
      data: async () => ({ medicine: await medicineJson(client, medicineId), command_id: cmd.command_id }),
      actor: CLOUD_ACTOR,
    });
    return { medicine_id: medicineId, selling_price: saved.selling_price, wholesale_price: saved.wholesale_price, min_selling_price: saved.min_selling_price };
  },

  async MEDICINE_METADATA_UPDATE(client, cmd) {
    const medicineId = requireMedicineId(cmd.payload);
    const fields = pick(cmd.payload, METADATA_FIELDS, 'MEDICINE_METADATA_UPDATE');
    await lockExistingMedicine(client, medicineId);
    await assertNoUnsyncedMedicineChange(client, medicineId);
    const saved = await updateMedicineDetailsTx(client, medicineId, fields as any, CLOUD_ACTOR);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_UPDATED', entity_type: 'medicine', entity_id: medicineId, operation: 'CLOUD_COMMAND',
      data: async () => ({ medicine: await medicineJson(client, medicineId), command_id: cmd.command_id }),
      actor: CLOUD_ACTOR,
    });
    return { medicine_id: medicineId, name: saved.name, category: saved.category };
  },

  async CATEGORY_UPSERT(client, cmd) {
    const name = typeof cmd.payload?.name === 'string' ? cmd.payload.name.trim().slice(0, 100) : '';
    if (!name) throw new HttpError(400, 'payload.name is required.');
    const description = typeof cmd.payload?.description === 'string' ? cmd.payload.description.slice(0, 2000) : null;
    const res = await client.query(
      `INSERT INTO categories (id, name, description) VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT (name) DO UPDATE SET description = COALESCE(EXCLUDED.description, categories.description), updated_at = CURRENT_TIMESTAMP
       RETURNING id, name`,
      [name, description]
    );
    return { category_id: res.rows[0].id, name: res.rows[0].name };
  },

  async SETTINGS_UPDATE(client, cmd) {
    const fields = pick(cmd.payload, SETTINGS_FIELDS, 'SETTINGS_UPDATE');
    const unsynced = await client.query(
      `SELECT 1 FROM sync_events WHERE event_type = 'SETTINGS_UPDATED' AND status <> 'SYNCED' LIMIT 1`
    );
    if (unsynced.rows[0]) throw new HttpError(409, 'CONFLICT: local settings changes have not synced yet; command not applied.');
    const saved = await updatePharmacySettingsTx(client, fields as any, CLOUD_ACTOR);
    return { updated: Object.keys(fields), pharmacy_name: saved.pharmacy_name };
  },
};

export const SUPPORTED_COMMANDS = Object.keys(HANDLERS);

/**
 * Validates and applies one command exactly once. Business validation failures become REJECTED
 * (recorded, acknowledged, audited). Infrastructure errors (database down) propagate so the
 * command is retried on the next cycle.
 */
export async function applyCloudCommand(cmd: CloudCommand): Promise<CommandOutcome> {
  if (!cmd || typeof cmd.command_id !== 'string' || !isValidUuid(cmd.command_id)) {
    throw new HttpError(400, 'Malformed command (command_id).');
  }
  const key = typeof cmd.idempotency_key === 'string' ? cmd.idempotency_key.trim().slice(0, 255) : '';
  if (key.length < 8) throw new HttpError(400, 'Malformed command (idempotency_key).');
  const identity = await getShopIdentity();

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gc-cmd:${key}`]);
    const seen = await client.query(
      'SELECT command_id, status, result, error FROM sync_inbound_commands WHERE command_id = $1 OR idempotency_key = $2 LIMIT 1',
      [cmd.command_id, key]
    );
    if (seen.rows[0]) {
      const r = seen.rows[0];
      return { command_id: cmd.command_id, status: r.status, result: r.result, error: r.error, duplicate: true };
    }

    let status: 'APPLIED' | 'REJECTED' = 'APPLIED';
    let result: Record<string, unknown> | null = null;
    let error: string | null = null;
    await client.query('SAVEPOINT gc_command');
    try {
      if (String(cmd.shop_id || '').toLowerCase() !== identity.shop_id.toLowerCase()) {
        throw new HttpError(403, 'Command is addressed to a different shop.');
      }
      const handler = HANDLERS[cmd.command_type];
      if (!handler) throw new HttpError(400, `Unsupported command type "${cmd.command_type}".`);
      result = await handler(client, cmd);
      await client.query('RELEASE SAVEPOINT gc_command');
    } catch (err: any) {
      if (!(err instanceof HttpError)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT gc_command');
      status = 'REJECTED';
      error = err.message.slice(0, 2000);
    }

    await client.query(
      `INSERT INTO sync_inbound_commands (command_id, idempotency_key, shop_id, command_type, payload, status, result, error, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6::text, $7, $8, CASE WHEN $6::text = 'APPLIED' THEN CURRENT_TIMESTAMP END)`,
      [cmd.command_id, key, isValidUuid(cmd.shop_id) ? cmd.shop_id : identity.shop_id, String(cmd.command_type).slice(0, 60),
       JSON.stringify(cmd.payload ?? null), status, result ? JSON.stringify(result) : null, error]
    );
    await recordAuditLog(
      {
        user_id: 'system',
        user_name: 'CLOUD',
        role: 'ADMIN',
        device_id: 'SERVER',
        action: status === 'APPLIED' ? 'CLOUD_COMMAND_APPLIED' : 'CLOUD_COMMAND_REJECTED',
        entity: 'cloud_command',
        entity_id: cmd.command_id,
        new_value: { command_type: cmd.command_type, payload: cmd.payload ?? null, created_by: cmd.created_by ?? null, result, error },
      },
      client
    );
    return { command_id: cmd.command_id, status, result, error, duplicate: false };
  });
}
