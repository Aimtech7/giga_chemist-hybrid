import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import pg from 'pg';
import { spawn } from 'child_process';
import { check, section, summary, pool, assertDevDatabase } from './harness';
import { safeRetryFailedEvents } from '../../server/sync/retry';
import { resetSyncConfig } from '../../server/sync/config';
import { syncWorker } from '../../server/sync/worker';
import { prepareCloudDatabase } from '../cloud-emulator';
import { getDatabaseConnectionConfig } from '../../server/db/client';

/**
 * SYNC PROTOCOL & CLOUD COMPATIBILITY REGRESSION TEST (npm run test:compatibility)
 *
 * Verifies that:
 * 1. LOCAL_EVENT_TYPES === CLOUD_SUPPORTED_EVENT_TYPES
 * 2. Every event type produced by outbox.ts has an explicit handler in cloud's apply_event_core.
 * 3. Release metadata includes sync_protocol_version and required_cloud_schema_version.
 * 4. Cloud migration 013 exposes required compatibility and retry RPCs.
 * 5. RPC PARAMETER CONTRACT: gc_check_event_statuses uses EXACTLY p_shop_id, p_token, p_keys (fails on p_idempotency_keys).
 * 6. SAFE FAILED EVENT RETRY:
 *    - CASE 1: cloud = PROCESSED, local = FAILED -> local => SYNCED, retransmissions = 0
 *    - CASE 2: cloud = NOT_FOUND, local = FAILED -> local => PENDING, worker wake = YES, keys/seq preserved
 *    - CASE 3: cloud precheck unavailable -> local remains FAILED, bulk retry fails safely (SAFE_RETRY_PRECHECK_FAILED)
 *    - CASE 4: event already applied but ack lost -> duplicate suppressed, exactly 1 sale, 1 payment, 1 stock effect
 * 7. UPDATER COMPATIBILITY GATE:
 *    - Shop 1 environment: .env with SYNC_SHOP_TOKEN (no SHOP_TOKEN, no .env.online) runs compatibility check
 *    - Cloud unreachable -> REFUSED (CLOUD_COMPATIBILITY_UNREACHABLE)
 *    - Emergency bypass -> UPDATER_SKIP_COMPATIBILITY_CHECK=true succeeds
 *    - Cloud schema too old -> CLOUD_SCHEMA_TOO_OLD refused
 *    - App protocol too new -> refused
 *    - Compatible cloud -> proceeds
 */

const ROOT = path.resolve('.');
const UPDATER_MJS = path.join(ROOT, 'scripts', 'updater', 'updater.mjs');

function cloudDbConfig() {
  const base: any = { ...getDatabaseConnectionConfig() };
  if (base.connectionString) {
    const u = new URL(base.connectionString);
    u.pathname = '/giga_chemist_cloud_test';
    base.connectionString = u.toString();
  } else {
    base.database = 'giga_chemist_cloud_test';
  }
  delete base.max;
  return base;
}

async function run() {
  await assertDevDatabase();

  section('1. EVENT TYPE PARITY (Local Outbox vs Cloud apply_event_core)');

  const outboxContent = fs.readFileSync('server/sync/outbox.ts', 'utf-8');
  const typeMatch = outboxContent.match(/export type SyncEventType =\s*([\s\S]*?);/);
  check(Boolean(typeMatch), 'SyncEventType found in server/sync/outbox.ts');

  const localTypes = typeMatch![1]
    .split('|')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim().replace(/['",]/g, ''))
    .filter((s) => s.length > 0 && /^[A-Z0-9_]+$/.test(s));

  check(localTypes.length >= 30, `Found ${localTypes.length} local event types in outbox.ts`);

  const migration013 = fs.readFileSync('cloud/supabase/migrations/013_fix_apply_event_core_and_protocol_compatibility.sql', 'utf-8');
  const applyEventCoreMatch = migration013.match(/FUNCTION giga_cloud\.apply_event_core[\s\S]*?CASE v_type([\s\S]*?)END CASE;/);
  check(Boolean(applyEventCoreMatch), 'apply_event_core CASE statement found in migration 013');

  const caseBody = applyEventCoreMatch![1];
  const cloudTypes = new Set<string>();
  const whenRegex = /WHEN\s+([\s\S]*?)\s+THEN/g;
  let match: RegExpExecArray | null;
  while ((match = whenRegex.exec(caseBody)) !== null) {
    const list = match[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    for (const t of list) {
      if (t) cloudTypes.add(t);
    }
  }

  for (const lt of localTypes) {
    const isHandled = cloudTypes.has(lt);
    check(isHandled, `Event type "${lt}" is explicitly supported in cloud apply_event_core`);
  }

  section('2. CLOUD PROTOCOL VERSIONING & COMPATIBILITY CONTRACT');

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  check(typeof pkg.sync_protocol_version === 'number', 'package.json defines sync_protocol_version');
  check(typeof pkg.required_cloud_schema_version === 'number', 'package.json defines required_cloud_schema_version');
  check(pkg.required_cloud_schema_version >= 13, 'required_cloud_schema_version is >= 13');

  check(migration013.includes('gc_check_compatibility'), 'migration 013 exposes gc_check_compatibility');
  check(migration013.includes('gc_check_event_statuses'), 'migration 013 exposes gc_check_event_statuses');
  check(migration013.includes('gc_ping'), 'migration 013 exposes gc_ping with protocol version metadata');

  section('3. SAFE FAILED EVENT RETRY & SANITIZATION (CODE CONTRACT)');

  const retryCode = fs.readFileSync('server/sync/retry.ts', 'utf-8');
  check(retryCode.includes('gc_check_event_statuses'), 'safeRetryFailedEvents verifies statuses with cloud before retry');
  check(retryCode.includes('p_keys: keys') || retryCode.includes('p_keys'), 'safeRetryFailedEvents passes p_keys to gc_check_event_statuses');
  check(!retryCode.includes('p_idempotency_keys'), 'safeRetryFailedEvents does NOT pass p_idempotency_keys');
  check(retryCode.includes('SAFE_RETRY_PRECHECK_FAILED'), 'safeRetryFailedEvents fails closed with SAFE_RETRY_PRECHECK_FAILED');
  check(retryCode.includes('sanitizeText'), 'getFailedEventsDiagnostics sanitizes all error messages');
  check(!retryCode.includes('password_hash'), 'retry diagnostics never expose password_hash');
  check(!retryCode.includes('pin_hash'), 'retry diagnostics never expose pin_hash');

  section('4. BUILD DEPENDENCIES & UPDATER INTEGRATION');

  check('esbuild' in (pkg.dependencies || {}), 'esbuild is in dependencies (not only devDependencies)');
  check('tsx' in (pkg.dependencies || {}), 'tsx is in dependencies');

  const updaterCode = fs.readFileSync('scripts/updater/updater.mjs', 'utf-8');
  check(updaterCode.includes('--include=dev'), 'updater buildActivate runs npm ci with --include=dev');
  check(updaterCode.includes('checkCloudCompatibility'), 'updater checks cloud compatibility during preflight');
  check(updaterCode.includes('SYNC_SHOP_TOKEN'), 'updater uses SYNC_SHOP_TOKEN as canonical token');
  check(updaterCode.includes('CLOUD_COMPATIBILITY_CONFIG_MISSING'), 'updater refuses missing cloud configuration');
  check(updaterCode.includes('CLOUD_COMPATIBILITY_UNREACHABLE'), 'updater refuses unreachable cloud compatibility endpoint');

  // ---------------------------------------------------------------------------
  // Mock Server Setup for Behavioral Tests (Sections 5, 6, 7)
  // ---------------------------------------------------------------------------
  let mockRpcHandler: ((fn: string, body: any, res: http.ServerResponse) => void) | null = null;
  let lastRpcCall: { fn: string; body: any; headers: any } | null = null;

  const mockServer = http.createServer((req, res) => {
    const url = req.url || '';
    const match = url.match(/\/rest\/v1\/rpc\/([a-zA-Z0-9_]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const fn = match[1];
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      lastRpcCall = { fn, body, headers: req.headers };
      if (mockRpcHandler) {
        mockRpcHandler(fn, body, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([]));
      }
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const mockPort = (mockServer.address() as any).port;
  const mockUrl = `http://127.0.0.1:${mockPort}`;

  // Read shop identity from dev db
  const shopIdRow = (await pool.query('SELECT shop_id FROM shop_identity WHERE id = 1')).rows[0];
  const testShopId = shopIdRow ? shopIdRow.shop_id : '06e25fd6-6cbb-45a6-b90c-be7b1f1f051c';

  const origEnv = { ...process.env };
  const trackedEventIds: string[] = [];

  try {
    // Set environment to talk to mock cloud
    process.env.APP_MODE = 'hybrid';
    process.env.SUPABASE_URL = mockUrl;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key-contract';
    process.env.SYNC_SHOP_TOKEN = 'test-token-at-least-32-characters-long-mock';
    resetSyncConfig();

    section('5. RPC PARAMETER CONTRACT (BEHAVIORAL)');

    const contractEventId = crypto.randomUUID();
    const contractKey = `contract-test-${contractEventId}`;
    trackedEventIds.push(contractEventId);

    await pool.query(`
      INSERT INTO sync_events (
        id, idempotency_key, device_id, operation, entity_type, entity_id,
        payload, status, shop_id, event_type, attempt_count, next_attempt_at, last_error
      ) VALUES (
        $1, $2, 'TEST-DEVICE', 'CREATE', 'medicine', $3,
        '{}'::jsonb, 'FAILED', $4, 'MEDICINE_CREATED', 1, CURRENT_TIMESTAMP, 'contract test failure'
      )
    `, [contractEventId, contractKey, contractEventId, testShopId]);

    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_event_statuses') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ idempotency_key: contractKey, status: 'NOT_FOUND' }]));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([]));
      }
    };

    lastRpcCall = null;
    await safeRetryFailedEvents([contractEventId]);

    check(lastRpcCall?.fn === 'gc_check_event_statuses', 'client called gc_check_event_statuses RPC endpoint');
    check(Array.isArray(lastRpcCall?.body?.p_keys), 'client passed p_keys as an array');
    check(lastRpcCall?.body?.p_keys?.[0] === contractKey, 'client passed the expected idempotency key in p_keys');
    check(!('p_idempotency_keys' in (lastRpcCall?.body || {})), 'client did NOT send p_idempotency_keys argument');
    check(typeof lastRpcCall?.body?.p_shop_id === 'string', 'client passed p_shop_id string');
    check(typeof lastRpcCall?.body?.p_token === 'string', 'client passed p_token string');

    const argNames = Object.keys(lastRpcCall?.body || {}).sort();
    check(
      argNames.length === 3 && argNames[0] === 'p_keys' && argNames[1] === 'p_shop_id' && argNames[2] === 'p_token',
      'client passed EXACTLY p_shop_id, p_token, p_keys with no unsupported arguments'
    );

    section('6. SAFE FAILED-EVENT RECOVERY (BEHAVIORAL)');

    // Spy on syncWorker.wake
    let wakeCount = 0;
    const origWake = syncWorker.wake.bind(syncWorker);
    syncWorker.wake = () => {
      wakeCount++;
      return 'scheduled';
    };

    // CASE 1: cloud = PROCESSED, local = FAILED -> local => SYNCED, retransmissions = 0
    const case1EventId = crypto.randomUUID();
    const case1Key = `case1-key-${case1EventId}`;
    trackedEventIds.push(case1EventId);

    await pool.query(`
      INSERT INTO sync_events (
        id, idempotency_key, device_id, operation, entity_type, entity_id,
        payload, status, shop_id, event_type, attempt_count, next_attempt_at, last_error
      ) VALUES (
        $1, $2, 'TEST-DEVICE', 'CREATE', 'medicine', $3,
        '{}'::jsonb, 'FAILED', $4, 'MEDICINE_CREATED', 1, CURRENT_TIMESTAMP, 'test failure 1'
      )
    `, [case1EventId, case1Key, case1EventId, testShopId]);

    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_event_statuses') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ idempotency_key: case1Key, status: 'PROCESSED' }]));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([]));
      }
    };

    wakeCount = 0;
    const res1 = await safeRetryFailedEvents([case1EventId]);
    check(res1.already_applied_by_cloud === 1, 'CASE 1: cloud reports PROCESSED -> already_applied_by_cloud = 1');
    check(res1.requeued_for_retry === 0, 'CASE 1: cloud reports PROCESSED -> requeued_for_retry = 0');

    const dbRow1 = (await pool.query('SELECT status FROM sync_events WHERE id = $1', [case1EventId])).rows[0];
    check(dbRow1.status === 'SYNCED', 'CASE 1: local event status transitioned to SYNCED');
    check(wakeCount === 0, 'CASE 1: worker wake NOT triggered (network retransmission count = 0)');

    // CASE 2: cloud = NOT_FOUND, local = FAILED -> local => PENDING, worker wake = YES
    const case2EventId = crypto.randomUUID();
    const case2Key = `case2-key-${case2EventId}`;
    trackedEventIds.push(case2EventId);

    await pool.query(`
      INSERT INTO sync_events (
        id, idempotency_key, device_id, operation, entity_type, entity_id,
        payload, status, shop_id, event_type, attempt_count, next_attempt_at, last_error
      ) VALUES (
        $1, $2, 'TEST-DEVICE', 'CREATE', 'medicine', $3,
        '{}'::jsonb, 'FAILED', $4, 'MEDICINE_CREATED', 2, CURRENT_TIMESTAMP, 'test failure 2'
      )
    `, [case2EventId, case2Key, case2EventId, testShopId]);

    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_event_statuses') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ idempotency_key: case2Key, status: 'NOT_FOUND' }]));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([]));
      }
    };

    wakeCount = 0;
    const res2 = await safeRetryFailedEvents([case2EventId]);
    check(res2.requeued_for_retry === 1, 'CASE 2: cloud reports NOT_FOUND -> requeued_for_retry = 1');
    check(res2.already_applied_by_cloud === 0, 'CASE 2: cloud reports NOT_FOUND -> already_applied_by_cloud = 0');

    const dbRow2 = (await pool.query('SELECT id, status, idempotency_key, entity_id, seq FROM sync_events WHERE id = $1', [case2EventId])).rows[0];
    check(dbRow2.status === 'PENDING', 'CASE 2: local event status transitioned to PENDING');
    check(dbRow2.idempotency_key === case2Key, 'CASE 2: preserved idempotency_key');
    check(dbRow2.entity_id === case2EventId, 'CASE 2: preserved entity_id');
    check(Number(dbRow2.seq) > 0, 'CASE 2: preserved local sequence');
    check(wakeCount === 1, 'CASE 2: sync worker wake triggered');

    // CASE 3: cloud pre-check unavailable -> fails closed, local remains FAILED, no retransmission
    const case3EventId = crypto.randomUUID();
    const case3Key = `case3-key-${case3EventId}`;
    trackedEventIds.push(case3EventId);

    await pool.query(`
      INSERT INTO sync_events (
        id, idempotency_key, device_id, operation, entity_type, entity_id,
        payload, status, shop_id, event_type, attempt_count, next_attempt_at, last_error
      ) VALUES (
        $1, $2, 'TEST-DEVICE', 'CREATE', 'medicine', $3,
        '{}'::jsonb, 'FAILED', $4, 'MEDICINE_CREATED', 1, CURRENT_TIMESTAMP, 'test failure 3'
      )
    `, [case3EventId, case3Key, case3EventId, testShopId]);

    mockRpcHandler = (fn, body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'cloud internal error' }));
    };

    wakeCount = 0;
    let errCase3: any = null;
    try {
      await safeRetryFailedEvents([case3EventId]);
    } catch (e) {
      errCase3 = e;
    }

    check(Boolean(errCase3), 'CASE 3: safeRetryFailedEvents threw on cloud precheck failure');
    check(
      errCase3?.message?.includes('SAFE_RETRY_PRECHECK_FAILED') || errCase3?.code === 'SAFE_RETRY_PRECHECK_FAILED',
      'CASE 3: error explicitly states SAFE_RETRY_PRECHECK_FAILED'
    );

    const dbRow3 = (await pool.query('SELECT status FROM sync_events WHERE id = $1', [case3EventId])).rows[0];
    check(dbRow3.status === 'FAILED', 'CASE 3: local event remains FAILED (untouched)');
    check(wakeCount === 0, 'CASE 3: worker not woken (no unsafe retransmission)');

    // Restore wake
    syncWorker.wake = origWake;

    // CASE 4: event already applied but HTTP ack previously lost (idempotency contract)
    // Connect to test cloud database giga_chemist_cloud_test
    await prepareCloudDatabase('giga_chemist_cloud_test', true);
    const cloudClient = new pg.Client(cloudDbConfig());
    await cloudClient.connect();
    try {
      // Ensure test shop exists in cloud database
      await cloudClient.query(`
        INSERT INTO giga_cloud.shops (shop_id, shop_code, name, active, token_hash)
        VALUES ($1, 'TEST', 'Test Shop', true, giga_cloud.token_hash('test-token-at-least-32-characters-long-mock'))
        ON CONFLICT (shop_id) DO UPDATE SET
          active = true,
          token_hash = giga_cloud.token_hash('test-token-at-least-32-characters-long-mock')
      `, [testShopId]);

      const case4SaleId = crypto.randomUUID();
      const case4MovementId = crypto.randomUUID();
      const case4PaymentId = crypto.randomUUID();
      const case4ReceiptNo = `REC-TEST-${Date.now()}`;
      const case4Key = `case4-sale-${crypto.randomUUID()}`;

      const saleEventPayload = {
        event_id: crypto.randomUUID(),
        shop_id: testShopId,
        idempotency_key: case4Key,
        event_type: 'SALE_COMPLETED',
        entity_type: 'sale',
        entity_id: case4SaleId,
        local_seq: 100,
        occurred_at: new Date().toISOString(),
        payload: {
          data: {
            sale: {
              id: case4SaleId,
              sale_number: 'SALE-TEST-1',
              receipt_number: case4ReceiptNo,
              total: 1500,
              subtotal: 1500,
              payment_method: 'CASH',
              status: 'COMPLETED',
            },
            items: [
              {
                id: crypto.randomUUID(),
                sale_id: case4SaleId,
                medicine_id: crypto.randomUUID(),
                quantity: 2,
                unit_price: 750,
                total: 1500,
              },
            ],
            payments: [
              {
                id: case4PaymentId,
                sale_id: case4SaleId,
                method: 'CASH',
                amount: 1500,
              },
            ],
          },
          movements: [
            {
              id: case4MovementId,
              medicine_id: crypto.randomUUID(),
              batch_id: crypto.randomUUID(),
              movement_type: 'SALE',
              delta: -2,
              reference_id: case4SaleId,
            },
          ],
        },
      };

      // 1. First application -> PROCESSED
      const apply1 = await cloudClient.query(
        'SELECT public.gc_ingest_events($1::uuid, $2::text, $3::jsonb) AS res',
        [testShopId, 'test-token-at-least-32-characters-long-mock', JSON.stringify([saleEventPayload])]
      );
      const apply1Result = apply1.rows[0].res?.results?.[0];
      check(apply1Result?.status === 'APPLIED' || apply1Result?.status === 'PROCESSED', 'CASE 4: first cloud application returned APPLIED');

      // 2. Pre-check queries cloud processed_events -> reports PROCESSED
      const checkStatus = await cloudClient.query(
        'SELECT public.gc_check_event_statuses($1::uuid, $2::text, $3::text[]) AS res',
        [testShopId, 'test-token-at-least-32-characters-long-mock', [case4Key]]
      );
      const reported = checkStatus.rows[0].res?.[0];
      check(reported?.status === 'PROCESSED', 'CASE 4: cloud precheck confirms status = PROCESSED');

      // 3. Retrying apply_event with same idempotency key (simulating network retransmission)
      const apply2 = await cloudClient.query(
        'SELECT public.gc_ingest_events($1::uuid, $2::text, $3::jsonb) AS res',
        [testShopId, 'test-token-at-least-32-characters-long-mock', JSON.stringify([saleEventPayload])]
      );
      const apply2Result = apply2.rows[0].res?.results?.[0];
      check(apply2Result?.status === 'DUPLICATE', 'CASE 4: retry returns DUPLICATE status');

      // 4. Verify no duplicates in cloud tables
      const salesCount = (await cloudClient.query('SELECT count(*)::int AS n FROM giga_cloud.sales WHERE receipt_number = $1', [case4ReceiptNo])).rows[0].n;
      check(salesCount === 1, 'CASE 4: duplicate sale created MUST BE 0 (exact count: 1)');

      const paymentsCount = (await cloudClient.query('SELECT count(*)::int AS n FROM giga_cloud.payments WHERE sale_id = $1', [case4SaleId])).rows[0].n;
      check(paymentsCount === 1, 'CASE 4: duplicate payment created MUST BE 0 (exact count: 1)');

      const movementsCount = (await cloudClient.query('SELECT count(*)::int AS n FROM giga_cloud.inventory_movements WHERE reference_id = $1', [case4SaleId])).rows[0].n;
      check(movementsCount === 1, 'CASE 4: duplicate stock effect MUST BE 0 (exact count: 1)');
    } finally {
      await cloudClient.end();
    }

    section('7. UPDATER CLOUD COMPATIBILITY GATE (BEHAVIORAL)');

    // Helper to run updater compatibility-check subcommand asynchronously
    const runUpdaterCompat = (envOverrides: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; parsed: any }> => {
      return new Promise((resolve) => {
        const p = spawn(process.execPath, [UPDATER_MJS, 'compatibility-check'], {
          cwd: ROOT,
          env: {
            ...process.env,
            ...envOverrides,
          },
        });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
          let parsed: any = null;
          try {
            const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
            if (line) parsed = JSON.parse(line);
          } catch {
            /* ignore */
          }
          resolve({ code, out, err, parsed });
        });
      });
    };

    // Subtest 1: Actual Shop 1-like environment (APP_MODE=hybrid, SYNC_SHOP_TOKEN, no SHOP_TOKEN, no .env.online)
    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_compatibility') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ compatible: true, protocol_version: body.p_protocol_version, cloud_schema_version: 13 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({}));
      }
    };

    const shop1Env = {
      APP_MODE: 'hybrid',
      SYNC_ENABLED: 'true',
      SHOP_ID: testShopId,
      SUPABASE_URL: mockUrl,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SYNC_SHOP_TOKEN: 'test-canonical-token-at-least-32-chars',
      SHOP_TOKEN: '', // explicitly ensure no legacy SHOP_TOKEN is needed
    };

    const rShop1 = await runUpdaterCompat(shop1Env);
    check(rShop1.code === 0 && rShop1.parsed?.ok === true, 'Shop 1 environment with SYNC_SHOP_TOKEN passes compatibility check');
    check(lastRpcCall?.fn === 'gc_check_compatibility', 'compatibility check RPC was actually executed');
    check(lastRpcCall?.body?.p_token === 'test-canonical-token-at-least-32-chars', 'canonical SYNC_SHOP_TOKEN was sent to cloud RPC');

    // Subtest 2: Missing config fields -> CLOUD_COMPATIBILITY_CONFIG_MISSING (never exposes values)
    const rMissing = await runUpdaterCompat({
      APP_MODE: 'hybrid',
      SUPABASE_URL: '',
      SYNC_SHOP_TOKEN: '',
      SHOP_TOKEN: '',
    });
    check(rMissing.code !== 0, 'missing cloud config exits non-zero');
    check(rMissing.parsed?.error === 'CLOUD_COMPATIBILITY_CONFIG_MISSING', 'returns CLOUD_COMPATIBILITY_CONFIG_MISSING');
    check(rMissing.parsed?.detail?.includes('SUPABASE_URL'), 'safe error detail lists missing field names');
    check(!/test-token|secret|password|jwt/i.test(rMissing.parsed?.detail || ''), 'no secrets exposed in missing config detail');

    // Subtest 3: Cloud unreachable -> CLOUD_COMPATIBILITY_UNREACHABLE
    const rUnreachable = await runUpdaterCompat({
      APP_MODE: 'hybrid',
      SHOP_ID: testShopId,
      SUPABASE_URL: 'http://127.0.0.1:59998',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SYNC_SHOP_TOKEN: 'test-canonical-token-at-least-32-chars',
    });
    check(rUnreachable.code !== 0, 'unreachable cloud exits non-zero');
    check(rUnreachable.parsed?.error === 'CLOUD_COMPATIBILITY_UNREACHABLE', 'returns CLOUD_COMPATIBILITY_UNREACHABLE');

    // Subtest 4: Emergency bypass UPDATER_SKIP_COMPATIBILITY_CHECK=true
    const rBypass = await runUpdaterCompat({
      APP_MODE: 'hybrid',
      SHOP_ID: testShopId,
      SUPABASE_URL: 'http://127.0.0.1:59998',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SYNC_SHOP_TOKEN: 'test-canonical-token-at-least-32-chars',
      UPDATER_SKIP_COMPATIBILITY_CHECK: 'true',
    });
    check(rBypass.code === 0 && rBypass.parsed?.ok === true && rBypass.parsed?.bypassed === true, 'emergency bypass succeeds when UPDATER_SKIP_COMPATIBILITY_CHECK=true');

    // Subtest 5: Cloud Schema Too Old (cloud reports schema 12 vs app requiring 13)
    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_compatibility') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ compatible: false, error: 'CLOUD_SCHEMA_TOO_OLD', cloud_schema_version: 12, max_supported: 2 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({}));
      }
    };

    const rTooOld = await runUpdaterCompat(shop1Env);
    check(rTooOld.code !== 0, 'cloud schema too old exits non-zero');
    check(rTooOld.parsed?.error === 'CLOUD_SCHEMA_TOO_OLD', 'returns CLOUD_SCHEMA_TOO_OLD');

    // Subtest 6: App Protocol Too New
    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_compatibility') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ compatible: false, error: 'SYNC_PROTOCOL_INCOMPATIBLE', min_supported: 1, max_supported: 2, cloud_schema_version: 13 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({}));
      }
    };

    const rProtoIncompat = await runUpdaterCompat(shop1Env);
    check(rProtoIncompat.code !== 0, 'incompatible protocol exits non-zero');
    check(rProtoIncompat.parsed?.error === 'SYNC_PROTOCOL_INCOMPATIBLE', 'returns SYNC_PROTOCOL_INCOMPATIBLE');

    // Subtest 7: Compatible cloud -> installation proceeds
    mockRpcHandler = (fn, body, res) => {
      if (fn === 'gc_check_compatibility') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ compatible: true, protocol_version: 2, cloud_schema_version: 13 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({}));
      }
    };

    const rCompatible = await runUpdaterCompat(shop1Env);
    check(rCompatible.code === 0 && rCompatible.parsed?.ok === true, 'compatible cloud schema 13 & protocol 2 succeeds');

  } finally {
    // Clean up test events from local database
    if (trackedEventIds.length > 0) {
      await pool.query('DELETE FROM sync_events WHERE id = ANY($1::uuid[])', [trackedEventIds]);
    }
    mockServer.close();
    process.env = origEnv;
    resetSyncConfig();
  }

  const fails = summary();
  await pool.end();
  process.exit(fails ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
