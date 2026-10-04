# GIGA CHEMIST — Batch & Expiry Review Report

## Executive Context & Regulatory Compliance
In pharmaceutical inventory management, **FEFO (First Expiring, First Out)** is required to prevent expired medicines from being dispensed.

During the audit of the legacy POS database backup (`chemist_pos.sql` / Open Source Point of Sale 2.1.3), it was discovered that:
1. The legacy schema did **not** possess native columns for batch numbers or manufacturer expiry dates.
2. Custom fields (`custom1` to `custom10` in `ospos_items`) were unpopulated (`'0'` or empty).
3. Inventory transaction comments (`ospos_inventory.trans_comment`) only recorded cashier sale IDs, receiving IDs, or manual adjustment tags without batch metadata.

---

## 1. Truth-Based Policy (Zero Fake Expiry Dates)
In strict accordance with clinical pharmacy standards and data migration safety rules:
- **No fake or placeholder expiration dates are fabricated.**
- Storing fabricated future dates (e.g. `2029-12-31`) would mask unverified stock and bypass safety checks.
- All 2,181 migrated medicines are assigned a standardized, truth-based structure in `medicine_batches`:
  - **Batch Number Format:** `LEGACY-{legacy_item_id}`
  - **Expiry Date:** `NULL` (Truthfully unrecorded)
  - **Manufacturing Date:** `NULL`
  - **Received Date:** `NULL`
  - **Expiry Status:** `'UNKNOWN'`
  - **Audit Flag / Notes:** `LEGACY_MIGRATION_REVIEW_REQUIRED`
  - **Active vs Exhausted:** Items with positive stock balance are marked `status = 'active'`; zero/negative stock balances are marked `status = 'exhausted'`.

### POS Dispensing Safety Policy for Unknown-Expiry Stock:
1. **Visual Badge:** POS dispensing screen displays a distinct amber warning badge: `⚠️ Expiry Unverified (Legacy Batch)`.
2. **Authorized Verification Prompt:** When a cashier selects a legacy batch with `expiry_status = 'UNKNOWN'`, a confirmation dialog alerts: *"This stock originated from legacy POS migration without verified expiry. Please physically confirm shelf packaging before dispensing."*
3. **Audit Trail:** Cashier checkout confirmation is logged in `audit_logs`.

---

## 2. Stock Distribution Summary for Pharmacy Review

| Stock Status Category | Number of Formulary Items | Total Units | Pharmacy Action Required |
| :--- | :--- | :--- | :--- |
| **Positive Current Stock** | **1,307 medicines** | **43,686 units** | **Conduct physical stocktake: record actual manufacturer batch numbers and physical expiry dates on pharmacy shelves.** |
| **Zero Stock (Out of Stock)**| **628 medicines** | **0 units** | **No immediate action. When new stock arrives via PO / Receiving, enter real batch & expiry.** |
| **Negative Stock (Over-sold)**| **244 medicines** | **-3 units net** | **Physical count audit required: reconcile shelf count with stock adjustment.** |
| **Inactive / Deleted Items** | **146 medicines** | **0 units** | **Archived historically. Kept for historical sales audit integrity.** |

---

## 3. Step-by-Step Procedure for Physical Stock Review

To complete the batch & expiry transition during live onboarding at GIGA CHEMIST:

1. **Access GIGA CHEMIST Formulary / Batch Management**:
   - Log in as `ADMIN` or `MANAGER`.
   - Navigate to **Inventory & Stock** &rarr; **Batch Management**.

2. **Filter by `LEGACY_MIGRATION_REVIEW_REQUIRED`**:
   - The UI highlights all opening batches created during migration.

3. **Perform Shelf Audit by Category**:
   - Start with high-turnover categories (e.g. *Antibiotics*, *Painkillers*, *Cough Syrups*, *Antacids*).
   - Enter the actual manufacturer Batch Number stamped on the blister pack / bottle.
   - Enter the actual Expiry Date stamped on the packaging.
   - Click **Save Batch Details**.

4. **FEFO Enforcement**:
   - As soon as real expiry dates are updated, GIGA CHEMIST's FEFO engine will automatically prioritize dispensing the nearest-expiring batches first during POS checkout.
