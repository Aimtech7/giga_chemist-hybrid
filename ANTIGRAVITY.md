# GIGA CHEMIST — SHOP 2 PROJECT TRACKER (ANTIGRAVITY.md)

## 1. Project Purpose & Scope
Preparation, legacy data migration, testing, and deployment packaging for **Shop 2**.
Shop 2 is the second physical pharmacy branch operating the GIGA CHEMIST platform.
It shares the same application engine and Supabase project as Shop 1, but possesses completely isolated operational inventory, sales, users, sync outbox, device identity, and local PostgreSQL database.

## 2. Source & Architecture Baseline
- **Source Repository**: `https://github.com/Aimtech7/giga_chemist-hybrid.git`
- **Development Root**: `B:\GIGA-CHEMIST-POS-2` (strictly isolated from `B:\GIGA-CHEMIST-POS`)
- **Current Git Branch**: `shop2/development`
- **Base Production SHA**: `ac7492c25177336a3309dcdb6088e9c3d7b964cc`
- **Base Production Tree**: `305644d7859e39f2ae3b39a9f2cf00c2559ef7f4`

## 3. Database Architecture
- **Development Database**: `giga_chemist_shop2_dev` (Local development machine, port 5432)
- **Planned Production Database**: `giga_chemist_shop2` (Actual Shop 2 computer)
- **Forbidden Databases**: `giga_chemist`, `giga_chemist_dev` (Must NEVER be touched by Shop 2)

## 4. Strict Isolation & Separation Rules
1. **Zero Shop 1 Contamination**: Shop 1 data, medicines, batches, sales, and accounts must NEVER be imported into Shop 2.
2. **Forbidden Shop 1 ID**: `c2a176c8-a50f-456f-a370-225c11d2e32f` is strictly blocked in Shop 2 setup.
3. **Local-Only During Development**: `APP_MODE=local` and `SYNC_ENABLED=false`. No live cloud sync worker may run from `B:\GIGA-CHEMIST-POS-2`.
4. **No Cloud Impersonation**: Development PC must NEVER register or impersonate live Shop 2 on Supabase.
5. **No Secret Leaks**: Development `.env` contains no cloud tokens.

## 5. Migration Status
- **PostgreSQL Operational Schema**: **INITIALIZED (28/28 migrations applied)**
  - Applied: `001_initial_schema.sql` through `028_authoritative_shop_mirror.sql`.
  - Current Operational State: Clean, 0 medicines, 0 batches.
- **Legacy SQLite Migration**: **PENDING (Awaiting SQLite backup from Shop 2)**
  - Status: Awaiting client-provided SQLite database.
  - Placeholder & audit pipelines prepared in `deployment/shop2/migration/`.

## 6. Test & Build Status
- **TypeScript Lint**: **PASS** (254 tracked files, 0 errors).
- **Vite & Serverless Build**: **PASS** (Built in 1.28s).
- **Safety Guard (`assert-shop2-dev.ts`)**: **PASS** (Strict boundary enforcement confirmed).

## 7. Deployment Package Preparation
- Structure created in `deployment/shop2/`:
  - `config/`
  - `database/`
  - `installer/`
  - `migration/`
  - `verification/`
  - `release/`
- Target Artifact: `GIGA-CHEMIST-SHOP2-PACKAGE` for offline physical transfer to the Shop 2 computer.

## 8. Cloud Activation Pipeline (Planned Future Step)
- Documented in `deployment/shop2/ACTIVATE-SHOP2-ONLINE.md`.
- Activation prerequisites:
  1. Local SQLite to PostgreSQL migration verified and healthy.
  2. Shop 2 operating offline locally.
  3. Unique Shop 2 UUID generated and registered in `giga_cloud.shops`.
  4. Authoritative Shop 2 inventory baseline snapshot uploaded.

## 9. Open Decisions
- None currently blocking setup. Awaiting delivery of Shop 2 SQLite backup.

## 10. Next Actions
1. **WAIT FOR SHOP 2 SQLITE BACKUP** (Do not begin migration before receiving actual file).
2. Inspect schema and row counts of legacy SQLite database.
3. Run field mapping and data audit.
4. Execute migration into `giga_chemist_shop2_dev`.
