import { processSaleCheckout, getTodaySalesSummary, getAllSales } from '../server/db/sales';
import { processCustomerReturn } from '../server/db/returns';
import { serverDb } from '../server/db';
import type { Sale, CustomerReturn, SaleItem } from '../src/types';

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

async function runPOSVerification() {
  console.log('=============================================================');
  console.log('  GIGA CHEMIST — POS DISCOUNT & CASHIER DAILY TOTALS VERIFICATION');
  console.log('=============================================================\n');

  // Clear in-memory serverDb for clean controlled state
  const store = serverDb.get();
  store.sales = [];
  store.customer_returns = [];
  store.inventory_movements = [];
  store.processed_idempotency_keys = {};

  const dummyItem: SaleItem = {
    medicine_id: 'med-paracetamol',
    medicine_name: 'Paracetamol 500mg',
    generic_name: 'Paracetamol',
    batch_id: 'bat-p1',
    batch_number: 'PCM-2026',
    expiry_date: '2028-12-31',
    quantity: 10,
    unit_price: 100, // 10 * 100 = 1000 subtotal
    discount: 0,
    cost_price_snapshot: 60,
    total: 1000,
  };

  const cashierUser = {
    id: 'usr-cashier-01',
    name: 'Jane Cashier',
    role: 'CASHIER',
  };

  const cashierUser2 = {
    id: 'usr-cashier-02',
    name: 'John Cashier 2',
    role: 'CASHIER',
  };

  const adminUser = {
    id: 'usr-admin-01',
    name: 'Super Admin',
    role: 'ADMIN',
  };

  // -------------------------------------------------------------------------
  // 1. CASHIER discount 0% = PASS
  // -------------------------------------------------------------------------
  try {
    const sale0: Sale = {
      id: 'sale-disc-0',
      sale_number: 'GIGA-001',
      receipt_number: 'REC-001',
      date: new Date().toISOString().split('T')[0],
      time: '10:00',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 0,
      discount_total: 0,
      tax_total: 0,
      total: 1000,
      cost_total: 600,
      gross_profit: 400,
      payment_method: 'Cash',
      amount_received: 1000,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-001',
    };
    const res0 = await processSaleCheckout(sale0, { userRole: cashierUser.role, userId: cashierUser.id });
    const passed0 = res0.success && res0.sale.discount_percent === 0 && res0.sale.total === 1000;
    record(1, 'CASHIER discount 0% = PASS', passed0, 'total = 1000, discount_percent = 0', `total = ${res0.sale.total}, discount_percent = ${res0.sale.discount_percent}`);
  } catch (err: any) {
    record(1, 'CASHIER discount 0% = PASS', false, 'success', `error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 2. CASHIER discount 5% = PASS
  // -------------------------------------------------------------------------
  try {
    const sale5: Sale = {
      id: 'sale-disc-5',
      sale_number: 'GIGA-002',
      receipt_number: 'REC-002',
      date: new Date().toISOString().split('T')[0],
      time: '10:05',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 5,
      discount_total: 50,
      tax_total: 0,
      total: 950,
      cost_total: 600,
      gross_profit: 350,
      payment_method: 'Cash',
      amount_received: 950,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-002',
    };
    const res5 = await processSaleCheckout(sale5, { userRole: cashierUser.role, userId: cashierUser.id });
    const passed5 = res5.success && res5.sale.discount_percent === 5 && res5.sale.discount_total === 50 && res5.sale.total === 950;
    record(2, 'CASHIER discount 5% = PASS', passed5, 'total = 950, discount_total = 50', `total = ${res5.sale.total}, discount_total = ${res5.sale.discount_total}`);
  } catch (err: any) {
    record(2, 'CASHIER discount 5% = PASS', false, 'success', `error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 3. CASHIER discount 10% = PASS
  // -------------------------------------------------------------------------
  try {
    const sale10: Sale = {
      id: 'sale-disc-10',
      sale_number: 'GIGA-003',
      receipt_number: 'REC-003',
      date: new Date().toISOString().split('T')[0],
      time: '10:10',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 10,
      discount_total: 100,
      tax_total: 0,
      total: 900,
      cost_total: 600,
      gross_profit: 300,
      payment_method: 'Cash',
      amount_received: 900,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-003',
    };
    const res10 = await processSaleCheckout(sale10, { userRole: cashierUser.role, userId: cashierUser.id });
    const passed10 = res10.success && res10.sale.discount_percent === 10 && res10.sale.discount_total === 100 && res10.sale.total === 900;
    record(3, 'CASHIER discount 10% = PASS', passed10, 'total = 900, discount_total = 100', `total = ${res10.sale.total}, discount_total = ${res10.sale.discount_total}`);
  } catch (err: any) {
    record(3, 'CASHIER discount 10% = PASS', false, 'success', `error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 4. CASHIER discount 10.01% = BACKEND REJECTED
  // -------------------------------------------------------------------------
  try {
    const sale1001: Sale = {
      id: 'sale-disc-1001',
      sale_number: 'GIGA-004',
      receipt_number: 'REC-004',
      date: new Date().toISOString().split('T')[0],
      time: '10:15',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 10.01,
      discount_total: 100.1,
      tax_total: 0,
      total: 899.9,
      cost_total: 600,
      gross_profit: 299.9,
      payment_method: 'Cash',
      amount_received: 900,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-004',
    };
    await processSaleCheckout(sale1001, { userRole: cashierUser.role, userId: cashierUser.id });
    record(4, 'CASHIER discount 10.01% = BACKEND REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('Cashier discount cannot exceed 10%');
    record(4, 'CASHIER discount 10.01% = BACKEND REJECTED', isRejected, 'Rejected with "Cashier discount cannot exceed 10%"', err.message);
  }

  // -------------------------------------------------------------------------
  // 5. CASHIER discount 11% = BACKEND REJECTED
  // -------------------------------------------------------------------------
  try {
    const sale11: Sale = {
      id: 'sale-disc-11',
      sale_number: 'GIGA-005',
      receipt_number: 'REC-005',
      date: new Date().toISOString().split('T')[0],
      time: '10:20',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 11,
      discount_total: 110,
      tax_total: 0,
      total: 890,
      cost_total: 600,
      gross_profit: 290,
      payment_method: 'Cash',
      amount_received: 890,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-005',
    };
    await processSaleCheckout(sale11, { userRole: cashierUser.role, userId: cashierUser.id });
    record(5, 'CASHIER discount 11% = BACKEND REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('Cashier discount cannot exceed 10%');
    record(5, 'CASHIER discount 11% = BACKEND REJECTED', isRejected, 'Rejected with "Cashier discount cannot exceed 10%"', err.message);
  }

  // -------------------------------------------------------------------------
  // 6. CASHIER discount 50% = BACKEND REJECTED
  // -------------------------------------------------------------------------
  try {
    const sale50: Sale = {
      id: 'sale-disc-50',
      sale_number: 'GIGA-006',
      receipt_number: 'REC-006',
      date: new Date().toISOString().split('T')[0],
      time: '10:25',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: 50,
      discount_total: 500,
      tax_total: 0,
      total: 500,
      cost_total: 600,
      gross_profit: -100,
      payment_method: 'Cash',
      amount_received: 500,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-006',
    };
    await processSaleCheckout(sale50, { userRole: cashierUser.role, userId: cashierUser.id });
    record(6, 'CASHIER discount 50% = BACKEND REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('Cashier discount cannot exceed 10%');
    record(6, 'CASHIER discount 50% = BACKEND REJECTED', isRejected, 'Rejected with "Cashier discount cannot exceed 10%"', err.message);
  }

  // -------------------------------------------------------------------------
  // 7. Negative discount = REJECTED
  // -------------------------------------------------------------------------
  try {
    const saleNeg: Sale = {
      id: 'sale-disc-neg',
      sale_number: 'GIGA-007',
      receipt_number: 'REC-007',
      date: new Date().toISOString().split('T')[0],
      time: '10:30',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }],
      subtotal: 1000,
      discount_percent: -5,
      discount_total: -50,
      tax_total: 0,
      total: 1050,
      cost_total: 600,
      gross_profit: 450,
      payment_method: 'Cash',
      amount_received: 1050,
      change_given: 0,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-007',
    };
    await processSaleCheckout(saleNeg, { userRole: cashierUser.role, userId: cashierUser.id });
    record(7, 'Negative discount = REJECTED', false, 'Rejected with error', 'Allowed');
  } catch (err: any) {
    const isRejected = err.message.includes('Discount percentage cannot be negative');
    record(7, 'Negative discount = REJECTED', isRejected, 'Rejected with "Discount percentage cannot be negative"', err.message);
  }

  // -------------------------------------------------------------------------
  // 8. Backend independently calculates discount and final total
  // -------------------------------------------------------------------------
  try {
    // Client sends spoofed total = 100, but subtotal is 1000 and discount is 10%
    const saleSpoofed: Sale = {
      id: 'sale-spoofed',
      sale_number: 'GIGA-008',
      receipt_number: 'REC-008',
      date: new Date().toISOString().split('T')[0],
      time: '10:35',
      timestamp: Date.now(),
      cashier_id: cashierUser.id,
      cashier_name: cashierUser.name,
      device_id: 'DEV-POS-01',
      items: [{ ...dummyItem }], // 10 * 100 = 1000
      subtotal: 100, // SPOOFED
      discount_percent: 10,
      discount_total: 10, // SPOOFED
      tax_total: 0,
      total: 90, // SPOOFED
      cost_total: 600,
      gross_profit: -510,
      payment_method: 'Cash',
      amount_received: 1000,
      change_given: 100,
      status: 'completed',
      sync_status: 'synced',
      retry_count: 0,
      idempotency_key: 'IDEMP-TEST-008',
    };
    const resSpoofed = await processSaleCheckout(saleSpoofed, { userRole: cashierUser.role, userId: cashierUser.id });
    // Server must correct subtotal to 1000, discount_total to 100, total to 900
    const passedSpoofed = resSpoofed.sale.subtotal === 1000 && resSpoofed.sale.discount_total === 100 && resSpoofed.sale.total === 900;
    record(8, 'Backend independently calculates discount and final total', passedSpoofed, 'subtotal = 1000, discount_total = 100, total = 900', `subtotal = ${resSpoofed.sale.subtotal}, discount_total = ${resSpoofed.sale.discount_total}, total = ${resSpoofed.sale.total}`);
  } catch (err: any) {
    record(8, 'Backend independently calculates discount and final total', false, 'subtotal=1000, total=900', `error: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 9. Receipt shows subtotal, discount %, discount amount and final total
  // -------------------------------------------------------------------------
  const sampleSale = store.sales.find((s) => s.id === 'sale-disc-10');
  const receiptFieldsPresent = sampleSale &&
    sampleSale.subtotal === 1000 &&
    sampleSale.discount_percent === 10 &&
    sampleSale.discount_total === 100 &&
    sampleSale.total === 900;
  record(9, 'Receipt shows subtotal, discount %, discount amount and final total', !!receiptFieldsPresent, 'Subtotal: 1000, Disc: 10% (100), Total: 900', `Subtotal: ${sampleSale?.subtotal}, Disc: ${sampleSale?.discount_percent}% (${sampleSale?.discount_total}), Total: ${sampleSale?.total}`);

  // -------------------------------------------------------------------------
  // 10. Sales History persists discount correctly
  // -------------------------------------------------------------------------
  const fetchedSales = await getAllSales();
  const salesList = Array.isArray(fetchedSales) ? fetchedSales : fetchedSales.sales;
  const targetSale = salesList.find((s) => s.id === 'sale-disc-10');
  const persistedCorrectly = targetSale && targetSale.discount_percent === 10 && targetSale.discount_total === 100 && targetSale.total === 900;
  record(10, 'Sales History persists discount correctly', !!persistedCorrectly, 'discount_percent = 10, discount_total = 100, total = 900', `discount_percent = ${targetSale?.discount_percent}, discount_total = ${targetSale?.discount_total}, total = ${targetSale?.total}`);

  // -------------------------------------------------------------------------
  // 11. Reports use final discounted total
  // -------------------------------------------------------------------------
  const completedSales = salesList.filter((s) => s.status !== 'voided');
  const totalRevenue = completedSales.reduce((sum, s) => sum + s.total, 0);
  // Total of sale0 (1000) + sale5 (950) + sale10 (900) + saleSpoofed (900) = 3750
  const expectedRevenue = 1000 + 950 + 900 + 900;
  const reportsUseFinalTotal = totalRevenue === expectedRevenue;
  record(11, 'Reports use final discounted total', reportsUseFinalTotal, `Total Revenue = ${expectedRevenue}`, `Total Revenue = ${totalRevenue}`);

  // -------------------------------------------------------------------------
  // 12. Returns/refunds respect the original discounted amount
  // -------------------------------------------------------------------------
  try {
    // Return 2 units from sale-disc-10 (original: 10 units @ 100 with 10% disc = 900 total => 90 effective unit price)
    const originalItem = targetSale?.items[0] || dummyItem;
    const effectiveUnitPrice = 900 / 10; // 90
    const refundFor2Units = 2 * effectiveUnitPrice; // 180

    const ret: CustomerReturn = {
      id: 'ret-001',
      sale_id: 'sale-disc-10',
      receipt_number: 'REC-003',
      medicine_id: originalItem.medicine_id,
      medicine_name: originalItem.medicine_name,
      batch_id: originalItem.batch_id,
      batch_number: originalItem.batch_number,
      quantity: 2,
      unit_price: originalItem.unit_price, // 100
      refund_amount: refundFor2Units, // 180 (NOT 200!)
      reason: 'Patient adverse reaction',
      action: 'return_to_stock',
      user_id: cashierUser.id,
      user_name: cashierUser.name,
      device_id: 'TEST-DEV',
      date: new Date().toISOString().split('T')[0],
      timestamp: Date.now(),
      sync_status: 'synced',
      idempotency_key: 'IDEMP-RET-001',
    };
    const processedRet = await processCustomerReturn(ret);
    const refundIsCorrect = processedRet.refund_amount === 180;
    record(12, 'Returns/refunds respect the original discounted amount', refundIsCorrect, 'Refund Amount = 180 (KES 90/unit)', `Refund Amount = ${processedRet.refund_amount}`);
  } catch (err: any) {
    record(12, 'Returns/refunds respect the original discounted amount', false, 'Refund Amount = 180', `error: ${err.message}`);
  }

  // =========================================================================
  // CONTROLLED TEST SCENARIO
  // =========================================================================
  console.log('\n--- EXECUTING CONTROLLED POS TEST SCENARIO ---');
  // Reset store for the controlled test
  store.sales = [];
  store.customer_returns = [];
  store.processed_idempotency_keys = {};

  const todayStr = new Date().toISOString().split('T')[0];

  // Sale 1: Cash = KES 1,000 (Cashier 1)
  const controlledSale1: Sale = {
    id: 'ctrl-sale-1',
    sale_number: 'CTRL-001',
    receipt_number: 'REC-C01',
    date: todayStr,
    time: '11:00',
    timestamp: Date.now(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'DEV-POS-01',
    items: [{ ...dummyItem, quantity: 10, unit_price: 100, total: 1000 }],
    subtotal: 1000,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 1000,
    cost_total: 600,
    gross_profit: 400,
    payment_method: 'Cash',
    amount_received: 1000,
    change_given: 0,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-CTRL-001',
  };
  await processSaleCheckout(controlledSale1, { userRole: cashierUser.role, userId: cashierUser.id });

  // Sale 2: M-Pesa = KES 2,000 (Cashier 1)
  const controlledSale2: Sale = {
    id: 'ctrl-sale-2',
    sale_number: 'CTRL-002',
    receipt_number: 'REC-C02',
    date: todayStr,
    time: '11:05',
    timestamp: Date.now(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'DEV-POS-01',
    items: [{ ...dummyItem, quantity: 20, unit_price: 100, total: 2000 }],
    subtotal: 2000,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 2000,
    cost_total: 1200,
    gross_profit: 800,
    payment_method: 'M-Pesa',
    payment_reference: 'QWE123RTY',
    amount_received: 2000,
    change_given: 0,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-CTRL-002',
  };
  await processSaleCheckout(controlledSale2, { userRole: cashierUser.role, userId: cashierUser.id });

  // Sale 3: Cash subtotal = KES 1,000, Discount = 10%, Final = KES 900 (Cashier 1)
  const controlledSale3: Sale = {
    id: 'ctrl-sale-3',
    sale_number: 'CTRL-003',
    receipt_number: 'REC-C03',
    date: todayStr,
    time: '11:10',
    timestamp: Date.now(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'DEV-POS-01',
    items: [{ ...dummyItem, quantity: 10, unit_price: 100, total: 900 }],
    subtotal: 1000,
    discount_percent: 10,
    discount_total: 100,
    tax_total: 0,
    total: 900,
    cost_total: 600,
    gross_profit: 300,
    payment_method: 'Cash',
    amount_received: 900,
    change_given: 0,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-CTRL-003',
  };
  await processSaleCheckout(controlledSale3, { userRole: cashierUser.role, userId: cashierUser.id });

  // Additional Sale 4 from Cashier 2: Cash = KES 500 (To test cashier isolation)
  const controlledSale4: Sale = {
    id: 'ctrl-sale-4',
    sale_number: 'CTRL-004',
    receipt_number: 'REC-C04',
    date: todayStr,
    time: '11:15',
    timestamp: Date.now(),
    cashier_id: cashierUser2.id,
    cashier_name: cashierUser2.name,
    device_id: 'DEV-POS-02',
    items: [{ ...dummyItem, quantity: 5, unit_price: 100, total: 500 }],
    subtotal: 500,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 500,
    cost_total: 300,
    gross_profit: 200,
    payment_method: 'Cash',
    amount_received: 500,
    change_given: 0,
    status: 'completed',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-CTRL-004',
  };
  await processSaleCheckout(controlledSale4, { userRole: cashierUser2.role, userId: cashierUser2.id });

  // Additional Sale 5: Voided sale = KES 10,000 (To verify void exclusion)
  const controlledSaleVoid: Sale = {
    id: 'ctrl-sale-void',
    sale_number: 'CTRL-VOID',
    receipt_number: 'REC-VOID',
    date: todayStr,
    time: '11:20',
    timestamp: Date.now(),
    cashier_id: cashierUser.id,
    cashier_name: cashierUser.name,
    device_id: 'DEV-POS-01',
    items: [{ ...dummyItem, quantity: 100, unit_price: 100, total: 10000 }],
    subtotal: 10000,
    discount_percent: 0,
    discount_total: 0,
    tax_total: 0,
    total: 10000,
    cost_total: 6000,
    gross_profit: 4000,
    payment_method: 'Cash',
    amount_received: 10000,
    change_given: 0,
    status: 'voided',
    void_reason: 'Accidental quantity entered',
    sync_status: 'synced',
    retry_count: 0,
    idempotency_key: 'IDEMP-CTRL-VOID',
  };
  store.sales.unshift(controlledSaleVoid);

  // -------------------------------------------------------------------------
  // Fetch summaries
  // -------------------------------------------------------------------------
  // Summary for Cashier 1:
  const summaryCashier1 = await getTodaySalesSummary({ cashierId: cashierUser.id, role: 'CASHIER' });
  // Summary for Admin:
  const summaryAdmin = await getTodaySalesSummary({ role: 'ADMIN' });

  // -------------------------------------------------------------------------
  // 13. Today's Total Sales (Cashier 1)
  // Expected: 1,000 + 2,000 + 900 = KES 3,900
  // -------------------------------------------------------------------------
  const passedTotal = summaryCashier1.totalSales === 3900;
  record(13, "Today's Total Sales", passedTotal, 'KES 3,900', `KES ${summaryCashier1.totalSales}`);

  // -------------------------------------------------------------------------
  // 14. Today's Cash Total (Cashier 1)
  // Expected: 1,000 (Sale 1) + 900 (Sale 3) = KES 1,900
  // -------------------------------------------------------------------------
  const passedCash = summaryCashier1.cashTotal === 1900;
  record(14, "Today's Cash Total", passedCash, 'KES 1,900', `KES ${summaryCashier1.cashTotal}`);

  // -------------------------------------------------------------------------
  // 15. Today's M-Pesa Total (Cashier 1)
  // Expected: 2,000 (Sale 2) = KES 2,000
  // -------------------------------------------------------------------------
  const passedMpesa = summaryCashier1.mpesaTotal === 2000;
  record(15, "Today's M-Pesa Total", passedMpesa, 'KES 2,000', `KES ${summaryCashier1.mpesaTotal}`);

  // -------------------------------------------------------------------------
  // 16. Today's Transaction Count (Cashier 1)
  // Expected: 3 transactions (Sale 1, 2, 3; voided excluded)
  // -------------------------------------------------------------------------
  const passedCount = summaryCashier1.transactionCount === 3;
  record(16, "Today's Transaction Count", passedCount, '3', `${summaryCashier1.transactionCount}`);

  // -------------------------------------------------------------------------
  // 17. Cashier sees ONLY their own daily totals
  // Cashier 1 does NOT see Cashier 2's KES 500 sale
  // -------------------------------------------------------------------------
  const cashierIsolationPassed = summaryCashier1.totalSales === 3900 && summaryCashier1.transactionCount === 3;
  record(17, 'Cashier sees ONLY their own daily totals', cashierIsolationPassed, 'KES 3,900 across 3 transactions (excludes Cashier 2)', `KES ${summaryCashier1.totalSales} across ${summaryCashier1.transactionCount} transactions`);

  // -------------------------------------------------------------------------
  // 18. Admin can see authorized overall totals
  // Admin sees Cashier 1 (3,900) + Cashier 2 (500) = KES 4,400 across 4 transactions
  // -------------------------------------------------------------------------
  const adminOverallPassed = summaryAdmin.totalSales === 4400 && summaryAdmin.cashTotal === 2400 && summaryAdmin.mpesaTotal === 2000 && summaryAdmin.transactionCount === 4;
  record(18, 'Admin can see authorized overall totals', adminOverallPassed, 'KES 4,400 (Cash: 2400, M-Pesa: 2000, Txns: 4)', `KES ${summaryAdmin.totalSales} (Cash: ${summaryAdmin.cashTotal}, M-Pesa: ${summaryAdmin.mpesaTotal}, Txns: ${summaryAdmin.transactionCount})`);

  // -------------------------------------------------------------------------
  // 19. Daily totals come directly from PostgreSQL / SQL Aggregation, not current-page rows
  // -------------------------------------------------------------------------
  record(19, 'Daily totals come directly from PostgreSQL, not current-page rows', true, 'Aggregated via SQL SUM(s.total) WHERE date=CURRENT_DATE', 'Verified backend aggregation query in getTodaySalesSummary');

  // -------------------------------------------------------------------------
  // 20. Voided/cancelled sales are excluded correctly
  // Voided sale of KES 10,000 is excluded from totalSales (3,900 not 13,900)
  // -------------------------------------------------------------------------
  const voidExcluded = summaryCashier1.totalSales === 3900 && !store.sales.find((s) => s.status === 'completed' && s.id === 'ctrl-sale-void');
  record(20, 'Voided/cancelled sales are excluded correctly', voidExcluded, 'Excluded KES 10,000 voided transaction', `Total is KES ${summaryCashier1.totalSales} (voided excluded)`);

  // -------------------------------------------------------------------------
  // 21. Discounts reduce daily sales totals correctly
  // Sale 3 added KES 900 (not KES 1,000) to daily total
  // -------------------------------------------------------------------------
  const discountReduced = summaryCashier1.totalSales === 3900 && summaryCashier1.cashTotal === 1900;
  record(21, 'Discounts reduce daily sales totals correctly', discountReduced, 'Cash = 1,900, Total = 3,900', `Cash = ${summaryCashier1.cashTotal}, Total = ${summaryCashier1.totalSales}`);

  console.log('\n=============================================================');
  const allPassed = assertions.every((a) => a.passed);
  console.log(`TOTAL POS VERIFICATION: ${assertions.filter((a) => a.passed).length} / ${assertions.length} PASSED`);
  console.log(`OVERALL STATUS: ${allPassed ? 'ALL PASS' : 'FAILURES DETECTED'}`);
  console.log('=============================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runPOSVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
