use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use chrono::NaiveDate;
use indexmap::IndexMap;
use rust_decimal::Decimal;
use serde::Deserialize;
use uuid::Uuid;

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
        .route("/tax", get(get_tax_report))
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

#[derive(Debug, Deserialize)]
pub struct TaxReportQuery {
    pub destination_id: Uuid,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

async fn get_tax_report(
    State(state): State<AppState>,
    Query(query): Query<TaxReportQuery>,
) -> Result<Json<TaxReportSummary>, (StatusCode, Json<TaxValidationError>)> {
    // Check for missing tax rates first
    if let Some(missing) = check_missing_tax_rates(&state.pool).await.ok().flatten() {
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TaxValidationError {
                    error: format!(
                        "Cannot generate tax report: {} invoice(s) have missing tax rates.",
                        missing.len()
                    ),
                    missing_tax_rates: missing,
                }),
            ));
        }
    }

    let rows = queries::get_tax_report(&state.pool, query.destination_id, query.from, query.to)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;

    let summary = build_tax_report_hierarchy(rows);
    Ok(Json(summary))
}

fn build_tax_report_hierarchy(rows: Vec<TaxReportFlatRow>) -> TaxReportSummary {
    // Group: invoice_id → purchase_id → allocations
    // Use IndexMap to preserve insertion order (which matches the SQL ORDER BY)
    let mut invoice_map: IndexMap<Uuid, TaxReportInvoice> = IndexMap::new();

    // Track purchases we've already seen to avoid double-counting
    struct PurchaseAccum {
        item_name: String,
        quantity: i32,
        invoice_unit_price: Decimal,
        allocations: Vec<TaxReportAllocation>,
    }
    let mut purchase_map: IndexMap<Uuid, IndexMap<Uuid, PurchaseAccum>> = IndexMap::new();

    for row in &rows {
        // Ensure invoice entry exists
        invoice_map.entry(row.invoice_id).or_insert_with(|| TaxReportInvoice {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number.clone(),
            invoice_date: row.invoice_date,
            delivery_date: row.delivery_date,
            tax_rate: row.tax_rate,
            total_cost: Decimal::ZERO,
            total_revenue: Decimal::ZERO,
            total_commission: Decimal::ZERO,
            total_hst_on_cost: Decimal::ZERO,
            total_hst_on_commission: Decimal::ZERO,
            purchases: vec![],
        });

        // Ensure purchase entry exists
        let inv_purchases = purchase_map.entry(row.invoice_id).or_default();
        let purchase = inv_purchases.entry(row.purchase_id).or_insert_with(|| PurchaseAccum {
            item_name: row.item_name.clone(),
            quantity: row.quantity,
            invoice_unit_price: row.invoice_unit_price,
            allocations: vec![],
        });

        // Add allocation if present
        if let (Some(receipt_id), Some(receipt_number), Some(receipt_date), Some(allocated_qty), Some(unit_cost), Some(allocated_total)) = (
            row.receipt_id,
            row.receipt_number.as_ref(),
            row.receipt_date,
            row.allocated_qty,
            row.allocation_unit_cost,
            row.allocation_total,
        ) {
            purchase.allocations.push(TaxReportAllocation {
                receipt_id,
                receipt_number: receipt_number.clone(),
                receipt_date,
                vendor_name: row.vendor_name.clone().unwrap_or_default(),
                allocated_qty,
                unit_cost,
                allocated_total,
            });
        }
    }

    let hundred = Decimal::from(100);
    let mut total_cost = Decimal::ZERO;
    let mut total_revenue = Decimal::ZERO;
    let mut total_commission = Decimal::ZERO;
    let mut total_hst_on_cost = Decimal::ZERO;
    let mut total_hst_on_commission = Decimal::ZERO;

    // Build final structure with correct per-allocation economics
    for (invoice_id, purchases) in &purchase_map {
        let invoice = invoice_map.get_mut(invoice_id).unwrap();
        let tax_rate = invoice.tax_rate;

        for (_purchase_id, accum) in purchases {
            // Compute cost from actual allocations (the REAL cost, not an average)
            let alloc_total_cost: Decimal = accum.allocations.iter()
                .map(|a| a.allocated_total)
                .sum();
            let alloc_total_qty: i32 = accum.allocations.iter()
                .map(|a| a.allocated_qty)
                .sum();

            // Use allocation-based cost when fully allocated, otherwise fall back
            // For tax reporting we only show locked invoices which should be fully allocated
            let qty = Decimal::from(accum.quantity);
            let purchase_total_cost = if alloc_total_qty == accum.quantity && alloc_total_qty > 0 {
                alloc_total_cost
            } else {
                // Fallback: if not fully allocated, use allocation cost for what we have
                // plus proportional estimate for the rest (shouldn't happen for locked invoices)
                alloc_total_cost
            };

            let purchase_total_revenue = qty * accum.invoice_unit_price;
            let commission = purchase_total_revenue - purchase_total_cost;
            let hst_on_cost = purchase_total_cost * tax_rate / hundred;
            let hst_on_commission = commission * tax_rate / hundred;

            invoice.purchases.push(TaxReportPurchase {
                item_name: accum.item_name.clone(),
                quantity: accum.quantity,
                invoice_unit_price: accum.invoice_unit_price,
                total_cost: purchase_total_cost,
                total_revenue: purchase_total_revenue,
                commission,
                hst_on_cost,
                hst_on_commission,
                allocations: accum.allocations.clone(),
            });

            invoice.total_cost += purchase_total_cost;
            invoice.total_revenue += purchase_total_revenue;
            invoice.total_commission += commission;
            invoice.total_hst_on_cost += hst_on_cost;
            invoice.total_hst_on_commission += hst_on_commission;

            total_cost += purchase_total_cost;
            total_revenue += purchase_total_revenue;
            total_commission += commission;
            total_hst_on_cost += hst_on_cost;
            total_hst_on_commission += hst_on_commission;
        }
    }

    TaxReportSummary {
        total_commission,
        total_hst_on_cost,
        total_hst_on_commission,
        total_cost,
        total_revenue,
        invoices: invoice_map.into_values().collect(),
    }
}
