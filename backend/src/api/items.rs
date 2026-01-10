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
        .route("/", get(list_items).post(create_item))
        .route("/active", get(list_active_items))
        .route("/{id}", get(get_item).put(update_item).delete(delete_item))
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
