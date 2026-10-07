import 'dotenv/config';
import { pgPool } from '../../server/db/client';
import { runBackup } from '../../server/ops/backup';

/**
 * Creates one verified PostgreSQL backup of the database configured in .env.
 *
 *   npm run backup                      (BACKUP_DIR / BACKUP_KEEP from .env; default backups/, 14)
 *   npm run backup -- --dir D:\Backups --keep 30 [--pre-upgrade]
 *
 * Never restores. Exit code 0 = verified backup written, 1 = failed.
 */
async function main() {
  const args = process.argv.slice(2);
  const val = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const keep = val('--keep') ? Number(val('--keep')) : undefined;
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) throw new Error('--keep must be a positive integer.');
  const r = await runBackup(args.includes('--pre-upgrade') ? 'PRE_UPGRADE' : 'CLI', { dir: val('--dir'), keep });
  if (!r.success) {
    console.error(`BACKUP FAILED: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`BACKUP OK: ${r.file}`);
  console.log(`  size ${(r.size_bytes / 1048576).toFixed(1)} MB, ${r.toc_entries} TOC entries verified, ${r.duration_ms} ms, pruned ${r.pruned.length} old file(s)`);
}

main()
  .catch((err) => {
    console.error('BACKUP FAILED:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
