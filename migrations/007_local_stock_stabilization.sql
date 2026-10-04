-- =============================================================================
-- Migration 007: Local stock stabilization
-- GIGA CHEMIST Pharmacy POS
--
-- Non-destructive and idempotent. Safe on an existing imported pharmacy database:
-- only adds missing columns/defaults and the backend device row. No DROP, no data
-- rewrites, no business records.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. inventory_movements: columns the stock code writes on every movement
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reason VARCHAR(100);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
ALTER TABLE inventory_movements ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE inventory_movements ALTER COLUMN id SET DEFAULT uuid_generate_v4();

-- 2. medicine_batches: columns used by add-stock / physical count / expiry edit
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS selling_price_override NUMERIC(12, 2);
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS expiry_status VARCHAR(20) DEFAULT 'KNOWN';
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE medicine_batches ALTER COLUMN id SET DEFAULT uuid_generate_v4();

-- 3. medicines: version/updated_at are bumped on every stock reconciliation
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- 4. audit_logs: server always supplies a UUID; keep a DB default as a safety net
ALTER TABLE audit_logs ALTER COLUMN id SET DEFAULT uuid_generate_v4();

-- 5. Backend device used as the device_id for Admin stock operations (devices FK).
--    branch_id is linked only if the MAIN branch exists.
INSERT INTO devices (id, branch_id, name, device_type, app_version, status)
VALUES (
  'SERVER',
  (SELECT id FROM branches WHERE id = '00000000-0000-0000-0000-000000000001'),
  'Local Server Backend', 'server', '1.0.0', 'active'
)
ON CONFLICT (id) DO NOTHING;
