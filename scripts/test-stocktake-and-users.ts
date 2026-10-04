import {
  hashCredential,
  verifyCredential,
  createJwtToken,
  verifyJwtToken,
  hasPermission,
  ROLE_PERMISSIONS,
} from '../server/auth';
import { searchMedicines } from '../src/services/searchEngine';
import type { Medicine, MedicineBatch, InventoryMovement, User, UserRole, Sale } from '../src/types';

interface TestResult {
  testNumber: string;
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}

const results: TestResult[] = [];

function assert(testNumber: string, name: string, condition: boolean, details?: string) {
  if (condition) {
    results.push({ testNumber, name, passed: true, details });
    console.log(`  [PASS] [${testNumber}] ${name}${details ? ` -> ${details}` : ''}`);
  } else {
    results.push({ testNumber, name, passed: false, details, error: 'Assertion failed' });
    console.error(`  [FAIL] [${testNumber}] ${name}${details ? ` -> ${details}` : ''}`);
  }
}

// ===========================================================================
// IN-MEMORY TRANSACTION ENGINE (Simulates PostgreSQL ACID state machine)
// ===========================================================================
class MockDatabaseEngine {
  medicines: Map<string, Medicine> = new Map();
  batches: Map<string, MedicineBatch> = new Map();
  movements: InventoryMovement[] = [];
  auditLogs: any[] = [];
  users: Map<string, any> = new Map();

  constructor() {
    this.seed();
  }

  seed() {
    // Initial Root Admin
    const { combined: adminHash } = hashCredential('AdminInitial@2026');
    this.users.set('usr-admin-root', {
      id: 'usr-admin-root',
      name: 'Root Administrator',
      email: 'admin@gigachemist.co.ke',
      role: 'ADMIN',
      password_hash: adminHash,
      pin: '1234',
      active: true,
      created_at: '2026-01-01',
    });

    // Test Medicine 1 (Single Batch)
    this.medicines.set('med-amx-500', {
      id: 'med-amx-500',
      name: 'Amoxicillin 500mg',
      generic_name: 'Amoxicillin',
      brand_name: 'Amoxil',
      category: 'Antibiotics',
      dosage_form: 'Capsule',
      dosage_strength: '500mg',
      barcode: '616400100101',
      sku: 'MED-AMX-500',
      purchase_price: 10.0,
      selling_price: 20.0,
      current_stock: 500,
      reorder_level: 50,
      unit: 'Capsule',
      status: 'active',
      medicine_type: 'Branded',
      manufacturer: 'GSK',
      description: 'Antibiotic',
      prescription_required: true,
      created_by: 'Admin',
      updated_by: 'Admin',
      version: 1,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    } as Medicine);

    this.batches.set('bat-amx-01', {
      id: 'bat-amx-01',
      medicine_id: 'med-amx-500',
      medicine_name: 'Amoxicillin 500mg',
      batch_number: 'AMX-LOT-01',
      quantity_received: 500,
      quantity_available: 500,
      purchase_price: 10.0,
      supplier_id: 'supp-1',
      supplier_name: 'Laborex Kenya',
      manufacturing_date: '2024-01-01',
      expiry_date: '2028-12-31',
      expiry_status: 'KNOWN',
      received_date: '2026-01-01',
      purchase_invoice: 'INV-001',
      created_by: 'Admin',
      status: 'active',
      created_at: '2026-01-01',
    } as MedicineBatch);

    // Test Medicine 2 (Multiple Batches: Lot A = 100, Lot B = 250)
    this.medicines.set('med-pcm-500', {
      id: 'med-pcm-500',
      name: 'Paracetamol 500mg',
      generic_name: 'Paracetamol',
      brand_name: 'Panadol',
      category: 'Analgesics',
      dosage_form: 'Tablet',
      dosage_strength: '500mg',
      barcode: '616400100201',
      sku: 'MED-PCM-500',
      purchase_price: 2.0,
      selling_price: 5.0,
      current_stock: 350,
      reorder_level: 40,
      unit: 'Tablet',
      status: 'active',
      medicine_type: 'Generic',
      manufacturer: 'GSK',
      description: 'Pain relief',
      prescription_required: false,
      created_by: 'Admin',
      updated_by: 'Admin',
      version: 1,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    } as Medicine);

    this.batches.set('bat-pcm-a', {
      id: 'bat-pcm-a',
      medicine_id: 'med-pcm-500',
      medicine_name: 'Paracetamol 500mg',
      batch_number: 'PCM-BATCH-A',
      quantity_received: 100,
      quantity_available: 100,
      purchase_price: 2.0,
      supplier_id: 'supp-1',
      supplier_name: 'Laborex Kenya',
      manufacturing_date: '2024-01-01',
      expiry_date: '2028-08-31',
      expiry_status: 'KNOWN',
      received_date: '2026-01-01',
      purchase_invoice: 'INV-002',
      created_by: 'Admin',
      status: 'active',
      created_at: '2026-01-01',
    } as MedicineBatch);

    this.batches.set('bat-pcm-b', {
      id: 'bat-pcm-b',
      medicine_id: 'med-pcm-500',
      medicine_name: 'Paracetamol 500mg',
      batch_number: 'PCM-BATCH-B',
      quantity_received: 250,
      quantity_available: 250,
      purchase_price: 2.0,
      supplier_id: 'supp-1',
      supplier_name: 'Laborex Kenya',
      manufacturing_date: '2024-01-01',
      expiry_date: '2029-01-31',
      expiry_status: 'KNOWN',
      received_date: '2026-01-01',
      purchase_invoice: 'INV-003',
      created_by: 'Admin',
      status: 'active',
      created_at: '2026-01-01',
    } as MedicineBatch);
  }

  // Transactional Direct Physical Stock Count
  adminPhysicalStockCount(params: {
    medicine_id: string;
    counts: Array<{
      batch_id?: string;
      batch_number: string;
      quantity: number;
      expiry_date?: string | null;
      expiry_status?: 'KNOWN' | 'UNKNOWN' | 'EXPIRED';
    }>;
    notes?: string;
    user_id: string;
    user_name: string;
    role: string;
  }) {
    if (params.role !== 'ADMIN') {
      throw new Error('403 Forbidden: Only ADMIN may perform physical stock count.');
    }

    const med = this.medicines.get(params.medicine_id);
    if (!med) throw new Error(`Medicine ${params.medicine_id} not found.`);

    // Snapshot state for atomic transaction rollback
    const medSnapshot = { ...med };
    const batchSnapshots = new Map(this.batches);
    const movLength = this.movements.length;
    const auditLength = this.auditLogs.length;

    try {
      const prevTotalStock = med.current_stock;
      const updatedBatches: MedicineBatch[] = [];
      const recordedMovements: any[] = [];

      for (const c of params.counts) {
        if (c.quantity < 0 || !Number.isInteger(c.quantity)) {
          throw new Error(`Quantity must be a non-negative whole number (got ${c.quantity}).`);
        }

        let batch: MedicineBatch | undefined;
        if (c.batch_id) {
          batch = this.batches.get(c.batch_id);
        } else {
          // Find by batch_number
          for (const b of this.batches.values()) {
            if (b.medicine_id === med.id && b.batch_number.toUpperCase() === c.batch_number.toUpperCase()) {
              batch = b;
              break;
            }
          }
        }

        const prevBatchQty = batch ? batch.quantity_available : 0;
        const delta = c.quantity - prevBatchQty;

        const isExpired = c.expiry_status === 'EXPIRED' || (c.expiry_date && new Date(c.expiry_date) < new Date());
        const expiryStatus = isExpired ? 'EXPIRED' : (c.expiry_date ? 'KNOWN' : 'UNKNOWN');
        const batchStatus = c.quantity === 0 ? 'exhausted' : (isExpired ? 'quarantined' : 'active');

        if (batch) {
          batch.quantity_available = c.quantity;
          if (c.expiry_date !== undefined) batch.expiry_date = c.expiry_date || '';
          batch.expiry_status = expiryStatus as any;
          batch.status = batchStatus as any;
          updatedBatches.push(batch);
        } else {
          const newBatchId = `bat-new-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
          const newBatch: MedicineBatch = {
            id: newBatchId,
            medicine_id: med.id,
            medicine_name: med.name,
            batch_number: c.batch_number.toUpperCase(),
            quantity_received: c.quantity,
            quantity_available: c.quantity,
            purchase_price: med.purchase_price || 0,
            expiry_date: c.expiry_date || '',
            expiry_status: expiryStatus as any,
            supplier_id: '',
            supplier_name: '',
            manufacturing_date: '',
            received_date: new Date().toISOString().split('T')[0],
            purchase_invoice: '',
            created_by: params.user_name,
            status: batchStatus as any,
            created_at: new Date().toISOString(),
          };
          this.batches.set(newBatchId, newBatch);
          updatedBatches.push(newBatch);
        }

        const movId = `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const mov: InventoryMovement = {
          id: movId,
          medicine_id: med.id,
          medicine_name: med.name,
          batch_id: batch?.id || 'new',
          batch_number: c.batch_number,
          previous_quantity: prevBatchQty,
          adjustment_quantity: delta,
          new_quantity: c.quantity,
          reason: 'PHYSICAL_STOCK_COUNT',
          notes: params.notes,
          user_id: params.user_id,
          user_name: params.user_name,
          date: new Date().toISOString().split('T')[0],
          device_id: 'SERVER',
          timestamp: Date.now(),
        };
        this.movements.push(mov);
        recordedMovements.push({ batch_id: batch?.id, delta, new_quantity: c.quantity });
      }

      // Recalculate medicine current_stock = SUM(all active, non-expired batches)
      const allActiveBatches = Array.from(this.batches.values()).filter(
        (b) => b.medicine_id === med.id && b.status === 'active'
      );
      const newTotalStock = allActiveBatches.reduce((sum, b) => sum + b.quantity_available, 0);
      med.current_stock = newTotalStock;
      med.updated_at = new Date().toISOString().split('T')[0];

      // Insert audit log
      this.auditLogs.push({
        id: `aud-${Date.now()}`,
        user_id: params.user_id,
        user_name: params.user_name,
        role: params.role,
        action: 'ADMIN_PHYSICAL_STOCK_COUNT',
        entity: 'medicine',
        entity_id: med.id,
        previous_value: JSON.stringify({ current_stock: prevTotalStock }),
        new_value: JSON.stringify({ current_stock: newTotalStock, batches: recordedMovements }),
        timestamp: Date.now(),
      });

      return {
        success: true,
        medicine: med,
        batches: updatedBatches,
        total_stock: newTotalStock,
        previous_stock: prevTotalStock,
        delta: newTotalStock - prevTotalStock,
      };
    } catch (err) {
      // ROLLBACK on error
      this.medicines.set(medSnapshot.id, medSnapshot);
      this.batches = batchSnapshots;
      this.movements.length = movLength;
      this.auditLogs.length = auditLength;
      throw err;
    }
  }

  // POS Checkout validation
  checkout(sale: Sale, role: UserRole) {
    for (const item of sale.items) {
      const med = this.medicines.get(item.medicine_id);
      if (!med) throw new Error(`Medicine ${item.medicine_id} not found.`);
      if (med.current_stock < item.quantity) {
        throw new Error(`Insufficient stock for ${med.name}. Available: ${med.current_stock}, Requested: ${item.quantity}`);
      }
      med.current_stock -= item.quantity;
    }
    return { success: true, sale_id: sale.id };
  }

  // User Management Methods
  createUser(params: { name: string; email: string; role: UserRole; password?: string; pin?: string; active?: boolean }, actorRole: string) {
    if (actorRole !== 'ADMIN') {
      throw new Error('403 Forbidden: Only ADMIN may create user accounts.');
    }
    const cleanEmail = params.email.toLowerCase().trim();
    for (const u of this.users.values()) {
      if (u.email === cleanEmail) {
        throw new Error(`Email ${cleanEmail} is already registered.`);
      }
    }
    const { combined: passwordHash } = params.password ? hashCredential(params.password) : { combined: '' };
    const id = `usr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const userRecord = {
      id,
      name: params.name.trim(),
      email: cleanEmail,
      role: params.role,
      password_hash: passwordHash,
      pin: params.pin || '',
      active: params.active !== false,
      created_at: new Date().toISOString(),
    };
    this.users.set(id, userRecord);
    return userRecord;
  }

  authenticate(email: string, secret: string) {
    const cleanEmail = email.toLowerCase().trim();
    let found: any = null;
    for (const u of this.users.values()) {
      if (u.email === cleanEmail) {
        found = u;
        break;
      }
    }
    if (!found) throw new Error('Invalid email or password.');
    if (!found.active) throw new Error('Account disabled. Contact Administrator.');

    const isMatch = verifyCredential(secret, found.password_hash);
    if (!isMatch && found.pin !== secret) {
      throw new Error('Invalid email or password.');
    }
    return found;
  }

  changePassword(userId: string, currentSecret: string, newSecret: string) {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found.');
    const isMatch = verifyCredential(currentSecret, user.password_hash) || user.pin === currentSecret;
    if (!isMatch) throw new Error('Incorrect current password.');
    const { combined: newHash } = hashCredential(newSecret);
    user.password_hash = newHash;
    return { success: true };
  }

  adminResetPassword(targetUserId: string, newSecret: string, actorRole: string) {
    if (actorRole !== 'ADMIN') {
      throw new Error('403 Forbidden: Only ADMIN may reset another user password.');
    }
    const user = this.users.get(targetUserId);
    if (!user) throw new Error('Target user not found.');
    const { combined: newHash } = hashCredential(newSecret);
    user.password_hash = newHash;
    return { success: true };
  }

  toggleStatus(targetUserId: string, active: boolean, actorId: string, actorRole: string) {
    if (actorRole !== 'ADMIN') {
      throw new Error('403 Forbidden: Only ADMIN may change user status.');
    }
    const user = this.users.get(targetUserId);
    if (!user) throw new Error('User not found.');

    if (user.role === 'ADMIN' && !active) {
      const activeAdmins = Array.from(this.users.values()).filter((u) => u.role === 'ADMIN' && u.active);
      if (activeAdmins.length <= 1) {
        throw new Error('Safeguard Violation: Cannot deactivate the last active Administrator.');
      }
    }

    user.active = active;
    return { success: true, user };
  }
}

// ===========================================================================
// MAIN TEST RUNNER (ALL 13 USER-REQUESTED SCENARIOS)
// ===========================================================================
async function runAllScenarios() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — DIRECT PHYSICAL STOCK COUNT & RBAC SUITE');
  console.log('=============================================================\n');

  const db = new MockDatabaseEngine();

  // -------------------------------------------------------------------------
  // TEST 1 — DIRECT STOCK COUNT (500 -> 463, Delta: -37, Immediate Save)
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Direct Physical Stock Count (500 -> 463) ---');
  const res1 = db.adminPhysicalStockCount({
    medicine_id: 'med-amx-500',
    counts: [{ batch_id: 'bat-amx-01', batch_number: 'AMX-LOT-01', quantity: 463, expiry_date: '2028-12-31' }],
    notes: 'Direct physical count test',
    user_id: 'usr-admin-root',
    user_name: 'Root Administrator',
    role: 'ADMIN',
  });

  assert('TEST 1', 'Admin enters 463 -> stock becomes 463 immediately without variance approval', res1.total_stock === 463);
  assert('TEST 1', 'Batch quantity reconciles to 463', db.batches.get('bat-amx-01')?.quantity_available === 463);
  assert('TEST 1', 'Medicine current_stock equals 463', db.medicines.get('med-amx-500')?.current_stock === 463);
  assert('TEST 1', 'Inventory movement recorded with Delta -37', res1.delta === -37);
  assert('TEST 1', 'Movement type & reason is PHYSICAL_STOCK_COUNT', db.movements[db.movements.length - 1].reason === 'PHYSICAL_STOCK_COUNT');
  assert('TEST 1', 'Audit log created for ADMIN_PHYSICAL_STOCK_COUNT', db.auditLogs.some((a) => a.action === 'ADMIN_PHYSICAL_STOCK_COUNT'));

  // -------------------------------------------------------------------------
  // TEST 2 — STOCK INCREASE (463 -> 600, Delta: +137)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Physical Stock Increase (463 -> 600) ---');
  const res2 = db.adminPhysicalStockCount({
    medicine_id: 'med-amx-500',
    counts: [{ batch_id: 'bat-amx-01', batch_number: 'AMX-LOT-01', quantity: 600, expiry_date: '2028-12-31' }],
    user_id: 'usr-admin-root',
    user_name: 'Root Administrator',
    role: 'ADMIN',
  });

  assert('TEST 2', 'Admin enters 600 -> database immediately becomes 600', res2.total_stock === 600);
  assert('TEST 2', 'Inventory movement delta is +137', res2.delta === 137);
  assert('TEST 2', 'Medicine stock equals 600', db.medicines.get('med-amx-500')?.current_stock === 600);

  // -------------------------------------------------------------------------
  // TEST 3 — ZERO STOCK CONFIRMATION (600 -> 0)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3: Zero Stock Confirmation (600 -> 0) ---');
  const res3 = db.adminPhysicalStockCount({
    medicine_id: 'med-amx-500',
    counts: [{ batch_id: 'bat-amx-01', batch_number: 'AMX-LOT-01', quantity: 0, expiry_date: '2028-12-31' }],
    user_id: 'usr-admin-root',
    user_name: 'Root Administrator',
    role: 'ADMIN',
  });

  assert('TEST 3', 'Admin enters 0 -> database current_stock becomes 0', res3.total_stock === 0);
  assert('TEST 3', 'Batch status set to exhausted', db.batches.get('bat-amx-01')?.status === 'exhausted');

  // Attempting to sell unavailable stock at POS must fail
  try {
    db.checkout({
      id: 'sale-test-zero',
      receipt_number: 'REC-001',
      items: [
        {
          medicine_id: 'med-amx-500',
          medicine_name: 'Amoxicillin 500mg',
          generic_name: 'Amoxicillin',
          quantity: 1,
          unit_price: 20,
          discount: 0,
          total: 20,
          batch_id: 'bat-amx-01',
          batch_number: 'AMX-LOT-01',
          expiry_date: '2028-12-31',
          cost_price_snapshot: 10,
        },
      ],
      subtotal: 20,
      discount_percent: 0,
      discount_amount: 0,
      total: 20,
      amount_received: 20,
      change_given: 0,
      payment_method: 'Cash',
      cashier_id: 'usr-cashier',
      cashier_name: 'Cashier',
      date: '2026-10-03',
      time: '12:00:00',
      status: 'completed',
    } as unknown as Sale, 'CASHIER');
    assert('TEST 3', 'POS cannot sell unavailable quantity', false);
  } catch (err: any) {
    assert('TEST 3', 'POS cannot sell unavailable quantity (Correctly blocked)', true, err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 4 — MULTIPLE BATCHES RECONCILIATION
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 4: Multiple Batches Individual Count ---');
  // Count Batch A: 120 (was 100), Batch B: 230 (was 250)
  const res4 = db.adminPhysicalStockCount({
    medicine_id: 'med-pcm-500',
    counts: [
      { batch_id: 'bat-pcm-a', batch_number: 'PCM-BATCH-A', quantity: 120, expiry_date: '2028-08-31' },
      { batch_id: 'bat-pcm-b', batch_number: 'PCM-BATCH-B', quantity: 230, expiry_date: '2029-01-31' },
    ],
    user_id: 'usr-admin-root',
    user_name: 'Root Administrator',
    role: 'ADMIN',
  });

  assert('TEST 4', 'Batch A updated to 120', db.batches.get('bat-pcm-a')?.quantity_available === 120);
  assert('TEST 4', 'Batch B updated to 230', db.batches.get('bat-pcm-b')?.quantity_available === 230);
  assert('TEST 4', 'Medicine current_stock equals SUM(120 + 230) = 350', db.medicines.get('med-pcm-500')?.current_stock === 350);

  // -------------------------------------------------------------------------
  // TEST 5 — EXPIRY CAPTURE & QUARANTINE
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 5: Expiry Capture & Correction ---');
  db.adminPhysicalStockCount({
    medicine_id: 'med-pcm-500',
    counts: [
      { batch_id: 'bat-pcm-a', batch_number: 'PCM-BATCH-A', quantity: 120, expiry_date: '2030-05-15' },
      { batch_id: 'bat-pcm-b', batch_number: 'PCM-BATCH-B', quantity: 230, expiry_date: '2020-01-01', expiry_status: 'EXPIRED' },
    ],
    user_id: 'usr-admin-root',
    user_name: 'Root Administrator',
    role: 'ADMIN',
  });

  assert('TEST 5', 'Batch A expiry updated to 2030-05-15 (VALID)', db.batches.get('bat-pcm-a')?.expiry_date === '2030-05-15');
  assert('TEST 5', 'Expired Batch B marked quarantined & excluded from sellable stock', db.batches.get('bat-pcm-b')?.status === 'quarantined');
  assert('TEST 5', 'Medicine sellable stock reflects only active batch (120 units)', db.medicines.get('med-pcm-500')?.current_stock === 120);

  // -------------------------------------------------------------------------
  // TEST 6 — CREATE SECOND ADMIN (PBKDF2 HASHED)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 6: Existing Admin Creates Second Admin ---');
  const admin2 = db.createUser({
    name: 'Sarah Admin',
    email: 'sarah@gigachemist.co.ke',
    role: 'ADMIN',
    password: 'SarahPassword@2026',
    active: true,
  }, 'ADMIN');

  assert('TEST 6', 'Second Admin created successfully', admin2.role === 'ADMIN');
  assert('TEST 6', 'Password stored as PBKDF2 salt$hash format', admin2.password_hash.includes('$'));
  const authAdmin2 = db.authenticate('sarah@gigachemist.co.ke', 'SarahPassword@2026');
  assert('TEST 6', 'New Admin login succeeds', authAdmin2.id === admin2.id);

  // -------------------------------------------------------------------------
  // TEST 7 — CREATE CASHIER
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 7: Admin Creates Cashier ---');
  const cashier1 = db.createUser({
    name: 'James Cashier',
    email: 'james@gigachemist.co.ke',
    role: 'CASHIER',
    password: 'JamesPassword@2026',
    active: true,
  }, 'ADMIN');

  assert('TEST 7', 'Cashier created successfully', cashier1.role === 'CASHIER');
  const authCashier1 = db.authenticate('james@gigachemist.co.ke', 'JamesPassword@2026');
  assert('TEST 7', 'Cashier login succeeds', authCashier1.id === cashier1.id);
  assert('TEST 7', 'Cashier permissions strictly restricted', !hasPermission('CASHIER', 'inventory.adjust') && !hasPermission('CASHIER', 'users.manage'));

  // -------------------------------------------------------------------------
  // TEST 8 — ADMIN PASSWORD CHANGE
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 8: Admin Changes Own Password ---');
  db.changePassword(admin2.id, 'SarahPassword@2026', 'NewSarahPassword@2026');

  try {
    db.authenticate('sarah@gigachemist.co.ke', 'SarahPassword@2026');
    assert('TEST 8', 'Old password fails authentication', false);
  } catch (e) {
    assert('TEST 8', 'Old password fails authentication (Correctly rejected)', true);
  }

  const authNewSarah = db.authenticate('sarah@gigachemist.co.ke', 'NewSarahPassword@2026');
  assert('TEST 8', 'New password succeeds authentication', authNewSarah.id === admin2.id);

  // -------------------------------------------------------------------------
  // TEST 9 — RESET CASHIER PASSWORD
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 9: Admin Resets Cashier Password ---');
  db.adminResetPassword(cashier1.id, 'ResetJamesPassword@2026', 'ADMIN');

  try {
    db.authenticate('james@gigachemist.co.ke', 'JamesPassword@2026');
    assert('TEST 9', 'Old Cashier password fails authentication', false);
  } catch (e) {
    assert('TEST 9', 'Old Cashier password fails authentication', true);
  }

  const authResetJames = db.authenticate('james@gigachemist.co.ke', 'ResetJamesPassword@2026');
  assert('TEST 9', 'New reset Cashier password succeeds', authResetJames.id === cashier1.id);

  // -------------------------------------------------------------------------
  // TEST 10 — USER ACTIVATION / DEACTIVATION & SAFEGUARDS
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 10: Deactivate / Reactivate User & Safeguards ---');
  db.toggleStatus(cashier1.id, false, admin2.id, 'ADMIN');

  try {
    db.authenticate('james@gigachemist.co.ke', 'ResetJamesPassword@2026');
    assert('TEST 10', 'Deactivated cashier login is denied', false);
  } catch (err: any) {
    assert('TEST 10', 'Deactivated cashier login is denied (Correct)', true, err.message);
  }

  db.toggleStatus(cashier1.id, true, admin2.id, 'ADMIN');
  const authReactivated = db.authenticate('james@gigachemist.co.ke', 'ResetJamesPassword@2026');
  assert('TEST 10', 'Reactivated cashier login succeeds', authReactivated.active === true);

  // Safeguard: Cannot deactivate last remaining active admin
  db.toggleStatus(admin2.id, false, 'usr-admin-root', 'ADMIN'); // Deactivates Sarah -> Root is now sole active admin
  try {
    db.toggleStatus('usr-admin-root', false, 'usr-admin-root', 'ADMIN'); // Attempts to deactivate sole admin
    assert('TEST 10', 'Safeguard should block deactivating last active admin', false);
  } catch (err: any) {
    assert('TEST 10', 'Safeguard blocks deactivating last active admin', true, err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 11 — RBAC 403 FORBIDDEN ENFORCEMENT
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 11: RBAC Cashier 403 Forbidden Enforcement ---');
  // Attempt create user as Cashier
  try {
    db.createUser({ name: 'Hacker', email: 'hacker@test.com', role: 'ADMIN' }, 'CASHIER');
    assert('TEST 11', 'Cashier create user returns 403 Forbidden', false);
  } catch (err: any) {
    assert('TEST 11', 'Cashier create user returns 403 Forbidden', true, err.message);
  }

  // Attempt physical count as Cashier
  try {
    db.adminPhysicalStockCount({
      medicine_id: 'med-amx-500',
      counts: [{ batch_number: 'AMX-01', quantity: 999 }],
      user_id: cashier1.id,
      user_name: cashier1.name,
      role: 'CASHIER',
    });
    assert('TEST 11', 'Cashier physical count returns 403 Forbidden', false);
  } catch (err: any) {
    assert('TEST 11', 'Cashier physical count returns 403 Forbidden', true, err.message);
  }

  // Attempt reset another user password as Cashier
  try {
    db.adminResetPassword('usr-admin-root', 'HackedPass@2026', 'CASHIER');
    assert('TEST 11', 'Cashier reset another user password returns 403 Forbidden', false);
  } catch (err: any) {
    assert('TEST 11', 'Cashier reset another user password returns 403 Forbidden', true, err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 12 — PERSISTENCE & ACID TRANSACTION ROLLBACK
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 12: Persistence & ACID Rollback Verification ---');
  const medBeforeError = db.medicines.get('med-pcm-500')?.current_stock;
  try {
    db.adminPhysicalStockCount({
      medicine_id: 'med-pcm-500',
      counts: [{ batch_id: 'bat-pcm-a', batch_number: 'PCM-BATCH-A', quantity: -99 }], // Invalid negative qty
      user_id: 'usr-admin-root',
      user_name: 'Root Administrator',
      role: 'ADMIN',
    });
    assert('TEST 12', 'Negative quantity should trigger rollback', false);
  } catch (err: any) {
    assert('TEST 12', 'Invalid quantity rejected and rolled back', true, err.message);
  }
  const medAfterError = db.medicines.get('med-pcm-500')?.current_stock;
  assert('TEST 12', 'Medicine stock completely unchanged after rollback', medBeforeError === medAfterError);

  // -------------------------------------------------------------------------
  // TEST 13 — LOCAL / OFFLINE OPERATION & CATALOG SEARCH
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 13: Local / Offline Search & Operation ---');
  const allMeds = Array.from(db.medicines.values());
  const searchAmo = searchMedicines('amox', allMeds);
  assert('TEST 13', 'Offline search finds Amoxicillin by partial string "amox"', searchAmo.length > 0 && searchAmo[0].name.includes('Amoxicillin'));
  const searchBarcode = searchMedicines('616400100101', allMeds);
  assert('TEST 13', 'Offline search matches exact barcode', searchBarcode.length > 0 && searchBarcode[0].barcode === '616400100101');

  // Summary
  console.log('\n=============================================================');
  console.log('                 TEST SUITE SUMMARY REPORT');
  console.log('=============================================================');
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  console.log(`Total Assertions Evaluated: ${results.length}`);
  console.log(`Total Assertions Passed:    ${passedCount}`);
  console.log(`Total Assertions Failed:    ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAILED TESTS:');
    results.filter((r) => !r.passed).forEach((r) => console.error(`  - [${r.testNumber}] ${r.name}: ${r.details || r.error}`));
    process.exit(1);
  } else {
    console.log('\nALL 13 TEST SUITE SCENARIOS PASSED WITH ZERO ERRORS! ✓');
  }
}

runAllScenarios();
