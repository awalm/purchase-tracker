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
        .route("/integrity", get(get_integrity_check))
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

    let lost_rows = queries::get_lost_items_for_tax_report(&state.pool, query.from, query.to)
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TaxValidationError {
                error: format!("Database error: {}", e),
                missing_tax_rates: vec![],
            }),
        ))?;

    let summary = build_tax_report_hierarchy(rows, lost_rows);
    Ok(Json(summary))
}

fn build_tax_report_hierarchy(rows: Vec<TaxReportFlatRow>, lost_rows: Vec<queries::LostItemRow>) -> TaxReportSummary {
    // Group: invoice_id → purchase_id → allocations
    // Use IndexMap to preserve insertion order (which matches the SQL ORDER BY)
    let mut invoice_map: IndexMap<Uuid, TaxReportInvoice> = IndexMap::new();

    struct PurchaseAccum {
        item_name: String,
        quantity: i32,
        invoice_unit_price: Decimal,
        purchase_type: String,
        bonus_for_purchase_id: Option<Uuid>,
        allocations: Vec<TaxReportAllocation>,
    }
    // Flat map: purchase_id → (invoice_id, accum)
    let mut purchase_map: IndexMap<Uuid, (Uuid, PurchaseAccum)> = IndexMap::new();

    for row in &rows {
        // Ensure invoice entry exists
        invoice_map.entry(row.invoice_id).or_insert_with(|| TaxReportInvoice {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number.clone(),
            invoice_date: row.invoice_date,
            delivery_date: row.delivery_date,
            tax_rate: row.tax_rate,
            hst_charged: row.invoice_tax_amount.unwrap_or(Decimal::ZERO),
            total_cost: Decimal::ZERO,
            total_revenue: Decimal::ZERO,
            total_commission: Decimal::ZERO,
            total_hst_on_cost: Decimal::ZERO,
            total_hst_on_commission: Decimal::ZERO,
            purchases: vec![],
        });

        // Ensure purchase entry exists
        let (_, accum) = purchase_map.entry(row.purchase_id).or_insert_with(|| (row.invoice_id, PurchaseAccum {
            item_name: row.item_name.clone(),
            quantity: row.quantity,
            invoice_unit_price: row.invoice_unit_price,
            purchase_type: row.purchase_type.clone(),
            bonus_for_purchase_id: row.bonus_for_purchase_id,
            allocations: vec![],
        }));

        // Add allocation if present
        if let (Some(receipt_id), Some(receipt_number), Some(receipt_date), Some(allocated_qty), Some(unit_cost), Some(allocated_total)) = (
            row.receipt_id,
            row.receipt_number.as_ref(),
            row.receipt_date,
            row.allocated_qty,
            row.allocation_unit_cost,
            row.allocation_total,
        ) {
            accum.allocations.push(TaxReportAllocation {
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

    // Compute bonus revenue per parent purchase.
    // bonus_revenue_for[parent_purchase_id] = sum of (bonus_qty * bonus_unit_price)
    let mut bonus_revenue_for: std::collections::HashMap<Uuid, Decimal> = std::collections::HashMap::new();
    let bonus_purchase_ids: Vec<Uuid> = purchase_map.iter()
        .filter(|(_, (_, a))| a.purchase_type == "bonus")
        .map(|(id, _)| *id)
        .collect();

    for bonus_id in &bonus_purchase_ids {
        if let Some((_, accum)) = purchase_map.get(bonus_id) {
            if let Some(parent_id) = accum.bonus_for_purchase_id {
                let revenue = Decimal::from(accum.quantity) * accum.invoice_unit_price;
                *bonus_revenue_for.entry(parent_id).or_insert(Decimal::ZERO) += revenue;
            }
        }
    }

    // Remove bonus purchases from the map — they're merged into parents
    for bonus_id in &bonus_purchase_ids {
        purchase_map.shift_remove(bonus_id);
    }

    let hundred = Decimal::from(100);
    let mut total_cost = Decimal::ZERO;
    let mut total_revenue = Decimal::ZERO;
    let mut total_commission = Decimal::ZERO;
    let mut total_hst_on_cost = Decimal::ZERO;
    let mut total_hst_on_commission = Decimal::ZERO;
    let mut total_hst_charged = Decimal::ZERO;

    // Group purchases back by invoice for output
    let mut invoice_purchases: IndexMap<Uuid, Vec<TaxReportPurchase>> = IndexMap::new();

    for (purchase_id, (invoice_id, accum)) in &purchase_map {
        let tax_rate = invoice_map.get(invoice_id).map(|i| i.tax_rate).unwrap_or(Decimal::ZERO);

        let alloc_total_cost: Decimal = accum.allocations.iter()
            .map(|a| a.allocated_total)
            .sum();

        let qty = Decimal::from(accum.quantity);

        // Refunds: negate allocation cost so everything reverses
        let purchase_total_cost = if accum.purchase_type == "refund" {
            -alloc_total_cost
        } else {
            alloc_total_cost
        };

        let bonus_rev = bonus_revenue_for.get(purchase_id).copied().unwrap_or(Decimal::ZERO);
        let purchase_total_revenue = qty * accum.invoice_unit_price;
        // Commission includes bonus revenue (bonus has zero cost, so it's pure profit)
        let commission = purchase_total_revenue + bonus_rev - purchase_total_cost;
        let hst_on_cost = purchase_total_cost * tax_rate / hundred;
        let hst_on_commission = commission * tax_rate / hundred;

        let purchase = TaxReportPurchase {
            item_name: accum.item_name.clone(),
            quantity: accum.quantity,
            invoice_unit_price: accum.invoice_unit_price,
            purchase_type: accum.purchase_type.clone(),
            total_cost: purchase_total_cost,
            total_revenue: purchase_total_revenue,
            commission,
            bonus_revenue: bonus_rev,
            hst_on_cost,
            hst_on_commission,
            allocations: accum.allocations.clone(),
        };

        let inv = invoice_map.get_mut(invoice_id).unwrap();
        inv.total_cost += purchase_total_cost;
        inv.total_revenue += purchase_total_revenue + bonus_rev;
        inv.total_commission += commission;
        inv.total_hst_on_cost += hst_on_cost;
        inv.total_hst_on_commission += hst_on_commission;

        total_cost += purchase_total_cost;
        total_revenue += purchase_total_revenue + bonus_rev;
        total_commission += commission;
        total_hst_on_cost += hst_on_cost;
        total_hst_on_commission += hst_on_commission;

        invoice_purchases.entry(*invoice_id).or_default().push(purchase);
    }

    // Attach purchases to invoices
    for (invoice_id, purchases) in invoice_purchases {
        if let Some(inv) = invoice_map.get_mut(&invoice_id) {
            inv.purchases = purchases;
        }
    }

    // Sum HST charged across all invoices
    for inv in invoice_map.values() {
        total_hst_charged += inv.hst_charged;
    }

    // Build lost items list and sum costs
    let mut lost_items_cost = Decimal::ZERO;
    let mut lost_items_tax = Decimal::ZERO;
    let lost_items: Vec<TaxReportLostItem> = lost_rows.into_iter().map(|r| {
        lost_items_cost += r.line_total;
        lost_items_tax += r.tax_amount;
        TaxReportLostItem {
            receipt_id: r.receipt_id,
            receipt_number: r.receipt_number,
            receipt_date: r.receipt_date,
            vendor_name: r.vendor_name,
            item_name: r.item_name,
            quantity: r.quantity,
            unit_cost: r.unit_cost,
            line_total: r.line_total,
            tax_amount: r.tax_amount,
        }
    }).collect();

    // Lost items add to total cost (write-off) and HST paid
    total_cost += lost_items_cost;
    total_hst_on_cost += lost_items_tax;

    TaxReportSummary {
        total_commission,
        total_hst_on_cost,
        total_hst_on_commission,
        total_hst_charged,
        total_cost,
        total_revenue,
        lost_items_cost,
        lost_items_tax,
        lost_items,
        invoices: invoice_map.into_values().collect(),
    }
}

#[derive(Debug, serde::Serialize)]
struct IntegrityReport {
    allocation_item_mismatches: Vec<queries::AllocationItemMismatch>,
    ok: bool,
}

async fn get_integrity_check(
    State(state): State<AppState>,
) -> Result<Json<IntegrityReport>, (StatusCode, String)> {
    let mismatches = queries::check_allocation_item_integrity(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let ok = mismatches.is_empty();
    Ok(Json(IntegrityReport {
        allocation_item_mismatches: mismatches,
        ok,
    }))
}
