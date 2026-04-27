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
        .route("/unreconciled-items", get(get_unreconciled_items))
}

async fn get_summary(
    State(state): State<AppState>,
    Query(query): Query<DateRangeQuery>,
) -> Result<Json<queries::ProfitReport>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot calculate profit report: {} invoice(s) have missing tax rates. Please add tax_rate to these invoices.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let summary = queries::get_profit_report(&state.pool, query.from, query.to)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;

    // Validate that tax fields are not NULL
    if summary.total_tax_owed.is_none() || summary.total_tax_paid.is_none() {
        if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
            if !missing.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(TaxValidationError {
                        error: "Tax calculation returned NULL: one or more invoices missing tax_rate"
                            .to_string(),
                        missing_tax_rates: missing,
                    }),
                ));
            }
        }
    }

    Ok(Json(summary))
}

async fn get_by_destination(
    State(state): State<AppState>,
) -> Result<Json<Vec<DestinationSummary>>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot calculate destination summary: {} invoice(s) have missing tax rates. Please add tax_rate to these invoices.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let summaries = queries::get_destination_summary(&state.pool)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;
    Ok(Json(summaries))
}

async fn get_by_vendor(
    State(state): State<AppState>,
) -> Result<Json<Vec<VendorSummary>>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot calculate vendor summary: {} invoice(s) have missing tax rates. Please add tax_rate to these invoices.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let summaries = queries::get_vendor_summary(&state.pool)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;
    Ok(Json(summaries))
}

async fn get_unreconciled_items(
    State(state): State<AppState>,
    Query(query): Query<DateRangeQuery>,
) -> Result<Json<Vec<queries::UnreconciledReceiptItem>>, StatusCode> {
    let items = queries::get_unreconciled_receipt_items(&state.pool, query.from, query.to)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(items))
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
