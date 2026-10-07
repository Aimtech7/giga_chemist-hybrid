import 'dotenv/config';
import { pgPool } from '../server/db/client';
import { enqueueMedicineBaselines } from '../server/sync/bootstrap';
import { getSyncConfig } from '../server/sync/config';

/**
 * One-time (or occasional) cloud baseline: queues MEDICINE_BASELINE events (metadata + batch
 * quantities) for every medicine, so cloud stock reporting starts from the shop's real stock.
 * Events go through the normal outbox: they are delivered by the server's sync worker, offline-safe
 * and idempotent. Nothing local is changed.
 *
 *   npm run sync:bootstrap -- --confirm
 *   npm run sync:bootstrap -- --confirm --medicine <uuid> [--medicine <uuid> ...]
 */
async function main() {
  const cfg = getSyncConfig();
  if (!cfg.outboxEnabled) throw new Error('APP_MODE must be hybrid in .env.');
  const args = process.argv.slice(2);
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--medicine' && args[i + 1]) ids.push(args[++i]);
  const total = ids.length || Number((await pgPool.query('SELECT COUNT(*) n FROM medicines')).rows[0].n);
  if (!args.includes('--confirm')) {
    console.log(`Would queue ${total} MEDICINE_BASELINE event(s). Re-run with --confirm to queue them.`);
    return;
  }
  const res = await enqueueMedicineBaselines({
    medicineIds: ids,
    onProgress: (d, t) => {
      if (d % 250 === 0 || d === t) console.log(`  queued ${d}/${t}`);
    },
  });
  console.log(`Queued ${res.queued} baseline event(s). The running server's sync worker delivers them.`);
}

main()
  .catch((err) => {
    console.error('[sync:bootstrap] failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
