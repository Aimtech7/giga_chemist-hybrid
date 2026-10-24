import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { findPgBinary } from '../../server/ops/backup';
import { getDatabaseConnectionConfig } from '../../server/db/client';

dotenv.config();

async function main() {
  console.log('======================================================================');
  console.log('  CREATING FINAL COPY-READY POSTGRESQL BACKUP FOR SHOP 2');
  console.log('======================================================================\n');

  const connStr = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || '';
  const parsed = new URL(connStr);
  const dbName = parsed.pathname.replace(/^\//, '');
  const host = parsed.hostname || 'localhost';
  const port = parsed.port || '5432';
  const user = parsed.username || 'postgres';
  const password = decodeURIComponent(parsed.password || '');

  if (dbName !== 'giga_chemist_shop2') {
    throw new Error(`Database must be 'giga_chemist_shop2', got '${dbName}'`);
  }

  const outputDir = path.resolve('deployment/shop2/database');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const targetBackup = path.join(outputDir, 'giga_chemist_shop2_final.backup');
  if (fs.existsSync(targetBackup)) {
    fs.unlinkSync(targetBackup);
  }

  const pgDumpBin = findPgBinary('pg_dump');
  const pgRestoreBin = findPgBinary('pg_restore');

  console.log(`Using pg_dump:    ${pgDumpBin}`);
  console.log(`Using pg_restore: ${pgRestoreBin}`);
  console.log(`Target Backup:    ${targetBackup}\n`);

  // Run pg_dump in custom format (-Fc)
  console.log('Running pg_dump in custom format (-Fc)...');
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-h', host,
      '-p', port,
      '-U', user,
      '-d', dbName,
      '-F', 'c',
      '-b',
      '-v',
      '-f', targetBackup,
    ];

    const child = spawn(pgDumpBin, args, {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with code ${code}`));
    });

    child.on('error', reject);
  });

  const stats = fs.statSync(targetBackup);
  console.log(`\n✓ pg_dump finished successfully.`);
  console.log(`  File size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size.toLocaleString()} bytes)`);

  if (stats.size === 0) {
    throw new Error('Created backup file has 0 bytes!');
  }

  // Verify with pg_restore --list
  console.log('\nVerifying backup file with pg_restore --list...');
  const tocEntries = await new Promise<number>((resolve, reject) => {
    const child = spawn(pgRestoreBin, ['--list', targetBackup], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let count = 0;
    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter((l: string) => l.trim() && !l.startsWith(';'));
      count += lines.length;
    });

    child.on('exit', (code) => {
      if (code === 0) resolve(count);
      else reject(new Error(`pg_restore --list failed with code ${code}`));
    });

    child.on('error', reject);
  });

  console.log(`✓ Verification successful: ${tocEntries} TOC entries found in archive.`);
  console.log(`\nFinal Shop 2 backup ready at: ${targetBackup}`);
}

main().catch(err => {
  console.error('\n[FATAL BACKUP ERROR]:', err);
  process.exit(1);
});
