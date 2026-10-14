-- =============================================================================
-- 021 — STAFF NAME HISTORY (receipts keep the name they were recorded with)   additive only
-- =============================================================================
-- Sales store cashier_id only; receipts and history used to show the CURRENT users.name, so renaming
-- a staff member changed every old receipt. Instead of rewriting sale rows, this records each name
-- with the period it was valid:
--
--   user_name_history(user_id, name, valid_from, valid_to)   valid_to NULL = current name
--   trigger on users: a name change closes the current period and opens a new one
--   user_name_at(user_id, at)   the name valid at a moment (falls back to the current name)
--
-- Seed: every existing user's current name, valid from -infinity (= what receipts show today).
-- No existing row of any table is changed. No DROP, no DELETE.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_name_history (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_name_history_user ON user_name_history(user_id, valid_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_name_history_current ON user_name_history(user_id) WHERE valid_to IS NULL;

INSERT INTO user_name_history (user_id, name, valid_from)
SELECT u.id, u.name, '-infinity'::timestamptz
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM user_name_history h WHERE h.user_id = u.id);

CREATE OR REPLACE FUNCTION user_name_history_track() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO user_name_history (user_id, name, valid_from) VALUES (NEW.id, NEW.name, '-infinity'::timestamptz)
        ON CONFLICT DO NOTHING;
    ELSIF NEW.name IS DISTINCT FROM OLD.name THEN
        UPDATE user_name_history SET valid_to = CURRENT_TIMESTAMP WHERE user_id = NEW.id AND valid_to IS NULL;
        INSERT INTO user_name_history (user_id, name, valid_from) VALUES (NEW.id, NEW.name, CURRENT_TIMESTAMP);
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_user_name_history ON users;
CREATE TRIGGER trg_user_name_history AFTER INSERT OR UPDATE OF name ON users
    FOR EACH ROW EXECUTE FUNCTION user_name_history_track();

-- The name a staff member had at a moment (e.g. a sale's created_at); NULL user -> NULL.
CREATE OR REPLACE FUNCTION user_name_at(p_user UUID, p_at TIMESTAMPTZ) RETURNS VARCHAR LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT h.name FROM user_name_history h
          WHERE h.user_id = p_user AND h.valid_from <= COALESCE(p_at, CURRENT_TIMESTAMP)
            AND (h.valid_to IS NULL OR h.valid_to > COALESCE(p_at, CURRENT_TIMESTAMP))
          ORDER BY h.valid_from DESC LIMIT 1),
        (SELECT u.name FROM users u WHERE u.id = p_user))
$$;

-- The cashier name of a sale (same function name in the cloud's giga_online schema, cloud 010, where
-- it returns the per-sale snapshot): shared sale queries work against either database.
CREATE OR REPLACE FUNCTION sale_cashier_name(p_sale UUID, p_cashier UUID, p_at TIMESTAMPTZ) RETURNS VARCHAR LANGUAGE sql STABLE AS $$
    SELECT user_name_at(p_cashier, p_at)
$$;

-- A deleted (never-used) account takes its name history with it (re-run safe).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_name_history_user_id_fkey' AND confdeltype <> 'c') THEN
        ALTER TABLE user_name_history DROP CONSTRAINT user_name_history_user_id_fkey;
        ALTER TABLE user_name_history ADD CONSTRAINT user_name_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;
