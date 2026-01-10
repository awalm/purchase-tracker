use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ============================================
// Enums
// ============================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "delivery_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Pending,
    InTransit,
    Delivered,
    Damaged,
    Returned,
    Lost,
}

// ============================================
// Core Entities
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Vendor {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Destination {
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Item {
    pub id: Uuid,
    pub name: String,
    pub vendor_id: Uuid,
    pub unit_cost: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Payout {
    pub id: Uuid,
    pub destination_id: Uuid,
    pub item_id: Uuid,
    pub payout_price: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct IncomingInvoice {
    pub id: Uuid,
    pub vendor_id: Uuid,
    pub invoice_number: String,
    pub order_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub total: Decimal,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Purchase {
    pub id: Uuid,
    pub item_id: Uuid,
    pub invoice_id: Option<Uuid>,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub destination_id: Option<Uuid>,
    pub status: DeliveryStatus,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub password_hash: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AuditLog {
    pub id: Uuid,
    pub table_name: String,
    pub record_id: Uuid,
    pub operation: String,
    pub old_data: Option<serde_json::Value>,
    pub new_data: Option<serde_json::Value>,
    pub user_id: Uuid,
    pub created_at: DateTime<Utc>,
}

// ============================================
// View Models (derived data from SQL views)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ActiveItem {
    pub id: Uuid,
    pub name: String,
    pub vendor_id: Uuid,
    pub vendor_name: String,
    pub unit_cost: Decimal,
    pub default_destination_id: Option<Uuid>,
    pub default_destination_code: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ActivePayout {
    pub id: Uuid,
    pub item_id: Uuid,
    pub item_name: String,
    pub destination_id: Uuid,
    pub destination_code: String,
    pub payout_price: Decimal,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PurchaseEconomics {
    pub purchase_id: Uuid,
    pub purchase_date: DateTime<Utc>,
    pub item_name: String,
    pub vendor_name: String,
    pub destination_code: Option<String>,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub payout_price: Option<Decimal>,
    pub unit_profit: Option<Decimal>,
    pub total_profit: Option<Decimal>,
    pub total_cost: Option<Decimal>,
    pub total_revenue: Option<Decimal>,
    pub status: DeliveryStatus,
    pub delivery_date: Option<NaiveDate>,
    pub invoice_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct InvoiceReconciliation {
    pub invoice_id: Uuid,
    pub invoice_number: String,
    pub vendor_name: String,
    pub invoice_date: NaiveDate,
    pub invoice_total: Decimal,
    pub purchases_total: Decimal,
    pub difference: Decimal,
    pub is_matched: bool,
    pub purchase_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DestinationSummary {
    pub destination_id: Uuid,
    pub destination_code: String,
    pub destination_name: String,
    pub total_purchases: Option<i64>,
    pub total_quantity: Option<i64>,
    pub total_cost: Option<Decimal>,
    pub total_profit: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VendorSummary {
    pub vendor_id: Uuid,
    pub vendor_name: String,
    pub total_invoices: Option<i64>,
    pub total_purchases: Option<i64>,
    pub total_quantity: Option<i64>,
    pub total_spent: Option<Decimal>,
}

// ============================================
// DTOs (Data Transfer Objects for API)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVendor {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateVendor {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDestination {
    pub code: String,
    pub name: String,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDestination {
    pub code: Option<String>,
    pub name: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateItem {
    pub name: String,
    pub vendor_id: Uuid,
    pub unit_cost: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateItem {
    pub name: Option<String>,
    pub unit_cost: Option<Decimal>,
    pub end_date: Option<NaiveDate>,
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePayout {
    pub destination_id: Uuid,
    pub item_id: Uuid,
    pub payout_price: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePayout {
    pub payout_price: Option<Decimal>,
    pub end_date: Option<NaiveDate>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoice {
    pub vendor_id: Uuid,
    pub invoice_number: String,
    pub order_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub total: Decimal,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInvoice {
    pub invoice_number: Option<String>,
    pub order_number: Option<String>,
    pub invoice_date: Option<NaiveDate>,
    pub total: Option<Decimal>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePurchase {
    pub item_id: Uuid,
    pub invoice_id: Option<Uuid>,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub destination_id: Option<Uuid>,
    pub status: Option<DeliveryStatus>,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePurchase {
    pub invoice_id: Option<Uuid>,
    pub quantity: Option<i32>,
    pub unit_cost: Option<Decimal>,
    pub destination_id: Option<Uuid>,
    pub status: Option<DeliveryStatus>,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusUpdate {
    pub status: DeliveryStatus,
}

// ============================================
// Query Parameters
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseQuery {
    pub status: Option<DeliveryStatus>,
    pub destination_id: Option<Uuid>,
    pub vendor_id: Option<Uuid>,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemQuery {
    pub vendor_id: Option<Uuid>,
    pub date: Option<NaiveDate>,
    pub active_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayoutQuery {
    pub destination_id: Option<Uuid>,
    pub item_id: Option<Uuid>,
    pub date: Option<NaiveDate>,
    pub active_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditQuery {
    pub table_name: Option<String>,
    pub record_id: Option<Uuid>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
}
