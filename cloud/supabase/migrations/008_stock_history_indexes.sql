-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): STOCK HISTORY INDEXES                 version 008
-- =============================================================================
-- Additive and re-runnable: indexes only (no data change, no function change). The online Stock History
-- reads the movement ledger per shop + batch + time, per shop + time (one day / range) and per shop +
-- medicine + time (the medicine timeline), and each batch's MEDICINE_BASELINE event (sync-start anchor).
-- Existing: idx_gc_movements_batch (shop_id, batch_id, local_seq), idx_gc_movements_reference,
-- idx_gc_events_shop (shop_id, local_seq), idx_gc_sales_date (shop_id, business_date),
-- idx_gc_sale_items_sale, idx_gc_sale_items_medicine.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_gc_movements_batch_time ON giga_cloud.inventory_movements (shop_id, batch_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_gc_movements_time ON giga_cloud.inventory_movements (shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_gc_movements_medicine_time ON giga_cloud.inventory_movements (shop_id, medicine_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_gc_events_baseline ON giga_cloud.processed_events (shop_id, local_seq) WHERE event_type = 'MEDICINE_BASELINE';
COMMIT;
