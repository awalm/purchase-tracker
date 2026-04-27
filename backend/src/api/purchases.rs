use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
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
        .route("/", get(list_purchases).post(create_purchase))
        .route("/economics", get(list_economics))
        .route(
            "/{id}",
            get(get_purchase)
                .put(update_purchase)
                .delete(delete_purchase),
        )
        .route(
            "/{id}/allocations",
            get(list_allocations).post(create_allocation),
        )
        .route("/{id}/allocations/auto", post(auto_allocate))
        .route("/{id}/split", post(split_purchase))
        .route("/{id}/distribute-preview", get(distribute_preview))
        .route("/{id}/distribute", post(distribute_bonus))
        .route(
            "/{id}/allocations/{allocation_id}",
            axum::routing::put(update_allocation).delete(delete_allocation),
        )
        .route("/{id}/status", patch(update_status))
}

async fn list_purchases(
    State(state): State<AppState>,
    Query(query): Query<PurchaseQuery>,
) -> Result<Json<Vec<Purchase>>, (StatusCode, String)> {
    let purchases = queries::get_all_purchases(&state.pool, query)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(purchases))
}

async fn list_economics(
    State(state): State<AppState>,
    Query(query): Query<PurchaseQuery>,
) -> Result<Json<Vec<PurchaseEconomics>>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot calculate purchase economics: {} invoice(s) have missing tax rates. Please add tax_rate to these invoices.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let economics = queries::get_purchase_economics(&state.pool, query)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;
    Ok(Json(economics))
}

async fn get_purchase(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Purchase>, (StatusCode, String)> {
    let purchase = queries::get_purchase_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Purchase not found".to_string()))?;
    Ok(Json(purchase))
}

async fn create_purchase(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreatePurchase>,
) -> Result<(StatusCode, Json<Purchase>), (StatusCode, String)> {
    let purchase = queries::create_purchase(&state.pool, data, user.user_id)
        .await
        .map_err(map_purchase_write_error)?;
    Ok((StatusCode::CREATED, Json(purchase)))
}

async fn update_purchase(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdatePurchase>,
) -> Result<Json<Purchase>, (StatusCode, String)> {
    let purchase = queries::update_purchase(&state.pool, id, data, user.user_id)
        .await
        .map_err(map_purchase_write_error)?
        .ok_or((StatusCode::NOT_FOUND, "Purchase not found".to_string()))?;
    Ok(Json(purchase))
}

async fn update_status(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<StatusUpdate>,
) -> Result<Json<Purchase>, (StatusCode, String)> {
    let purchase = queries::update_purchase_status(&state.pool, id, data.status, user.user_id)
        .await
        .map_err(map_purchase_write_error)?
        .ok_or((StatusCode::NOT_FOUND, "Purchase not found".to_string()))?;
    Ok(Json(purchase))
}

async fn delete_purchase(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_purchase(&state.pool, id, user.user_id)
        .await
        .map_err(map_purchase_write_error)?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Purchase not found".to_string()))
    }
}

async fn list_allocations(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<PurchaseAllocationWithReceipt>>, (StatusCode, String)> {
    let allocations = queries::get_purchase_allocations(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(allocations))
}

async fn create_allocation(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<CreatePurchaseAllocation>,
) -> Result<(StatusCode, Json<PurchaseAllocationWithReceipt>), (StatusCode, String)> {
    let allocation = queries::create_purchase_allocation(&state.pool, id, data)
        .await
        .map_err(map_allocation_error)?;
    Ok((StatusCode::CREATED, Json(allocation)))
}

async fn update_allocation(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path((id, allocation_id)): Path<(Uuid, Uuid)>,
    Json(data): Json<UpdatePurchaseAllocation>,
) -> Result<Json<PurchaseAllocationWithReceipt>, (StatusCode, String)> {
    let allocation = queries::update_purchase_allocation(&state.pool, id, allocation_id, data)
        .await
        .map_err(map_allocation_error)?;
    Ok(Json(allocation))
}

async fn delete_allocation(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path((id, allocation_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_purchase_allocation(&state.pool, id, allocation_id)
        .await
        .map_err(map_purchase_write_error)?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Allocation not found".to_string()))
    }
}

async fn auto_allocate(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    payload: Option<Json<AutoAllocatePurchaseRequest>>,
) -> Result<Json<AutoAllocatePurchaseResult>, (StatusCode, String)> {
    let request = payload.map(|Json(data)| data).unwrap_or_default();

    let result = queries::auto_allocate_purchase(
        &state.pool,
        id,
        request.allow_receipt_date_override,
    )
        .await
        .map_err(map_allocation_error)?;
    Ok(Json(result))
}

async fn split_purchase(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<SplitPurchaseRequest>,
) -> Result<Json<SplitPurchaseResult>, (StatusCode, String)> {
    let result = queries::split_purchase(&state.pool, id, data, user.user_id)
        .await
        .map_err(map_purchase_write_error)?;
    Ok(Json(result))
}

async fn distribute_preview(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<DistributeBonusPreviewResult>, (StatusCode, String)> {
    let result = queries::distribute_bonus_preview(&state.pool, id)
        .await
        .map_err(map_purchase_write_error)?;
    Ok(Json(result))
}

async fn distribute_bonus(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<DistributeBonusRequest>,
) -> Result<Json<DistributeBonusResult>, (StatusCode, String)> {
    let result = queries::distribute_bonus(&state.pool, id, data, user.user_id)
        .await
        .map_err(map_purchase_write_error)?;
    Ok(Json(result))
}

fn map_allocation_error(err: queries::PurchaseAllocationError) -> (StatusCode, String) {
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

fn map_purchase_write_error(err: sqlx::Error) -> (StatusCode, String) {
    if let Some(msg) = queries::locked_invoice_error_message(&err) {
        return (StatusCode::UNPROCESSABLE_ENTITY, msg);
    }

    if let Some(msg) = queries::purchase_link_required_error_message(&err) {
        return (StatusCode::UNPROCESSABLE_ENTITY, msg);
    }

    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
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
