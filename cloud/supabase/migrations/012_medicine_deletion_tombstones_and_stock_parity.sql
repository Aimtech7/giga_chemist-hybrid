-- =============================================================================
-- 012 — MEDICINE DELETION TOMBSTONES, RESURRECTION BLOCK & CONTINUOUS STOCK PARITY
-- =============================================================================

-- 1. Medicine tombstones table in cloud: prevents resurrection of deleted medicines
CREATE TABLE IF NOT EXISTS giga_cloud.medicine_tombstones (
    shop_id UUID NOT NULL,
    medicine_id UUID NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deletion_seq BIGINT NOT NULL,
    deletion_event_id UUID,
    PRIMARY KEY (shop_id, medicine_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_medicine_tombstones_seq 
    ON giga_cloud.medicine_tombstones(shop_id, deletion_seq);

-- 2. Stock versioning & fingerprinting columns on stock_levels & medicines
ALTER TABLE giga_cloud.stock_levels
    ADD COLUMN IF NOT EXISTS stock_version BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS stock_fingerprint TEXT;

ALTER TABLE giga_cloud.medicines
    ADD COLUMN IF NOT EXISTS stock_version BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS stock_fingerprint TEXT;

-- 3. Tombstone-aware upsert_medicine helper
CREATE OR REPLACE FUNCTION giga_cloud.upsert_medicine(p_shop UUID, p_seq BIGINT, v JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_id UUID := giga_cloud.j_uuid(v, 'id');
BEGIN
    IF v_id IS NULL THEN RETURN; END IF;

    -- Tombstone protection: if medicine was deleted at or after this seq, DO NOT resurrect
    IF EXISTS (
        SELECT 1 FROM giga_cloud.medicine_tombstones t 
         WHERE t.shop_id = p_shop AND t.medicine_id = v_id AND t.deletion_seq >= p_seq
    ) THEN
        RETURN;
    END IF;

    INSERT INTO giga_cloud.medicines AS t (
        shop_id, medicine_id, name, sku, barcode, category, purchase_price, selling_price,
        wholesale_price, min_selling_price, reorder_level, status, local_version, data, source_seq,
        stock_version, stock_fingerprint
    ) VALUES (
        p_shop, v_id, v ->> 'name', v ->> 'sku', v ->> 'barcode', v ->> 'category',
        giga_cloud.j_num(v, 'purchase_price'), giga_cloud.j_num(v, 'selling_price'),
        giga_cloud.j_num(v, 'wholesale_price'), giga_cloud.j_num(v, 'min_selling_price'),
        giga_cloud.j_int(v, 'reorder_level'), COALESCE(v ->> 'status', 'active'),
        giga_cloud.j_int(v, 'version'), v, p_seq,
        COALESCE(giga_cloud.j_int(v, 'stock_version'), 1), v ->> 'stock_fingerprint'
    )
    ON CONFLICT (shop_id, medicine_id) DO UPDATE SET
        name = EXCLUDED.name, sku = EXCLUDED.sku, barcode = EXCLUDED.barcode, category = EXCLUDED.category,
        purchase_price = EXCLUDED.purchase_price, selling_price = EXCLUDED.selling_price,
        wholesale_price = EXCLUDED.wholesale_price, min_selling_price = EXCLUDED.min_selling_price,
        reorder_level = EXCLUDED.reorder_level, status = EXCLUDED.status, local_version = EXCLUDED.local_version,
        data = EXCLUDED.data, source_seq = EXCLUDED.source_seq,
        stock_version = GREATEST(t.stock_version, EXCLUDED.stock_version),
        stock_fingerprint = COALESCE(EXCLUDED.stock_fingerprint, t.stock_fingerprint),
        updated_at = now()
    WHERE t.source_seq <= EXCLUDED.source_seq;
END $$;

-- 4. Enhanced apply_event_core handling MEDICINE_DELETED, MEDICINE_ARCHIVED & STOCK_RECONCILIATION_BASELINE
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
                r ->> 'payment_method', NULLIF(r ->> 'date', '')::date, giga_cloud.j_num(r, 'user_id'), r, v_seq)
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

-- 5. Enhanced inspection RPC returning stock_version & fingerprint
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
                'status', m.status,
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
                'last_reported_quantity', s.last_reported_quantity,
                'reconciliation_required', s.reconciliation_required,
                'stock_version', s.stock_version,
                'stock_fingerprint', s.stock_fingerprint
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

GRANT EXECUTE ON FUNCTION giga_cloud.gc_inspect_shop_data(UUID, TEXT) TO anon, authenticated, service_role;

-- 6. Add MEDICINE_DELETE to giga_cloud.commands allowed command types
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
        'USER_PROFILE_UPDATE'::text, 'SYNC_RETRY_FAILED'::text, 'MEDICINE_DELETE'::text
    ])
);
