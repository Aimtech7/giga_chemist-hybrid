# GIGA CHEMIST — Online Admin Parity Matrix

Comprehensive feature audit comparing Local Shop Administration with Online Global Administration.

## Architectural Boundary

- **Execution Authority**: Shop local PostgreSQL is the single source of truth for all operational inventory, sales, shifts, and financial mutations.
- **Online Admin Model**: Remote administrative changes are queued as authenticated, shop-scoped commands, executed locally within a database transaction, audited, emitted via durable outbox, and confirmed back to the cloud reporting mirror.
- **Global Stock Override**: Deliberate administrative stock corrections (`STOCK_OVERRIDE_ADD`, `STOCK_OVERRIDE_REMOVE`, `STOCK_OVERRIDE_SET`) are explicit override commands with a 10-minute validity window, restricted strictly to Global Administrators, and never conflated with ordinary two-way sync.

---

## Parity Audit Table

| LOCAL FEATURE | LOCAL COMPONENT | ONLINE FEATURE | STATUS | COMMAND/API | SHOP CAPABILITY | NOTES |
|---|---|---|---|---|---|---|
| **Medicines: List & Search** | `MedicineList.tsx` | Online Medicine Catalogue | FULL_PARITY | `GET /api/medicines` | N/A | Cloud copy query with instant client search |
| **Medicines: Create** | `AddMedicineModal.tsx` | Remote Create Medicine | FULL_PARITY | `POST /api/admin/commands/medicine-create` | `MEDICINE_CREATE` | Generates shop command; local transaction assigns/syncs |
| **Medicines: Update Metadata** | `EditMedicineModal.tsx` | Remote Metadata Update | FULL_PARITY | `POST /api/admin/commands/medicine-update` | `MEDICINE_METADATA_UPDATE` | Barcode, generic name, category, etc. |
| **Medicines: Price Update** | `PriceHistoryModal.tsx` | Remote Price Update | FULL_PARITY | `POST /api/admin/commands/price-update` | `PRICE_UPDATE` | Selling, wholesale, min selling, purchase prices |
| **Medicines: Delete / Archive** | `DeleteMedicineModal.tsx` | Remote Medicine Delete | FULL_PARITY | `GET /api/admin/medicines/:id/delete-preview`, `POST /api/admin/commands/medicine-delete` | `MEDICINE_DELETE` | Canonical `apiFetch()`; blocks if stock > 0; permanent if unused, archive if history |
| **Medicines: Restore Archived** | `MedicineList.tsx` | Remote Medicine Restore | FULL_PARITY | `POST /api/medicines/:id/restore` | `MEDICINE_METADATA_UPDATE` | Restores status to active via canonical auth client |
| **Inventory: Stock Add** | `AddStockModal.tsx` | Remote Stock Add | FULL_PARITY | `POST /api/admin/commands/stock-add` | `STOCK_ADD` | Optimistic concurrency checking expected quantity |
| **Inventory: Stock Remove** | `RemoveStockModal.tsx` | Remote Stock Remove | FULL_PARITY | `POST /api/admin/commands/stock-remove` | `STOCK_REMOVE` | Requires reason, checks expected quantity, prevents negative |
| **Inventory: Set Physical Count** | `PhysicalStockCount.tsx` | Remote Physical Count | FULL_PARITY | `POST /api/admin/commands/stock-set` | `STOCK_SET` | Concurrency gate on expected quantity |
| **Global Stock Override: Add** | Local Direct Adjust | Explicit Override Add | FULL_PARITY | `POST /api/admin/commands/stock-override-add` | `STOCK_OVERRIDE_ADD` | Global Admin only, locks batch, applies to current local stock, audited |
| **Global Stock Override: Remove** | Local Direct Adjust | Explicit Override Remove | FULL_PARITY | `POST /api/admin/commands/stock-override-remove` | `STOCK_OVERRIDE_REMOVE` | Global Admin only, locks batch, strictly blocks negative stock |
| **Global Stock Override: Set** | Local Stocktake Adjust | Explicit Override Set | FULL_PARITY | `POST /api/admin/commands/stock-override-set` | `STOCK_OVERRIDE_SET` | Global Admin only, physical count correction, requires batch allocation if multiple |
| **Stock Snapshot Refresh** | Local Parity Check | Refresh Stock From Shop | FULL_PARITY | `POST /api/admin/commands/stock-snapshot-request` | `STOCK_SNAPSHOT_REQUEST` | Re-publishes authoritative baseline without inventory movement |
| **Batches: Create** | `BatchManagement.tsx` | Remote Batch Create | FULL_PARITY | `POST /api/admin/commands/batch-create` | `BATCH_CREATE` | Creates batch with expiry & opening stock |
| **Batches: Update** | `BatchManagement.tsx` | Remote Batch Update | FULL_PARITY | `POST /api/admin/commands/batch-update` | `BATCH_UPDATE` | Updates batch number, pricing overrides |
| **Batches: Expiry Update** | `BatchManagement.tsx` | Remote Batch Expiry Update | FULL_PARITY | `POST /api/admin/commands/batch-expiry` | `BATCH_EXPIRY_UPDATE` | Updates expiry date with audit log |
| **Batches: Status (Active/Archived)** | `BatchManagement.tsx` | Remote Batch Toggle | FULL_PARITY | `POST /api/admin/commands/batch-active` | `BATCH_SET_ACTIVE` | Deactivates or activates batches remotely |
| **Expiry: Monitoring** | `ExpiryTracking.tsx` | Online Expiry Tracking | FULL_PARITY | `GET /api/batches` | N/A | Near-expiry and expired alerts from reporting mirror |
| **Purchases: Draft / Create** | `PurchaseOrders.tsx` | Remote Purchase Create | FULL_PARITY | `POST /api/admin/commands/purchase-create` | `PURCHASE_CREATE` | Creates pending purchase in shop |
| **Purchases: Receive** | `PurchaseOrders.tsx` | Remote Purchase Receive | FULL_PARITY | `POST /api/admin/commands/purchase-receive` | `PURCHASE_RECEIVE` | Receives items into shop stock, updates batches |
| **Purchases: Cancel** | `PurchaseOrders.tsx` | Remote Purchase Cancel | FULL_PARITY | `POST /api/admin/commands/purchase-cancel` | `PURCHASE_CANCEL` | Cancels pending purchase |
| **Suppliers: CRUD** | `SupplierList.tsx` | Remote Supplier Management | FULL_PARITY | `POST /api/admin/commands/supplier-*` | `SUPPLIER_CREATE`, `SUPPLIER_UPDATE`, `SUPPLIER_SET_ACTIVE` | Complete remote supplier lifecycle |
| **Customers: CRUD** | `CustomerList.tsx` | Remote Customer Management | FULL_PARITY | `POST /api/admin/commands/customer-*` | `CUSTOMER_CREATE`, `CUSTOMER_UPDATE`, `CUSTOMER_SET_ACTIVE` | Complete remote customer lifecycle |
| **Sales: View & Search** | `HistoryView.tsx` | Online Sales History | FULL_PARITY | `GET /api/sales` | N/A | Cloud copy mirror with receipt details & payments |
| **Sales: Void** | `HistoryView.tsx` | Remote Sale Void | FULL_PARITY | `POST /api/admin/commands/sale-void` | `SALE_VOID` | Voids sale locally, rolls back stock, emits outbox |
| **Returns: Workflow** | `ReturnsView.tsx` | Remote Return Approve/Reject | FULL_PARITY | `POST /api/admin/commands/return-*` | `RETURN_APPROVE`, `RETURN_REJECT` | Remote approval/rejection with refund verification |
| **Expenses: CRUD** | `ExpenseTracker.tsx` | Remote Expense Management | FULL_PARITY | `POST /api/admin/commands/expense-*` | `EXPENSE_CREATE`, `EXPENSE_UPDATE`, `EXPENSE_VOID` | Complete remote expense lifecycle |
| **Reports: Sales & Inventory** | `ReportsView.tsx` | Online Business Reports | FULL_PARITY | `GET /api/admin/insights`, `GET /api/reports/*` | N/A | Financial summaries, movement audits, turnover |
| **Users: Create Staff** | `UserManagement.tsx` | Remote Staff Creation | FULL_PARITY | `POST /api/admin/commands/user-create` | `USER_CREATE` | PBKDF2 hash synced via secure credential RPC |
| **Users: Role & Status** | `UserManagement.tsx` | Remote Staff Role/Active | FULL_PARITY | `POST /api/admin/commands/user-*` | `USER_ROLE_UPDATE`, `USER_SET_ACTIVE` | Instant remote role and activation control |
| **Users: Session Revocation** | `SecurityView.tsx` | Remote Session Revocation | FULL_PARITY | `POST /api/admin/commands/user-session-revoke` | `USER_SESSION_REVOKE` | Invalidates JWTs issued before revocation timestamp |
| **Shifts: Review** | `ShiftHistoryView.tsx` | Remote Shift Review | FULL_PARITY | `POST /api/admin/commands/shift-review` | `SHIFT_REVIEW` | Reviews closed cashier shifts, audits cash variance |
| **Stocktakes: Session Conduct** | `StocktakeView.tsx` | Offline Physical Count | LOCAL_ONLY_BY_DESIGN | N/A | N/A | Physical counting requires barcode scanning on hardware at local shop |
| **Stocktakes: History & Audit** | `StocktakeHistory.tsx` | Online Stocktake History | FULL_PARITY | `GET /api/stocktakes` | N/A | Inspect completed sessions and variance reports |
| **Settings: Pharmacy Config** | `SettingsView.tsx` | Remote Settings Update | FULL_PARITY | `POST /api/admin/commands/settings` | `SETTINGS_UPDATE` | Receipt headers, tax, thresholds, printer options |
| **Audit Logs: Review** | `AuditView.tsx` | Remote Audit Trail | FULL_PARITY | `GET /api/audit-logs` | N/A | Inspect all local and remote actions with actor tags |
| **Alerts: Monitoring & Ack** | `AlertsView.tsx` | Online Alerts Hub | FULL_PARITY | `GET /api/admin/alerts`, `POST /api/admin/alerts/:id/ack` | N/A | Stock, expiry, sync, and hardware alerts |
| **Sync Center: Queues & Issues** | `SyncCenter.tsx` | Online Sync Center | FULL_PARITY | `GET /api/admin/sync-center`, `GET /api/admin/sync-center/issues` | N/A | Inspect pending/delivered commands and sequence gaps |
| **Sync Center: Rejected Changes** | `RejectedChangesView.tsx`| Rejected Changes Hub | FULL_PARITY | `GET /api/admin/sync/rejected-changes`, `POST /api/admin/sync/retry-failed` | `SYNC_RETRY_FAILED` | Categorized inspection, safe preview, selective retry |
| **Sync Center: Stock Conflicts**| `StockConflictsView.tsx` | Stock Conflicts Center | FULL_PARITY | `GET /api/admin/sync/stock-conflicts` | `STOCK_OVERRIDE_*`, `STOCK_SNAPSHOT_REQUEST` | Inspect mismatches, Sync from Shop, or Override |
| **Backups: Status & Verification**| `BackupManager.tsx` | Remote Backup Monitoring | FULL_PARITY | `GET /api/admin/shop-health` | N/A | Real-time backup age, size, status, and verification |
| **Backups: Manual Trigger** | `BackupManager.tsx` | Trigger Local Backup | LOCAL_ONLY_BY_DESIGN | N/A | N/A | Local disk I/O and pg_dump executed on local PC |
| **Health: Diagnostics** | `HealthTab.tsx` | Shop PC Diagnostics | FULL_PARITY | `GET /api/admin/shop-health` | N/A | CPU, disk free, uptime, restarts, DB status |
| **Updates: Approval & Deploy** | `UpdateManager.tsx` | Software Update Approve | FULL_PARITY | `POST /api/admin/commands/app-update` | `APP_UPDATE_APPROVE` | Approves production commit for updater installation |

---

## Status Definitions

- **FULL_PARITY**: Remote administration capability exists with identical business rules and local transactional enforcement.
- **PARTIAL**: Feature is available remotely with limited fields or read-only reporting.
- **MISSING**: Feature exists locally but has no remote equivalent. *(None currently identified in administrative scope).*
- **LOCAL_ONLY_BY_DESIGN**: Feature requires physical presence at the terminal (e.g. barcode gun scanning during live stocktake counting or local pg_dump process spawning).

---

## Zero-Missed-Change Invariant Verification

1. **Transactional Coupling**: Every local business mutation and its corresponding outbox sync event are committed within the **same PostgreSQL transaction**. If outbox event insertion fails, the entire business mutation rolls back.
2. **Sales Invariant**: Every committed sale emits exactly one `SALE_COMPLETED` outbox event containing sale items, payments, stock movements, and batch changes.
3. **Idempotent Delivery**: All remote commands and local sync events carry immutable `idempotency_key` identifiers. Retries return existing processed outcomes without double-counting inventory or transactions.
