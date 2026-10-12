import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, roundMoney, type Queryable } from './client';
import { recordAuditLog } from './audit';
import { assertExpected } from './concurrency';
import { enqueueSyncEvent, rowJson } from '../sync/outbox';
import type { SaleActor } from './sales';
import type { Supplier } from '../../src/types';

function toSupplier(r: any): Supplier {
  return {
    id: r.id,
    name: r.name,
    contact_person: r.contact_person || '',
    phone: r.phone || '',
    email: r.email || '',
    address: r.address || '',
    tax_pin: r.tax_pin || undefined,
    balance: Number(r.balance) || 0,
    status: r.status || 'active',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export async function getAllSuppliers(q: Queryable = pgPool): Promise<Supplier[]> {
  const res = await q.query('SELECT *, balance::float AS balance FROM suppliers ORDER BY name ASC');
  return res.rows.map(toSupplier);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Editable supplier fields (balance is maintained by purchases, set only through the local screen). */
export const SUPPLIER_FIELDS = ['name', 'contact_person', 'phone', 'email', 'address', 'tax_pin'] as const;

/** Full normalized record (missing text = cleared, exactly as the local supplier form behaves). */
function normalize(input: Partial<Supplier>) {
  const name = str(input?.name, 255);
  if (!name) throw new HttpError(400, 'Supplier name is required.');
  const status = input.status || 'active';
  if (!['active', 'inactive'].includes(status)) throw new HttpError(400, 'status must be active or inactive.');
  const balance = input.balance === undefined ? undefined : Number(input.balance);
  if (balance !== undefined && !Number.isFinite(balance)) throw new HttpError(400, 'balance must be a number.');
  return {
    fields: [name, str(input.contact_person, 255) || null, str(input.phone, 50), str(input.email, 100) || null,
      str(input.address, 2000) || null, str(input.tax_pin, 50) || null, status],
    balance,
  };
}

async function finish(client: pg.PoolClient, row: any, before: any, action: string, actor: SaleActor, extra: Record<string, unknown> = {}) {
  await recordAuditLog(
    {
      user_id: actor.user_id,
      user_name: actor.user_name,
      role: actor.role,
      device_id: actor.device_id,
      action,
      entity: 'supplier',
      entity_id: row.id,
      previous_value: before ? toSupplier(before) : undefined,
      new_value: { ...toSupplier(row), ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'SUPPLIER_UPSERTED',
    entity_type: 'supplier',
    entity_id: row.id,
    operation: before ? 'UPDATE' : 'CREATE',
    data: async () => ({ supplier: await rowJson(client, 'suppliers', row.id), ...extra }),
    actor,
  });
  return toSupplier(row);
}

/** Creates a supplier with a caller-chosen id (remote commands pass the id they announced). */
export async function createSupplierTx(client: pg.PoolClient, id: string, input: Partial<Supplier>, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const { fields, balance } = normalize(input);
  const res = await client.query(
    `INSERT INTO suppliers (id, name, contact_person, phone, email, address, tax_pin, status, balance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, balance::float AS balance`,
    [id, ...fields, roundMoney(balance ?? 0)]
  );
  return finish(client, res.rows[0], null, 'SUPPLIER_CREATED', actor, extra);
}

async function lockSupplier(client: pg.PoolClient, id: string) {
  const found = await client.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [id]);
  if (!found.rows[0]) throw new HttpError(404, 'Supplier not found.');
  return found.rows[0];
}

/**
 * Updates a supplier. `patch` replaces the whole editable record (local form) unless `partial`:
 * then only the given fields change (remote command) and `expected` is checked against the locked row.
 */
export async function updateSupplierTx(
  client: pg.PoolClient, id: string, patch: Partial<Supplier>, actor: SaleActor,
  opts: { partial?: boolean; expected?: Record<string, unknown>; extra?: Record<string, unknown>; action?: string } = {}
) {
  const before = await lockSupplier(client, id);
  assertExpected(toSupplier(before) as any, opts.expected, 'this supplier');
  const merged = opts.partial ? { ...toSupplier(before), ...patch } : patch;
  const { fields, balance } = normalize(merged);
  const res = await client.query(
    `UPDATE suppliers SET name=$2, contact_person=$3, phone=$4, email=$5, address=$6, tax_pin=$7, status=$8,
       balance = COALESCE($9, balance), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING *, balance::float AS balance`,
    [id, ...fields, balance === undefined || opts.partial ? null : roundMoney(balance)]
  );
  return finish(client, res.rows[0], before, opts.action || 'SUPPLIER_UPDATED', actor, opts.extra);
}

/** Deactivate / reactivate. A supplier is never deleted while purchases or batches reference it. */
export async function setSupplierActiveTx(client: pg.PoolClient, id: string, active: boolean, reason: string | null, actor: SaleActor, extra: Record<string, unknown> = {}) {
  return updateSupplierTx(client, id, { status: active ? 'active' : 'inactive' }, actor, {
    partial: true, extra: { reason, ...extra }, action: active ? 'SUPPLIER_ACTIVATED' : 'SUPPLIER_DEACTIVATED',
  });
}

/** Creates (no id) or updates (UUID id) a supplier. Never succeeds unless PostgreSQL committed. */
export async function upsertSupplier(input: Partial<Supplier>, actor: SaleActor): Promise<Supplier> {
  normalize(input);
  return withTransaction(async (client) =>
    input.id ? updateSupplierTx(client, requireUuid(input.id, 'supplier id'), input, actor) : createSupplierTx(client, crypto.randomUUID(), input, actor)
  );
}
