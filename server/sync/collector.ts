/**
 * Per-transaction collector for the outbox. insertMovement / audit writes made on a transaction
 * client are remembered here so the business event enqueued at the end of that same transaction
 * carries them (stock deltas + audit trail) without every caller passing them around.
 *
 * withTransaction() resets the collector at BEGIN and at release, so a rolled-back transaction can
 * never leak rows into the next transaction that reuses the pooled client.
 *
 * Deliberately dependency-free: server/db/client.ts imports it.
 */
export interface CollectedRows {
  movements: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

const collectors = new WeakMap<object, CollectedRows>();

export function resetCollector(client: object): void {
  collectors.delete(client);
}

function bucket(client: object): CollectedRows {
  let c = collectors.get(client);
  if (!c) {
    c = { movements: [], audits: [] };
    collectors.set(client, c);
  }
  return c;
}

export function collectMovement(client: object, row: Record<string, unknown>): void {
  bucket(client).movements.push(row);
}

export function collectAudit(client: object, row: Record<string, unknown>): void {
  bucket(client).audits.push(row);
}

/** Returns and clears what was collected on this client since the last take. */
export function takeCollected(client: object): CollectedRows {
  const c = collectors.get(client) || { movements: [], audits: [] };
  collectors.delete(client);
  return c;
}
