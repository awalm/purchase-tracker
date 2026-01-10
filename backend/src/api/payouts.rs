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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_payouts).post(create_payout))
        .route("/active", get(list_active_payouts))
        .route("/{id}", get(get_payout).put(update_payout).delete(delete_payout))
}

async fn list_payouts(
    State(state): State<AppState>,
    Query(query): Query<PayoutQuery>,
) -> Result<Json<Vec<Payout>>, (StatusCode, String)> {
    let payouts = queries::get_all_payouts(&state.pool, query)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payouts))
}

async fn list_active_payouts(
    State(state): State<AppState>,
) -> Result<Json<Vec<ActivePayout>>, (StatusCode, String)> {
    let payouts = queries::get_active_payouts(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payouts))
}

async fn get_payout(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Payout>, (StatusCode, String)> {
    let payout = queries::get_payout_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Payout not found".to_string()))?;
    Ok(Json(payout))
}

async fn create_payout(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreatePayout>,
) -> Result<(StatusCode, Json<Payout>), (StatusCode, String)> {
    let payout = queries::create_payout(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(payout)))
}

async fn update_payout(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdatePayout>,
) -> Result<Json<Payout>, (StatusCode, String)> {
    let payout = queries::update_payout(&state.pool, id, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Payout not found".to_string()))?;
    Ok(Json(payout))
}

async fn delete_payout(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_payout(&state.pool, id, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Payout not found".to_string()))
    }
}
