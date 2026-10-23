# SHOP 2 LEGACY SQLITE MIGRATION PIPELINE

## Overview
This directory contains the migration workflow for transitioning Shop 2 from its existing legacy SQLite point-of-sale database to GIGA CHEMIST PostgreSQL.
**NOTE**: Do NOT invent or assume legacy field mappings until the actual Shop 2 SQLite file has been received and inspected.

---

## Planned Sequential Migration Workflow

### Step 1: Ingestion & Protection
- Receive the Shop 2 SQLite backup file.
- Immediately create an untouched, read-only SHA-256 verified backup copy in `backup/`.

### Step 2: Schema & Entity Discovery
- Inspect table structures, columns, indexes, and primary keys.
- Count exact rows across all tables.
- Identify core entities:
  - Medicines & Categories
  - Batches, Expiry Dates, and Stock Quantities
  - Historical Sales Invoices & Line Items
  - Payments & Payment Methods
  - Purchases & Supplier Deliveries
  - System Users, Passwords & Permissions
  - Suppliers & Customer Accounts

### Step 3: Mapping & Transformation Design
- Map legacy fields to GIGA CHEMIST PostgreSQL schema:
  - Handle nulls, legacy dates, and negative quantities.
  - Map cashier/manager accounts with temporary secure passwords (forced reset).
  - Map batch numbers and expiry date fallbacks for items with missing expiry data.

### Step 4: Staging & Execution
- Run dry-run execution against `giga_chemist_shop2_dev`.
- Verify foreign key integrity and constraint satisfaction.
- Commit actual migration in a transactional batch.

### Step 5: Financial & Inventory Validation
- Compare legacy vs PostgreSQL counts:
  - Exact row parity for medicines, batches, sales, line items.
- Validate total financial sales value (legacy sum vs new sum).
- Validate physical on-hand stock quantities.
- Check negative stock = 0.

### Step 6: Package Creation
- Dump the validated PostgreSQL data into `shop2-migrated-seed.sql`.
- Bundle into `GIGA-CHEMIST-SHOP2-PACKAGE` for final offline deployment.

---

## Placeholder Scripts & Tools
- `analyze-shop2-sqlite.ts` (Placeholder schema analyzer)
- `migrate-shop2.ts` (Placeholder migration runner)
- `validate-shop2-migration.ts` (Placeholder validation auditor)
- `backup/` (Directory for incoming original SQLite database file)
