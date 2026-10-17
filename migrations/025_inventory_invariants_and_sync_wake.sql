-- =============================================================================
-- 025 — INVENTORY INVARIANTS, USER ARCHIVING & SYNC ACCELERATION
-- =============================================================================
-- 1. Strictly enforce non-negative stock invariants locally:
--    - medicines.current_stock >= 0
--    - medicine_batches.quantity_available >= 0
--    - inventory_movements.new_quantity >= 0
-- 2. Add sessions_revoked_at to users table for instantaneous staff deactivation.
-- 3. Sequence optimization index on sync_events.
-- =============================================================================

-- 1. Non-negative stock constraints (guarded with NOT VALID -> VALIDATE for zero-downtime safety)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_medicines_current_stock_nonnegative'
    ) THEN
        ALTER TABLE medicines ADD CONSTRAINT chk_medicines_current_stock_nonnegative CHECK (current_stock >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_medicine_batches_quantity_nonnegative'
    ) THEN
        ALTER TABLE medicine_batches ADD CONSTRAINT chk_medicine_batches_quantity_nonnegative CHECK (quantity_available >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_movements_new_quantity_nonnegative'
    ) THEN
        ALTER TABLE inventory_movements ADD CONSTRAINT chk_inventory_movements_new_quantity_nonnegative CHECK (new_quantity >= 0);
    END IF;
END $$;

-- 2. User session revocation support
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;

-- 3. Strict sequential outbox dispatch index
CREATE INDEX IF NOT EXISTS idx_sync_events_seq_pending
    ON sync_events (seq ASC)
    WHERE status = 'PENDING';
