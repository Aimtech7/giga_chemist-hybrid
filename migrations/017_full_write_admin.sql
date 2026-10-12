-- =============================================================================
-- 017 — FULL-WRITE GLOBAL ADMIN: lifecycle columns for remote (online) administration
-- =============================================================================
-- Additive / relaxing only. No business row is changed: every new column has a default that
-- describes existing rows exactly (customers active, expenses posted, purchases unchanged).
--   customers.active                 deactivate instead of delete (sale history keeps its customer)
--   expenses.status/void_*           posted -> voided (a posted expense is never deleted)
--   expenses.created_by_name         an expense recorded by a remote Administrator has no shop
--                                    account; user_id becomes optional, one of the two is required
--   purchases.cancel_reason/at       pending -> cancelled (a received purchase is never cancelled);
--                                    invoice_number optional while pending (required to receive)
--   returns.reviewed_by_name         a return reviewed by a remote Administrator (no shop account)
--   users.sessions_revoked_at        shop sessions issued before this instant are refused
-- =============================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'posted';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_by_name VARCHAR(255);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE expenses ALTER COLUMN user_id DROP NOT NULL;

-- A PENDING purchase (ordered, goods not here yet) may have no supplier invoice yet; receiving it
-- still requires one (enforced by the application), so every received purchase keeps its invoice.
ALTER TABLE purchases ALTER COLUMN invoice_number DROP NOT NULL;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS reviewed_by_name VARCHAR(255);

ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_status') THEN
    ALTER TABLE expenses ADD CONSTRAINT chk_expenses_status CHECK (
      (status = 'posted' AND voided_at IS NULL) OR (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_actor') THEN
    ALTER TABLE expenses ADD CONSTRAINT chk_expenses_actor CHECK (user_id IS NOT NULL OR created_by_name IS NOT NULL);
  END IF;
END $$;

-- A rejection needs a reviewer: a shop account (reviewed_by) or a remote Administrator (reviewed_by_name).
ALTER TABLE returns DROP CONSTRAINT IF EXISTS chk_returns_review_consistency;
ALTER TABLE returns ADD CONSTRAINT chk_returns_review_consistency CHECK (
  (status = 'PENDING' AND reviewed_at IS NULL AND approved_quantity IS NULL)
  OR (status = 'APPROVED' AND reviewed_at IS NOT NULL AND approved_quantity IS NOT NULL AND approved_quantity > 0)
  OR (status = 'REJECTED' AND reviewed_at IS NOT NULL AND (reviewed_by IS NOT NULL OR reviewed_by_name IS NOT NULL)));

CREATE INDEX IF NOT EXISTS idx_expenses_status_date ON expenses(status, date);
