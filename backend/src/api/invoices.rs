use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
};
use uuid::Uuid;
use zip::{write::FileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    auth::AuthenticatedUser,
    db::{models::*, queries},
};

use super::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_invoices).post(create_invoice))
        .route("/backup/import", post(import_backup))
        .route("/backup/import-all", post(import_all_backups))
        .route("/backup/export", get(export_all_backups))
        .route("/reconciliation", get(list_reconciliations))
        .route(
            "/{id}",
            get(get_invoice_detail)
                .put(update_invoice)
                .delete(delete_invoice),
        )
        .route("/{id}/purchases", get(get_invoice_purchases))
        .route("/{id}/backup", get(export_backup))
        .route(
            "/{id}/document",
            get(download_document).post(upload_document),
        )
}

async fn list_invoices(
    State(state): State<AppState>,
) -> Result<Json<Vec<InvoiceWithDestination>>, (StatusCode, String)> {
    let invoices = queries::get_invoices_with_destination(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(invoices))
}

async fn list_reconciliations(
    State(state): State<AppState>,
) -> Result<Json<Vec<InvoiceReconciliation>>, (StatusCode, String)> {
    let reconciliations = queries::get_invoice_reconciliation(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(reconciliations))
}

async fn get_invoice_detail(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<InvoiceWithDestination>, (StatusCode, String)> {
    let invoice = queries::get_invoice_with_destination(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;
    Ok(Json(invoice))
}

async fn get_invoice_purchases(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<PurchaseEconomics>>, (StatusCode, String)> {
    // Verify invoice exists
    let _invoice = queries::get_invoice_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;

    let purchases = queries::get_purchases_by_invoice(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(purchases))
}

async fn create_invoice(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateInvoice>,
) -> Result<(StatusCode, Json<Invoice>), (StatusCode, String)> {
    let invoice = queries::create_invoice(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(invoice)))
}

async fn update_invoice(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdateInvoice>,
) -> Result<Json<Invoice>, (StatusCode, String)> {
    let invoice = queries::update_invoice(&state.pool, id, data, user.user_id)
        .await
        .map_err(map_invoice_write_error)?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;
    Ok(Json(invoice))
}

async fn delete_invoice(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_invoice(&state.pool, id, user.user_id)
        .await
        .map_err(map_invoice_write_error)?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Invoice not found".to_string()))
    }
}

fn map_invoice_write_error(err: sqlx::Error) -> (StatusCode, String) {
    if let Some(msg) = queries::locked_invoice_error_message(&err) {
        return (StatusCode::UNPROCESSABLE_ENTITY, msg);
    }

    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

async fn upload_document(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, String)> {
    // Verify invoice exists
    let _invoice = queries::get_invoice_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let filename = field.file_name().unwrap_or("invoice.pdf").to_string();
            let data = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

            queries::save_invoice_pdf(&state.pool, id, &data, &filename)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            return Ok(StatusCode::OK);
        }
    }

    Err((StatusCode::BAD_REQUEST, "No file field found".to_string()))
}

async fn download_document(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, (StatusCode, String)> {
    let (pdf_data, filename) = queries::get_invoice_pdf(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((
            StatusCode::NOT_FOUND,
            "No document attached to this invoice".to_string(),
        ))?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", filename),
        )
        .body(Body::from(pdf_data))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(response)
}

#[derive(Debug, Serialize, Deserialize)]
struct InvoiceBackupBundle {
    version: u32,
    exported_at: DateTime<Utc>,
    invoice: BackupInvoice,
    destination: BackupDestination,
    receipts: Vec<BackupReceipt>,
    purchases: Vec<BackupPurchase>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupInvoice {
    #[serde(alias = "legacy_id")]
    source_id: Uuid,
    invoice_number: String,
    order_number: Option<String>,
    invoice_date: NaiveDate,
    delivery_date: Option<NaiveDate>,
    subtotal: Decimal,
    tax_rate: Decimal,
    reconciliation_state: String,
    notes: Option<String>,
    document_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupDestination {
    #[serde(alias = "legacy_id")]
    source_id: Uuid,
    code: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupReceipt {
    #[serde(alias = "legacy_id")]
    source_id: Uuid,
    vendor_name: String,
    vendor_short_id: Option<String>,
    receipt_number: String,
    receipt_date: NaiveDate,
    subtotal: Decimal,
    #[serde(default)]
    tax_amount: Option<Decimal>,
    #[serde(default)]
    tax_rate: Option<Decimal>, // legacy backups only — used as fallback if tax_amount missing
    payment_method: Option<String>,
    ingestion_metadata: Option<serde_json::Value>,
    notes: Option<String>,
    document_path: Option<String>,
    line_items: Vec<BackupReceiptLineItem>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupReceiptLineItem {
    #[serde(alias = "legacy_id")]
    source_id: Uuid,
    item_name: String,
    quantity: i32,
    unit_cost: Decimal,
    notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupPurchase {
    #[serde(alias = "legacy_id")]
    source_id: Uuid,
    item_name: String,
    destination_code: Option<String>,
    quantity: i32,
    purchase_cost: Decimal,
    invoice_unit_price: Option<Decimal>,
    status: DeliveryStatus,
    delivery_date: Option<NaiveDate>,
    notes: Option<String>,
    #[serde(alias = "legacy_receipt_id")]
    source_receipt_id: Option<Uuid>,
    allocations: Vec<BackupPurchaseAllocation>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupPurchaseAllocation {
    #[serde(alias = "legacy_receipt_id")]
    source_receipt_id: Uuid,
    #[serde(alias = "legacy_receipt_line_item_id")]
    source_receipt_line_item_id: Option<Uuid>,
    allocated_qty: i32,
    unit_cost: Decimal,
}

#[derive(Debug, Serialize)]
struct InvoiceBackupImportResponse {
    invoice_id: Uuid,
    invoice_number: String,
    restored_purchase_count: usize,
    restored_receipt_count: usize,
    restored_allocation_count: usize,
}

#[derive(Debug, Serialize)]
struct InvoiceBulkBackupImportResponse {
    restored_invoice_count: usize,
    restored_purchase_count: usize,
    restored_receipt_count: usize,
    restored_allocation_count: usize,
    restored_invoices: Vec<InvoiceBackupImportResponse>,
}

#[derive(Debug, Deserialize)]
struct InvoiceBulkBackupExportQuery {
    include_unfinalized: Option<bool>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    include_documents: Option<bool>,
}

#[derive(Debug, Serialize)]
struct InvoiceBulkBackupManifest {
    version: u32,
    exported_at: DateTime<Utc>,
    include_unfinalized: bool,
    include_documents: bool,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    invoice_count: usize,
    invoices: Vec<InvoiceBulkBackupManifestInvoice>,
}

#[derive(Debug, Serialize)]
struct InvoiceBulkBackupManifestInvoice {
    invoice_id: Uuid,
    invoice_number: String,
    invoice_date: NaiveDate,
    reconciliation_state: String,
    backup_path: String,
}

async fn build_invoice_backup_zip(
    state: &AppState,
    id: Uuid,
    include_documents: bool,
) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let invoice = queries::get_invoice_with_destination(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;

    let destination = queries::get_destination_by_id(&state.pool, invoice.destination_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((
            StatusCode::NOT_FOUND,
            "Invoice destination not found".to_string(),
        ))?;

    let purchases = queries::get_purchases_by_invoice(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut allocations_by_purchase: HashMap<Uuid, Vec<PurchaseAllocationWithReceipt>> =
        HashMap::new();
    let mut receipt_ids: HashSet<Uuid> = HashSet::new();

    for purchase in &purchases {
        let rows = queries::get_purchase_allocations(&state.pool, purchase.purchase_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if rows.is_empty() {
            if let Some(receipt_id) = purchase.receipt_id {
                receipt_ids.insert(receipt_id);
            }
        } else {
            for allocation in &rows {
                receipt_ids.insert(allocation.receipt_id);
            }
        }
        allocations_by_purchase.insert(purchase.purchase_id, rows);
    }

    let mut archive_entries: Vec<(String, Vec<u8>)> = Vec::new();

    let invoice_document_path = if include_documents {
        queries::get_invoice_pdf(&state.pool, id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map(|(bytes, filename)| {
                let safe_name = sanitize_archive_filename(&filename, "invoice.pdf");
                let path = format!("documents/invoice/{}", safe_name);
                archive_entries.push((path.clone(), bytes));
                path
            })
    } else {
        None
    };

    let mut sorted_receipt_ids: Vec<Uuid> = receipt_ids.into_iter().collect();
    sorted_receipt_ids.sort();

    let mut backup_receipts: Vec<BackupReceipt> = Vec::new();
    for receipt_id in sorted_receipt_ids {
        let receipt = queries::get_receipt_with_vendor(&state.pool, receipt_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .ok_or((
                StatusCode::NOT_FOUND,
                format!("Receipt {} referenced by invoice is missing", receipt_id),
            ))?;

        let vendor = queries::get_vendor_by_id(&state.pool, receipt.vendor_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .ok_or((
                StatusCode::NOT_FOUND,
                format!(
                    "Vendor {} referenced by receipt is missing",
                    receipt.vendor_id
                ),
            ))?;

        let line_items = queries::get_receipt_line_items(&state.pool, receipt_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let receipt_document_path = if include_documents {
            queries::get_receipt_pdf(&state.pool, receipt_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .map(|(bytes, filename)| {
                    let safe_name = sanitize_archive_filename(&filename, "receipt.pdf");
                    let path = format!("documents/receipts/{}/{}", receipt_id, safe_name);
                    archive_entries.push((path.clone(), bytes));
                    path
                })
        } else {
            None
        };

        backup_receipts.push(BackupReceipt {
            source_id: receipt.id,
            vendor_name: receipt.vendor_name,
            vendor_short_id: vendor.short_id,
            receipt_number: receipt.receipt_number,
            receipt_date: receipt.receipt_date,
            subtotal: receipt.subtotal,
            tax_amount: Some(receipt.tax_amount),
            tax_rate: None,
            payment_method: receipt.payment_method,
            ingestion_metadata: receipt.ingestion_metadata,
            notes: receipt.notes,
            document_path: receipt_document_path,
            line_items: line_items
                .into_iter()
                .map(|line| BackupReceiptLineItem {
                    source_id: line.id,
                    item_name: line.item_name,
                    quantity: line.quantity,
                    unit_cost: line.unit_cost,
                    notes: line.notes,
                })
                .collect(),
        });
    }

    let mut backup_purchases: Vec<BackupPurchase> = purchases
        .into_iter()
        .map(|purchase| {
            let allocations = allocations_by_purchase
                .get(&purchase.purchase_id)
                .cloned()
                .unwrap_or_default();

            BackupPurchase {
                source_id: purchase.purchase_id,
                item_name: purchase.item_name,
                destination_code: purchase.destination_code,
                quantity: purchase.quantity,
                purchase_cost: purchase.purchase_cost,
                invoice_unit_price: purchase.invoice_unit_price,
                status: purchase.status,
                delivery_date: purchase.delivery_date,
                notes: purchase.notes,
                source_receipt_id: purchase.receipt_id,
                allocations: allocations
                    .into_iter()
                    .map(|allocation| BackupPurchaseAllocation {
                        source_receipt_id: allocation.receipt_id,
                        source_receipt_line_item_id: allocation.receipt_line_item_id,
                        allocated_qty: allocation.allocated_qty,
                        unit_cost: allocation.unit_cost,
                    })
                    .collect(),
            }
        })
        .collect();

    backup_purchases.sort_by_key(|row| row.source_id);
    backup_receipts.sort_by_key(|row| row.source_id);

    let backup_bundle = InvoiceBackupBundle {
        version: 1,
        exported_at: Utc::now(),
        invoice: BackupInvoice {
            source_id: invoice.id,
            invoice_number: invoice.invoice_number.clone(),
            order_number: invoice.order_number,
            invoice_date: invoice.invoice_date,
            delivery_date: invoice.delivery_date,
            subtotal: invoice.subtotal,
            tax_rate: invoice.tax_rate,
            reconciliation_state: invoice.reconciliation_state,
            notes: invoice.notes,
            document_path: invoice_document_path,
        },
        destination: BackupDestination {
            source_id: destination.id,
            code: destination.code,
            name: destination.name,
        },
        receipts: backup_receipts,
        purchases: backup_purchases,
    };

    let mut zip_writer = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_options = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip_writer
        .start_file("bundle.json", zip_options)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let manifest = serde_json::to_vec_pretty(&backup_bundle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    zip_writer
        .write_all(&manifest)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for (path, bytes) in archive_entries {
        zip_writer
            .start_file(path, zip_options)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        zip_writer
            .write_all(&bytes)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let zip_data = zip_writer
        .finish()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_inner();

    let safe_invoice_number = sanitize_archive_filename(&invoice.invoice_number, "invoice");
    let filename = format!("invoice_{}_backup.zip", safe_invoice_number);

    Ok((zip_data, filename))
}

async fn export_backup(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, (StatusCode, String)> {
    let (zip_data, filename) = build_invoice_backup_zip(&state, id, true).await?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(zip_data))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(response)
}

async fn export_all_backups(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Query(query): Query<InvoiceBulkBackupExportQuery>,
) -> Result<Response, (StatusCode, String)> {
    if let (Some(from), Some(to)) = (query.from, query.to) {
        if from > to {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid date range: 'from' must be less than or equal to 'to'".to_string(),
            ));
        }
    }

    let include_unfinalized = query.include_unfinalized.unwrap_or(false);
    let include_documents = query.include_documents.unwrap_or(true);

    let invoices = queries::get_invoices_with_destination(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let selected_invoices: Vec<InvoiceWithDestination> = invoices
        .into_iter()
        .filter(|invoice| {
            let state_ok = include_unfinalized || invoice.reconciliation_state == "locked";
            let from_ok = query
                .from
                .map(|from| invoice.invoice_date >= from)
                .unwrap_or(true);
            let to_ok = query
                .to
                .map(|to| invoice.invoice_date <= to)
                .unwrap_or(true);

            state_ok && from_ok && to_ok
        })
        .collect();

    if selected_invoices.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "No invoices matched the selected backup filters".to_string(),
        ));
    }

    let mut zip_writer = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_options = FileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut manifest_entries: Vec<InvoiceBulkBackupManifestInvoice> = Vec::new();
    for invoice in selected_invoices {
        let (invoice_zip, invoice_zip_filename) =
            build_invoice_backup_zip(&state, invoice.id, include_documents).await?;

        let short_id: String = invoice.id.to_string().chars().take(8).collect();
        let backup_path = format!("invoices/{}-{}", short_id, invoice_zip_filename);

        zip_writer
            .start_file(&backup_path, zip_options)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        zip_writer
            .write_all(&invoice_zip)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        manifest_entries.push(InvoiceBulkBackupManifestInvoice {
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            invoice_date: invoice.invoice_date,
            reconciliation_state: invoice.reconciliation_state,
            backup_path,
        });
    }

    let manifest = InvoiceBulkBackupManifest {
        version: 1,
        exported_at: Utc::now(),
        include_unfinalized,
        include_documents,
        from: query.from,
        to: query.to,
        invoice_count: manifest_entries.len(),
        invoices: manifest_entries,
    };

    zip_writer
        .start_file("manifest.json", zip_options)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    zip_writer
        .write_all(&manifest_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let zip_data = zip_writer
        .finish()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_inner();

    let filename = format!("invoices_backup_{}.zip", Utc::now().format("%Y%m%d_%H%M%S"));

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(zip_data))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(response)
}

async fn import_backup(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    multipart: Multipart,
) -> Result<(StatusCode, Json<InvoiceBackupImportResponse>), (StatusCode, String)> {
    let zip_payload = read_multipart_zip_payload(multipart).await?;
    let restored = import_backup_zip_payload(&state, user.user_id, zip_payload).await?;

    Ok((StatusCode::CREATED, Json(restored)))
}

async fn import_all_backups(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    multipart: Multipart,
) -> Result<(StatusCode, Json<InvoiceBulkBackupImportResponse>), (StatusCode, String)> {
    let zip_payload = read_multipart_zip_payload(multipart).await?;

    let mut archive = ZipArchive::new(Cursor::new(zip_payload.clone()))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid ZIP file: {}", e)))?;

    if archive.by_name("bundle.json").is_ok() {
        let restored = import_backup_zip_payload(&state, user.user_id, zip_payload).await?;
        return Ok((
            StatusCode::CREATED,
            Json(InvoiceBulkBackupImportResponse {
                restored_invoice_count: 1,
                restored_purchase_count: restored.restored_purchase_count,
                restored_receipt_count: restored.restored_receipt_count,
                restored_allocation_count: restored.restored_allocation_count,
                restored_invoices: vec![restored],
            }),
        ));
    }

    let mut nested_invoice_backups: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Failed to read entry {} from ZIP: {}", i, e),
            )
        })?;

        if entry.is_dir() {
            continue;
        }

        let path = entry.name().to_string();
        if !path.to_ascii_lowercase().ends_with(".zip") {
            continue;
        }

        let mut entry_bytes = Vec::new();
        entry.read_to_end(&mut entry_bytes).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Failed reading nested archive '{}': {}", path, e),
            )
        })?;
        nested_invoice_backups.push((path, entry_bytes));
    }

    if nested_invoice_backups.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "No invoice backup ZIP files found in archive. Expected nested *.zip files or bundle.json.".to_string(),
        ));
    }

    let mut restored_invoices: Vec<InvoiceBackupImportResponse> = Vec::new();
    let mut restored_purchase_count = 0usize;
    let mut restored_receipt_count = 0usize;
    let mut restored_allocation_count = 0usize;

    for (path, nested_zip) in nested_invoice_backups {
        let restored = import_backup_zip_payload(&state, user.user_id, nested_zip)
            .await
            .map_err(|(status, message)| {
                (status, format!("Failed importing '{}': {}", path, message))
            })?;

        restored_purchase_count += restored.restored_purchase_count;
        restored_receipt_count += restored.restored_receipt_count;
        restored_allocation_count += restored.restored_allocation_count;
        restored_invoices.push(restored);
    }

    Ok((
        StatusCode::CREATED,
        Json(InvoiceBulkBackupImportResponse {
            restored_invoice_count: restored_invoices.len(),
            restored_purchase_count,
            restored_receipt_count,
            restored_allocation_count,
            restored_invoices,
        }),
    ))
}

async fn read_multipart_zip_payload(
    mut multipart: Multipart,
) -> Result<Vec<u8>, (StatusCode, String)> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            return Ok(bytes.to_vec());
        }
    }

    Err((
        StatusCode::BAD_REQUEST,
        "Missing file field in multipart request".to_string(),
    ))
}

async fn import_backup_zip_payload(
    state: &AppState,
    user_id: Uuid,
    zip_payload: Vec<u8>,
) -> Result<InvoiceBackupImportResponse, (StatusCode, String)> {
    let mut archive = ZipArchive::new(Cursor::new(zip_payload))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid ZIP file: {}", e)))?;

    let manifest_bytes = read_zip_entry(&mut archive, "bundle.json")?;
    let bundle: InvoiceBackupBundle = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid backup manifest: {}", e),
        )
    })?;

    if bundle.version != 1 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Unsupported backup version: {}", bundle.version),
        ));
    }

    let existing_destinations = queries::get_all_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut destination_by_code: HashMap<String, Uuid> = existing_destinations
        .into_iter()
        .map(|d| (d.code.to_lowercase(), d.id))
        .collect();

    let mut required_destination_codes: HashSet<String> = HashSet::new();
    required_destination_codes.insert(bundle.destination.code.clone());
    for purchase in &bundle.purchases {
        if let Some(code) = purchase.destination_code.as_deref() {
            let trimmed = code.trim();
            if !trimmed.is_empty() {
                required_destination_codes.insert(trimmed.to_string());
            }
        }
    }

    for code in required_destination_codes {
        let key = code.to_lowercase();
        if destination_by_code.contains_key(&key) {
            continue;
        }

        let destination_name = if code.eq_ignore_ascii_case(&bundle.destination.code) {
            bundle.destination.name.clone()
        } else {
            code.clone()
        };

        let created_destination = queries::create_destination(
            &state.pool,
            CreateDestination {
                code: code.clone(),
                name: destination_name,
                is_active: Some(true),
            },
            user_id,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        destination_by_code.insert(key, created_destination.id);
    }

    let invoice_destination_id = destination_by_code
        .get(&bundle.destination.code.to_lowercase())
        .copied()
        .ok_or((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "Could not resolve destination code '{}' during restore",
                bundle.destination.code
            ),
        ))?;

    let created_invoice = queries::create_invoice(
        &state.pool,
        CreateInvoice {
            destination_id: invoice_destination_id,
            invoice_number: bundle.invoice.invoice_number.clone(),
            order_number: bundle.invoice.order_number.clone(),
            invoice_date: bundle.invoice.invoice_date,
            delivery_date: bundle.invoice.delivery_date,
            subtotal: bundle.invoice.subtotal,
            tax_amount: Some(bundle.invoice.subtotal * bundle.invoice.tax_rate / Decimal::new(100, 0)),
            tax_rate: Some(bundle.invoice.tax_rate),
            reconciliation_state: Some(bundle.invoice.reconciliation_state.clone()),
            notes: bundle.invoice.notes.clone(),
        },
        user_id,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(path) = bundle.invoice.document_path.as_deref() {
        let document_bytes = read_zip_entry(&mut archive, path)?;
        let filename = zip_path_filename(path, "invoice.pdf");
        queries::save_invoice_pdf(&state.pool, created_invoice.id, &document_bytes, &filename)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let existing_vendors = queries::get_all_vendors(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut vendor_by_name: HashMap<String, Uuid> = existing_vendors
        .into_iter()
        .map(|vendor| (vendor.name.to_lowercase(), vendor.id))
        .collect();

    let existing_items = queries::get_active_items(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut item_by_name: HashMap<String, Uuid> = existing_items
        .into_iter()
        .map(|item| (item.name.to_lowercase(), item.id))
        .collect();

    let mut receipt_id_map: HashMap<Uuid, Uuid> = HashMap::new();
    let mut receipt_line_item_id_map: HashMap<Uuid, Uuid> = HashMap::new();

    for receipt in &bundle.receipts {
        let vendor_key = receipt.vendor_name.to_lowercase();
        let vendor_id = if let Some(existing_vendor_id) = vendor_by_name.get(&vendor_key).copied() {
            existing_vendor_id
        } else {
            let created_vendor = queries::create_vendor(
                &state.pool,
                CreateVendor {
                    name: receipt.vendor_name.clone(),
                    short_id: receipt.vendor_short_id.clone(),
                },
                user_id,
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            vendor_by_name.insert(vendor_key, created_vendor.id);
            created_vendor.id
        };

        let mut attempt = 0u32;
        let restored_receipt = loop {
            let candidate_number = if attempt == 0 {
                Some(receipt.receipt_number.clone())
            } else {
                Some(make_restore_receipt_number(
                    &receipt.receipt_number,
                    attempt,
                ))
            };

            let create_result = queries::create_receipt(
                &state.pool,
                CreateReceipt {
                    vendor_id,
                    source_vendor_alias: None,
                    receipt_number: candidate_number,
                    receipt_date: receipt.receipt_date,
                    subtotal: receipt.subtotal,
                    tax_amount: receipt.tax_amount.or_else(|| {
                        receipt.tax_rate.map(|rate| receipt.subtotal * rate / Decimal::new(100, 0))
                    }),
                    tax_rate: receipt.tax_rate,
                    payment_method: receipt.payment_method.clone(),
                    ingestion_metadata: receipt.ingestion_metadata.clone(),
                    notes: receipt.notes.clone(),
                },
                user_id,
            )
            .await;

            match create_result {
                Ok(created) => break created,
                Err(err) if is_receipt_number_conflict(&err) => {
                    attempt += 1;
                    if attempt > 20 {
                        return Err((
                            StatusCode::CONFLICT,
                            format!(
                                "Could not assign unique receipt number for {} after multiple attempts",
                                receipt.receipt_number
                            ),
                        ));
                    }
                }
                Err(err) => {
                    return Err((StatusCode::INTERNAL_SERVER_ERROR, err.to_string()));
                }
            }
        };

        if let Some(path) = receipt.document_path.as_deref() {
            let document_bytes = read_zip_entry(&mut archive, path)?;
            let filename = zip_path_filename(path, "receipt.pdf");
            queries::save_receipt_pdf(&state.pool, restored_receipt.id, &document_bytes, &filename)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }

        receipt_id_map.insert(receipt.source_id, restored_receipt.id);

        for line_item in &receipt.line_items {
            let item_key = line_item.item_name.to_lowercase();
            let item_id = if let Some(existing_item_id) = item_by_name.get(&item_key).copied() {
                existing_item_id
            } else {
                let created_item = queries::create_item(
                    &state.pool,
                    CreateItem {
                        name: line_item.item_name.clone(),
                        default_destination_id: Some(invoice_destination_id),
                        notes: None,
                    },
                    user_id,
                )
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                item_by_name.insert(item_key, created_item.id);
                created_item.id
            };

            let created_line_item = queries::create_receipt_line_item(
                &state.pool,
                restored_receipt.id,
                CreateReceiptLineItem {
                    item_id,
                    quantity: line_item.quantity,
                    unit_cost: line_item.unit_cost,
                    notes: line_item.notes.clone(),
                    parent_line_item_id: None,
                },
            )
            .await
            .map_err(map_purchase_allocation_error)?;

            receipt_line_item_id_map.insert(line_item.source_id, created_line_item.id);
        }
    }

    let mut purchase_id_map: HashMap<Uuid, Uuid> = HashMap::new();
    for purchase in &bundle.purchases {
        let item_key = purchase.item_name.to_lowercase();
        let item_id = if let Some(existing_item_id) = item_by_name.get(&item_key).copied() {
            existing_item_id
        } else {
            let created_item = queries::create_item(
                &state.pool,
                CreateItem {
                    name: purchase.item_name.clone(),
                    default_destination_id: Some(invoice_destination_id),
                    notes: None,
                },
                user_id,
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            item_by_name.insert(item_key, created_item.id);
            created_item.id
        };

        let purchase_destination_id = purchase
            .destination_code
            .as_ref()
            .and_then(|code| destination_by_code.get(&code.to_lowercase()).copied())
            .unwrap_or(invoice_destination_id);

        let direct_receipt_id = if purchase.allocations.is_empty() {
            purchase
                .source_receipt_id
                .and_then(|source_receipt_id| receipt_id_map.get(&source_receipt_id).copied())
        } else {
            None
        };

        let created_purchase = queries::create_purchase(
            &state.pool,
            CreatePurchase {
                item_id,
                invoice_id: Some(created_invoice.id),
                receipt_id: direct_receipt_id,
                quantity: purchase.quantity,
                purchase_cost: purchase.purchase_cost,
                invoice_unit_price: purchase.invoice_unit_price,
                destination_id: Some(purchase_destination_id),
                status: Some(purchase.status),
                delivery_date: purchase.delivery_date,
                notes: purchase.notes.clone(),
                refunds_purchase_id: None,
                purchase_type: None,
                bonus_for_purchase_id: None,
            },
            user_id,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        purchase_id_map.insert(purchase.source_id, created_purchase.id);
    }

    let mut restored_allocation_count = 0usize;
    for purchase in &bundle.purchases {
        let restored_purchase_id = purchase_id_map.get(&purchase.source_id).copied().ok_or((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "Missing restored purchase mapping for {}",
                purchase.source_id
            ),
        ))?;

        for allocation in &purchase.allocations {
            let source_line_item_id = allocation.source_receipt_line_item_id.ok_or((
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "Allocation on purchase {} is missing receipt_line_item_id; backup cannot be restored safely",
                    purchase.source_id
                ),
            ))?;

            let restored_line_item_id = receipt_line_item_id_map
                .get(&source_line_item_id)
                .copied()
                .ok_or((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!(
                        "Missing restored receipt line item mapping for {}",
                        source_line_item_id
                    ),
                ))?;

            queries::create_purchase_allocation(
                &state.pool,
                restored_purchase_id,
                CreatePurchaseAllocation {
                    receipt_line_item_id: restored_line_item_id,
                    allocated_qty: allocation.allocated_qty,
                    allow_receipt_date_override: false,
                },
            )
            .await
            .map_err(map_purchase_allocation_error)?;

            restored_allocation_count += 1;
        }
    }

    Ok(InvoiceBackupImportResponse {
        invoice_id: created_invoice.id,
        invoice_number: created_invoice.invoice_number,
        restored_purchase_count: bundle.purchases.len(),
        restored_receipt_count: bundle.receipts.len(),
        restored_allocation_count,
    })
}

fn sanitize_archive_filename(input: &str, fallback: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    let sanitized: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn zip_path_filename(path: &str, fallback: &str) -> String {
    path.rsplit('/').next().map_or_else(
        || fallback.to_string(),
        |segment| sanitize_archive_filename(segment, fallback),
    )
}

fn read_zip_entry(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    path: &str,
) -> Result<Vec<u8>, (StatusCode, String)> {
    let mut file = archive.by_name(path).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            format!("Backup is missing required file '{}'.", path),
        )
    })?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Failed to read '{}' from backup: {}", path, e),
        )
    })?;

    Ok(bytes)
}

fn make_restore_receipt_number(base: &str, attempt: u32) -> String {
    let suffix = format!("-R{}", attempt);
    let max_base_len = 100usize.saturating_sub(suffix.len());
    let trimmed_base: String = base.chars().take(max_base_len).collect();
    format!("{}{}", trimmed_base, suffix)
}

fn is_receipt_number_conflict(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db_err) => db_err.constraint() == Some("receipts_receipt_number_key"),
        _ => false,
    }
}

fn map_purchase_allocation_error(err: queries::PurchaseAllocationError) -> (StatusCode, String) {
    match err {
        queries::PurchaseAllocationError::Validation(msg) => {
            (StatusCode::UNPROCESSABLE_ENTITY, msg)
        }
        queries::PurchaseAllocationError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
        queries::PurchaseAllocationError::Sql(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}
