use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::NaiveDate;
use flate2::{write::GzEncoder, read::GzDecoder, Compression};
use std::io::{Read, Write};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{models::*, queries};
use crate::services::travel::{geocoder, matcher, parser, trips};

use super::AppState;

const TRAVEL_UPLOAD_MAX_BYTES: usize = 256 * 1024 * 1024; // 256 MB

pub fn router() -> Router<AppState> {
    Router::new()
        // Locations
        .route("/locations", get(list_locations).post(create_location))
        .route(
            "/locations/{id}",
            get(get_location).put(update_location).delete(delete_location),
        )
        .route("/locations/import", post(import_locations))
        .route("/locations/geocode", post(trigger_geocode))
        // Uploads
        .route("/uploads", get(list_uploads).post(upload_timeline))
        .route("/uploads/{id}", delete(delete_upload))
        .route("/uploads/{id}/reparse", post(reparse_upload))
        // Segments & Trips
        .route("/segments", get(get_segments))
        .route("/segments/{id}", patch(classify_segment))
        .route("/segments/{id}/link-receipt", post(link_receipt))
        .route("/segments/rematch", post(rematch_visits))
        // Trip Logs
        .route("/trip-logs", get(list_trip_logs).post(create_trip_log))
        .route("/trip-logs/receipt", post(create_receipt_trip_log))
        .route("/trip-logs/{id}", get(get_trip_log).patch(update_trip_log).delete(delete_trip_log))
        // Summary
        .route("/summary", get(get_summary))
        // Directions
        .route("/directions", get(get_directions))
        .layer(DefaultBodyLimit::max(TRAVEL_UPLOAD_MAX_BYTES))
}

#[derive(Debug, Deserialize)]
pub struct TravelDateRangeQuery {
    pub upload_id: Option<Uuid>,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

// ============================================
// Locations
// ============================================

async fn list_locations(
    State(state): State<AppState>,
) -> Result<Json<Vec<TravelLocation>>, (StatusCode, String)> {
    queries::get_all_travel_locations(&state.pool)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn get_location(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TravelLocation>, (StatusCode, String)> {
    queries::get_travel_location_by_id(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Location not found".to_string()))
}

async fn create_location(
    State(state): State<AppState>,
    Json(input): Json<CreateTravelLocation>,
) -> Result<(StatusCode, Json<TravelLocation>), (StatusCode, String)> {
    queries::create_travel_location(&state.pool, &input)
        .await
        .map(|loc| (StatusCode::CREATED, Json(loc)))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn update_location(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateTravelLocation>,
) -> Result<Json<TravelLocation>, (StatusCode, String)> {
    queries::update_travel_location(&state.pool, id, &input)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Location not found".to_string()))
}

async fn delete_location(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_travel_location(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Location not found".to_string()))
    }
}

#[derive(Serialize)]
struct BulkImportResult {
    imported: usize,
    skipped: usize,
}

async fn import_locations(
    State(state): State<AppState>,
    Json(input): Json<BulkImportLocationsRequest>,
) -> Result<Json<BulkImportResult>, (StatusCode, String)> {
    let (imported, skipped) = queries::bulk_import_travel_locations(&state.pool, &input.locations)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(BulkImportResult { imported, skipped }))
}

#[derive(Serialize)]
struct GeocodeResultResponse {
    provider: String,
    total: usize,
    success: usize,
    failed: usize,
    details: Vec<GeocodeDetailResponse>,
}

#[derive(Serialize)]
struct GeocodeDetailResponse {
    address: String,
    status: String,
    error: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
}

#[derive(Deserialize)]
struct GeocodeRequest {
    location_ids: Option<Vec<uuid::Uuid>>,
}

async fn trigger_geocode(
    State(state): State<AppState>,
    body: Option<Json<GeocodeRequest>>,
) -> Result<Json<GeocodeResultResponse>, (StatusCode, String)> {
    let ids = body.and_then(|b| b.0.location_ids);
    let result = geocoder::geocode_pending_locations(
        &state.pool,
        ids.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(GeocodeResultResponse {
        provider: result.provider,
        total: result.total,
        success: result.success,
        failed: result.failed,
        details: result.details.into_iter().map(|d| GeocodeDetailResponse {
            address: d.address,
            status: d.status,
            error: d.error,
            lat: d.lat,
            lng: d.lng,
        }).collect(),
    }))
}

// ============================================
// Uploads
// ============================================

async fn list_uploads(
    State(state): State<AppState>,
) -> Result<Json<Vec<TravelUpload>>, (StatusCode, String)> {
    queries::get_all_travel_uploads(&state.pool)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn upload_timeline(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TravelUpload>, (StatusCode, String)> {
    // Read the uploaded file
    let mut file_data: Option<Vec<u8>> = None;
    let mut filename = "timeline.json".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
    {
        if field.name() == Some("file") {
            filename = field
                .file_name()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "timeline.json".to_string());
            let data = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e)))?;
            file_data = Some(data.to_vec());
        }
    }

    let data = file_data.ok_or((StatusCode::BAD_REQUEST, "No file uploaded".to_string()))?;

    // Compress raw data for storage
    let compressed = compress_gzip(&data)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Compression failed: {}", e)))?;
    tracing::info!(
        "Timeline compressed: {} -> {} bytes ({:.0}%)",
        data.len(),
        compressed.len(),
        (compressed.len() as f64 / data.len() as f64) * 100.0
    );

    // Create upload record with compressed raw data
    let upload = queries::create_travel_upload(&state.pool, &filename, &compressed)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let pool = state.pool.clone();
    let upload_id = upload.id;

    match process_timeline(&pool, upload_id, &data).await {
        Ok((visits, activities, segments, date_start, date_end)) => {
            queries::update_travel_upload_status(
                &pool,
                upload_id,
                "completed",
                None,
                date_start,
                date_end,
                visits as i32,
                activities as i32,
                segments as i32,
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
        Err(err) => {
            // Processing failed — delete the upload entirely (no orphans)
            let _ = queries::delete_travel_upload(&pool, upload_id).await;
            return Err((StatusCode::UNPROCESSABLE_ENTITY, err));
        }
    }

    // Refetch to get updated status (without raw_data)
    let updated = queries::get_all_travel_uploads(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .find(|u| u.id == upload_id)
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Upload disappeared".to_string()))?;

    Ok(Json(updated))
}

async fn reparse_upload(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TravelUpload>, (StatusCode, String)> {
    // Get the compressed raw data
    let compressed = queries::get_travel_upload_raw_data(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Upload not found or has no stored data".to_string()))?;

    // Decompress
    let data = decompress_gzip(&compressed)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Decompression failed: {}", e)))?;

    // Clear existing visits/activities/segments
    queries::clear_travel_upload_data(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Re-process
    match process_timeline(&state.pool, id, &data).await {
        Ok((visits, activities, segments, date_start, date_end)) => {
            queries::update_travel_upload_status(
                &state.pool,
                id,
                "completed",
                None,
                date_start,
                date_end,
                visits as i32,
                activities as i32,
                segments as i32,
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
        Err(err) => {
            let _ = queries::update_travel_upload_status(
                &state.pool,
                id,
                "failed",
                Some(&err),
                None,
                None,
                0,
                0,
                0,
            )
            .await;
            return Err((StatusCode::UNPROCESSABLE_ENTITY, err));
        }
    }

    // Refetch
    let updated = queries::get_all_travel_uploads(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .find(|u| u.id == id)
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Upload disappeared".to_string()))?;

    Ok(Json(updated))
}

async fn process_timeline(
    pool: &sqlx::PgPool,
    upload_id: Uuid,
    data: &[u8],
) -> Result<(usize, usize, usize, Option<NaiveDate>, Option<NaiveDate>), String> {
    // 1. Parse timeline
    let parsed = parser::parse_timeline(data)?;

    // 2. Load locations for matching
    let locations = queries::get_all_travel_locations(pool)
        .await
        .map_err(|e| format!("Failed to load locations: {}", e))?;

    // 3. Insert visits with matching
    let mut db_visits = Vec::new();
    for visit in &parsed.visits {
        let matched = matcher::match_location(visit.latitude, visit.longitude, &locations, 250.0);
        let (loc_id, dist) = matched
            .map(|m| (Some(m.location_id), Some(m.distance_meters)))
            .unwrap_or((None, None));

        let db_visit = queries::insert_travel_visit(pool, upload_id, visit, loc_id, dist)
            .await
            .map_err(|e| format!("Failed to insert visit: {}", e))?;
        db_visits.push(db_visit);
    }

    // 4. Insert activities
    let mut db_activities = Vec::new();
    for activity in &parsed.activities {
        let db_activity = queries::insert_travel_activity(pool, upload_id, activity)
            .await
            .map_err(|e| format!("Failed to insert activity: {}", e))?;
        db_activities.push(db_activity);
    }

    // 5. Build trip segments
    let segment_drafts = trips::build_segments(&db_visits, &db_activities, &locations);

    // 6. Insert segments
    let mut segment_count = 0;
    for draft in &segment_drafts {
        queries::insert_travel_segment(pool, upload_id, draft)
            .await
            .map_err(|e| format!("Failed to insert segment: {}", e))?;
        segment_count += 1;
    }

    Ok((
        db_visits.len(),
        db_activities.len(),
        segment_count,
        parsed.date_range_start,
        parsed.date_range_end,
    ))
}

fn compress_gzip(data: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)?;
    encoder.finish()
}

fn decompress_gzip(data: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut decoder = GzDecoder::new(data);
    let mut result = Vec::new();
    decoder.read_to_end(&mut result)?;
    Ok(result)
}

async fn delete_upload(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_travel_upload(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Upload not found".to_string()))
    }
}

// ============================================
// Segments
// ============================================

async fn get_segments(
    State(state): State<AppState>,
    Query(query): Query<TravelDateRangeQuery>,
) -> Result<Json<Vec<TravelSegmentWithDetails>>, (StatusCode, String)> {
    if let Some(upload_id) = query.upload_id {
        queries::get_travel_segments(&state.pool, upload_id, query.from, query.to)
            .await
            .map(Json)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    } else if let Some(date) = query.from {
        queries::get_segments_for_date(&state.pool, date)
            .await
            .map(Json)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    } else {
        Err((StatusCode::BAD_REQUEST, "upload_id or from date is required".to_string()))
    }
}

async fn classify_segment(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateTravelSegment>,
) -> Result<Json<TravelSegment>, (StatusCode, String)> {
    queries::update_travel_segment(&state.pool, id, &input)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Segment not found".to_string()))
}

async fn link_receipt(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<LinkReceiptToSegment>,
) -> Result<Json<TravelSegment>, (StatusCode, String)> {
    queries::link_receipt_to_segment(&state.pool, id, input.receipt_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Segment not found".to_string()))
}

#[derive(Debug, Deserialize)]
struct RematchRequest {
    date: NaiveDate,
    radius_meters: f64,
}

/// Re-match all visits for a given date against locations with a new radius.
async fn rematch_visits(
    State(state): State<AppState>,
    Json(input): Json<RematchRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = &state.pool;

    // Load all non-excluded locations
    let locations = queries::get_all_travel_locations(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|l| !l.excluded && l.latitude.is_some() && l.longitude.is_some())
        .collect::<Vec<_>>();

    // Find all visits for this date via segments
    let visit_ids: Vec<Uuid> = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT DISTINCT tv.id FROM travel_visits tv
           JOIN travel_segments ts ON ts.visit_id = tv.id
           WHERE ts.trip_date = $1 AND ts.segment_type = 'visit'"#
    )
    .bind(input.date)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut matched_count = 0u32;
    let mut updated_count = 0u32;

    for vid in &visit_ids {
        let visit = sqlx::query_as::<_, TravelVisit>("SELECT * FROM travel_visits WHERE id = $1")
            .bind(vid)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let visit = match visit {
            Some(v) => v,
            None => continue,
        };

        let matched = matcher::match_location(visit.latitude, visit.longitude, &locations, input.radius_meters);
        let (new_loc_id, new_dist) = matched
            .map(|m| (Some(m.location_id), Some(m.distance_meters)))
            .unwrap_or((None, None));

        if new_loc_id != visit.matched_location_id {
            sqlx::query(
                "UPDATE travel_visits SET matched_location_id = $1, match_distance_meters = $2 WHERE id = $3"
            )
            .bind(new_loc_id)
            .bind(new_dist)
            .bind(vid)
            .execute(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            updated_count += 1;
        }
        if new_loc_id.is_some() {
            matched_count += 1;
        }
    }

    Ok(Json(serde_json::json!({
        "total_visits": visit_ids.len(),
        "matched": matched_count,
        "updated": updated_count,
        "radius_meters": input.radius_meters,
    })))
}

// ============================================
// Trip Logs
// ============================================

#[derive(Debug, Deserialize)]
struct TripLogQuery {
    upload_id: Option<Uuid>,
}

async fn list_trip_logs(
    State(state): State<AppState>,
    Query(query): Query<TripLogQuery>,
) -> Result<Json<Vec<TravelTripLog>>, (StatusCode, String)> {
    queries::list_trip_logs(&state.pool, query.upload_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn create_trip_log(
    State(state): State<AppState>,
    Json(input): Json<CreateTripLog>,
) -> Result<Json<TripLogWithSegments>, (StatusCode, String)> {
    let log = queries::create_trip_log(&state.pool, &input)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let segments = queries::get_segments_for_date(&state.pool, log.trip_date)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TripLogWithSegments { log, segments }))
}

async fn create_receipt_trip_log(
    State(state): State<AppState>,
    Json(input): Json<CreateReceiptTripLog>,
) -> Result<Json<TripLogWithSegments>, (StatusCode, String)> {
    let log = queries::create_receipt_trip_log(&state.pool, &input)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let segments = queries::get_segments_for_date(&state.pool, log.trip_date)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TripLogWithSegments { log, segments }))
}

async fn get_trip_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TripLogWithSegments>, (StatusCode, String)> {
    let log = queries::get_trip_log(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Trip log not found".to_string()))?;

    let segments = queries::get_segments_for_date(&state.pool, log.trip_date)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TripLogWithSegments { log, segments }))
}

async fn update_trip_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateTripLog>,
) -> Result<Json<TravelTripLog>, (StatusCode, String)> {
    // If confirming, refresh km totals first
    if input.status.as_deref() == Some("confirmed") {
        if let Some(log) = queries::get_trip_log(&state.pool, id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        {
            let _ = queries::refresh_trip_log_km(&state.pool, &log).await;
        }
    }

    queries::update_trip_log(&state.pool, id, &input)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Trip log not found".to_string()))
}

async fn delete_trip_log(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let deleted = queries::delete_trip_log(&state.pool, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Trip log not found".to_string()))
    }
}

// ============================================
// Summary
// ============================================

async fn get_summary(
    State(state): State<AppState>,
    Query(query): Query<TravelDateRangeQuery>,
) -> Result<Json<TravelSummary>, (StatusCode, String)> {
    let upload_id = query
        .upload_id
        .ok_or((StatusCode::BAD_REQUEST, "upload_id is required".to_string()))?;

    queries::get_travel_summary(&state.pool, upload_id, query.from, query.to)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// --- Directions ---

#[derive(Debug, Deserialize)]
pub struct DirectionsQuery {
    pub from_lat: f64,
    pub from_lng: f64,
    pub to_lat: f64,
    pub to_lng: f64,
    /// Optional waypoints as "lat,lng|lat,lng|..." for more accurate routing
    pub waypoints: Option<String>,
}

async fn get_directions(
    Query(query): Query<DirectionsQuery>,
) -> Result<Json<geocoder::DirectionsResult>, (StatusCode, String)> {
    let waypoints: Vec<[f64; 2]> = query.waypoints
        .as_deref()
        .unwrap_or("")
        .split('|')
        .filter(|s| !s.is_empty())
        .filter_map(|s| {
            let parts: Vec<&str> = s.split(',').collect();
            if parts.len() == 2 {
                Some([parts[0].parse::<f64>().ok()?, parts[1].parse::<f64>().ok()?])
            } else {
                None
            }
        })
        .collect();

    geocoder::get_directions(query.from_lat, query.from_lng, query.to_lat, query.to_lng, &waypoints)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
