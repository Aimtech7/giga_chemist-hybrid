import { HttpError, isValidUuid } from '../db/client';

/**
 * Cloud -> shop command payload rules, shared by BOTH sides:
 *   - the online (Vercel) API validates a remote Admin's request before queueing it
 *   - the shop validates again when it applies the command (never trusts the cloud row)
 * Pure functions, no database access: safe to bundle into the serverless API.
 *
 * Stock commands carry a MOVEMENT (add / remove a quantity) or a PHYSICAL COUNT for one batch —
 * never a "current_stock = X" snapshot. The shop's local PostgreSQL computes the result.
 *
 * OPTIMISTIC CONCURRENCY: edits of existing data may carry what the Administrator SAW —
 * `expected` (field -> value) or `expected_quantity` (batch stock). The shop compares them with the
 * row it locks and REJECTS the command when anything changed meanwhile (never overwrites silently).
 * STOCK_SET requires expected_quantity. Create commands carry an id chosen by the online API, so the
 * new record can be referenced before the shop has applied it and a re-delivery creates nothing twice.
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
  'USER_SET_ACTIVE',
  'USER_ROLE_UPDATE',
  'APP_UPDATE_APPROVE',
  'USER_CREATE',
  'USER_CREDENTIAL_REFRESH',
  // Full-write Global Admin (cloud migration 006)
  'MEDICINE_CREATE',
  'MEDICINE_SET_ACTIVE',
  'BATCH_CREATE',
  'BATCH_UPDATE',
  'BATCH_SET_ACTIVE',
  'SUPPLIER_CREATE',
  'SUPPLIER_UPDATE',
  'SUPPLIER_SET_ACTIVE',
  'CUSTOMER_CREATE',
  'CUSTOMER_UPDATE',
  'CUSTOMER_SET_ACTIVE',
  'PURCHASE_CREATE',
  'PURCHASE_UPDATE_DRAFT',
  'PURCHASE_RECEIVE',
  'PURCHASE_CANCEL',
  'EXPENSE_CREATE',
  'EXPENSE_UPDATE',
  'EXPENSE_VOID',
  'RETURN_APPROVE',
  'RETURN_REJECT',
  'SALE_VOID',
  'USER_SESSION_REVOKE',
  // Cashier shifts (cloud migration 009): an online Administrator reviews a CLOSED shift.
  'SHIFT_REVIEW',
  // Unified accounts (cloud migration 010): name / username / email of a shop staff account.
  'USER_PROFILE_UPDATE',
  // Sync control center (cloud migration 010): the shop re-sends its FAILED outbox events with their
  // ORIGINAL idempotency keys (the cloud answers DUPLICATE for anything it already has).
  'SYNC_RETRY_FAILED',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const STOCK_COMMAND_TYPES: readonly CommandType[] = ['STOCK_ADD', 'STOCK_REMOVE', 'STOCK_SET'];

/**
 * Commands that change stock quantities or need the shop's live state: the online app warns
 * strongly before queueing them while the shop is offline (they are re-checked on delivery).
 */
export const HIGH_CONFLICT_TYPES: readonly CommandType[] = [
  'STOCK_ADD', 'STOCK_REMOVE', 'STOCK_SET', 'BATCH_CREATE', 'PURCHASE_RECEIVE', 'RETURN_APPROVE', 'SALE_VOID',
];

/**
 * Types an Administrator may fan out to ALL shops (one independent command per shop). Never stock,
 * sales, returns, purchase receipt, users or device identity.
 */
export const ALL_SHOPS_TYPES: readonly CommandType[] = ['PRICE_UPDATE', 'MEDICINE_METADATA_UPDATE', 'CATEGORY_UPSERT', 'SETTINGS_UPDATE'];

/** Same reasons the shop's Remove Stock dialog offers. */
export const STOCK_REMOVE_REASONS = ['Damaged', 'Expired', 'Lost', 'Physical stock correction', 'Other'] as const;

export const MAX_STOCK_QUANTITY = 1_000_000;

/** Roles a remote Administrator may assign to shop staff: the shop's RBAC roles (server/auth.ts). */
export const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'CASHIER'] as const;

/** Staff profile fields USER_PROFILE_UPDATE may change (never a password, hash, PIN or role). */
export const USER_PROFILE_FIELDS = ['name', 'username', 'email'] as const;
export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number];
const STAFF_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAFF_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,49}$/;

/** One staff profile value, normalised exactly as the shop stores it (username null = none). */
export function staffProfileValue(field: UserProfileField, v: unknown): string | null {
  if (field === 'name') {
    const n = typeof v === 'string' ? v.trim() : '';
    if (!n || n.length > 255) throw new HttpError(400, 'name is required (max 255 characters).');
    return n;
  }
  if (field === 'email') {
    const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!STAFF_EMAIL_RE.test(e) || e.length > 255) throw new HttpError(400, 'A valid email address is required.');
    return e;
  }
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!STAFF_USERNAME_RE.test(u)) throw new HttpError(400, 'username must be 3-50 characters: letters, digits, dot, underscore or hyphen.');
  return u;
}

export const PRICE_FIELDS = ['selling_price', 'wholesale_price', 'min_selling_price', 'purchase_price'] as const;
export const METADATA_FIELDS = [
  'name', 'generic_name', 'brand_name', 'manufacturer', 'description', 'dosage_form',
  'dosage_strength', 'unit', 'prescription_required', 'category', 'sku', 'barcode', 'reorder_level', 'status', 'medicine_type',
] as const;
/** Non-secret shop settings an Administrator may change remotely (never credentials or device identity). */
export const SETTINGS_FIELDS = [
  'pharmacy_name', 'tagline', 'address', 'phone', 'email', 'receipt_header', 'receipt_footer',
  'currency', 'tax_rate', 'tax_enabled', 'printer_type', 'auto_print_receipt', 'low_stock_threshold', 'expiry_warning_days',
] as const;
export const SUPPLIER_FIELDS = ['name', 'contact_person', 'phone', 'email', 'address', 'tax_pin'] as const;
export const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'address', 'notes'] as const;
export const EXPENSE_FIELDS = ['category', 'description', 'amount', 'payment_method', 'reference', 'date'] as const;
export const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salaries', 'Transport', 'Maintenance', 'Supplies', 'Miscellaneous'] as const;
export const EXPENSE_PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;
export const BATCH_FIELDS = ['batch_number', 'supplier_id', 'purchase_price', 'selling_price_override', 'notes'] as const;
export const RETURN_DISPOSITIONS = ['quarantine', 'damaged', 'dispose'] as const;

const TEXT_LIMITS: Record<string, number> = {
  name: 255, generic_name: 255, brand_name: 255, manufacturer: 255, description: 2000, dosage_form: 100,
  dosage_strength: 100, unit: 50, category: 100, sku: 100, barcode: 100, medicine_type: 100,
  pharmacy_name: 255, tagline: 255, address: 2000, phone: 50, email: 255, receipt_header: 1000, receipt_footer: 1000,
  currency: 10, contact_person: 255, tax_pin: 50, notes: 2000, reference: 100,
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

function wholeNumber(v: unknown, field: string, min: number, max = MAX_STOCK_QUANTITY): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function reasonText(v: unknown, required: boolean, field = 'reason'): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length < 3) throw new HttpError(400, `${field} must be at least 3 characters.`);
  return t.slice(0, 500);
}

function batchNumber(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'batch_number must be text.');
  const t = v.trim().toUpperCase();
  if (t.length > 100 || !/^[A-Z0-9._\-/ ]+$/.test(t)) throw new HttpError(400, 'batch_number may contain letters, digits, space, . _ - / (max 100).');
  return t;
}

function date(v: unknown, field = 'expiry_date'): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new HttpError(400, `${field} must be YYYY-MM-DD or empty.`);
  const d = new Date(`${v.trim()}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v.trim()) throw new HttpError(400, `${field} is not a real date.`);
  return v.trim();
}

function money(v: unknown, field: string, nullable: boolean): number | null {
  if ((v === null || v === '') && nullable) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000_000) throw new HttpError(400, `${field} must be a non-negative amount.`);
  return Math.round(n * 100) / 100;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false.`);
  return v;
}

function text(v: unknown, field: string, opts: { required?: boolean; clearable?: boolean } = {}): string | null {
  if (v === null && opts.clearable) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const t = v.trim();
  if (!t && opts.required) throw new HttpError(400, `${field} cannot be empty.`);
  return t.slice(0, TEXT_LIMITS[field] || 255);
}

function email(v: unknown, field = 'email'): string {
  const t = text(v, field, { clearable: true }) ?? '';
  if (t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new HttpError(400, `${field} must be a valid email address or empty.`);
  return t.toLowerCase();
}

/**
 * `expected` (what the Administrator saw): an object whose keys are a subset of `allowed` and whose
 * values are plain scalars. Returned unchanged (the shop compares, normalizing numbers/text).
 */
function expectedOf(v: unknown, allowed: readonly string[], what: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${what}.expected must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.includes(k)) throw new HttpError(400, `${what}.expected does not allow: ${k}.`);
    if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) throw new HttpError(400, `${what}.expected.${k} must be a plain value.`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function expectedQuantity(v: unknown, required: boolean): number | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'expected_quantity (the batch quantity you are looking at) is required for a physical count.');
    return undefined;
  }
  return wholeNumber(v, 'expected_quantity', 0);
}

function withReason(out: Record<string, any>, v: unknown, required = false) {
  const r = reasonText(v, required);
  if (r) out.reason = r;
  return out;
}

function medicineFields(p: Record<string, any>, out: Record<string, any>) {
  for (const f of METADATA_FIELDS) {
    if (p[f] === undefined) continue;
    if (f === 'prescription_required') out[f] = bool(p[f], f);
    else if (f === 'reorder_level') out[f] = wholeNumber(p[f], 'reorder_level', 0);
    else if (f === 'status') {
      if (p[f] !== 'active' && p[f] !== 'inactive') throw new HttpError(400, 'status must be "active" or "inactive".');
      out[f] = p[f];
    } else {
      const t = text(p[f], f, { required: f === 'name' })!;
      if ((f === 'sku' || f === 'barcode') && t && !/^[A-Za-z0-9._\-/]+$/.test(t)) throw new HttpError(400, `${f} may contain letters, digits and . _ - / only.`);
      if ((f === 'sku' || f === 'barcode') && !t) throw new HttpError(400, `${f} cannot be cleared remotely.`);
      out[f] = t;
    }
  }
  return out;
}

function priceFields(p: Record<string, any>, out: Record<string, any>) {
  for (const f of PRICE_FIELDS) if (p[f] !== undefined) out[f] = money(p[f], f, f === 'wholesale_price');
  if (out.wholesale_price === 0) throw new HttpError(400, 'wholesale_price must be greater than zero (empty = no wholesale price).');
  return out;
}

function purchaseItems(v: unknown) {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'items must be a non-empty list.');
  if (v.length > 500) throw new HttpError(400, 'Too many lines in one purchase (max 500).');
  return v.map((raw, i) => {
    const it = obj(raw);
    onlyKeys(it, ['medicine_id', 'batch_number', 'expiry_date', 'manufacturing_date', 'quantity', 'purchase_price'], `items[${i}]`);
    return {
      medicine_id: uuid(it.medicine_id, `items[${i}].medicine_id`),
      batch_number: batchNumber(it.batch_number),
      expiry_date: date(it.expiry_date, `items[${i}].expiry_date`),
      manufacturing_date: date(it.manufacturing_date, `items[${i}].manufacturing_date`),
      quantity: wholeNumber(it.quantity, `items[${i}].quantity`, 1),
      purchase_price: money(it.purchase_price, `items[${i}].purchase_price`, false),
    };
  });
}

function paymentStatus(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!['paid', 'partial', 'unpaid'].includes(String(v))) throw new HttpError(400, 'payment_status must be paid, partial or unpaid.');
  return String(v);
}

function partialFields(p: Record<string, any>, fields: readonly string[], required: readonly string[] = []) {
  const out: Record<string, any> = {};
  for (const f of fields) {
    if (p[f] === undefined) continue;
    out[f] = f === 'email' ? email(p[f]) : text(p[f], f, { required: required.includes(f), clearable: !required.includes(f) });
  }
  return out;
}

function expenseFields(p: Record<string, any>, creating: boolean) {
  const out: Record<string, any> = {};
  if (p.category !== undefined || creating) {
    if (!EXPENSE_CATEGORIES.includes(p.category)) throw new HttpError(400, `category must be one of ${EXPENSE_CATEGORIES.join(', ')}.`);
    out.category = p.category;
  }
  if (p.description !== undefined || creating) out.description = text(p.description, 'description', { required: true });
  if (p.amount !== undefined || creating) {
    const a = money(p.amount, 'amount', false)!;
    if (a <= 0) throw new HttpError(400, 'amount must be greater than zero.');
    out.amount = a;
  }
  if (p.payment_method !== undefined) {
    if (!EXPENSE_PAYMENT_METHODS.includes(p.payment_method)) throw new HttpError(400, `payment_method must be one of ${EXPENSE_PAYMENT_METHODS.join(', ')}.`);
    out.payment_method = p.payment_method;
  }
  if (p.reference !== undefined) out.reference = text(p.reference, 'reference', { clearable: true });
  if (p.date !== undefined) out.date = date(p.date, 'date');
  return out;
}

function settingsFields(p: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const f of SETTINGS_FIELDS) {
    if (p[f] === undefined) continue;
    if (f === 'tax_enabled' || f === 'auto_print_receipt') out[f] = bool(p[f], f);
    else if (f === 'tax_rate') {
      const n = Number(p[f]);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'tax_rate must be between 0 and 100.');
      out[f] = Math.round(n * 100) / 100;
    } else if (f === 'low_stock_threshold' || f === 'expiry_warning_days') out[f] = wholeNumber(p[f], f, 0, 3650);
    else if (f === 'printer_type') {
      if (p[f] !== '58mm' && p[f] !== '80mm') throw new HttpError(400, 'printer_type must be 58mm or 80mm.');
      out[f] = p[f];
    } else {
      if (typeof p[f] !== 'string') throw new HttpError(400, `${f} must be text.`);
      out[f] = p[f].trim().slice(0, TEXT_LIMITS[f] || 255);
    }
  }
  if (out.pharmacy_name === '') throw new HttpError(400, 'pharmacy_name cannot be empty.');
  if (out.currency === '') throw new HttpError(400, 'currency cannot be empty.');
  return out;
}

/**
 * Validates a payload and returns its normalized form (unknown fields refused, numbers checked,
 * text trimmed). Throws HttpError(400) with a message safe to show to the Admin.
 */
export function validateCommandPayload(type: string, payload: unknown): Record<string, any> {
  const p = obj(payload);
  switch (type) {
    // ------------------------------------------------------------------ stock (movements / counts)
    case 'STOCK_ADD': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'batch_number', 'expiry_date', 'quantity', 'reason', 'expected_quantity'], 'STOCK_ADD');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), quantity: wholeNumber(p.quantity, 'quantity', 1), reason: reasonText(p.reason, true) };
      if (p.batch_id !== undefined && p.batch_id !== null && p.batch_id !== '') {
        if (p.batch_number || p.expiry_date) throw new HttpError(400, 'Give either batch_id (existing batch) or batch_number + expiry_date (new batch), not both.');
        out.batch_id = uuid(p.batch_id, 'batch_id');
        const eq = expectedQuantity(p.expected_quantity, false);
        if (eq !== undefined) out.expected_quantity = eq;
      } else {
        if (p.expected_quantity !== undefined && p.expected_quantity !== null) throw new HttpError(400, 'expected_quantity needs batch_id.');
        out.batch_number = batchNumber(p.batch_number);
        out.expiry_date = date(p.expiry_date);
      }
      return out;
    }
    case 'STOCK_REMOVE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'quantity', 'reason', 'notes', 'expected_quantity'], 'STOCK_REMOVE');
      if (!STOCK_REMOVE_REASONS.includes(p.reason)) throw new HttpError(400, `reason must be one of: ${STOCK_REMOVE_REASONS.join(', ')}.`);
      const notes = reasonText(p.notes, p.reason === 'Other', 'notes');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), quantity: wholeNumber(p.quantity, 'quantity', 1), reason: p.reason, notes };
      const eq = expectedQuantity(p.expected_quantity, false);
      if (eq !== undefined) out.expected_quantity = eq;
      return out;
    }
    case 'STOCK_SET': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'batch_number', 'quantity', 'reason', 'expected_quantity'], 'STOCK_SET');
      const out: Record<string, any> = {
        medicine_id: uuid(p.medicine_id, 'medicine_id'), quantity: wholeNumber(p.quantity, 'quantity', 0), reason: reasonText(p.reason, true),
        expected_quantity: expectedQuantity(p.expected_quantity, true),
      };
      if (p.batch_id) out.batch_id = uuid(p.batch_id, 'batch_id');
      else out.batch_number = batchNumber(p.batch_number);
      return out;
    }
    case 'BATCH_EXPIRY_UPDATE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'expiry_date', 'reason', 'expected_expiry_date'], 'BATCH_EXPIRY_UPDATE');
      if (!('expiry_date' in p)) throw new HttpError(400, 'expiry_date is required (empty = unknown expiry).');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), expiry_date: date(p.expiry_date), reason: reasonText(p.reason, false) };
      if ('expected_expiry_date' in p) out.expected_expiry_date = date(p.expected_expiry_date, 'expected_expiry_date');
      return out;
    }
    // ------------------------------------------------------------------ batches
    case 'BATCH_CREATE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'batch_number', 'expiry_date', 'supplier_id', 'purchase_price', 'selling_price_override', 'quantity', 'reason'], 'BATCH_CREATE');
      const out: Record<string, any> = {
        medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), batch_number: batchNumber(p.batch_number),
        expiry_date: date(p.expiry_date), quantity: wholeNumber(p.quantity ?? 0, 'quantity', 0),
      };
      if (p.supplier_id) out.supplier_id = uuid(p.supplier_id, 'supplier_id');
      if (p.purchase_price !== undefined && p.purchase_price !== null && p.purchase_price !== '') out.purchase_price = money(p.purchase_price, 'purchase_price', false);
      if (p.selling_price_override !== undefined && p.selling_price_override !== null && p.selling_price_override !== '') {
        out.selling_price_override = money(p.selling_price_override, 'selling_price_override', false);
      }
      return withReason(out, p.reason);
    }
    case 'BATCH_UPDATE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'reason', 'expected', ...BATCH_FIELDS], 'BATCH_UPDATE');
      const out: Record<string, any> = { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id') };
      if (p.batch_number !== undefined) out.batch_number = batchNumber(p.batch_number);
      if (p.supplier_id !== undefined) out.supplier_id = p.supplier_id === null || p.supplier_id === '' ? null : uuid(p.supplier_id, 'supplier_id');
      if (p.purchase_price !== undefined) out.purchase_price = money(p.purchase_price, 'purchase_price', false);
      if (p.selling_price_override !== undefined) out.selling_price_override = money(p.selling_price_override, 'selling_price_override', true);
      if (p.notes !== undefined) out.notes = text(p.notes, 'notes', { clearable: true });
      if (Object.keys(out).length === 2) throw new HttpError(400, `BATCH_UPDATE needs at least one of: ${BATCH_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, BATCH_FIELDS, 'BATCH_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'BATCH_SET_ACTIVE': {
      onlyKeys(p, ['medicine_id', 'batch_id', 'active', 'reason'], 'BATCH_SET_ACTIVE');
      return { medicine_id: uuid(p.medicine_id, 'medicine_id'), batch_id: uuid(p.batch_id, 'batch_id'), active: bool(p.active, 'active'), reason: reasonText(p.reason, true) };
    }
    // ------------------------------------------------------------------ medicines / prices
    case 'PRICE_UPDATE': {
      onlyKeys(p, ['medicine_id', 'reason', 'expected', ...PRICE_FIELDS], 'PRICE_UPDATE');
      const out = priceFields(p, { medicine_id: uuid(p.medicine_id, 'medicine_id') });
      if (Object.keys(out).length === 1) throw new HttpError(400, `PRICE_UPDATE needs at least one of: ${PRICE_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, PRICE_FIELDS, 'PRICE_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'MEDICINE_METADATA_UPDATE': {
      onlyKeys(p, ['medicine_id', 'reason', 'expected', ...METADATA_FIELDS], 'MEDICINE_METADATA_UPDATE');
      const out = medicineFields(p, { medicine_id: uuid(p.medicine_id, 'medicine_id') });
      if (Object.keys(out).length === 1) throw new HttpError(400, `MEDICINE_METADATA_UPDATE needs at least one of: ${METADATA_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, METADATA_FIELDS, 'MEDICINE_METADATA_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'MEDICINE_CREATE': {
      onlyKeys(p, ['medicine_id', 'reason', ...METADATA_FIELDS, ...PRICE_FIELDS], 'MEDICINE_CREATE');
      if (p.status !== undefined) throw new HttpError(400, 'A new medicine is always created active.');
      if (p.name === undefined) throw new HttpError(400, 'name is required.');
      const out = priceFields(p, medicineFields(p, { medicine_id: uuid(p.medicine_id, 'medicine_id') }));
      if (!out.selling_price || out.selling_price <= 0) throw new HttpError(400, 'selling_price must be greater than zero.');
      return withReason(out, p.reason);
    }
    case 'MEDICINE_SET_ACTIVE': {
      onlyKeys(p, ['medicine_id', 'active', 'reason'], 'MEDICINE_SET_ACTIVE');
      return { medicine_id: uuid(p.medicine_id, 'medicine_id'), active: bool(p.active, 'active'), reason: reasonText(p.reason, true) };
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
      const out = settingsFields(p);
      if (Object.keys(out).length === 0) throw new HttpError(400, `SETTINGS_UPDATE needs at least one of: ${SETTINGS_FIELDS.join(', ')}.`);
      return out;
    }
    // ------------------------------------------------------------------ suppliers / customers
    case 'SUPPLIER_CREATE': {
      onlyKeys(p, ['supplier_id', ...SUPPLIER_FIELDS], 'SUPPLIER_CREATE');
      if (p.name === undefined) throw new HttpError(400, 'name is required.');
      return { supplier_id: uuid(p.supplier_id, 'supplier_id'), ...partialFields(p, SUPPLIER_FIELDS, ['name']) };
    }
    case 'SUPPLIER_UPDATE': {
      onlyKeys(p, ['supplier_id', 'reason', 'expected', ...SUPPLIER_FIELDS], 'SUPPLIER_UPDATE');
      const out: Record<string, any> = { supplier_id: uuid(p.supplier_id, 'supplier_id'), ...partialFields(p, SUPPLIER_FIELDS, ['name']) };
      if (Object.keys(out).length === 1) throw new HttpError(400, `SUPPLIER_UPDATE needs at least one of: ${SUPPLIER_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, SUPPLIER_FIELDS, 'SUPPLIER_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'SUPPLIER_SET_ACTIVE': {
      onlyKeys(p, ['supplier_id', 'active', 'reason'], 'SUPPLIER_SET_ACTIVE');
      return { supplier_id: uuid(p.supplier_id, 'supplier_id'), active: bool(p.active, 'active'), reason: reasonText(p.reason, true) };
    }
    case 'CUSTOMER_CREATE': {
      onlyKeys(p, ['customer_id', ...CUSTOMER_FIELDS], 'CUSTOMER_CREATE');
      if (p.name === undefined) throw new HttpError(400, 'name is required.');
      return { customer_id: uuid(p.customer_id, 'customer_id'), ...partialFields(p, CUSTOMER_FIELDS, ['name']) };
    }
    case 'CUSTOMER_UPDATE': {
      onlyKeys(p, ['customer_id', 'reason', 'expected', ...CUSTOMER_FIELDS], 'CUSTOMER_UPDATE');
      const out: Record<string, any> = { customer_id: uuid(p.customer_id, 'customer_id'), ...partialFields(p, CUSTOMER_FIELDS, ['name']) };
      if (Object.keys(out).length === 1) throw new HttpError(400, `CUSTOMER_UPDATE needs at least one of: ${CUSTOMER_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, CUSTOMER_FIELDS, 'CUSTOMER_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'CUSTOMER_SET_ACTIVE': {
      onlyKeys(p, ['customer_id', 'active', 'reason'], 'CUSTOMER_SET_ACTIVE');
      return { customer_id: uuid(p.customer_id, 'customer_id'), active: bool(p.active, 'active'), reason: reasonText(p.reason, true) };
    }
    // ------------------------------------------------------------------ purchases
    case 'PURCHASE_CREATE': {
      onlyKeys(p, ['purchase_id', 'supplier_id', 'invoice_number', 'payment_status', 'notes', 'items'], 'PURCHASE_CREATE');
      const out: Record<string, any> = { purchase_id: uuid(p.purchase_id, 'purchase_id'), supplier_id: uuid(p.supplier_id, 'supplier_id'), items: purchaseItems(p.items) };
      if (p.invoice_number) out.invoice_number = text(p.invoice_number, 'invoice_number');
      const ps = paymentStatus(p.payment_status);
      if (ps) out.payment_status = ps;
      if (p.notes) out.notes = text(p.notes, 'notes');
      return out;
    }
    case 'PURCHASE_UPDATE_DRAFT': {
      onlyKeys(p, ['purchase_id', 'supplier_id', 'invoice_number', 'payment_status', 'notes', 'items'], 'PURCHASE_UPDATE_DRAFT');
      const out: Record<string, any> = { purchase_id: uuid(p.purchase_id, 'purchase_id') };
      if (p.supplier_id !== undefined) out.supplier_id = uuid(p.supplier_id, 'supplier_id');
      if (p.invoice_number !== undefined) out.invoice_number = text(p.invoice_number, 'invoice_number', { clearable: true });
      const ps = paymentStatus(p.payment_status);
      if (ps) out.payment_status = ps;
      if (p.notes !== undefined) out.notes = text(p.notes, 'notes', { clearable: true });
      if (p.items !== undefined) out.items = purchaseItems(p.items);
      if (Object.keys(out).length === 1) throw new HttpError(400, 'PURCHASE_UPDATE_DRAFT needs at least one change.');
      return out;
    }
    case 'PURCHASE_RECEIVE': {
      // Either receive an existing PENDING purchase (purchase_id only), or receive goods directly
      // (purchase_id announced by the online API + supplier_id + invoice_number + items).
      onlyKeys(p, ['purchase_id', 'supplier_id', 'invoice_number', 'payment_status', 'notes', 'items'], 'PURCHASE_RECEIVE');
      const out: Record<string, any> = { purchase_id: uuid(p.purchase_id, 'purchase_id') };
      const ps = paymentStatus(p.payment_status);
      if (ps) out.payment_status = ps;
      if (p.items !== undefined) {
        out.supplier_id = uuid(p.supplier_id, 'supplier_id');
        out.invoice_number = text(p.invoice_number, 'invoice_number', { required: true });
        out.items = purchaseItems(p.items);
        if (p.notes) out.notes = text(p.notes, 'notes');
      } else {
        if (p.supplier_id !== undefined || p.notes !== undefined) throw new HttpError(400, 'Receiving a pending purchase takes only purchase_id, invoice_number and payment_status.');
        if (p.invoice_number) out.invoice_number = text(p.invoice_number, 'invoice_number');
      }
      return out;
    }
    case 'PURCHASE_CANCEL': {
      onlyKeys(p, ['purchase_id', 'reason'], 'PURCHASE_CANCEL');
      return { purchase_id: uuid(p.purchase_id, 'purchase_id'), reason: reasonText(p.reason, true) };
    }
    // ------------------------------------------------------------------ expenses
    case 'EXPENSE_CREATE': {
      onlyKeys(p, ['expense_id', ...EXPENSE_FIELDS], 'EXPENSE_CREATE');
      return { expense_id: uuid(p.expense_id, 'expense_id'), payment_method: 'Cash', ...expenseFields(p, true) };
    }
    case 'EXPENSE_UPDATE': {
      onlyKeys(p, ['expense_id', 'reason', 'expected', ...EXPENSE_FIELDS], 'EXPENSE_UPDATE');
      const out: Record<string, any> = { expense_id: uuid(p.expense_id, 'expense_id'), ...expenseFields(p, false) };
      if (Object.keys(out).length === 1) throw new HttpError(400, `EXPENSE_UPDATE needs at least one of: ${EXPENSE_FIELDS.join(', ')}.`);
      const exp = expectedOf(p.expected, EXPENSE_FIELDS, 'EXPENSE_UPDATE');
      if (exp) out.expected = exp;
      return withReason(out, p.reason);
    }
    case 'EXPENSE_VOID': {
      onlyKeys(p, ['expense_id', 'reason'], 'EXPENSE_VOID');
      return { expense_id: uuid(p.expense_id, 'expense_id'), reason: reasonText(p.reason, true) };
    }
    // ------------------------------------------------------------------ returns / sales
    case 'RETURN_APPROVE': {
      onlyKeys(p, ['return_id', 'restock', 'disposition', 'notes', 'refund_method'], 'RETURN_APPROVE');
      const restock = bool(p.restock, 'restock');
      const out: Record<string, any> = { return_id: uuid(p.return_id, 'return_id'), restock };
      if (p.refund_method !== undefined) {
        if (!['Cash', 'M-Pesa', 'Card', 'Bank'].includes(p.refund_method)) throw new HttpError(400, 'refund_method must be Cash, M-Pesa, Card or Bank.');
        out.refund_method = p.refund_method;
      }
      if (!restock) {
        const d = p.disposition ?? 'quarantine';
        if (!RETURN_DISPOSITIONS.includes(d)) throw new HttpError(400, `disposition must be one of ${RETURN_DISPOSITIONS.join(', ')} when not restocking.`);
        out.disposition = d;
      } else if (p.disposition !== undefined) throw new HttpError(400, 'disposition is only used when restock is false.');
      const notes = reasonText(p.notes, false, 'notes');
      if (notes) out.notes = notes;
      return out;
    }
    case 'RETURN_REJECT': {
      onlyKeys(p, ['return_id', 'reason'], 'RETURN_REJECT');
      return { return_id: uuid(p.return_id, 'return_id'), reason: reasonText(p.reason, true) };
    }
    case 'SALE_VOID': {
      onlyKeys(p, ['sale_id', 'reason'], 'SALE_VOID');
      return { sale_id: uuid(p.sale_id, 'sale_id'), reason: reasonText(p.reason, true) };
    }
    case 'SHIFT_REVIEW': {
      onlyKeys(p, ['shift_id', 'notes'], 'SHIFT_REVIEW');
      const out: Record<string, any> = { shift_id: uuid(p.shift_id, 'shift_id') };
      const notes = reasonText(p.notes, false, 'notes');
      if (notes) out.notes = notes;
      return out;
    }
    // ------------------------------------------------------------------ staff
    case 'USER_SET_ACTIVE': {
      onlyKeys(p, ['user_id', 'active', 'reason'], 'USER_SET_ACTIVE');
      return { user_id: uuid(p.user_id, 'user_id'), active: bool(p.active, 'active'), reason: reasonText(p.reason, true) };
    }
    case 'USER_ROLE_UPDATE': {
      onlyKeys(p, ['user_id', 'role', 'reason'], 'USER_ROLE_UPDATE');
      if (!ASSIGNABLE_ROLES.includes(p.role)) throw new HttpError(400, `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
      return { user_id: uuid(p.user_id, 'user_id'), role: p.role, reason: reasonText(p.reason, true) };
    }
    // Profile edit with optimistic concurrency: `expected` = what the Administrator SAW for every
    // field being changed; the shop REJECTS the command when its row differs (no silent overwrite).
    case 'USER_PROFILE_UPDATE': {
      onlyKeys(p, ['user_id', 'name', 'username', 'email', 'expected', 'reason'], 'USER_PROFILE_UPDATE');
      const out: Record<string, any> = { user_id: uuid(p.user_id, 'user_id') };
      if (p.expected === undefined) throw new HttpError(400, 'expected (the values the Administrator saw) is required.');
      const exp = obj(p.expected);
      onlyKeys(exp, USER_PROFILE_FIELDS, 'USER_PROFILE_UPDATE expected');
      const expected: Record<string, string | null> = {};
      for (const f of USER_PROFILE_FIELDS) {
        if (p[f] === undefined) continue;
        out[f] = staffProfileValue(f, p[f]);
        if (!(f in exp)) throw new HttpError(400, `expected.${f} is required when ${f} is changed.`);
        expected[f] = staffProfileValue(f, exp[f]);
      }
      if (Object.keys(out).length === 1) throw new HttpError(400, 'Nothing to change: give name, username or email.');
      out.expected = expected;
      const reason = reasonText(p.reason, false);
      if (reason) out.reason = reason;
      return out;
    }
    case 'SYNC_RETRY_FAILED': {
      onlyKeys(p, ['reason', 'event_ids'], 'SYNC_RETRY_FAILED');
      const reason = reasonText(p.reason, false);
      const event_ids = Array.isArray(p.event_ids) ? p.event_ids.map((id: any) => uuid(id, 'event_id')) : undefined;
      const out: any = {};
      if (reason) out.reason = reason;
      if (event_ids) out.event_ids = event_ids;
      return out;
    }
    case 'USER_SESSION_REVOKE': {
      onlyKeys(p, ['user_id', 'reason'], 'USER_SESSION_REVOKE');
      return { user_id: uuid(p.user_id, 'user_id'), reason: reasonText(p.reason, false) };
    }
    // Credentials are NEVER in a command: the shop fetches the password hash for this one account
    // through the shop-authenticated gc_fetch_user_credential while the command is open.
    case 'USER_CREATE': {
      onlyKeys(p, ['user_id', 'name', 'email', 'username', 'role', 'credential_version'], 'USER_CREATE');
      if (!ASSIGNABLE_ROLES.includes(p.role)) throw new HttpError(400, `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 255) throw new HttpError(400, 'name is required (max 255 characters).');
      const mail = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 255) throw new HttpError(400, 'A valid email address is required.');
      let username: string | null = null;
      if (p.username !== undefined && p.username !== null && p.username !== '') {
        username = typeof p.username === 'string' ? p.username.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) throw new HttpError(400, 'username must be 3-50 characters: letters, digits, dot, underscore or hyphen.');
      }
      return { user_id: uuid(p.user_id, 'user_id'), name, email: mail, username, role: p.role, credential_version: wholeNumber(p.credential_version, 'credential_version', 1) };
    }
    case 'USER_CREDENTIAL_REFRESH': {
      onlyKeys(p, ['user_id', 'credential_version', 'reason'], 'USER_CREDENTIAL_REFRESH');
      return { user_id: uuid(p.user_id, 'user_id'), credential_version: wholeNumber(p.credential_version, 'credential_version', 1), reason: reasonText(p.reason, false) };
    }
    case 'APP_UPDATE_APPROVE': {
      onlyKeys(p, ['target_commit', 'reason'], 'APP_UPDATE_APPROVE');
      const c = typeof p.target_commit === 'string' ? p.target_commit.trim().toLowerCase() : '';
      if (!/^[0-9a-f]{40}$/.test(c)) throw new HttpError(400, 'target_commit must be a full 40-character commit id.');
      return { target_commit: c, reason: reasonText(p.reason, false) };
    }
    default:
      throw new HttpError(400, `Unsupported command type "${type}".`);
  }
}

/** The record a command is about (for listings and conflict display); null for shop-wide commands. */
export function commandEntity(type: string, payload: Record<string, any> | null | undefined): { entity: string; entity_id: string } | null {
  const p = payload || {};
  const pick: [string, string][] = [
    ['batch_id', 'batch'], ['medicine_id', 'medicine'], ['supplier_id', 'supplier'], ['customer_id', 'customer'],
    ['purchase_id', 'purchase'], ['expense_id', 'expense'], ['return_id', 'return'], ['sale_id', 'sale'], ['user_id', 'user'],
  ];
  // Purchases name a supplier too: the purchase is the subject.
  if (type.startsWith('PURCHASE_') && p.purchase_id) return { entity: 'purchase', entity_id: p.purchase_id };
  for (const [key, entity] of pick) if (typeof p[key] === 'string') return { entity, entity_id: p[key] };
  return null;
}

/** expected / expected_quantity / expected_expiry_date of a payload (what the Administrator saw). */
export function commandExpectation(payload: Record<string, any> | null | undefined): Record<string, unknown> | null {
  const p = payload || {};
  const out: Record<string, unknown> = {};
  if (p.expected && typeof p.expected === 'object') Object.assign(out, p.expected);
  if (p.expected_quantity !== undefined) out.quantity = p.expected_quantity;
  if (p.expected_expiry_date !== undefined) out.expiry_date = p.expected_expiry_date;
  return Object.keys(out).length ? out : null;
}
