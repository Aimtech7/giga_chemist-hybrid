import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
import { getDatabaseConnectionConfig } from '../server/db/client';

/**
 * DEVELOPMENT-ONLY maintenance: zero ALL stock and set ALL batch expiries to 2029-01-31 so the
 * pharmacy can rebuild stock through Physical Stock Count.
 *
 * This is deliberately NOT a migration and is NOT wired into npm install / db:migrate / startup /
 * installer / upgrade. It refuses to run unless ALL of the following hold:
 *   1. the connected database (checked in PostgreSQL itself) is giga_chemist_dev
 *   2. DB_NAME (if set) is giga_chemist_dev
 *   3. ALLOW_DEV_STOCK_RESET=true
 *   4. the explicit flag --i-understand-this-zeroes-all-dev-stock is passed
 *
 * Run manually:
 *   set ALLOW_DEV_STOCK_RESET=true   (PowerShell: $env:ALLOW_DEV_STOCK_RESET='true')
 *   npx tsx scripts/dev-reset-stock-and-expiry.ts --i-understand-this-zeroes-all-dev-stock
 *
 * Changes ONLY: medicine_batches.quantity_available (-> 0), status (-> 'exhausted', 'recalled' kept),
 * expiry_date (-> 2029-01-31), expiry_status (-> 'KNOWN'), updated_at; medicines.current_stock (-> 0).
 * Adds one DEV_STOCK_RESET inventory movement per batch that had stock, and one audit row.
 * Never touches medicine identity, any price, quantity_received, sales, sale_items, payments,
 * purchases, suppliers, customers, users or existing inventory movements.
 */
const REQUIRED_DB = 'giga_chemist_dev';
const TARGET_EXPIRY = '2029-01-31';
const CONFIRM_FLAG = '--i-understand-this-zeroes-all-dev-stock';

function refuse(msg: string): never {
  console.error(`\n[REFUSED] ${msg}\nNo changes were made.`);
  process.exit(2);
}

async function main() {
  if (process.env.ALLOW_DEV_STOCK_RESET !== 'true') refuse('ALLOW_DEV_STOCK_RESET=true is not set.');
  if (!process.argv.includes(CONFIRM_FLAG)) refuse(`Missing explicit confirmation flag ${CONFIRM_FLAG}.`);
  if (process.env.DB_NAME && process.env.DB_NAME !== REQUIRED_DB) refuse(`DB_NAME is "${process.env.DB_NAME}", not ${REQUIRED_DB}.`);
  // The connection is taken from LOCAL_DATABASE_URL / DATABASE_URL before DB_NAME, so the database
  // that WOULD be used is checked here, before any connection is opened.
  const config: any = getDatabaseConnectionConfig();
  let targetDb = config.database as string | undefined;
  if (config.connectionString) {
    try {
      targetDb = decodeURIComponent(new URL(config.connectionString).pathname.replace(/^\//, ''));
    } catch {
      refuse('The database connection string cannot be parsed.');
    }
  }
  if (targetDb === 'giga_chemist') refuse('Target is the PRODUCTION pharmacy database "giga_chemist". This script never runs there.');
  if (targetDb !== REQUIRED_DB) refuse(`Configured database is "${targetDb}", not ${REQUIRED_DB}.`);

  const pool = new pg.Pool(config);
  const client = await pool.connect();
  try {
    const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
    if (db !== REQUIRED_DB) refuse(`Connected database is "${db}", not ${REQUIRED_DB}.`);

    const before = (
      await client.query(`SELECT
        (SELECT COALESCE(SUM(current_stock), 0) FROM medicines)::bigint AS med_stock,
        (SELECT COALESCE(SUM(quantity_available), 0) FROM medicine_batches)::bigint AS batch_stock,
        (SELECT COUNT(*) FROM medicine_batches)::int AS batches,
        (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available <> 0)::int AS batches_with_stock,
        (SELECT COUNT(*) FROM sales)::int AS sales,
        (SELECT COUNT(*) FROM sale_items)::int AS sale_items,
        (SELECT COUNT(*) FROM payments)::int AS payments,
        (SELECT COUNT(*) FROM purchases)::int AS purchases,
        (SELECT COUNT(*) FROM inventory_movements)::int AS movements,
        (SELECT COALESCE(SUM(quantity_received), 0) FROM medicine_batches)::bigint AS qty_received,
        (SELECT md5(string_agg(id::text || selling_price::text || COALESCE(wholesale_price::text, '') || purchase_price::text, ',' ORDER BY id)) FROM medicines) AS price_hash`)
    ).rows[0];
    console.log('Before:', before);

    await client.query('BEGIN');
    await client.query(`INSERT INTO devices (id, name, device_type, app_version, status)
                        VALUES ('SERVER', 'Local Server Backend', 'server', '1.0.0', 'active') ON CONFLICT (id) DO NOTHING`);
    const withStock = await client.query(
      'SELECT id, medicine_id, quantity_available FROM medicine_batches WHERE quantity_available <> 0 ORDER BY id FOR UPDATE'
    );
    const now = Date.now();
    for (const b of withStock.rows) {
      await client.query(
        `INSERT INTO inventory_movements (id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity,
           movement_type, reason, notes, device_id, date, timestamp)
         VALUES ($1, $2, $3, $4, $5, 0, 'DEV_STOCK_RESET', 'DEV_STOCK_RESET',
           'Development database stock reset (to be rebuilt by Physical Stock Count)', 'SERVER', CURRENT_DATE, $6)`,
        [crypto.randomUUID(), b.medicine_id, b.id, b.quantity_available, -Number(b.quantity_available), now]
      );
    }
    const batchUpd = await client.query(
      `UPDATE medicine_batches
         SET quantity_available = 0,
             status = CASE WHEN status = 'recalled' THEN status ELSE 'exhausted' END,
             expiry_date = $1::date, expiry_status = 'KNOWN', updated_at = CURRENT_TIMESTAMP`,
      [TARGET_EXPIRY]
    );
    const medUpd = await client.query(`UPDATE medicines SET current_stock = 0, updated_at = CURRENT_TIMESTAMP WHERE current_stock <> 0`);
    await client.query(
      `INSERT INTO audit_logs (id, user_name, role, action, entity, entity_id, previous_value, new_value, device_id, timestamp)
       VALUES ($1, 'Maintenance Script', 'ADMIN', 'DEV_STOCK_RESET', 'database', $2, $3, $4, 'SERVER', $5)`,
      [
        crypto.randomUUID(),
        REQUIRED_DB,
        JSON.stringify({ medicine_stock: Number(before.med_stock), batch_stock: Number(before.batch_stock) }),
        JSON.stringify({ batches_updated: batchUpd.rowCount, medicines_zeroed: medUpd.rowCount, movements_written: withStock.rowCount, expiry: TARGET_EXPIRY }),
        now,
      ]
    );
    await client.query('COMMIT');

    const after = (
      await client.query(`SELECT
        (SELECT COALESCE(SUM(current_stock), 0) FROM medicines)::bigint AS med_stock,
        (SELECT COALESCE(SUM(quantity_available), 0) FROM medicine_batches)::bigint AS batch_stock,
        (SELECT COUNT(*) FROM medicines WHERE current_stock <> 0)::int AS meds_nonzero,
        (SELECT COUNT(*) FROM medicine_batches WHERE quantity_available <> 0)::int AS batches_nonzero,
        (SELECT COUNT(*) FROM medicine_batches WHERE expiry_date IS DISTINCT FROM $1::date)::int AS batches_other_expiry,
        (SELECT COUNT(*) FROM medicine_batches WHERE expiry_status <> 'KNOWN')::int AS batches_not_known,
        (SELECT COUNT(*) FROM sales)::int AS sales,
        (SELECT COUNT(*) FROM sale_items)::int AS sale_items,
        (SELECT COUNT(*) FROM payments)::int AS payments,
        (SELECT COUNT(*) FROM purchases)::int AS purchases,
        (SELECT COUNT(*) FROM inventory_movements)::int AS movements,
        (SELECT COALESCE(SUM(quantity_received), 0) FROM medicine_batches)::bigint AS qty_received,
        (SELECT md5(string_agg(id::text || selling_price::text || COALESCE(wholesale_price::text, '') || purchase_price::text, ',' ORDER BY id)) FROM medicines) AS price_hash`,
        [TARGET_EXPIRY])
    ).rows[0];
    console.log('After:', after);

    const ok =
      Number(after.med_stock) === 0 && Number(after.batch_stock) === 0 && after.meds_nonzero === 0 &&
      after.batches_nonzero === 0 && after.batches_other_expiry === 0 && after.batches_not_known === 0 &&
      after.sales === before.sales && after.sale_items === before.sale_items && after.payments === before.payments &&
      after.purchases === before.purchases && after.movements === before.movements + withStock.rowCount! &&
      String(after.qty_received) === String(before.qty_received) && after.price_hash === before.price_hash;
    console.log(ok ? '\nVERIFIED: all stock 0, all batch expiries 2029-01-31 (KNOWN); history, prices and quantity_received unchanged.' : '\nVERIFICATION FAILED - inspect the numbers above.');
    process.exitCode = ok ? 0 : 1;
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[dev-reset] failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
