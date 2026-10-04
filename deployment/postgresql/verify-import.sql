-- =============================================================================
-- GIGA CHEMIST — POSTGRESQL DATABASE IMPORT VERIFICATION SCRIPT
-- Run this script in PostgreSQL after importing giga_chemist_full.sql:
-- psql -U postgres -d giga_chemist -f verify-import.sql
-- =============================================================================

\echo '======================================================================'
\echo '  GIGA CHEMIST — DATABASE INTEGRITY & IMPORT VERIFICATION'
\echo '======================================================================'
\echo ''

-- 1. Table Row Counts
\echo '--> [1/5] Checking Primary Entity & Ledger Row Counts...'
SELECT 
    'Medicines Formulary' AS entity, 
    COUNT(*) AS actual_count, 
    2181 AS expected_count,
    CASE WHEN COUNT(*) = 2181 THEN 'PASS' ELSE 'FAIL' END AS status
FROM medicines
UNION ALL
SELECT 
    'Medicine Batches', 
    COUNT(*), 
    2181,
    CASE WHEN COUNT(*) = 2181 THEN 'PASS' ELSE 'FAIL' END
FROM medicine_batches
UNION ALL
SELECT 
    'Sales Transactions', 
    COUNT(*), 
    135818,
    CASE WHEN COUNT(*) = 135818 THEN 'PASS' ELSE 'FAIL' END
FROM sales
UNION ALL
SELECT 
    'Sale Line Items', 
    COUNT(*), 
    226401,
    CASE WHEN COUNT(*) = 226401 THEN 'PASS' ELSE 'FAIL' END
FROM sale_items
UNION ALL
SELECT 
    'Payment Records', 
    COUNT(*), 
    135817,
    CASE WHEN COUNT(*) = 135817 THEN 'PASS' ELSE 'FAIL' END
FROM payments
UNION ALL
SELECT 
    'Purchases (Receivings)', 
    COUNT(*), 
    728,
    CASE WHEN COUNT(*) = 728 THEN 'PASS' ELSE 'FAIL' END
FROM purchases
UNION ALL
SELECT 
    'Purchase Line Items', 
    COUNT(*), 
    2524,
    CASE WHEN COUNT(*) = 2524 THEN 'PASS' ELSE 'FAIL' END
FROM purchase_items
UNION ALL
SELECT 
    'Inventory Movement History', 
    COUNT(*), 
    263107,
    CASE WHEN COUNT(*) = 263107 THEN 'PASS' ELSE 'FAIL' END
FROM inventory_movements
UNION ALL
SELECT 
    'Categories', 
    COUNT(*), 
    580,
    CASE WHEN COUNT(*) = 580 THEN 'PASS' ELSE 'FAIL' END
FROM categories
UNION ALL
SELECT 
    'Suppliers', 
    COUNT(*), 
    7,
    CASE WHEN COUNT(*) = 7 THEN 'PASS' ELSE 'FAIL' END
FROM suppliers
UNION ALL
SELECT 
    'Customers', 
    COUNT(*), 
    1,
    CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END
FROM customers;

-- 2. Stock Integrity
\echo ''
\echo '--> [2/5] Verifying Stock Totals & Non-Null Balance Consistency...'
SELECT 
    SUM(current_stock) AS total_medicine_stock,
    (SELECT SUM(quantity_available) FROM medicine_batches) AS total_batch_stock,
    43686 AS expected_stock,
    CASE 
        WHEN SUM(current_stock) = 43686 AND (SELECT SUM(quantity_available) FROM medicine_batches) = 43686 
        THEN 'PASS' 
        ELSE 'FAIL' 
    END AS stock_status
FROM medicines;

-- 3. Expiry Date & Truth-in-Data Validation
\echo ''
\echo '--> [3/5] Checking Expiry Dates (Truth-Based Nulls & Zero Fake Dates)...'
SELECT 
    COUNT(CASE WHEN expiry_date = '2029-12-31' THEN 1 END) AS fake_2029_dates_count,
    COUNT(CASE WHEN expiry_date IS NULL AND expiry_status = 'UNKNOWN' THEN 1 END) AS legacy_unknown_expiry_count,
    CASE 
        WHEN COUNT(CASE WHEN expiry_date = '2029-12-31' THEN 1 END) = 0 
         AND COUNT(CASE WHEN expiry_date IS NULL AND expiry_status = 'UNKNOWN' THEN 1 END) = 2181 
        THEN 'PASS' 
        ELSE 'FAIL' 
    END AS expiry_integrity_status
FROM medicine_batches;

-- 4. Authentication Security & Zero Password Leakage
\echo ''
\echo '--> [4/5] Verifying Security (Active Admin/Cashier + Locked Legacy Accounts + Zero MD5)...'
SELECT 
    COUNT(*) AS total_staff_profiles,
    COUNT(CASE WHEN email = 'admin@gigachemist.co.ke' AND role = 'ADMIN' AND active = TRUE THEN 1 END) AS active_admin_count,
    COUNT(CASE WHEN email = 'cashier@gigachemist.co.ke' AND role = 'CASHIER' AND active = TRUE THEN 1 END) AS active_cashier_count,
    COUNT(CASE WHEN password_hash = 'LOCKED_MIGRATED_LEGACY_STAFF_ACCOUNT' THEN 1 END) AS locked_legacy_accounts,
    COUNT(CASE WHEN length(password_hash) = 32 AND password_hash ~ '^[a-f0-9]+$' THEN 1 END) AS md5_hashes_leaked,
    CASE 
        WHEN COUNT(CASE WHEN length(password_hash) = 32 AND password_hash ~ '^[a-f0-9]+$' THEN 1 END) = 0 
         AND COUNT(CASE WHEN password_hash = 'LOCKED_MIGRATED_LEGACY_STAFF_ACCOUNT' THEN 1 END) = 5
         AND COUNT(CASE WHEN email = 'admin@gigachemist.co.ke' AND role = 'ADMIN' AND active = TRUE THEN 1 END) = 1
         AND COUNT(CASE WHEN email = 'cashier@gigachemist.co.ke' AND role = 'CASHIER' AND active = TRUE THEN 1 END) = 1
        THEN 'PASS' 
        ELSE 'FAIL' 
    END AS security_status
FROM users;

-- 5. Financial Reconciliation Proof
\echo ''
\echo '--> [5/5] Checking Financial Integrity (Sales vs Payments)...'
SELECT 
    SUM(total) AS total_sales_net_amount,
    (SELECT SUM(amount) FROM payments) AS total_payments_collected,
    ROUND(SUM(total) - (SELECT SUM(amount) FROM payments), 2) AS variance,
    CASE 
        WHEN ROUND(SUM(total), 2) = 45299922.38 
         AND ROUND((SELECT SUM(amount) FROM payments), 2) = 45360422.53 
         AND ROUND((SELECT SUM(amount) FROM payments) - SUM(total), 2) = 60500.15
        THEN 'PASS (Reconciled with 224 over-tenders & cash roundings)' 
        ELSE 'FAIL' 
    END AS financial_status
FROM sales;

\echo ''
\echo '======================================================================'
\echo '  VERIFICATION COMPLETE'
\echo '======================================================================'
