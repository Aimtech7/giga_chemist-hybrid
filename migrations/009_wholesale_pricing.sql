-- =============================================================================
-- Migration 009: Wholesale pricing mode on sales
-- GIGA CHEMIST Pharmacy POS
--
-- medicines.wholesale_price already exists (nullable; NULL = no wholesale price set).
-- This adds the pricing mode actually used, per sale and per sale line.
--
-- Columns are NULLABLE with no default, so existing (historical) rows are NOT rewritten:
-- NULL means a legacy sale made before wholesale pricing existed (retail).
-- Every new sale stores 'RETAIL' or 'WHOLESALE' explicitly.
-- Non-destructive and idempotent.
-- =============================================================================

ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_mode VARCHAR(20);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS price_mode VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_price_mode') THEN
    ALTER TABLE sales ADD CONSTRAINT chk_sales_price_mode
      CHECK (price_mode IS NULL OR price_mode IN ('RETAIL', 'WHOLESALE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_items_price_mode') THEN
    ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_price_mode
      CHECK (price_mode IS NULL OR price_mode IN ('RETAIL', 'WHOLESALE'));
  END IF;
  -- A wholesale price, when set, must be a positive amount (existing values are all NULL).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_medicines_wholesale_price') THEN
    ALTER TABLE medicines ADD CONSTRAINT chk_medicines_wholesale_price
      CHECK (wholesale_price IS NULL OR wholesale_price > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_price_mode ON sales(price_mode) WHERE price_mode IS NOT NULL;
