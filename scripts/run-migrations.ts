import dotenv from 'dotenv';
import { runMigrations } from '../server/db/migrator';

dotenv.config();

async function main() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — PostgreSQL Database Migrations');
  console.log('=============================================================\n');

  const result = await runMigrations();
  if (result.success) {
    if (result.applied.length === 0) {
      console.log('Database is already up to date. No new migrations applied.');
    } else {
      console.log(`\nSuccessfully applied ${result.applied.length} migrations:`);
      result.applied.forEach((m) => console.log(`- ${m}`));
    }
    process.exit(0);
  } else {
    console.error('\nMigration failed:', result.errors);
    process.exit(1);
  }
}

main();

