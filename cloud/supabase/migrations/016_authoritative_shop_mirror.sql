-- =============================================================================
-- 016 — AUTHORITATIVE SHOP MIRROR, ZERO-DRIFT INVENTORY SNAPSHOT & FINGERPRINT
-- =============================================================================
-- Forward-only, additive, backward-compatible migration.
-- 1. Adds 'SHOP_INVENTORY_SNAPSHOT' to giga_cloud.commands allowed command types.
-- 2. Adds snapshot metadata and inventory_fingerprint to giga_cloud.shops.
-- 3. Adds public.gc_apply_inventory_snapshot() for atomic authoritative mirror updates.
-- 4. Adds public.gc_get_inventory_fingerprint() for fast zero-payload drift checks.
-- 5. Handles 'SHOP_INVENTORY_SNAPSHOT' inside giga_cloud.apply_event_core().
-- 6. Increments schema_version to 16 in gc_ping and gc_check_compatibility.
-- =============================================================================

-- 1. Commands check constraint
ALTER TABLE giga_cloud.commands DROP CONSTRAINT IF EXISTS commands_command_type_check;
ALTER TABLE giga_cloud.commands ADD CONSTRAINT commands_command_type_check CHECK (
    command_type = ANY (ARRAY[
        'PRICE_UPDATE'::text, 'MEDICINE_METADATA_UPDATE'::text, 'CATEGORY_UPSERT'::text, 'SETTINGS_UPDATE'::text,
        'STOCK_ADD'::text, 'STOCK_REMOVE'::text, 'STOCK_SET'::text, 'BATCH_EXPIRY_UPDATE'::text,
        'USER_SET_ACTIVE'::text, 'USER_ROLE_UPDATE'::text, 'APP_UPDATE_APPROVE'::text, 'USER_CREATE'::text,
        'USER_CREDENTIAL_REFRESH'::text, 'MEDICINE_CREATE'::text, 'MEDICINE_SET_ACTIVE'::text, 'BATCH_CREATE'::text,
        'BATCH_UPDATE'::text, 'BATCH_SET_ACTIVE'::text, 'SUPPLIER_CREATE'::text, 'SUPPLIER_UPDATE'::text,
        'SUPPLIER_SET_ACTIVE'::text, 'CUSTOMER_CREATE'::text, 'CUSTOMER_UPDATE'::text, 'CUSTOMER_SET_ACTIVE'::text,
        'PURCHASE_CREATE'::text, 'PURCHASE_UPDATE_DRAFT'::text, 'PURCHASE_RECEIVE'::text, 'PURCHASE_CANCEL'::text,
        'EXPENSE_CREATE'::text, 'EXPENSE_UPDATE'::text, 'EXPENSE_VOID'::text, 'RETURN_APPROVE'::text,
        'RETURN_REJECT'::text, 'SALE_VOID'::text, 'USER_SESSION_REVOKE'::text, 'SHIFT_REVIEW'::text,
        'USER_PROFILE_UPDATE'::text, 'SYNC_RETRY_FAILED'::text, 'MEDICINE_DELETE'::text,
        'STOCK_OVERRIDE_ADD'::text, 'STOCK_OVERRIDE_REMOVE'::text, 'STOCK_OVERRIDE_SET'::text, 'STOCK_SNAPSHOT_REQUEST'::text,
        'MEDICINE_DELETE_PREFLIGHT'::text, 'SHOP_INVENTORY_SNAPSHOT'::text
    ])
);

-- 2. Snapshot metadata on giga_cloud.shops
ALTER TABLE giga_cloud.shops
    ADD COLUMN IF NOT EXISTS shop_snapshot_seq BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS shop_snapshot_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS shop_snapshot_id UUID,
    ADD COLUMN IF NOT EXISTS inventory_fingerprint TEXT;

-- 3. Authoritative Snapshot Application RPC
CREATE OR REPLACE FUNCTION public.gc_apply_inventory_snapshot(p_shop_id UUID, p_token TEXT, p_snapshot JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    v_seq BIGINT;
    v_id UUID;
    v_fp TEXT;
    v_current_seq BIGINT;
    v_med_count INT := 0;
    v_batch_count INT := 0;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);

    IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
        RAISE EXCEPTION 'invalid snapshot payload' USING ERRCODE = 'PT400';
    END IF;

    v_seq := (p_snapshot ->> 'snapshot_seq')::BIGINT;
    v_id := giga_cloud.j_uuid(p_snapshot, 'snapshot_id');
    v_fp := p_snapshot ->> 'fingerprint';

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'snapshot_seq is required' USING ERRCODE = 'PT400';
    END IF;

    -- High-water mark protection: an older snapshot cannot supersede a newer snapshot
    SELECT shop_snapshot_seq INTO v_current_seq FROM giga_cloud.shops WHERE shop_id = p_shop_id;
    IF v_current_seq IS NOT NULL AND v_seq < v_current_seq THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'ignored', TRUE,
            'reason', 'OLDER_SNAPSHOT_SUPERSEDED',
            'current_snapshot_seq', v_current_seq,
            'attempted_seq', v_seq
        );
    END IF;

    -- Record authoritative snapshot state on shop
    UPDATE giga_cloud.shops
       SET shop_snapshot_seq = v_seq,
           shop_snapshot_at = now(),
           shop_snapshot_id = v_id,
           inventory_fingerprint = v_fp
     WHERE shop_id = p_shop_id;

    -- 1. Upsert medicines using native jsonb_to_recordset
    INSERT INTO giga_cloud.medicines AS t (
        shop_id, medicine_id, name, sku, barcode, purchase_price, selling_price,
        status, local_version, data, source_seq, stock_version, stock_fingerprint
    )
    SELECT 
        p_shop_id, 
        COALESCE(m.medicine_id, m.id), 
        m.name, 
        m.sku, 
        m.barcode, 
        m.purchase_price, 
        m.selling_price,
        COALESCE(m.status, 'active'), 
        COALESCE(m.version, 1), 
        COALESCE(to_jsonb(m), '{}'::jsonb),
        v_seq, 
        COALESCE(m.stock_version, 1), 
        m.stock_fingerprint
    FROM jsonb_to_recordset(COALESCE(p_snapshot -> 'medicines', '[]'::jsonb)) AS m(
        id uuid,
        medicine_id uuid,
        name text,
        sku text,
        barcode text,
        purchase_price numeric,
        selling_price numeric,
        status text,
        version int,
        stock_version int,
        stock_fingerprint text
    )
    LEFT JOIN giga_cloud.medicine_tombstones tom 
      ON tom.shop_id = p_shop_id 
     AND tom.medicine_id = COALESCE(m.medicine_id, m.id)
     AND tom.deletion_seq >= v_seq
    WHERE COALESCE(m.medicine_id, m.id) IS NOT NULL
      AND tom.medicine_id IS NULL
    ON CONFLICT (shop_id, medicine_id) DO UPDATE SET
        name = EXCLUDED.name,
        sku = COALESCE(EXCLUDED.sku, t.sku),
        barcode = COALESCE(EXCLUDED.barcode, t.barcode),
        purchase_price = COALESCE(EXCLUDED.purchase_price, t.purchase_price),
        selling_price = COALESCE(EXCLUDED.selling_price, t.selling_price),
        status = EXCLUDED.status,
        local_version = GREATEST(t.local_version, EXCLUDED.local_version),
        stock_version = GREATEST(t.stock_version, EXCLUDED.stock_version),
        stock_fingerprint = COALESCE(EXCLUDED.stock_fingerprint, t.stock_fingerprint),
        source_seq = GREATEST(t.source_seq, EXCLUDED.source_seq),
        updated_at = now();
    GET DIAGNOSTICS v_med_count = ROW_COUNT;

    -- 2. Upsert batches and stock levels using pure in-memory CTEs (no temp table)
    WITH snap_batches AS (
        SELECT 
            COALESCE(b.batch_id, b.id) AS batch_id,
            b.medicine_id,
            b.batch_number,
            NULLIF(b.expiry_date, '')::date AS expiry_date,
            COALESCE(b.status, 'active') AS status,
            COALESCE(to_jsonb(b), '{}'::jsonb) AS data,
            COALESCE(b.quantity_available, 0) AS quantity_available,
            COALESCE(b.stock_version, 1) AS stock_version
        FROM jsonb_to_recordset(COALESCE(p_snapshot -> 'batches', '[]'::jsonb)) AS b(
            id uuid,
            batch_id uuid,
            medicine_id uuid,
            batch_number text,
            expiry_date text,
            status text,
            quantity_available int,
            stock_version int
        )
        LEFT JOIN giga_cloud.medicine_tombstones tom
          ON tom.shop_id = p_shop_id 
         AND tom.medicine_id = b.medicine_id
         AND tom.deletion_seq >= v_seq
        WHERE COALESCE(b.batch_id, b.id) IS NOT NULL 
          AND b.medicine_id IS NOT NULL
          AND tom.medicine_id IS NULL
    ),
    upsert_batches AS (
        INSERT INTO giga_cloud.medicine_batches AS mb (
            shop_id, batch_id, medicine_id, batch_number, expiry_date, status, data, source_seq
        )
        SELECT 
            p_shop_id, sb.batch_id, sb.medicine_id, sb.batch_number, sb.expiry_date, sb.status, sb.data, v_seq
        FROM snap_batches sb
        ON CONFLICT (shop_id, batch_id) DO UPDATE SET
            batch_number = EXCLUDED.batch_number,
            expiry_date = COALESCE(EXCLUDED.expiry_date, mb.expiry_date),
            status = EXCLUDED.status,
            source_seq = GREATEST(mb.source_seq, EXCLUDED.source_seq),
            updated_at = now()
        RETURNING mb.batch_id
    ),
    newer_movements AS (
        SELECT batch_id, SUM(delta) AS delta
        FROM giga_cloud.inventory_movements
        WHERE shop_id = p_shop_id AND local_seq > v_seq
        GROUP BY batch_id
    )
    INSERT INTO giga_cloud.stock_levels AS s (
        shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq,
        delta_since_baseline, last_reported_quantity, reconciliation_required, reconciliation_reason,
        stock_version
    )
    SELECT 
        p_shop_id, sb.medicine_id, sb.batch_id, TRUE,
        sb.quantity_available, v_seq,
        COALESCE(nm.delta, 0),
        sb.quantity_available, FALSE, NULL,
        sb.stock_version
    FROM snap_batches sb
    LEFT JOIN newer_movements nm ON nm.batch_id = sb.batch_id
    ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
        has_baseline = TRUE,
        baseline_quantity = EXCLUDED.baseline_quantity,
        baseline_seq = EXCLUDED.baseline_seq,
        delta_since_baseline = EXCLUDED.delta_since_baseline,
        last_reported_quantity = EXCLUDED.baseline_quantity,
        reconciliation_required = FALSE,
        reconciliation_reason = NULL,
        stock_version = GREATEST(s.stock_version, EXCLUDED.stock_version);
    GET DIAGNOSTICS v_batch_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'snapshot_id', v_id,
        'snapshot_seq', v_seq,
        'fingerprint', v_fp,
        'medicines_applied', v_med_count,
        'batches_applied', v_batch_count
    );
END $$;

-- 4. Fast Fingerprint Check RPC
CREATE OR REPLACE FUNCTION public.gc_get_inventory_fingerprint(p_shop_id UUID, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE
    s_row RECORD;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);

    SELECT shop_snapshot_seq, shop_snapshot_at, shop_snapshot_id, inventory_fingerprint
      INTO s_row
      FROM giga_cloud.shops
     WHERE shop_id = p_shop_id;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'shop_id', p_shop_id,
        'fingerprint', s_row.inventory_fingerprint,
        'snapshot_seq', COALESCE(s_row.shop_snapshot_seq, 0),
        'snapshot_at', s_row.shop_snapshot_at,
        'snapshot_id', s_row.shop_snapshot_id,
        'medicines_count', (SELECT count(*)::int FROM giga_cloud.medicines WHERE shop_id = p_shop_id AND status <> 'archived'),
        'batches_count', (SELECT count(*)::int FROM giga_cloud.stock_levels WHERE shop_id = p_shop_id)
    );
END $$;

-- 5. Extend apply_event_core with SHOP_INVENTORY_SNAPSHOT support
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
            INSERT INTO giga_cloud.medicine_tombstones (shop_id, medicine_id, deleted_at, deletion_seq, deletion_event_id)
            VALUES (p_shop, v_med_id, now(), v_seq, v_event)
            ON CONFLICT (shop_id, medicine_id) DO UPDATE SET
                deletion_seq = GREATEST(medicine_tombstones.deletion_seq, EXCLUDED.deletion_seq),
                deleted_at = now();

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
        v_med_id := giga_cloud.j_uuid(d -> 'medicine', 'id');
        IF v_med_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM giga_cloud.medicine_tombstones t 
             WHERE t.shop_id = p_shop AND t.medicine_id = v_med_id AND t.deletion_seq >= v_seq
        ) THEN
            RETURN;
        END IF;

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

    WHEN 'SHOP_INVENTORY_SNAPSHOT' THEN
        -- Delegated to gc_apply_inventory_snapshot internally
        PERFORM public.gc_apply_inventory_snapshot(p_shop, 'INTERNAL_SYSTEM_CALL', d);

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

    -- Common parts of every event
    PERFORM giga_cloud.upsert_batches(p_shop, v_seq, p -> 'batches');
    PERFORM giga_cloud.apply_movements(p_shop, v_event, v_seq, p -> 'movements');
    PERFORM giga_cloud.insert_audits(p_shop, v_event, p -> 'audit');
    IF NULLIF(ev ->> 'device_id', '') IS NOT NULL THEN
        INSERT INTO giga_cloud.devices (shop_id, device_id) VALUES (p_shop, ev ->> 'device_id')
        ON CONFLICT (shop_id, device_id) DO UPDATE SET last_seen_at = now();
    END IF;
END $$;

-- 6. Schema Version 16 in gc_ping & gc_check_compatibility
CREATE OR REPLACE FUNCTION public.gc_ping(p_shop_id UUID, p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);
    RETURN jsonb_build_object(
        'ok', TRUE,
        'server_time', now(),
        'schema_version', 16,
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
    v_cloud_schema INT := 16;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_protocol_version < v_min THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'APPLICATION_TOO_OLD', 'min_supported', v_min, 'cloud_schema_version', v_cloud_schema);
    ELSIF p_protocol_version > v_max THEN
        RETURN jsonb_build_object('compatible', FALSE, 'error', 'CLOUD_SCHEMA_TOO_OLD', 'max_supported', v_max, 'cloud_schema_version', v_cloud_schema);
    END IF;
    RETURN jsonb_build_object('compatible', TRUE, 'protocol_version', p_protocol_version, 'cloud_schema_version', v_cloud_schema);
END $$;

-- 7. Public Inspection RPC for Parity & Authoritative Mirror Verification
CREATE OR REPLACE FUNCTION public.gc_inspect_shop_data(p_shop_id UUID, p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    PERFORM giga_cloud.touch_shop_contact(p_shop_id);

    RETURN jsonb_build_object(
        'medicines', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', m.medicine_id,
                'medicine_id', m.medicine_id,
                'name', m.name,
                'barcode', m.barcode,
                'sku', m.sku,
                'status', m.status,
                'version', m.local_version,
                'local_version', m.local_version,
                'stock_version', m.stock_version,
                'stock_fingerprint', m.stock_fingerprint,
                'current_stock', COALESCE((
                    SELECT SUM(CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE s.last_reported_quantity END)
                    FROM giga_cloud.stock_levels s
                    WHERE s.shop_id = p_shop_id AND s.medicine_id = m.medicine_id
                ), 0)
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
                'quantity_available', CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE s.last_reported_quantity END,
                'last_reported_quantity', s.last_reported_quantity,
                'reconciliation_required', s.reconciliation_required,
                'stock_version', s.stock_version,
                'stock_fingerprint', s.stock_fingerprint
            )), '[]'::jsonb)
            FROM giga_cloud.stock_levels s
            WHERE s.shop_id = p_shop_id
        ),
        'batches', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'batch_id', b.batch_id,
                'medicine_id', b.medicine_id,
                'batch_number', b.batch_number,
                'expiry_date', b.expiry_date,
                'status', b.status,
                'stock_version', COALESCE((b.data ->> 'stock_version')::int, 1)
            )), '[]'::jsonb)
            FROM giga_cloud.medicine_batches b
            WHERE b.shop_id = p_shop_id
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
        ),
        'tombstones', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'medicine_id', t.medicine_id,
                'deleted_at', t.deleted_at,
                'deletion_seq', t.deletion_seq
            )), '[]'::jsonb)
            FROM giga_cloud.medicine_tombstones t
            WHERE t.shop_id = p_shop_id
        )
    );
END $$;

REVOKE ALL ON FUNCTION public.gc_inspect_shop_data(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gc_inspect_shop_data(UUID, TEXT) TO anon, authenticated, service_role;

-- Grants
GRANT EXECUTE ON FUNCTION public.gc_apply_inventory_snapshot(UUID, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gc_get_inventory_fingerprint(UUID, TEXT) TO anon, authenticated, service_role;

