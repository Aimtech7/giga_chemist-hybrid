# MASTER PROMPT: Hybrid Offline-First & Cloud-Connected Pharmacy Management & POS System

> **Instructions for the AI Assistant:**
> You are an elite Principal Systems Architect and Full-Stack Systems Engineer specializing in mission-critical retail, healthcare, and offline-first distributed systems. Your objective is to design, implement, and deploy a production-grade, enterprise-ready **Pharmacy Management & Point of Sale (POS) System** named **GIGA CHEMIST**.
>
> The system must operate as a **hybrid, dual-tier architecture**:
> 1. **Local Tier (On-Premises Windows 11 Master Server):** Provides 100% autonomous, zero-internet offline operation for local cashier terminals over LAN, with local PostgreSQL 16, FEFO batch tracking, ESC/POS hardware peripheral drivers, and sub-millisecond barcode checkout.
> 2. **Cloud Tier (Supabase PostgreSQL + Vercel Web Console):** Provides centralized multi-branch data consolidation, real-time mirror views, cryptographic inventory parity audits, and a remote administrative command queue that dispatches asynchronous changes to on-premises servers without disrupting local operations.
>
> Follow the comprehensive specification below to build the complete codebase from scratch.

---

## 1. System Architecture & Topology

Implement a 3-tier distributed architecture:
- **Workstation Tier (On-Premises Windows 11 Master PC):**
  - Runs local PostgreSQL 16 (`127.0.0.1:5432`) as the authoritative ground truth for all store transactions, balances, shifts, and credentials.
  - Runs a Node.js 20 LTS / Express application engine (`http://0.0.0.0:3000`).
  - Runs a single-leader background synchronization daemon supervised via PostgreSQL session advisory lock `7420317001`.
  - Runs Windows Task Scheduler auto-start and watchdog services for headless, unattended boot.
- **Client Terminal Tier (Counter Tills & Mobile Tablets on Store LAN):**
  - Progressive Web App (PWA) accessed via private LAN (`http://192.168.1.x:3000`).
  - Dexie.js (IndexedDB) in-browser optimistic caching for sub-10ms UI reactivity and barcode scanning.
  - Direct hardware peripheral control: USB/Network 80mm ESC/POS thermal receipt printers, USB HID barcode scanner buffer listeners, and RJ11 24V solenoid cash drawer kick triggers.
- **Cloud Management Tier (Supabase Cloud + Vercel Serverless):**
  - Supabase PostgreSQL (Port 6543 via Supavisor transaction pooler).
  - Private schema `giga_cloud.*` for physical base tables partitioned strictly by `shop_id`.
  - Scoped tenant views `giga_online.*` filtered dynamically by PostgreSQL session variable `set_config('giga.shop_id', ..., true)`.
  - Next.js / Express web console deployed on Vercel (`https://gigachem.vercel.app`) allowing pharmacy owners to remotely monitor sales, adjust pricing, manage formularies, and review cashier shifts.

```
┌──────────────────────────────────────────────────────────┐
│              LOCAL STORE MASTER (Windows 11)             │
│  [PostgreSQL 16] <--> [Node.js Engine] <--> [Local POS]  │
│         ▲                    ▲                           │
│         │                    │ (Advisory Lock Worker)    │
│  (LAN Counter PCs)           │                           │
│  [Till 1] [Till 2]           │ Outbox & Commands         │
└──────────────────────────────┼───────────────────────────┘
                               │ HTTPS / WebSockets
                               ▼
┌──────────────────────────────────────────────────────────┐
│                CENTRAL CLOUD INFRASTRUCTURE              │
│  [Supabase PostgreSQL] <--------> [Vercel Online Admin]  │
│  - giga_cloud.* (Base Tables)     - Remote Owner Console │
│  - giga_online.* (Views)          - Multi-Shop Scope     │
│  - giga_cloud.commands            - Pricing & Stock Hub  │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Technology Stack & Dependencies

- **Local Backend:** Node.js 20 LTS, TypeScript, Express, `pg` (node-postgres with connection pooling), `dotenv`, `cors`, `jsonwebtoken`, `zod` (validation).
- **Client Frontend:** React 18, Vite / Next.js, TypeScript, Tailwind CSS, Lucide React icons, Dexie.js (IndexedDB wrapper).
- **Local Database:** PostgreSQL 16 x64 on Windows 11 with SSD WAL write optimization (`synchronous_commit = on`, `fsync = on`).
- **Cloud Database:** Supabase PostgreSQL 15/16, PostgREST RPC endpoints, Supabase Realtime CDC WebSockets.
- **Remote Admin:** Next.js 14 App Router, Serverless Functions deployed to Vercel.
- **Peripherals:** Native Node.js `net` / `usb` / raw Windows spooler streaming for ESC/POS, global keystroke listener for USB HID barcode scanners.

---

## 3. Local PostgreSQL Database Schema (On-Premises Ground Truth)

Design migrations creating the following core relational tables:
1. `users`: `user_id UUID PK`, `username TEXT UNIQUE`, `email TEXT`, `password_hash TEXT`, `pin_hash TEXT`, `salt TEXT`, `role TEXT CHECK IN ('ADMIN', 'PHARMACIST', 'CASHIER')`, `active BOOL`.
2. `medicines`: `medicine_id UUID PK`, `name TEXT`, `generic_name TEXT`, `barcode TEXT UNIQUE`, `sku TEXT UNIQUE`, `category TEXT`, `reorder_level INT`, `selling_price NUMERIC(12,2)`, `wholesale_price NUMERIC(12,2)`, `min_selling_price NUMERIC(12,2)`, `purchase_price NUMERIC(12,2)`, `prescription_required BOOL`, `current_stock INT`, `active BOOL`.
3. `medicine_batches`: `batch_id UUID PK`, `medicine_id UUID FK`, `batch_number TEXT`, `manufacturing_date DATE`, `expiry_date DATE`, `landing_cost NUMERIC(12,2)`, `current_stock INT`, `active BOOL`.
4. `inventory_movements`: `movement_id UUID PK`, `medicine_id UUID FK`, `batch_id UUID FK`, `movement_type TEXT CHECK IN ('SALE', 'VOID_RETURN', 'PURCHASE_RECEIPT', 'MANUAL_ADD', 'MANUAL_REMOVE', 'STOCKTAKE_ADJUSTMENT')`, `quantity_delta INT`, `previous_quantity INT`, `new_quantity INT`, `reference_id UUID`, `reason TEXT`, `user_id UUID FK`, `created_at TIMESTAMPTZ`.
5. `cashier_shifts`: `shift_id UUID PK`, `user_id UUID FK`, `device_id TEXT`, `opened_at TIMESTAMPTZ`, `closed_at TIMESTAMPTZ`, `opening_float NUMERIC(12,2)`, `expected_cash NUMERIC(12,2)`, `actual_cash NUMERIC(12,2)`, `variance NUMERIC(12,2)`, `status TEXT CHECK IN ('OPEN', 'CLOSED', 'REVIEWED')`, `notes TEXT`.
6. `sales`: `sale_id UUID PK`, `receipt_number TEXT UNIQUE`, `shift_id UUID FK`, `customer_id UUID FK`, `cashier_id UUID FK`, `subtotal NUMERIC(12,2)`, `tax NUMERIC(12,2)`, `discount NUMERIC(12,2)`, `total_amount NUMERIC(12,2)`, `payment_status TEXT`, `status TEXT CHECK IN ('COMPLETED', 'VOIDED')`, `void_reason TEXT`, `voided_by UUID FK`, `created_at TIMESTAMPTZ`.
7. `sale_items`: `sale_item_id UUID PK`, `sale_id UUID FK`, `medicine_id UUID FK`, `batch_id UUID FK`, `quantity INT`, `unit_price NUMERIC(12,2)`, `unit_cost NUMERIC(12,2)`, `total_price NUMERIC(12,2)`.
8. `sale_payments`: `payment_id UUID PK`, `sale_id UUID FK`, `method TEXT CHECK IN ('CASH', 'MPESA', 'CARD', 'CREDIT')`, `amount NUMERIC(12,2)`, `reference TEXT`.
9. `suppliers`: `supplier_id UUID PK`, `name TEXT`, `contact_name TEXT`, `phone TEXT`, `email TEXT`, `active BOOL`.
10. `customers`: `customer_id UUID PK`, `name TEXT`, `phone TEXT UNIQUE`, `email TEXT`, `loyalty_points INT`, `credit_limit NUMERIC(12,2)`, `current_balance NUMERIC(12,2)`, `active BOOL`.
11. `expenses`: `expense_id UUID PK`, `category TEXT`, `description TEXT`, `amount NUMERIC(12,2)`, `payment_method TEXT`, `shift_id UUID FK`, `user_id UUID FK`, `created_at TIMESTAMPTZ`.
12. `sync_events` (Transactional Outbox): `seq BIGSERIAL PK`, `event_id UUID UNIQUE`, `idempotency_key TEXT UNIQUE`, `event_type TEXT`, `entity_type TEXT`, `entity_id TEXT`, `operation TEXT`, `payload JSONB`, `status TEXT CHECK IN ('PENDING', 'PROCESSING', 'SYNCED', 'FAILED')`, `retry_count INT`, `created_at TIMESTAMPTZ`.
13. `sync_inbound_commands`: `command_id UUID PK`, `idempotency_key TEXT UNIQUE`, `command_type TEXT`, `payload JSONB`, `status TEXT CHECK IN ('APPLIED', 'REJECTED')`, `applied_at TIMESTAMPTZ`, `result JSONB`, `error_message TEXT`.
14. `sync_status`: `key TEXT PRIMARY KEY`, `last_synced_seq BIGINT`, `last_success_at TIMESTAMPTZ`, `last_error TEXT`, `last_error_at TIMESTAMPTZ`.

---

## 4. Core Business Logic & Invariants

1. **Atomic Checkout & FEFO Depletion:**
   - Cashier checkout requires an active open shift in `cashier_shifts`.
   - All requested batches are locked via `SELECT ... FOR UPDATE` ordered by `batch_id` to prevent deadlocks.
   - Dispensing enforces First-Expired, First-Out (FEFO), picking the batch with the earliest valid expiry date.
   - Sales, batch decrements, inventory movements, cashier till balance increments, and outbox rows in `sync_events` MUST commit within a single atomic database transaction.
2. **Sales Voiding & Restocking Protocol:**
   - Voiding requires administrator authorization.
   - Batches are re-credited with the exact quantities originally sold. Restorative rows are recorded in `inventory_movements`, and a `SALE_VOIDED` outbox event is enqueued.
3. **Cashier Shift Balancing:**
   - Cashier declares opening float $F$.
   - System continuously tracks expected till cash: $\text{Expected} = F + \text{Cash Sales} - \text{Refunds} - \text{Till Expenses}$.
   - At shift end, cashier performs a **blind physical cash count** $A$. The system computes variance: $\text{Variance} = A - \text{Expected}$. Non-zero variances flag an administrative alert.
4. **Profit Margin Protection:**
   - System enforces $\text{selling\_price} \ge \text{min\_selling\_price} \ge \text{purchase\_price}$. Cashiers cannot discount below `min_selling_price`.

---

## 5. Offline-First Client & Hardware Peripherals

1. **Dexie.js In-Browser Fast Formulary:**
   - Replicates medicines, batches, categories, and customers into 15 IndexedDB stores.
   - Barcode scans query IndexedDB directly, yielding cart lookups in $<10\text{ms}$.
2. **Keyboard Wedge Barcode Scanner Listener:**
   - Captures rapid keystroke bursts ($<30\text{ms}$ interval) terminated by `\r` / `\n` without requiring focus on an input box, routing scanned barcodes straight into the active cart.
3. **ESC/POS Thermal Receipt Printing:**
   - Direct byte formatting for 80mm receipt printers (48 characters/line, bold shop headers, tax summaries, itemized columns, cut paper command).
4. **Electronic RJ11 Cash Drawer Kick:**
   - Emits 24V solenoid pulse command `Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA])` on cash checkout completion.

---

## 6. Cloud Database Schema & Multi-Tenant Partitioning (Supabase)

Create the following cloud infrastructure in Supabase:
1. `giga_cloud.shops`: `shop_id UUID PK`, `shop_code TEXT UNIQUE`, `name TEXT`, `token_hash TEXT NOT NULL`, `active BOOL`, `created_at TIMESTAMPTZ`, `last_seen_at TIMESTAMPTZ`.
2. `giga_cloud.online_users`: `user_id UUID PK`, `shop_id UUID REFERENCES giga_cloud.shops(shop_id)` (NULL for Global Multi-Shop Admin), `email TEXT UNIQUE`, `name TEXT`, `role TEXT`, `password_hash TEXT`, `active BOOL`.
3. `giga_cloud.medicines`, `medicine_batches`, `stock_levels`, `sales`, `cashier_shifts`: Base physical mirror tables, strictly partitioned with composite primary keys starting with `(shop_id, ...)`.
4. `giga_online.*` Views: Scoped tenant views querying `giga_cloud.*` with `WHERE shop_id = NULLIF(current_setting('giga.shop_id', true), '')::UUID`.
5. `giga_cloud.commands`: `command_id UUID PK`, `shop_id UUID FK`, `command_type TEXT`, `idempotency_key TEXT UNIQUE`, `payload JSONB`, `status TEXT CHECK IN ('PENDING', 'DELIVERED', 'APPLIED', 'REJECTED', 'EXPIRED')`, `created_by_user_id UUID`, `source TEXT`, `created_at TIMESTAMPTZ`, `delivered_at TIMESTAMPTZ`, `applied_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`, `result_summary JSONB`, `error_message TEXT`.
6. Stored Procedures (`SECURITY DEFINER`):
   - `gc_ingest_events(p_shop_id, p_shop_token, p_device_id, p_events)`: Verifies SHA-256 shop token hash, verifies idempotency keys, applies outbox events using Last-Write-Wins (LWW) sequence tracking, updates cloud mirror.
   - `gc_pull_commands(p_shop_id, p_shop_token, p_limit)`: Atomically locks and claims pending commands using `FOR UPDATE SKIP LOCKED`, marking them `DELIVERED`.
   - `gc_ack_command(p_shop_id, p_shop_token, p_command_id, p_status, p_result, p_error)`: Marks command as `APPLIED` or `REJECTED`.
   - `gc_get_inventory_fingerprint(p_shop_id)`: Returns SHA-256 hash of entire active catalog stock for parity checks.
   - `gc_apply_inventory_snapshot(p_shop_id, p_snapshot)`: Overwrites cloud stock levels with authoritative local ground truth if a parity mismatch is detected.

---

## 7. Synchronization Engine & Remote Command Lifecycle

1. **Transactional Outbox Worker (Local Server):**
   - Session-level advisory lock `SELECT pg_try_advisory_lock(7420317001)` elects single leader.
   - Drains `sync_events` in batches of 50 via `SELECT ... FOR UPDATE SKIP LOCKED`.
   - Posts batch to `POST /rest/v1/rpc/gc_ingest_events` over HTTPS with `apikey` and `Authorization: Bearer <ANON_KEY>`.
   - Updates local rows to `SYNCED` on success; applies capped exponential backoff ($5\text{s} \to 60\text{s}$) on failure without blocking local checkouts.
2. **Inbound Remote Command Replay (8-Step FSM):**
   - **Step 1:** Remote Admin submits action on Vercel (`POST /api/admin/commands/:action`).
   - **Step 2:** Preflight validates schema; generates idempotency key `cmd_${shopId}_${type}_${Date.now()}_${rand}`.
   - **Step 3:** Inserts row into `giga_cloud.commands` with `status = 'PENDING'`.
   - **Step 4:** Supabase Realtime CDC pushes WebSocket notification to local server; fallback adaptive polling (5–15s) guarantees discovery.
   - **Step 5:** Local worker calls `gc_pull_commands`, atomically locking rows and setting `DELIVERED`.
   - **Step 6:** Local worker begins local PostgreSQL transaction (`BEGIN`), checks `sync_inbound_commands` idempotency, executes mutation using local business logic functions, writes to `sync_inbound_commands`, enqueues outbox event, and commits (`COMMIT`).
   - **Step 7:** Local worker calls `gc_ack_command`, updating cloud command to `APPLIED`.
   - **Step 8:** Outbox worker ships generated event upstream to `gc_ingest_events`, instantly updating `giga_cloud.*` so the Vercel dashboard reflects the change.
3. **Supported Remote Command Types (15 Types):**
   `STOCK_ADD`, `STOCK_REMOVE`, `STOCK_OVERRIDE_ADD`, `STOCK_OVERRIDE_REMOVE`, `MEDICINE_CREATE`, `MEDICINE_UPDATE`, `PRICE_UPDATE`, `SUPPLIER_CREATE`, `SUPPLIER_UPDATE`, `CUSTOMER_CREATE`, `CUSTOMER_UPDATE`, `EXPENSE_RECORD`, `RETURN_APPROVE`, `RETURN_REJECT`, `SALE_VOID`.
4. **Self-Healing Parity Engine:**
   - Every 120 seconds, local worker computes:
     $$\text{Hash}_{\text{Local}} = \text{SHA256}(\sum \text{Sort}(\text{medicine\_id} \mathbin{\Vert} \text{batch\_id} \mathbin{\Vert} \text{quantity}))$$
   - Compares against `gc_get_inventory_fingerprint`. If hashes diverge, publishes authoritative local snapshot to self-heal cloud mirror.

---

## 8. Windows 11 Production Deployment & Supervision

1. **Auto-Start Service Runner (`deployment/windows/service-runner.ps1`):**
   - Binds to Windows Task Scheduler as task `GigaChemistPOS_Service` with trigger `At Startup` (runs headlessly before cashier login).
   - Verifies port 3000 singleton status (kills orphan Node processes).
   - Polls PostgreSQL `127.0.0.1:5432` up to 60s; restarts `postgresql-x64-16` service if unresponsive.
   - Verifies production web bundle (`dist/index.html`).
   - Spawns Node.js with output redirected to rolling daily logs (`logs/server.log`).
2. **Watchdog Supervisor (`deployment/windows/watchdog.ps1`):**
   - Probes `http://127.0.0.1:3000/api/health` every 30 seconds; auto-restarts application if 3 consecutive pings fail or process memory exceeds 1.5 GB.
3. **Automated Ops Backups (`server/ops/backup.ts`):**
   - Scheduled `pg_dump` daily at 23:00, compressed and encrypted, with retention of 14 daily and 8 weekly backup files.

---

## 9. Verification & Smoke Testing Protocol

Implement integration tests verifying:
1. **Local LAN Checkout:** Dispense items locally; verify $<60\text{ms}$ commit, batch decrement, and receipt print.
2. **Offline Resilience:** Unplug WAN cable; execute 5 sales; verify uninterrupted checkouts and queued `PENDING` outbox events.
3. **Auto-Catchup Sync:** Reconnect WAN; verify worker drains outbox within 3s and transitions events to `SYNCED`.
4. **Remote Admin Execution:** Issue `PRICE_UPDATE` on Vercel; observe claim, local transaction commit, ACK, and cloud mirror reflection.
5. **Parity Self-Healing:** Inject intentional divergence into cloud database; verify automated detection and snapshot correction within 120s.
6. **Cash Drawer Kick:** Verify 24V pulse command fires upon cash tender finalization.

---
*Now implement this complete system with clean, modular, production-ready code, strict TypeScript typing, database migrations, and robust error handling.*
