import { pgPool, withTransaction } from '../db/client';
import { enqueueSyncEvent, isOutboxEnabled, medicineJson } from './outbox';

/**
 * Queues one MEDICINE_BASELINE event per medicine: its metadata plus every batch with its
 * quantity, captured while the medicine row is locked. The cloud uses it as the starting point of
 * its stock ledger (later movements are added as deltas); it never overwrites stock afterwards.
 *
 * Each medicine is its own short transaction, so the POS keeps selling while this runs.
 */
export async function enqueueMedicineBaselines(opts: { medicineIds?: string[]; onProgress?: (done: number, total: number) => void } = {}) {
  if (!isOutboxEnabled()) throw new Error('APP_MODE=hybrid is required to queue cloud baselines.');
  const ids: string[] = opts.medicineIds?.length
    ? opts.medicineIds
    : (await pgPool.query('SELECT id FROM medicines ORDER BY name, id')).rows.map((r) => r.id);
  let done = 0;
  for (const id of ids) {
    await withTransaction(async (client) => {
      // Same lock every stock operation takes (reconcileMedicineStock): no movement can commit
      // between reading these quantities and taking this event's sequence number.
      const locked = await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [id]);
      if (!locked.rows[0]) return;
      const batches = (await client.query(
        `SELECT id, medicine_id, batch_number, quantity_available, expiry_date, expiry_status, status, supplier_id,
                purchase_price, selling_price_override, received_date
           FROM medicine_batches WHERE medicine_id = $1 ORDER BY id`,
        [id]
      )).rows;
      await enqueueSyncEvent(client, {
        event_type: 'MEDICINE_BASELINE',
        entity_type: 'medicine',
        entity_id: id,
        operation: 'BASELINE',
        data: async () => ({ medicine: await medicineJson(client, id), batches }),
        actor: { user_name: 'SYSTEM (baseline)' },
      });
    });
    done++;
    opts.onProgress?.(done, ids.length);
  }
  return { queued: done };
}
