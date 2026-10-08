-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): REMOTE ADMIN COMMANDS                 version 003
-- =============================================================================
-- Apply after 001 and 002 in the Supabase SQL editor. Re-runnable, NON-DESTRUCTIVE:
-- no table is dropped, no command history is deleted, no stock row is written.
--
-- Lets an online ADMIN (https://gigachem.vercel.app, giga_cloud.online_users) manage the shop
-- remotely by QUEUEING commands. The shop's local PostgreSQL stays authoritative:
--
--   phone -> Vercel API (ADMIN JWT) -> giga_cloud.queue_online_command -> giga_cloud.commands
--         -> gc_pull_commands -> shop sync worker -> ONE local transaction (stock movement +
--            audit + outbox event) -> gc_ingest_events -> cloud copy -> phone sees the result
--
-- Adds:
--   * command types STOCK_ADD, STOCK_REMOVE, STOCK_SET, BATCH_EXPIRY_UPDATE (CHECK widened)
--   * who/where columns on giga_cloud.commands (created_by_user_id, source)
--   * giga_cloud.online_audit        audit trail of every remote administrative request
--   * giga_cloud.queue_online_command  the only write the online API performs (owner-only)
-- Nothing here updates giga_cloud.stock_levels / medicines: cloud stock still moves ONLY through
-- the movements the shop reports.
-- =============================================================================

BEGIN;

-- 1. Widen the command_type CHECK (drop whichever CHECK constrains command_type, add the new one).
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
    'STOCK_ADD', 'STOCK_REMOVE', 'STOCK_SET', 'BATCH_EXPIRY_UPDATE'));

-- 2. Who queued a command and from where (NULL for commands issued from the SQL editor).
ALTER TABLE giga_cloud.commands ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE giga_cloud.commands ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SQL';
CREATE INDEX IF NOT EXISTS idx_gc_commands_shop_recent ON giga_cloud.commands(shop_id, created_at DESC);

-- 3. Audit of remote administrative requests (the shop additionally audits the APPLY locally).
CREATE TABLE IF NOT EXISTS giga_cloud.online_audit (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    shop_id UUID,
    online_user_id UUID,
    user_email TEXT,
    action TEXT NOT NULL,
    command_id UUID,
    command_type TEXT,
    details JSONB,
    client_ip TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_gc_online_audit_shop ON giga_cloud.online_audit(shop_id, at DESC);

-- 4. Queue one command for a shop on behalf of an online ADMIN. Re-checks, inside the database,
--    that the account is an ACTIVE ADMIN allowed for that shop and that the shop is active.
--    Same idempotency key = same command (a retried phone request never queues twice).
CREATE OR REPLACE FUNCTION giga_cloud.queue_online_command(
    p_shop_id UUID, p_type TEXT, p_payload JSONB, p_idempotency_key TEXT, p_user_id UUID,
    p_client_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
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
    IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
        RAISE EXCEPTION 'idempotency key too short' USING ERRCODE = 'PT400';
    END IF;

    v_by := left(v_user.name || ' <' || v_user.email || '>', 200);
    INSERT INTO giga_cloud.commands AS c (shop_id, command_type, payload, idempotency_key, created_by, created_by_user_id, source)
    VALUES (p_shop_id, p_type, p_payload, p_idempotency_key, v_by, v_user.id, 'ONLINE_ADMIN')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING c.command_id INTO v_id;

    IF v_id IS NULL THEN
        -- Replay of an earlier request: return the original (only if it is this user's, same shop).
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

-- 5. Privileges: owner-only, like every other giga_cloud object (no anon / authenticated access).
REVOKE ALL ON giga_cloud.online_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE giga_cloud.online_audit_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.queue_online_command(UUID, TEXT, JSONB, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON giga_cloud.online_audit FROM %I', r);
            EXECUTE format('REVOKE ALL ON SEQUENCE giga_cloud.online_audit_id_seq FROM %I', r);
            EXECUTE format('REVOKE ALL ON FUNCTION giga_cloud.queue_online_command(UUID, TEXT, JSONB, TEXT, UUID, TEXT, TEXT) FROM %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
