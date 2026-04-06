-- BG Tracker Schema Upgrade
-- Safe to run on ANY version of the database. Adds what's missing, skips what exists.
-- This file runs on every startup via start.sh.
--
-- As of 2026-03-08, the initial schema (001_initial_schema.sql) is canonical and
-- includes all tables (vendors, destinations, items, receipts, invoices, purchases,
-- users, audit_log) plus all views and indexes. This file is reserved for future
-- incremental upgrades only.

-- ============================================
-- ITEM MODEL CLEANUP (Phase 1): Remove start_date, end_date, purchase_cost
-- ============================================

-- 1. Drop views that depend on items columns
DROP VIEW IF EXISTS v_active_items;
DROP VIEW IF EXISTS v_purchase_economics;
DROP VIEW IF EXISTS v_vendor_summary;

-- 2. Drop the GiST exclusion constraint and related index
DO $$ BEGIN
  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_name_vendor_id_daterange_excl;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DROP INDEX IF EXISTS idx_items_end_date;

-- 3. Drop the columns
ALTER TABLE items DROP COLUMN IF EXISTS purchase_cost;
ALTER TABLE items DROP COLUMN IF EXISTS start_date;
ALTER TABLE items DROP COLUMN IF EXISTS end_date;

-- 4. Drop the old is_item_valid function (used start_date/end_date)
DROP FUNCTION IF EXISTS is_item_valid(UUID, DATE);

-- ============================================
-- ITEM MODEL CLEANUP (Phase 2): Remove vendor_id from items
-- Items are pure catalog entries: name + destination + notes
-- An item is an item — vendor comes from receipts/purchases, not the item itself.
-- ============================================

-- 5. Drop constraints that reference vendor_id on items
DO $$ BEGIN
  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_name_vendor_id_unique;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_vendor_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- 6. Drop vendor_id column
ALTER TABLE items DROP COLUMN IF EXISTS vendor_id;

-- 7. Add unique constraint on name alone
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_name_unique UNIQUE (name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- 8. Recreate v_active_items (simple: items + default destination)
CREATE OR REPLACE VIEW v_active_items AS
SELECT
    i.id,
    i.name,
    i.default_destination_id,
    d.code AS default_destination_code,
    i.notes,
    i.created_at
FROM items i
LEFT JOIN destinations d ON d.id = i.default_destination_id;

-- 9. Recreate v_purchase_economics
-- Vendor now comes from the receipt (LEFT JOIN), not the item.
-- vendor_name is NULL when no receipt is linked.
-- When purchase_cost = 0, treat it as unknown: use selling_price as effective cost
-- so commission shows as 0 (break-even) rather than inflated profit.
CREATE OR REPLACE VIEW v_purchase_economics AS
SELECT 
    p.id AS purchase_id,
    p.created_at AS purchase_date,
    p.item_id,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.purchase_cost,
    CASE WHEN p.purchase_cost = 0 AND p.selling_price IS NOT NULL
      THEN p.quantity * p.selling_price
      ELSE p.quantity * p.purchase_cost
    END AS total_cost,
    p.selling_price,
    p.quantity * p.selling_price AS total_selling,
    CASE WHEN p.purchase_cost = 0 THEN 0
      ELSE p.selling_price - p.purchase_cost
    END AS unit_commission,
    CASE WHEN p.purchase_cost = 0 THEN 0
      ELSE p.quantity * (p.selling_price - p.purchase_cost)
    END AS total_commission,
    CASE WHEN p.purchase_cost = 0 AND p.selling_price IS NOT NULL
      THEN p.quantity * p.selling_price * 0.13
      ELSE p.quantity * p.purchase_cost * 0.13
    END AS tax_paid,
    CASE WHEN p.purchase_cost = 0 THEN 0
      WHEN p.selling_price IS NOT NULL
        THEN p.quantity * (p.selling_price - p.purchase_cost) * 0.13
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

-- 10. Recreate v_vendor_summary
-- Now based on receipts, not items. A vendor's purchases come through their receipts.
CREATE OR REPLACE VIEW v_vendor_summary AS
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

-- Receipt reconciliation view (mirrors v_invoice_reconciliation)
-- A receipt is reconciled when:
--   1. SUM(qty * purchase_cost) matches receipt.subtotal
--   2. All purchases have an invoice linked
DROP VIEW IF EXISTS v_receipt_reconciliation;
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
    COALESCE(SUM(p.quantity * COALESCE(p.selling_price, 0)), 0) AS total_selling,
    COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission
FROM receipts r
JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN purchases p ON p.receipt_id = r.id
GROUP BY r.id, r.receipt_number, v.name, r.receipt_date, r.subtotal;
