-- =============================================================================
-- GIGA CHEMIST — CLOUD (Supabase) SCHEMA FOR THE ONLINE (VERCEL) API      version 002
-- =============================================================================
-- Apply after 001 in the Supabase SQL editor. Re-runnable. Adds:
--   giga_cloud.online_users   accounts for the online (Vercel) app — separate from the shop's
--                             staff accounts, whose password/PIN hashes never leave the shop
--   giga_online.*             READ-ONLY views presenting one shop's synced cloud data under the
--                             local table/column names, so the online API runs the SAME report and
--                             Sales History SQL as the shop server. The shop is chosen per request
--                             with SET LOCAL giga.shop_id = '<uuid>'; unset = no rows.
-- The online API is read-only: selling and stock changes happen only on the shop's local server
-- (local PostgreSQL is authoritative), never against the cloud copy.
-- =============================================================================

CREATE TABLE IF NOT EXISTS giga_cloud.online_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
    password_hash TEXT NOT NULL,
    -- NULL = may read every registered shop; otherwise only this shop
    shop_id UUID REFERENCES giga_cloud.shops(shop_id),
    -- optional link to the shop staff account (Cashier: "own sales" scope online)
    local_user_id UUID,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- Owner-only helper (SQL editor / scripts/online/create-online-user.ts). The hash is produced by the
-- application's own credential hashing (scrypt), never stored in clear.
CREATE OR REPLACE FUNCTION giga_cloud.upsert_online_user(p_email TEXT, p_name TEXT, p_role TEXT, p_password_hash TEXT,
                                                         p_shop_id UUID DEFAULT NULL, p_local_user_id UUID DEFAULT NULL) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
    IF p_password_hash IS NULL OR length(p_password_hash) < 40 THEN RAISE EXCEPTION 'password hash looks invalid'; END IF;
    INSERT INTO giga_cloud.online_users (email, name, role, password_hash, shop_id, local_user_id)
    VALUES (lower(trim(p_email)), p_name, p_role, p_password_hash, p_shop_id, p_local_user_id)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
        shop_id = EXCLUDED.shop_id, local_user_id = EXCLUDED.local_user_id, active = TRUE, updated_at = now()
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE SCHEMA IF NOT EXISTS giga_online;

CREATE OR REPLACE FUNCTION giga_online.current_shop() RETURNS UUID
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('giga.shop_id', true), '')::uuid $$;

-- Stock per batch from the cloud ledger: baseline + deltas when a baseline exists, otherwise the
-- quantity the shop reported with its latest movement (reporting only; never written back).
CREATE OR REPLACE VIEW giga_online.batch_stock AS
SELECT s.medicine_id, s.batch_id,
       CASE WHEN s.has_baseline THEN s.baseline_quantity + s.delta_since_baseline ELSE COALESCE(s.last_reported_quantity, 0) END::int AS quantity
FROM giga_cloud.stock_levels s WHERE s.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.medicines AS
SELECT m.medicine_id AS id, (m.data->>'branch_id')::uuid AS branch_id, m.name, m.data->>'generic_name' AS generic_name,
       m.data->>'brand_name' AS brand_name, m.sku, m.barcode, (m.data->>'category_id')::uuid AS category_id,
       m.data->>'medicine_type' AS medicine_type, m.data->>'dosage_strength' AS dosage_strength, m.data->>'dosage_form' AS dosage_form,
       m.data->>'manufacturer' AS manufacturer, m.data->>'description' AS description,
       m.purchase_price, m.selling_price, m.wholesale_price, m.min_selling_price,
       COALESCE((SELECT SUM(bs.quantity) FROM giga_online.batch_stock bs WHERE bs.medicine_id = m.medicine_id), 0)::int AS current_stock,
       m.reorder_level, m.data->>'unit' AS unit, (m.data->>'prescription_required')::boolean AS prescription_required,
       m.status, m.local_version AS version, (m.data->>'created_by')::uuid AS created_by, (m.data->>'updated_by')::uuid AS updated_by,
       (m.data->>'created_at')::timestamptz AS created_at, (m.data->>'updated_at')::timestamptz AS updated_at
FROM giga_cloud.medicines m WHERE m.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.categories AS
SELECT DISTINCT ON ((m.data->>'category_id')::uuid) (m.data->>'category_id')::uuid AS id, m.category AS name,
       NULL::text AS description, NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at
FROM giga_cloud.medicines m
WHERE m.shop_id = giga_online.current_shop() AND m.data->>'category_id' IS NOT NULL AND m.category IS NOT NULL;

CREATE OR REPLACE VIEW giga_online.medicine_batches AS
SELECT b.batch_id AS id, (b.data->>'branch_id')::uuid AS branch_id, b.medicine_id, b.batch_number, (b.data->>'supplier_id')::uuid AS supplier_id,
       NULL::int AS quantity_received, COALESCE(bs.quantity, 0) AS quantity_available,
       (b.data->>'purchase_price')::numeric AS purchase_price, (b.data->>'selling_price_override')::numeric AS selling_price_override,
       (b.data->>'manufacturing_date')::date AS manufacturing_date, b.expiry_date, (b.data->>'received_date')::date AS received_date,
       b.data->>'purchase_invoice' AS purchase_invoice, b.expiry_status, b.status, b.updated_at AS created_at, b.updated_at
FROM giga_cloud.medicine_batches b
LEFT JOIN giga_online.batch_stock bs ON bs.batch_id = b.batch_id
WHERE b.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.sales AS
SELECT s.sale_id AS id, (s.data->>'branch_id')::uuid AS branch_id, s.sale_number, s.receipt_number, s.cashier_id, s.customer_id, s.device_id,
       s.business_date AS date, s.business_time AS time, s.subtotal, (s.data->>'discount_percent')::numeric AS discount_percent,
       s.discount_total, s.tax_total, s.total, s.cost_total, s.gross_profit, s.payment_method, s.data->>'payment_reference' AS payment_reference,
       (s.data->>'amount_received')::numeric AS amount_received, (s.data->>'change_given')::numeric AS change_given,
       s.status, s.void_reason, s.voided_by, s.local_idempotency_key AS idempotency_key, s.price_mode, s.created_at_local AS created_at
FROM giga_cloud.sales s WHERE s.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.sale_items AS
SELECT i.sale_item_id AS id, i.sale_id, i.medicine_id, i.batch_id, i.batch_number, (i.data->>'expiry_date')::date AS expiry_date,
       i.quantity, i.unit_price, i.discount, i.cost_price_snapshot, i.total, i.price_mode, (i.data->>'created_at')::timestamptz AS created_at
FROM giga_cloud.sale_items i WHERE i.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.payments AS
SELECT p.payment_id AS id, p.sale_id, p.method, p.amount, p.reference, (p.data->>'created_at')::timestamptz AS created_at
FROM giga_cloud.payments p WHERE p.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.returns AS
SELECT r.return_id AS id, (r.data->>'branch_id')::uuid AS branch_id, r.sale_id, r.receipt_number, r.medicine_id, r.batch_id, r.quantity,
       (r.data->>'unit_price')::numeric AS unit_price, r.refund_amount, r.requested_refund, r.approved_quantity, r.restocked,
       r.data->>'reason' AS reason, r.data->>'action' AS action, r.status, r.requested_by AS user_id, r.data->>'device_id' AS device_id,
       (r.data->>'created_at')::timestamptz AS created_at, r.reviewed_by, r.reviewed_at, r.data->>'review_notes' AS review_notes
FROM giga_cloud.returns r WHERE r.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.customers AS
SELECT c.customer_id AS id, (c.data->>'branch_id')::uuid AS branch_id, c.name, c.phone, c.data->>'email' AS email, c.data->>'address' AS address,
       c.data->>'notes' AS notes, (c.data->>'credit_balance')::numeric AS credit_balance, (c.data->>'total_spent')::numeric AS total_spent,
       (c.data->>'last_visit')::timestamptz AS last_visit, (c.data->>'created_at')::timestamptz AS created_at, c.updated_at
FROM giga_cloud.customers c WHERE c.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.suppliers AS
SELECT s.supplier_id AS id, s.name, s.data->>'contact_person' AS contact_person, s.data->>'phone' AS phone, s.data->>'email' AS email,
       s.data->>'address' AS address, s.data->>'tax_pin' AS tax_pin, (s.data->>'balance')::numeric AS balance, s.status,
       (s.data->>'created_at')::timestamptz AS created_at, s.updated_at
FROM giga_cloud.suppliers s WHERE s.shop_id = giga_online.current_shop();

-- Staff names for reports: synced profiles, plus cashier names carried on synced sales.
CREATE OR REPLACE VIEW giga_online.users AS
SELECT u.user_id AS id, u.name, u.email, u.username, u.role, u.active
FROM giga_cloud.users u WHERE u.shop_id = giga_online.current_shop()
UNION ALL
(SELECT DISTINCT ON (s.cashier_id) s.cashier_id, s.cashier_name, NULL::text, NULL::text, NULL::text, NULL::boolean
 FROM giga_cloud.sales s
 WHERE s.shop_id = giga_online.current_shop() AND s.cashier_id IS NOT NULL AND s.cashier_name IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM giga_cloud.users u WHERE u.shop_id = s.shop_id AND u.user_id = s.cashier_id));

CREATE OR REPLACE VIEW giga_online.expenses AS
SELECT e.expense_id AS id, (e.data->>'branch_id')::uuid AS branch_id, e.category, e.description, e.amount, e.payment_method,
       e.data->>'reference' AS reference, e.user_id, e.expense_date AS date, (e.data->>'created_at')::timestamptz AS created_at
FROM giga_cloud.expenses e WHERE e.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.purchases AS
SELECT p.purchase_id AS id, (p.data->>'branch_id')::uuid AS branch_id, p.order_number, p.invoice_number, p.supplier_id,
       (p.data->>'order_date')::date AS order_date, p.received_date, p.data->>'status' AS status, p.total_amount, p.payment_status,
       p.data->>'notes' AS notes, (p.data->>'created_by')::uuid AS created_by, (p.data->>'created_at')::timestamptz AS created_at
FROM giga_cloud.purchases p WHERE p.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.purchase_items AS
SELECT i.purchase_item_id AS id, i.purchase_id, i.medicine_id, i.batch_number, (i.data->>'manufacturing_date')::date AS manufacturing_date,
       (i.data->>'expiry_date')::date AS expiry_date, i.quantity, i.purchase_price, i.total, (i.data->>'created_at')::timestamptz AS created_at
FROM giga_cloud.purchase_items i WHERE i.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.inventory_movements AS
SELECT m.movement_id AS id, m.medicine_id, m.batch_id, m.previous_quantity, m.delta AS adjustment_quantity, m.new_quantity,
       m.movement_type, m.reason, m.reference_id, m.notes, m.user_id, m.device_id, m.occurred_at AS created_at
FROM giga_cloud.inventory_movements m WHERE m.shop_id = giga_online.current_shop();

CREATE OR REPLACE VIEW giga_online.settings AS
SELECT (st.data->>'branch_id')::uuid AS branch_id, st.data->>'pharmacy_name' AS pharmacy_name, st.data->>'tagline' AS tagline,
       st.data->>'address' AS address, st.data->>'phone' AS phone, st.data->>'email' AS email, st.data->>'currency' AS currency,
       (st.data->>'tax_rate')::numeric AS tax_rate, (st.data->>'tax_enabled')::boolean AS tax_enabled,
       st.data->>'receipt_header' AS receipt_header, st.data->>'receipt_footer' AS receipt_footer, st.data->>'printer_type' AS printer_type,
       (st.data->>'auto_print_receipt')::boolean AS auto_print_receipt, (st.data->>'low_stock_threshold')::int AS low_stock_threshold,
       (st.data->>'expiry_warning_days')::int AS expiry_warning_days, st.data->>'version' AS version, st.updated_at
FROM giga_cloud.shop_settings st WHERE st.shop_id = giga_online.current_shop();

-- Private: reachable only by the database owner role used by the server-side online API.
REVOKE ALL ON SCHEMA giga_online FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA giga_online FROM PUBLIC;
REVOKE ALL ON giga_cloud.online_users FROM PUBLIC;
REVOKE ALL ON FUNCTION giga_cloud.upsert_online_user(TEXT, TEXT, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA giga_online FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA giga_online FROM %I', r);
            EXECUTE format('REVOKE ALL ON giga_cloud.online_users FROM %I', r);
        END IF;
    END LOOP;
END $$;
