-- =============================================================================
-- 025 — FRESH-INSTALL FIX: users.salt optional (additive, no data change)
-- =============================================================================
-- A database built from scratch gets users from 002_auth_rbac.sql, which declares a legacy
-- `salt VARCHAR NOT NULL` column. Databases that came from the original schema (Shop 1, dev) never had
-- it, and the application never writes it (credentials are self-contained "salt$hash" values), so on a
-- FRESH install creating a user failed. This only removes the NOT NULL where the column exists;
-- databases without the column are untouched. No row is changed.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'salt' AND is_nullable = 'NO') THEN
        ALTER TABLE users ALTER COLUMN salt DROP NOT NULL;
    END IF;
END $$;
