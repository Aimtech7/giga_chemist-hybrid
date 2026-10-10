# Online POS catalogue cache (Dexie)

The browser keeps a cache of the catalogue (`db.medicines`, `db.medicine_batches`) so the till can search and
sell quickly. The server (shop PostgreSQL, or the cloud copy for the online app) is authoritative.

## Refresh rule (`replaceCatalog` in `src/services/syncEngine.ts`)

1. Download the COMPLETE `/api/medicines` and `/api/batches`.
2. Both must succeed and both must be JSON arrays. Otherwise nothing is touched: the existing cache stays as it was.
3. In ONE Dexie read-write transaction: clear both tables, `bulkPut` both snapshots. Any failure rolls the whole
   transaction back (the previous cache survives).
4. After the commit, `CATALOG_REFRESHED_EVENT` (`giga:catalog-refreshed`) is fired on `window`. The POS and
   Admin Medicines screens re-read Dexie when they receive it, so a screen opened before the refresh finished
   never keeps showing the previous snapshot.

A refresh runs after login, on app start with a stored session, and from Settings → sync.

Rows removed or re-based on the server (e.g. a cloud stock rebase) therefore disappear from the cache on the next
successful refresh; nothing stale is merged in.

What the screens show from the cache:

| Screen | Shows |
|---|---|
| POS (till) | every ACTIVE medicine; zero-stock ones visible and searchable, marked OUT OF STOCK, not addable (click, Enter, barcode) |
| Admin → Medicines (shop app) | active by default, "Include inactive" shows all; Low / Out of Stock filters; status column |
| Admin → Medicines (online app) | the cloud catalogue straight from the API: totals, status + stock filters, Active/Inactive and In/Low/Out badges, "Show more" |

Tests: `npm run test:pos-cache` (headless Chrome, real IndexedDB, real `syncEngine` module, stubbed API).

## Multi-shop isolation (one shared snapshot, stamped with its shop)

The browser keeps ONE catalogue snapshot. It is safe across shops because of four rules:

1. **Shop key.** `shopCacheKey()` = the selected shop (Global Admin), else the account's own shop (shop users),
   else `default` (the server's default shop; always `default` on the single-shop local pharmacy app). Two shop
   users of different shops never share a key, even though neither selects a shop.
2. **Identity stamped atomically.** `replaceCatalog()` writes `db.meta['catalogue'] = { shop_key, refreshed_at,
   medicines, batches }` in the SAME transaction as the rows. A download that finishes after the shop changed is
   discarded. Concurrent refreshes for the same shop share one download.
3. **Guard before every read.** POS, Medicines and Inventory call `isCatalogForCurrentShop()` before reading the
   catalogue. If the snapshot belongs to another shop they read nothing and `CatalogStatusBanner` shows
   "Loading the catalogue for <shop>…" or, after a failure, an error with **Retry**. A cache without identity
   (filled before this existed) is accepted only by the local pharmacy app, so it keeps working offline.
4. **Purge before render.** `purgeIfShopChanged()` (awaited at login and at session restore, and run before
   every hydration) empties all shop-scoped tables and the identity when the key changed. The shop selector
   (Global Admin only) selects, purges and reloads.

Switching Shop 1 -> Shop 2 therefore goes: selection changes -> guard refuses the Shop 1 snapshot at once ->
purge -> reload -> complete Shop 2 download -> validated -> one transaction replaces rows + identity ->
`giga:catalog-refreshed` -> screens re-read. If the Shop 2 download fails, nothing of Shop 1 is shown as Shop 2:
the error banner offers Retry.

The server side is independent of the browser: every request's shop is resolved and authorized per request
(`X-GIGA-SHOP-ID`), a shop-scoped account gets 403 for another shop, and concurrent requests for different
shops never share context (`test:unified-auth`).

Tests: `npm run test:pos-cache` (browser cache, incl. cross-shop) and `npm run test:unified-auth` (server).
