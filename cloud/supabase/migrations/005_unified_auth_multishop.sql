-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): UNIFIED AUTHENTICATION + MULTI-SHOP     version 005
-- =============================================================================
-- Apply after 004 in the Supabase SQL editor. ADDITIVE and re-runnable: no table or column is
-- dropped, no business row is touched, no credential is reset, existing sessions stay valid.
--
--   1. giga_cloud.online_users becomes the ONE cloud login table for two kinds of account:
--        GLOBAL_ADMIN  cloud-managed, shop_id NULL, role ADMIN, never a shop staff account
--        SHOP_USER     exactly one shop (shop_id) and normally one shop staff account (local_user_id);
--                      the SAME password as the shop login (PBKDF2 "salt$hash"; PINs never leave the shop)
--      Pre-005 accounts: an ADMIN with no shop staff link becomes GLOBAL_ADMIN (keeps its password,
--      sessions and id); every other account becomes SHOP_USER.
--   2. Credential versions: (credential_version, credential_updated_at) decide which password hash
--      is newer; an older hash never overwrites a newer one, in either direction.
--   3. Shop-token RPCs, same authentication pattern as gc_ingest_events:
--        gc_sync_user_credentials   shop -> cloud: staff password hashes + profile (never PINs)
--        gc_fetch_user_credential   cloud -> shop: ONE hash, only while a USER_CREATE /
--                                   USER_CREDENTIAL_REFRESH command for that user is open
--        gc_credential_sync_preview dry run, no hashes in or out
--   4. Credential sync is OFF per shop until giga_cloud.shops.credential_sync_enabled is set
--      (the operator enables it deliberately; until then the RPC stores nothing).
--   5. Command types USER_CREATE and USER_CREDENTIAL_REFRESH (payloads carry no secret).
--   6. The last active GLOBAL_ADMIN can never be deactivated, demoted or deleted (trigger).
-- =============================================================================

BEGIN;

-- 1. Account model -------------------------------------------------------------
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS account_type TEXT;
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS credential_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS credential_source TEXT;
ALTER TABLE giga_cloud.online_users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE giga_cloud.shops ADD COLUMN IF NOT EXISTS credential_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Pre-005 owner-created Administrators (no shop staff link) become GLOBAL_ADMIN; everything else SHOP_USER.
UPDATE giga_cloud.online_users
   SET account_type = 'GLOBAL_ADMIN', shop_id = NULL, updated_at = now()
 WHERE account_type IS NULL AND role = 'ADMIN' AND local_user_id IS NULL;
UPDATE giga_cloud.online_users SET account_type = 'SHOP_USER' WHERE account_type IS NULL;
ALTER TABLE giga_cloud.online_users ALTER COLUMN account_type SET DEFAULT 'SHOP_USER';
ALTER TABLE giga_cloud.online_users ALTER COLUMN account_type SET NOT NULL;

-- Roles: the shop's RBAC roles (MANAGER added; ADMIN / CASHIER unchanged).
DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'giga_cloud.online_users'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%role%' AND pg_get_constraintdef(oid) NOT LIKE '%account_type%'
    LOOP
        EXECUTE format('ALTER TABLE giga_cloud.online_users DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE giga_cloud.online_users ADD CONSTRAINT online_users_role_check CHECK (role IN ('ADMIN', 'MANAGER', 'CASHIER'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'online_users_account_type_check') THEN
        ALTER TABLE giga_cloud.online_users ADD CONSTRAINT online_users_account_type_check
            CHECK (account_type IN ('GLOBAL_ADMIN', 'SHOP_USER'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'online_users_global_admin_shape') THEN
        ALTER TABLE giga_cloud.online_users ADD CONSTRAINT online_users_global_admin_shape
            CHECK (account_type <> 'GLOBAL_ADMIN' OR (shop_id IS NULL AND local_user_id IS NULL AND role = 'ADMIN'));
    END IF;
    -- NOT VALID: grandfathers any pre-005 row; enforced for every new or changed row.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'online_users_shop_user_has_shop') THEN
        ALTER TABLE giga_cloud.online_users ADD CONSTRAINT online_users_shop_user_has_shop
            CHECK (account_type <> 'SHOP_USER' OR shop_id IS NOT NULL) NOT VALID;
    END IF;
END $$;

-- One cloud identity per shop staff account; usernames unique within a shop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_online_users_shop_local ON giga_cloud.online_users (shop_id, local_user_id) WHERE local_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_online_users_shop_username ON giga_cloud.online_users (shop_id, lower(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_online_users_username ON giga_cloud.online_users (lower(username)) WHERE username IS NOT NULL;

-- Owner helper (scripts/online/create-online-user.ts): same signature; account_type derived.
CREATE OR REPLACE FUNCTION giga_cloud.upsert_online_user(p_email TEXT, p_name TEXT, p_role TEXT, p_password_hash TEXT,
                                                         p_shop_id UUID DEFAULT NULL, p_local_user_id UUID DEFAULT NULL) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
    v_id UUID;
    v_type TEXT := CASE WHEN p_shop_id IS NULL AND p_local_user_id IS NULL AND p_role = 'ADMIN' THEN 'GLOBAL_ADMIN' ELSE 'SHOP_USER' END;
BEGIN
    IF p_password_hash IS NULL OR length(p_password_hash) < 40 THEN RAISE EXCEPTION 'password hash looks invalid'; END IF;
    INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, local_user_id, account_type, credential_source)
    VALUES (lower(trim(p_email)), p_name, p_role, p_password_hash, p_shop_id, p_local_user_id, v_type, 'CLOUD')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
        shop_id = EXCLUDED.shop_id, local_user_id = EXCLUDED.local_user_id, account_type = EXCLUDED.account_type, active = TRUE,
        credential_version = giga_cloud.online_users.credential_version + 1, credential_updated_at = now(), credential_source = 'CLOUD',
        token_version = giga_cloud.online_users.token_version + 1, deactivated_at = NULL, updated_at = now()
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- 2. Last active GLOBAL_ADMIN protection (serialized; covers every write path) -------
CREATE OR REPLACE FUNCTION giga_cloud.protect_last_global_admin() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.account_type = 'GLOBAL_ADMIN' AND OLD.active
       AND (TG_OP = 'DELETE' OR NOT NEW.active OR NEW.account_type <> 'GLOBAL_ADMIN' OR NEW.role <> 'ADMIN') THEN
        PERFORM pg_advisory_xact_lock(hashtext('giga_cloud.global_admins'));
        IF NOT EXISTS (SELECT 1 FROM giga_cloud.online_users u
                        WHERE u.account_type = 'GLOBAL_ADMIN' AND u.active AND u.id <> OLD.id) THEN
            RAISE EXCEPTION 'the last active global administrator cannot be removed, deactivated or demoted' USING ERRCODE = 'PT409';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS trg_protect_last_global_admin ON giga_cloud.online_users;
CREATE TRIGGER trg_protect_last_global_admin BEFORE UPDATE OR DELETE ON giga_cloud.online_users
    FOR EACH ROW EXECUTE FUNCTION giga_cloud.protect_last_global_admin();

-- 3. Command types ---------------------------------------------------------------
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
    'USER_CREATE', 'USER_CREDENTIAL_REFRESH'));
CREATE INDEX IF NOT EXISTS idx_gc_commands_open_user ON giga_cloud.commands (shop_id, (payload ->> 'user_id'))
    WHERE status IN ('PENDING', 'DELIVERED');

-- 4. Credential RPCs -------------------------------------------------------------
-- True when an open (not yet acknowledged) command of one of p_types targets that staff account.
CREATE OR REPLACE FUNCTION giga_cloud.open_user_command(p_shop UUID, p_user UUID, p_types TEXT[]) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM giga_cloud.commands c
                    WHERE c.shop_id = p_shop AND c.status IN ('PENDING', 'DELIVERED')
                      AND c.command_type = ANY(p_types) AND c.payload ->> 'user_id' = p_user::text)
$$;

-- Shop -> cloud. The shop is authoritative for its staff, EXCEPT:
--   * an older credential never replaces a newer one (version, then timestamp)
--   * while an online Administrator's USER_SET_ACTIVE / USER_ROLE_UPDATE for that account is still
--     open, the cloud keeps the Administrator's value (the shop has not applied it yet)
-- Results carry statuses only (never a hash).
CREATE OR REPLACE FUNCTION public.gc_sync_user_credentials(p_shop_id UUID, p_token TEXT, p_users JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    u JSONB;
    r giga_cloud.online_users%ROWTYPE;
    v_results JSONB := '[]'::jsonb;
    v_local UUID;
    v_email TEXT;
    v_username TEXT;
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
                    email = v_email, username = v_username, name = COALESCE(NULLIF(u ->> 'name', ''), name), role = v_role, active = v_active,
                    password_hash = CASE WHEN v_newer THEN v_hash ELSE password_hash END,
                    credential_version = CASE WHEN v_newer THEN v_ver ELSE credential_version END,
                    credential_updated_at = CASE WHEN v_newer THEN v_at ELSE credential_updated_at END,
                    credential_source = CASE WHEN v_newer THEN 'SHOP' ELSE credential_source END,
                    -- A new password, a deactivation or a demotion ends existing online sessions.
                    token_version = token_version + CASE WHEN v_newer OR (r.active AND NOT v_active) OR (r.role = 'ADMIN' AND v_role <> 'ADMIN') THEN 1 ELSE 0 END,
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

-- Cloud -> shop: the hash of ONE staff account of THIS shop, only while a USER_CREATE or
-- USER_CREDENTIAL_REFRESH command for it is open (so a shop token cannot bulk-read credentials).
CREATE OR REPLACE FUNCTION public.gc_fetch_user_credential(p_shop_id UUID, p_token TEXT, p_local_user_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE r giga_cloud.online_users%ROWTYPE;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF NOT giga_cloud.open_user_command(p_shop_id, p_local_user_id, ARRAY['USER_CREATE', 'USER_CREDENTIAL_REFRESH']) THEN
        RAISE EXCEPTION 'no open credential command for that account' USING ERRCODE = 'PT404';
    END IF;
    SELECT * INTO r FROM giga_cloud.online_users
     WHERE shop_id = p_shop_id AND local_user_id = p_local_user_id AND account_type = 'SHOP_USER';
    IF NOT FOUND THEN RAISE EXCEPTION 'no cloud identity for that account' USING ERRCODE = 'PT404'; END IF;
    RETURN jsonb_build_object('local_user_id', r.local_user_id, 'email', r.email, 'username', r.username, 'name', r.name,
                              'role', r.role, 'active', r.active, 'password_hash', r.password_hash,
                              'credential_version', r.credential_version, 'credential_updated_at', r.credential_updated_at);
END $$;

-- Dry run for publishing a shop's existing staff (no hashes in or out; writes nothing).
CREATE OR REPLACE FUNCTION public.gc_credential_sync_preview(p_shop_id UUID, p_token TEXT, p_users JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    u JSONB;
    v_out JSONB := '[]'::jsonb;
    v_local UUID;
    v_email TEXT;
    v_username TEXT;
    v_match giga_cloud.online_users%ROWTYPE;
    v_status TEXT;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_users IS NULL OR jsonb_typeof(p_users) <> 'array' OR jsonb_array_length(p_users) > 500 THEN
        RAISE EXCEPTION 'p_users must be a JSON array (max 500)' USING ERRCODE = 'PT400';
    END IF;
    FOR u IN SELECT * FROM jsonb_array_elements(p_users) LOOP
        IF u ? 'password_hash' OR u ? 'pin_hash' THEN RAISE EXCEPTION 'the preview never accepts credentials' USING ERRCODE = 'PT400'; END IF;
        v_local := NULLIF(u ->> 'local_user_id', '')::uuid;
        v_email := lower(trim(u ->> 'email'));
        v_username := NULLIF(lower(trim(COALESCE(u ->> 'username', ''))), '');
        SELECT * INTO v_match FROM giga_cloud.online_users WHERE shop_id = p_shop_id AND local_user_id = v_local;
        IF FOUND THEN v_status := 'MATCHED';
        ELSIF EXISTS (SELECT 1 FROM giga_cloud.online_users WHERE lower(email) = v_email) THEN v_status := 'EMAIL_CONFLICT';
        ELSE v_status := 'TO_CREATE';
        END IF;
        v_out := v_out || jsonb_build_object(
            'local_user_id', v_local, 'status', v_status,
            'email_conflict_with', CASE WHEN v_status = 'EMAIL_CONFLICT' THEN
                (SELECT jsonb_build_object('account_type', o.account_type, 'same_shop', o.shop_id IS NOT DISTINCT FROM p_shop_id)
                   FROM giga_cloud.online_users o WHERE lower(o.email) = v_email LIMIT 1) END,
            'username_conflict', v_username IS NOT NULL AND EXISTS (SELECT 1 FROM giga_cloud.online_users o
                WHERE o.shop_id = p_shop_id AND lower(o.username) = v_username AND o.local_user_id IS DISTINCT FROM v_local),
            'username_used_in_other_shops', v_username IS NOT NULL AND EXISTS (SELECT 1 FROM giga_cloud.online_users o
                WHERE o.shop_id IS DISTINCT FROM p_shop_id AND lower(o.username) = v_username));
    END LOOP;
    RETURN jsonb_build_object('credential_sync_enabled', (SELECT credential_sync_enabled FROM giga_cloud.shops WHERE shop_id = p_shop_id),
                              'results', v_out);
END $$;

-- 5. Privileges: the three new RPCs are callable with the API key and authenticate the shop
--    token themselves; helpers stay owner-only.
REVOKE ALL ON FUNCTION giga_cloud.open_user_command(UUID, UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.protect_last_global_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_sync_user_credentials(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_fetch_user_credential(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_credential_sync_preview(UUID, TEXT, JSONB) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON FUNCTION giga_cloud.open_user_command(UUID, UUID, TEXT[]) FROM %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_sync_user_credentials(UUID, TEXT, JSONB) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_fetch_user_credential(UUID, TEXT, UUID) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_credential_sync_preview(UUID, TEXT, JSONB) TO %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
