-- =============================================================================
-- 018 — HISTORY: indexes for the Admin supply / purchase history (additive only)
-- =============================================================================
-- Sales history already has idx_sales_date, idx_sales_cashier(_date), idx_sales_status_date,
-- idx_sales_receipt, idx_sale_items_sale_id, idx_payments_sale_id, idx_returns_sale_id (checked).
-- Purchases had only their primary key / order number.
CREATE INDEX IF NOT EXISTS idx_purchases_received_date ON purchases (received_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases (supplier_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_medicine ON sale_items (medicine_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_medicine ON purchase_items (medicine_id);
