import { HttpError, isValidUuid } from '../db/client';

/**
 * Cloud -> shop command payload rules, shared by BOTH sides:
 *   - the online (Vercel) API validates a remote Admin's request before queueing it
 *   - the shop validates again when it applies the command (never trusts the cloud row)
 * Pure functions, no database access: safe to bundle into the serverless API.
 *
 * Stock commands carry a MOVEMENT (add / remove a quantity) or a PHYSICAL COUNT for one batch —
 * never a "current_stock = X" snapshot. The shop's local PostgreSQL computes the result.
 */
export const COMMAND_TYPES = [
  'PRICE_UPDATE',
  'MEDICINE_METADATA_UPDATE',
  'CATEGORY_UPSERT',
  'SETTINGS_UPDATE',
  'STOCK_ADD',
  'STOCK_REMOVE',
  'STOCK_SET',
  'BATCH_EXPIRY_UPDATE',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const STOCK_COMMAND_TYPES: readonly CommandType[] = ['STOCK_ADD', 'STOCK_REMOVE', 'STOCK_SET'];

/** Same reasons the shop's Remove Stock dialog offers. */
export const STOCK_REMOVE_REASONS = ['Damaged', 'Expired', 'Lost', 'Physical stock correction', 'Other'] as const;

export const MAX_STOCK_QUANTITY = 1_000_000;

export const PRICE_FIELDS = ['selling_price', 'wholesale_price', 'min_selling_price', 'purchase_price'] as const;
export const METADATA_FIELDS = [
  'name', 'generic_name', 'brand_name', 'manufacturer', 'description', 'dosage_form',
  'dosage_strength', 'unit', 'prescription_required', 'category',
] as const;
export const SETTINGS_FIELDS = ['pharmacy_name', 'tagline', 'address', 'phone', 'email', 'receipt_header', 'receipt_footer'] as const;

const TEXT_LIMITS: Record<string, number> = {
  name: 255, generic_name: 255, brand_name: 255, manufacturer: 255, description: 2000, dosage_form: 100,
  dosage_strength: 100, unit: 50, category: 100,
  pharmacy_name: 255, tagline: 255, address: 500, phone: 50, email: 255, receipt_header: 1000, receipt_footer: 1000,
};

export function isCommandType(v: unknown): v is CommandType {
  return typeof v === 'string' && (COMMAND_TYPES as readonly string[]).includes(v);
}

function obj(payload: unknown): Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload must be an object.');
  return payload as Record<string, any>;
}

function onlyKeys(p: Record<string, any>, allowed: readonly string[], what: string) {
  const extra = Object.keys(p).filter((k) => p[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new HttpError(400, `${what} does not allow: ${extra.join(', ')}.`);
}

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !isValidUuid(v)) throw new HttpError(400, `${field} must be a valid UUID.`);
  return v.trim().toLowerCase();
}

function wholeNumber(v: unknown, field: string, min: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > MAX_STOCK_QUANTITY) {
    throw new HttpError(400, `${field} must be a whole number from ${min} to ${MAX_STOCK_QUANTITY}.`);
  }
  return n;
}

function reasonText(v: unknown, required: boolean): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw new HttpError(400, 'reason is required.');
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, 'reason must be text.');
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length < 3) throw new HttpError(400, 'reason must be at least 3 characters.');
  return t.slice(0, 200);
}

function batchNumber(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'batch_number must be text.');
  const t = v.trim().toUpperCase();
  if (t.length > 100 || !/^[A-Z0-9._\-/ ]+$/.test(t)) throw new HttpError(400, 'batch_number may contain letters, digits, space, . _ - / (max 100).');
  return t;
}

function expiry(v: unknown, field = 'expiry_date'): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new HttpError(400, `${field} must be YYYY-MM-DD or empty.`);
  const d = new Date(`${v.trim()}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v.trim()) throw new HttpError(400, `${field} is not a real date.`);
  return v.trim();
}

function money(v: unknown, field: string, nullable: boolean): number | null {
  if (v === null && nullable) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000_000) throw new HttpError(400, `${field} must be a non-negative amount.`);
  return Math.round(n * 100) / 100;
}

/**
 * Validates a payload and returns its normalized form (unknown fields refused, numbers checked,
 * text trimmed). Throws HttpError(400) with a message safe to show to the Admin.
 */
export function validateCommandPayload(type: string, payload: unknown): Record<string, any> {
  const p = obj(payload);
  switch (type) {
    case 'STOCK_ADD': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'batch_number', 'expiry_date', 'quantity', 'reason'], 'STOCK_ADD');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), quantity: wholeNumber(p.quantity, 'quantity', 1), reason: reasonText(p.reason, true) };
      if (p.batch_id !== undefined && p.batch_id !== null && p.batch_id !== '') {
        if (p.batch_number || p.expiry_date) throw new HttpError(400, 'Give either batch_id (existing batch) or batch_number + expiry_date (new batch), not both.');
        out.batch_id = uuid(p.batch_id, 'batch_id');
      } else {
        out.batch_number = batchNumber(p.batch_number);
        out.expiry_date = expiry(p.expiry_date);
      }
      return out;
    }
    case 'STOCK_REMOVE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'quantity', 'reason', 'notes'], 'STOCK_REMOVE');
      if (!STOCK_REMOVE_REASONS.includes(p.reason)) throw new HttpError(400, `reason must be one of: ${STOCK_REMOVE_REASONS.join(', ')}.`);
      const notes = reasonText(p.notes, p.reason === 'Other');
      return { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), quantity: wholeNumber(p.quantity, 'quantity', 1), reason: p.reason, notes };
    }
    case 'STOCK_SET': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'batch_number', 'quantity', 'reason'], 'STOCK_SET');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), quantity: wholeNumber(p.quantity, 'quantity', 0), reason: reasonText(p.reason, true) };
      if (p.batch_id) out.batch_id = uuid(p.batch_id, 'batch_id');
      else out.batch_number = batchNumber(p.batch_number);
      return out;
    }
    case 'BATCH_EXPIRY_UPDATE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'expiry_date', 'reason'], 'BATCH_EXPIRY_UPDATE');
      if (!('expiry_date' in p)) throw new HttpError(400, 'expiry_date is required (empty = unknown expiry).');
      return { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), expiry_date: expiry(p.expiry_date), reason: reasonText(p.reason, false) };
    }
    case 'PRICE_UPDATE': {
      onlyKeys(p, ['medicine_id', 'reason', ...PRICE_FIELDS], 'PRICE_UPDATE');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id') };
      for (const f of PRICE_FIELDS) if (p[f] !== undefined) out[f] = money(p[f], f, f === 'wholesale_price');
      if (Object.keys(out).length === 1) throw new HttpError(400, `PRICE_UPDATE needs at least one of: ${PRICE_FIELDS.join(', ')}.`);
      const r = reasonText(p.reason, false);
      if (r) out.reason = r;
      return out;
    }
    case 'MEDICINE_METADATA_UPDATE': {
      onlyKeys(p, ['medicine_id', 'reason', ...METADATA_FIELDS], 'MEDICINE_METADATA_UPDATE');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id') };
      for (const f of METADATA_FIELDS) {
        if (p[f] === undefined) continue;
        if (f === 'prescription_required') {
          if (typeof p[f] !== 'boolean') throw new HttpError(400, 'prescription_required must be true or false.');
          out[f] = p[f];
        } else {
          if (typeof p[f] !== 'string') throw new HttpError(400, `${f} must be text.`);
          const t = p[f].trim();
          if (f === 'name' && !t) throw new HttpError(400, 'name cannot be empty.');
          out[f] = t.slice(0, TEXT_LIMITS[f] || 255);
        }
      }
      if (Object.keys(out).length === 1) throw new HttpError(400, `MEDICINE_METADATA_UPDATE needs at least one of: ${METADATA_FIELDS.join(', ')}.`);
      const r = reasonText(p.reason, false);
      if (r) out.reason = r;
      return out;
    }
    case 'CATEGORY_UPSERT': {
      onlyKeys(p, ['name', 'description'], 'CATEGORY_UPSERT');
      const name = typeof p.name === 'string' ? p.name.trim().slice(0, 100) : '';
      if (!name) throw new HttpError(400, 'name is required.');
      if (p.description !== undefined && p.description !== null && typeof p.description !== 'string') throw new HttpError(400, 'description must be text.');
      return { name, description: typeof p.description === 'string' ? p.description.trim().slice(0, 2000) : null };
    }
    case 'SETTINGS_UPDATE': {
      onlyKeys(p, SETTINGS_FIELDS, 'SETTINGS_UPDATE');
      const out: Record<string, any> = {};
      for (const f of SETTINGS_FIELDS) {
        if (p[f] === undefined) continue;
        if (typeof p[f] !== 'string') throw new HttpError(400, `${f} must be text.`);
        out[f] = p[f].trim().slice(0, TEXT_LIMITS[f] || 255);
      }
      if (out.pharmacy_name === '') throw new HttpError(400, 'pharmacy_name cannot be empty.');
      if (Object.keys(out).length === 0) throw new HttpError(400, `SETTINGS_UPDATE needs at least one of: ${SETTINGS_FIELDS.join(', ')}.`);
      return out;
    }
    default:
      throw new HttpError(400, `Unsupported command type "${type}".`);
  }
}
