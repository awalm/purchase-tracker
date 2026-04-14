use axum::{
    body::Body,
    extract::{Multipart, Path, State},
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_invoices).post(create_invoice))
        .route("/reconciliation", get(list_reconciliations))
        .route(
            "/{id}",
            get(get_invoice_detail)
                .put(update_invoice)
                .delete(delete_invoice),
        )
        .route("/{id}/purchases", get(get_invoice_purchases))
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Invoice not found".to_string()))
    }
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
