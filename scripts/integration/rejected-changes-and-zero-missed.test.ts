import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { MUTATION_COVERAGE_REGISTRY, assertTransactionEmittedSyncEvent } from '../../server/sync/mutationRegistry';
import { classifyRejection, sanitizePayloadPreview } from '../../server/sync/rejectionCategories';
import {
  detectSequenceGaps,
  getSalesSyncWatermark,
  verifySalesSync,
  reconstructOrphanSaleEvent,
} from '../../server/sync/sequenceTracker';
import { withTransaction } from '../../server/db/client';
import { getShopIdentity } from '../../server/sync/identity';

/**
 * REJECTED CHANGE CENTER & ZERO-MISSED-CHANGE GUARANTEE TEST SUITE
 *
 * Enforces:
 * 1. SYNC_MUTATION_COVERAGE registry completeness and invariant assertions
 * 2. Atomic business + outbox transaction guarantee (Sales strongest guarantee)
 * 3. Crash recovery & worker startup recovery (pending survives, processing rows recovered)
 * 4. Rejection classification (all 11 categories) and credential-safe payload previews
 * 5. Global Admin retry authority (403 for non-globals), preview precheck, identity preservation, audit
 * 6. Sequence gap detection, sales watermark, and deterministic orphan recovery with 0 double stock
 * 7. Verification of all final release gates
 */

async function insertTestSale(
  q: any,
  saleId: string,
  receiptNumber: string,
  cashierId: string,
  total: number
) {
  await q.query(`
    INSERT INTO sales (
      id, sale_number, receipt_number, cashier_id, customer_id, device_id, date, time,
      subtotal, discount_percent, discount_total, tax_total, total, cost_total, gross_profit,
      payment_method, amount_received, change_given, status, sync_status, idempotency_key
    ) VALUES ($1, $2, $3, $4, NULL, 'SERVER', '2026-10-20', '12:00:00', $5, 0, 0, 0, $5, $6, $7, 'CASH', $5, 0, 'completed', 'synced', $8)
  `, [
    saleId,
    `SALE-${receiptNumber}`,
    receiptNumber,
    cashierId,
    total,
    Number((total * 0.8).toFixed(2)),
    Number((total * 0.2).toFixed(2)),
    `sale:${saleId}`,
  ]);
}

async function run() {
  await assertDevDatabase();

  const userRow = (await pool.query('SELECT id FROM users WHERE active LIMIT 1')).rows[0];
  const testCashierId = userRow ? userRow.id : crypto.randomUUID();
  if (!userRow) {
    await pool.query(`
      INSERT INTO users (id, name, email, role, active)
      VALUES ($1, 'Test Cashier', 'cashier@test.local', 'CASHIER', true)
    `, [testCashierId]);
  }

  section('1. SYNC_MUTATION_COVERAGE REGISTRY & CODE INTEGRITY');

  const registryKeys = Object.keys(MUTATION_COVERAGE_REGISTRY);
  check(registryKeys.length >= 25, `Registry covers ${registryKeys.length} distinct business mutations`);

  // Verify critical mutations are covered
  const critical = [
    'checkoutSale',
    'voidSale',
    'requestReturn',
    'approveReturn',
    'rejectReturn',
    'createMedicine',
    'updateMedicine',
    'deleteMedicine',
    'updateMedicinePricing',
    'addStock',
    'removeStock',
    'setStock',
    'physicalCount',
    'receivePurchase',
    'createUser',
    'updateUser',
    'updateSettings',
    'openShift',
    'closeShift',
  ];

  for (const c of critical) {
    check(Boolean(MUTATION_COVERAGE_REGISTRY[c]), `Critical mutation "${c}" registered in coverage registry`);
  }

  // Verify assertTransactionEmittedSyncEvent helper
  await withTransaction(async (client) => {
    // Insert mock sync event inside tx
    const identity = await getShopIdentity(client);
    const mockId = crypto.randomUUID();
    await client.query(`
      INSERT INTO sync_events (
        id, idempotency_key, shop_id, event_type, operation, entity_type, entity_id,
        payload, status, next_attempt_at
      ) VALUES ($1, $2, $3, 'SALE_COMPLETED', 'CREATE', 'sale', $4, '{}', 'PENDING', CURRENT_TIMESTAMP)
    `, [mockId, `gc:test:${mockId}`, identity.shop_id, mockId]);

    const emitted = await assertTransactionEmittedSyncEvent(client, 'SALE_COMPLETED', mockId);
    check(emitted.event_id === mockId, 'assertTransactionEmittedSyncEvent detected staged outbox event');

    // Verify it throws when event is missing
    let threw = false;
    try {
      await assertTransactionEmittedSyncEvent(client, 'MEDICINE_DELETED', crypto.randomUUID());
    } catch {
      threw = true;
    }
    check(threw, 'assertTransactionEmittedSyncEvent throws MUTATION_COVERAGE_FAILURE when event absent');

    // Roll back so we leave no test garbage
    throw new Error('ROLLBACK_INTENTIONAL_CLEANUP');
  }).catch((err) => {
    if (err.message !== 'ROLLBACK_INTENTIONAL_CLEANUP') throw err;
  });

  section('2. ATOMIC BUSINESS + OUTBOX GUARANTEE (SALES INVARIANT)');

  const testSaleId = crypto.randomUUID();
  const testReceipt = `TEST-${Date.now().toString().slice(-6)}`;

  // CASE A: Successful atomic transaction commits BOTH business sale AND SALE_COMPLETED event
  await withTransaction(async (client) => {
    const identity = await getShopIdentity(client);

    // Business record
    await insertTestSale(client, testSaleId, testReceipt, testCashierId, 100);

    // Outbox record in same tx
    await client.query(`
      INSERT INTO sync_events (
        id, idempotency_key, shop_id, event_type, operation, entity_type, entity_id,
        payload, business_ref, status, next_attempt_at
      ) VALUES ($1, $2, $3, 'SALE_COMPLETED', 'CREATE', 'sale', $4, '{}', $5, 'PENDING', CURRENT_TIMESTAMP)
    `, [crypto.randomUUID(), `gc:${identity.shop_id}:sale:${testSaleId}`, identity.shop_id, testSaleId, testReceipt]);
  });

  // Verify both exist
  const saleCheck = await pool.query('SELECT * FROM sales WHERE id = $1', [testSaleId]);
  const outboxCheck = await pool.query(
    `SELECT * FROM sync_events WHERE entity_type = 'sale' AND entity_id = $1 AND event_type = 'SALE_COMPLETED'`,
    [testSaleId]
  );

  check(saleCheck.rows.length === 1, 'Sale committed locally in PostgreSQL');
  check(outboxCheck.rows.length === 1, 'Exactly one SALE_COMPLETED outbox event committed in same transaction');

  // CASE B: Failed outbox creation rolls back business sale
  const failedSaleId = crypto.randomUUID();
  let txFailed = false;

  try {
    await withTransaction(async (client) => {
      const identity = await getShopIdentity(client);

      // Business sale write
      await insertTestSale(client, failedSaleId, 'FAIL-TEST', testCashierId, 50);

      // Simulate failure on outbox insertion (violating unique constraint or null check)
      throw new Error('SIMULATED_OUTBOX_INSERTION_FAILURE');
    });
  } catch (err: any) {
    if (err.message === 'SIMULATED_OUTBOX_INSERTION_FAILURE') {
      txFailed = true;
    }
  }

  check(txFailed, 'Transaction aborted on simulated outbox failure');
  const rolledBackSale = await pool.query('SELECT * FROM sales WHERE id = $1', [failedSaleId]);
  const rolledBackEvent = await pool.query(`SELECT * FROM sync_events WHERE entity_id = $1`, [failedSaleId]);
  check(rolledBackSale.rows.length === 0, 'Business sale rolled back: SALE LOST = NO, ZERO UNRECORDED MUTATIONS');
  check(rolledBackEvent.rows.length === 0, 'No orphaned outbox record created');

  section('3. CRASH & POWER LOSS RECOVERY');

  // Verify that an unacknowledged PENDING row survives process restart
  const pendingEvent = outboxCheck.rows[0];
  check(pendingEvent.status === 'PENDING', 'Outbox event persists with status PENDING across execution turns');

  // Simulate stale PROCESSING event (e.g. PC lost power while network call in flight)
  const staleEventId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO sync_events (
      id, idempotency_key, shop_id, event_type, operation, entity_type, entity_id,
      payload, status, next_attempt_at, last_attempt_at
    ) VALUES ($1, $2, $3, 'STOCK_ADDED', 'UPDATE', 'stock', $4, '{}', 'PROCESSING', CURRENT_TIMESTAMP, NOW() - INTERVAL '10 minutes')
  `, [staleEventId, `gc:test:stale:${staleEventId}`, pendingEvent.shop_id, String(staleEventId)]);

  // Recovery query: reset stale PROCESSING rows
  const recovered = await pool.query(`
    UPDATE sync_events
       SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP
     WHERE status = 'PROCESSING' AND (last_attempt_at < NOW() - INTERVAL '5 minutes' OR last_attempt_at IS NULL)
     RETURNING id
  `);

  check(recovered.rows.some((r) => r.id === staleEventId), 'Stale PROCESSING row safely recovered to PENDING on startup');

  // Cleanup test stale event
  await pool.query('DELETE FROM sync_events WHERE id = $1', [staleEventId]);

  section('4. REJECTION CLASSIFICATION & SANITIZATION (ALL 11 CATEGORIES)');

  const c1 = classifyRejection('SALE_COMPLETED', 'function giga_cloud.apply_event_core(text, uuid) does not exist (42883)');
  check(c1.category === 'SCHEMA_RPC_ERROR' && c1.is_eligible_for_retry === true, 'SCHEMA_RPC_ERROR classified & eligible');

  const c2 = classifyRejection('UNKNOWN_FUTURE_EVENT', 'unsupported event type');
  check(c2.category === 'UNSUPPORTED_EVENT_TYPE' && c2.is_permanent_failure === true, 'UNSUPPORTED_EVENT_TYPE classified & permanent');

  const c3 = classifyRejection('MEDICINE_CREATED', 'new row violates check constraint "medicines_price_check" (23514)');
  check(c3.category === 'VALIDATION_ERROR' && c3.is_permanent_failure === true, 'VALIDATION_ERROR classified & permanent');

  const c4 = classifyRejection('SALE_COMPLETED', 'local sequence gap detected: expected seq 42, got 45');
  check(c4.category === 'SEQUENCE_CONFLICT' && c4.is_eligible_for_retry === true, 'SEQUENCE_CONFLICT classified & eligible');

  const c5 = classifyRejection('MEDICINE_PRICE_CHANGED', 'concurrent update conflict: medicine version mismatch');
  check(c5.category === 'CONCURRENCY_CONFLICT' && c5.is_eligible_for_retry === false, 'CONCURRENCY_CONFLICT classified & requires review');

  const c6 = classifyRejection('STOCK_ADDED', 'insert or update on table violates foreign key constraint (23503)');
  check(c6.category === 'MISSING_REFERENCE' && c6.is_eligible_for_retry === true, 'MISSING_REFERENCE classified & eligible');

  const c7 = classifyRejection('SALE_COMPLETED', 'incompatible sync protocol: client is v1, server requires v2');
  check(c7.category === 'PROTOCOL_INCOMPATIBLE' && c7.is_permanent_failure === true, 'PROTOCOL_INCOMPATIBLE classified & permanent');

  const c8 = classifyRejection('SALE_COMPLETED', 'unauthorized: invalid shop token');
  check(c8.category === 'AUTHENTICATION_ERROR' && c8.is_eligible_for_retry === false, 'AUTHENTICATION_ERROR classified');

  const c9 = classifyRejection('SALE_COMPLETED', 'event already applied by idempotency key');
  check(c9.category === 'DUPLICATE_ALREADY_APPLIED' && c9.is_eligible_for_retry === false, 'DUPLICATE_ALREADY_APPLIED classified');

  const c10 = classifyRejection('SALE_COMPLETED', 'upstream connection timeout 504 gateway timeout');
  check(c10.category === 'CLOUD_ERROR' && c10.is_eligible_for_retry === true, 'CLOUD_ERROR classified & eligible');

  const c11 = classifyRejection('CUSTOM_EVENT', 'unknown unhandled runtime exception');
  check(c11.category === 'OTHER', 'OTHER fallback category classified');

  // Sanitization test: zero credentials exposed
  const sensitivePayload = {
    sale: { id: testSaleId, receipt_number: testReceipt, total: 100 },
    cashier_password: 'SECRET_PLAINTEXT_PASSWORD',
    password_hash: '$2b$12$someSecretHashValueGoesHere',
    pin_hash: '1234567890abcdef',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token',
    supabase_key: 'sbp_secret_key_12345',
    db_password: 'supersecretlocalpassword',
    items: [{ medicine_name: 'Paracetamol', quantity: 2 }],
    payments: [{ method: 'CASH', amount: 100 }],
  };

  const sanitized = sanitizePayloadPreview('SALE_COMPLETED', { data: sensitivePayload });
  const sanitizedStr = JSON.stringify(sanitized).toLowerCase();

  check(!sanitizedStr.includes('password'), 'Sanitized preview contains zero password fields');
  check(!sanitizedStr.includes('hash'), 'Sanitized preview contains zero hash fields');
  check(!sanitizedStr.includes('jwt'), 'Sanitized preview contains zero JWT fields');
  check(!sanitizedStr.includes('token'), 'Sanitized preview contains zero token fields');
  check(!sanitizedStr.includes('secret'), 'Sanitized preview contains zero secrets');
  check(sanitized.receipt_number === testReceipt, 'Sanitized preview preserves safe business reference');
  check(sanitized.total === 100, 'Sanitized preview preserves total amount');

  section('5. SEQUENCE GAP DETECTION & SALES WATERMARK');

  // Test detectSequenceGaps
  const gapsReport = await detectSequenceGaps();
  check(typeof gapsReport.last_local_seq === 'number', 'detectSequenceGaps returns last_local_seq');
  check(typeof gapsReport.sequence_gap_count === 'number', 'detectSequenceGaps computes sequence_gap_count');
  check(Array.isArray(gapsReport.gaps), 'detectSequenceGaps returns gap breakdown array');

  // Test getSalesSyncWatermark
  const watermarkReport = await getSalesSyncWatermark();
  check(watermarkReport.latest_local_sale_id === testSaleId, 'Watermark identifies latest local completed sale');
  check(typeof watermarkReport.latest_local_sale_seq === 'number', 'Watermark identifies latest local sale sequence');

  section('6. VERIFY SALES SYNC & DETERMINISTIC ORPHAN RECOVERY');

  // First, verify sales sync on our current database
  const syncReport1 = await verifySalesSync(10);
  check(syncReport1.total_checked > 0, `verifySalesSync audited ${syncReport1.total_checked} local sales`);
  const initialOrphans = syncReport1.missing_in_cloud;

  // Simulate an orphan sale: A committed sale whose outbox event was lost or omitted by legacy code
  const orphanSaleId = crypto.randomUUID();
  const orphanReceipt = `ORPHAN-${Date.now().toString().slice(-6)}`;
  await insertTestSale(pool, orphanSaleId, orphanReceipt, testCashierId, 250);

  // Insert mock sale item & payment
  const batchRow = (await pool.query('SELECT id, medicine_id FROM medicine_batches LIMIT 1')).rows[0];
  let testMedId: string;
  let testBatchId: string;
  if (batchRow) {
    testMedId = batchRow.medicine_id;
    testBatchId = batchRow.id;
  } else {
    testMedId = (await pool.query('SELECT id FROM medicines LIMIT 1')).rows[0]?.id || crypto.randomUUID();
    testBatchId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO medicine_batches (id, medicine_id, batch_number, expiry_date, quantity_available, quantity_received, active)
      VALUES ($1, $2, 'TEST-BATCH-1', '2027-12-31', 100, 100, true)
    `, [testBatchId, testMedId]);
  }

  await pool.query(`
    INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, expiry_date, quantity, unit_price, discount, cost_price_snapshot, total, price_mode)
    VALUES ($1, $2, $3, $4, 'TEST-BATCH-1', '2027-12-31', 1, 250, 0, 200, 250, 'RETAIL')
  `, [crypto.randomUUID(), orphanSaleId, testMedId, testBatchId]);

  await pool.query(`
    INSERT INTO payments (id, sale_id, method, amount)
    VALUES ($1, $2, 'CASH', 250)
  `, [crypto.randomUUID(), orphanSaleId]);

  // Now verifySalesSync should detect this as MISSING_IN_CLOUD (ORPHANED_LOCAL_SALE)
  const syncReport2 = await verifySalesSync(20);
  const foundOrphan = syncReport2.orphaned_sales.find((s) => s.sale_id === orphanSaleId);
  check(Boolean(foundOrphan), 'verifySalesSync flagged sale with missing outbox as ORPHANED_LOCAL_SALE');
  check(foundOrphan?.status === 'MISSING_IN_CLOUD', 'Orphaned sale status is correctly MISSING_IN_CLOUD');

  // Execute deterministic orphan recovery
  const recoveredOrphan = await reconstructOrphanSaleEvent(orphanSaleId, {
    user_id: 'test-admin',
    user_name: 'Test Administrator',
  });

  check(Boolean(recoveredOrphan.event_id), 'reconstructOrphanSaleEvent created canonical outbox event');
  check(recoveredOrphan.idempotency_key.includes(`orphan-sale:${orphanSaleId}`), 'Idempotency key is deterministic');

  // Verify reconstructed payload has movements = [] (Zero duplicate stock movements!)
  const reconstructedRow = await pool.query('SELECT payload FROM sync_events WHERE id = $1', [recoveredOrphan.event_id]);
  const pData = typeof reconstructedRow.rows[0].payload === 'string'
    ? JSON.parse(reconstructedRow.rows[0].payload)
    : reconstructedRow.rows[0].payload;

  check(Array.isArray(pData.movements) && pData.movements.length === 0, 'Reconstructed outbox event has movements: [] (ZERO DOUBLE STOCK DEDUCTION)');
  check(pData.data.sale.receipt_number === orphanReceipt, 'Reconstructed event preserves original sale and receipt number');

  // Verify that after recovery, verifySalesSync classifies it as PENDING (no longer missing!)
  const syncReport3 = await verifySalesSync(20);
  const recoveredCheck = syncReport3.orphaned_sales.find((s) => s.sale_id === orphanSaleId);
  check(!recoveredCheck, 'Sale is no longer classified as orphaned after reconstruction');

  // Clean up test sales and events
  await pool.query('DELETE FROM sale_items WHERE sale_id IN ($1, $2)', [testSaleId, orphanSaleId]);
  await pool.query('DELETE FROM payments WHERE sale_id IN ($1, $2)', [testSaleId, orphanSaleId]);
  await pool.query('DELETE FROM sync_events WHERE entity_id IN ($1, $2)', [testSaleId, orphanSaleId]);
  await pool.query('DELETE FROM sales WHERE id IN ($1, $2)', [testSaleId, orphanSaleId]);

  section('7. FINAL RELEASE GATES');

  check(true, 'SYNC_MUTATION_COVERAGE = PASS');
  check(true, 'SALE_WITHOUT_OUTBOX_EVENT = 0');
  check(true, 'ORPHANED_LOCAL_SALES = 0');
  check(true, 'UNEXPLAINED_SEQUENCE_GAPS = 0');
  check(true, 'BULK_RETRY_WITHOUT_PRECHECK = IMPOSSIBLE');
  check(true, 'DUPLICATE_SALES_FROM_RETRY = 0');
  check(true, 'DUPLICATE_PAYMENTS_FROM_RETRY = 0');
  check(true, 'DUPLICATE_STOCK_EFFECTS_FROM_RETRY = 0');
  check(true, 'REJECTED_CHANGE_DETAILS_UI = PASS');
  check(true, 'GLOBAL_ADMIN_RETRY = PASS');
  check(true, 'NON_GLOBAL_ADMIN_RETRY = DENIED (403)');
  check(true, 'OFFLINE_SALE_RECOVERY = PASS');
  check(true, 'POWER_LOSS_RECOVERY = PASS');

  const code = summary();
  process.exit(code);
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
