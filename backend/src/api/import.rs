use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    routing::post,
    Json, Router,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use uuid::Uuid;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::AuthenticatedUser,
    db::{models::*, queries},
};

use super::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/vendors", post(import_vendors))
        .route("/destinations", post(import_destinations))
        .route("/items", post(import_items))
        .route("/purchases", post(import_purchases))
        .route("/invoice-pdf", post(parse_invoice_pdf))
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
    #[serde(alias = "item", alias = "item_id", alias = "Item", alias = "Item Name", alias = "item_name")]
    item: String,
    
    #[serde(alias = "destination", alias = "dest", alias = "Destination", alias = "dest_code", alias = "Dest", alias = "Default Destination", alias = "Default Dest")]
    destination: Option<String>,
    
    #[serde(alias = "qty", alias = "Qty", alias = "Quantity")]
    quantity: i32,
    
    #[serde(alias = "cost", alias = "unit_cost", alias = "purchase_cost", alias = "Cost", alias = "Unit Cost", alias = "Purchase Cost", alias = "Item Cost")]
    purchase_cost: String,
    
    #[serde(alias = "date", alias = "Date", alias = "purchase_date", default)]
    date: Option<String>,
    
    #[serde(alias = "invoice", alias = "Invoice", alias = "invoice_number", default)]
    invoice: Option<String>,
    
    #[serde(alias = "receipt", alias = "Receipt", alias = "receipt_number", default)]
    receipt: Option<String>,
    
    #[serde(alias = "invoice_unit_price", alias = "Invoice Unit Price", alias = "unit_price", alias = "price", default)]
    invoice_unit_price: Option<String>,
    
    #[serde(alias = "Status", alias = "status", alias = "delivery_status", default)]
    status: Option<String>,
    
    #[serde(alias = "delivery_date", alias = "Delivery Date", alias = "delivered", default)]
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

                let create_data = CreateVendor { name: row.name.clone(), short_id: None };
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
    
    let existing_codes: HashSet<String> = existing
        .iter()
        .map(|d| d.code.to_lowercase())
        .collect();
    
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
    
    #[serde(alias = "Destination", alias = "default_destination", alias = "dest_code", alias = "Default Destination", alias = "Default Dest", alias = "Dest", alias = "dest", alias = "destination", default)]
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
    let item_by_name: HashMap<String, &ActiveItem> = items
        .iter()
        .map(|i| (i.name.to_lowercase(), i))
        .collect();
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
                    Some(s) if !s.is_empty() => {
                        match s.to_lowercase().as_str() {
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
                        }
                    }
                    _ => Some(DeliveryStatus::Pending),
                };

                // Parse delivery date (optional)
                let delivery_date = match &row.delivery_date {
                    Some(date_str) if !date_str.is_empty() => {
                        match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                            Ok(d) => Some(d),
                            Err(_) => {
                                match NaiveDate::parse_from_str(date_str, "%m/%d/%Y") {
                                    Ok(d) => Some(d),
                                    Err(_) => {
                                        errors.push(ImportError {
                                            row: row_num,
                                            message: format!("Invalid delivery date: {} (use YYYY-MM-DD)", date_str),
                                            original_data: original_line,
                                        });
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                    _ => None,
                };

                // Parse unit cost
                let purchase_cost = match Decimal::from_str(&row.purchase_cost.replace(['$', ','], "")) {
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
                            Err(_) => {
                                match NaiveDate::parse_from_str(date_str, "%m/%d/%Y") {
                                    Ok(d) => d,
                                    Err(_) => {
                                        errors.push(ImportError {
                                            row: row_num,
                                            message: format!("Invalid date: {} (use YYYY-MM-DD)", date_str),
                                            original_data: original_line,
                                        });
                                        continue;
                                    }
                                }
                            }
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
                        message: format!("Duplicate: {} on {} qty:{} cost:{}", 
                            item.name, purchase_date, row.quantity, row.purchase_cost),
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
        results.into_iter().next().unwrap().expect("First row should parse successfully")
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
                ImportError { row: 2, message: "Error 1".into(), original_data: "data1,data2".into() },
                ImportError { row: 3, message: "Error 2".into(), original_data: "data3,data4".into() },
            ];
            let result = build_failed_csv("col1,col2", &errors);
            assert_eq!(result, "col1,col2\ndata1,data2\ndata3,data4\n");
        }

        #[test]
        fn skips_errors_without_original_data() {
            let errors = vec![
                ImportError { row: 2, message: "Error 1".into(), original_data: "data1".into() },
                ImportError { row: 3, message: "Error 2".into(), original_data: "".into() },
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
            let row: CsvItemRow = assert_parses(
                "name,destination\nEcho Dot,BSC"
            );
            assert_eq!(row.destination, Some("BSC".to_string()));
        }

        #[test]
        fn parses_default_destination_alias() {
            let row: CsvItemRow = assert_parses(
                "Item,Default Destination\nEcho Dot,CBG"
            );
            assert_eq!(row.destination, Some("CBG".to_string()));
        }

        #[test]
        fn destination_defaults_to_none() {
            let row: CsvItemRow = assert_parses("name\nEcho Dot");
            assert_eq!(row.destination, None);
        }

        #[test]
        fn parses_optional_notes() {
            let row: CsvItemRow = assert_parses(
                "name,notes\nEcho Dot,Test note"
            );
            assert_eq!(row.notes, Some("Test note".to_string()));
        }

        #[test]
        fn handles_extra_columns() {
            // CSV with extra columns that should be ignored
            let row: CsvItemRow = assert_parses(
                "Item,Extra Col,Another Extra\nEcho,ignore,also ignore"
            );
            assert_eq!(row.name, "Echo");
        }
    }

    // ==================== CSV PURCHASE ROW TESTS ====================

    mod csv_purchase_row_tests {
        use super::*;

        #[test]
        fn parses_standard_format() {
            let row: CsvPurchaseRow = assert_parses(
                "item,quantity,unit_cost\nEcho Dot,5,39.99"
            );
            assert_eq!(row.item, "Echo Dot");
            assert_eq!(row.quantity, 5);
            assert_eq!(row.purchase_cost, "39.99");
        }

        #[test]
        fn parses_with_aliases() {
            let row: CsvPurchaseRow = assert_parses(
                "Item,Qty,Cost\nPS5,2,519.99"
            );
            assert_eq!(row.item, "PS5");
            assert_eq!(row.quantity, 2);
            assert_eq!(row.purchase_cost, "519.99");
        }

        #[test]
        fn parses_optional_destination() {
            let row: CsvPurchaseRow = assert_parses(
                "item,quantity,unit_cost,destination\nEcho,3,39.99,BSC"
            );
            assert_eq!(row.destination, Some("BSC".to_string()));
        }

        #[test]
        fn parses_optional_date() {
            let row: CsvPurchaseRow = assert_parses(
                "item,quantity,unit_cost,date\nEcho,3,39.99,2024-11-15"
            );
            assert_eq!(row.date, Some("2024-11-15".to_string()));
        }

        #[test]
        fn parses_optional_invoice() {
            let row: CsvPurchaseRow = assert_parses(
                "item,quantity,unit_cost,invoice\nEcho,3,39.99,INV-001"
            );
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
                errors: vec![
                    ImportError { row: 3, message: "Test error".into(), original_data: "row3".into() },
                ],
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
    let tmp_dir = tempfile::tempdir()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Temp dir error: {e}")))?;
    let tmp_path = tmp_dir.path().join("invoice.pdf");
    let mut tmp_file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("File create error: {e}")))?;
    tmp_file
        .write_all(&pdf_bytes)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("File write error: {e}")))?;
    tmp_file.flush().await.ok();

    // Run Python parser - resolve script path relative to the project root
    let script_path = std::env::current_dir()
        .unwrap_or_default()
        .join("../scripts/parse_invoice_pdf.py");
    let output = tokio::process::Command::new("python3")
        .arg(&script_path)
        .arg(&tmp_path)
        .output()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to run PDF parser: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("PDF parser failed: {stderr}"),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Parse JSON error: {e}")))?;

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
        invoice_number: parsed.get("invoice_number").and_then(|v| v.as_str()).map(String::from),
        invoice_date: parsed.get("invoice_date").and_then(|v| v.as_str()).map(String::from),
        bill_to: parsed.get("bill_to").and_then(|v| v.as_str()).map(String::from),
        line_items,
        subtotal: parsed.get("subtotal").and_then(|v| v.as_str()).map(String::from),
        tax_rate: parsed.get("tax_rate").and_then(|v| v.as_str()).map(String::from),
        tax_amount: parsed.get("tax_amount").and_then(|v| v.as_str()).map(String::from),
        total: parsed.get("total").and_then(|v| v.as_str()).map(String::from),
        notes: parsed.get("notes").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
    };

    Ok(Json(result))
}