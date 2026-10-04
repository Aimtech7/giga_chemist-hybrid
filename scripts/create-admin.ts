import 'dotenv/config';
import readline from 'readline';
import { pgPool } from '../server/db/client';
import { createUser, updateUser, adminResetUserPassword, MIN_PASSWORD_LENGTH } from '../server/db/users';

/**
 * Creates (or repairs) an Administrator account in the PostgreSQL users table.
 *
 *   npm run create-admin -- "<Full Name>" <email> <password> [pin]
 *
 * There are NO default credentials: a password of at least MIN_PASSWORD_LENGTH characters is
 * required. Secrets are hashed with PBKDF2-SHA512 and never printed.
 */
function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

async function main() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — Administrator Account Setup');
  console.log('=============================================================\n');

  const [argName, argEmail, argPassword, argPin] = process.argv.slice(2);
  const name = argName || (await ask('Admin full name: '));
  const email = (argEmail || (await ask('Admin email: '))).toLowerCase();
  const password = argPassword || (await ask(`Admin password (min ${MIN_PASSWORD_LENGTH} characters): `));
  const pin = argPin || (await ask('Optional 4-6 digit PIN (Enter to skip): ')) || undefined;

  if (!name || !email || !password) {
    throw new Error('Name, email and password are all required. No default credentials exist.');
  }

  const existing = await pgPool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await updateUser(id, { name, role: 'ADMIN', active: true });
    await adminResetUserPassword({ targetUserId: id, newPassword: password, newPin: pin });
    console.log(`\n✓ Existing account ${email} updated: role ADMIN, active, new password${pin ? ' and PIN' : ''}.`);
  } else {
    const created = await createUser({ name, email, role: 'ADMIN', password, pin, active: true });
    console.log(`\n✓ Administrator ${created.name} (${created.email}) created.`);
  }
  console.log('Log in at http://localhost:3000 with this email and password.');
}

main()
  .catch((err) => {
    console.error('\n[ERROR] Failed to register admin account:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
