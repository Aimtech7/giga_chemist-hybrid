-- =============================================================================
-- 019 — STOCK HISTORY: indexes for the daily stock history (additive only, no data change)
-- =============================================================================
-- Stock History reads each batch's last movement before a day (opening) and checks whether a batch has
-- imported movements dated before its creation. Both are "batch + time" lookups.
-- Already present (checked): idx_movements_batch (batch_id), idx_movements_medicine (medicine_id),
-- idx_movements_created_at (created_at DESC), idx_sales_date (date), idx_sale_items_sale_id (sale_id),
-- idx_sale_items_medicine (medicine_id, 018).
CREATE INDEX IF NOT EXISTS idx_movements_batch_created ON inventory_movements (batch_id, created_at);
