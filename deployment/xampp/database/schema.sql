-- ====================================================================
-- GIGA CHEMIST - Production MySQL Schema for XAMPP (Local Environment)
-- Compatible with MySQL 5.1+ / 5.5+ / 5.6+ / 5.7+ / MariaDB / PHP PDO
-- ====================================================================

CREATE DATABASE IF NOT EXISTS `giga_chemist` 
  DEFAULT CHARACTER SET utf8 
  COLLATE utf8_unicode_ci;

USE `giga_chemist`;

SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------
-- 1. Users Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) DEFAULT NULL,
  `name` VARCHAR(100) NOT NULL,
  `email` VARCHAR(100) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('ADMIN', 'MANAGER', 'CASHIER') NOT NULL DEFAULT 'CASHIER',
  `phone` VARCHAR(30) DEFAULT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` VARCHAR(50) NOT NULL,
  `last_login` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_users_role` (`role`),
  INDEX `idx_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 2. Roles Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `roles` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `created_at` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 3. Permissions Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `permissions` (
  `id` VARCHAR(50) NOT NULL,
  `code` VARCHAR(50) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `module` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 4. User Roles Mapping Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_roles` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `role_id` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_user_roles_user` (`user_id`),
  INDEX `idx_user_roles_role` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 5. Role Permissions Mapping Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id` VARCHAR(50) NOT NULL,
  `role_id` VARCHAR(50) NOT NULL,
  `permission_id` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_role_perm_role` (`role_id`),
  INDEX `idx_role_perm_permission` (`permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 6. Devices Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `devices` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `device_type` VARCHAR(20) DEFAULT 'desktop',
  `app_version` VARCHAR(20) DEFAULT '1.0.0',
  `first_registered` VARCHAR(50) DEFAULT NULL,
  `last_seen` VARCHAR(50) DEFAULT NULL,
  `last_synced_at` VARCHAR(50) DEFAULT NULL,
  `current_user_id` VARCHAR(50) DEFAULT NULL,
  `branch_id` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 7. Categories Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `categories` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `created_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 8. Medicines Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medicines` (
  `id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) DEFAULT NULL,
  `name` VARCHAR(190) NOT NULL,
  `generic_name` VARCHAR(255) DEFAULT NULL,
  `brand_name` VARCHAR(255) DEFAULT NULL,
  `sku` VARCHAR(100) DEFAULT NULL,
  `barcode` VARCHAR(100) DEFAULT NULL,
  `category` VARCHAR(100) DEFAULT NULL,
  `medicine_type` VARCHAR(100) DEFAULT NULL,
  `dosage_strength` VARCHAR(100) DEFAULT NULL,
  `dosage_form` VARCHAR(50) DEFAULT 'Tablet',
  `manufacturer` VARCHAR(255) DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `purchase_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `selling_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `wholesale_price` DECIMAL(12,2) DEFAULT NULL,
  `min_selling_price` DECIMAL(12,2) DEFAULT NULL,
  `current_stock` INT NOT NULL DEFAULT 0,
  `reorder_level` INT NOT NULL DEFAULT 10,
  `unit` VARCHAR(50) DEFAULT 'Unit',
  `prescription_required` TINYINT(1) NOT NULL DEFAULT 0,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `created_at` VARCHAR(50) DEFAULT NULL,
  `updated_at` VARCHAR(50) DEFAULT NULL,
  `created_by` VARCHAR(100) DEFAULT 'System',
  `updated_by` VARCHAR(100) DEFAULT 'System',
  `version` INT DEFAULT 1,
  PRIMARY KEY (`id`),
  INDEX `idx_medicines_barcode` (`barcode`),
  INDEX `idx_medicines_name` (`name`),
  INDEX `idx_medicines_category` (`category`),
  INDEX `idx_medicines_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 9. Medicine Batches Table (FEFO & Expiry Tracking)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medicine_batches` (
  `id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) DEFAULT NULL,
  `medicine_id` VARCHAR(50) NOT NULL,
  `medicine_name` VARCHAR(255) DEFAULT NULL,
  `batch_number` VARCHAR(100) NOT NULL,
  `supplier_id` VARCHAR(50) DEFAULT NULL,
  `supplier_name` VARCHAR(255) DEFAULT NULL,
  `quantity_received` INT NOT NULL DEFAULT 0,
  `quantity_available` INT NOT NULL DEFAULT 0,
  `purchase_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `selling_price_override` DECIMAL(12,2) DEFAULT NULL,
  `manufacturing_date` VARCHAR(50) DEFAULT NULL,
  `expiry_date` VARCHAR(50) NOT NULL,
  `received_date` VARCHAR(50) DEFAULT NULL,
  `purchase_invoice` VARCHAR(100) DEFAULT NULL,
  `created_by` VARCHAR(100) DEFAULT 'System',
  `created_at` VARCHAR(50) DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  INDEX `idx_batches_medicine` (`medicine_id`),
  INDEX `idx_batches_expiry` (`expiry_date`),
  INDEX `idx_batches_status` (`status`),
  INDEX `idx_batches_batch_num` (`batch_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 10. Suppliers Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `suppliers` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `contact_person` VARCHAR(100) DEFAULT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `email` VARCHAR(100) DEFAULT NULL,
  `address` TEXT DEFAULT NULL,
  `tax_pin` VARCHAR(50) DEFAULT NULL,
  `balance` DECIMAL(12,2) DEFAULT 0.00,
  `status` VARCHAR(20) DEFAULT 'active',
  `created_at` VARCHAR(50) DEFAULT NULL,
  `updated_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 11. Purchases Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `purchases` (
  `id` VARCHAR(50) NOT NULL,
  `supplier_id` VARCHAR(50) DEFAULT NULL,
  `supplier_name` VARCHAR(255) DEFAULT NULL,
  `invoice_number` VARCHAR(100) DEFAULT NULL,
  `purchase_date` VARCHAR(50) DEFAULT NULL,
  `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `payment_status` VARCHAR(50) DEFAULT 'paid',
  `notes` TEXT DEFAULT NULL,
  `created_by` VARCHAR(100) DEFAULT NULL,
  `created_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_purchases_supplier` (`supplier_id`),
  INDEX `idx_purchases_date` (`purchase_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 12. Purchase Items Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `purchase_items` (
  `id` VARCHAR(50) NOT NULL,
  `purchase_id` VARCHAR(50) NOT NULL,
  `medicine_id` VARCHAR(50) NOT NULL,
  `medicine_name` VARCHAR(255) DEFAULT NULL,
  `batch_number` VARCHAR(100) DEFAULT NULL,
  `expiry_date` VARCHAR(50) DEFAULT NULL,
  `quantity` INT NOT NULL,
  `unit_cost` DECIMAL(12,2) NOT NULL,
  `total_cost` DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_purchase_items_purchase` (`purchase_id`),
  INDEX `idx_purchase_items_medicine` (`medicine_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 13. Inventory Movements Table (Audit Trail)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `inventory_movements` (
  `id` VARCHAR(50) NOT NULL,
  `medicine_id` VARCHAR(50) NOT NULL,
  `batch_id` VARCHAR(50) DEFAULT NULL,
  `movement_type` VARCHAR(50) NOT NULL,
  `quantity` INT NOT NULL,
  `previous_stock` INT NOT NULL,
  `new_stock` INT NOT NULL,
  `reason` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(50) DEFAULT NULL,
  `user_name` VARCHAR(100) DEFAULT NULL,
  `device_id` VARCHAR(50) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `date` VARCHAR(50) DEFAULT NULL,
  `timestamp` BIGINT DEFAULT NULL,
  `created_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_movements_medicine` (`medicine_id`),
  INDEX `idx_movements_batch` (`batch_id`),
  INDEX `idx_movements_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 14. Customers Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `customers` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `email` VARCHAR(100) DEFAULT NULL,
  `address` TEXT DEFAULT NULL,
  `tax_pin` VARCHAR(50) DEFAULT NULL,
  `total_purchases` INT DEFAULT 0,
  `total_spent` DECIMAL(12,2) DEFAULT 0.00,
  `outstanding_balance` DECIMAL(12,2) DEFAULT 0.00,
  `credit_limit` DECIMAL(12,2) DEFAULT 0.00,
  `status` VARCHAR(20) DEFAULT 'active',
  `created_at` VARCHAR(50) DEFAULT NULL,
  `updated_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_customers_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 15. Sales Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales` (
  `id` VARCHAR(50) NOT NULL,
  `receipt_number` VARCHAR(100) NOT NULL UNIQUE,
  `cashier_id` VARCHAR(50) DEFAULT NULL,
  `cashier_name` VARCHAR(100) DEFAULT NULL,
  `customer_id` VARCHAR(50) DEFAULT NULL,
  `customer_name` VARCHAR(255) DEFAULT NULL,
  `subtotal` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `discount_amount` DECIMAL(12,2) DEFAULT 0.00,
  `tax_amount` DECIMAL(12,2) DEFAULT 0.00,
  `grand_total` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `payment_method` VARCHAR(50) NOT NULL DEFAULT 'Cash',
  `payment_status` VARCHAR(50) DEFAULT 'completed',
  `amount_tendered` DECIMAL(12,2) DEFAULT NULL,
  `change_given` DECIMAL(12,2) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `is_voided` TINYINT(1) DEFAULT 0,
  `void_reason` TEXT DEFAULT NULL,
  `voided_at` VARCHAR(50) DEFAULT NULL,
  `voided_by` VARCHAR(100) DEFAULT NULL,
  `device_id` VARCHAR(50) DEFAULT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL UNIQUE,
  `date` VARCHAR(50) NOT NULL,
  `created_at` VARCHAR(50) NOT NULL,
  `synced` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `idx_sales_receipt` (`receipt_number`),
  INDEX `idx_sales_date` (`date`),
  INDEX `idx_sales_cashier` (`cashier_id`),
  INDEX `idx_sales_idempotency` (`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 16. Sale Items Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sale_items` (
  `id` VARCHAR(50) NOT NULL,
  `sale_id` VARCHAR(50) NOT NULL,
  `medicine_id` VARCHAR(50) NOT NULL,
  `medicine_name` VARCHAR(255) NOT NULL,
  `batch_id` VARCHAR(50) DEFAULT NULL,
  `batch_number` VARCHAR(100) DEFAULT NULL,
  `expiry_date` VARCHAR(50) DEFAULT NULL,
  `quantity` INT NOT NULL,
  `unit_price` DECIMAL(12,2) NOT NULL,
  `cost_price` DECIMAL(12,2) DEFAULT 0.00,
  `discount` DECIMAL(12,2) DEFAULT 0.00,
  `total_price` DECIMAL(12,2) NOT NULL,
  `is_returned` TINYINT(1) DEFAULT 0,
  `returned_quantity` INT DEFAULT 0,
  `returned_amount` DECIMAL(12,2) DEFAULT 0.00,
  PRIMARY KEY (`id`),
  INDEX `idx_sale_items_sale` (`sale_id`),
  INDEX `idx_sale_items_med` (`medicine_id`),
  INDEX `idx_sale_items_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 17. Payments Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payments` (
  `id` VARCHAR(50) NOT NULL,
  `sale_id` VARCHAR(50) DEFAULT NULL,
  `customer_id` VARCHAR(50) DEFAULT NULL,
  `payment_type` VARCHAR(50) DEFAULT 'sale',
  `amount` DECIMAL(12,2) NOT NULL,
  `payment_method` VARCHAR(50) NOT NULL,
  `reference_number` VARCHAR(100) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `date` VARCHAR(50) DEFAULT NULL,
  `created_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_payments_sale` (`sale_id`),
  INDEX `idx_payments_customer` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 18. Customer Returns Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `customer_returns` (
  `id` VARCHAR(50) NOT NULL,
  `original_sale_id` VARCHAR(50) NOT NULL,
  `receipt_number` VARCHAR(100) NOT NULL,
  `customer_id` VARCHAR(50) DEFAULT NULL,
  `customer_name` VARCHAR(255) DEFAULT NULL,
  `total_refund_amount` DECIMAL(12,2) NOT NULL,
  `refund_method` VARCHAR(50) NOT NULL DEFAULT 'Cash',
  `reason` TEXT DEFAULT NULL,
  `cashier_id` VARCHAR(50) DEFAULT NULL,
  `cashier_name` VARCHAR(100) DEFAULT NULL,
  `device_id` VARCHAR(50) DEFAULT NULL,
  `date` VARCHAR(50) NOT NULL,
  `created_at` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_returns_orig_sale` (`original_sale_id`),
  INDEX `idx_returns_receipt` (`receipt_number`),
  INDEX `idx_returns_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 19. Customer Return Items Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `customer_return_items` (
  `id` VARCHAR(50) NOT NULL,
  `return_id` VARCHAR(50) NOT NULL,
  `sale_item_id` VARCHAR(50) NOT NULL,
  `medicine_id` VARCHAR(50) NOT NULL,
  `medicine_name` VARCHAR(255) NOT NULL,
  `batch_id` VARCHAR(50) DEFAULT NULL,
  `batch_number` VARCHAR(100) DEFAULT NULL,
  `quantity` INT NOT NULL,
  `refund_unit_price` DECIMAL(12,2) NOT NULL,
  `refund_subtotal` DECIMAL(12,2) NOT NULL,
  `restocked` TINYINT(1) DEFAULT 1,
  `restock_reason` VARCHAR(100) DEFAULT 'RESTOCKED_VALID_CONDITION',
  PRIMARY KEY (`id`),
  INDEX `idx_return_items_ret` (`return_id`),
  INDEX `idx_return_items_med` (`medicine_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 20. Expenses Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `expenses` (
  `id` VARCHAR(50) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `description` TEXT NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `payment_method` VARCHAR(50) NOT NULL,
  `reference` VARCHAR(100) DEFAULT NULL,
  `date` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(50) DEFAULT NULL,
  `user_name` VARCHAR(100) DEFAULT NULL,
  `created_at` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_expenses_date` (`date`),
  INDEX `idx_expenses_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 21. Audit Logs Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(50) DEFAULT NULL,
  `user_name` VARCHAR(100) DEFAULT NULL,
  `role` VARCHAR(50) DEFAULT NULL,
  `action` VARCHAR(100) NOT NULL,
  `entity` VARCHAR(100) DEFAULT NULL,
  `entity_id` VARCHAR(100) DEFAULT NULL,
  `previous_value` LONGTEXT DEFAULT NULL,
  `new_value` LONGTEXT DEFAULT NULL,
  `device_id` VARCHAR(50) DEFAULT NULL,
  `timestamp` BIGINT DEFAULT NULL,
  `date` VARCHAR(50) DEFAULT NULL,
  `created_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_audit_entity` (`entity`),
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 22. Sync Events Table (Offline Queue Sync Storage)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sync_events` (
  `id` VARCHAR(50) NOT NULL,
  `entity_type` VARCHAR(50) NOT NULL,
  `entity_id` VARCHAR(50) NOT NULL,
  `action` VARCHAR(50) NOT NULL,
  `payload` LONGTEXT DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'pending',
  `error_message` TEXT DEFAULT NULL,
  `device_id` VARCHAR(50) DEFAULT NULL,
  `created_at` VARCHAR(50) NOT NULL,
  `synced_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_sync_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------
-- 23. Settings Table
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `key_name` VARCHAR(100) NOT NULL,
  `key_value` LONGTEXT NOT NULL,
  `updated_at` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`key_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

SET FOREIGN_KEY_CHECKS = 1;
