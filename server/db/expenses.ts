import crypto from 'crypto';
import { pgPool, HttpError, withTransaction, businessNow, roundMoney, type Queryable } from './client';
import { recordAuditLog } from './audit';
import { enqueueSyncEvent, rowJson } from '../sync/outbox';
import type { SaleActor } from './sales';
import type { Expense } from '../../src/types';

export const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salaries', 'Transport', 'Maintenance', 'Supplies', 'Miscellaneous'] as const;
const EXPENSE_PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'];
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
    user_name: r.user_name || 'Staff',
    date: r.date || '',
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

export async function recordExpense(input: Partial<Expense>, actor: SaleActor): Promise<Expense> {
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
  if (input.date !== undefined && input.date !== '' && !DATE_RE.test(String(input.date))) {
    throw new HttpError(400, 'Date must be YYYY-MM-DD.');
  }

  return withTransaction(async (client) => {
    const date = input.date || (await businessNow(client)).date;
    const id = crypto.randomUUID();
    const res = await client.query(
      `INSERT INTO expenses (id, category, description, amount, payment_method, reference, user_id, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, amount::float AS amount`,
      [id, category, description, roundMoney(amount), method,
       typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 100) : null,
       actor.user_id, date]
    );
    await recordAuditLog(
      {
        user_id: actor.user_id,
        user_name: actor.user_name,
        role: actor.role,
        device_id: actor.device_id,
        action: 'EXPENSE_RECORDED',
        entity: 'expense',
        entity_id: id,
        new_value: { category, description, amount: roundMoney(amount), payment_method: method, date },
      },
      client
    );
    await enqueueSyncEvent(client, {
      event_type: 'EXPENSE_RECORDED',
      entity_type: 'expense',
      entity_id: id,
      operation: 'CREATE',
      data: async () => ({ expense: await rowJson(client, 'expenses', id) }),
      actor,
    });
    return toExpense({ ...res.rows[0], user_name: actor.user_name });
  });
}
