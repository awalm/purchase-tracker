# BG Tracker - Implementation Progress

## Status: ✅ Complete

**Last Updated:** 2026-01-10

---

## Technology Stack Status

| Layer | Planned | Implemented | Notes |
|-------|---------|-------------|-------|
| **Frontend** | React + TypeScript + Vite | ✅ | Complete |
| **UI Components** | Shadcn/ui + Tailwind CSS | ✅ | Complete |
| **Data Fetching** | TanStack Query | ✅ | Complete |
| **Tables** | TanStack Table | ✅ | Using basic tables with hooks |
| **Backend** | Rust + Axum | ✅ | Compiles successfully |
| **DB Access** | SQLx (compile-time) | ✅ | Verified against schema |
| **Auth** | JWT + Argon2 | ✅ | Backend complete |
| **Database** | PostgreSQL 15+ | ✅ | Schema + migrations |

---

## Backend Implementation ✅ Complete

### Files Created
- [backend/src/main.rs](backend/src/main.rs) - Axum server entry point
- [backend/src/api/mod.rs](backend/src/api/mod.rs) - API router
- [backend/src/api/auth.rs](backend/src/api/auth.rs) - Login/register/me endpoints
- [backend/src/api/vendors.rs](backend/src/api/vendors.rs) - Vendor CRUD
- [backend/src/api/destinations.rs](backend/src/api/destinations.rs) - Destination CRUD
- [backend/src/api/items.rs](backend/src/api/items.rs) - Item CRUD (active items view)
- [backend/src/api/payouts.rs](backend/src/api/payouts.rs) - Payout CRUD (active payouts view)
- [backend/src/api/invoices.rs](backend/src/api/invoices.rs) - Invoice CRUD
- [backend/src/api/purchases.rs](backend/src/api/purchases.rs) - Purchase CRUD + economics view
- [backend/src/api/reports.rs](backend/src/api/reports.rs) - Vendor/destination summaries
- [backend/src/db/models.rs](backend/src/db/models.rs) - All Rust structs
- [backend/src/db/queries.rs](backend/src/db/queries.rs) - SQLx compile-time queries
- [backend/src/auth/jwt.rs](backend/src/auth/jwt.rs) - JWT + Argon2 auth
- [backend/src/services/audit.rs](backend/src/services/audit.rs) - Audit logging

---

## Frontend Implementation ✅ Complete

### Core Files
- [frontend/package.json](frontend/package.json) - Dependencies (React, TanStack, Radix, Tailwind)
- [frontend/vite.config.ts](frontend/vite.config.ts) - Vite config with API proxy + path aliases
- [frontend/tsconfig.json](frontend/tsconfig.json) - TypeScript config with @ alias
- [frontend/tailwind.config.js](frontend/tailwind.config.js) - Tailwind with Shadcn theming
- [frontend/postcss.config.js](frontend/postcss.config.js) - PostCSS config

### Components
- [frontend/src/components/Layout.tsx](frontend/src/components/Layout.tsx) - Sidebar navigation
- [frontend/src/components/ui/button.tsx](frontend/src/components/ui/button.tsx) - Button component
- [frontend/src/components/ui/input.tsx](frontend/src/components/ui/input.tsx) - Input component
- [frontend/src/components/ui/label.tsx](frontend/src/components/ui/label.tsx) - Label component
- [frontend/src/components/ui/card.tsx](frontend/src/components/ui/card.tsx) - Card component
- [frontend/src/components/ui/table.tsx](frontend/src/components/ui/table.tsx) - Table component
- [frontend/src/components/ui/dialog.tsx](frontend/src/components/ui/dialog.tsx) - Dialog/Modal
- [frontend/src/components/ui/select.tsx](frontend/src/components/ui/select.tsx) - Select dropdown
- [frontend/src/components/ui/status-badge.tsx](frontend/src/components/ui/status-badge.tsx) - Status badges

### Pages
- [frontend/src/pages/LoginPage.tsx](frontend/src/pages/LoginPage.tsx) - Login/register
- [frontend/src/pages/DashboardPage.tsx](frontend/src/pages/DashboardPage.tsx) - Summary stats
- [frontend/src/pages/VendorsPage.tsx](frontend/src/pages/VendorsPage.tsx) - Vendor CRUD
- [frontend/src/pages/DestinationsPage.tsx](frontend/src/pages/DestinationsPage.tsx) - Destination CRUD
- [frontend/src/pages/ItemsPage.tsx](frontend/src/pages/ItemsPage.tsx) - Items catalog
- [frontend/src/pages/PayoutsPage.tsx](frontend/src/pages/PayoutsPage.tsx) - Payout management
- [frontend/src/pages/InvoicesPage.tsx](frontend/src/pages/InvoicesPage.tsx) - Invoice tracking
- [frontend/src/pages/PurchasesPage.tsx](frontend/src/pages/PurchasesPage.tsx) - Main tracking grid

### Hooks & Utils
- [frontend/src/hooks/useApi.ts](frontend/src/hooks/useApi.ts) - TanStack Query hooks
- [frontend/src/lib/utils.ts](frontend/src/lib/utils.ts) - Utility functions (cn, formatCurrency, formatDate)
- [frontend/src/api.ts](frontend/src/api.ts) - API client
- [frontend/src/AuthContext.tsx](frontend/src/AuthContext.tsx) - Auth state management
- [frontend/src/App.tsx](frontend/src/App.tsx) - Router + protected routes

---

## Quick Start

```bash
# 1. Start the database
docker compose up -d

# 2. Run migrations (wait for db to be ready)
cd backend && cargo sqlx migrate run

# 3. Start backend (port 3000)
cd backend && cargo run

# 4. Start frontend (port 5173, proxies to backend)
cd frontend && npm run dev

# 5. Open browser
open http://localhost:5173
```

---

## Features

### Dashboard
- Total purchases, quantity, spent, profit stats
- Summary by destination with profit/loss coloring
- Summary by vendor with invoice counts

### Vendors
- Create, edit, delete vendors
- Simple name field

### Destinations
- Create, edit, delete destinations
- Code + name fields
- Active/inactive status

### Items
- Create items with vendor, cost, start date
- Optional default destination
- Shows active items only (based on date range)
- Auto-populated from `v_active_items` view

### Payouts
- Create payouts with item, destination, price, start date
- Shows active payouts only (based on date range)
- Auto-populated from `v_active_payouts` view

### Invoices
- Create invoices with vendor, invoice #, order #, date, total
- Track incoming vendor invoices

### Purchases (Main Tracking)
- Create purchases with item, quantity, cost, destination, invoice
- Auto-fills unit cost from item
- Auto-fills default destination from item
- Filter by status and destination
- Inline status dropdown to update delivery status
- Shows profit calculations from `v_purchase_economics` view
- Color-coded profit/loss

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React App     │────▶│   Axum Backend  │────▶│   PostgreSQL    │
│   (port 5173)   │     │   (port 3000)   │     │   (port 5432)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
      │                        │                        │
      │ TanStack Query         │ SQLx                   │ Views
      │ Shadcn/ui              │ JWT Auth               │ Partitions
      │ Tailwind               │ Audit logging          │ Triggers
      └────────────────────────┴────────────────────────┘
```
