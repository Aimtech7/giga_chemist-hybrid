/**
 * Plain-language CONFLICT reason for a rejected remote command or cloud event, from its error text.
 * Pure (shared by the shop server and the online API). Unknown texts are OTHER (shown verbatim).
 */
export const CONFLICT_REASONS = [
  'DELETE_PREFLIGHT_STALE', 'RESOLVED_HISTORICAL_CONFLICT', 'STALE_VERSION', 'USER_CHANGED_LOCALLY', 'STOCK_CHANGED', 'RECORD_NOT_FOUND', 'DUPLICATE_USERNAME', 'DUPLICATE_EMAIL', 'INVALID_STATE', 'OTHER',
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export function classifyConflict(commandType: string | null | undefined, error: string | null | undefined): ConflictReason {
  const e = String(error || '').toLowerCase();
  const t = String(commandType || '');
  if (!e) return 'OTHER';
  if ((t === 'MEDICINE_DELETE' || t === 'MEDICINE_DELETE_PREFLIGHT') && /(medicine version conflict|delete_preflight_stale|refresh and retry|expected \d+, but currently at \d+|version conflict)/.test(e)) {
    return 'DELETE_PREFLIGHT_STALE';
  }
  if (/username/.test(e) && /(already|used|exists|duplicate)/.test(e)) return 'DUPLICATE_USERNAME';
  if (/email/.test(e) && /(already|used|exists|duplicate)/.test(e)) return 'DUPLICATE_EMAIL';
  if (t.startsWith('USER_') && /(changed at the shop|changed meanwhile|reload and edit)/.test(e)) return 'USER_CHANGED_LOCALLY';
  if (/(stock|quantity).*(changed|moved)|expected.?quantity|insufficient|below zero|would go negative/.test(e)) return 'STOCK_CHANGED';
  if (/(changed meanwhile|was changed|stale|version|expected)/.test(e)) return 'STALE_VERSION';
  if (/(not found|does not exist|unknown (medicine|batch|user|supplier|customer|purchase|sale))/.test(e)) return 'RECORD_NOT_FOUND';
  if (/(cannot .* (a|an) .* that is|already (voided|received|cancelled|approved|rejected|closed|reviewed)|invalid.state|not pending|is (closed|completed|cancelled))/.test(e)) return 'INVALID_STATE';
  return 'OTHER';
}

export const FAILURE_CATEGORIES = [
  'SCHEMA_RPC_ERROR',
  'VALIDATION_ERROR',
  'UNSUPPORTED_EVENT_TYPE',
  'SEQUENCE_PROBLEM',
  'CLOUD_ERROR',
  'CONCURRENCY_CONFLICT',
  'OTHER',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export function classifyFailure(eventType: string | null | undefined, error: string | null | undefined): FailureCategory {
  const e = String(error || '').toLowerCase();
  if (!e) return 'OTHER';
  if (/function .* does not exist|column .* does not exist|syntax error|relation .* does not exist|type .* does not exist|operator does not exist|rpc error/.test(e)) {
    return 'SCHEMA_RPC_ERROR';
  }
  if (/unknown event_type|unsupported event/.test(e)) {
    return 'UNSUPPORTED_EVENT_TYPE';
  }
  if (/sequence|local_seq|gap|out of order|monotonic/.test(e)) {
    return 'SEQUENCE_PROBLEM';
  }
  if (/is required|cannot be null|invalid format|invalid uuid|malformed|payload is missing|validation/.test(e)) {
    return 'VALIDATION_ERROR';
  }
  if (/connection refused|timeout|network|econnrefused|enotfound|fetch failed|failed to fetch|500|502|503|504|upstream/.test(e)) {
    return 'CLOUD_ERROR';
  }
  if (/stale|conflict|changed meanwhile|already|expected/.test(e)) {
    return 'CONCURRENCY_CONFLICT';
  }
  return 'OTHER';
}

