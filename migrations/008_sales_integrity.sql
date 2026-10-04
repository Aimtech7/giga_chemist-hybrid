-- =============================================================================
-- Migration 008: Sales / returns / purchases integrity
-- GIGA CHEMIST Pharmacy POS
--
-- Non-destructive and idempotent. Adds sequences for server-generated document numbers,
-- missing indexes, and CHECK constraints.
--
-- Constraints that legacy imported history does not satisfy (the old system stored returns as
-- negative sales / negative quantities) are added NOT VALID: PostgreSQL enforces them for every
-- new or updated row but does not rewrite or reject existing history.
-- No DROP, no UPDATE/DELETE of business data, no stock changes.
-- =============================================================================

-- 1. Server-generated, collision-free document numbers
CREATE SEQUENCE IF NOT EXISTS sale_receipt_seq;
CREATE SEQUENCE IF NOT EXISTS purchase_order_seq;

-- 2. Missing indexes (sale history item lookup, returns per sale, movement history, reports)
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_returns_sale_id ON returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_movements_created_at ON inventory_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at DESC);

-- 3. CHECK constraints
DO $$
BEGIN
  -- Fully validated: existing data already satisfies these.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_batch_qty_nonnegative') THEN
    ALTER TABLE medicine_batches ADD CONSTRAINT chk_batch_qty_nonnegative CHECK (quantity_available >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_medicine_stock_nonnegative') THEN
    ALTER TABLE medicines ADD CONSTRAINT chk_medicine_stock_nonnegative CHECK (current_stock >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_discount_percent') THEN
    ALTER TABLE sales ADD CONSTRAINT chk_sales_discount_percent CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_returns_quantity_positive') THEN
    ALTER TABLE returns ADD CONSTRAINT chk_returns_quantity_positive CHECK (quantity > 0 AND refund_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_amount_positive') THEN
    ALTER TABLE expenses ADD CONSTRAINT chk_expenses_amount_positive CHECK (amount > 0);
  END IF;

  -- NOT VALID: enforced for new rows; legacy negative "return" rows are preserved untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_items_quantity_positive') THEN
    ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_quantity_positive CHECK (quantity > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_total_nonnegative') THEN
    ALTER TABLE sales ADD CONSTRAINT chk_sales_total_nonnegative CHECK (total >= 0 AND subtotal >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_amount_positive') THEN
    ALTER TABLE payments ADD CONSTRAINT chk_payments_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;
END $$;
