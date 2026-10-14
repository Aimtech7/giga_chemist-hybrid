-- =============================================================================
-- 023 — IMMUTABLE PRICE HISTORY (additive only)
-- =============================================================================
-- Every change of a medicine's purchase / selling / wholesale / minimum selling price, and of a
-- batch's purchase price / selling price override, is recorded by a TRIGGER, so no code path can
-- change a price without a history row. Who / why / where it came from is taken from transaction-local
-- settings the application sets before the change (server/db/priceHistory.ts):
--   giga.actor_id, giga.actor_name, giga.price_source, giga.price_reason, giga.price_reference
-- A change made without them is still recorded, as source UNATTRIBUTED.
--
-- Rows can never be updated or deleted (trigger). Metadata / audit only: historical sales keep their
-- own unit_price and cost snapshots and are never touched. No existing row of any table is changed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS price_history (
    id BIGSERIAL PRIMARY KEY,
    medicine_id UUID NOT NULL,
    batch_id UUID,
    field VARCHAR(40) NOT NULL,
    old_value NUMERIC(12, 2),
    new_value NUMERIC(12, 2),
    changed_by UUID,
    changed_by_name VARCHAR(255),
    source VARCHAR(40) NOT NULL,
    reason TEXT,
    reference VARCHAR(100),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_history_medicine ON price_history(medicine_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_changed ON price_history(changed_at DESC);

CREATE OR REPLACE FUNCTION price_history_ctx(p_key TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting(p_key, true), '')
$$;

CREATE OR REPLACE FUNCTION price_history_record(p_medicine UUID, p_batch UUID, p_field TEXT, p_old NUMERIC, p_new NUMERIC) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF p_old IS NOT DISTINCT FROM p_new THEN RETURN; END IF;
    INSERT INTO price_history (medicine_id, batch_id, field, old_value, new_value, changed_by, changed_by_name, source, reason, reference)
    VALUES (p_medicine, p_batch, p_field, p_old, p_new,
            CASE WHEN price_history_ctx('giga.actor_id') ~* '^[0-9a-f-]{36}$' THEN price_history_ctx('giga.actor_id')::uuid END,
            price_history_ctx('giga.actor_name'), COALESCE(price_history_ctx('giga.price_source'), 'UNATTRIBUTED'),
            price_history_ctx('giga.price_reason'), price_history_ctx('giga.price_reference'));
END $$;

CREATE OR REPLACE FUNCTION price_history_medicines() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM price_history_record(NEW.id, NULL, 'purchase_price', OLD.purchase_price, NEW.purchase_price);
    PERFORM price_history_record(NEW.id, NULL, 'selling_price', OLD.selling_price, NEW.selling_price);
    PERFORM price_history_record(NEW.id, NULL, 'wholesale_price', OLD.wholesale_price, NEW.wholesale_price);
    PERFORM price_history_record(NEW.id, NULL, 'min_selling_price', OLD.min_selling_price, NEW.min_selling_price);
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_price_history_medicines ON medicines;
CREATE TRIGGER trg_price_history_medicines AFTER UPDATE OF purchase_price, selling_price, wholesale_price, min_selling_price ON medicines
    FOR EACH ROW EXECUTE FUNCTION price_history_medicines();

CREATE OR REPLACE FUNCTION price_history_batches() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM price_history_record(NEW.medicine_id, NEW.id, 'batch_purchase_price', OLD.purchase_price, NEW.purchase_price);
    PERFORM price_history_record(NEW.medicine_id, NEW.id, 'batch_selling_price_override', OLD.selling_price_override, NEW.selling_price_override);
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_price_history_batches ON medicine_batches;
CREATE TRIGGER trg_price_history_batches AFTER UPDATE OF purchase_price, selling_price_override ON medicine_batches
    FOR EACH ROW EXECUTE FUNCTION price_history_batches();

-- History is immutable.
CREATE OR REPLACE FUNCTION price_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'price_history is immutable (% refused)', TG_OP USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS trg_price_history_immutable ON price_history;
CREATE TRIGGER trg_price_history_immutable BEFORE UPDATE OR DELETE ON price_history
    FOR EACH ROW EXECUTE FUNCTION price_history_immutable();
