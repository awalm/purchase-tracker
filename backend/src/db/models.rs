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
    Returned,
    Damaged,
    Lost,
}

// ============================================
// Core Entities
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Vendor {
    pub id: Uuid,
    pub name: String,
    pub short_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VendorImportAlias {
    pub id: Uuid,
    pub normalized_alias: String,
    pub raw_alias: String,
    pub vendor_id: Uuid,
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
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Invoice {
    pub id: Uuid,
    pub destination_id: Uuid,
    pub invoice_number: String,
    pub order_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub delivery_date: Option<NaiveDate>,
    pub subtotal: Decimal,
    pub tax_rate: Decimal,
    pub total: Decimal,
    pub reconciliation_state: String,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // original_pdf and original_filename are NOT included here
    // They are handled separately via dedicated endpoints to avoid
    // loading large blobs on every invoice list query.
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Receipt {
    pub id: Uuid,
    pub vendor_id: Uuid,
    pub receipt_number: String,
    pub receipt_date: NaiveDate,
    pub subtotal: Decimal,
    pub tax_amount: Decimal,
    pub total: Decimal,
    pub payment_method: Option<String>,
    pub ingestion_metadata: Option<serde_json::Value>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // original_pdf and original_filename are NOT included here
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReceiptLineItem {
    pub id: Uuid,
    pub receipt_id: Uuid,
    pub item_id: Uuid,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub notes: Option<String>,
    pub parent_line_item_id: Option<Uuid>,
    pub state: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReceiptLineItemWithItem {
    pub id: Uuid,
    pub receipt_id: Uuid,
    pub item_id: Uuid,
    pub item_name: String,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub notes: Option<String>,
    pub parent_line_item_id: Option<Uuid>,
    pub state: String,
    pub allocated_qty: i32,
    pub remaining_qty: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Purchase {
    pub id: Uuid,
    pub item_id: Uuid,
    pub invoice_id: Option<Uuid>,
    pub receipt_id: Option<Uuid>,
    pub quantity: i32,
    pub purchase_cost: Decimal,
    pub cost_adjustment: Decimal,
    pub adjustment_note: Option<String>,
    pub invoice_unit_price: Option<Decimal>, // Invoice-side unit price (invoice context)
    pub destination_id: Option<Uuid>,
    pub status: DeliveryStatus,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
    pub refunds_purchase_id: Option<Uuid>,
    pub purchase_type: String,
    pub bonus_for_purchase_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PurchaseAllocation {
    pub id: Uuid,
    pub purchase_id: Uuid,
    pub receipt_id: Uuid,
    pub receipt_line_item_id: Option<Uuid>,
    pub allocated_qty: i32,
    pub unit_cost: Decimal,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PurchaseAllocationWithReceipt {
    pub id: Uuid,
    pub purchase_id: Uuid,
    pub receipt_id: Uuid,
    pub receipt_line_item_id: Option<Uuid>,
    pub item_id: Option<Uuid>,
    pub item_name: Option<String>,
    pub allocated_qty: i32,
    pub unit_cost: Decimal,
    pub receipt_number: String,
    pub vendor_name: String,
    pub receipt_date: NaiveDate,
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReceiptMetadataAuditEntry {
    pub id: Uuid,
    pub receipt_id: Uuid,
    pub operation: String,
    pub old_ingestion_metadata: Option<serde_json::Value>,
    pub new_ingestion_metadata: Option<serde_json::Value>,
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
    pub default_destination_id: Option<Uuid>,
    pub default_destination_code: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub total_qty: i64,
    pub total_value: Decimal,
    pub min_unit_cost: Option<Decimal>,
    pub avg_unit_cost: Option<Decimal>,
    pub max_unit_cost: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub avg_unit_commission: Option<Decimal>,
    pub last_receipt_date: Option<DateTime<Utc>>,
}

/// A receipt line for a specific item, joined with receipt metadata.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ItemReceiptLine {
    pub receipt_line_item_id: Uuid,
    pub receipt_id: Uuid,
    pub receipt_number: String,
    pub receipt_date: NaiveDate,
    pub vendor_name: Option<String>,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub line_total: Decimal,
    pub receipt_subtotal: Decimal,
    pub receipt_total: Decimal,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PurchaseEconomics {
    pub purchase_id: Uuid,
    pub purchase_date: DateTime<Utc>,
    pub item_id: Uuid,
    pub item_name: String,
    pub vendor_name: Option<String>,
    pub destination_code: Option<String>,
    pub quantity: i32,
    pub purchase_cost: Decimal,
    pub cost_adjustment: Option<Decimal>,
    pub adjustment_note: Option<String>,
    pub total_cost: Option<Decimal>,
    pub invoice_unit_price: Option<Decimal>,
    pub total_selling: Option<Decimal>,
    pub unit_commission: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub tax_paid: Option<Decimal>,
    pub tax_owed: Option<Decimal>,
    pub status: DeliveryStatus,
    pub delivery_date: Option<NaiveDate>,
    pub invoice_id: Option<Uuid>,
    pub receipt_id: Option<Uuid>,
    pub receipt_number: Option<String>,
    pub invoice_number: Option<String>,
    pub allow_receipt_date_override: bool,
    pub notes: Option<String>,
    pub refunds_purchase_id: Option<Uuid>,
    pub purchase_type: Option<String>,
    pub bonus_for_purchase_id: Option<Uuid>,
    pub invoice_reconciliation_state: Option<String>,
    pub bonus_parent_item_name: Option<String>,
    pub bonus_parent_quantity: Option<i32>,
    pub bonus_parent_invoice_number: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct InvoiceReconciliation {
    pub invoice_id: Uuid,
    pub invoice_number: String,
    pub destination_code: String,
    pub destination_name: String,
    pub invoice_date: NaiveDate,
    pub invoice_total: Decimal,
    pub purchases_total: Decimal,
    pub difference: Decimal,
    pub is_matched: bool,
    pub purchase_count: i64,
    pub total_cost: Decimal,
    pub total_commission: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DestinationSummary {
    pub destination_id: Uuid,
    pub destination_code: String,
    pub destination_name: String,
    pub total_invoices: Option<i64>,
    pub total_purchases: Option<i64>,
    pub total_quantity: Option<i64>,
    pub total_cost: Option<Decimal>,
    pub total_revenue: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub total_tax_paid: Option<Decimal>,
    pub total_tax_owed: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VendorSummary {
    pub vendor_id: Uuid,
    pub vendor_name: String,
    pub total_receipts: Option<i64>,
    pub total_purchases: Option<i64>,
    pub total_quantity: Option<i64>,
    pub total_spent: Option<Decimal>,
}

// Receipt detail with vendor info and linked purchase economics
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReceiptWithVendor {
    pub id: Uuid,
    pub vendor_id: Uuid,
    pub vendor_name: String,
    pub receipt_number: String,
    pub receipt_date: NaiveDate,
    pub subtotal: Decimal,
    pub tax_amount: Decimal,
    pub total: Decimal,
    pub payment_method: Option<String>,
    pub ingestion_metadata: Option<serde_json::Value>,
    pub has_pdf: Option<bool>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub receipt_line_item_count: i64,
    pub purchase_count: Option<i64>,
    pub purchases_total: Option<Decimal>,
    pub total_selling: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub invoiced_count: Option<i64>,
    pub locked_purchase_count: Option<i64>,
}

// Invoice detail with destination info and linked purchase economics
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct InvoiceWithDestination {
    pub id: Uuid,
    pub destination_id: Uuid,
    pub destination_code: String,
    pub destination_name: String,
    pub invoice_number: String,
    pub order_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub delivery_date: Option<NaiveDate>,
    pub subtotal: Decimal,
    pub tax_rate: Decimal,
    pub total: Decimal,
    pub reconciliation_state: String,
    pub has_pdf: Option<bool>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub purchase_count: Option<i64>,
    pub purchases_total: Option<Decimal>,
    pub total_cost: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub receipted_count: Option<i64>,
}

// ============================================
// DTOs (Data Transfer Objects for API)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVendor {
    pub name: String,
    pub short_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateVendor {
    pub name: Option<String>,
    pub short_id: Option<String>,
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
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateItem {
    pub name: Option<String>,
    pub default_destination_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItemRequest {
    pub target_item_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItemResult {
    pub purchases_transferred: i64,
    pub receipt_lines_transferred: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoice {
    pub destination_id: Uuid,
    pub invoice_number: String,
    pub order_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub delivery_date: Option<NaiveDate>,
    pub subtotal: Decimal,
    pub tax_amount: Option<Decimal>,
    pub tax_rate: Option<Decimal>, // defaults to 13.00 if not provided
    pub reconciliation_state: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInvoice {
    pub invoice_number: Option<String>,
    pub order_number: Option<String>,
    pub invoice_date: Option<NaiveDate>,
    pub delivery_date: Option<NaiveDate>,
    pub subtotal: Option<Decimal>,
    pub tax_amount: Option<Decimal>,
    pub tax_rate: Option<Decimal>,
    pub reconciliation_state: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceFromPdfLineItemSplit {
    pub item_id: Uuid,
    pub qty: i32,
    pub purchase_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceFromPdfLineItem {
    pub line_index: usize,
    pub description: String,
    pub qty: i32,
    pub invoice_unit_price: String,
    pub subtotal: String,
    pub item_id: Option<Uuid>,
    #[serde(default)]
    pub splits: Option<Vec<CreateInvoiceFromPdfLineItemSplit>>,
    pub purchase_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceFromPdfRequest {
    pub destination_id: Uuid,
    pub invoice_number: String,
    pub invoice_date: String,
    pub delivery_date: Option<String>,
    pub subtotal: String,
    pub tax_amount: Option<String>,
    pub tax_rate: Option<String>,
    pub notes: Option<String>,
    pub line_items: Vec<CreateInvoiceFromPdfLineItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceImportValidationError {
    pub field: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceImportLineFailure {
    pub line_index: usize,
    pub code: String,
    pub message: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvoiceFromPdfResponse {
    pub invoice_id: Uuid,
    pub purchase_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReceipt {
    pub vendor_id: Uuid,
    pub source_vendor_alias: Option<String>,
    pub receipt_number: Option<String>,
    pub receipt_date: NaiveDate,
    pub subtotal: Decimal,
    pub tax_amount: Option<Decimal>,
    pub tax_rate: Option<Decimal>, // backwards-compatible fallback if tax_amount is not provided
    pub payment_method: Option<String>,
    pub ingestion_metadata: Option<serde_json::Value>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateReceipt {
    pub vendor_id: Option<Uuid>,
    pub receipt_number: Option<String>,
    pub receipt_date: Option<NaiveDate>,
    pub subtotal: Option<Decimal>,
    pub tax_amount: Option<Decimal>,
    pub tax_rate: Option<Decimal>,
    pub payment_method: Option<String>,
    pub ingestion_metadata: Option<serde_json::Value>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReceiptLineItem {
    pub item_id: Uuid,
    pub quantity: i32,
    pub unit_cost: Decimal,
    pub notes: Option<String>,
    pub parent_line_item_id: Option<Uuid>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateReceiptLineItem {
    pub item_id: Option<Uuid>,
    pub quantity: Option<i32>,
    pub unit_cost: Option<Decimal>,
    pub notes: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePurchase {
    pub item_id: Uuid,
    pub invoice_id: Option<Uuid>,
    pub receipt_id: Option<Uuid>,
    pub quantity: i32,
    pub purchase_cost: Decimal,
    pub invoice_unit_price: Option<Decimal>, // Invoice-side unit price (invoice context)
    pub destination_id: Option<Uuid>,
    pub status: Option<DeliveryStatus>,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
    pub refunds_purchase_id: Option<Uuid>,
    pub purchase_type: Option<String>,
    pub bonus_for_purchase_id: Option<Uuid>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdatePurchase {
    pub item_id: Option<Uuid>,
    pub invoice_id: Option<Uuid>,
    #[serde(default)]
    pub clear_invoice: bool, // true → set invoice_id to NULL
    pub receipt_id: Option<Uuid>,
    #[serde(default)]
    pub clear_receipt: bool, // true → set receipt_id to NULL
    pub quantity: Option<i32>,
    pub purchase_cost: Option<Decimal>,
    pub cost_adjustment: Option<Decimal>,
    pub adjustment_note: Option<String>,
    #[serde(default)]
    pub clear_adjustment_note: bool, // true → set adjustment_note to NULL
    pub invoice_unit_price: Option<Decimal>, // Invoice-side unit price (invoice context)
    #[serde(default)]
    pub clear_invoice_unit_price: bool, // true → set invoice_unit_price to NULL
    pub destination_id: Option<Uuid>,
    pub status: Option<DeliveryStatus>,
    pub delivery_date: Option<NaiveDate>,
    pub notes: Option<String>,
    pub refunds_purchase_id: Option<Uuid>,
    #[serde(default)]
    pub clear_refunds_purchase: bool, // true → set refunds_purchase_id to NULL
    pub purchase_type: Option<String>,
    pub bonus_for_purchase_id: Option<Uuid>,
    #[serde(default)]
    pub clear_bonus_for_purchase: bool, // true → set bonus_for_purchase_id to NULL
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusUpdate {
    pub status: DeliveryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePurchaseAllocation {
    pub receipt_line_item_id: Uuid,
    pub allocated_qty: i32,
    #[serde(default)]
    pub allow_receipt_date_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePurchaseAllocation {
    pub receipt_line_item_id: Option<Uuid>,
    pub allocated_qty: Option<i32>,
    pub allow_receipt_date_override: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AutoAllocatePurchaseRequest {
    #[serde(default)]
    pub allow_receipt_date_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoAllocatePurchaseResult {
    pub purchase_id: Uuid,
    pub purchase_qty: i32,
    pub previously_allocated_qty: i32,
    pub auto_allocated_qty: i32,
    pub total_allocated_qty: i32,
    pub remaining_qty: i32,
    pub allocations_created: i32,
    pub allocations_updated: i32,
    pub receipts_touched: i32,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPurchaseLine {
    pub item_id: Uuid,
    pub quantity: i32,
    pub purchase_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPurchaseRequest {
    pub lines: Vec<SplitPurchaseLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPurchaseResult {
    pub original_purchase_id: Uuid,
    pub created_purchases: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeBonusItem {
    pub item_id: Uuid,
    /// If None, auto-fill from existing purchases. If Some, use as fixed qty.
    pub quantity: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeBonusRequest {
    pub items: Vec<DistributeBonusItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeBonusPreviewItem {
    pub item_id: Uuid,
    pub item_name: String,
    pub auto_qty: i32,
    pub parent_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeBonusPreviewResult {
    pub items: Vec<DistributeBonusPreviewItem>,
    pub total_qty: i32,
    pub original_qty: i32,
    pub remainder: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeBonusResult {
    pub bonus_purchases_created: i32,
    pub total_qty_attributed: i32,
    pub remainder_qty: i32,
    pub remainder_purchase_id: Option<Uuid>,
}

// ============================================
// Query Parameters
// ============================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
pub struct ItemQuery {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditQuery {
    pub table_name: Option<String>,
    pub record_id: Option<Uuid>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::dec;
    use serde_json;

    // ==================== DeliveryStatus Enum ====================

    mod delivery_status_tests {
        use super::*;

        #[test]
        fn serializes_to_snake_case() {
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::Pending).unwrap(),
                "\"pending\""
            );
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::InTransit).unwrap(),
                "\"in_transit\""
            );
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::Delivered).unwrap(),
                "\"delivered\""
            );
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::Damaged).unwrap(),
                "\"damaged\""
            );
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::Returned).unwrap(),
                "\"returned\""
            );
            assert_eq!(
                serde_json::to_string(&DeliveryStatus::Lost).unwrap(),
                "\"lost\""
            );
        }

        #[test]
        fn deserializes_from_snake_case() {
            assert_eq!(
                serde_json::from_str::<DeliveryStatus>("\"pending\"").unwrap(),
                DeliveryStatus::Pending
            );
            assert_eq!(
                serde_json::from_str::<DeliveryStatus>("\"in_transit\"").unwrap(),
                DeliveryStatus::InTransit
            );
            assert_eq!(
                serde_json::from_str::<DeliveryStatus>("\"delivered\"").unwrap(),
                DeliveryStatus::Delivered
            );
        }

        #[test]
        fn rejects_invalid_status() {
            assert!(serde_json::from_str::<DeliveryStatus>("\"invalid\"").is_err());
            assert!(serde_json::from_str::<DeliveryStatus>("\"InTransit\"").is_err());
        }

        #[test]
        fn equality_works() {
            assert_eq!(DeliveryStatus::Pending, DeliveryStatus::Pending);
            assert_ne!(DeliveryStatus::Pending, DeliveryStatus::Delivered);
        }

        #[test]
        fn clone_works() {
            let status = DeliveryStatus::InTransit;
            let cloned = status.clone();
            assert_eq!(status, cloned);
        }
    }

    // ==================== Invoice (destination-based) ====================

    mod invoice_tests {
        use super::*;

        #[test]
        fn create_invoice_has_destination_id_not_vendor_id() {
            let json = r#"{
                "destination_id": "550e8400-e29b-41d4-a716-446655440000",
                "invoice_number": "INV-001",
                "invoice_date": "2026-01-15",
                "subtotal": "1500.00"
            }"#;
            let invoice: CreateInvoice = serde_json::from_str(json).unwrap();
            assert_eq!(
                invoice.destination_id,
                Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap()
            );
            assert_eq!(invoice.invoice_number, "INV-001");
        }

        #[test]
        fn create_invoice_rejects_vendor_id_field() {
            let json = r#"{
                "vendor_id": "550e8400-e29b-41d4-a716-446655440000",
                "invoice_number": "INV-001",
                "invoice_date": "2026-01-15",
                "subtotal": "1500.00"
            }"#;
            // Should fail because vendor_id is not a valid field and destination_id is missing
            assert!(serde_json::from_str::<CreateInvoice>(json).is_err());
        }

        #[test]
        fn create_invoice_with_all_optional_fields() {
            let json = r#"{
                "destination_id": "550e8400-e29b-41d4-a716-446655440000",
                "invoice_number": "INV-002",
                "order_number": "ORD-123",
                "invoice_date": "2026-02-01",
                "subtotal": "2500.50",
                "tax_rate": "13.00",
                "notes": "February shipment"
            }"#;
            let invoice: CreateInvoice = serde_json::from_str(json).unwrap();
            assert_eq!(invoice.order_number, Some("ORD-123".to_string()));
            assert_eq!(invoice.notes, Some("February shipment".to_string()));
            assert_eq!(invoice.subtotal, dec!(2500.50));
            assert_eq!(invoice.tax_amount, None);
            assert_eq!(invoice.tax_rate, Some(dec!(13.00)));
            assert_eq!(invoice.reconciliation_state, None);
        }

        #[test]
        fn create_invoice_optional_fields_default_to_none() {
            let json = r#"{
                "destination_id": "550e8400-e29b-41d4-a716-446655440000",
                "invoice_number": "INV-003",
                "invoice_date": "2026-03-01",
                "subtotal": "100.00"
            }"#;
            let invoice: CreateInvoice = serde_json::from_str(json).unwrap();
            assert_eq!(invoice.order_number, None);
            assert_eq!(invoice.notes, None);
            assert_eq!(invoice.tax_amount, None);
            assert_eq!(invoice.tax_rate, None);
            assert_eq!(invoice.reconciliation_state, None);
        }

        #[test]
        fn create_invoice_serializes_roundtrip() {
            let invoice = CreateInvoice {
                destination_id: Uuid::new_v4(),
                invoice_number: "INV-RT".to_string(),
                order_number: Some("ORD-RT".to_string()),
                invoice_date: NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
                delivery_date: None,
                subtotal: dec!(999.99),
                tax_amount: None,
                tax_rate: None,
                reconciliation_state: None,
                notes: None,
            };
            let json = serde_json::to_string(&invoice).unwrap();
            let deserialized: CreateInvoice = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized.destination_id, invoice.destination_id);
            assert_eq!(deserialized.invoice_number, invoice.invoice_number);
            assert_eq!(deserialized.subtotal, invoice.subtotal);
        }

        #[test]
        fn update_invoice_all_fields_optional() {
            let json = "{}";
            let update: UpdateInvoice = serde_json::from_str(json).unwrap();
            assert_eq!(update.invoice_number, None);
            assert_eq!(update.order_number, None);
            assert_eq!(update.invoice_date, None);
            assert_eq!(update.subtotal, None);
            assert_eq!(update.tax_amount, None);
            assert_eq!(update.tax_rate, None);
            assert_eq!(update.reconciliation_state, None);
            assert_eq!(update.notes, None);
        }

        #[test]
        fn update_invoice_partial_update() {
            let json = r#"{"subtotal": "1200.00", "notes": "Updated subtotal"}"#;
            let update: UpdateInvoice = serde_json::from_str(json).unwrap();
            assert_eq!(update.subtotal, Some(dec!(1200.00)));
            assert_eq!(update.notes, Some("Updated subtotal".to_string()));
            assert_eq!(update.invoice_number, None);
            assert_eq!(update.reconciliation_state, None);
        }
    }

    // ==================== InvoiceWithDestination ====================

    mod invoice_with_destination_tests {
        use super::*;

        fn make_invoice_with_dest() -> InvoiceWithDestination {
            InvoiceWithDestination {
                id: Uuid::new_v4(),
                destination_id: Uuid::new_v4(),
                destination_code: "CBG".to_string(),
                destination_name: "Canada Buying Group".to_string(),
                invoice_number: "INV-100".to_string(),
                order_number: Some("ORD-50".to_string()),
                invoice_date: NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                delivery_date: Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap()),
                subtotal: dec!(4424.78),
                tax_rate: dec!(13.00),
                total: dec!(5000.00),
                reconciliation_state: "open".to_string(),
                has_pdf: Some(false),
                notes: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                purchase_count: Some(3),
                purchases_total: Some(dec!(4424.78)),
                total_cost: Some(dec!(3500.00)),
                total_commission: Some(dec!(924.78)),
                receipted_count: Some(2),
            }
        }

        #[test]
        fn has_destination_fields_not_vendor() {
            let inv = make_invoice_with_dest();
            let json = serde_json::to_string(&inv).unwrap();
            assert!(json.contains("destination_id"));
            assert!(json.contains("destination_code"));
            assert!(json.contains("destination_name"));
            assert!(!json.contains("vendor_id"));
            assert!(!json.contains("vendor_name"));
        }

        #[test]
        fn serializes_purchase_aggregates() {
            let inv = make_invoice_with_dest();
            let json = serde_json::to_string(&inv).unwrap();
            assert!(json.contains("\"purchase_count\":3"));
            assert!(json.contains("4424.78"));
        }

        #[test]
        fn handles_null_aggregates() {
            let mut inv = make_invoice_with_dest();
            inv.purchase_count = None;
            inv.purchases_total = None;
            let json = serde_json::to_string(&inv).unwrap();
            // Should serialize nulls, not crash
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(parsed["purchase_count"].is_null());
            assert!(parsed["purchases_total"].is_null());
        }

        #[test]
        fn roundtrip_serialization() {
            let inv = make_invoice_with_dest();
            let json = serde_json::to_string(&inv).unwrap();
            let parsed: InvoiceWithDestination = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed.id, inv.id);
            assert_eq!(parsed.destination_code, "CBG");
            assert_eq!(parsed.invoice_number, "INV-100");
            assert_eq!(parsed.subtotal, dec!(4424.78));
            assert_eq!(parsed.total, dec!(5000.00));
            assert_eq!(parsed.has_pdf, Some(false));
        }
    }

    // ==================== InvoiceReconciliation ====================

    mod reconciliation_tests {
        use super::*;

        #[test]
        fn has_destination_fields_not_vendor() {
            let rec = InvoiceReconciliation {
                invoice_id: Uuid::new_v4(),
                invoice_number: "INV-200".to_string(),
                destination_code: "BSC".to_string(),
                destination_name: "Bulk Supply Co".to_string(),
                invoice_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                invoice_total: dec!(1000.00),
                purchases_total: dec!(1000.00),
                difference: dec!(0.00),
                is_matched: true,
                purchase_count: 5,
                total_cost: dec!(800.00),
                total_commission: dec!(200.00),
            };
            let json = serde_json::to_string(&rec).unwrap();
            assert!(json.contains("destination_code"));
            assert!(json.contains("destination_name"));
            assert!(!json.contains("vendor_name"));
        }

        #[test]
        fn matched_when_difference_zero() {
            let rec = InvoiceReconciliation {
                invoice_id: Uuid::new_v4(),
                invoice_number: "INV-300".to_string(),
                destination_code: "CBG".to_string(),
                destination_name: "Canada Buying Group".to_string(),
                invoice_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                invoice_total: dec!(500.00),
                purchases_total: dec!(500.00),
                difference: dec!(0.00),
                is_matched: true,
                purchase_count: 2,
                total_cost: dec!(400.00),
                total_commission: dec!(100.00),
            };
            assert!(rec.is_matched);
            assert_eq!(rec.difference, dec!(0.00));
        }

        #[test]
        fn unmatched_with_difference() {
            let rec = InvoiceReconciliation {
                invoice_id: Uuid::new_v4(),
                invoice_number: "INV-301".to_string(),
                destination_code: "BSC".to_string(),
                destination_name: "Bulk Supply Co".to_string(),
                invoice_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                invoice_total: dec!(500.00),
                purchases_total: dec!(450.00),
                difference: dec!(50.00),
                is_matched: false,
                purchase_count: 1,
                total_cost: dec!(350.00),
                total_commission: dec!(100.00),
            };
            assert!(!rec.is_matched);
            assert_eq!(rec.difference, dec!(50.00));
        }
    }

    // ==================== Summary Models ====================

    mod summary_tests {
        use super::*;

        #[test]
        fn destination_summary_has_invoices_field() {
            let summary = DestinationSummary {
                destination_id: Uuid::new_v4(),
                destination_code: "CBG".to_string(),
                destination_name: "Canada Buying Group".to_string(),
                total_invoices: Some(5),
                total_purchases: Some(20),
                total_quantity: Some(100),
                total_cost: Some(dec!(5000.00)),
                total_revenue: Some(dec!(7500.00)),
                total_commission: Some(dec!(2500.00)),
                total_tax_paid: Some(dec!(650.00)),
                total_tax_owed: Some(dec!(325.00)),
            };
            let json = serde_json::to_string(&summary).unwrap();
            assert!(json.contains("\"total_invoices\":5"));
        }

        #[test]
        fn vendor_summary_has_no_invoices_field() {
            let summary = VendorSummary {
                vendor_id: Uuid::new_v4(),
                vendor_name: "Best Buy".to_string(),
                total_receipts: Some(3),
                total_purchases: Some(10),
                total_quantity: Some(50),
                total_spent: Some(dec!(3000.00)),
            };
            let json = serde_json::to_string(&summary).unwrap();
            assert!(!json.contains("total_invoices"));
        }

        #[test]
        fn destination_summary_nullable_aggregates() {
            let summary = DestinationSummary {
                destination_id: Uuid::new_v4(),
                destination_code: "NEW".to_string(),
                destination_name: "New Destination".to_string(),
                total_invoices: None,
                total_purchases: None,
                total_quantity: None,
                total_cost: None,
                total_revenue: None,
                total_commission: None,
                total_tax_paid: None,
                total_tax_owed: None,
            };
            let json = serde_json::to_string(&summary).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(parsed["total_invoices"].is_null());
            assert!(parsed["total_purchases"].is_null());
        }
    }

    // ==================== Refund / Negative Quantity Tests ====================

    mod refund_tests {
        use super::*;

        #[test]
        fn create_purchase_accepts_negative_quantity_for_refund() {
            let json = serde_json::json!({
                "item_id": Uuid::new_v4(),
                "quantity": -1,
                "purchase_cost": "39.99"
            });
            let purchase: CreatePurchase = serde_json::from_value(json).unwrap();
            assert_eq!(purchase.quantity, -1);
        }

        #[test]
        fn create_purchase_accepts_positive_quantity() {
            let json = serde_json::json!({
                "item_id": Uuid::new_v4(),
                "quantity": 4,
                "purchase_cost": "39.99"
            });
            let purchase: CreatePurchase = serde_json::from_value(json).unwrap();
            assert_eq!(purchase.quantity, 4);
        }

        #[test]
        fn two_invoices_positive_and_refund_net_to_correct_quantity() {
            // Invoice 1: +4 items at $10 each
            // Invoice 2: -1 item (refund) at $10 each
            // Net quantity should be 3, net cost should be $30
            let inv1_id = Uuid::new_v4();
            let inv2_id = Uuid::new_v4();
            let item_id = Uuid::new_v4();
            let dest_id = Uuid::new_v4();
            let purchase_cost = dec!(10.00);

            let purchases = vec![
                Purchase {
                    id: Uuid::new_v4(),
                    item_id,
                    invoice_id: Some(inv1_id),
                    receipt_id: None,
                    quantity: 4,
                    purchase_cost,
                    invoice_unit_price: Some(dec!(12.00)),
                    destination_id: Some(dest_id),
                    status: DeliveryStatus::Pending,
                    delivery_date: None,
                    notes: None,
                    refunds_purchase_id: None,
                    purchase_type: "unit".to_string(),
                    bonus_for_purchase_id: None,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Purchase {
                    id: Uuid::new_v4(),
                    item_id,
                    invoice_id: Some(inv2_id),
                    receipt_id: None,
                    quantity: -1,
                    purchase_cost,
                    invoice_unit_price: Some(dec!(12.00)),
                    destination_id: Some(dest_id),
                    status: DeliveryStatus::Pending,
                    delivery_date: None,
                    notes: Some("Refund - 1 unit returned".to_string()),
                    refunds_purchase_id: None,
                    purchase_type: "refund".to_string(),
                    bonus_for_purchase_id: None,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            ];

            let net_quantity: i32 = purchases.iter().map(|p| p.quantity).sum();
            let net_cost: Decimal = purchases
                .iter()
                .map(|p| Decimal::from(p.quantity) * p.purchase_cost)
                .sum();

            assert_eq!(net_quantity, 3, "4 purchased - 1 refunded = 3 net");
            assert_eq!(net_cost, dec!(30.00), "4×$10 + (-1)×$10 = $30");
        }

        #[test]
        fn two_invoices_reconcile_with_refund() {
            // Invoice 1: total $40 (4 × $10), purchase total $40 → matched
            // Invoice 2: total -$10 (refund 1 × $10), purchase total -$10 → matched
            // Both invoices individually reconcile
            let rec_inv1 = InvoiceReconciliation {
                invoice_id: Uuid::new_v4(),
                invoice_number: "INV-SALE".to_string(),
                destination_code: "BSC".to_string(),
                destination_name: "Bulk Supply Co".to_string(),
                invoice_date: NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                invoice_total: dec!(40.00),
                purchases_total: dec!(40.00),
                difference: dec!(0.00),
                is_matched: true,
                purchase_count: 1,
                total_cost: dec!(32.00),
                total_commission: dec!(8.00),
            };

            let rec_inv2 = InvoiceReconciliation {
                invoice_id: Uuid::new_v4(),
                invoice_number: "INV-REFUND".to_string(),
                destination_code: "BSC".to_string(),
                destination_name: "Bulk Supply Co".to_string(),
                invoice_date: NaiveDate::from_ymd_opt(2026, 2, 15).unwrap(),
                invoice_total: dec!(-10.00),
                purchases_total: dec!(-10.00),
                difference: dec!(0.00),
                is_matched: true,
                purchase_count: 1,
                total_cost: dec!(-8.00),
                total_commission: dec!(-2.00),
            };

            assert!(rec_inv1.is_matched, "Sale invoice should reconcile");
            assert!(rec_inv2.is_matched, "Refund invoice should reconcile");

            // Cross-invoice net totals
            let net_invoice_total = rec_inv1.invoice_total + rec_inv2.invoice_total;
            let net_purchases_total = rec_inv1.purchases_total + rec_inv2.purchases_total;
            assert_eq!(
                net_invoice_total,
                dec!(30.00),
                "$40 sale + (-$10) refund = $30 net"
            );
            assert_eq!(net_purchases_total, dec!(30.00));
            assert_eq!(
                net_invoice_total, net_purchases_total,
                "Net totals reconcile"
            );
        }

        #[test]
        fn refund_economics_compute_negative_cost() {
            // A refund line: qty -1 at purchase_cost $8
            // total_cost = -1 × $8 = -$8 (cost returned)
            let econ = PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Best Buy".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: -1,
                purchase_cost: dec!(8.00),
                total_cost: Some(dec!(-8.00)),
                invoice_unit_price: Some(dec!(12.00)),
                total_selling: Some(dec!(-12.00)),
                unit_commission: Some(dec!(4.00)),
                total_commission: Some(dec!(-4.00)),
                tax_paid: Some(dec!(-1.04)),
                tax_owed: Some(dec!(-0.52)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: Some(Uuid::new_v4()),
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            };

            assert_eq!(econ.quantity, -1);
            assert_eq!(econ.total_cost, Some(dec!(-8.00)), "Refund returns cost");
        }

        #[test]
        fn net_economics_across_sale_and_refund() {
            // Sale: qty +4, cost $8 → cost $32
            // Refund: qty -1, cost $8 → cost -$8
            // Net: cost $24
            let sale = PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Best Buy".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: 4,
                purchase_cost: dec!(8.00),
                total_cost: Some(dec!(32.00)),
                invoice_unit_price: Some(dec!(12.00)),
                total_selling: Some(dec!(48.00)),
                unit_commission: Some(dec!(4.00)),
                total_commission: Some(dec!(16.00)),
                tax_paid: Some(dec!(4.16)),
                tax_owed: Some(dec!(2.08)),
                status: DeliveryStatus::Delivered,
                delivery_date: None,
                invoice_id: Some(Uuid::new_v4()),
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            };

            let refund = PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Best Buy".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: -1,
                purchase_cost: dec!(8.00),
                total_cost: Some(dec!(-8.00)),
                invoice_unit_price: Some(dec!(12.00)),
                total_selling: Some(dec!(-12.00)),
                unit_commission: Some(dec!(4.00)),
                total_commission: Some(dec!(-4.00)),
                tax_paid: Some(dec!(-1.04)),
                tax_owed: Some(dec!(-0.52)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: Some(Uuid::new_v4()),
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            };

            let items = vec![sale, refund];
            let net_qty: i32 = items.iter().map(|e| e.quantity).sum();
            let net_cost: Decimal = items.iter().filter_map(|e| e.total_cost).sum();

            assert_eq!(net_qty, 3, "+4 - 1 = 3 net units");
            assert_eq!(net_cost, dec!(24.00), "$32 - $8 = $24 net cost");
        }

        #[test]
        fn destination_summary_nets_refunds() {
            // Simulates what SUM(quantity) returns across purchases including refunds
            // 4 sold, 1 refunded → total_quantity = 3
            let summary = DestinationSummary {
                destination_id: Uuid::new_v4(),
                destination_code: "BSC".to_string(),
                destination_name: "Bulk Supply Co".to_string(),
                total_invoices: Some(2),
                total_purchases: Some(2),
                total_quantity: Some(3),             // 4 + (-1) = 3
                total_cost: Some(dec!(24.00)),       // 4×8 + (-1)×8 = 24
                total_revenue: Some(dec!(36.00)),    // 4×12 + (-1)×12 = 36
                total_commission: Some(dec!(12.00)), // 36 - 24 = 12
                total_tax_paid: Some(dec!(3.12)),
                total_tax_owed: Some(dec!(1.56)),
            };

            assert_eq!(
                summary.total_invoices,
                Some(2),
                "Two invoices: sale + refund"
            );
            assert_eq!(summary.total_quantity, Some(3), "Net quantity after refund");
            assert_eq!(
                summary.total_cost,
                Some(dec!(24.00)),
                "Net cost after refund"
            );
            assert_eq!(
                summary.total_revenue,
                Some(dec!(36.00)),
                "Net revenue after refund"
            );
            assert_eq!(
                summary.total_commission,
                Some(dec!(12.00)),
                "Net profit after refund"
            );
        }
    }

    // ==================== Other DTO Tests ====================

    mod dto_tests {
        use super::*;

        #[test]
        fn create_purchase_with_invoice_link() {
            let invoice_id = Uuid::new_v4();
            let json = serde_json::json!({
                "item_id": Uuid::new_v4(),
                "quantity": 5,
                "purchase_cost": "39.99",
                "invoice_id": invoice_id,
                "destination_id": Uuid::new_v4()
            });
            let purchase: CreatePurchase = serde_json::from_value(json).unwrap();
            assert_eq!(purchase.invoice_id, Some(invoice_id));
            assert_eq!(purchase.quantity, 5);
        }

        #[test]
        fn create_purchase_without_invoice() {
            let json = serde_json::json!({
                "item_id": Uuid::new_v4(),
                "quantity": 3,
                "purchase_cost": "19.99"
            });
            let purchase: CreatePurchase = serde_json::from_value(json).unwrap();
            assert_eq!(purchase.invoice_id, None);
            assert_eq!(purchase.destination_id, None);
            assert_eq!(purchase.status, None);
        }

        #[test]
        fn status_update_deserializes() {
            let json = r#"{"status": "delivered"}"#;
            let update: StatusUpdate = serde_json::from_str(json).unwrap();
            assert_eq!(update.status, DeliveryStatus::Delivered);
        }

        #[test]
        fn create_vendor_minimal() {
            let json = r#"{"name": "Amazon"}"#;
            let vendor: CreateVendor = serde_json::from_str(json).unwrap();
            assert_eq!(vendor.name, "Amazon");
        }

        #[test]
        fn create_destination_with_defaults() {
            let json = r#"{"code": "TST", "name": "Test Dest"}"#;
            let dest: CreateDestination = serde_json::from_str(json).unwrap();
            assert_eq!(dest.code, "TST");
            assert_eq!(dest.is_active, None); // defaults handled by DB
        }

        #[test]
        fn purchase_query_defaults() {
            let query = PurchaseQuery::default();
            assert_eq!(query.status, None);
            assert_eq!(query.destination_id, None);
            assert_eq!(query.vendor_id, None);
            assert_eq!(query.from, None);
            assert_eq!(query.to, None);
            assert_eq!(query.limit, None);
            assert_eq!(query.offset, None);
        }

        #[test]
        fn purchase_query_from_json() {
            let json = r#"{"status": "pending", "limit": 50}"#;
            let query: PurchaseQuery = serde_json::from_str(json).unwrap();
            assert_eq!(query.status, Some(DeliveryStatus::Pending));
            assert_eq!(query.limit, Some(50));
            assert_eq!(query.destination_id, None);
        }
    }

    // ==================== Item Model (no vendor) ====================
    // These tests guarantee that Item and ActiveItem never regress back to
    // having vendor fields. The 500 error on /api/items/active was caused
    // by a stale query referencing vendor_id after the column was dropped.

    mod item_model_tests {
        use super::*;

        #[test]
        fn item_has_no_vendor_field() {
            let item = Item {
                id: Uuid::new_v4(),
                name: "Echo Dot".to_string(),
                default_destination_id: None,
                notes: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            };
            let json = serde_json::to_string(&item).unwrap();
            assert!(
                !json.contains("vendor_id"),
                "Item must not have vendor_id field"
            );
            assert!(
                !json.contains("vendor_name"),
                "Item must not have vendor_name field"
            );
        }

        #[test]
        fn active_item_has_no_vendor_field() {
            let item = ActiveItem {
                id: Uuid::new_v4(),
                name: "PS5".to_string(),
                default_destination_id: None,
                default_destination_code: Some("BSC".to_string()),
                notes: None,
                created_at: Utc::now(),
                total_qty: 0,
                total_value: dec!(0),
                min_unit_cost: None,
                avg_unit_cost: None,
                max_unit_cost: None,
                total_commission: None,
                avg_unit_commission: None,
                last_receipt_date: None,
            };
            let json = serde_json::to_string(&item).unwrap();
            assert!(
                !json.contains("vendor_id"),
                "ActiveItem must not have vendor_id"
            );
            assert!(
                !json.contains("vendor_name"),
                "ActiveItem must not have vendor_name"
            );
        }

        #[test]
        fn create_item_has_no_vendor_field() {
            let json = serde_json::json!({
                "name": "Test Item",
                "default_destination_id": null,
                "notes": null
            });
            let item: CreateItem = serde_json::from_value(json).unwrap();
            assert_eq!(item.name, "Test Item");
            let serialized = serde_json::to_string(&item).unwrap();
            assert!(
                !serialized.contains("vendor"),
                "CreateItem must not have any vendor field"
            );
        }

        #[test]
        fn create_item_minimal() {
            // Only name is required
            let json = r#"{"name": "Widget"}"#;
            let item: CreateItem = serde_json::from_str(json).unwrap();
            assert_eq!(item.name, "Widget");
            assert_eq!(item.default_destination_id, None);
            assert_eq!(item.notes, None);
        }

        #[test]
        fn create_item_with_destination_and_notes() {
            let dest_id = Uuid::new_v4();
            let json = serde_json::json!({
                "name": "Echo Dot",
                "default_destination_id": dest_id,
                "notes": "5th gen"
            });
            let item: CreateItem = serde_json::from_value(json).unwrap();
            assert_eq!(item.name, "Echo Dot");
            assert_eq!(item.default_destination_id, Some(dest_id));
            assert_eq!(item.notes, Some("5th gen".to_string()));
        }

        #[test]
        fn active_item_roundtrip() {
            let item = ActiveItem {
                id: Uuid::new_v4(),
                name: "Switch OLED".to_string(),
                default_destination_id: Some(Uuid::new_v4()),
                default_destination_code: Some("CBG".to_string()),
                notes: Some("White model".to_string()),
                created_at: Utc::now(),
                total_qty: 0,
                total_value: dec!(0),
                min_unit_cost: None,
                avg_unit_cost: None,
                max_unit_cost: None,
                total_commission: None,
                avg_unit_commission: None,
                last_receipt_date: None,
            };
            let json = serde_json::to_string(&item).unwrap();
            let parsed: ActiveItem = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed.id, item.id);
            assert_eq!(parsed.name, "Switch OLED");
            assert_eq!(parsed.default_destination_code, Some("CBG".to_string()));
        }

        #[test]
        fn item_query_is_empty_struct() {
            // ItemQuery should have no fields (vendor_id was removed)
            let json = "{}";
            let query: ItemQuery = serde_json::from_str(json).unwrap();
            let serialized = serde_json::to_string(&query).unwrap();
            assert_eq!(serialized, "{}");
        }
    }

    // ==================== Zero Purchase Cost Economics ====================
    // When purchase_cost = 0 (cost unknown), the view treats it as if
    // cost = invoice_unit_price, so commission = 0 (break-even) instead of
    // inflated profit. These tests validate the expected model values
    // that the view would produce.

    mod zero_cost_economics_tests {
        use super::*;

        /// Helper: builds a PurchaseEconomics with the logic the view applies
        /// when purchase_cost = 0 (uses invoice_unit_price as effective cost).
        fn make_zero_cost_economics(qty: i32, invoice_unit_price: Decimal) -> PurchaseEconomics {
            PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Amazon".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: qty,
                purchase_cost: dec!(0),
                // View logic: total_cost = qty * invoice_unit_price when cost = 0
                total_cost: Some(Decimal::from(qty) * invoice_unit_price),
                invoice_unit_price: Some(invoice_unit_price),
                total_selling: Some(Decimal::from(qty) * invoice_unit_price),
                // View logic: commission = 0 when cost = 0
                unit_commission: Some(dec!(0)),
                total_commission: Some(dec!(0)),
                // View logic: tax_paid = qty * invoice_unit_price * 0.13 when cost = 0
                tax_paid: Some(Decimal::from(qty) * invoice_unit_price * dec!(0.13)),
                tax_owed: Some(dec!(0)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: None,
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            }
        }

        /// Helper: builds a PurchaseEconomics with normal (nonzero) cost.
        fn make_normal_economics(qty: i32, cost: Decimal, sell: Decimal) -> PurchaseEconomics {
            let commission = sell - cost;
            PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Amazon".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: qty,
                purchase_cost: cost,
                total_cost: Some(Decimal::from(qty) * cost),
                invoice_unit_price: Some(sell),
                total_selling: Some(Decimal::from(qty) * sell),
                unit_commission: Some(commission),
                total_commission: Some(Decimal::from(qty) * commission),
                tax_paid: Some(Decimal::from(qty) * cost * dec!(0.13)),
                tax_owed: Some(Decimal::from(qty) * commission * dec!(0.13)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: None,
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            }
        }

        #[test]
        fn zero_cost_shows_zero_commission() {
            let econ = make_zero_cost_economics(3, dec!(25.00));
            assert_eq!(econ.purchase_cost, dec!(0));
            assert_eq!(
                econ.unit_commission,
                Some(dec!(0)),
                "Commission must be 0 when purchase cost unknown"
            );
            assert_eq!(
                econ.total_commission,
                Some(dec!(0)),
                "Total commission must be 0 when purchase cost unknown"
            );
        }

        #[test]
        fn zero_cost_total_cost_uses_invoice_unit_price() {
            let econ = make_zero_cost_economics(4, dec!(30.00));
            // total_cost should be qty * invoice_unit_price = 4 * 30 = 120
            assert_eq!(
                econ.total_cost,
                Some(dec!(120.00)),
                "total_cost should use invoice_unit_price as effective cost"
            );
            assert_eq!(
                econ.total_selling,
                Some(dec!(120.00)),
                "total_selling = qty * invoice_unit_price"
            );
            // total_cost == total_selling (break-even)
            assert_eq!(
                econ.total_cost, econ.total_selling,
                "When cost unknown, total_cost = total_selling (break-even)"
            );
        }

        #[test]
        fn zero_cost_tax_paid_uses_invoice_unit_price() {
            let econ = make_zero_cost_economics(2, dec!(50.00));
            // tax_paid = qty * invoice_unit_price * 0.13 = 2 * 50 * 0.13 = 13
            assert_eq!(
                econ.tax_paid,
                Some(dec!(13.00)),
                "tax_paid should use invoice_unit_price when cost is 0"
            );
        }

        #[test]
        fn zero_cost_tax_owed_is_zero() {
            let econ = make_zero_cost_economics(2, dec!(50.00));
            assert_eq!(
                econ.tax_owed,
                Some(dec!(0)),
                "tax_owed should be 0 when cost unknown (no proven profit)"
            );
        }

        #[test]
        fn nonzero_cost_calculates_normally() {
            let econ = make_normal_economics(3, dec!(10.00), dec!(15.00));
            assert_eq!(econ.total_cost, Some(dec!(30.00)));
            assert_eq!(econ.total_selling, Some(dec!(45.00)));
            assert_eq!(econ.unit_commission, Some(dec!(5.00)));
            assert_eq!(econ.total_commission, Some(dec!(15.00)));
            assert_eq!(econ.tax_paid, Some(dec!(3.90))); // 30 * 0.13
            assert_eq!(econ.tax_owed, Some(dec!(1.95))); // 15 * 0.13
        }

        #[test]
        fn zero_cost_vs_nonzero_cost_commission_differs() {
            let zero = make_zero_cost_economics(1, dec!(100.00));
            let normal = make_normal_economics(1, dec!(80.00), dec!(100.00));

            // Zero cost: commission = 0 (we don't know the cost)
            assert_eq!(zero.total_commission, Some(dec!(0)));
            // Normal: commission = 100 - 80 = 20
            assert_eq!(normal.total_commission, Some(dec!(20.00)));
        }

        #[test]
        fn zero_cost_single_unit() {
            let econ = make_zero_cost_economics(1, dec!(99.99));
            assert_eq!(
                econ.total_cost,
                Some(dec!(99.99)),
                "Single unit: total_cost = invoice_unit_price"
            );
            assert_eq!(econ.total_selling, Some(dec!(99.99)));
            assert_eq!(econ.total_commission, Some(dec!(0)));
        }

        #[test]
        fn vendor_name_nullable_in_economics() {
            let mut econ = make_zero_cost_economics(1, dec!(10.00));
            econ.vendor_name = None;
            let json = serde_json::to_string(&econ).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(
                parsed["vendor_name"].is_null(),
                "vendor_name should serialize as null when no receipt linked"
            );
        }

        /// Expose helper for cross-module comparison tests.
        pub fn tests_make_zero_cost(qty: i32, invoice_unit_price: Decimal) -> PurchaseEconomics {
            make_zero_cost_economics(qty, invoice_unit_price)
        }
    }

    mod bonus_economics_tests {
        use super::*;

        /// Helper: builds a PurchaseEconomics matching the DB logic for bonus
        /// purchases (purchase_type = 'bonus', purchase_cost = 0).
        /// Bonuses must always be attributed to a parent purchase; their
        /// commission is credited to the parent (this row shows $0).
        fn make_bonus_economics(qty: i32, invoice_unit_price: Decimal) -> PurchaseEconomics {
            PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Amazon".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: qty,
                purchase_cost: dec!(0),
                // Bonus: total_cost = 0 (cost is genuinely zero)
                total_cost: Some(dec!(0)),
                invoice_unit_price: Some(invoice_unit_price),
                total_selling: Some(Decimal::from(qty) * invoice_unit_price),
                // Attributed bonus: commission credited to parent, this row shows 0
                unit_commission: Some(dec!(0)),
                total_commission: Some(dec!(0)),
                // Bonus: tax_paid = 0 (no purchase cost)
                tax_paid: Some(dec!(0)),
                // Attributed bonus: tax_owed = 0 (credited to parent)
                tax_owed: Some(dec!(0)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: None,
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: Some("bonus".to_string()),
                bonus_for_purchase_id: Some(Uuid::new_v4()),
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            }
        }

        #[test]
        fn bonus_total_cost_is_zero() {
            let econ = make_bonus_economics(3, dec!(25.00));
            assert_eq!(econ.purchase_cost, dec!(0));
            assert_eq!(
                econ.total_cost,
                Some(dec!(0)),
                "Bonus total_cost must be 0 (cost is genuinely zero)"
            );
        }

        #[test]
        fn bonus_commission_is_zero_credited_to_parent() {
            let econ = make_bonus_economics(3, dec!(25.00));
            assert_eq!(
                econ.unit_commission,
                Some(dec!(0)),
                "Bonus unit_commission = 0 (credited to parent)"
            );
            assert_eq!(
                econ.total_commission,
                Some(dec!(0)),
                "Bonus total_commission = 0 (credited to parent)"
            );
        }

        #[test]
        fn bonus_tax_paid_is_zero() {
            let econ = make_bonus_economics(2, dec!(50.00));
            assert_eq!(
                econ.tax_paid,
                Some(dec!(0)),
                "Bonus tax_paid must be 0 (no purchase cost)"
            );
        }

        #[test]
        fn bonus_tax_owed_is_zero() {
            let econ = make_bonus_economics(2, dec!(50.00));
            assert_eq!(
                econ.tax_owed,
                Some(dec!(0)),
                "Bonus tax_owed = 0 (credited to parent)"
            );
        }

        #[test]
        fn bonus_single_unit() {
            let econ = make_bonus_economics(1, dec!(99.99));
            assert_eq!(econ.total_cost, Some(dec!(0)));
            assert_eq!(econ.total_selling, Some(dec!(99.99)));
            assert_eq!(econ.unit_commission, Some(dec!(0)));
            assert_eq!(econ.total_commission, Some(dec!(0)));
            assert_eq!(econ.tax_paid, Some(dec!(0)));
            assert_eq!(
                econ.tax_owed,
                Some(dec!(0)),
                "tax_owed = 0 (credited to parent)"
            );
        }

        #[test]
        fn bonus_vs_zero_cost_both_show_zero_commission() {
            let bonus = make_bonus_economics(1, dec!(100.00));
            let zero_cost = super::zero_cost_economics_tests::tests_make_zero_cost(1, dec!(100.00));

            // Bonus (attributed): commission = 0 (credited to parent)
            assert_eq!(bonus.total_commission, Some(dec!(0)));
            // Zero cost (unknown): commission = 0 (can't compute)
            assert_eq!(zero_cost.total_commission, Some(dec!(0)));
            // Difference: bonus has parent link, zero-cost doesn't
            assert!(bonus.bonus_for_purchase_id.is_some());
            assert!(zero_cost.bonus_for_purchase_id.is_none());
        }

        #[test]
        fn bonus_purchase_type_is_set() {
            let econ = make_bonus_economics(1, dec!(10.00));
            assert_eq!(
                econ.purchase_type,
                Some("bonus".to_string()),
                "purchase_type must be 'bonus'"
            );
        }

        #[test]
        fn bonus_has_parent_link() {
            let econ = make_bonus_economics(1, dec!(10.00));
            assert!(
                econ.bonus_for_purchase_id.is_some(),
                "Bonus must have bonus_for_purchase_id set"
            );
        }

        /// Simulates the parent purchase economics after receiving a bonus boost.
        /// Parent: 10 units at $5 cost, $8 invoice price
        /// Bonus: 2 units at $8 invoice price (attributed)
        /// Expected: parent's total_commission = 10 * (8-5) + 2*8 = 30 + 16 = 46
        #[test]
        fn parent_boosted_by_attributed_bonus() {
            let bonus_selling = Decimal::from(2) * dec!(8.00); // 16.00
            let own_commission = Decimal::from(10) * (dec!(8.00) - dec!(5.00)); // 30.00
            let boosted_commission = own_commission + bonus_selling; // 46.00

            let parent = PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: Some("Amazon".to_string()),
                destination_code: Some("BSC".to_string()),
                quantity: 10,
                purchase_cost: dec!(5.00),
                total_cost: Some(dec!(50.00)),
                invoice_unit_price: Some(dec!(8.00)),
                // total_selling boosted: 10*8 + 16 = 96
                total_selling: Some(Decimal::from(10) * dec!(8.00) + bonus_selling),
                // unit_commission boosted: (8-5) + 16/10 = 4.60
                unit_commission: Some(dec!(3.00) + bonus_selling / Decimal::from(10)),
                total_commission: Some(boosted_commission),
                tax_paid: Some(Decimal::from(10) * dec!(5.00) * dec!(0.13)),
                tax_owed: Some(boosted_commission * dec!(0.13)),
                status: DeliveryStatus::Pending,
                delivery_date: None,
                invoice_id: None,
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: Some("unit".to_string()),
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            };

            assert_eq!(parent.total_commission, Some(dec!(46.00)));
            assert_eq!(parent.unit_commission, Some(dec!(4.60)));
            assert_eq!(parent.total_selling, Some(dec!(96.00)));
            assert_eq!(parent.tax_owed, Some(dec!(5.98)));
        }

        #[test]
        fn bonus_parent_fields_none_by_default() {
            let econ = make_bonus_economics(1, dec!(10.00));
            // Test helper sets no parent info — simulates unresolved parent
            assert!(econ.bonus_parent_item_name.is_none());
            assert!(econ.bonus_parent_quantity.is_none());
            assert!(econ.bonus_parent_invoice_number.is_none());
        }

        #[test]
        fn bonus_parent_fields_populated_for_cross_invoice() {
            let mut econ = make_bonus_economics(3, dec!(0.50));
            econ.bonus_parent_item_name = Some("Echo Dot 5th Gen Blue".to_string());
            econ.bonus_parent_quantity = Some(28);
            econ.bonus_parent_invoice_number = Some("6".to_string());

            assert_eq!(econ.bonus_parent_item_name.as_deref(), Some("Echo Dot 5th Gen Blue"));
            assert_eq!(econ.bonus_parent_quantity, Some(28));
            assert_eq!(econ.bonus_parent_invoice_number.as_deref(), Some("6"));
            assert!(econ.bonus_for_purchase_id.is_some(), "attributed bonus must have parent id");
        }

        #[test]
        fn unit_purchase_has_no_parent_fields() {
            let parent = PurchaseEconomics {
                purchase_id: Uuid::new_v4(),
                purchase_date: Utc::now(),
                item_id: Uuid::new_v4(),
                item_name: "Widget".to_string(),
                vendor_name: None,
                destination_code: None,
                quantity: 5,
                purchase_cost: dec!(10),
                total_cost: Some(dec!(50)),
                invoice_unit_price: Some(dec!(15)),
                total_selling: Some(dec!(75)),
                unit_commission: Some(dec!(5)),
                total_commission: Some(dec!(25)),
                tax_paid: Some(dec!(6.50)),
                tax_owed: Some(dec!(3.25)),
                status: DeliveryStatus::Delivered,
                delivery_date: None,
                invoice_id: None,
                receipt_id: None,
                receipt_number: None,
                invoice_number: None,
                allow_receipt_date_override: false,
                notes: None,
                refunds_purchase_id: None,
                purchase_type: Some("unit".to_string()),
                bonus_for_purchase_id: None,
                invoice_reconciliation_state: None,
                bonus_parent_item_name: None,
                bonus_parent_quantity: None,
                bonus_parent_invoice_number: None,
            };

            assert!(parent.bonus_for_purchase_id.is_none());
            assert!(parent.bonus_parent_item_name.is_none());
            assert!(parent.bonus_parent_quantity.is_none());
            assert!(parent.bonus_parent_invoice_number.is_none());
        }

        #[test]
        fn bonus_parent_fields_serialize_in_json() {
            let mut econ = make_bonus_economics(2, dec!(0.50));
            econ.bonus_parent_item_name = Some("PS5 Pro".to_string());
            econ.bonus_parent_quantity = Some(6);
            econ.bonus_parent_invoice_number = Some("7".to_string());

            let json = serde_json::to_value(&econ).unwrap();
            assert_eq!(json["bonus_parent_item_name"], "PS5 Pro");
            assert_eq!(json["bonus_parent_quantity"], 6);
            assert_eq!(json["bonus_parent_invoice_number"], "7");
        }

        #[test]
        fn bonus_parent_fields_serialize_null_when_none() {
            let econ = make_bonus_economics(1, dec!(0.50));
            let json = serde_json::to_value(&econ).unwrap();
            assert!(json["bonus_parent_item_name"].is_null());
            assert!(json["bonus_parent_quantity"].is_null());
            assert!(json["bonus_parent_invoice_number"].is_null());
        }
    }
}
