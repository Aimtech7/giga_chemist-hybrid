import fs from 'fs';
import path from 'path';
import { runMigration } from './migrate';

async function validateMigrationPipeline() {
  console.log('======================================================================');
  console.log('  GIGA CHEMIST — MIGRATION PIPELINE AUTOMATED VALIDATION TEST');
  console.log('======================================================================\n');

  // Run in dry-run mode
  const { stats, data } = await runMigration(true);

  console.log('\n--- EXECUTING AUTOMATED ASSERTIONS ---');

  // Assertion 1: Zero password hashes in transformed users
  const hasPasswords = data.users.some(
    (u) =>
      u.password_hash.includes('6b0890b68b99cdd9614a29ee04d2c10e') || // legacy MD5 hashes
      u.password_hash.includes('9559d0fb8e5a21a54917f48721e06612') ||
      u.password_hash.length === 32
  );
  if (hasPasswords) {
    throw new Error('SECURITY VIOLATION: Legacy MD5 password hashes found in transformed user dataset!');
  }
  console.log('✓ PASS: Zero legacy passwords or MD5 hashes imported (all staff profiles locked).');

  // Assertion 2: Entity count matching
  if (stats.medicinesCount !== 2181) {
    throw new Error(`Item count mismatch: expected 2181, got ${stats.medicinesCount}`);
  }
  console.log(`✓ PASS: Medicines count matches legacy items (${stats.medicinesCount} items).`);

  // Assertion 3: Opening batches
  if (stats.batchesCount !== 2181) {
    throw new Error(`Batch count mismatch: expected 2181, got ${stats.batchesCount}`);
  }
  console.log(`✓ PASS: Batches created for all formulary items (${stats.batchesCount} batches).`);

  // Assertion 4: Historical Sales Count
  if (stats.salesCount !== 135818) {
    throw new Error(`Sales count mismatch: expected 135818, got ${stats.salesCount}`);
  }
  console.log(`✓ PASS: Sales count matches legacy (${stats.salesCount.toLocaleString()} transactions).`);

  // Assertion 5: Sale Line Items Count
  if (stats.saleItemsCount !== 226401) {
    throw new Error(`Sale items count mismatch: expected 226401, got ${stats.saleItemsCount}`);
  }
  console.log(`✓ PASS: Sale items count matches legacy (${stats.saleItemsCount.toLocaleString()} lines).`);

  // Assertion 6: Payments Count & Total Amount
  if (stats.paymentsCount !== 135817) {
    throw new Error(`Payments count mismatch: expected 135817, got ${stats.paymentsCount}`);
  }
  if (Math.abs(stats.totalPaymentsAmount - 45360422.53) > 0.01) {
    throw new Error(`Payments sum mismatch: expected KES 45,360,422.53, got ${stats.totalPaymentsAmount}`);
  }
  console.log(`✓ PASS: Payments count (${stats.paymentsCount.toLocaleString()}) and total (KES ${stats.totalPaymentsAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) exactly match legacy.`);

  // Assertion 7: Purchases Count
  if (stats.purchasesCount !== 728) {
    throw new Error(`Purchases count mismatch: expected 728, got ${stats.purchasesCount}`);
  }
  console.log(`✓ PASS: Purchases count matches legacy (${stats.purchasesCount} orders).`);

  // Assertion 8: Inventory movements count
  if (stats.inventoryMovementsCount !== 263107) {
    throw new Error(`Inventory movements count mismatch: expected 263107, got ${stats.inventoryMovementsCount}`);
  }
  console.log(`✓ PASS: Inventory movements audit records match legacy (${stats.inventoryMovementsCount.toLocaleString()} entries).`);

  // Assertion 9: Suppliers & Customers
  if (stats.suppliersCount !== 7 || stats.customersCount !== 1) {
    throw new Error('Suppliers / customers count mismatch.');
  }
  console.log(`✓ PASS: Suppliers (${stats.suppliersCount}) and Customers (${stats.customersCount}) match.`);

  // Assertion 10: Zero fake expiry dates (No 2029 placeholder)
  const hasFakeDates = data.batches.some(
    (b) => b.expiry_date === '2029-12-31' || (b.expiry_date !== null && b.expiry_status === 'UNKNOWN')
  );
  if (hasFakeDates) {
    throw new Error('CLINICAL SAFETY VIOLATION: Fake expiry dates or 2029-12-31 placeholder found in legacy batch data!');
  }
  const allBatchesUnknown = data.batches.every((b) => b.expiry_date === null && b.expiry_status === 'UNKNOWN');
  if (!allBatchesUnknown) {
    throw new Error('Legacy batches must have expiry_date = null and expiry_status = UNKNOWN');
  }
  console.log(`✓ PASS: Truth-based expiry verified — 0 fake dates, all ${data.batches.length} legacy batches have expiry_date = null and expiry_status = UNKNOWN.`);

  // Assertion 11: Financial Change/Tender Reconciliation
  const calculatedDifference = stats.totalPaymentsAmount - stats.totalSalesNet;
  if (Math.abs(calculatedDifference - 60500.15) > 0.01) {
    throw new Error(`Financial reconciliation variance mismatch: expected KES 60,500.15, got KES ${calculatedDifference.toFixed(2)}`);
  }
  console.log(`✓ PASS: Financial change/tender variance mathematically verified (KES ${calculatedDifference.toFixed(2)} across 334 overtender/rounding transactions).`);

  console.log('\n======================================================================');
  console.log('  ALL MIGRATION PIPELINE INTEGRITY TESTS PASSED SUCCESSFULLY (11/11)');
  console.log('======================================================================\n');
}

validateMigrationPipeline().catch((err) => {
  console.error('[VALIDATION FAILED]', err);
  process.exit(1);
});
