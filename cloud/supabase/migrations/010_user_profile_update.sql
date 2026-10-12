-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): UNIFIED ACCOUNTS — STAFF PROFILE EDITING         version 010
-- =============================================================================
-- Apply after 009, BEFORE deploying the Vercel API of this release (it queues USER_PROFILE_UPDATE,
-- which a pre-010 cloud refuses). ADDITIVE and re-runnable: no table, column or row is dropped.
--
--   1. Command types USER_PROFILE_UPDATE and SYNC_RETRY_FAILED (the shop re-sends its failed outbox
--      events with their original idempotency keys). USER_PROFILE_UPDATE (name / username / email of one shop staff account, with the
--      values the Administrator saw; the shop rejects a stale edit). Never a password, hash or PIN.
--   2. gc_sync_user_credentials (shop -> cloud) re-created from 005 with two changes:
--        * while an online USER_PROFILE_UPDATE for the account is still open, the cloud keeps the
--          Administrator's name / username / email (the shop has not applied it yet) — the same rule
--          005 already applies to USER_SET_ACTIVE / USER_ROLE_UPDATE;
--        * a changed login email or username ends that account's online sessions (token_version).
--      Everything else (version ordering, conflicts, statuses, audit) is unchanged.
--   3. giga_online.sale_cashier_name(sale, cashier, at): the cashier name RECORDED with the sale
--      (giga_cloud.sales.cashier_name snapshot), so renaming staff never rewrites old receipts online.
--      The shop's database has a function of the same name (local migration 021).
-- Nothing here writes stock, sales or credentials of any existing account.
-- =============================================================================

BEGIN;

-- 1. Command type ------------------------------------------------------------------------
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
    'USER_SET_ACTIVE', 'USER_ROLE_UPDATE', 'APP_UPDATE_APPROVE',
    'USER_CREATE', 'USER_CREDENTIAL_REFRESH',
    'MEDICINE_CREATE', 'MEDICINE_SET_ACTIVE',
    'BATCH_CREATE', 'BATCH_UPDATE', 'BATCH_SET_ACTIVE',
    'SUPPLIER_CREATE', 'SUPPLIER_UPDATE', 'SUPPLIER_SET_ACTIVE',
    'CUSTOMER_CREATE', 'CUSTOMER_UPDATE', 'CUSTOMER_SET_ACTIVE',
    'PURCHASE_CREATE', 'PURCHASE_UPDATE_DRAFT', 'PURCHASE_RECEIVE', 'PURCHASE_CANCEL',
    'EXPENSE_CREATE', 'EXPENSE_UPDATE', 'EXPENSE_VOID',
    'RETURN_APPROVE', 'RETURN_REJECT', 'SALE_VOID',
    'USER_SESSION_REVOKE',
    'SHIFT_REVIEW',
    'USER_PROFILE_UPDATE', 'SYNC_RETRY_FAILED'));

-- 2. Shop -> cloud credential / profile publish -----------------------------------------
CREATE OR REPLACE FUNCTION public.gc_sync_user_credentials(p_shop_id UUID, p_token TEXT, p_users JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    u JSONB;
    r giga_cloud.online_users%ROWTYPE;
    v_results JSONB := '[]'::jsonb;
    v_local UUID;
    v_email TEXT;
    v_username TEXT;
    v_name TEXT;
    v_role TEXT;
    v_active BOOLEAN;
    v_hash TEXT;
    v_ver BIGINT;
    v_at TIMESTAMPTZ;
    v_status TEXT;
    v_newer BOOLEAN;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF NOT (SELECT credential_sync_enabled FROM giga_cloud.shops WHERE shop_id = p_shop_id) THEN
        RETURN jsonb_build_object('enabled', FALSE, 'results', '[]'::jsonb);
    END IF;
    IF p_users IS NULL OR jsonb_typeof(p_users) <> 'array' THEN RAISE EXCEPTION 'p_users must be a JSON array' USING ERRCODE = 'PT400'; END IF;
    IF jsonb_array_length(p_users) > 100 THEN RAISE EXCEPTION 'at most 100 users per call' USING ERRCODE = 'PT413'; END IF;

    FOR u IN SELECT * FROM jsonb_array_elements(p_users) LOOP
        BEGIN
            v_local := NULLIF(u ->> 'local_user_id', '')::uuid;
            v_email := lower(trim(u ->> 'email'));
            v_username := NULLIF(lower(trim(COALESCE(u ->> 'username', ''))), '');
            v_role := u ->> 'role';
            v_active := COALESCE((u ->> 'active')::boolean, FALSE);
            v_hash := u ->> 'password_hash';
            v_ver := (u ->> 'credential_version')::bigint;
            v_at := (u ->> 'credential_updated_at')::timestamptz;
            IF v_local IS NULL OR v_email IS NULL OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN RAISE EXCEPTION 'local_user_id and a valid email are required'; END IF;
            IF v_role NOT IN ('ADMIN', 'MANAGER', 'CASHIER') THEN RAISE EXCEPTION 'unsupported role'; END IF;
            IF v_hash IS NULL OR length(v_hash) < 40 OR position('$' IN v_hash) = 0 THEN RAISE EXCEPTION 'password hash format not supported'; END IF;
            IF v_ver IS NULL OR v_ver < 1 OR v_at IS NULL THEN RAISE EXCEPTION 'credential_version and credential_updated_at are required'; END IF;

            SELECT * INTO r FROM giga_cloud.online_users WHERE shop_id = p_shop_id AND local_user_id = v_local FOR UPDATE;
            IF NOT FOUND THEN
                IF EXISTS (SELECT 1 FROM giga_cloud.online_users WHERE lower(email) = v_email) THEN
                    v_status := 'EMAIL_CONFLICT';
                ELSE
                    IF v_username IS NOT NULL AND EXISTS (SELECT 1 FROM giga_cloud.online_users
                                                           WHERE shop_id = p_shop_id AND lower(username) = v_username) THEN
                        v_username := NULL;
                        v_status := 'CREATED_WITHOUT_USERNAME';
                    ELSE
                        v_status := 'CREATED';
                    END IF;
                    INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, local_user_id, active, account_type,
                                                         username, credential_version, credential_updated_at, credential_source,
                                                         deactivated_at)
                    VALUES (v_email, COALESCE(NULLIF(u ->> 'name', ''), v_email), v_role, v_hash, p_shop_id, v_local, v_active, 'SHOP_USER',
                            v_username, v_ver, v_at, 'SHOP', CASE WHEN v_active THEN NULL ELSE now() END);
                END IF;
            ELSE
                v_newer := (v_ver, v_at) > (r.credential_version, r.credential_updated_at);
                v_name := COALESCE(NULLIF(u ->> 'name', ''), r.name);
                -- An online profile edit not yet applied by the shop wins over the shop's older copy.
                IF giga_cloud.open_user_command(p_shop_id, v_local, ARRAY['USER_PROFILE_UPDATE']) THEN
                    v_email := lower(r.email);
                    v_username := r.username;
                    v_name := r.name;
                END IF;
                IF v_email <> lower(r.email) AND EXISTS (SELECT 1 FROM giga_cloud.online_users WHERE lower(email) = v_email AND id <> r.id) THEN
                    v_email := lower(r.email);   -- keep the current login email; reported below
                    v_status := 'EMAIL_CONFLICT_KEPT_OLD';
                ELSE
                    v_status := CASE WHEN v_newer THEN 'CREDENTIAL_UPDATED' WHEN (v_ver, v_at) = (r.credential_version, r.credential_updated_at) THEN 'UPDATED' ELSE 'CLOUD_CREDENTIAL_NEWER' END;
                END IF;
                IF v_username IS NOT NULL AND EXISTS (SELECT 1 FROM giga_cloud.online_users
                                                       WHERE shop_id = p_shop_id AND lower(username) = v_username AND id <> r.id) THEN
                    v_username := r.username;
                END IF;
                IF giga_cloud.open_user_command(p_shop_id, v_local, ARRAY['USER_SET_ACTIVE']) THEN v_active := r.active; END IF;
                IF giga_cloud.open_user_command(p_shop_id, v_local, ARRAY['USER_ROLE_UPDATE']) THEN v_role := r.role; END IF;
                UPDATE giga_cloud.online_users SET
                    email = v_email, username = v_username, name = v_name, role = v_role, active = v_active,
                    password_hash = CASE WHEN v_newer THEN v_hash ELSE password_hash END,
                    credential_version = CASE WHEN v_newer THEN v_ver ELSE credential_version END,
                    credential_updated_at = CASE WHEN v_newer THEN v_at ELSE credential_updated_at END,
                    credential_source = CASE WHEN v_newer THEN 'SHOP' ELSE credential_source END,
                    -- A new password, a deactivation, a demotion or a new login identifier ends online sessions.
                    token_version = token_version + CASE WHEN v_newer OR (r.active AND NOT v_active) OR (r.role = 'ADMIN' AND v_role <> 'ADMIN')
                                                          OR v_email <> lower(r.email) OR v_username IS DISTINCT FROM r.username THEN 1 ELSE 0 END,
                    deactivated_at = CASE WHEN v_active THEN NULL WHEN r.active THEN now() ELSE deactivated_at END,
                    updated_at = now()
                WHERE id = r.id;
            END IF;
            IF v_status IN ('CREATED', 'CREATED_WITHOUT_USERNAME', 'CREDENTIAL_UPDATED') THEN
                INSERT INTO giga_cloud.online_audit (shop_id, online_user_id, user_email, action, details)
                VALUES (p_shop_id, NULL, v_email, 'SHOP_CREDENTIAL_SYNCED',
                        jsonb_build_object('local_user_id', v_local, 'credential_version', v_ver, 'status', v_status));
            END IF;
            v_results := v_results || jsonb_build_object('local_user_id', v_local, 'status', v_status);
        EXCEPTION WHEN OTHERS THEN
            v_results := v_results || jsonb_build_object('local_user_id', u ->> 'local_user_id', 'status', 'REJECTED', 'error', left(SQLERRM, 300));
        END;
    END LOOP;
    RETURN jsonb_build_object('enabled', TRUE, 'results', v_results, 'server_time', now());
END $$;

-- 3. Receipt cashier name (snapshot) ----------------------------------------------------
CREATE OR REPLACE FUNCTION giga_online.sale_cashier_name(p_sale UUID, p_cashier UUID, p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT s.cashier_name FROM giga_cloud.sales s WHERE s.shop_id = giga_online.current_shop() AND s.sale_id = p_sale),
        (SELECT u.name FROM giga_cloud.users u WHERE u.shop_id = giga_online.current_shop() AND u.user_id = p_cashier))
$$;
REVOKE ALL ON FUNCTION giga_online.sale_cashier_name(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;

-- Same name as the shop's user_name_at (local 021) so shared queries (returns, expenses) run against
-- either database. The cloud keeps no name history: it answers the staff mirror's name.
CREATE OR REPLACE FUNCTION giga_online.user_name_at(p_user UUID, p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT u.name FROM giga_cloud.users u WHERE u.shop_id = giga_online.current_shop() AND u.user_id = p_user
$$;
REVOKE ALL ON FUNCTION giga_online.user_name_at(UUID, TIMESTAMPTZ) FROM PUBLIC;

COMMIT;
