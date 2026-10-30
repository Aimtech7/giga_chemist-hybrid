# Software Requirements Specification (SRS)
## GIGA CHEMIST — Local-Server & Hybrid Offline-First Pharmacy Management System

**Document Identifier:** GIGA-SRS-LOCAL-V2.0  
**Document Version:** 2.0.0 (Comprehensive Production Specification with Cloud Protocols, Command Lifecycle & Full Installation Blueprint)  
**Status:** Approved / Historical & Operational Standard  
**System Classification:** On-Premises Master Server + Local LAN Counter Terminals + Asynchronous Outbox Cloud Mirror  
**Authoritative Scope:** Local PostgreSQL (On-Premises Windows 11 Master) + Supabase Cloud PostgreSQL (Port 6543) + Vercel Remote Admin Engine  
**Repository:** `b:\GIGA-CHEMIST-POS`

---

## 1. Introduction

### 1.1 Purpose
This document provides an exhaustive, formal specification of the software requirements for the **GIGA CHEMIST Local-Server and Hybrid Offline-First Pharmacy System**. It establishes the complete architectural, functional, data, interface, hardware, cryptographic, multi-branch, and deployment requirements that governed the system when an **on-premises master PC per pharmacy branch** hosted the authoritative PostgreSQL database and application engine.

This document serves as the permanent, authoritative blueprint for on-premises pharmacy deployments, disaster-recovery re-installations, hardware peripheral integrations, cloud synchronization protocols, and comparative evaluations against modern cloud-native architectures.

### 1.2 Scope & Core Mandate
The primary mandate of the local-server architecture is **absolute operational autonomy under complete network isolation**:
1. **Zero-Internet Operational Continuity:** The pharmacy point of sale, dispensing workflows, cashier shifts, inventory adjustments, and physical receipt printing operate continuously without degradation, regardless of whether internet access is absent, intermittent, high-latency, or completely severed for months.
2. **Local PostgreSQL Authority:** The on-premises database (`127.0.0.1:5432`) is the single authoritative master for all inventory balances, batch records, user credentials, shifts, and financial ledgers within each physical shop.
3. **LAN Multi-Terminal Operation:** A single master server PC serves multiple client counter terminals and tablet devices within the shop over the local area network (LAN) with sub-millisecond response times.
4. **Hybrid Outbox Cloud Mirroring:** When internet connectivity is available, an asynchronous background worker syncs committed transactions to Supabase Cloud (`giga_cloud.*`), maintains cryptographic inventory parity, and polls for remote administration commands.
5. **Multi-Branch Multi-Shop Isolation:** Multiple independent physical branches (Shop 1, Shop 2) operate autonomously on their own local servers while synchronizing to a unified cloud database strictly partitioned by `shop_id`.
6. **Remote Administration Bridge:** An online web console (`https://gigachem.vercel.app`) allows the pharmacy owner to remotely manage catalogs, adjust stock, review shifts, and update pricing through an asynchronous command queue that respects local transaction locks.

### 1.3 Definitions, Acronyms, and Abbreviations
- **ACID:** Atomicity, Consistency, Isolation, Durability.
- **Advisory Lock:** A PostgreSQL session-level application lock (`pg_try_advisory_lock`) used to elect a single sync leader process per physical node.
- **ATC:** Anatomical Therapeutic Chemical classification system.
- **COGS:** Cost of Goods Sold ($\text{Unit Cost} \times \text{Quantity Sold}$).
- **Dexie.js / IndexedDB:** The client-side browser object database caching formularies for sub-millisecond barcode scanning.
- **ESC/POS:** Standardized printer command language for thermal receipt printers.
- **FEFO:** First-Expired, First-Out (stock allocation prioritizing the earliest expiring pharmaceutical batch).
- **HID:** Human Interface Device (standard barcode scanner operating in keyboard emulation mode).
- **LAN:** Local Area Network (IPv4 private subnet, e.g., `192.168.1.0/24`).
- **LWW:** Last-Write-Wins conflict resolution strategy driven by monotonic sequence numbers and timestamps.
- **Outbox Pattern:** Transactional design where state mutations and outgoing sync packets are written in the same atomic database transaction.
- **PWA:** Progressive Web Application.
- **REST RPC:** Remote Procedure Call invoked over HTTPS against Supabase PostgREST endpoints (`/rest/v1/rpc/*`).
- **UUIDv4:** Universally Unique Identifier (RFC 4122).
- **WAL:** Write-Ahead Logging (PostgreSQL durability engine).

---

## 2. Overall Description & System Architecture

### 2.1 Multi-Shop Physical & Cloud Topology

The system comprises three physical tiers: Local Master Workstations, Local LAN Clients, and Centralized Supabase Cloud Infrastructure.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              PHARMACY PHYSICAL PREMISES                                │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ PRIMARY SERVER WORKSTATION (Windows 11 Pro 64-bit)                             │   │
│   │                                                                                │   │
│   │   [ Task Scheduler: GigaChemistPOS_Service ]                                  │   │
│   │        │                                                                       │   │
│   │        ▼                                                                       │   │
│   │   [ service-runner.ps1 / watchdog.ps1 ]                                        │   │
│   │        │                                                                       │   │
│   │        ├─► [ PostgreSQL 16 Service (127.0.0.1:5432) ]                          │   │
│   │        │    ├── Database: giga_chemist (Authoritative Master)                  │   │
│   │        │    └── Storage: Local NVMe SSD (WAL + Backups)                        │   │
│   │        │                                                                       │   │
│   │        ├─► [ Node.js 20 LTS Backend Engine (server.ts) ]                       │   │
│   │        │    ├── Express API: http://0.0.0.0:3000                               │   │
│   │        │    ├── Background Sync Worker (Advisory Lock: 7420317001)             │   │
│   │        │    ├── Automated Backup Daemon (server/ops/backup.ts)                 │   │
│   │        │    └── Local Email Queue (server/email/service.ts)                    │   │
│   │        │                                                                       │   │
│   │        └─► [ Primary Cashier Terminal PWA (http://localhost:3000) ]            │   │
│   │             ├── Hardware: USB Thermal Printer (ESC/POS 80mm)                   │   │
│   │             ├── Hardware: RJ11 Cash Drawer Kick (ESC p 0 25 250)               │   │
│   │             └── Hardware: USB Barcode Scanner (HID Keystroke Buffer)           │   │
│   └────────────────────────┬───────────────────────────────────────────────────────┘   │
│                            │ Private LAN Subnet (Ethernet / Wi-Fi Router)              │
│                            ▼                                                           │
│   ┌────────────────────────────────────────────────┐  ┌────────────────────────────┐   │
│   │ SECONDARY COUNTER TERMINAL (PC 2)              │  │ DISPENSARY TABLET (Wi-Fi)  │   │
│   │ - Browser PWA: http://192.168.1.100:3000       │  │ - Mobile PWA Browser       │   │
│   │ - Dexie IndexedDB In-Browser Cache             │  │ - Formulary Search         │   │
│   │ - Dedicated USB Barcode Scanner                │  │ - Physical Stock Counting  │   │
│   └────────────────────────────────────────────────┘  └────────────────────────────┘   │
└────────────────────────────────────┬───────────────────────────────────────────────────┘
                                     │ WAN / Internet Gateway (Optional & Asynchronous)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SUPABASE CLOUD INFRASTRUCTURE                                   │
│                                                                                        │
│   ┌────────────────────────────────────────────────┐  ┌────────────────────────────┐   │
│   │ Supabase PostgreSQL Mirror (Port 6543)         │  │ Remote Admin Web Console   │   │
│   │ - Schema: giga_cloud.* (Replicated Mirror)     │  │ (Owner Laptop / Phone)     │   │
│   │ - Views: giga_online.*                         │  │                            │   │
│   │ - Outbox Destination: gc_ingest_events         │  │ - Views Mirror Reports     │   │
│   │ - Inbound Commands: giga_cloud.commands        │  │ - Queues Remote Changes    │   │
│   │ - Parity Verification: gc_get_inventory_finger │  │   (PENDING state)          │   │
│   │ - Self-Healing: gc_apply_inventory_snapshot    │  │                            │   │
│   └────────────────────────────────────────────────┘  └────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 System Invariants & Architectural Rules
1. **Local Authoritative Rule:** No remote network request may block a cashier from completing a sale. Network requests are strictly dispatched asynchronously by background workers.
2. **Atomic Depletion Rule:** A sale, its batch-level inventory decrement, the financial ledger entry, and the corresponding `sync_events` outbox record occur within the exact same database transaction. A sale cannot commit without its outbox event.
3. **Optimistic Local Cache Invariant:** The client browser cache (Dexie IndexedDB) is an optimistic read-through cache. The local server's PostgreSQL engine is the authoritative source of truth. If client IndexedDB drifts, a background re-sync overwrites IndexedDB with PostgreSQL records.
4. **Idempotent Inbound Execution:** Any command originating from the remote cloud application is tracked in `sync_inbound_commands` with a unique idempotency key. A delivered command cannot be executed twice under any circumstances.
5. **Strict Multi-Shop Isolation:** Under no circumstances may Shop 1 and Shop 2 cross-contaminate their local databases. Local database connection configurations (`giga_chemist` vs. `giga_chemist_shop2`) are strictly tied to their registered `SHOP_ID` and verified during server boot.
6. **No Phantom Negative Stock:** Inventory decrements enforce physical bounds checks. Stock cannot be sold below zero unless explicit emergency override configurations are authorized by an administrator.


---

## 3. Exhaustive Functional Requirements

```mermaid
graph LR
    subgraph Core Functional Groups
        G1["Core Formulary & Batches (FR-01 to FR-06)"]
        G2["Inventory Control & Sales (FR-07 to FR-12)"]
        G3["Entities & Operations (FR-13 to FR-17)"]
        G4["Hardware & Client (FR-18 to FR-20)"]
        G5["Sync, Backup & Supervision (FR-21 to FR-25)"]
    end
```

---

### FR-01: Local Server Initialization, Auto-Start & Service Supervision
- **Implementation:** `deployment/windows/service-runner.ps1`, `watchdog.ps1`, Windows Task Scheduler (`GigaChemistPOS_Service`).
- **Startup Protocol:**
  1. Boot trigger initiates execution upon Windows startup without requiring user login (`Run whether user is logged on or not`).
  2. Singleton guard scans TCP port 3000 via `Get-NetTCPConnection`; terminates orphan Node processes holding the port.
  3. Database readiness loop polls `127.0.0.1:5432` up to 60 seconds; if unreachable, attempts `Restart-Service postgresql-x64-16`.
  4. Verifies production web bundle integrity (`dist/index.html` and asset hashes).
  5. Launches Node.js production server with stdout and stderr redirected to rolling daily logs (`logs/server.log`).
- **Supervision & Crash Recovery:** `watchdog.ps1` pings `http://127.0.0.1:3000/api/health` every 30 seconds; restarts the process if 3 consecutive pings fail or memory exceeds 1.5 GB.

### FR-02: User Authentication & Salted PBKDF2/PIN Verification
- **Endpoints:** `POST /api/auth/login`, `POST /api/auth/pin-login`, `GET /api/auth/me`, `POST /api/auth/logout`.
- **Entities:** `users` (`user_id`, `username`, `email`, `password_hash`, `pin_hash`, `salt`, `role`, `active`).
- **Cryptographic Protocol:** Passwords hashed with PBKDF2 (100,000 iterations, SHA-512, 32-byte salt). Quick cashier switching uses 4-to-6 digit numeric PINs verified using `crypto.timingSafeEqual` against salted hashes.
- **Session Handling:** Signs JWT containing `user_id`, `role`, `shop_id`, and session nonce with 24-hour expiration stored in `HttpOnly`, `SameSite=Lax` cookies.

### FR-03: Centralized User Administration & Access Control
- **Endpoints:** `GET /api/users`, `POST /api/users`, `PUT /api/users/:id`, `PATCH /api/users/:id/role`, `PATCH /api/users/:id/status`, `POST /api/users/:id/pin`.
- **Role Hierarchy:** `ADMIN` (full access, configuration, voids, pricing), `PHARMACIST` (dispensing, stock receiving, reorders), `CASHIER` (POS checkout, till drawer operations, shift closure).
- **Security Rules:** Soft-deletion via `active = false` preserves historical foreign key integrity on audit and shift logs. Password resets immediately revoke all active JWT sessions in `user_sessions`.

### FR-04: Pharmaceutical Formulary & Medicine Master Catalog
- **Endpoints:** `GET /api/medicines`, `POST /api/medicines`, `PUT /api/medicines/:id`, `POST /api/medicines/:id/delete-preflight`, `DELETE /api/medicines/:id`.
- **Attributes:** Trade name, generic name, barcode (EAN-13/UPC), SKU, category, therapeutic class, unit of measure, reorder level, prescription required flag, active ingredients.
- **Preflight Deletion Guard:** Endpoint `POST /api/medicines/:id/delete-preflight` verifies that physical batch stock is 0 and no sales exist within the active financial year before allowing archiving.

### FR-05: Multi-Tier Pricing & Profit Margin Protection
- **Endpoints:** `PATCH /api/medicines/:id/pricing`, `GET /api/price-history`.
- **Pricing Fields:** `selling_price` (Retail), `wholesale_price` (Bulk/Trade), `min_selling_price` (Floor price below which cashiers cannot discount), `purchase_price` (Latest landing cost).
- **Integrity Rule:** Enforces $\text{selling\_price} \ge \text{min\_selling\_price} \ge \text{purchase\_price}$. All adjustments log old price, new price, user ID, and timestamp into `price_history`.

### FR-06: Batch Tracking, FEFO Rotation & Expiry Management
- **Endpoints:** `GET /api/batches`, `POST /api/batches`, `PATCH /api/batches/:id/expiry`.
- **Batch Metadata:** Batch number, manufacturing date, expiry date, landing cost, current quantity.
- **FEFO Allocation Protocol:** Point of sale carts automatically allocate units from the earliest expiring batch with positive quantity. Batches are flagged:
  - `VALID`: Expiry $> 90$ days.
  - `EXPIRING_SOON`: Expiry $\le 90$ days and $> 0$ days.
  - `EXPIRED`: Expiry $\le 0$ days (dispensing blocked by POS checkout validator).

### FR-07: Real-Time Inventory Control & Direct Stock Adjustments
- **Endpoints:** `POST /api/inventory/set-stock`, `POST /api/inventory/add-stock`, `POST /api/inventory/remove-stock`, `GET /api/inventory/movements`.
- **Adjustment Protocol:**
  1. Opens transaction `BEGIN`.
  2. Acquires row lock via `SELECT current_stock FROM medicine_batches WHERE batch_id = $1 FOR UPDATE`.
  3. Computes delta ($\Delta = \text{New} - \text{Current}$).
  4. Updates batch quantity and parent medicine total stock.
  5. Inserts audit row into `inventory_movements` (`movement_type`, `quantity_delta`, `reason`, `user_id`).
  6. Enqueues outbox record in `sync_events`.
  7. Commits transaction `COMMIT`.

### FR-08: Inventory Intelligence & Automated Reorder Suggestions
- **Endpoints:** `GET /api/inventory/insights/fast-moving`, `GET /api/inventory/insights/slow-moving`, `GET /api/inventory/insights/dead-stock`, `GET /api/inventory/insights/reorder`.
- **Mathematical Formulations:**
  - **Consumption Velocity:** $V_{30} = \frac{\sum_{d=1}^{30} Q_{\text{sold}}}{30}$ units/day.
  - **Stock Depletion Days:** $D = \frac{\text{Current Stock}}{V_{30}}$.
  - **Reorder Threshold:** Triggered when $\text{Current Stock} \le \text{reorder\_level}$.
  - **Suggested Order Quantity:** $Q_{\text{reorder}} = (2 \times \text{reorder\_level}) - \text{Current Stock}$.

### FR-09: Point of Sale Checkout & Atomic Transaction Depletion
- **Endpoints:** `POST /api/sales/checkout`, `GET /api/sales/today-summary`.
- **Transaction Protocol:**
  1. Validates that cashier has an open till shift in `cashier_shifts`.
  2. Locks each requested batch row in alphabetical sequence of `batch_id` (preventing deadlocks).
  3. Verifies stock availability; rejects with HTTP 409 if insufficient.
  4. Inserts parent record into `sales` (`sale_id`, `shift_id`, `subtotal`, `tax`, `discount`, `total_amount`, `payment_status`).
  5. Inserts line items into `sale_items` and payment tenders into `sale_payments` (Cash, M-Pesa, Card).
  6. Decrements batch and medicine stock quantities.
  7. Inserts corresponding rows into `inventory_movements`.
  8. Enqueues `SALE_COMPLETED` record into `sync_events`.
  9. Commits transaction. Total elapsed execution: $< 60\text{ms}$.

### FR-10: Sales Voiding & Restocking Protocol
- **Endpoints:** `POST /api/sales/:id/void`.
- **Void Protocol:** Requires `ADMIN` authorization. Restores line item quantities to their original batches, updates parent sale status to `VOIDED`, records void reason and authorized user ID, writes restocking entries to `inventory_movements`, and emits `SALE_VOIDED` outbox event.

### FR-11: Cashier Shift Management, Till Tracking & Cash Variance
- **Endpoints:** `GET /api/shifts/current`, `POST /api/shifts/open`, `POST /api/shifts/:id/close`, `POST /api/shifts/:id/review`.
- **Reconciliation Protocol:**
  - **Opening Shift:** Cashier declares opening cash float ($F$).
  - **Shift Operations:** System tracks cash sales ($C$), cash customer refunds ($R$), and petty cash expenses ($E$) disbursed from till.
  - **Closing Blind Count:** Cashier physically counts physical cash in drawer ($A$) without knowing the system expectation.
  - **Variance Calculation:**
    $$\text{Expected Cash} = F + C - R - E$$
    $$\text{Variance} = A - \text{Expected Cash}$$
  - **Discrepancy Flags:** Any non-zero variance triggers an administrative review alert.

### FR-12: Formal Stocktake Sessions & Discrepancy Reconciliation
- **Endpoints:** `POST /api/stocktakes`, `POST /api/stocktakes/:id/start`, `PUT /api/stocktakes/:id/lines/:lineId`, `POST /api/stocktakes/:id/submit`, `POST /api/stocktakes/:id/approve`.
- **Workflow:** Freezes expected inventory baseline snapshot; cashiers perform physical barcode counting; system computes discrepancies ($\text{Counted} - \text{Expected}$); Admin reviews variance value; on approval, automatically writes adjusting movements to restore parity.

### FR-13: Customer Directory & Store Credit Ledger
- **Endpoints:** `GET /api/customers`, `POST /api/customers`, `PUT /api/customers/:id`, `GET /api/customers/:id/ledger`.
- **Features:** Patient medical history, allergy alerts, chronic condition tags, and store credit ledger tracking credit purchases, partial payments, and overdue balances.

### FR-14: Supplier Directory & Purchase Order Ingestion
- **Endpoints:** `GET /api/suppliers`, `POST /api/suppliers`, `GET /api/purchases`, `POST /api/purchases`, `POST /api/purchases/:id/receive`.
- **Purchase Ingestion Protocol:** Ingests wholesale invoices, auto-creates new batch numbers with manufacturing/expiry dates, updates landing cost, and increments stock levels upon receipt verification.

### FR-15: Customer Returns Management & Inspection Workflow
- **Endpoints:** `GET /api/returns`, `POST /api/returns`, `POST /api/returns/:id/approve`, `POST /api/returns/:id/reject`.
- **Inspection Protocol:** Pharmacist inspects returned medications; designates disposition (`RESTOCK` if packaging intact and cold chain maintained, `QUARANTINE`, or `DESTROY`); approves refund disbursement.

### FR-16: Operational Overhead & Expense Tracking
- **Endpoints:** `GET /api/expenses`, `POST /api/expenses`, `POST /api/expenses/:id/void`.
- **Expense Accounting:** Categorizes operational disbursements (Utilities, Salaries, Deliveries, Packaging). If payment method is `TILL_CASH`, automatically deducts outlay from current cashier shift drawer balance.

### FR-17: Business Day Summary & Financial Reporting
- **Endpoints:** `GET /api/reports/summary`, `GET /api/reports/sales-by-category`, `GET /api/reports/profit-loss`.
- **Financial Aggregation:** Computes gross revenue, sales tax collected, COGS, gross margin, net profit after expenses, and tender breakdown (Cash vs. M-Pesa vs. Card).

### FR-18: Local Hardware Peripherals — ESC/POS Thermal Printing & Cash Drawer
- **Interface:** Direct byte streaming via USB, Serial COM, or Local Network raw port 9100.
- **ESC/POS Formatting:** 80mm / 48-character formatting, thermal font selection, bold headers, itemized price tables, tax summary, QR code generation.
- **Drawer Kick Command:** Transmits 5-byte pulse sequence `0x1B, 0x70, 0x00, 0x19, 0xFA` (24V 50ms solenoid pulse) upon cash sale completion.

### FR-19: Barcode Scanner Input Handling & Buffer Emulation
- **Interface:** Captures hardware keyboard emulation bursts ($<30\text{ms}$ inter-keystroke timing) terminated by carriage return (`\r` / `\n`).
- **Processing:** Bypasses active input focus traps; immediately routes scan buffer to Dexie IndexedDB fast lookup; appends identified batch directly to the active POS cart.

### FR-20: Offline-First Dexie IndexedDB In-Browser Engine
- **Engine:** 15 IndexedDB stores caching medicines, batches, customers, categories, settings, and pending local events.
- **Performance:** Sub-10ms UI reactivity and offline search capability on low-spec counter client PCs.

### FR-21: Transactional Outbox Pattern & Background Sync Worker
- **Table:** `sync_events` (`seq BIGSERIAL`, `event_id UUID`, `event_type TEXT`, `payload JSONB`, `status TEXT`, `retry_count INT`).
- **Leader Election:** Local server runs `SELECT pg_try_advisory_lock(7420317001)` to ensure only one worker drains the outbox across multi-process clusters.
- **Draining Protocol:** Batches up to 50 pending events, sends via HTTPS RPC `gc_ingest_events`, updates status to `SYNCED` on HTTP 200.

### FR-22: Inbound Cloud Command Execution & Idempotency Replay
- **Table:** `sync_inbound_commands` (`command_id UUID`, `idempotency_key TEXT`, `command_type TEXT`, `status TEXT`, `result JSONB`).
- **Replay Protection:** Worker claims pending commands from cloud via `gc_pull_commands`; verifies `idempotency_key`; executes mutation inside a local transaction; sends ACK back to cloud via `gc_ack_command`.

### FR-23: Authoritative Inventory Fingerprint & Self-Healing Mirror
- **Protocol:** Every 120 seconds, local worker computes SHA-256 fingerprint across all medicine batch stock balances:
  $$\text{Hash} = \text{SHA256}(\sum \text{Sort}(\text{medicine\_id} \mathbin{\Vert} \text{batch\_id} \mathbin{\Vert} \text{quantity}))$$
- **Parity Audit:** Calls `gc_get_inventory_fingerprint`. If cloud hash diverges, publishes authoritative snapshot via `gc_apply_inventory_snapshot` to self-heal the cloud mirror.

### FR-24: Telemetry Heartbeats, Machine Health & Local Alert Center
- **Endpoints:** `/api/alerts`, `/api/admin/health`.
- **Payload:** Machine CPU usage, memory utilization, disk free space guard ($> 2\text{GB}$ required), PostgreSQL active connection pool count, and outbox lag.

### FR-25: Automated Database Backups, Restore Drills & Retention Daemon
- **Module:** `server/ops/backup.ts`.
- **Automation:** Scheduled native `pg_dump` executed daily at 23:00 local time. Backups compressed with gzip, encrypted with AES-256, and retained:
  - 14 daily backup snapshots (`BACKUP_KEEP=14`).
  - 8 weekly archives (`BACKUP_KEEP_WEEKLY=8`).


---

## 4. Multi-Shop Operations, Local-to-Cloud Sync & Data Flow Workflows

### 4.1 Multi-Shop Architecture & Partitioning Topology (Shop 1 & Shop 2 to Cloud)

This diagram details the physical deployment across two independent pharmacy branches (Shop 1 in Kitale and Shop 2 in Eldoret), showing their autonomous local master servers, on-premises LANs, independent outbox workers, and their secure, partitioned aggregation inside Supabase Cloud.

```mermaid
graph TD
    subgraph S1["PHYSICAL PREMISES: SHOP 1 (Kitale Main Branch)"]
        S1_LAN["Local Private LAN (192.168.1.0/24)"]
        S1_SRV["Master Server PC (Windows 11)"]
        S1_PG[("Local PostgreSQL 16
(127.0.0.1:5432)
DB: giga_chemist
shop_id: c2a1...32f")]
        S1_OUTBOX["Transactional Outbox
(sync_events)"]
        S1_WORKER["Background Sync Worker
(Leader Lock: 7420317001)"]
        S1_T1["Counter Till 1 (localhost:3000)"]
        S1_T2["Counter Till 2 (192.168.1.102:3000)"]
    end

    subgraph S2["PHYSICAL PREMISES: SHOP 2 (Eldoret Branch)"]
        S2_LAN["Local Private LAN (192.168.2.0/24)"]
        S2_SRV["Master Server PC (Windows 11)"]
        S2_PG[("Local PostgreSQL 16
(127.0.0.1:5432)
DB: giga_chemist_shop2
shop_id: e8d4...91b")]
        S2_OUTBOX["Transactional Outbox
(sync_events)"]
        S2_WORKER["Background Sync Worker
(Leader Lock: 7420317001)"]
        S2_T1["Counter Till 1 (localhost:3000)"]
        S2_T2["Counter Till 2 (192.168.2.102:3000)"]
    end

    subgraph CLOUD["CENTRAL SUPABASE CLOUD (Multi-Tenant Master Hub)"]
        CLOUD_RPC["Supabase RPC API Gateways (Port 6543)"]
        CLOUD_MIRROR[("Cloud PostgreSQL Mirror Tables (giga_cloud.*)")]
        
        CLOUD_S1_PART["SHOP 1 PARTITION (shop_id = c2a1...)
- medicines, batches, stock_levels
- sales, cashier_shifts, movements"]
        
        CLOUD_S2_PART["SHOP 2 PARTITION (shop_id = e8d4...)
- medicines, batches, stock_levels
- sales, cashier_shifts, movements"]
        
        CLOUD_CMD["Command Queue
(giga_cloud.commands)"]
    end

    subgraph ADMIN["REMOTE GLOBAL CONTROL CENTER"]
        WEB_APP["Vercel Cloud App: https://gigachem.vercel.app"]
        SCOPE_SEL["Scope Toggle:
[ Shop 1 | Shop 2 | All Shops (Consolidated) ]"]
    end

    %% Shop 1 Internal LAN
    S1_T1 -->|HTTP Rest| S1_SRV
    S1_T2 -->|LAN HTTP| S1_SRV
    S1_SRV -->|TCP| S1_PG
    S1_PG -->|Writes Committed| S1_OUTBOX
    S1_WORKER -->|Claims Batch 50| S1_OUTBOX

    %% Shop 2 Internal LAN
    S2_T1 -->|HTTP Rest| S2_SRV
    S2_T2 -->|LAN HTTP| S2_SRV
    S2_SRV -->|TCP| S2_PG
    S2_PG -->|Writes Committed| S2_OUTBOX
    S2_WORKER -->|Claims Batch 50| S2_OUTBOX

    %% Upstream to Cloud
    S1_WORKER -->|HTTPS RPC: gc_ingest_events(shop1_token)| CLOUD_RPC
    S2_WORKER -->|HTTPS RPC: gc_ingest_events(shop2_token)| CLOUD_RPC
    
    CLOUD_RPC --> CLOUD_MIRROR
    CLOUD_MIRROR --> CLOUD_S1_PART
    CLOUD_MIRROR --> CLOUD_S2_PART

    %% Remote Administration
    WEB_APP --> SCOPE_SEL
    SCOPE_SEL -->|Queue Command (PENDING)| CLOUD_CMD
    CLOUD_CMD -.->|gc_pull_commands(shop1_id)| S1_WORKER
    CLOUD_CMD -.->|gc_pull_commands(shop2_id)| S2_WORKER
```

---

### 4.2 Bidirectional Data Pipeline (Local-to-Cloud & Cloud-to-Local)

This flowchart illustrates the life cycle of data: how local dispensing and stock events travel upstream to the cloud mirror, and how remote administrative commands travel downstream, undergo local replay, and report execution results.

```mermaid
flowchart TD
    subgraph OUTBOUND["1. OUTBOUND DATA PIPELINE (Local Shop -> Cloud)"]
        O1["Cashier Completes Sale / Stock Adjusted Locally"] --> O2["Local DB Transaction (BEGIN)"]
        O2 --> O3["Write Business Rows (sales, sale_items, movements)"]
        O3 --> O4["Write Outbox Row (sync_events, status='PENDING')"]
        O4 --> O5["Local DB Transaction (COMMIT) - Immediate Cashier Result"]
        O5 --> O6["Background Sync Worker Drains Outbox (Batch of 50)"]
        O6 --> O7{"Internet Connection Available?"}
        O7 -->|No| O8["Increment Attempt Count & Apply Exponential Backoff"]
        O8 --> O6
        O7 -->|Yes| O9["POST HTTPS RPC /rpc/gc_ingest_events"]
        O9 --> O10["Cloud Validates Shop Token & Ingests Events"]
        O10 --> O11["Cloud Updates giga_cloud.* Tables"]
        O11 --> O12["Worker Updates Local sync_events: status='SYNCED'"]
    end

    subgraph INBOUND["2. INBOUND DATA PIPELINE (Cloud Remote Admin -> Local Shop)"]
        I1["Remote Admin Issues Change (e.g., Update Price, Set Stock)"] --> I2["Insert Command into giga_cloud.commands (status='PENDING')"]
        I2 --> I3["Local Sync Worker Polls: gc_pull_commands(shop_id)"]
        I3 --> I4{"Has Local DB Already Executed Idempotency Key?"}
        I4 -->|Yes (Duplicate)| I5["Acknowledge Cloud Immediately (gc_ack_command)"]
        I4 -->|No (New Command)| I6["Open Local PostgreSQL Transaction (BEGIN)"]
        I6 --> I7["Execute Command Mutation on Local Formulary / Stock"]
        I7 --> I8["Insert Record into sync_inbound_commands (status='APPLIED')"]
        I8 --> I9["Insert Row into sync_events (event_type='LOCAL_STATE_MUTATED')"]
        I9 --> I10["Commit Local Transaction (COMMIT)"]
        I10 --> I11["Send ACK to Cloud RPC: gc_ack_command(status='APPLIED')"]
        I11 --> I12["Cloud Updates giga_cloud.commands (status='APPLIED')"]
    end
```

---

### 4.3 Concurrent Multi-Shop Dispensing & Parallel Cloud Mirroring

This sequence diagram proves how Shop 1 and Shop 2 operate **simultaneously and independently**. Transactions execute with zero cross-shop crosstalk, zero shared bottlenecks, and parallel upstream replication.

```mermaid
sequenceDiagram
    autonumber
    actor Cashier1 as Cashier (Shop 1)
    participant S1_DB as Shop 1 Local DB
    participant S1_Sync as Shop 1 Sync Worker
    participant Cloud as Supabase Cloud (Port 6543)
    participant S2_Sync as Shop 2 Sync Worker
    participant S2_DB as Shop 2 Local DB
    actor Cashier2 as Cashier (Shop 2)

    par Parallel Local Transactions
        Cashier1->>S1_DB: POST /sales/checkout (Sell 2x Amoxicillin)
        S1_DB->>S1_DB: BEGIN -> Decrement Stock -> Write Sale -> Write Outbox -> COMMIT
        S1_DB-->>Cashier1: 201 Created (Receipt Printed in 40ms)
    and
        Cashier2->>S2_DB: POST /sales/checkout (Sell 1x Paracetamol)
        S2_DB->>S2_DB: BEGIN -> Decrement Stock -> Write Sale -> Write Outbox -> COMMIT
        S2_DB-->>Cashier2: 201 Created (Receipt Printed in 45ms)
    end

    Note over S1_Sync,S2_Sync: Local Sync Workers wake on interval or outbox notification

    par Parallel Outbox Drainage to Cloud
        S1_Sync->>S1_DB: SELECT * FROM sync_events WHERE status='PENDING' FOR UPDATE SKIP LOCKED
        S1_Sync->>Cloud: POST /rpc/gc_ingest_events (Shop 1 Batch, shop_id=c2a1...)
        Cloud->>Cloud: Ingest events into giga_cloud.* (Shop 1 Partition)
        Cloud-->>S1_Sync: 200 OK { processed: 1, failed: 0 }
        S1_Sync->>S1_DB: UPDATE sync_events SET status='SYNCED'
    and
        S2_Sync->>S2_DB: SELECT * FROM sync_events WHERE status='PENDING' FOR UPDATE SKIP LOCKED
        S2_Sync->>Cloud: POST /rpc/gc_ingest_events (Shop 2 Batch, shop_id=e8d4...)
        Cloud->>Cloud: Ingest events into giga_cloud.* (Shop 2 Partition)
        Cloud-->>S2_Sync: 200 OK { processed: 1, failed: 0 }
        S2_Sync->>S2_DB: UPDATE sync_events SET status='SYNCED'
    end
```

---

### 4.4 Global Remote Administration: Broadcast vs. Targeted Command Execution

Demonstrates how a remote pharmacy owner issues a targeted change to a single branch versus fanning out a broadcast catalog change across all registered branches.

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Remote Admin (Web App)
    participant Cloud as Supabase Cloud (giga_cloud.commands)
    participant S1_Worker as Shop 1 Sync Worker
    participant S1_DB as Shop 1 Local DB
    participant S2_Worker as Shop 2 Sync Worker
    participant S2_DB as Shop 2 Local DB

    Note over Owner,Cloud: Case A: Targeted Command (Override Stock in Shop 1 Only)
    Owner->>Cloud: POST /admin/commands/stock-override { shop_id: 'Shop1', medicine_id, new_stock: 100 }
    Cloud->>Cloud: INSERT INTO commands (shop_id='Shop1', status='PENDING')
    S1_Worker->>Cloud: gc_pull_commands(shop_id='Shop1')
    Cloud-->>S1_Worker: Returns Command #101
    S1_Worker->>S1_DB: Apply STOCK_OVERRIDE_SET (Sets stock to 100)
    S1_Worker->>Cloud: gc_ack_command(cmd_id=101, status='APPLIED')

    Note over Owner,Cloud: Case B: Broadcast Command (Update Selling Price of Cetirizine across ALL shops)
    Owner->>Cloud: POST /admin/commands/price-update (Scope: ALL) { medicine_code: 'CET-10', price: 25.00 }
    Cloud->>Cloud: Inserts Command #201 for Shop 1 (PENDING)
    Cloud->>Cloud: Inserts Command #202 for Shop 2 (PENDING)

    par Independent Polling & Execution
        S1_Worker->>Cloud: gc_pull_commands('Shop1')
        Cloud-->>S1_Worker: Returns Command #201
        S1_Worker->>S1_DB: UPDATE medicines SET selling_price = 25.00
        S1_Worker->>Cloud: gc_ack_command(cmd_id=201, status='APPLIED')
    and
        S2_Worker->>Cloud: gc_pull_commands('Shop2')
        Cloud-->>S2_Worker: Returns Command #202
        S2_Worker->>S2_DB: UPDATE medicines SET selling_price = 25.00
        S2_Worker->>Cloud: gc_ack_command(cmd_id=202, status='APPLIED')
    end
    Cloud-->>Owner: Both commands marked APPLIED in Activity Log
```

---

### 4.5 Network Partition & Resilience: Split-Brain Prevention during Outage at Shop 2

Proves system resilience when one shop loses internet access completely while the other remains connected. Tills continue dispensing locally, and upon internet restoration, the outbox self-heals with cryptographic parity verification.

```mermaid
sequenceDiagram
    autonumber
    participant S1 as Shop 1 (Normal Online Operation)
    participant Cloud as Supabase Cloud
    participant S2_DB as Shop 2 Local PostgreSQL
    participant S2_Worker as Shop 2 Sync Worker
    actor Cashier2 as Shop 2 Cashier

    Note over S2_Worker,Cloud: [ NETWORK PARTITION: Shop 2 Fiber/ISP Link Goes Down ]

    Cashier2->>S2_DB: Process Sale 1 (KES 1,500)
    S2_DB-->>Cashier2: Sale Committed & Receipt Printed (Outbox: Event #501 PENDING)
    Cashier2->>S2_DB: Process Sale 2 (KES 3,200)
    S2_DB-->>Cashier2: Sale Committed & Receipt Printed (Outbox: Event #502 PENDING)

    S2_Worker->>Cloud: Attempt Sync Packet (HTTP Timeout / Network Unreachable)
    Note over S2_Worker: Worker catches error -> Keeps events PENDING -> Enters Exponential Backoff
    Note over S1,Cloud: Shop 1 continues syncing normally with zero disruption

    Note over S2_Worker,Cloud: [ RESTORATION: Shop 2 Internet Connectivity Re-Established ]

    S2_Worker->>Cloud: Probe Connection (HTTP 200 OK)
    Note over S2_Worker: Cloud Reconnected! Worker resets backoff and makes all pending events due immediately
    S2_Worker->>S2_DB: Drains Events #501 and #502
    S2_Worker->>Cloud: POST /rpc/gc_ingest_events (Events #501, #502)
    Cloud-->>S2_Worker: 200 OK (Cloud Mirror Updated)

    Note over S2_Worker,Cloud: Cryptographic Parity Audit (Self-Healing Check)
    S2_Worker->>S2_DB: Compute Local SHA-256 Inventory Fingerprint (Hash_L)
    S2_Worker->>Cloud: POST /rpc/gc_get_inventory_fingerprint('Shop2') -> Returns Hash_C
    alt Hash_L == Hash_C
        Note over S2_Worker: Parity Confirmed (Zero Drift across 3,000+ items)
    else Hash_L != Hash_C (Discrepancy Detected)
        S2_Worker->>S2_DB: Generate Authoritative Inventory Snapshot
        S2_Worker->>Cloud: POST /rpc/gc_apply_inventory_snapshot('Shop2', SnapshotData)
        Cloud->>Cloud: Overwrite Cloud Stock Levels to match Shop 2 Local DB exactly
        Note over S2_Worker: Cloud Mirror Self-Healed!
    end
```

---

### 4.6 Cashier Shift Lifecycle & End-of-Day Balancing Protocol

```mermaid
flowchart TD
    A["Cashier Arrives at Workstation"] --> B["Open POS App (http://localhost:3000)"]
    B --> C["Enter User Credentials & Login"]
    C --> D{"Active Open Shift Exists?"}
    D -->|No| E["Prompt Opening Float Declaration"]
    E --> F["Submit Float (e.g., KES 2,000) -> Shift State: OPEN"]
    D -->|Yes| G["Access POS Register View"]
    F --> G
    G --> H["Perform Continuous Dispensing & Sales"]
    H --> I["Sales Increment Expected Cash in Background"]
    I --> J["Shift End: Cashier Clicks Close Shift"]
    J --> K["Cashier Blind Counts Physical Drawer Cash"]
    K --> L["Submit Actual Cash Count"]
    L --> M["System Computes Variance: Actual - Expected"]
    M --> N{"Is Variance Zero?"}
    N -->|Yes| O["Shift Status: CLOSED (Perfect Balance)"]
    N -->|No| P["Shift Status: CLOSED (Variance Flagged)"]
    P --> Q["Admin Reviews Shift & Enters Explanatory Notes"]
    O --> R["Print Z-Report Summary Receipt"]
    Q --> R
```


---

## 5. Local-to-Cloud Database Connectivity & Security Protocols

### 5.1 Communication Protocols & Network Topologies

The local server communicates with Supabase Cloud through two distinct, highly optimized network communication channels:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          LOCAL SERVER NETWORK ADAPTER (Node.js)                        │
│                                                                                        │
│   ┌─────────────────────────────────────────┐  ┌───────────────────────────────────┐   │
│   │ CHANNEL A: HTTPS REST PostgREST RPC     │  │ CHANNEL B: Direct PostgreSQL Pool │   │
│   │ - Endpoint: /rest/v1/rpc/<fn>           │  │ - Port: 6543 (Supavisor Pooler)   │   │
│   │ - Protocol: HTTPS / TLS 1.3             │  │ - Protocol: PostgreSQL Wire (TCP) │   │
│   │ - Payload: Compressed JSON              │  │ - Mode: Transaction Pooling       │   │
│   │ - Used by: Background Sync Worker       │  │ - Used by: Direct Migration/Admin │   │
│   └────────────────────┬────────────────────┘  └─────────────────┬─────────────────┘   │
└────────────────────────┼─────────────────────────────────────────┼─────────────────────┘
                         │ HTTPS (Port 443)                        │ TCP (Port 6543)
                         ▼                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SUPABASE CLOUD INFRASTRUCTURE                                   │
│                                                                                        │
│   ┌─────────────────────────────────────────┐  ┌───────────────────────────────────┐   │
│   │ Kong API Gateway / PostgREST Engine     │  │ Supavisor Connection Pooler       │   │
│   │ - Inbound Header Authentication         │  │ - Session Re-use & Low Latency    │   │
│   │ - Dispatches to SECURITY DEFINER Funcs  │  │ - Transaction Isolation Enforced  │   │
│   └────────────────────┬────────────────────┘  └─────────────────┬─────────────────┘   │
│                        │                                         │                     │
│                        ▼                                         ▼                     │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Supabase Cloud PostgreSQL 15/16 Instance                                       │   │
│   │ - Schema: giga_cloud.* (Private Base Physical Tables)                          │   │
│   │ - Schema: giga_online.* (Tenant Scoped Views via Session Variables)           │   │
│   │ - Schema: public.* (Exposed Remote Procedure Calls: gc_*)                      │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Channel A: HTTPS PostgREST RPC Engine (`https://<project-ref>.supabase.co/rest/v1/rpc/*`):**
   - **Primary Sync Conduit:** All operational outbox syncing, command polling, command acknowledgement, and heartbeats use this channel.
   - **Standard Headers:**
     - `Content-Type: application/json`
     - `Accept: application/json`
     - `apikey: <SUPABASE_ANON_KEY>`
     - `Authorization: Bearer <SUPABASE_ANON_KEY>`
   - **Authentication Body/Parameters:** Every RPC requires `p_shop_id` and the shop's secret credential, checked inside the database function.
2. **Channel B: Direct PostgreSQL Transaction Wire Protocol (Port 6543):**
   - **Pooler Architecture:** Supabase uses Supavisor transaction pooling on port 6543. Connections are acquired, used within a single transactional block (`BEGIN ... COMMIT`), and instantly returned to the cloud pool.
   - **Connection String:**
     `postgresql://postgres.<project-ref>:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require`

---

### 5.2 Transport Layer Security (TLS) & Pooler SSL Configuration

All data in transit between the local on-premises pharmacy server and Supabase Cloud is encrypted using modern TLS (TLS 1.2 minimum, TLS 1.3 preferred).

```typescript
// server/db/client.ts & server/sync/cloudClient.ts configuration
const pgClientConfig = {
  connectionString: process.env.ONLINE_DATABASE_URL || process.env.DATABASE_URL,
  ssl: {
    // Cloud database hosted on Supavisor uses intermediate cert authority
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
};
```

- **Cipher Suites:** Negotiated using ECDHE-ECDSA-AES128-GCM-SHA256 or ECDHE-RSA-AES256-GCM-SHA384.
- **Certificate Verification:** HTTPS RPC requests validate the Supabase wildcard SSL certificate (`*.supabase.co`) against the standard Node.js root trust store.
- **Connection Resiliency:** The client sets strict socket timeouts (`httpTimeoutMs = 15000`) and abort controllers on all fetch calls to prevent socket leaks during local broadband dropouts.

---

### 5.3 Cryptographic Shop Authentication & SHA-256 Token Verification

Every local pharmacy master server possesses a cryptographically secure 64-character hexadecimal token (`SYNC_SHOP_TOKEN`). Under no circumstances is the raw token stored in plain text in the cloud.

```
┌─────────────────────────────────┐                 ┌───────────────────────────────────┐
│ LOCAL MASTER SERVER             │                 │ SUPABASE CLOUD (PostgreSQL RPC)   │
│                                 │                 │                                   │
│ Reads: process.env.SYNC_SHOP_TOKEN               │ Database Table: giga_cloud.shops  │
│ e.g. "a9f8e4c3b210..."          │                 │ Column: token_hash (SHA-256)      │
│                                 │                 │                                   │
│ Submits RPC Payload:            │  HTTPS POST     │ Verification:                     │
│ {                               ├────────────────►│ v_token_hash := encode(           │
│   "p_shop_id": "c2a1-...",      │                 │   digest(p_shop_token, 'sha256'), │
│   "p_shop_token": "a9f8e4...",  │                 │   'hex'                           │
│   "p_events": [ ... ]           │                 │ );                                │
│ }                               │                 │ IF s.token_hash != v_token_hash   │
│                                 │                 │   RAISE EXCEPTION 'UNAUTHORIZED'; │
└─────────────────────────────────┘                 └───────────────────────────────────┘
```

1. **Token Generation:** Generated on the cloud using `crypto.randomBytes(32).toString('hex')`.
2. **Cloud Storage:** When a shop is registered via `giga_cloud.register_shop(p_code, p_name, p_token)`, the database computes:
   $$\text{token\_hash} = \text{encode}(\text{digest}(p\_token, \text{'sha256'}), \text{'hex'})$$
3. **RPC Verification:** Every RPC (`gc_ingest_events`, `gc_pull_commands`, `gc_ack_command`, `gc_heartbeat`) runs this verification in `SECURITY DEFINER` mode:
   ```sql
   SELECT shop_id INTO v_shop_id
   FROM giga_cloud.shops
   WHERE shop_id = p_shop_id
     AND token_hash = encode(digest(p_shop_token, 'sha256'), 'hex')
     AND active = TRUE;

   IF v_shop_id IS NULL THEN
       RAISE EXCEPTION 'AUTHENTICATION_FAILED: Invalid shop credentials or shop deactivated';
   END IF;
   ```

---

### 5.4 Database Tenant Isolation & Schema Partitioning

The cloud database enforces strict tenant isolation through two layered architectural tiers: **Private Base Tables (`giga_cloud.*`)** and **Tenant Scoped Views (`giga_online.*`)**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               SUPABASE CLOUD DATABASE                                  │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ PHYSICAL BASE TABLES: giga_cloud.*                                             │   │
│   │                                                                                │   │
│   │   [ giga_cloud.medicines ]        (PK: shop_id, medicine_id)                   │   │
│   │   [ giga_cloud.medicine_batches ] (PK: shop_id, batch_id)                      │   │
│   │   [ giga_cloud.stock_levels ]     (PK: shop_id, medicine_id, batch_id)         │   │
│   │   [ giga_cloud.sales ]            (PK: shop_id, sale_id)                       │   │
│   │   [ giga_cloud.commands ]         (PK: command_id, FK: shop_id)                │   │
│   │                                                                                │   │
│   │   * Strictly isolated by composite primary keys containing (shop_id, ...)      │   │
│   │   * Public/Anon users have ZERO direct access (REVOKE ALL FROM anon, authenticated)│
│   └───────────────────────────────────────┬────────────────────────────────────────┘   │
│                                           │                                            │
│                                           ▼                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ TENANT SCOPED VIEWS: giga_online.*                                             │   │
│   │                                                                                │   │
│   │   CREATE VIEW giga_online.medicines AS                                         │   │
│   │     SELECT * FROM giga_cloud.medicines                                         │   │
│   │     WHERE shop_id = NULLIF(current_setting('giga.shop_id', true), '')::UUID;   │   │
│   │                                                                                │   │
│   │   CREATE VIEW giga_online.stock_levels AS                                      │   │
│   │     SELECT * FROM giga_cloud.stock_levels                                      │   │
│   │     WHERE shop_id = NULLIF(current_setting('giga.shop_id', true), '')::UUID;   │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Session Variable Scoping:** When the Vercel online API accesses shop-scoped data, it invokes helper function `withShopId(shopId, fn)`. This issues:
  ```sql
  SELECT set_config('giga.shop_id', $1, true);
  ```
  The parameter `true` scopes the variable strictly to the active transaction. All queries against `giga_online.*` automatically filter rows to the requested shop, making cross-tenant data leaks impossible at the SQL engine level.

---

### 5.5 Supabase Realtime WebSocket Channels & Adaptive Fallback Polling

To provide immediate delivery of remote commands without unnecessary network flooding, the local server uses a dual-protocol notification pipeline:

1. **Supabase Realtime WebSockets:**
   - The local sync daemon establishes a persistent WebSocket connection:
     `wss://<project-ref>.supabase.co/realtime/v1/websocket?apikey=<SUPABASE_ANON_KEY>&vsn=1.0.0`
   - It subscribes to PostgreSQL Change Data Capture (CDC) events on `giga_cloud.commands`:
     `realtime:giga_cloud:commands:shop_id=eq.<LOCAL_SHOP_ID>`
   - When a remote administrator queues a command, the PostgreSQL write triggers an instantaneous broadcast to the local server, waking the sync worker in $<150\text{ms}$.
2. **Adaptive Fallback Polling Daemon:**
   - If broadband instability, firewall inspection, or corporate proxy settings disrupt the WebSocket connection, the worker automatically falls back to an adaptive HTTP polling loop:
     $$T_{\text{poll}} = \min(T_{\text{base}} \times 1.5^{\text{idle\_cycles}}, T_{\text{max}}) \pm \text{Jitter}$$
   - **Configuration Defaults:** $T_{\text{base}} = 5\text{ seconds}$, $T_{\text{max}} = 15\text{ seconds}$, $\text{Jitter} = \pm 1.5\text{ seconds}$.
   - The random jitter prevents multi-branch "thundering herd" spikes against the Supabase database.

---

### 5.6 Transactional Outbox Batch Ingestion Protocol & Conflict Resolution

The local sync worker ships outbox events in transactional batches using RPC `gc_ingest_events`.

#### 1. Batch Payload Schema
```json
{
  "p_shop_id": "c2a13890-4820-410a-8d14-38491023932f",
  "p_shop_token": "9f8e4c3b210a5678...",
  "p_device_id": "SERVER-NODE-01",
  "p_events": [
    {
      "event_id": "8b9e6f20-94d1-419b-a320-192847102938",
      "idempotency_key": "evt_c2a1..._1042_8b9e6f",
      "event_type": "SALE_COMPLETED",
      "entity_type": "sales",
      "entity_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "operation": "INSERT",
      "local_seq": 1042,
      "payload": {
        "sale": { "sale_id": "f47a...", "total_amount": 1500.00, "status": "COMPLETED" },
        "movements": [
          { "batch_id": "b10...", "medicine_id": "m20...", "quantity_delta": -2 }
        ]
      },
      "created_at": "2026-10-30T14:22:10.450Z"
    }
  ]
}
```

#### 2. Cloud Ingestion Engine (`gc_ingest_events`) Execution Steps:
1. **Authentication Check:** Hashes `p_shop_token` and verifies against `giga_cloud.shops`.
2. **Transaction Loop:** Iterates over each event in `p_events`:
   - Checks `giga_cloud.processed_events` for `idempotency_key`. If exists, flags event as `DUPLICATE` and skips replay.
   - If new, records event into `giga_cloud.processed_events` and inserts the immutable record into `giga_cloud.event_log`.
   - **Last-Write-Wins (LWW) & Sequence Protection:**
     Updates target tables (`medicines`, `suppliers`, `customers`, etc.) only if the incoming `local_seq` or timestamp is newer than `source_seq`:
     ```sql
     UPDATE giga_cloud.medicines
     SET name = EXCLUDED.name,
         selling_price = EXCLUDED.selling_price,
         source_seq = EXCLUDED.source_seq,
         updated_at = now()
     WHERE giga_cloud.medicines.shop_id = p_shop_id
       AND giga_cloud.medicines.medicine_id = EXCLUDED.medicine_id
       AND (giga_cloud.medicines.source_seq IS NULL OR giga_cloud.medicines.source_seq < EXCLUDED.source_seq);
     ```
   - **Stock Reconciliation:** Batch inventory movements are summed into `giga_cloud.stock_levels.delta_since_baseline`.
3. **Response:** Returns JSON object reporting `{ "processed": 1, "duplicates": 0, "failed": 0 }`.
4. **Watermark Progression:** Local server updates local database table `sync_status.last_synced_seq = 1042`.

---

### 5.7 Cryptographic Parity Audits & Self-Healing Inventory Snapshots

To guarantee that network drops, server reboots, or concurrency anomalies never introduce long-term drift between on-premises inventory and the cloud mirror, the system executes an automated cryptographic parity audit every 120 seconds.

```mermaid
flowchart TD
    A["Trigger Parity Audit (Every 120s)"] --> B["Local Worker Locks In-Memory Stock State"]
    B --> C["Compute Local Fingerprint (Hash_Local)"]
    C --> D["POST RPC gc_get_inventory_fingerprint(p_shop_id)"]
    D --> E["Cloud Computes Hash_Cloud from giga_cloud.stock_levels"]
    E --> F{"Does Hash_Local == Hash_Cloud?"}
    F -->|Match (Identical)| G["Log Parity OK (Zero Drift Across Formulary)"]
    F -->|Mismatch (Drift Detected)| H["Trigger Authoritative Snapshot Protocol"]
    H --> I["Dump Local Stock Balances (MedicineId, BatchId, CurrentQty)"]
    I --> J["POST RPC gc_apply_inventory_snapshot(p_shop_id, Snapshot)"]
    J --> K["Cloud Atomically Overwrites giga_cloud.stock_levels"]
    K --> L["Cloud Baseline Reset & Mirror Self-Healed"]
```

1. **Fingerprint Algorithm:**
   Both local PostgreSQL and cloud PostgreSQL execute the exact same canonical sorting and hashing query:
   ```sql
   SELECT encode(digest(coalesce(string_agg(
     medicine_id::text || ':' || batch_id::text || ':' || current_stock::text,
     '|' ORDER BY medicine_id, batch_id
   ), 'EMPTY'), 'sha256'), 'hex') AS fingerprint
   FROM medicine_batches
   WHERE active = TRUE;
   ```
2. **Authoritative Self-Healing:**
   Because physical stock counted in the pharmacy is always the ultimate ground truth, the **local shop database is permanently authoritative**. If the cloud hash does not match, the local worker publishes a full inventory snapshot via `gc_apply_inventory_snapshot`, forcing the cloud mirror into exact alignment without human intervention.


---

## 6. Online Admin Architecture & Inbound Remote Command Delivery Lifecycle

### 6.1 Online Admin Web Architecture

The remote management plane is hosted as a serverless web application deployed on Vercel (`https://gigachem.vercel.app`). It allows pharmacy directors, regional managers, and off-site administrators to oversee business health and manage store operations remotely.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        REMOTE ADMINISTRATOR WORKSTATION / PHONE                        │
│                                                                                        │
│   Web Browser: https://gigachem.vercel.app (Next.js 14 / React Frontend)               │
│   - Multi-Shop Consolidated Dashboard & Live Inventory Matrix                         │
│   - Remote Pricing, Formulary, Stock Override & Shift Audit Panels                     │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ HTTPS (Secure Cookie JWT Session)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        VERCEL SERVERLESS COMPUTE LAYER                                 │
│                                                                                        │
│   Serverless API Routes: /api/admin/* (server/online/remoteAdmin.ts)                   │
│   - Express API compiled to Vercel Serverless Function                                 │
│   - Validates incoming command payload schema against commandSchema.ts                 │
│   - Evaluates Optimistic Concurrency Constraints (expected / expected_quantity)        │
│   - Generates Unique Idempotency Key: cmd_${shopId}_${type}_${timestamp}_${random}     │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ TCP Port 6543 (Transaction Mode Pooler)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SUPABASE CLOUD POSTGRESQL DATABASE                              │
│                                                                                        │
│   Table: giga_cloud.commands (Asynchronous Inbound Command Queue)                      │
│   - Stores queued commands with status: PENDING                                        │
│   - Triggers PostgreSQL CDC notification to Supabase Realtime                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 Administrative Authentication & Role-Based Scoping

Remote administrators authenticate directly against the cloud database table `giga_cloud.online_users`.

```sql
CREATE TABLE IF NOT EXISTS giga_cloud.online_users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID REFERENCES giga_cloud.shops(shop_id), -- NULL = Global Multi-Shop Admin
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'PHARMACIST', 'CASHIER')),
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
```

- **Global Admin (`shop_id IS NULL`):** Has unrestricted administrative authority across all registered shops. Can switch between branches or select "All Shops" scope to inspect aggregated analytics and fan out broadcast catalog commands.
- **Branch Admin (`shop_id = <UUID>`):** Restricted strictly to their assigned pharmacy branch. Any API request attempting to access or mutate an alternate shop returns `HTTP 403 FORBIDDEN`.

---

### 6.3 Command Storage Engine & Finite State Machine

The cloud command engine coordinates asynchronous execution between the cloud and on-premises servers using a 5-state deterministic finite state machine (FSM).

```mermaid
stateDiagram-v2
    [*] --> PENDING: Admin Queues Command (Vercel API)
    PENDING --> DELIVERED: Local Worker Claims (gc_pull_commands)
    PENDING --> EXPIRED: TTL Elapses without Delivery (>48h)
    DELIVERED --> APPLIED: Local DB Replay Succeeds & ACKed
    DELIVERED --> REJECTED: Local Replay Fails / Validation Fails
    APPLIED --> [*]
    REJECTED --> [*]
    EXPIRED --> [*]
```

#### Table Schema: `giga_cloud.commands`
```sql
CREATE TABLE IF NOT EXISTS giga_cloud.commands (
    command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    command_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'DELIVERED', 'APPLIED', 'REJECTED', 'EXPIRED')),
    created_by_user_id UUID REFERENCES giga_cloud.online_users(user_id),
    source TEXT NOT NULL DEFAULT 'VERCEL_API',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    applied_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '48 hours'),
    result_summary JSONB,
    error_message TEXT
);
```

---

### 6.4 Comprehensive Catalog of All Remote Command Types

The system supports 15 core remote administrative command types. Each command carries strict payload schemas and validation rules:

| # | Command Type | Purpose & Target Entity | Key Payload Fields | Optimistic Concurrency Guard |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `STOCK_ADD` | Record manual batch intake | `medicine_id`, `batch_id`, `quantity`, `reason` | `expected_quantity` (optional) |
| 2 | `STOCK_REMOVE` | Write off damaged/expired stock | `medicine_id`, `batch_id`, `quantity`, `reason` | Physical stock $\ge$ quantity |
| 3 | `STOCK_OVERRIDE_ADD` | Emergency administrative stock injection | `medicine_id`, `batch_id`, `quantity`, `notes` | Unrestricted |
| 4 | `STOCK_OVERRIDE_REMOVE`| Emergency administrative stock deduction | `medicine_id`, `batch_id`, `quantity`, `notes` | Deducts down to zero |
| 5 | `MEDICINE_CREATE` | Register new pharmaceutical formulation | `name`, `generic_name`, `barcode`, `category`, `selling_price` | Unique barcode/SKU check |
| 6 | `MEDICINE_UPDATE` | Update clinical indication & reorder levels | `medicine_id`, `category`, `reorder_level`, `prescription_required` | `expected` fields comparison |
| 7 | `PRICE_UPDATE` | Adjust retail, wholesale, and floor pricing | `medicine_id`, `selling_price`, `wholesale_price`, `min_selling_price` | $\text{selling} \ge \text{min} \ge \text{cost}$ |
| 8 | `SUPPLIER_CREATE` | Onboard pharmaceutical distributor | `name`, `contact_name`, `phone`, `email` | Unique supplier name |
| 9 | `SUPPLIER_UPDATE` | Update supplier terms and contact data | `supplier_id`, `phone`, `email`, `active` | Supplier exists |
| 10 | `CUSTOMER_CREATE` | Register patient or corporate client | `name`, `phone`, `email`, `credit_limit` | Unique phone number |
| 11 | `CUSTOMER_UPDATE` | Update loyalty points or credit facilities | `customer_id`, `phone`, `loyalty_points`, `credit_limit` | Customer exists |
| 12 | `EXPENSE_RECORD` | Record operational expenditure | `category`, `description`, `amount`, `payment_method` | Positive amount |
| 13 | `RETURN_APPROVE` | Authorize customer return & restock batch | `return_id`, `approved_quantity`, `refund_amount`, `restocked` | Return status `PENDING` |
| 14 | `RETURN_REJECT` | Reject customer return claim | `return_id`, `rejection_reason` | Return status `PENDING` |
| 15 | `SALE_VOID` | Void fraudulent or erroneous sale | `sale_id`, `void_reason` | Sale exists & not voided |

---

### 6.5 The 8-Step Complete Inbound Command Delivery Lifecycle

The execution lifecycle of a remote command guarantees ACID durability and prevents duplicate execution across network interruptions:

1. **Step 1: Admin Action & Client Dispatch:**
   The remote administrator triggers an action on the Vercel web console (e.g., updates the retail selling price of Paracetamol from KES 20 to KES 25).
2. **Step 2: Vercel Preflight Validation & Idempotency Key Generation:**
   The Vercel API validates the schema against `server/sync/commandSchema.ts`. It synthesizes an immutable idempotency key:
   $$\text{IdempotencyKey} = \text{cmd}\_{\text{shopId}}\_{\text{type}}\_{\text{timestamp}}\_{\text{random}}$$
3. **Step 3: Cloud Command Ingestion:**
   The API writes the record into `giga_cloud.commands` with `status = 'PENDING'`.
4. **Step 4: Notification & Realtime Dispatch:**
   Supabase PostgreSQL fires a CDC notification over the Realtime WebSocket topic. If the local socket is disconnected, the local adaptive polling loop detects the pending command during its next iteration.
5. **Step 5: Atomic Claiming via Stored Procedure (`gc_pull_commands`):**
   The local worker executes RPC `gc_pull_commands`. The stored procedure atomically claims pending rows using `FOR UPDATE SKIP LOCKED` and transitions them to `DELIVERED`:
   ```sql
   UPDATE giga_cloud.commands
   SET status = 'DELIVERED',
       delivered_at = now()
   WHERE command_id IN (
       SELECT command_id FROM giga_cloud.commands
       WHERE shop_id = p_shop_id AND status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
   ```
6. **Step 6: Local Ingestion & Transactional Replay:**
   The local server receives the command batch. For each command:
   - Opens a local PostgreSQL transaction (`BEGIN`).
   - Checks `sync_inbound_commands` by `idempotency_key`. If already processed, skips replay and prepares a cached acknowledgment.
   - Evaluates optimistic concurrency guards (`expected` values). If local state has moved ahead, marks command `REJECTED` with conflict details.
   - Executes the authoritative business mutation using the exact same transactional functions (`server/db/*Tx`) utilized by on-site cashiers.
   - Inserts the execution outcome into `sync_inbound_commands` (`status = 'APPLIED'`).
   - Inserts an outbox event into `sync_events` (`event_type = 'MEDICINE_PRICE_CHANGED'`).
   - Commits the local transaction (`COMMIT`).
7. **Step 7: Cloud Acknowledgment (`gc_ack_command`):**
   The local worker immediately calls cloud RPC `gc_ack_command`, updating `giga_cloud.commands` with `status = 'APPLIED'`, `applied_at = now()`, and the local execution summary.
8. **Step 8: Cloud State Reflection & Online Admin Visibility:**
   During the next outbox sync cycle (typically within 3 seconds), the local worker pushes the generated `sync_events` row to `gc_ingest_events`. This updates the cloud mirror tables (`giga_cloud.medicines`), allowing the remote administrator to immediately see the updated price reflected across the web console.

---

### 6.6 End-to-End Command Delivery & Reflection Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Remote Owner (Browser)
    participant Vercel as Vercel Serverless API
    participant CloudDB as Supabase Cloud DB (commands & mirror)
    participant LocalSync as Local Shop Sync Daemon
    participant LocalDB as Local PostgreSQL (Authoritative)

    Admin->>Vercel: POST /api/admin/commands/price-update { medicine_id: 'm1', new_price: 25.00 }
    Note over Vercel: Preflight check & Idempotency key generated
    Vercel->>CloudDB: INSERT INTO giga_cloud.commands (status='PENDING')
    CloudDB-->>Vercel: 201 Created (Command #901 Queued)
    Vercel-->>Admin: UI displays "Command Queued (Pending Sync)"

    par Realtime Notification or Adaptive Poll
        CloudDB-)LocalSync: Supabase Realtime Push Alert
    and
        LocalSync->>CloudDB: POST /rpc/gc_pull_commands(shop_id)
    end

    CloudDB-->>LocalSync: Atomically returns Command #901 (Status -> DELIVERED)

    rect rgb(240, 248, 255)
        Note over LocalSync,LocalDB: Local Atomic Transaction Replay
        LocalSync->>LocalDB: BEGIN Transaction
        LocalSync->>LocalDB: Check sync_inbound_commands(idempotency_key)
        LocalSync->>LocalDB: UPDATE medicines SET selling_price = 25.00 WHERE medicine_id = 'm1'
        LocalSync->>LocalDB: INSERT INTO price_history (medicine_id, old_price, new_price, user)
        LocalSync->>LocalDB: INSERT INTO sync_inbound_commands (cmd_id, status='APPLIED')
        LocalSync->>LocalDB: INSERT INTO sync_events (event_type='MEDICINE_PRICE_CHANGED')
        LocalSync->>LocalDB: COMMIT Transaction
    end

    LocalSync->>CloudDB: POST /rpc/gc_ack_command(cmd_id=901, status='APPLIED')
    CloudDB-->>LocalSync: ACK Confirmed

    Note over LocalSync,CloudDB: Upstream State Reflection
    LocalSync->>LocalDB: Claim sync_events (event_type='MEDICINE_PRICE_CHANGED')
    LocalSync->>CloudDB: POST /rpc/gc_ingest_events(event_batch)
    CloudDB->>CloudDB: UPDATE giga_cloud.medicines SET selling_price = 25.00
    CloudDB-->>LocalSync: 200 OK (Mirrored)
    LocalSync->>LocalDB: UPDATE sync_events SET status='SYNCED'

    Admin->>Vercel: Refresh Dashboard
    Vercel->>CloudDB: SELECT * FROM giga_online.medicines WHERE medicine_id = 'm1'
    CloudDB-->>Vercel: Returns updated selling_price: 25.00
    Vercel-->>Admin: UI shows Paracetamol Price: KES 25.00 (Synced & Applied)
```


---

## 7. Comprehensive Step-by-Step Installation, Configuration & Deployment Manual

This section delivers an end-to-end, actionable installation manual for commissioning the complete GIGA CHEMIST hybrid infrastructure from scratch.

---

### 7.1 Hardware & Environment Prerequisites

#### 1. Primary Master Server Workstation (One Per Branch)
- **Processor:** Intel Core i5 / AMD Ryzen 5 (4 cores, 8 threads, 2.8 GHz minimum).
- **RAM:** 16 GB DDR4/DDR5 (minimum 8 GB dedicated to PostgreSQL and Node.js buffer cache).
- **Storage:** 256 GB NVMe SSD (PCIe Gen 3 minimum; SSD required for PostgreSQL WAL write throughput).
- **Network Interface:** Gigabit Ethernet RJ45 connected directly to the store's primary LAN router.
- **Operating System:** Windows 11 Pro 64-bit (Version 22H2 or newer). *Pro edition is required for Group Policy and reliable background service management without forced consumer reboot loops.*
- **Power Protection:** Uninterruptible Power Supply (UPS) with minimum 650VA / 360W rating to prevent dirty shutdowns during grid outages.

#### 2. Client Counter Cashier Terminals (PC 2, PC 3)
- **Processor:** Dual-Core 2.0 GHz or higher (Intel Celeron N5095, Core i3, or equivalent).
- **RAM:** 4 GB DDR4 minimum.
- **Storage:** 64 GB SSD.
- **Display:** 1366x768 resolution minimum (1080p recommended).
- **Browser:** Google Chrome (v115+) or Microsoft Edge (Chromium v115+).

#### 3. Store Local Area Network (LAN) Infrastructure
- 100/1000 Mbps Gigabit Ethernet Switch or Router.
- Master Server assigned a static local IP address (e.g., `192.168.1.100` or DHCP MAC reservation).
- Counter PCs connected via wired Cat5e/Cat6 Ethernet cables for guaranteed sub-millisecond latency.

---

### 7.2 Local Master Server Installation (Windows 11 Pro)

#### Step 1: Install System Dependencies
Open PowerShell as **Administrator** and install the runtime prerequisites:

```powershell
# 1. Ensure Windows Execution Policy allows script automation
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force

# 2. Install Node.js 20 LTS (using winget package manager)
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements

# 3. Install Git for Windows
winget install Git.Git --silent --accept-package-agreements --accept-source-agreements

# 4. Install PostgreSQL 16 x64 Server
winget install PostgreSQL.PostgreSQL.16 --silent --accept-package-agreements --accept-source-agreements
```

*Note: Restart PowerShell after installation to ensure `node`, `npm`, `git`, and `psql` are available in `$env:PATH`.*

#### Step 2: Configure PostgreSQL Service for Local & LAN Access
1. Open PostgreSQL configuration file: `C:\Program Files\PostgreSQL\16\data\postgresql.conf`
   Set:
   ```ini
   listen_addresses = '*'
   port = 5432
   max_connections = 100
   shared_buffers = 1GB
   synchronous_commit = on
   wal_level = replica
   fsync = on
   ```
2. Open client authentication file: `C:\Program Files\PostgreSQL\16\data\pg_hba.conf`
   Add the following lines to permit local and private LAN counter connections:
   ```ini
   # TYPE  DATABASE        USER            ADDRESS                 METHOD
   host    all             all             127.0.0.1/32            scram-sha-256
   host    all             all             ::1/128                 scram-sha-256
   host    all             all             192.168.1.0/24          scram-sha-256
   ```
3. Restart the PostgreSQL service:
   ```powershell
   Restart-Service postgresql-x64-16
   ```

#### Step 3: Configure Windows Firewall
Execute the following commands to allow cashier terminals on the LAN to access the POS server while blocking untrusted networks:

```powershell
# Allow Inbound TCP traffic on port 3000 (POS Express Web Server) for Private LAN
New-NetFirewallRule -DisplayName "GIGA Chemist POS Web (Port 3000)" `
    -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow `
    -Profile Private

# Allow Inbound TCP traffic on port 5432 (PostgreSQL) for Private LAN
New-NetFirewallRule -DisplayName "GIGA Chemist PostgreSQL (Port 5432)" `
    -Direction Inbound -LocalPort 5432 -Protocol TCP -Action Allow `
    -Profile Private
```

---

### 7.3 Database Initialization & Local Migration Execution

1. Clone or place the codebase into the target production directory:
   ```powershell
   cd C:\
   git clone https://github.com/your-org/giga-chemist-pos.git GIGA-CHEMIST-POS
   cd C:\GIGA-CHEMIST-POS
   ```
2. Install npm dependencies:
   ```powershell
   npm ci
   ```
3. Create the local production database:
   ```powershell
   # Create database giga_chemist under postgres superuser
   & "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres -h 127.0.0.1 -p 5432 giga_chemist
   ```
4. Execute the migration runner to apply database migrations `001` through `028`:
   ```powershell
   npm run db:migrate
   ```
   *Expected Output: `Successfully applied 28 migrations. Local schema is up to date.`*

---

### 7.4 Master Admin User Onboarding

Seed the initial local administrator account into the database using the provided onboarding utility:

```powershell
# Syntax: npm run create-admin -- "<Full Name>" <Email> <Password> <QuickLoginPIN>
npm run create-admin -- "Store Administrator" admin@gigachemist.com Pharmacy2026! 1234
```

*Verification: The script creates the admin user with salted PBKDF2 hash, assigns role `ADMIN`, sets status `active = true`, and links PIN hash `1234` for rapid POS till switching.*

---

### 7.5 Production Environment Configuration (`.env`)

Create the production configuration file at `C:\GIGA-CHEMIST-POS\.env`. Every parameter is detailed below:

```ini
# ==============================================================================
# GIGA CHEMIST — PRODUCTION ON-PREMISES ENVIRONMENT CONFIGURATION
# ==============================================================================

# 1. Local Application Runtime
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
APP_MODE=hybrid
JWT_SECRET=super_secret_cryptographic_jwt_key_minimum_64_characters_long_abc123

# 2. Local Master PostgreSQL Database
DATABASE_URL=postgresql://postgres:YourPostgresPassword123@127.0.0.1:5432/giga_chemist
DATABASE_POOL_MIN=5
DATABASE_POOL_MAX=25

# 3. Shop Identification & Cloud Hybrid Credentials
SHOP_ID=c2a13890-4820-410a-8d14-38491023932f
SHOP_CODE=SHOP1
SHOP_NAME=Kitale Main Branch
DEVICE_ID=MASTER-SERVER-01
SYNC_SHOP_TOKEN=9f8e4c3b210a56789abcdef0123456789abcdef0123456789abcdef012345678

# 4. Supabase Cloud Sync Configuration
SYNC_ENABLED=true
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ONLINE_DATABASE_URL=postgresql://postgres.your-project-ref:YourCloudDbPass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require

# 5. Sync Cadence & Resiliency Timers
SYNC_INTERVAL_MS=3000
SYNC_COMMAND_POLL_INTERVAL_MS=5000
SYNC_BATCH_SIZE=50
SYNC_HTTP_TIMEOUT_MS=15000
SYNC_MAX_BACKOFF_MS=60000

# 6. Local Hardware Peripheral Configurations
PRINTER_TYPE=RAW_ESC_POS
PRINTER_PORT=USB
PRINTER_PAPER_WIDTH_MM=80
PRINTER_CHAR_WIDTH=48
CASH_DRAWER_ENABLED=true
CASH_DRAWER_KICK_PIN=0
CASH_DRAWER_PULSE_ON_MS=50
CASH_DRAWER_PULSE_OFF_MS=200

# 7. Automated Ops & Backup Retention
BACKUP_ENABLED=true
BACKUP_SCHEDULE=0 23 * * *
BACKUP_PATH=C:\GigaBackups
BACKUP_KEEP=14
BACKUP_KEEP_WEEKLY=8
```

---

### 7.6 Production Build & Windows Auto-Start Background Service

#### Step 1: Compile Production Assets
Compile the React/TypeScript frontend bundle into high-performance static assets:

```powershell
npm run build
```
*Verify that `dist/index.html` and `dist/assets/*.js` are generated.*

#### Step 2: Install Windows Auto-Start Service Runner
The repository provides an automated installation script that registers the Node.js server with Windows Task Scheduler to run unattended at system startup:

```powershell
# Execute the automated Windows autostart installer
powershell -ExecutionPolicy Bypass -File .\deployment\windows\install-autostart.ps1
```

**What this script configures:**
1. Creates Windows Scheduled Task named **`GigaChemistPOS_Service`**.
2. Configures trigger: **`At Startup`** (boots before any cashier logs into Windows).
3. Configures principal: **`SYSTEM`** or dedicated administrator account with highest privileges.
4. Binds execution to `deployment/windows/service-runner.ps1`.
5. Enables recovery: If the process crashes, Task Scheduler restarts it after 1 minute up to 3 times.

#### Step 3: Verify Service Execution
```powershell
# Manually trigger task to verify startup
Start-ScheduledTask -TaskName "GigaChemistPOS_Service"

# Check server health endpoint
curl http://127.0.0.1:3000/api/health
```
*Expected Response:*
```json
{"status":"healthy","database":"connected","mode":"hybrid","syncWorker":"running"}
```

---

### 7.7 LAN Cashier Counter Terminals Setup (PC 2, PC 3)

Configure each secondary checkout workstation connected to the store LAN:

1. **Static IP / Hostname Configuration:**
   Identify the Master Server's IP address (e.g., `192.168.1.100`).
2. **Browser Installation:**
   Install Google Chrome or Microsoft Edge.
3. **Open POS Interface:**
   Navigate to: `http://192.168.1.100:3000`
4. **Install as Progressive Web App (PWA):**
   - Click the **Install GIGA CHEMIST** icon in the browser address bar.
   - Choose **Install** to add the application to the Windows Desktop and Taskbar.
5. **Kiosk Auto-Launch Setup:**
   Right-click the desktop shortcut -> Properties -> Add `--kiosk --app=http://192.168.1.100:3000` to the Target field. Placing this shortcut in the Windows Startup folder (`shell:startup`) allows the till terminal to automatically open directly into the point of sale on boot.

---

### 7.8 Local Hardware Peripherals Configuration

#### 1. 80mm ESC/POS Thermal Receipt Printer Setup
1. Connect printer via USB cable to the till terminal.
2. Install the vendor-supplied driver (Epson TM-T20, Xprinter 80mm, or Rongta).
3. **Configure Generic / Text-Only Mode (Recommended for RAW ESC/POS byte streaming):**
   - Open **Printers & Scanners** in Windows Settings.
   - Add Printer -> The printer that I want isn't listed -> Add a local printer.
   - Select the USB virtual port (e.g., `USB001`).
   - Manufacturer: **Generic**, Model: **Generic / Text Only**.
   - Name the printer `GIGA_RECEIPT_PRINTER`.
4. In the GIGA CHEMIST POS Settings panel (`http://localhost:3000/settings`), select `GIGA_RECEIPT_PRINTER` as the default receipt printer.
5. Click **Test Print** to verify bold headings, font scaling, tax table formatting, and paper cutting.

#### 2. Handheld USB Barcode Scanner Setup
1. Connect the barcode scanner via USB. The operating system detects it as a standard USB HID Keyboard device.
2. Scan the vendor's configuration programming barcodes (located in the scanner user manual):
   - **Step A: Set Interface to USB HID Keyboard Emulation Mode.**
   - **Step B: Add Suffix -> Carriage Return + Line Feed (`CR + LF` / Enter key).**
3. **Verification:**
   - Open a text editor (Notepad).
   - Scan any pharmaceutical product EAN-13 barcode.
   - The barcode number must appear instantly followed by an immediate newline.
   - In GIGA CHEMIST POS, scanning a barcode anywhere on the checkout screen instantly resolves the item from Dexie IndexedDB and adds it to the active cart in $<10\text{ms}$.

#### 3. Electronic Cash Drawer Setup
1. Connect the RJ11 cable from the bottom of the cash drawer into the **DK (Drawer Kick)** port of the thermal receipt printer.
2. The POS engine triggers drawer opening automatically when cash payments are tendered by transmitting the standard ESC/POS solenoid pulse:
   ```typescript
   // Hex command: 1B 70 00 19 FA
   const KICK_DRAWER_PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
   printerSocket.write(KICK_DRAWER_PULSE);
   ```
3. Test drawer kick via the POS manual button **Open Till Drawer** (requires Cashier authorization).

---

### 7.9 Supabase Cloud Infrastructure Setup

#### Step 1: Create Supabase Project
1. Navigate to [Supabase Management Console](https://supabase.com) and create a new project named `giga-chemist-cloud`.
2. Select your nearest geographic region (e.g., `eu-central-1` or `af-south-1`).
3. Set a strong, secure database password and record it.

#### Step 2: Execute Cloud Migrations in Sequence
Open the **Supabase SQL Editor** and execute the database migration scripts located in `cloud/supabase/migrations/` in strict numerical sequence:
1. `001_giga_cloud_hybrid.sql` (Creates `giga_cloud` schema, base tables, and security functions).
2. `002_online_api.sql` (Creates `giga_online` tenant views and session configuration logic).
3. `003_remote_admin_commands.sql` (Creates `giga_cloud.commands` and status transition rules).
4. `004_remote_operations.sql` (Adds remote audit and telemetry tables).
5. `005_unified_auth_multishop.sql` (Creates `giga_cloud.online_users` and multi-shop tokens).
6. `006_full_write_admin.sql` through `016_authoritative_shop_mirror.sql` (Applies full write administrative commands, cashier shifts, baseline deltas, and snapshot isolation).

#### Step 3: Register Physical Branches in `giga_cloud.shops`
Execute the registration query in the Supabase SQL editor to create Shop 1 and Shop 2:

```sql
-- Register Shop 1 (Kitale Main Branch)
SELECT giga_cloud.register_shop(
    'SHOP1',
    'Kitale Main Branch',
    '9f8e4c3b210a56789abcdef0123456789abcdef0123456789abcdef012345678'
);

-- Register Shop 2 (Eldoret Branch)
SELECT giga_cloud.register_shop(
    'SHOP2',
    'Eldoret Branch',
    '3d2c1b0a987654321fedcba987654321fedcba987654321fedcba987654321'
);
```

#### Step 4: Seed Online Global Administrator Account
Create the initial remote owner account using the online user CLI utility:

```powershell
npm run online:create-user -- `
    --email owner@gigachemist.com `
    --name "Pharmacy Director" `
    --password "CloudAdmin2026!" `
    --role ADMIN `
    --global
```
*Note: The `--global` flag sets `shop_id = NULL` in `giga_cloud.online_users`, granting this administrator access to all physical branches.*

---

### 7.10 Vercel Online Admin Deployment

1. **Connect GitHub Repository to Vercel:**
   - Log into [Vercel](https://vercel.com).
   - Click **Add New Project** -> Import `giga-chemist-pos`.
2. **Configure Project Settings:**
   - **Framework Preset:** Next.js.
   - **Root Directory:** `./`
   - **Build Command:** `npm run build:online`
   - **Output Directory:** `.next`
3. **Configure Environment Variables in Vercel Dashboard:**
   Add the following production environment keys:
   - `ONLINE_DATABASE_URL`: Your Supabase pooler connection string on port 6543 (`postgresql://postgres.xxx:pass@pooler.supabase.com:6543/postgres?sslmode=require`).
   - `SUPABASE_URL`: `https://your-project-ref.supabase.co`
   - `SUPABASE_ANON_KEY`: `eyJhbGciOiJIUzI1Ni...`
   - `ONLINE_JWT_SECRET`: 64-character random secret key.
   - `NODE_ENV`: `production`
4. **Deploy:** Click **Deploy**. Vercel compiles the serverless frontend and API routes, publishing the application to `https://gigachem.vercel.app`.

---

### 7.11 System Verification, Commissioning & Smoke Testing Checklist

Follow this 7-step smoke testing protocol before releasing the pharmacy system for live operations:

| Step | Verification Procedure | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- |
| **1. Local LAN Sale** | Log into Counter Till 2 (`http://192.168.1.100:3000`). Scan barcode, checkout with Cash. | Sale completes in $<60\text{ms}$. ESC/POS printer cuts receipt. Cash drawer opens. Stock decrements locally. | [ ] PASS |
| **2. Offline Resilience** | Disconnect WAN Ethernet / unplug fiber optic router. Perform 3 sales on Till 1 and Till 2. | Checkouts proceed with zero delay or warnings. Outbox records 3 events with status `PENDING`. | [ ] PASS |
| **3. Auto-Catchup Sync** | Reconnect WAN Ethernet. Observe server logs (`logs/server.log`). | Sync worker wakes within 3s. Drains pending events to cloud. Events update to status `SYNCED`. | [ ] PASS |
| **4. Cloud Mirror Parity** | Open Supabase SQL Editor. Run `SELECT * FROM giga_cloud.sales WHERE shop_id = '<SHOP1_ID>'`. | Cloud shows exact sales totals, timestamps, and matching item quantities as local PostgreSQL. | [ ] PASS |
| **5. Remote Admin Command** | Log into `https://gigachem.vercel.app`. Adjust Amoxicillin retail price to KES 30.00. | Command transitions `PENDING` -> `DELIVERED` -> `APPLIED`. Local till reflects KES 30.00 within 5s. | [ ] PASS |
| **6. Parity Self-Healing** | Manually modify a cloud stock level row in SQL editor to simulate drift. Wait 120 seconds. | Parity audit detects fingerprint mismatch. Local worker pushes snapshot. Cloud mirror auto-heals. | [ ] PASS |
| **7. End of Day Shift** | Cashier clicks **Close Shift**, performs blind cash count. Admin reviews variance. | Variance computed. Shift status transitions to `CLOSED`. Z-Report receipt prints. Syncs to cloud. | [ ] PASS |


---

## 8. Non-Functional Requirements

### 8.1 Zero-Internet Resilience & Fault Tolerance
- **Continuous Offline Operation:** The local pharmacy point of sale must experience **zero downtime, zero checkout latency increase, and zero blocked transactions** when external WAN/internet connectivity is lost indefinitely.
- **Queue Backlog Capacity:** The local PostgreSQL `sync_events` transactional outbox must support storing up to **500,000 pending outbox events** (exceeding 6 months of heavy dispensing activity) without performance degradation on local queries.
- **Exponential Backoff:** Network retry routines must enforce capped exponential backoff ($5\text{s} \to 10\text{s} \to 20\text{s} \to \dots \to 60\text{s}$) to avoid exhausting network interface buffers during prolonged telecom outages.

### 8.2 Performance Benchmarks & Sub-Millisecond Latencies
- **Barcode Lookup Latency:** Barcode scanning and cart addition via Dexie IndexedDB must resolve in $< 10\text{ms}$.
- **Local Transaction Commit:** Full checkout execution (locking batch, decrementing stock, inserting sale, sale items, payments, movements, and outbox rows) must commit within $< 80\text{ms}$ on local NVMe SSD storage.
- **Network Sync Latency:** Under active broadband connectivity, local mutations must reach Supabase Cloud within $< 3\text{ seconds}$.
- **Remote Command Delivery:** Inbound administrative commands must be claimed, executed on-premises, and acknowledged to the cloud within $< 5\text{ seconds}$ via Realtime WebSocket push.

### 8.3 Data Durability & Power Loss Protection
- **WAL Configuration:** Local PostgreSQL runs with `synchronous_commit = on` and `fsync = on`.
- **Sudden Power Severance:** In the event of catastrophic grid failure or UPS battery depletion, PostgreSQL Write-Ahead Logging (WAL) guarantees crash recovery to a completely consistent state with zero transaction corruption upon reboot.
- **Automated Backups:** Daily physical database dumps (`pg_dump`) execute at 23:00 local time, retaining 14 daily and 8 weekly archives on isolated local storage.

### 8.4 Network Partition Tolerance & Multi-Node Safety
- **Single Sync Leader Guard:** Across multi-threaded or multi-process local backend clusters, session-level advisory locking (`pg_try_advisory_lock(7420317001)`) guarantees that exactly one process drains the outbox and polls cloud commands at any given moment.
- **Multi-Shop Data Segregation:** Local database configuration engines strictly validate `SHOP_ID` during bootstrap. The system immediately halts startup with an unrecoverable fatal error if local shop credentials do not match the configured database identity.

---

## 9. Architectural Comparison Matrix

This matrix provides a comprehensive, objective technical comparison between the **Legacy Local-Server Architecture** and the **Modern Cloud-Only System** for GIGA CHEMIST:

| Feature Dimension | Legacy Local-Server System (Windows 11 Master) | Modern Cloud-Only System (Vercel + Supabase) |
| :--- | :--- | :--- |
| **Authoritative Store** | Local PostgreSQL (`127.0.0.1:5432`) on shop PC | Supabase Cloud PostgreSQL (`giga_cloud.*`) |
| **Server Hardware Requirement** | Dedicated Core i5/16GB on-site PC per shop | Zero on-site server hardware (Any browser/tablet) |
| **Offline Checkouts** | 100% autonomous operation; infinite offline run | Requires continuous, stable internet connectivity |
| **Multi-Terminal LAN Sync** | Sub-millisecond across local private switch | Sub-second via Supabase Realtime WebSockets |
| **Data Propagation to Cloud** | Asynchronous transactional outbox worker | Synchronous direct REST writes to cloud tables |
| **Hardware Peripherals** | Direct local ESC/POS raw port & cash drawer kick | WebUSB / WebBluetooth / Browser native print dialog |
| **Remote Admin Operations** | Asynchronous command queue with local worker poll | Immediate REST bridge writes to cloud tables |
| **Disaster Recovery / Backups** | Local `pg_dump`, UPS maintenance, SSD monitoring | Managed cloud backups, point-in-time recovery |
| **Maintenance Burden** | High (Windows tasks, service runners, DB tuning) | Zero infrastructure maintenance; fully serverless |
| **Branch Onboarding Time** | 2 to 4 hours (Hardware setup, OS install, migrations)| Under 5 minutes (Open browser URL and log in) |

---

## 10. Conclusion & Operational Verification Sign-Off

The **GIGA CHEMIST Local-Server and Hybrid Offline-First Architecture** represents an uncompromising engineering standard for environments where telecommunications infrastructure is fragile, erratic, or cost-prohibitive. By anchoring the authoritative transactional core in on-premises PostgreSQL and leveraging an asynchronous transactional outbox, the system ensures that pharmacy counter operations remain invincible against external network disruptions while simultaneously delivering centralized multi-branch oversight and remote administrative control.

This specification stands as the authoritative reference for the architecture, implementation, synchronization protocols, and deployment lifecycle of the local-server system.

---
*End of Specification — GIGA CHEMIST Systems Engineering Group*
