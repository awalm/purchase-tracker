use axum::{
    extract::{DefaultBodyLimit, Multipart, Query, State},
    http::StatusCode,
    routing::post,
    Json, Router,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    db::{models::*, queries},
};

use super::AppState;

const IMPORT_MULTIPART_MAX_BYTES: usize = 25 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/vendors", post(import_vendors))
        .route("/destinations", post(import_destinations))
        .route("/items", post(import_items))
        .route("/purchases", post(import_purchases))
        .route("/receipts", post(import_receipts))
        .route("/receipts/preview", post(preview_receipts))
        .route("/invoice-pdf", post(parse_invoice_pdf))
        .route("/receipt-image", post(parse_receipt_image))
        .route("/invoice-pdf/commit", post(commit_invoice_pdf))
        .layer(DefaultBodyLimit::max(IMPORT_MULTIPART_MAX_BYTES))
}

#[derive(Debug, Deserialize)]
pub struct ImportCsvRequest {
    pub csv_data: String,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub success_count: usize,
    pub error_count: usize,
    pub duplicate_count: usize,
    pub errors: Vec<ImportError>,
    pub failed_rows_csv: String,
}

#[derive(Debug, Serialize)]
pub struct ImportError {
    pub row: usize,
    pub message: String,
    pub original_data: String,
}

#[derive(Debug, Deserialize, Clone)]
struct CsvPurchaseRow {
    #[serde(
        alias = "item",
        alias = "item_id",
        alias = "Item",
        alias = "Item Name",
        alias = "item_name"
    )]
    item: String,

    #[serde(
        alias = "destination",
        alias = "dest",
        alias = "Destination",
        alias = "dest_code",
        alias = "Dest",
        alias = "Default Destination",
        alias = "Default Dest"
    )]
    destination: Option<String>,

    #[serde(alias = "qty", alias = "Qty", alias = "Quantity")]
    quantity: i32,

    #[serde(
        alias = "cost",
        alias = "unit_cost",
        alias = "purchase_cost",
        alias = "Cost",
        alias = "Unit Cost",
        alias = "Purchase Cost",
        alias = "Item Cost"
    )]
    purchase_cost: String,

    #[serde(alias = "date", alias = "Date", alias = "purchase_date", default)]
    date: Option<String>,

    #[serde(
        alias = "invoice",
        alias = "Invoice",
        alias = "invoice_number",
        default
    )]
    invoice: Option<String>,

    #[serde(
        alias = "receipt",
        alias = "Receipt",
        alias = "receipt_number",
        default
    )]
    receipt: Option<String>,

    #[serde(
        alias = "invoice_unit_price",
        alias = "Invoice Unit Price",
        alias = "unit_price",
        alias = "price",
        default
    )]
    invoice_unit_price: Option<String>,

    #[serde(alias = "Status", alias = "status", alias = "delivery_status", default)]
    status: Option<String>,

    #[serde(
        alias = "delivery_date",
        alias = "Delivery Date",
        alias = "delivered",
        default
    )]
    delivery_date: Option<String>,

    #[serde(alias = "Notes", alias = "notes", alias = "Note", default)]
    notes: Option<String>,
}

impl CsvPurchaseRow {
    fn duplicate_key(&self, item_id: Uuid, date: NaiveDate) -> String {
        format!(
            "{}|{}|{}|{}",
            item_id,
            date,
            self.quantity,
            self.purchase_cost.replace(['$', ',', ' '], "")
        )
    }
}

#[derive(Debug, Deserialize, Clone)]
struct CsvReceiptRow {
    #[serde(
        alias = "vendor",
        alias = "Vendor",
        alias = "vendor_name",
        alias = "Vendor Name",
        alias = "vendor_id"
    )]
    vendor: String,

    #[serde(
        alias = "receipt_number",
        alias = "receipt",
        alias = "Receipt",
        alias = "Receipt Number",
        alias = "number",
        default
    )]
    receipt_number: Option<String>,

    #[serde(
        alias = "receipt_date",
        alias = "Receipt Date",
        alias = "date",
        alias = "Date"
    )]
    receipt_date: String,

    #[serde(alias = "subtotal", alias = "Subtotal")]
    subtotal: String,

    #[serde(
        alias = "tax_amount",
        alias = "Tax Amount",
        alias = "tax",
        alias = "Tax",
        default
    )]
    tax_amount: Option<String>,

    #[serde(alias = "payment_method", alias = "Payment Method", default)]
    payment_method: Option<String>,

    #[serde(alias = "notes", alias = "Notes", alias = "note", default)]
    notes: Option<String>,
}

#[derive(Debug, Serialize)]
struct PreviewRow<T> {
    row: usize,
    data: T,
    is_duplicate: bool,
}

#[derive(Debug, Serialize)]
struct PreviewErrorRow {
    row: usize,
    message: String,
    original_data: String,
}

#[derive(Debug, Serialize)]
struct PreviewResult<T> {
    valid_rows: Vec<PreviewRow<T>>,
    error_rows: Vec<PreviewErrorRow>,
    total_count: usize,
    valid_count: usize,
    error_count: usize,
    duplicate_count: usize,
}

#[derive(Debug, Serialize)]
struct ReceiptPreview {
    vendor_name: String,
    receipt_number: Option<String>,
    receipt_date: String,
    subtotal: String,
    tax_amount: Option<String>,
    payment_method: Option<String>,
    notes: Option<String>,
}

fn receipt_duplicate_key(vendor_id: Uuid, receipt_number: &str) -> String {
    format!("{}|{}", vendor_id, receipt_number.trim().to_lowercase())
}

fn parse_date_yyyy_mm_dd_or_mm_dd_yyyy(value: &str) -> Result<NaiveDate, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Date is required".to_string());
    }

    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(trimmed, "%m/%d/%Y"))
        .map_err(|_| format!("Invalid date: {} (use YYYY-MM-DD)", value))
}

fn parse_decimal(value: &str, field_name: &str) -> Result<Decimal, String> {
    let cleaned = value.replace(['$', ',', ' '], "");
    Decimal::from_str(&cleaned).map_err(|_| format!("Invalid {}: {}", field_name, value))
}

fn parse_optional_decimal(
    value: Option<&str>,
    field_name: &str,
) -> Result<Option<Decimal>, String> {
    match value.map(|v| v.trim()).filter(|v| !v.is_empty()) {
        Some(v) => parse_decimal(v, field_name).map(Some),
        None => Ok(None),
    }
}

fn normalize_optional_payment_method(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_import_alias_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn resolve_vendor<'a>(
    vendor_ref: &str,
    vendors: &'a [Vendor],
    vendor_by_name: &HashMap<String, &'a Vendor>,
    vendor_by_short_id: &HashMap<String, &'a Vendor>,
    vendor_by_alias: &HashMap<String, Uuid>,
) -> Option<&'a Vendor> {
    let trimmed = vendor_ref.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized_alias = normalize_import_alias_key(trimmed);
    if let Some(vendor_id) = vendor_by_alias.get(&normalized_alias) {
        if let Some(vendor) = vendors.iter().find(|v| v.id == *vendor_id) {
            return Some(vendor);
        }
    }

    if let Ok(vendor_id) = Uuid::from_str(trimmed) {
        return vendors.iter().find(|v| v.id == vendor_id);
    }

    if let Some(v) = vendor_by_name.get(&trimmed.to_lowercase()) {
        return Some(*v);
    }

    if let Some(v) = vendor_by_short_id.get(&trimmed.to_lowercase()) {
        return Some(*v);
    }

    None
}

// ==================== VENDORS ====================

#[derive(Debug, Deserialize)]
struct CsvVendorRow {
    #[serde(alias = "Name", alias = "vendor_name", alias = "Vendor")]
    name: String,
}

async fn import_vendors(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let mut success_count = 0;
    let mut duplicate_count = 0;
    let mut errors: Vec<ImportError> = Vec::new();

    let existing_vendors = queries::get_all_vendors(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let existing_names: HashSet<String> = existing_vendors
        .iter()
        .map(|v| v.name.to_lowercase())
        .collect();

    let mut batch_names: HashSet<String> = HashSet::new();
    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();
    let header_line = csv_lines.first().cloned().unwrap_or_default();

    for (row_idx, result) in reader.deserialize::<CsvVendorRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                let name_lower = row.name.to_lowercase();

                if existing_names.contains(&name_lower) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: format!("Vendor already exists: {}", row.name),
                        original_data: original_line,
                    });
                    continue;
                }

                if batch_names.contains(&name_lower) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: "Duplicate in CSV".to_string(),
                        original_data: original_line,
                    });
                    continue;
                }

                let create_data = CreateVendor {
                    name: row.name.clone(),
                    short_id: None,
                };
                match queries::create_vendor(&state.pool, create_data, user.user_id).await {
                    Ok(_) => {
                        success_count += 1;
                        batch_names.insert(name_lower);
                    }
                    Err(e) => {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Database error: {}", e),
                            original_data: original_line,
                        });
                    }
                }
            }
            Err(e) => {
                errors.push(ImportError {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let failed_rows_csv = build_failed_csv(&header_line, &errors);

    Ok(Json(ImportResult {
        success_count,
        error_count: errors.len(),
        duplicate_count,
        errors,
        failed_rows_csv,
    }))
}

// ==================== DESTINATIONS ====================

#[derive(Debug, Deserialize)]
struct CsvDestinationRow {
    #[serde(alias = "Code", alias = "destination_code", alias = "Destination")]
    code: String,

    #[serde(alias = "Name", alias = "destination_name")]
    name: String,
}

async fn import_destinations(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let mut success_count = 0;
    let mut duplicate_count = 0;
    let mut errors: Vec<ImportError> = Vec::new();

    let existing = queries::get_all_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let existing_codes: HashSet<String> = existing.iter().map(|d| d.code.to_lowercase()).collect();

    let mut batch_codes: HashSet<String> = HashSet::new();
    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();
    let header_line = csv_lines.first().cloned().unwrap_or_default();

    for (row_idx, result) in reader.deserialize::<CsvDestinationRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                let code_lower = row.code.to_lowercase();

                if existing_codes.contains(&code_lower) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: format!("Destination already exists: {}", row.code),
                        original_data: original_line,
                    });
                    continue;
                }

                if batch_codes.contains(&code_lower) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: "Duplicate in CSV".to_string(),
                        original_data: original_line,
                    });
                    continue;
                }

                let create_dest = CreateDestination {
                    code: row.code.clone(),
                    name: row.name.clone(),
                    is_active: Some(true),
                };

                match queries::create_destination(&state.pool, create_dest, user.user_id).await {
                    Ok(_) => {
                        success_count += 1;
                        batch_codes.insert(code_lower);
                    }
                    Err(e) => {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Database error: {}", e),
                            original_data: original_line,
                        });
                    }
                }
            }
            Err(e) => {
                errors.push(ImportError {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let failed_rows_csv = build_failed_csv(&header_line, &errors);

    Ok(Json(ImportResult {
        success_count,
        error_count: errors.len(),
        duplicate_count,
        errors,
        failed_rows_csv,
    }))
}

// ==================== ITEMS ====================

#[derive(Debug, Deserialize)]
struct CsvItemRow {
    #[serde(alias = "Name", alias = "item_name", alias = "Item", alias = "item")]
    name: String,

    #[serde(
        alias = "Destination",
        alias = "default_destination",
        alias = "dest_code",
        alias = "Default Destination",
        alias = "Default Dest",
        alias = "Dest",
        alias = "dest",
        alias = "destination",
        default
    )]
    destination: Option<String>,

    #[serde(alias = "Notes", alias = "notes", alias = "Note", default)]
    notes: Option<String>,
}

async fn import_items(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let mut success_count = 0;
    let mut duplicate_count = 0;
    let mut errors: Vec<ImportError> = Vec::new();

    let destinations = queries::get_all_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let existing_items = queries::get_active_items(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let dest_by_code: HashMap<String, &Destination> = destinations
        .iter()
        .map(|d| (d.code.to_lowercase(), d))
        .collect();
    let existing_names: HashSet<String> = existing_items
        .iter()
        .map(|i| i.name.to_lowercase())
        .collect();

    let mut batch_names: HashSet<String> = HashSet::new();
    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();
    let header_line = csv_lines.first().cloned().unwrap_or_default();

    for (row_idx, result) in reader.deserialize::<CsvItemRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                // Skip empty rows
                if row.name.trim().is_empty() {
                    continue;
                }

                // Check for duplicate item name
                let item_key = row.name.to_lowercase();
                if existing_names.contains(&item_key) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: format!("Item already exists: {}", row.name),
                        original_data: original_line,
                    });
                    continue;
                }

                if batch_names.contains(&item_key) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: "Duplicate in CSV".to_string(),
                        original_data: original_line,
                    });
                    continue;
                }

                // Find destination
                let destination_id = match &row.destination {
                    Some(code) if !code.is_empty() => {
                        match dest_by_code.get(&code.to_lowercase()) {
                            Some(d) => Some(d.id),
                            None => {
                                errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Destination not found: {}", code),
                                    original_data: original_line,
                                });
                                continue;
                            }
                        }
                    }
                    _ => None,
                };

                // Create the item
                let create_item = CreateItem {
                    name: row.name.clone(),
                    default_destination_id: destination_id,
                    notes: row.notes.clone(),
                };

                match queries::create_item(&state.pool, create_item, user.user_id).await {
                    Ok(_) => {
                        success_count += 1;
                        batch_names.insert(item_key);
                    }
                    Err(e) => {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Database error: {}", e),
                            original_data: original_line,
                        });
                    }
                }
            }
            Err(e) => {
                errors.push(ImportError {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let failed_rows_csv = build_failed_csv(&header_line, &errors);

    Ok(Json(ImportResult {
        success_count,
        error_count: errors.len(),
        duplicate_count,
        errors,
        failed_rows_csv,
    }))
}

// ==================== PURCHASES ====================

async fn import_purchases(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let mut success_count = 0;
    let mut duplicate_count = 0;
    let mut errors: Vec<ImportError> = Vec::new();

    // Cache for lookups
    let items = queries::get_active_items(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let destinations = queries::get_all_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let invoices = queries::get_all_invoices(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let receipts = queries::get_all_receipts(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Get existing purchases for duplicate detection
    let existing_purchases = queries::get_all_purchases(&state.pool, PurchaseQuery::default())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Build set of existing purchase keys for duplicate detection
    let mut existing_keys: HashSet<String> = HashSet::new();
    for p in &existing_purchases {
        let key = format!(
            "{}|{}|{}|{}",
            p.item_id,
            p.created_at.date_naive(),
            p.quantity,
            p.purchase_cost.to_string().replace(['$', ',', ' '], "")
        );
        existing_keys.insert(key);
    }

    // Track keys we're importing in this batch
    let mut batch_keys: HashSet<String> = HashSet::new();

    // Create lookup maps
    let item_by_name: HashMap<String, &ActiveItem> =
        items.iter().map(|i| (i.name.to_lowercase(), i)).collect();
    let dest_by_code: HashMap<String, &Destination> = destinations
        .iter()
        .map(|d| (d.code.to_lowercase(), d))
        .collect();
    let invoice_by_number: HashMap<String, &Invoice> = invoices
        .iter()
        .map(|i| (i.invoice_number.to_lowercase(), i))
        .collect();
    let receipt_by_number: HashMap<String, &Receipt> = receipts
        .iter()
        .map(|r| (r.receipt_number.to_lowercase(), r))
        .collect();

    // Store raw lines for error reporting
    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();
    let header_line = csv_lines.first().cloned().unwrap_or_default();

    for (row_idx, result) in reader.deserialize::<CsvPurchaseRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                // Find the item
                let item = match item_by_name.get(&row.item.to_lowercase()) {
                    Some(i) => *i,
                    None => {
                        if let Ok(uuid) = Uuid::from_str(&row.item) {
                            match items.iter().find(|i| i.id == uuid) {
                                Some(i) => i,
                                None => {
                                    errors.push(ImportError {
                                        row: row_num,
                                        message: format!("Item not found: {}", row.item),
                                        original_data: original_line,
                                    });
                                    continue;
                                }
                            }
                        } else {
                            errors.push(ImportError {
                                row: row_num,
                                message: format!("Item not found: {}", row.item),
                                original_data: original_line,
                            });
                            continue;
                        }
                    }
                };

                // Find destination (optional)
                let destination_id = match &row.destination {
                    Some(dest_code) if !dest_code.is_empty() => {
                        match dest_by_code.get(&dest_code.to_lowercase()) {
                            Some(d) => Some(d.id),
                            None => {
                                errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Destination not found: {}", dest_code),
                                    original_data: original_line,
                                });
                                continue;
                            }
                        }
                    }
                    _ => item.default_destination_id,
                };

                // Find invoice (optional)
                let invoice_id = match &row.invoice {
                    Some(inv_num) if !inv_num.is_empty() => {
                        match invoice_by_number.get(&inv_num.to_lowercase()) {
                            Some(i) => Some(i.id),
                            None => {
                                errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Invoice not found: {}", inv_num),
                                    original_data: original_line,
                                });
                                continue;
                            }
                        }
                    }
                    _ => None,
                };

                // Find receipt (optional)
                let receipt_id = match &row.receipt {
                    Some(rcpt_num) if !rcpt_num.is_empty() => {
                        match receipt_by_number.get(&rcpt_num.to_lowercase()) {
                            Some(r) => Some(r.id),
                            None => {
                                errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Receipt not found: {}", rcpt_num),
                                    original_data: original_line,
                                });
                                continue;
                            }
                        }
                    }
                    _ => None,
                };

                // Parse invoice unit price (optional)
                let invoice_unit_price = match &row.invoice_unit_price {
                    Some(sp) if !sp.is_empty() => {
                        match Decimal::from_str(&sp.replace(['$', ','], "")) {
                            Ok(d) => Some(d),
                            Err(_) => {
                                errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Invalid invoice unit price: {}", sp),
                                    original_data: original_line,
                                });
                                continue;
                            }
                        }
                    }
                    _ => None,
                };

                // Parse status (optional, default pending)
                let status = match &row.status {
                    Some(s) if !s.is_empty() => match s.to_lowercase().as_str() {
                        "pending" => Some(DeliveryStatus::Pending),
                        "in_transit" | "in transit" => Some(DeliveryStatus::InTransit),
                        "delivered" => Some(DeliveryStatus::Delivered),
                        "damaged" => Some(DeliveryStatus::Damaged),
                        "returned" => Some(DeliveryStatus::Returned),
                        "lost" => Some(DeliveryStatus::Lost),
                        _ => {
                            errors.push(ImportError {
                                    row: row_num,
                                    message: format!("Invalid status: {} (use pending/in_transit/delivered/damaged/returned/lost)", s),
                                    original_data: original_line,
                                });
                            continue;
                        }
                    },
                    _ => Some(DeliveryStatus::Pending),
                };

                // Parse delivery date (optional)
                let delivery_date = match &row.delivery_date {
                    Some(date_str) if !date_str.is_empty() => {
                        match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                            Ok(d) => Some(d),
                            Err(_) => match NaiveDate::parse_from_str(date_str, "%m/%d/%Y") {
                                Ok(d) => Some(d),
                                Err(_) => {
                                    errors.push(ImportError {
                                        row: row_num,
                                        message: format!(
                                            "Invalid delivery date: {} (use YYYY-MM-DD)",
                                            date_str
                                        ),
                                        original_data: original_line,
                                    });
                                    continue;
                                }
                            },
                        }
                    }
                    _ => None,
                };

                // Parse unit cost
                let purchase_cost =
                    match Decimal::from_str(&row.purchase_cost.replace(['$', ','], "")) {
                        Ok(d) => d,
                        Err(_) => {
                            errors.push(ImportError {
                                row: row_num,
                                message: format!("Invalid purchase cost: {}", row.purchase_cost),
                                original_data: original_line,
                            });
                            continue;
                        }
                    };

                // Parse date or use today
                let purchase_date = match &row.date {
                    Some(date_str) if !date_str.is_empty() => {
                        match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                            Ok(d) => d,
                            Err(_) => match NaiveDate::parse_from_str(date_str, "%m/%d/%Y") {
                                Ok(d) => d,
                                Err(_) => {
                                    errors.push(ImportError {
                                        row: row_num,
                                        message: format!(
                                            "Invalid date: {} (use YYYY-MM-DD)",
                                            date_str
                                        ),
                                        original_data: original_line,
                                    });
                                    continue;
                                }
                            },
                        }
                    }
                    _ => chrono::Utc::now().date_naive(),
                };

                // Check for duplicates
                let dup_key = row.duplicate_key(item.id, purchase_date);

                if existing_keys.contains(&dup_key) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: format!(
                            "Duplicate: {} on {} qty:{} cost:{}",
                            item.name, purchase_date, row.quantity, row.purchase_cost
                        ),
                        original_data: original_line,
                    });
                    continue;
                }

                if batch_keys.contains(&dup_key) {
                    duplicate_count += 1;
                    errors.push(ImportError {
                        row: row_num,
                        message: "Duplicate in CSV: same row appears earlier".to_string(),
                        original_data: original_line,
                    });
                    continue;
                }

                // Create the purchase
                let create_purchase = CreatePurchase {
                    item_id: item.id,
                    receipt_id,
                    invoice_id,
                    quantity: row.quantity,
                    purchase_cost,
                    invoice_unit_price,
                    destination_id,
                    status,
                    delivery_date,
                    notes: row.notes.clone(),
                    refunds_purchase_id: None,
                    purchase_type: None,
                    bonus_for_purchase_id: None,
                };

                match queries::create_purchase(&state.pool, create_purchase, user.user_id).await {
                    Ok(_) => {
                        success_count += 1;
                        batch_keys.insert(dup_key);
                    }
                    Err(e) => {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Database error: {}", e),
                            original_data: original_line,
                        });
                    }
                }
            }
            Err(e) => {
                errors.push(ImportError {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let failed_rows_csv = build_failed_csv(&header_line, &errors);

    Ok(Json(ImportResult {
        success_count,
        error_count: errors.len(),
        duplicate_count,
        errors,
        failed_rows_csv,
    }))
}

async fn preview_receipts(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<PreviewResult<ReceiptPreview>>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let vendors = queries::get_all_vendors(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let receipts = queries::get_all_receipts(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let vendor_by_name: HashMap<String, &Vendor> =
        vendors.iter().map(|v| (v.name.to_lowercase(), v)).collect();
    let vendor_by_short_id: HashMap<String, &Vendor> = vendors
        .iter()
        .filter_map(|v| v.short_id.as_ref().map(|sid| (sid.to_lowercase(), v)))
        .collect();
    let vendor_by_alias: HashMap<String, Uuid> = queries::get_vendor_import_aliases(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .map(|a| (a.normalized_alias, a.vendor_id))
        .collect();

    let mut existing_keys: HashSet<String> = HashSet::new();
    for r in receipts {
        if !r.receipt_number.trim().is_empty() {
            existing_keys.insert(receipt_duplicate_key(r.vendor_id, &r.receipt_number));
        }
    }

    let mut batch_keys: HashSet<String> = HashSet::new();
    let mut valid_rows: Vec<PreviewRow<ReceiptPreview>> = Vec::new();
    let mut error_rows: Vec<PreviewErrorRow> = Vec::new();
    let mut duplicate_count = 0;

    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();

    for (row_idx, result) in reader.deserialize::<CsvReceiptRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                let vendor = match resolve_vendor(
                    &row.vendor,
                    &vendors,
                    &vendor_by_name,
                    &vendor_by_short_id,
                    &vendor_by_alias,
                ) {
                    Some(v) => v,
                    None => {
                        error_rows.push(PreviewErrorRow {
                            row: row_num,
                            message: format!("Vendor not found: {}", row.vendor),
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let receipt_date = match parse_date_yyyy_mm_dd_or_mm_dd_yyyy(&row.receipt_date) {
                    Ok(d) => d,
                    Err(message) => {
                        error_rows.push(PreviewErrorRow {
                            row: row_num,
                            message,
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let subtotal = match parse_decimal(&row.subtotal, "subtotal") {
                    Ok(v) => v,
                    Err(message) => {
                        error_rows.push(PreviewErrorRow {
                            row: row_num,
                            message,
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let tax_amount =
                    match parse_optional_decimal(row.tax_amount.as_deref(), "tax_amount") {
                        Ok(v) => v,
                        Err(message) => {
                            error_rows.push(PreviewErrorRow {
                                row: row_num,
                                message,
                                original_data: original_line,
                            });
                            continue;
                        }
                    };

                let payment_method =
                    normalize_optional_payment_method(row.payment_method.as_deref());

                let receipt_number = row
                    .receipt_number
                    .as_ref()
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty());

                if let Some(number) = receipt_number.as_ref() {
                    let key = receipt_duplicate_key(vendor.id, number);
                    if existing_keys.contains(&key) {
                        duplicate_count += 1;
                        error_rows.push(PreviewErrorRow {
                            row: row_num,
                            message: format!(
                                "Duplicate receipt for vendor {}: {}",
                                vendor.name, number
                            ),
                            original_data: original_line,
                        });
                        continue;
                    }

                    if batch_keys.contains(&key) {
                        duplicate_count += 1;
                        error_rows.push(PreviewErrorRow {
                            row: row_num,
                            message:
                                "Duplicate in CSV: same vendor + receipt number appears earlier"
                                    .to_string(),
                            original_data: original_line,
                        });
                        continue;
                    }

                    batch_keys.insert(key);
                }

                valid_rows.push(PreviewRow {
                    row: row_num,
                    data: ReceiptPreview {
                        vendor_name: vendor.name.clone(),
                        receipt_number,
                        receipt_date: receipt_date.to_string(),
                        subtotal: subtotal.to_string(),
                        tax_amount: tax_amount.map(|t| t.to_string()),
                        payment_method,
                        notes: row
                            .notes
                            .as_ref()
                            .map(|n| n.trim().to_string())
                            .filter(|n| !n.is_empty()),
                    },
                    is_duplicate: false,
                });
            }
            Err(e) => {
                error_rows.push(PreviewErrorRow {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let total_count = valid_rows.len() + error_rows.len();

    Ok(Json(PreviewResult {
        valid_count: valid_rows.len(),
        error_count: error_rows.len(),
        duplicate_count,
        total_count,
        valid_rows,
        error_rows,
    }))
}

async fn import_receipts(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(request): Json<ImportCsvRequest>,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(request.csv_data.as_bytes());

    let vendors = queries::get_all_vendors(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let receipts = queries::get_all_receipts(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let vendor_by_name: HashMap<String, &Vendor> =
        vendors.iter().map(|v| (v.name.to_lowercase(), v)).collect();
    let vendor_by_short_id: HashMap<String, &Vendor> = vendors
        .iter()
        .filter_map(|v| v.short_id.as_ref().map(|sid| (sid.to_lowercase(), v)))
        .collect();
    let vendor_by_alias: HashMap<String, Uuid> = queries::get_vendor_import_aliases(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .map(|a| (a.normalized_alias, a.vendor_id))
        .collect();

    let mut existing_keys: HashSet<String> = HashSet::new();
    for r in receipts {
        if !r.receipt_number.trim().is_empty() {
            existing_keys.insert(receipt_duplicate_key(r.vendor_id, &r.receipt_number));
        }
    }

    let mut batch_keys: HashSet<String> = HashSet::new();
    let mut success_count = 0;
    let mut duplicate_count = 0;
    let mut errors: Vec<ImportError> = Vec::new();

    let csv_lines: Vec<String> = request.csv_data.lines().map(|s| s.to_string()).collect();
    let header_line = csv_lines.first().cloned().unwrap_or_default();

    for (row_idx, result) in reader.deserialize::<CsvReceiptRow>().enumerate() {
        let row_num = row_idx + 2;
        let original_line = csv_lines.get(row_num - 1).cloned().unwrap_or_default();

        match result {
            Ok(row) => {
                let vendor = match resolve_vendor(
                    &row.vendor,
                    &vendors,
                    &vendor_by_name,
                    &vendor_by_short_id,
                    &vendor_by_alias,
                ) {
                    Some(v) => v,
                    None => {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Vendor not found: {}", row.vendor),
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let receipt_date = match parse_date_yyyy_mm_dd_or_mm_dd_yyyy(&row.receipt_date) {
                    Ok(d) => d,
                    Err(message) => {
                        errors.push(ImportError {
                            row: row_num,
                            message,
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let subtotal = match parse_decimal(&row.subtotal, "subtotal") {
                    Ok(v) => v,
                    Err(message) => {
                        errors.push(ImportError {
                            row: row_num,
                            message,
                            original_data: original_line,
                        });
                        continue;
                    }
                };

                let tax_amount =
                    match parse_optional_decimal(row.tax_amount.as_deref(), "tax_amount") {
                        Ok(v) => v,
                        Err(message) => {
                            errors.push(ImportError {
                                row: row_num,
                                message,
                                original_data: original_line,
                            });
                            continue;
                        }
                    };

                let payment_method =
                    normalize_optional_payment_method(row.payment_method.as_deref());

                let receipt_number = row
                    .receipt_number
                    .as_ref()
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty());

                if let Some(number) = receipt_number.as_ref() {
                    let key = receipt_duplicate_key(vendor.id, number);
                    if existing_keys.contains(&key) {
                        duplicate_count += 1;
                        errors.push(ImportError {
                            row: row_num,
                            message: format!(
                                "Duplicate receipt for vendor {}: {}",
                                vendor.name, number
                            ),
                            original_data: original_line,
                        });
                        continue;
                    }

                    if batch_keys.contains(&key) {
                        duplicate_count += 1;
                        errors.push(ImportError {
                            row: row_num,
                            message:
                                "Duplicate in CSV: same vendor + receipt number appears earlier"
                                    .to_string(),
                            original_data: original_line,
                        });
                        continue;
                    }

                    batch_keys.insert(key.clone());
                    existing_keys.insert(key);
                }

                let source_vendor_alias = row.vendor.trim().to_string();

                if !source_vendor_alias.is_empty() {
                    if let Err(e) = queries::upsert_vendor_import_alias(
                        &state.pool,
                        &source_vendor_alias,
                        vendor.id,
                    )
                    .await
                    {
                        errors.push(ImportError {
                            row: row_num,
                            message: format!("Database error: {}", e),
                            original_data: original_line,
                        });
                        continue;
                    }
                }

                let create_receipt = CreateReceipt {
                    vendor_id: vendor.id,
                    source_vendor_alias: if source_vendor_alias.is_empty() {
                        None
                    } else {
                        Some(source_vendor_alias)
                    },
                    receipt_number,
                    receipt_date,
                    subtotal,
                    tax_amount,
                    tax_rate: None,
                    payment_method,
                    ingestion_metadata: Some(json!({
                        "source": "csv",
                        "auto_parsed": false,
                        "ingestion_version": "csv-v1"
                    })),
                    notes: row
                        .notes
                        .as_ref()
                        .map(|n| n.trim().to_string())
                        .filter(|n| !n.is_empty()),
                };

                match queries::create_receipt(&state.pool, create_receipt, user.user_id).await {
                    Ok(_) => success_count += 1,
                    Err(e) => errors.push(ImportError {
                        row: row_num,
                        message: format!("Database error: {}", e),
                        original_data: original_line,
                    }),
                }
            }
            Err(e) => {
                errors.push(ImportError {
                    row: row_num,
                    message: format!("CSV parse error: {}", e),
                    original_data: original_line,
                });
            }
        }
    }

    let failed_rows_csv = build_failed_csv(&header_line, &errors);

    Ok(Json(ImportResult {
        success_count,
        error_count: errors.len(),
        duplicate_count,
        errors,
        failed_rows_csv,
    }))
}

// Helper to build failed rows CSV
fn build_failed_csv(header_line: &str, errors: &[ImportError]) -> String {
    if errors.is_empty() {
        String::new()
    } else {
        let mut csv_output = header_line.to_string();
        csv_output.push('\n');
        for error in errors {
            if !error.original_data.is_empty() {
                csv_output.push_str(&error.original_data);
                csv_output.push('\n');
            }
        }
        csv_output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== TEST HELPERS ====================

    /// Helper to parse CSV and collect results for a given row type
    fn parse_csv<T: for<'de> Deserialize<'de>>(csv_data: &str) -> Vec<Result<T, csv::Error>> {
        csv::ReaderBuilder::new()
            .flexible(true)
            .trim(csv::Trim::All)
            .from_reader(csv_data.as_bytes())
            .deserialize()
            .collect()
    }

    /// Helper to assert successful parse of first row
    fn assert_parses<T: for<'de> Deserialize<'de> + std::fmt::Debug>(csv_data: &str) -> T {
        let results: Vec<Result<T, _>> = parse_csv(csv_data);
        assert!(!results.is_empty(), "CSV should have at least one row");
        results
            .into_iter()
            .next()
            .unwrap()
            .expect("First row should parse successfully")
    }

    /// Helper to assert parse failure
    #[allow(dead_code)]
    fn assert_parse_fails<T: for<'de> Deserialize<'de> + std::fmt::Debug>(csv_data: &str) {
        let results: Vec<Result<T, _>> = parse_csv(csv_data);
        if !results.is_empty() {
            assert!(results[0].is_err(), "First row should fail to parse");
        }
    }

    // ==================== BUILD_FAILED_CSV TESTS ====================

    mod build_failed_csv_tests {
        use super::*;

        #[test]
        fn returns_empty_string_when_no_errors() {
            let result = build_failed_csv("header1,header2", &[]);
            assert_eq!(result, "");
        }

        #[test]
        fn includes_header_and_failed_rows() {
            let errors = vec![
                ImportError {
                    row: 2,
                    message: "Error 1".into(),
                    original_data: "data1,data2".into(),
                },
                ImportError {
                    row: 3,
                    message: "Error 2".into(),
                    original_data: "data3,data4".into(),
                },
            ];
            let result = build_failed_csv("col1,col2", &errors);
            assert_eq!(result, "col1,col2\ndata1,data2\ndata3,data4\n");
        }

        #[test]
        fn skips_errors_without_original_data() {
            let errors = vec![
                ImportError {
                    row: 2,
                    message: "Error 1".into(),
                    original_data: "data1".into(),
                },
                ImportError {
                    row: 3,
                    message: "Error 2".into(),
                    original_data: "".into(),
                },
            ];
            let result = build_failed_csv("header", &errors);
            assert_eq!(result, "header\ndata1\n");
        }
    }

    // ==================== CSV VENDOR ROW TESTS ====================

    mod csv_vendor_row_tests {
        use super::*;

        #[test]
        fn parses_standard_format() {
            let row: CsvVendorRow = assert_parses("name\nBest Buy");
            assert_eq!(row.name, "Best Buy");
        }

        #[test]
        fn parses_with_name_alias() {
            let row: CsvVendorRow = assert_parses("Name\nAmazon");
            assert_eq!(row.name, "Amazon");
        }

        #[test]
        fn parses_with_vendor_alias() {
            let row: CsvVendorRow = assert_parses("Vendor\nWalmart");
            assert_eq!(row.name, "Walmart");
        }

        #[test]
        fn parses_with_vendor_name_alias() {
            let row: CsvVendorRow = assert_parses("vendor_name\nStaples");
            assert_eq!(row.name, "Staples");
        }

        #[test]
        fn trims_whitespace() {
            let row: CsvVendorRow = assert_parses("name\n  Best Buy  ");
            assert_eq!(row.name, "Best Buy");
        }
    }

    // ==================== CSV DESTINATION ROW TESTS ====================

    mod csv_destination_row_tests {
        use super::*;

        #[test]
        fn parses_standard_format() {
            let row: CsvDestinationRow = assert_parses("code,name\nBSC,BuyBackStore Canada");
            assert_eq!(row.code, "BSC");
            assert_eq!(row.name, "BuyBackStore Canada");
        }

        #[test]
        fn parses_with_code_alias() {
            let row: CsvDestinationRow = assert_parses("Code,Name\nCBG,Cell Buddy Group");
            assert_eq!(row.code, "CBG");
            assert_eq!(row.name, "Cell Buddy Group");
        }

        #[test]
        fn parses_with_destination_alias() {
            let row: CsvDestinationRow = assert_parses("Destination,Name\nBSC,Test");
            assert_eq!(row.code, "BSC");
        }
    }

    // ==================== CSV ITEM ROW TESTS ====================

    mod csv_item_row_tests {
        use super::*;

        #[test]
        fn parses_standard_format() {
            let row: CsvItemRow = assert_parses("name\nEcho Dot");
            assert_eq!(row.name, "Echo Dot");
        }

        #[test]
        fn parses_with_item_alias() {
            let row: CsvItemRow = assert_parses("Item\nPS5");
            assert_eq!(row.name, "PS5");
        }

        #[test]
        fn parses_optional_destination() {
            let row: CsvItemRow = assert_parses("name,destination\nEcho Dot,BSC");
            assert_eq!(row.destination, Some("BSC".to_string()));
        }

        #[test]
        fn parses_default_destination_alias() {
            let row: CsvItemRow = assert_parses("Item,Default Destination\nEcho Dot,CBG");
            assert_eq!(row.destination, Some("CBG".to_string()));
        }

        #[test]
        fn destination_defaults_to_none() {
            let row: CsvItemRow = assert_parses("name\nEcho Dot");
            assert_eq!(row.destination, None);
        }

        #[test]
        fn parses_optional_notes() {
            let row: CsvItemRow = assert_parses("name,notes\nEcho Dot,Test note");
            assert_eq!(row.notes, Some("Test note".to_string()));
        }

        #[test]
        fn handles_extra_columns() {
            // CSV with extra columns that should be ignored
            let row: CsvItemRow =
                assert_parses("Item,Extra Col,Another Extra\nEcho,ignore,also ignore");
            assert_eq!(row.name, "Echo");
        }
    }

    // ==================== CSV PURCHASE ROW TESTS ====================

    mod csv_purchase_row_tests {
        use super::*;

        #[test]
        fn parses_standard_format() {
            let row: CsvPurchaseRow = assert_parses("item,quantity,unit_cost\nEcho Dot,5,39.99");
            assert_eq!(row.item, "Echo Dot");
            assert_eq!(row.quantity, 5);
            assert_eq!(row.purchase_cost, "39.99");
        }

        #[test]
        fn parses_with_aliases() {
            let row: CsvPurchaseRow = assert_parses("Item,Qty,Cost\nPS5,2,519.99");
            assert_eq!(row.item, "PS5");
            assert_eq!(row.quantity, 2);
            assert_eq!(row.purchase_cost, "519.99");
        }

        #[test]
        fn parses_optional_destination() {
            let row: CsvPurchaseRow =
                assert_parses("item,quantity,unit_cost,destination\nEcho,3,39.99,BSC");
            assert_eq!(row.destination, Some("BSC".to_string()));
        }

        #[test]
        fn parses_optional_date() {
            let row: CsvPurchaseRow =
                assert_parses("item,quantity,unit_cost,date\nEcho,3,39.99,2024-11-15");
            assert_eq!(row.date, Some("2024-11-15".to_string()));
        }

        #[test]
        fn parses_optional_invoice() {
            let row: CsvPurchaseRow =
                assert_parses("item,quantity,unit_cost,invoice\nEcho,3,39.99,INV-001");
            assert_eq!(row.invoice, Some("INV-001".to_string()));
        }

        #[test]
        fn duplicate_key_format() {
            let row = CsvPurchaseRow {
                item: "Echo Dot".to_string(),
                destination: Some("BSC".to_string()),
                quantity: 5,
                purchase_cost: "$39.99".to_string(),
                date: None,
                invoice: None,
                receipt: None,
                invoice_unit_price: None,
                status: None,
                delivery_date: None,
                notes: None,
            };
            let item_id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
            let date = NaiveDate::from_ymd_opt(2024, 11, 15).unwrap();

            let key = row.duplicate_key(item_id, date);
            assert!(key.contains("550e8400-e29b-41d4-a716-446655440000"));
            assert!(key.contains("2024-11-15"));
            assert!(key.contains("5"));
            assert!(key.contains("39.99"));
            // Should strip $, comma, and spaces from purchase_cost
            assert!(!key.contains("$"));
        }
    }

    // ==================== EDGE CASE TESTS ====================

    mod edge_case_tests {
        use super::*;

        #[test]
        fn handles_empty_csv() {
            let results: Vec<Result<CsvVendorRow, _>> = parse_csv("name\n");
            assert!(results.is_empty());
        }

        #[test]
        fn handles_csv_with_only_header() {
            let results: Vec<Result<CsvItemRow, _>> = parse_csv("name");
            assert!(results.is_empty());
        }

        #[test]
        fn handles_multiline_csv() {
            let csv = "name\nVendor1\nVendor2\nVendor3";
            let results: Vec<Result<CsvVendorRow, _>> = parse_csv(csv);
            assert_eq!(results.len(), 3);
            assert!(results.iter().all(|r| r.is_ok()));
        }

        #[test]
        fn item_row_parses_with_notes_and_destination() {
            let row: CsvItemRow = assert_parses("name,destination,notes\nEcho,BSC,Test note");
            assert_eq!(row.name, "Echo");
            assert_eq!(row.destination, Some("BSC".to_string()));
            assert_eq!(row.notes, Some("Test note".to_string()));
        }
    }

    // ==================== IMPORT RESULT TESTS ====================

    mod import_result_tests {
        use super::*;

        #[test]
        fn import_result_serializes_correctly() {
            let result = ImportResult {
                success_count: 10,
                error_count: 2,
                duplicate_count: 1,
                errors: vec![ImportError {
                    row: 3,
                    message: "Test error".into(),
                    original_data: "row3".into(),
                }],
                failed_rows_csv: "header\nrow3\n".into(),
            };

            let json = serde_json::to_string(&result).unwrap();
            assert!(json.contains("\"success_count\":10"));
            assert!(json.contains("\"error_count\":2"));
            assert!(json.contains("\"duplicate_count\":1"));
            assert!(json.contains("Test error"));
        }

        #[test]
        fn import_error_serializes_correctly() {
            let error = ImportError {
                row: 5,
                message: "Vendor not found: Unknown".into(),
                original_data: "Unknown,item,10.00".into(),
            };

            let json = serde_json::to_string(&error).unwrap();
            assert!(json.contains("\"row\":5"));
            assert!(json.contains("Vendor not found"));
        }
    }
}

// ==================== PDF INVOICE PARSING ====================

#[derive(Debug, Serialize)]
pub struct ParsedInvoiceLineItem {
    pub description: String,
    pub qty: i32,
    pub invoice_unit_price: String,
    pub subtotal: String,
}

#[derive(Debug, Serialize)]
pub struct ParsedInvoice {
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub bill_to: Option<String>,
    pub line_items: Vec<ParsedInvoiceLineItem>,
    pub subtotal: Option<String>,
    pub tax_rate: Option<String>,
    pub tax_amount: Option<String>,
    pub total: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedReceiptLineItem {
    pub description: String,
    pub quantity: i32,
    pub unit_cost: Option<String>,
    pub line_total: Option<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedReceipt {
    pub vendor_name: Option<String>,
    #[serde(default)]
    pub suggested_vendor_id: Option<Uuid>,
    #[serde(default)]
    pub fixture_used: Option<String>,
    pub receipt_number: Option<String>,
    pub receipt_date: Option<String>,
    pub subtotal: Option<String>,
    pub tax: Option<String>,
    pub total: Option<String>,
    pub payment_method: Option<String>,
    #[serde(default)]
    pub confidence_score: Option<f32>,
    #[serde(default)]
    pub parse_engine: Option<String>,
    #[serde(default)]
    pub parse_version: Option<String>,
    pub line_items: Vec<ParsedReceiptLineItem>,
    pub warnings: Vec<String>,
    pub raw_text_lines: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct InvoicePdfCommitErrorResponse {
    pub error_code: String,
    pub message: String,
    pub invoice_level_errors: Vec<InvoiceImportValidationError>,
    pub line_failures: Vec<InvoiceImportLineFailure>,
}

fn parse_decimal_input(raw: &str) -> Result<Decimal, ()> {
    Decimal::from_str(&raw.replace(['$', ',', ' '], "")).map_err(|_| ())
}

fn map_receipt_multipart_error<E: std::fmt::Display>(err: E) -> (StatusCode, String) {
    let message = err.to_string();
    let message_lower = message.to_ascii_lowercase();

    if message_lower.contains("too large")
        || message_lower.contains("size limit")
        || message_lower.contains("length limit")
    {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Uploaded file is too large. Maximum allowed size is {} MB.",
                IMPORT_MULTIPART_MAX_BYTES / (1024 * 1024)
            ),
        );
    }

    (
        StatusCode::BAD_REQUEST,
        "Invalid upload payload. Please upload one PDF, JPG, JPEG, PNG, or WEBP file."
            .to_string(),
    )
}

fn map_receipt_ocr_failure(status: StatusCode, body: &str) -> (StatusCode, String) {
    let body_lower = body.to_ascii_lowercase();

    if status == StatusCode::BAD_REQUEST {
        return (
            StatusCode::BAD_REQUEST,
            "OCR could not read the uploaded file. Please upload a valid, non-empty PDF or image."
                .to_string(),
        );
    }

    if status == StatusCode::UNPROCESSABLE_ENTITY {
        if body_lower.contains("paddleocr-vl is unavailable")
            || body_lower.contains("paddleocrvl is not available")
            || body_lower.contains("forced ocr mode 'vl' requested")
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                "PaddleOCR-VL is unavailable in this environment. Use OCR mode 'PaddleOCR' "
                    .to_string()
                    + "or keep 'Auto' to continue with PaddleOCR when VL is unavailable.",
            );
        }

        if body_lower.contains("unable to decode image") {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                "OCR could not decode this file. Try a clearer photo, a different image, or a PDF export."
                    .to_string(),
            );
        }

        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            "OCR could not extract receipt data from this file. Please try another image or PDF."
                .to_string(),
        );
    }

    if status == StatusCode::PAYLOAD_TOO_LARGE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Uploaded file is too large. Maximum allowed size is {} MB.",
                IMPORT_MULTIPART_MAX_BYTES / (1024 * 1024)
            ),
        );
    }

    (
        StatusCode::BAD_GATEWAY,
        "Receipt OCR service returned an unexpected error. Please retry.".to_string(),
    )
}

async fn parse_invoice_pdf(
    _user: AuthenticatedUser,
    mut multipart: Multipart,
) -> Result<Json<ParsedInvoice>, (StatusCode, String)> {
    // Read the PDF file from multipart
    let mut pdf_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("Read error: {e}")))?;
            pdf_bytes = Some(bytes.to_vec());
            break;
        }
    }

    let pdf_bytes = pdf_bytes.ok_or((
        StatusCode::BAD_REQUEST,
        "No file field in upload".to_string(),
    ))?;

    // Write to temp file
    let tmp_dir = tempfile::tempdir().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Temp dir error: {e}"),
        )
    })?;
    let tmp_path = tmp_dir.path().join("invoice.pdf");
    let mut tmp_file = tokio::fs::File::create(&tmp_path).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("File create error: {e}"),
        )
    })?;
    tmp_file.write_all(&pdf_bytes).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("File write error: {e}"),
        )
    })?;
    tmp_file.flush().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("File flush error: {e}"),
        )
    })?;

    // Run Python parser - resolve script path relative to the project root
    let script_path = std::env::current_dir()
        .unwrap_or_default()
        .join("../scripts/parse_invoice_pdf.py");
    let output = tokio::process::Command::new("python3")
        .arg(&script_path)
        .arg(&tmp_path)
        .output()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to run PDF parser: {e}"),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("PDF parser failed: {stderr}"),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Parse JSON error: {e}"),
        )
    })?;

    if let Some(err) = parsed.get("error") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("PDF parse error: {}", err.as_str().unwrap_or("unknown")),
        ));
    }

    // Map to our response type
    let line_items: Vec<ParsedInvoiceLineItem> = parsed
        .get("line_items")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(ParsedInvoiceLineItem {
                        description: item.get("description")?.as_str()?.to_string(),
                        qty: item.get("qty")?.as_i64()? as i32,
                        invoice_unit_price: item.get("unit_price")?.as_str()?.to_string(),
                        subtotal: item.get("subtotal")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let result = ParsedInvoice {
        invoice_number: parsed
            .get("invoice_number")
            .and_then(|v| v.as_str())
            .map(String::from),
        invoice_date: parsed
            .get("invoice_date")
            .and_then(|v| v.as_str())
            .map(String::from),
        bill_to: parsed
            .get("bill_to")
            .and_then(|v| v.as_str())
            .map(String::from),
        line_items,
        subtotal: parsed
            .get("subtotal")
            .and_then(|v| v.as_str())
            .map(String::from),
        tax_rate: parsed
            .get("tax_rate")
            .and_then(|v| v.as_str())
            .map(String::from),
        tax_amount: parsed
            .get("tax_amount")
            .and_then(|v| v.as_str())
            .map(String::from),
        total: parsed
            .get("total")
            .and_then(|v| v.as_str())
            .map(String::from),
        notes: parsed
            .get("notes")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from),
    };

    Ok(Json(result))
}

async fn parse_receipt_image(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Query(query): Query<ParseReceiptImageQuery>,
    mut multipart: Multipart,
) -> Result<Json<ParsedReceipt>, (StatusCode, String)> {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_name = "receipt-upload".to_string();
    let mut content_type = "application/octet-stream".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(map_receipt_multipart_error)?
    {
        if field.name() == Some("file") {
            file_name = field.file_name().unwrap_or("receipt-upload").to_string();
            if let Some(ct) = field.content_type() {
                content_type = ct.to_string();
            }
            let bytes = field
                .bytes()
                .await
                .map_err(map_receipt_multipart_error)?;
            file_bytes = Some(bytes.to_vec());
            break;
        }
    }

    let file_bytes = file_bytes.ok_or((
        StatusCode::BAD_REQUEST,
        "No file was uploaded. Please select a PDF or image file.".to_string(),
    ))?;

    let ocr_service_url =
        std::env::var("OCR_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8001".to_string());
    let mut endpoint = format!("{}/parse-receipt", ocr_service_url.trim_end_matches('/'));
    if let Some(mode) = query.ocr_mode {
        endpoint = format!("{}?mode={}", endpoint, mode.as_query_value());
    }

    let client = reqwest::Client::new();
    let part = match reqwest::multipart::Part::bytes(file_bytes.clone())
        .file_name(file_name.clone())
        .mime_str(&content_type)
    {
        Ok(p) => p,
        Err(_) => reqwest::multipart::Part::bytes(file_bytes).file_name(file_name),
    };
    let form = reqwest::multipart::Form::new().part("file", part);

    let response = client
        .post(&endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Receipt OCR service is unavailable right now. Please try again in a moment."
                    .to_string(),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_default();
        return Err(map_receipt_ocr_failure(status, &body));
    }

    let mut parsed = response.json::<ParsedReceipt>().await.map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Receipt OCR service returned an invalid response. Please retry.".to_string(),
        )
    })?;

    if parsed.suggested_vendor_id.is_none() {
        if let Some(vendor_name) = parsed
            .vendor_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let from_alias = queries::resolve_vendor_id_by_import_alias(&state.pool, vendor_name)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let suggested_vendor_id = if from_alias.is_some() {
                from_alias
            } else {
                let vendors = queries::get_all_vendors(&state.pool)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let vendor_name_lower = vendor_name.to_lowercase();

                vendors
                    .iter()
                    .find(|v| v.name.to_lowercase() == vendor_name_lower)
                    .map(|v| v.id)
                    .or_else(|| {
                        vendors
                            .iter()
                            .find(|v| {
                                v.short_id
                                    .as_deref()
                                    .map(|sid| sid.eq_ignore_ascii_case(vendor_name))
                                    .unwrap_or(false)
                            })
                            .map(|v| v.id)
                    })
            };

            parsed.suggested_vendor_id = suggested_vendor_id;
        }
    }

    Ok(Json(parsed))
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum ReceiptOcrMode {
    Auto,
    Classic,
    Vl,
}

impl ReceiptOcrMode {
    fn as_query_value(self) -> &'static str {
        match self {
            ReceiptOcrMode::Auto => "auto",
            ReceiptOcrMode::Classic => "classic",
            ReceiptOcrMode::Vl => "vl",
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct ParseReceiptImageQuery {
    #[serde(default)]
    ocr_mode: Option<ReceiptOcrMode>,
}

async fn commit_invoice_pdf(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    mut multipart: Multipart,
) -> Result<
    (StatusCode, Json<CreateInvoiceFromPdfResponse>),
    (StatusCode, Json<InvoicePdfCommitErrorResponse>),
> {
    let mut pdf_bytes: Option<Vec<u8>> = None;
    let mut pdf_filename: Option<String> = None;
    let mut payload: Option<CreateInvoiceFromPdfRequest> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "INVALID_MULTIPART".to_string(),
                message: format!("Multipart error: {e}"),
                invoice_level_errors: vec![],
                line_failures: vec![],
            }),
        )
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                pdf_filename = Some(field.file_name().unwrap_or("invoice.pdf").to_string());
                let bytes = field.bytes().await.map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(InvoicePdfCommitErrorResponse {
                            error_code: "FILE_READ_ERROR".to_string(),
                            message: format!("Failed to read uploaded file: {e}"),
                            invoice_level_errors: vec![],
                            line_failures: vec![],
                        }),
                    )
                })?;
                pdf_bytes = Some(bytes.to_vec());
            }
            "payload" => {
                let text = field.text().await.map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(InvoicePdfCommitErrorResponse {
                            error_code: "INVALID_PAYLOAD".to_string(),
                            message: format!("Failed to read payload: {e}"),
                            invoice_level_errors: vec![],
                            line_failures: vec![],
                        }),
                    )
                })?;
                let parsed_payload: CreateInvoiceFromPdfRequest = serde_json::from_str(&text)
                    .map_err(|e| {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(InvoicePdfCommitErrorResponse {
                                error_code: "INVALID_PAYLOAD_JSON".to_string(),
                                message: format!("Invalid payload JSON: {e}"),
                                invoice_level_errors: vec![],
                                line_failures: vec![],
                            }),
                        )
                    })?;
                payload = Some(parsed_payload);
            }
            _ => {}
        }
    }

    let payload = payload.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "MISSING_PAYLOAD".to_string(),
                message: "Missing payload field in multipart request".to_string(),
                invoice_level_errors: vec![],
                line_failures: vec![],
            }),
        )
    })?;

    let pdf_data = pdf_bytes.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "MISSING_FILE".to_string(),
                message: "Missing file field in multipart request".to_string(),
                invoice_level_errors: vec![],
                line_failures: vec![],
            }),
        )
    })?;

    let mut invoice_level_errors: Vec<InvoiceImportValidationError> = Vec::new();
    let mut line_failures: Vec<InvoiceImportLineFailure> = Vec::new();

    if payload.invoice_number.trim().is_empty() {
        invoice_level_errors.push(InvoiceImportValidationError {
            field: "invoice_number".to_string(),
            code: "REQUIRED".to_string(),
            message: "Invoice number is required".to_string(),
        });
    }

    let invoice_date = match NaiveDate::parse_from_str(&payload.invoice_date, "%Y-%m-%d") {
        Ok(d) => Some(d),
        Err(_) => {
            invoice_level_errors.push(InvoiceImportValidationError {
                field: "invoice_date".to_string(),
                code: "INVALID_DATE".to_string(),
                message: "Invoice date must use YYYY-MM-DD format".to_string(),
            });
            None
        }
    };

    let delivery_date = payload.delivery_date.as_deref().and_then(|s| {
        if s.is_empty() { None } else { NaiveDate::parse_from_str(s, "%Y-%m-%d").ok() }
    });

    let subtotal = match parse_decimal_input(&payload.subtotal) {
        Ok(v) => Some(v),
        Err(_) => {
            invoice_level_errors.push(InvoiceImportValidationError {
                field: "subtotal".to_string(),
                code: "INVALID_DECIMAL".to_string(),
                message: format!("Invalid subtotal: {}", payload.subtotal),
            });
            None
        }
    };

    let tax_rate = match payload.tax_rate.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match parse_decimal_input(raw) {
            Ok(v) => Some(v),
            Err(_) => {
                invoice_level_errors.push(InvoiceImportValidationError {
                    field: "tax_rate".to_string(),
                    code: "INVALID_DECIMAL".to_string(),
                    message: format!("Invalid tax rate: {raw}"),
                });
                None
            }
        },
        _ => None,
    };

    let existing_items = queries::get_active_items(&state.pool).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "ITEM_LOOKUP_FAILED".to_string(),
                message: format!("Failed to validate items: {e}"),
                invoice_level_errors: vec![],
                line_failures: vec![],
            }),
        )
    })?;
    let item_ids: HashSet<Uuid> = existing_items.into_iter().map(|i| i.id).collect();

    let mut resolved_lines: Vec<queries::AtomicInvoicePdfLine> = Vec::new();

    for li in &payload.line_items {
        // Parse invoice_unit_price early — needed for both paths
        let invoice_unit_price = match parse_decimal_input(&li.invoice_unit_price) {
            Ok(v) => v,
            Err(_) => {
                line_failures.push(InvoiceImportLineFailure {
                    line_index: li.line_index,
                    code: "INVALID_UNIT_PRICE".to_string(),
                    message: format!("Invalid invoice unit price: {}", li.invoice_unit_price),
                    description: Some(li.description.clone()),
                });
                continue;
            }
        };

        if parse_decimal_input(&li.subtotal).is_err() {
            line_failures.push(InvoiceImportLineFailure {
                line_index: li.line_index,
                code: "INVALID_SUBTOTAL".to_string(),
                message: format!("Invalid line subtotal: {}", li.subtotal),
                description: Some(li.description.clone()),
            });
            continue;
        }

        // ── Split mode: one parsed line → multiple purchases ──
        if let Some(ref splits) = li.splits {
            if splits.is_empty() {
                line_failures.push(InvoiceImportLineFailure {
                    line_index: li.line_index,
                    code: "EMPTY_SPLITS".to_string(),
                    message: "Splits array is empty".to_string(),
                    description: Some(li.description.clone()),
                });
                continue;
            }

            let mut split_ok = true;
            let mut split_qty_sum: i32 = 0;

            for (si, split) in splits.iter().enumerate() {
                if split.qty == 0 {
                    line_failures.push(InvoiceImportLineFailure {
                        line_index: li.line_index,
                        code: "INVALID_SPLIT_QTY".to_string(),
                        message: format!("Split #{} quantity must be non-zero", si + 1),
                        description: Some(li.description.clone()),
                    });
                    split_ok = false;
                }
                if !item_ids.contains(&split.item_id) {
                    line_failures.push(InvoiceImportLineFailure {
                        line_index: li.line_index,
                        code: "SPLIT_ITEM_NOT_FOUND".to_string(),
                        message: format!("Split #{} item does not exist", si + 1),
                        description: Some(li.description.clone()),
                    });
                    split_ok = false;
                }
                split_qty_sum += split.qty;
            }

            if split_qty_sum != li.qty {
                line_failures.push(InvoiceImportLineFailure {
                    line_index: li.line_index,
                    code: "SPLIT_QTY_MISMATCH".to_string(),
                    message: format!(
                        "Split quantities sum to {} but line quantity is {}",
                        split_qty_sum, li.qty
                    ),
                    description: Some(li.description.clone()),
                });
                split_ok = false;
            }

            if split_ok {
                for split in splits {
                    resolved_lines.push(queries::AtomicInvoicePdfLine {
                        line_index: li.line_index,
                        item_id: split.item_id,
                        qty: split.qty,
                        invoice_unit_price,
                        description: li.description.clone(),
                        purchase_type: split.purchase_type.clone().or_else(|| li.purchase_type.clone()),
                    });
                }
            }
            continue;
        }

        // ── Normal mode: one line → one purchase ──
        if li.item_id.is_none() {
            line_failures.push(InvoiceImportLineFailure {
                line_index: li.line_index,
                code: "ITEM_UNRESOLVED".to_string(),
                message: "No item mapping provided for line".to_string(),
                description: Some(li.description.clone()),
            });
            continue;
        }

        let item_id = li.item_id.expect("checked is_some");
        if !item_ids.contains(&item_id) {
            line_failures.push(InvoiceImportLineFailure {
                line_index: li.line_index,
                code: "ITEM_NOT_FOUND".to_string(),
                message: "Mapped item does not exist".to_string(),
                description: Some(li.description.clone()),
            });
            continue;
        }

        if li.qty == 0 {
            line_failures.push(InvoiceImportLineFailure {
                line_index: li.line_index,
                code: "INVALID_QTY".to_string(),
                message: format!("Quantity must be non-zero, got {}", li.qty),
                description: Some(li.description.clone()),
            });
            continue;
        }

        resolved_lines.push(queries::AtomicInvoicePdfLine {
            line_index: li.line_index,
            item_id,
            qty: li.qty,
            invoice_unit_price,
            description: li.description.clone(),
            purchase_type: li.purchase_type.clone(),
        });
    }

    if !invoice_level_errors.is_empty() || !line_failures.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "INVOICE_IMPORT_VALIDATION_FAILED".to_string(),
                message: "Import failed. No data was written.".to_string(),
                invoice_level_errors,
                line_failures,
            }),
        ));
    }

    let invoice_date = invoice_date.expect("validated above");
    let subtotal = subtotal.expect("validated above");

    let result = queries::create_invoice_from_pdf_atomic(
        &state.pool,
        queries::AtomicInvoicePdfCreateInput {
            destination_id: payload.destination_id,
            invoice_number: payload.invoice_number,
            invoice_date,
            delivery_date,
            subtotal,
            tax_rate,
            notes: payload.notes,
            pdf_data,
            pdf_filename: pdf_filename.unwrap_or_else(|| "invoice.pdf".to_string()),
            lines: resolved_lines,
        },
        user.user_id,
    )
    .await
    .map_err(|e| match e {
        queries::AtomicInvoicePdfCreateError::PurchaseInsert {
            line_index,
            description,
            source,
        } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "INVOICE_IMPORT_VALIDATION_FAILED".to_string(),
                message: "Import failed. No data was written.".to_string(),
                invoice_level_errors: vec![],
                line_failures: vec![InvoiceImportLineFailure {
                    line_index,
                    code: "PURCHASE_CREATE_FAILED".to_string(),
                    message: source.to_string(),
                    description: Some(description),
                }],
            }),
        ),
        queries::AtomicInvoicePdfCreateError::Sql(source) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(InvoicePdfCommitErrorResponse {
                error_code: "INVOICE_IMPORT_COMMIT_FAILED".to_string(),
                message: format!("Import failed: {source}"),
                invoice_level_errors: vec![],
                line_failures: vec![],
            }),
        ),
    })?;

    Ok((
        StatusCode::CREATED,
        Json(CreateInvoiceFromPdfResponse {
            invoice_id: result.invoice.id,
            purchase_count: result.purchase_count,
            message: "Invoice import committed atomically.".to_string(),
        }),
    ))
}
