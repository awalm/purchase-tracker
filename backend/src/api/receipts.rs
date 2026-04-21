use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{header, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    db::{models::*, queries},
};

use super::AppState;

const RECEIPT_MULTIPART_MAX_BYTES: usize = 25 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_receipts).post(create_receipt))
        .route(
            "/{id}",
            get(get_receipt_detail)
                .put(update_receipt)
                .delete(delete_receipt),
        )
        .route("/{id}/purchases", get(get_receipt_purchases))
        .route("/{id}/metadata-audit", get(get_receipt_metadata_audit))
        .route(
            "/{id}/line-items",
            get(list_receipt_line_items).post(create_receipt_line_item),
        )
        .route(
            "/{id}/line-items/{line_item_id}",
            axum::routing::put(update_receipt_line_item).delete(delete_receipt_line_item),
        )
        .route(
            "/{id}/document",
            get(download_document).post(upload_document),
        )
        .layer(DefaultBodyLimit::max(RECEIPT_MULTIPART_MAX_BYTES))
}

fn map_receipt_multipart_error<E: std::fmt::Display>(err: E) -> (StatusCode, String) {
    let message = err.to_string();
    let message_lower = message.to_ascii_lowercase();

    if message_lower.contains("too large")
        || message_lower.contains("size limit")
        || message_lower.contains("length limit")
        || message_lower.contains("body")
    {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Uploaded file is too large. Maximum allowed size is {} MB.",
                RECEIPT_MULTIPART_MAX_BYTES / (1024 * 1024)
            ),
        );
    }

    (
        StatusCode::BAD_REQUEST,
        "Invalid upload payload. Please upload one PDF, JPG, JPEG, PNG, or WEBP file."
            .to_string(),
    )
}

async fn list_receipts(
    State(state): State<AppState>,
) -> Result<Json<Vec<ReceiptWithVendor>>, (StatusCode, String)> {
    let receipts = queries::get_receipts_with_vendor(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(receipts))
}

async fn get_receipt_detail(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ReceiptWithVendor>, (StatusCode, String)> {
    let receipt = queries::get_receipt_with_vendor(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;
    Ok(Json(receipt))
}

async fn get_receipt_purchases(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<PurchaseEconomics>>, (StatusCode, String)> {
    // Verify receipt exists
    let _receipt = queries::get_receipt_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;

    let purchases = queries::get_purchases_by_receipt(&state.pool, id)
        .await
        .map_err(map_receipt_reconciliation_error)?;
    Ok(Json(purchases))
}

async fn get_receipt_metadata_audit(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ReceiptMetadataAuditEntry>>, (StatusCode, String)> {
    let _receipt = queries::get_receipt_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;

    let rows = queries::get_receipt_metadata_audit(&state.pool, id, Some(25))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

async fn list_receipt_line_items(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ReceiptLineItemWithItem>>, (StatusCode, String)> {
    let _receipt = queries::get_receipt_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;

    let rows = queries::get_receipt_line_items(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

async fn create_receipt_line_item(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<CreateReceiptLineItem>,
) -> Result<(StatusCode, Json<ReceiptLineItemWithItem>), (StatusCode, String)> {
    let row = queries::create_receipt_line_item(&state.pool, id, data)
        .await
        .map_err(map_validation_error)?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn update_receipt_line_item(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path((id, line_item_id)): Path<(Uuid, Uuid)>,
    Json(data): Json<UpdateReceiptLineItem>,
) -> Result<Json<ReceiptLineItemWithItem>, (StatusCode, String)> {
    let row = queries::update_receipt_line_item(&state.pool, id, line_item_id, data)
        .await
        .map_err(map_validation_error)?;
    Ok(Json(row))
}

async fn delete_receipt_line_item(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path((id, line_item_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_receipt_line_item(&state.pool, id, line_item_id)
        .await
        .map_err(map_validation_error)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((
            StatusCode::NOT_FOUND,
            "Receipt line item not found".to_string(),
        ))
    }
}

fn map_validation_error(err: queries::PurchaseAllocationError) -> (StatusCode, String) {
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

fn map_receipt_reconciliation_error(
    err: queries::ReceiptReconciliationError,
) -> (StatusCode, String) {
    match err {
        queries::ReceiptReconciliationError::Validation(msg) => {
            (StatusCode::UNPROCESSABLE_ENTITY, msg)
        }
        queries::ReceiptReconciliationError::Sql(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}

fn map_receipt_write_error(err: sqlx::Error) -> (StatusCode, String) {
    if let Some(msg) = queries::locked_invoice_error_message(&err) {
        return (StatusCode::UNPROCESSABLE_ENTITY, msg);
    }

    if let sqlx::Error::Database(db_err) = &err {
        if db_err.constraint() == Some("receipts_receipt_number_key") {
            return (
                StatusCode::CONFLICT,
                "Receipt number already exists. Use a unique receipt number.".to_string(),
            );
        }
    }

    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

async fn create_receipt(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateReceipt>,
) -> Result<(StatusCode, Json<Receipt>), (StatusCode, String)> {
    let source_vendor_alias = data
        .source_vendor_alias
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if let Some(alias) = source_vendor_alias.as_deref() {
        queries::upsert_vendor_import_alias(&state.pool, alias, data.vendor_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let receipt = queries::create_receipt(&state.pool, data, user.user_id)
        .await
        .map_err(map_receipt_write_error)?;
    Ok((StatusCode::CREATED, Json(receipt)))
}

async fn update_receipt(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdateReceipt>,
) -> Result<Json<Receipt>, (StatusCode, String)> {
    let receipt = queries::update_receipt(&state.pool, id, data, user.user_id)
        .await
        .map_err(map_receipt_write_error)?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;
    Ok(Json(receipt))
}

async fn delete_receipt(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_receipt(&state.pool, id, user.user_id)
        .await
        .map_err(map_receipt_write_error)?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Receipt not found".to_string()))
    }
}

async fn upload_document(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, String)> {
    // Verify receipt exists
    let _receipt = queries::get_receipt_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Receipt not found".to_string()))?;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(map_receipt_multipart_error)?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let filename = field.file_name().unwrap_or("receipt.pdf").to_string();
            let data = field
                .bytes()
                .await
                .map_err(map_receipt_multipart_error)?;

            queries::save_receipt_pdf(&state.pool, id, &data, &filename)
                .await
                .map_err(map_receipt_write_error)?;

            return Ok(StatusCode::OK);
        }
    }

    Err((
        StatusCode::BAD_REQUEST,
        "No file field found. Please upload one file using the 'file' form field.".to_string(),
    ))
}

async fn download_document(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, (StatusCode, String)> {
    let (pdf_data, filename) = queries::get_receipt_pdf(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "No document found".to_string()))?;

    let content_type = if filename.ends_with(".pdf") {
        "application/pdf"
    } else if filename.ends_with(".png") {
        "image/png"
    } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
        "image/jpeg"
    } else if filename.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    };

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", filename),
        )
        .body(Body::from(pdf_data))
        .unwrap())
}
