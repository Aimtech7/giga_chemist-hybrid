-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase): CASHIER SHIFTS + CASH RECONCILIATION     version 009
-- =============================================================================
-- Apply after 008, BEFORE deploying the Vercel API or any shop update of this release (a shop on this
-- release emits SHIFT_* events, which a pre-009 cloud rejects). ADDITIVE and re-runnable: no table,
-- column or business row is dropped or changed.
--
--   1. giga_cloud.cashier_shifts / cashier_shift_corrections: the REPORTING copy of each shop's shifts,
--      scoped by shop_id. The shop's local PostgreSQL stays authoritative; rows arrive only via events.
--   2. Event types SHIFT_OPENED, SHIFT_CLOSED, SHIFT_REVIEWED, SHIFT_CORRECTED (idempotent: replays are
--      DUPLICATE in processed_events, and an older copy never overwrites a newer one: source_seq).
--   3. Alerts: SHIFT_SHORTAGE / SHIFT_OVERAGE (any non-zero variance, raised on SHIFT_CLOSED, resolved by
--      SHIFT_REVIEWED), SHIFT_LEFT_OPEN (open from a previous business day) / SHIFT_NOT_CLOSED (open 2+
--      days), refreshed by giga_cloud.refresh_shift_alerts (called by the online API).
--   4. Command type SHIFT_REVIEW (an online Administrator reviews a CLOSED shift; the shop applies it).
--   5. Indexes for the shift reads (sales / returns / expenses carry shift ids inside their data JSON).
--   6. giga_online.cashier_shifts view (selected shop only); giga_online.returns gains refund_method /
--      refund_shift_id and giga_online.expenses gains shift_id (appended; existing columns unchanged).
-- apply_event: the 006 wrapper is re-created here with the shift branch added (same behaviour for every
-- other type). Re-running 006 later replaces it without the shift branch: re-run this file afterwards.
-- Nothing here writes stock.
-- =============================================================================

BEGIN;

-- 1. Tables ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.cashier_shifts (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    shift_id UUID NOT NULL,
    shift_number TEXT,
    cashier_id UUID,
    cashier_name TEXT,
    device_id TEXT,
    status TEXT NOT NULL,
    opened_at TIMESTAMPTZ,
    opened_business_date DATE,
    opening_float NUMERIC(12,2),
    closed_at TIMESTAMPTZ,
    closed_business_date DATE,
    total_sales NUMERIC(12,2),
    expected_cash NUMERIC(12,2),
    actual_cash NUMERIC(12,2),
    cash_variance NUMERIC(12,2),
    reviewed_at TIMESTAMPTZ,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, shift_id)
);
CREATE INDEX IF NOT EXISTS idx_gc_shifts_date ON giga_cloud.cashier_shifts (shop_id, opened_business_date);
CREATE INDEX IF NOT EXISTS idx_gc_shifts_cashier ON giga_cloud.cashier_shifts (shop_id, cashier_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_shifts_status ON giga_cloud.cashier_shifts (shop_id, status);

CREATE TABLE IF NOT EXISTS giga_cloud.cashier_shift_corrections (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    correction_id UUID NOT NULL,
    shift_id UUID NOT NULL,
    previous_actual_cash NUMERIC(12,2),
    corrected_actual_cash NUMERIC(12,2),
    expected_cash NUMERIC(12,2),
    corrected_variance NUMERIC(12,2),
    reason TEXT,
    created_by_name TEXT,
    created_at TIMESTAMPTZ,
    data JSONB NOT NULL,
    PRIMARY KEY (shop_id, correction_id)
);
CREATE INDEX IF NOT EXISTS idx_gc_shift_corrections_shift ON giga_cloud.cashier_shift_corrections (shop_id, shift_id);

-- Shift links travel inside the existing rows' data (no new columns on existing tables).
CREATE INDEX IF NOT EXISTS idx_gc_sales_shift ON giga_cloud.sales (shop_id, ((data->>'shift_id')::uuid));
CREATE INDEX IF NOT EXISTS idx_gc_returns_refund_shift ON giga_cloud.returns (shop_id, ((data->>'refund_shift_id')::uuid));
CREATE INDEX IF NOT EXISTS idx_gc_expenses_shift ON giga_cloud.expenses (shop_id, ((data->>'shift_id')::uuid));

-- 2. Command type SHIFT_REVIEW ------------------------------------------------------------
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
    'USER_SESSION_REVOKE',
    'SHIFT_REVIEW'));

-- 3. Event application -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION giga_cloud.upsert_shift(p_shop UUID, p_seq BIGINT, r JSONB, p_cashier_name TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    r := giga_cloud.require_row(r, 'shift');
    INSERT INTO giga_cloud.cashier_shifts AS t (
        shop_id, shift_id, shift_number, cashier_id, cashier_name, device_id, status, opened_at, opened_business_date, opening_float,
        closed_at, closed_business_date, total_sales, expected_cash, actual_cash, cash_variance, reviewed_at, data, source_seq)
    VALUES (
        p_shop, giga_cloud.j_uuid(r, 'id'), r ->> 'shift_number', giga_cloud.j_uuid(r, 'cashier_id'), p_cashier_name, r ->> 'device_id',
        r ->> 'status', NULLIF(r ->> 'opened_at', '')::timestamptz, NULLIF(r ->> 'opened_business_date', '')::date,
        giga_cloud.j_num(r, 'opening_float'), NULLIF(r ->> 'closed_at', '')::timestamptz, NULLIF(r ->> 'closed_business_date', '')::date,
        giga_cloud.j_num(r, 'total_sales'), giga_cloud.j_num(r, 'expected_cash'), giga_cloud.j_num(r, 'actual_cash'),
        giga_cloud.j_num(r, 'cash_variance'), NULLIF(r ->> 'reviewed_at', '')::timestamptz, r, p_seq)
    ON CONFLICT (shop_id, shift_id) DO UPDATE SET
        shift_number = EXCLUDED.shift_number, cashier_id = EXCLUDED.cashier_id,
        cashier_name = COALESCE(EXCLUDED.cashier_name, t.cashier_name), device_id = EXCLUDED.device_id, status = EXCLUDED.status,
        opened_at = EXCLUDED.opened_at, opened_business_date = EXCLUDED.opened_business_date, opening_float = EXCLUDED.opening_float,
        closed_at = EXCLUDED.closed_at, closed_business_date = EXCLUDED.closed_business_date, total_sales = EXCLUDED.total_sales,
        expected_cash = EXCLUDED.expected_cash, actual_cash = EXCLUDED.actual_cash, cash_variance = EXCLUDED.cash_variance,
        reviewed_at = EXCLUDED.reviewed_at, data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

-- Variance alert of one shift from its CURRENT cloud row (+ the latest correction, if any).
CREATE OR REPLACE FUNCTION giga_cloud.sync_shift_variance_alert(p_shop UUID, p_shift UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    s giga_cloud.cashier_shifts%ROWTYPE;
    v_var NUMERIC;
    v_key TEXT := 'SHIFT_VARIANCE:' || p_shift;
BEGIN
    SELECT * INTO s FROM giga_cloud.cashier_shifts WHERE shop_id = p_shop AND shift_id = p_shift;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT c.corrected_variance INTO v_var FROM giga_cloud.cashier_shift_corrections c
     WHERE c.shop_id = p_shop AND c.shift_id = p_shift ORDER BY c.created_at DESC, c.correction_id DESC LIMIT 1;
    v_var := COALESCE(v_var, s.cash_variance);
    IF s.status = 'CLOSED' AND v_var IS NOT NULL AND v_var <> 0 THEN
        PERFORM giga_cloud.raise_alert(p_shop, v_key, CASE WHEN v_var < 0 THEN 'SHIFT_SHORTAGE' ELSE 'SHIFT_OVERAGE' END, 'WARNING',
            CASE WHEN v_var < 0 THEN 'Cash SHORT ' ELSE 'Cash OVER ' END || to_char(abs(v_var), 'FM999,999,990.00') || ' — '
                || COALESCE(s.cashier_name, 'cashier') || ' (' || COALESCE(s.shift_number, p_shift::text) || ')',
            'Expected ' || to_char(s.expected_cash, 'FM999,999,990.00') || ', counted ' || to_char(s.expected_cash + v_var, 'FM999,999,990.00')
                || '. Closed ' || COALESCE(to_char(s.closed_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI'), '?') || ' (Nairobi). Review the shift to resolve.',
            'CLOUD');
    ELSE
        UPDATE giga_cloud.alerts SET status = 'RESOLVED', resolved_at = now()
         WHERE shop_id = p_shop AND alert_key = v_key AND status <> 'RESOLVED';
    END IF;
    IF s.status <> 'OPEN' THEN
        UPDATE giga_cloud.alerts SET status = 'RESOLVED', resolved_at = now()
         WHERE shop_id = p_shop AND alert_key IN ('SHIFT_LEFT_OPEN:' || p_shift, 'SHIFT_NOT_CLOSED:' || p_shift) AND status <> 'RESOLVED';
    END IF;
END $$;

-- Shifts left open: never auto-closed, only flagged (called by the online API with the alerts).
CREATE OR REPLACE FUNCTION giga_cloud.refresh_shift_alerts(p_shop UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Africa/Nairobi')::date;
    s RECORD;
BEGIN
    FOR s IN SELECT shift_id, shift_number, cashier_name, opened_at, opened_business_date FROM giga_cloud.cashier_shifts
              WHERE shop_id = p_shop AND status = 'OPEN' AND opened_business_date < v_today LOOP
        IF s.opened_business_date < v_today - 1 THEN
            PERFORM giga_cloud.raise_alert(p_shop, 'SHIFT_NOT_CLOSED:' || s.shift_id, 'SHIFT_NOT_CLOSED', 'CRITICAL',
                'Shift NOT CLOSED for ' || (v_today - s.opened_business_date) || ' days — ' || COALESCE(s.cashier_name, 'cashier') || ' (' || COALESCE(s.shift_number, '') || ')',
                'Opened ' || to_char(s.opened_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI') || ' (Nairobi). Count the drawer and close it at the shop.', 'CLOUD');
        ELSE
            PERFORM giga_cloud.raise_alert(p_shop, 'SHIFT_LEFT_OPEN:' || s.shift_id, 'SHIFT_LEFT_OPEN', 'WARNING',
                'Open shift from a previous business day — ' || COALESCE(s.cashier_name, 'cashier') || ' (' || COALESCE(s.shift_number, '') || ')',
                'Opened ' || to_char(s.opened_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI') || ' (Nairobi). Not auto-closed: the cashier (or an Administrator, with a reason) must count and close it.', 'CLOUD');
        END IF;
    END LOOP;
    -- Resolve flags whose shift was closed meanwhile (or escalated from LEFT_OPEN to NOT_CLOSED).
    UPDATE giga_cloud.alerts a SET status = 'RESOLVED', resolved_at = now()
     WHERE a.shop_id = p_shop AND a.status <> 'RESOLVED'
       AND (a.alert_key LIKE 'SHIFT_LEFT_OPEN:%' OR a.alert_key LIKE 'SHIFT_NOT_CLOSED:%')
       AND NOT EXISTS (SELECT 1 FROM giga_cloud.cashier_shifts x
                        WHERE x.shop_id = p_shop AND x.status = 'OPEN' AND x.opened_business_date < v_today
                          AND a.alert_key = CASE WHEN x.opened_business_date < v_today - 1 THEN 'SHIFT_NOT_CLOSED:' ELSE 'SHIFT_LEFT_OPEN:' END || x.shift_id);
END $$;

-- The 006 wrapper with the shift branch added (unchanged for every other event type).
CREATE OR REPLACE FUNCTION giga_cloud.apply_event(p_shop UUID, ev JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_type TEXT := ev ->> 'event_type';
    v_event UUID := giga_cloud.j_uuid(ev, 'event_id');
    v_seq BIGINT := NULLIF(ev ->> 'local_seq', '')::bigint;
    p JSONB := COALESCE(ev -> 'payload', '{}'::jsonb);
    d JSONB := COALESCE(ev -> 'payload' -> 'data', '{}'::jsonb);
    c JSONB;
    v_shift UUID;
BEGIN
    IF v_type IN ('SHIFT_OPENED', 'SHIFT_CLOSED', 'SHIFT_REVIEWED', 'SHIFT_CORRECTED') THEN
        IF v_seq IS NULL THEN RAISE EXCEPTION 'local_seq is required'; END IF;
        PERFORM giga_cloud.upsert_shift(p_shop, v_seq, d -> 'shift', d ->> 'cashier_name');
        v_shift := giga_cloud.j_uuid(d -> 'shift', 'id');
        IF v_type = 'SHIFT_CORRECTED' THEN
            c := giga_cloud.require_row(d -> 'correction', 'correction');
            INSERT INTO giga_cloud.cashier_shift_corrections (shop_id, correction_id, shift_id, previous_actual_cash, corrected_actual_cash,
                                                             expected_cash, corrected_variance, reason, created_by_name, created_at, data)
            VALUES (p_shop, giga_cloud.j_uuid(c, 'id'), giga_cloud.j_uuid(c, 'shift_id'), giga_cloud.j_num(c, 'previous_actual_cash'),
                    giga_cloud.j_num(c, 'corrected_actual_cash'), giga_cloud.j_num(c, 'expected_cash'), giga_cloud.j_num(c, 'corrected_variance'),
                    c ->> 'reason', c ->> 'created_by_name', NULLIF(c ->> 'created_at', '')::timestamptz, c)
            ON CONFLICT (shop_id, correction_id) DO NOTHING;
        END IF;
        IF v_type <> 'SHIFT_OPENED' THEN
            PERFORM giga_cloud.sync_shift_variance_alert(p_shop, v_shift);
        END IF;
        PERFORM giga_cloud.insert_audits(p_shop, v_event, p -> 'audit');
        IF NULLIF(ev ->> 'device_id', '') IS NOT NULL THEN
            INSERT INTO giga_cloud.devices (shop_id, device_id) VALUES (p_shop, ev ->> 'device_id')
            ON CONFLICT (shop_id, device_id) DO UPDATE SET last_seen_at = now();
        END IF;
        RETURN;
    END IF;

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

-- 4. Online views (selected shop only) ------------------------------------------------------------
-- Existing views gain the shift links at the END (existing columns unchanged): the shop's shared
-- read code (returns / expenses lists) selects them.
CREATE OR REPLACE VIEW giga_online.returns AS
SELECT r.return_id AS id, (r.data->>'branch_id')::uuid AS branch_id, r.sale_id, r.receipt_number, r.medicine_id, r.batch_id, r.quantity,
       (r.data->>'unit_price')::numeric AS unit_price, r.refund_amount, r.requested_refund, r.approved_quantity, r.restocked,
       r.data->>'reason' AS reason, r.data->>'action' AS action, r.status, r.requested_by AS user_id, r.data->>'device_id' AS device_id,
       (r.data->>'created_at')::timestamptz AS created_at, r.reviewed_by, r.reviewed_at, r.data->>'review_notes' AS review_notes,
       r.data->>'reviewed_by_name' AS reviewed_by_name,
       r.data->>'refund_method' AS refund_method, (r.data->>'refund_shift_id')::uuid AS refund_shift_id
FROM giga_cloud.returns r WHERE r.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.expenses AS
SELECT e.expense_id AS id, (e.data->>'branch_id')::uuid AS branch_id, e.category, e.description, e.amount, e.payment_method,
       e.data->>'reference' AS reference, e.user_id, e.expense_date AS date, (e.data->>'created_at')::timestamptz AS created_at,
       COALESCE(e.data->>'status', 'posted') AS status, e.data->>'void_reason' AS void_reason,
       (e.data->>'voided_at')::timestamptz AS voided_at, e.data->>'created_by_name' AS created_by_name,
       (e.data->>'shift_id')::uuid AS shift_id
FROM giga_cloud.expenses e WHERE e.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.cashier_shifts AS
SELECT s.shift_id AS id, s.shift_number, s.cashier_id, s.cashier_name, s.device_id, s.status, s.opened_at, s.opened_business_date,
       s.opening_float, s.closed_at, s.closed_business_date, s.total_sales, s.expected_cash, s.actual_cash, s.cash_variance, s.reviewed_at
FROM giga_cloud.cashier_shifts s WHERE s.shop_id = giga_online.current_shop();

-- 5. Privileges: owner-only, like every other giga_cloud object.
REVOKE ALL ON giga_cloud.cashier_shifts, giga_cloud.cashier_shift_corrections FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.upsert_shift(UUID, BIGINT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.sync_shift_variance_alert(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.refresh_shift_alerts(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.apply_event(UUID, JSONB) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON giga_cloud.cashier_shifts, giga_cloud.cashier_shift_corrections FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA giga_cloud FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA giga_online FROM %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
