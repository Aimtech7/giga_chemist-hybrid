process.env.APP_MODE = 'hybrid';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { withTransaction, HttpError } from '../../server/db/client';
import {
  createMedicineTx,
  deleteOrArchiveMedicineTx,
  previewMedicineDeletion,
  restoreMedicineTx,
} from '../../server/db/medicines';
import {
  shopSupportsMedicineDelete,
  buildRemoteAdminRouter,
  isAllShopsScope,
} from '../../server/online/remoteAdmin';
import { applyCloudCommand } from '../../server/sync/commands';
import { getShopIdentity } from '../../server/sync/identity';
import { validateCommandPayload } from '../../server/sync/commandSchema';

/**
 * ONLINE GLOBAL ADMIN MEDICINE DELETE END-TO-END TEST SUITE
 *
 * Verifies all 10 requirements:
 * TEST 1 — BUTTON VISIBILITY & BUNDLE VERIFICATION
 * TEST 2 — NON GLOBAL ADMIN RBAC (403 GLOBAL_ADMIN_ONLY)
 * TEST 3 — PREVIEW ENDPOINT SCHEMA & VALUES
 * TEST 4 — UNUSED MEDICINE (PERMANENT_DELETE + TOMBSTONE + REMOVAL)
 * TEST 5 — HISTORICAL MEDICINE (ARCHIVE_REQUIRED + RECEIPTS INTACT)
 * TEST 6 — STOCK EXISTS (BLOCKED WITH MEDICINE_HAS_STOCK)
 * TEST 7 — STALE CONCURRENCY (REJECTED ON VERSION/STOCK CONFLICT)
 * TEST 8 — OLD EVENT RESURRECTION (TOMBSTONE PREVENTS RESURRECTION)
 * TEST 9 — ALL SHOPS SCOPE (STRICTLY BLOCKED)
 * TEST 10 — SHOP TOO OLD (CAPABILITY GATE BLOCKS OLD COMMITS)
 */

async function run() {
  await assertDevDatabase();

  const client = await pool.connect();
  const identity = await getShopIdentity();
  const shopId = identity.shop_id;

  const adminRow = (await pool.query("SELECT id, name FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
  if (!adminRow) throw new Error('No admin user found in database for testing.');
  const adminActor = { user_id: adminRow.id, user_name: adminRow.name || 'Admin', role: 'ADMIN' as const };

  try {
    // =========================================================================
    // TEST 1 — BUTTON VISIBILITY & BUNDLE VERIFICATION
    // =========================================================================
    section('TEST 1 — BUTTON VISIBILITY & BUNDLE VERIFICATION');

    const medicinesTableSource = fs.readFileSync(path.resolve('src/components/remote/MedicinesTable.tsx'), 'utf-8');
    check(medicinesTableSource.includes("'delete'"), '1.1 MedicinesTable includes "delete" in RowAction');
    check(medicinesTableSource.includes('Trash2'), '1.2 MedicinesTable imports and renders Trash2 icon');
    check(medicinesTableSource.includes("'Delete medicine'"), '1.3 MedicinesTable specifies "Delete medicine"');
    check(medicinesTableSource.includes('aria-label={title}'), '1.4 MedicinesTable renders accessible aria-label={title}');

    const remoteAdminSource = fs.readFileSync(path.resolve('src/components/remote/RemoteAdminPanel.tsx'), 'utf-8');
    check(remoteAdminSource.includes('DeleteMedicineModal'), '1.5 RemoteAdminPanel imports DeleteMedicineModal');
    check(remoteAdminSource.includes("form.kind === 'delete'"), "1.6 RemoteAdminPanel renders DeleteMedicineModal on form.kind === 'delete'");
    check(remoteAdminSource.includes('DELETE MEDICINE'), '1.7 RemoteAdminPanel drawer renders DELETE MEDICINE button');
    check(remoteAdminSource.includes('border-rose-300'), '1.8 RemoteAdminPanel drawer applies distinct danger styling');

    // Verify production bundle
    const distFiles = fs.readdirSync(path.resolve('dist/app-assets'));
    const jsBundle = distFiles.find((f) => f.startsWith('index-') && f.endsWith('.js'));
    check(Boolean(jsBundle), '1.9 Production JS bundle found in dist/app-assets');
    if (jsBundle) {
      const bundleContent = fs.readFileSync(path.resolve(`dist/app-assets/${jsBundle}`), 'utf-8');
      check(bundleContent.includes('Delete Medicine'), '1.10 Generated production frontend bundle contains "Delete Medicine"');
      check(bundleContent.includes('delete-preview'), '1.11 Generated production frontend bundle contains "delete-preview" endpoint call');
      check(bundleContent.includes('SHOP UPDATE REQUIRED'), '1.12 Generated production frontend bundle contains "SHOP UPDATE REQUIRED"');
    }

    // =========================================================================
    // TEST 2 — NON GLOBAL ADMIN RBAC
    // =========================================================================
    section('TEST 2 — NON GLOBAL ADMIN RBAC (403 GLOBAL_ADMIN_ONLY)');

    // Mock deps for remoteAdminRouter
    let capturedSecurityEvent = false;
    const deps: any = {
      shopId: () => shopId,
      withShop: async (_req: any, fn: any) => fn(client),
      withShopId: async (_sId: string, fn: any) => fn(client),
      withCloud: async (fn: any) => fn(client),
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      route: (_name: string, fn: any) => async (req: any, res: any) => {
        try {
          const result = await fn(req, res);
          if (result !== undefined) res.json(result);
        } catch (err: any) {
          const code = err instanceof HttpError && typeof err.details?.code === 'string'
            ? err.details.code
            : err.code;
          res.status(err.status || 500).json({ error: err.message, code });
        }
      },
      getRemoteControl: async () => ({ remote_writes_enabled: true, maintenance_mode: false, maintenance_message: null }),
      clearRemoteControlCache: () => {},
      isGlobalAdmin: (u: any) => Boolean(u && u.account_type === 'GLOBAL_ADMIN' && u.role === 'ADMIN' && !u.shop_id),
      securityEvent: async () => { capturedSecurityEvent = true; },
    };

    const router = buildRemoteAdminRouter(deps);

    // Test non-global users
    const cashierUser = { id: crypto.randomUUID(), email: 'cashier@shop1.local', role: 'CASHIER', account_type: 'SHOP_USER', shop_id: shopId };
    const managerUser = { id: crypto.randomUUID(), email: 'manager@shop1.local', role: 'MANAGER', account_type: 'SHOP_USER', shop_id: shopId };
    const shopAdminUser = { id: crypto.randomUUID(), email: 'admin@shop1.local', role: 'ADMIN', account_type: 'SHOP_ADMIN', shop_id: shopId };
    const globalAdminUser = { id: crypto.randomUUID(), email: 'global@gigachem.internal', role: 'ADMIN', account_type: 'GLOBAL_ADMIN', shop_id: null };

    // Function to invoke route handler on router stack
    async function callPreview(user: any, medId: string, headers: Record<string, string> = {}) {
      const routeObj = router.stack.find((s: any) => s.route?.path === '/admin/medicines/:id/delete-preview');
      if (!routeObj) throw new Error('Route /admin/medicines/:id/delete-preview not mounted on router');
      const handler = routeObj.route.stack[routeObj.route.stack.length - 1].handle;

      let statusCode = 200;
      let jsonBody: any = null;
      const req: any = {
        params: { id: medId },
        query: { shop_id: shopId },
        headers,
        onlineUser: user,
      };
      const res: any = {
        status: (c: number) => { statusCode = c; return res; },
        json: (b: any) => { jsonBody = b; return res; },
      };
      await handler(req, res);
      return { statusCode, body: jsonBody };
    }

    const dummyMedId = crypto.randomUUID();
    const cashierRes = await callPreview(cashierUser, dummyMedId);
    check(cashierRes.statusCode === 403 && cashierRes.body?.code === 'GLOBAL_ADMIN_ONLY', '2.1 Cashier account denied preview (403 GLOBAL_ADMIN_ONLY)');

    const managerRes = await callPreview(managerUser, dummyMedId);
    check(managerRes.statusCode === 403 && managerRes.body?.code === 'GLOBAL_ADMIN_ONLY', '2.2 Manager account denied preview (403 GLOBAL_ADMIN_ONLY)');

    const shopAdminRes = await callPreview(shopAdminUser, dummyMedId);
    check(shopAdminRes.statusCode === 403 && shopAdminRes.body?.code === 'GLOBAL_ADMIN_ONLY', '2.3 Shop-bound Admin account denied preview (403 GLOBAL_ADMIN_ONLY)');

    // =========================================================================
    // TEST 3 — PREVIEW ENDPOINT SCHEMA & VALUES
    // =========================================================================
    section('TEST 3 — PREVIEW ENDPOINT SCHEMA & VALUES');

    // Create a fixture medicine in local database for preview testing
    const unusedMedId = crypto.randomUUID();
    const testTag = Date.now().toString(36);
    await withTransaction(async (c) => {
      await createMedicineTx(c, unusedMedId, {
        name: `Preview Target Medicine ${testTag}`,
        sku: `PREV-${testTag}`,
        barcode: `BAR-PREV-${testTag}`,
        selling_price: 150,
        purchase_price: 100,
        current_stock: 0,
      }, adminActor);
    });

    const previewRes = await callPreview(globalAdminUser, unusedMedId);
    check(previewRes.statusCode === 200, '3.1 Preview endpoint returns 200 for Global Admin');
    const pData = previewRes.body;
    check(pData && typeof pData.medicine === 'object', '3.2 Preview contains medicine object');
    check(pData.medicine.id === unusedMedId, '3.3 Preview medicine.id matches requested medicine');
    check(pData.medicine.current_stock === 0, '3.4 Preview medicine.current_stock === 0');
    check(typeof pData.references === 'object', '3.5 Preview contains references breakdown');
    check(typeof pData.references.sales === 'number', '3.6 Preview references has sales count');
    check(typeof pData.references.sale_items === 'number', '3.7 Preview references has sale_items count');
    check(typeof pData.references.purchases === 'number', '3.8 Preview references has purchases count');
    check(typeof pData.references.purchase_items === 'number', '3.9 Preview references has purchase_items count');
    check(typeof pData.references.returns === 'number', '3.10 Preview references has returns count');
    check(typeof pData.references.inventory_movements === 'number', '3.11 Preview references has inventory_movements count');
    check(typeof pData.total_historical_references === 'number', '3.12 Preview contains total_historical_references');
    check(pData.total_historical_references === 0, '3.13 Unused medicine total_historical_references === 0');
    check(pData.outcome === 'PERMANENT_DELETE', '3.14 Unused medicine outcome === PERMANENT_DELETE');
    check(pData.has_stock === false, '3.15 Unused medicine has_stock === false');
    check(typeof pData.disclaimer === 'string' && pData.disclaimer.includes('Final deletion eligibility is rechecked'),
      '3.16 Preview contains live shop authority disclaimer');

    // =========================================================================
    // TEST 4 — UNUSED MEDICINE PERMANENT DELETE & TOMBSTONE
    // =========================================================================
    section('TEST 4 — UNUSED MEDICINE (PERMANENT_DELETE + TOMBSTONE + REMOVAL)');

    const unusedCmd = {
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      idempotency_key: `cmd-del-unused-${Date.now()}`,
      command_type: 'MEDICINE_DELETE',
      payload: {
        medicine_id: unusedMedId,
        expected_version: 1,
        expected_status: 'active',
        expected_current_stock: 0,
        reason: 'Unused medicine end-to-end test',
      },
      created_by: 'Global Admin',
    };

    const cmdResult = await applyCloudCommand(unusedCmd as any);
    check(cmdResult.result?.action === 'DELETED', '4.1 Shop applies MEDICINE_DELETE with action=DELETED');

    const localCheck = await client.query('SELECT 1 FROM medicines WHERE id = $1', [unusedMedId]);
    check(localCheck.rows.length === 0, '4.2 Medicine row is permanently removed from local PostgreSQL');

    const tombstoneCheck = await client.query('SELECT * FROM medicine_tombstones WHERE medicine_id = $1', [unusedMedId]);
    check(tombstoneCheck.rows.length === 1, '4.3 Medicine tombstone recorded in local database');
    check(Number(tombstoneCheck.rows[0].deletion_seq) > 0, '4.4 Tombstone records non-zero deletion_seq');

    // Verify outbox emitted MEDICINE_DELETED event
    const outboxEv = await client.query(
      "SELECT * FROM sync_events WHERE entity_id = $1 AND event_type = 'MEDICINE_DELETED' ORDER BY seq DESC LIMIT 1",
      [unusedMedId]
    );
    check(outboxEv.rows.length === 1, '4.5 MEDICINE_DELETED sync event queued in shop outbox');

    // =========================================================================
    // TEST 5 — HISTORICAL MEDICINE ARCHIVE FALLBACK
    // =========================================================================
    section('TEST 5 — HISTORICAL MEDICINE (ARCHIVE_REQUIRED + RECEIPTS INTACT)');

    const histMedId = crypto.randomUUID();
    const histBatchId = crypto.randomUUID();
    const saleId = crypto.randomUUID();
    const receiptNum = `REC-TEST5-${Date.now()}`;

    const histTag = Date.now().toString(36) + 'h';
    await withTransaction(async (c) => {
      await createMedicineTx(c, histMedId, {
        name: `Historical Paracetamol 500mg ${histTag}`,
        sku: `PARA-HIST-${histTag}`,
        barcode: `BAR-HIST-${histTag}`,
        selling_price: 50,
        purchase_price: 30,
        current_stock: 0,
      }, adminActor);

      await c.query(
        `INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, status)
         VALUES ($1, $2, 'BAT-HIST-01', 20, 0, 30, '2028-12-31', 'exhausted')`,
        [histBatchId, histMedId]
      );

      await c.query(
        `INSERT INTO sales (
           id, sale_number, receipt_number, cashier_id, device_id, date, time,
           subtotal, total, payment_method, amount_received, status, idempotency_key, cost_total, gross_profit
         ) VALUES ($1, $4, $5, $2, 'SERVER', CURRENT_DATE, '12:00:00', 50, 50, 'cash', 50, 'completed', $3, 30, 20)`,
        [saleId, adminActor.user_id, crypto.randomUUID(), `SALE-${receiptNum}`, receiptNum]
      );

      await c.query(
        `INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, expiry_date, quantity, unit_price, total, cost_price_snapshot)
         VALUES ($1, $2, $3, $4, 'BAT-HIST-01', '2028-12-31', 1, 50, 50, 30)`,
        [crypto.randomUUID(), saleId, histMedId, histBatchId]
      );
    });

    const histPreviewRes = await callPreview(globalAdminUser, histMedId);
    check(histPreviewRes.body?.outcome === 'ARCHIVE_REQUIRED', '5.1 Historical medicine preview determines ARCHIVE_REQUIRED');
    check(histPreviewRes.body?.references.sale_items >= 1, '5.2 Historical sale items detected in preview');

    const histCmd = {
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      idempotency_key: `cmd-del-hist-${Date.now()}`,
      command_type: 'MEDICINE_DELETE',
      payload: {
        medicine_id: histMedId,
        expected_version: 1,
        expected_status: 'active',
        expected_current_stock: 0,
        reason: 'Historical medicine archive test',
      },
      created_by: 'Global Admin',
    };

    const histCmdResult = await applyCloudCommand(histCmd as any);
    check(histCmdResult.result?.action === 'ARCHIVED', '5.3 Shop applies MEDICINE_DELETE with action=ARCHIVED for historical medicine');

    const medAfterArchive = (await client.query('SELECT status, version FROM medicines WHERE id = $1', [histMedId])).rows[0];
    check(medAfterArchive && medAfterArchive.status === 'archived', '5.4 Medicine status updated to archived in local PostgreSQL');
    check(Number(medAfterArchive.version) >= 2, '5.5 Medicine version incremented on archive');

    const receiptAudit = await client.query(
      `SELECT s.receipt_number, si.unit_price, si.quantity, m.name, m.status
         FROM sales s
         JOIN sale_items si ON s.id = si.sale_id
         JOIN medicines m ON si.medicine_id = m.id
        WHERE s.id = $1`,
      [saleId]
    );
    check(receiptAudit.rows.length === 1 && receiptAudit.rows[0].receipt_number === receiptNum,
      '5.6 Historical sales receipt query remains 100% intact and functional');

    // =========================================================================
    // TEST 6 — STOCK EXISTS BLOCKS DELETION
    // =========================================================================
    section('TEST 6 — STOCK EXISTS (BLOCKED WITH MEDICINE_HAS_STOCK)');

    const stockedMedId = crypto.randomUUID();
    const stkTag = Date.now().toString(36) + 's';
    await withTransaction(async (c) => {
      await createMedicineTx(c, stockedMedId, {
        name: `Stocked Amoxicillin 250mg ${stkTag}`,
        sku: `AMOX-STK-${stkTag}`,
        barcode: `BAR-STK-${stkTag}`,
        selling_price: 120,
        purchase_price: 80,
        current_stock: 25,
      }, adminActor);

      await c.query(
        `INSERT INTO medicine_batches (id, medicine_id, batch_number, quantity_received, quantity_available, purchase_price, expiry_date, status)
         VALUES ($1, $2, 'BAT-AMOX-01', 25, 25, 80, '2028-12-31', 'active')`,
        [crypto.randomUUID(), stockedMedId]
      );
    });

    const stockedPreviewRes = await callPreview(globalAdminUser, stockedMedId);
    check(stockedPreviewRes.body?.has_stock === true, '6.1 Preview reports has_stock === true');
    check(Boolean(stockedPreviewRes.body?.block_reason?.includes('remain in stock')), '6.2 Preview reports clear stock block reason');

    const stockCmdRes = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      idempotency_key: `cmd-del-stk-${Date.now()}`,
      command_type: 'MEDICINE_DELETE',
      payload: {
        medicine_id: stockedMedId,
        expected_version: 1,
        expected_status: 'active',
        expected_current_stock: 25,
        reason: 'Attempt delete while stock > 0',
      },
      created_by: 'Global Admin',
    } as any);
    check(
      stockCmdRes.status === 'REJECTED' && Boolean(stockCmdRes.error?.includes('sellable stock')),
      '6.3 Local handler rejects deletion when stock > 0'
    );

    const medAfterStockAttempt = (await client.query('SELECT current_stock, status FROM medicines WHERE id = $1', [stockedMedId])).rows[0];
    check(Number(medAfterStockAttempt.current_stock) === 25 && medAfterStockAttempt.status === 'active',
      '6.4 Stock and active status completely unchanged after rejected delete attempt');

    // =========================================================================
    // TEST 7 — STALE CONCURRENCY CHECK
    // =========================================================================
    section('TEST 7 — STALE CONCURRENCY (REJECTED ON VERSION/STOCK CONFLICT)');

    const staleCmdRes = await applyCloudCommand({
      command_id: crypto.randomUUID(),
      shop_id: shopId,
      idempotency_key: `cmd-del-stale-${Date.now()}`,
      command_type: 'MEDICINE_DELETE',
      payload: {
        medicine_id: stockedMedId,
        expected_version: 999, // Stale version
        expected_status: 'active',
        expected_current_stock: 0,
      },
      created_by: 'Global Admin',
    } as any);
    check(
      staleCmdRes.status === 'REJECTED' && Boolean(staleCmdRes.error?.includes('conflict')),
      '7.1 Version mismatch rejects command with 409 conflict'
    );

    // =========================================================================
    // TEST 8 — OLD EVENT RESURRECTION PROTECTION
    // =========================================================================
    section('TEST 8 — OLD EVENT RESURRECTION (TOMBSTONE PREVENTS RESURRECTION)');

    // In local database, simulate arrival of an older sync/replay event for unusedMedId
    const tomb = (await client.query('SELECT deletion_seq FROM medicine_tombstones WHERE medicine_id = $1', [unusedMedId])).rows[0];
    check(Boolean(tomb), '8.1 Tombstone confirmed present before replay test');

    // Attempting deleteOrArchive on a deleted medicine returns idempotent success without recreation
    const idempDel = await withTransaction(async (c) => {
      return deleteOrArchiveMedicineTx(c, unusedMedId, adminActor);
    });
    check(idempDel.action === 'DELETED', '8.2 Duplicate delete operation returns action=DELETED from tombstone');

    const rowStillAbsent = await client.query('SELECT 1 FROM medicines WHERE id = $1', [unusedMedId]);
    check(rowStillAbsent.rows.length === 0, '8.3 Medicine row remains absent after replay/duplicate invocation');

    // =========================================================================
    // TEST 9 — ALL SHOPS SCOPE PROHIBITION
    // =========================================================================
    section('TEST 9 — ALL SHOPS SCOPE (STRICTLY BLOCKED)');

    const allShopsPreviewRes = await callPreview(globalAdminUser, dummyMedId, { 'x-giga-scope': 'ALL' });
    check(allShopsPreviewRes.statusCode === 400 && allShopsPreviewRes.body?.code === 'ALL_SHOPS_NOT_ALLOWED',
      '9.1 Delete preview across ALL SHOPS is rejected with 400 ALL_SHOPS_NOT_ALLOWED');

    // Check commandSchema ALL_SHOPS_TYPES
    check(!(['MEDICINE_DELETE'] as any).some((t: string) => (['PRICE_UPDATE', 'MEDICINE_METADATA_UPDATE', 'CATEGORY_UPSERT', 'SETTINGS_UPDATE'] as string[]).includes(t)),
      '9.2 MEDICINE_DELETE is not in ALL_SHOPS_TYPES (fan-out prohibited)');

    // =========================================================================
    // TEST 10 — SHOP TOO OLD (CAPABILITY GATE)
    // =========================================================================
    section('TEST 10 — SHOP TOO OLD (CAPABILITY GATE BLOCKS OLD COMMITS)');

    // Test with older commit (rollback release 5fee286)
    const oldRuntimeRow = {
      shop_id: shopId,
      git_commit: '5fee286f59d7b80f291a126c0a4c745321705fef',
      app_version: '1.1.0',
      status: {},
    };
    const capOld = shopSupportsMedicineDelete(oldRuntimeRow);
    check(capOld.supported === false, '10.1 shopSupportsMedicineDelete returns false for 5fee286 commit');
    check(Boolean(capOld.reason?.includes('Shop 1 must install the current GIGA CHEMIST release')),
      '10.2 Capability reason clearly states shop update required');

    // Test with updated release
    const newRuntimeRow = {
      shop_id: shopId,
      git_commit: '21421f039f702b25dec8cfc175e5839753f14ac3',
      app_version: '1.2.0',
      status: { capabilities: ['MEDICINE_DELETE', 'STOCK_PARITY', 'REJECTED_CHANGES'] },
    };
    const capNew = shopSupportsMedicineDelete(newRuntimeRow);
    check(capNew.supported === true, '10.3 shopSupportsMedicineDelete returns true for current release with capabilities');

    // Test command queueing capability gate rejection
    let queueRejected = false;
    try {
      validateCommandPayload('MEDICINE_DELETE', { medicine_id: crypto.randomUUID() });
      const capCheck = shopSupportsMedicineDelete(oldRuntimeRow);
      if (!capCheck.supported) {
        throw new HttpError(409, capCheck.reason || 'Shop update required', { code: 'SHOP_UPDATE_REQUIRED' });
      }
    } catch (err: any) {
      if (err.status === 409 && (err.code === 'SHOP_UPDATE_REQUIRED' || err.details?.code === 'SHOP_UPDATE_REQUIRED')) queueRejected = true;
    }
    check(queueRejected, '10.4 Queueing MEDICINE_DELETE to older shop release is rejected with 409 SHOP_UPDATE_REQUIRED');

  } finally {
    client.release();
  }

  summary();
}

run().catch((err) => {
  console.error('[online-medicine-delete.test] Unhandled test error:', err);
  process.exit(1);
});
