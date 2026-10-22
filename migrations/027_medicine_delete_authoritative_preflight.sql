-- =============================================================================
-- Migration 027: Authoritative Medicine Delete Preflight Registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS medicine_delete_preflights (
    preflight_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medicine_id UUID NOT NULL,
    current_version INT NOT NULL,
    current_status TEXT NOT NULL,
    current_stock NUMERIC NOT NULL,
    active_batches INT NOT NULL DEFAULT 0,
    sales_references INT NOT NULL DEFAULT 0,
    sale_item_references INT NOT NULL DEFAULT 0,
    purchase_references INT NOT NULL DEFAULT 0,
    purchase_item_references INT NOT NULL DEFAULT 0,
    returns_references INT NOT NULL DEFAULT 0,
    movement_references INT NOT NULL DEFAULT 0,
    stocktake_references INT NOT NULL DEFAULT 0,
    pending_local_sync INT NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL CHECK (outcome IN ('PERMANENT_DELETE', 'ARCHIVE_REQUIRED', 'BLOCKED')),
    block_reason TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delete_preflights_med ON medicine_delete_preflights(medicine_id, expires_at DESC);
