import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, type Queryable } from './client';
import { recordAuditLog } from './audit';
import { assertExpected } from './concurrency';
import { enqueueSyncEvent, rowJson } from '../sync/outbox';
import type { SaleActor } from './sales';
import type { Customer } from '../../src/types';

function toCustomer(r: any): Customer {
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    name: r.name,
    phone: r.phone || '',
    email: r.email || '',
    address: r.address || '',
    notes: r.notes || '',
    credit_balance: Number(r.credit_balance) || 0,
    total_spent: Number(r.total_spent) || 0,
    last_visit: r.last_visit ? new Date(r.last_visit).toISOString() : undefined,
    active: r.active !== false,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export async function getAllCustomers(q: Queryable = pgPool): Promise<Customer[]> {
  const res = await q.query(
    'SELECT *, credit_balance::float AS credit_balance, total_spent::float AS total_spent FROM customers ORDER BY name ASC'
  );
  return res.rows.map(toCustomer);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'address', 'notes'] as const;

function normalize(input: Partial<Customer>) {
  const name = str(input?.name, 255);
  if (!name) throw new HttpError(400, 'Customer name is required.');
  return [name, str(input.phone, 50) || null, str(input.email, 100) || null, str(input.address, 2000) || null, str(input.notes, 2000) || null];
}

async function finish(client: pg.PoolClient, row: any, before: any, action: string, actor: SaleActor, extra: Record<string, unknown> = {}) {
  await recordAuditLog(
    {
      user_id: actor.user_id,
      user_name: actor.user_name,
      role: actor.role,
      device_id: actor.device_id,
      action,
      entity: 'customer',
      entity_id: row.id,
      previous_value: before ? { name: before.name, phone: before.phone, email: before.email, active: before.active !== false } : undefined,
      new_value: { name: row.name, phone: row.phone, email: row.email, active: row.active !== false, ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'CUSTOMER_UPSERTED',
    entity_type: 'customer',
    entity_id: row.id,
    operation: before ? 'UPDATE' : 'CREATE',
    data: async () => ({ customer: await rowJson(client, 'customers', row.id), ...extra }),
    actor,
  });
  return toCustomer(row);
}

export async function createCustomerTx(client: pg.PoolClient, id: string, input: Partial<Customer>, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const res = await client.query(
    `INSERT INTO customers (id, name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, ...normalize(input)]
  );
  return finish(client, res.rows[0], null, 'CUSTOMER_CREATED', actor, extra);
}

/**
 * Updates contact details. Spend totals and balances are maintained only by sales/returns, never
 * accepted here. `partial` (remote command): only given fields change, `expected` checked first.
 */
export async function updateCustomerTx(
  client: pg.PoolClient, id: string, patch: Partial<Customer>, actor: SaleActor,
  opts: { partial?: boolean; expected?: Record<string, unknown>; extra?: Record<string, unknown> } = {}
) {
  const found = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id]);
  const before = found.rows[0];
  if (!before) throw new HttpError(404, 'Customer not found.');
  assertExpected(toCustomer(before) as any, opts.expected, 'this customer');
  const merged = opts.partial ? { ...toCustomer(before), ...patch } : patch;
  const res = await client.query(
    `UPDATE customers SET name=$2, phone=$3, email=$4, address=$5, notes=$6, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
    [id, ...normalize(merged)]
  );
  return finish(client, res.rows[0], before, 'CUSTOMER_UPDATED', actor, opts.extra);
}

/** Deactivate / reactivate. Customers are never deleted: their sales keep pointing at them. */
export async function setCustomerActiveTx(client: pg.PoolClient, id: string, active: boolean, reason: string | null, actor: SaleActor, extra: Record<string, unknown> = {}) {
  const found = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id]);
  const before = found.rows[0];
  if (!before) throw new HttpError(404, 'Customer not found.');
  const res = await client.query('UPDATE customers SET active = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *', [id, active]);
  return finish(client, res.rows[0], before, active ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_DEACTIVATED', actor, { reason, ...extra });
}

/** Creates (no id) or updates (UUID id) a customer's contact details. */
export async function upsertCustomer(input: Partial<Customer>, actor: SaleActor): Promise<Customer> {
  normalize(input);
  return withTransaction(async (client) =>
    input.id ? updateCustomerTx(client, requireUuid(input.id, 'customer id'), input, actor) : createCustomerTx(client, crypto.randomUUID(), input, actor)
  );
}
