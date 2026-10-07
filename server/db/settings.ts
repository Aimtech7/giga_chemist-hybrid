import type pg from 'pg';
import { pgPool, HttpError, withTransaction, type Queryable } from './client';
import { recordAuditLog, type AuditEntry } from './audit';
import type { PharmacySettings } from '../../src/types';
import { enqueueSyncEvent } from '../sync/outbox';

/** The settings table is one row per branch; this local install uses the MAIN branch row. */
const MAIN_BRANCH_ID = '00000000-0000-0000-0000-000000000001';

/** Columns an Administrator may change, with their validators. */
const EDITABLE: Record<string, (v: any) => any> = {
  pharmacy_name: (v) => requiredText(v, 'Pharmacy name', 255),
  tagline: (v) => optionalText(v, 255),
  address: (v) => optionalText(v, 2000),
  phone: (v) => optionalText(v, 50),
  email: (v) => optionalText(v, 100),
  currency: (v) => requiredText(v, 'Currency', 10),
  tax_rate: (v) => numberInRange(v, 'Tax rate', 0, 100),
  tax_enabled: (v) => Boolean(v),
  receipt_header: (v) => optionalText(v, 2000),
  receipt_footer: (v) => optionalText(v, 2000),
  printer_type: (v) => {
    if (v !== '58mm' && v !== '80mm') throw new HttpError(400, 'printer_type must be 58mm or 80mm.');
    return v;
  },
  auto_print_receipt: (v) => Boolean(v),
  low_stock_threshold: (v) => wholeNumber(v, 'Low stock threshold'),
  expiry_warning_days: (v) => wholeNumber(v, 'Expiry warning days'),
};

function requiredText(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, `${field} is required.`);
  return s.slice(0, max);
}
function optionalText(v: unknown, max: number): string {
  return v === undefined || v === null ? '' : String(v).slice(0, max);
}
function numberInRange(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}.`);
  return Math.round(n * 100) / 100;
}
function wholeNumber(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative whole number.`);
  return n;
}

export function toSettings(r: any): PharmacySettings {
  return {
    pharmacy_name: r.pharmacy_name,
    tagline: r.tagline || '',
    address: r.address || '',
    phone: r.phone || '',
    email: r.email || '',
    currency: r.currency || 'KES',
    tax_rate: Number(r.tax_rate) || 0,
    tax_enabled: Boolean(r.tax_enabled),
    receipt_header: r.receipt_header || '',
    receipt_footer: r.receipt_footer || '',
    printer_type: r.printer_type === '58mm' ? '58mm' : '80mm',
    auto_print_receipt: Boolean(r.auto_print_receipt),
    low_stock_threshold: Number(r.low_stock_threshold) || 0,
    expiry_warning_days: Number(r.expiry_warning_days) || 0,
    require_prescription_warning: true,
    allow_walk_in: true,
    version: r.version || '1.0.0-pwa',
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
  };
}

async function ensureSettingsRow(q: Queryable): Promise<any> {
  const existing = await q.query(
    `SELECT * FROM settings ORDER BY (branch_id = $1) DESC, updated_at DESC NULLS LAST LIMIT 1`,
    [MAIN_BRANCH_ID]
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await q.query(
    `INSERT INTO settings (branch_id) VALUES ($1) ON CONFLICT (branch_id) DO NOTHING RETURNING *`,
    [MAIN_BRANCH_ID]
  );
  return created.rows[0] || (await q.query('SELECT * FROM settings WHERE branch_id = $1', [MAIN_BRANCH_ID])).rows[0];
}

export async function getPharmacySettings(q: Queryable = pgPool): Promise<PharmacySettings> {
  return toSettings(await ensureSettingsRow(q));
}

/** ADMIN: updates the editable settings columns in one transaction with an audit row. */
export async function updatePharmacySettings(
  changes: Partial<PharmacySettings>,
  actor: Omit<AuditEntry, 'action' | 'entity' | 'entity_id'>
): Promise<PharmacySettings> {
  return withTransaction((client) => updatePharmacySettingsTx(client, changes, actor));
}

/** updatePharmacySettings on the caller's transaction (audit + outbox event included). */
export async function updatePharmacySettingsTx(
  client: pg.PoolClient,
  changes: Partial<PharmacySettings>,
  actor: Omit<AuditEntry, 'action' | 'entity' | 'entity_id'>
): Promise<PharmacySettings> {
  const columns: string[] = [];
  const values: any[] = [];
  for (const [key, validate] of Object.entries(EDITABLE)) {
    if ((changes as any)[key] !== undefined) {
      columns.push(key);
      values.push(validate((changes as any)[key]));
    }
  }
  if (columns.length === 0) throw new HttpError(400, 'No editable settings were provided.');
  const before = await ensureSettingsRow(client);
  const assignments = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const res = await client.query(
    `UPDATE settings SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE branch_id = $1 RETURNING *`,
    [before.branch_id, ...values]
  );
  const after = toSettings(res.rows[0]);
  await recordAuditLog(
    {
      ...actor,
      action: 'PHARMACY_SETTINGS_UPDATED',
      entity: 'settings',
      entity_id: String(before.branch_id),
      previous_value: Object.fromEntries(columns.map((c) => [c, before[c]])),
      new_value: Object.fromEntries(columns.map((c) => [c, (after as any)[c]])),
    },
    client
  );
  await enqueueSyncEvent(client, {
    event_type: 'SETTINGS_UPDATED',
    entity_type: 'settings',
    entity_id: String(before.branch_id),
    operation: 'UPDATE',
    data: async () => ({
      settings: (await client.query('SELECT to_jsonb(s) AS j FROM settings s WHERE branch_id = $1', [before.branch_id])).rows[0]?.j ?? null,
    }),
    actor,
  });
  return after;
}
