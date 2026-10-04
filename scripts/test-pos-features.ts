import dotenv from 'dotenv';
import pg from 'pg';
import {
  adminSetStock,
  adminAddStock,
  adminRemoveStock,
  adminEditBatchExpiry,
} from '../server/db/inventory';
import {
  processSaleCheckout,
  getTodaySalesSummary,
} from '../server/db/sales';
import { searchMedicines } from '../src/services/searchEngine';
import { runMigrations } from '../server/db/migrator';
import { getDatabaseConnectionConfig } from '../server/db/client';
import type { Medicine, MedicineBatch } from '../src/types';

dotenv.config();

const { Pool } = pg;
const pool = new Pool(getDatabaseConnectionConfig());

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, details?: string) {
  if (condition) {
    results.push({ name, passed: true, details });
    console.log(`  [PASS] ${name}${details ? ` (${details})` : ''}`);
  } else {
    results.push({ name, passed: false, details, error: 'Assertion failed' });
    console.error(`  [FAIL] ${name}${details ? ` (${details})` : ''}`);
  }
}

async function runTests() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — POS, DISCOUNT, STOCK & RBAC TEST SUITE');
  console.log('=============================================================\n');

  // 0. Ensure Migrations are applied
  console.log('Step 0: Running Migrations...');
  const migResult = await runMigrations();
  console.log(`Migrations status: ${migResult.success ? 'SUCCESS' : 'FAILED'}, applied: ${migResult.applied.length}`);

  const testSuffix = Date.now().toString().substring(6);
  const testMedId = `med-test-${testSuffix}`;
  const testBatch1Id = `bat-test-1-${testSuffix}`;
  const testBatch2Id = `bat-test-2-${testSuffix}`;
  const cashierAId = `usr-cashier-a-${testSuffix}`;
  const cashierBId = `usr-cashier-b-${testSuffix}`;
  const adminId = `usr-admin-${testSuffix}`;

  try {
    // 1. Create Test Fixtures in PostgreSQL
    console.log('\nStep 1: Setting up Test Fixtures in PostgreSQL...');
    await pool.query(`
      INSERT INTO medicines (
        id, name, generic_name, brand_name, category, dosage_form, dosage_strength,
        barcode, sku, purchase_price, selling_price, current_stock, reorder_level, unit, status
      ) VALUES (
        $1, 'Amoxicillin 500mg Test', 'Amoxicillin', 'Amoxil', 'Antibiotics', 'Capsule', '500mg',
        $2, $3, 10.00, 20.00, 500, 50, 'Capsule', 'active'
      )
    `, [testMedId, `BC-${testSuffix}`, `SKU-${testSuffix}`]);

    await pool.query(`
      INSERT INTO medicine_batches (
        id, medicine_id, batch_number, quantity_received, quantity_available,
        purchase_price, expiry_date, expiry_status, status
      ) VALUES 
      ($1, $2, $3, 300, 300, 10.00, '2028-12-31', 'KNOWN', 'active'),
      ($4, $2, $5, 200, 200, 10.00, '2029-06-30', 'KNOWN', 'active')
    `, [
      testBatch1Id, testMedId, `BAT-A-${testSuffix}`,
      testBatch2Id, `BAT-B-${testSuffix}`
    ]);

    // -------------------------------------------------------------
    // PART A & 23, 24: DISCOUNT VALIDATION & FINANCIAL CALCULATIONS
    // -------------------------------------------------------------
    console.log('\nStep 2: Testing Cashier Discount Validation (0% - 10%)...');

    // 2.1: 0% Discount -> PASS
    try {
      const res0 = await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 1, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 100,
        discount_percent: 0,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(res0.success && res0.sale.discount_percent === 0 && res0.sale.total === 100, 'Cashier discount 0% allowed');
    } catch (e: any) {
      assert(false, 'Cashier discount 0% allowed', e.message);
    }

    // 2.2: 5% Discount -> PASS (Subtotal 5000, 5% = 250 discount, Total 4750)
    try {
      const res5 = await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 50, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 4750,
        discount_percent: 5,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(
        res5.success &&
        res5.sale.subtotal === 5000 &&
        res5.sale.discount_percent === 5 &&
        res5.sale.discount_total === 250 &&
        res5.sale.total === 4750,
        'Cashier discount 5% financial calculation (5000 - 250 = 4750)'
      );
    } catch (e: any) {
      assert(false, 'Cashier discount 5% financial calculation', e.message);
    }

    // 2.3: 10% Discount -> PASS (Subtotal 10,000, 10% = 1,000 discount, Total 9,000)
    try {
      const res10 = await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 100, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 9000,
        discount_percent: 10,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(
        res10.success &&
        res10.sale.subtotal === 10000 &&
        res10.sale.discount_percent === 10 &&
        res10.sale.discount_total === 1000 &&
        res10.sale.total === 9000,
        'Cashier discount 10% (10,000 - 1,000 = 9,000)'
      );
    } catch (e: any) {
      assert(false, 'Cashier discount 10%', e.message);
    }

    // 2.4: Decimal discount 2.5% -> PASS (Subtotal 1000, 2.5% = 25 discount, Total 975)
    try {
      const res25 = await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 10, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 975,
        discount_percent: 2.5,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(
        res25.success &&
        res25.sale.discount_percent === 2.5 &&
        res25.sale.discount_total === 25 &&
        res25.sale.total === 975,
        'Cashier decimal discount 2.5% allowed and calculated accurately'
      );
    } catch (e: any) {
      assert(false, 'Cashier decimal discount 2.5%', e.message);
    }

    // 2.5: 10.01% Discount for Cashier -> MUST BE REJECTED
    try {
      await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 1, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 100,
        discount_percent: 10.01,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(false, 'Cashier discount 10.01% rejected by backend', 'Allowed unexpectedly');
    } catch (e: any) {
      assert(e.message.includes('Cashier discount cannot exceed 10%'), 'Cashier discount 10.01% rejected by backend', e.message);
    }

    // 2.6: 11% Discount for Cashier -> MUST BE REJECTED
    try {
      await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 1, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 100,
        discount_percent: 11,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(false, 'Cashier discount 11% rejected by backend', 'Allowed unexpectedly');
    } catch (e: any) {
      assert(e.message.includes('Cashier discount cannot exceed 10%'), 'Cashier discount 11% rejected by backend', e.message);
    }

    // 2.7: 50% Discount for Cashier -> MUST BE REJECTED
    try {
      await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 1, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 100,
        discount_percent: 50,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(false, 'Cashier discount 50% rejected by backend', 'Allowed unexpectedly');
    } catch (e: any) {
      assert(e.message.includes('Cashier discount cannot exceed 10%'), 'Cashier discount 50% rejected by backend', e.message);
    }

    // 2.8: Negative Discount -> MUST BE REJECTED
    try {
      await processSaleCheckout({
        items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 1, unit_price: 100 }],
        payment_method: 'Cash',
        amount_received: 100,
        discount_percent: -5,
        cashier_id: cashierAId,
        cashier_name: 'Cashier A',
      } as any, { userRole: 'CASHIER' });
      assert(false, 'Negative discount rejected by backend', 'Allowed unexpectedly');
    } catch (e: any) {
      assert(e.message.includes('Discount percentage cannot be negative'), 'Negative discount rejected by backend', e.message);
    }

    // -------------------------------------------------------------
    // PART B & 25, 26: ADMIN STOCK EDITING & MULTI-BATCH INTEGRITY
    // -------------------------------------------------------------
    console.log('\nStep 3: Testing Admin Stock Editing (Set, Add, Remove, Batch Integrity)...');

    // 3.1: Admin Set Stock on Batch 1: Change Batch 1 from 300 to 250 (Delta = -50)
    const setStockRes1 = await adminSetStock({
      medicine_id: testMedId,
      batch_id: testBatch1Id,
      new_stock: 250,
      reason: 'Physical stock count correction',
      notes: 'Test stock count deduction',
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const check1 = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [testMedId]);
    const batchCheck1 = await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatch1Id]);
    const batchCheck2 = await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatch2Id]);

    assert(
      setStockRes1.success &&
      setStockRes1.delta === (250 - Number(setStockRes1.batch.quantity_available + 50) >= 0 ? -50 : -50) &&
      Number(batchCheck1.rows[0].quantity_available) === 250 &&
      Number(batchCheck2.rows[0].quantity_available) === 200 &&
      Number(check1.rows[0].current_stock) === 450,
      'Admin Set Stock (300 -> 250, delta -50; Total 450 = 250 + 200)'
    );

    // 3.2: Admin Set Stock on Batch 1: Change Batch 1 from 250 to 400 (Delta = +150)
    const setStockRes2 = await adminSetStock({
      medicine_id: testMedId,
      batch_id: testBatch1Id,
      new_stock: 400,
      reason: 'Physical stock count correction',
      notes: 'Test stock recount addition',
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const check2 = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [testMedId]);
    assert(
      setStockRes2.success &&
      Number(check2.rows[0].current_stock) === 600,
      'Admin Set Stock (250 -> 400, delta +150; Total 600 = 400 + 200)'
    );

    // 3.3: Verify Multi-Batch Integrity: Editing Batch 1 did NOT change Batch 2
    const batchCheck2After = await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatch2Id]);
    assert(
      Number(batchCheck2After.rows[0].quantity_available) === 200,
      'Multi-Batch Integrity preserved: Batch 2 remains exactly 200 units'
    );

    // 3.4: Admin Add Stock (Create or add to batch)
    const addStockRes = await adminAddStock({
      medicine_id: testMedId,
      batch_number: `BAT-NEW-${testSuffix}`,
      quantity: 50,
      expiry_date: '2028-10-10',
      purchase_price: 10.00,
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const check3 = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [testMedId]);
    assert(
      addStockRes.success &&
      addStockRes.added_quantity === 50 &&
      Number(check3.rows[0].current_stock) === 650,
      'Admin Add Stock (+50 units -> Total stock 650)'
    );

    // 3.5: Admin Remove Stock (Deduct 25 units from Batch 2)
    const removeStockRes = await adminRemoveStock({
      medicine_id: testMedId,
      batch_id: testBatch2Id,
      quantity: 25,
      reason: 'Damaged',
      notes: 'Broken during shelf restocking',
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const check4 = await pool.query('SELECT current_stock FROM medicines WHERE id = $1', [testMedId]);
    const batchCheck2Final = await pool.query('SELECT quantity_available FROM medicine_batches WHERE id = $1', [testBatch2Id]);
    assert(
      removeStockRes.success &&
      Number(batchCheck2Final.rows[0].quantity_available) === 175 &&
      Number(check4.rows[0].current_stock) === 625,
      'Admin Remove Stock (-25 units from Batch 2 -> Batch 2 is 175, Total is 625)'
    );

    // -------------------------------------------------------------
    // PART C & 27: ADMIN EXPIRY MANAGEMENT (KNOWN VS UNKNOWN)
    // -------------------------------------------------------------
    console.log('\nStep 4: Testing Admin Expiry Management (KNOWN vs UNKNOWN)...');

    // 4.1: Edit Expiry to a known date
    const expRes1 = await adminEditBatchExpiry({
      batch_id: testBatch2Id,
      expiry_date: '2030-01-15',
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const batchExp1 = await pool.query('SELECT expiry_date, expiry_status FROM medicine_batches WHERE id = $1', [testBatch2Id]);
    assert(
      expRes1.success &&
      batchExp1.rows[0].expiry_date.toISOString().startsWith('2030-01-15') &&
      batchExp1.rows[0].expiry_status === 'KNOWN',
      'Admin edit expiry date to 2030-01-15 -> expiry_status is KNOWN'
    );

    // 4.2: Edit Expiry to NULL / Unknown
    const expRes2 = await adminEditBatchExpiry({
      batch_id: testBatch2Id,
      expiry_date: null,
      user_id: adminId,
      user_name: 'Admin User',
      role: 'ADMIN',
    });

    const batchExp2 = await pool.query('SELECT expiry_date, expiry_status FROM medicine_batches WHERE id = $1', [testBatch2Id]);
    assert(
      expRes2.success &&
      batchExp2.rows[0].expiry_date === null &&
      batchExp2.rows[0].expiry_status === 'UNKNOWN',
      'Admin set expiry to null -> expiry_date is NULL and expiry_status is UNKNOWN'
    );

    // -------------------------------------------------------------
    // PART D & 28: MEDICINE SEARCH ENGINE TESTS
    // -------------------------------------------------------------
    console.log('\nStep 5: Testing Global Medicine Search Engine...');
    const testMedsList: Medicine[] = [
      {
        id: 'm1',
        name: 'Amoxicillin 500mg Trihydrate',
        generic_name: 'Amoxicillin',
        brand_name: 'Amoxil',
        category: 'Antibiotics',
        dosage_form: 'Capsule',
        dosage_strength: '500mg',
        barcode: '8901234567890',
        sku: 'AMX-500-CAP',
        purchase_price: 15,
        selling_price: 25,
        current_stock: 100,
        reorder_level: 20,
        unit: 'Capsule',
        status: 'active',
      } as any,
      {
        id: 'm2',
        name: 'Paracetamol 500mg Tablets',
        generic_name: 'Acetaminophen',
        brand_name: 'Panadol',
        category: 'Analgesics',
        dosage_form: 'Tablet',
        dosage_strength: '500mg',
        barcode: '8909876543210',
        sku: 'PCM-500-TAB',
        purchase_price: 2,
        selling_price: 5,
        current_stock: 500,
        reorder_level: 50,
        unit: 'Tablet',
        status: 'active',
      } as any,
    ];

    const searchName = searchMedicines('Amoxicillin', testMedsList);
    assert(searchName.length === 1 && searchName[0].id === 'm1', 'Search by full name ("Amoxicillin")');

    const searchPartial = searchMedicines('amox', testMedsList);
    assert(searchPartial.length === 1 && searchPartial[0].id === 'm1', 'Search by partial name ("amox")');

    const searchGeneric = searchMedicines('Acetaminophen', testMedsList);
    assert(searchGeneric.length === 1 && searchGeneric[0].id === 'm2', 'Search by generic name ("Acetaminophen")');

    const searchBrand = searchMedicines('Panadol', testMedsList);
    assert(searchBrand.length === 1 && searchBrand[0].id === 'm2', 'Search by brand ("Panadol")');

    const searchStrength = searchMedicines('500mg', testMedsList);
    assert(searchStrength.length === 2, 'Search by strength ("500mg")');

    const searchBarcode = searchMedicines('8901234567890', testMedsList);
    assert(searchBarcode.length === 1 && searchBarcode[0].id === 'm1', 'Search by barcode ("8901234567890")');

    const searchSku = searchMedicines('PCM-500-TAB', testMedsList);
    assert(searchSku.length === 1 && searchSku[0].id === 'm2', 'Search by SKU ("PCM-500-TAB")');

    // -------------------------------------------------------------
    // PART E, F & 29, 30: CASHIER DAILY SALES TOTALS & ISOLATION
    // -------------------------------------------------------------
    console.log('\nStep 6: Testing Cashier Daily Sales Totals & Cashier Isolation...');

    // Cashier A Sale 1: Cash = 1000
    await processSaleCheckout({
      items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 10, unit_price: 100 }],
      payment_method: 'Cash',
      amount_received: 100,
      discount_percent: 0,
      cashier_id: cashierAId,
      cashier_name: 'Cashier A',
    } as any, { userRole: 'CASHIER' });

    // Cashier A Sale 2: M-Pesa = 2000
    await processSaleCheckout({
      items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 20, unit_price: 100 }],
      payment_method: 'M-Pesa',
      payment_reference: `MPESA-${testSuffix}-1`,
      amount_received: 2000,
      discount_percent: 0,
      cashier_id: cashierAId,
      cashier_name: 'Cashier A',
    } as any, { userRole: 'CASHIER' });

    // Cashier A Sale 3: Subtotal = 1000, 10% discount -> Cash payment = 900
    await processSaleCheckout({
      items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 10, unit_price: 100 }],
      payment_method: 'Cash',
      amount_received: 900,
      discount_percent: 10,
      cashier_id: cashierAId,
      cashier_name: 'Cashier A',
    } as any, { userRole: 'CASHIER' });

    // Cashier B Sale: Cash = 500 (Separate cashier)
    await processSaleCheckout({
      items: [{ medicine_id: testMedId, batch_id: testBatch1Id, quantity: 5, unit_price: 100 }],
      payment_method: 'Cash',
      amount_received: 500,
      discount_percent: 0,
      cashier_id: cashierBId,
      cashier_name: 'Cashier B',
    } as any, { userRole: 'CASHIER' });

    // Query Summary for Cashier A
    const summaryA = await getTodaySalesSummary({
      cashierId: cashierAId,
      role: 'CASHIER',
    });

    // Expected for Cashier A:
    // Cash: 1000 + 900 = 1900
    // M-Pesa: 2000
    // Total: 3900
    // Count: 3 (Cashier B's 500 sale is isolated!)
    assert(
      summaryA.cashTotal === 1900 &&
      summaryA.mpesaTotal === 2000 &&
      summaryA.totalSales === 3900 &&
      summaryA.transactionCount === 3,
      'Cashier A Daily Totals: Cash = 1,900, M-Pesa = 2,000, Total = 3,900, Count = 3'
    );

    // Query Summary for Cashier B
    const summaryB = await getTodaySalesSummary({
      cashierId: cashierBId,
      role: 'CASHIER',
    });

    assert(
      summaryB.cashTotal === 500 &&
      summaryB.totalSales === 500 &&
      summaryB.transactionCount === 1,
      'Cashier B Daily Totals isolated: Cash = 500, Total = 500, Count = 1'
    );

    // Query Summary for Admin (Sees overall sales across all cashiers)
    const summaryAdmin = await getTodaySalesSummary({
      role: 'ADMIN',
    });

    assert(
      summaryAdmin.totalSales >= 4400 && // 3900 (Cashier A) + 500 (Cashier B) + earlier tests
      summaryAdmin.cashTotal >= 2400,
      'Admin Summary sees aggregate pharmacy total across all cashiers'
    );

    // -------------------------------------------------------------
    // PART G & 33: API SECURITY & AUDIT TRAIL VERIFICATION
    // -------------------------------------------------------------
    console.log('\nStep 7: Verifying Stock Movement Audit Logs in PostgreSQL...');
    const auditRes = await pool.query(`
      SELECT action, entity, entity_id FROM audit_logs
      WHERE entity_id = $1 OR user_id = $2
      ORDER BY timestamp DESC
    `, [testMedId, adminId]);

    assert(
      auditRes.rows.some((r) => r.action === 'ADMIN_SET_STOCK'),
      'Audit log recorded ADMIN_SET_STOCK action'
    );

    const movementsRes = await pool.query(`
      SELECT movement_type, adjustment_quantity, new_quantity FROM inventory_movements
      WHERE medicine_id = $1
      ORDER BY timestamp DESC
    `, [testMedId]);

    assert(
      movementsRes.rows.length >= 4,
      `Inventory movements recorded accurately (${movementsRes.rows.length} movement records found)`
    );

  } finally {
    // Clean up test data
    console.log('\nCleaning up test fixtures...');
    try {
      await pool.query('DELETE FROM customer_returns WHERE sale_id IN (SELECT id FROM sales WHERE cashier_id IN ($1, $2))', [cashierAId, cashierBId]);
      await pool.query('DELETE FROM payments WHERE sale_id IN (SELECT id FROM sales WHERE cashier_id IN ($1, $2))', [cashierAId, cashierBId]);
      await pool.query('DELETE FROM sale_items WHERE medicine_id = $1', [testMedId]);
      await pool.query('DELETE FROM sales WHERE cashier_id IN ($1, $2)', [cashierAId, cashierBId]);
      await pool.query('DELETE FROM inventory_movements WHERE medicine_id = $1', [testMedId]);
      await pool.query('DELETE FROM audit_logs WHERE entity_id = $1 OR user_id = $2', [testMedId, adminId]);
      await pool.query('DELETE FROM medicine_batches WHERE medicine_id = $1', [testMedId]);
      await pool.query('DELETE FROM medicines WHERE id = $1', [testMedId]);
    } catch (cleanErr) {}
    await pool.end();
  }

  // Summary
  console.log('\n=============================================================');
  console.log('  TEST SUMMARY');
  console.log('=============================================================');
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  console.log(`Total tests: ${results.length}`);
  console.log(`Passed:      ${passedCount}`);
  console.log(`Failed:      ${failedCount}`);

  if (failedCount > 0) {
    console.error('\nFAILED TESTS:');
    results.filter((r) => !r.passed).forEach((r) => console.error(`- ${r.name}: ${r.details || r.error}`));
    process.exit(1);
  } else {
    console.log('\nALL POS, DISCOUNT, STOCK & RBAC TESTS PASSED SUCCESSFULLY! ✓');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
