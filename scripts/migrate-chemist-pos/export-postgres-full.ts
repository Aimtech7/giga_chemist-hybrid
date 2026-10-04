import fs from 'fs';
import path from 'path';
import { runMigration } from './migrate';
import { hashCredential } from '../../server/auth';

function sqlEscape(val: any): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'number') {
    return isNaN(val) ? '0' : String(val);
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  // String escaping: standard SQL single quote doubling
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

function formatSqlDate(val: any): string {
  if (!val) return 'NULL';
  return `'${String(val).substring(0, 10)}'`;
}

function formatSqlTimestamp(val: any): string {
  if (!val) return 'NULL';
  const str = String(val).replace(/'/g, "''");
  return `'${str}'::timestamptz`;
}

async function exportFullPostgresDatabase() {
  const exportDir = path.resolve('deployment/postgresql');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const sqlFilePath = path.join(exportDir, 'giga_chemist_full.sql');
  console.log('======================================================================');
  console.log('  GIGA CHEMIST — GENERATING FULL PRODUCTION POSTGRESQL SQL EXPORT');
  console.log('======================================================================');
  console.log(`Output SQL Path: ${sqlFilePath}\n`);

  const startTime = Date.now();

  // Run the validated in-memory migration pipeline to extract all transformed entities
  console.log('Step 1/3: Extracting and validating all legacy entities from chemist_pos.sql...');
  const { stats, data } = await runMigration(true);

  console.log('\nStep 2/3: Generating PostgreSQL-native DDL and DML data stream...');
  const writeStream = fs.createWriteStream(sqlFilePath, { encoding: 'utf8' });

  // 1. Header & Configuration
  writeStream.write(`-- =============================================================================
-- GIGA CHEMIST (PHARMACY POS & INVENTORY MANAGEMENT SYSTEM)
-- Full Standalone PostgreSQL Production Database Export
-- Generated: ${new Date().toISOString()}
-- Source Migration: chemist_pos.sql (767,370 records transformed)
-- =============================================================================

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

BEGIN;

-- =============================================================================
-- SCHEMA DDL
-- =============================================================================

-- 1. BRANCHES
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    is_main_branch BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. ROLES
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. PERMISSIONS
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) UNIQUE NOT NULL,
    module VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. ROLE_PERMISSIONS
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- 5. USERS
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    pin_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    phone VARCHAR(50),
    active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 6. USER_ROLES
CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 7. DEVICES
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(100) PRIMARY KEY,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    device_type VARCHAR(50) DEFAULT 'desktop',
    app_version VARCHAR(50) NOT NULL,
    first_registered TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_synced_at TIMESTAMPTZ,
    current_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'active'
);

-- 8. CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 9. MEDICINES (Authoritative Formulary)
CREATE TABLE IF NOT EXISTS medicines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    generic_name VARCHAR(255) NOT NULL,
    brand_name VARCHAR(255),
    sku VARCHAR(100) NOT NULL,
    barcode VARCHAR(100) NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    medicine_type VARCHAR(100),
    dosage_strength VARCHAR(100) NOT NULL,
    dosage_form VARCHAR(100) NOT NULL,
    manufacturer VARCHAR(255),
    description TEXT,
    purchase_price NUMERIC(12, 2) NOT NULL,
    selling_price NUMERIC(12, 2) NOT NULL,
    wholesale_price NUMERIC(12, 2),
    min_selling_price NUMERIC(12, 2),
    current_stock INTEGER NOT NULL DEFAULT 0,
    reorder_level INTEGER NOT NULL DEFAULT 20,
    unit VARCHAR(50) NOT NULL DEFAULT 'Unit',
    prescription_required BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_medicine_barcode_branch UNIQUE (barcode, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);
CREATE INDEX IF NOT EXISTS idx_medicines_generic_name ON medicines(generic_name);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines(barcode);
CREATE INDEX IF NOT EXISTS idx_medicines_sku ON medicines(sku);

-- 10. SUPPLIERS
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    address TEXT,
    tax_pin VARCHAR(50),
    balance NUMERIC(12, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 11. MEDICINE_BATCHES (FEFO Tracking & Truth-based Null Expiry)
CREATE TABLE IF NOT EXISTS medicine_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    quantity_received INTEGER NOT NULL,
    quantity_available INTEGER NOT NULL,
    purchase_price NUMERIC(12, 2) NOT NULL,
    selling_price_override NUMERIC(12, 2),
    manufacturing_date DATE,
    expiry_date DATE,
    received_date DATE,
    purchase_invoice VARCHAR(100),
    expiry_status VARCHAR(20) DEFAULT 'KNOWN',
    notes TEXT,
    status VARCHAR(20) DEFAULT 'active',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_batch_medicine UNIQUE (medicine_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON medicine_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_status ON medicine_batches(status);
CREATE INDEX IF NOT EXISTS idx_batches_medicine ON medicine_batches(medicine_id);

-- 12. PURCHASES
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    order_number VARCHAR(100) UNIQUE NOT NULL,
    invoice_number VARCHAR(100) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    order_date DATE NOT NULL,
    received_date DATE,
    status VARCHAR(50) DEFAULT 'pending',
    total_amount NUMERIC(12, 2) NOT NULL,
    payment_status VARCHAR(50) DEFAULT 'unpaid',
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 13. PURCHASE_ITEMS
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_number VARCHAR(100) NOT NULL,
    manufacturing_date DATE,
    expiry_date DATE,
    quantity INTEGER NOT NULL,
    purchase_price NUMERIC(12, 2) NOT NULL,
    total NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 14. CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(100),
    address TEXT,
    notes TEXT,
    credit_balance NUMERIC(12, 2) DEFAULT 0.00,
    total_spent NUMERIC(12, 2) DEFAULT 0.00,
    last_visit TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 15. SALES
CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    sale_number VARCHAR(100) UNIQUE NOT NULL,
    receipt_number VARCHAR(100) UNIQUE NOT NULL,
    cashier_id UUID NOT NULL REFERENCES users(id),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    date DATE NOT NULL,
    time VARCHAR(20) NOT NULL,
    subtotal NUMERIC(12, 2) NOT NULL,
    discount_total NUMERIC(12, 2) DEFAULT 0.00,
    tax_total NUMERIC(12, 2) DEFAULT 0.00,
    total NUMERIC(12, 2) NOT NULL,
    cost_total NUMERIC(12, 2) NOT NULL,
    gross_profit NUMERIC(12, 2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    payment_reference VARCHAR(100),
    amount_received NUMERIC(12, 2) NOT NULL,
    change_given NUMERIC(12, 2) DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'completed',
    void_reason TEXT,
    voided_by UUID REFERENCES users(id),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    sync_status VARCHAR(50) DEFAULT 'synced',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sales_idempotency ON sales(idempotency_key);

-- 16. SALE_ITEMS
CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    batch_number VARCHAR(100) NOT NULL,
    expiry_date DATE,
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL,
    discount NUMERIC(12, 2) DEFAULT 0.00,
    cost_price_snapshot NUMERIC(12, 2) NOT NULL,
    total NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 17. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method VARCHAR(50) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    reference VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 18. INVENTORY_MOVEMENTS (Audit Ledger)
CREATE TABLE IF NOT EXISTS inventory_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    previous_quantity INTEGER NOT NULL,
    adjustment_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    movement_type VARCHAR(50) NOT NULL,
    reference_id VARCHAR(100),
    notes TEXT,
    user_id UUID NOT NULL REFERENCES users(id),
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_movements_medicine ON inventory_movements(medicine_id);
CREATE INDEX IF NOT EXISTS idx_movements_batch ON inventory_movements(batch_id);

-- 19. RETURNS
CREATE TABLE IF NOT EXISTS returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL REFERENCES sales(id),
    receipt_number VARCHAR(100) NOT NULL,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL,
    refund_amount NUMERIC(12, 2) NOT NULL,
    reason TEXT NOT NULL,
    action VARCHAR(50) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 20. EXPENSES
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    reference VARCHAR(100),
    user_id UUID NOT NULL REFERENCES users(id),
    date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 21. AUDIT_LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    action VARCHAR(100) NOT NULL,
    entity VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    previous_value JSONB,
    new_value JSONB,
    device_id VARCHAR(100) NOT NULL,
    ip_address VARCHAR(50),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- 22. SYNC_EVENTS
CREATE TABLE IF NOT EXISTS sync_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    operation VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'synced',
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_events_idempotency ON sync_events(idempotency_key);

-- 23. SETTINGS
CREATE TABLE IF NOT EXISTS settings (
    branch_id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000'::UUID,
    pharmacy_name VARCHAR(255) NOT NULL DEFAULT 'GIGA CHEMIST',
    tagline VARCHAR(255) DEFAULT 'Trusted Healthcare & Pharmaceutical Solutions',
    address TEXT DEFAULT 'Kenyatta Street, Kitale, Kenya',
    phone VARCHAR(50) DEFAULT '+254 700 123 456',
    email VARCHAR(100) DEFAULT 'info@gigachemist.co.ke',
    currency VARCHAR(10) DEFAULT 'KES',
    tax_rate NUMERIC(5, 2) DEFAULT 0.00,
    tax_enabled BOOLEAN DEFAULT FALSE,
    receipt_header TEXT DEFAULT 'GIGA CHEMIST\nKitale, Kenya\nOfficial Dispensing Receipt',
    receipt_footer TEXT DEFAULT 'Thank you for choosing GIGA CHEMIST!\nGet well soon.',
    printer_type VARCHAR(20) DEFAULT '80mm',
    auto_print_receipt BOOLEAN DEFAULT TRUE,
    low_stock_threshold INTEGER DEFAULT 20,
    expiry_warning_days INTEGER DEFAULT 90,
    version VARCHAR(50) DEFAULT '1.0.0-pwa',
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 24. LEGACY MIGRATION MAP (Traceability & Idempotency)
CREATE TABLE IF NOT EXISTS legacy_migration_map (
    source_system VARCHAR(50) DEFAULT 'OSPOS_LEGACY',
    source_table VARCHAR(100) NOT NULL,
    source_id VARCHAR(100) NOT NULL,
    target_table VARCHAR(100) NOT NULL,
    target_id UUID NOT NULL,
    migrated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    PRIMARY KEY (source_table, source_id)
);

-- Stock Trigger Function
CREATE OR REPLACE FUNCTION update_medicine_current_stock()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE medicines
    SET current_stock = COALESCE((
        SELECT SUM(quantity_available)
        FROM medicine_batches
        WHERE medicine_id = COALESCE(NEW.medicine_id, OLD.medicine_id)
          AND status = 'active'
          AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
    ), 0),
    updated_at = CURRENT_TIMESTAMP
    WHERE id = COALESCE(NEW.medicine_id, OLD.medicine_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_medicine_stock ON medicine_batches;
CREATE TRIGGER trg_update_medicine_stock
AFTER INSERT OR UPDATE OF quantity_available, status, expiry_date OR DELETE
ON medicine_batches
FOR EACH ROW
EXECUTE FUNCTION update_medicine_current_stock();

-- =============================================================================
-- DATA INGESTION
-- =============================================================================
\n`);

  // Initial Core Records
  writeStream.write(`-- Core Branches & Devices
INSERT INTO branches (id, code, name, address, phone, email, is_main_branch, active)
VALUES ('${data.branchId}', 'MAIN', 'GIGA CHEMIST - MAIN', 'Kitale, Kenya', '+254 700 123 456', 'info@gigachemist.co.ke', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;\n\n`);

  writeStream.write(`INSERT INTO devices (id, branch_id, name, device_type, app_version, status)
VALUES ('${data.deviceId}', '${data.branchId}', 'Main Station Terminal', 'desktop', '1.0.0', 'active')
ON CONFLICT (id) DO NOTHING;\n\n`);

  writeStream.write(`INSERT INTO settings (branch_id, pharmacy_name, tagline, address, phone, email, currency, tax_rate, receipt_header, receipt_footer)
VALUES ('${data.branchId}', 'GIGA CHEMIST', 'Trusted Healthcare & Pharmaceutical Solutions', 'Kitale, Kenya', '+254 700 123 456', 'info@gigachemist.co.ke', 'KES', 8.00, 'GIGA CHEMIST\nKitale, Kenya\nOfficial Dispensing Receipt', 'Thank you for choosing GIGA CHEMIST!\nGet well soon.')
ON CONFLICT (branch_id) DO NOTHING;\n\n`);

  // Insert Categories
  console.log(`- Writing ${data.categories.length} categories...`);
  writeStream.write(`-- Categories (${data.categories.length} records)\n`);
  for (const cat of data.categories) {
    writeStream.write(`INSERT INTO categories (id, name, description) VALUES (${sqlEscape(cat.id)}, ${sqlEscape(cat.name)}, ${sqlEscape(cat.description)}) ON CONFLICT (name) DO NOTHING;\n`);
  }
  writeStream.write('\n');

  // Insert Suppliers
  console.log(`- Writing ${data.suppliers.length} suppliers...`);
  writeStream.write(`-- Suppliers (${data.suppliers.length} records)\n`);
  for (const s of data.suppliers) {
    writeStream.write(`INSERT INTO suppliers (id, name, contact_person, phone, email, address, tax_pin, status) VALUES (${sqlEscape(s.id)}, ${sqlEscape(s.name)}, ${sqlEscape(s.contact_person)}, ${sqlEscape(s.phone)}, ${sqlEscape(s.email)}, ${sqlEscape(s.address)}, ${sqlEscape(s.tax_pin)}, ${sqlEscape(s.status)}) ON CONFLICT (id) DO NOTHING;\n`);
  }
  writeStream.write('\n');

  // Insert Customers
  console.log(`- Writing ${data.customers.length} customers...`);
  writeStream.write(`-- Customers (${data.customers.length} records)\n`);
  for (const c of data.customers) {
    writeStream.write(`INSERT INTO customers (id, branch_id, name, phone, email, address, notes) VALUES (${sqlEscape(c.id)}, ${sqlEscape(c.branch_id)}, ${sqlEscape(c.name)}, ${sqlEscape(c.phone)}, ${sqlEscape(c.email)}, ${sqlEscape(c.address)}, ${sqlEscape(c.notes)}) ON CONFLICT (id) DO NOTHING;\n`);
  }
  writeStream.write('\n');

  // Insert Users (Staff Identities)
  console.log(`- Writing ${data.users.length} staff identity profiles (zero passwords)...`);
  writeStream.write(`-- Users / Staff Identities (${data.users.length} records)\n`);
  for (const u of data.users) {
    writeStream.write(`INSERT INTO users (id, branch_id, name, email, role, phone, active, password_hash, pin_hash) VALUES (${sqlEscape(u.id)}, ${sqlEscape(u.branch_id)}, ${sqlEscape(u.name)}, ${sqlEscape(u.email)}, ${sqlEscape(u.role)}, ${sqlEscape(u.phone)}, ${sqlEscape(u.active)}, ${sqlEscape(u.password_hash)}, ${sqlEscape(u.pin_hash)}) ON CONFLICT (email) DO NOTHING;\n`);
  }
  writeStream.write('\n');

  // Active Production Administrator and Cashier Accounts (Precomputed PBKDF2-SHA512 hashes - zero plaintext passwords)
  const adminPwdHash = '779dee3d684fedaf93208ec655922c2d$6c586a0921bc148e975fa3213f5042f3c50f78675973b4ec1f13a0dbe169a264afd8451bc3864cbc23402132c723758f7216c2b0ffcc719352f002dc97446c31';
  const adminPinHash = '779dee3d684fedaf93208ec655922c2d$c8fe04e878654e4c19b6edccfe20e709084e606ddd83c1b8d57f6ef0b98b1da83e12edafa3df59662a165c9e09e41dd9ba2d04cb780d04934f3e09a2e6422524';
  const cashierPwdHash = '64366af56fd0eaeaf3953cdb930ddbea$0e91b3f2ad71606545da39425918b1e9d32732e29eddb7dd53dfdec87e2bd8629181632b400de352abc3e9054bee69ecfc69d7743a06eb5d98ae4c0e3b9216c0';
  const cashierPinHash = '64366af56fd0eaeaf3953cdb930ddbea$29a014b818995f1a6d567e3aa108c65228411a2fbade8e54b7caeea4eeedb8fbc42b2c161c15bdf585be9024d7a61c6d0213b12324f535ca0b510152d21dd654';

  console.log('- Writing active production accounts (ADMIN & CASHIER)...');
  writeStream.write(`-- Active Production Administrator and Cashier Accounts
INSERT INTO users (id, branch_id, name, email, role, phone, active, password_hash, pin_hash)
VALUES 
  ('00000000-0000-0000-0000-000000000099', '${data.branchId}', 'Administrator', 'admin@gigachemist.co.ke', 'ADMIN', '+254 700 123 456', TRUE, '${adminPwdHash}', '${adminPinHash}'),
  ('00000000-0000-0000-0000-000000000098', '${data.branchId}', 'Cashier', 'cashier@gigachemist.co.ke', 'CASHIER', '+254 700 123 456', TRUE, '${cashierPwdHash}', '${cashierPinHash}')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, pin_hash = EXCLUDED.pin_hash, active = TRUE;\n\n`);

  // Insert Medicines (Batches of 500 rows per INSERT)
  console.log(`- Writing ${data.medicines.length} medicines...`);
  writeStream.write(`-- Medicines Formulary (${data.medicines.length} records)\n`);
  for (let i = 0; i < data.medicines.length; i += 500) {
    const chunk = data.medicines.slice(i, i + 500);
    writeStream.write(`INSERT INTO medicines (id, branch_id, name, generic_name, brand_name, sku, barcode, category_id, medicine_type, dosage_strength, dosage_form, manufacturer, description, purchase_price, selling_price, current_stock, reorder_level, unit, status) VALUES\n`);
    const valRows = chunk.map((m) =>
      `  (${sqlEscape(m.id)}, ${sqlEscape(m.branch_id)}, ${sqlEscape(m.name)}, ${sqlEscape(m.generic_name)}, ${sqlEscape(m.brand_name)}, ${sqlEscape(m.sku)}, ${sqlEscape(m.barcode)}, ${sqlEscape(m.category_id)}, ${sqlEscape(m.medicine_type)}, ${sqlEscape(m.dosage_strength)}, ${sqlEscape(m.dosage_form)}, ${sqlEscape(m.manufacturer)}, ${sqlEscape(m.description)}, ${m.purchase_price}, ${m.selling_price}, ${m.current_stock}, ${m.reorder_level}, ${sqlEscape(m.unit)}, ${sqlEscape(m.status)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (barcode, branch_id) DO NOTHING;\n\n');
  }

  // Insert Batches (Batches of 500 rows per INSERT)
  console.log(`- Writing ${data.batches.length} initial batches (truth-based null expiry)...`);
  writeStream.write(`-- Medicine Batches (${data.batches.length} records)\n`);
  for (let i = 0; i < data.batches.length; i += 500) {
    const chunk = data.batches.slice(i, i + 500);
    writeStream.write(`INSERT INTO medicine_batches (id, branch_id, medicine_id, batch_number, supplier_id, quantity_received, quantity_available, purchase_price, manufacturing_date, expiry_date, received_date, expiry_status, notes, status) VALUES\n`);
    const valRows = chunk.map((b) =>
      `  (${sqlEscape(b.id)}, ${sqlEscape(b.branch_id)}, ${sqlEscape(b.medicine_id)}, ${sqlEscape(b.batch_number)}, ${sqlEscape(b.supplier_id)}, ${b.quantity_received}, ${b.quantity_available}, ${b.purchase_price}, ${formatSqlDate(b.manufacturing_date)}, ${formatSqlDate(b.expiry_date)}, ${formatSqlDate(b.received_date)}, ${sqlEscape(b.expiry_status)}, ${sqlEscape(b.notes)}, ${sqlEscape(b.status)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (medicine_id, batch_number) DO NOTHING;\n\n');
  }

  // Insert Purchases & Purchase Items
  console.log(`- Writing ${data.purchases.length} purchases and ${data.purchaseItems.length} purchase items...`);
  writeStream.write(`-- Purchases (${data.purchases.length} records)\n`);
  for (let i = 0; i < data.purchases.length; i += 500) {
    const chunk = data.purchases.slice(i, i + 500);
    writeStream.write(`INSERT INTO purchases (id, branch_id, order_number, invoice_number, supplier_id, order_date, received_date, status, total_amount, payment_status, notes, created_by) VALUES\n`);
    const valRows = chunk.map((p) =>
      `  (${sqlEscape(p.id)}, ${sqlEscape(p.branch_id)}, ${sqlEscape(p.order_number)}, ${sqlEscape(p.invoice_number)}, ${sqlEscape(p.supplier_id)}, ${formatSqlDate(p.order_date)}, ${formatSqlDate(p.received_date)}, ${sqlEscape(p.status)}, ${p.total_amount}, ${sqlEscape(p.payment_status)}, ${sqlEscape(p.notes)}, ${sqlEscape(p.created_by)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (order_number) DO NOTHING;\n\n');
  }

  writeStream.write(`-- Purchase Items (${data.purchaseItems.length} records)\n`);
  for (let i = 0; i < data.purchaseItems.length; i += 1000) {
    const chunk = data.purchaseItems.slice(i, i + 1000);
    writeStream.write(`INSERT INTO purchase_items (id, purchase_id, medicine_id, batch_number, manufacturing_date, expiry_date, quantity, purchase_price, total) VALUES\n`);
    const valRows = chunk.map((pi) =>
      `  (${sqlEscape(pi.id)}, ${sqlEscape(pi.purchase_id)}, ${sqlEscape(pi.medicine_id)}, ${sqlEscape(pi.batch_number)}, ${formatSqlDate(pi.manufacturing_date)}, ${formatSqlDate(pi.expiry_date)}, ${pi.quantity}, ${pi.purchase_price}, ${pi.total})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (id) DO NOTHING;\n\n');
  }

  // Insert Sales (Batches of 1000 rows)
  console.log(`- Writing ${data.sales.length.toLocaleString()} sales...`);
  writeStream.write(`-- Sales (${data.sales.length} records)\n`);
  for (let i = 0; i < data.sales.length; i += 1000) {
    const chunk = data.sales.slice(i, i + 1000);
    writeStream.write(`INSERT INTO sales (id, branch_id, sale_number, receipt_number, cashier_id, customer_id, device_id, date, time, subtotal, discount_total, tax_total, total, cost_total, gross_profit, payment_method, payment_reference, amount_received, change_given, status, idempotency_key, sync_status, created_at) VALUES\n`);
    const valRows = chunk.map((s) =>
      `  (${sqlEscape(s.id)}, ${sqlEscape(s.branch_id)}, ${sqlEscape(s.sale_number)}, ${sqlEscape(s.receipt_number)}, ${sqlEscape(s.cashier_id)}, ${sqlEscape(s.customer_id)}, ${sqlEscape(s.device_id)}, ${formatSqlDate(s.date)}, ${sqlEscape(s.time)}, ${s.subtotal}, ${s.discount_total}, ${s.tax_total}, ${s.total}, ${s.cost_total}, ${s.gross_profit}, ${sqlEscape(s.payment_method)}, ${sqlEscape(s.payment_reference)}, ${s.amount_received}, ${s.change_given}, ${sqlEscape(s.status)}, ${sqlEscape(s.idempotency_key)}, ${sqlEscape(s.sync_status)}, ${formatSqlTimestamp(s.created_at)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (idempotency_key) DO NOTHING;\n\n');
  }

  // Insert Sale Items (Batches of 1500 rows)
  console.log(`- Writing ${data.saleItems.length.toLocaleString()} sale items...`);
  writeStream.write(`-- Sale Items (${data.saleItems.length} records)\n`);
  for (let i = 0; i < data.saleItems.length; i += 1500) {
    const chunk = data.saleItems.slice(i, i + 1500);
    writeStream.write(`INSERT INTO sale_items (id, sale_id, medicine_id, batch_id, batch_number, expiry_date, quantity, unit_price, discount, cost_price_snapshot, total) VALUES\n`);
    const valRows = chunk.map((si) =>
      `  (${sqlEscape(si.id)}, ${sqlEscape(si.sale_id)}, ${sqlEscape(si.medicine_id)}, ${sqlEscape(si.batch_id)}, ${sqlEscape(si.batch_number)}, ${formatSqlDate(si.expiry_date)}, ${si.quantity}, ${si.unit_price}, ${si.discount}, ${si.cost_price_snapshot}, ${si.total})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (id) DO NOTHING;\n\n');
  }

  // Insert Payments (Batches of 1500 rows)
  console.log(`- Writing ${data.payments.length.toLocaleString()} payments...`);
  writeStream.write(`-- Payments (${data.payments.length} records)\n`);
  for (let i = 0; i < data.payments.length; i += 1500) {
    const chunk = data.payments.slice(i, i + 1500);
    writeStream.write(`INSERT INTO payments (id, sale_id, method, amount, reference, created_at) VALUES\n`);
    const valRows = chunk.map((p) =>
      `  (${sqlEscape(p.id)}, ${sqlEscape(p.sale_id)}, ${sqlEscape(p.method)}, ${p.amount}, ${sqlEscape(p.reference)}, ${formatSqlTimestamp(p.created_at)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (id) DO NOTHING;\n\n');
  }

  // Insert Inventory Movements (Batches of 2000 rows)
  console.log(`- Writing ${data.movements.length.toLocaleString()} inventory movements...`);
  writeStream.write(`-- Inventory Movements Audit Trail (${data.movements.length} records)\n`);
  for (let i = 0; i < data.movements.length; i += 2000) {
    const chunk = data.movements.slice(i, i + 2000);
    writeStream.write(`INSERT INTO inventory_movements (id, branch_id, medicine_id, batch_id, previous_quantity, adjustment_quantity, new_quantity, movement_type, reference_id, notes, user_id, device_id, timestamp, created_at) VALUES\n`);
    const valRows = chunk.map((m) =>
      `  (${sqlEscape(m.id)}, ${sqlEscape(m.branch_id)}, ${sqlEscape(m.medicine_id)}, ${sqlEscape(m.batch_id)}, ${m.previous_quantity}, ${m.adjustment_quantity}, ${m.new_quantity}, ${sqlEscape(m.movement_type)}, ${sqlEscape(m.reference_id)}, ${sqlEscape(m.notes)}, ${sqlEscape(m.user_id)}, ${sqlEscape(m.device_id)}, ${m.timestamp}, ${formatSqlTimestamp(m.created_at)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (id) DO NOTHING;\n\n');
  }

  // Insert Migration Map (Batches of 2000 rows)
  console.log(`- Writing ${data.migrationMap.length.toLocaleString()} migration map records...`);
  writeStream.write(`-- Migration Map Traceability (${data.migrationMap.length} records)\n`);
  for (let i = 0; i < data.migrationMap.length; i += 2000) {
    const chunk = data.migrationMap.slice(i, i + 2000);
    writeStream.write(`INSERT INTO legacy_migration_map (source_system, source_table, source_id, target_table, target_id, metadata) VALUES\n`);
    const valRows = chunk.map((mm) =>
      `  (${sqlEscape(mm.source_system)}, ${sqlEscape(mm.source_table)}, ${sqlEscape(mm.source_id)}, ${sqlEscape(mm.target_table)}, ${sqlEscape(mm.target_id)}, ${sqlEscape(mm.metadata || null)})`
    );
    writeStream.write(valRows.join(',\n') + '\nON CONFLICT (source_table, source_id) DO NOTHING;\n\n');
  }

  writeStream.write(`COMMIT;\n\n-- End of GIGA CHEMIST Database Export\n`);
  writeStream.end();

  await new Promise<void>((resolve) => writeStream.on('finish', () => resolve()));

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const fileSizeMb = (fs.statSync(sqlFilePath).size / (1024 * 1024)).toFixed(2);

  console.log('\n======================================================================');
  console.log(`  [SUCCESS] Exported giga_chemist_full.sql (${fileSizeMb} MB) in ${durationSec}s`);
  console.log('======================================================================\n');
}

exportFullPostgresDatabase().catch((err) => {
  console.error('[EXPORT FAILED]', err);
  process.exit(1);
});
