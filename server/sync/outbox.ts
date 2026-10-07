import crypto from 'crypto';
import type pg from 'pg';
import { cleanUuid } from '../db/client';
import { getSyncConfig } from './config';
import { getShopIdentity } from './identity';
import { takeCollected } from './collector';

/**
 * Durable outbox. enqueueSyncEvent() MUST be called with the business transaction's client, before
 * COMMIT: the business change and its sync event then commit (or roll back) together.
 *
 * In APP_MODE=local it records nothing (no cloud dependency at all).
 *
 * Stock is never sent as a "current_stock = X" snapshot. Events carry the immutable
 * inventory_movements rows (with their deltas) written by the same transaction.
 */
export type SyncEventType =
  | 'SALE_COMPLETED'
  | 'SALE_VOIDED'
  | 'RETURN_REQUESTED'
  | 'RETURN_APPROVED'
  | 'RETURN_REJECTED'
  | 'PURCHASE_RECEIVED'
  | 'STOCK_SET'
  | 'STOCK_ADDED'
  | 'STOCK_REMOVED'
  | 'PHYSICAL_COUNT'
  | 'BATCH_EXPIRY_CHANGED'
  | 'MEDICINE_CREATED'
  | 'MEDICINE_UPDATED'
  | 'MEDICINE_PRICE_CHANGED'
  | 'MEDICINE_BASELINE'
  | 'SUPPLIER_UPSERTED'
  | 'CUSTOMER_UPSERTED'
  | 'EXPENSE_RECORDED'
  | 'SETTINGS_UPDATED'
  | 'USER_UPSERTED';

export interface SyncActor {
  user_id?: string | null;
  user_name?: string | null;
  role?: string | null;
  device_id?: string | null;
}

export interface EnqueueInput {
  event_type: SyncEventType;
  entity_type: string;
  entity_id: string;
  operation: string;
  /** Business snapshot; a function is evaluated only when the outbox is enabled. */
  data: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
  actor: SyncActor;
  /** Resolved device id of the terminal (falls back to actor.device_id). */
  device_id?: string | null;
  /** Receipt / order / invoice number etc. */
  business_ref?: string | null;
}

export function isOutboxEnabled(): boolean {
  return getSyncConfig().outboxEnabled;
}

/** Returns the new event id, or null when the outbox is disabled (local mode). */
export async function enqueueSyncEvent(client: pg.PoolClient, input: EnqueueInput): Promise<string | null> {
  const collected = takeCollected(client);
  if (!isOutboxEnabled()) return null;

  const identity = await getShopIdentity(client);
  const eventId = crypto.randomUUID();
  const idempotencyKey = `gc:${identity.shop_id}:${eventId}`;

  // Batch metadata for every batch the movements touched (number, expiry) — never quantities as truth.
  const batchIds = [...new Set(collected.movements.map((m) => String(m.batch_id)).filter(Boolean))];
  const batches = batchIds.length
    ? (await client.query(
        `SELECT id, medicine_id, batch_number, expiry_date, expiry_status, status, supplier_id,
                purchase_price, selling_price_override, received_date
           FROM medicine_batches WHERE id = ANY($1::uuid[])`,
        [batchIds]
      )).rows
    : [];

  const data = typeof input.data === 'function' ? await input.data() : input.data;
  const payload = {
    data,
    movements: collected.movements,
    batches,
    audit: collected.audits,
    actor: {
      user_id: cleanUuid(input.actor.user_id || null),
      user_name: input.actor.user_name || null,
      role: input.actor.role || null,
    },
  };

  const deviceId = (input.device_id || input.actor.device_id || null)?.toString().slice(0, 100) || null;
  await client.query(
    `INSERT INTO sync_events (
       id, idempotency_key, shop_id, device_id, event_type, operation, entity_type, entity_id,
       payload, actor_user_id, actor_name, business_ref, status, next_attempt_at, processed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING', CURRENT_TIMESTAMP, NULL)`,
    [
      eventId,
      idempotencyKey,
      identity.shop_id,
      deviceId,
      input.event_type,
      input.operation.slice(0, 50),
      input.entity_type.slice(0, 50),
      String(input.entity_id).slice(0, 100),
      JSON.stringify(payload),
      cleanUuid(input.actor.user_id || null),
      (input.actor.user_name || '').slice(0, 255) || null,
      input.business_ref ? String(input.business_ref).slice(0, 100) : null,
    ]
  );
  return eventId;
}

/** Raw row of a table as JSON (inside the caller's transaction). */
export async function rowJson(client: pg.PoolClient, table: string, id: string): Promise<Record<string, unknown> | null> {
  const res = await client.query(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE t.id = $1`, [id]);
  return res.rows[0]?.j ?? null;
}

/** Raw rows of a child table as JSON. */
export async function rowsJson(client: pg.PoolClient, table: string, fkColumn: string, id: string): Promise<Record<string, unknown>[]> {
  const res = await client.query(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE t.${fkColumn} = $1 ORDER BY t.id`, [id]);
  return res.rows.map((r) => r.j);
}

/** Medicine metadata for the cloud. current_stock is deliberately omitted (stock moves only by ledger). */
export async function medicineJson(client: pg.PoolClient, medicineId: string): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT to_jsonb(m) - 'current_stock' || jsonb_build_object('category', c.name) AS j
       FROM medicines m LEFT JOIN categories c ON c.id = m.category_id WHERE m.id = $1`,
    [medicineId]
  );
  return res.rows[0]?.j ?? null;
}

/** Public user profile for the cloud: credentials (password/PIN hashes) never leave the shop. */
export async function userJson(client: pg.PoolClient, userId: string): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT to_jsonb(u) - 'password_hash' - 'pin_hash' AS j FROM users u WHERE u.id = $1`,
    [userId]
  );
  return res.rows[0]?.j ?? null;
}
