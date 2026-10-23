# GIGA CHEMIST — SHOP 2 DEVELOPMENT WORKSPACE

## 1. What This Workspace Is
`B:\GIGA-CHEMIST-POS-2` is the dedicated, isolated development workspace for preparing, testing, and packaging **Shop 2**.
This is **NOT** the live Shop 2 computer. This directory serves as the preparation workshop where legacy SQLite data will be migrated to PostgreSQL, verified, and packaged into `GIGA-CHEMIST-SHOP2-PACKAGE` before installation on the physical Shop 2 computer.

## 2. STRICT SEPARATION RULES — What Must NEVER Be Copied From Shop 1
Under NO circumstances should any of the following be copied or shared between Shop 1 and Shop 2:
- **Shop 1 SHOP_ID**: `c2a176c8-a50f-456f-a370-225c11d2e32f` (FORBIDDEN IN SHOP 2).
- **Shop 1 Environment Files**: `.env`, `.env.local`, `.env.production`.
- **Shop 1 Database**: `giga_chemist` or `giga_chemist_dev`.
- **Shop 1 Data**: Medicines, stock counts, batch numbers, sales, invoices, customers, local users.
- **Shop 1 Sync State**: `sync_events`, `sync_inbound_commands`, outbox sequences, audit logs.
- **Shop 1 Updater State**: `update-state.json`, installed SHA metadata, backups.

## 3. Database Names
- **Development Database**: `giga_chemist_shop2_dev` (Used for testing and migration validation).
- **Future Production Database**: `giga_chemist_shop2` (Will run on the physical Shop 2 computer).

## 4. How to Start Locally
Shop 2 runs strictly in **local-only** mode during development.
```powershell
# 1. Verify safety guard
npx tsx scripts/shop2/assert-shop2-dev.ts

# 2. Start local server
npm run dev
```
The application will listen on `http://localhost:5002` (or configured port) with cloud synchronization fully disabled.

## 5. How to Run Tests
Only run tests that are strictly local and safe:
```powershell
# Run TypeScript linting
npm run lint

# Run application build
npm run build

# Run Shop 2 safety assertion
npx tsx scripts/shop2/assert-shop2-dev.ts
```
**CRITICAL**: Do NOT run integration tests that communicate with production cloud or attempt to synchronize Shop 1 data.

## 6. How the Future SQLite Migration Will Work
When the existing Shop 2 SQLite database file is provided:
1. **Preserve Original**: Store an untouched, read-only copy in `deployment/shop2/migration/backup/`.
2. **Schema & Data Audit**: Inspect tables, columns, row counts, and data types.
3. **Field Mapping**: Map legacy tables to GIGA CHEMIST PostgreSQL schema:
   - Medicines & Categories
   - Batches, Expiry Dates & Quantities
   - Sales, Receipt Items & Payments
   - Customers & Suppliers
   - Users & Passwords (forced reset on first login)
4. **Data Transformation & Import**: Run migration into `giga_chemist_shop2_dev`.
5. **Reconciliation & Auditing**: Validate financial balance, stock totals, and historical counts.

## 7. How Shop 2 Cloud Activation Will Work Later
Shop 2 will first launch and operate **100% offline / local** in production.
Once operational stability is proven:
1. A unique `SHOP_ID` and `SYNC_SHOP_TOKEN` will be generated.
2. Shop 2 will be registered in Supabase `giga_cloud.shops`.
3. An authoritative initial inventory snapshot will be published to the cloud mirror.
4. Cloud sync worker will be enabled in `hybrid` mode.

## 8. How to Build the Final Deployment Package
Once migration and verification are complete, the standalone deployment package will be compiled into `deployment/shop2/release/GIGA-CHEMIST-SHOP2-PACKAGE` for transfer via USB to the Shop 2 computer.
