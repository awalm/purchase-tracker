-- BG Tracker Initial Schema
-- Migration 001: Initial Schema (with Receipts — Phase 1 rearchitecture)

-- ============================================
-- TABLES
-- ============================================

-- Vendors (who you BUY from: Best Buy, Amazon, etc.)
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    short_id VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-side alias cache for OCR/import vendor labels
CREATE TABLE vendor_import_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    normalized_alias VARCHAR(255) NOT NULL UNIQUE,
    raw_alias VARCHAR(255) NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
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

-- Items (Product catalog — pure entries: name + default destination + notes)
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    default_destination_id UUID REFERENCES destinations(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- Receipts (incoming from vendors — buy-side, mirrors Invoices which are sell-side)
CREATE TABLE receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    receipt_number VARCHAR(100) NOT NULL UNIQUE,
    receipt_date DATE NOT NULL,
    subtotal DECIMAL(12, 4) NOT NULL,
    tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 13.00,
    total DECIMAL(12, 4) NOT NULL,
    payment_method TEXT,
    ingestion_metadata JSONB,
    original_pdf BYTEA,
    original_filename VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invoices (outgoing to destinations — sell-side)
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id UUID NOT NULL REFERENCES destinations(id),
    invoice_number VARCHAR(100) NOT NULL,
    order_number VARCHAR(100),
    invoice_date DATE NOT NULL,
    subtotal DECIMAL(12, 4) NOT NULL,
    tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 13.00,
    total DECIMAL(12, 4) NOT NULL,
    reconciliation_state VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (reconciliation_state IN ('open', 'in_review', 'reconciled', 'locked', 'reopened')),
    original_pdf BYTEA,
    original_filename VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchases (main tracking table — links items to receipts and invoices)
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id),
    receipt_id UUID REFERENCES receipts(id),
    invoice_id UUID REFERENCES invoices(id),
    quantity INTEGER NOT NULL CHECK (quantity != 0),
    purchase_cost DECIMAL(10, 4) NOT NULL,
    invoice_unit_price DECIMAL(10, 4),
    destination_id UUID REFERENCES destinations(id),
    status delivery_status NOT NULL DEFAULT 'pending',
    delivery_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users (authentication)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Log (partitioned)
CREATE TABLE audit_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    table_name VARCHAR(50) NOT NULL,
    record_id UUID NOT NULL,
    operation VARCHAR(10) NOT NULL,
    old_data JSONB,
    new_data JSONB,
    user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Audit log partitions (2025-11 through 2026-12)
CREATE TABLE audit_log_2025_11 PARTITION OF audit_log FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE audit_log_2025_12 PARTITION OF audit_log FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE audit_log_2026_01 PARTITION OF audit_log FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE audit_log_2026_02 PARTITION OF audit_log FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE audit_log_2026_03 PARTITION OF audit_log FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE audit_log_2026_04 PARTITION OF audit_log FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE audit_log_2026_05 PARTITION OF audit_log FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_log_2026_06 PARTITION OF audit_log FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE audit_log_2026_07 PARTITION OF audit_log FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_log_2026_08 PARTITION OF audit_log FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_log_2026_09 PARTITION OF audit_log FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_log_2026_10 PARTITION OF audit_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_log_2026_11 PARTITION OF audit_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_log_2026_12 PARTITION OF audit_log FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- ============================================
-- VIEWS
-- ============================================

-- Active items (simple: items + default destination)
CREATE VIEW v_active_items AS
SELECT 
    i.id,
    i.name,
    i.default_destination_id,
    d.code AS default_destination_code,
    i.notes,
    i.created_at
FROM items i
LEFT JOIN destinations d ON d.id = i.default_destination_id;

-- Purchase economics (cost + commission + tax + receipt/invoice linkage)
-- Vendor comes from receipt (LEFT JOIN), not items.
-- When purchase_cost = 0, treat as unknown: use invoice_unit_price as effective cost
-- so commission shows as 0 (break-even) rather than inflated profit.
CREATE VIEW v_purchase_economics AS
SELECT 
    p.id AS purchase_id,
    p.created_at AS purchase_date,
    p.item_id,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.purchase_cost,
        CASE WHEN p.purchase_cost = 0 AND p.invoice_unit_price IS NOT NULL
            THEN p.quantity * p.invoice_unit_price
      ELSE p.quantity * p.purchase_cost
    END AS total_cost,
        p.invoice_unit_price,
        p.quantity * p.invoice_unit_price AS total_selling,
    CASE WHEN p.purchase_cost = 0 THEN 0
            ELSE p.invoice_unit_price - p.purchase_cost
    END AS unit_commission,
    CASE WHEN p.purchase_cost = 0 THEN 0
            ELSE p.quantity * (p.invoice_unit_price - p.purchase_cost)
    END AS total_commission,
        CASE WHEN p.purchase_cost = 0 AND p.invoice_unit_price IS NOT NULL
            THEN p.quantity * p.invoice_unit_price * 0.13
      ELSE p.quantity * p.purchase_cost * 0.13
    END AS tax_paid,
    CASE WHEN p.purchase_cost = 0 THEN 0
            WHEN p.invoice_unit_price IS NOT NULL
                THEN p.quantity * (p.invoice_unit_price - p.purchase_cost) * 0.13
      ELSE 0
    END AS tax_owed,
    p.status,
    p.delivery_date,
    p.invoice_id,
    p.receipt_id,
    r.receipt_number,
    inv.invoice_number,
    p.notes
FROM purchases p
JOIN items i ON i.id = p.item_id
LEFT JOIN receipts r ON r.id = p.receipt_id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN destinations d ON d.id = p.destination_id
LEFT JOIN invoices inv ON inv.id = p.invoice_id;

-- Invoice reconciliation
CREATE VIEW v_invoice_reconciliation AS
SELECT 
    inv.id AS invoice_id,
    inv.invoice_number,
    d.code AS destination_code,
    d.name AS destination_name,
    inv.invoice_date,
    inv.subtotal AS invoice_total,
    COALESCE(SUM(p.quantity * COALESCE(p.invoice_unit_price, p.purchase_cost)), 0) AS purchases_total,
    inv.subtotal - COALESCE(SUM(p.quantity * COALESCE(p.invoice_unit_price, p.purchase_cost)), 0) AS difference,
    ABS(inv.subtotal - COALESCE(SUM(p.quantity * COALESCE(p.invoice_unit_price, p.purchase_cost)), 0)) < 0.01 AS is_matched,
    COUNT(p.id) AS purchase_count,
    COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_cost,
    COALESCE(SUM(p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission
FROM invoices inv
JOIN destinations d ON d.id = inv.destination_id
LEFT JOIN purchases p ON p.invoice_id = inv.id
GROUP BY inv.id, inv.invoice_number, d.code, d.name, inv.invoice_date, inv.subtotal;

-- Destination summary (with zero-cost guard logic)
CREATE VIEW v_destination_summary AS
SELECT 
    d.id AS destination_id,
    d.code AS destination_code,
    d.name AS destination_name,
    (SELECT COUNT(*) FROM invoices WHERE destination_id = d.id) AS total_invoices,
    (SELECT COUNT(*) FROM purchases WHERE destination_id = d.id) AS total_purchases,
    (SELECT COALESCE(SUM(quantity), 0) FROM purchases WHERE destination_id = d.id) AS total_quantity,
    (SELECT COALESCE(SUM(
                CASE WHEN purchase_cost = 0 AND invoice_unit_price IS NOT NULL
                    THEN quantity * invoice_unit_price
          ELSE quantity * purchase_cost
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_cost,
        (SELECT COALESCE(SUM(quantity * COALESCE(invoice_unit_price, purchase_cost)), 0) FROM purchases WHERE destination_id = d.id) AS total_revenue,
    (SELECT COALESCE(SUM(
        CASE WHEN purchase_cost = 0 THEN 0
                    ELSE quantity * (COALESCE(invoice_unit_price, purchase_cost) - purchase_cost)
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_commission,
    (SELECT COALESCE(SUM(
                CASE WHEN purchase_cost = 0 AND invoice_unit_price IS NOT NULL
                    THEN quantity * invoice_unit_price * 0.13
          ELSE quantity * purchase_cost * 0.13
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_paid,
    (SELECT COALESCE(SUM(
        CASE WHEN purchase_cost = 0 THEN 0
                    WHEN invoice_unit_price IS NOT NULL
                        THEN quantity * (invoice_unit_price - purchase_cost) * 0.13
          ELSE 0
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_owed
FROM destinations d;

-- Vendor summary (receipts-based — a vendor's purchases come through their receipts)
CREATE VIEW v_vendor_summary AS
SELECT 
    v.id AS vendor_id,
    v.name AS vendor_name,
    COUNT(DISTINCT r.id) AS total_receipts,
    COUNT(DISTINCT p.id) AS total_purchases,
    COALESCE(SUM(p.quantity), 0) AS total_quantity,
    COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_spent
FROM vendors v
LEFT JOIN receipts r ON r.vendor_id = v.id
LEFT JOIN purchases p ON p.receipt_id = r.id
GROUP BY v.id, v.name;

-- Receipt reconciliation
CREATE VIEW v_receipt_reconciliation AS
SELECT
    r.id AS receipt_id,
    r.receipt_number,
    v.name AS vendor_name,
    r.receipt_date,
    r.subtotal AS receipt_subtotal,
    COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS purchases_total,
    r.subtotal - COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS difference,
    ABS(r.subtotal - COALESCE(SUM(p.quantity * p.purchase_cost), 0)) < 0.01 AS is_matched,
    COUNT(p.id) AS purchase_count,
    COUNT(p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AS invoiced_count,
    COUNT(p.id) = COUNT(p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AND COUNT(p.id) > 0 AS all_invoiced,
    COALESCE(SUM(p.quantity * COALESCE(p.invoice_unit_price, 0)), 0) AS total_selling,
    COALESCE(SUM(p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission
FROM receipts r
JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN purchases p ON p.receipt_id = r.id
GROUP BY r.id, r.receipt_number, v.name, r.receipt_date, r.subtotal;

-- ============================================
-- Indexes
-- ============================================

CREATE INDEX idx_purchases_item ON purchases(item_id);
CREATE INDEX idx_purchases_receipt ON purchases(receipt_id);
CREATE INDEX idx_purchases_invoice ON purchases(invoice_id);
CREATE INDEX idx_purchases_destination ON purchases(destination_id);
CREATE INDEX idx_purchases_status ON purchases(status);
CREATE INDEX idx_purchases_created ON purchases(created_at);

CREATE INDEX idx_receipts_vendor ON receipts(vendor_id);
CREATE INDEX idx_receipts_number ON receipts(receipt_number);
CREATE INDEX idx_receipts_date ON receipts(receipt_date);
CREATE INDEX idx_vendor_import_aliases_vendor ON vendor_import_aliases(vendor_id);

CREATE INDEX idx_invoices_destination ON invoices(destination_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);

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
CREATE TRIGGER update_vendor_import_aliases_updated_at BEFORE UPDATE ON vendor_import_aliases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_destinations_updated_at BEFORE UPDATE ON destinations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_items_updated_at BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_receipts_updated_at BEFORE UPDATE ON receipts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_purchases_updated_at BEFORE UPDATE ON purchases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Helper Functions
-- ============================================

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

INSERT INTO destinations (code, name, is_active) VALUES
    ('CBG', 'Canada Buying Group', TRUE),
    ('BSC', 'Bulk Supply Co', TRUE);

INSERT INTO vendors (name) VALUES
    ('Best Buy'),
    ('Amazon'),
    ('Staples'),
    ('Canada Computers'),
    ('Walmart');
