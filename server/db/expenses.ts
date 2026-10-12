import crypto from 'crypto';
import type pg from 'pg';
import { pgPool, HttpError, requireUuid, withTransaction, businessNow, roundMoney, cleanUuid, type Queryable } from './client';
import { recordAuditLog } from './audit';
import { assertExpected } from './concurrency';
import { enqueueSyncEvent, rowJson } from '../sync/outbox';
import type { SaleActor } from './sales';
import type { Expense } from '../../src/types';

export const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salaries', 'Transport', 'Maintenance', 'Supplies', 'Miscellaneous'] as const;
export const EXPENSE_PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'];
export const EXPENSE_FIELDS = ['category', 'description', 'amount', 'payment_method', 'reference', 'date'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toExpense(r: any): Expense {
  return {
    id: r.id,
    branch_id: r.branch_id || undefined,
    category: r.category,
    description: r.description,
    amount: Number(r.amount) || 0,
    payment_method: r.payment_method,
    reference: r.reference || undefined,
    user_id: r.user_id,
    user_name: r.user_name || r.created_by_name || 'Staff',
    date: r.date || '',
    status: r.status === 'voided' ? 'voided' : 'posted',
    void_reason: r.void_reason || undefined,
    voided_at: r.voided_at ? new Date(r.voided_at).toISOString() : undefined,
    sync_status: 'synced',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
  } as Expense;
}

export async function getAllExpenses(q: Queryable = pgPool): Promise<Expense[]> {
  const res = await q.query(
    `SELECT e.*, e.amount::float AS amount, u.name AS user_name
     FROM expenses e LEFT JOIN users u ON e.user_id = u.id
     ORDER BY e.date DESC, e.created_at DESC LIMIT 2000`
  );
  return res.rows.map(toExpense);
}

/** Validates a full expense record (same rules for the shop screen and remote commands). */
function normalize(input: Partial<Expense>) {
  const category = input?.category;
  if (!category || !EXPENSE_CATEGORIES.includes(category as any)) {
    throw new HttpError(400, `Category must be one of ${EXPENSE_CATEGORIES.join(', ')}.`);
  }
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : '';
  if (!description) throw new HttpError(400, 'Description is required.');
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Amount must be greater than zero.');
  const method = input.payment_method || 'Cash';
  if (!EXPENSE_PAYMENT_METHODS.includes(method)) throw new HttpError(400, `Payment method must be one of ${EXPENSE_PAYMENT_METHODS.join(', ')}.`);
  if (input.date !== undefined && input.date !== '' && input.date !== null && !DATE_RE.test(String(input.date))) {
    throw new HttpError(400, 'Date must be YYYY-MM-DD.');
  }
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 100) : null;
  return { category, description, amount: roundMoney(amount), method, reference, date: input.date ? String(input.date) : '' };
}

const auditActor = (actor: SaleActor) => ({ user_id: actor.user_id, user_name: actor.user_name, role: actor.role, device_id: actor.device_id });

async function lockExpense(client: pg.PoolClient, id: string) {
  const r = await client.query('SELECT *, amount::float AS amount FROM expenses WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Expense not found.');
  return r.rows[0];
}

/** Records an expense with a caller-chosen id (a remote command announces its id in advance). */
export async function recordExpenseTx(client: pg.PoolClient, id: string, input: Partial<Expense>, actor: SaleActor, extra: Record<string, unknown> = {}): Promise<Expense> {
  const v = normalize(input);
  const date = v.date || (await businessNow(client)).date;
  const res = await client.query(
    `INSERT INTO expenses (id, category, description, amount, payment_method, reference, user_id, date, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, amount::float AS amount`,
    [id, v.category, v.description, v.amount, v.method, v.reference, cleanUuid(actor.user_id), date, (actor.user_name || 'Staff').slice(0, 255)]
  );
  await recordAuditLog(
    {
      ...auditActor(actor),
      action: 'EXPENSE_RECORDED',
      entity: 'expense',
      entity_id: id,
      new_value: { category: v.category, description: v.description, amount: v.amount, payment_method: v.method, date, ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'EXPENSE_RECORDED',
    entity_type: 'expense',
    entity_id: id,
    operation: 'CREATE',
    data: async () => ({ expense: await rowJson(client, 'expenses', id), ...extra }),
    actor,
  });
  return toExpense({ ...res.rows[0], user_name: actor.user_name });
}

/**
 * Corrects a POSTED expense (partial fields; `expected` = what the editor saw). A voided expense is
 * final. The previous values stay in the audit trail.
 */
export async function updateExpenseTx(
  client: pg.PoolClient, id: string, patch: Partial<Expense>, actor: SaleActor,
  opts: { expected?: Record<string, unknown>; extra?: Record<string, unknown> } = {}
): Promise<Expense> {
  const before = await lockExpense(client, id);
  if (before.status === 'voided') throw new HttpError(409, 'This expense is voided and can no longer be edited.');
  assertExpected(toExpense(before) as any, opts.expected, 'this expense');
  const v = normalize({ ...toExpense(before), ...patch });
  const res = await client.query(
    `UPDATE expenses SET category = $2, description = $3, amount = $4, payment_method = $5, reference = $6, date = COALESCE(NULLIF($7, '')::date, date),
       updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *, amount::float AS amount`,
    [id, v.category, v.description, v.amount, v.method, v.reference, v.date]
  );
  const after = res.rows[0];
  await recordAuditLog(
    {
      ...auditActor(actor),
      action: 'EXPENSE_UPDATED',
      entity: 'expense',
      entity_id: id,
      previous_value: { category: before.category, description: before.description, amount: before.amount, payment_method: before.payment_method, date: before.date },
      new_value: { category: after.category, description: after.description, amount: after.amount, payment_method: after.payment_method, date: after.date, ...opts.extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'EXPENSE_UPDATED', entity_type: 'expense', entity_id: id, operation: 'UPDATE',
    data: async () => ({ expense: await rowJson(client, 'expenses', id), ...opts.extra }),
    actor,
  });
  return toExpense(after);
}

/** Voids a posted expense: kept for the audit trail, excluded from every report. Never deleted. */
export async function voidExpenseTx(client: pg.PoolClient, id: string, reasonRaw: unknown, actor: SaleActor, extra: Record<string, unknown> = {}): Promise<Expense> {
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 1000) : '';
  if (reason.length < 3) throw new HttpError(400, 'A void reason (at least 3 characters) is required.');
  const before = await lockExpense(client, id);
  if (before.status === 'voided') throw new HttpError(409, 'This expense is already voided.');
  const res = await client.query(
    `UPDATE expenses SET status = 'voided', void_reason = $2, voided_at = CURRENT_TIMESTAMP, voided_by_name = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *, amount::float AS amount`,
    [id, reason, (actor.user_name || 'Staff').slice(0, 255)]
  );
  await recordAuditLog(
    {
      ...auditActor(actor),
      action: 'EXPENSE_VOIDED',
      entity: 'expense',
      entity_id: id,
      previous_value: { status: 'posted', amount: before.amount, category: before.category, date: before.date },
      new_value: { status: 'voided', reason, ...extra },
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'EXPENSE_VOIDED', entity_type: 'expense', entity_id: id, operation: 'VOID',
    data: async () => ({ expense: await rowJson(client, 'expenses', id), ...extra }),
    actor,
  });
  return toExpense(res.rows[0]);
}

export async function recordExpense(input: Partial<Expense>, actor: SaleActor): Promise<Expense> {
  normalize(input);
  return withTransaction((client) => recordExpenseTx(client, crypto.randomUUID(), input, actor));
}

export async function updateExpense(id: string, patch: Partial<Expense>, actor: SaleActor): Promise<Expense> {
  const expenseId = requireUuid(id, 'expense id');
  return withTransaction((client) => updateExpenseTx(client, expenseId, patch, actor));
}

export async function voidExpense(id: string, reason: unknown, actor: SaleActor): Promise<Expense> {
  const expenseId = requireUuid(id, 'expense id');
  return withTransaction((client) => voidExpenseTx(client, expenseId, reason, actor));
}
