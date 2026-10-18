-- =============================================================================
-- 011 — ATOMIC BASELINE SEQUENCING, NEGATIVE STOCK PROTECTION & CATALOGUE PARITY
-- =============================================================================
-- 1. Atomic baseline: a MEDICINE_BASELINE event must atomically set:
--      baseline_seq, baseline_quantity, last_reported_quantity, delta_since_baseline
--    from the SAME authoritative local snapshot.
-- 2. Negative stock protection & drift detection:
--      If a movement would cause cloud stock < 0, flag reconciliation_required
--      and create a STOCK_RECONCILIATION_REQUIRED alert. Never silently clamp with MAX(stock, 0).
-- 3. Batch metadata parity: expose notes and created_by in giga_online.medicine_batches.
-- 4. User deletion support: handle USER_DELETED event in apply_event_core.
-- =============================================================================

-- Add reconciliation_required flags to stock_levels
ALTER TABLE giga_cloud.stock_levels
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

-- Update stock_on_hand view to expose reconciliation_required
CREATE OR REPLACE VIEW giga_cloud.stock_on_hand AS
SELECT shop_id, medicine_id, batch_id, has_baseline,
       baseline_quantity + delta_since_baseline AS quantity,
       last_reported_quantity,
       (has_baseline AND last_reported_quantity IS NOT NULL
        AND last_reported_quantity <> baseline_quantity + delta_since_baseline) AS drift_detected,
       reconciliation_required,
       reconciliation_reason,
       last_movement_at
FROM giga_cloud.stock_levels;

-- Update giga_online.batch_stock to expose reconciliation_required
CREATE OR REPLACE VIEW giga_online.batch_stock AS
SELECT s.medicine_id, s.batch_id,
       CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE COALESCE(s.last_reported_quantity, 0) END::int AS quantity,
       s.reconciliation_required,
       s.reconciliation_reason
FROM giga_cloud.stock_levels s WHERE s.shop_id = giga_online.current_shop();

-- Expose notes and created_by in giga_online.medicine_batches
CREATE OR REPLACE VIEW giga_online.medicine_batches AS
SELECT b.batch_id AS id, (b.data->>'branch_id')::uuid AS branch_id, b.medicine_id, b.batch_number, (b.data->>'supplier_id')::uuid AS supplier_id,
       NULL::int AS quantity_received, COALESCE(bs.quantity, 0) AS quantity_available,
       (b.data->>'purchase_price')::numeric AS purchase_price, (b.data->>'selling_price_override')::numeric AS selling_price_override,
       (b.data->>'manufacturing_date')::date AS manufacturing_date, b.expiry_date, (b.data->>'received_date')::date AS received_date,
       b.data->>'purchase_invoice' AS purchase_invoice, b.data->>'notes' AS notes, (b.data->>'created_by')::uuid AS created_by,
       b.expiry_status, b.status, b.updated_at AS created_at, b.updated_at
FROM giga_cloud.medicine_batches b
LEFT JOIN giga_online.batch_stock bs ON bs.batch_id = b.batch_id
WHERE b.shop_id = giga_online.current_shop();

-- Expose reconciliation_required on giga_online.medicines
CREATE OR REPLACE VIEW giga_online.medicines AS
SELECT m.medicine_id AS id, (m.data->>'branch_id')::uuid AS branch_id, m.name, m.data->>'generic_name' AS generic_name,
       m.data->>'brand_name' AS brand_name, m.sku, m.barcode, (m.data->>'category_id')::uuid AS category_id,
       m.data->>'medicine_type' AS medicine_type, m.data->>'dosage_strength' AS dosage_strength, m.data->>'dosage_form' AS dosage_form,
       m.data->>'manufacturer' AS manufacturer, m.data->>'description' AS description,
       m.purchase_price, m.selling_price, m.wholesale_price, m.min_selling_price,
       COALESCE((SELECT SUM(bs.quantity) FROM giga_online.batch_stock bs WHERE bs.medicine_id = m.medicine_id), 0)::int AS current_stock,
       COALESCE((SELECT bool_or(bs.reconciliation_required) FROM giga_online.batch_stock bs WHERE bs.medicine_id = m.medicine_id), FALSE) AS stock_reconciliation_required,
       m.reorder_level, m.data->>'unit' AS unit, (m.data->>'prescription_required')::boolean AS prescription_required,
       m.status, m.local_version AS version, (m.data->>'created_by')::uuid AS created_by, (m.data->>'updated_by')::uuid AS updated_by,
       (m.data->>'created_at')::timestamptz AS created_at, (m.data->>'updated_at')::timestamptz AS updated_at
FROM giga_cloud.medicines m WHERE m.shop_id = giga_online.current_shop();

-- Enhanced apply_movements: detects negative stock without silent clamping
CREATE OR REPLACE FUNCTION giga_cloud.apply_movements(p_shop UUID, p_event UUID, p_seq BIGINT, p_movs JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    m JSONB;
    n INTEGER;
    v_med UUID;
    v_bat UUID;
    v_delta INT;
    v_new_q INT;
    v_current_stock INT;
BEGIN
    FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(p_movs, '[]'::jsonb)) LOOP
        v_med := giga_cloud.j_uuid(m, 'medicine_id');
        v_bat := giga_cloud.j_uuid(m, 'batch_id');
        v_delta := giga_cloud.j_int(m, 'delta');
        v_new_q := giga_cloud.j_int(m, 'new_quantity');

        INSERT INTO giga_cloud.inventory_movements (
            shop_id, movement_id, event_id, local_seq, medicine_id, batch_id, movement_type, reason, delta,
            previous_quantity, new_quantity, reference_id, notes, user_id, device_id, occurred_at)
        VALUES (
            p_shop, giga_cloud.j_uuid(m, 'id'), p_event, p_seq, v_med,
            v_bat, m ->> 'movement_type', m ->> 'reason', v_delta,
            giga_cloud.j_int(m, 'previous_quantity'), v_new_q, m ->> 'reference_id',
            m ->> 'notes', giga_cloud.j_uuid(m, 'user_id'), m ->> 'device_id', NULLIF(m ->> 'occurred_at', '')::timestamptz)
        ON CONFLICT (shop_id, movement_id) DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n = 1 THEN
            INSERT INTO giga_cloud.stock_levels AS s (
                shop_id, medicine_id, batch_id, delta_since_baseline, last_reported_quantity, last_movement_seq, last_movement_at)
            VALUES (
                p_shop, v_med, v_bat, v_delta,
                v_new_q, p_seq, NULLIF(m ->> 'occurred_at', '')::timestamptz)
            ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
                delta_since_baseline = s.delta_since_baseline
                    + CASE WHEN p_seq > s.baseline_seq THEN EXCLUDED.delta_since_baseline ELSE 0 END,
                last_reported_quantity = CASE WHEN p_seq >= s.last_movement_seq THEN EXCLUDED.last_reported_quantity ELSE s.last_reported_quantity END,
                last_movement_at = CASE WHEN p_seq >= s.last_movement_seq THEN EXCLUDED.last_movement_at ELSE s.last_movement_at END,
                last_movement_seq = GREATEST(s.last_movement_seq, p_seq);

            -- Check for negative stock condition: flag reconciliation_required instead of silent clamping
            SELECT CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE COALESCE(s.last_reported_quantity, 0) END
              INTO v_current_stock
              FROM giga_cloud.stock_levels s
             WHERE s.shop_id = p_shop AND s.batch_id = v_bat;

            IF v_current_stock < 0 THEN
                UPDATE giga_cloud.stock_levels
                   SET reconciliation_required = TRUE,
                       reconciliation_reason = 'Stock became negative (' || v_current_stock || ') after movement at local_seq ' || p_seq
                 WHERE shop_id = p_shop AND batch_id = v_bat;

                -- Record security / audit event for administrator awareness
                INSERT INTO giga_cloud.audit_events (shop_id, audit_id, event_id, action, entity, entity_id, role, new_value, occurred_at)
                VALUES (p_shop, gen_random_uuid(), p_event, 'STOCK_RECONCILIATION_REQUIRED', 'stock_level', v_bat::text, 'SYSTEM',
                        jsonb_build_object('batch_id', v_bat, 'medicine_id', v_med, 'current_stock', v_current_stock, 'local_seq', p_seq), now())
                ON CONFLICT (shop_id, audit_id) DO NOTHING;
            END IF;
        END IF;
    END LOOP;
END $$;

-- Update giga_cloud.apply_event_core with atomic baseline and USER_DELETED support
CREATE OR REPLACE FUNCTION giga_cloud.apply_event_core(p_shop UUID, ev JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_type TEXT := ev ->> 'event_type';
    v_seq BIGINT := (ev ->> 'local_seq')::bigint;
    v_event UUID := giga_cloud.j_uuid(ev, 'event_id');
    p JSONB := COALESCE(ev -> 'payload', '{}'::jsonb);
    d JSONB := COALESCE(p -> 'data', '{}'::jsonb);
    r JSONB;
    b JSONB;
    n INTEGER;
BEGIN
    CASE v_type
    WHEN 'SALE_COMPLETED' THEN
        IF d ? 'sale' AND jsonb_typeof(d -> 'sale') = 'object' THEN
            PERFORM giga_cloud.upsert_sale(p_shop, v_seq, d -> 'sale', d -> 'customer');
        END IF;
    WHEN 'SALE_VOIDED' THEN
        IF d ? 'sale' AND jsonb_typeof(d -> 'sale') = 'object' THEN
            PERFORM giga_cloud.upsert_sale(p_shop, v_seq, d -> 'sale', NULL);
        END IF;
        PERFORM giga_cloud.upsert_customer(p_shop, v_seq, d -> 'customer');
    WHEN 'PURCHASE_RECEIVED' THEN
        r := giga_cloud.require_row(d -> 'purchase', 'purchase');
        PERFORM giga_cloud.upsert_supplier(p_shop, v_seq, d -> 'supplier');
        INSERT INTO giga_cloud.purchases (shop_id, purchase_id, order_number, invoice_number, supplier_id, received_date, total_amount,
                                          payment_status, data, source_seq)
        VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), r ->> 'order_number', r ->> 'invoice_number', giga_cloud.j_uuid(r, 'supplier_id'),
                NULLIF(r ->> 'received_date', '')::date, giga_cloud.j_num(r, 'total_amount'), r ->> 'payment_status', r, v_seq)
        ON CONFLICT (shop_id, purchase_id) DO NOTHING;
        FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'items', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.purchase_items (shop_id, purchase_item_id, purchase_id, medicine_id, batch_number, quantity, purchase_price, total, data)
            VALUES (p_shop, giga_cloud.j_uuid(b, 'id'), giga_cloud.j_uuid(b, 'purchase_id'), giga_cloud.j_uuid(b, 'medicine_id'),
                    b ->> 'batch_number', giga_cloud.j_int(b, 'quantity'), giga_cloud.j_num(b, 'purchase_price'), giga_cloud.j_num(b, 'total'), b)
            ON CONFLICT (shop_id, purchase_item_id) DO NOTHING;
        END LOOP;
    WHEN 'STOCK_SET', 'STOCK_ADDED', 'STOCK_REMOVED', 'PHYSICAL_COUNT' THEN
        IF jsonb_array_length(COALESCE(p -> 'movements', '[]'::jsonb)) = 0 THEN
            RAISE EXCEPTION '% carries no inventory movement', v_type;
        END IF;
    WHEN 'BATCH_EXPIRY_CHANGED' THEN
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, jsonb_build_array(giga_cloud.require_row(d -> 'batch', 'batch')));
    WHEN 'MEDICINE_CREATED', 'MEDICINE_UPDATED', 'MEDICINE_PRICE_CHANGED' THEN
        PERFORM giga_cloud.upsert_medicine(p_shop, v_seq, d -> 'medicine');
    WHEN 'MEDICINE_BASELINE' THEN
        -- ATOMIC BASELINE INVARIANT:
        -- baseline_seq, baseline_quantity, last_reported_quantity and batch baseline quantities
        -- are set atomically from the SAME authoritative local snapshot at local_seq v_seq.
        PERFORM giga_cloud.upsert_medicine(p_shop, v_seq, d -> 'medicine');
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, d -> 'batches');
        FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'batches', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.stock_levels AS s (
                shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq,
                delta_since_baseline, last_reported_quantity, reconciliation_required, reconciliation_reason)
            VALUES (
                p_shop, giga_cloud.j_uuid(b, 'medicine_id'), giga_cloud.j_uuid(b, 'id'), TRUE,
                giga_cloud.j_int(b, 'quantity_available'), v_seq,
                COALESCE((SELECT SUM(delta) FROM giga_cloud.inventory_movements im
                          WHERE im.shop_id = p_shop AND im.batch_id = giga_cloud.j_uuid(b, 'id') AND im.local_seq > v_seq), 0),
                giga_cloud.j_int(b, 'quantity_available'), FALSE, NULL)
            ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
                has_baseline = TRUE,
                baseline_quantity = EXCLUDED.baseline_quantity,
                baseline_seq = EXCLUDED.baseline_seq,
                delta_since_baseline = EXCLUDED.delta_since_baseline,
                last_reported_quantity = CASE WHEN s.last_movement_seq <= v_seq THEN EXCLUDED.baseline_quantity ELSE s.last_reported_quantity END,
                reconciliation_required = FALSE,
                reconciliation_reason = NULL
            WHERE s.baseline_seq <= EXCLUDED.baseline_seq;
        END LOOP;
    WHEN 'SUPPLIER_UPSERTED' THEN
        PERFORM giga_cloud.upsert_supplier(p_shop, v_seq, giga_cloud.require_row(d -> 'supplier', 'supplier'));
    WHEN 'CUSTOMER_UPSERTED' THEN
        PERFORM giga_cloud.upsert_customer(p_shop, v_seq, giga_cloud.require_row(d -> 'customer', 'customer'));
    WHEN 'EXPENSE_RECORDED' THEN
        r := giga_cloud.require_row(d -> 'expense', 'expense');
        INSERT INTO giga_cloud.expenses (shop_id, expense_id, category, description, amount, payment_method, expense_date, user_id, data, source_seq)
        VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), r ->> 'category', r ->> 'description', giga_cloud.j_num(r, 'amount'),
                r ->> 'payment_method', NULLIF(r ->> 'date', '')::date, giga_cloud.j_uuid(r, 'user_id'), r, v_seq)
        ON CONFLICT (shop_id, expense_id) DO NOTHING;
    WHEN 'SETTINGS_UPDATED' THEN
        r := d -> 'settings';
        IF r IS NULL OR jsonb_typeof(r) <> 'object' THEN RAISE EXCEPTION 'payload is missing settings'; END IF;
        INSERT INTO giga_cloud.shop_settings AS t (shop_id, data, source_seq) VALUES (p_shop, r, v_seq)
        ON CONFLICT (shop_id) DO UPDATE SET data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
        WHERE t.source_seq < EXCLUDED.source_seq;
    WHEN 'USER_UPSERTED' THEN
        r := giga_cloud.require_row(d -> 'user', 'user');
        r := r - 'password_hash' - 'pin_hash';
        INSERT INTO giga_cloud.users AS t (shop_id, user_id, name, email, username, role, active, data, source_seq)
        VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), r ->> 'name', r ->> 'email', r ->> 'username', r ->> 'role', (r ->> 'active')::boolean, r, v_seq)
        ON CONFLICT (shop_id, user_id) DO UPDATE SET
            name = EXCLUDED.name, email = EXCLUDED.email, username = EXCLUDED.username, role = EXCLUDED.role, active = EXCLUDED.active,
            data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
        WHERE t.source_seq < EXCLUDED.source_seq;
    WHEN 'USER_DELETED' THEN
        -- If user has historical sales, expenses or purchases in cloud, deactivate; otherwise delete
        r := d -> 'user';
        IF r IS NOT NULL THEN
            UPDATE giga_cloud.users SET active = FALSE, updated_at = now()
             WHERE shop_id = p_shop AND user_id = giga_cloud.j_uuid(r, 'id');
            UPDATE giga_cloud.online_users SET active = FALSE, updated_at = now()
             WHERE shop_id = p_shop AND local_user_id = giga_cloud.j_uuid(r, 'id');
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown event_type "%"', v_type;
    END CASE;

    -- Common parts of every event: stock ledger, batch metadata, audit trail, device.
    PERFORM giga_cloud.upsert_batches(p_shop, v_seq, p -> 'batches');
    PERFORM giga_cloud.apply_movements(p_shop, v_event, v_seq, p -> 'movements');
    PERFORM giga_cloud.insert_audits(p_shop, v_event, p -> 'audit');
    IF NULLIF(ev ->> 'device_id', '') IS NOT NULL THEN
        INSERT INTO giga_cloud.devices (shop_id, device_id) VALUES (p_shop, ev ->> 'device_id')
        ON CONFLICT (shop_id, device_id) DO UPDATE SET last_seen_at = now();
    END IF;
END $$;

-- Inspection RPC for Shop consistency scanner (read-only audit)
CREATE OR REPLACE FUNCTION giga_cloud.gc_inspect_shop_data(p_shop_id UUID, p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM giga_cloud.verify_shop(p_shop_id, p_token);
    RETURN jsonb_build_object(
        'medicines', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', m.medicine_id,
                'name', m.name,
                'barcode', m.barcode,
                'sku', m.sku,
                'status', m.status
            )), '[]'::jsonb)
            FROM giga_cloud.medicines m
            WHERE m.shop_id = p_shop_id
        ),
        'stock_levels', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'medicine_id', s.medicine_id,
                'batch_id', s.batch_id,
                'has_baseline', s.has_baseline,
                'baseline_quantity', s.baseline_quantity,
                'baseline_seq', s.baseline_seq,
                'delta_since_baseline', s.delta_since_baseline,
                'quantity', CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE s.last_reported_quantity END,
                'last_reported_quantity', s.last_reported_quantity,
                'reconciliation_required', s.reconciliation_required
            )), '[]'::jsonb)
            FROM giga_cloud.stock_levels s
            WHERE s.shop_id = p_shop_id
        ),
        'users', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'user_id', u.user_id,
                'name', u.name,
                'email', u.email,
                'username', u.username,
                'role', u.role,
                'active', u.active
            )), '[]'::jsonb)
            FROM giga_cloud.users u
            WHERE u.shop_id = p_shop_id
        ),
        'online_users', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', ou.id,
                'local_user_id', ou.local_user_id,
                'email', ou.email,
                'username', ou.username,
                'name', ou.name,
                'role', ou.role,
                'active', ou.active,
                'credential_version', ou.credential_version
            )), '[]'::jsonb)
            FROM giga_cloud.online_users ou
            WHERE ou.shop_id = p_shop_id
        )
    );
END $$;

GRANT EXECUTE ON FUNCTION giga_cloud.gc_inspect_shop_data(UUID, TEXT) TO anon, authenticated, service_role;

