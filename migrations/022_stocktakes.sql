-- =============================================================================
-- 022 — FORMAL STOCKTAKE SESSIONS (additive only)
-- =============================================================================
-- A stocktake is counted first and changes NOTHING until an Administrator approves it:
--
--   DRAFT -> COUNTING -> REVIEW -> COMPLETED      (approval applies the counts; approved_* recorded)
--     \________\___________\-----> CANCELLED      (never after completion)
--   REVIEW -> COUNTING (re-opened for more counting)
--
--   stocktakes        one session (scope, who / when, notes, approval)
--   stocktake_lines   one batch: system quantity AT COUNT TIME, physical quantity, variance, cost
--
-- Approval applies variance = physical - system_at_count to the batch AS IT IS THEN (sales made
-- after the count stay counted), through the normal stock path: a PHYSICAL_STOCK_COUNT inventory
-- movement (previous / delta / new, reference = stocktake number), medicine stock reconciliation,
-- audit and the PHYSICAL_COUNT sync event. No existing row of any table is changed by this file.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS stocktake_seq;

CREATE TABLE IF NOT EXISTS stocktakes (
    id UUID PRIMARY KEY,
    stocktake_number VARCHAR(40) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    scope_type VARCHAR(20) NOT NULL,
    scope_value JSONB,
    allow_cashier_count BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    started_by UUID REFERENCES users(id),
    started_by_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counting_started_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    submitted_by_name VARCHAR(255),
    approved_at TIMESTAMPTZ,
    approved_by UUID REFERENCES users(id),
    approved_by_name VARCHAR(255),
    approval_notes TEXT,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by_name VARCHAR(255),
    cancel_reason TEXT,
    business_date DATE NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_stocktakes_status CHECK (status IN ('DRAFT', 'COUNTING', 'REVIEW', 'APPROVED', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT chk_stocktakes_scope CHECK (scope_type IN ('ALL', 'CATEGORY', 'MEDICINES'))
);
CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status, created_at DESC);

CREATE TABLE IF NOT EXISTS stocktake_lines (
    id UUID PRIMARY KEY,
    stocktake_id UUID NOT NULL REFERENCES stocktakes(id),
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID NOT NULL REFERENCES medicine_batches(id),
    batch_number VARCHAR(100),
    expiry_date DATE,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
    system_quantity INTEGER,
    physical_quantity INTEGER,
    reason TEXT,
    counted_by UUID REFERENCES users(id),
    counted_by_name VARCHAR(255),
    counted_at TIMESTAMPTZ,
    applied_quantity_before INTEGER,
    applied_quantity_after INTEGER,
    movement_id UUID,
    CONSTRAINT uq_stocktake_line UNIQUE (stocktake_id, batch_id),
    CONSTRAINT chk_stocktake_physical CHECK (physical_quantity IS NULL OR physical_quantity >= 0)
);
CREATE INDEX IF NOT EXISTS idx_stocktake_lines_session ON stocktake_lines(stocktake_id);
CREATE INDEX IF NOT EXISTS idx_stocktake_lines_medicine ON stocktake_lines(medicine_id);
