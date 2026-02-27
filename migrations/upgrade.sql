-- BG Tracker Schema Upgrade
-- Safe to run on ANY version of the database. Adds what's missing, skips what exists.
-- This file runs on every startup via start.sh and on restore via restore.sh.

-- Add subtotal/tax_rate/pdf columns to invoices (added 2026-02-18)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='subtotal') THEN
    ALTER TABLE invoices ADD COLUMN subtotal NUMERIC(12,4);
    UPDATE invoices SET subtotal = ROUND(total / 1.13, 4) WHERE subtotal IS NULL;
    ALTER TABLE invoices ALTER COLUMN subtotal SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='tax_rate') THEN
    ALTER TABLE invoices ADD COLUMN tax_rate NUMERIC(5,2) NOT NULL DEFAULT 13.00;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='original_pdf') THEN
    ALTER TABLE invoices ADD COLUMN original_pdf BYTEA;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='original_filename') THEN
    ALTER TABLE invoices ADD COLUMN original_filename VARCHAR(255);
  END IF;
END $$;

-- Remove payouts (removed 2026-02-19 - payout price is derived from invoices)
DO $$ BEGIN
  DROP VIEW IF EXISTS v_active_payouts CASCADE;
  DROP TABLE IF EXISTS payouts CASCADE;
  -- Recreate v_purchase_economics without payout join if it still has payout columns
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='v_purchase_economics' AND column_name='payout_price'
  ) THEN
    DROP VIEW IF EXISTS v_purchase_economics CASCADE;
    CREATE VIEW v_purchase_economics AS
    SELECT
      p.id AS purchase_id,
      p.created_at AS purchase_date,
      i.name AS item_name,
      v.name AS vendor_name,
      d.code AS destination_code,
      p.quantity,
      p.unit_cost,
      p.quantity * p.unit_cost AS total_cost,
      p.status,
      p.delivery_date,
      p.invoice_id
    FROM purchases p
    JOIN items i ON i.id = p.item_id
    JOIN vendors v ON v.id = i.vendor_id
    LEFT JOIN destinations d ON d.id = p.destination_id;
  END IF;
  -- Recreate v_destination_summary without total_profit if it still has it
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='v_destination_summary' AND column_name='total_profit'
  ) THEN
    DROP VIEW IF EXISTS v_destination_summary CASCADE;
    CREATE VIEW v_destination_summary AS
    SELECT
      d.id AS destination_id,
      d.code AS destination_code,
      d.name AS destination_name,
      (SELECT COUNT(*) FROM invoices WHERE destination_id = d.id) AS total_invoices,
      (SELECT COUNT(*) FROM purchases WHERE destination_id = d.id) AS total_purchases,
      (SELECT COALESCE(SUM(quantity), 0) FROM purchases WHERE destination_id = d.id) AS total_quantity,
      (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM purchases WHERE destination_id = d.id) AS total_cost
    FROM destinations d;
  END IF;
  -- Remove has_payout function
  DROP FUNCTION IF EXISTS has_payout(UUID, UUID, DATE);
END $$;

-- Future schema changes go here. Pattern:
-- DO $$ BEGIN
--   IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='...' AND column_name='...') THEN
--     ALTER TABLE ... ADD COLUMN ...;
--   END IF;
-- END $$;

-- Add selling_price to purchases (was unit_price, added 2026-02-18)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchases' AND column_name='unit_price')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchases' AND column_name='selling_price') THEN
    ALTER TABLE purchases ADD COLUMN selling_price NUMERIC(10,4);
  END IF;
END $$;

-- Rename columns for clarity (2026-02-20)
-- items.unit_cost → purchase_cost, purchases.unit_cost → purchase_cost, purchases.unit_price → selling_price
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='items' AND column_name='unit_cost') THEN
    ALTER TABLE items RENAME COLUMN unit_cost TO purchase_cost;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchases' AND column_name='unit_cost') THEN
    ALTER TABLE purchases RENAME COLUMN unit_cost TO purchase_cost;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchases' AND column_name='unit_price') THEN
    ALTER TABLE purchases RENAME COLUMN unit_price TO selling_price;
  END IF;
END $$;

-- Recreate ALL views with new column names and commission/tax economics
DO $$ BEGIN
  -- Active items view
  DROP VIEW IF EXISTS v_active_items CASCADE;
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

  -- Purchase economics with commission and tax tracking
  DROP VIEW IF EXISTS v_purchase_economics CASCADE;
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

  -- Invoice reconciliation with commission tracking
  DROP VIEW IF EXISTS v_invoice_reconciliation;
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

  -- Destination summary with commission and tax
  DROP VIEW IF EXISTS v_destination_summary CASCADE;
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

  -- Vendor summary
  DROP VIEW IF EXISTS v_vendor_summary CASCADE;
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
END $$;
