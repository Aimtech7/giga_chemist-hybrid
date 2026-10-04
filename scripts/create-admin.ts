import readline from 'readline';
import dotenv from 'dotenv';
import { createUser, getUserAuthRecord, updateUser } from '../server/db/users';

dotenv.config();

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
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

  // Check if args provided via command line: npm run create-admin -- name email password pin
  const args = process.argv.slice(2);
  let name = args[0];
  let email = args[1];
  let password = args[2];
  let pin = args[3];

  if (!name) {
    name = (await askQuestion('Enter Admin Full Name (default: Dr. Austin): ')) || 'Dr. Austin (Admin)';
  }
  if (!email) {
    email = (await askQuestion('Enter Admin Email (default: admin@gigachemist.co.ke): ')) || 'admin@gigachemist.co.ke';
  }
  if (!password) {
    password = (await askQuestion('Enter Admin Password (default: admin123): ')) || 'admin123';
  }
  if (!pin) {
    pin = (await askQuestion('Enter 4-Digit Station PIN (default: 1234): ')) || '1234';
  }

  console.log(`\nRegistering administrator account:`);
  console.log(`- Name:     ${name}`);
  console.log(`- Email:    ${email}`);
  console.log(`- Role:     ADMIN`);
  console.log(`- PIN:      **** (Hashed via PBKDF2)`);
  console.log(`- Password: **** (Hashed via PBKDF2)`);

  try {
    const existing = await getUserAuthRecord(email);
    if (existing) {
      console.log(`\nAccount with email "${email}" already exists. Updating credentials...`);
      const updated = await updateUser(existing.id, {
        name,
        role: 'ADMIN',
        password,
        pin,
        active: true,
      });
      console.log(`✓ Admin user "${updated.name}" updated successfully!`);
    } else {
      const created = await createUser({
        name,
        email,
        role: 'ADMIN',
        password,
        pin,
        active: true,
      });
      console.log(`\n✓ Admin user "${created.name}" (${created.email}) created successfully!`);
    }

    console.log('\nYou can now log in to GIGA CHEMIST at http://localhost:3000 using these credentials.');
  } catch (err: any) {
    console.error('\n[ERROR] Failed to register admin account:', err.message);
    process.exit(1);
  }
}

main();
