use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch},
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
        .route("/{id}", get(get_purchase).put(update_purchase).delete(delete_purchase))
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Purchase not found".to_string()))
    }
}
