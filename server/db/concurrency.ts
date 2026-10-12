import { HttpError } from './client';

/**
 * Optimistic concurrency for remote (online) edits. The Administrator's page may be stale: a cashier
 * sells, a local Administrator edits, sync lags. A command therefore carries what the Administrator
 * SAW ("expected" values); the shop compares them with its own row, LOCKED in the applying
 * transaction, and refuses the change when anything differs. Newer local activity is never
 * overwritten silently: the rejection names the field and the shop's current value.
 *
 * Field comparison (not a row version) on purpose: medicines.version moves on every sale, which
 * would reject almost every price edit at a busy counter.
 */
function norm(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).trim();
  if (t === '') return null;
  // Numeric text from PostgreSQL NUMERIC columns compares as a number ("12.50" = 12.5).
  if (/^-?\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 100) / 100;
  return t;
}

export function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a);
  const y = norm(b);
  if (typeof x === 'string' && typeof y === 'string') return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/**
 * Throws 409 CONFLICT when any expected field differs from the shop's current value.
 * `current` must be read under a row lock in the same transaction that applies the change.
 */
export function assertExpected(current: Record<string, unknown>, expected: Record<string, unknown> | undefined | null, what: string): void {
  if (!expected) return;
  const changed: Record<string, { expected: unknown; current: unknown }> = {};
  for (const [field, seen] of Object.entries(expected)) {
    if (!sameValue(current[field], seen)) changed[field] = { expected: norm(seen), current: norm(current[field]) };
  }
  const fields = Object.keys(changed);
  if (fields.length) {
    const list = fields.map((f) => `${f} is now ${JSON.stringify(changed[f].current)} (you saw ${JSON.stringify(changed[f].expected)})`).join('; ');
    throw new HttpError(409, `CONFLICT: ${what} changed since the page was loaded: ${list}. Refresh before retrying.`, { conflict: changed });
  }
}

/** Stock form of the same check: the batch quantity the Administrator saw vs the locked quantity. */
export function assertExpectedQuantity(current: number, expected: number | undefined | null, what: string): void {
  if (expected === undefined || expected === null) return;
  if (Number(current) !== Number(expected)) {
    throw new HttpError(
      409,
      `CONFLICT: current stock of ${what} changed since the page was loaded: the shop has ${current}, you saw ${expected}. ` +
        'Sales or other stock changes happened meanwhile; refresh before retrying.',
      { conflict: { quantity: { expected, current } } }
    );
  }
}
