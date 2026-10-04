-- ====================================================================
-- GIGA CHEMIST - Seed Data for Local XAMPP Environment
-- ====================================================================

USE `giga_chemist`;

SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------
-- 1. Default Roles
-- --------------------------------------------------------
INSERT INTO `roles` (`id`, `name`, `description`, `created_at`) VALUES
('role-admin', 'ADMIN', 'Full system access and configuration', '2026-01-01'),
('role-manager', 'MANAGER', 'Inventory, purchases, adjustments, and report viewing', '2026-01-01'),
('role-cashier', 'CASHIER', 'Point of sale, dispensing, and receipt generation', '2026-01-01')
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);

-- --------------------------------------------------------
-- 2. Standard Permissions
-- --------------------------------------------------------
INSERT INTO `permissions` (`id`, `code`, `description`, `module`) VALUES
('perm-01', 'medicine.create', 'Create new medicine items', 'inventory'),
('perm-02', 'medicine.update', 'Update medicine details', 'inventory'),
('perm-03', 'medicine.delete', 'Delete medicine records', 'inventory'),
('perm-04', 'medicine.change_price', 'Change pricing parameters', 'inventory'),
('perm-05', 'medicine.view', 'View medicine database', 'inventory'),
('perm-06', 'inventory.view', 'View stock balances and batches', 'inventory'),
('perm-07', 'inventory.adjust', 'Make manual stock adjustments', 'inventory'),
('perm-08', 'stock.receive', 'Receive supplier purchase orders', 'purchases'),
('perm-09', 'sales.create', 'Create sales and dispense medicines', 'pos'),
('perm-10', 'sales.view', 'View sales records and history', 'pos'),
('perm-11', 'sales.void', 'Void completed transactions', 'pos'),
('perm-12', 'reports.view', 'Access financial and sales analytics', 'reports'),
('perm-13', 'users.manage', 'Add, modify, and manage user accounts', 'users'),
('perm-14', 'settings.manage', 'Modify system and printer configuration', 'settings'),
('perm-15', 'audit.view', 'Inspect security and inventory audit logs', 'audit'),
('perm-16', 'returns.process', 'Process and approve customer refunds', 'pos'),
('perm-17', 'returns.request', 'Request customer returns', 'pos'),
('perm-18', 'customers.manage', 'Create and modify customer accounts', 'customers'),
('perm-19', 'expenses.manage', 'Record and track store expenses', 'expenses')
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);

-- --------------------------------------------------------
-- 3. Standard Role Permissions Mapping
-- --------------------------------------------------------
-- Admin gets all permissions
INSERT INTO `role_permissions` (`id`, `role_id`, `permission_id`) VALUES
('rp-a01', 'role-admin', 'perm-01'),
('rp-a02', 'role-admin', 'perm-02'),
('rp-a03', 'role-admin', 'perm-03'),
('rp-a04', 'role-admin', 'perm-04'),
('rp-a05', 'role-admin', 'perm-05'),
('rp-a06', 'role-admin', 'perm-06'),
('rp-a07', 'role-admin', 'perm-07'),
('rp-a08', 'role-admin', 'perm-08'),
('rp-a09', 'role-admin', 'perm-09'),
('rp-a10', 'role-admin', 'perm-10'),
('rp-a11', 'role-admin', 'perm-11'),
('rp-a12', 'role-admin', 'perm-12'),
('rp-a13', 'role-admin', 'perm-13'),
('rp-a14', 'role-admin', 'perm-14'),
('rp-a15', 'role-admin', 'perm-15'),
('rp-a16', 'role-admin', 'perm-16'),
('rp-a17', 'role-admin', 'perm-17'),
('rp-a18', 'role-admin', 'perm-18'),
('rp-a19', 'role-admin', 'perm-19'),

-- Manager permissions
('rp-m01', 'role-manager', 'perm-01'),
('rp-m02', 'role-manager', 'perm-02'),
('rp-m04', 'role-manager', 'perm-04'),
('rp-m05', 'role-manager', 'perm-05'),
('rp-m06', 'role-manager', 'perm-06'),
('rp-m07', 'role-manager', 'perm-07'),
('rp-m08', 'role-manager', 'perm-08'),
('rp-m09', 'role-manager', 'perm-09'),
('rp-m10', 'role-manager', 'perm-10'),
('rp-m12', 'role-manager', 'perm-12'),
('rp-m16', 'role-manager', 'perm-16'),
('rp-m17', 'role-manager', 'perm-17'),
('rp-m18', 'role-manager', 'perm-18'),
('rp-m19', 'role-manager', 'perm-19'),

-- Cashier permissions
('rp-c05', 'role-cashier', 'perm-05'),
('rp-c06', 'role-cashier', 'perm-06'),
('rp-c09', 'role-cashier', 'perm-09'),
('rp-c10', 'role-cashier', 'perm-10'),
('rp-c17', 'role-cashier', 'perm-17'),
('rp-c18', 'role-cashier', 'perm-18')
ON DUPLICATE KEY UPDATE `role_id` = VALUES(`role_id`);

-- --------------------------------------------------------
-- 4. Initial Categories
-- --------------------------------------------------------
INSERT INTO `categories` (`id`, `name`, `description`, `created_at`) VALUES
('cat-01', 'Analgesics & Antipyretics', 'Pain relievers and fever reducers', '2026-01-01'),
('cat-02', 'Antibiotics', 'Antimicrobial and antibacterial agents', '2026-01-01'),
('cat-03', 'Antihistamines', 'Allergy and cold management medicines', '2026-01-01'),
('cat-04', 'Cardiovascular', 'Heart and blood pressure management', '2026-01-01'),
('cat-05', 'Antidiabetic', 'Blood sugar control medications', '2026-01-01'),
('cat-06', 'Gastrointestinal', 'Antacids, PPIs, and digestive medications', '2026-01-01'),
('cat-07', 'Vitamins & Supplements', 'Nutritional and wellness supplements', '2026-01-01'),
('cat-08', 'Dermatologicals', 'Topical creams and ointments', '2026-01-01'),
('cat-09', 'Respiratory', 'Bronchodilators and cough syrups', '2026-01-01'),
('cat-10', 'First Aid & Surgical', 'Bandages, dressings, and medical supplies', '2026-01-01')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- --------------------------------------------------------
-- 5. Default Pharmacy Settings
-- --------------------------------------------------------
INSERT INTO `settings` (`key_name`, `key_value`, `updated_at`) VALUES
('pharmacy_settings', '{"pharmacy_name":"GIGA CHEMIST","tagline":"Healthcare & Pharmaceutical Dispensing Centre","address":"Commercial Street, Kitale, Kenya","phone":"+254 700 123 456","email":"orders@gigachemist.co.ke","currency":"KES","tax_rate":0,"tax_enabled":false,"receipt_header":"GIGA CHEMIST\\nKitale, Kenya\\nOfficial Dispensing Receipt","receipt_footer":"Thank you for choosing GIGA CHEMIST!\\nMedicines dispensed correctly cannot be returned.\\nGet well soon.","printer_type":"80mm","auto_print_receipt":true,"low_stock_threshold":20,"expiry_warning_days":90,"require_prescription_warning":true,"allow_walk_in":true,"version":"1.0.0-pwa"}', '2026-01-01')
ON DUPLICATE KEY UPDATE `key_value` = VALUES(`key_value`);

-- --------------------------------------------------------
-- 6. Sample Suppliers
-- --------------------------------------------------------
INSERT INTO `suppliers` (`id`, `name`, `contact_person`, `phone`, `email`, `address`, `tax_pin`, `balance`, `status`, `created_at`, `updated_at`) VALUES
('sup-001', 'Harleys Pharma Ltd', 'David Omondi', '+254 722 112 233', 'sales@harleys.co.ke', 'Enterprise Road, Industrial Area, Nairobi', 'P051234567A', 0.00, 'active', '2026-01-01', '2026-01-01'),
('sup-002', 'Megascope Healthcare', 'Mercy Chebet', '+254 733 445 566', 'orders@megascope.co.ke', 'Mombasa Road, Nairobi', 'P059876543Z', 0.00, 'active', '2026-01-01', '2026-01-01'),
('sup-003', 'Elys Chemical Industries', 'Paul Karanja', '+254 711 778 899', 'info@elys.co.ke', 'Ruaraka, Thika Road, Nairobi', 'P053322114K', 0.00, 'active', '2026-01-01', '2026-01-01')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- --------------------------------------------------------
-- 7. Starter Essential Medicines
-- --------------------------------------------------------
INSERT INTO `medicines` (`id`, `branch_id`, `name`, `generic_name`, `brand_name`, `sku`, `barcode`, `category`, `medicine_type`, `dosage_strength`, `dosage_form`, `manufacturer`, `description`, `purchase_price`, `selling_price`, `wholesale_price`, `min_selling_price`, `current_stock`, `reorder_level`, `unit`, `prescription_required`, `status`, `created_at`, `updated_at`, `created_by`, `updated_by`, `version`) VALUES
('med-001', 'branch-kitale', 'Paracetamol 500mg', 'Paracetamol (Acetaminophen)', 'Panadol', 'MED-PCM-500', '616400010012', 'Analgesics & Antipyretics', 'Pain Relief & Fever', '500mg', 'Tablet', 'GlaxoSmithKline', 'Effective relief from headache, fever, muscle aches, and pain.', 3.50, 10.00, 8.00, 7.00, 350, 50, 'Strips (10 tabs)', 0, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-002', 'branch-kitale', 'Amoxicillin 500mg Capsules', 'Amoxicillin Trihydrate', 'Amoxil', 'MED-AMX-500', '616400010029', 'Antibiotics', 'Antibacterial', '500mg', 'Capsule', 'Dawa Pharmaceuticals', 'Broad-spectrum penicillin antibiotic for bacterial infections.', 12.00, 25.00, 20.00, 18.00, 180, 40, 'Strips (10 caps)', 1, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-003', 'branch-kitale', 'Cetirizine 10mg Tablets', 'Cetirizine Hydrochloride', 'Zyrtec', 'MED-CTZ-010', '616400010036', 'Antihistamines', 'Anti-allergy', '10mg', 'Tablet', 'Elys Chemical Industries', 'Non-drowsy antihistamine for rhinitis, itching, and allergies.', 4.00, 12.00, 10.00, 8.00, 220, 30, 'Strips (10 tabs)', 0, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-004', 'branch-kitale', 'Omeprazole 20mg Capsules', 'Omeprazole', 'Losec', 'MED-OMP-020', '616400010043', 'Gastrointestinal', 'Proton Pump Inhibitor', '20mg', 'Capsule', 'AstraZeneca', 'Reduces stomach acid for heartburn, ulcers, and GERD.', 8.00, 20.00, 16.00, 15.00, 140, 25, 'Strips (14 caps)', 0, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-005', 'branch-kitale', 'Metformin 500mg Tablets', 'Metformin Hydrochloride', 'Glucophage', 'MED-MTF-500', '616400010050', 'Antidiabetic', 'Biguanide', '500mg', 'Tablet', 'Merck', 'First-line medication for type 2 diabetes blood glucose control.', 5.00, 15.00, 12.00, 10.00, 290, 50, 'Strips (10 tabs)', 1, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-006', 'branch-kitale', 'Amlodipine 5mg Tablets', 'Amlodipine Besylate', 'Norvasc', 'MED-AML-005', '616400010067', 'Cardiovascular', 'Calcium Channel Blocker', '5mg', 'Tablet', 'Pfizer', 'Antihypertensive agent for high blood pressure and angina.', 6.50, 18.00, 15.00, 12.00, 195, 30, 'Strips (10 tabs)', 1, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-007', 'branch-kitale', 'Ibuprofen 400mg Tablets', 'Ibuprofen', 'Brufen', 'MED-IBU-400', '616400010074', 'Analgesics & Antipyretics', 'NSAID Pain & Inflammation', '400mg', 'Tablet', 'Abbott Healthcare', 'Non-steroidal anti-inflammatory for joint pain, dental pain, fever.', 4.50, 12.00, 10.00, 8.00, 310, 40, 'Strips (10 tabs)', 0, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1),
('med-008', 'branch-kitale', 'Salbutamol Inhaler 100mcg', 'Salbutamol Sulfate', 'Ventolin', 'MED-SLB-100', '616400010081', 'Respiratory', 'Short-Acting Bronchodilator', '100mcg/dose', 'Inhaler', 'GlaxoSmithKline', 'Fast-acting relief for asthma and COPD bronchospasm.', 220.00, 380.00, 320.00, 300.00, 45, 10, 'Canister (200 doses)', 1, 'active', '2026-01-01', '2026-01-01', 'Admin', 'Admin', 1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- --------------------------------------------------------
-- 8. Starter Batches (FEFO Ready with realistic future dates)
-- --------------------------------------------------------
INSERT INTO `medicine_batches` (`id`, `branch_id`, `medicine_id`, `medicine_name`, `batch_number`, `supplier_id`, `supplier_name`, `quantity_received`, `quantity_available`, `purchase_price`, `selling_price_override`, `manufacturing_date`, `expiry_date`, `received_date`, `purchase_invoice`, `created_by`, `created_at`, `status`) VALUES
('bat-001', 'branch-kitale', 'med-001', 'Paracetamol 500mg', 'BN-PCM-2026A', 'sup-001', 'Harleys Pharma Ltd', 200, 200, 3.50, NULL, '2026-01-10', '2027-12-31', '2026-01-15', 'INV-HRL-4491', 'Admin', '2026-01-15', 'active'),
('bat-002', 'branch-kitale', 'med-001', 'Paracetamol 500mg', 'BN-PCM-2026B', 'sup-001', 'Harleys Pharma Ltd', 150, 150, 3.50, NULL, '2026-02-01', '2028-06-30', '2026-02-05', 'INV-HRL-4812', 'Admin', '2026-02-05', 'active'),
('bat-003', 'branch-kitale', 'med-002', 'Amoxicillin 500mg Capsules', 'BN-AMX-8801', 'sup-002', 'Megascope Healthcare', 180, 180, 12.00, NULL, '2025-11-20', '2027-10-31', '2025-12-01', 'INV-MEG-1102', 'Admin', '2025-12-01', 'active'),
('bat-004', 'branch-kitale', 'med-003', 'Cetirizine 10mg Tablets', 'BN-CTZ-3320', 'sup-003', 'Elys Chemical Industries', 220, 220, 4.00, NULL, '2026-01-05', '2028-01-31', '2026-01-12', 'INV-ELY-7731', 'Admin', '2026-01-12', 'active'),
('bat-005', 'branch-kitale', 'med-004', 'Omeprazole 20mg Capsules', 'BN-OMP-9104', 'sup-001', 'Harleys Pharma Ltd', 140, 140, 8.00, NULL, '2025-10-15', '2027-08-31', '2025-11-01', 'INV-HRL-3901', 'Admin', '2025-11-01', 'active'),
('bat-006', 'branch-kitale', 'med-005', 'Metformin 500mg Tablets', 'BN-MTF-6022', 'sup-002', 'Megascope Healthcare', 290, 290, 5.00, NULL, '2026-01-18', '2028-04-30', '2026-01-25', 'INV-MEG-1390', 'Admin', '2026-01-25', 'active'),
('bat-007', 'branch-kitale', 'med-006', 'Amlodipine 5mg Tablets', 'BN-AML-1190', 'sup-001', 'Harleys Pharma Ltd', 195, 195, 6.50, NULL, '2025-12-10', '2027-11-30', '2026-01-04', 'INV-HRL-4210', 'Admin', '2026-01-04', 'active'),
('bat-008', 'branch-kitale', 'med-007', 'Ibuprofen 400mg Tablets', 'BN-IBU-4001', 'sup-003', 'Elys Chemical Industries', 310, 310, 4.50, NULL, '2026-02-12', '2028-08-31', '2026-02-18', 'INV-ELY-8199', 'Admin', '2026-02-18', 'active'),
('bat-009', 'branch-kitale', 'med-008', 'Salbutamol Inhaler 100mcg', 'BN-SLB-0041', 'sup-001', 'Harleys Pharma Ltd', 45, 45, 220.00, NULL, '2026-01-02', '2027-12-31', '2026-01-10', 'INV-HRL-4401', 'Admin', '2026-01-10', 'active')
ON DUPLICATE KEY UPDATE `batch_number` = VALUES(`batch_number`);

SET FOREIGN_KEY_CHECKS = 1;
