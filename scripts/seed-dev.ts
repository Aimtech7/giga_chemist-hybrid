import 'dotenv/config';
import { pgPool } from '../server/db/client';

/**
 * Development "seed": reports the user directory state only.
 *
 * It deliberately creates NO accounts. Earlier versions created Admin/Manager/Cashier users with
 * published default passwords and PINs, which would leave a known Administrator password on any
 * install where the seed was run. Create the first Administrator with a password you choose:
 *
 *   npm run create-admin -- "<Full Name>" <email> <password> [pin]
 */
async function main() {
  const res = await pgPool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE role = 'ADMIN' AND active)::int AS active_admins FROM users`
  );
  const { total, active_admins } = res.rows[0];
  console.log(`Users: ${total} total, ${active_admins} active Administrator(s).`);
  if (active_admins === 0) {
    console.log('No active Administrator. Create one (no default credentials exist):');
    console.log('  npm run create-admin -- "<Full Name>" <email> <password> [pin]');
  } else {
    console.log('Nothing to seed. Manage further accounts from the Users screen.');
  }
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
