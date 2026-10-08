-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): REMOTE OPERATIONS                     version 004
-- =============================================================================
-- Apply after 001-003 in the Supabase SQL editor. Re-runnable, NON-DESTRUCTIVE (no table dropped,
-- no row deleted; the only object replaced is the queue_online_command FUNCTION).
--
-- Adds:
--   * command types USER_SET_ACTIVE, USER_ROLE_UPDATE, APP_UPDATE_APPROVE
--   * giga_cloud.commands.display        what the Admin saw when queueing (names, old values) —
--                                         shown in Remote Activity, never sent to the shop
--   * giga_cloud.online_users.token_version   bump = revoke that account's online sessions
--   * giga_cloud.shop_runtime_status     latest shop-PC HEARTBEAT (sanitized runtime health)
--   * giga_cloud.alerts                  persistent alerts (raised by the shop heartbeat or by the
--                                         cloud: shop offline, rejected commands), ack / history
--   * giga_cloud.remote_control          emergency switches: remote_writes_enabled, maintenance
--   * public.gc_heartbeat(shop, token, status)   shop-authenticated, like the other gc_* RPCs
--   * giga_cloud.refresh_cloud_alerts / queue_online_command (honours remote_writes_enabled)
-- =============================================================================

BEGIN;

-- 1. Command types
DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'giga_cloud.commands'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%command_type%'
    LOOP
        EXECUTE format('ALTER TABLE giga_cloud.commands DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE giga_cloud.commands ADD CONSTRAINT commands_command_type_check CHECK (command_type IN (
    'PRICE_UPDATE', 'MEDICINE_METADATA_UPDATE', 'CATEGORY_UPSERT', 'SETTINGS_UPDATE',
    'STOCK_ADD', 'STOCK_REMOVE', 'STOCK_SET', 'BATCH_EXPIRY_UPDATE',
    'USER_SET_ACTIVE', 'USER_ROLE_UPDATE', 'APP_UPDATE_APPROVE'));
ALTER TABLE giga_cloud.commands ADD COLUMN IF NOT EXISTS display JSONB;

-- 2. Online session revocation
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- 3. Heartbeat
CREATE TABLE IF NOT EXISTS giga_cloud.shop_runtime_status (
    shop_id UUID PRIMARY KEY REFERENCES giga_cloud.shops(shop_id),
    reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    device_id TEXT,
    app_version TEXT,
    git_commit TEXT,
    mode TEXT,
    started_at TIMESTAMPTZ,
    uptime_seconds BIGINT,
    db_healthy BOOLEAN,
    worker_healthy BOOLEAN,
    outbound_pending INTEGER,
    outbound_failed INTEGER,
    inbound_unacked INTEGER,
    last_sync_at TIMESTAMPTZ,
    disk_free_bytes BIGINT,
    disk_total_bytes BIGINT,
    backup JSONB,
    update_state JSONB,
    inventory JSONB,
    status JSONB NOT NULL,
    heartbeats BIGINT NOT NULL DEFAULT 1
);

-- 4. Alerts
CREATE TABLE IF NOT EXISTS giga_cloud.alerts (
    id BIGSERIAL PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    alert_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    title TEXT NOT NULL,
    detail TEXT,
    source TEXT NOT NULL CHECK (source IN ('SHOP', 'CLOUD')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gc_alerts_open ON giga_cloud.alerts(shop_id, alert_key) WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS idx_gc_alerts_recent ON giga_cloud.alerts(shop_id, last_seen_at DESC);

-- 5. Emergency controls (missing row = defaults: remote writes ON, maintenance OFF)
CREATE TABLE IF NOT EXISTS giga_cloud.remote_control (
    shop_id UUID PRIMARY KEY REFERENCES giga_cloud.shops(shop_id),
    remote_writes_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
    maintenance_message TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Alert upsert helper (open alert with the same key is refreshed, otherwise a new one is opened)
CREATE OR REPLACE FUNCTION giga_cloud.raise_alert(p_shop UUID, p_key TEXT, p_kind TEXT, p_severity TEXT, p_title TEXT,
                                                  p_detail TEXT, p_source TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    UPDATE giga_cloud.alerts SET last_seen_at = now(), severity = p_severity, title = p_title, detail = p_detail
     WHERE shop_id = p_shop AND alert_key = p_key AND status <> 'RESOLVED';
    IF NOT FOUND THEN
        INSERT INTO giga_cloud.alerts (shop_id, alert_key, kind, severity, title, detail, source)
        VALUES (p_shop, p_key, p_kind, p_severity, p_title, p_detail, p_source);
    END IF;
END $$;

-- 7. HEARTBEAT — called by the shop sync worker with its token. Stores typed, sanitized fields only.
CREATE OR REPLACE FUNCTION public.gc_heartbeat(p_shop_id UUID, p_token TEXT, p_status JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_alert JSONB;
    v_keys TEXT[] := ARRAY[]::TEXT[];
    v_key TEXT;
    v_sev TEXT;
    v_status JSONB;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_status IS NULL OR jsonb_typeof(p_status) <> 'object' OR octet_length(p_status::text) > 65536 THEN
        RAISE EXCEPTION 'invalid heartbeat payload' USING ERRCODE = 'PT400';
    END IF;
    v_status := p_status - 'alerts';

    INSERT INTO giga_cloud.shop_runtime_status AS r (
        shop_id, reported_at, device_id, app_version, git_commit, mode, started_at, uptime_seconds, db_healthy, worker_healthy,
        outbound_pending, outbound_failed, inbound_unacked, last_sync_at, disk_free_bytes, disk_total_bytes,
        backup, update_state, inventory, status)
    VALUES (
        p_shop_id, now(), left(v_status->>'device_id', 100), left(v_status->>'app_version', 40), left(v_status->>'git_commit', 40),
        left(v_status->>'mode', 20), (v_status->>'started_at')::timestamptz, (v_status->>'uptime_seconds')::bigint,
        (v_status->>'db_healthy')::boolean,
        COALESCE((v_status->'worker'->>'running')::boolean, FALSE) AND COALESCE((v_status->'worker'->>'consecutive_failures')::int, 0) < 5
            AND v_status->'worker'->>'halted' IS NULL,
        (v_status->'outbound'->>'pending')::int, (v_status->'outbound'->>'failed')::int, (v_status->'inbound'->>'unacked')::int,
        (v_status->>'last_sync_at')::timestamptz, (v_status->'disk'->>'free_bytes')::bigint, (v_status->'disk'->>'total_bytes')::bigint,
        v_status->'backup', v_status->'update', v_status->'inventory', v_status)
    ON CONFLICT (shop_id) DO UPDATE SET
        reported_at = now(), device_id = EXCLUDED.device_id, app_version = EXCLUDED.app_version, git_commit = EXCLUDED.git_commit,
        mode = EXCLUDED.mode, started_at = EXCLUDED.started_at, uptime_seconds = EXCLUDED.uptime_seconds, db_healthy = EXCLUDED.db_healthy,
        worker_healthy = EXCLUDED.worker_healthy, outbound_pending = EXCLUDED.outbound_pending, outbound_failed = EXCLUDED.outbound_failed,
        inbound_unacked = EXCLUDED.inbound_unacked, last_sync_at = EXCLUDED.last_sync_at, disk_free_bytes = EXCLUDED.disk_free_bytes,
        disk_total_bytes = EXCLUDED.disk_total_bytes, backup = EXCLUDED.backup, update_state = EXCLUDED.update_state,
        inventory = EXCLUDED.inventory, status = EXCLUDED.status, heartbeats = r.heartbeats + 1;

    -- Shop-raised alert conditions present now; the ones no longer reported are resolved.
    FOR v_alert IN SELECT value FROM jsonb_array_elements(COALESCE(p_status->'alerts', '[]'::jsonb)) LIMIT 50 LOOP
        v_key := left(v_alert->>'key', 120);
        v_sev := CASE WHEN v_alert->>'severity' IN ('INFO', 'WARNING', 'CRITICAL') THEN v_alert->>'severity' ELSE 'WARNING' END;
        CONTINUE WHEN v_key IS NULL OR v_key = '';
        v_keys := v_keys || v_key;
        PERFORM giga_cloud.raise_alert(p_shop_id, v_key, left(COALESCE(v_alert->>'kind', 'OTHER'), 40), v_sev,
                                       left(COALESCE(v_alert->>'title', v_key), 200), left(v_alert->>'detail', 500), 'SHOP');
    END LOOP;
    UPDATE giga_cloud.alerts SET status = 'RESOLVED', resolved_at = now()
     WHERE shop_id = p_shop_id AND source = 'SHOP' AND status <> 'RESOLVED' AND NOT (alert_key = ANY(v_keys));

    RETURN jsonb_build_object('ok', TRUE, 'server_time', now());
END $$;

-- 8. Cloud-side alert conditions (called by the online API when the Admin looks at alerts/health)
CREATE OR REPLACE FUNCTION giga_cloud.refresh_cloud_alerts(p_shop UUID, p_offline_seconds INTEGER DEFAULT 180) RETURNS VOID
LANGUAGE plpgsql SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_seen TIMESTAMPTZ;
    c RECORD;
BEGIN
    SELECT reported_at INTO v_seen FROM giga_cloud.shop_runtime_status WHERE shop_id = p_shop;
    IF v_seen IS NULL OR v_seen < now() - make_interval(secs => p_offline_seconds) THEN
        PERFORM giga_cloud.raise_alert(p_shop, 'SHOP_OFFLINE', 'SHOP', 'CRITICAL',
            CASE WHEN v_seen IS NULL THEN 'Shop computer has never sent a heartbeat' ELSE 'Shop computer is offline (no heartbeat)' END,
            CASE WHEN v_seen IS NULL THEN NULL ELSE 'Last heartbeat ' || to_char(v_seen AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI') || ' (Nairobi)' END, 'CLOUD');
    ELSE
        UPDATE giga_cloud.alerts SET status = 'RESOLVED', resolved_at = now()
         WHERE shop_id = p_shop AND alert_key = 'SHOP_OFFLINE' AND status <> 'RESOLVED';
    END IF;
    FOR c IN SELECT command_id, command_type, error FROM giga_cloud.commands
              WHERE shop_id = p_shop AND status = 'REJECTED' AND acked_at > now() - interval '7 days'
                AND NOT EXISTS (SELECT 1 FROM giga_cloud.alerts a WHERE a.shop_id = p_shop AND a.alert_key = 'COMMAND_REJECTED:' || command_id) LOOP
        INSERT INTO giga_cloud.alerts (shop_id, alert_key, kind, severity, title, detail, source)
        VALUES (p_shop, 'COMMAND_REJECTED:' || c.command_id, 'COMMAND', 'WARNING', 'Remote change rejected: ' || c.command_type, left(c.error, 500), 'CLOUD');
    END LOOP;
END $$;

-- 9. queue_online_command: honours remote_writes_enabled and stores the display context.
DROP FUNCTION IF EXISTS giga_cloud.queue_online_command(UUID, TEXT, JSONB, TEXT, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION giga_cloud.queue_online_command(
    p_shop_id UUID, p_type TEXT, p_payload JSONB, p_idempotency_key TEXT, p_user_id UUID,
    p_client_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL, p_display JSONB DEFAULT NULL
) RETURNS TABLE (command_id UUID, status TEXT, created_at TIMESTAMPTZ, duplicate BOOLEAN)
LANGUAGE plpgsql SET search_path = giga_cloud, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_user giga_cloud.online_users%ROWTYPE;
    v_id UUID;
    v_by TEXT;
BEGIN
    SELECT * INTO v_user FROM giga_cloud.online_users u WHERE u.id = p_user_id AND u.active;
    IF NOT FOUND OR v_user.role <> 'ADMIN' THEN
        RAISE EXCEPTION 'only an active online ADMIN may queue shop commands' USING ERRCODE = 'PT403';
    END IF;
    IF v_user.shop_id IS NOT NULL AND v_user.shop_id <> p_shop_id THEN
        RAISE EXCEPTION 'this account may not manage that shop' USING ERRCODE = 'PT403';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM giga_cloud.shops s WHERE s.shop_id = p_shop_id AND s.active) THEN
        RAISE EXCEPTION 'shop is not registered or inactive' USING ERRCODE = 'PT404';
    END IF;
    IF EXISTS (SELECT 1 FROM giga_cloud.remote_control rc WHERE rc.shop_id = p_shop_id AND NOT rc.remote_writes_enabled) THEN
        RAISE EXCEPTION 'remote changes are disabled for this shop' USING ERRCODE = 'PT423';
    END IF;
    IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
        RAISE EXCEPTION 'idempotency key too short' USING ERRCODE = 'PT400';
    END IF;

    v_by := left(v_user.name || ' <' || v_user.email || '>', 200);
    INSERT INTO giga_cloud.commands AS c (shop_id, command_type, payload, idempotency_key, created_by, created_by_user_id, source, display)
    VALUES (p_shop_id, p_type, p_payload, p_idempotency_key, v_by, v_user.id, 'ONLINE_ADMIN', p_display)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING c.command_id INTO v_id;

    IF v_id IS NULL THEN
        RETURN QUERY SELECT c.command_id, c.status, c.created_at, TRUE FROM giga_cloud.commands c
            WHERE c.idempotency_key = p_idempotency_key AND c.shop_id = p_shop_id AND c.created_by_user_id = v_user.id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'idempotency key already used' USING ERRCODE = 'PT409';
        END IF;
        RETURN;
    END IF;

    INSERT INTO giga_cloud.online_audit (shop_id, online_user_id, user_email, action, command_id, command_type, details, client_ip, user_agent)
    VALUES (p_shop_id, v_user.id, v_user.email, 'REMOTE_COMMAND_QUEUED', v_id, p_type, p_payload, left(p_client_ip, 100), left(p_user_agent, 300));

    RETURN QUERY SELECT c.command_id, c.status, c.created_at, FALSE FROM giga_cloud.commands c WHERE c.command_id = v_id;
END $$;

-- 10. Privileges: only gc_heartbeat is added to the API-key-callable set; everything else owner-only.
REVOKE ALL ON giga_cloud.shop_runtime_status, giga_cloud.alerts, giga_cloud.remote_control FROM PUBLIC;
REVOKE ALL ON SEQUENCE giga_cloud.alerts_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.raise_alert(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.refresh_cloud_alerts(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.queue_online_command(UUID, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_heartbeat(UUID, TEXT, JSONB) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON giga_cloud.shop_runtime_status, giga_cloud.alerts, giga_cloud.remote_control FROM %I', r);
            EXECUTE format('REVOKE ALL ON SEQUENCE giga_cloud.alerts_id_seq FROM %I', r);
            EXECUTE format('REVOKE ALL ON FUNCTION giga_cloud.raise_alert(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM %I', r);
            EXECUTE format('REVOKE ALL ON FUNCTION giga_cloud.refresh_cloud_alerts(UUID, INTEGER) FROM %I', r);
            EXECUTE format('REVOKE ALL ON FUNCTION giga_cloud.queue_online_command(UUID, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, JSONB) FROM %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_heartbeat(UUID, TEXT, JSONB) TO %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
