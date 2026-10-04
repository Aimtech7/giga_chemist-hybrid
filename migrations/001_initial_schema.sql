-- =============================================================================
-- Migration 001: Initial Relational Database Schema
-- GIGA CHEMIST Pharmacy POS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. BRANCHES
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    is_main_branch BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. SUPPLIERS
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    address TEXT,
    tax_pin VARCHAR(50),
    balance NUMERIC(12, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(100),
    address TEXT,
    notes TEXT,
    credit_balance NUMERIC(12, 2) DEFAULT 0.00,
    total_spent NUMERIC(12, 2) DEFAULT 0.00,
    last_visit TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. SETTINGS
CREATE TABLE IF NOT EXISTS settings (
    branch_id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000'::UUID,
    pharmacy_name VARCHAR(255) NOT NULL DEFAULT 'GIGA CHEMIST',
    tagline VARCHAR(255) DEFAULT 'Trusted Healthcare & Pharmaceutical Solutions',
    address TEXT DEFAULT 'Kenyatta Street, Kitale, Kenya',
    phone VARCHAR(50) DEFAULT '+254 700 123 456',
    email VARCHAR(100) DEFAULT 'info@gigachemist.co.ke',
    currency VARCHAR(10) DEFAULT 'KES',
    tax_rate NUMERIC(5, 2) DEFAULT 0.00,
    tax_enabled BOOLEAN DEFAULT FALSE,
    receipt_header TEXT DEFAULT 'GIGA CHEMIST\nKitale, Kenya\nOfficial Dispensing Receipt',
    receipt_footer TEXT DEFAULT 'Thank you for choosing GIGA CHEMIST!\nGet well soon.',
    printer_type VARCHAR(20) DEFAULT '80mm',
    auto_print_receipt BOOLEAN DEFAULT TRUE,
    low_stock_threshold INTEGER DEFAULT 20,
    expiry_warning_days INTEGER DEFAULT 90,
    version VARCHAR(50) DEFAULT '1.0.0-pwa',
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
