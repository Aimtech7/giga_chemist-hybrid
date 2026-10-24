/**
 * Shop 2 SQLite Migration Placeholder — Schema Analyzer
 *
 * Runs schema and row count analysis once the legacy SQLite database
 * is provided in deployment/shop2/migration/backup/
 */
import fs from 'fs';
import path from 'path';

const BACKUP_DIR = path.resolve('deployment/shop2/migration/backup');

async function main() {
  console.log('=============================================================');
  console.log('  SHOP 2 — LEGACY SQLITE SCHEMA ANALYZER');
  console.log('=============================================================');

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db') || f.endsWith('.sqlite'));

  if (files.length === 0) {
    console.log('\nSTATUS: WAITING FOR SHOP 2 SQLITE BACKUP FILE');
    console.log(`Please place the Shop 2 SQLite backup file into:\n  ${BACKUP_DIR}`);
    console.log('Supported extensions: .db, .sqlite\n');
    process.exit(0);
  }

  console.log(`Found legacy SQLite file(s): ${files.join(', ')}`);
  console.log('Ready to proceed with schema inspection upon file delivery.');
}

main().catch(console.error);
