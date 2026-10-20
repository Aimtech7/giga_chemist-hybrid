-- =============================================================================
-- Migration 026: Medicine Deletion Safeguards, Tombstones & Stock Versioning
-- =============================================================================

-- 1. Monotonic stock versioning & deterministic fingerprinting on medicines
ALTER TABLE medicines
    ADD COLUMN IF NOT EXISTS stock_version BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS stock_fingerprint TEXT;

-- 2. Monotonic stock versioning on batches
ALTER TABLE medicine_batches
    ADD COLUMN IF NOT EXISTS stock_version BIGINT NOT NULL DEFAULT 1;

-- 3. Medicine tombstones table: prevents resurrection of permanently deleted medicines
CREATE TABLE IF NOT EXISTS medicine_tombstones (
    medicine_id UUID PRIMARY KEY,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletion_seq BIGINT NOT NULL,
    actor_id UUID,
    actor_name TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_medicine_tombstones_seq ON medicine_tombstones(deletion_seq);

-- 4. Stock parity audit log
CREATE TABLE IF NOT EXISTS stock_parity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medicine_id UUID NOT NULL,
    local_stock INT NOT NULL,
    cloud_stock INT,
    local_stock_version BIGINT,
    cloud_stock_version BIGINT,
    local_fingerprint TEXT,
    cloud_fingerprint TEXT,
    outcome TEXT NOT NULL, -- 'MATCH', 'TEMPORARILY_BEHIND', 'PERSISTENT_MISMATCH', 'RECONCILED'
    reconciled BOOLEAN NOT NULL DEFAULT FALSE,
    details JSONB,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_parity_log_checked_at ON stock_parity_log(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_parity_log_medicine_id ON stock_parity_log(medicine_id);

-- Initialize stock_fingerprint for existing medicines
UPDATE medicines
   SET stock_fingerprint = md5(id::text || ':' || current_stock::text || ':' || stock_version::text)
 WHERE stock_fingerprint IS NULL;
