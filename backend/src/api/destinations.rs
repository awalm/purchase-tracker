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
        .route("/", get(list_destinations).post(create_destination))
        .route("/active", get(list_active_destinations))
        .route(
            "/{id}",
            get(get_destination)
                .put(update_destination)
                .delete(delete_destination),
        )
}

async fn list_destinations(
    State(state): State<AppState>,
) -> Result<Json<Vec<Destination>>, (StatusCode, String)> {
    let destinations = queries::get_all_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(destinations))
}

async fn list_active_destinations(
    State(state): State<AppState>,
) -> Result<Json<Vec<Destination>>, (StatusCode, String)> {
    let destinations = queries::get_active_destinations(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(destinations))
}

async fn get_destination(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Destination>, (StatusCode, String)> {
    let destination = queries::get_destination_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Destination not found".to_string()))?;
    Ok(Json(destination))
}

async fn create_destination(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(data): Json<CreateDestination>,
) -> Result<(StatusCode, Json<Destination>), (StatusCode, String)> {
    let destination = queries::create_destination(&state.pool, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(destination)))
}

async fn update_destination(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(data): Json<UpdateDestination>,
) -> Result<Json<Destination>, (StatusCode, String)> {
    let destination = queries::update_destination(&state.pool, id, data, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Destination not found".to_string()))?;
    Ok(Json(destination))
}

async fn delete_destination(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_destination(&state.pool, id, user.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Destination not found".to_string()))
    }
}
