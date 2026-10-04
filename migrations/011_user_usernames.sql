-- =============================================================================
-- Migration 011: Optional usernames for staff login
-- GIGA CHEMIST Pharmacy POS
--
-- The login screen accepts "Email or Username", but users had no username column (login could
-- only match an email). Adds an optional username, unique case-insensitively.
-- Nullable and NOT back-filled: existing accounts keep working by email until an Administrator
-- assigns a username (Users screen). Non-destructive and idempotent.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower
  ON users (lower(username))
  WHERE username IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_username_format') THEN
    -- 3-50 chars: letters, digits, dot, underscore, hyphen; never an email address.
    ALTER TABLE users ADD CONSTRAINT chk_users_username_format
      CHECK (username IS NULL OR username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$');
  END IF;
END $$;
