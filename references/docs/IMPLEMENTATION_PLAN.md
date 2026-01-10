# BG Tracker Implementation Plan

## Overview

A buying group tracking application replacing the current Excel-based system.

**Key Design Decisions:**
- **Single source of truth:** Tables store raw data only; all derived/computed data lives in VIEWs
- **Payout-driven workflow:** Payouts inform buying decisions
- **Catalog-first:** Items must exist before purchases
- **API-level audit logging:** All mutations tracked (audit_log partitioned monthly)
- **Two entity types:** Vendors (buy FROM) vs Destinations (sell/ship TO)
- **Business logic in Rust:** SQL helpers for validation only, decisions computed in application layer

---

## 1. Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | React + TypeScript + Vite | UI framework |
| **UI Components** | Shadcn/ui + Tailwind CSS | Component library |
| **Data Fetching** | TanStack Query | API calls, caching, loading states |
| **Tables** | TanStack Table | Data grids (sorting, filtering, pagination) |
| **Backend** | Rust + Axum | API server |
| **DB Access** | SQLx | Compile-time SQL verification |
| **Auth** | JWT + Argon2 | Authentication (backend only) |
| **Database** | PostgreSQL 15+ | Partitioning, financial data |

**Security:** React never accesses the database directly. All data flows through authenticated API endpoints.

**Data Import:** Export Excel sheets to CSV, then import via API. No Excel parsing library needed.

---

## 2. Business Workflow

```
1. Destination (CBG/BSC) publishes payout prices
2. You decide to buy items from Vendors based on profit margin
3. Items arrive → tracked with status (pending → delivered)
4. Items ship to Destination
5. Incoming invoice arrives from Vendor → reconciliation
```

### Entity Types

| Role | Examples | Table |
|------|----------|-------|
| **Vendor** (buy FROM) | Best Buy, Amazon, Staples, Canada Computers, Walmart | `vendors` |
| **Destination** (sell/ship TO) | CBG, BSC | `destinations` |

---

## 3. Database Schema

### 3.1 Entity Relationship Diagram

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   vendors   │     │  incoming_      │     │ destinations │
│─────────────│     │  invoices       │     │──────────────│
│ id (PK)     │◄────│─────────────────│     │ id (PK)      │
│ name        │     │ id (PK)         │     │ code         │
│ created_at  │     │ vendor_id (FK)  │     │ name         │
│ updated_at  │     │ invoice_number  │     │ is_active    │
└─────────────┘     │ order_number    │     │ created_at   │
                    │ invoice_date    │     │ updated_at   │
                    │ total           │     └──────────────┘
                    │ notes           │            ▲
                    │ created_at      │            │
                    │ updated_at      │            │
                    └────────┬────────┘            │
                             │                     │
                             ▼                     │
┌─────────────┐     ┌─────────────────┐     ┌──────┴───────┐
│   items     │     │   purchases     │     │   payouts    │
│─────────────│     │─────────────────│     │──────────────│
│ id (PK)     │◄────│ id (PK)         │     │ id (PK)      │
│ name        │     │ item_id (FK)    │     │ destination_ │
│ vendor_id   │     │ invoice_id (FK) │     │   id (FK)    │
│ unit_cost   │     │ quantity        │     │ item_id (FK) │
│ start_date  │     │ unit_cost       │     │ payout_price │
│ end_date    │     │ destination_id  │◄────┤ start_date   │
│ default_    │     │ status          │     │ end_date     │
│ destination │     │ delivery_date   │     │ notes        │
│ notes       │     │ notes           │     │ created_at   │
│ created_at  │     │ created_at      │     │ updated_at   │
│ updated_at  │     │ updated_at      │     └──────────────┘
└─────────────┘     └─────────────────┘

◄P► = Partitioned          VIEWS (derived data)
                    ┌─────────────────┐     ┌──────────────────┐
                    │ audit_log ◄P►   │     │ v_purchase_      │
                    │─────────────────│     │ economics        │
                    │ id (PK)         │     │──────────────────│
                    │ table_name      │     │ purchase_id      │
                    │ record_id       │     │ item_name        │
                    │ operation       │     │ vendor_name      │
                    │ old_data (JSONB)│     │ quantity         │
                    │ new_data (JSONB)│     │ unit_cost        │
                    │ user_id         │     │ payout_price     │
                    │ created_at ◄────┼─┐   │ unit_profit      │
                    └─────────────────┘ │   │ total_profit     │
                                        │   │ destination      │
                    partition key ──────┘   │ status           │
                                            └──────────────────┘
                                      
                                            ┌──────────────────┐
                                            │ v_invoice_       │
                                            │ reconciliation   │
                                            │──────────────────│
                                            │ invoice_id       │
                                            │ invoice_total    │
                                            │ purchases_total  │
                                            │ difference       │
                                            │ is_matched       │
                                            └──────────────────┘

                                            ┌──────────────────┐
                                            │ v_active_items   │
                                            │──────────────────│
                                            │ (items where     │
                                            │  end_date IS NULL│
                                            │  or >= today)    │
                                            └──────────────────┘

                                            ┌──────────────────┐
                                            │ v_active_payouts │
                                            │──────────────────│
                                            │ (payouts where   │
                                            │  end_date IS NULL│
                                            │  or >= today)    │
                                            └──────────────────┘
```

### 3.2 Partitioning Strategy

| Table | Partitioned? | Notes |
|-------|--------------|-------|
| `audit_log` | ✅ Yes (monthly) | Grows unbounded, perfect for partitioning |
| `purchases` | ❌ No (v1) | Can add later via `ATTACH PARTITION` |
| `incoming_invoices` | ❌ No (v1) | Can add later via `ATTACH PARTITION` |
| `items` | ❌ No | Small catalog |
| `payouts` | ❌ No | Uses date ranges |
| `vendors` | ❌ No | Tiny, static |
| `destinations` | ❌ No | Tiny, static |

### 3.3 Views (Derived Data)

| View | Purpose | Source Tables |
|------|---------|---------------|
| `v_purchase_economics` | Profit calculations per purchase | purchases, payouts, items |
| `v_invoice_reconciliation` | Invoice vs purchases matching | incoming_invoices, purchases |
| `v_active_items` | Currently valid items | items (filtered by date) |
| `v_active_payouts` | Currently valid payouts | payouts (filtered by date) |
| `v_destination_summary` | Totals by destination | purchases, destinations |

### 3.4 SQL Schema

```sql
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

-- Initial audit_log partitions
CREATE TABLE audit_log_2025_11 PARTITION OF audit_log
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE audit_log_2025_12 PARTITION OF audit_log
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE audit_log_2026_01 PARTITION OF audit_log
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

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
    SUM(p.quantity) AS total_quantity,
    SUM(p.quantity * p.unit_cost) AS total_cost,
    SUM(pe.total_profit) AS total_profit
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
    COUNT(p.id) AS total_purchases,
    SUM(p.quantity) AS total_quantity,
    SUM(p.quantity * p.unit_cost) AS total_spent
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
```

---

### 3.5 SQLx Compile-Time Verification Guidelines

SQLx provides compile-time SQL verification by checking queries against the actual database schema. This catches SQL errors at compile time rather than runtime.

#### Environment Setup

```bash
# Required for SQLx compile-time checking
export DATABASE_URL="postgresql://bgtracker:bgtracker@localhost:5432/bgtracker"

# Or use a .env file in the backend directory
echo 'DATABASE_URL=postgresql://bgtracker:bgtracker@localhost:5432/bgtracker' > backend/.env
```

#### View Columns and Nullable Types

When querying from SQL views, SQLx treats all columns as potentially nullable because view columns don't inherit `NOT NULL` constraints from base tables. Use the `"column_name!"` syntax to assert non-null:

```rust
// ❌ WRONG: SQLx sees view columns as nullable
sqlx::query_as!(
    MyStruct,
    r#"SELECT id, name FROM v_my_view"#
)

// ✅ CORRECT: Assert non-null columns with "column!"
sqlx::query_as!(
    MyStruct,
    r#"SELECT 
        id as "id!",
        name as "name!",
        optional_field  -- leave as-is for nullable
    FROM v_my_view"#
)
```

#### Enum Types

For PostgreSQL enums, use the type annotation syntax:

```rust
sqlx::query_as!(
    Purchase,
    r#"SELECT 
        status as "status: DeliveryStatus",
        -- or for non-null assertion from views:
        status as "status!: DeliveryStatus"
    FROM purchases"#
)
```

#### Generic Type Inference for Option<T>

When passing `None` to generic functions, Rust needs type hints:

```rust
// ❌ WRONG: Type cannot be inferred
AuditService::log(pool, "table", id, "create", None, Some(&data), user_id)

// ✅ CORRECT: Provide type annotation
AuditService::log(pool, "table", id, "create", None::<&MyType>, Some(&data), user_id)
```

#### Development Workflow

```bash
# 1. Start the database
docker compose up -d db

# 2. Run migrations (database must be running)
cd backend && sqlx migrate run

# 3. Build (requires running database for compile-time checks)
cargo build

# 4. If offline mode is needed (CI/CD):
cargo sqlx prepare  # Generates .sqlx/ directory with query metadata
```

#### Partial Index Limitations

Partial indexes with `CURRENT_DATE` cannot be used because `CURRENT_DATE` is not immutable. Use explicit date filtering in queries instead:

```sql
-- ❌ WRONG: Partial index with CURRENT_DATE (won't work)
CREATE INDEX idx_items_active ON items(vendor_id) 
    WHERE end_date IS NULL OR end_date >= CURRENT_DATE;

-- ✅ CORRECT: Regular index, filter in query
CREATE INDEX idx_items_active ON items(vendor_id);

-- Then in Rust:
sqlx::query!("SELECT * FROM items WHERE end_date IS NULL OR end_date >= CURRENT_DATE")
```

---

## 4. Project Structure

```
bg-tracker/
├── frontend/                    # React application
│   ├── src/
│   │   ├── components/          # Reusable UI components
│   │   ├── features/            # Feature modules
│   │   │   ├── auth/
│   │   │   ├── invoices/
│   │   │   ├── items/
│   │   │   ├── purchases/       # Main tracking
│   │   │   ├── payouts/
│   │   │   └── reports/
│   │   ├── hooks/               # Custom React hooks
│   │   ├── lib/                 # Utilities, API client
│   │   └── types/               # TypeScript types
│   └── package.json
│
├── backend/                     # Rust application
│   ├── src/
│   │   ├── api/                 # HTTP handlers
│   │   │   ├── auth.rs
│   │   │   ├── invoices.rs
│   │   │   ├── items.rs
│   │   │   ├── purchases.rs
│   │   │   └── payouts.rs
│   │   ├── db/                  # Database layer
│   │   │   ├── models.rs
│   │   │   ├── queries.rs
│   │   │   └── migrations/
│   │   ├── services/            # Business logic + audit
│   │   ├── auth/                # Authentication
│   │   └── main.rs
│   └── Cargo.toml
│
├── migrations/                  # SQL migrations
├── scripts/                     # Import/utility scripts
└── docker-compose.yml           # Local development
```

---

## 5. API Endpoints

```
Authentication:
  POST   /api/auth/login
  POST   /api/auth/logout
  GET    /api/auth/me

Vendors:
  GET    /api/vendors
  POST   /api/vendors
  GET    /api/vendors/:id
  PUT    /api/vendors/:id

Destinations:
  GET    /api/destinations
  POST   /api/destinations
  GET    /api/destinations/:id
  PUT    /api/destinations/:id

Items:
  GET    /api/items
  GET    /api/items?vendor_id=&date=
  POST   /api/items
  GET    /api/items/:id
  PUT    /api/items/:id

Payouts:
  GET    /api/payouts
  GET    /api/payouts?destination_id=&date=
  POST   /api/payouts
  GET    /api/payouts/:id
  PUT    /api/payouts/:id

Purchases:
  GET    /api/purchases
  GET    /api/purchases?status=&destination_id=&from=&to=
  POST   /api/purchases
  GET    /api/purchases/:id
  PUT    /api/purchases/:id
  PATCH  /api/purchases/:id/status

Invoices:
  GET    /api/invoices
  POST   /api/invoices
  GET    /api/invoices/:id
  PUT    /api/invoices/:id
  GET    /api/invoices/:id/reconciliation

Audit:
  GET    /api/audit?table=&record_id=

Import:
  POST   /api/import/csv/vendors
  POST   /api/import/csv/items
  POST   /api/import/csv/invoices
  POST   /api/import/csv/purchases
  POST   /api/import/csv/payouts

Reports:
  GET    /api/reports/summary
  GET    /api/reports/by-destination
  GET    /api/reports/by-vendor
```

---

## 6. Audit Trail

All mutations go through the API, which writes to `audit_log` in the same transaction:

```rust
async fn update_purchase(&self, id: Uuid, update: PurchaseUpdate, user_id: Uuid) -> Result<Purchase> {
    let mut tx = self.pool.begin().await?;
    
    let old = get_purchase(&mut tx, id).await?;
    let new = apply_update(&mut tx, id, &update).await?;
    
    write_audit(&mut tx, "purchases", id, "update", &old, &new, user_id).await?;
    
    tx.commit().await?;
    Ok(new)
}
```

| Table | Create | Update | Delete |
|-------|--------|--------|--------|
| `vendors` | ✅ | ✅ | ✅ |
| `destinations` | ✅ | ✅ | ✅ |
| `items` | ✅ | ✅ | ✅ |
| `payouts` | ✅ | ✅ | ✅ |
| `purchases` | ✅ | ✅ | ✅ |
| `incoming_invoices` | ✅ | ✅ | ✅ |

---

## 7. Key Features

### 7.1 Purchases View (Main Grid)
- Query `v_purchase_economics` for display (all profit calculations derived)
- Filtering by vendor, destination, status, date range
- Bulk status updates
- Export to CSV

### 7.2 Invoice Management
- Query `v_invoice_reconciliation` for matching status
- Auto-reconciliation computed from view (never stored)

### 7.3 Item Catalog
- Query `v_active_items` for currently valid items
- Historical items visible by querying `items` table directly

### 7.4 Payout Configuration
- Query `v_active_payouts` for currently valid payouts
- Historical payouts visible by querying `payouts` table directly

### 7.5 Reports
- Query `v_destination_summary` for destination totals
- Query `v_vendor_summary` for vendor totals
- All aggregations computed on-demand from views

---

## 8. Implementation Phases

### Phase 1: Foundation
- [ ] Database schema and migrations
- [ ] Rust backend with basic CRUD
- [ ] API-level audit logging
- [ ] Authentication system
- [ ] React frontend scaffold

### Phase 2: Core Features
- [ ] Purchases grid view (main tracking)
- [ ] Invoice management
- [ ] Item catalog with date ranges
- [ ] Payout configuration with date ranges
- [ ] CSV import (one endpoint per table)

### Phase 3: Polish
- [ ] Reports and dashboards
- [ ] Bulk operations
- [ ] Export functionality
- [ ] Partition management (auto-create monthly)

---

## 9. Design Principles

### 9.1 Single Source of Truth
- **Tables** store raw, user-entered data only
- **Views** compute all derived/calculated values
- **Never** store computed values in tables (no `is_reconciled` flag, no `total_profit` column)

### 9.2 SQL vs Rust Responsibilities

| Responsibility | Where | Example |
|----------------|-------|---------|
| Data storage | Tables | `purchases`, `items`, `payouts` |
| Computed display | Views | `v_purchase_economics`, `v_invoice_reconciliation` |
| Validation | SQL functions | `is_item_valid()`, `has_payout()` |
| Business decisions | Rust | "Should I buy this item?", "What-if scenarios" |
| Audit logging | Rust | Write to `audit_log` in same transaction |

### 9.3 Rust Best Practices
- Keep Axum handlers thin (delegate to `services/`)
- Write integration tests that spin up Postgres via Docker
- Avoid over-abstracting with traits early
- Avoid building a generic repository layer

---

## 10. Testing Strategy

### 10.1 Testing Philosophy

**Focus on backend.** Frontend is simple CRUD UI - manual testing is sufficient.

Backend correctness matters because:
- Financial calculations must be accurate
- Audit trail must be complete
- Views must return correct derived data
- Constraints must prevent bad data

### 10.2 Backend Integration Tests (Primary)

Use `testcontainers-rs` to spin up real Postgres per test run.

```rust
#[tokio::test]
async fn test_purchase_creates_audit_log() {
    let pool = setup_test_db().await;  // spins up Postgres container
    let service = PurchaseService::new(pool.clone());
    
    let purchase = service.create_purchase(CreatePurchase { ... }, user_id).await.unwrap();
    
    let audit = sqlx::query_as::<_, AuditLog>(
        "SELECT * FROM audit_log WHERE record_id = $1"
    )
    .bind(purchase.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    
    assert_eq!(audit.operation, "create");
    assert_eq!(audit.table_name, "purchases");
}

#[tokio::test]
async fn test_purchase_economics_view_calculates_profit() {
    let pool = setup_test_db().await;
    
    // Setup: vendor, item ($50), destination, payout ($75)
    let vendor_id = create_vendor(&pool, "Best Buy").await;
    let dest_id = create_destination(&pool, "CBG").await;
    let item_id = create_item(&pool, "Widget", vendor_id, dec!(50.00)).await;
    create_payout(&pool, item_id, dest_id, dec!(75.00)).await;
    
    // Create purchase
    let purchase_id = create_purchase(&pool, item_id, dest_id, 2, dec!(50.00)).await;
    
    // Query view
    let economics = sqlx::query_as::<_, PurchaseEconomics>(
        "SELECT * FROM v_purchase_economics WHERE purchase_id = $1"
    )
    .bind(purchase_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    
    assert_eq!(economics.unit_profit, dec!(25.00));   // 75 - 50
    assert_eq!(economics.total_profit, dec!(50.00));  // 25 * 2
}
```

### 10.3 Test Categories

| Category | Priority | What to Test |
|----------|----------|--------------|
| **Views** | High | `v_purchase_economics` profit calculations |
| **Views** | High | `v_invoice_reconciliation` matching logic |
| **Views** | High | `v_active_items` / `v_active_payouts` date filtering |
| **Audit** | High | Every create/update/delete creates audit entry |
| **Constraints** | Medium | Date range exclusion prevents overlaps |
| **Constraints** | Medium | FK constraints prevent orphans |
| **CRUD** | Medium | Basic create, read, update for each entity |
| **Auth** | Medium | JWT validation, protected routes reject unauthorized |
| **Import** | Low | CSV parsing, validation errors |

### 10.4 Database Constraint Tests

```rust
#[tokio::test]
async fn test_overlapping_item_date_ranges_rejected() {
    let pool = setup_test_db().await;
    let vendor_id = create_vendor(&pool, "Best Buy").await;
    
    // Create item valid from 2025-01-01 to 2025-06-30
    create_item_with_dates(&pool, "Widget", vendor_id, "2025-01-01", Some("2025-06-30")).await;
    
    // Try to create overlapping item (should fail)
    let result = create_item_with_dates(&pool, "Widget", vendor_id, "2025-03-01", None).await;
    
    assert!(result.is_err());  // Exclusion constraint violation
}
```

### 10.5 Test Fixtures

```rust
// tests/fixtures/mod.rs
pub async fn setup_test_db() -> PgPool {
    let container = Postgres::default().start().await;
    let pool = PgPool::connect(&container.connection_string()).await.unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    pool
}

pub async fn seed_realistic_data(pool: &PgPool) {
    // Mirror original Excel structure
    // - 5 vendors (Best Buy, Amazon, etc.)
    // - 2 destinations (CBG, BSC)
    // - Sample items with payouts
    // - Mix of reconciled and unreconciled invoices
}
```

### 10.6 Frontend Testing (Minimal)

**Skip for v1.** Frontend is simple CRUD forms + TanStack Table grids.

If needed later:
- Vitest for utility functions only
- Manual testing for UI flows
- No E2E (high maintenance, low value for this app)

---

## 11. Future Extensibility

Out of scope for initial release:
- Webhook automation
- Outgoing invoice generation  
- Email notifications
- Tax tracking details
- Partitioning for `purchases`/`incoming_invoices` (add via `ATTACH PARTITION` when needed)
