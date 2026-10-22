-- =============================================================================
-- 015 — SHOP 1 STABILITY, LOCK CONTENTION ELIMINATION & DELETE PREFLIGHT
-- =============================================================================
-- Forward-only, additive, backward-compatible migration.
-- 1. Adds 'MEDICINE_DELETE_PREFLIGHT' to giga_cloud.commands allowed command types.
-- 2. Makes giga_cloud.authenticate_shop() strictly READ-ONLY (no row lock on shops).
-- 3. Adds low-contention throttled contact updater giga_cloud.touch_shop_contact().
-- 4. Optimizes open commands index to cover (shop_id, created_at, command_id).
-- 5. Updates public.gc_ping and public.gc_check_compatibility with schema_version 15.
-- =============================================================================

-- 1. Commands check constraint
ALTER TABLE giga_cloud.commands DROP CONSTRAINT IF EXISTS commands_command_type_check;
ALTER TABLE giga_cloud.commands ADD CONSTRAINT commands_command_type_check CHECK (
    command_type = ANY (ARRAY[
        'PRICE_UPDATE'::text, 'MEDICINE_METADATA_UPDATE'::text, 'CATEGORY_UPSERT'::text, 'SETTINGS_UPDATE'::text,
        'STOCK_ADD'::text, 'STOCK_REMOVE'::text, 'STOCK_SET'::text, 'BATCH_EXPIRY_UPDATE'::text,
        'USER_SET_ACTIVE'::text, 'USER_ROLE_UPDATE'::text, 'APP_UPDATE_APPROVE'::text, 'USER_CREATE'::text,
        'USER_CREDENTIAL_REFRESH'::text, 'MEDICINE_CREATE'::text, 'MEDICINE_SET_ACTIVE'::text, 'BATCH_CREATE'::text,
        'BATCH_UPDATE'::text, 'BATCH_SET_ACTIVE'::text, 'SUPPLIER_CREATE'::text, 'SUPPLIER_UPDATE'::text,
        'SUPPLIER_SET_ACTIVE'::text, 'CUSTOMER_CREATE'::text, 'CUSTOMER_UPDATE'::text, 'CUSTOMER_SET_ACTIVE'::text,
        'PURCHASE_CREATE'::text, 'PURCHASE_UPDATE_DRAFT'::text, 'PURCHASE_RECEIVE'::text, 'PURCHASE_CANCEL'::text,
        'EXPENSE_CREATE'::text, 'EXPENSE_UPDATE'::text, 'EXPENSE_VOID'::text, 'RETURN_APPROVE'::text,
        'RETURN_REJECT'::text, 'SALE_VOID'::text, 'USER_SESSION_REVOKE'::text, 'SHIFT_REVIEW'::text,
        'USER_PROFILE_UPDATE'::text, 'SYNC_RETRY_FAILED'::text, 'MEDICINE_DELETE'::text,
        'STOCK_OVERRIDE_ADD'::text, 'STOCK_OVERRIDE_REMOVE'::text, 'STOCK_OVERRIDE_SET'::text, 'STOCK_SNAPSHOT_REQUEST'::text,
        'MEDICINE_DELETE_PREFLIGHT'::text
    ])
);

-- 2. Strictly Read-Only authenticate_shop (eliminates exclusive row lock contention)
CREATE OR REPLACE FUNCTION giga_cloud.authenticate_shop(p_shop_id UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_hash TEXT;
    v_active BOOLEAN;
BEGIN
    IF p_shop_id IS NULL OR p_token IS NULL OR length(p_token) < 32 THEN
        RAISE EXCEPTION 'shop authentication failed' USING ERRCODE = 'PT403';
    END IF;
    SELECT token_hash, active INTO v_hash, v_active FROM giga_cloud.shops WHERE shop_id = p_shop_id;
    IF NOT FOUND OR NOT v_active OR v_hash <> giga_cloud.token_hash(p_token) THEN
        RAISE EXCEPTION 'shop authentication failed (unknown, inactive or wrong token)' USING ERRCODE = 'PT403';
    END IF;
    -- Note: NO row update here. Authentication is purely read-only to allow concurrent RPCs.
END $$;

-- 3. Low-contention, throttled contact touch helper (maximum 1 update per 30 seconds per shop)
CREATE OR REPLACE FUNCTION giga_cloud.touch_shop_contact(p_shop_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE giga_cloud.shops
       SET last_seen_at = now()
     WHERE shop_id = p_shop_id
       AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds');
END $$;

-- 4. Open commands index covering sort columns for zero-command pull speed
CREATE INDEX IF NOT EXISTS idx_gc_commands_open_covering
    ON giga_cloud.commands (shop_id, created_at, command_id)
    WHERE status IN ('PENDING', 'DELIVERED');

-- 5. Updated gc_heartbeat: incorporates touch_shop_contact
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
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);

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

-- 6. Versioned Sync Protocol in gc_ping & gc_check_compatibility (schema_version 15)
CREATE OR REPLACE FUNCTION public.gc_ping(p_shop_id UUID, p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);
    RETURN jsonb_build_object(
        'ok', TRUE,
        'server_time', now(),
        'schema_version', 15,
        'sync_protocol_version', 2,
        'min_supported_protocol', 1,
        'max_supported_protocol', 2
    );
END $$;

CREATE OR REPLACE FUNCTION public.gc_check_compatibility(p_shop_id UUID, p_token TEXT, p_protocol_version INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_min INT := 1;
    v_max INT := 2;
    v_cloud_schema INT := 15;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_protocol_version < v_min THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'APPLICATION_TOO_OLD', 'min_supported', v_min, 'cloud_schema_version', v_cloud_schema);
    ELSIF p_protocol_version > v_max THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'CLOUD_SCHEMA_TOO_OLD', 'max_supported', v_max, 'cloud_schema_version', v_cloud_schema);
    END IF;
    RETURN jsonb_build_object('compatible', TRUE, 'protocol_version', p_protocol_version, 'cloud_schema_version', v_cloud_schema);
END $$;

GRANT EXECUTE ON FUNCTION public.gc_check_compatibility(UUID, TEXT, INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gc_ping(UUID, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gc_heartbeat(UUID, TEXT, JSONB) TO anon, authenticated, service_role;
