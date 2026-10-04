import fs from 'fs';
import path from 'path';
import { streamLegacyDump } from './parser';

async function investigateSalesVariance() {
  const sqlPath = path.resolve('chemist_pos.sql');

  const sales = new Map<number, any>();
  const saleItemsSum = new Map<number, number>();
  const salePaymentsSum = new Map<number, number>();
  const saleTaxesSum = new Map<number, number>();
  const salesWithoutItems = new Set<number>();
  const salesWithoutPayments = new Set<number>();

  await streamLegacyDump(sqlPath, {
    onRow: (table, row) => {
      if (table === 'ospos_sales') {
        sales.set(Number(row[4]), {
          sale_id: Number(row[4]),
          sale_time: row[0],
        });
      } else if (table === 'ospos_sales_items') {
        const sId = Number(row[0]);
        const qty = Number(row[5]) || 0;
        const price = Number(row[7]) || 0;
        const disc = Number(row[8]) || 0;
        const total = (qty * price) * (1 - disc / 100);
        saleItemsSum.set(sId, (saleItemsSum.get(sId) || 0) + total);
      } else if (table === 'ospos_sales_payments') {
        const sId = Number(row[0]);
        const pmt = Number(row[2]) || 0;
        salePaymentsSum.set(sId, (salePaymentsSum.get(sId) || 0) + pmt);
      } else if (table === 'ospos_sales_items_taxes') {
        // row: sale_id, item_id, line, name, percent
      }
    },
  });

  let totalItems = 0;
  let totalPayments = 0;
  let mismatchCount = 0;

  for (const sId of sales.keys()) {
    const itemTotal = saleItemsSum.get(sId) || 0;
    const pmtTotal = salePaymentsSum.get(sId) || 0;

    totalItems += itemTotal;
    totalPayments += pmtTotal;

    if (!saleItemsSum.has(sId)) salesWithoutItems.add(sId);
    if (!salePaymentsSum.has(sId)) salesWithoutPayments.add(sId);

    if (Math.abs(itemTotal - pmtTotal) > 0.01) {
      mismatchCount++;
    }
  }

  console.log(`Total Sales: ${sales.size}`);
  console.log(`Total Sales Items Sum: KES ${totalItems.toFixed(2)}`);
  console.log(`Total Payments Sum: KES ${totalPayments.toFixed(2)}`);
  console.log(`Variance: KES ${(totalPayments - totalItems).toFixed(2)}`);
  console.log(`Sales without items: ${salesWithoutItems.size}`);
  console.log(`Sales without payments: ${salesWithoutPayments.size}`);
  console.log(`Sales with item vs payment mismatch: ${mismatchCount}`);
}

investigateSalesVariance().catch(console.error);
