-- =============================================================================
-- Migration 012: Return approval workflow (Cashier requests, Admin approves/rejects)
-- GIGA CHEMIST Pharmacy POS
--
-- returns rows become requests with an explicit status:
--   PENDING  = requested; NOTHING applied (no stock, no refund, no reporting effect)
--   APPROVED = an Administrator authorised it; refund/stock/movement/audit applied atomically
--   REJECTED = declined; no effects
-- Existing rows were applied immediately by the old code, so they are recorded as APPROVED
-- (their quantities, refunds and timestamps are not changed).
-- Non-destructive and idempotent.
-- =============================================================================

ALTER TABLE returns ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'APPROVED';
-- New rows must state their status explicitly (the application always inserts 'PENDING').
ALTER TABLE returns ALTER COLUMN status DROP DEFAULT;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS requested_refund NUMERIC(12, 2);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS approved_quantity INTEGER;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS restocked BOOLEAN;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- Historical (already-applied) rows: record what actually happened.
UPDATE returns
   SET approved_quantity = COALESCE(approved_quantity, quantity),
       requested_refund  = COALESCE(requested_refund, refund_amount),
       restocked         = COALESCE(restocked, action = 'return_to_stock'),
       reviewed_at       = COALESCE(reviewed_at, created_at)
 WHERE status = 'APPROVED' AND approved_quantity IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_returns_status') THEN
    ALTER TABLE returns ADD CONSTRAINT chk_returns_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));
  END IF;
  -- A reviewed request must say who reviewed it and when (historical rows have no reviewer).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_returns_review_consistency') THEN
    ALTER TABLE returns ADD CONSTRAINT chk_returns_review_consistency CHECK (
      (status = 'PENDING' AND reviewed_at IS NULL AND approved_quantity IS NULL)
      OR (status = 'APPROVED' AND reviewed_at IS NOT NULL AND approved_quantity IS NOT NULL AND approved_quantity > 0)
      OR (status = 'REJECTED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_sale_status ON returns(sale_id, status);
