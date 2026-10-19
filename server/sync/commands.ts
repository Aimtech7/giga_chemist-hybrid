import type pg from 'pg';
import { HttpError, isValidUuid, withTransaction } from '../db/client';
import { recordAuditLog } from '../db/audit';
import { assertExpected, assertExpectedQuantity } from '../db/concurrency';
import { applyPricingUpdate, createMedicineTx, getMedicineById, updateMedicineDetailsTx, type MedicineActor } from '../db/medicines';
import { updatePharmacySettingsTx } from '../db/settings';
import {
  adminAddStockTx, adminCreateBatchTx, adminEditBatchExpiryTx, adminPhysicalStockCountTx, adminRemoveStockTx,
  adminSetBatchActiveTx, adminUpdateBatchTx, type StockActor,
} from '../db/inventory';
import { createSupplierTx, setSupplierActiveTx, updateSupplierTx } from '../db/suppliers';
import { createCustomerTx, setCustomerActiveTx, updateCustomerTx } from '../db/customers';
import { recordExpenseTx, updateExpenseTx, voidExpenseTx } from '../db/expenses';
import { cancelPurchaseTx, createDraftPurchaseTx, receiveDraftPurchaseTx, receivePurchaseOrderTx, updateDraftPurchaseTx } from '../db/purchases';
import { approveReturnTx, rejectReturnTx } from '../db/returns';
import { voidSaleTx, type SaleActor } from '../db/sales';
import { reviewShiftTx } from '../db/shifts';
import { enqueueSyncEvent, medicineJson, userJson } from './outbox';
import { getShopIdentity } from './identity';
import { COMMAND_TYPES, USER_PROFILE_FIELDS, validateCommandPayload } from './commandSchema';
import { revokeUserSessionsTx, updateUserTx, unusablePinHash } from '../db/users';
import type { FetchedCredential } from './credentials';
import { readUpdateState } from '../ops/runtime';

/**
 * Inbound cloud -> shop commands: the ONE write path of remote (online) administration.
 *   - only the command types below exist; anything else is REJECTED
 *   - every command is validated, then applied in ONE PostgreSQL transaction together with its
 *     sync_inbound_commands row (idempotency) and an audit row
 *   - handlers call the SAME transactional functions as the shop's own screens (server/db/*Tx):
 *     no business rule is implemented twice
 *   - stock commands (STOCK_ADD / STOCK_REMOVE / STOCK_SET) are movements or a physical count of
 *     one batch: rows locked, batch updated, medicine reconciled, inventory movement + audit + outbox
 *     event written in this transaction. A command never writes current_stock directly, never
 *     touches sale_items, never edits a completed sale.
 *   - OPTIMISTIC CONCURRENCY: `expected` / `expected_quantity` (what the Administrator saw) are
 *     compared with the LOCKED row; any difference rejects the command (CONFLICT) instead of
 *     overwriting newer local activity. A rejection's result carries the shop's current values.
 *   - without `expected`, price/metadata/settings commands still refuse to overwrite a local change
 *     that has not reached the cloud yet
 */
export interface CloudCommand {
  command_id: string;
  shop_id: string;
  command_type: string;
  payload: any;
  idempotency_key: string;
  created_by?: string | null;
  /**
   * USER_CREATE / USER_CREDENTIAL_REFRESH only: the password hash fetched for this one account just
   * before applying (gc_fetch_user_credential). In memory only — never stored with the command,
   * its result or the audit row.
   */
  credential?: FetchedCredential | null;
  credential_error?: string | null;
}

/** Commands about one staff account (payload.user_id). */
const USER_COMMANDS = ['USER_SET_ACTIVE', 'USER_ROLE_UPDATE', 'USER_CREATE', 'USER_CREDENTIAL_REFRESH', 'USER_SESSION_REVOKE', 'USER_PROFILE_UPDATE'];
export const CREDENTIAL_COMMANDS = ['USER_CREATE', 'USER_CREDENTIAL_REFRESH'];

/** (version, timestamp) ordering shared with the cloud: true when a is strictly newer than b. */
async function credentialNewer(client: pg.PoolClient, a: { v: number; at: string }, b: { v: number; at: string }): Promise<boolean> {
  const r = await client.query('SELECT ($1::bigint, $2::timestamptz) > ($3::bigint, $4::timestamptz) AS newer', [a.v, a.at, b.v, b.at]);
  return Boolean(r.rows[0].newer);
}

function requireCredential(cmd: CloudCommand, userId: string): FetchedCredential {
  if (cmd.credential_error) throw new HttpError(409, cmd.credential_error);
  const c = cmd.credential;
  if (!c) throw new Error('credential not fetched yet'); // infrastructure: retried next cycle
  if (String(c.local_user_id).toLowerCase() !== userId) throw new HttpError(409, 'Fetched credential belongs to another account.');
  if (typeof c.password_hash !== 'string' || !c.password_hash.includes('$') || c.password_hash.length < 40) throw new HttpError(409, 'Fetched credential has an unsupported format.');
  return c;
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
function cloudActor(cmd: CloudCommand): MedicineActor & StockActor & SaleActor {
  const who = typeof cmd.created_by === 'string' && cmd.created_by.trim() ? cmd.created_by.trim().slice(0, 120) : '';
  return {
    user_id: null as unknown as string,
    user_name: who ? `CLOUD (${who})` : 'CLOUD',
    role: 'ADMIN' as any,
    device_id: 'SERVER',
    command_id: cmd.command_id,
  };
}

/** Business fields only (ids, reasons and concurrency expectations stay in the command / audit). */
function fieldsOf(p: Record<string, any>, ...drop: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!['reason', 'expected', 'expected_quantity', 'expected_expiry_date', ...drop].includes(k)) out[k] = v;
  }
  return out;
}

function remoteNote(cmd: CloudCommand, text: string | null): string {
  return `Remote admin ${cloudActor(cmd).user_name}: ${text || 'no reason given'}`.slice(0, 500);
}

/** Recorded with every audit row a command writes, so the shop audit trail names the command. */
const ref = (cmd: CloudCommand, p: Record<string, any> = {}) => ({ command_id: cmd.command_id, ...(p.reason ? { reason: p.reason } : {}) });

/** A batch named by id must belong to the medicine named in the same command. Locks it. */
async function batchOfMedicine(client: pg.PoolClient, batchId: string, medicineId: string) {
  const r = await client.query('SELECT * FROM medicine_batches WHERE id = $1 AND medicine_id = $2 FOR UPDATE', [batchId, medicineId]);
  if (!r.rows[0]) throw new HttpError(404, 'This batch does not exist for this medicine in the shop.');
  return r.rows[0] as { id: string; batch_number: string; quantity_available: number; expiry_date: string | null };
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

/**
 * Locks the medicine, then checks concurrency: field expectations when the Administrator sent them
 * (precise), otherwise the conservative "no unsynced local change" rule.
 */
async function lockMedicineForEdit(client: pg.PoolClient, medicineId: string, expected: Record<string, unknown> | undefined) {
  const r = await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [medicineId]);
  if (!r.rows[0]) throw new HttpError(404, `Medicine ${medicineId} does not exist in this shop.`);
  const current = (await getMedicineById(medicineId, client))!;
  if (expected) assertExpected(current as any, expected, `"${current.name}"`);
  else await assertNoUnsyncedMedicineChange(client, medicineId);
  return current;
}

async function medicineEvent(client: pg.PoolClient, cmd: CloudCommand, type: 'MEDICINE_UPDATED' | 'MEDICINE_PRICE_CHANGED' | 'MEDICINE_CREATED', medicineId: string) {
  await enqueueSyncEvent(client, {
    event_type: type, entity_type: 'medicine', entity_id: medicineId, operation: 'CLOUD_COMMAND',
    data: async () => ({ medicine: await medicineJson(client, medicineId), command_id: cmd.command_id }),
    actor: cloudActor(cmd),
  });
}

type Handler = (client: pg.PoolClient, cmd: CloudCommand) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------- medicines / prices
  // Changes the CURRENT price only. sale_items keep their own price snapshot (never rewritten).
  async PRICE_UPDATE(client, cmd) {
    const p = validateCommandPayload('PRICE_UPDATE', cmd.payload);
    const before = await lockMedicineForEdit(client, p.medicine_id, p.expected);
    const saved = await applyPricingUpdate(client, p.medicine_id, fieldsOf(p, 'medicine_id') as any, cloudActor(cmd));
    await medicineEvent(client, cmd, 'MEDICINE_PRICE_CHANGED', p.medicine_id);
    return {
      medicine_id: p.medicine_id, selling_price: saved.selling_price, wholesale_price: saved.wholesale_price, min_selling_price: saved.min_selling_price,
      purchase_price: saved.purchase_price,
      previous: { selling_price: before.selling_price, wholesale_price: before.wholesale_price, min_selling_price: before.min_selling_price, purchase_price: before.purchase_price },
    };
  },

  async MEDICINE_METADATA_UPDATE(client, cmd) {
    const p = validateCommandPayload('MEDICINE_METADATA_UPDATE', cmd.payload);
    await lockMedicineForEdit(client, p.medicine_id, p.expected);
    const saved = await updateMedicineDetailsTx(client, p.medicine_id, fieldsOf(p, 'medicine_id') as any, cloudActor(cmd));
    await medicineEvent(client, cmd, 'MEDICINE_UPDATED', p.medicine_id);
    return { medicine_id: p.medicine_id, name: saved.name, category: saved.category, status: saved.status };
  },

  // New catalogue item (stock 0). Its id was chosen by the online API, so a re-delivery is a duplicate.
  async MEDICINE_CREATE(client, cmd) {
    const p = validateCommandPayload('MEDICINE_CREATE', cmd.payload);
    const saved = await createMedicineTx(client, p.medicine_id, fieldsOf(p, 'medicine_id') as any, cloudActor(cmd));
    await medicineEvent(client, cmd, 'MEDICINE_CREATED', p.medicine_id);
    return { medicine_id: saved.id, name: saved.name, sku: saved.sku, barcode: saved.barcode, selling_price: saved.selling_price, created: true };
  },

  // "Remove" a medicine = inactive. History (sales, movements, batches) is never deleted.
  async MEDICINE_SET_ACTIVE(client, cmd) {
    const p = validateCommandPayload('MEDICINE_SET_ACTIVE', cmd.payload);
    // Status is set explicitly (idempotent), so no unsynced-change refusal: an empty expectation.
    const before = await lockMedicineForEdit(client, p.medicine_id, {});
    const saved = await updateMedicineDetailsTx(client, p.medicine_id, { status: p.active ? 'active' : 'inactive' } as any, cloudActor(cmd));
    await recordAuditLog({
      ...cloudActor(cmd), action: p.active ? 'REMOTE_MEDICINE_ACTIVATED' : 'REMOTE_MEDICINE_DEACTIVATED', entity: 'medicine', entity_id: p.medicine_id,
      previous_value: { status: before.status }, new_value: { status: saved.status, ...ref(cmd, p) },
    } as any, client);
    await medicineEvent(client, cmd, 'MEDICINE_UPDATED', p.medicine_id);
    return { medicine_id: p.medicine_id, name: saved.name, previous_status: before.status, status: saved.status };
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
    if (batch) assertExpectedQuantity(Number(batch.quantity_available), p.expected_quantity, `batch ${batch.batch_number}`);
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
    const batch = await batchOfMedicine(client, p.batch_id, p.medicine_id);
    assertExpectedQuantity(Number(batch.quantity_available), p.expected_quantity, `batch ${batch.batch_number}`);
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

  // Physical count of one batch. expected_quantity is MANDATORY: when the batch quantity locked now
  // differs from what the Administrator saw (a sale happened meanwhile) the count is REJECTED, so a
  // stale count can never erase a cashier's movement.
  async STOCK_SET(client, cmd) {
    const p = validateCommandPayload('STOCK_SET', cmd.payload);
    let current = 0;
    let label = `batch ${p.batch_number || ''}`.trim();
    if (p.batch_id) {
      const b = await batchOfMedicine(client, p.batch_id, p.medicine_id);
      current = Number(b.quantity_available);
      label = `batch ${b.batch_number}`;
    } else {
      const b = (await client.query('SELECT quantity_available FROM medicine_batches WHERE medicine_id = $1 AND UPPER(batch_number) = $2 FOR UPDATE',
        [p.medicine_id, p.batch_number])).rows[0];
      current = b ? Number(b.quantity_available) : 0;
    }
    assertExpectedQuantity(current, p.expected_quantity, label);
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
    const batch = await batchOfMedicine(client, p.batch_id, p.medicine_id);
    if ('expected_expiry_date' in p) assertExpected({ expiry_date: batch.expiry_date }, { expiry_date: p.expected_expiry_date }, `batch ${batch.batch_number}`);
    const out = await adminEditBatchExpiryTx(client, { ...cloudActor(cmd), batch_id: p.batch_id, expiry_date: p.expiry_date });
    return {
      medicine_id: p.medicine_id, batch_id: p.batch_id, batch_number: out.batch.batch_number,
      expiry_date: out.batch.expiry_date || null, batch_status: out.batch.status, current_stock: out.medicine.current_stock,
    };
  },

  // ---------------------------------------------------------------- batches
  async BATCH_CREATE(client, cmd) {
    const p = validateCommandPayload('BATCH_CREATE', cmd.payload);
    const out = await adminCreateBatchTx(client, { ...cloudActor(cmd), ...fieldsOf(p) as any, notes: remoteNote(cmd, p.reason || 'new batch') });
    return {
      medicine_id: p.medicine_id, batch_id: out.batch.id, batch_number: out.batch.batch_number, quantity: out.batch.quantity_available,
      expiry_date: out.batch.expiry_date || null, current_stock: out.medicine.current_stock, movement_id: out.movement?.id ?? null,
    };
  },

  async BATCH_UPDATE(client, cmd) {
    const p = validateCommandPayload('BATCH_UPDATE', cmd.payload);
    const out = await adminUpdateBatchTx(client, { ...cloudActor(cmd), ...fieldsOf(p) as any },
      (current) => assertExpected(current, p.expected, 'this batch'));
    return { medicine_id: p.medicine_id, batch_id: p.batch_id, batch_number: out.batch.batch_number, supplier_id: out.batch.supplier_id || null,
      purchase_price: out.batch.purchase_price, selling_price_override: out.batch.selling_price_override ?? null };
  },

  // Out of sale = status 'recalled' (quantity kept, not sellable, not counted in stock).
  async BATCH_SET_ACTIVE(client, cmd) {
    const p = validateCommandPayload('BATCH_SET_ACTIVE', cmd.payload);
    const out = await adminSetBatchActiveTx(client, { ...cloudActor(cmd), medicine_id: p.medicine_id, batch_id: p.batch_id, active: p.active, reason: p.reason });
    return { medicine_id: p.medicine_id, batch_id: p.batch_id, batch_number: out.batch.batch_number, batch_status: out.batch.status, current_stock: out.medicine.current_stock };
  },

  // ---------------------------------------------------------------- suppliers / customers
  async SUPPLIER_CREATE(client, cmd) {
    const p = validateCommandPayload('SUPPLIER_CREATE', cmd.payload);
    const s = await createSupplierTx(client, p.supplier_id, fieldsOf(p, 'supplier_id'), cloudActor(cmd), ref(cmd));
    return { supplier_id: s.id, name: s.name, status: s.status, created: true };
  },
  async SUPPLIER_UPDATE(client, cmd) {
    const p = validateCommandPayload('SUPPLIER_UPDATE', cmd.payload);
    const s = await updateSupplierTx(client, p.supplier_id, fieldsOf(p, 'supplier_id'), cloudActor(cmd), { partial: true, expected: p.expected, extra: ref(cmd, p) });
    return { supplier_id: s.id, name: s.name, status: s.status };
  },
  async SUPPLIER_SET_ACTIVE(client, cmd) {
    const p = validateCommandPayload('SUPPLIER_SET_ACTIVE', cmd.payload);
    const s = await setSupplierActiveTx(client, p.supplier_id, p.active, p.reason, cloudActor(cmd), ref(cmd));
    return { supplier_id: s.id, name: s.name, status: s.status };
  },
  async CUSTOMER_CREATE(client, cmd) {
    const p = validateCommandPayload('CUSTOMER_CREATE', cmd.payload);
    const c = await createCustomerTx(client, p.customer_id, fieldsOf(p, 'customer_id'), cloudActor(cmd), ref(cmd));
    return { customer_id: c.id, name: c.name, created: true };
  },
  async CUSTOMER_UPDATE(client, cmd) {
    const p = validateCommandPayload('CUSTOMER_UPDATE', cmd.payload);
    const c = await updateCustomerTx(client, p.customer_id, fieldsOf(p, 'customer_id'), cloudActor(cmd), { partial: true, expected: p.expected, extra: ref(cmd, p) });
    return { customer_id: c.id, name: c.name };
  },
  async CUSTOMER_SET_ACTIVE(client, cmd) {
    const p = validateCommandPayload('CUSTOMER_SET_ACTIVE', cmd.payload);
    const c = await setCustomerActiveTx(client, p.customer_id, p.active, p.reason, cloudActor(cmd), ref(cmd));
    return { customer_id: c.id, name: c.name, active: c.active };
  },

  // ---------------------------------------------------------------- purchases
  async PURCHASE_CREATE(client, cmd) {
    const p = validateCommandPayload('PURCHASE_CREATE', cmd.payload);
    const pur = await createDraftPurchaseTx(client, p.purchase_id, fieldsOf(p, 'purchase_id') as any, cloudActor(cmd), ref(cmd));
    return { purchase_id: pur.id, order_number: pur.order_number, status: pur.status, total_amount: pur.total_amount, lines: pur.items.length };
  },
  async PURCHASE_UPDATE_DRAFT(client, cmd) {
    const p = validateCommandPayload('PURCHASE_UPDATE_DRAFT', cmd.payload);
    const pur = await updateDraftPurchaseTx(client, p.purchase_id, fieldsOf(p, 'purchase_id') as any, cloudActor(cmd), ref(cmd));
    return { purchase_id: pur.id, order_number: pur.order_number, status: pur.status, total_amount: pur.total_amount, lines: pur.items.length };
  },
  // Stock in, batches, movements, purchase state and audit: one transaction (this one).
  async PURCHASE_RECEIVE(client, cmd) {
    const p = validateCommandPayload('PURCHASE_RECEIVE', cmd.payload);
    const actor = cloudActor(cmd);
    let out;
    if (p.items) {
      const exists = await client.query('SELECT status FROM purchases WHERE id = $1', [p.purchase_id]);
      if (exists.rows[0]) throw new HttpError(409, `This purchase already exists (status ${exists.rows[0].status}); receive it without items.`);
      out = await receivePurchaseOrderTx(client, p.purchase_id, fieldsOf(p, 'purchase_id') as any, actor, ref(cmd));
    } else {
      out = await receiveDraftPurchaseTx(client, p.purchase_id, { invoice_number: p.invoice_number, payment_status: p.payment_status }, actor, ref(cmd));
    }
    return {
      purchase_id: out.purchase.id, order_number: out.purchase.order_number, status: out.purchase.status, invoice_number: out.purchase.invoice_number,
      total_amount: out.purchase.total_amount, medicines: out.medicines.map((m: any) => ({ id: m.id, current_stock: m.current_stock })),
    };
  },
  async PURCHASE_CANCEL(client, cmd) {
    const p = validateCommandPayload('PURCHASE_CANCEL', cmd.payload);
    const pur = await cancelPurchaseTx(client, p.purchase_id, p.reason, cloudActor(cmd), ref(cmd));
    return { purchase_id: pur.id, order_number: pur.order_number, status: pur.status };
  },

  // ---------------------------------------------------------------- expenses (never deleted)
  async EXPENSE_CREATE(client, cmd) {
    const p = validateCommandPayload('EXPENSE_CREATE', cmd.payload);
    const e = await recordExpenseTx(client, p.expense_id, fieldsOf(p, 'expense_id') as any, cloudActor(cmd), ref(cmd));
    return { expense_id: e.id, amount: e.amount, category: e.category, date: e.date, status: e.status };
  },
  async EXPENSE_UPDATE(client, cmd) {
    const p = validateCommandPayload('EXPENSE_UPDATE', cmd.payload);
    const e = await updateExpenseTx(client, p.expense_id, fieldsOf(p, 'expense_id') as any, cloudActor(cmd), { expected: p.expected, extra: ref(cmd, p) });
    return { expense_id: e.id, amount: e.amount, category: e.category, date: e.date, status: e.status };
  },
  async EXPENSE_VOID(client, cmd) {
    const p = validateCommandPayload('EXPENSE_VOID', cmd.payload);
    const e = await voidExpenseTx(client, p.expense_id, p.reason, cloudActor(cmd), ref(cmd));
    return { expense_id: e.id, amount: e.amount, status: e.status };
  },

  // ---------------------------------------------------------------- returns / sales (history kept)
  // Only an approved return affects stock, refunds and reports (same workflow as the shop).
  async RETURN_APPROVE(client, cmd) {
    const p = validateCommandPayload('RETURN_APPROVE', cmd.payload);
    const out = await approveReturnTx(client, p.return_id, {
      restock: p.restock, disposition: p.restock ? 'return_to_stock' : p.disposition, notes: p.notes ?? null, refund_method: p.refund_method,
    }, cloudActor(cmd));
    return {
      return_id: p.return_id, status: 'APPROVED', refund_amount: out.refund_amount, refund_method: out.refund_method, refund_shift_id: out.refund_shift_id,
      restocked: p.restock, current_stock: out.medicine.current_stock,
    };
  },
  async RETURN_REJECT(client, cmd) {
    const p = validateCommandPayload('RETURN_REJECT', cmd.payload);
    await rejectReturnTx(client, p.return_id, p.reason, cloudActor(cmd));
    return { return_id: p.return_id, status: 'REJECTED' };
  },
  // A completed sale is never edited: a void reverses its stock and marks it voided, audited.
  async SALE_VOID(client, cmd) {
    const p = validateCommandPayload('SALE_VOID', cmd.payload);
    const out = await voidSaleTx(client, p.sale_id, p.reason, cloudActor(cmd));
    return { sale_id: p.sale_id, receipt_number: out.sale.receipt_number, status: out.sale.status, batches_restocked: out.batches.length };
  },

  // ---------------------------------------------------------------- cashier shifts (figures never change)
  async SHIFT_REVIEW(client, cmd) {
    const p = validateCommandPayload('SHIFT_REVIEW', cmd.payload);
    return reviewShiftTx(client, p.shift_id, p.notes ?? null, cloudActor(cmd));
  },

  // ---------------------------------------------------------------- shop staff (no credentials)
  // Same rules as the shop's user screen: the last active Administrator can never be deactivated or
  // demoted. Passwords / PINs are NOT handled by commands (they would persist in cloud history).
  async USER_SET_ACTIVE(client, cmd) {
    const p = validateCommandPayload('USER_SET_ACTIVE', cmd.payload);
    const before = await lockUser(client, p.user_id);
    const saved = await updateUserTx(client, p.user_id, { active: p.active });
    await recordAuditLog({
      ...cloudActor(cmd), action: p.active ? 'REMOTE_USER_ACTIVATED' : 'REMOTE_USER_DEACTIVATED', entity: 'user', entity_id: p.user_id,
      previous_value: { active: before.active }, new_value: { active: saved.active, reason: p.reason, command_id: cmd.command_id },
    } as any, client);
    return { user_id: p.user_id, name: saved.name, active: saved.active, role: saved.role };
  },

  async USER_ROLE_UPDATE(client, cmd) {
    const p = validateCommandPayload('USER_ROLE_UPDATE', cmd.payload);
    const before = await lockUser(client, p.user_id);
    const saved = await updateUserTx(client, p.user_id, { role: p.role });
    await recordAuditLog({
      ...cloudActor(cmd), action: 'REMOTE_USER_ROLE_CHANGED', entity: 'user', entity_id: p.user_id,
      previous_value: { role: before.role }, new_value: { role: saved.role, reason: p.reason, command_id: cmd.command_id },
    } as any, client);
    return { user_id: p.user_id, name: saved.name, previous_role: before.role, role: saved.role };
  },

  // Name / username / email edited by an online Global Administrator. REJECTED when the shop's row no
  // longer holds what the Administrator saw (a newer local edit is never overwritten). Uniqueness is
  // enforced by updateUserTx (409). Ids, historical sales and receipts keep their recorded values.
  async USER_PROFILE_UPDATE(client, cmd) {
    const p = validateCommandPayload('USER_PROFILE_UPDATE', cmd.payload);
    await lockUser(client, p.user_id);
    const row = (await client.query('SELECT name, LOWER(username) AS username, LOWER(email) AS email FROM users WHERE id = $1', [p.user_id])).rows[0];
    const fields = USER_PROFILE_FIELDS.filter((f) => p[f] !== undefined);
    const stale = fields.filter((f) => (row[f] ?? null) !== (p.expected[f] ?? null));
    if (stale.length) {
      throw new HttpError(409, `This account was changed at the shop meanwhile (${stale.join(', ')}). Reload and edit again.`);
    }
    const before = Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
    const changes = Object.fromEntries(fields.map((f) => [f, p[f]]));
    const saved = await updateUserTx(client, p.user_id, changes);
    const after = Object.fromEntries(fields.map((f) => [f, (saved as any)[f] ?? null]));
    await recordAuditLog({
      ...cloudActor(cmd), action: 'REMOTE_USER_PROFILE_UPDATED', entity: 'user', entity_id: p.user_id,
      previous_value: before, new_value: { ...after, reason: p.reason ?? null, command_id: cmd.command_id },
    } as any, client);
    return { user_id: p.user_id, before, after };
  },

  // Re-sends the shop's FAILED outbox events (same ids + idempotency keys: never a duplicate in the cloud).
  async SYNC_RETRY_FAILED(client, cmd) {
    const p = validateCommandPayload('SYNC_RETRY_FAILED', cmd.payload);
    const r = await client.query(`UPDATE sync_events SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'FAILED' RETURNING id`);
    await recordAuditLog({
      ...cloudActor(cmd), action: 'SYNC_FAILED_EVENTS_REQUEUED', entity: 'sync', entity_id: 'sync_events',
      new_value: { requeued: r.rowCount || 0, reason: p.reason ?? null, command_id: cmd.command_id },
    } as any, client);
    return { requeued: r.rowCount || 0 };
  },

  // Signs the account out of every shop terminal (its tokens issued before now are refused).
  async USER_SESSION_REVOKE(client, cmd) {
    const p = validateCommandPayload('USER_SESSION_REVOKE', cmd.payload);
    const before = await lockUser(client, p.user_id);
    const at = await revokeUserSessionsTx(client, p.user_id);
    await recordAuditLog({
      ...cloudActor(cmd), action: 'REMOTE_USER_SESSIONS_REVOKED', entity: 'user', entity_id: p.user_id,
      new_value: { name: before.name, revoked_at: at, reason: p.reason, command_id: cmd.command_id },
    } as any, client);
    return { user_id: p.user_id, name: before.name, sessions_revoked_at: at };
  },

  // A staff account created by an online Global Administrator. The password HASH comes from the
  // cloud login mirror (fetched for this command only); the PIN is unusable until set at the shop.
  async USER_CREATE(client, cmd) {
    const p = validateCommandPayload('USER_CREATE', cmd.payload);
    const cred = requireCredential(cmd, p.user_id);
    const existing = (await client.query('SELECT id, email FROM users WHERE id = $1 FOR UPDATE', [p.user_id])).rows[0];
    if (existing) {
      if (String(existing.email).toLowerCase() !== p.email) throw new HttpError(409, 'A different staff account already uses this id.');
      return { user_id: p.user_id, already_existed: true };
    }
    const clash = (await client.query(
      `SELECT CASE WHEN LOWER(email) = $1 THEN 'email' ELSE 'username' END AS field FROM users WHERE LOWER(email) = $1 OR ($2::text IS NOT NULL AND LOWER(username) = $2) LIMIT 1`,
      [p.email, p.username])).rows[0];
    if (clash) throw new HttpError(409, `Another staff account in this shop already uses that ${clash.field}.`);
    await client.query(
      `INSERT INTO users (id, name, email, username, role, active, password_hash, pin_hash, credential_version, credential_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [p.user_id, p.name, p.email, p.username, p.role, cred.active !== false, cred.password_hash, unusablePinHash(),
       Number(cred.credential_version), cred.credential_updated_at]
    );
    await enqueueSyncEvent(client, {
      event_type: 'USER_UPSERTED', entity_type: 'user', entity_id: p.user_id, operation: 'CLOUD_COMMAND',
      data: async () => ({ user: await userJson(client, p.user_id), command_id: cmd.command_id }),
      actor: cloudActor(cmd),
    });
    await recordAuditLog({
      ...cloudActor(cmd), action: 'REMOTE_USER_CREATED', entity: 'user', entity_id: p.user_id,
      new_value: { name: p.name, email: p.email, username: p.username, role: p.role, command_id: cmd.command_id },
    } as any, client);
    return { user_id: p.user_id, name: p.name, role: p.role, created: true };
  },

  // A password reset by an online Global Administrator. Applied only when the cloud credential is
  // newer than the shop's (an offline password change made here later is kept and published instead).
  async USER_CREDENTIAL_REFRESH(client, cmd) {
    const p = validateCommandPayload('USER_CREDENTIAL_REFRESH', cmd.payload);
    const cred = requireCredential(cmd, p.user_id);
    const local = (await client.query(
      'SELECT id, credential_version, credential_updated_at::text AS at FROM users WHERE id = $1 FOR UPDATE', [p.user_id])).rows[0];
    if (!local) throw new HttpError(404, 'This user does not exist in the shop.');
    const newer = await credentialNewer(client, { v: Number(cred.credential_version), at: cred.credential_updated_at },
      { v: Number(local.credential_version), at: local.at });
    if (newer) {
      await client.query(
        `UPDATE users SET password_hash = $2, credential_version = $3, credential_updated_at = $4::timestamptz, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [p.user_id, cred.password_hash, Number(cred.credential_version), cred.credential_updated_at]);
    }
    await recordAuditLog({
      ...cloudActor(cmd), action: newer ? 'REMOTE_USER_PASSWORD_RESET' : 'REMOTE_USER_PASSWORD_RESET_SUPERSEDED', entity: 'user', entity_id: p.user_id,
      new_value: { credential_version: Number(newer ? cred.credential_version : local.credential_version), reason: p.reason, command_id: cmd.command_id },
    } as any, client);
    return newer
      ? { user_id: p.user_id, credential_version: Number(cred.credential_version), applied: true }
      : { user_id: p.user_id, applied: false, note: 'The shop has a newer password for this account; it is kept and published to the cloud.' };
  },

  // ---------------------------------------------------------------- software update approval
  // Records the approval only. The updater (scripts/updater/updater.mjs) installs it after checking
  // independently that the commit is the tip of the approved production branch, with a verified
  // backup first and automatic rollback if the new version is unhealthy.
  async APP_UPDATE_APPROVE(client, cmd) {
    const p = validateCommandPayload('APP_UPDATE_APPROVE', cmd.payload);
    const state = readUpdateState();
    if (!state) throw new HttpError(409, 'The updater is not installed on the shop computer (no update status yet).');
    if (state.available_commit !== p.target_commit) {
      throw new HttpError(409, `This version is not the update the shop detected on the approved production channel` +
        `${state.available_commit ? ` (${state.available_commit.slice(0, 12)})` : ' (none available)'}.`);
    }
    let row;
    try {
      row = (await client.query(
        `INSERT INTO update_approvals (target_commit, approved_by, command_id) VALUES ($1, $2, $3) RETURNING id, approved_at`,
        [p.target_commit, cloudActor(cmd).user_name, cmd.command_id]
      )).rows[0];
    } catch (err: any) {
      if (err?.code === '42P01') throw new HttpError(409, 'Local database migration 015 is missing; run npm run db:migrate on the shop computer.');
      throw err;
    }
    await recordAuditLog({
      ...cloudActor(cmd), action: 'REMOTE_UPDATE_APPROVED', entity: 'software_update', entity_id: p.target_commit,
      new_value: { target_commit: p.target_commit, reason: p.reason, command_id: cmd.command_id, current_commit: state.current_commit ?? null },
    } as any, client);
    return { approval_id: row.id, target_commit: p.target_commit, note: 'Approval recorded. The shop updater verifies, backs up and installs it; watch Updates.' };
  },
};

async function lockUser(client: pg.PoolClient, userId: string) {
  const r = await client.query('SELECT id, name, role, active FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!r.rows[0]) throw new HttpError(404, 'This user does not exist in the shop.');
  return r.rows[0] as { id: string; name: string; role: string; active: boolean };
}

export const SUPPORTED_COMMANDS = Object.keys(HANDLERS);
// The shop handles exactly the types the cloud accepts.
if (SUPPORTED_COMMANDS.length !== COMMAND_TYPES.length || !COMMAND_TYPES.every((t) => t in HANDLERS)) {
  throw new Error('Cloud command handlers are out of step with COMMAND_TYPES.');
}

/** Keys whose VALUES must never be stored (a malformed / hostile command may carry them; it is rejected anyway). */
const SECRET_KEY = /^(password|password_hash|pin|pin_hash|token|jwt|jwt_secret|sync_shop_token|secret|api_key|credential|hash)$/i;

/** Copy of a payload safe to store in sync_inbound_commands and the audit trail: secret-named values redacted. */
export function redactSecrets(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redactSecrets(x, depth + 1)]));
}

/** Deterministic database refusals (invalid data, constraint) are a rejection, not a retry. */
function isDataError(err: any): boolean {
  return typeof err?.code === 'string' && /^(22|23)/.test(err.code);
}

/**
 * Validates and applies one command exactly once. Business validation failures become REJECTED
 * (recorded, acknowledged, audited; a CONFLICT carries the shop's current values in `result`).
 * Infrastructure errors (database down) propagate so the command is retried on the next cycle.
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
      result = err instanceof HttpError && err.details ? { rejected: true, ...err.details } : null;
    }

    // A refused staff command left the cloud's immediate value (active / role / password) ahead of
    // the shop: re-publish this account so the cloud converges back to the shop's actual state.
    if (status === 'REJECTED' && USER_COMMANDS.includes(cmd.command_type) && isValidUuid(cmd.payload?.user_id)) {
      await client.query('SAVEPOINT gc_user_republish');
      try {
        await client.query(`UPDATE users SET auth_sync_seq = nextval('users_auth_sync_seq') WHERE id = $1`, [cmd.payload.user_id]);
        await client.query('RELEASE SAVEPOINT gc_user_republish');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT gc_user_republish'); // before local migration 016: nothing to re-publish
      }
    }
    await client.query(
      `INSERT INTO sync_inbound_commands (command_id, idempotency_key, shop_id, command_type, payload, status, result, error, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6::text, $7, $8, CASE WHEN $6::text = 'APPLIED' THEN CURRENT_TIMESTAMP END)`,
      [cmd.command_id, key, isValidUuid(cmd.shop_id) ? cmd.shop_id : identity.shop_id, String(cmd.command_type).slice(0, 60),
       JSON.stringify(redactSecrets(cmd.payload ?? null)), status, result ? JSON.stringify(result) : null, error]
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
        new_value: { command_type: cmd.command_type, payload: redactSecrets(cmd.payload ?? null), created_by: cmd.created_by ?? null, result, error },
      },
      client
    );
    return { command_id: cmd.command_id, status, result, error, duplicate: false };
  });
}

