import type pg from 'pg';
import { HttpError, isValidUuid, withTransaction } from '../db/client';
import { recordAuditLog } from '../db/audit';
import { applyPricingUpdate, updateMedicineDetailsTx, type MedicineActor } from '../db/medicines';
import { updatePharmacySettingsTx } from '../db/settings';
import { adminAddStockTx, adminEditBatchExpiryTx, adminPhysicalStockCountTx, adminRemoveStockTx, type StockActor } from '../db/inventory';
import { enqueueSyncEvent, medicineJson } from './outbox';
import { getShopIdentity } from './identity';
import { COMMAND_TYPES, validateCommandPayload } from './commandSchema';

/**
 * Inbound cloud -> shop commands. Conservative by design:
 *   - only the command types below exist; anything else is REJECTED
 *   - every command is validated, then applied in ONE PostgreSQL transaction together with its
 *     sync_inbound_commands row (idempotency) and an audit row
 *   - stock commands (STOCK_ADD / STOCK_REMOVE / STOCK_SET) are movements or a physical count of
 *     one batch, applied through the SAME functions as the shop's Admin stock screens: rows locked,
 *     batch updated, medicine reconciled, inventory movement + audit + outbox event written in this
 *     transaction. A command never writes current_stock directly, never touches sale_items.
 *   - STOCK_REMOVE can never make a batch negative (rejected instead); STOCK_SET applies the count
 *     against the quantity locked at apply time (the movement delta is computed here)
 *   - price/metadata/settings commands never silently overwrite a local change that has not
 *     reached the cloud yet
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

/**
 * The local actor for a cloud command. user_id null: audit / movement user_id columns reference
 * shop staff, and a remote (online) Admin is not a shop account; the person is recorded by name.
 */
function cloudActor(cmd: CloudCommand): MedicineActor & StockActor {
  const who = typeof cmd.created_by === 'string' && cmd.created_by.trim() ? cmd.created_by.trim().slice(0, 120) : '';
  return {
    user_id: null as unknown as string,
    user_name: who ? `CLOUD (${who})` : 'CLOUD',
    role: 'ADMIN' as any,
    device_id: 'SERVER',
    command_id: cmd.command_id,
  };
}

/** Business fields only (the optional free-text reason stays in the command / audit record). */
function fieldsOf(p: Record<string, any>): Record<string, unknown> {
  const { medicine_id: _m, reason: _r, ...rest } = p;
  return rest;
}

function remoteNote(cmd: CloudCommand, text: string | null): string {
  return `Remote admin ${cloudActor(cmd).user_name}: ${text || 'no reason given'}`.slice(0, 500);
}

/** A batch named by id must belong to the medicine named in the same command. */
async function batchOfMedicine(client: pg.PoolClient, batchId: string, medicineId: string) {
  const r = await client.query('SELECT id, batch_number FROM medicine_batches WHERE id = $1 AND medicine_id = $2', [batchId, medicineId]);
  if (!r.rows[0]) throw new HttpError(404, 'This batch does not exist for this medicine in the shop.');
  return r.rows[0] as { id: string; batch_number: string };
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
    const p = validateCommandPayload('PRICE_UPDATE', cmd.payload);
    const medicineId = p.medicine_id;
    const fields = fieldsOf(p);
    const actor = cloudActor(cmd);
    await lockExistingMedicine(client, medicineId);
    await assertNoUnsyncedMedicineChange(client, medicineId);
    const saved = await applyPricingUpdate(client, medicineId, fields as any, actor);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_PRICE_CHANGED', entity_type: 'medicine', entity_id: medicineId, operation: 'CLOUD_COMMAND',
      data: async () => ({ medicine: await medicineJson(client, medicineId), command_id: cmd.command_id }),
      actor,
    });
    return { medicine_id: medicineId, selling_price: saved.selling_price, wholesale_price: saved.wholesale_price, min_selling_price: saved.min_selling_price };
  },

  async MEDICINE_METADATA_UPDATE(client, cmd) {
    const p = validateCommandPayload('MEDICINE_METADATA_UPDATE', cmd.payload);
    const medicineId = p.medicine_id;
    const fields = fieldsOf(p);
    const actor = cloudActor(cmd);
    await lockExistingMedicine(client, medicineId);
    await assertNoUnsyncedMedicineChange(client, medicineId);
    const saved = await updateMedicineDetailsTx(client, medicineId, fields as any, actor);
    await enqueueSyncEvent(client, {
      event_type: 'MEDICINE_UPDATED', entity_type: 'medicine', entity_id: medicineId, operation: 'CLOUD_COMMAND',
      data: async () => ({ medicine: await medicineJson(client, medicineId), command_id: cmd.command_id }),
      actor,
    });
    return { medicine_id: medicineId, name: saved.name, category: saved.category };
  },

  async CATEGORY_UPSERT(client, cmd) {
    const { name, description } = validateCommandPayload('CATEGORY_UPSERT', cmd.payload);
    const res = await client.query(
      `INSERT INTO categories (id, name, description) VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT (name) DO UPDATE SET description = COALESCE(EXCLUDED.description, categories.description), updated_at = CURRENT_TIMESTAMP
       RETURNING id, name`,
      [name, description]
    );
    return { category_id: res.rows[0].id, name: res.rows[0].name };
  },

  async SETTINGS_UPDATE(client, cmd) {
    const fields = validateCommandPayload('SETTINGS_UPDATE', cmd.payload);
    const unsynced = await client.query(
      `SELECT 1 FROM sync_events WHERE event_type = 'SETTINGS_UPDATED' AND status <> 'SYNCED' LIMIT 1`
    );
    if (unsynced.rows[0]) throw new HttpError(409, 'CONFLICT: local settings changes have not synced yet; command not applied.');
    const saved = await updatePharmacySettingsTx(client, fields as any, cloudActor(cmd));
    return { updated: Object.keys(fields), pharmacy_name: saved.pharmacy_name };
  },

  // ---------------------------------------------------------------- remote Admin stock control
  // Movement: +quantity on an existing batch (by id) or on a batch number (created if new).
  async STOCK_ADD(client, cmd) {
    const p = validateCommandPayload('STOCK_ADD', cmd.payload);
    const batch = p.batch_id ? await batchOfMedicine(client, p.batch_id, p.medicine_id) : null;
    const out = await adminAddStockTx(client, {
      ...cloudActor(cmd),
      medicine_id: p.medicine_id,
      quantity: p.quantity,
      batch_number: batch ? batch.batch_number : p.batch_number,
      expiry_date: batch ? undefined : p.expiry_date,
      notes: remoteNote(cmd, p.reason),
    });
    return {
      medicine_id: p.medicine_id, batch_id: out.batch.id, batch_number: out.batch.batch_number, quantity_added: p.quantity,
      previous_quantity: out.movement.previous_quantity, new_quantity: out.movement.new_quantity, delta: out.movement.delta,
      current_stock: out.medicine.current_stock, movement_id: out.movement.id,
    };
  },

  // Movement: -quantity; REJECTED when the batch holds less than that at apply time (never negative).
  async STOCK_REMOVE(client, cmd) {
    const p = validateCommandPayload('STOCK_REMOVE', cmd.payload);
    await batchOfMedicine(client, p.batch_id, p.medicine_id);
    const out = await adminRemoveStockTx(client, {
      ...cloudActor(cmd),
      medicine_id: p.medicine_id,
      batch_id: p.batch_id,
      quantity: p.quantity,
      reason: p.reason,
      notes: remoteNote(cmd, p.notes ? `${p.reason} - ${p.notes}` : p.reason),
    });
    return {
      medicine_id: p.medicine_id, batch_id: p.batch_id, batch_number: out.batch.batch_number, quantity_removed: p.quantity,
      previous_quantity: out.movement.previous_quantity, new_quantity: out.movement.new_quantity, delta: out.movement.delta,
      current_stock: out.medicine.current_stock, movement_id: out.movement.id,
    };
  },

  // Physical count of one batch: the counted quantity replaces the quantity LOCKED NOW (sales made
  // while the command was pending are included); the movement records the actual delta.
  async STOCK_SET(client, cmd) {
    const p = validateCommandPayload('STOCK_SET', cmd.payload);
    if (p.batch_id) await batchOfMedicine(client, p.batch_id, p.medicine_id);
    const out = await adminPhysicalStockCountTx(client, {
      ...cloudActor(cmd),
      medicine_id: p.medicine_id,
      counts: [p.batch_id ? { batch_id: p.batch_id, batch_number: '', quantity: p.quantity } : { batch_number: p.batch_number, quantity: p.quantity }],
      notes: remoteNote(cmd, p.reason),
    });
    const m = out.movements[0];
    return {
      medicine_id: p.medicine_id, batch_id: m.batch_id, batch_number: m.batch_number, counted_quantity: p.quantity,
      previous_quantity: m.previous_quantity, new_quantity: m.new_quantity, delta: m.delta,
      current_stock: out.total_stock, movement_id: m.id,
    };
  },

  async BATCH_EXPIRY_UPDATE(client, cmd) {
    const p = validateCommandPayload('BATCH_EXPIRY_UPDATE', cmd.payload);
    await batchOfMedicine(client, p.batch_id, p.medicine_id);
    const out = await adminEditBatchExpiryTx(client, { ...cloudActor(cmd), batch_id: p.batch_id, expiry_date: p.expiry_date });
    return {
      medicine_id: p.medicine_id, batch_id: p.batch_id, batch_number: out.batch.batch_number,
      expiry_date: out.batch.expiry_date || null, batch_status: out.batch.status, current_stock: out.medicine.current_stock,
    };
  },
};

export const SUPPORTED_COMMANDS = Object.keys(HANDLERS);
// The shop handles exactly the types the cloud accepts.
if (SUPPORTED_COMMANDS.length !== COMMAND_TYPES.length || !COMMAND_TYPES.every((t) => t in HANDLERS)) {
  throw new Error('Cloud command handlers are out of step with COMMAND_TYPES.');
}

/** Deterministic database refusals (invalid data, constraint) are a rejection, not a retry. */
function isDataError(err: any): boolean {
  return typeof err?.code === 'string' && /^(22|23)/.test(err.code);
}

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
      if (!(err instanceof HttpError) && !isDataError(err)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT gc_command');
      status = 'REJECTED';
      error = err instanceof HttpError
        ? err.message.slice(0, 2000)
        : `The shop database refused this change as invalid data (code ${err.code}).`;
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
