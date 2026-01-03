# BG Tracker Implementation Plan

## Overview

A buying group tracking application replacing the current Excel-based system.

**Key Design Decisions:**
- Payout-driven workflow (payouts inform buying decisions)
- Catalog-first (items must exist before purchases)
- API-level audit logging (all mutations tracked)
- Partitioned tables for scalability and archival
- Two entity types: Vendors (buy FROM) vs Destinations (sell/ship TO)

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
| **Excel Import** | calamine | Rust Excel parsing |

**Security:** React never accesses the database directly. All data flows through authenticated API endpoints.

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
│─────────────│     │  invoices ◄P►   │     │──────────────│
│ id (PK)     │◄────│─────────────────│     │ id (PK)      │
│ name        │     │ id (PK)         │     │ code         │
│ created_at  │     │ vendor_id (FK)  │     │ name         │
│ updated_at  │     │ invoice_number  │     │ is_active    │
└─────────────┘     │ order_number    │     │ created_at   │
                    │ invoice_date    │     │ updated_at   │
                    │ total           │     └──────────────┘
                    │ notes           │            ▲
                    │ created_at ◄────┼── partition key
                    │ updated_at      │            │
                    └────────┬────────┘            │
                             │                     │
                             ▼                     │
┌─────────────┐     ┌─────────────────┐     ┌──────┴───────┐
│   items     │     │ purchases ◄P►   │     │   payouts    │
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
│ created_at  │     │ created_at ◄────┼── partition key
│ updated_at  │     │ updated_at      │     │ updated_at   │
└─────────────┘     └─────────────────┘     └──────────────┘

                    ┌─────────────────┐
                    │ audit_log ◄P►   │
                    │─────────────────│
                    │ id (PK)         │
                    │ table_name      │
                    │ record_id       │
                    │ operation       │
                    │ old_data (JSONB)│
                    │ new_data (JSONB)│
                    │ user_id         │
                    │ created_at ◄────┼── partition key
                    └─────────────────┘

◄P► = Partitioned by month (created_at)
```

### 3.2 Partitioning Strategy

| Table | Partitioned? | Partition Key | Frequency |
|-------|--------------|---------------|-----------|
| `purchases` | ✅ Yes | `created_at` | Monthly |
| `incoming_invoices` | ✅ Yes | `created_at` | Monthly |
| `audit_log` | ✅ Yes | `created_at` | Monthly |
| `items` | ❌ No | - | Small catalog |
| `payouts` | ❌ No | - | Uses date ranges |
| `vendors` | ❌ No | - | Tiny, static |
| `destinations` | ❌ No | - | Tiny, static |

### 3.3 SQL Schema

```sql
-- ============================================
-- Reference Tables (non-partitioned)
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

-- ============================================
-- Partitioned Tables
-- ============================================

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
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    invoice_number VARCHAR(100) NOT NULL,
    order_number VARCHAR(100),
    invoice_date DATE NOT NULL,
    total DECIMAL(12, 4) NOT NULL,
    is_reconciled BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Purchases (main tracking table - replaces BG_Tracking)
CREATE TABLE purchases (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id),
    invoice_id UUID,  -- Optional, linked when invoice arrives
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost DECIMAL(10, 4) NOT NULL,  -- Snapshot from items at purchase time
    destination_id UUID REFERENCES destinations(id),
    status delivery_status NOT NULL DEFAULT 'pending',
    delivery_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Audit Log (API-level change tracking)
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

-- ============================================
-- Initial Partitions (2025-2026)
-- ============================================

CREATE TABLE incoming_invoices_2025_11 PARTITION OF incoming_invoices
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE incoming_invoices_2025_12 PARTITION OF incoming_invoices
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE incoming_invoices_2026_01 PARTITION OF incoming_invoices
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE purchases_2025_11 PARTITION OF purchases
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE purchases_2025_12 PARTITION OF purchases
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE purchases_2026_01 PARTITION OF purchases
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE audit_log_2025_11 PARTITION OF audit_log
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE audit_log_2025_12 PARTITION OF audit_log
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE audit_log_2026_01 PARTITION OF audit_log
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- ============================================
-- Indexes
-- ============================================

CREATE INDEX idx_items_name_vendor ON items(name, vendor_id);
CREATE INDEX idx_items_vendor ON items(vendor_id);
CREATE INDEX idx_items_date_range ON items(start_date, end_date);

CREATE INDEX idx_payouts_item_destination ON payouts(item_id, destination_id);
CREATE INDEX idx_payouts_date_range ON payouts(start_date, end_date);

CREATE INDEX idx_purchases_item ON purchases(item_id);
CREATE INDEX idx_purchases_invoice ON purchases(invoice_id);
CREATE INDEX idx_purchases_destination ON purchases(destination_id);
CREATE INDEX idx_purchases_status ON purchases(status);

CREATE INDEX idx_incoming_invoices_vendor ON incoming_invoices(vendor_id);
CREATE INDEX idx_incoming_invoices_number ON incoming_invoices(invoice_number);

CREATE INDEX idx_audit_log_table_record ON audit_log(table_name, record_id);

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
-- Helper Functions
-- ============================================

CREATE OR REPLACE FUNCTION get_item_cost(
    p_item_name VARCHAR,
    p_vendor_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
) RETURNS DECIMAL AS $$
    SELECT unit_cost FROM items
    WHERE name = p_item_name
      AND vendor_id = p_vendor_id
      AND start_date <= p_date
      AND (end_date IS NULL OR end_date >= p_date)
    LIMIT 1;
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION get_payout_price(
    p_item_id UUID,
    p_destination_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
) RETURNS DECIMAL AS $$
    SELECT payout_price FROM payouts
    WHERE item_id = p_item_id
      AND destination_id = p_destination_id
      AND start_date <= p_date
      AND (end_date IS NULL OR end_date >= p_date)
    LIMIT 1;
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION create_monthly_partitions(p_year INT, p_month INT)
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
        'CREATE TABLE IF NOT EXISTS incoming_invoices_%s PARTITION OF incoming_invoices FOR VALUES FROM (%L) TO (%L)',
        partition_suffix, start_date, end_date
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS purchases_%s PARTITION OF purchases FOR VALUES FROM (%L) TO (%L)',
        partition_suffix, start_date, end_date
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit_log_%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        partition_suffix, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;
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
  POST   /api/import/excel

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
- Data grid mirroring current Excel `BG_Tracking` sheet
- Filtering by vendor, destination, status, date range
- Bulk status updates
- Export to CSV/Excel

### 7.2 Invoice Management
- Invoice list with reconciliation status
- Auto-reconciliation (sum of linked purchases vs invoice total)

### 7.3 Item Catalog
- Per-vendor pricing with date ranges
- Default destination assignment

### 7.4 Payout Configuration
- Payout prices per destination with date ranges
- Historical payout tracking

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
- [ ] Excel import functionality

### Phase 3: Polish
- [ ] Reports and dashboards
- [ ] Bulk operations
- [ ] Export functionality
- [ ] Partition management (auto-create monthly)

---

## 9. Future Extensibility

Out of scope for initial release:
- Webhook automation
- Outgoing invoice generation
- Email notifications
- Tax tracking details
