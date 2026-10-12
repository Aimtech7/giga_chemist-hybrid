-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): HISTORY INDEXES                       version 007
-- =============================================================================
-- Additive and re-runnable: indexes only (no data change). Supports the online Admin sales / supply
-- history, which filters by shop and pages server-side over large histories (100k+ sales per shop).
-- Existing: idx_gc_sales_date (shop_id, business_date), idx_gc_sale_items_sale (shop_id, sale_id).
BEGIN;
CREATE INDEX IF NOT EXISTS idx_gc_sales_cashier ON giga_cloud.sales (shop_id, cashier_id);
CREATE INDEX IF NOT EXISTS idx_gc_sales_status ON giga_cloud.sales (shop_id, status);
CREATE INDEX IF NOT EXISTS idx_gc_sales_receipt ON giga_cloud.sales (shop_id, receipt_number);
CREATE INDEX IF NOT EXISTS idx_gc_sale_items_medicine ON giga_cloud.sale_items (shop_id, medicine_id);
CREATE INDEX IF NOT EXISTS idx_gc_payments_sale ON giga_cloud.payments (shop_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_gc_returns_sale ON giga_cloud.returns (shop_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_gc_purchases_received ON giga_cloud.purchases (shop_id, received_date DESC);
CREATE INDEX IF NOT EXISTS idx_gc_purchases_supplier ON giga_cloud.purchases (shop_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_gc_purchase_items_purchase ON giga_cloud.purchase_items (shop_id, purchase_id);
CREATE INDEX IF NOT EXISTS idx_gc_movements_reference ON giga_cloud.inventory_movements (shop_id, reference_id);
CREATE INDEX IF NOT EXISTS idx_gc_audit_entity ON giga_cloud.audit_events (shop_id, entity_id);
COMMIT;
