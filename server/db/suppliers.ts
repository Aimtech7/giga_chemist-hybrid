import crypto from 'crypto';
import { pgPool, HttpError, requireUuid, withTransaction, roundMoney, type Queryable } from './client';
import { recordAuditLog } from './audit';
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

/** Creates (no id) or updates (UUID id) a supplier. Never succeeds unless PostgreSQL committed. */
export async function upsertSupplier(input: Partial<Supplier>, actor: SaleActor): Promise<Supplier> {
  const name = str(input?.name, 255);
  if (!name) throw new HttpError(400, 'Supplier name is required.');
  const status = input.status || 'active';
  if (!['active', 'inactive'].includes(status)) throw new HttpError(400, 'status must be active or inactive.');
  const balance = input.balance === undefined ? undefined : Number(input.balance);
  if (balance !== undefined && !Number.isFinite(balance)) throw new HttpError(400, 'balance must be a number.');
  const fields = [
    name, str(input.contact_person, 255) || null, str(input.phone, 50), str(input.email, 100) || null,
    str(input.address, 2000) || null, str(input.tax_pin, 50) || null, status,
  ];

  return withTransaction(async (client) => {
    let row: any;
    let before: any = null;
    if (input.id) {
      const id = requireUuid(input.id, 'supplier id');
      const found = await client.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [id]);
      before = found.rows[0];
      if (!before) throw new HttpError(404, 'Supplier not found.');
      const res = await client.query(
        `UPDATE suppliers SET name=$2, contact_person=$3, phone=$4, email=$5, address=$6, tax_pin=$7, status=$8,
           balance = COALESCE($9, balance), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *, balance::float AS balance`,
        [id, ...fields, balance === undefined ? null : roundMoney(balance)]
      );
      row = res.rows[0];
    } else {
      const res = await client.query(
        `INSERT INTO suppliers (id, name, contact_person, phone, email, address, tax_pin, status, balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, balance::float AS balance`,
        [crypto.randomUUID(), ...fields, roundMoney(balance ?? 0)]
      );
      row = res.rows[0];
    }
    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: actor.device_id,
        action: before ? 'SUPPLIER_UPDATED' : 'SUPPLIER_CREATED',
        entity: 'supplier',
        entity_id: row.id,
        previous_value: before ? toSupplier(before) : undefined,
        new_value: toSupplier(row),
      },
      client
    );
    await enqueueSyncEvent(client, {
      event_type: 'SUPPLIER_UPSERTED',
      entity_type: 'supplier',
      entity_id: row.id,
      operation: before ? 'UPDATE' : 'CREATE',
      data: async () => ({ supplier: await rowJson(client, 'suppliers', row.id) }),
      actor,
    });
    return toSupplier(row);
  });
}
