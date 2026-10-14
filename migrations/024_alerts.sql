-- =============================================================================
-- 024 — LOCAL ALERTS CENTER (additive only)
-- =============================================================================
-- The shop's own alert list (works with the internet down). One row per CONDITION occurrence:
-- while the condition is present the open row is refreshed (last_seen_at) instead of duplicated;
-- when it disappears the row is RESOLVED; if it comes back later a NEW row is opened.
--   status: OPEN -> ACKNOWLEDGED (by an Administrator) -> RESOLVED (condition gone)
-- The same conditions also travel to the cloud with the heartbeat (giga_cloud.alerts, cloud 004).
-- No existing row of any table is changed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS alerts (
    id BIGSERIAL PRIMARY KEY,
    alert_key VARCHAR(200) NOT NULL,
    alert_type VARCHAR(60) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    severity VARCHAR(10) NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    related_entity VARCHAR(60),
    related_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_by_name VARCHAR(255),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    CONSTRAINT chk_alerts_status CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
    CONSTRAINT chk_alerts_severity CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_key ON alerts(alert_key) WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS idx_alerts_recent ON alerts(last_seen_at DESC);
