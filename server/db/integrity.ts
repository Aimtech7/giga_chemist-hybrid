import { pgPool } from './client';

/**
 * DATA INTEGRITY DASHBOARD (shop computer, READ ONLY). Every check is a SELECT; nothing is repaired
 * here (repairs are explicit, separate workflows). Findings in sales imported from the old system
 * (idempotency key LEGACY-%) are reported separately from new ones: legacy-only findings are INFO,
 * anything produced by the current application is a WARNING / CRITICAL.
 */
interface Check { key: string; label: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; sql: string; legacySplit?: boolean; explain: string }

const LEGACY = `s.idempotency_key LIKE 'LEGACY%'`;
const CHECKS: Check[] = [
  { key: 'NEGATIVE_BATCH_STOCK', label: 'Batches with negative stock', severity: 'CRITICAL', explain: 'Should be impossible (database constraint).',
    sql: `SELECT b.id::text AS ref FROM medicine_batches b WHERE b.quantity_available < 0` },
  { key: 'NEGATIVE_MEDICINE_STOCK', label: 'Medicines with negative total stock', severity: 'CRITICAL', explain: 'Total stock below zero.',
    sql: `SELECT m.id::text AS ref FROM medicines m WHERE m.current_stock < 0` },
  { key: 'MEDICINE_TOTAL_MISMATCH', label: 'Medicine total differs from its batches', severity: 'WARNING',
    explain: 'medicines.current_stock matches neither the unexpired nor the full sum of its active batches.',
    sql: `SELECT m.id::text AS ref FROM medicines m CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(b.quantity_available) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE), 0) AS fresh, COALESCE(SUM(b.quantity_available), 0) AS all_active
              FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active') t
          WHERE m.current_stock <> t.fresh AND m.current_stock <> t.all_active` },
  { key: 'ORPHAN_SALE_ITEMS', label: 'Sale lines without a sale', severity: 'CRITICAL', explain: 'A sale line points to a missing sale.',
    sql: `SELECT i.id::text AS ref FROM sale_items i WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = i.sale_id)` },
  { key: 'PAYMENTS_WITHOUT_SALE', label: 'Payments without a sale', severity: 'CRITICAL', explain: 'A payment points to a missing sale.',
    sql: `SELECT p.id::text AS ref FROM payments p WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p.sale_id)` },
  { key: 'SALES_WITHOUT_ITEMS', label: 'Sales without any line', severity: 'WARNING', legacySplit: true, explain: 'A sale has no sale_items.',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id)` },
  { key: 'SALES_WITHOUT_PAYMENT', label: 'Completed sales without a payment', severity: 'WARNING', legacySplit: true, explain: 'A non-voided sale has no payment row.',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s WHERE s.status <> 'voided' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)` },
  { key: 'SALE_TOTAL_VS_LINES', label: 'Sale total differs from its lines', severity: 'WARNING', legacySplit: true,
    explain: 'total - tax must equal the sum of the line totals (lines are after their discounts).',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s
           WHERE ABS(COALESCE(s.total, 0) - COALESCE(s.tax_total, 0) - COALESCE((SELECT SUM(i.total) FROM sale_items i WHERE i.sale_id = s.id), 0)) > 0.01` },
  { key: 'PAYMENTS_VS_TOTAL', label: 'Payments (minus change) differ from the sale total', severity: 'WARNING', legacySplit: true,
    explain: 'Cash is recorded as tendered: payments - change given must equal the total.',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s
           WHERE s.status <> 'voided' AND EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)
             AND ABS(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = s.id), 0) - COALESCE(s.change_given, 0) - COALESCE(s.total, 0)) > 0.01` },
  { key: 'IMPLAUSIBLE_SALE_DATES', label: 'Sales with an implausible date', severity: 'WARNING', legacySplit: true,
    explain: 'Before 2015 or in the future (usually a wrong computer clock in the old system).',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s WHERE s.date < DATE '2015-01-01' OR s.date > (now() AT TIME ZONE 'Africa/Nairobi')::date + 1` },
  { key: 'BATCHES_WITHOUT_MEDICINE', label: 'Batches without a medicine', severity: 'CRITICAL', explain: 'A batch points to a missing medicine.',
    sql: `SELECT b.id::text AS ref FROM medicine_batches b WHERE NOT EXISTS (SELECT 1 FROM medicines m WHERE m.id = b.medicine_id)` },
  { key: 'INVALID_SUPPLIER_LINKS', label: 'Batches / purchases with a missing supplier', severity: 'WARNING', explain: 'supplier_id points to no supplier.',
    sql: `SELECT b.id::text AS ref FROM medicine_batches b WHERE b.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers x WHERE x.id = b.supplier_id)
          UNION ALL SELECT p.order_number FROM purchases p WHERE p.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers x WHERE x.id = p.supplier_id)` },
  { key: 'INVALID_USER_LINKS', label: 'Sales with a missing cashier', severity: 'WARNING', legacySplit: true, explain: 'cashier_id points to no user.',
    sql: `SELECT s.receipt_number AS ref, ${LEGACY} AS legacy FROM sales s WHERE s.cashier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.cashier_id)` },
  { key: 'DUPLICATE_ACTIVE_BARCODES', label: 'Active medicines sharing a barcode', severity: 'WARNING', explain: 'Scanning would be ambiguous.',
    sql: `SELECT barcode AS ref FROM medicines WHERE status = 'active' AND barcode IS NOT NULL AND barcode <> '' GROUP BY barcode HAVING COUNT(*) > 1` },
  { key: 'ACTIVE_EXPIRED_BATCHES', label: 'Expired batches still active with stock', severity: 'INFO', explain: 'Expired stock is not sellable; dispose or record it.',
    sql: `SELECT b.batch_number AS ref FROM medicine_batches b WHERE b.status = 'active' AND b.quantity_available > 0 AND b.expiry_date <= CURRENT_DATE` },
  { key: 'ACTIVE_USERS_WITHOUT_PASSWORD', label: 'Active users without a usable password', severity: 'INFO', explain: 'Imported accounts that cannot log in until a password is set.',
    sql: `SELECT u.name AS ref FROM users u WHERE u.active AND u.password_hash !~ '^[0-9a-f]{32}[$][0-9a-f]{128}$'` },
  { key: 'STALE_OUTBOX_EVENTS', label: 'Outbox events waiting more than 1 hour', severity: 'WARNING', explain: 'Not yet accepted by the cloud (internet or a rejection).',
    sql: `SELECT e.seq::text AS ref FROM sync_events e WHERE e.status IN ('PENDING', 'PROCESSING', 'FAILED') AND e.created_at < now() - interval '1 hour'` },
  { key: 'REJECTED_COMMANDS_7D', label: 'Remote commands rejected (7 days)', severity: 'INFO', explain: 'See the Sync Center for the reasons.',
    sql: `SELECT c.command_type AS ref FROM sync_inbound_commands c WHERE c.status = 'REJECTED' AND c.received_at > now() - interval '7 days'` },
];

export async function integrityReport() {
  const started = Date.now();
  const results = [];
  for (const c of CHECKS) {
    try {
      const rows = (await pgPool.query(`SELECT * FROM (${c.sql}) q LIMIT 100000`)).rows;
      const legacy = c.legacySplit ? rows.filter((r: any) => r.legacy).length : 0;
      const current = rows.length - legacy;
      const severity = rows.length === 0 ? 'OK' : c.legacySplit && current === 0 ? 'INFO' : c.severity;
      results.push({
        key: c.key, label: c.label, explain: c.explain, severity, count: rows.length, legacy_count: legacy, current_count: current,
        sample: rows.filter((r: any) => !c.legacySplit || !r.legacy).concat(rows.filter((r: any) => r.legacy)).slice(0, 5).map((r: any) => String(r.ref)),
      });
    } catch (err: any) {
      results.push({ key: c.key, label: c.label, explain: c.explain, severity: 'UNKNOWN', count: null, error: String(err?.message || err).slice(0, 200) });
    }
  }
  const worst = ['CRITICAL', 'WARNING', 'INFO'].find((s) => results.some((r) => r.severity === s)) || 'OK';
  return { checked_at: new Date().toISOString(), duration_ms: Date.now() - started, overall: worst, read_only: true, checks: results };
}
