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
        .route("/", get(list_vendors).post(create_vendor))
        .route(
            "/{id}",
            get(get_vendor).put(update_vendor).delete(delete_vendor),
        )
}

async fn list_vendors(
    State(state): State<AppState>,
) -> Result<Json<Vec<Vendor>>, (StatusCode, String)> {
    let vendors = queries::get_all_vendors(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(vendors))
}

async fn get_vendor(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vendor>, (StatusCode, String)> {
    let vendor = queries::get_vendor_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Vendor not found".to_string()))?;
    Ok(Json(vendor))
}

async fn create_vendor(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateVendor>,
) -> Result<(StatusCode, Json<Vendor>), (StatusCode, String)> {
    let vendor = queries::create_vendor(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(vendor)))
}

async fn update_vendor(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdateVendor>,
) -> Result<Json<Vendor>, (StatusCode, String)> {
    let vendor = queries::update_vendor(&state.pool, id, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Vendor not found".to_string()))?;
    Ok(Json(vendor))
}

async fn delete_vendor(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_vendor(&state.pool, id, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Vendor not found".to_string()))
    }
}
