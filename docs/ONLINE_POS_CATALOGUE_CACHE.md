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

## Multi-shop isolation (for the multi-shop phase)

The cache holds exactly ONE shop's data. The multi-shop branch (`feature/multi-shop-unified-auth`) adds:

- `purgeIfShopChanged()`: before any hydration, if the selected shop differs from the shop the cache was filled
  for (`giga_cache_shop` marker), every shop-scoped table is emptied.
- Switching shop confirms, purges and reloads the page (other tabs reload too).

With `replaceCatalog` the catalogue tables are additionally replaced as a whole snapshot of the request's shop
(the API resolves the shop from the authorized `X-GIGA-SHOP-ID`), so even without the purge no Shop 1 medicine
or batch could remain under Shop 2. When this fix is merged into the multi-shop branch:

1. Keep `purgeIfShopChanged()` as the first step of `syncFromLocalApiToDexie()`.
2. Replace that branch's medicines/batches `putAll` lines with `replaceCatalog()` (the only overlapping lines).
3. Shop-specific screens re-read on `CATALOG_REFRESHED_EVENT`, which fires only after the new shop's snapshot
   has committed.
