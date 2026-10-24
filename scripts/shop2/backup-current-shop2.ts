import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { runBackup } from '../../server/ops/backup';

dotenv.config();

async function main() {
  console.log('======================================================================');
  console.log('  STEP 6: BACK UP CURRENT SHOP 2 DATABASE BEFORE CUTOVER');
  console.log('  Target Database: giga_chemist_shop2');
  console.log('======================================================================\n');

  if (process.env.DB_NAME !== 'giga_chemist_shop2') {
    throw new Error(`DB_NAME must be 'giga_chemist_shop2' (currently: '${process.env.DB_NAME}')`);
  }

  const backupDir = path.resolve('backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupRes = await runBackup('CLI', { dir: backupDir, keep: 30 });
  if (!backupRes.success || !backupRes.file) {
    throw new Error(`Backup failed: ${backupRes.error}`);
  }

  const requestedBackupPath = path.join(backupDir, 'shop2-pre-real-data-cutover-20261023.backup');
  fs.copyFileSync(backupRes.file, requestedBackupPath);

  const stats = fs.statSync(requestedBackupPath);
  console.log(`✓ Backup successfully created and verified:`);
  console.log(`  Original File:   ${backupRes.file}`);
  console.log(`  Target Backup:   ${requestedBackupPath}`);
  console.log(`  File Size:       ${(stats.size / 1024).toFixed(1)} KB (${stats.size.toLocaleString()} bytes)`);
  console.log(`  TOC Entries:     ${backupRes.toc_entries}`);
  console.log(`  Duration:        ${backupRes.duration_ms} ms`);

  if (stats.size === 0) {
    throw new Error('CRITICAL: Created backup file has zero size!');
  }
}

main().catch(err => {
  console.error('\n[BACKUP FAILED]:', err.message);
  process.exit(1);
});
