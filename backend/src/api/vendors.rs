use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    db::{models::*, queries},
};

use super::AppState;

#[derive(Debug, Deserialize)]
struct UpsertVendorImportAliasRequest {
    raw_alias: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_vendors).post(create_vendor))
        .route(
            "/{id}",
            get(get_vendor).put(update_vendor).delete(delete_vendor),
        )
        .route(
            "/{id}/import-aliases",
            get(list_vendor_import_aliases).post(upsert_vendor_import_alias),
        )
        .route(
            "/{id}/import-aliases/{alias_id}",
            delete(delete_vendor_import_alias),
        )
        .route(
            "/{id}/apply-default-location",
            post(apply_default_location),
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

async fn list_vendor_import_aliases(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<VendorImportAlias>>, (StatusCode, String)> {
    let vendor_exists = queries::get_vendor_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_some();

    if !vendor_exists {
        return Err((StatusCode::NOT_FOUND, "Vendor not found".to_string()));
    }

    let aliases = queries::get_vendor_import_aliases_by_vendor(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(aliases))
}

async fn upsert_vendor_import_alias(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpsertVendorImportAliasRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let vendor_exists = queries::get_vendor_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_some();

    if !vendor_exists {
        return Err((StatusCode::NOT_FOUND, "Vendor not found".to_string()));
    }

    if payload.raw_alias.trim().is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "raw_alias is required".to_string(),
        ));
    }

    queries::upsert_vendor_import_alias(&state.pool, &payload.raw_alias, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_vendor_import_alias(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path((id, alias_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_vendor_import_alias(&state.pool, id, alias_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Alias not found".to_string()))
    }
}

/// Apply vendor's default_location_id to all receipts for this vendor that don't have a store_location_id.
/// Returns the count of updated receipts.
async fn apply_default_location(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let vendor = queries::get_vendor_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Vendor not found".to_string()))?;

    let location_id = vendor.default_location_id.ok_or((
        StatusCode::UNPROCESSABLE_ENTITY,
        "Vendor has no default location set".to_string(),
    ))?;

    let result = sqlx::query!(
        r#"UPDATE receipts SET store_location_id = $1
           WHERE vendor_id = $2 AND store_location_id IS NULL"#,
        location_id,
        id
    )
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "updated": result.rows_affected()
    })))
}
