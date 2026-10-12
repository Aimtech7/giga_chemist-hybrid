-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): FULL-WRITE GLOBAL ADMIN                version 006
-- =============================================================================
-- Apply after 005 in the Supabase SQL editor, BEFORE deploying the Vercel API or any shop update
-- of this release. ADDITIVE and re-runnable: no table, column or business row is dropped or changed.
--
--   1. Command types for full remote administration of ONE shop per command (medicines, batches,
--      suppliers, customers, purchases, expenses, returns, sale void, staff sessions). Writes are
--      still only QUEUED here; the shop's local PostgreSQL applies each command in one transaction.
--   2. Shop -> cloud event types for changes that previously could not be mirrored:
--        EXPENSE_UPDATED, EXPENSE_VOIDED                    (a posted expense is never deleted)
--        PURCHASE_DRAFTED, PURCHASE_UPDATED, PURCHASE_CANCELLED  (draft purchase lifecycle)
--        BATCH_UPDATED                                      (batch metadata / active state)
--      and EXPENSE_RECORDED / PURCHASE_RECEIVED now UPDATE an existing row when the event is newer
--      (a received draft, an edited expense) instead of keeping the first copy.
--      Implemented as a wrapper: the 001 function is kept, renamed giga_cloud.apply_event_core,
--      and is still what applies every other event type. Re-running 001 later replaces the wrapper
--      with the core function: re-run this file afterwards.
--   3. giga_online views gain the new lifecycle columns at the END (existing columns unchanged):
--        expenses.status / void_reason / voided_at / created_by_name   (reports exclude voided)
--        customers.active, purchases.cancel_reason, returns.reviewed_by_name
-- Nothing here writes stock: cloud stock still moves ONLY through movements reported by a shop.
-- =============================================================================

BEGIN;

-- 1. Command types ---------------------------------------------------------------
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
    'USER_CREATE', 'USER_CREDENTIAL_REFRESH',
    'MEDICINE_CREATE', 'MEDICINE_SET_ACTIVE',
    'BATCH_CREATE', 'BATCH_UPDATE', 'BATCH_SET_ACTIVE',
    'SUPPLIER_CREATE', 'SUPPLIER_UPDATE', 'SUPPLIER_SET_ACTIVE',
    'CUSTOMER_CREATE', 'CUSTOMER_UPDATE', 'CUSTOMER_SET_ACTIVE',
    'PURCHASE_CREATE', 'PURCHASE_UPDATE_DRAFT', 'PURCHASE_RECEIVE', 'PURCHASE_CANCEL',
    'EXPENSE_CREATE', 'EXPENSE_UPDATE', 'EXPENSE_VOID',
    'RETURN_APPROVE', 'RETURN_REJECT', 'SALE_VOID',
    'USER_SESSION_REVOKE'));

-- 2. Event application -------------------------------------------------------------
CREATE OR REPLACE FUNCTION giga_cloud.upsert_expense(p_shop UUID, p_seq BIGINT, r JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    r := giga_cloud.require_row(r, 'expense');
    INSERT INTO giga_cloud.expenses AS t (shop_id, expense_id, category, description, amount, payment_method, expense_date, user_id, data, source_seq)
    VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), r ->> 'category', r ->> 'description', giga_cloud.j_num(r, 'amount'),
            r ->> 'payment_method', NULLIF(r ->> 'date', '')::date, giga_cloud.j_uuid(r, 'user_id'), r, p_seq)
    ON CONFLICT (shop_id, expense_id) DO UPDATE SET
        category = EXCLUDED.category, description = EXCLUDED.description, amount = EXCLUDED.amount,
        payment_method = EXCLUDED.payment_method, expense_date = EXCLUDED.expense_date, user_id = EXCLUDED.user_id,
        data = EXCLUDED.data, source_seq = EXCLUDED.source_seq
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

-- Purchase header + its lines. Lines are replaced only when this event is newer than the stored row.
CREATE OR REPLACE FUNCTION giga_cloud.upsert_purchase(p_shop UUID, p_seq BIGINT, r JSONB, p_items JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_id UUID;
    v_changed INTEGER;
    b JSONB;
BEGIN
    r := giga_cloud.require_row(r, 'purchase');
    v_id := giga_cloud.j_uuid(r, 'id');
    INSERT INTO giga_cloud.purchases AS t (shop_id, purchase_id, order_number, invoice_number, supplier_id, received_date, total_amount,
                                           payment_status, data, source_seq)
    VALUES (p_shop, v_id, r ->> 'order_number', r ->> 'invoice_number', giga_cloud.j_uuid(r, 'supplier_id'),
            NULLIF(r ->> 'received_date', '')::date, giga_cloud.j_num(r, 'total_amount'), r ->> 'payment_status', r, p_seq)
    ON CONFLICT (shop_id, purchase_id) DO UPDATE SET
        order_number = EXCLUDED.order_number, invoice_number = EXCLUDED.invoice_number, supplier_id = EXCLUDED.supplier_id,
        received_date = EXCLUDED.received_date, total_amount = EXCLUDED.total_amount, payment_status = EXCLUDED.payment_status,
        data = EXCLUDED.data, source_seq = EXCLUDED.source_seq
    WHERE t.source_seq < EXCLUDED.source_seq;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed = 0 OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN; END IF;
    DELETE FROM giga_cloud.purchase_items WHERE shop_id = p_shop AND purchase_id = v_id;
    FOR b IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        INSERT INTO giga_cloud.purchase_items (shop_id, purchase_item_id, purchase_id, medicine_id, batch_number, quantity, purchase_price, total, data)
        VALUES (p_shop, giga_cloud.j_uuid(b, 'id'), v_id, giga_cloud.j_uuid(b, 'medicine_id'), b ->> 'batch_number',
                giga_cloud.j_int(b, 'quantity'), giga_cloud.j_num(b, 'purchase_price'), giga_cloud.j_num(b, 'total'), b)
        ON CONFLICT (shop_id, purchase_item_id) DO UPDATE SET
            purchase_id = EXCLUDED.purchase_id, medicine_id = EXCLUDED.medicine_id, batch_number = EXCLUDED.batch_number,
            quantity = EXCLUDED.quantity, purchase_price = EXCLUDED.purchase_price, total = EXCLUDED.total, data = EXCLUDED.data;
    END LOOP;
END $$;

-- Keep the 001 implementation as apply_event_core (renamed once; re-runs leave it alone).
DO $$
BEGIN
    IF to_regprocedure('giga_cloud.apply_event_core(uuid, jsonb)') IS NULL THEN
        ALTER FUNCTION giga_cloud.apply_event(UUID, JSONB) RENAME TO apply_event_core;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.apply_event(p_shop UUID, ev JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_type TEXT := ev ->> 'event_type';
    v_event UUID := giga_cloud.j_uuid(ev, 'event_id');
    v_seq BIGINT := NULLIF(ev ->> 'local_seq', '')::bigint;
    p JSONB := COALESCE(ev -> 'payload', '{}'::jsonb);
    d JSONB := COALESCE(ev -> 'payload' -> 'data', '{}'::jsonb);
BEGIN
    IF v_type IN ('EXPENSE_UPDATED', 'EXPENSE_VOIDED', 'PURCHASE_DRAFTED', 'PURCHASE_UPDATED', 'PURCHASE_CANCELLED', 'BATCH_UPDATED') THEN
        IF v_seq IS NULL THEN RAISE EXCEPTION 'local_seq is required'; END IF;
        IF v_type IN ('EXPENSE_UPDATED', 'EXPENSE_VOIDED') THEN
            PERFORM giga_cloud.upsert_expense(p_shop, v_seq, d -> 'expense');
        ELSIF v_type = 'BATCH_UPDATED' THEN
            PERFORM giga_cloud.upsert_batches(p_shop, v_seq, jsonb_build_array(giga_cloud.require_row(d -> 'batch', 'batch')));
        ELSE
            PERFORM giga_cloud.upsert_supplier(p_shop, v_seq, d -> 'supplier');
            PERFORM giga_cloud.upsert_purchase(p_shop, v_seq, d -> 'purchase', d -> 'items');
        END IF;
        -- Same common parts as every core event: batch metadata, stock ledger, audit trail, device.
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, p -> 'batches');
        PERFORM giga_cloud.apply_movements(p_shop, v_event, v_seq, p -> 'movements');
        PERFORM giga_cloud.insert_audits(p_shop, v_event, p -> 'audit');
        IF NULLIF(ev ->> 'device_id', '') IS NOT NULL THEN
            INSERT INTO giga_cloud.devices (shop_id, device_id) VALUES (p_shop, ev ->> 'device_id')
            ON CONFLICT (shop_id, device_id) DO UPDATE SET last_seen_at = now();
        END IF;
        RETURN;
    END IF;

    -- Newer copies of rows the core inserts with DO NOTHING (a received draft, a re-recorded expense):
    -- written first, so the core's own inserts become no-ops and everything else is unchanged.
    IF v_seq IS NOT NULL AND v_type = 'EXPENSE_RECORDED' AND jsonb_typeof(d -> 'expense') = 'object' THEN
        PERFORM giga_cloud.upsert_expense(p_shop, v_seq, d -> 'expense');
    ELSIF v_seq IS NOT NULL AND v_type = 'PURCHASE_RECEIVED' AND jsonb_typeof(d -> 'purchase') = 'object' THEN
        PERFORM giga_cloud.upsert_purchase(p_shop, v_seq, d -> 'purchase', d -> 'items');
    END IF;
    PERFORM giga_cloud.apply_event_core(p_shop, ev);
END $$;

-- 3. Online views (new columns appended) ----------------------------------------------
CREATE OR REPLACE VIEW giga_online.expenses AS
SELECT e.expense_id AS id, (e.data->>'branch_id')::uuid AS branch_id, e.category, e.description, e.amount, e.payment_method,
       e.data->>'reference' AS reference, e.user_id, e.expense_date AS date, (e.data->>'created_at')::timestamptz AS created_at,
       COALESCE(e.data->>'status', 'posted') AS status, e.data->>'void_reason' AS void_reason,
       (e.data->>'voided_at')::timestamptz AS voided_at, e.data->>'created_by_name' AS created_by_name
FROM giga_cloud.expenses e WHERE e.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.customers AS
SELECT c.customer_id AS id, (c.data->>'branch_id')::uuid AS branch_id, c.name, c.phone, c.data->>'email' AS email, c.data->>'address' AS address,
       c.data->>'notes' AS notes, (c.data->>'credit_balance')::numeric AS credit_balance, (c.data->>'total_spent')::numeric AS total_spent,
       (c.data->>'last_visit')::timestamptz AS last_visit, (c.data->>'created_at')::timestamptz AS created_at, c.updated_at,
       COALESCE((c.data->>'active')::boolean, TRUE) AS active
FROM giga_cloud.customers c WHERE c.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.purchases AS
SELECT p.purchase_id AS id, (p.data->>'branch_id')::uuid AS branch_id, p.order_number, p.invoice_number, p.supplier_id,
       (p.data->>'order_date')::date AS order_date, p.received_date, p.data->>'status' AS status, p.total_amount, p.payment_status,
       p.data->>'notes' AS notes, (p.data->>'created_by')::uuid AS created_by, (p.data->>'created_at')::timestamptz AS created_at,
       p.data->>'cancel_reason' AS cancel_reason
FROM giga_cloud.purchases p WHERE p.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.returns AS
SELECT r.return_id AS id, (r.data->>'branch_id')::uuid AS branch_id, r.sale_id, r.receipt_number, r.medicine_id, r.batch_id, r.quantity,
       (r.data->>'unit_price')::numeric AS unit_price, r.refund_amount, r.requested_refund, r.approved_quantity, r.restocked,
       r.data->>'reason' AS reason, r.data->>'action' AS action, r.status, r.requested_by AS user_id, r.data->>'device_id' AS device_id,
       (r.data->>'created_at')::timestamptz AS created_at, r.reviewed_by, r.reviewed_at, r.data->>'review_notes' AS review_notes,
       r.data->>'reviewed_by_name' AS reviewed_by_name
FROM giga_cloud.returns r WHERE r.shop_id = giga_online.current_shop();

-- 4. Privileges: owner-only, like every other giga_cloud object.
REVOKE ALL ON FUNCTION giga_cloud.upsert_expense(UUID, BIGINT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.upsert_purchase(UUID, BIGINT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.apply_event(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.apply_event_core(UUID, JSONB) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA giga_cloud FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA giga_online FROM %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
