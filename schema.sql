-- =============================================================================
-- GIGA CHEMIST (PHARMACY POS & INVENTORY MANAGEMENT SYSTEM)
-- PostgreSQL Production Relational Database Schema
-- Multi-Branch Ready, UUID Primary Keys, Audit & Sync Enabled
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. BRANCHES (Multi-Branch Architecture)
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
    name VARCHAR(50) UNIQUE NOT NULL, -- 'ADMIN', 'MANAGER', 'CASHIER'
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. PERMISSIONS
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) UNIQUE NOT NULL, -- e.g. 'medicine.change_price', 'inventory.adjust'
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
    role VARCHAR(50) NOT NULL, -- 'ADMIN', 'MANAGER', 'CASHIER'
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

-- 7. DEVICES (Point of Sale Terminals & Tablets)
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(100) PRIMARY KEY, -- e.g. 'POS-KITALE-01-UUID'
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    device_type VARCHAR(50) DEFAULT 'desktop', -- 'desktop', 'tablet', 'mobile'
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
    unit VARCHAR(50) NOT NULL DEFAULT 'Strips (10 tabs)',
    prescription_required BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_medicine_barcode_branch UNIQUE (barcode, branch_id)
);
CREATE INDEX idx_medicines_name ON medicines(name);
CREATE INDEX idx_medicines_generic_name ON medicines(generic_name);
CREATE INDEX idx_medicines_barcode ON medicines(barcode);

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

-- 11. MEDICINE_BATCHES (FEFO Tracking)
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
    expiry_status VARCHAR(20) DEFAULT 'KNOWN', -- 'KNOWN', 'UNKNOWN', 'EXPIRED'
    notes TEXT,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'quarantined', 'recalled', 'exhausted'
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_batch_medicine UNIQUE (medicine_id, batch_number)
);
CREATE INDEX idx_batches_expiry ON medicine_batches(expiry_date);
CREATE INDEX idx_batches_status ON medicine_batches(status);

-- 12. PURCHASES
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    order_number VARCHAR(100) UNIQUE NOT NULL,
    invoice_number VARCHAR(100) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    order_date DATE NOT NULL,
    received_date DATE,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'received', 'cancelled'
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

-- 14. CUSTOMERS / PATIENTS
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
    status VARCHAR(50) DEFAULT 'completed', -- 'completed', 'held', 'returned', 'voided'
    void_reason TEXT,
    voided_by UUID REFERENCES users(id),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    sync_status VARCHAR(50) DEFAULT 'synced',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sales_date ON sales(date);
CREATE INDEX idx_sales_receipt ON sales(receipt_number);

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
    method VARCHAR(50) NOT NULL, -- 'Cash', 'M-Pesa', 'Card', 'Bank'
    amount NUMERIC(12, 2) NOT NULL,
    reference VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 18. INVENTORY_MOVEMENTS (Strict Transaction Ledger)
CREATE TABLE IF NOT EXISTS inventory_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    previous_quantity INTEGER NOT NULL,
    adjustment_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    movement_type VARCHAR(50) NOT NULL, -- 'SALE', 'PURCHASE', 'RETURN', 'DAMAGE', 'EXPIRY', 'ADJUSTMENT', 'CORRECTION'
    reference_id VARCHAR(100),
    notes TEXT,
    user_id UUID NOT NULL REFERENCES users(id),
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_movements_medicine ON inventory_movements(medicine_id);
CREATE INDEX idx_movements_batch ON inventory_movements(batch_id);

-- 19. RETURNS & RETURN_ITEMS
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
    action VARCHAR(50) NOT NULL, -- 'return_to_stock', 'damaged', 'quarantine', 'dispose'
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

-- 21. AUDIT_LOGS (Immutable Audit Trail)
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
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- 22. SYNC_EVENTS (Offline Sync Audit & Queue)
CREATE TABLE IF NOT EXISTS sync_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    operation VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    local_id VARCHAR(100) NOT NULL,
    server_id UUID,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'pending', 'syncing', 'synced', 'failed', 'conflict'
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

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

-- =============================================================================
-- 24. ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Anonymous/Authenticated Read Access to Formulary & Settings
CREATE POLICY "Allow public read active medicines" ON medicines FOR SELECT USING (status = 'active');
CREATE POLICY "Allow public read active batches" ON medicine_batches FOR SELECT USING (status = 'active');
CREATE POLICY "Allow public read settings" ON settings FOR SELECT USING (true);
CREATE POLICY "Allow public read customers" ON customers FOR SELECT USING (true);

-- Service Role Full Operational Access (Bypasses RLS by default on Supabase backend)
-- Authenticated User Policies
CREATE POLICY "Staff insert sales" ON sales FOR INSERT WITH CHECK (true);
CREATE POLICY "Staff insert sale items" ON sale_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Staff insert payments" ON payments FOR INSERT WITH CHECK (true);
CREATE POLICY "Staff insert inventory movements" ON inventory_movements FOR INSERT WITH CHECK (true);
CREATE POLICY "Staff insert audit logs" ON audit_logs FOR INSERT WITH CHECK (true);

-- =============================================================================
-- 25. AUTOMATIC STOCK CALCULATION TRIGGERS
-- =============================================================================

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
