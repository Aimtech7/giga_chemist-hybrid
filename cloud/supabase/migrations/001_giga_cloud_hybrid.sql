-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase) SCHEMA FOR HYBRID SYNC          version 001
-- =============================================================================
-- Apply in the Supabase SQL editor (or psql) as the project owner. Re-runnable.
--
-- Purpose of the cloud: centralized multi-shop reporting + a control channel (commands) to shops.
-- It is NOT the shop's operational database: each shop's local PostgreSQL stays authoritative and
-- checkout never waits for the cloud.
--
-- Shape:
--   giga_cloud.*            private schema (no anon/authenticated access to tables)
--   public.gc_ping           \
--   public.gc_ingest_events   > the only entry points; SECURITY DEFINER; every call is
--   public.gc_pull_commands  /  authenticated by (shop_id, shop sync token)
--   public.gc_ack_command   /
--   giga_cloud.register_shop / giga_cloud.issue_command   owner-only admin helpers
--
-- Idempotency: giga_cloud.processed_events is keyed by the event idempotency_key. An event is
-- applied in the same transaction that records its key, so a retried event is a no-op
-- (DUPLICATE). Business rows additionally use ON CONFLICT DO NOTHING / sequence guards.
--
-- Stock: never a snapshot. Cloud stock per batch = baseline (optional MEDICINE_BASELINE event)
-- + SUM(delta) of the immutable inventory_movements received after that baseline.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS giga_cloud;

-- ---------------------------------------------------------------------------
-- Shops, devices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.shops (
    shop_id UUID PRIMARY KEY,
    shop_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    last_event_at TIMESTAMPTZ,
    events_received BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS giga_cloud.devices (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    device_id TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, device_id)
);

-- ---------------------------------------------------------------------------
-- Sync metadata: idempotency registry + immutable event log, rejections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.processed_events (
    idempotency_key TEXT PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    local_seq BIGINT,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    device_id TEXT,
    actor_user_id UUID,
    actor_name TEXT,
    business_ref TEXT,
    occurred_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gc_events_shop ON giga_cloud.processed_events(shop_id, local_seq);

CREATE TABLE IF NOT EXISTS giga_cloud.rejected_events (
    id BIGSERIAL PRIMARY KEY,
    shop_id UUID,
    idempotency_key TEXT,
    event_type TEXT,
    error TEXT,
    payload JSONB,
    rejected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Central catalog (managed in the cloud, pushed to shops by commands)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Per-shop reporting copies. `data` keeps the full local row; typed columns serve reporting.
-- source_seq = local outbox sequence of the last event applied to the row (newer wins).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.medicines (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    medicine_id UUID NOT NULL,
    name TEXT,
    generic_name TEXT,
    barcode TEXT,
    sku TEXT,
    category TEXT,
    status TEXT,
    selling_price NUMERIC(12,2),
    wholesale_price NUMERIC(12,2),
    min_selling_price NUMERIC(12,2),
    purchase_price NUMERIC(12,2),
    reorder_level INTEGER,
    local_version INTEGER,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, medicine_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.medicine_batches (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    batch_id UUID NOT NULL,
    medicine_id UUID NOT NULL,
    batch_number TEXT,
    expiry_date DATE,
    expiry_status TEXT,
    status TEXT,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, batch_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.inventory_movements (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    movement_id UUID NOT NULL,
    event_id UUID NOT NULL,
    local_seq BIGINT NOT NULL,
    medicine_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    movement_type TEXT,
    reason TEXT,
    delta INTEGER NOT NULL,
    previous_quantity INTEGER,
    new_quantity INTEGER,
    reference_id TEXT,
    notes TEXT,
    user_id UUID,
    device_id TEXT,
    occurred_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, movement_id)
);
CREATE INDEX IF NOT EXISTS idx_gc_movements_batch ON giga_cloud.inventory_movements(shop_id, batch_id, local_seq);

CREATE TABLE IF NOT EXISTS giga_cloud.stock_levels (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    medicine_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    has_baseline BOOLEAN NOT NULL DEFAULT FALSE,
    baseline_quantity INTEGER NOT NULL DEFAULT 0,
    baseline_seq BIGINT NOT NULL DEFAULT 0,
    delta_since_baseline BIGINT NOT NULL DEFAULT 0,
    -- new_quantity reported by the newest movement: for drift detection only, never authoritative.
    last_reported_quantity INTEGER,
    last_movement_seq BIGINT NOT NULL DEFAULT 0,
    last_movement_at TIMESTAMPTZ,
    PRIMARY KEY (shop_id, medicine_id, batch_id)
);

CREATE OR REPLACE VIEW giga_cloud.stock_on_hand AS
SELECT shop_id, medicine_id, batch_id, has_baseline,
       baseline_quantity + delta_since_baseline AS quantity,
       last_reported_quantity,
       (has_baseline AND last_reported_quantity IS NOT NULL
        AND last_reported_quantity <> baseline_quantity + delta_since_baseline) AS drift_detected,
       last_movement_at
FROM giga_cloud.stock_levels;

CREATE TABLE IF NOT EXISTS giga_cloud.sales (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    sale_id UUID NOT NULL,
    sale_number TEXT,
    receipt_number TEXT,
    business_date DATE,
    business_time TEXT,
    cashier_id UUID,
    cashier_name TEXT,
    customer_id UUID,
    device_id TEXT,
    price_mode TEXT,
    subtotal NUMERIC(12,2),
    discount_total NUMERIC(12,2),
    tax_total NUMERIC(12,2),
    total NUMERIC(12,2),
    cost_total NUMERIC(12,2),
    gross_profit NUMERIC(12,2),
    payment_method TEXT,
    status TEXT,
    void_reason TEXT,
    voided_by UUID,
    local_idempotency_key TEXT,
    created_at_local TIMESTAMPTZ,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, sale_id)
);
CREATE INDEX IF NOT EXISTS idx_gc_sales_date ON giga_cloud.sales(shop_id, business_date);

CREATE TABLE IF NOT EXISTS giga_cloud.sale_items (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    sale_item_id UUID NOT NULL,
    sale_id UUID NOT NULL,
    medicine_id UUID,
    batch_id UUID,
    batch_number TEXT,
    quantity INTEGER,
    unit_price NUMERIC(12,2),
    discount NUMERIC(12,2),
    cost_price_snapshot NUMERIC(12,2),
    total NUMERIC(12,2),
    price_mode TEXT,
    data JSONB NOT NULL,
    PRIMARY KEY (shop_id, sale_item_id)
);
CREATE INDEX IF NOT EXISTS idx_gc_sale_items_sale ON giga_cloud.sale_items(shop_id, sale_id);

CREATE TABLE IF NOT EXISTS giga_cloud.payments (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    payment_id UUID NOT NULL,
    sale_id UUID NOT NULL,
    method TEXT,
    amount NUMERIC(12,2),
    reference TEXT,
    data JSONB NOT NULL,
    PRIMARY KEY (shop_id, payment_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.returns (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    return_id UUID NOT NULL,
    sale_id UUID,
    receipt_number TEXT,
    medicine_id UUID,
    batch_id UUID,
    quantity INTEGER,
    approved_quantity INTEGER,
    requested_refund NUMERIC(12,2),
    refund_amount NUMERIC(12,2),
    restocked BOOLEAN,
    status TEXT,
    requested_by UUID,
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, return_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.purchases (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    purchase_id UUID NOT NULL,
    order_number TEXT,
    invoice_number TEXT,
    supplier_id UUID,
    received_date DATE,
    total_amount NUMERIC(12,2),
    payment_status TEXT,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    PRIMARY KEY (shop_id, purchase_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.purchase_items (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    purchase_item_id UUID NOT NULL,
    purchase_id UUID NOT NULL,
    medicine_id UUID,
    batch_number TEXT,
    quantity INTEGER,
    purchase_price NUMERIC(12,2),
    total NUMERIC(12,2),
    data JSONB NOT NULL,
    PRIMARY KEY (shop_id, purchase_item_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.expenses (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    expense_id UUID NOT NULL,
    category TEXT,
    description TEXT,
    amount NUMERIC(12,2),
    payment_method TEXT,
    expense_date DATE,
    user_id UUID,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    PRIMARY KEY (shop_id, expense_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.suppliers (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    supplier_id UUID NOT NULL,
    name TEXT,
    status TEXT,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.customers (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    customer_id UUID NOT NULL,
    name TEXT,
    phone TEXT,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, customer_id)
);

-- Public profile only. Password / PIN hashes never leave the shop.
CREATE TABLE IF NOT EXISTS giga_cloud.users (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    user_id UUID NOT NULL,
    name TEXT,
    email TEXT,
    username TEXT,
    role TEXT,
    active BOOLEAN,
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, user_id)
);

CREATE TABLE IF NOT EXISTS giga_cloud.shop_settings (
    shop_id UUID PRIMARY KEY REFERENCES giga_cloud.shops(shop_id),
    data JSONB NOT NULL,
    source_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS giga_cloud.audit_events (
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    audit_id UUID NOT NULL,
    event_id UUID NOT NULL,
    action TEXT,
    entity TEXT,
    entity_id TEXT,
    user_id UUID,
    user_name TEXT,
    role TEXT,
    device_id TEXT,
    previous_value JSONB,
    new_value JSONB,
    occurred_at TIMESTAMPTZ,
    PRIMARY KEY (shop_id, audit_id)
);

-- ---------------------------------------------------------------------------
-- Cloud -> shop commands (durable; delivered until acknowledged; applied once by the shop)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giga_cloud.commands (
    command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES giga_cloud.shops(shop_id),
    command_type TEXT NOT NULL CHECK (command_type IN ('PRICE_UPDATE', 'MEDICINE_METADATA_UPDATE', 'CATEGORY_UPSERT', 'SETTINGS_UPDATE')),
    payload JSONB NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'APPLIED', 'REJECTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    delivered_at TIMESTAMPTZ,
    delivery_count INTEGER NOT NULL DEFAULT 0,
    acked_at TIMESTAMPTZ,
    result JSONB,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_gc_commands_open ON giga_cloud.commands(shop_id, created_at) WHERE status IN ('PENDING', 'DELIVERED');

-- =============================================================================
-- Helpers
-- =============================================================================
CREATE OR REPLACE FUNCTION giga_cloud.token_hash(p_token TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

CREATE OR REPLACE FUNCTION giga_cloud.authenticate_shop(p_shop_id UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_hash TEXT;
    v_active BOOLEAN;
BEGIN
    IF p_shop_id IS NULL OR p_token IS NULL OR length(p_token) < 32 THEN
        RAISE EXCEPTION 'shop authentication failed' USING ERRCODE = 'PT403';
    END IF;
    SELECT token_hash, active INTO v_hash, v_active FROM giga_cloud.shops WHERE shop_id = p_shop_id;
    IF NOT FOUND OR NOT v_active OR v_hash <> giga_cloud.token_hash(p_token) THEN
        RAISE EXCEPTION 'shop authentication failed (unknown, inactive or wrong token)' USING ERRCODE = 'PT403';
    END IF;
    UPDATE giga_cloud.shops SET last_seen_at = now() WHERE shop_id = p_shop_id;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.j_uuid(v JSONB, k TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(v ->> k, '')::uuid $$;
CREATE OR REPLACE FUNCTION giga_cloud.j_num(v JSONB, k TEXT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(v ->> k, '')::numeric $$;
CREATE OR REPLACE FUNCTION giga_cloud.j_int(v JSONB, k TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(v ->> k, '')::numeric::integer $$;

CREATE OR REPLACE FUNCTION giga_cloud.require_row(v JSONB, what TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF v IS NULL OR jsonb_typeof(v) <> 'object' OR NULLIF(v ->> 'id', '') IS NULL THEN
        RAISE EXCEPTION 'payload is missing %', what;
    END IF;
    RETURN v;
END $$;

-- Stock ledger: insert each movement once; only a newly inserted movement changes stock.
CREATE OR REPLACE FUNCTION giga_cloud.apply_movements(p_shop UUID, p_event UUID, p_seq BIGINT, p_movs JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    m JSONB;
    n INTEGER;
BEGIN
    FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(p_movs, '[]'::jsonb)) LOOP
        INSERT INTO giga_cloud.inventory_movements (
            shop_id, movement_id, event_id, local_seq, medicine_id, batch_id, movement_type, reason, delta,
            previous_quantity, new_quantity, reference_id, notes, user_id, device_id, occurred_at)
        VALUES (
            p_shop, giga_cloud.j_uuid(m, 'id'), p_event, p_seq, giga_cloud.j_uuid(m, 'medicine_id'),
            giga_cloud.j_uuid(m, 'batch_id'), m ->> 'movement_type', m ->> 'reason', giga_cloud.j_int(m, 'delta'),
            giga_cloud.j_int(m, 'previous_quantity'), giga_cloud.j_int(m, 'new_quantity'), m ->> 'reference_id',
            m ->> 'notes', giga_cloud.j_uuid(m, 'user_id'), m ->> 'device_id', NULLIF(m ->> 'occurred_at', '')::timestamptz)
        ON CONFLICT (shop_id, movement_id) DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n = 1 THEN
            INSERT INTO giga_cloud.stock_levels AS s (
                shop_id, medicine_id, batch_id, delta_since_baseline, last_reported_quantity, last_movement_seq, last_movement_at)
            VALUES (
                p_shop, giga_cloud.j_uuid(m, 'medicine_id'), giga_cloud.j_uuid(m, 'batch_id'), giga_cloud.j_int(m, 'delta'),
                giga_cloud.j_int(m, 'new_quantity'), p_seq, NULLIF(m ->> 'occurred_at', '')::timestamptz)
            ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
                delta_since_baseline = s.delta_since_baseline
                    + CASE WHEN p_seq > s.baseline_seq THEN EXCLUDED.delta_since_baseline ELSE 0 END,
                last_reported_quantity = CASE WHEN p_seq >= s.last_movement_seq THEN EXCLUDED.last_reported_quantity ELSE s.last_reported_quantity END,
                last_movement_at = CASE WHEN p_seq >= s.last_movement_seq THEN EXCLUDED.last_movement_at ELSE s.last_movement_at END,
                last_movement_seq = GREATEST(s.last_movement_seq, p_seq);
        END IF;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.upsert_batches(p_shop UUID, p_seq BIGINT, p_batches JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE b JSONB;
BEGIN
    FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_batches, '[]'::jsonb)) LOOP
        INSERT INTO giga_cloud.medicine_batches AS t (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq)
        VALUES (p_shop, giga_cloud.j_uuid(b, 'id'), giga_cloud.j_uuid(b, 'medicine_id'), b ->> 'batch_number',
                NULLIF(b ->> 'expiry_date', '')::date, b ->> 'expiry_status', b ->> 'status', b - 'quantity_available' - 'quantity_received', p_seq)
        ON CONFLICT (shop_id, batch_id) DO UPDATE SET
            batch_number = EXCLUDED.batch_number, expiry_date = EXCLUDED.expiry_date, expiry_status = EXCLUDED.expiry_status,
            status = EXCLUDED.status, data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
        WHERE t.source_seq < EXCLUDED.source_seq;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.insert_audits(p_shop UUID, p_event UUID, p_audits JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE a JSONB;
BEGIN
    FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(p_audits, '[]'::jsonb)) LOOP
        INSERT INTO giga_cloud.audit_events (shop_id, audit_id, event_id, action, entity, entity_id, user_id, user_name, role,
                                             device_id, previous_value, new_value, occurred_at)
        VALUES (p_shop, giga_cloud.j_uuid(a, 'id'), p_event, a ->> 'action', a ->> 'entity', a ->> 'entity_id',
                giga_cloud.j_uuid(a, 'user_id'), a ->> 'user_name', a ->> 'role', a ->> 'device_id',
                a -> 'previous_value', a -> 'new_value', NULLIF(a ->> 'occurred_at', '')::timestamptz)
        ON CONFLICT (shop_id, audit_id) DO NOTHING;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.upsert_sale(p_shop UUID, p_seq BIGINT, s JSONB, p_cashier_name TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    s := giga_cloud.require_row(s, 'sale');
    INSERT INTO giga_cloud.sales AS t (
        shop_id, sale_id, sale_number, receipt_number, business_date, business_time, cashier_id, cashier_name, customer_id,
        device_id, price_mode, subtotal, discount_total, tax_total, total, cost_total, gross_profit, payment_method, status,
        void_reason, voided_by, local_idempotency_key, created_at_local, data, source_seq)
    VALUES (
        p_shop, giga_cloud.j_uuid(s, 'id'), s ->> 'sale_number', s ->> 'receipt_number', NULLIF(s ->> 'date', '')::date,
        s ->> 'time', giga_cloud.j_uuid(s, 'cashier_id'), p_cashier_name, giga_cloud.j_uuid(s, 'customer_id'), s ->> 'device_id',
        s ->> 'price_mode', giga_cloud.j_num(s, 'subtotal'), giga_cloud.j_num(s, 'discount_total'), giga_cloud.j_num(s, 'tax_total'),
        giga_cloud.j_num(s, 'total'), giga_cloud.j_num(s, 'cost_total'), giga_cloud.j_num(s, 'gross_profit'),
        s ->> 'payment_method', s ->> 'status', s ->> 'void_reason', giga_cloud.j_uuid(s, 'voided_by'),
        s ->> 'idempotency_key', NULLIF(s ->> 'created_at', '')::timestamptz, s, p_seq)
    -- A completed sale is immutable; later events (void / return) may only change its status fields.
    ON CONFLICT (shop_id, sale_id) DO UPDATE SET
        status = EXCLUDED.status, void_reason = EXCLUDED.void_reason, voided_by = EXCLUDED.voided_by,
        data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now(),
        cashier_name = COALESCE(t.cashier_name, EXCLUDED.cashier_name)
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.upsert_customer(p_shop UUID, p_seq BIGINT, c JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF c IS NULL OR jsonb_typeof(c) <> 'object' THEN RETURN; END IF;
    c := giga_cloud.require_row(c, 'customer');
    INSERT INTO giga_cloud.customers AS t (shop_id, customer_id, name, phone, data, source_seq)
    VALUES (p_shop, giga_cloud.j_uuid(c, 'id'), c ->> 'name', c ->> 'phone', c, p_seq)
    ON CONFLICT (shop_id, customer_id) DO UPDATE SET
        name = EXCLUDED.name, phone = EXCLUDED.phone, data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.upsert_supplier(p_shop UUID, p_seq BIGINT, v JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN; END IF;
    v := giga_cloud.require_row(v, 'supplier');
    INSERT INTO giga_cloud.suppliers AS t (shop_id, supplier_id, name, status, data, source_seq)
    VALUES (p_shop, giga_cloud.j_uuid(v, 'id'), v ->> 'name', v ->> 'status', v, p_seq)
    ON CONFLICT (shop_id, supplier_id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status, data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

CREATE OR REPLACE FUNCTION giga_cloud.upsert_medicine(p_shop UUID, p_seq BIGINT, v JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    v := giga_cloud.require_row(v, 'medicine');
    v := v - 'current_stock';  -- never a stock snapshot
    INSERT INTO giga_cloud.medicines AS t (shop_id, medicine_id, name, generic_name, barcode, sku, category, status, selling_price,
                                           wholesale_price, min_selling_price, purchase_price, reorder_level, local_version, data, source_seq)
    VALUES (p_shop, giga_cloud.j_uuid(v, 'id'), v ->> 'name', v ->> 'generic_name', v ->> 'barcode', v ->> 'sku', v ->> 'category',
            v ->> 'status', giga_cloud.j_num(v, 'selling_price'), giga_cloud.j_num(v, 'wholesale_price'),
            giga_cloud.j_num(v, 'min_selling_price'), giga_cloud.j_num(v, 'purchase_price'), giga_cloud.j_int(v, 'reorder_level'),
            giga_cloud.j_int(v, 'version'), v, p_seq)
    ON CONFLICT (shop_id, medicine_id) DO UPDATE SET
        name = EXCLUDED.name, generic_name = EXCLUDED.generic_name, barcode = EXCLUDED.barcode, sku = EXCLUDED.sku,
        category = EXCLUDED.category, status = EXCLUDED.status, selling_price = EXCLUDED.selling_price,
        wholesale_price = EXCLUDED.wholesale_price, min_selling_price = EXCLUDED.min_selling_price,
        purchase_price = EXCLUDED.purchase_price, reorder_level = EXCLUDED.reorder_level, local_version = EXCLUDED.local_version,
        data = EXCLUDED.data, source_seq = EXCLUDED.source_seq, updated_at = now()
    WHERE t.source_seq < EXCLUDED.source_seq;
END $$;

-- Applies one event's business effect. Raises on invalid input (the caller records a rejection).
CREATE OR REPLACE FUNCTION giga_cloud.apply_event(p_shop UUID, ev JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_type TEXT := ev ->> 'event_type';
    v_event UUID := giga_cloud.j_uuid(ev, 'event_id');
    v_seq BIGINT := NULLIF(ev ->> 'local_seq', '')::bigint;
    p JSONB := COALESCE(ev -> 'payload', '{}'::jsonb);
    d JSONB := COALESCE(ev -> 'payload' -> 'data', '{}'::jsonb);
    r JSONB;
    b JSONB;
    v_cur BIGINT;
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
    WHEN 'MEDICINE_BASELINE' THEN
        -- Starting point for cloud stock: quantities captured under the medicine row lock at local seq v_seq.
        PERFORM giga_cloud.upsert_medicine(p_shop, v_seq, d -> 'medicine');
        PERFORM giga_cloud.upsert_batches(p_shop, v_seq, d -> 'batches');
        FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(d -> 'batches', '[]'::jsonb)) LOOP
            INSERT INTO giga_cloud.stock_levels AS s (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, baseline_seq, delta_since_baseline)
            VALUES (p_shop, giga_cloud.j_uuid(b, 'medicine_id'), giga_cloud.j_uuid(b, 'id'), TRUE, giga_cloud.j_int(b, 'quantity_available'), v_seq,
                    COALESCE((SELECT SUM(delta) FROM giga_cloud.inventory_movements im
                              WHERE im.shop_id = p_shop AND im.batch_id = giga_cloud.j_uuid(b, 'id') AND im.local_seq > v_seq), 0))
            ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE SET
                has_baseline = TRUE, baseline_quantity = EXCLUDED.baseline_quantity, baseline_seq = EXCLUDED.baseline_seq,
                delta_since_baseline = EXCLUDED.delta_since_baseline
            WHERE s.baseline_seq < EXCLUDED.baseline_seq;
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

-- =============================================================================
-- RPC entry points (PostgREST: POST /rest/v1/rpc/<name>)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.gc_ping(p_shop_id UUID, p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    RETURN jsonb_build_object('ok', TRUE, 'server_time', now(), 'schema_version', 1);
END $$;

-- Applies a batch of shop events. Per event: APPLIED, DUPLICATE (already processed) or REJECTED
-- (invalid; recorded in rejected_events). One bad event never blocks the others.
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
    IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
        RAISE EXCEPTION 'p_events must be a JSON array' USING ERRCODE = 'PT400';
    END IF;
    IF jsonb_array_length(p_events) > 200 THEN
        RAISE EXCEPTION 'at most 200 events per call' USING ERRCODE = 'PT413';
    END IF;

    FOR ev IN SELECT * FROM jsonb_array_elements(p_events) LOOP
        v_key := ev ->> 'idempotency_key';
        BEGIN
            IF v_key IS NULL OR length(v_key) < 8 THEN RAISE EXCEPTION 'idempotency_key is required'; END IF;
            IF giga_cloud.j_uuid(ev, 'shop_id') IS DISTINCT FROM p_shop_id THEN
                RAISE EXCEPTION 'event shop_id does not match the authenticated shop';
            END IF;
            -- Registering the key first makes a concurrent retry of the same event wait, then see DUPLICATE.
            INSERT INTO giga_cloud.processed_events (idempotency_key, event_id, shop_id, local_seq, event_type, entity_type, entity_id,
                                                     device_id, actor_user_id, actor_name, business_ref, occurred_at, payload)
            VALUES (v_key, giga_cloud.j_uuid(ev, 'event_id'), p_shop_id, NULLIF(ev ->> 'local_seq', '')::bigint, ev ->> 'event_type',
                    ev ->> 'entity_type', ev ->> 'entity_id', ev ->> 'device_id', giga_cloud.j_uuid(ev, 'actor_user_id'),
                    ev ->> 'actor_name', ev ->> 'business_ref', NULLIF(ev ->> 'occurred_at', '')::timestamptz, ev -> 'payload')
            ON CONFLICT (idempotency_key) DO NOTHING;
            GET DIAGNOSTICS n = ROW_COUNT;
            IF n = 0 THEN
                v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'DUPLICATE');
            ELSE
                PERFORM giga_cloud.apply_event(p_shop_id, ev);
                v_applied := v_applied + 1;
                v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'APPLIED');
            END IF;
        EXCEPTION WHEN OTHERS THEN
            INSERT INTO giga_cloud.rejected_events (shop_id, idempotency_key, event_type, error, payload)
            VALUES (p_shop_id, v_key, ev ->> 'event_type', SQLERRM, ev);
            v_results := v_results || jsonb_build_object('idempotency_key', v_key, 'status', 'REJECTED', 'error', SQLERRM);
        END;
    END LOOP;

    UPDATE giga_cloud.shops SET last_event_at = now(), events_received = events_received + v_applied WHERE shop_id = p_shop_id;
    RETURN jsonb_build_object('results', v_results, 'server_time', now());
END $$;

-- Returns the shop's open commands (oldest first). A command stays open until acknowledged,
-- so a lost acknowledgement means re-delivery; the shop applies each command once.
CREATE OR REPLACE FUNCTION public.gc_pull_commands(p_shop_id UUID, p_token TEXT, p_limit INTEGER DEFAULT 20) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE v JSONB;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    WITH picked AS (
        SELECT command_id FROM giga_cloud.commands
        WHERE shop_id = p_shop_id AND status IN ('PENDING', 'DELIVERED')
        ORDER BY created_at, command_id
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
        FOR UPDATE SKIP LOCKED
    ), upd AS (
        UPDATE giga_cloud.commands c
        SET status = 'DELIVERED', delivered_at = now(), delivery_count = delivery_count + 1
        FROM picked WHERE c.command_id = picked.command_id
        RETURNING c.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'command_id', command_id, 'shop_id', shop_id, 'command_type', command_type, 'payload', payload,
        'idempotency_key', idempotency_key, 'created_at', created_at, 'created_by', created_by,
        'delivery_count', delivery_count) ORDER BY created_at, command_id), '[]'::jsonb)
    INTO v FROM upd;
    RETURN jsonb_build_object('commands', v, 'server_time', now());
END $$;

CREATE OR REPLACE FUNCTION public.gc_ack_command(p_shop_id UUID, p_token TEXT, p_command_id UUID, p_status TEXT,
                                                 p_result JSONB DEFAULT NULL, p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = giga_cloud, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
    PERFORM giga_cloud.authenticate_shop(p_shop_id, p_token);
    IF p_status NOT IN ('APPLIED', 'REJECTED') THEN
        RAISE EXCEPTION 'p_status must be APPLIED or REJECTED' USING ERRCODE = 'PT400';
    END IF;
    SELECT status INTO v_status FROM giga_cloud.commands WHERE command_id = p_command_id AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown command for this shop' USING ERRCODE = 'PT404';
    END IF;
    IF v_status IN ('PENDING', 'DELIVERED') THEN
        UPDATE giga_cloud.commands SET status = p_status, acked_at = now(), result = p_result, error = left(p_error, 2000)
        WHERE command_id = p_command_id;
    END IF;
    -- Acknowledging an already-final command is a no-op (idempotent).
    RETURN jsonb_build_object('ok', TRUE, 'status', COALESCE(CASE WHEN v_status IN ('PENDING', 'DELIVERED') THEN p_status END, v_status));
END $$;

-- =============================================================================
-- Owner-only administration helpers (run from the SQL editor; NOT exposed to API keys)
-- =============================================================================
-- Registers (or re-keys) a shop. Keep the token secret; put it in that shop's .env as SYNC_SHOP_TOKEN.
CREATE OR REPLACE FUNCTION giga_cloud.register_shop(p_shop_id UUID, p_code TEXT, p_name TEXT, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF p_token IS NULL OR length(p_token) < 32 THEN RAISE EXCEPTION 'token must be at least 32 characters'; END IF;
    INSERT INTO giga_cloud.shops (shop_id, shop_code, name, token_hash)
    VALUES (p_shop_id, p_code, p_name, giga_cloud.token_hash(p_token))
    ON CONFLICT (shop_id) DO UPDATE SET shop_code = EXCLUDED.shop_code, name = EXCLUDED.name, token_hash = EXCLUDED.token_hash, active = TRUE;
END $$;

-- Queues a command for one shop. Re-issuing with the same idempotency key returns the original.
CREATE OR REPLACE FUNCTION giga_cloud.issue_command(p_shop_id UUID, p_type TEXT, p_payload JSONB, p_idempotency_key TEXT,
                                                    p_created_by TEXT DEFAULT NULL) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
    INSERT INTO giga_cloud.commands (shop_id, command_type, payload, idempotency_key, created_by)
    VALUES (p_shop_id, p_type, p_payload, p_idempotency_key, p_created_by)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING command_id INTO v_id;
    IF v_id IS NULL THEN SELECT command_id INTO v_id FROM giga_cloud.commands WHERE idempotency_key = p_idempotency_key; END IF;
    RETURN v_id;
END $$;

-- =============================================================================
-- Privileges: tables and helpers are private; only the four gc_* RPCs are callable by API keys,
-- and each of them authenticates the shop token itself.
-- =============================================================================
REVOKE ALL ON SCHEMA giga_cloud FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA giga_cloud FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA giga_cloud FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_ping(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_ingest_events(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_pull_commands(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gc_ack_command(UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC;

DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA giga_cloud FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA giga_cloud FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA giga_cloud FROM %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_ping(UUID, TEXT) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_ingest_events(UUID, TEXT, JSONB) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_pull_commands(UUID, TEXT, INTEGER) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.gc_ack_command(UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO %I', r);
        END IF;
    END LOOP;
END $$;
