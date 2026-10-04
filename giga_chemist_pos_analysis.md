# GIGA CHEMIST POS — Codebase Analysis

## Project Overview

**GIGA CHEMIST POS** is a full-stack offline-first pharmacy point-of-sale system built for a real dispensing chemist in Kitale, Kenya.

- **Frontend**: React 19 + TypeScript + TailwindCSS 4 + Vite (PWA)
- **Backend**: Express.js + TypeScript running on `tsx` (no compile step)
- **Database (Server)**: PostgreSQL (local or Supabase cloud) with a JSON flat-file fallback (`data/server-db.json`)
- **Database (Client)**: Dexie.js (IndexedDB wrapper) for offline-first local storage
- **Sync**: Custom dual-mode sync engine (local Express API ↔ Dexie, or Supabase ↔ Dexie)
- **Auth**: JWT-based server auth + cached user session on client
- **Deployment**: Vercel (cloud) or standalone local Windows PC (`start-giga-chemist.bat`)

---

## Architecture: Dual-Mode Offline-First System

```
[Browser / PWA]
    Dexie.js (IndexedDB)  ←→  SyncEngine  ←→  Local Express API (PostgreSQL)
                                                     ↕ (optional)
                                               Supabase Cloud DB
```

The system operates in two modes:
1. **Local PC Mode**: Express server runs on the same machine, uses local PostgreSQL. Frontend syncs to it.
2. **Cloud/Vercel Mode**: Frontend syncs to Supabase directly.

---

## Modules / Screens

| Module | Access | Description |
|--------|--------|-------------|
| `dashboard` | Admin/Manager | Executive KPI dashboard |
| `pos` | All roles | POS register (sale + payment + receipt) |
| `medicines` | All roles | Medicine lookup/catalogue |
| `inventory` | Admin/Manager | Stock management & adjustments |
| `stocktake` | Admin | Physical stock count |
| `batches` | Admin/Manager | Medicine batch management |
| `expiry` | Admin/Manager | Expiry date management |
| `purchases` | Admin/Manager | Purchase orders & receiving |
| `suppliers` | Admin/Manager | Supplier management |
| `customers` | All (with perms) | Customer CRM |
| `expenses` | Admin/Manager | Expense tracking |
| `sales` | Admin/Manager | Sales history & returns |
| `returns` | Admin/Manager | Customer returns |
| `reports` | Admin/Manager | Financial & operational reports |
| `users` | Admin only | User management |
| `audit` | Admin only | Audit log viewer |
| `settings` | Admin only | Pharmacy settings |

---

## Key Architectural Decisions & Notable Changes

### 1. Dual-Database Strategy
- **Server side**: `server/db.ts` → JSON flat-file store (`data/server-db.json`) used as development fallback. The `server/db/` folder contains a full PostgreSQL implementation split by domain (medicines, batches, sales, inventory, users, etc.)
- **Client side**: Dexie (IndexedDB) for offline-first local state
- The `server/db/index.ts` aggregates all domain DB functions and exports them to `routes.ts`

### 2. JWT-Based Role Authentication
- Server: `server/auth.ts` handles JWT creation/verification + role-permission mapping (`ROLE_PERMISSIONS`)
- Three roles: **ADMIN**, **MANAGER**, **CASHIER**
- Permission keys (e.g. `medicine.view`, `sales.create`, `returns.process`) enforce fine-grained RBAC
- Rate limiter on `/auth/login` (20 attempts per minute per IP)
- Cashiers get **sanitized responses** — `purchase_price` and `wholesale_price` are zeroed out from medicine/batch data

### 3. Sync Engine (`services/syncEngine.ts`)
Two sync paths:
- `syncFromLocalApiToDexie()` — hydrates Dexie from local Express (11 endpoints: categories → medicines → batches → sales → purchases → movements → returns → expenses → settings)
- `syncFromSupabaseToDexie()` — hydrates from Supabase cloud; falls back to local if Supabase not configured
- `runSync()` — uploads pending local sales/returns/expenses to server via `/api/sync`
- **Safe Stock Merge**: When syncing authoritative stock from server, if there are still unsynced local sales for a medicine, the local (deducted) stock count is preserved — preventing silent stock erasure

### 4. Idempotency & Sync Queue
- Every sale, return, and expense gets an `idempotency_key` to prevent duplicate processing
- `SyncQueueItem` table in Dexie (`pending_sync`) tracks each pending entity with retry counts and error messages
- Background heartbeat every **30 seconds** auto-retries pending items when online

### 5. POS Screen (`components/pos/PosScreen.tsx` — 41KB)
Largest component. Handles:
- Medicine search (barcode + text)
- Cart management with FEFO batch allocation (First Expiry First Out)
- Hold/resume sales (`HeldSale`)
- `PaymentModal` — supports Cash, M-Pesa, Card, Bank, and **Mixed/Split payments**
- `ReceiptModal` — thermal receipt printing (58mm/80mm)
- Discount at item level and order level
- Minimum selling price enforcement

### 6. Inventory Engine (`services/inventoryEngine.ts`)
- FEFO batch allocation logic
- Stock deduction on sale
- Batch exhaustion tracking

### 7. Receipt / Thermal Printing
- `services/receiptPrinter.ts` — generic receipt formatting
- `services/thermalPrinter.ts` — 58mm/80mm ESC/POS thermal printer support
- Auto-print setting in `PharmacySettings`

### 8. Migrations (`migrations/`)
Four SQL migration files:
1. `001_initial_schema.sql` — Core tables
2. `002_auth_rbac.sql` — Users, passwords, RBAC
3. `003_indexes_constraints.sql` — Performance indexes and constraints
4. `004_discount_and_stock_enhancements.sql` — Added `min_selling_price`, `wholesale_price`, discount fields

### 9. Dexie Schema Versioning
- **Version 1**: Core tables
- **Version 2**: Added `categories` table (new addition)

### 10. PharmacySettings
Stored both server-side and in Dexie. Contains:
- Pharmacy name, address, contact
- Currency (`KES`), tax rate/enabled
- Receipt header/footer
- Printer type (58mm/80mm)
- Thresholds: `low_stock_threshold`, `expiry_warning_days`
- Flags: `require_prescription_warning`, `allow_walk_in`, `auto_print_receipt`
- Optional `currency_symbol` field

---

## Data Flow: A Typical Sale

1. Cashier searches medicine → PosScreen fetches from Dexie
2. Cart built; FEFO batch allocated via inventoryEngine
3. PaymentModal collects payment (cash/M-Pesa/split)
4. Sale saved to Dexie with `sync_status: 'pending'`
5. Stock decremented in Dexie immediately
6. `enqueueSyncItem()` adds to `pending_sync` queue
7. SyncEngine sends to `/api/sync` when online
8. Server processes sale, returns `authoritative_medicines` and `authoritative_batches`
9. Dexie updated with safe stock merge

---

## RBAC Permission Matrix

| Permission | ADMIN | MANAGER | CASHIER |
|---|---|---|---|
| medicine.view | ✅ | ✅ | ✅ |
| medicine.create/update/delete | ✅ | ✅ | ❌ |
| medicine.change_price | ✅ | ❌ | ❌ |
| sales.create | ✅ | ✅ | ✅ |
| sales.void | ✅ | ✅ | ❌ |
| returns.process | ✅ | ✅ | ❌ |
| returns.request | ✅ | ✅ | ✅ |
| reports.view | ✅ | ✅ | ❌ |
| users.manage | ✅ | ❌ | ❌ |
| settings.manage | ✅ | ❌ | ❌ |
| audit.view | ✅ | ❌ | ❌ |
| expenses.manage | ✅ | ✅ | ❌ |
| customers.manage | ✅ | ✅ | ✅ |
| inventory.adjust | ✅ | ❌ | ❌ |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| [`src/App.tsx`](file:///d:/GIGA-CHEMIST-POS/src/App.tsx) | Root component, routing, auth guard |
| [`src/types/index.ts`](file:///d:/GIGA-CHEMIST-POS/src/types/index.ts) | All TypeScript interfaces |
| [`src/db/dexie.ts`](file:///d:/GIGA-CHEMIST-POS/src/db/dexie.ts) | Client-side IndexedDB schema |
| [`src/services/syncEngine.ts`](file:///d:/GIGA-CHEMIST-POS/src/services/syncEngine.ts) | Offline sync logic |
| [`src/services/inventoryEngine.ts`](file:///d:/GIGA-CHEMIST-POS/src/services/inventoryEngine.ts) | FEFO batch allocation |
| [`src/services/auth.ts`](file:///d:/GIGA-CHEMIST-POS/src/services/auth.ts) | Client auth/session cache |
| [`src/services/permissions.ts`](file:///d:/GIGA-CHEMIST-POS/src/services/permissions.ts) | Frontend RBAC checks |
| [`src/components/pos/PosScreen.tsx`](file:///d:/GIGA-CHEMIST-POS/src/components/pos/PosScreen.tsx) | Main POS register |
| [`src/components/pos/PaymentModal.tsx`](file:///d:/GIGA-CHEMIST-POS/src/components/pos/PaymentModal.tsx) | Split payment UI |
| [`server/routes.ts`](file:///d:/GIGA-CHEMIST-POS/server/routes.ts) | All API endpoints |
| [`server/auth.ts`](file:///d:/GIGA-CHEMIST-POS/server/auth.ts) | JWT + RBAC server-side |
| [`server/db/`](file:///d:/GIGA-CHEMIST-POS/server/db/) | PostgreSQL domain functions |
| [`server/db.ts`](file:///d:/GIGA-CHEMIST-POS/server/db.ts) | JSON fallback store + seed data |
| [`migrations/`](file:///d:/GIGA-CHEMIST-POS/migrations/) | SQL schema migrations |
| [`server.ts`](file:///d:/GIGA-CHEMIST-POS/server.ts) | Express app entry point |
