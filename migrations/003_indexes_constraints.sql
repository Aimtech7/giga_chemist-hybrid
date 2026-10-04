-- =============================================================================
-- Migration 003: Operational Tables, Relational Constraints, Indexes & Triggers
-- GIGA CHEMIST Pharmacy POS
-- =============================================================================

-- 1. MEDICINES (Authoritative Formulary)
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
    purchase_price NUMERIC(12, 2) NOT NULL CHECK (purchase_price >= 0),
    selling_price NUMERIC(12, 2) NOT NULL CHECK (selling_price >= 0),
    wholesale_price NUMERIC(12, 2) CHECK (wholesale_price >= 0),
    min_selling_price NUMERIC(12, 2) CHECK (min_selling_price >= 0),
    current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    reorder_level INTEGER NOT NULL DEFAULT 20 CHECK (reorder_level >= 0),
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
CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);
CREATE INDEX IF NOT EXISTS idx_medicines_generic_name ON medicines(generic_name);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines(barcode);
CREATE INDEX IF NOT EXISTS idx_medicines_sku ON medicines(sku);

-- 2. MEDICINE_BATCHES (FEFO Tracking)
CREATE TABLE IF NOT EXISTS medicine_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    quantity_received INTEGER NOT NULL CHECK (quantity_received >= 0),
    quantity_available INTEGER NOT NULL CHECK (quantity_available >= 0),
    purchase_price NUMERIC(12, 2) NOT NULL CHECK (purchase_price >= 0),
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
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON medicine_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_status ON medicine_batches(status);
CREATE INDEX IF NOT EXISTS idx_batches_medicine ON medicine_batches(medicine_id);

-- 3. PURCHASES
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    order_number VARCHAR(100) UNIQUE NOT NULL,
    invoice_number VARCHAR(100) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    order_date DATE NOT NULL,
    received_date DATE,
    status VARCHAR(50) DEFAULT 'pending',
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
    payment_status VARCHAR(50) DEFAULT 'unpaid',
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. PURCHASE_ITEMS
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_number VARCHAR(100) NOT NULL,
    manufacturing_date DATE,
    expiry_date DATE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    purchase_price NUMERIC(12, 2) NOT NULL CHECK (purchase_price >= 0),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. SALES
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
    subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
    discount_total NUMERIC(12, 2) DEFAULT 0.00 CHECK (discount_total >= 0),
    tax_total NUMERIC(12, 2) DEFAULT 0.00 CHECK (tax_total >= 0),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    cost_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cost_total >= 0),
    gross_profit NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    payment_method VARCHAR(50) NOT NULL,
    payment_reference VARCHAR(100),
    amount_received NUMERIC(12, 2) NOT NULL CHECK (amount_received >= 0),
    change_given NUMERIC(12, 2) DEFAULT 0.00 CHECK (change_given >= 0),
    status VARCHAR(50) DEFAULT 'completed', -- 'completed', 'held', 'returned', 'voided'
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

-- 6. SALE_ITEMS
CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    batch_number VARCHAR(100) NOT NULL,
    expiry_date DATE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    discount NUMERIC(12, 2) DEFAULT 0.00 CHECK (discount >= 0),
    cost_price_snapshot NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cost_price_snapshot >= 0),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method VARCHAR(50) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    reference VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. INVENTORY_MOVEMENTS (Strict Transaction Ledger)
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
CREATE INDEX IF NOT EXISTS idx_movements_medicine ON inventory_movements(medicine_id);
CREATE INDEX IF NOT EXISTS idx_movements_batch ON inventory_movements(batch_id);

-- 9. RETURNS
CREATE TABLE IF NOT EXISTS returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL REFERENCES sales(id),
    receipt_number VARCHAR(100) NOT NULL,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    refund_amount NUMERIC(12, 2) NOT NULL CHECK (refund_amount >= 0),
    reason TEXT NOT NULL,
    action VARCHAR(50) NOT NULL, -- 'return_to_stock', 'quarantine', 'damaged', 'dispose'
    user_id UUID NOT NULL REFERENCES users(id),
    device_id VARCHAR(100) NOT NULL REFERENCES devices(id),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 10. EXPENSES
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(50) NOT NULL,
    reference VARCHAR(100),
    user_id UUID NOT NULL REFERENCES users(id),
    date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 11. AUDIT_LOGS (Immutable Centralized Audit Trail)
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
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- 12. SYNC_EVENTS (Idempotency and Device Sync Log)
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
