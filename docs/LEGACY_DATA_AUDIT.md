# Legacy Database Audit Report — `chemist_pos.sql`

**Audit Date:** 2026-10-01T21:45:21.394Z
**Source File:** `chemist_pos.sql` (39.16 MB, 769,051 lines)

## 1. Dump Metadata

```sql
-- phpMyAdmin SQL Dump
-- version 3.2.4
-- http://www.phpmyadmin.net
--
-- Host: localhost
-- Generation Time: Oct 01, 2026 at 05:11 AM
-- Server version: 5.1.41
-- PHP Version: 5.3.1

SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8 */;

--
-- Database: `chemist_pos`
--
```

## 2. Table Summary & Accurate Row Counts

| Table Name | Row Count | Primary Key(s) | Column Count | Status / Classification |
| :--- | :--- | :--- | :--- | :--- |
| `ospos_app_config` | **27** | `key` | 2 | ⚙️ Configuration |
| `ospos_customers` | **1** | None | 4 | 👥 Contacts & Entities |
| `ospos_employees` | **5** | None | 4 | ⚠️ **Auth / Security (EXCLUDE PASSWORDS)** |
| `ospos_giftcards` | **0** | `giftcard_id` | 5 | Business Data |
| `ospos_inventory` | **263,107** | `trans_id` | 6 | 📦 Products & Inventory |
| `ospos_items` | **2,181** | `item_id` | 24 | 📦 Products & Inventory |
| `ospos_items_taxes` | **1** | `item_id`, `name`, `percent` | 3 | Business Data |
| `ospos_item_kits` | **0** | `item_kit_id` | 3 | 📦 Products & Inventory |
| `ospos_item_kit_items` | **0** | `item_kit_id`, `item_id`, `quantity` | 3 | 📦 Products & Inventory |
| `ospos_modules` | **10** | `module_id` | 4 | Business Data |
| `ospos_people` | **12** | `person_id` | 12 | 👥 Contacts & Entities |
| `ospos_permissions` | **8** | `module_id`, `person_id` | 2 | Business Data |
| `ospos_receivings` | **728** | `receiving_id` | 6 | 🚚 Purchases / Receivings |
| `ospos_receivings_items` | **2,524** | `receiving_id`, `item_id`, `line` | 9 | 🚚 Purchases / Receivings |
| `ospos_sales` | **135,818** | `sale_id` | 6 | 💰 Sales & Transactions |
| `ospos_sales_items` | **226,401** | `sale_id`, `item_id`, `line` | 9 | 💰 Sales & Transactions |
| `ospos_sales_items_taxes` | **698** | `sale_id`, `item_id`, `line`, `name`, `percent` | 5 | 💰 Sales & Transactions |
| `ospos_sales_payments` | **135,817** | `sale_id`, `payment_type` | 3 | 💰 Sales & Transactions |
| `ospos_sales_suspended` | **6** | `sale_id` | 6 | 💰 Sales & Transactions |
| `ospos_sales_suspended_items` | **13** | `sale_id`, `item_id`, `line` | 9 | 💰 Sales & Transactions |
| `ospos_sales_suspended_items_taxes` | **0** | `sale_id`, `item_id`, `line`, `name`, `percent` | 5 | Business Data |
| `ospos_sales_suspended_payments` | **6** | `sale_id`, `payment_type` | 3 | 💰 Sales & Transactions |
| `ospos_sessions` | **1** | `session_id` | 5 | ⚠️ **Auth / Security (EXCLUDE PASSWORDS)** |
| `ospos_suppliers` | **6** | None | 4 | 👥 Contacts & Entities |

**Total Data Rows:** 767,370

## 3. Historical Sales & Payment Summary

- **Date Range:** `1980-01-03 16:01:19` to `2026-10-01 06:26:07`

### Payment Breakdown in Legacy Dump

| Payment Type | Transaction Count | Total Amount (KES) |
| :--- | :--- | :--- |
| `Cash` | 135,817 | **45,360,422.53** |
| **TOTAL** | - | **45,360,422.53** |

## 4. Detailed Schema Structure per Table

### Table: `ospos_app_config` (27 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `key` | `varchar(255)` | NO | 🔑 YES |
| `value` | `varchar(255)` | NO | NO |

### Table: `ospos_customers` (1 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `person_id` | `int(10)` | NO | NO |
| `account_number` | `varchar(255)` | YES | NO |
| `taxable` | `int(1)` | NO | NO |
| `deleted` | `int(1)` | NO | NO |

### Table: `ospos_employees` (5 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `username` | `varchar(255)` | NO | NO |
| `password` | `varchar(255)` | NO | NO |
| `person_id` | `int(10)` | NO | NO |
| `deleted` | `int(1)` | NO | NO |

### Table: `ospos_giftcards` (0 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `giftcard_id` | `int(11)` | NO | 🔑 YES |
| `giftcard_number` | `varchar(25)` | NO | NO |
| `value` | `double(15,2)` | NO | NO |
| `deleted` | `int(1)` | NO | NO |
| `person_id` | `int(11)` | NO | NO |

### Table: `ospos_inventory` (263,107 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `trans_id` | `int(11)` | NO | 🔑 YES |
| `trans_items` | `int(11)` | NO | NO |
| `trans_user` | `int(11)` | NO | NO |
| `trans_date` | `timestamp` | NO | NO |
| `trans_comment` | `text` | NO | NO |
| `trans_inventory` | `int(11)` | NO | NO |

### Table: `ospos_items` (2,181 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `name` | `varchar(255)` | NO | NO |
| `category` | `varchar(255)` | NO | NO |
| `supplier_id` | `int(11)` | YES | NO |
| `item_number` | `varchar(255)` | YES | NO |
| `description` | `varchar(255)` | NO | NO |
| `cost_price` | `double(15,2)` | NO | NO |
| `unit_price` | `double(15,2)` | NO | NO |
| `quantity` | `double(15,2)` | NO | NO |
| `reorder_level` | `double(15,2)` | NO | NO |
| `location` | `varchar(255)` | NO | NO |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `allow_alt_description` | `tinyint(1)` | NO | NO |
| `is_serialized` | `tinyint(1)` | NO | NO |
| `deleted` | `int(1)` | NO | NO |
| `custom1` | `varchar(25)` | NO | NO |
| `custom2` | `varchar(25)` | NO | NO |
| `custom3` | `varchar(25)` | NO | NO |
| `custom4` | `varchar(25)` | NO | NO |
| `custom5` | `varchar(25)` | NO | NO |
| `custom6` | `varchar(25)` | NO | NO |
| `custom7` | `varchar(25)` | NO | NO |
| `custom8` | `varchar(25)` | NO | NO |
| `custom9` | `varchar(25)` | NO | NO |
| `custom10` | `varchar(25)` | NO | NO |

### Table: `ospos_items_taxes` (1 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `name` | `varchar(255)` | NO | 🔑 YES |
| `percent` | `double(15,3)` | NO | 🔑 YES |

### Table: `ospos_item_kits` (0 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `item_kit_id` | `int(11)` | NO | 🔑 YES |
| `name` | `varchar(255)` | NO | NO |
| `description` | `varchar(255)` | NO | NO |

### Table: `ospos_item_kit_items` (0 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `item_kit_id` | `int(11)` | NO | 🔑 YES |
| `item_id` | `int(11)` | NO | 🔑 YES |
| `quantity` | `double(15,2)` | NO | 🔑 YES |

### Table: `ospos_modules` (10 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `name_lang_key` | `varchar(255)` | NO | NO |
| `desc_lang_key` | `varchar(255)` | NO | NO |
| `sort` | `int(10)` | NO | NO |
| `module_id` | `varchar(255)` | NO | 🔑 YES |

### Table: `ospos_people` (12 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `first_name` | `varchar(255)` | NO | NO |
| `last_name` | `varchar(255)` | NO | NO |
| `phone_number` | `varchar(255)` | NO | NO |
| `email` | `varchar(255)` | NO | NO |
| `address_1` | `varchar(255)` | NO | NO |
| `address_2` | `varchar(255)` | NO | NO |
| `city` | `varchar(255)` | NO | NO |
| `state` | `varchar(255)` | NO | NO |
| `zip` | `varchar(255)` | NO | NO |
| `country` | `varchar(255)` | NO | NO |
| `comments` | `text` | NO | NO |
| `person_id` | `int(10)` | NO | 🔑 YES |

### Table: `ospos_permissions` (8 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `module_id` | `varchar(255)` | NO | 🔑 YES |
| `person_id` | `int(10)` | NO | 🔑 YES |

### Table: `ospos_receivings` (728 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `receiving_time` | `timestamp` | NO | NO |
| `supplier_id` | `int(10)` | YES | NO |
| `employee_id` | `int(10)` | NO | NO |
| `comment` | `text` | NO | NO |
| `receiving_id` | `int(10)` | NO | 🔑 YES |
| `payment_type` | `varchar(20)` | YES | NO |

### Table: `ospos_receivings_items` (2,524 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `receiving_id` | `int(10)` | NO | 🔑 YES |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `description` | `varchar(30)` | YES | NO |
| `serialnumber` | `varchar(30)` | YES | NO |
| `line` | `int(3)` | NO | 🔑 YES |
| `quantity_purchased` | `int(10)` | NO | NO |
| `item_cost_price` | `decimal(15,2)` | NO | NO |
| `item_unit_price` | `double(15,2)` | NO | NO |
| `discount_percent` | `int(11)` | NO | NO |

### Table: `ospos_sales` (135,818 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_time` | `timestamp` | NO | NO |
| `customer_id` | `int(10)` | YES | NO |
| `employee_id` | `int(10)` | NO | NO |
| `comment` | `text` | NO | NO |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `payment_type` | `varchar(512)` | YES | NO |

### Table: `ospos_sales_items` (226,401 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `description` | `varchar(30)` | YES | NO |
| `serialnumber` | `varchar(30)` | YES | NO |
| `line` | `int(3)` | NO | 🔑 YES |
| `quantity_purchased` | `double(15,2)` | NO | NO |
| `item_cost_price` | `decimal(15,2)` | NO | NO |
| `item_unit_price` | `double(15,2)` | NO | NO |
| `discount_percent` | `int(11)` | NO | NO |

### Table: `ospos_sales_items_taxes` (698 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `line` | `int(3)` | NO | 🔑 YES |
| `name` | `varchar(255)` | NO | 🔑 YES |
| `percent` | `double(15,3)` | NO | 🔑 YES |

### Table: `ospos_sales_payments` (135,817 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `payment_type` | `varchar(40)` | NO | 🔑 YES |
| `payment_amount` | `decimal(15,2)` | NO | NO |

### Table: `ospos_sales_suspended` (6 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_time` | `timestamp` | NO | NO |
| `customer_id` | `int(10)` | YES | NO |
| `employee_id` | `int(10)` | NO | NO |
| `comment` | `text` | NO | NO |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `payment_type` | `varchar(512)` | YES | NO |

### Table: `ospos_sales_suspended_items` (13 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `description` | `varchar(30)` | YES | NO |
| `serialnumber` | `varchar(30)` | YES | NO |
| `line` | `int(3)` | NO | 🔑 YES |
| `quantity_purchased` | `double(15,2)` | NO | NO |
| `item_cost_price` | `decimal(15,2)` | NO | NO |
| `item_unit_price` | `double(15,2)` | NO | NO |
| `discount_percent` | `int(11)` | NO | NO |

### Table: `ospos_sales_suspended_items_taxes` (0 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `item_id` | `int(10)` | NO | 🔑 YES |
| `line` | `int(3)` | NO | 🔑 YES |
| `name` | `varchar(255)` | NO | 🔑 YES |
| `percent` | `double(15,3)` | NO | 🔑 YES |

### Table: `ospos_sales_suspended_payments` (6 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `sale_id` | `int(10)` | NO | 🔑 YES |
| `payment_type` | `varchar(40)` | NO | 🔑 YES |
| `payment_amount` | `decimal(15,2)` | NO | NO |

### Table: `ospos_sessions` (1 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `session_id` | `varchar(40)` | NO | 🔑 YES |
| `ip_address` | `varchar(16)` | NO | NO |
| `user_agent` | `varchar(120)` | NO | NO |
| `last_activity` | `int(10)` | NO | NO |
| `user_data` | `text` | YES | NO |

### Table: `ospos_suppliers` (6 rows)

| Column | Type | Nullable | Primary Key |
| :--- | :--- | :--- | :--- |
| `person_id` | `int(10)` | NO | NO |
| `company_name` | `varchar(255)` | NO | NO |
| `account_number` | `varchar(255)` | YES | NO |
| `deleted` | `int(1)` | NO | NO |

