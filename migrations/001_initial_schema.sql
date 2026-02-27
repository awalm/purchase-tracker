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
    purchase_cost DECIMAL(10, 4) NOT NULL,
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

-- Delivery Status Enum
CREATE TYPE delivery_status AS ENUM (
    'pending',
    'in_transit',
    'delivered',
    'damaged',
    'returned',
    'lost'
);

-- Invoices (outgoing to destinations, for reconciliation)
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id UUID NOT NULL REFERENCES destinations(id),
    invoice_number VARCHAR(100) NOT NULL,
    order_number VARCHAR(100),
    invoice_date DATE NOT NULL,
    subtotal DECIMAL(12, 4) NOT NULL,  -- Pre-tax amount (what the goods actually cost)
    tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 13.00,  -- Tax percentage (e.g. 13.00 for HST)
    total DECIMAL(12, 4) NOT NULL,  -- subtotal * (1 + tax_rate/100)
    original_pdf BYTEA,             -- Original PDF invoice stored in DB
    original_filename VARCHAR(255), -- Original filename for downloads
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchases (main tracking table - replaces BG_Tracking)
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id),
    invoice_id UUID REFERENCES invoices(id),
    quantity INTEGER NOT NULL CHECK (quantity != 0),
    purchase_cost DECIMAL(10, 4) NOT NULL,  -- What you paid the vendor per unit
    selling_price DECIMAL(10, 4),            -- What the destination pays per unit (from invoice)
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
    i.purchase_cost,
    i.default_destination_id,
    d.code AS default_destination_code,
    i.notes
FROM items i
JOIN vendors v ON v.id = i.vendor_id
LEFT JOIN destinations d ON d.id = i.default_destination_id
WHERE i.start_date <= CURRENT_DATE
  AND (i.end_date IS NULL OR i.end_date >= CURRENT_DATE);

-- Purchase economics (cost + commission + tax tracking)
CREATE VIEW v_purchase_economics AS
SELECT 
    p.id AS purchase_id,
    p.created_at AS purchase_date,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.purchase_cost,
    p.quantity * p.purchase_cost AS total_cost,
    p.selling_price,
    p.quantity * p.selling_price AS total_selling,
    p.selling_price - p.purchase_cost AS unit_commission,
    p.quantity * (p.selling_price - p.purchase_cost) AS total_commission,
    p.quantity * p.purchase_cost * 0.13 AS tax_paid,
    CASE WHEN p.selling_price IS NOT NULL
      THEN p.quantity * (p.selling_price - p.purchase_cost) * 0.13
      ELSE 0
    END AS tax_owed,
    p.status,
    p.delivery_date,
    p.invoice_id
FROM purchases p
JOIN items i ON i.id = p.item_id
JOIN vendors v ON v.id = i.vendor_id
LEFT JOIN destinations d ON d.id = p.destination_id;

-- Invoice reconciliation (compare invoice subtotal vs sum of selling_price * qty)
CREATE VIEW v_invoice_reconciliation AS
SELECT 
    inv.id AS invoice_id,
    inv.invoice_number,
    d.code AS destination_code,
    d.name AS destination_name,
    inv.invoice_date,
    inv.subtotal AS invoice_total,
    COALESCE(SUM(p.quantity * COALESCE(p.selling_price, p.purchase_cost)), 0) AS purchases_total,
    inv.subtotal - COALESCE(SUM(p.quantity * COALESCE(p.selling_price, p.purchase_cost)), 0) AS difference,
    ABS(inv.subtotal - COALESCE(SUM(p.quantity * COALESCE(p.selling_price, p.purchase_cost)), 0)) < 0.01 AS is_matched,
    COUNT(p.id) AS purchase_count,
    COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_cost,
    COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission
FROM invoices inv
JOIN destinations d ON d.id = inv.destination_id
LEFT JOIN purchases p ON p.invoice_id = inv.id
GROUP BY inv.id, inv.invoice_number, d.code, d.name, inv.invoice_date, inv.subtotal;

-- Destination summary (totals by destination with commission and tax)
CREATE VIEW v_destination_summary AS
SELECT 
    d.id AS destination_id,
    d.code AS destination_code,
    d.name AS destination_name,
    (SELECT COUNT(*) FROM invoices WHERE destination_id = d.id) AS total_invoices,
    (SELECT COUNT(*) FROM purchases WHERE destination_id = d.id) AS total_purchases,
    (SELECT COALESCE(SUM(quantity), 0) FROM purchases WHERE destination_id = d.id) AS total_quantity,
    (SELECT COALESCE(SUM(quantity * purchase_cost), 0) FROM purchases WHERE destination_id = d.id) AS total_cost,
    (SELECT COALESCE(SUM(quantity * COALESCE(selling_price, purchase_cost)), 0) FROM purchases WHERE destination_id = d.id) AS total_revenue,
    (SELECT COALESCE(SUM(quantity * (COALESCE(selling_price, purchase_cost) - purchase_cost)), 0) FROM purchases WHERE destination_id = d.id) AS total_commission,
    (SELECT COALESCE(SUM(quantity * purchase_cost * 0.13), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_paid,
    (SELECT COALESCE(SUM(CASE WHEN selling_price IS NOT NULL THEN quantity * (selling_price - purchase_cost) * 0.13 ELSE 0 END), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_owed
FROM destinations d;

-- Vendor summary (totals by vendor)
CREATE VIEW v_vendor_summary AS
SELECT 
    v.id AS vendor_id,
    v.name AS vendor_name,
    COUNT(DISTINCT p.id) AS total_purchases,
    COALESCE(SUM(p.quantity), 0) AS total_quantity,
    COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_spent
FROM vendors v
LEFT JOIN items i ON i.vendor_id = v.id
LEFT JOIN purchases p ON p.item_id = i.id
GROUP BY v.id, v.name;

-- ============================================
-- Indexes
-- ============================================

-- Items: lookup by vendor, date range filtering
CREATE INDEX idx_items_vendor ON items(vendor_id);
CREATE INDEX idx_items_end_date ON items(end_date);

-- Purchases: common query patterns
CREATE INDEX idx_purchases_item ON purchases(item_id);
CREATE INDEX idx_purchases_invoice ON purchases(invoice_id);
CREATE INDEX idx_purchases_destination ON purchases(destination_id);
CREATE INDEX idx_purchases_status ON purchases(status);
CREATE INDEX idx_purchases_created ON purchases(created_at);

-- Invoices: lookup patterns
CREATE INDEX idx_invoices_destination ON invoices(destination_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);

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
CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
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
