-- =============================================================================
-- Migration 010: Unique medicine barcodes
-- GIGA CHEMIST Pharmacy POS
--
-- The existing constraint uq_medicine_barcode_branch (barcode, branch_id) does not stop duplicates
-- when branch_id is NULL (NULLs are distinct in PostgreSQL). This adds a unique index on the
-- normalized barcode (case/space-insensitive, empty barcodes ignored).
--
-- Safe on any database: if duplicate barcodes ALREADY exist (e.g. imported legacy data), the index
-- is NOT created and a NOTICE is raised instead of failing the migration run. The application also
-- rejects duplicate barcodes on create/edit, so new duplicates cannot be introduced either way.
-- Non-destructive: no data is modified.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_medicines_barcode_normalized') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM medicines
    WHERE btrim(barcode) <> ''
    GROUP BY lower(btrim(barcode))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Duplicate medicine barcodes exist; unique barcode index NOT created. Resolve duplicates, then re-run.';
  ELSE
    CREATE UNIQUE INDEX uq_medicines_barcode_normalized ON medicines (lower(btrim(barcode))) WHERE btrim(barcode) <> '';
  END IF;
END $$;
