use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use super::models::*;
use crate::services::audit::AuditService;

#[derive(Debug, Clone)]
pub struct AtomicInvoicePdfLine {
    pub line_index: usize,
    pub item_id: Uuid,
    pub qty: i32,
    pub invoice_unit_price: Decimal,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct AtomicInvoicePdfCreateInput {
    pub destination_id: Uuid,
    pub invoice_number: String,
    pub invoice_date: NaiveDate,
    pub subtotal: Decimal,
    pub tax_rate: Option<Decimal>,
    pub notes: Option<String>,
    pub pdf_data: Vec<u8>,
    pub pdf_filename: String,
    pub lines: Vec<AtomicInvoicePdfLine>,
}

#[derive(Debug, Clone)]
pub struct AtomicInvoicePdfCreateResult {
    pub invoice: Invoice,
    pub purchase_count: usize,
}

#[derive(Debug)]
pub enum AtomicInvoicePdfCreateError {
    Sql(sqlx::Error),
    PurchaseInsert {
        line_index: usize,
        description: String,
        source: sqlx::Error,
    },
}

impl From<sqlx::Error> for AtomicInvoicePdfCreateError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sql(value)
    }
}

#[derive(Debug)]
pub enum PurchaseAllocationError {
    Sql(sqlx::Error),
    NotFound(String),
    Validation(String),
}

impl From<sqlx::Error> for PurchaseAllocationError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sql(value)
    }
}

#[derive(Debug)]
pub enum ReceiptReconciliationError {
    Sql(sqlx::Error),
    Validation(String),
}

impl From<sqlx::Error> for ReceiptReconciliationError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sql(value)
    }
}

const UNLINK_PURCHASES_FOR_DESTINATION_INVOICES_SQL: &str = r#"UPDATE purchases
       SET invoice_id = NULL,
           invoice_unit_price = NULL
       WHERE invoice_id IN (
         SELECT id FROM invoices WHERE destination_id = $1
       )"#;

const UNLINK_PURCHASES_FOR_INVOICE_SQL: &str = r#"UPDATE purchases
       SET invoice_id = NULL,
           invoice_unit_price = NULL
       WHERE invoice_id = $1"#;

const DELETE_ALLOCATIONS_FOR_INVOICE_PURCHASES_SQL: &str = r#"DELETE FROM purchase_allocations pa
             USING purchases p
             WHERE pa.purchase_id = p.id
                 AND p.invoice_id = $1"#;

const DELETE_ORPHAN_PURCHASES_SQL: &str = r#"DELETE FROM purchases p
       WHERE p.invoice_id IS NULL
         AND p.receipt_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM purchase_allocations pa WHERE pa.purchase_id = p.id
         )"#;

const LOCKED_INVOICE_ERROR_PREFIX: &str = "LOCKED_INVOICE:";
const PURCHASE_LINK_REQUIRED_ERROR_PREFIX: &str = "PURCHASE_LINK_REQUIRED:";

fn locked_invoice_error(message: &str) -> sqlx::Error {
    sqlx::Error::Protocol(format!("{}{}", LOCKED_INVOICE_ERROR_PREFIX, message))
}

fn purchase_link_required_error(message: &str) -> sqlx::Error {
    sqlx::Error::Protocol(format!(
        "{}{}",
        PURCHASE_LINK_REQUIRED_ERROR_PREFIX, message
    ))
}

pub fn locked_invoice_error_message(err: &sqlx::Error) -> Option<String> {
    match err {
        sqlx::Error::Protocol(msg) => msg
            .strip_prefix(LOCKED_INVOICE_ERROR_PREFIX)
            .map(str::to_string),
        _ => None,
    }
}

pub fn purchase_link_required_error_message(err: &sqlx::Error) -> Option<String> {
    match err {
        sqlx::Error::Protocol(msg) => msg
            .strip_prefix(PURCHASE_LINK_REQUIRED_ERROR_PREFIX)
            .map(str::to_string),
        _ => None,
    }
}

async fn delete_orphan_purchases(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(DELETE_ORPHAN_PURCHASES_SQL)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

async fn purchase_has_allocation_links(
    pool: &PgPool,
    purchase_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(
               SELECT 1
               FROM purchase_allocations
               WHERE purchase_id = $1
           ) AS "exists!""#,
        purchase_id
    )
    .fetch_one(pool)
    .await
}

async fn invoice_is_locked(pool: &PgPool, invoice_id: Uuid) -> Result<bool, sqlx::Error> {
    let is_locked = sqlx::query_scalar!(
        r#"SELECT (reconciliation_state = 'locked') AS "is_locked!"
           FROM invoices
           WHERE id = $1"#,
        invoice_id
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(false);

    Ok(is_locked)
}

async fn purchase_is_linked_to_locked_invoice(
    pool: &PgPool,
    purchase_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(
               SELECT 1
               FROM purchases p
               JOIN invoices inv ON inv.id = p.invoice_id
               WHERE p.id = $1
                 AND inv.reconciliation_state = 'locked'
           ) AS "exists!""#,
        purchase_id
    )
    .fetch_one(pool)
    .await
}

async fn receipt_has_locked_invoice_dependencies(
    pool: &PgPool,
    receipt_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(
               SELECT 1
               FROM purchases p
               JOIN invoices inv ON inv.id = p.invoice_id
               WHERE inv.reconciliation_state = 'locked'
                 AND (
                     p.receipt_id = $1
                     OR EXISTS (
                         SELECT 1
                         FROM purchase_allocations pa
                         WHERE pa.purchase_id = p.id
                           AND pa.receipt_id = $1
                     )
                 )
           ) AS "exists!""#,
        receipt_id
    )
    .fetch_one(pool)
    .await
}

async fn ensure_invoice_not_locked(
    pool: &PgPool,
    invoice_id: Uuid,
    message: &str,
) -> Result<(), sqlx::Error> {
    if invoice_is_locked(pool, invoice_id).await? {
        return Err(locked_invoice_error(message));
    }
    Ok(())
}

async fn ensure_purchase_not_linked_to_locked_invoice(
    pool: &PgPool,
    purchase_id: Uuid,
    message: &str,
) -> Result<(), sqlx::Error> {
    if purchase_is_linked_to_locked_invoice(pool, purchase_id).await? {
        return Err(locked_invoice_error(message));
    }
    Ok(())
}

async fn ensure_receipt_not_linked_to_locked_invoice(
    pool: &PgPool,
    receipt_id: Uuid,
    message: &str,
) -> Result<(), sqlx::Error> {
    if receipt_has_locked_invoice_dependencies(pool, receipt_id).await? {
        return Err(locked_invoice_error(message));
    }
    Ok(())
}

async fn ensure_purchase_not_linked_to_locked_invoice_for_allocation(
    pool: &PgPool,
    purchase_id: Uuid,
    message: &str,
) -> Result<(), PurchaseAllocationError> {
    if purchase_is_linked_to_locked_invoice(pool, purchase_id)
        .await
        .map_err(PurchaseAllocationError::Sql)?
    {
        return Err(PurchaseAllocationError::Validation(message.to_string()));
    }
    Ok(())
}

async fn ensure_receipt_not_linked_to_locked_invoice_for_line_item(
    pool: &PgPool,
    receipt_id: Uuid,
    message: &str,
) -> Result<(), PurchaseAllocationError> {
    if receipt_has_locked_invoice_dependencies(pool, receipt_id)
        .await
        .map_err(PurchaseAllocationError::Sql)?
    {
        return Err(PurchaseAllocationError::Validation(message.to_string()));
    }
    Ok(())
}

fn validate_receipt_date_for_invoice(
    invoice_date: Option<NaiveDate>,
    receipt_date: NaiveDate,
    allow_receipt_date_override: bool,
) -> Result<(), PurchaseAllocationError> {
    if let Some(invoice_date) = invoice_date {
        if receipt_date > invoice_date && !allow_receipt_date_override {
            return Err(PurchaseAllocationError::Validation(format!(
                "Receipt date {} is after invoice date {}. Enable receipt date override to proceed.",
                receipt_date.format("%Y-%m-%d"),
                invoice_date.format("%Y-%m-%d")
            )));
        }
    }

    Ok(())
}

fn no_eligible_receipts_before_invoice_warning(invoice_date: NaiveDate) -> String {
    format!(
        "No receipts on or before invoice date {} are available for allocation.",
        invoice_date.format("%Y-%m-%d")
    )
}

// ============================================
// Vendors
// ============================================

pub async fn get_all_vendors(pool: &PgPool) -> Result<Vec<Vendor>, sqlx::Error> {
    sqlx::query_as!(
        Vendor,
        r#"SELECT id, name, short_id, created_at, updated_at FROM vendors ORDER BY name"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_vendor_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Vendor>, sqlx::Error> {
    sqlx::query_as!(
        Vendor,
        r#"SELECT id, name, short_id, created_at, updated_at FROM vendors WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_vendor(
    pool: &PgPool,
    data: CreateVendor,
    user_id: Uuid,
) -> Result<Vendor, sqlx::Error> {
    let short_id = data
        .short_id
        .as_deref()
        .and_then(normalize_vendor_short_id)
        .or_else(|| derive_vendor_short_id(&data.name));

    let vendor = sqlx::query_as!(
        Vendor,
        r#"INSERT INTO vendors (name, short_id) VALUES ($1, $2) RETURNING id, name, short_id, created_at, updated_at"#,
        data.name,
        short_id
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "vendors",
        vendor.id,
        "create",
        None::<&Vendor>,
        Some(&vendor),
        user_id,
    )
    .await?;
    Ok(vendor)
}

pub async fn update_vendor(
    pool: &PgPool,
    id: Uuid,
    data: UpdateVendor,
    user_id: Uuid,
) -> Result<Option<Vendor>, sqlx::Error> {
    let old = get_vendor_by_id(pool, id).await?;

    if let Some(ref old_vendor) = old {
        let next_name = data.name.clone().unwrap_or_else(|| old_vendor.name.clone());
        let next_short_id = data
            .short_id
            .as_deref()
            .and_then(normalize_vendor_short_id)
            .or_else(|| old_vendor.short_id.clone())
            .or_else(|| derive_vendor_short_id(&next_name));

        let vendor = sqlx::query_as!(
            Vendor,
            r#"UPDATE vendors SET name = COALESCE($2, name), short_id = $3 WHERE id = $1 
               RETURNING id, name, short_id, created_at, updated_at"#,
            id,
            data.name,
            next_short_id
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref v) = vendor {
            AuditService::log(
                pool,
                "vendors",
                id,
                "update",
                Some(old_vendor),
                Some(v),
                user_id,
            )
            .await?;
        }
        return Ok(vendor);
    }
    Ok(None)
}

pub async fn delete_vendor(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_vendor_by_id(pool, id).await?;

    // Unlink purchases from this vendor's receipts, then delete the receipts
    sqlx::query!(r#"UPDATE purchases SET receipt_id = NULL WHERE receipt_id IN (SELECT id FROM receipts WHERE vendor_id = $1)"#, id)
        .execute(pool)
        .await?;
    sqlx::query!(r#"DELETE FROM receipts WHERE vendor_id = $1"#, id)
        .execute(pool)
        .await?;

    // Keep purchase invariant: invoice OR receipt/allocations must exist.
    let _ = delete_orphan_purchases(pool).await?;

    let result = sqlx::query!(r#"DELETE FROM vendors WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref v) = old {
            AuditService::log(
                pool,
                "vendors",
                id,
                "delete",
                Some(v),
                None::<&Vendor>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn get_vendor_summary(pool: &PgPool) -> Result<Vec<VendorSummary>, sqlx::Error> {
    sqlx::query_as!(
        VendorSummary,
        r#"WITH allocation_totals AS (
            SELECT
                pa.purchase_id,
                COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty
            FROM purchase_allocations pa
            GROUP BY pa.purchase_id
        ),
        allocation_rows AS (
            SELECT
                p.id AS purchase_id,
                pa.receipt_id,
                pa.allocated_qty AS quantity,
                pa.unit_cost AS unit_cost
            FROM purchases p
            JOIN invoices inv ON inv.id = p.invoice_id
            JOIN purchase_allocations pa ON pa.purchase_id = p.id
            WHERE p.invoice_id IS NOT NULL
              AND p.invoice_unit_price IS NOT NULL
              AND p.destination_id IS NOT NULL
              AND inv.reconciliation_state = 'locked'
        ),
        remainder_rows AS (
            SELECT
                p.id AS purchase_id,
                p.receipt_id,
                GREATEST(p.quantity - COALESCE(at.allocated_qty, 0), 0) AS quantity,
                p.purchase_cost AS unit_cost
            FROM purchases p
            JOIN invoices inv ON inv.id = p.invoice_id
            LEFT JOIN allocation_totals at ON at.purchase_id = p.id
            WHERE p.invoice_id IS NOT NULL
              AND p.invoice_unit_price IS NOT NULL
              AND p.destination_id IS NOT NULL
              AND inv.reconciliation_state = 'locked'
              AND p.receipt_id IS NOT NULL
              AND GREATEST(p.quantity - COALESCE(at.allocated_qty, 0), 0) > 0
        ),
        finalized_vendor_rows AS (
            SELECT * FROM allocation_rows
            UNION ALL
            SELECT * FROM remainder_rows
        )
        SELECT
            v.id as "vendor_id!",
            v.name as "vendor_name!",
            (
                SELECT COUNT(DISTINCT fvr.receipt_id)
                FROM finalized_vendor_rows fvr
                JOIN receipts r ON r.id = fvr.receipt_id
                WHERE r.vendor_id = v.id
            ) as "total_receipts?",
            (
                SELECT COUNT(DISTINCT fvr.purchase_id)
                FROM finalized_vendor_rows fvr
                JOIN receipts r ON r.id = fvr.receipt_id
                WHERE r.vendor_id = v.id
            ) as "total_purchases?",
            (
                SELECT COALESCE(SUM(fvr.quantity), 0)
                FROM finalized_vendor_rows fvr
                JOIN receipts r ON r.id = fvr.receipt_id
                WHERE r.vendor_id = v.id
            ) as "total_quantity?",
            (
                SELECT COALESCE(SUM(fvr.quantity * fvr.unit_cost), 0)
                FROM finalized_vendor_rows fvr
                JOIN receipts r ON r.id = fvr.receipt_id
                WHERE r.vendor_id = v.id
            ) as "total_spent?"
        FROM vendors v
        ORDER BY v.name"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_vendor_import_aliases(
    pool: &PgPool,
) -> Result<Vec<VendorImportAlias>, sqlx::Error> {
    sqlx::query_as::<_, VendorImportAlias>(
        r#"SELECT id, normalized_alias, raw_alias, vendor_id, created_at, updated_at
           FROM vendor_import_aliases"#,
    )
    .fetch_all(pool)
    .await
}

pub async fn get_vendor_import_aliases_by_vendor(
    pool: &PgPool,
    vendor_id: Uuid,
) -> Result<Vec<VendorImportAlias>, sqlx::Error> {
    sqlx::query_as::<_, VendorImportAlias>(
        r#"SELECT id, normalized_alias, raw_alias, vendor_id, created_at, updated_at
           FROM vendor_import_aliases
           WHERE vendor_id = $1
           ORDER BY updated_at DESC, raw_alias ASC"#,
    )
    .bind(vendor_id)
    .fetch_all(pool)
    .await
}

pub async fn resolve_vendor_id_by_import_alias(
    pool: &PgPool,
    alias: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let normalized = normalize_import_alias(alias);
    if normalized.is_empty() {
        return Ok(None);
    }

    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT vendor_id FROM vendor_import_aliases WHERE normalized_alias = $1"#,
    )
    .bind(normalized)
    .fetch_optional(pool)
    .await
}

pub async fn upsert_vendor_import_alias(
    pool: &PgPool,
    alias: &str,
    vendor_id: Uuid,
) -> Result<(), sqlx::Error> {
    let normalized = normalize_import_alias(alias);
    if normalized.is_empty() {
        return Ok(());
    }

    sqlx::query(
        r#"INSERT INTO vendor_import_aliases (normalized_alias, raw_alias, vendor_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (normalized_alias)
           DO UPDATE SET
             vendor_id = EXCLUDED.vendor_id,
             raw_alias = EXCLUDED.raw_alias,
             updated_at = NOW()"#,
    )
    .bind(normalized)
    .bind(alias.trim())
    .bind(vendor_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_vendor_import_alias(
    pool: &PgPool,
    vendor_id: Uuid,
    alias_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"DELETE FROM vendor_import_aliases
           WHERE id = $1
             AND vendor_id = $2"#,
    )
    .bind(alias_id)
    .bind(vendor_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

// ============================================
// Destinations
// ============================================

pub async fn get_all_destinations(pool: &PgPool) -> Result<Vec<Destination>, sqlx::Error> {
    sqlx::query_as!(
        Destination,
        r#"SELECT id, code, name, is_active, created_at, updated_at 
           FROM destinations ORDER BY code"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_active_destinations(pool: &PgPool) -> Result<Vec<Destination>, sqlx::Error> {
    sqlx::query_as!(
        Destination,
        r#"SELECT id, code, name, is_active, created_at, updated_at 
           FROM destinations WHERE is_active = TRUE ORDER BY code"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_destination_by_id(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<Destination>, sqlx::Error> {
    sqlx::query_as!(
        Destination,
        r#"SELECT id, code, name, is_active, created_at, updated_at 
           FROM destinations WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_destination(
    pool: &PgPool,
    data: CreateDestination,
    user_id: Uuid,
) -> Result<Destination, sqlx::Error> {
    let destination = sqlx::query_as!(
        Destination,
        r#"INSERT INTO destinations (code, name, is_active) VALUES ($1, $2, $3) 
           RETURNING id, code, name, is_active, created_at, updated_at"#,
        data.code,
        data.name,
        data.is_active.unwrap_or(true)
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "destinations",
        destination.id,
        "create",
        None::<&Destination>,
        Some(&destination),
        user_id,
    )
    .await?;
    Ok(destination)
}

pub async fn update_destination(
    pool: &PgPool,
    id: Uuid,
    data: UpdateDestination,
    user_id: Uuid,
) -> Result<Option<Destination>, sqlx::Error> {
    let old = get_destination_by_id(pool, id).await?;

    if let Some(ref old_dest) = old {
        let destination = sqlx::query_as!(
            Destination,
            r#"UPDATE destinations SET 
                code = COALESCE($2, code),
                name = COALESCE($3, name),
                is_active = COALESCE($4, is_active)
               WHERE id = $1 
               RETURNING id, code, name, is_active, created_at, updated_at"#,
            id,
            data.code,
            data.name,
            data.is_active
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref d) = destination {
            AuditService::log(
                pool,
                "destinations",
                id,
                "update",
                Some(old_dest),
                Some(d),
                user_id,
            )
            .await?;
        }
        return Ok(destination);
    }
    Ok(None)
}

pub async fn delete_destination(
    pool: &PgPool,
    id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let old = get_destination_by_id(pool, id).await?;

    // Unlink items that use this as default destination
    sqlx::query!(
        r#"UPDATE items SET default_destination_id = NULL WHERE default_destination_id = $1"#,
        id
    )
    .execute(pool)
    .await?;
    // Unlink purchases from this destination
    sqlx::query!(
        r#"UPDATE purchases SET destination_id = NULL WHERE destination_id = $1"#,
        id
    )
    .execute(pool)
    .await?;
    // Unlink purchases from invoices for this destination, then delete the invoices
    sqlx::query(UNLINK_PURCHASES_FOR_DESTINATION_INVOICES_SQL)
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query!(r#"DELETE FROM invoices WHERE destination_id = $1"#, id)
        .execute(pool)
        .await?;

    // Keep purchase invariant: invoice OR receipt/allocations must exist.
    let _ = delete_orphan_purchases(pool).await?;

    let result = sqlx::query!(r#"DELETE FROM destinations WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref d) = old {
            AuditService::log(
                pool,
                "destinations",
                id,
                "delete",
                Some(d),
                None::<&Destination>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn get_destination_summary(
    pool: &PgPool,
) -> Result<Vec<DestinationSummary>, sqlx::Error> {
    sqlx::query_as!(
        DestinationSummary,
        r#"WITH allocation_totals AS (
            SELECT
                pa.purchase_id,
                COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
            FROM purchase_allocations pa
            GROUP BY pa.purchase_id
        ),
        finalized_purchases AS (
            SELECT
                p.id,
                p.destination_id,
                p.quantity,
                p.invoice_unit_price,
                CASE
                    WHEN at.allocated_qty = p.quantity
                         AND at.allocated_qty > 0
                         AND p.quantity > 0
                    THEN at.allocated_total_cost / p.quantity::numeric
                    ELSE p.purchase_cost
                END AS effective_purchase_cost
            FROM purchases p
            JOIN invoices inv ON inv.id = p.invoice_id
            LEFT JOIN allocation_totals at ON at.purchase_id = p.id
            WHERE p.invoice_id IS NOT NULL
              AND p.invoice_unit_price IS NOT NULL
              AND p.destination_id IS NOT NULL
              AND inv.reconciliation_state = 'locked'
        )
        SELECT
            d.id as "destination_id!",
            d.code as "destination_code!",
            d.name as "destination_name!",
            (SELECT COUNT(*) FROM invoices inv WHERE inv.destination_id = d.id AND inv.reconciliation_state = 'locked') as "total_invoices?",
            (SELECT COUNT(*) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_purchases?",
            (SELECT COALESCE(SUM(fp.quantity), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_quantity?",
            (SELECT COALESCE(SUM(fp.quantity * fp.effective_purchase_cost), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_cost?",
            (SELECT COALESCE(SUM(fp.quantity * fp.invoice_unit_price), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_revenue?",
            (SELECT COALESCE(SUM(fp.quantity * (fp.invoice_unit_price - fp.effective_purchase_cost)), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_commission?",
            (SELECT COALESCE(SUM(fp.quantity * fp.effective_purchase_cost * 0.13), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_tax_paid?",
            (SELECT COALESCE(SUM(fp.quantity * (fp.invoice_unit_price - fp.effective_purchase_cost) * 0.13), 0) FROM finalized_purchases fp WHERE fp.destination_id = d.id) as "total_tax_owed?"
        FROM destinations d
        ORDER BY d.code"#
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Items
// ============================================

pub async fn get_all_items(pool: &PgPool, _query: ItemQuery) -> Result<Vec<Item>, sqlx::Error> {
    sqlx::query_as!(
        Item,
        r#"SELECT id, name,
                  default_destination_id, notes, created_at, updated_at
           FROM items
           ORDER BY name"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_active_items(pool: &PgPool) -> Result<Vec<ActiveItem>, sqlx::Error> {
    sqlx::query_as!(
        ActiveItem,
        r#"SELECT 
            i.id as "id!",
            i.name as "name!",
            i.default_destination_id as "default_destination_id?",
            d.code as "default_destination_code?",
            i.notes as "notes?",
            i.created_at as "created_at!"
        FROM items i
        LEFT JOIN destinations d ON d.id = i.default_destination_id
        ORDER BY i.created_at DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_item_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Item>, sqlx::Error> {
    sqlx::query_as!(
        Item,
        r#"SELECT id, name,
                  default_destination_id, notes, created_at, updated_at
           FROM items WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_item(
    pool: &PgPool,
    data: CreateItem,
    user_id: Uuid,
) -> Result<Item, sqlx::Error> {
    let item = sqlx::query_as!(
        Item,
        r#"INSERT INTO items (name, default_destination_id, notes) 
           VALUES ($1, $2, $3) 
           RETURNING id, name,
                     default_destination_id, notes, created_at, updated_at"#,
        data.name,
        data.default_destination_id,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "items",
        item.id,
        "create",
        None::<&Item>,
        Some(&item),
        user_id,
    )
    .await?;
    Ok(item)
}

pub async fn update_item(
    pool: &PgPool,
    id: Uuid,
    data: UpdateItem,
    user_id: Uuid,
) -> Result<Option<Item>, sqlx::Error> {
    let old = get_item_by_id(pool, id).await?;

    if let Some(ref old_item) = old {
        let item = sqlx::query_as!(
            Item,
            r#"UPDATE items SET 
                name = COALESCE($2, name),
                default_destination_id = COALESCE($3, default_destination_id),
                notes = COALESCE($4, notes)
               WHERE id = $1 
               RETURNING id, name,
                         default_destination_id, notes, created_at, updated_at"#,
            id,
            data.name,
            data.default_destination_id,
            data.notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref i) = item {
            AuditService::log(
                pool,
                "items",
                id,
                "update",
                Some(old_item),
                Some(i),
                user_id,
            )
            .await?;
        }
        return Ok(item);
    }
    Ok(None)
}

pub async fn delete_item(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_item_by_id(pool, id).await?;

    // Cascade: delete all purchases for this item
    sqlx::query!(r#"DELETE FROM purchases WHERE item_id = $1"#, id)
        .execute(pool)
        .await?;

    let result = sqlx::query!(r#"DELETE FROM items WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref i) = old {
            AuditService::log(pool, "items", id, "delete", Some(i), None::<&Item>, user_id).await?;
        }
        return Ok(true);
    }
    Ok(false)
}

// ============================================
// Incoming Invoices
// ============================================

pub async fn get_all_invoices(pool: &PgPool) -> Result<Vec<Invoice>, sqlx::Error> {
    sqlx::query_as!(
        Invoice,
        r#"SELECT id, destination_id, invoice_number, order_number, invoice_date, 
                subtotal, tax_rate, total, reconciliation_state, notes, created_at, updated_at
           FROM invoices ORDER BY invoice_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_invoice_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Invoice>, sqlx::Error> {
    sqlx::query_as!(
        Invoice,
        r#"SELECT id, destination_id, invoice_number, order_number, invoice_date, 
                  subtotal, tax_rate, total, reconciliation_state, notes, created_at, updated_at
           FROM invoices WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_invoice(
    pool: &PgPool,
    data: CreateInvoice,
    user_id: Uuid,
) -> Result<Invoice, sqlx::Error> {
    let tax_rate = data.tax_rate.unwrap_or(Decimal::new(1300, 2)); // 13.00
    let reconciliation_state = data.reconciliation_state.as_deref().unwrap_or("open");
    let total = data.subtotal * (Decimal::ONE + tax_rate / Decimal::new(100, 0));
    let invoice = sqlx::query_as!(
        Invoice,
        r#"INSERT INTO invoices (destination_id, invoice_number, order_number, invoice_date, subtotal, tax_rate, total, reconciliation_state, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
           RETURNING id, destination_id, invoice_number, order_number, invoice_date, 
                     subtotal, tax_rate, total, reconciliation_state, notes, created_at, updated_at"#,
        data.destination_id,
        data.invoice_number,
        data.order_number,
        data.invoice_date,
        data.subtotal,
        tax_rate,
        total,
        reconciliation_state,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "invoices",
        invoice.id,
        "create",
        None::<&Invoice>,
        Some(&invoice),
        user_id,
    )
    .await?;
    Ok(invoice)
}

pub async fn create_invoice_from_pdf_atomic(
    pool: &PgPool,
    data: AtomicInvoicePdfCreateInput,
    user_id: Uuid,
) -> Result<AtomicInvoicePdfCreateResult, AtomicInvoicePdfCreateError> {
    let mut tx = pool.begin().await?;

    let tax_rate = data.tax_rate.unwrap_or(Decimal::new(1300, 2)); // 13.00
    let total = data.subtotal * (Decimal::ONE + tax_rate / Decimal::new(100, 0));

    let invoice = sqlx::query_as!(
        Invoice,
          r#"INSERT INTO invoices (destination_id, invoice_number, order_number, invoice_date, subtotal, tax_rate, total, reconciliation_state, notes, original_pdf, original_filename)
              VALUES ($1, $2, NULL, $3, $4, $5, $6, 'open', $7, $8, $9)
           RETURNING id, destination_id, invoice_number, order_number, invoice_date,
                            subtotal, tax_rate, total, reconciliation_state, notes, created_at, updated_at"#,
        data.destination_id,
        data.invoice_number,
        data.invoice_date,
        data.subtotal,
        tax_rate,
        total,
        data.notes,
        data.pdf_data,
        data.pdf_filename,
    )
    .fetch_one(&mut *tx)
    .await?;

    AuditService::log_with_executor(
        &mut *tx,
        "invoices",
        invoice.id,
        "create",
        None::<&Invoice>,
        Some(&invoice),
        user_id,
    )
    .await?;

    let mut purchase_count = 0usize;
    for line in data.lines {
        let purchase = sqlx::query_as!(
            Purchase,
                r#"INSERT INTO purchases (item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price, destination_id, status, delivery_date, notes, created_at, updated_at)
                    VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NULL, NULL, $8::date::timestamptz, $8::date::timestamptz)
               RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price,
                         destination_id, status as "status: DeliveryStatus",
                         delivery_date, notes, created_at, updated_at"#,
            line.item_id,
            invoice.id,
            line.qty,
            Decimal::ZERO,
            Some(line.invoice_unit_price),
            Some(data.destination_id),
            DeliveryStatus::Delivered as DeliveryStatus,
            data.invoice_date,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|source| AtomicInvoicePdfCreateError::PurchaseInsert {
            line_index: line.line_index,
            description: line.description.clone(),
            source,
        })?;

        AuditService::log_with_executor(
            &mut *tx,
            "purchases",
            purchase.id,
            "create",
            None::<&Purchase>,
            Some(&purchase),
            user_id,
        )
        .await?;

        purchase_count += 1;
    }

    tx.commit().await?;

    Ok(AtomicInvoicePdfCreateResult {
        invoice,
        purchase_count,
    })
}

pub async fn update_invoice(
    pool: &PgPool,
    id: Uuid,
    data: UpdateInvoice,
    user_id: Uuid,
) -> Result<Option<Invoice>, sqlx::Error> {
    let old = get_invoice_by_id(pool, id).await?;

    if let Some(ref old_inv) = old {
        let has_non_state_changes = data.invoice_number.is_some()
            || data.order_number.is_some()
            || data.invoice_date.is_some()
            || data.subtotal.is_some()
            || data.tax_rate.is_some()
            || data.notes.is_some();
        let requested_state = data.reconciliation_state.as_deref();

        if old_inv.reconciliation_state == "locked" {
            if has_non_state_changes || requested_state != Some("reopened") {
                return Err(locked_invoice_error(
                    "Locked invoices are immutable. Set reconciliation_state to 'reopened' first.",
                ));
            }
        } else if requested_state == Some("reopened") {
            return Err(locked_invoice_error(
                "Only locked invoices can transition to 'reopened'.",
            ));
        }

        let invoice = sqlx::query_as!(
            Invoice,
            r#"UPDATE invoices SET 
                invoice_number = COALESCE($2, invoice_number),
                order_number = COALESCE($3, order_number),
                invoice_date = COALESCE($4, invoice_date),
                subtotal = COALESCE($5, subtotal),
                tax_rate = COALESCE($6, tax_rate),
                total = COALESCE($5, subtotal) * (1 + COALESCE($6, tax_rate) / 100),
                reconciliation_state = COALESCE($7, reconciliation_state),
                notes = COALESCE($8, notes)
               WHERE id = $1 
               RETURNING id, destination_id, invoice_number, order_number, invoice_date, 
                         subtotal, tax_rate, total, reconciliation_state, notes, created_at, updated_at"#,
            id,
            data.invoice_number,
            data.order_number,
            data.invoice_date,
            data.subtotal,
            data.tax_rate,
            data.reconciliation_state,
            data.notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref inv) = invoice {
            AuditService::log(
                pool,
                "invoices",
                id,
                "update",
                Some(old_inv),
                Some(inv),
                user_id,
            )
            .await?;
        }
        return Ok(invoice);
    }
    Ok(None)
}

pub async fn delete_invoice(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_invoice_by_id(pool, id).await?;

    if let Some(ref inv) = old {
        if inv.reconciliation_state == "locked" {
            return Err(locked_invoice_error(
                "Cannot delete a locked invoice. Reopen it first.",
            ));
        }
    }

    // Remove allocation links for this invoice's purchases so deleting an invoice
    // behaves like the invoice never existed for allocation-backed rows.
    sqlx::query(DELETE_ALLOCATIONS_FOR_INVOICE_PURCHASES_SQL)
        .bind(id)
        .execute(pool)
        .await?;

    // Unlink purchases that reference this invoice (SET NULL, not delete)
    sqlx::query(UNLINK_PURCHASES_FOR_INVOICE_SQL)
        .bind(id)
        .execute(pool)
        .await?;

    // Keep purchase invariant: invoice OR receipt/allocations must exist.
    let _ = delete_orphan_purchases(pool).await?;

    let result = sqlx::query!(r#"DELETE FROM invoices WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref inv) = old {
            AuditService::log(
                pool,
                "invoices",
                id,
                "delete",
                Some(inv),
                None::<&Invoice>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn save_invoice_pdf(
    pool: &PgPool,
    id: Uuid,
    pdf_data: &[u8],
    filename: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query!(
        r#"UPDATE invoices SET original_pdf = $2, original_filename = $3 WHERE id = $1"#,
        id,
        pdf_data,
        filename
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_invoice_pdf(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<(Vec<u8>, String)>, sqlx::Error> {
    let row = sqlx::query!(
        r#"SELECT original_pdf, original_filename FROM invoices WHERE id = $1 AND original_pdf IS NOT NULL"#,
        id
    )
    .fetch_optional(pool)
    .await?;

    Ok(
        row.and_then(|r| match (r.original_pdf, r.original_filename) {
            (Some(pdf), Some(name)) => Some((pdf, name)),
            (Some(pdf), None) => Some((pdf, "invoice.pdf".to_string())),
            _ => None,
        }),
    )
}

pub async fn get_invoice_reconciliation(
    pool: &PgPool,
) -> Result<Vec<InvoiceReconciliation>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceReconciliation,
        r#"SELECT 
            invoice_id as "invoice_id!",
            invoice_number as "invoice_number!",
            destination_code as "destination_code!",
            destination_name as "destination_name!",
            invoice_date as "invoice_date!",
            invoice_total as "invoice_total!",
            purchases_total as "purchases_total!",
            difference as "difference!",
            is_matched as "is_matched!",
            purchase_count as "purchase_count!",
            total_cost as "total_cost!",
            total_commission as "total_commission!"
        FROM v_invoice_reconciliation
        ORDER BY invoice_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_invoice_with_destination(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<InvoiceWithDestination>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceWithDestination,
                r#"WITH allocation_totals AS (
                             SELECT
                                     pa.purchase_id,
                                     COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                                     COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
                             FROM purchase_allocations pa
                             GROUP BY pa.purchase_id
                     ),
                     invoice_purchase_totals AS (
                             SELECT
                                     p.invoice_id,
                                     p.quantity,
                                     p.invoice_unit_price,
                                     CASE
                                         WHEN at.allocated_qty = p.quantity
                                              AND at.allocated_qty > 0
                                              AND p.quantity > 0
                                         THEN at.allocated_total_cost / p.quantity::numeric
                                         ELSE p.purchase_cost
                                     END AS effective_purchase_cost
                             FROM purchases p
                             LEFT JOIN allocation_totals at ON at.purchase_id = p.id
                             WHERE p.invoice_id IS NOT NULL
                     )
                     SELECT 
            inv.id,
            inv.destination_id,
            d.code AS destination_code,
            d.name AS destination_name,
            inv.invoice_number,
            inv.order_number,
            inv.invoice_date,
            inv.subtotal,
            inv.tax_rate,
            inv.total,
            inv.reconciliation_state,
            (inv.original_pdf IS NOT NULL) AS has_pdf,
            inv.notes,
            inv.created_at,
            inv.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE((SELECT SUM(rp.quantity * COALESCE(rp.invoice_unit_price, rp.effective_purchase_cost)) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS purchases_total,
            COALESCE((SELECT SUM(rp.quantity * rp.effective_purchase_cost) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS total_cost,
            COALESCE((SELECT SUM(rp.quantity * (COALESCE(rp.invoice_unit_price, rp.effective_purchase_cost) - rp.effective_purchase_cost)) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS total_commission,
            COUNT(p.id) FILTER (
                WHERE p.receipt_id IS NOT NULL
                   OR EXISTS (
                       SELECT 1
                       FROM purchase_allocations pa
                       WHERE pa.purchase_id = p.id
                   )
            ) AS receipted_count
        FROM invoices inv
        JOIN destinations d ON d.id = inv.destination_id
        LEFT JOIN purchases p ON p.invoice_id = inv.id
        WHERE inv.id = $1
        GROUP BY inv.id, inv.destination_id, d.code, d.name, inv.invoice_number, inv.order_number,
                 inv.invoice_date, inv.subtotal, inv.tax_rate, inv.total, inv.reconciliation_state, inv.original_pdf, inv.notes, inv.created_at, inv.updated_at"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn get_invoices_with_destination(
    pool: &PgPool,
) -> Result<Vec<InvoiceWithDestination>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceWithDestination,
                r#"WITH allocation_totals AS (
                             SELECT
                                     pa.purchase_id,
                                     COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                                     COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
                             FROM purchase_allocations pa
                             GROUP BY pa.purchase_id
                     ),
                     invoice_purchase_totals AS (
                             SELECT
                                     p.invoice_id,
                                     p.quantity,
                                     p.invoice_unit_price,
                                     CASE
                                         WHEN at.allocated_qty = p.quantity
                                              AND at.allocated_qty > 0
                                              AND p.quantity > 0
                                         THEN at.allocated_total_cost / p.quantity::numeric
                                         ELSE p.purchase_cost
                                     END AS effective_purchase_cost
                             FROM purchases p
                             LEFT JOIN allocation_totals at ON at.purchase_id = p.id
                             WHERE p.invoice_id IS NOT NULL
                     )
                     SELECT 
            inv.id,
            inv.destination_id,
            d.code AS destination_code,
            d.name AS destination_name,
            inv.invoice_number,
            inv.order_number,
            inv.invoice_date,
            inv.subtotal,
            inv.tax_rate,
            inv.total,
            inv.reconciliation_state,
            (inv.original_pdf IS NOT NULL) AS has_pdf,
            inv.notes,
            inv.created_at,
            inv.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE((SELECT SUM(rp.quantity * COALESCE(rp.invoice_unit_price, rp.effective_purchase_cost)) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS purchases_total,
            COALESCE((SELECT SUM(rp.quantity * rp.effective_purchase_cost) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS total_cost,
            COALESCE((SELECT SUM(rp.quantity * (COALESCE(rp.invoice_unit_price, rp.effective_purchase_cost) - rp.effective_purchase_cost)) FROM invoice_purchase_totals rp WHERE rp.invoice_id = inv.id), 0) AS total_commission,
            COUNT(p.id) FILTER (
                WHERE p.receipt_id IS NOT NULL
                   OR EXISTS (
                       SELECT 1
                       FROM purchase_allocations pa
                       WHERE pa.purchase_id = p.id
                   )
            ) AS receipted_count
        FROM invoices inv
        JOIN destinations d ON d.id = inv.destination_id
        LEFT JOIN purchases p ON p.invoice_id = inv.id
        GROUP BY inv.id, inv.destination_id, d.code, d.name, inv.invoice_number, inv.order_number,
                 inv.invoice_date, inv.subtotal, inv.tax_rate, inv.total, inv.reconciliation_state, inv.original_pdf, inv.notes, inv.created_at, inv.updated_at
        ORDER BY inv.invoice_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_purchases_by_invoice(
    pool: &PgPool,
    invoice_id: Uuid,
) -> Result<Vec<PurchaseEconomics>, sqlx::Error> {
    sqlx::query_as!(
        PurchaseEconomics,
        r#"WITH allocation_summary AS (
               SELECT
                   pa.purchase_id,
                   (ARRAY_AGG(DISTINCT pa.receipt_id))[1] AS any_receipt_id,
                   COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                   COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
               FROM purchase_allocations pa
               GROUP BY pa.purchase_id
           ),
           purchase_rows AS (
               SELECT
                   p.id AS purchase_id,
                   p.item_id,
                   p.quantity,
                   p.invoice_unit_price,
                   p.status,
                   p.delivery_date,
                   p.invoice_id,
                   COALESCE(p.receipt_id, alloc.any_receipt_id) AS resolved_receipt_id,
                   p.destination_id,
                   p.allow_receipt_date_override,
                   p.notes,
                   p.created_at,
                   CASE
                       WHEN alloc.allocated_qty = p.quantity
                            AND alloc.allocated_qty > 0
                            AND p.quantity > 0
                       THEN alloc.allocated_total_cost / p.quantity::numeric
                       ELSE p.purchase_cost
                   END AS effective_purchase_cost
               FROM purchases p
               LEFT JOIN allocation_summary alloc ON alloc.purchase_id = p.id
               WHERE p.invoice_id = $1
           )
           SELECT
               pr.purchase_id AS "purchase_id!",
               COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS "purchase_date!",
               pr.item_id AS "item_id!",
               COALESCE(i.name, '(deleted item)') AS "item_name!",
               v.name AS "vendor_name?",
               d.code AS "destination_code?",
               pr.quantity AS "quantity!",
               pr.effective_purchase_cost AS "purchase_cost!",
               (pr.quantity * pr.effective_purchase_cost) AS total_cost,
               pr.invoice_unit_price,
               (pr.quantity * pr.invoice_unit_price) AS total_selling,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost)
               END AS unit_commission,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (pr.quantity * (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost))
               END AS total_commission,
               (pr.quantity * pr.effective_purchase_cost * 0.13) AS tax_paid,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (pr.quantity * (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost) * 0.13)
               END AS tax_owed,
               pr.status AS "status!: DeliveryStatus",
               pr.delivery_date,
               pr.invoice_id,
               pr.resolved_receipt_id AS "receipt_id?",
               r.receipt_number AS "receipt_number?",
               inv.invoice_number AS "invoice_number?",
               pr.allow_receipt_date_override AS "allow_receipt_date_override!",
               pr.notes
           FROM purchase_rows pr
           LEFT JOIN items i ON i.id = pr.item_id
           LEFT JOIN receipts r ON r.id = pr.resolved_receipt_id
           LEFT JOIN vendors v ON v.id = r.vendor_id
           LEFT JOIN destinations d ON d.id = pr.destination_id
           LEFT JOIN invoices inv ON inv.id = pr.invoice_id
           ORDER BY pr.created_at DESC"#,
        invoice_id
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Purchases
// ============================================

pub async fn get_all_purchases(
    pool: &PgPool,
    query: PurchaseQuery,
) -> Result<Vec<Purchase>, sqlx::Error> {
    sqlx::query_as!(
        Purchase,
        r#"SELECT p.id, p.item_id, p.invoice_id, p.receipt_id, p.quantity, p.purchase_cost, p.invoice_unit_price,
                  p.destination_id, p.status as "status: DeliveryStatus", 
                  p.delivery_date, p.notes, p.created_at, p.updated_at
           FROM purchases p
           LEFT JOIN receipts r ON r.id = p.receipt_id
           WHERE ($1::delivery_status IS NULL OR p.status = $1)
             AND ($2::uuid IS NULL OR p.destination_id = $2)
             AND ($3::uuid IS NULL OR r.vendor_id = $3)
             AND ($4::date IS NULL OR p.created_at >= $4::date)
             AND ($5::date IS NULL OR p.created_at <= $5::date)
           ORDER BY p.created_at DESC
           LIMIT COALESCE($6, 100)
           OFFSET COALESCE($7, 0)"#,
        query.status as Option<DeliveryStatus>,
        query.destination_id,
        query.vendor_id,
        query.from,
        query.to,
        query.limit,
        query.offset
    )
    .fetch_all(pool)
    .await
}

pub async fn get_purchase_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Purchase>, sqlx::Error> {
    sqlx::query_as!(
        Purchase,
        r#"SELECT id, item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price,
                  destination_id, status as "status: DeliveryStatus", 
                  delivery_date, notes, created_at, updated_at
           FROM purchases WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn get_purchase_allocations(
    pool: &PgPool,
    purchase_id: Uuid,
) -> Result<Vec<PurchaseAllocationWithReceipt>, sqlx::Error> {
    sqlx::query_as!(
        PurchaseAllocationWithReceipt,
        r#"SELECT
            pa.id,
            pa.purchase_id,
            pa.receipt_id,
            pa.receipt_line_item_id,
            rli.item_id,
            i.name as item_name,
            pa.allocated_qty,
            pa.unit_cost,
            r.receipt_number,
            v.name as vendor_name,
            r.receipt_date,
            pa.created_at,
            pa.updated_at
        FROM purchase_allocations pa
        JOIN receipts r ON r.id = pa.receipt_id
        JOIN vendors v ON v.id = r.vendor_id
        LEFT JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
        LEFT JOIN items i ON i.id = rli.item_id
        WHERE pa.purchase_id = $1
        ORDER BY r.receipt_date DESC, pa.created_at DESC"#,
        purchase_id
    )
    .fetch_all(pool)
    .await
}

pub async fn create_purchase_allocation(
    pool: &PgPool,
    purchase_id: Uuid,
    data: CreatePurchaseAllocation,
) -> Result<PurchaseAllocationWithReceipt, PurchaseAllocationError> {
    if data.allocated_qty <= 0 {
        return Err(PurchaseAllocationError::Validation(
            "allocated_qty must be greater than zero".to_string(),
        ));
    }

    ensure_purchase_not_linked_to_locked_invoice_for_allocation(
        pool,
        purchase_id,
        "Cannot modify allocations for purchases on a locked invoice. Reopen the invoice first.",
    )
    .await?;

    let mut tx = pool.begin().await?;

    let purchase = sqlx::query!(
          r#"SELECT
                  p.id,
                  p.item_id,
                  p.quantity,
                  p.allow_receipt_date_override,
                inv.invoice_date AS "invoice_date?"
              FROM purchases p
              LEFT JOIN invoices inv ON inv.id = p.invoice_id
              WHERE p.id = $1"#,
        purchase_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Purchase not found".to_string()))?;

    let receipt_line = sqlx::query!(
          r#"SELECT
                  rli.id,
                  rli.receipt_id,
                  rli.item_id,
                  rli.quantity,
                  rli.unit_cost,
                  r.receipt_date
           FROM receipt_line_items rli
              JOIN receipts r ON r.id = rli.receipt_id
           WHERE rli.id = $1"#,
        data.receipt_line_item_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Receipt line item not found".to_string()))?;

    if receipt_line.item_id != purchase.item_id {
        return Err(PurchaseAllocationError::Validation(
            "Receipt line item item must match invoice line item".to_string(),
        ));
    }

    let allow_receipt_date_override =
        data.allow_receipt_date_override || purchase.allow_receipt_date_override;
    validate_receipt_date_for_invoice(
        purchase.invoice_date,
        receipt_line.receipt_date,
        allow_receipt_date_override,
    )?;

    let allocated_for_purchase_sum = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT FROM purchase_allocations WHERE purchase_id = $1"#,
        purchase_id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(0);

    if allocated_for_purchase_sum + data.allocated_qty > purchase.quantity {
        return Err(PurchaseAllocationError::Validation(format!(
            "Allocated quantity exceeds purchase quantity (allocated: {}, requested: {}, purchase qty: {})",
            allocated_for_purchase_sum, data.allocated_qty, purchase.quantity
        )));
    }

    let allocated_for_line_sum = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT FROM purchase_allocations WHERE receipt_line_item_id = $1"#,
        data.receipt_line_item_id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(0);

    if allocated_for_line_sum + data.allocated_qty > receipt_line.quantity {
        return Err(PurchaseAllocationError::Validation(format!(
            "Allocated quantity exceeds receipt line quantity (allocated: {}, requested: {}, receipt line qty: {})",
            allocated_for_line_sum, data.allocated_qty, receipt_line.quantity
        )));
    }

    let created = sqlx::query_as!(
        PurchaseAllocation,
        r#"INSERT INTO purchase_allocations (purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost, created_at, updated_at"#,
        purchase_id,
        receipt_line.receipt_id,
        Some(receipt_line.id),
        data.allocated_qty,
        receipt_line.unit_cost
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint() == Some("purchase_allocations_purchase_id_receipt_id_key") {
                return PurchaseAllocationError::Validation(
                    "Allocation for this receipt already exists on this line item. Edit the existing allocation instead."
                        .to_string(),
                );
            }
        }
        PurchaseAllocationError::Sql(e)
    })?;

    if data.allow_receipt_date_override && !purchase.allow_receipt_date_override {
        sqlx::query!(
            r#"UPDATE purchases SET allow_receipt_date_override = TRUE WHERE id = $1"#,
            purchase_id
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let rows = get_purchase_allocations(pool, purchase_id).await?;
    rows.into_iter()
        .find(|r| r.id == created.id)
        .ok_or_else(|| {
            PurchaseAllocationError::NotFound("Allocation created but not found".to_string())
        })
}

pub async fn update_purchase_allocation(
    pool: &PgPool,
    purchase_id: Uuid,
    allocation_id: Uuid,
    data: UpdatePurchaseAllocation,
) -> Result<PurchaseAllocationWithReceipt, PurchaseAllocationError> {
    ensure_purchase_not_linked_to_locked_invoice_for_allocation(
        pool,
        purchase_id,
        "Cannot modify allocations for purchases on a locked invoice. Reopen the invoice first.",
    )
    .await?;

    let mut tx = pool.begin().await?;

    let purchase = sqlx::query!(
        r#"SELECT
              p.id,
              p.item_id,
              p.quantity,
              p.allow_receipt_date_override,
                  inv.invoice_date AS "invoice_date?"
           FROM purchases p
           LEFT JOIN invoices inv ON inv.id = p.invoice_id
           WHERE p.id = $1"#,
        purchase_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Purchase not found".to_string()))?;

    let current = sqlx::query_as!(
        PurchaseAllocation,
        r#"SELECT id, purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost, created_at, updated_at
           FROM purchase_allocations
           WHERE id = $1 AND purchase_id = $2"#,
        allocation_id,
        purchase_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Allocation not found".to_string()))?;

    let next_receipt_line_item_id = data
        .receipt_line_item_id
        .or(current.receipt_line_item_id)
        .ok_or_else(|| {
            PurchaseAllocationError::Validation(
                "Allocation must be linked to a receipt line item".to_string(),
            )
        })?;
    let next_allocated_qty = data.allocated_qty.unwrap_or(current.allocated_qty);

    if next_allocated_qty <= 0 {
        return Err(PurchaseAllocationError::Validation(
            "allocated_qty must be greater than zero".to_string(),
        ));
    }

    let receipt_line = sqlx::query!(
        r#"SELECT
              rli.id,
              rli.receipt_id,
              rli.item_id,
              rli.quantity,
              rli.unit_cost,
              r.receipt_date
           FROM receipt_line_items rli
           JOIN receipts r ON r.id = rli.receipt_id
           WHERE rli.id = $1"#,
        next_receipt_line_item_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Receipt line item not found".to_string()))?;

    if receipt_line.item_id != purchase.item_id {
        return Err(PurchaseAllocationError::Validation(
            "Receipt line item item must match invoice line item".to_string(),
        ));
    }

    let requested_override = data.allow_receipt_date_override;
    let effective_override = requested_override.unwrap_or(purchase.allow_receipt_date_override);
    validate_receipt_date_for_invoice(
        purchase.invoice_date,
        receipt_line.receipt_date,
        effective_override,
    )?;

    if requested_override == Some(false) {
        if let Some(invoice_date) = purchase.invoice_date {
            let has_other_late_allocations = sqlx::query_scalar!(
                r#"SELECT EXISTS(
                       SELECT 1
                       FROM purchase_allocations pa
                       JOIN receipts r ON r.id = pa.receipt_id
                       WHERE pa.purchase_id = $1
                         AND pa.id <> $2
                         AND r.receipt_date > $3
                   ) AS "exists!""#,
                purchase_id,
                allocation_id,
                invoice_date
            )
            .fetch_one(&mut *tx)
            .await?;

            if has_other_late_allocations {
                return Err(PurchaseAllocationError::Validation(
                    "Cannot disable receipt date override while allocations after the invoice date still exist."
                        .to_string(),
                ));
            }
        }
    }

    let other_allocated_purchase_sum = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT
           FROM purchase_allocations
           WHERE purchase_id = $1 AND id <> $2"#,
        purchase_id,
        allocation_id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(0);

    if other_allocated_purchase_sum + next_allocated_qty > purchase.quantity {
        return Err(PurchaseAllocationError::Validation(format!(
            "Allocated quantity exceeds purchase quantity (allocated by others: {}, requested: {}, purchase qty: {})",
            other_allocated_purchase_sum, next_allocated_qty, purchase.quantity
        )));
    }

    let other_allocated_line_sum = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT
           FROM purchase_allocations
           WHERE receipt_line_item_id = $1 AND id <> $2"#,
        next_receipt_line_item_id,
        allocation_id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(0);

    if other_allocated_line_sum + next_allocated_qty > receipt_line.quantity {
        return Err(PurchaseAllocationError::Validation(format!(
            "Allocated quantity exceeds receipt line quantity (allocated by others: {}, requested: {}, receipt line qty: {})",
            other_allocated_line_sum, next_allocated_qty, receipt_line.quantity
        )));
    }

    let updated = sqlx::query_as!(
        PurchaseAllocation,
        r#"UPDATE purchase_allocations
           SET receipt_id = $3,
               receipt_line_item_id = $4,
               allocated_qty = $5,
               unit_cost = $6
           WHERE id = $1 AND purchase_id = $2
           RETURNING id, purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost, created_at, updated_at"#,
        allocation_id,
        purchase_id,
        receipt_line.receipt_id,
        Some(receipt_line.id),
        next_allocated_qty,
        receipt_line.unit_cost
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint() == Some("purchase_allocations_purchase_id_receipt_id_key") {
                return PurchaseAllocationError::Validation(
                    "Allocation for this receipt already exists on this line item."
                        .to_string(),
                );
            }
        }
        PurchaseAllocationError::Sql(e)
    })?;

    if let Some(next_override) = requested_override {
        if next_override != purchase.allow_receipt_date_override {
            sqlx::query!(
                r#"UPDATE purchases SET allow_receipt_date_override = $2 WHERE id = $1"#,
                purchase_id,
                next_override
            )
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;

    let rows = get_purchase_allocations(pool, purchase_id).await?;
    rows.into_iter()
        .find(|r| r.id == updated.id)
        .ok_or_else(|| {
            PurchaseAllocationError::NotFound("Allocation updated but not found".to_string())
        })
}

pub async fn get_receipt_line_items(
    pool: &PgPool,
    receipt_id: Uuid,
) -> Result<Vec<ReceiptLineItemWithItem>, sqlx::Error> {
    sqlx::query_as!(
        ReceiptLineItemWithItem,
        r#"SELECT
            rli.id,
            rli.receipt_id,
            rli.item_id,
            i.name AS item_name,
            rli.quantity,
            rli.unit_cost,
            rli.notes,
            COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN pa.allocated_qty ELSE 0 END), 0)::INT AS "allocated_qty!: i32",
            (rli.quantity - COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN pa.allocated_qty ELSE 0 END), 0))::INT AS "remaining_qty!: i32",
            rli.created_at,
            rli.updated_at
        FROM receipt_line_items rli
        JOIN items i ON i.id = rli.item_id
        LEFT JOIN purchase_allocations pa
          ON pa.receipt_line_item_id = rli.id
         AND pa.receipt_id = rli.receipt_id
        LEFT JOIN purchases p ON p.id = pa.purchase_id
        WHERE rli.receipt_id = $1
        GROUP BY rli.id, rli.receipt_id, rli.item_id, i.name, rli.quantity, rli.unit_cost, rli.notes, rli.created_at, rli.updated_at
        ORDER BY i.name"#,
        receipt_id
    )
    .fetch_all(pool)
    .await
}

pub async fn create_receipt_line_item(
    pool: &PgPool,
    receipt_id: Uuid,
    data: CreateReceiptLineItem,
) -> Result<ReceiptLineItemWithItem, PurchaseAllocationError> {
    if data.quantity <= 0 {
        return Err(PurchaseAllocationError::Validation(
            "quantity must be greater than zero".to_string(),
        ));
    }

    ensure_receipt_not_linked_to_locked_invoice_for_line_item(
        pool,
        receipt_id,
        "Cannot modify receipt line items linked to a locked invoice. Reopen linked invoice(s) first.",
    )
    .await?;

    let created = sqlx::query_as!(
        ReceiptLineItem,
        r#"INSERT INTO receipt_line_items (receipt_id, item_id, quantity, unit_cost, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, receipt_id, item_id, quantity, unit_cost, notes, created_at, updated_at"#,
        receipt_id,
        data.item_id,
        data.quantity,
        data.unit_cost,
        data.notes,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint() == Some("receipt_line_items_receipt_id_item_id_key") {
                return PurchaseAllocationError::Validation(
                    "Receipt already has a line for this item. Edit the existing line instead."
                        .to_string(),
                );
            }
        }
        PurchaseAllocationError::Sql(e)
    })?;

    let rows = get_receipt_line_items(pool, receipt_id).await?;
    rows.into_iter()
        .find(|r| r.id == created.id)
        .ok_or_else(|| {
            PurchaseAllocationError::NotFound("Receipt line item created but not found".to_string())
        })
}

pub async fn update_receipt_line_item(
    pool: &PgPool,
    receipt_id: Uuid,
    line_item_id: Uuid,
    data: UpdateReceiptLineItem,
) -> Result<ReceiptLineItemWithItem, PurchaseAllocationError> {
    ensure_receipt_not_linked_to_locked_invoice_for_line_item(
        pool,
        receipt_id,
        "Cannot modify receipt line items linked to a locked invoice. Reopen linked invoice(s) first.",
    )
    .await?;

    let current = sqlx::query_as!(
        ReceiptLineItem,
        r#"SELECT id, receipt_id, item_id, quantity, unit_cost, notes, created_at, updated_at
           FROM receipt_line_items
           WHERE id = $1 AND receipt_id = $2"#,
        line_item_id,
        receipt_id
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Receipt line item not found".to_string()))?;

    let next_item_id = data.item_id.unwrap_or(current.item_id);
    let next_qty = data.quantity.unwrap_or(current.quantity);
    let next_unit_cost = data.unit_cost.unwrap_or(current.unit_cost);
    let next_notes = data.notes.or(current.notes);

    if next_qty <= 0 {
        return Err(PurchaseAllocationError::Validation(
            "quantity must be greater than zero".to_string(),
        ));
    }

    let allocated = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT
           FROM purchase_allocations
           WHERE receipt_line_item_id = $1"#,
        line_item_id
    )
    .fetch_one(pool)
    .await?
    .unwrap_or(0);

    if next_qty < allocated {
        return Err(PurchaseAllocationError::Validation(format!(
            "quantity cannot be less than currently allocated qty ({})",
            allocated
        )));
    }

    let updated = sqlx::query_as!(
        ReceiptLineItem,
        r#"UPDATE receipt_line_items
           SET item_id = $3,
               quantity = $4,
               unit_cost = $5,
               notes = $6
           WHERE id = $1 AND receipt_id = $2
           RETURNING id, receipt_id, item_id, quantity, unit_cost, notes, created_at, updated_at"#,
        line_item_id,
        receipt_id,
        next_item_id,
        next_qty,
        next_unit_cost,
        next_notes,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint() == Some("receipt_line_items_receipt_id_item_id_key") {
                return PurchaseAllocationError::Validation(
                    "Receipt already has a line for this item. Edit the existing line instead."
                        .to_string(),
                );
            }
        }
        PurchaseAllocationError::Sql(e)
    })?;

    let rows = get_receipt_line_items(pool, receipt_id).await?;
    rows.into_iter()
        .find(|r| r.id == updated.id)
        .ok_or_else(|| {
            PurchaseAllocationError::NotFound("Receipt line item updated but not found".to_string())
        })
}

pub async fn delete_receipt_line_item(
    pool: &PgPool,
    receipt_id: Uuid,
    line_item_id: Uuid,
) -> Result<bool, PurchaseAllocationError> {
    ensure_receipt_not_linked_to_locked_invoice_for_line_item(
        pool,
        receipt_id,
        "Cannot modify receipt line items linked to a locked invoice. Reopen linked invoice(s) first.",
    )
    .await?;

    let allocated = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(allocated_qty), 0)::INT
           FROM purchase_allocations
           WHERE receipt_line_item_id = $1"#,
        line_item_id
    )
    .fetch_one(pool)
    .await?
    .unwrap_or(0);

    if allocated > 0 {
        return Err(PurchaseAllocationError::Validation(
            "Cannot delete line item with existing allocations".to_string(),
        ));
    }

    let result = sqlx::query!(
        r#"DELETE FROM receipt_line_items WHERE id = $1 AND receipt_id = $2"#,
        line_item_id,
        receipt_id
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

pub async fn delete_purchase_allocation(
    pool: &PgPool,
    purchase_id: Uuid,
    allocation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    ensure_purchase_not_linked_to_locked_invoice(
        pool,
        purchase_id,
        "Cannot modify allocations for purchases on a locked invoice. Reopen the invoice first.",
    )
    .await?;

    let result = sqlx::query!(
        r#"DELETE FROM purchase_allocations WHERE id = $1 AND purchase_id = $2"#,
        allocation_id,
        purchase_id
    )
    .execute(pool)
    .await?;

    // Removing a final allocation can orphan a purchase if both direct links are null.
    let _ = delete_orphan_purchases(pool).await?;

    Ok(result.rows_affected() > 0)
}

pub async fn auto_allocate_purchase(
    pool: &PgPool,
    purchase_id: Uuid,
    allow_receipt_date_override: bool,
) -> Result<AutoAllocatePurchaseResult, PurchaseAllocationError> {
    ensure_purchase_not_linked_to_locked_invoice_for_allocation(
        pool,
        purchase_id,
        "Cannot modify allocations for purchases on a locked invoice. Reopen the invoice first.",
    )
    .await?;

    let mut tx = pool.begin().await?;

    let purchase = sqlx::query!(
        r#"SELECT
              p.id,
              p.item_id,
              p.quantity,
              p.allow_receipt_date_override,
                  inv.invoice_date AS "invoice_date?"
           FROM purchases p
           LEFT JOIN invoices inv ON inv.id = p.invoice_id
           WHERE p.id = $1"#,
        purchase_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| PurchaseAllocationError::NotFound("Purchase not found".to_string()))?;

    let effective_allow_receipt_date_override =
        allow_receipt_date_override || purchase.allow_receipt_date_override;
    let invoice_date_cutoff = if effective_allow_receipt_date_override {
        None
    } else {
        purchase.invoice_date
    };

    let existing_allocations = sqlx::query!(
        r#"SELECT id, receipt_id, allocated_qty
           FROM purchase_allocations
           WHERE purchase_id = $1"#,
        purchase_id
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut existing_by_receipt: HashMap<Uuid, (Uuid, i32)> = existing_allocations
        .iter()
        .map(|row| (row.receipt_id, (row.id, row.allocated_qty)))
        .collect();

    let previously_allocated_qty = existing_allocations
        .iter()
        .map(|row| row.allocated_qty)
        .sum::<i32>();
    let mut remaining_qty = (purchase.quantity - previously_allocated_qty).max(0);
    let mut auto_allocated_qty = 0;
    let mut allocations_created = 0;
    let mut allocations_updated = 0;
    let mut touched_receipts: HashSet<Uuid> = HashSet::new();

    if remaining_qty > 0 {
        let candidates = sqlx::query!(
            r#"SELECT
                rli.id AS line_item_id,
                rli.receipt_id,
                rli.quantity AS "line_qty!: i32",
                rli.unit_cost,
                COALESCE(SUM(CASE WHEN pa.purchase_id <> $1 THEN pa.allocated_qty ELSE 0 END), 0)::INT
                    AS "allocated_by_others!: i32"
            FROM receipt_line_items rli
            JOIN receipts r ON r.id = rli.receipt_id
            LEFT JOIN purchase_allocations pa ON pa.receipt_line_item_id = rli.id
            WHERE rli.item_id = $2
                            AND ($3::date IS NULL OR r.receipt_date <= $3)
            GROUP BY rli.id, rli.receipt_id, rli.quantity, rli.unit_cost, r.receipt_date
            ORDER BY r.receipt_date ASC, rli.receipt_id ASC"#,
            purchase_id,
                        purchase.item_id,
                        invoice_date_cutoff
        )
        .fetch_all(&mut *tx)
        .await?;

        for candidate in candidates {
            if remaining_qty <= 0 {
                break;
            }

            let max_for_purchase_on_line =
                (candidate.line_qty - candidate.allocated_by_others).max(0);

            let (existing_allocation_id, existing_qty_on_receipt) = existing_by_receipt
                .get(&candidate.receipt_id)
                .map(|(allocation_id, qty)| (Some(*allocation_id), *qty))
                .unwrap_or((None, 0));

            let additional_capacity = (max_for_purchase_on_line - existing_qty_on_receipt).max(0);
            if additional_capacity <= 0 {
                continue;
            }

            let delta = remaining_qty.min(additional_capacity);
            if delta <= 0 {
                continue;
            }

            if let Some(allocation_id) = existing_allocation_id {
                let new_qty = existing_qty_on_receipt + delta;

                sqlx::query!(
                    r#"UPDATE purchase_allocations
                       SET receipt_line_item_id = $2,
                           allocated_qty = $3,
                           unit_cost = $4
                       WHERE id = $1"#,
                    allocation_id,
                    Some(candidate.line_item_id),
                    new_qty,
                    candidate.unit_cost
                )
                .execute(&mut *tx)
                .await?;

                existing_by_receipt.insert(candidate.receipt_id, (allocation_id, new_qty));
                allocations_updated += 1;
            } else {
                let created = sqlx::query!(
                    r#"INSERT INTO purchase_allocations (purchase_id, receipt_id, receipt_line_item_id, allocated_qty, unit_cost)
                       VALUES ($1, $2, $3, $4, $5)
                       RETURNING id"#,
                    purchase_id,
                    candidate.receipt_id,
                    Some(candidate.line_item_id),
                    delta,
                    candidate.unit_cost
                )
                .fetch_one(&mut *tx)
                .await?;

                existing_by_receipt.insert(candidate.receipt_id, (created.id, delta));
                allocations_created += 1;
            }

            auto_allocated_qty += delta;
            remaining_qty -= delta;
            touched_receipts.insert(candidate.receipt_id);
        }
    }

    if allow_receipt_date_override && !purchase.allow_receipt_date_override {
        sqlx::query!(
            r#"UPDATE purchases SET allow_receipt_date_override = TRUE WHERE id = $1"#,
            purchase_id
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let total_allocated_qty = previously_allocated_qty + auto_allocated_qty;
    let remaining_qty = (purchase.quantity - total_allocated_qty).max(0);
    let warning = if invoice_date_cutoff.is_some() && remaining_qty > 0 && auto_allocated_qty <= 0 {
        Some(no_eligible_receipts_before_invoice_warning(
            invoice_date_cutoff.expect("cutoff is_some checked"),
        ))
    } else {
        None
    };

    Ok(AutoAllocatePurchaseResult {
        purchase_id,
        purchase_qty: purchase.quantity,
        previously_allocated_qty,
        auto_allocated_qty,
        total_allocated_qty,
        remaining_qty,
        allocations_created,
        allocations_updated,
        receipts_touched: touched_receipts.len() as i32,
        warning,
    })
}

pub async fn create_purchase(
    pool: &PgPool,
    data: CreatePurchase,
    user_id: Uuid,
) -> Result<Purchase, sqlx::Error> {
    if data.invoice_id.is_none() && data.receipt_id.is_none() {
        return Err(purchase_link_required_error(
            "Purchase must be linked to at least one side (invoice or receipt).",
        ));
    }

    if let Some(invoice_id) = data.invoice_id {
        ensure_invoice_not_locked(
            pool,
            invoice_id,
            "Cannot create a purchase on a locked invoice. Reopen the invoice first.",
        )
        .await?;
    }

    let status = data.status.unwrap_or(DeliveryStatus::Pending);
    let invoice_unit_price = if data.invoice_id.is_some() {
        data.invoice_unit_price
    } else {
        None
    };

    let purchase = sqlx::query_as!(
        Purchase,
                    r#"INSERT INTO purchases (item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price, destination_id, status, delivery_date, notes, created_at, updated_at) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                                     COALESCE((SELECT invoice_date::timestamptz FROM invoices WHERE id = $2),
                                                        (SELECT receipt_date::timestamptz FROM receipts WHERE id = $3),
                                                        TIMESTAMPTZ '1970-01-01 00:00:00+00'),
                                     COALESCE((SELECT invoice_date::timestamptz FROM invoices WHERE id = $2),
                                                        (SELECT receipt_date::timestamptz FROM receipts WHERE id = $3),
                                                        TIMESTAMPTZ '1970-01-01 00:00:00+00')) 
              RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price,
                     destination_id, status as "status: DeliveryStatus", 
                     delivery_date, notes, created_at, updated_at"#,
        data.item_id,
        data.invoice_id,
        data.receipt_id,
        data.quantity,
        data.purchase_cost,
        invoice_unit_price,
        data.destination_id,
        status as DeliveryStatus,
        data.delivery_date,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "purchases",
        purchase.id,
        "create",
        None::<&Purchase>,
        Some(&purchase),
        user_id,
    )
    .await?;
    Ok(purchase)
}

pub async fn update_purchase(
    pool: &PgPool,
    id: Uuid,
    data: UpdatePurchase,
    user_id: Uuid,
) -> Result<Option<Purchase>, sqlx::Error> {
    let old = get_purchase_by_id(pool, id).await?;

    if let Some(ref old_purchase) = old {
        if let Some(old_invoice_id) = old_purchase.invoice_id {
            ensure_invoice_not_locked(
                pool,
                old_invoice_id,
                "Cannot modify a purchase linked to a locked invoice. Reopen the invoice first.",
            )
            .await?;
        }

        // Resolve nullable fields: explicit clear wins, then new value, then keep existing
        let invoice_id = if data.clear_invoice {
            None
        } else {
            data.invoice_id.or(old_purchase.invoice_id)
        };

        if let Some(next_invoice_id) = invoice_id {
            if Some(next_invoice_id) != old_purchase.invoice_id {
                ensure_invoice_not_locked(
                    pool,
                    next_invoice_id,
                    "Cannot link a purchase to a locked invoice. Reopen the invoice first.",
                )
                .await?;
            }
        }

        let receipt_id = if data.clear_receipt {
            None
        } else {
            data.receipt_id.or(old_purchase.receipt_id)
        };

        let has_allocation_link = purchase_has_allocation_links(pool, id).await?;
        if invoice_id.is_none() && receipt_id.is_none() && !has_allocation_link {
            return Err(purchase_link_required_error(
                "Purchase must remain linked to at least one side (invoice or receipt).",
            ));
        }

        let invoice_unit_price = if invoice_id.is_some() {
            if data.clear_invoice_unit_price {
                None
            } else {
                data.invoice_unit_price.or(old_purchase.invoice_unit_price)
            }
        } else {
            None
        };
        // Receipt-linked purchases must derive item/qty/cost from receipt lines + allocations.
        // Keep these immutable here to prevent drift between purchase and receipt truths.
        let receipt_link_locked = receipt_id.is_some();
        let item_id = if receipt_link_locked {
            old_purchase.item_id
        } else {
            data.item_id.unwrap_or(old_purchase.item_id)
        };
        let quantity = if receipt_link_locked {
            old_purchase.quantity
        } else {
            data.quantity.unwrap_or(old_purchase.quantity)
        };
        let purchase_cost = if receipt_link_locked {
            old_purchase.purchase_cost
        } else {
            data.purchase_cost.unwrap_or(old_purchase.purchase_cost)
        };
        let destination_id = data.destination_id.or(old_purchase.destination_id);
        let status = data.status.unwrap_or(old_purchase.status.clone());
        let delivery_date = data.delivery_date.or(old_purchase.delivery_date);
        let notes = data.notes.or(old_purchase.notes.clone());

        let purchase = sqlx::query_as!(
            Purchase,
            r#"UPDATE purchases SET 
                item_id = $2,
                invoice_id = $3,
                receipt_id = $4,
                quantity = $5,
                purchase_cost = $6,
                invoice_unit_price = $7,
                destination_id = $8,
                status = $9,
                delivery_date = $10,
                notes = $11
               WHERE id = $1 
               RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price,
                         destination_id, status as "status: DeliveryStatus", 
                         delivery_date, notes, created_at, updated_at"#,
            id,
            item_id,
            invoice_id,
            receipt_id,
            quantity,
            purchase_cost,
            invoice_unit_price,
            destination_id,
            status as DeliveryStatus,
            delivery_date,
            notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref p) = purchase {
            AuditService::log(
                pool,
                "purchases",
                id,
                "update",
                Some(old_purchase),
                Some(p),
                user_id,
            )
            .await?;
        }
        return Ok(purchase);
    }
    Ok(None)
}

pub async fn update_purchase_status(
    pool: &PgPool,
    id: Uuid,
    status: DeliveryStatus,
    user_id: Uuid,
) -> Result<Option<Purchase>, sqlx::Error> {
    let old = get_purchase_by_id(pool, id).await?;

    if let Some(ref old_purchase) = old {
        if let Some(old_invoice_id) = old_purchase.invoice_id {
            ensure_invoice_not_locked(
                pool,
                old_invoice_id,
                "Cannot modify a purchase linked to a locked invoice. Reopen the invoice first.",
            )
            .await?;
        }

        let purchase = sqlx::query_as!(
            Purchase,
            r#"UPDATE purchases SET status = $2
               WHERE id = $1 
               RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, invoice_unit_price,
                         destination_id, status as "status: DeliveryStatus", 
                         delivery_date, notes, created_at, updated_at"#,
            id,
            status as DeliveryStatus
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref p) = purchase {
            AuditService::log(
                pool,
                "purchases",
                id,
                "update",
                Some(old_purchase),
                Some(p),
                user_id,
            )
            .await?;
        }
        return Ok(purchase);
    }
    Ok(None)
}

pub async fn delete_purchase(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_purchase_by_id(pool, id).await?;

    if let Some(ref old_purchase) = old {
        if let Some(old_invoice_id) = old_purchase.invoice_id {
            ensure_invoice_not_locked(
                pool,
                old_invoice_id,
                "Cannot delete a purchase linked to a locked invoice. Reopen the invoice first.",
            )
            .await?;
        }
    }

    let result = sqlx::query!(r#"DELETE FROM purchases WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref p) = old {
            AuditService::log(
                pool,
                "purchases",
                id,
                "delete",
                Some(p),
                None::<&Purchase>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn get_purchase_economics(
    pool: &PgPool,
    query: PurchaseQuery,
) -> Result<Vec<PurchaseEconomics>, sqlx::Error> {
    sqlx::query_as!(
        PurchaseEconomics,
        r#"SELECT 
            pe.purchase_id as "purchase_id!",
            pe.purchase_date as "purchase_date!",
            pe.item_id as "item_id!",
            pe.item_name as "item_name!",
            pe.vendor_name,
            pe.destination_code,
            pe.quantity as "quantity!",
            pe.purchase_cost as "purchase_cost!",
            pe.total_cost,
            pe.invoice_unit_price,
            pe.total_selling,
            pe.unit_commission,
            pe.total_commission,
            pe.tax_paid,
            pe.tax_owed,
            pe.status as "status!: DeliveryStatus",
            pe.delivery_date,
            pe.invoice_id,
            pe.receipt_id,
            pe.receipt_number,
            pe.invoice_number,
            p.allow_receipt_date_override AS "allow_receipt_date_override!",
            pe.notes
        FROM v_purchase_economics pe
        JOIN purchases p ON p.id = pe.purchase_id
        LEFT JOIN receipts r ON r.id = p.receipt_id
        WHERE ($1::delivery_status IS NULL OR pe.status = $1)
          AND ($2::uuid IS NULL OR p.destination_id = $2)
          AND ($3::uuid IS NULL OR r.vendor_id = $3)
          AND ($4::date IS NULL OR pe.purchase_date >= $4::date)
          AND ($5::date IS NULL OR pe.purchase_date <= $5::date)
        ORDER BY pe.purchase_date DESC
        LIMIT COALESCE($6, 100)
        OFFSET COALESCE($7, 0)"#,
        query.status as Option<DeliveryStatus>,
        query.destination_id,
        query.vendor_id,
        query.from,
        query.to,
        query.limit,
        query.offset
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Users (for auth)
// ============================================

pub async fn get_user_by_username(
    pool: &PgPool,
    username: &str,
) -> Result<Option<User>, sqlx::Error> {
    sqlx::query_as!(
        User,
        r#"SELECT id, username, password_hash, is_active, created_at, updated_at
           FROM users WHERE username = $1 AND is_active = TRUE"#,
        username
    )
    .fetch_optional(pool)
    .await
}

#[allow(dead_code)]
pub async fn get_user_by_id(pool: &PgPool, id: Uuid) -> Result<Option<User>, sqlx::Error> {
    sqlx::query_as!(
        User,
        r#"SELECT id, username, password_hash, is_active, created_at, updated_at
           FROM users WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_user(
    pool: &PgPool,
    username: &str,
    password_hash: &str,
) -> Result<User, sqlx::Error> {
    sqlx::query_as!(
        User,
        r#"INSERT INTO users (username, password_hash) VALUES ($1, $2)
           RETURNING id, username, password_hash, is_active, created_at, updated_at"#,
        username,
        password_hash
    )
    .fetch_one(pool)
    .await
}

// ============================================
// Audit Log
// ============================================

#[allow(dead_code)]
pub async fn get_audit_logs(
    pool: &PgPool,
    query: AuditQuery,
) -> Result<Vec<AuditLog>, sqlx::Error> {
    sqlx::query_as!(
        AuditLog,
        r#"SELECT id, table_name, record_id, operation, old_data, new_data, user_id, created_at
           FROM audit_log
           WHERE ($1::text IS NULL OR table_name = $1)
             AND ($2::uuid IS NULL OR record_id = $2)
           ORDER BY created_at DESC
           LIMIT COALESCE($3, 100)
           OFFSET COALESCE($4, 0)"#,
        query.table_name,
        query.record_id,
        query.limit,
        query.offset
    )
    .fetch_all(pool)
    .await
}

pub async fn get_receipt_metadata_audit(
    pool: &PgPool,
    receipt_id: Uuid,
    limit: Option<i32>,
) -> Result<Vec<ReceiptMetadataAuditEntry>, sqlx::Error> {
    sqlx::query_as!(
        ReceiptMetadataAuditEntry,
        r#"SELECT
              id,
              record_id AS "receipt_id!",
              operation,
              old_data -> 'ingestion_metadata' AS old_ingestion_metadata,
              new_data -> 'ingestion_metadata' AS new_ingestion_metadata,
              user_id,
              created_at
           FROM audit_log
           WHERE table_name = 'receipts'
             AND record_id = $1
             AND (
                 operation = 'create'
                 OR old_data -> 'ingestion_metadata' IS DISTINCT FROM new_data -> 'ingestion_metadata'
             )
           ORDER BY created_at DESC
           LIMIT COALESCE($2, 50)"#,
        receipt_id,
        limit
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Receipts
// ============================================

pub async fn get_all_receipts(pool: &PgPool) -> Result<Vec<Receipt>, sqlx::Error> {
    sqlx::query_as!(
        Receipt,
        r#"SELECT id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total,
                payment_method,
          ingestion_metadata,
                  notes, created_at, updated_at
           FROM receipts ORDER BY receipt_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_receipt_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Receipt>, sqlx::Error> {
    sqlx::query_as!(
        Receipt,
        r#"SELECT id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total,
                  payment_method,
                  ingestion_metadata,
                  notes, created_at, updated_at
           FROM receipts WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_receipt(
    pool: &PgPool,
    data: CreateReceipt,
    user_id: Uuid,
) -> Result<Receipt, sqlx::Error> {
    let ingestion_metadata = Some(data.ingestion_metadata.unwrap_or_else(|| {
        json!({
            "source": "manual",
            "auto_parsed": false,
            "ingestion_version": "manual-v1"
        })
    }));

    let (tax_rate, total) = if let Some(tax_amount) = data.tax_amount {
        let rate = if data.subtotal == Decimal::ZERO {
            Decimal::ZERO
        } else {
            (tax_amount * Decimal::new(100, 0)) / data.subtotal
        };
        (rate, data.subtotal + tax_amount)
    } else {
        let rate = data.tax_rate.unwrap_or(Decimal::new(1300, 2)); // 13.00 fallback
        let computed_total = data.subtotal * (Decimal::ONE + rate / Decimal::new(100, 0));
        (rate, computed_total)
    };
    let provided_number = data
        .receipt_number
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let receipt_number = if let Some(number) = provided_number {
        number
    } else {
        generate_unique_receipt_number(pool, data.vendor_id).await?
    };

    let receipt = sqlx::query_as!(
        Receipt,
        r#"INSERT INTO receipts (vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total, payment_method, ingestion_metadata, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total,
                     payment_method,
                     ingestion_metadata,
                     notes, created_at, updated_at"#,
        data.vendor_id,
        receipt_number,
        data.receipt_date,
        data.subtotal,
        tax_rate,
        total,
        data.payment_method,
        ingestion_metadata,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "receipts",
        receipt.id,
        "create",
        None::<&Receipt>,
        Some(&receipt),
        user_id,
    )
    .await?;
    Ok(receipt)
}

async fn generate_unique_receipt_number(
    pool: &PgPool,
    vendor_id: Uuid,
) -> Result<String, sqlx::Error> {
    let vendor = get_vendor_by_id(pool, vendor_id).await?;
    let vendor_prefix = vendor
        .as_ref()
        .and_then(|v| {
            v.short_id
                .clone()
                .or_else(|| derive_vendor_short_id(&v.name))
        })
        .unwrap_or_else(|| "VND".to_string());

    loop {
        let candidate = format!("{}-{}", vendor_prefix, Uuid::new_v4().simple());
        let exists = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM receipts WHERE receipt_number = $1)"#,
            candidate
        )
        .fetch_one(pool)
        .await?
        .unwrap_or(false);

        if !exists {
            return Ok(candidate);
        }
    }
}

fn normalize_vendor_short_id(value: &str) -> Option<String> {
    let normalized: String = value
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>()
        .to_uppercase();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_import_alias(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn derive_vendor_short_id(name: &str) -> Option<String> {
    let mut built = String::new();
    for part in name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|p| !p.is_empty())
    {
        let chunk: String = part.chars().take(3).collect();
        built.push_str(&chunk.to_uppercase());
        if built.len() >= 12 {
            break;
        }
    }

    if built.is_empty() {
        Some("VND".to_string())
    } else {
        Some(built.chars().take(12).collect())
    }
}

pub async fn update_receipt(
    pool: &PgPool,
    id: Uuid,
    data: UpdateReceipt,
    user_id: Uuid,
) -> Result<Option<Receipt>, sqlx::Error> {
    let old = get_receipt_by_id(pool, id).await?;

    if let Some(ref old_receipt) = old {
        ensure_receipt_not_linked_to_locked_invoice(
            pool,
            id,
            "Cannot modify a receipt linked to a locked invoice. Reopen linked invoice(s) first.",
        )
        .await?;

        let vendor_id = data.vendor_id.unwrap_or(old_receipt.vendor_id);
        let receipt_number = data
            .receipt_number
            .clone()
            .unwrap_or_else(|| old_receipt.receipt_number.clone());
        let receipt_date = data.receipt_date.unwrap_or(old_receipt.receipt_date);
        let subtotal = data.subtotal.unwrap_or(old_receipt.subtotal);
        let notes = data.notes.clone().or(old_receipt.notes.clone());
        let payment_method = data
            .payment_method
            .clone()
            .or(old_receipt.payment_method.clone());
        let ingestion_metadata = data
            .ingestion_metadata
            .or_else(|| old_receipt.ingestion_metadata.clone());

        let (tax_rate, total) = if let Some(tax_amount) = data.tax_amount {
            let rate = if subtotal == Decimal::ZERO {
                Decimal::ZERO
            } else {
                (tax_amount * Decimal::new(100, 0)) / subtotal
            };
            (rate, subtotal + tax_amount)
        } else {
            let rate = data.tax_rate.unwrap_or(old_receipt.tax_rate);
            (
                rate,
                subtotal * (Decimal::ONE + rate / Decimal::new(100, 0)),
            )
        };

        let receipt = sqlx::query_as!(
            Receipt,
            r#"UPDATE receipts SET 
                vendor_id = $2,
                receipt_number = $3,
                receipt_date = $4,
                subtotal = $5,
                tax_rate = $6,
                total = $7,
                payment_method = $8,
                ingestion_metadata = $9,
                notes = $10
               WHERE id = $1 
               RETURNING id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total,
                         payment_method,
                         ingestion_metadata,
                         notes, created_at, updated_at"#,
            id,
            vendor_id,
            receipt_number,
            receipt_date,
            subtotal,
            tax_rate,
            total,
            payment_method,
            ingestion_metadata,
            notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref r) = receipt {
            AuditService::log(
                pool,
                "receipts",
                id,
                "update",
                Some(old_receipt),
                Some(r),
                user_id,
            )
            .await?;
        }
        return Ok(receipt);
    }
    Ok(None)
}

pub async fn delete_receipt(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_receipt_by_id(pool, id).await?;

    if old.is_some() {
        ensure_receipt_not_linked_to_locked_invoice(
            pool,
            id,
            "Cannot delete a receipt linked to a locked invoice. Reopen linked invoice(s) first.",
        )
        .await?;
    }

    // Unlink purchases that reference this receipt (SET NULL, not delete)
    sqlx::query!(
        r#"UPDATE purchases SET receipt_id = NULL WHERE receipt_id = $1"#,
        id
    )
    .execute(pool)
    .await?;

    let result = sqlx::query!(r#"DELETE FROM receipts WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    // Keep purchase invariant: invoice OR receipt/allocations must exist.
    let _ = delete_orphan_purchases(pool).await?;

    if result.rows_affected() > 0 {
        if let Some(ref r) = old {
            AuditService::log(
                pool,
                "receipts",
                id,
                "delete",
                Some(r),
                None::<&Receipt>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn save_receipt_pdf(
    pool: &PgPool,
    id: Uuid,
    pdf_data: &[u8],
    filename: &str,
) -> Result<bool, sqlx::Error> {
    ensure_receipt_not_linked_to_locked_invoice(
        pool,
        id,
        "Cannot update documents for a receipt linked to a locked invoice. Reopen linked invoice(s) first.",
    )
    .await?;

    let result = sqlx::query!(
        r#"UPDATE receipts SET original_pdf = $2, original_filename = $3 WHERE id = $1"#,
        id,
        pdf_data,
        filename
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_receipt_pdf(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<(Vec<u8>, String)>, sqlx::Error> {
    let row = sqlx::query!(
        r#"SELECT original_pdf, original_filename FROM receipts WHERE id = $1 AND original_pdf IS NOT NULL"#,
        id
    )
    .fetch_optional(pool)
    .await?;

    Ok(
        row.and_then(|r| match (r.original_pdf, r.original_filename) {
            (Some(pdf), Some(name)) => Some((pdf, name)),
            (Some(pdf), None) => Some((pdf, "receipt.pdf".to_string())),
            _ => None,
        }),
    )
}

pub async fn get_receipt_with_vendor(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<ReceiptWithVendor>, sqlx::Error> {
    sqlx::query_as!(
        ReceiptWithVendor,
        r#"SELECT 
            r.id,
            r.vendor_id,
            v.name AS vendor_name,
            r.receipt_number,
            r.receipt_date,
            r.subtotal,
            r.tax_rate,
            r.total,
            r.payment_method,
            r.ingestion_metadata,
            (r.original_pdf IS NOT NULL) AS has_pdf,
            r.notes,
            r.created_at,
            r.updated_at,
            (SELECT COUNT(*)::BIGINT FROM receipt_line_items rli WHERE rli.receipt_id = r.id) AS "receipt_line_item_count!",
                        COUNT(DISTINCT p.id) AS purchase_count,
                        COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * p.purchase_cost ELSE 0 END), 0) AS purchases_total,
                        COALESCE(SUM(pa.allocated_qty * COALESCE(p.invoice_unit_price, 0)), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * COALESCE(p.invoice_unit_price, 0) ELSE 0 END), 0) AS total_selling,
                        COALESCE(SUM(pa.allocated_qty * (COALESCE(p.invoice_unit_price, pa.unit_cost) - pa.unit_cost)), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost) ELSE 0 END), 0) AS total_commission,
                        COUNT(DISTINCT p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AS invoiced_count
        FROM receipts r
        JOIN vendors v ON v.id = r.vendor_id
                LEFT JOIN purchase_allocations pa ON pa.receipt_id = r.id
                LEFT JOIN purchases p ON p.id = pa.purchase_id OR (pa.id IS NULL AND p.receipt_id = r.id)
        WHERE r.id = $1
           GROUP BY r.id, r.vendor_id, v.name, r.receipt_number, r.receipt_date, r.subtotal, r.tax_rate, r.total,
                             r.payment_method, r.ingestion_metadata,
                 r.original_pdf, r.notes, r.created_at, r.updated_at"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn get_receipts_with_vendor(
    pool: &PgPool,
) -> Result<Vec<ReceiptWithVendor>, sqlx::Error> {
    sqlx::query_as!(
        ReceiptWithVendor,
        r#"SELECT 
            r.id,
            r.vendor_id,
            v.name AS vendor_name,
            r.receipt_number,
            r.receipt_date,
            r.subtotal,
            r.tax_rate,
            r.total,
            r.payment_method,
            r.ingestion_metadata,
            (r.original_pdf IS NOT NULL) AS has_pdf,
            r.notes,
            r.created_at,
            r.updated_at,
            (SELECT COUNT(*)::BIGINT FROM receipt_line_items rli WHERE rli.receipt_id = r.id) AS "receipt_line_item_count!",
                        COUNT(DISTINCT p.id) AS purchase_count,
                        COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * p.purchase_cost ELSE 0 END), 0) AS purchases_total,
                        COALESCE(SUM(pa.allocated_qty * COALESCE(p.invoice_unit_price, 0)), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * COALESCE(p.invoice_unit_price, 0) ELSE 0 END), 0) AS total_selling,
                        COALESCE(SUM(pa.allocated_qty * (COALESCE(p.invoice_unit_price, pa.unit_cost) - pa.unit_cost)), 0)
                            + COALESCE(SUM(CASE WHEN pa.id IS NULL THEN p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost) ELSE 0 END), 0) AS total_commission,
                        COUNT(DISTINCT p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AS invoiced_count
        FROM receipts r
        JOIN vendors v ON v.id = r.vendor_id
                LEFT JOIN purchase_allocations pa ON pa.receipt_id = r.id
                LEFT JOIN purchases p ON p.id = pa.purchase_id OR (pa.id IS NULL AND p.receipt_id = r.id)
        GROUP BY r.id, r.vendor_id, v.name, r.receipt_number, r.receipt_date, r.subtotal, r.tax_rate, r.total,
             r.payment_method, r.ingestion_metadata,
                 r.original_pdf, r.notes, r.created_at, r.updated_at
        ORDER BY r.receipt_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_purchases_by_receipt(
    pool: &PgPool,
    receipt_id: Uuid,
) -> Result<Vec<PurchaseEconomics>, ReceiptReconciliationError> {
    sqlx::query_as!(
        PurchaseEconomics,
        r#"WITH allocation_rows AS (
               SELECT
                   p.id AS purchase_id,
                   COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS purchase_date,
                   p.item_id,
                   i.name AS item_name,
                   v.name AS vendor_name,
                   d.code AS destination_code,
                   pa.allocated_qty AS quantity,
                   pa.unit_cost AS purchase_cost,
                   (pa.allocated_qty * pa.unit_cost) AS total_cost,
                   p.invoice_unit_price,
                   (pa.allocated_qty * p.invoice_unit_price) AS total_selling,
                   (COALESCE(p.invoice_unit_price, pa.unit_cost) - pa.unit_cost) AS unit_commission,
                   (pa.allocated_qty * (COALESCE(p.invoice_unit_price, pa.unit_cost) - pa.unit_cost)) AS total_commission,
                   (pa.allocated_qty * pa.unit_cost * 0.13) AS tax_paid,
                   (pa.allocated_qty * (COALESCE(p.invoice_unit_price, pa.unit_cost) - pa.unit_cost) * 0.13) AS tax_owed,
                   p.status,
                   p.delivery_date,
                   p.invoice_id,
                   r.id AS receipt_id,
                   r.receipt_number,
                   inv.invoice_number,
                   p.allow_receipt_date_override,
                   p.notes,
                   p.created_at AS sort_created_at
               FROM purchase_allocations pa
               JOIN purchases p ON p.id = pa.purchase_id
               JOIN items i ON i.id = p.item_id
               JOIN receipts r ON r.id = pa.receipt_id
               JOIN vendors v ON v.id = r.vendor_id
               LEFT JOIN destinations d ON d.id = p.destination_id
               LEFT JOIN invoices inv ON inv.id = p.invoice_id
               LEFT JOIN receipt_line_items rli ON rli.id = pa.receipt_line_item_id
               WHERE pa.receipt_id = $1
                 AND (
                     pa.receipt_line_item_id IS NULL
                     OR rli.id IS NULL
                     OR rli.item_id IS DISTINCT FROM p.item_id
                 ) IS NOT TRUE
           ),
           direct_rows AS (
               SELECT
                   p.id AS purchase_id,
                   COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS purchase_date,
                   p.item_id,
                   i.name AS item_name,
                   v.name AS vendor_name,
                   d.code AS destination_code,
                   p.quantity AS quantity,
                   p.purchase_cost AS purchase_cost,
                   (p.quantity * p.purchase_cost) AS total_cost,
                   p.invoice_unit_price,
                   (p.quantity * p.invoice_unit_price) AS total_selling,
                   (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost) AS unit_commission,
                   (p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost)) AS total_commission,
                   (p.quantity * p.purchase_cost * 0.13) AS tax_paid,
                   (p.quantity * (COALESCE(p.invoice_unit_price, p.purchase_cost) - p.purchase_cost) * 0.13) AS tax_owed,
                   p.status,
                   p.delivery_date,
                   p.invoice_id,
                   r.id AS receipt_id,
                   r.receipt_number,
                   inv.invoice_number,
                   p.allow_receipt_date_override,
                   p.notes,
                   p.created_at AS sort_created_at
               FROM purchases p
               JOIN receipts r ON r.id = p.receipt_id
               JOIN items i ON i.id = p.item_id
               JOIN vendors v ON v.id = r.vendor_id
               LEFT JOIN destinations d ON d.id = p.destination_id
               LEFT JOIN invoices inv ON inv.id = p.invoice_id
               WHERE p.receipt_id = $1
                 AND NOT EXISTS (
                     SELECT 1
                     FROM purchase_allocations pa
                     WHERE pa.purchase_id = p.id
                       AND pa.receipt_id = $1
                 )
           )
           SELECT
               c.purchase_id AS "purchase_id!",
               c.purchase_date AS "purchase_date!",
               c.item_id AS "item_id!",
               c.item_name AS "item_name!",
               c.vendor_name,
               c.destination_code,
               c.quantity AS "quantity!",
               c.purchase_cost AS "purchase_cost!",
               c.total_cost,
               c.invoice_unit_price,
               c.total_selling,
               c.unit_commission,
               c.total_commission,
               c.tax_paid,
               c.tax_owed,
               c.status AS "status!: DeliveryStatus",
               c.delivery_date,
               c.invoice_id,
               c.receipt_id AS "receipt_id?",
               c.receipt_number AS "receipt_number?",
               c.invoice_number AS "invoice_number?",
               c.allow_receipt_date_override AS "allow_receipt_date_override!",
               c.notes
           FROM (
               SELECT * FROM allocation_rows
               UNION ALL
               SELECT * FROM direct_rows
           ) c
           ORDER BY c.sort_created_at DESC"#,
        receipt_id
    )
    .fetch_all(pool)
    .await
    .map_err(ReceiptReconciliationError::Sql)
}

pub async fn get_purchases_by_item(
    pool: &PgPool,
    item_id: Uuid,
) -> Result<Vec<PurchaseEconomics>, sqlx::Error> {
    sqlx::query_as!(
        PurchaseEconomics,
        r#"WITH allocation_summary AS (
               SELECT
                   pa.purchase_id,
                   (ARRAY_AGG(DISTINCT pa.receipt_id))[1] AS any_receipt_id,
                   COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                   COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
               FROM purchase_allocations pa
               GROUP BY pa.purchase_id
           ),
           purchase_rows AS (
               SELECT
                   p.id AS purchase_id,
                   p.item_id,
                   p.quantity,
                   p.invoice_unit_price,
                   p.status,
                   p.delivery_date,
                   p.invoice_id,
                   COALESCE(p.receipt_id, alloc.any_receipt_id) AS resolved_receipt_id,
                   p.destination_id,
                   p.allow_receipt_date_override,
                   p.notes,
                   p.created_at,
                   CASE
                       WHEN alloc.allocated_qty = p.quantity
                            AND alloc.allocated_qty > 0
                            AND p.quantity > 0
                       THEN alloc.allocated_total_cost / p.quantity::numeric
                       ELSE p.purchase_cost
                   END AS effective_purchase_cost
               FROM purchases p
               LEFT JOIN allocation_summary alloc ON alloc.purchase_id = p.id
                             WHERE p.item_id = $1
                                 AND (
                                         p.invoice_id IS NOT NULL
                                         OR p.receipt_id IS NOT NULL
                                         OR alloc.any_receipt_id IS NOT NULL
                                 )
           )
           SELECT
               pr.purchase_id AS "purchase_id!",
               COALESCE(inv.invoice_date::timestamptz, r.receipt_date::timestamptz, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS "purchase_date!",
               pr.item_id AS "item_id!",
               COALESCE(i.name, '(deleted item)') AS "item_name!",
               v.name AS "vendor_name?",
               d.code AS "destination_code?",
               pr.quantity AS "quantity!",
               pr.effective_purchase_cost AS "purchase_cost!",
               (pr.quantity * pr.effective_purchase_cost) AS total_cost,
               pr.invoice_unit_price,
               (pr.quantity * pr.invoice_unit_price) AS total_selling,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost)
               END AS unit_commission,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (pr.quantity * (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost))
               END AS total_commission,
               (pr.quantity * pr.effective_purchase_cost * 0.13) AS tax_paid,
               CASE
                   WHEN pr.effective_purchase_cost = 0 THEN NULL
                   ELSE (pr.quantity * (COALESCE(pr.invoice_unit_price, pr.effective_purchase_cost) - pr.effective_purchase_cost) * 0.13)
               END AS tax_owed,
               pr.status AS "status!: DeliveryStatus",
               pr.delivery_date,
               pr.invoice_id,
               pr.resolved_receipt_id AS "receipt_id?",
               r.receipt_number AS "receipt_number?",
               inv.invoice_number AS "invoice_number?",
               pr.allow_receipt_date_override AS "allow_receipt_date_override!",
               pr.notes
           FROM purchase_rows pr
           LEFT JOIN items i ON i.id = pr.item_id
           LEFT JOIN receipts r ON r.id = pr.resolved_receipt_id
           LEFT JOIN vendors v ON v.id = r.vendor_id
           LEFT JOIN destinations d ON d.id = pr.destination_id
           LEFT JOIN invoices inv ON inv.id = pr.invoice_id
           ORDER BY pr.created_at DESC"#,
        item_id
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Reports
// ============================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct ProfitReport {
    pub total_cost: Option<Decimal>,
    pub total_revenue: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub total_tax_paid: Option<Decimal>,
    pub total_tax_owed: Option<Decimal>,
    pub purchase_count: Option<i64>,
    pub item_count: Option<i64>,
}

pub async fn get_profit_report(
    pool: &PgPool,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
) -> Result<ProfitReport, sqlx::Error> {
    sqlx::query_as!(
        ProfitReport,
                r#"WITH allocation_totals AS (
                        SELECT
                            pa.purchase_id,
                            COALESCE(SUM(pa.allocated_qty), 0)::INT AS allocated_qty,
                            COALESCE(SUM(pa.allocated_qty * pa.unit_cost), 0::numeric) AS allocated_total_cost
                        FROM purchase_allocations pa
                        GROUP BY pa.purchase_id
                ),
                finalized_purchases AS (
                        SELECT
                                p.id AS purchase_id,
                                inv.invoice_date::timestamptz AS purchase_date,
                                p.quantity,
                                p.invoice_unit_price,
                                CASE
                                    WHEN at.allocated_qty = p.quantity
                                         AND at.allocated_qty > 0
                                         AND p.quantity > 0
                                    THEN at.allocated_total_cost / p.quantity::numeric
                                    ELSE p.purchase_cost
                                END AS effective_purchase_cost
                        FROM purchases p
                        JOIN invoices inv ON inv.id = p.invoice_id
                        LEFT JOIN allocation_totals at ON at.purchase_id = p.id
                        WHERE p.invoice_id IS NOT NULL
                            AND p.invoice_unit_price IS NOT NULL
                            AND p.destination_id IS NOT NULL
                            AND inv.reconciliation_state = 'locked'
                )
                SELECT
                        SUM(quantity * effective_purchase_cost) as total_cost,
                        SUM(quantity * invoice_unit_price) as total_revenue,
                        SUM(quantity * (invoice_unit_price - effective_purchase_cost)) as total_commission,
                        SUM(quantity * effective_purchase_cost * 0.13) as total_tax_paid,
                        SUM(quantity * (invoice_unit_price - effective_purchase_cost) * 0.13) as total_tax_owed,
                        COUNT(*) as purchase_count,
                        COUNT(DISTINCT purchase_id) as item_count
                FROM finalized_purchases
                WHERE ($1::date IS NULL OR purchase_date >= $1::date)
                    AND ($2::date IS NULL OR purchase_date <= $2::date)"#,
        from,
        to
    )
    .fetch_one(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn invoice_unlink_sql_clears_invoice_unit_price() {
        assert!(
            UNLINK_PURCHASES_FOR_INVOICE_SQL.contains("invoice_id = NULL"),
            "Invoice unlink SQL must clear invoice_id"
        );
        assert!(
            UNLINK_PURCHASES_FOR_INVOICE_SQL.contains("invoice_unit_price = NULL"),
            "Invoice unlink SQL must clear invoice_unit_price"
        );
    }

    #[test]
    fn destination_unlink_sql_clears_invoice_unit_price() {
        assert!(
            UNLINK_PURCHASES_FOR_DESTINATION_INVOICES_SQL.contains("invoice_id = NULL"),
            "Destination unlink SQL must clear invoice_id"
        );
        assert!(
            UNLINK_PURCHASES_FOR_DESTINATION_INVOICES_SQL.contains("invoice_unit_price = NULL"),
            "Destination unlink SQL must clear invoice_unit_price"
        );
        assert!(
            UNLINK_PURCHASES_FOR_DESTINATION_INVOICES_SQL
                .contains("SELECT id FROM invoices WHERE destination_id = $1"),
            "Destination unlink SQL must target invoices in the destination"
        );
    }

    #[test]
    fn invoice_delete_sql_removes_allocations_for_linked_purchases() {
        assert!(
            DELETE_ALLOCATIONS_FOR_INVOICE_PURCHASES_SQL
                .contains("DELETE FROM purchase_allocations pa"),
            "Invoice delete SQL must remove allocation rows"
        );
        assert!(
            DELETE_ALLOCATIONS_FOR_INVOICE_PURCHASES_SQL.contains("USING purchases p"),
            "Invoice delete SQL must scope allocation deletion through purchases"
        );
        assert!(
            DELETE_ALLOCATIONS_FOR_INVOICE_PURCHASES_SQL.contains("p.invoice_id = $1"),
            "Invoice delete SQL must target allocations for the deleted invoice"
        );
    }

    #[test]
    fn upgrade_sql_backfills_stale_invoice_unit_price() {
        let upgrade_sql = include_str!("../../../migrations/upgrade.sql");
        assert!(
            upgrade_sql.contains("UPDATE purchases")
                && upgrade_sql.contains("SET invoice_unit_price = NULL")
                && upgrade_sql.contains("WHERE invoice_id IS NULL"),
            "Upgrade migration must backfill stale invoice_unit_price rows"
        );
    }

    #[test]
    fn invoice_reconciliation_state_includes_reopened_in_migrations() {
        let initial_schema = include_str!("../../../migrations/001_initial_schema.sql");
        let upgrade_sql = include_str!("../../../migrations/upgrade.sql");

        assert!(
            initial_schema.contains("'reopened'"),
            "Initial schema must allow reopened reconciliation_state"
        );
        assert!(
            upgrade_sql.contains("'reopened'"),
            "Upgrade migration must allow reopened reconciliation_state"
        );
    }

    #[test]
    fn orphan_purchase_cleanup_sql_targets_only_unlinked_rows_without_allocations() {
        assert!(
            DELETE_ORPHAN_PURCHASES_SQL.contains("invoice_id IS NULL"),
            "Orphan cleanup SQL must target invoice-unlinked purchases"
        );
        assert!(
            DELETE_ORPHAN_PURCHASES_SQL.contains("receipt_id IS NULL"),
            "Orphan cleanup SQL must target receipt-unlinked purchases"
        );
        assert!(
            DELETE_ORPHAN_PURCHASES_SQL
                .contains("NOT EXISTS (\n           SELECT 1 FROM purchase_allocations pa WHERE pa.purchase_id = p.id\n         )"),
            "Orphan cleanup SQL must preserve allocation-backed purchases"
        );
    }

    #[test]
    fn item_purchases_query_is_allocation_aware_and_not_reconciled_gated() {
        let source = include_str!("queries.rs");
        let start = source
            .find("pub async fn get_purchases_by_item(")
            .expect("get_purchases_by_item function must exist");
        let tail = &source[start..];
        let end = tail
            .find("// ============================================\n// Reports")
            .expect("reports section marker must exist after get_purchases_by_item");
        let item_query_fn = &tail[..end];

        assert!(
            item_query_fn.contains("WITH allocation_summary AS ("),
            "Item purchases query must aggregate allocation rows"
        );
        assert!(
            item_query_fn
                .contains("LEFT JOIN allocation_summary alloc ON alloc.purchase_id = p.id"),
            "Item purchases query must left join allocation summary"
        );
        assert!(
            item_query_fn
                .contains("COALESCE(p.receipt_id, alloc.any_receipt_id) AS resolved_receipt_id"),
            "Item purchases query must resolve receipt via allocations when direct link is null"
        );
        assert!(
            item_query_fn.contains("WHERE p.item_id = $1"),
            "Item purchases query must filter by item_id in purchase_rows"
        );
        assert!(
            item_query_fn.contains("p.invoice_id IS NOT NULL")
                && item_query_fn.contains("p.receipt_id IS NOT NULL")
                && item_query_fn.contains("alloc.any_receipt_id IS NOT NULL"),
            "Item purchases query must exclude standalone orphan purchases"
        );
        assert!(
            item_query_fn.contains("WHEN pr.effective_purchase_cost = 0 THEN NULL")
                && item_query_fn.contains("END AS total_commission"),
            "Item purchases query must suppress commission when cost is unknown/unset"
        );

        assert!(
            !item_query_fn.contains("reconciled_purchase_ids"),
            "Item purchases query must not reintroduce reconciled_purchase_ids gating"
        );
        assert!(
            !item_query_fn.contains("v_receipt_reconciliation"),
            "Item purchases query must not require receipt reconciliation gate"
        );
    }

    fn assert_locked_invoice_sql_error(err: &sqlx::Error) {
        let msg = locked_invoice_error_message(err)
            .expect("expected sqlx protocol error with locked invoice message");
        assert!(
            msg.to_lowercase().contains("locked"),
            "expected locked-invoice message, got: {msg}"
        );
    }

    fn assert_locked_invoice_validation_error(err: PurchaseAllocationError) {
        match err {
            PurchaseAllocationError::Validation(msg) => {
                assert!(
                    msg.to_lowercase().contains("locked"),
                    "expected locked-invoice validation message, got: {msg}"
                );
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    async fn test_pool() -> Option<PgPool> {
        let database_url = std::env::var("DATABASE_URL").ok()?;
        PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .ok()
    }

    async fn seed_purchase_with_receipt(
        pool: &PgPool,
    ) -> Result<(Uuid, Uuid, Uuid, Uuid, Uuid), sqlx::Error> {
        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, _invoice_id) =
            seed_purchase_with_receipt_and_state(pool, "open").await?;

        Ok((vendor_id, destination_id, item_id, receipt_id, purchase_id))
    }

    async fn seed_purchase_with_receipt_and_state(
        pool: &PgPool,
        reconciliation_state: &str,
    ) -> Result<(Uuid, Uuid, Uuid, Uuid, Uuid, Uuid), sqlx::Error> {
        let vendor_id = Uuid::new_v4();
        let destination_id = Uuid::new_v4();
        let item_id = Uuid::new_v4();
        let receipt_id = Uuid::new_v4();
        let invoice_id = Uuid::new_v4();
        let purchase_id = Uuid::new_v4();

        sqlx::query(r#"INSERT INTO vendors (id, name) VALUES ($1, $2)"#)
            .bind(vendor_id)
            .bind(format!("test-vendor-{}", vendor_id))
            .execute(pool)
            .await?;

        sqlx::query(r#"INSERT INTO destinations (id, code, name) VALUES ($1, $2, $3)"#)
            .bind(destination_id)
            .bind(format!("D{}", &destination_id.to_string()[..8]))
            .bind("Test Destination")
            .execute(pool)
            .await?;

        sqlx::query(r#"INSERT INTO items (id, name, default_destination_id) VALUES ($1, $2, $3)"#)
            .bind(item_id)
            .bind(format!("test-item-{}", item_id))
            .bind(destination_id)
            .execute(pool)
            .await?;

        sqlx::query(
            r#"INSERT INTO receipts (id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(receipt_id)
        .bind(vendor_id)
        .bind(format!("R{}", &receipt_id.to_string()[..10]))
        .bind(NaiveDate::from_ymd_opt(2026, 4, 14).unwrap())
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(1300, 2))
        .bind(Decimal::new(11300, 2))
        .execute(pool)
        .await?;

        sqlx::query(
                r#"INSERT INTO invoices (id, destination_id, invoice_number, invoice_date, subtotal, tax_rate, total, reconciliation_state)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
        )
        .bind(invoice_id)
        .bind(destination_id)
        .bind(format!("I{}", &invoice_id.to_string()[..10]))
        .bind(NaiveDate::from_ymd_opt(2026, 4, 14).unwrap())
        .bind(Decimal::new(12000, 2))
        .bind(Decimal::new(1300, 2))
        .bind(Decimal::new(13560, 2))
          .bind(reconciliation_state)
        .execute(pool)
        .await?;

        sqlx::query(
            r#"INSERT INTO purchases (id, item_id, receipt_id, invoice_id, quantity, purchase_cost, invoice_unit_price, destination_id, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'delivered')"#,
        )
        .bind(purchase_id)
        .bind(item_id)
        .bind(receipt_id)
        .bind(invoice_id)
        .bind(2_i32)
        .bind(Decimal::new(87999, 2))
        .bind(Decimal::new(89000, 2))
        .bind(destination_id)
        .execute(pool)
        .await?;

        Ok((
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
            invoice_id,
        ))
    }

    async fn create_receipt_for_seed(
        pool: &PgPool,
        vendor_id: Uuid,
        receipt_date: NaiveDate,
        subtotal: Decimal,
    ) -> Uuid {
        let receipt_id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO receipts (id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(receipt_id)
        .bind(vendor_id)
        .bind(format!("R{}", &receipt_id.to_string()[..10]))
        .bind(receipt_date)
        .bind(subtotal)
        .bind(Decimal::new(1300, 2))
        .bind(subtotal * Decimal::new(113, 2))
        .execute(pool)
        .await
        .expect("create receipt");

        receipt_id
    }

    async fn create_receipt_line_item_for_seed(
        pool: &PgPool,
        receipt_id: Uuid,
        item_id: Uuid,
        quantity: i32,
        unit_cost: Decimal,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO receipt_line_items (id, receipt_id, item_id, quantity, unit_cost, notes)
               VALUES ($1, $2, $3, $4, $5, 'test-line')"#,
        )
        .bind(id)
        .bind(receipt_id)
        .bind(item_id)
        .bind(quantity)
        .bind(unit_cost)
        .execute(pool)
        .await
        .expect("create receipt line item");
        id
    }

    async fn cleanup_seeded(
        pool: &PgPool,
        vendor_id: Uuid,
        destination_id: Uuid,
        item_id: Uuid,
        receipt_id: Uuid,
        purchase_id: Uuid,
    ) {
        let _ = sqlx::query(r#"DELETE FROM purchase_allocations WHERE purchase_id = $1"#)
            .bind(purchase_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM purchases WHERE id = $1"#)
            .bind(purchase_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM receipts WHERE id = $1"#)
            .bind(receipt_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM invoices WHERE destination_id = $1"#)
            .bind(destination_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM items WHERE id = $1"#)
            .bind(item_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM destinations WHERE id = $1"#)
            .bind(destination_id)
            .execute(pool)
            .await;
        let _ = sqlx::query(r#"DELETE FROM vendors WHERE id = $1"#)
            .bind(vendor_id)
            .execute(pool)
            .await;
    }

    #[tokio::test]
    async fn updating_receipt_number_does_not_mutate_linked_purchase() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");

        let _ = update_receipt(
            &pool,
            receipt_id,
            UpdateReceipt {
                vendor_id: None,
                receipt_number: Some(format!("RENAMED-{}", &receipt_id.to_string()[..8])),
                receipt_date: None,
                subtotal: None,
                tax_amount: None,
                tax_rate: None,
                payment_method: None,
                ingestion_metadata: None,
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("receipt update")
        .expect("receipt exists");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after")
            .expect("purchase exists after");

        assert_eq!(after.id, before.id);
        assert_eq!(after.item_id, before.item_id);
        assert_eq!(after.invoice_id, before.invoice_id);
        assert_eq!(after.receipt_id, before.receipt_id);
        assert_eq!(after.quantity, before.quantity);
        assert_eq!(after.purchase_cost, before.purchase_cost);
        assert_eq!(after.invoice_unit_price, before.invoice_unit_price);
        assert_eq!(after.destination_id, before.destination_id);
        assert_eq!(after.status, before.status);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn updating_receipt_totals_does_not_mutate_linked_purchase() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");

        let _ = update_receipt(
            &pool,
            receipt_id,
            UpdateReceipt {
                vendor_id: None,
                receipt_number: None,
                receipt_date: None,
                subtotal: Some(Decimal::new(999999, 2)),
                tax_amount: Some(Decimal::new(129999, 2)),
                tax_rate: None,
                payment_method: None,
                ingestion_metadata: None,
                notes: Some("edited receipt totals".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect("receipt update")
        .expect("receipt exists");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after")
            .expect("purchase exists after");

        assert_eq!(after.id, before.id);
        assert_eq!(after.item_id, before.item_id);
        assert_eq!(after.invoice_id, before.invoice_id);
        assert_eq!(after.receipt_id, before.receipt_id);
        assert_eq!(after.quantity, before.quantity);
        assert_eq!(after.purchase_cost, before.purchase_cost);
        assert_eq!(after.invoice_unit_price, before.invoice_unit_price);
        assert_eq!(after.destination_id, before.destination_id);
        assert_eq!(after.status, before.status);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn deleting_invoice_clears_linked_purchase_invoice_fields() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");

        let invoice_id = before
            .invoice_id
            .expect("seed purchase should be linked to an invoice");

        let deleted = delete_invoice(&pool, invoice_id, Uuid::new_v4())
            .await
            .expect("delete invoice should succeed");
        assert!(deleted, "invoice should be deleted");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after")
            .expect("purchase exists after");

        assert_eq!(after.invoice_id, None, "invoice link should be cleared");
        assert_eq!(
            after.invoice_unit_price, None,
            "invoice unit price should be cleared when invoice is unlinked"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn deleting_destination_clears_invoice_fields_on_linked_purchases() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");

        assert!(
            before.invoice_id.is_some(),
            "seed purchase should be linked to an invoice"
        );
        assert!(
            before.destination_id.is_some(),
            "seed purchase should be linked to a destination"
        );
        assert!(
            before.invoice_unit_price.is_some(),
            "seed purchase should have an invoice unit price"
        );

        let deleted = delete_destination(&pool, destination_id, Uuid::new_v4())
            .await
            .expect("delete destination should succeed");
        assert!(deleted, "destination should be deleted");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after")
            .expect("purchase exists after");

        assert_eq!(
            after.destination_id, None,
            "destination link should be cleared"
        );
        assert_eq!(after.invoice_id, None, "invoice link should be cleared");
        assert_eq!(
            after.invoice_unit_price, None,
            "invoice unit price should be cleared when invoice is unlinked"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn allocation_cannot_exceed_receipt_line_quantity() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            1,
            Decimal::new(87999, 2),
        )
        .await;

        let err = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect_err("should fail when allocation exceeds receipt line qty");

        match err {
            PurchaseAllocationError::Validation(msg) => {
                assert!(msg.contains("receipt line quantity"));
            }
            _ => panic!("expected validation error"),
        }

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn allocation_unit_cost_is_derived_from_receipt_line_item() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            3,
            Decimal::new(77777, 2),
        )
        .await;

        let allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("create allocation");

        assert_eq!(allocation.receipt_line_item_id, Some(line_item_id));
        assert_eq!(allocation.unit_cost, Decimal::new(77777, 2));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn allocation_rejects_receipt_after_invoice_without_override() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        sqlx::query(r#"UPDATE receipts SET receipt_date = $2 WHERE id = $1"#)
            .bind(receipt_id)
            .bind(NaiveDate::from_ymd_opt(2026, 4, 20).unwrap())
            .execute(&pool)
            .await
            .expect("set receipt date after invoice");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let err = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect_err("should reject allocations with receipt date after invoice date");

        match err {
            PurchaseAllocationError::Validation(msg) => {
                assert!(msg.contains("after invoice date"));
            }
            other => panic!("expected validation error, got {other:?}"),
        }

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn allocation_allows_receipt_after_invoice_with_override() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        sqlx::query(r#"UPDATE receipts SET receipt_date = $2 WHERE id = $1"#)
            .bind(receipt_id)
            .bind(NaiveDate::from_ymd_opt(2026, 4, 20).unwrap())
            .execute(&pool)
            .await
            .expect("set receipt date after invoice");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: true,
            },
        )
        .await
        .expect("override should allow late receipt allocation");

        assert_eq!(allocation.receipt_id, receipt_id);

        let persisted_override = sqlx::query_scalar!(
            r#"SELECT allow_receipt_date_override FROM purchases WHERE id = $1"#,
            purchase_id
        )
        .fetch_one(&pool)
        .await
        .expect("read purchase override flag");

        assert!(persisted_override, "override flag should persist on purchase");

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn receipt_summary_counts_receipt_lines_even_when_no_purchases_linked() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            3,
            Decimal::new(87999, 2),
        )
        .await;

        sqlx::query(r#"DELETE FROM purchase_allocations WHERE purchase_id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("delete allocations");

        sqlx::query(r#"DELETE FROM purchases WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("delete purchase");

        let summary = get_receipt_with_vendor(&pool, receipt_id)
            .await
            .expect("receipt summary should load")
            .expect("receipt should exist");

        assert_eq!(summary.receipt_line_item_count, 1);
        assert_eq!(summary.purchase_count, Some(0));

        let summaries = get_receipts_with_vendor(&pool)
            .await
            .expect("receipt summaries should load");

        let listed = summaries
            .iter()
            .find(|receipt| receipt.id == receipt_id)
            .expect("receipt should be present in list");

        assert_eq!(listed.receipt_line_item_count, 1);
        assert_eq!(listed.purchase_count, Some(0));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_allocate_purchase_fully_allocates_with_multiple_receipts() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            1,
            Decimal::new(87999, 2),
        )
        .await;

        let second_receipt_id = create_receipt_for_seed(
            &pool,
            vendor_id,
            NaiveDate::from_ymd_opt(2026, 4, 15).unwrap(),
            Decimal::new(10000, 2),
        )
        .await;

        let _second_line_item_id = create_receipt_line_item_for_seed(
            &pool,
            second_receipt_id,
            item_id,
            2,
            Decimal::new(91000, 2),
        )
        .await;

        let result = auto_allocate_purchase(&pool, purchase_id, false)
            .await
            .expect("auto allocation should succeed");

        assert_eq!(result.previously_allocated_qty, 0);
        assert_eq!(result.auto_allocated_qty, 2);
        assert_eq!(result.total_allocated_qty, 2);
        assert_eq!(result.remaining_qty, 0);
        assert_eq!(result.allocations_created, 2);
        assert_eq!(result.allocations_updated, 0);
        assert_eq!(result.receipts_touched, 2);

        let rows = get_purchase_allocations(&pool, purchase_id)
            .await
            .expect("allocations should load");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().map(|row| row.allocated_qty).sum::<i32>(), 2);

        let _ = sqlx::query(r#"DELETE FROM receipts WHERE id = $1"#)
            .bind(second_receipt_id)
            .execute(&pool)
            .await;

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_allocate_purchase_returns_partial_when_capacity_is_insufficient() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            1,
            Decimal::new(87999, 2),
        )
        .await;

        let result = auto_allocate_purchase(&pool, purchase_id, false)
            .await
            .expect("auto allocation should succeed");

        assert_eq!(result.previously_allocated_qty, 0);
        assert_eq!(result.auto_allocated_qty, 1);
        assert_eq!(result.total_allocated_qty, 1);
        assert_eq!(result.remaining_qty, 1);
        assert_eq!(result.allocations_created, 1);
        assert_eq!(result.allocations_updated, 0);
        assert_eq!(result.receipts_touched, 1);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_allocate_purchase_warns_when_only_late_receipts_are_available() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        sqlx::query(r#"UPDATE receipts SET receipt_date = $2 WHERE id = $1"#)
            .bind(receipt_id)
            .bind(NaiveDate::from_ymd_opt(2026, 4, 20).unwrap())
            .execute(&pool)
            .await
            .expect("set receipt date after invoice");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let result = auto_allocate_purchase(&pool, purchase_id, false)
            .await
            .expect("auto allocation should return warning result");

        assert_eq!(result.auto_allocated_qty, 0);
        assert_eq!(result.remaining_qty, 2);
        assert!(
            result
                .warning
                .as_deref()
                .unwrap_or_default()
                .contains("on or before invoice date"),
            "expected date-cutoff warning"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_allocate_purchase_override_allows_late_receipts() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        sqlx::query(r#"UPDATE receipts SET receipt_date = $2 WHERE id = $1"#)
            .bind(receipt_id)
            .bind(NaiveDate::from_ymd_opt(2026, 4, 20).unwrap())
            .execute(&pool)
            .await
            .expect("set receipt date after invoice");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let result = auto_allocate_purchase(&pool, purchase_id, true)
            .await
            .expect("override should allow auto allocation from late receipt");

        assert_eq!(result.auto_allocated_qty, 2);
        assert_eq!(result.remaining_qty, 0);
        assert!(result.warning.is_none());

        let persisted_override = sqlx::query_scalar!(
            r#"SELECT allow_receipt_date_override FROM purchases WHERE id = $1"#,
            purchase_id
        )
        .fetch_one(&pool)
        .await
        .expect("read purchase override flag");
        assert!(persisted_override);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_allocate_purchase_updates_existing_allocation_before_creating_more() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let existing = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("seed allocation should succeed");

        let second_receipt_id = create_receipt_for_seed(
            &pool,
            vendor_id,
            NaiveDate::from_ymd_opt(2026, 4, 16).unwrap(),
            Decimal::new(5000, 2),
        )
        .await;

        let _second_line_item_id = create_receipt_line_item_for_seed(
            &pool,
            second_receipt_id,
            item_id,
            5,
            Decimal::new(92000, 2),
        )
        .await;

        let result = auto_allocate_purchase(&pool, purchase_id, false)
            .await
            .expect("auto allocation should succeed");

        assert_eq!(result.previously_allocated_qty, 1);
        assert_eq!(result.auto_allocated_qty, 1);
        assert_eq!(result.total_allocated_qty, 2);
        assert_eq!(result.remaining_qty, 0);
        assert_eq!(result.allocations_created, 0);
        assert_eq!(result.allocations_updated, 1);
        assert_eq!(result.receipts_touched, 1);

        let rows = get_purchase_allocations(&pool, purchase_id)
            .await
            .expect("allocations should load");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, existing.id);
        assert_eq!(rows[0].allocated_qty, 2);

        let _ = sqlx::query(r#"DELETE FROM receipts WHERE id = $1"#)
            .bind(second_receipt_id)
            .execute(&pool)
            .await;

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_blocks_auto_allocation() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, _invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed locked data");

        let _line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let err = auto_allocate_purchase(&pool, purchase_id, false)
            .await
            .expect_err("auto allocation should fail on locked invoice");

        assert_locked_invoice_validation_error(err);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn updating_receipt_linked_purchase_cannot_override_item_qty_or_cost() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");

        let updated = update_purchase(
            &pool,
            purchase_id,
            UpdatePurchase {
                item_id: Some(Uuid::new_v4()),
                invoice_id: None,
                clear_invoice: false,
                receipt_id: None,
                clear_receipt: false,
                quantity: Some(before.quantity + 5),
                purchase_cost: Some(before.purchase_cost + Decimal::new(1000, 2)),
                invoice_unit_price: None,
                clear_invoice_unit_price: false,
                destination_id: None,
                status: None,
                delivery_date: None,
                notes: Some("receipt-linked notes edit".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect("update should succeed")
        .expect("purchase exists");

        assert_eq!(updated.item_id, before.item_id);
        assert_eq!(updated.quantity, before.quantity);
        assert_eq!(updated.purchase_cost, before.purchase_cost);
        assert_eq!(updated.notes.as_deref(), Some("receipt-linked notes edit"));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn receipt_purchases_include_allocation_backed_rows_when_purchase_unlinked() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        assert_eq!(allocation.allocated_qty, 2);

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach direct receipt link");

        let rows = get_purchases_by_receipt(&pool, receipt_id)
            .await
            .expect("allocation-backed rows should still load");

        let linked_row = rows
            .iter()
            .find(|row| row.purchase_id == purchase_id)
            .expect("detached purchase should still be visible via allocation");

        assert_eq!(linked_row.quantity, 2);
        assert_eq!(linked_row.purchase_cost, Decimal::new(87999, 2));
        assert_eq!(linked_row.receipt_id, Some(receipt_id));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn invoice_purchases_include_allocation_backed_receipt_link_when_purchase_unlinked() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");
        let invoice_id = before
            .invoice_id
            .expect("seed purchase should have invoice");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let _allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach direct receipt link");

        let rows = get_purchases_by_invoice(&pool, invoice_id)
            .await
            .expect("invoice purchases should load");

        let linked_row = rows
            .iter()
            .find(|row| row.purchase_id == purchase_id)
            .expect("detached purchase should still resolve receipt link via allocation");

        assert_eq!(linked_row.receipt_id, Some(receipt_id));
        assert_eq!(linked_row.receipt_number.is_some(), true);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn invoice_summary_counts_allocation_backed_receipted_purchases_when_unlinked() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "open")
                .await
                .expect("seed data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let _allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach direct receipt link");

        let summary = get_invoice_with_destination(&pool, invoice_id)
            .await
            .expect("invoice summary should load")
            .expect("invoice should exist");

        assert_eq!(summary.purchase_count, Some(1));
        assert_eq!(summary.receipted_count, Some(1));

        let summaries = get_invoices_with_destination(&pool)
            .await
            .expect("invoice summaries should load");

        let listed = summaries
            .iter()
            .find(|inv| inv.id == invoice_id)
            .expect("invoice should be present in list");

        assert_eq!(listed.purchase_count, Some(1));
        assert_eq!(listed.receipted_count, Some(1));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn invoice_purchases_use_allocation_unit_cost_when_purchase_cost_is_zero() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");
        let invoice_id = before
            .invoice_id
            .expect("seed purchase should have invoice");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let _allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL, purchase_cost = 0 WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should simulate stale detached purchase cost");

        let rows = get_purchases_by_invoice(&pool, invoice_id)
            .await
            .expect("invoice purchases should load");

        let row = rows
            .iter()
            .find(|entry| entry.purchase_id == purchase_id)
            .expect("purchase should be present in invoice rows");

        assert_eq!(row.purchase_cost, Decimal::new(87999, 2));
        assert_eq!(row.total_cost, Some(Decimal::new(175998, 2)));
        assert_eq!(row.total_commission, Some(Decimal::new(2002, 2)));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn deleting_invoice_cleans_orphaned_invoice_only_purchase() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");
        let invoice_id = before
            .invoice_id
            .expect("seed purchase should have invoice");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach receipt link");

        let deleted = delete_invoice(&pool, invoice_id, Uuid::new_v4())
            .await
            .expect("delete invoice should succeed");
        assert!(deleted, "invoice should be deleted");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after delete");
        assert!(
            after.is_none(),
            "Invoice-only purchase should be removed instead of becoming orphaned"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn deleting_locked_invoice_requires_reopen_first() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed data");

        let err = delete_invoice(&pool, invoice_id, Uuid::new_v4())
            .await
            .expect_err("locked invoice should not be deletable");

        assert_locked_invoice_sql_error(&err);

        let invoice_after = get_invoice_by_id(&pool, invoice_id)
            .await
            .expect("invoice lookup should succeed after failed delete");
        assert!(
            invoice_after.is_some(),
            "Locked invoice should remain after failed delete"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn deleting_invoice_cleans_allocation_backed_invoice_only_purchase() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let before = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read before")
            .expect("purchase exists before");
        let invoice_id = before
            .invoice_id
            .expect("seed purchase should have invoice");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let _allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach direct receipt link");

        let deleted = delete_invoice(&pool, invoice_id, Uuid::new_v4())
            .await
            .expect("delete invoice should succeed");
        assert!(deleted, "invoice should be deleted");

        let after = get_purchase_by_id(&pool, purchase_id)
            .await
            .expect("purchase read after delete");
        assert!(
            after.is_none(),
            "Allocation-backed invoice-only purchase should be removed after invoice delete"
        );

        let allocation_count = sqlx::query_scalar!(
            r#"SELECT COUNT(*)::BIGINT AS "count!" FROM purchase_allocations WHERE purchase_id = $1"#,
            purchase_id
        )
        .fetch_one(&pool)
        .await
        .expect("allocation count read");
        assert_eq!(
            allocation_count, 0,
            "Allocation rows should be removed for deleted-invoice purchases"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn create_purchase_requires_invoice_or_receipt_link() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let err = create_purchase(
            &pool,
            CreatePurchase {
                item_id,
                invoice_id: None,
                receipt_id: None,
                quantity: 1,
                purchase_cost: Decimal::new(5000, 2),
                invoice_unit_price: None,
                destination_id: Some(destination_id),
                status: Some(DeliveryStatus::Pending),
                delivery_date: None,
                notes: Some("invalid standalone purchase".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("purchase create should reject missing invoice+receipt links");

        let msg = purchase_link_required_error_message(&err)
            .expect("expected purchase-link-required protocol error");
        assert!(
            msg.to_lowercase().contains("at least one side"),
            "expected purchase-link-required message, got: {msg}"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn update_purchase_rejects_clearing_last_link() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id) =
            seed_purchase_with_receipt(&pool).await.expect("seed data");

        let err = update_purchase(
            &pool,
            purchase_id,
            UpdatePurchase {
                item_id: None,
                invoice_id: None,
                clear_invoice: true,
                receipt_id: None,
                clear_receipt: true,
                quantity: None,
                purchase_cost: None,
                invoice_unit_price: None,
                clear_invoice_unit_price: false,
                destination_id: None,
                status: None,
                delivery_date: None,
                notes: Some("attempt to orphan purchase".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("update should reject clearing both invoice and receipt links");

        let msg = purchase_link_required_error_message(&err)
            .expect("expected purchase-link-required protocol error");
        assert!(
            msg.to_lowercase().contains("at least one side"),
            "expected purchase-link-required message, got: {msg}"
        );

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_requires_reopen_before_invoice_edits() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed locked data");

        let err = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: Some(Decimal::new(13000, 2)),
                tax_rate: None,
                reconciliation_state: None,
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("locked invoice should reject direct edits");
        assert_locked_invoice_sql_error(&err);

        let reopened = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: None,
                tax_rate: None,
                reconciliation_state: Some("reopened".to_string()),
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("locked invoice should reopen")
        .expect("invoice should exist");

        assert_eq!(reopened.reconciliation_state, "reopened");

        let edited = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: None,
                tax_rate: None,
                reconciliation_state: None,
                notes: Some("edited after reopen".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect("reopened invoice should allow edits")
        .expect("invoice should exist");

        assert_eq!(edited.notes.as_deref(), Some("edited after reopen"));

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_blocks_purchase_create_update_status_and_delete() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed locked data");

        let create_err = create_purchase(
            &pool,
            CreatePurchase {
                item_id,
                invoice_id: Some(invoice_id),
                receipt_id: Some(receipt_id),
                quantity: 1,
                purchase_cost: Decimal::new(5000, 2),
                invoice_unit_price: Some(Decimal::new(6000, 2)),
                destination_id: Some(destination_id),
                status: Some(DeliveryStatus::Pending),
                delivery_date: None,
                notes: Some("should fail".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("create purchase on locked invoice should fail");
        assert_locked_invoice_sql_error(&create_err);

        let update_err = update_purchase(
            &pool,
            purchase_id,
            UpdatePurchase {
                item_id: None,
                invoice_id: None,
                clear_invoice: false,
                receipt_id: None,
                clear_receipt: false,
                quantity: None,
                purchase_cost: None,
                invoice_unit_price: None,
                clear_invoice_unit_price: false,
                destination_id: None,
                status: None,
                delivery_date: None,
                notes: Some("edit should fail".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("update purchase on locked invoice should fail");
        assert_locked_invoice_sql_error(&update_err);

        let status_err =
            update_purchase_status(&pool, purchase_id, DeliveryStatus::Pending, Uuid::new_v4())
                .await
                .expect_err("status update on locked invoice should fail");
        assert_locked_invoice_sql_error(&status_err);

        let delete_err = delete_purchase(&pool, purchase_id, Uuid::new_v4())
            .await
            .expect_err("delete purchase on locked invoice should fail");
        assert_locked_invoice_sql_error(&delete_err);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn reopened_invoice_allows_purchase_mutation_again() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed locked data");

        let _ = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: None,
                tax_rate: None,
                reconciliation_state: Some("reopened".to_string()),
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("invoice should reopen")
        .expect("invoice exists");

        let updated =
            update_purchase_status(&pool, purchase_id, DeliveryStatus::Pending, Uuid::new_v4())
                .await
                .expect("status update should succeed after reopen")
                .expect("purchase exists");

        assert_eq!(updated.status, DeliveryStatus::Pending);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_blocks_allocation_creation() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, _invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "locked")
                .await
                .expect("seed locked data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let err = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect_err("allocation create should fail on locked invoice");

        assert_locked_invoice_validation_error(err);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_blocks_allocation_update_and_delete() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "open")
                .await
                .expect("seed open data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 1,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        let _ = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: None,
                tax_rate: None,
                reconciliation_state: Some("locked".to_string()),
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("invoice should lock")
        .expect("invoice exists");

        let update_err = update_purchase_allocation(
            &pool,
            purchase_id,
            allocation.id,
            UpdatePurchaseAllocation {
                receipt_line_item_id: Some(line_item_id),
                allocated_qty: Some(1),
                allow_receipt_date_override: None,
            },
        )
        .await
        .expect_err("allocation update should fail on locked invoice");
        assert_locked_invoice_validation_error(update_err);

        let delete_err = delete_purchase_allocation(&pool, purchase_id, allocation.id)
            .await
            .expect_err("allocation delete should fail on locked invoice");
        assert_locked_invoice_sql_error(&delete_err);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }

    #[tokio::test]
    async fn locked_invoice_blocks_receipt_and_line_item_mutations_via_allocation_link() {
        let Some(pool) = test_pool().await else {
            eprintln!("Skipping test: DATABASE_URL is not set or unreachable");
            return;
        };

        let (vendor_id, destination_id, item_id, receipt_id, purchase_id, invoice_id) =
            seed_purchase_with_receipt_and_state(&pool, "open")
                .await
                .expect("seed open data");

        let line_item_id = create_receipt_line_item_for_seed(
            &pool,
            receipt_id,
            item_id,
            2,
            Decimal::new(87999, 2),
        )
        .await;

        let _allocation = create_purchase_allocation(
            &pool,
            purchase_id,
            CreatePurchaseAllocation {
                receipt_line_item_id: line_item_id,
                allocated_qty: 2,
                allow_receipt_date_override: false,
            },
        )
        .await
        .expect("allocation should be created");

        sqlx::query(r#"UPDATE purchases SET receipt_id = NULL WHERE id = $1"#)
            .bind(purchase_id)
            .execute(&pool)
            .await
            .expect("should detach direct receipt link");

        let _ = update_invoice(
            &pool,
            invoice_id,
            UpdateInvoice {
                invoice_number: None,
                order_number: None,
                invoice_date: None,
                subtotal: None,
                tax_rate: None,
                reconciliation_state: Some("locked".to_string()),
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("invoice should lock")
        .expect("invoice exists");

        let receipt_update_err = update_receipt(
            &pool,
            receipt_id,
            UpdateReceipt {
                vendor_id: None,
                receipt_number: Some(format!("LOCKED-{}", &receipt_id.to_string()[..8])),
                receipt_date: None,
                subtotal: None,
                tax_amount: None,
                tax_rate: None,
                payment_method: None,
                ingestion_metadata: None,
                notes: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect_err("receipt update should fail when linked via allocation to locked invoice");
        assert_locked_invoice_sql_error(&receipt_update_err);

        let save_pdf_err = save_receipt_pdf(&pool, receipt_id, b"pdf", "receipt.pdf")
            .await
            .expect_err("receipt document update should fail on locked link");
        assert_locked_invoice_sql_error(&save_pdf_err);

        let receipt_delete_err = delete_receipt(&pool, receipt_id, Uuid::new_v4())
            .await
            .expect_err("receipt delete should fail when linked via allocation to locked invoice");
        assert_locked_invoice_sql_error(&receipt_delete_err);

        let line_create_err = create_receipt_line_item(
            &pool,
            receipt_id,
            CreateReceiptLineItem {
                item_id: Uuid::new_v4(),
                quantity: 1,
                unit_cost: Decimal::new(12345, 2),
                notes: Some("should fail".to_string()),
            },
        )
        .await
        .expect_err("line item create should fail on locked-linked receipt");
        assert_locked_invoice_validation_error(line_create_err);

        let line_update_err = update_receipt_line_item(
            &pool,
            receipt_id,
            line_item_id,
            UpdateReceiptLineItem {
                item_id: None,
                quantity: None,
                unit_cost: None,
                notes: Some("should fail".to_string()),
            },
        )
        .await
        .expect_err("line item update should fail on locked-linked receipt");
        assert_locked_invoice_validation_error(line_update_err);

        let line_delete_err = delete_receipt_line_item(&pool, receipt_id, line_item_id)
            .await
            .expect_err("line item delete should fail on locked-linked receipt");
        assert_locked_invoice_validation_error(line_delete_err);

        cleanup_seeded(
            &pool,
            vendor_id,
            destination_id,
            item_id,
            receipt_id,
            purchase_id,
        )
        .await;
    }
}
