use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use chrono::NaiveDate;
use serde::Deserialize;

use crate::db::{models::*, queries};

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct DateRangeQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/summary", get(get_summary))
        .route("/destinations", get(get_by_destination))
        .route("/vendors", get(get_by_vendor))
}

async fn get_summary(
    State(state): State<AppState>,
    Query(query): Query<DateRangeQuery>,
) -> Result<Json<queries::ProfitReport>, (StatusCode, String)> {
    let summary = queries::get_profit_report(&state.pool, query.from, query.to)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(summary))
}

async fn get_by_destination(
    State(state): State<AppState>,
) -> Result<Json<Vec<DestinationSummary>>, (StatusCode, String)> {
    let summaries = queries::get_destination_summary(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(summaries))
}

async fn get_by_vendor(
    State(state): State<AppState>,
) -> Result<Json<Vec<VendorSummary>>, (StatusCode, String)> {
    let summaries = queries::get_vendor_summary(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(summaries))
}
