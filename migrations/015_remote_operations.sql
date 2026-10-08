-- =============================================================================
-- 015 — REMOTE OPERATIONS: backup verification/tiers, approved software updates
-- =============================================================================
-- Additive only: new columns with defaults and one new table. No business row is changed.
--   backup_runs.verified / toc_entries / tier   proof that each archive was readable
--                                              (pg_restore --list) and its retention tier
--   update_approvals                            an Administrator's remote approval to install one
--                                              specific commit of the approved production channel;
--                                              the updater re-verifies it independently
-- =============================================================================

ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS verified BOOLEAN;
ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS toc_entries INTEGER;
ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS tier VARCHAR(10);
ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS weekly_file_path TEXT;

CREATE TABLE IF NOT EXISTS update_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_commit CHAR(40) NOT NULL CHECK (target_commit ~ '^[0-9a-f]{40}$'),
    approved_by TEXT,
    command_id UUID UNIQUE,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    consumed_at TIMESTAMPTZ,
    outcome VARCHAR(20),
    outcome_detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_update_approvals_open ON update_approvals(approved_at DESC) WHERE consumed_at IS NULL;
