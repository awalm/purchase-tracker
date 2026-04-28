-- BG Tracker Schema Upgrade
-- Safe to run on ANY version of the database. Adds what's missing, skips what exists.
-- This file runs on every startup via start.sh.
--
-- Handles: item model cleanup (drop vendor_id, start_date, end_date, purchase_cost),
-- view recreation (v_active_items, v_purchase_economics, v_vendor_summary,
-- v_destination_summary, v_receipt_reconciliation) with zero-cost guard logic.

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

-- ============================================
-- VENDOR SHORT ID (for receipt number prefixes)
-- ============================================
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS short_id VARCHAR(20);

UPDATE vendors
SET short_id = COALESCE(
  short_id,
  NULLIF(
    UPPER(REGEXP_REPLACE(name, '[^A-Za-z0-9]+', '', 'g')),
    ''
  )
)
WHERE short_id IS NULL;

UPDATE vendors
SET short_id = SUBSTRING(short_id FROM 1 FOR 20)
WHERE short_id IS NOT NULL
  AND LENGTH(short_id) > 20;

CREATE TABLE IF NOT EXISTS vendor_import_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_alias VARCHAR(255) NOT NULL UNIQUE,
  raw_alias VARCHAR(255) NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_import_aliases_vendor
  ON vendor_import_aliases(vendor_id);

DROP TRIGGER IF EXISTS update_vendor_import_aliases_updated_at ON vendor_import_aliases;
CREATE TRIGGER update_vendor_import_aliases_updated_at
BEFORE UPDATE ON vendor_import_aliases
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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

-- Ensure invoice unit price column naming is normalized pre-release.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'purchases' AND column_name = 'selling_price'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'purchases' AND column_name = 'invoice_unit_price'
  ) THEN
    ALTER TABLE purchases RENAME COLUMN selling_price TO invoice_unit_price;
  END IF;
END $$;

-- Keep invoice pricing consistent with invoice linkage.
-- If an invoice link is removed, invoice_unit_price must be NULL.
UPDATE purchases
SET invoice_unit_price = NULL
WHERE invoice_id IS NULL
  AND invoice_unit_price IS NOT NULL;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS allow_receipt_date_override BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================
-- INVOICE RECONCILIATION STATE
-- ============================================
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS reconciliation_state VARCHAR(32) NOT NULL DEFAULT 'open';

UPDATE invoices
SET reconciliation_state = 'open'
WHERE reconciliation_state IS NULL
   OR reconciliation_state NOT IN ('open', 'in_review', 'reconciled', 'locked', 'reopened');

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_reconciliation_state_chk;

DO $$ BEGIN
  ALTER TABLE invoices
    ADD CONSTRAINT invoices_reconciliation_state_chk
    CHECK (reconciliation_state IN ('open', 'in_review', 'reconciled', 'locked', 'reopened'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- INVOICE DELIVERY DATE
-- ============================================
-- delivery_date defaults to invoice_date for existing rows.
-- Used as the receipt date cutoff for auto-allocation instead of invoice_date.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS delivery_date DATE;

UPDATE invoices
SET delivery_date = invoice_date
WHERE delivery_date IS NULL;

-- ============================================
-- PURCHASE ALLOCATIONS (Phase 1)
-- Keep invoice lines intact while allocating qty/cost to one or more receipts.
-- ============================================

CREATE TABLE IF NOT EXISTS purchase_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  allocated_qty INTEGER NOT NULL CHECK (allocated_qty > 0),
  unit_cost DECIMAL(10, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_allocations_purchase ON purchase_allocations(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_allocations_receipt ON purchase_allocations(receipt_id);

DROP TRIGGER IF EXISTS update_purchase_allocations_updated_at ON purchase_allocations;
CREATE TRIGGER update_purchase_allocations_updated_at
BEFORE UPDATE ON purchase_allocations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- RECEIPT LINE ITEMS (Phase 2)
-- Source-of-truth lines for qty/cost on each receipt.
-- ============================================

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ingestion_metadata JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipts'
      AND column_name = 'payment_card_last4'
  ) THEN
    EXECUTE 'UPDATE receipts
             SET payment_method = COALESCE(payment_method, payment_card_last4)
             WHERE payment_method IS NULL';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS receipt_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost DECIMAL(10, 4) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (receipt_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_receipt_line_items_receipt ON receipt_line_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_item ON receipt_line_items(item_id);

DROP TRIGGER IF EXISTS update_receipt_line_items_updated_at ON receipt_line_items;
CREATE TRIGGER update_receipt_line_items_updated_at
BEFORE UPDATE ON receipt_line_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE purchase_allocations
  ADD COLUMN IF NOT EXISTS receipt_line_item_id UUID REFERENCES receipt_line_items(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_purchase_allocations_receipt_line_item
  ON purchase_allocations(receipt_line_item_id);

-- Backfill receipt_line_items from legacy purchases linked directly to receipts.
-- Timestamp is derived from receipt/invoice date; if unknown, use obvious epoch sentinel.
INSERT INTO receipt_line_items (receipt_id, item_id, quantity, unit_cost, notes, created_at, updated_at)
SELECT
  p.receipt_id,
  p.item_id,
  SUM(p.quantity)::INT,
  CASE
    WHEN SUM(p.quantity) = 0 THEN MAX(p.purchase_cost)
    ELSE SUM((p.quantity::numeric) * p.purchase_cost) / NULLIF(SUM(p.quantity), 0)
  END,
  'legacy backfill',
  COALESCE(r.receipt_date::timestamptz, MIN(inv.invoice_date)::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
  COALESCE(r.receipt_date::timestamptz, MIN(inv.invoice_date)::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00')
FROM purchases p
LEFT JOIN receipts r ON r.id = p.receipt_id
LEFT JOIN invoices inv ON inv.id = p.invoice_id
WHERE p.receipt_id IS NOT NULL
GROUP BY p.receipt_id, p.item_id, r.receipt_date
ON CONFLICT (receipt_id, item_id) DO NOTHING;

-- Backfill allocation linkage to receipt_line_items and enforce receipt-derived unit_cost.
UPDATE purchase_allocations pa
SET receipt_line_item_id = rli.id,
    unit_cost = rli.unit_cost
FROM purchases p
JOIN receipt_line_items rli
  ON rli.item_id = p.item_id
WHERE pa.purchase_id = p.id
  AND rli.receipt_id = pa.receipt_id
  AND pa.receipt_line_item_id IS NULL;

-- Backfill missing allocation rows for legacy direct receipt-linked purchases
-- when mapping to receipt_line_items is unambiguous and capacity is available.
WITH candidate_allocations AS (
  SELECT
    p.id AS purchase_id,
    p.receipt_id,
    rli.id AS receipt_line_item_id,
    p.quantity AS allocated_qty,
    rli.unit_cost
  FROM purchases p
  JOIN receipt_line_items rli
    ON rli.receipt_id = p.receipt_id
   AND rli.item_id = p.item_id
  LEFT JOIN purchase_allocations existing
    ON existing.purchase_id = p.id
   AND existing.receipt_id = p.receipt_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pa_line.allocated_qty), 0)::INT AS allocated_on_line
    FROM purchase_allocations pa_line
    WHERE pa_line.receipt_line_item_id = rli.id
  ) line_alloc ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pa_purchase.allocated_qty), 0)::INT AS allocated_on_purchase
    FROM purchase_allocations pa_purchase
    WHERE pa_purchase.purchase_id = p.id
  ) purchase_alloc ON TRUE
  WHERE p.receipt_id IS NOT NULL
    AND p.quantity > 0
    AND existing.id IS NULL
    AND purchase_alloc.allocated_on_purchase = 0
    AND (rli.quantity - line_alloc.allocated_on_line) >= p.quantity
)
INSERT INTO purchase_allocations (purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost)
SELECT purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost
FROM candidate_allocations
ON CONFLICT (purchase_id, receipt_id) DO NOTHING;

-- Keep receipt-linked purchase_cost aligned with receipt-derived allocation unit_cost.
UPDATE purchases p
SET purchase_cost = pa.unit_cost
FROM purchase_allocations pa
WHERE p.id = pa.purchase_id
  AND p.receipt_id IS NOT NULL
  AND pa.receipt_id = p.receipt_id
  AND p.purchase_cost IS DISTINCT FROM pa.unit_cost;

-- 9. Recreate v_purchase_economics
-- Vendor now comes from the receipt (LEFT JOIN), not the item.
-- vendor_name is NULL when no receipt is linked.
-- When purchase_cost = 0, treat it as unknown: use invoice_unit_price as effective cost
-- so commission shows as 0 (break-even) rather than inflated profit.
CREATE OR REPLACE VIEW v_purchase_economics AS
SELECT 
    p.id AS purchase_id,
  COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS purchase_date,
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
    COALESCE(SUM(p.quantity * COALESCE(p.invoice_unit_price, 0)), 0) AS total_selling,
    COALESCE(SUM(p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission
FROM receipts r
JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN purchases p ON p.receipt_id = r.id
GROUP BY r.id, r.receipt_number, v.name, r.receipt_date, r.subtotal;

-- ============================================
-- BONUS ATTRIBUTION
-- ============================================
-- A bonus purchase can optionally be attributed to a parent (unit) purchase.
-- When set, the bonus's selling value boosts the parent's commission and the
-- bonus row itself shows zero commission (no double-counting).
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS bonus_for_purchase_id UUID REFERENCES purchases(id);

CREATE INDEX IF NOT EXISTS idx_purchases_bonus_for_purchase
  ON purchases(bonus_for_purchase_id) WHERE bonus_for_purchase_id IS NOT NULL;

-- ============================================
-- DESTINATION SUMMARY: Zero-cost guard logic
-- ============================================
-- When purchase_cost = 0, use invoice_unit_price as effective cost (break-even)
-- so commission/tax calculations stay consistent with v_purchase_economics.
CREATE OR REPLACE VIEW v_destination_summary AS
SELECT 
    d.id AS destination_id,
    d.code AS destination_code,
    d.name AS destination_name,
    (SELECT COUNT(*) FROM invoices WHERE destination_id = d.id) AS total_invoices,
    (SELECT COUNT(*) FROM purchases WHERE destination_id = d.id) AS total_purchases,
    (SELECT COALESCE(SUM(quantity), 0) FROM purchases WHERE destination_id = d.id) AS total_quantity,
    (SELECT COALESCE(SUM(
        CASE WHEN purchase_type = 'bonus' THEN 0
          WHEN purchase_cost = 0 AND invoice_unit_price IS NOT NULL
            THEN quantity * invoice_unit_price
          ELSE quantity * purchase_cost
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_cost,
    (SELECT COALESCE(SUM(quantity * COALESCE(invoice_unit_price, purchase_cost)), 0) FROM purchases WHERE destination_id = d.id) AS total_revenue,
    (SELECT COALESCE(SUM(
        CASE WHEN bonus_for_purchase_id IS NOT NULL THEN 0
          WHEN purchase_type = 'bonus'
            THEN quantity * COALESCE(invoice_unit_price, 0)
          WHEN purchase_cost = 0 THEN 0
          ELSE quantity * (COALESCE(invoice_unit_price, purchase_cost) - purchase_cost)
               + COALESCE((SELECT SUM(b.quantity * COALESCE(b.invoice_unit_price, 0))
                           FROM purchases b
                           WHERE b.bonus_for_purchase_id = purchases.id
                             AND b.purchase_type = 'bonus'), 0)
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_commission,
    (SELECT COALESCE(SUM(
        CASE WHEN purchase_type = 'bonus' THEN 0
          WHEN purchase_cost = 0 AND invoice_unit_price IS NOT NULL
            THEN quantity * invoice_unit_price * 0.13
          ELSE quantity * purchase_cost * 0.13
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_paid,
    (SELECT COALESCE(SUM(
        CASE WHEN bonus_for_purchase_id IS NOT NULL THEN 0
          WHEN purchase_type = 'bonus'
            THEN quantity * COALESCE(invoice_unit_price, 0) * 0.13
          WHEN purchase_cost = 0 THEN 0
          WHEN invoice_unit_price IS NOT NULL
            THEN (quantity * (invoice_unit_price - purchase_cost)
                 + COALESCE((SELECT SUM(b.quantity * COALESCE(b.invoice_unit_price, 0))
                             FROM purchases b
                             WHERE b.bonus_for_purchase_id = purchases.id
                               AND b.purchase_type = 'bonus'), 0)) * 0.13
          ELSE 0
        END
    ), 0) FROM purchases WHERE destination_id = d.id) AS total_tax_owed
FROM destinations d;

-- ============================================
-- RECEIPT LINE ITEM PARENT/CHILD (for fees attached to products)
-- ============================================
ALTER TABLE receipt_line_items
  ADD COLUMN IF NOT EXISTS parent_line_item_id UUID REFERENCES receipt_line_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_receipt_line_items_parent
  ON receipt_line_items(parent_line_item_id) WHERE parent_line_item_id IS NOT NULL;

-- ============================================
-- RECEIPT NUMBER UNIQUENESS
-- ============================================
-- Enforce unique receipt_number when existing data allows it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT receipt_number
      FROM receipts
      WHERE receipt_number IS NOT NULL
      GROUP BY receipt_number
      HAVING COUNT(*) > 1
    ) dupes
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_number_unique ON receipts(receipt_number);
  END IF;
END $$;

-- ============================================
-- REFUND / CREDIT PURCHASE LINKING
-- ============================================
-- A credit purchase (negative qty) can reference the original purchase it refunds.
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS refunds_purchase_id UUID REFERENCES purchases(id);

CREATE INDEX IF NOT EXISTS idx_purchases_refunds_purchase
  ON purchases(refunds_purchase_id) WHERE refunds_purchase_id IS NOT NULL;

-- ============================================
-- PURCHASE TYPE (unit / bonus / refund)
-- ============================================
-- unit   = standard physical purchase, counts toward inventory
-- bonus  = promotional freebie, in economics but not unit counts
-- refund = credit/return
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS purchase_type TEXT NOT NULL DEFAULT 'unit';

-- Recreate v_purchase_economics with purchase_type + bonus attribution
CREATE OR REPLACE VIEW v_purchase_economics AS
WITH bonus_sums AS (
    SELECT bonus_for_purchase_id AS parent_id,
           SUM(quantity * COALESCE(invoice_unit_price, 0)) AS bonus_selling
    FROM purchases
    WHERE purchase_type = 'bonus' AND bonus_for_purchase_id IS NOT NULL
    GROUP BY bonus_for_purchase_id
)
SELECT 
    p.id AS purchase_id,
    COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS purchase_date,
    p.item_id,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.purchase_cost,
    CASE WHEN p.purchase_type = 'bonus' THEN 0
      WHEN p.purchase_cost = 0 AND p.invoice_unit_price IS NOT NULL
        THEN p.quantity * p.invoice_unit_price
      ELSE p.quantity * p.purchase_cost
    END AS total_cost,
    p.invoice_unit_price,
    -- total_selling: own selling + attributed bonus selling (not for attributed bonuses)
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL
        THEN p.quantity * p.invoice_unit_price
      ELSE p.quantity * p.invoice_unit_price + COALESCE(bs.bonus_selling, 0)
    END AS total_selling,
    -- unit_commission: attributed bonus → 0; standalone bonus → full price; normal → own + bonus boost
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN COALESCE(p.invoice_unit_price, 0)
      WHEN p.purchase_cost = 0 THEN 0
      ELSE (p.invoice_unit_price - p.purchase_cost)
           + COALESCE(bs.bonus_selling, 0) / NULLIF(p.quantity, 0)::numeric
    END AS unit_commission,
    -- total_commission: attributed bonus → 0; standalone bonus → full; normal → own + bonus
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN p.quantity * COALESCE(p.invoice_unit_price, 0)
      WHEN p.purchase_cost = 0 THEN 0
      ELSE p.quantity * (p.invoice_unit_price - p.purchase_cost)
           + COALESCE(bs.bonus_selling, 0)
    END AS total_commission,
    CASE WHEN p.purchase_type = 'bonus' THEN 0
      WHEN p.purchase_cost = 0 AND p.invoice_unit_price IS NOT NULL
        THEN p.quantity * p.invoice_unit_price * 0.13
      ELSE p.quantity * p.purchase_cost * 0.13
    END AS tax_paid,
    -- tax_owed: attributed bonus → 0; standalone bonus → on commission; normal → on commission + bonus
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN p.quantity * COALESCE(p.invoice_unit_price, 0) * 0.13
      WHEN p.purchase_cost = 0 THEN 0
      WHEN p.invoice_unit_price IS NOT NULL
        THEN (p.quantity * (p.invoice_unit_price - p.purchase_cost)
             + COALESCE(bs.bonus_selling, 0)) * 0.13
      ELSE 0
    END AS tax_owed,
    p.status,
    p.delivery_date,
    p.invoice_id,
    p.receipt_id,
    r.receipt_number,
    inv.invoice_number,
    p.notes,
    p.purchase_type,
    inv.reconciliation_state AS invoice_reconciliation_state
FROM purchases p
LEFT JOIN bonus_sums bs ON bs.parent_id = p.id
JOIN items i ON i.id = p.item_id
LEFT JOIN receipts r ON r.id = p.receipt_id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN destinations d ON d.id = p.destination_id
LEFT JOIN invoices inv ON inv.id = p.invoice_id;

-- ================================================================
-- Add tax_amount column to receipts (store dollar amount, not rate)
-- ================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'tax_amount'
  ) THEN
    ALTER TABLE receipts ADD COLUMN tax_amount DECIMAL(12, 4);
    UPDATE receipts SET tax_amount = total - subtotal;
    ALTER TABLE receipts ALTER COLUMN tax_amount SET NOT NULL;
    ALTER TABLE receipts ALTER COLUMN tax_amount SET DEFAULT 0;
  END IF;
END $$;

-- Add CHECK constraint: subtotal + tax_amount ≈ total
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_receipts_tax_amount_total'
  ) THEN
    ALTER TABLE receipts ADD CONSTRAINT chk_receipts_tax_amount_total
      CHECK (ABS(subtotal + tax_amount - total) <= 0.02);
  END IF;
END $$;

-- ================================================================
-- Drop tax_rate from receipts (redundant — derived from tax_amount/subtotal)
-- ================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'tax_rate'
  ) THEN
    ALTER TABLE receipts DROP COLUMN tax_rate;
  END IF;
END $$;

-- ================================================================
-- Add tax_amount to invoices and enforce subtotal + tax_amount = total
-- ================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'tax_amount'
  ) THEN
    ALTER TABLE invoices ADD COLUMN tax_amount DECIMAL(12, 4);
    UPDATE invoices SET tax_amount = total - subtotal;
    ALTER TABLE invoices ALTER COLUMN tax_amount SET NOT NULL;
    ALTER TABLE invoices ALTER COLUMN tax_amount SET DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_tax_amount_total'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_tax_amount_total
      CHECK (ABS(subtotal + tax_amount - total) <= 0.02);
  END IF;
END $$;

-- ============================================
-- RECEIPT LINE ITEM STATE (returned/damaged support)
-- ============================================
ALTER TABLE receipt_line_items
  ADD COLUMN IF NOT EXISTS state VARCHAR(20) NOT NULL DEFAULT 'active';

-- Add check constraint if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_receipt_line_items_state'
  ) THEN
    ALTER TABLE receipt_line_items ADD CONSTRAINT chk_receipt_line_items_state
      CHECK (state IN ('active', 'returned', 'damaged'));
  END IF;
END $$;

-- ============================================
-- COST ADJUSTMENT (per-unit economics correction)
-- ============================================
-- Allows redistributing promotional/bundle discounts across purchases.
-- purchase_cost stays as-is (matches actual receipt); economics use purchase_cost + cost_adjustment.
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS cost_adjustment DECIMAL(10, 4) NOT NULL DEFAULT 0;
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS adjustment_note TEXT;

-- Recreate v_purchase_economics with cost_adjustment support
DROP VIEW IF EXISTS v_purchase_economics;
CREATE VIEW v_purchase_economics AS
WITH bonus_sums AS (
    SELECT bonus_for_purchase_id AS parent_id,
           SUM(quantity * COALESCE(invoice_unit_price, 0)) AS bonus_selling
    FROM purchases
    WHERE purchase_type = 'bonus' AND bonus_for_purchase_id IS NOT NULL
    GROUP BY bonus_for_purchase_id
)
SELECT 
    p.id AS purchase_id,
    COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS purchase_date,
    p.item_id,
    i.name AS item_name,
    v.name AS vendor_name,
    d.code AS destination_code,
    p.quantity,
    p.purchase_cost,
    p.cost_adjustment,
    p.adjustment_note,
    CASE WHEN p.purchase_type = 'bonus' THEN 0
      WHEN (p.purchase_cost + p.cost_adjustment) = 0 AND p.invoice_unit_price IS NOT NULL
        THEN p.quantity * p.invoice_unit_price
      ELSE p.quantity * (p.purchase_cost + p.cost_adjustment)
    END AS total_cost,
    p.invoice_unit_price,
    -- total_selling: own selling + attributed bonus selling (not for attributed bonuses)
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL
        THEN p.quantity * p.invoice_unit_price
      ELSE p.quantity * p.invoice_unit_price + COALESCE(bs.bonus_selling, 0)
    END AS total_selling,
    -- unit_commission: attributed bonus → 0; standalone bonus → full price; normal → own + bonus boost
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN COALESCE(p.invoice_unit_price, 0)
      WHEN (p.purchase_cost + p.cost_adjustment) = 0 THEN 0
      ELSE (p.invoice_unit_price - (p.purchase_cost + p.cost_adjustment))
           + COALESCE(bs.bonus_selling, 0) / NULLIF(p.quantity, 0)::numeric
    END AS unit_commission,
    -- total_commission: attributed bonus → 0; standalone bonus → full; normal → own + bonus
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN p.quantity * COALESCE(p.invoice_unit_price, 0)
      WHEN (p.purchase_cost + p.cost_adjustment) = 0 THEN 0
      ELSE p.quantity * (p.invoice_unit_price - (p.purchase_cost + p.cost_adjustment))
           + COALESCE(bs.bonus_selling, 0)
    END AS total_commission,
    CASE WHEN p.purchase_type = 'bonus' THEN 0
      WHEN (p.purchase_cost + p.cost_adjustment) = 0 AND p.invoice_unit_price IS NOT NULL
        THEN p.quantity * p.invoice_unit_price * 0.13
      ELSE p.quantity * (p.purchase_cost + p.cost_adjustment) * 0.13
    END AS tax_paid,
    -- tax_owed: attributed bonus → 0; standalone bonus → on commission; normal → on commission + bonus
    CASE WHEN p.bonus_for_purchase_id IS NOT NULL THEN 0
      WHEN p.purchase_type = 'bonus'
        THEN p.quantity * COALESCE(p.invoice_unit_price, 0) * 0.13
      WHEN (p.purchase_cost + p.cost_adjustment) = 0 THEN 0
      WHEN p.invoice_unit_price IS NOT NULL
        THEN (p.quantity * (p.invoice_unit_price - (p.purchase_cost + p.cost_adjustment))
             + COALESCE(bs.bonus_selling, 0)) * 0.13
      ELSE 0
    END AS tax_owed,
    p.status,
    p.delivery_date,
    p.invoice_id,
    p.receipt_id,
    r.receipt_number,
    inv.invoice_number,
    p.notes,
    p.purchase_type,
    inv.reconciliation_state AS invoice_reconciliation_state
FROM purchases p
LEFT JOIN bonus_sums bs ON bs.parent_id = p.id
JOIN items i ON i.id = p.item_id
LEFT JOIN receipts r ON r.id = p.receipt_id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN destinations d ON d.id = p.destination_id
LEFT JOIN invoices inv ON inv.id = p.invoice_id;

-- ============================================
-- RECEIPT LINE ITEM ADJUSTMENTS (cost correction lines)
-- ============================================
-- Allows adding discount/promo lines on receipts that flow into
-- purchase cost_adjustment. Mirrors how invoice bonuses work.

-- Add line_type column: 'item' (default) | 'adjustment'
ALTER TABLE receipt_line_items
  ADD COLUMN IF NOT EXISTS line_type VARCHAR(20) NOT NULL DEFAULT 'item';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_receipt_line_items_line_type'
  ) THEN
    ALTER TABLE receipt_line_items ADD CONSTRAINT chk_receipt_line_items_line_type
      CHECK (line_type IN ('item', 'adjustment'));
  END IF;
END $$;

-- Relax the unique constraint: only enforce for root lines (no parent).
-- Child lines (fees, adjustments) can reference the same item.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'receipt_line_items_receipt_id_item_id_key'
  ) THEN
    ALTER TABLE receipt_line_items DROP CONSTRAINT receipt_line_items_receipt_id_item_id_key;
  END IF;
END $$;

-- Recreate unique index with state so active + returned lines for the same item can coexist
DROP INDEX IF EXISTS receipt_line_items_receipt_item_root_unique;
CREATE UNIQUE INDEX receipt_line_items_receipt_item_root_unique
  ON receipt_line_items(receipt_id, item_id, state)
  WHERE parent_line_item_id IS NULL AND line_type = 'item';

-- Fix child receipt lines that were created before line_type feature
UPDATE receipt_line_items
SET line_type = 'adjustment'
WHERE parent_line_item_id IS NOT NULL
  AND line_type = 'item';

-- Prevent allocations to adjustment/child receipt line items at DB level
CREATE OR REPLACE FUNCTION trg_check_allocation_line_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.receipt_line_item_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM receipt_line_items
      WHERE id = NEW.receipt_line_item_id
        AND (line_type <> 'item' OR parent_line_item_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Cannot allocate to adjustment or child receipt line items';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_allocation_line_type ON purchase_allocations;
CREATE TRIGGER check_allocation_line_type
  BEFORE INSERT OR UPDATE ON purchase_allocations
  FOR EACH ROW
  EXECUTE FUNCTION trg_check_allocation_line_type();

-- ============================================
-- SINGLE SOURCE OF TRUTH: allocation effective costs
-- Accounts for adjustment children on receipt line items.
-- ALL economics queries must use this view instead of raw purchase_allocations math.
-- ============================================
CREATE OR REPLACE VIEW v_allocation_costs AS
SELECT
    pa.id AS allocation_id,
    pa.purchase_id,
    pa.receipt_id,
    pa.receipt_line_item_id,
    pa.allocated_qty,
    pa.unit_cost AS raw_unit_cost,
    pa.unit_cost + COALESCE(adj.per_unit_adjustment, 0) AS effective_unit_cost,
    pa.allocated_qty * (pa.unit_cost + COALESCE(adj.per_unit_adjustment, 0)) AS effective_allocated_cost,
    pa.created_at,
    pa.updated_at
FROM purchase_allocations pa
LEFT JOIN LATERAL (
    SELECT
        CASE WHEN rli.quantity > 0
             THEN SUM(child.unit_cost * child.quantity) / rli.quantity
             ELSE 0
        END AS per_unit_adjustment
    FROM receipt_line_items child
    JOIN receipt_line_items rli ON rli.id = child.parent_line_item_id
    WHERE child.parent_line_item_id = pa.receipt_line_item_id
      AND child.line_type = 'adjustment'
    GROUP BY rli.quantity
) adj ON TRUE;

-- ============================================
-- MANUAL PURCHASE GROUPING (display_parent_purchase_id)
-- ============================================
-- Allows manually nesting any purchase under another for organizational display.
-- Purely visual grouping — does not affect economics.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS display_parent_purchase_id UUID REFERENCES purchases(id);

-- ============================================
-- NAMED DISPLAY GROUPS (display_group)
-- ============================================
-- Allows organizing purchases into arbitrary named sections for display.
-- Purely visual — does not affect economics.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS display_group VARCHAR(100);
