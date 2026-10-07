-- =============================================================================
-- 014 — EMAIL REPORT QUEUE, EMAIL SETTINGS, BACKUP RUN LOG
-- =============================================================================
-- Additive only: new tables, no change to any existing business row.
-- Email never blocks the POS: reports are generated into email_jobs (PostgreSQL) and a background
-- worker delivers them over SMTP, retrying while SMTP/internet is unavailable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(40) NOT NULL,
    shop_id UUID,
    report_date DATE,
    recipients TEXT[] NOT NULL,
    subject TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT,
    -- [{ "filename": "...csv", "contentType": "text/csv", "content": "<utf-8 text>" }]
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'RETRYING', 'FAILED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error TEXT,
    message_id TEXT,
    -- e.g. SHOP1:DAILY_STOCK:2026-10-07 — one report per shop/type/day, even after restarts.
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_jobs_due ON email_jobs(next_attempt_at) WHERE status IN ('PENDING', 'RETRYING');
CREATE INDEX IF NOT EXISTS idx_email_jobs_created ON email_jobs(created_at DESC);

-- Admin-editable report settings (single row). SMTP credentials stay in the server .env only.
CREATE TABLE IF NOT EXISTS email_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    daily_stock_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    business_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    expiry_report_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    low_stock_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    stock_report_time VARCHAR(5) NOT NULL DEFAULT '18:00',
    business_report_time VARCHAR(5) NOT NULL DEFAULT '18:05',
    expiry_report_time VARCHAR(5) NOT NULL DEFAULT '08:00',
    expiry_report_weekday SMALLINT NOT NULL DEFAULT 1 CHECK (expiry_report_weekday BETWEEN 1 AND 7), -- ISO: 1 = Monday
    low_stock_digest_time VARCHAR(5) NOT NULL DEFAULT '08:00',
    -- Comma-separated; NULL = STOCK_REPORT_RECIPIENTS from .env
    recipients TEXT,
    include_low_stock BOOLEAN NOT NULL DEFAULT TRUE,
    include_expiry BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID
);
INSERT INTO email_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per backup attempt (scheduled, manual or CLI). Backups are never restored automatically.
CREATE TABLE IF NOT EXISTS backup_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger VARCHAR(20) NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL', 'CLI', 'PRE_UPGRADE')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
    database_name VARCHAR(100),
    file_path TEXT,
    size_bytes BIGINT,
    duration_ms INTEGER,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at DESC);
