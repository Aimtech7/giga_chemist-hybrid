import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, type ViteDevServer } from 'vite';

/**
 * Online POS catalogue cache (Dexie) — browser test.   npm run test:pos-cache
 *
 * Runs the REAL src/services/syncEngine.ts + src/db/dexie.ts in headless Chrome (real IndexedDB),
 * served by a Vite dev server. fetch is stubbed inside the page, so no POS server, no database
 * and no cloud is touched. Proves: a failed or incomplete download never clears the cache; a
 * successful refresh replaces medicines + batches atomically (stale rows removed, rows updated).
 * Chrome: CHROME_PATH or the default Windows install path.
 */
const PORT = Number(process.env.POS_CACHE_TEST_PORT || 5199);
const CDP_PORT = Number(process.env.POS_CACHE_CDP_PORT || 9339);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- minimal CDP client
async function openPage(): Promise<{ evaluate: <T>(expr: string) => Promise<T>; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-pos-cache-'));
  const chrome: ChildProcess = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let ws: WebSocket | null = null;
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(200);
    try {
      const t = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as any[]).find((x) => x.type === 'page');
      if (t) ws = new WebSocket(t.webSocketDebuggerUrl);
    } catch {
      /* not up yet */
    }
  }
  if (!ws) throw new Error('Chrome DevTools endpoint did not start');
  const sock = ws;
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res) => {
      const i = ++id;
      pending.set(i, res);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/icon.svg` });
  await sleep(1500);
  return {
    evaluate: async <T>(expression: string) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value as T;
    },
    close: () => {
      try { sock.close(); } catch { /* ignore */ }
      chrome.kill();
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500);
    },
  };
}

// ---------------------------------------------------------------- in-page harness
const HARNESS = `(async () => {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  localStorage.setItem('giga_chemist_auth_token', b64({ alg: 'none' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + 3600 }) + '.x');
  localStorage.setItem('giga_chemist_current_user', JSON.stringify({ id: 'u-global', name: 'Test', email: 't@x', role: 'ADMIN', active: true }));
  const { db } = await import('/src/db/dexie.ts');
  const se = await import('/src/services/syncEngine.ts');
  const sc = await import('/src/services/shopContext.ts');
  const realFetch = window.fetch.bind(window);
  window.__routes = {};
  window.__requests = [];
  window.fetch = async (url, init) => {
    const p = new URL(String(url), location.href).pathname;
    let r = window.__routes[p];
    if (!r) return realFetch(url, init);
    window.__requests.push({ path: p, shop: (init && init.headers && init.headers['X-GIGA-SHOP-ID']) || null });
    if (typeof r === 'function') r = await r(init);
    if (r === 'NETWORK') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  window.__events = 0;
  window.addEventListener(se.CATALOG_REFRESHED_EVENT, () => { window.__events++; });
  const med = (id, name, v, extra = {}) => ({ id, name, generic_name: name, brand_name: '', sku: id, barcode: 'B-' + id, category: 'Test',
    status: 'active', version: v, current_stock: 5, reorder_level: 1, selling_price: 10, purchase_price: 5, unit: 'pc', ...extra });
  const bat = (id, medicine_id, q) => ({ id, medicine_id, batch_number: 'BN-' + id, quantity_available: q, quantity_received: q,
    expiry_date: '2030-01-01', expiry_status: 'ok', status: 'active' });
  window.__t = {
    db, se, sc, med, bat,
    async seed() {
      await db.transaction('rw', db.medicines, db.medicine_batches, async () => {
        await db.medicines.clear(); await db.medicine_batches.clear();
        await db.medicines.bulkPut([med('m1', 'Existing v1', 1), med('m-stale', 'Stale medicine', 1)]);
        await db.medicine_batches.bulkPut([bat('b1', 'm1', 5), bat('b-stale', 'm-stale', 3)]);
      });
    },
    async snap() {
      const m = (await db.medicines.toArray()).sort((a, b) => a.id.localeCompare(b.id));
      const b = (await db.medicine_batches.toArray()).sort((a, b) => a.id.localeCompare(b.id));
      return JSON.stringify({ m, b });
    },
    route(p, r) { window.__routes[p] = r; },
  };
  return 'ready';
})()`;

async function run(page: Awaited<ReturnType<typeof openPage>>) {
  const ev = page.evaluate;
  check((await ev<string>(HARNESS)) === 'ready', 'harness loaded the real syncEngine + Dexie modules in Chrome');

  const OK_MEDS = `[__t.med('m1', 'Existing v2', 2), __t.med('m2', 'New medicine', 1, { status: 'inactive', current_stock: 0 })]`;
  const OK_BATS = `[__t.bat('b1', 'm1', 7), __t.bat('b2', 'm2', 0)]`;
  const attempt = (meds: string, bats: string) => ev<{ ok: boolean; same: boolean; events: number }>(`(async () => {
    await __t.seed(); window.__events = 0;
    const before = await __t.snap();
    __t.route('/api/medicines', ${meds}); __t.route('/api/batches', ${bats});
    const ok = await __t.se.replaceCatalog();
    return { ok, same: (await __t.snap()) === before, events: window.__events };
  })()`);

  console.log('\n=== FAILED / INCOMPLETE DOWNLOAD NEVER CLEARS THE CACHE');
  let r = await attempt(`{ status: 200, body: ${OK_MEDS} }`, `{ status: 500, body: { error: 'boom' } }`);
  check(!r.ok && r.same && r.events === 0, 'medicines OK + batches HTTP 500 -> old medicines AND old batches kept', r);
  r = await attempt(`{ status: 500, body: { error: 'boom' } }`, `{ status: 200, body: ${OK_BATS} }`);
  check(!r.ok && r.same && r.events === 0, 'medicines HTTP 500 + batches OK -> cache intact', r);
  r = await attempt(`{ status: 200, body: ${OK_MEDS} }`, `'NETWORK'`);
  check(!r.ok && r.same && r.events === 0, 'batches network failure -> cache intact', r);
  r = await attempt(`{ status: 200, body: { medicines: ${OK_MEDS} } }`, `{ status: 200, body: ${OK_BATS} }`);
  check(!r.ok && r.same && r.events === 0, 'medicines response not a complete list -> cache intact', r);
  r = await attempt(`{ status: 200, body: [...${OK_MEDS}, { name: 'no id' }] }`, `{ status: 200, body: ${OK_BATS} }`);
  check(!r.ok && r.same && r.events === 0, 'write failure inside the transaction -> rolled back, cache intact (atomic)', r);

  console.log('\n=== SUCCESSFUL REFRESH = COMPLETE SNAPSHOT REPLACEMENT');
  const s = await ev<any>(`(async () => {
    await __t.seed(); window.__events = 0;
    __t.route('/api/medicines', { status: 200, body: ${OK_MEDS} }); __t.route('/api/batches', { status: 200, body: ${OK_BATS} });
    const ok = await __t.se.replaceCatalog();
    const m = await __t.db.medicines.toArray(), b = await __t.db.medicine_batches.toArray();
    return { ok, events: window.__events, mIds: m.map((x) => x.id).sort(), bIds: b.map((x) => x.id).sort(),
      m1: m.find((x) => x.id === 'm1'), b1: b.find((x) => x.id === 'b1'), m2: m.find((x) => x.id === 'm2') };
  })()`);
  check(s.ok === true && s.events === 1, 'refresh succeeds and announces the new snapshot once', s);
  check(!s.mIds.includes('m-stale'), 'stale medicine (not returned by the server) removed', s.mIds);
  check(!s.bIds.includes('b-stale'), 'stale batch (not returned by the server) removed', s.bIds);
  check(s.m1?.name === 'Existing v2' && s.m1?.version === 2, 'existing medicine updated to the server version', s.m1);
  check(s.b1?.quantity_available === 7, 'existing batch updated to the server quantity', s.b1);
  check(JSON.stringify(s.mIds) === '["m1","m2"]' && JSON.stringify(s.bIds) === '["b1","b2"]', 'cache = exactly the server medicines and batches', s);
  check(s.m2?.status === 'inactive' && s.m2?.current_stock === 0, 'inactive and zero-stock medicines are kept in the cache (not filtered out)', s.m2);

  console.log('\n=== FULL-SIZE CATALOGUE');
  const big = await ev<any>(`(async () => {
    await __t.seed();
    const meds = Array.from({ length: 2181 }, (_, i) => __t.med('M' + i, 'Med ' + i, 1, { status: i < 2035 ? 'active' : 'inactive', current_stock: i % 3 }));
    const bats = meds.map((m, i) => __t.bat('B' + i, m.id, i % 3));
    __t.route('/api/medicines', { status: 200, body: meds }); __t.route('/api/batches', { status: 200, body: bats });
    const t0 = performance.now();
    const ok = await __t.se.replaceCatalog();
    return { ok, ms: Math.round(performance.now() - t0), meds: await __t.db.medicines.count(), bats: await __t.db.medicine_batches.count(),
      active: await __t.db.medicines.where('status').equals('active').count(), inactive: await __t.db.medicines.where('status').equals('inactive').count() };
  })()`);
  check(big.ok && big.meds === 2181 && big.bats === 2181 && big.active === 2035 && big.inactive === 146,
    `2181 medicines / 2181 batches replaced (2035 active, 146 inactive) in ${big.ms} ms`, big);
}

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

async function runMultiShop(page: Awaited<ReturnType<typeof openPage>>) {
  const ev = page.evaluate;
  console.log('\n=== MULTI-SHOP CACHE ISOLATION (synthetic Shop 1 / Shop 2)');
  await ev<number>(`(async () => {
    window.S1 = '${S1}'; window.S2 = '${S2}';
    const m = __t.med, b = __t.bat;
    window.CAT = {
      [S1]: { meds: [m('s1-m1', 'Shop1 Amox', 1), m('s1-m2', 'Shop1 Zero', 1, { current_stock: 0 }), m('s1-m3', 'Shop1 Retired', 1, { status: 'inactive' })],
              bats: [b('s1-b1', 's1-m1', 5), b('s1-b2', 's1-m2', 0), b('s1-b3', 's1-m3', 2)] },
      [S2]: { meds: [m('s2-m1', 'Shop2 Paracetamol', 1)], bats: [b('s2-b1', 's2-m1', 9)] },
    };
    window.__fail = {}; window.__delay = {};
    const route = (kind) => async (init) => {
      const shop = init && init.headers && init.headers['X-GIGA-SHOP-ID'];
      if (window.__delay[shop]) await new Promise((r) => setTimeout(r, window.__delay[shop]));
      if (window.__fail[shop + ':' + kind]) return { status: 500, body: { error: 'shop ' + kind + ' down' } };
      return CAT[shop] ? { status: 200, body: CAT[shop][kind] } : { status: 403, body: { error: 'no shop' } };
    };
    __t.route('/api/medicines', route('meds')); __t.route('/api/batches', route('bats'));
    window.ids = async () => ({ m: (await __t.db.medicines.toArray()).map((x) => x.id).sort(), b: (await __t.db.medicine_batches.toArray()).map((x) => x.id).sort() });
    window.asGlobal = async (shop) => {
      localStorage.setItem('giga_chemist_current_user', JSON.stringify({ id: 'u-global', name: 'G', email: 'g@x', role: 'ADMIN', active: true }));
      __t.sc.setOnlineAccount({ type: 'GLOBAL_ADMIN', shop_id: null, local_user_id: null, username: null });
      __t.sc.setSelectedShop({ shop_id: shop, shop_code: shop === S1 ? 'SHOP1' : 'SHOP2', name: shop === S1 ? 'Shop 1' : 'Shop 2' });
    };
    return 1;
  })()`);

  // TEST 1 + 2 + 7a: Global Admin on Shop 1
  let r = await ev<any>(`(async () => {
    await asGlobal(S1); await __t.se.purgeIfShopChanged(); window.__requests = [];
    const ok = await __t.se.replaceCatalog();
    return { ok, ids: await ids(), meta: await __t.se.getCatalogMeta(), gate: await __t.se.isCatalogForCurrentShop(), shops: __requests.map((x) => x.shop) };
  })()`);
  check(r.ok && JSON.stringify(r.ids.m) === '["s1-m1","s1-m2","s1-m3"]' && JSON.stringify(r.ids.b) === '["s1-b1","s1-b2","s1-b3"]', 'TEST 1: Shop 1 refresh stores exactly the Shop 1 catalogue', r.ids);
  check(r.meta?.shop_key === S1 && r.meta.medicines === 3 && r.meta.batches === 3 && Boolean(r.meta.refreshed_at) && r.gate,
    'TEST 2: cache metadata records Shop 1 (shop id + refreshed_at), stamped in the same transaction', r.meta);
  check(r.shops.length === 2 && r.shops.every((x: string) => x === S1), 'TEST 7a: every catalogue request carried the selected Shop 1 header', r.shops);
  check(r.ids.m.includes('s1-m2') && r.ids.m.includes('s1-m3'), 'TEST 9/10 (cache): zero-stock and inactive medicines kept in the snapshot');

  // TEST 3: switching to Shop 2 hides Shop 1 even before anything is purged
  r = await ev<any>(`(async () => { await asGlobal(S2); return { gate: await __t.se.isCatalogForCurrentShop(), stillThere: (await ids()).m.length }; })()`);
  check(r.gate === false && r.stillThere === 3, 'TEST 3: with Shop 2 selected the Shop 1 snapshot is refused by the cross-shop guard (screens read nothing)', r);

  // TEST 4 + 7b: successful Shop 2 refresh replaces the Shop 1 snapshot
  r = await ev<any>(`(async () => {
    await __t.se.purgeIfShopChanged(); window.__requests = [];
    const ok = await __t.se.replaceCatalog();
    return { ok, ids: await ids(), meta: await __t.se.getCatalogMeta(), gate: await __t.se.isCatalogForCurrentShop(), shops: __requests.map((x) => x.shop) };
  })()`);
  check(r.ok && JSON.stringify(r.ids.m) === '["s2-m1"]' && JSON.stringify(r.ids.b) === '["s2-b1"]' && r.meta?.shop_key === S2 && r.gate,
    'TEST 4: Shop 2 refresh replaces the Shop 1 snapshot completely (no Shop 1 row left)', r);
  check(r.shops.length === 2 && r.shops.every((x: string) => x === S2), 'TEST 7b: after the switch only the selected Shop 2 was requested', r.shops);

  // TEST 5 + 11 + 12: a failed Shop 2 refresh never labels the Shop 1 cache as Shop 2
  for (const kind of ['meds', 'bats']) {
    r = await ev<any>(`(async () => {
      await asGlobal(S1); await __t.se.purgeIfShopChanged(); await __t.se.replaceCatalog();
      await asGlobal(S2); window.__fail = { [S2 + ':${kind}']: true };
      const ok = await __t.se.replaceCatalog(); window.__fail = {};
      return { ok, ids: await ids(), meta: await __t.se.getCatalogMeta(), gate: await __t.se.isCatalogForCurrentShop(), state: __t.se.getCatalogState() };
    })()`);
    check(!r.ok && r.meta?.shop_key === S1 && r.gate === false && r.ids.m.length === 3 && r.state?.status === 'error' && r.state?.shop_key === S2,
      `TEST 5/${kind === 'meds' ? '11' : '12'}: Shop 2 ${kind === 'meds' ? 'medicines' : 'batches'} failure -> old snapshot kept, still labelled Shop 1, not shown for Shop 2, error state`, r);
  }

  // A download that finishes after a shop switch is discarded
  r = await ev<any>(`(async () => {
    await asGlobal(S1); await __t.se.purgeIfShopChanged(); await __t.se.replaceCatalog();
    window.__delay = { [S1]: 300 };
    const p = __t.se.replaceCatalog();
    await new Promise((res) => setTimeout(res, 50)); await asGlobal(S2);
    const ok = await p; window.__delay = {};
    return { ok, meta: await __t.se.getCatalogMeta(), gate: await __t.se.isCatalogForCurrentShop() };
  })()`);
  check(r.ok === false && r.meta?.shop_key === S1 && r.gate === false, 'a Shop 1 download that finishes after switching to Shop 2 is discarded', r);

  // Concurrent refreshes for the same shop share one download
  r = await ev<any>(`(async () => {
    await asGlobal(S1); await __t.se.purgeIfShopChanged(); window.__requests = [];
    const [a, b] = await Promise.all([__t.se.replaceCatalog(), __t.se.replaceCatalog()]);
    return { a, b, n: __requests.length };
  })()`);
  check(r.a && r.b && r.n === 2, 'two simultaneous refreshes (login + app start) share one medicines + one batches download', r);

  // TEST 8 (browser side): a shop user is keyed to its OWN shop; another user's selection is ignored
  r = await ev<any>(`(async () => {
    await asGlobal(S1); await __t.se.purgeIfShopChanged(); await __t.se.replaceCatalog();
    localStorage.setItem('giga_chemist_current_user', JSON.stringify({ id: 'u-shop2', name: 'C2', email: 'c2@x', role: 'CASHIER', active: true }));
    __t.sc.setOnlineAccount({ type: 'SHOP_USER', shop_id: S2, local_user_id: 'l2', username: null });
    const key = __t.sc.shopCacheKey(), selected = __t.sc.selectedShopId();
    const gateBefore = await __t.se.isCatalogForCurrentShop();
    await __t.se.purgeIfShopChanged();
    return { key, selected, gateBefore, left: (await ids()).m.length, meta: await __t.se.getCatalogMeta() };
  })()`);
  check(r.key === S2 && r.selected === null, "TEST 8: a Shop 2 user ignores the Global Admin's selection and is keyed to its own shop", r);
  check(r.gateBefore === false && r.left === 0 && r.meta === null, 'TEST 8: the Shop 1 cache is refused and emptied (identity cleared) when a Shop 2 user signs in', r);

  // Single-shop local app: an existing cache without identity stays usable (no offline regression)
  r = await ev<any>(`(async () => {
    localStorage.setItem('giga_chemist_current_user', JSON.stringify({ id: 'u-local', name: 'L', email: 'l@x', role: 'CASHIER', active: true }));
    __t.sc.setOnlineAccount(null); await __t.seed(); await __t.db.meta.delete('catalogue');
    return { key: __t.sc.shopCacheKey(), gate: await __t.se.isCatalogForCurrentShop() };
  })()`);
  check(r.key === 'default' && r.gate === true, 'local pharmacy app: a pre-existing cache (no identity yet) remains usable', r);
}

async function main() {
  let vite: ViteDevServer | null = null;
  let page: Awaited<ReturnType<typeof openPage>> | null = null;
  try {
    vite = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error', clearScreen: false });
    await vite.listen();
    page = await openPage();
    await run(page);
    await runMultiShop(page);
  } catch (err: any) {
    check(false, `suite aborted: ${err?.message || err}`);
  } finally {
    page?.close();
    await vite?.close();
  }
  console.log(`\n=============================================================\n  RESULT: ${passed} passed, ${failed} failed\n=============================================================`);
  process.exit(failed ? 1 : 0);
}

main();
