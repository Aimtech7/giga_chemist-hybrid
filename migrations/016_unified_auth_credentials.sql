-- =============================================================================
-- 016 — UNIFIED AUTHENTICATION: credential versions + cloud credential sync tracking
-- =============================================================================
-- Additive only. No password hash, PIN, role or active flag is changed by this migration.
--   users.credential_version / credential_updated_at   which password hash is newer (shop vs cloud);
--                                                      bumped automatically when password_hash changes
--   users.auth_sync_seq / auth_synced_seq              "needs publishing to the cloud login mirror";
--                                                      bumped when the password, active flag, role,
--                                                      email, username or name changes (never for a PIN)
-- The worker publishes dirty accounts with gc_sync_user_credentials (password HASH only, never the PIN)
-- once the cloud has enabled credential sync for this shop. Existing accounts start "dirty", so the
-- first enabled sync publishes them; until the cloud enables it nothing is stored there.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS users_auth_sync_seq;

ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_sync_seq BIGINT NOT NULL DEFAULT nextval('users_auth_sync_seq');
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_synced_seq BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION users_auth_sync_mark() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- A changed password is a new credential version, unless the writer set the version itself
    -- (a newer credential applied from the cloud keeps the cloud's version and timestamp).
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash AND NEW.credential_version = OLD.credential_version THEN
        NEW.credential_version := OLD.credential_version + 1;
        NEW.credential_updated_at := clock_timestamp();
    END IF;
    IF (NEW.password_hash, NEW.credential_version, NEW.active, NEW.role, NEW.email, NEW.username, NEW.name)
       IS DISTINCT FROM (OLD.password_hash, OLD.credential_version, OLD.active, OLD.role, OLD.email, OLD.username, OLD.name)
       AND NEW.auth_sync_seq = OLD.auth_sync_seq THEN
        NEW.auth_sync_seq := nextval('users_auth_sync_seq');
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_users_auth_sync_mark ON users;
CREATE TRIGGER trg_users_auth_sync_mark BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_auth_sync_mark();

CREATE INDEX IF NOT EXISTS idx_users_auth_sync_dirty ON users(auth_sync_seq) WHERE auth_sync_seq > auth_synced_seq;
