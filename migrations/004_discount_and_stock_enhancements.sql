-- =============================================================================
-- Migration 004: POS Discount Support, Stock Management & Batch Expiry Enhancements
-- GIGA CHEMIST Pharmacy POS
-- =============================================================================

-- 1. Ensure sales table has discount_percent column
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5, 2) DEFAULT 0.00;

-- 2. Ensure medicine_batches has expiry_status column
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS expiry_status VARCHAR(20) DEFAULT 'KNOWN';

-- 3. Ensure inventory_movements has movement_type and date columns
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS movement_type VARCHAR(50) DEFAULT 'ADJUSTMENT';
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;

-- 4. Create indexes for fast cashier daily sales lookups and date boundary calculations
CREATE INDEX IF NOT EXISTS idx_sales_cashier_date ON sales(cashier_id, date);
CREATE INDEX IF NOT EXISTS idx_sales_status_date ON sales(status, date);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);
CREATE INDEX IF NOT EXISTS idx_payments_sale_id ON payments(sale_id);
