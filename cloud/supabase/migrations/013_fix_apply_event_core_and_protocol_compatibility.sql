-- =============================================================================
-- Migration 013: Restore apply_event_core compatibility, safe retry, and protocol versioning
-- =============================================================================

-- 0. Safe j_uuid function that validates UUID format before casting
CREATE OR REPLACE FUNCTION giga_cloud.j_uuid(v JSONB, k TEXT) RETURNS UUID
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    val TEXT := v ->> k;
BEGIN
    IF val IS NULL OR val !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;
    RETURN val::UUID;
END $$;

-- 1. Overloaded upsert_sale to accept (UUID, BIGINT, JSONB, JSONB) as safety net
CREATE OR REPLACE FUNCTION giga_cloud.upsert_sale(p_shop UUID, p_seq BIGINT, s JSONB, p_customer JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM giga_cloud.upsert_sale(p_shop, p_seq, s, (s ->> 'cashier_name')::TEXT);
END $$;

-- 2. Complete, backwards-compatible apply_event_core with all branches restored
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
    v_med_id UUID;
    n INTEGER;
BEGIN
    IF v_seq IS NULL THEN RAISE EXCEPTION 'local_seq is required'; END IF;

    CASE v_type
    WHEN 'SALE_COMPLETED' THEN
        PERFORM giga_cloud.upsert_customer(p_shop, v_seq, d -> 'customer');
        PERFORM giga_cloud.upsert_sale(p_shop, v_seq, d -> 'sale', d ->> 'cashier_name');
        FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'items', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.sale_items (shop_id, sale_item_id, sale_id, medicine_id, batch_id, batch_number, quantity, unit_price,
                                               discount, cost_price_snapshot, total, price_mode, data)
            VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), giga_cloud.j_uuid(r, 'sale_id'), giga_cloud.j_uuid(r, 'medicine_id'),
                    giga_cloud.j_uuid(r, 'batch_id'), r ->> 'batch_number', giga_cloud.j_int(r, 'quantity'), giga_cloud.j_num(r, 'unit_price'),
                    giga_cloud.j_num(r, 'discount'), giga_cloud.j_num(r, 'cost_price_snapshot'), giga_cloud.j_num(r, 'total'),
                    r ->> 'price_mode', r)
            ON CONFLICT (shop_id, sale_item_id) DO NOTHING;
        END LOOP;
        FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'payments', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.payments (shop_id, payment_id, sale_id, method, amount, reference, data)
            VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), giga_cloud.j_uuid(r, 'sale_id'), r ->> 'method', giga_cloud.j_num(r, 'amount'),
                    r ->> 'reference', r)
            ON CONFLICT (shop_id, payment_id) DO NOTHING;
        END LOOP;

    WHEN 'SALE_VOIDED' THEN
        PERFORM giga_cloud.upsert_customer(p_shop, v_seq, d -> 'customer');
        PERFORM giga_cloud.upsert_sale(p_shop, v_seq, d -> 'sale', NULL);

    WHEN 'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED' THEN
        r := giga_cloud.require_row(d -> 'return', 'return');
        INSERT INTO giga_cloud.returns AS t (shop_id, return_id, sale_id, receipt_number, medicine_id, batch_id, quantity, approved_quantity,
                                            requested_refund, refund_amount, restocked, status, requested_by, reviewed_by, reviewed_at, data, source_seq)
        VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), giga_cloud.j_uuid(r, 'sale_id'), r ->> 'receipt_number', giga_cloud.j_uuid(r, 'medicine_id'),
                giga_cloud.j_uuid(r, 'batch_id'), giga_cloud.j_int(r, 'quantity'), giga_cloud.j_int(r, 'approved_quantity'),
                giga_cloud.j_num(r, 'requested_refund'), giga_cloud.j_num(r, 'refund_amount'), (r ->> 'restocked')::boolean,
                r ->> 'status', giga_cloud.j_uuid(r, 'user_id'), giga_cloud.j_uuid(r, 'reviewed_by'),
                NULLIF(r ->> 'reviewed_at', '')::timestamptz, r, v_seq)
        ON CONFLICT (shop_id, return_id) DO UPDATE SET
            approved_quantity = EXCLUDED.approved_quantity, refund_amount = EXCLUDED.refund_amount, restocked = EXCLUDED.restocked,
            status = EXCLUDED.status, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, data = EXCLUDED.data,
            source_seq = EXCLUDED.source_seq, updated_at = now()
        WHERE t.source_seq < EXCLUDED.source_seq;
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

    WHEN 'MEDICINE_DELETED' THEN
        v_med_id := giga_cloud.j_uuid(d, 'medicine_id');
        IF v_med_id IS NOT NULL THEN
            -- Record tombstone to prevent resurrection from older events
            INSERT INTO giga_cloud.medicine_tombstones (shop_id, medicine_id, deleted_at, deletion_seq, deletion_event_id)
            VALUES (p_shop, v_med_id, now(), v_seq, v_event)
            ON CONFLICT (shop_id, medicine_id) DO UPDATE SET
                deletion_seq = GREATEST(medicine_tombstones.deletion_seq, EXCLUDED.deletion_seq),
                deleted_at = now();

            -- Remove active representation from cloud catalogue
            DELETE FROM giga_cloud.stock_levels WHERE shop_id = p_shop AND medicine_id = v_med_id;
            DELETE FROM giga_cloud.medicine_batches WHERE shop_id = p_shop AND medicine_id = v_med_id;
            DELETE FROM giga_cloud.medicines WHERE shop_id = p_shop AND medicine_id = v_med_id;
        END IF;

    WHEN 'MEDICINE_ARCHIVED' THEN
        v_med_id := giga_cloud.j_uuid(d, 'medicine_id');
        IF v_med_id IS NOT NULL THEN
            UPDATE giga_cloud.medicines 
               SET status = 'archived', updated_at = now()
             WHERE shop_id = p_shop AND medicine_id = v_med_id;
            UPDATE giga_cloud.medicine_batches
               SET status = 'archived', updated_at = now()
             WHERE shop_id = p_shop AND medicine_id = v_med_id;
        END IF;

    WHEN 'MEDICINE_BASELINE', 'STOCK_RECONCILIATION_BASELINE' THEN
        -- Tombstone check
        v_med_id := giga_cloud.j_uuid(d -> 'medicine', 'id');
        IF v_med_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM giga_cloud.medicine_tombstones t 
             WHERE t.shop_id = p_shop AND t.medicine_id = v_med_id AND t.deletion_seq >= v_seq
        ) THEN
            RETURN;
        END IF;

        -- ATOMIC BASELINE INVARIANT:
        -- baseline_seq, baseline_quantity, last_reported_quantity and batch baseline quantities
        -- are set atomically from the SAME authoritative local snapshot at local_seq v_seq.
        PERFORM giga_cloud.upsert_medicine(p_shop, v_seq, d -> 'medicine');
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, d -> 'batches');
        FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'batches', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.stock_levels AS s (
                shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq,
                delta_since_baseline, last_reported_quantity, reconciliation_required, reconciliation_reason,
                stock_version, stock_fingerprint)
            VALUES (
                p_shop, giga_cloud.j_uuid(b, 'medicine_id'), giga_cloud.j_uuid(b, 'id'), TRUE,
                giga_cloud.j_int(b, 'quantity_available'), v_seq,
                COALESCE((SELECT SUM(delta) FROM giga_cloud.inventory_movements im
                          WHERE im.shop_id = p_shop AND im.batch_id = giga_cloud.j_uuid(b, 'id') AND im.local_seq > v_seq), 0),
                giga_cloud.j_int(b, 'quantity_available'), FALSE, NULL,
                COALESCE(giga_cloud.j_int(d -> 'medicine', 'stock_version'), 1),
                d -> 'medicine' ->> 'stock_fingerprint')
            ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
                has_baseline = TRUE,
                baseline_quantity = EXCLUDED.baseline_quantity,
                baseline_seq = EXCLUDED.baseline_seq,
                delta_since_baseline = EXCLUDED.delta_since_baseline,
                last_reported_quantity = CASE WHEN s.last_movement_seq <= v_seq THEN EXCLUDED.baseline_quantity ELSE s.last_reported_quantity END,
                reconciliation_required = FALSE,
                reconciliation_reason = NULL,
                stock_version = GREATEST(s.stock_version, EXCLUDED.stock_version),
                stock_fingerprint = COALESCE(EXCLUDED.stock_fingerprint, s.stock_fingerprint)
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
        r := d -> 'user';
        IF r IS NOT NULL THEN
            UPDATE giga_cloud.users SET active = FALSE, updated_at = now()
             WHERE shop_id = p_shop AND user_id = giga_cloud.j_uuid(r, 'id');
            UPDATE giga_cloud.online_users SET active = FALSE, updated_at = now()
             WHERE shop_id = p_shop AND local_user_id = giga_cloud.j_uuid(r, 'id');
        END IF;

    WHEN 'EXPENSE_UPDATED', 'EXPENSE_VOIDED' THEN
        PERFORM giga_cloud.upsert_expense(p_shop, v_seq, d -> 'expense');

    WHEN 'BATCH_UPDATED' THEN
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, jsonb_build_array(giga_cloud.require_row(d -> 'batch', 'batch')));

    WHEN 'PURCHASE_DRAFTED', 'PURCHASE_UPDATED', 'PURCHASE_CANCELLED' THEN
        PERFORM giga_cloud.upsert_supplier(p_shop, v_seq, d -> 'supplier');
        PERFORM giga_cloud.upsert_purchase(p_shop, v_seq, d -> 'purchase', d -> 'items');

    WHEN 'SHIFT_OPENED', 'SHIFT_CLOSED', 'SHIFT_REVIEWED', 'SHIFT_CORRECTED' THEN
        PERFORM giga_cloud.upsert_shift(p_shop, v_seq, d -> 'shift', d ->> 'cashier_name');
        IF v_type = 'SHIFT_CORRECTED' THEN
            r := giga_cloud.require_row(d -> 'correction', 'correction');
            INSERT INTO giga_cloud.cashier_shift_corrections (shop_id, correction_id, shift_id, previous_actual_cash, corrected_actual_cash,
                                                             expected_cash, corrected_variance, reason, created_by_name, created_at, data)
            VALUES (p_shop, giga_cloud.j_uuid(r, 'id'), giga_cloud.j_uuid(r, 'shift_id'), giga_cloud.j_num(r, 'previous_actual_cash'),
                    giga_cloud.j_num(r, 'corrected_actual_cash'), giga_cloud.j_num(r, 'expected_cash'), giga_cloud.j_num(r, 'corrected_variance'),
                    r ->> 'reason', r ->> 'created_by_name', NULLIF(r ->> 'created_at', '')::timestamptz, r)
            ON CONFLICT (shop_id, correction_id) DO NOTHING;
        END IF;
        IF v_type <> 'SHIFT_OPENED' THEN
            PERFORM giga_cloud.sync_shift_variance_alert(p_shop, giga_cloud.j_uuid(d -> 'shift', 'id'));
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

-- 3. Ingest events: safe retry support and cleanup of rejected records on successful retry
CREATE OR REPLACE FUNCTION public.gc_ingest_events(p_shop_id UUID, p_token TEXT, p_events JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    ev JSONB;
    v_key TEXT;
    v_results JSONB := '[]'::jsonb;
    v_applied INTEGER := 0;
    n INTEGER;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    FOR ev IN SELECT * FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) LOOP
        v_key := ev ->> 'idempotency_key';
        IF v_key IS NULL OR length(v_key) < 8 THEN
            v_results := v_results || jsonb_build_object('status', 'REJECTED', 'error', 'idempotency_key is required');
            CONTINUE;
        END IF;

        IF giga_cloud.j_uuid(ev, 'shop_id') IS DISTINCT FROM p_shop_id THEN
            INSERT INTO giga_cloud.rejected_events (shop_id, idempotency_key, event_type, error, payload)
            VALUES (p_shop_id, v_key, ev ->> 'event_type', 'event shop_id does not match the authenticated shop', ev);
            v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'REJECTED', 'error', 'event shop_id does not match the authenticated shop');
            CONTINUE;
        END IF;

        IF EXISTS (SELECT 1 FROM giga_cloud.processed_events WHERE shop_id = p_shop_id AND idempotency_key = v_key) THEN
            -- Already processed: clean up any stale rejected record and return DUPLICATE
            DELETE FROM giga_cloud.rejected_events WHERE shop_id = p_shop_id AND idempotency_key = v_key;
            v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'DUPLICATE');
            CONTINUE;
        END IF;

        BEGIN
            PERFORM giga_cloud.apply_event(p_shop_id, ev);
            INSERT INTO giga_cloud.processed_events (
                shop_id, idempotency_key, event_id, event_type, entity_type, entity_id,
                device_id, actor_user_id, actor_name, business_ref, occurred_at, payload, local_seq
            )
            VALUES (
                p_shop_id, v_key, giga_cloud.j_uuid(ev, 'event_id'), ev ->> 'event_type', ev ->> 'entity_type', ev ->> 'entity_id',
                ev ->> 'device_id', giga_cloud.j_uuid(ev, 'actor_user_id'), ev ->> 'actor_name', ev ->> 'business_ref',
                NULLIF(ev ->> 'occurred_at', '')::timestamptz, ev -> 'payload', NULLIF(ev ->> 'local_seq', '')::bigint
            );

            -- Successfully applied on retry: remove from rejected_events
            DELETE FROM giga_cloud.rejected_events WHERE shop_id = p_shop_id AND idempotency_key = v_key;

            v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'APPLIED');
            v_applied := v_applied + 1;
        EXCEPTION WHEN OTHERS THEN
            DELETE FROM giga_cloud.rejected_events WHERE shop_id = p_shop_id AND idempotency_key = v_key;
            INSERT INTO giga_cloud.rejected_events (shop_id, idempotency_key, event_type, error, payload)
            VALUES (p_shop_id, v_key, ev ->> 'event_type', SQLERRM, ev);
            v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'REJECTED', 'error', SQLERRM);
        END;
    END LOOP;

    UPDATE giga_cloud.shops
       SET last_seen_at = now(),
           last_event_at = now(),
           events_received = events_received + v_applied
     WHERE shop_id = p_shop_id;

    RETURN jsonb_build_object('applied', v_applied, 'results', v_results);
END $$;

-- 4. Check event statuses RPC for safe retry preview
CREATE OR REPLACE FUNCTION public.gc_check_event_statuses(p_shop_id UUID, p_token TEXT, p_keys TEXT[]) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    k TEXT;
    v_proc RECORD;
    v_rej RECORD;
    v_results JSONB := '[]'::jsonb;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    FOREACH k IN ARRAY p_keys LOOP
        SELECT idempotency_key, event_type, local_seq
          INTO v_proc
          FROM giga_cloud.processed_events
         WHERE shop_id = p_shop_id AND idempotency_key = k;

        IF FOUND THEN
            v_results := v_results || jsonb_build_object(
                'idempotency_key', k,
                'status', 'PROCESSED',
                'event_type', v_proc.event_type,
                'local_seq', v_proc.local_seq
            );
        ELSE
            SELECT idempotency_key, event_type, error
              INTO v_rej
              FROM giga_cloud.rejected_events
             WHERE shop_id = p_shop_id AND idempotency_key = k;

            IF FOUND THEN
                v_results := v_results || jsonb_build_object(
                    'idempotency_key', k,
                    'status', 'REJECTED',
                    'event_type', v_rej.event_type,
                    'error', v_rej.error
                );
            ELSE
                v_results := v_results || jsonb_build_object(
                    'idempotency_key', k,
                    'status', 'NOT_FOUND'
                );
            END IF;
        END IF;
    END LOOP;
    RETURN v_results;
END $$;

-- 5. Versioned Sync Protocol in gc_ping & gc_check_compatibility
CREATE OR REPLACE FUNCTION public.gc_ping(p_shop_id UUID, p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    RETURN jsonb_build_object(
        'ok', TRUE,
        'server_time', now(),
        'schema_version', 13,
        'sync_protocol_version', 2,
        'min_supported_protocol', 1,
        'max_supported_protocol', 2
    );
END $$;

CREATE OR REPLACE FUNCTION public.gc_check_compatibility(p_shop_id UUID, p_token TEXT, p_protocol_version INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_min INT := 1;
    v_max INT := 2;
    v_cloud_schema INT := 13;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_protocol_version < v_min THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'APPLICATION_TOO_OLD', 'min_supported', v_min, 'cloud_schema_version', v_cloud_schema);
    ELSIF p_protocol_version > v_max THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'CLOUD_SCHEMA_TOO_OLD', 'max_supported', v_max, 'cloud_schema_version', v_cloud_schema);
    END IF;
    RETURN jsonb_build_object('compatible', TRUE, 'protocol_version', p_protocol_version, 'cloud_schema_version', v_cloud_schema);
END $$;

GRANT EXECUTE ON FUNCTION public.gc_check_event_statuses(UUID, TEXT, TEXT[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gc_check_compatibility(UUID, TEXT, INT) TO anon, authenticated, service_role;
