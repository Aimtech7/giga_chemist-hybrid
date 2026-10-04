# Legacy Data Mapping Specification

## Source: `chemist_pos.sql` (OSPOS MySQL Database)
## Destination: GIGA CHEMIST PostgreSQL / Supabase Schema

This document defines the comprehensive field-by-field mapping from the legacy POS database backup (`chemist_pos.sql`) into the current GIGA CHEMIST production PostgreSQL schema (`schema.sql`).

---

## 1. High-Level Architecture & Security Rules

1. **Authentication Exclusion (CRITICAL)**:
   - Old password hashes (`ospos_employees.password` MD5 strings) are **STRICTLY EXCLUDED**.
   - Old session tokens (`ospos_sessions`) are **STRICTLY EXCLUDED**.
   - Staff identities are preserved in `users` with uncredentialed / locked password hashes so historical sales and receipts retain accurate cashier attribution without compromising security.
   - Existing GIGA CHEMIST administrative accounts are preserved and protected.

2. **Idempotency & Traceability**:
   - A dedicated migration tracking table `legacy_migration_map` records `(source_table, source_id, target_table, target_id, migrated_at)`.
   - All legacy IDs are preserved via explicit identifiers (e.g. `SALE-LEGACY-{id}`, `PO-LEGACY-{id}`, `LEGACY-{id}`).

3. **Stock Reconciliation Without Double-Counting**:
   - `ospos_items.quantity` represents the authoritative final stock snapshot from the legacy system.
   - Initial batches and starting stock in `medicines` and `medicine_batches` are populated from this snapshot.
   - The 263,107 historical movements from `ospos_inventory` are imported into `inventory_movements` with `notes = 'LEGACY_POS: ...'` as an immutable audit log, without replaying or double-adjusting stock balances.

4. **Batch & Expiry Review Strategy**:
   - The legacy system did not enforce batch tracking or expiry date recording.
   - To maintain FEFO compliance without inventing falsified medical expiry dates, all legacy stock is assigned a traceable batch number `LEGACY-{item_id}` and marked with `notes = 'LEGACY_MIGRATION_REVIEW_REQUIRED'`.
   - A dedicated Batch/Expiry Review Report is generated to allow pharmacy staff to update actual physical batch numbers and expiry dates during stock audits.

---

## 2. Table-by-Table Field Mapping

### A. Store Configuration: `ospos_app_config` &rarr; `settings`

| Source Field (`ospos_app_config`) | Target Field (`settings`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `company` (`gigamart`) | `pharmacy_name` | Default fallback to 'GIGA CHEMIST' or legacy value | Exact |
| `address` (`Kitale`) | `address` | 'Kitale, Kenya' | Exact |
| `phone` (`0723570539`) | `phone` | Preserved directly | Exact |
| `email` | `email` | Fallback to 'info@gigachemist.co.ke' if empty | Fallback |
| `default_tax_rate` (`8`) | `tax_rate` | Numeric parse (e.g. 8.00) | Exact |
| `return_policy` (`Test`) | `receipt_footer` | Preserved or standard GIGA CHEMIST footer | Fallback |

---

### B. People & Staff: `ospos_people` + `ospos_employees` &rarr; `users`

| Source Field | Target Field (`users`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `ospos_employees.person_id` | `id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `first_name` + `last_name` | `name` | Capitalized, trimmed concatenation | Exact |
| `username` / `email` | `email` | `username@gigachemist.local` or valid email | Exact |
| `phone_number` | `phone` | Formatted phone number string | Exact |
| `ospos_employees.deleted` | `active` | `deleted == 0` &rarr; `true`, `deleted == 1` &rarr; `false` | Exact |
| `ospos_employees.username` | `role` | `'admin'` &rarr; `'ADMIN'`, others &rarr; `'CASHIER'` | Exact |
| **`ospos_employees.password`** | **`password_hash`** | **EXCLUDED (Set to locked random PBKDF2/bcrypt hash)** | **Security Enforced** |
| - | `pin_hash` | Set to locked random hash | Security Enforced |

---

### C. Suppliers: `ospos_suppliers` + `ospos_people` &rarr; `suppliers`

| Source Field | Target Field (`suppliers`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `ospos_suppliers.person_id` | `id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `company_name` | `name` | Uppercase trimmed supplier name | Exact |
| `first_name` + `last_name` | `contact_person` | Cleaned contact person name | Exact |
| `phone_number` | `phone` | Direct mapping; fallback to '+254 700 000 000' | Exact / Fallback |
| `email` | `email` | Trimmed email or NULL | Exact |
| `address_1` | `address` | Supplier address string | Exact |
| `account_number` | `tax_pin` | Account number / PIN reference | Exact |
| `deleted` | `status` | `deleted == 0` &rarr; `'active'`, `deleted == 1` &rarr; `'inactive'` | Exact |

---

### D. Customers: `ospos_customers` + `ospos_people` &rarr; `customers`

| Source Field | Target Field (`customers`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `ospos_customers.person_id` | `id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `first_name` + `last_name` | `name` | Cleaned name string | Exact |
| `phone_number` | `phone` | Direct mapping or NULL | Exact |
| `email` | `email` | Direct mapping or NULL | Exact |
| `address_1` | `address` | Direct mapping or NULL | Exact |
| `account_number` | `notes` | Preserved in customer notes | Exact |

---

### E. Categories: `ospos_items.category` &rarr; `categories`

| Source Field | Target Field (`categories`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `category` | `name` | Trimmed, deduplicated case-insensitively. Generic symbols (`.`, `p`) mapped to 'General Pharmaceutical' | Cleaned |
| - | `description` | 'Imported from legacy POS formulary category' | Generated |

---

### F. Products / Formulary: `ospos_items` &rarr; `medicines`

| Source Field (`ospos_items`) | Target Field (`medicines`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `item_id` | `id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `name` | `name` | Cleaned medicine name | Exact |
| `name` | `generic_name` | Populated from name | Fallback |
| `item_number` | `barcode` | Direct if present, else `GC-LEGACY-{item_id.padStart(6, '0')}` | Exact / Generated |
| `item_number` | `sku` | Direct if present, else `SKU-LEGACY-{item_id.padStart(6, '0')}` | Exact / Generated |
| `category` | `category_id` | Mapped category UUID | Exact |
| `cost_price` | `purchase_price` | Numeric decimal value | Exact |
| `unit_price` | `selling_price` | Numeric decimal value | Exact |
| `quantity` | `current_stock` | Final legacy quantity snapshot | Exact |
| `reorder_level` | `reorder_level` | Numeric integer value (default 20 if 0) | Exact |
| `location` | `description` | 'Legacy Location: ' + location | Contextual |
| `deleted` | `status` | `deleted == 0` &rarr; `'active'`, `deleted == 1` &rarr; `'inactive'` | Exact |
| `supplier_id` | `manufacturer` | Mapped supplier company name if linked | Contextual |
| - | `dosage_strength` | 'Standard' | Fallback |
| - | `dosage_form` | Inferred from category (Syrup, Tablets, Cream, Drops, Unit) | Inferred |
| - | `unit` | 'Unit' | Fallback |

---

### G. Opening Stock Batches: `ospos_items` &rarr; `medicine_batches`

| Source Field (`ospos_items`) | Target Field (`medicine_batches`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `item_id` | `medicine_id` | Mapped medicine UUID | Exact |
| - | `batch_number` | `LEGACY-{item_id}` | Traceable Code |
| `quantity` | `quantity_received` | `GREATEST(ROUND(quantity), 0)` | Exact |
| `quantity` | `quantity_available` | `GREATEST(ROUND(quantity), 0)` | Exact |
| `cost_price` | `purchase_price` | Legacy cost price snapshot | Exact |
| - | `manufacturing_date` | `NULL` | Truthful Null |
| - | `expiry_date` | `NULL` | Truthful Null |
| - | `received_date` | `NULL` | Truthful Null |
| - | `expiry_status` | `'UNKNOWN'` | Traceable Status |
| `quantity` | `status` | `quantity > 0` &rarr; `'active'`, `quantity <= 0` &rarr; `'exhausted'` | Exact |
| - | `notes` | `'LEGACY_MIGRATION_REVIEW_REQUIRED'` | Audit Flag |

---

### H. Purchases / Receivings: `ospos_receivings` + `ospos_receivings_items` &rarr; `purchases` + `purchase_items`

| Source Field | Target Field | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `receiving_id` | `purchases.id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `receiving_id` | `purchases.order_number` | `PO-LEGACY-{receiving_id}` | Traceable Code |
| `receiving_id` | `purchases.invoice_number` | `INV-LEGACY-{receiving_id}` | Traceable Code |
| `supplier_id` | `purchases.supplier_id` | Mapped supplier UUID (or default generic supplier) | Exact |
| `receiving_time` | `purchases.order_date` | Timestamp to date | Exact |
| `receiving_time` | `purchases.received_date` | Timestamp to date | Exact |
| - | `purchases.status` | `'received'` | Exact |
| Line item sums | `purchases.total_amount` | Sum of `quantity_purchased * item_cost_price` | Exact |
| `payment_type` | `purchases.payment_status` | `'paid'` | Exact |
| `receiving_items.item_id` | `purchase_items.medicine_id`| Mapped medicine UUID | Exact |
| `quantity_purchased` | `purchase_items.quantity` | Numeric integer | Exact |
| `item_cost_price` | `purchase_items.purchase_price`| Snapshot purchase cost | Exact |
| Line total | `purchase_items.total` | `quantity_purchased * item_cost_price` | Exact |

---

### I. Historical Sales & Payments: `ospos_sales` + `ospos_sales_items` + `ospos_sales_payments` &rarr; `sales` + `sale_items` + `payments`

| Source Field | Target Field | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `sale_id` | `sales.id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `sale_id` | `sales.sale_number` | `SALE-LEGACY-{sale_id}` | Traceable Code |
| `sale_id` | `sales.receipt_number` | `REC-LEGACY-{sale_id}` | Traceable Code |
| `sale_id` | `sales.idempotency_key`| `LEGACY-SALE-{sale_id}` | Idempotency Key |
| `employee_id` | `sales.cashier_id` | Mapped employee UUID | Exact |
| `customer_id` | `sales.customer_id` | Mapped customer UUID or NULL | Exact |
| `sale_time` | `sales.date` | Date portion (`YYYY-MM-DD`) | Exact |
| `sale_time` | `sales.time` | Time portion (`HH:MM:SS`) | Exact |
| `sales_items` calculation | `sales.subtotal` | Sum of `(item_unit_price * quantity_purchased)` | Exact |
| `sales_items` calculation | `sales.discount_total` | Sum of `(item_unit_price * quantity_purchased * discount_percent / 100)` | Exact |
| `sales_items_taxes` | `sales.tax_total` | Tax line sum or 0.00 | Exact |
| `sales_items` net total | `sales.total` | Net total payable | Exact |
| `sales_items` cost sum | `sales.cost_total` | Sum of `(item_cost_price * quantity_purchased)` | Exact |
| Net profit | `sales.gross_profit` | `total - cost_total` | Exact |
| `ospos_sales_payments` | `sales.payment_method` | Normalized payment type ('Cash', 'M-Pesa', 'Card') | Exact |
| `payment_amount` | `sales.amount_received`| Amount received | Exact |
| - | `sales.status` | `'completed'` | Exact |
| `sales_items.item_id` | `sale_items.medicine_id` | Mapped medicine UUID | Exact |
| `sales_items.item_id` | `sale_items.batch_id` | Mapped legacy batch UUID | Exact |
| `quantity_purchased` | `sale_items.quantity` | Quantity sold | Exact |
| `item_unit_price` | `sale_items.unit_price` | Historical sale price snapshot | Exact |
| `item_cost_price` | `sale_items.cost_price_snapshot` | Historical cost price snapshot | Exact |
| `discount_percent` | `sale_items.discount` | Line discount amount | Exact |
| `payment_amount` | `payments.amount` | Payment record amount | Exact |
| `payment_type` | `payments.method` | 'Cash' | Exact |

---

### J. Inventory Movements: `ospos_inventory` &rarr; `inventory_movements`

| Source Field (`ospos_inventory`) | Target Field (`inventory_movements`) | Conversion Rule / Default | Status |
| :--- | :--- | :--- | :--- |
| `trans_id` | `id` | Deterministic UUID mapped via `legacy_migration_map` | Exact |
| `trans_items` | `medicine_id` | Mapped medicine UUID | Exact |
| `trans_items` | `batch_id` | Mapped opening batch UUID | Exact |
| `trans_inventory` | `adjustment_quantity` | Quantity delta (+ / -) | Exact |
| `trans_comment` | `movement_type` | Inferred: 'POS' &rarr; 'SALE', 'RECV' &rarr; 'PURCHASE', other &rarr; 'ADJUSTMENT' | Inferred |
| `trans_id` | `reference_id` | `LEGACY-TRANS-{trans_id}` | Traceable Code |
| `trans_comment` | `notes` | `LEGACY_POS: {trans_comment}` | Exact |
| `trans_user` | `user_id` | Mapped employee UUID | Exact |
| `trans_date` | `timestamp` | Epoch millisecond timestamp | Exact |
| `trans_date` | `created_at` | Timestamp | Exact |

---

## 3. Unmapped Legacy Elements

| Source Table / Field | Description | Reason for Exclusion / Alternate Handling |
| :--- | :--- | :--- |
| `ospos_employees.password` | MD5 password hash | **Security Requirement:** Passwords must not be migrated. |
| `ospos_sessions.*` | Active web session data | **Security Requirement:** Ephemeral PHP sessions excluded. |
| `ospos_giftcards` | Giftcards table (0 rows) | Empty table in legacy database. |
| `ospos_item_kits` | Item kits / bundles (0 rows) | Empty table in legacy database. |
| `ospos_item_kit_items` | Kit items (0 rows) | Empty table in legacy database. |
| `ospos_modules` | CodeIgniter module registry | OSPOS navigation registry, not relevant to PostgreSQL data model. |
| `ospos_permissions` | OSPOS module permissions | Replaced by GIGA CHEMIST RBAC system. |
| `ospos_items.custom1..10` | Custom columns (all '0') | Empty placeholder fields in legacy database. |
