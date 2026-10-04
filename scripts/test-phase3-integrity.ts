import {
  hashCredential,
  verifyCredential,
  createJwtToken,
  verifyJwtToken,
  hasPermission,
  ROLE_PERMISSIONS,
} from '../server/auth';
import {
  createUser,
  updateUser,
  toggleUserStatus,
  authenticateUser,
  getAllUsers,
  getUserAuthRecord,
} from '../server/db/users';
import { registerDevice, getDevice } from '../server/db/devices';
import { processSaleCheckout, getAllSales } from '../server/db/sales';
import { recordAuditLog, getAllAuditLogs } from '../server/db/audit';
import type { Sale, UserRole } from '../src/types';

async function runPhase3Tests() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — PHASE 3 INTEGRITY & RBAC TEST SUITE');
  console.log('=============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} ${detail ? `-> ${detail}` : ''}`);
      failed++;
    }
  }

  // --- 1. Real user login & password verification ---
  console.log('--- TEST GROUP 1: Authentication & Password Hashing ---');
  try {
    const adminUser = await authenticateUser('admin@gigachemist.co.ke', 'admingiga1234');
    assert(adminUser.role === 'ADMIN', 'Test A1: Real Admin user login via password against PBKDF2 hash');

    const cashierUser = await authenticateUser('cashier@gigachemist.co.ke', '2026');
    assert(cashierUser.role === 'CASHIER', 'Test A2: Real Cashier user login via PIN against PBKDF2 hash');

    // Test JWT token generation and verification
    const token = createJwtToken({
      userId: adminUser.id,
      role: adminUser.role,
      email: adminUser.email,
      name: adminUser.name,
    });
    const verifyResult = verifyJwtToken(token);
    assert(
      verifyResult.valid && verifyResult.payload?.role === 'ADMIN',
      'Test A3: Signed JWT token creation and verification'
    );
  } catch (err: any) {
    assert(false, 'Test A: User Login', err.message);
  }

  // --- 2. Invalid password rejection ---
  try {
    let failedAuth = false;
    try {
      await authenticateUser('admin@gigachemist.co.ke', 'wrong_password_xyz');
    } catch (e) {
      failedAuth = true;
    }
    assert(failedAuth, 'Test B: Invalid password strictly rejected');
  } catch (err: any) {
    assert(false, 'Test B: Invalid password rejection', err.message);
  }

  // --- 3. Disabled account rejection ---
  try {
    // Create test user and deactivate
    const tempUser = await createUser({
      name: 'Temp Deactivated Staff',
      email: `temp-disabled-${Date.now()}@gigachemist.co.ke`,
      role: 'CASHIER',
      password: 'password123',
      pin: '9999',
      active: false,
    });

    let rejectedDeactivated = false;
    try {
      await authenticateUser(tempUser.email, 'password123');
    } catch (e: any) {
      if (e.message.includes('deactivated') || e.message.includes('disabled')) {
        rejectedDeactivated = true;
      }
    }
    assert(rejectedDeactivated, 'Test C: Deactivated user account rejected on authentication');
  } catch (err: any) {
    assert(false, 'Test C: Disabled account rejection', err.message);
  }

  // --- 4. Cashier RBAC vs Admin RBAC ---
  console.log('\n--- TEST GROUP 2: Granular RBAC & Permission Matrix ---');
  assert(!hasPermission('CASHIER', 'medicine.change_price'), 'Test D1: Cashier lacks medicine.change_price');
  assert(!hasPermission('CASHIER', 'inventory.adjust'), 'Test D2: Cashier lacks inventory.adjust');
  assert(!hasPermission('CASHIER', 'users.manage'), 'Test D3: Cashier lacks users.manage');
  assert(!hasPermission('CASHIER', 'sales.void'), 'Test D4: Cashier lacks sales.void');

  assert(hasPermission('ADMIN', 'medicine.change_price'), 'Test E1: Admin possesses medicine.change_price');
  assert(hasPermission('ADMIN', 'inventory.adjust'), 'Test E2: Admin possesses inventory.adjust');
  assert(hasPermission('ADMIN', 'users.manage'), 'Test E3: Admin possesses users.manage');
  assert(hasPermission('ADMIN', 'sales.void'), 'Test E4: Admin possesses sales.void');

  assert(hasPermission('MANAGER', 'stock.receive'), 'Test E5: Manager possesses stock.receive');
  assert(!hasPermission('MANAGER', 'users.manage'), 'Test E6: Manager lacks users.manage');

  // --- 5. User Creation & Role Update ---
  console.log('\n--- TEST GROUP 3: Centralized User Management & Duplicate Protection ---');
  const uniqueEmail = `test-pharmacist-${Date.now()}@gigachemist.co.ke`;
  let createdUser: any;
  try {
    createdUser = await createUser({
      name: 'New Test Pharmacist',
      email: uniqueEmail,
      role: 'CASHIER',
      password: 'PharmaPass@2026',
      pin: '7788',
      phone: '+254 700 999 888',
      active: true,
    });
    assert(Boolean(createdUser.id), 'Test F1: Admin creates new staff user in database');

    const authCheck = await authenticateUser(uniqueEmail, 'PharmaPass@2026');
    assert(authCheck.email === uniqueEmail, 'Test F2: Newly created user authenticates with password');

    // Role update: Promote Cashier to Manager
    const updated = await updateUser(createdUser.id, { role: 'MANAGER' });
    assert(updated.role === 'MANAGER', 'Test G1: Role updated from CASHIER to MANAGER');
    assert(hasPermission(updated.role, 'stock.receive'), 'Test G2: Promoted user gains Manager permissions');

    // Duplicate email check
    let duplicateRejected = false;
    try {
      await createUser({
        name: 'Duplicate Imposter',
        email: uniqueEmail,
        role: 'CASHIER',
        password: 'Pass',
      });
    } catch (e: any) {
      duplicateRejected = true;
    }
    assert(duplicateRejected, 'Test H: Duplicate email registration rejected with conflict');
  } catch (err: any) {
    assert(false, 'Test F/G/H: User Creation & Update', err.message);
  }

  // --- 6. Password Storage Verification (No plaintext) ---
  console.log('\n--- TEST GROUP 4: Password Security & Storage Verification ---');
  try {
    const rawAuth = await getUserAuthRecord(uniqueEmail);
    assert(Boolean(rawAuth?.password_hash), 'Test I1: Database stores salted password hash');
    assert(rawAuth?.password_hash !== 'PharmaPass@2026', 'Test I2: Password is NOT stored in plaintext');
    assert(rawAuth?.pin_hash !== '7788', 'Test I3: PIN is NOT stored in plaintext');
  } catch (err: any) {
    assert(false, 'Test I: Password storage', err.message);
  }

  // --- 7. Sale Transaction & Sync Idempotency ---
  console.log('\n--- TEST GROUP 5: Transactional Sales & Idempotency ---');
  try {
    const testSaleId = `sal-test-${Date.now()}`;
    const testIdempotencyKey = `idem-key-${Date.now()}`;
    const testSale: Sale = {
      id: testSaleId,
      sale_number: `SAL-T-${Date.now()}`,
      receipt_number: `REC-T-${Date.now()}`,
      cashier_id: 'usr-admin-01',
      cashier_name: 'Dr. Austin',
      date: new Date().toISOString().split('T')[0],
      time: '12:00:00',
      items: [
        {
          medicine_id: 'med-001',
          medicine_name: 'Paracetamol 500mg',
          generic_name: 'Paracetamol',
          batch_id: 'batch-001',
          batch_number: 'PCM-2601-A',
          expiry_date: '2027-12-31',
          quantity: 2,
          unit_price: 10,
          discount: 0,
          cost_price_snapshot: 3.5,
          total: 20,
        },
      ],
      subtotal: 20,
      discount_total: 0,
      tax_total: 0,
      total: 20,
      cost_total: 7,
      gross_profit: 13,
      payment_method: 'Cash',
      amount_received: 20,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      idempotency_key: testIdempotencyKey,
      device_id: 'POS-KITALE-01',
      timestamp: Date.now(),
      retry_count: 0,
    };

    const firstResult = await processSaleCheckout(testSale);
    assert(firstResult.success && !firstResult.duplicate, 'Test J: Sale checkout processed transactionally');

    // Duplicate submission with same idempotency key
    const secondResult = await processSaleCheckout(testSale);
    assert(secondResult.success && secondResult.duplicate, 'Test K: Duplicate submission identified and deduplicated');
  } catch (err: any) {
    assert(false, 'Test J/K: Sale processing & idempotency', err.message);
  }

  // --- 8. Device Registration ---
  console.log('\n--- TEST GROUP 6: Device Registration & Audit Logs ---');
  try {
    const devId = `POS-TERMINAL-TEST-${Date.now()}`;
    const registered = await registerDevice({
      device_id: devId,
      name: 'Counter 02 Register',
      device_type: 'desktop',
      app_version: '1.0.0-pwa',
    });
    assert(registered.id === devId && registered.status === 'active', 'Test L: Device registered in database');

    // Audit log
    await recordAuditLog({
      user_id: 'usr-admin-01',
      user_name: 'Dr. Austin',
      role: 'ADMIN',
      action: 'TEST_SENSITIVE_OPERATION',
      entity: 'system',
      entity_id: 'test-01',
      device_id: devId,
      new_value: JSON.stringify({ passed: true }),
    });

    const logs = await getAllAuditLogs();
    const hasLog = logs.some((l) => l.action === 'TEST_SENSITIVE_OPERATION');
    assert(hasLog, 'Test M: Immutable audit log written and retrieved');
  } catch (err: any) {
    assert(false, 'Test L/M: Device & Audit', err.message);
  }

  console.log('\n=============================================================');
  console.log(`  PHASE 3 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3Tests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
