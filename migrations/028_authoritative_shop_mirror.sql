-- =============================================================================
-- Migration 028: Shop Inventory Snapshots and Authoritative Mirror Registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS shop_inventory_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_seq BIGINT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL,
    medicines_count INT NOT NULL DEFAULT 0,
    batches_count INT NOT NULL DEFAULT 0,
    total_stock NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    cloud_confirmed_at TIMESTAMPTZ,
    details JSONB
);

CREATE INDEX IF NOT EXISTS idx_snapshots_seq ON shop_inventory_snapshots(snapshot_seq DESC);
