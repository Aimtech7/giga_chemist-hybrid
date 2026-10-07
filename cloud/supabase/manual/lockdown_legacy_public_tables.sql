-- =============================================================================
-- GIGA CHEMIST — URGENT: LOCK DOWN THE LEGACY PUBLIC TABLES IN SUPABASE
-- =============================================================================
-- Found 2026-10-07: the public anon key could read public.users (including password_hash and
-- pin_hash) and public.medicines. These tables are an old bulk-loaded copy of the shop database and
-- are NOT used by the hybrid sync or the online API (those use giga_cloud / giga_online).
--
-- Run in the Supabase SQL editor (as the project owner). Effect:
--   * Row Level Security ON for every table in public, with no policies -> anon / authenticated read
--     nothing; the service role and the database owner are unaffected.
--   * All table privileges revoked from anon and authenticated.
-- Safe to re-run. Does not delete any data.
-- =============================================================================
DO $$
DECLARE t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.tablename);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t.tablename);
        END IF;
    END LOOP;
END $$;

-- Verify (should return 0 rows of readable tables for anon):
SELECT table_name FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');

-- The exposed hashes must be treated as compromised: change the password AND PIN of every staff
-- account that existed in that copy (Users screen on the shop POS), and rotate the Supabase
-- database password (Project Settings -> Database).
-- Optional, once you are sure nothing reads these legacy tables: DROP them, or keep them locked.
