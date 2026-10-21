-- =============================================================================
-- 014 — GLOBAL ADMIN STOCK OVERRIDE & STOCK SNAPSHOT COMMANDS
-- =============================================================================
-- Forward-only, additive, backward-compatible migration.
-- Expands giga_cloud.commands command_type check constraint to include:
--   'STOCK_OVERRIDE_ADD'
--   'STOCK_OVERRIDE_REMOVE'
--   'STOCK_OVERRIDE_SET'
--   'STOCK_SNAPSHOT_REQUEST'
-- Updates public.gc_ping and public.gc_check_compatibility with schema_version 14.
-- =============================================================================

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
        'STOCK_OVERRIDE_ADD'::text, 'STOCK_OVERRIDE_REMOVE'::text, 'STOCK_OVERRIDE_SET'::text, 'STOCK_SNAPSHOT_REQUEST'::text
    ])
);

CREATE OR REPLACE FUNCTION public.gc_ping(p_shop_id UUID, p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    RETURN jsonb_build_object(
        'ok', TRUE,
        'server_time', now(),
        'schema_version', 14,
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
    v_cloud_schema INT := 14;
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
