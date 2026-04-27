use axum::{
    extract::{Path, Query, State},
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

#[derive(Debug, serde::Serialize)]
pub struct TaxValidationError {
    pub error: String,
    pub missing_tax_rates: Vec<MissingTaxRate>,
}

#[derive(Debug, serde::Serialize)]
pub struct MissingTaxRate {
    pub invoice_id: String,
    pub invoice_number: String,
    pub reconciliation_state: String,
    pub message: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_items).post(create_item))
        .route("/active", get(list_active_items))
        .route("/{id}", get(get_item).put(update_item).delete(delete_item))
        .route("/{id}/purchases", get(list_item_purchases))
        .route("/{id}/receipt-lines", get(list_item_receipt_lines))
}

async fn list_items(
    State(state): State<AppState>,
    Query(query): Query<ItemQuery>,
) -> Result<Json<Vec<Item>>, (StatusCode, String)> {
    let items = queries::get_all_items(&state.pool, query)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(items))
}

async fn list_active_items(
    State(state): State<AppState>,
) -> Result<Json<Vec<ActiveItem>>, (StatusCode, String)> {
    let items = queries::get_active_items(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(items))
}

async fn get_item(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Item>, (StatusCode, String)> {
    let item = queries::get_item_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Item not found".to_string()))?;
    Ok(Json(item))
}

async fn create_item(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateItem>,
) -> Result<(StatusCode, Json<Item>), (StatusCode, String)> {
    let item = queries::create_item(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(item)))
}

async fn update_item(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdateItem>,
) -> Result<Json<Item>, (StatusCode, String)> {
    let item = queries::update_item(&state.pool, id, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Item not found".to_string()))?;
    Ok(Json(item))
}

async fn delete_item(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_item(&state.pool, id, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Item not found".to_string()))
    }
}

async fn list_item_purchases(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<PurchaseEconomics>>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot retrieve item purchases: {} invoice(s) have missing tax rates. Please add tax_rate to these invoices.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let purchases = queries::get_purchases_by_item(&state.pool, id)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;
    Ok(Json(purchases))
}

async fn list_item_receipt_lines(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ItemReceiptLine>>, (StatusCode, String)> {
    let lines = queries::get_item_receipt_lines(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(lines))
}

/// Check for invoices that are locked but have NULL tax_rate
async fn check_missing_tax_rates(
    pool: &sqlx::PgPool,
) -> Result<Option<Vec<MissingTaxRate>>, sqlx::Error> {
    let missing: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id::text, invoice_number, reconciliation_state 
         FROM invoices 
         WHERE reconciliation_state IN ('locked', 'in_review', 'reconciled')
         AND tax_rate IS NULL 
         ORDER BY invoice_date DESC"
    )
    .fetch_all(pool)
    .await?;

    if missing.is_empty() {
        return Ok(None);
    }

    let missing_tax_rates = missing
        .into_iter()
        .map(|(id, number, state)| MissingTaxRate {
            message: format!("Invoice #{} ({}) is missing tax_rate. Click to edit and add the tax rate percentage.", &number, &state),
            invoice_id: id,
            invoice_number: number,
            reconciliation_state: state,
        })
        .collect();

    Ok(Some(missing_tax_rates))
}
