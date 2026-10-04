# GIGA CHEMIST — Unmapped & Legacy Compatibility Report

## Overview
This document records all legacy database elements from `chemist_pos.sql` that were either intentionally excluded, transformed into alternative structures, or noted for operational reference.

---

## 1. Table-by-Table Disposition

| Legacy Table Name | Legacy Row Count | Status in Migration | Detailed Rationale |
| :--- | :--- | :--- | :--- |
| `ospos_app_config` | 27 rows | **Transformed** | Pharmacy name, address, phone, and tax rate migrated to GIGA CHEMIST `settings` table. Unused UI flags omitted. |
| `ospos_customers` | 1 row | **Transformed** | Customer account details joined with `ospos_people` and migrated to `customers` table. |
| `ospos_employees` | 5 rows | **Sanitized & Transformed** | Staff identities migrated to `users` with zero passwords/hashes. |
| `ospos_giftcards` | 0 rows | **Skipped** | Empty table in legacy database. |
| `ospos_inventory` | 263,107 rows | **Transformed (Audit Log)** | Preserved in `inventory_movements` as historical ledger marked with `notes = 'LEGACY_POS: ...'`. |
| `ospos_items` | 2,181 rows | **Transformed** | Migrated to `medicines` and opening `medicine_batches`. |
| `ospos_items_taxes` | 1 row | **Transformed** | Default tax rate incorporated into global settings. |
| `ospos_item_kits` | 0 rows | **Skipped** | Empty table in legacy database. |
| `ospos_item_kit_items` | 0 rows | **Skipped** | Empty table in legacy database. |
| `ospos_modules` | 10 rows | **Skipped** | CodeIgniter navigation structure; superseded by GIGA CHEMIST React/TypeScript frontend routing. |
| `ospos_people` | 12 rows | **Transformed** | Entity contact registry merged with suppliers, customers, and staff profiles. |
| `ospos_permissions` | 8 rows | **Skipped** | OSPOS module bitmasks; superseded by GIGA CHEMIST role-based access control (RBAC). |
| `ospos_receivings` | 728 rows | **Transformed** | Migrated to `purchases` table. |
| `ospos_receivings_items` | 2,524 rows | **Transformed** | Migrated to `purchase_items` table. |
| `ospos_sales` | 135,818 rows | **Transformed** | Migrated to `sales` table. |
| `ospos_sales_items` | 226,401 rows | **Transformed** | Migrated to `sale_items` table. |
| `ospos_sales_items_taxes` | 698 rows | **Transformed** | Tax components reconciled into sales records. |
| `ospos_sales_payments` | 135,817 rows | **Transformed** | Migrated to `payments` table. |
| `ospos_sales_suspended` | 6 rows | **Preserved in Audit** | Historical suspended sales from 2017 archived for reference. |
| `ospos_sales_suspended_items` | 13 rows | **Preserved in Audit** | Suspended sale item lines archived. |
| `ospos_sales_suspended_payments` | 6 rows | **Preserved in Audit** | Suspended sale payments archived. |
| `ospos_sessions` | 1 row | **Excluded** | Ephemeral PHP session state discarded for security. |
| `ospos_suppliers` | 6 rows | **Transformed** | Joined with `ospos_people` and migrated to `suppliers` (+1 default fallback supplier created). |

---

## 2. Unpopulated Legacy Columns

The following columns in `ospos_items` existed in the legacy table definition but contained default `'0'` or empty values across all 2,181 rows:
- `custom1` through `custom10` (Unused custom fields in legacy POS).
- `allow_alt_description` (Legacy boolean flag).
- `is_serialized` (Legacy serialized inventory flag).
- `giftcard_number` (Giftcard system unutilized).

---

## 3. Data Integrity & Loss Assessment
- **Zero Business Data Loss:** 100% of historical medicines, stock balances, customers, suppliers, purchases, sales, line items, payments, and inventory ledger movements have been preserved and transformed.
- **Source Preservation:** The original backup file `chemist_pos.sql` remains completely untouched and unmodified at the root of the workspace.
