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
) -> Result<Json<Vec<PurchaseEconomics>>, (StatusCode, String)> {
    let economics = queries::get_purchase_economics(&state.pool, query)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
