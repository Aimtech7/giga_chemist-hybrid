/**
 * Plain-language CONFLICT reason for a rejected remote command or cloud event, from its error text.
 * Pure (shared by the shop server and the online API). Unknown texts are OTHER (shown verbatim).
 */
export const CONFLICT_REASONS = [
  'STALE_VERSION', 'USER_CHANGED_LOCALLY', 'STOCK_CHANGED', 'RECORD_NOT_FOUND', 'DUPLICATE_USERNAME', 'DUPLICATE_EMAIL', 'INVALID_STATE', 'OTHER',
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export function classifyConflict(commandType: string | null | undefined, error: string | null | undefined): ConflictReason {
  const e = String(error || '').toLowerCase();
  const t = String(commandType || '');
  if (!e) return 'OTHER';
  if (/username/.test(e) && /(already|used|exists|duplicate)/.test(e)) return 'DUPLICATE_USERNAME';
  if (/email/.test(e) && /(already|used|exists|duplicate)/.test(e)) return 'DUPLICATE_EMAIL';
  if (t.startsWith('USER_') && /(changed at the shop|changed meanwhile|reload and edit)/.test(e)) return 'USER_CHANGED_LOCALLY';
  if (/(stock|quantity).*(changed|moved)|expected.?quantity|insufficient|below zero|would go negative/.test(e)) return 'STOCK_CHANGED';
  if (/(changed meanwhile|was changed|stale|version|expected)/.test(e)) return 'STALE_VERSION';
  if (/(not found|does not exist|unknown (medicine|batch|user|supplier|customer|purchase|sale))/.test(e)) return 'RECORD_NOT_FOUND';
  if (/(cannot .* (a|an) .* that is|already (voided|received|cancelled|approved|rejected|closed|reviewed)|invalid.state|not pending|is (closed|completed|cancelled))/.test(e)) return 'INVALID_STATE';
  return 'OTHER';
}
