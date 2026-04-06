use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{StatusCode, header},
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_receipts).post(create_receipt))
        .route("/{id}", get(get_receipt_detail).put(update_receipt).delete(delete_receipt))
        .route("/{id}/purchases", get(get_receipt_purchases))
        .route("/{id}/document", get(download_document).post(upload_document))
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(purchases))
}

async fn create_receipt(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateReceipt>,
) -> Result<(StatusCode, Json<Receipt>), (StatusCode, String)> {
    let receipt = queries::create_receipt(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
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
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let filename = field
                .file_name()
                .unwrap_or("receipt.pdf")
                .to_string();
            let data = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

            queries::save_receipt_pdf(&state.pool, id, &data, &filename)
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
