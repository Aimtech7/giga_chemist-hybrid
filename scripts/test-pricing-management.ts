import { adminUpdateMedicinePricing, getAllMedicines, getMedicineById } from '../server/db/medicines';
import { processSaleCheckout, getAllSales } from '../server/db/sales';
import { getAllAuditLogs } from '../server/db/audit';
import { serverDb } from '../server/db';
import { searchMedicines } from '../src/services/searchEngine';
import { canViewCostData, hasPermission } from '../src/services/permissions';
import type { Medicine, Sale, User, SaleItem } from '../src/types';

interface TestAssertion {
  id: number;
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

const assertions: TestAssertion[] = [];

function record(id: number, name: string, passed: boolean, expected: string, actual: string) {
  assertions.push({ id, name, passed, expected, actual });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] Item ${id}: ${name}`);
  if (!passed) {
    console.error(`       Expected: ${expected}`);
    console.error(`       Actual:   ${actual}`);
  }
}

async function runPricingTests() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — ADMIN-ONLY PRICE MANAGEMENT VERIFICATION');
  console.log('=============================================================\n');

  // Reset in-memory database store
  const store = serverDb.get();
  store.medicines = [];
  store.sales = [];
  store.audit_logs = [];
  store.processed_idempotency_keys = {};

  const adminUser: User = {
    id: 'usr-admin-01',
    name: 'Super Administrator',
    email: 'admin@gigachemist.co.ke',
    role: 'ADMIN',
    active: true,
    created_at: new Date().toISOString(),
  };

  const cashierUser: User = {
    id: 'usr-cashier-01',
    name: 'Jane Cashier',
    email: 'cashier@gigachemist.co.ke',
    role: 'CASHIER',
    active: true,
    created_at: new Date().toISOString(),
  };

  // Seed Initial Test Medicine:
  // Amoxicillin 500mg (Purchase: 60, Selling: 90, Stock: 100)
  const initialMed: Medicine = {
    id: 'med-amox-500',
    name: 'Amoxicillin 500mg',
    generic_name: 'Amoxicillin',
    brand_name: 'Amoxil',
    sku: 'SKU-AMX-500',
    barcode: '616400001234',
    category: 'Antibiotics',
    medicine_type: 'Capsule',
    dosage_strength: '500mg',
    dosage_form: 'Capsule',
    manufacturer: 'Dawa Ltd',
    description: 'Broad-spectrum antibiotic',
    purchase_price: 60.00,
    selling_price: 90.00,
    wholesale_price: 80.00,
    min_selling_price: 75.00,
    current_stock: 100,
    reorder_level: 20,
    unit: 'Strips (10 caps)',
    prescription_required: true,
    status: 'active',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'Admin',
    updated_by: 'Admin',
  };
  store.medicines.push(initialMed);

  // -------------------------------------------------------------------------
  // Pre-test: Create an Initial Historical Sale at KES 90
  // -------------------------------------------------------------------------
  const historicalItem: SaleItem = {
    medicine_id: initialMed.id,
    medicine_name: initialMed.name,
    generic_name: initialMed.generic_name,
    batch_id: 'bat-amx-01',
    batch_number: 'AMX-2026-01',
    expiry_date: '2028-12-31',
    quantity: 2,
    unit_price: 90.00, // Sold at old price 90
    discount: 0,
    cost_price_snapshot: 60.00,
    total: 180.00,
  };

  const historicalSale: Sale = {
    id: 'sale-hist-001',
    sale_number: 'GIGA-HIST-001',
    receipt_number: 'REC-HIST-001',
    date: '2026-01-15',
    time: '14:30',
    timestamp: new Date('2026-01-15T14:30:00Z').getTime(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'POS-TERMINAL-01',
    items: [historicalItem],
    subtotal: 180.00,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 180.00,
    cost_total: 120.00,
    gross_profit: 60.00,
    payment_method: 'Cash',
    amount_received: 200.00,
    change_given: 20.00,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-HIST-001',
  };
  await processSaleCheckout(historicalSale, { userRole: cashierUser.role, userId: cashierUser.id });

  // -------------------------------------------------------------------------
  // TEST 1: Admin Changes Selling Price (KES 90 -> KES 100)
  // -------------------------------------------------------------------------
  let updatedAfterSellingPrice: Medicine | null = null;
  try {
    updatedAfterSellingPrice = await adminUpdateMedicinePricing({
      id: initialMed.id,
      selling_price: 100.00,
      user_id: adminUser.id,
      user_name: adminUser.name,
      role: adminUser.role,
      device_id: 'SERVER-POS',
    });

    const passedSelling =
      updatedAfterSellingPrice !== null &&
      updatedAfterSellingPrice.selling_price === 100.00 &&
      updatedAfterSellingPrice.purchase_price === 60.00; // Cost remains unchanged

    record(
      1,
      'Admin changes selling price: KES 90 -> KES 100',
      passedSelling,
      'selling_price = 100.00, purchase_price = 60.00',
      `selling_price = ${updatedAfterSellingPrice?.selling_price}, purchase_price = ${updatedAfterSellingPrice?.purchase_price}`
    );
  } catch (err: any) {
    record(1, 'Admin changes selling price: KES 90 -> KES 100', false, 'Success', `Error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // TEST 2: Admin Changes Cost Price (KES 60 -> KES 65)
  // -------------------------------------------------------------------------
  let updatedAfterCostPrice: Medicine | null = null;
  try {
    updatedAfterCostPrice = await adminUpdateMedicinePricing({
      id: initialMed.id,
      purchase_price: 65.00,
      user_id: adminUser.id,
      user_name: adminUser.name,
      role: adminUser.role,
      device_id: 'SERVER-POS',
    });

    const passedCost =
      updatedAfterCostPrice !== null &&
      updatedAfterCostPrice.purchase_price === 65.00 &&
      updatedAfterCostPrice.selling_price === 100.00; // Selling price preserved

    record(
      2,
      'Admin changes cost price: KES 60 -> KES 65',
      passedCost,
      'purchase_price = 65.00, selling_price = 100.00',
      `purchase_price = ${updatedAfterCostPrice?.purchase_price}, selling_price = ${updatedAfterCostPrice?.selling_price}`
    );
  } catch (err: any) {
    record(2, 'Admin changes cost price: KES 60 -> KES 65', false, 'Success', `Error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Cashier Role Blocked from Price Editing (Frontend & RBAC Matrix)
  // -------------------------------------------------------------------------
  const cashierHasPermission = hasPermission(cashierUser, 'medicine.change_price');
  const cashierCanSeeCost = canViewCostData(cashierUser);
  const adminCanSeeCost = canViewCostData(adminUser);

  const rbacPassed = !cashierHasPermission && !cashierCanSeeCost && adminCanSeeCost;
  record(
    3,
    'Cashier restricted from price editing & cost view (Admin-Only RBAC)',
    rbacPassed,
    'cashier.change_price = false, cashier.canViewCost = false, admin.canViewCost = true',
    `cashier.change_price = ${cashierHasPermission}, cashier.canViewCost = ${cashierCanSeeCost}, admin.canViewCost = ${adminCanSeeCost}`
  );

  // -------------------------------------------------------------------------
  // TEST 4: Negative Price Rejected
  // -------------------------------------------------------------------------
  try {
    await adminUpdateMedicinePricing({
      id: initialMed.id,
      selling_price: -10.00,
      user_id: adminUser.id,
      user_name: adminUser.name,
      role: adminUser.role,
    });
    record(4, 'Negative selling price = REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('cannot be negative');
    record(4, 'Negative selling price = REJECTED', isRejected, 'Rejected with "cannot be negative"', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 5: Invalid Value (Non-Numeric Text) Rejected
  // -------------------------------------------------------------------------
  try {
    await adminUpdateMedicinePricing({
      id: initialMed.id,
      selling_price: 'abc' as any,
      user_id: adminUser.id,
      user_name: adminUser.name,
      role: adminUser.role,
    });
    record(5, 'Invalid text price ("abc") = REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('valid numeric value');
    record(5, 'Invalid text price ("abc") = REJECTED', isRejected, 'Rejected with "valid numeric value"', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 6: Audit Logging Recorded with Full Pricing Delta
  // -------------------------------------------------------------------------
  const auditLogs = await getAllAuditLogs();
  const priceAudit = auditLogs.find((l) => l.action === 'ADMIN_PRICE_UPDATE' && l.entity_id === initialMed.id);

  let auditPassed = false;
  if (priceAudit && priceAudit.new_value) {
    try {
      const parsed = JSON.parse(priceAudit.new_value);
      auditPassed =
        parsed.medicine_id === initialMed.id &&
        parsed.new_purchase_price === 65.00 &&
        parsed.new_selling_price === 100.00;
    } catch (e) {}
  }

  record(
    6,
    'Audit Log created for price update (ADMIN_PRICE_UPDATE)',
    auditPassed,
    'action = ADMIN_PRICE_UPDATE with old/new prices delta',
    `Found audit record: ${priceAudit ? JSON.stringify(priceAudit.action) : 'NONE'}`
  );

  // -------------------------------------------------------------------------
  // TEST 7: Immediate POS Refresh & Search Integration
  // -------------------------------------------------------------------------
  // Search query should return medicine with new price KES 100
  const searchResults = searchMedicines('amox', store.medicines);
  const foundMed = searchResults.find((m) => m.id === initialMed.id);
  const posRefreshPassed = foundMed !== undefined && foundMed.selling_price === 100.00;

  record(
    7,
    'Immediate POS refresh & search engine reflects new selling price (KES 100)',
    posRefreshPassed,
    'POS search returns selling_price = 100.00',
    `POS search selling_price = ${foundMed?.selling_price}`
  );

  // -------------------------------------------------------------------------
  // TEST 8: Future Sales Use New Selling Price (KES 100)
  // -------------------------------------------------------------------------
  const futureSaleItem: SaleItem = {
    medicine_id: foundMed!.id,
    medicine_name: foundMed!.name,
    generic_name: foundMed!.generic_name,
    batch_id: 'bat-amx-01',
    batch_number: 'AMX-2026-01',
    expiry_date: '2028-12-31',
    quantity: 3,
    unit_price: foundMed!.selling_price, // 100.00
    discount: 0,
    cost_price_snapshot: foundMed!.purchase_price, // 65.00
    total: 300.00,
  };

  const futureSale: Sale = {
    id: 'sale-future-002',
    sale_number: 'GIGA-FUT-002',
    receipt_number: 'REC-FUT-002',
    date: new Date().toISOString().split('T')[0],
    time: '15:00',
    timestamp: Date.now(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'POS-TERMINAL-01',
    items: [futureSaleItem],
    subtotal: 300.00,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 300.00,
    cost_total: 195.00,
    gross_profit: 105.00,
    payment_method: 'Cash',
    amount_received: 300.00,
    change_given: 0,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-FUT-002',
  };
  const resFuture = await processSaleCheckout(futureSale, { userRole: cashierUser.role, userId: cashierUser.id });
  const futureSalePassed = resFuture.success && resFuture.sale.total === 300.00 && resFuture.sale.items[0].unit_price === 100.00;

  record(
    8,
    'Future sales checkout accurately uses new price (3 units @ KES 100 = KES 300)',
    futureSalePassed,
    'total = 300.00, unit_price = 100.00',
    `total = ${resFuture.sale.total}, unit_price = ${resFuture.sale.items[0].unit_price}`
  );

  // -------------------------------------------------------------------------
  // TEST 9: Historical Sales Integrity Preserved
  // -------------------------------------------------------------------------
  const allSales = await getAllSales();
  const salesList = Array.isArray(allSales) ? allSales : allSales.sales;
  const retrievedHistSale = salesList.find((s) => s.id === 'sale-hist-001');

  const historicalIntegrityPassed =
    retrievedHistSale !== undefined &&
    retrievedHistSale.total === 180.00 &&
    retrievedHistSale.items[0].unit_price === 90.00 &&
    retrievedHistSale.items[0].cost_price_snapshot === 60.00;

  record(
    9,
    'Historical sale snapshot integrity preserved (Past sale remains 2 units @ KES 90 = KES 180)',
    historicalIntegrityPassed,
    'Historical sale total = 180.00, unit_price = 90.00',
    `Historical sale total = ${retrievedHistSale?.total}, unit_price = ${retrievedHistSale?.items[0].unit_price}`
  );

  console.log('\n=============================================================');
  const allPassed = assertions.every((a) => a.passed);
  console.log(`TOTAL PRICING VERIFICATION: ${assertions.filter((a) => a.passed).length} / ${assertions.length} PASSED`);
  console.log(`OVERALL STATUS: ${allPassed ? 'ALL PASS' : 'FAILURES DETECTED'}`);
  console.log('=============================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runPricingTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
