use axum::{
    extract::{Path, State},
    http::StatusCode,
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
        .route("/{id}", get(get_invoice).put(update_invoice).delete(delete_invoice))
}

async fn list_invoices(
    State(state): State<AppState>,
) -> Result<Json<Vec<IncomingInvoice>>, (StatusCode, String)> {
    let invoices = queries::get_all_invoices(&state.pool)
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

async fn get_invoice(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<IncomingInvoice>, (StatusCode, String)> {
    let invoice = queries::get_invoice_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invoice not found".to_string()))?;
    Ok(Json(invoice))
}

async fn create_invoice(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateInvoice>,
) -> Result<(StatusCode, Json<IncomingInvoice>), (StatusCode, String)> {
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
) -> Result<Json<IncomingInvoice>, (StatusCode, String)> {
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
