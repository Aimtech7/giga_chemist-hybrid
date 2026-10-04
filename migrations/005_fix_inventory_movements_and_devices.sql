-- =============================================================================
-- Migration 005: Schema Fixes for Inventory Movements, Devices, and Sales
-- GIGA CHEMIST Pharmacy POS
-- =============================================================================

-- 1. Ensure inventory_movements has reason and date columns
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reason VARCHAR(100);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
ALTER TABLE inventory_movements ALTER COLUMN user_id DROP NOT NULL;

-- 2. Ensure sales table has discount_percent column
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5, 2) DEFAULT 0.00;

-- 3. Ensure medicine_batches has expiry_status column
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS expiry_status VARCHAR(20) DEFAULT 'KNOWN';

-- 4. Ensure standard device identifiers exist for local terminal and backend operations.
-- branch_id links to the MAIN branch only when that row exists (NULL otherwise), so this
-- migration no longer fails with a foreign-key error on a database built from migrations alone.
INSERT INTO devices (id, branch_id, name, device_type, app_version, status)
SELECT d.id, (SELECT b.id FROM branches b WHERE b.id = '00000000-0000-0000-0000-000000000001'), d.name, d.device_type, '1.0.0', 'active'
FROM (VALUES
  ('POS-TERMINAL-01', 'Main POS Terminal 1', 'desktop'),
  ('SERVER', 'Local Server Backend', 'server')
) AS d(id, name, device_type)
ON CONFLICT (id) DO NOTHING;
