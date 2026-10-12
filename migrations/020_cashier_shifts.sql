-- =============================================================================
-- 020 — CASHIER SHIFTS + DAILY CASH RECONCILIATION (additive only)
-- =============================================================================
-- A cashier OPENS a shift with an opening float, sells, then CLOSES it by counting the drawer.
-- The expected cash is computed by the server from the transactions tagged with the shift; the
-- figures at close are stored on the shift row and never rewritten (corrections are separate rows).
--
--   cashier_shifts             one row per shift (OPEN -> CLOSED -> REVIEWED)
--   cashier_shift_corrections  audited corrections of a closed shift's counted cash (never an edit)
--   sales.shift_id             the shift a sale was completed in (new sales only; history untouched)
--   returns.refund_method      how an APPROVED refund was paid (Cash / M-Pesa / Card / Bank)
--   returns.refund_shift_id    the till (open shift) a refund was paid from
--   expenses.shift_id          a CASH expense paid out of an open shift's till
--
-- No existing row is changed: every new column is NULL for existing rows (= "not part of any shift").
-- No DROP, no DELETE, no stock, sale, payment or user change.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS cashier_shift_seq;

CREATE TABLE IF NOT EXISTS cashier_shifts (
    id UUID PRIMARY KEY,
    shift_number VARCHAR(40) NOT NULL UNIQUE,
    cashier_id UUID NOT NULL REFERENCES users(id),
    device_id VARCHAR(100),
    status VARCHAR(20) NOT NULL,

    opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_business_date DATE NOT NULL,
    opening_float NUMERIC(12, 2) NOT NULL,
    opened_by UUID REFERENCES users(id),
    opened_by_name VARCHAR(255),

    closed_at TIMESTAMPTZ,
    closed_business_date DATE,
    closed_by UUID REFERENCES users(id),
    closed_by_name VARCHAR(255),
    -- CASHIER = closed by the shift's own cashier; ADMIN = controlled closure by an Administrator
    close_method VARCHAR(20),
    admin_close_reason TEXT,

    -- Figures computed by the server AT CLOSE (never edited afterwards)
    total_transactions INTEGER,
    total_sales NUMERIC(12, 2),
    cash_sales NUMERIC(12, 2),
    mpesa_sales NUMERIC(12, 2),
    card_sales NUMERIC(12, 2),
    bank_sales NUMERIC(12, 2),
    other_sales NUMERIC(12, 2),
    units_sold INTEGER,
    voided_count INTEGER,
    voided_total NUMERIC(12, 2),
    returns_count INTEGER,
    refund_total NUMERIC(12, 2),
    cash_refunds NUMERIC(12, 2),
    cash_expenses NUMERIC(12, 2),
    expected_cash NUMERIC(12, 2),
    actual_cash NUMERIC(12, 2),
    cash_variance NUMERIC(12, 2),
    closing_notes TEXT,

    reviewed_by UUID REFERENCES users(id),
    reviewed_by_name VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashier_shifts_status') THEN
    ALTER TABLE cashier_shifts ADD CONSTRAINT chk_cashier_shifts_status CHECK (status IN ('OPEN', 'CLOSED', 'REVIEWED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashier_shifts_float') THEN
    ALTER TABLE cashier_shifts ADD CONSTRAINT chk_cashier_shifts_float CHECK (opening_float >= 0);
  END IF;
  -- An OPEN shift has no closing figures; a closed / reviewed one has all of them and a real count.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashier_shifts_lifecycle') THEN
    ALTER TABLE cashier_shifts ADD CONSTRAINT chk_cashier_shifts_lifecycle CHECK (
      (status = 'OPEN' AND closed_at IS NULL AND actual_cash IS NULL AND expected_cash IS NULL AND reviewed_at IS NULL)
      OR (status IN ('CLOSED', 'REVIEWED') AND closed_at IS NOT NULL AND closed_business_date IS NOT NULL
          AND actual_cash IS NOT NULL AND actual_cash >= 0 AND expected_cash IS NOT NULL AND cash_variance IS NOT NULL
          AND close_method IN ('CASHIER', 'ADMIN')
          AND (close_method = 'CASHIER' OR admin_close_reason IS NOT NULL)
          AND (cash_variance = 0 OR closing_notes IS NOT NULL))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashier_shifts_review') THEN
    ALTER TABLE cashier_shifts ADD CONSTRAINT chk_cashier_shifts_review CHECK (
      (status = 'REVIEWED') = (reviewed_at IS NOT NULL));
  END IF;
END $$;

-- ONE ACTIVE SHIFT RULE: a cashier can never have two OPEN shifts (enforced by PostgreSQL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_shifts_one_open ON cashier_shifts(cashier_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_opened_date ON cashier_shifts(opened_business_date);
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_cashier_opened ON cashier_shifts(cashier_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_status ON cashier_shifts(status);

-- Audited corrections of a CLOSED / REVIEWED shift's counted cash. The shift row keeps its original
-- closing figures; the latest correction (if any) is the effective count.
CREATE TABLE IF NOT EXISTS cashier_shift_corrections (
    id UUID PRIMARY KEY,
    shift_id UUID NOT NULL REFERENCES cashier_shifts(id),
    previous_actual_cash NUMERIC(12, 2) NOT NULL,
    corrected_actual_cash NUMERIC(12, 2) NOT NULL CHECK (corrected_actual_cash >= 0),
    expected_cash NUMERIC(12, 2) NOT NULL,
    corrected_variance NUMERIC(12, 2) NOT NULL,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    created_by_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cashier_shift_corrections_shift ON cashier_shift_corrections(shift_id, created_at);

-- Links (NULL for every existing row).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES cashier_shifts(id);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_method VARCHAR(20);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_shift_id UUID REFERENCES cashier_shifts(id);
CREATE INDEX IF NOT EXISTS idx_returns_refund_shift ON returns(refund_shift_id) WHERE refund_shift_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_returns_refund_method') THEN
    ALTER TABLE returns ADD CONSTRAINT chk_returns_refund_method CHECK (refund_method IS NULL OR refund_method IN ('Cash', 'M-Pesa', 'Card', 'Bank'));
  END IF;
END $$;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES cashier_shifts(id);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id) WHERE shift_id IS NOT NULL;
DO $$
BEGIN
  -- Only cash leaves a till.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_shift_cash') THEN
    ALTER TABLE expenses ADD CONSTRAINT chk_expenses_shift_cash CHECK (shift_id IS NULL OR payment_method = 'Cash');
  END IF;
END $$;
