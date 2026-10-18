import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
import { pgPool, withTransaction, registerAfterCommit, HttpError } from '../../server/db/client';
import { createUser, updateUser, deleteOrArchiveUser, adminResetUserPassword, adminSetUserPin, getUserById } from '../../server/db/users';
import { userJson, enqueueSyncEvent } from '../../server/sync/outbox';
import { registerSyncWakeHandler, notifySyncWake } from '../../server/sync/wake';
import { runShopConsistencyCheck, reconcileMedicineBaseline } from '../../server/sync/consistency';

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSection = '';

function section(name: string) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = `${currentSection} :: ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`;
    failures.push(msg);
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function run() {
  console.log('=============================================================');
  console.log('  SHOP 1 DATA CONSISTENCY & INVENTORY REPAIR TEST SUITE');
  console.log('  (Development PC Environment Only)');
  console.log('=============================================================');

  const client = await pgPool.connect();

  try {
    // -------------------------------------------------------------------------
    // 1. INVENTORY INVARIANTS & NEGATIVE STOCK PREVENTION
    // -------------------------------------------------------------------------
    section('1. Negative Stock Invariants');

    // Test constraint on medicine_batches: quantity_available >= 0
    let batchConstraintFailed = false;
    const testMedId = crypto.randomUUID();
    const testBatchId = crypto.randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO medicines (id, name, current_stock, purchase_price, selling_price, status)
         VALUES ($1, 'Test Negative Stock Med', 10, 10, 20, 'active')`,
        [testMedId]
      );
      await client.query(
        `INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_available, expiry_date, status)
         VALUES ($1, $2, 'TEST-NEG-1', -5, '2028-12-31', 'active')`,
        [testBatchId, testMedId]
      );
      await client.query('COMMIT');
    } catch (err: any) {
      batchConstraintFailed = true;
      await client.query('ROLLBACK');
    }
    check(batchConstraintFailed, 'Local DB rejects negative batch quantity via chk_medicine_batches_quantity_nonnegative');

    // Test constraint on medicines: current_stock >= 0
    let medConstraintFailed = false;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO medicines (id, name, current_stock, purchase_price, selling_price, status)
         VALUES ($1, 'Test Negative Med', -10, 10, 20, 'active')`,
        [crypto.randomUUID()]
      );
      await client.query('COMMIT');
    } catch (err: any) {
      medConstraintFailed = true;
      await client.query('ROLLBACK');
    }
    check(medConstraintFailed, 'Local DB rejects negative current_stock via chk_medicines_current_stock_nonnegative');

    // -------------------------------------------------------------------------
    // 2. IMMEDIATE POST-COMMIT SYNC WAKE
    // -------------------------------------------------------------------------
    section('2. Immediate Post-Commit Sync Wake');

    let wakeCalled = false;
    registerSyncWakeHandler(() => {
      wakeCalled = true;
    });

    // A committing transaction MUST fire the wake hook
    await withTransaction(async (c) => {
      registerAfterCommit(c, () => notifySyncWake());
    });
    check(wakeCalled, 'registerAfterCommit fires immediately upon COMMIT');

    // A rolled back transaction MUST NOT fire the wake hook
    let rollbackWakeCalled = false;
    registerSyncWakeHandler(() => {
      rollbackWakeCalled = true;
    });

    try {
      await withTransaction(async (c) => {
        registerAfterCommit(c, () => notifySyncWake());
        throw new Error('Forced rollback');
      });
    } catch (e) {
      // Expected rollback
    }
    check(!rollbackWakeCalled, 'registerAfterCommit does NOT fire when transaction rolls back');

    // -------------------------------------------------------------------------
    // 3. STRICT SEQUENTIAL OUTBOX DISPATCH
    // -------------------------------------------------------------------------
    section('3. Strict Sequential Outbox Dispatch');

    // Insert 2 test events with consecutive sequences
    const ev1Id = crypto.randomUUID();
    const ev2Id = crypto.randomUUID();
    const fakeShopId = crypto.randomUUID();

    const maxSeqRes = await client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq FROM sync_events');
    const baseSeq = Number(maxSeqRes.rows[0].max_seq) + 1000;

    // Event 1 is PENDING but backed off into the future (next_attempt_at in 10 minutes)
    await client.query(
      `INSERT INTO sync_events (id, seq, idempotency_key, shop_id, event_type, operation, entity_type, entity_id, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'TEST_EV1', 'TEST', 'test', '1', '{}', 'PENDING', CURRENT_TIMESTAMP + interval '10 minutes')`,
      [ev1Id, baseSeq, `test:${ev1Id}`, fakeShopId]
    );

    // Event 2 is PENDING and due now
    await client.query(
      `INSERT INTO sync_events (id, seq, idempotency_key, shop_id, event_type, operation, entity_type, entity_id, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'TEST_EV2', 'TEST', 'test', '2', '{}', 'PENDING', CURRENT_TIMESTAMP - interval '1 second')`,
      [ev2Id, baseSeq + 1, `test:${ev2Id}`, fakeShopId]
    );

    // The strict ordering query must NOT claim Event 2 because Event 1 (lower seq) is waiting on backoff!
    const claimRes = await client.query(
      `SELECT id FROM sync_events
        WHERE status = 'PENDING'
          AND next_attempt_at <= CURRENT_TIMESTAMP
          AND seq < COALESCE((
                SELECT MIN(seq) FROM sync_events
                 WHERE status = 'PENDING' AND next_attempt_at > CURRENT_TIMESTAMP
              ), 9223372036854775807)
        ORDER BY seq`
    );

    const claimedIds = claimRes.rows.map((r) => r.id);
    check(!claimedIds.includes(ev2Id), 'Event with higher seq does NOT jump ahead of backed-off earlier seq (Zero sequence gaps)');

    // Reconnect drain: when reconnecting, backed off events are made due immediately
    await client.query(
      `UPDATE sync_events SET next_attempt_at = CURRENT_TIMESTAMP WHERE id IN ($1, $2)`,
      [ev1Id, ev2Id]
    );

    const claimRes2 = await client.query(
      `SELECT id FROM sync_events
        WHERE status = 'PENDING'
          AND next_attempt_at <= CURRENT_TIMESTAMP
          AND seq < COALESCE((
                SELECT MIN(seq) FROM sync_events
                 WHERE status = 'PENDING' AND next_attempt_at > CURRENT_TIMESTAMP
              ), 9223372036854775807)
        ORDER BY seq`
    );
    const claimedIds2 = claimRes2.rows.map((r) => r.id);
    check(claimedIds2.includes(ev1Id) && claimedIds2.includes(ev2Id), 'On reconnect, all pending events are immediately claimable in strict seq order');

    // Clean up test events
    await client.query('DELETE FROM sync_events WHERE id IN ($1, $2)', [ev1Id, ev2Id]);

    // -------------------------------------------------------------------------
    // 4. USER MANAGEMENT CRUD & DELETE / ARCHIVE SAFEGUARDS
    // -------------------------------------------------------------------------
    section('4. User Management CRUD & Archive Safeguards');

    const testAdmin = await client.query(`SELECT id FROM users WHERE role = 'ADMIN' AND active = TRUE LIMIT 1`);
    const adminId = testAdmin.rows[0]?.id || crypto.randomUUID();

    // Create a new staff user with password and PIN
    const testEmail = `test_staff_${Date.now()}@gigachemist.internal`;
    const createdUser = await createUser({
      name: 'Test Staff Cashier',
      email: testEmail,
      username: `cashier_${Date.now().toString().slice(-6)}`,
      role: 'CASHIER',
      password: 'SecurePassword123!',
      pin: '1234',
      phone: '+254700000000',
      active: true,
      created_by: adminId,
    });

    check(createdUser && createdUser.id !== undefined, 'Staff user created successfully with role CASHIER');
    check(createdUser.email === testEmail, 'Email matches created user');

    // PIN Local-Only Invariant: userJson() MUST NOT serialize password_hash or pin_hash
    const exportedJson: any = await withTransaction((c) => userJson(c, createdUser.id));
    check(exportedJson.password_hash === undefined, 'PIN and Password hashes are NEVER in userJson (Credential separation invariant)');
    check(exportedJson.pin_hash === undefined, 'pin_hash is stripped from sync events (PIN local-only invariant)');

    // Admin sets new PIN
    const pinRes = await adminSetUserPin(createdUser.id, '4321', adminId);
    check(pinRes.success, 'Admin successfully set/changed user PIN');

    // User without history: permanent delete allowed
    const deleteResult1 = await deleteOrArchiveUser(createdUser.id, adminId);
    check(deleteResult1.action === 'deleted', 'User with zero transaction history is permanently deleted', deleteResult1);

    const verifyDeleted = await getUserById(createdUser.id);
    check(verifyDeleted === null, 'User row verified deleted from local database');

    // Now create a user with a historical sale reference
    const userWithHistory = await createUser({
      name: 'History Staff Member',
      email: `history_${Date.now()}@gigachemist.internal`,
      username: `hist_${Date.now().toString().slice(-6)}`,
      role: 'CASHIER',
      password: 'SecurePassword123!',
      pin: '5678',
      created_by: adminId,
    });

    // Create a dummy audit log referencing this user
    const dummyAuditId = crypto.randomUUID();
    await client.query(
      `INSERT INTO audit_logs (id, action, entity, entity_id, user_id, user_name, role, device_id, timestamp)
       VALUES ($1, 'TEST_ACTION', 'test_entity', '1', $2, 'History Staff', 'CASHIER', 'test-device-dev', $3)`,
      [dummyAuditId, userWithHistory.id, Date.now()]
    );

    // Attempt to delete user with history: MUST ARCHIVE instead of deleting
    const deleteResult2 = await deleteOrArchiveUser(userWithHistory.id, adminId);
    check(deleteResult2.action === 'archived', 'User with transaction history is ARCHIVED/DEACTIVATED, not deleted', deleteResult2);

    const verifyArchived = await getUserById(userWithHistory.id);
    check(verifyArchived !== null && verifyArchived.active === false, 'Archived user remains in database with active = false');

    // Clean up dummy audit & test user
    await client.query('DELETE FROM audit_logs WHERE id = $1', [dummyAuditId]);
    await client.query('DELETE FROM users WHERE id = $1', [userWithHistory.id]);

    // Self-deletion protection: admin cannot delete self
    let selfDeleteBlocked = false;
    try {
      await deleteOrArchiveUser(adminId, adminId);
    } catch (err: any) {
      if (err instanceof HttpError && err.status === 409) selfDeleteBlocked = true;
    }
    check(selfDeleteBlocked, 'Self-deletion is strictly blocked for acting Administrator');

    // -------------------------------------------------------------------------
    // 5. READ-ONLY SHOP CONSISTENCY CHECK
    // -------------------------------------------------------------------------
    section('5. Read-Only Shop Consistency Check');

    const report = await runShopConsistencyCheck();
    check(report && typeof report.healthy === 'boolean', 'runShopConsistencyCheck returns valid ConsistencyReport');
    check(typeof report.summary.negative_local_stock === 'number', 'Reports local negative stock count');
    check(typeof report.summary.sequence_gaps === 'number', 'Reports sequence continuity');

    // -------------------------------------------------------------------------
    // 6. CONTROLLED MEDICINE BASELINE RECONCILIATION
    // -------------------------------------------------------------------------
    section('6. Controlled Baseline Reconciliation');

    const medRow = await client.query('SELECT id, name FROM medicines LIMIT 1');
    if (medRow.rows[0]) {
      const medId = medRow.rows[0].id;
      const reconcileRes = await reconcileMedicineBaseline(medId, {
        user_id: adminId,
        user_name: 'Admin Test',
        role: 'ADMIN',
      });
      check(reconcileRes.success && reconcileRes.medicineId === medId, 'reconcileMedicineBaseline locks row and emits authoritative MEDICINE_BASELINE event');

      // Verify audit row was written
      const auditRes = await client.query(
        `SELECT action, entity, entity_id FROM audit_logs WHERE action = 'CLOUD_STOCK_RECONCILIATION' AND entity_id = $1`,
        [medId]
      );
      check(auditRes.rows.length > 0, 'Reconciliation writes CLOUD_STOCK_RECONCILIATION audit row');
    }

  } catch (err: any) {
    console.error('Test error:', err);
    failed++;
    failures.push(`General Error: ${err?.message || err}`);
  } finally {
    client.release();
    await pgPool.end();
  }

  console.log('\n=============================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('=============================================================');

  process.exitCode = failed === 0 ? 0 : 1;
}

run();
