-- BG Tracker Initial Schema
-- Migration 001: Initial Schema

-- ============================================
-- EXTENSIONS
-- ============================================

-- Enable btree_gist for EXCLUDE constraint with UUIDs
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================
-- TABLES (Source of Truth - raw data only)
-- ============================================

-- Vendors (who you BUY from: Best Buy, Amazon, etc.)
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Destinations (who you SELL/SHIP to: CBG, BSC)
CREATE TABLE destinations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Items (Product catalog - keyed by name + vendor + date range)
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    unit_cost DECIMAL(10, 4) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,  -- NULL means currently active
    default_destination_id UUID REFERENCES destinations(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Prevent overlapping date ranges for same item/vendor
    EXCLUDE USING gist (
        name WITH =,
        vendor_id WITH =,
        daterange(start_date, COALESCE(end_date, '9999-12-31'::date), '[]') WITH &&
    )
);

-- Payouts (what destinations pay you - with date ranges)
CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id UUID NOT NULL REFERENCES destinations(id),
    item_id UUID NOT NULL REFERENCES items(id),
    payout_price DECIMAL(10, 4) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,  -- NULL means currently active
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Prevent overlapping date ranges for same item/destination
    EXCLUDE USING gist (
        item_id WITH =,
        destination_id WITH =,
        daterange(start_date, COALESCE(end_date, '9999-12-31'::date), '[]') WITH &&
    )
);

-- Delivery Status Enum
CREATE TYPE delivery_status AS ENUM (
    'pending',
    'in_transit',
    'delivered',
    'damaged',
    'returned',
    'lost'
);

-- Incoming Invoices (from vendors, for reconciliation)
CREATE TABLE incoming_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    invoice_number VARCHAR(100) NOT NULL,
    order_number VARCHAR(100),
    invoice_date DATE NOT NULL,
    total DECIMAL(12, 4) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchases (main tracking table - replaces BG_Tracking)
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id),
    invoice_id UUID REFERENCES incoming_invoices(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost DECIMAL(10, 4) NOT NULL,  -- Snapshot from items at purchase time
    destination_id UUID REFERENCES destinations(id),
    status delivery_status NOT NULL DEFAULT 'pending',
    delivery_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users (for authentication)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Log (partitioned - grows unbounded)
CREATE TABLE audit_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    table_name VARCHAR(50) NOT NULL,
    record_id UUID NOT NULL,
    operation VARCHAR(10) NOT NULL,  -- 'create', 'update', 'delete'
    old_data JSONB,
    new_data JSONB,
    user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Initial audit_log partitions (covering 2025-2026)
CREATE TABLE audit_log_2025_11 PARTITION OF audit_log
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE audit_log_2025_12 PARTITION OF audit_log
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE audit_log_2026_01 PARTITION OF audit_log
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE audit_log_2026_02 PARTITION OF audit_log
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE audit_log_2026_03 PARTITION OF audit_log
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE audit_log_2026_04 PARTITION OF audit_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE audit_log_2026_05 PARTITION OF audit_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_log_2026_06 PARTITION OF audit_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ============================================
-- VIEWS (Derived Data - computed, never stored)
-- ============================================

-- Active items (currently valid pricing)
CREATE VIEW v_active_items AS
SELECT 
    i.id,
    i.name,
    i.vendor_id,
    v.name AS vendor_name,
    i.unit_cost,
    i.default_destination_id,
    d.code AS default_destination_code,
    i.notes
FROM items i
JOIN vendors v ON v.id = i.vendor_id
LEFT JOIN destinations d ON d.id = i.default_destination_id
WHERE i.start_date <= CURRENT_DATE
  AND (i.end_date IS NULL OR i.end_date >= CURRENT_DATE);

-- Active payouts (currently valid payout prices)
CREATE VIEW v_active_payouts AS
SELECT 
    p.id,
    p.item_id,
    i.name AS item_name,
    p.destination_id,
    d.code AS destination_code,
    p.payout_price,
    p.notes
FROM payouts p
JOIN items i ON i.id = p.item_id
JOIN destinations d ON d.id = p.destination_id
WHERE p.start_date <= CURRENT_DATE
  AND (p.end_date IS NULL OR p.end_date >= CURRENT_DATE);

-- Purchase economics (profit calculations)
CREATE VIEW v_purchase_economics AS
SELECT 
    p.id AS purchase_id,
    p.created_at AS purchase_date,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.unit_cost,
    py.payout_price,
    (py.payout_price - p.unit_cost) AS unit_profit,
    (py.payout_price - p.unit_cost) * p.quantity AS total_profit,
    p.quantity * p.unit_cost AS total_cost,
    p.quantity * COALESCE(py.payout_price, 0) AS total_revenue,
    p.status,
    p.delivery_date,
    p.invoice_id
FROM purchases p
JOIN items i ON i.id = p.item_id
JOIN vendors v ON v.id = i.vendor_id
LEFT JOIN destinations d ON d.id = p.destination_id
LEFT JOIN payouts py ON py.item_id = p.item_id 
    AND py.destination_id = p.destination_id
    AND py.start_date <= p.created_at::date
    AND (py.end_date IS NULL OR py.end_date >= p.created_at::date);

-- Invoice reconciliation (compare invoice total vs sum of purchases)
CREATE VIEW v_invoice_reconciliation AS
SELECT 
    inv.id AS invoice_id,
    inv.invoice_number,
    v.name AS vendor_name,
    inv.invoice_date,
    inv.total AS invoice_total,
    COALESCE(SUM(p.quantity * p.unit_cost), 0) AS purchases_total,
    inv.total - COALESCE(SUM(p.quantity * p.unit_cost), 0) AS difference,
    ABS(inv.total - COALESCE(SUM(p.quantity * p.unit_cost), 0)) < 0.01 AS is_matched,
    COUNT(p.id) AS purchase_count
FROM incoming_invoices inv
JOIN vendors v ON v.id = inv.vendor_id
LEFT JOIN purchases p ON p.invoice_id = inv.id
GROUP BY inv.id, inv.invoice_number, v.name, inv.invoice_date, inv.total;

-- Destination summary (totals by destination)
CREATE VIEW v_destination_summary AS
SELECT 
    d.id AS destination_id,
    d.code AS destination_code,
    d.name AS destination_name,
    COUNT(p.id) AS total_purchases,
    COALESCE(SUM(p.quantity), 0) AS total_quantity,
    COALESCE(SUM(p.quantity * p.unit_cost), 0) AS total_cost,
    COALESCE(SUM(pe.total_profit), 0) AS total_profit
FROM destinations d
LEFT JOIN purchases p ON p.destination_id = d.id
LEFT JOIN v_purchase_economics pe ON pe.purchase_id = p.id
GROUP BY d.id, d.code, d.name;

-- Vendor summary (totals by vendor)
CREATE VIEW v_vendor_summary AS
SELECT 
    v.id AS vendor_id,
    v.name AS vendor_name,
    COUNT(DISTINCT inv.id) AS total_invoices,
    COUNT(DISTINCT p.id) AS total_purchases,
    COALESCE(SUM(p.quantity), 0) AS total_quantity,
    COALESCE(SUM(p.quantity * p.unit_cost), 0) AS total_spent
FROM vendors v
LEFT JOIN items i ON i.vendor_id = v.id
LEFT JOIN purchases p ON p.item_id = i.id
LEFT JOIN incoming_invoices inv ON inv.vendor_id = v.id
GROUP BY v.id, v.name;

-- ============================================
-- Indexes
-- ============================================

-- Items: lookup by vendor, date range filtering
CREATE INDEX idx_items_vendor ON items(vendor_id);
CREATE INDEX idx_items_active ON items(vendor_id) 
    WHERE end_date IS NULL OR end_date >= CURRENT_DATE;

-- Payouts: lookup by item+destination, date range filtering  
CREATE INDEX idx_payouts_item_destination ON payouts(item_id, destination_id);
CREATE INDEX idx_payouts_active ON payouts(item_id, destination_id) 
    WHERE end_date IS NULL OR end_date >= CURRENT_DATE;

-- Purchases: common query patterns
CREATE INDEX idx_purchases_item ON purchases(item_id);
CREATE INDEX idx_purchases_invoice ON purchases(invoice_id);
CREATE INDEX idx_purchases_destination ON purchases(destination_id);
CREATE INDEX idx_purchases_status ON purchases(status);
CREATE INDEX idx_purchases_created ON purchases(created_at);

-- Invoices: lookup patterns
CREATE INDEX idx_invoices_vendor ON incoming_invoices(vendor_id);
CREATE INDEX idx_invoices_number ON incoming_invoices(invoice_number);
CREATE INDEX idx_invoices_date ON incoming_invoices(invoice_date);

-- Audit log: lookup by table+record
CREATE INDEX idx_audit_table_record ON audit_log(table_name, record_id);

-- ============================================
-- Triggers
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_vendors_updated_at BEFORE UPDATE ON vendors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_destinations_updated_at BEFORE UPDATE ON destinations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_items_updated_at BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payouts_updated_at BEFORE UPDATE ON payouts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_incoming_invoices_updated_at BEFORE UPDATE ON incoming_invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_purchases_updated_at BEFORE UPDATE ON purchases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Helper Functions (validation only - business logic in Rust)
-- ============================================

-- Check if item is valid for a given date (use for validation, not business logic)
CREATE OR REPLACE FUNCTION is_item_valid(
    p_item_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
) RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM items
        WHERE id = p_item_id
          AND start_date <= p_date
          AND (end_date IS NULL OR end_date >= p_date)
    );
$$ LANGUAGE SQL;

-- Check if payout exists for item/destination on date
CREATE OR REPLACE FUNCTION has_payout(
    p_item_id UUID,
    p_destination_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
) RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM payouts
        WHERE item_id = p_item_id
          AND destination_id = p_destination_id
          AND start_date <= p_date
          AND (end_date IS NULL OR end_date >= p_date)
    );
$$ LANGUAGE SQL;

-- Create audit_log partition for a month
CREATE OR REPLACE FUNCTION create_audit_partition(p_year INT, p_month INT)
RETURNS VOID AS $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_suffix VARCHAR;
BEGIN
    start_date := make_date(p_year, p_month, 1);
    end_date := start_date + INTERVAL '1 month';
    partition_suffix := to_char(start_date, 'YYYY_MM');
    
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit_log_%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        partition_suffix, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Seed Data
-- ============================================

-- Insert default destinations
INSERT INTO destinations (code, name, is_active) VALUES
    ('CBG', 'Canada Buying Group', TRUE),
    ('BSC', 'Bulk Supply Co', TRUE);

-- Insert common vendors
INSERT INTO vendors (name) VALUES
    ('Best Buy'),
    ('Amazon'),
    ('Staples'),
    ('Canada Computers'),
    ('Walmart');
