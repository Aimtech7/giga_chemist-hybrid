-- =============================================================================
-- 013 — HYBRID SYNC: durable outbox, stable shop identity, inbound cloud commands
-- =============================================================================
-- Local PostgreSQL stays authoritative. Every syncable business write inserts one sync_events
-- row inside its own transaction; a background worker on the local server ships PENDING rows to
-- the cloud later. Nothing here changes stock, sales or any existing business row.
-- =============================================================================

-- 1. SHOP IDENTITY (single row). Generated once and stored in the database, so it survives
--    restarts, updates, reboots and internet outages, and travels with backups/restores.
--    Never derived from hostname or IP. SHOP_ID in .env may adopt a cloud-assigned id before the
--    first event is synced (see server/sync/identity.ts); after that a mismatch halts sync.
CREATE TABLE IF NOT EXISTS shop_identity (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    shop_id UUID NOT NULL,
    shop_code VARCHAR(50) NOT NULL DEFAULT 'SHOP1',
    shop_name VARCHAR(255),
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO shop_identity (id, shop_id, shop_code, shop_name, branch_id)
SELECT 1, gen_random_uuid(), 'SHOP1',
       COALESCE((SELECT name FROM branches WHERE code = 'MAIN' LIMIT 1), 'GIGA CHEMIST - MAIN'),
       (SELECT id FROM branches WHERE code = 'MAIN' LIMIT 1)
ON CONFLICT (id) DO NOTHING;

-- 2. OUTBOX. The existing sync_events table (empty, never written by the API) is extended in place.
--    device_id loses its FK/NOT NULL: an outbox insert must never be able to roll back a sale
--    because of an unregistered terminal id.
ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_device_id_fkey;
ALTER TABLE sync_events ALTER COLUMN device_id DROP NOT NULL;

ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS shop_id UUID;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS event_type VARCHAR(60);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS actor_name VARCHAR(255);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS business_ref VARCHAR(100);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS locked_by VARCHAR(100);

-- Legacy rows (none expected) are normalised to the new upper-case states.
UPDATE sync_events SET status = UPPER(status) WHERE status <> UPPER(status);
UPDATE sync_events SET status = 'SYNCED' WHERE status NOT IN ('PENDING', 'PROCESSING', 'SYNCED', 'FAILED');
UPDATE sync_events SET event_type = UPPER(operation) WHERE event_type IS NULL;
UPDATE sync_events SET shop_id = (SELECT shop_id FROM shop_identity WHERE id = 1) WHERE shop_id IS NULL;

ALTER TABLE sync_events ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE sync_events ALTER COLUMN processed_at DROP DEFAULT;
ALTER TABLE sync_events ALTER COLUMN event_type SET NOT NULL;
ALTER TABLE sync_events ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS chk_sync_events_status;
ALTER TABLE sync_events ADD CONSTRAINT chk_sync_events_status
    CHECK (status IN ('PENDING', 'PROCESSING', 'SYNCED', 'FAILED'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_events_seq ON sync_events(seq);
CREATE INDEX IF NOT EXISTS idx_sync_events_due ON sync_events(next_attempt_at, seq) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_sync_events_status ON sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_entity ON sync_events(entity_type, entity_id);

-- 3. INBOUND CLOUD COMMANDS. One row per command ever received; the primary key and the unique
--    idempotency key guarantee a command delivered twice is applied once.
CREATE TABLE IF NOT EXISTS sync_inbound_commands (
    command_id UUID PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    shop_id UUID NOT NULL,
    command_type VARCHAR(60) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('APPLIED', 'REJECTED')),
    result JSONB,
    error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TIMESTAMPTZ,
    acked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_inbound_unacked ON sync_inbound_commands(received_at) WHERE acked_at IS NULL;

-- 4. WORKER STATE (last successful sync, last error...). Survives restarts.
CREATE TABLE IF NOT EXISTS sync_state (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
