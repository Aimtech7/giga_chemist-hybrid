import dotenv from 'dotenv';
import { hashCredential, ROLE_PERMISSIONS } from '../server/auth';
import { createUser, getAllUsers } from '../server/db/users';

dotenv.config();

async function seedDevelopment() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — Development Database Seeding');
  console.log('=============================================================');

  console.log('\n[1/3] Checking existing server users...');
  const existingUsers = await getAllUsers();
  console.log(`Found ${existingUsers.length} existing users.`);

  if (existingUsers.length === 0) {
    console.log('\n[2/3] Seeding initial Admin, Manager, and Cashier accounts with salted PBKDF2 hashes...');
    
    const admin = await createUser({
      name: 'Dr. Austin (Admin)',
      email: 'admin@gigachemist.co.ke',
      role: 'ADMIN',
      password: 'admin123',
      pin: '1234',
      phone: '+254 711 000 111',
      active: true,
    });
    console.log(`- Created Admin: ${admin.email} (Role: ${admin.role})`);

    const manager = await createUser({
      name: 'Pharma. Mercy (Manager)',
      email: 'pharma@gigachemist.co.ke',
      role: 'MANAGER',
      password: 'pharma123',
      pin: '2345',
      phone: '+254 722 000 222',
      active: true,
    });
    console.log(`- Created Manager: ${manager.email} (Role: ${manager.role})`);

    const cashier = await createUser({
      name: 'Cashier Daisy',
      email: 'cashier@gigachemist.co.ke',
      role: 'CASHIER',
      password: 'cashier123',
      pin: '3456',
      phone: '+254 733 000 333',
      active: true,
    });
    console.log(`- Created Cashier: ${cashier.email} (Role: ${cashier.role})`);
  } else {
    console.log('\n[2/3] Users already exist. Skipping creation.');
  }

  console.log('\n[3/3] RBAC Matrix Defined:');
  Object.entries(ROLE_PERMISSIONS).forEach(([role, perms]) => {
    console.log(`- Role ${role}: ${perms.length} granular permissions configured`);
  });

  console.log('\n=============================================================');
  console.log('  DEVELOPMENT SEED COMPLETE');
  console.log('=============================================================');
}

seedDevelopment().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
