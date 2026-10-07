import crypto from 'crypto';
import { pgPool, HttpError, requireUuid, withTransaction, type Queryable } from './client';
import { recordAuditLog } from './audit';
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

/**
 * Creates (no id) or updates (UUID id) a customer's contact details. Spend totals and balances are
 * maintained only by sales/returns, never accepted from the client.
 */
export async function upsertCustomer(input: Partial<Customer>, actor: SaleActor): Promise<Customer> {
  const name = str(input?.name, 255);
  if (!name) throw new HttpError(400, 'Customer name is required.');
  const fields = [name, str(input.phone, 50) || null, str(input.email, 100) || null, str(input.address, 2000) || null, str(input.notes, 2000) || null];

  return withTransaction(async (client) => {
    let row: any;
    let created = false;
    if (input.id) {
      const id = requireUuid(input.id, 'customer id');
      const res = await client.query(
        `UPDATE customers SET name=$2, phone=$3, email=$4, address=$5, notes=$6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [id, ...fields]
      );
      row = res.rows[0];
      if (!row) throw new HttpError(404, 'Customer not found.');
    } else {
      const res = await client.query(
        `INSERT INTO customers (id, name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [crypto.randomUUID(), ...fields]
      );
      row = res.rows[0];
      created = true;
    }
    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: actor.device_id,
        action: created ? 'CUSTOMER_CREATED' : 'CUSTOMER_UPDATED',
        entity: 'customer',
        entity_id: row.id,
        new_value: { name: row.name, phone: row.phone },
      },
      client
    );
    await enqueueSyncEvent(client, {
      event_type: 'CUSTOMER_UPSERTED',
      entity_type: 'customer',
      entity_id: row.id,
      operation: created ? 'CREATE' : 'UPDATE',
      data: async () => ({ customer: await rowJson(client, 'customers', row.id) }),
      actor,
    });
    return toCustomer(row);
  });
}
