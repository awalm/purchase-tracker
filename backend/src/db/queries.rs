use chrono::NaiveDate;
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

use super::models::*;
use crate::services::audit::AuditService;

// ============================================
// Vendors
// ============================================

pub async fn get_all_vendors(pool: &PgPool) -> Result<Vec<Vendor>, sqlx::Error> {
    sqlx::query_as!(
        Vendor,
        r#"SELECT id, name, created_at, updated_at FROM vendors ORDER BY name"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_vendor_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Vendor>, sqlx::Error> {
    sqlx::query_as!(
        Vendor,
        r#"SELECT id, name, created_at, updated_at FROM vendors WHERE id = $1"#,
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
    let vendor = sqlx::query_as!(
        Vendor,
        r#"INSERT INTO vendors (name) VALUES ($1) RETURNING id, name, created_at, updated_at"#,
        data.name
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(pool, "vendors", vendor.id, "create", None::<&Vendor>, Some(&vendor), user_id).await?;
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
        let vendor = sqlx::query_as!(
            Vendor,
            r#"UPDATE vendors SET name = COALESCE($2, name) WHERE id = $1 
               RETURNING id, name, created_at, updated_at"#,
            id,
            data.name
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref v) = vendor {
            AuditService::log(pool, "vendors", id, "update", Some(old_vendor), Some(v), user_id)
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

    let result = sqlx::query!(r#"DELETE FROM vendors WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref v) = old {
            AuditService::log(pool, "vendors", id, "delete", Some(v), None::<&Vendor>, user_id)
                .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn get_vendor_summary(pool: &PgPool) -> Result<Vec<VendorSummary>, sqlx::Error> {
    sqlx::query_as!(
        VendorSummary,
        r#"SELECT 
            vendor_id as "vendor_id!",
            vendor_name as "vendor_name!",
            total_receipts,
            total_purchases,
            total_quantity,
            total_spent
        FROM v_vendor_summary
        ORDER BY vendor_name"#
    )
    .fetch_all(pool)
    .await
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
            AuditService::log(pool, "destinations", id, "update", Some(old_dest), Some(d), user_id)
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
    sqlx::query!(r#"UPDATE items SET default_destination_id = NULL WHERE default_destination_id = $1"#, id)
        .execute(pool)
        .await?;
    // Unlink purchases from this destination
    sqlx::query!(r#"UPDATE purchases SET destination_id = NULL WHERE destination_id = $1"#, id)
        .execute(pool)
        .await?;
    // Unlink purchases from invoices for this destination, then delete the invoices
    sqlx::query!(r#"UPDATE purchases SET invoice_id = NULL WHERE invoice_id IN (SELECT id FROM invoices WHERE destination_id = $1)"#, id)
        .execute(pool)
        .await?;
    sqlx::query!(r#"DELETE FROM invoices WHERE destination_id = $1"#, id)
        .execute(pool)
        .await?;

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

pub async fn get_destination_summary(pool: &PgPool) -> Result<Vec<DestinationSummary>, sqlx::Error> {
    sqlx::query_as!(
        DestinationSummary,
        r#"SELECT 
            destination_id as "destination_id!",
            destination_code as "destination_code!",
            destination_name as "destination_name!",
            total_invoices,
            total_purchases,
            total_quantity,
            total_cost,
            total_revenue,
            total_commission,
            total_tax_paid,
            total_tax_owed
        FROM v_destination_summary
        ORDER BY destination_code"#
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
            i.default_destination_id,
            d.code as default_destination_code,
            i.notes,
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

    AuditService::log(pool, "items", item.id, "create", None::<&Item>, Some(&item), user_id).await?;
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
            AuditService::log(pool, "items", id, "update", Some(old_item), Some(i), user_id)
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
                  subtotal, tax_rate, total, notes, created_at, updated_at
           FROM invoices ORDER BY invoice_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_invoice_by_id(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<Invoice>, sqlx::Error> {
    sqlx::query_as!(
        Invoice,
        r#"SELECT id, destination_id, invoice_number, order_number, invoice_date, 
                  subtotal, tax_rate, total, notes, created_at, updated_at
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
    let total = data.subtotal * (Decimal::ONE + tax_rate / Decimal::new(100, 0));
    let invoice = sqlx::query_as!(
        Invoice,
        r#"INSERT INTO invoices (destination_id, invoice_number, order_number, invoice_date, subtotal, tax_rate, total, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           RETURNING id, destination_id, invoice_number, order_number, invoice_date, 
                     subtotal, tax_rate, total, notes, created_at, updated_at"#,
        data.destination_id,
        data.invoice_number,
        data.order_number,
        data.invoice_date,
        data.subtotal,
        tax_rate,
        total,
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

pub async fn update_invoice(
    pool: &PgPool,
    id: Uuid,
    data: UpdateInvoice,
    user_id: Uuid,
) -> Result<Option<Invoice>, sqlx::Error> {
    let old = get_invoice_by_id(pool, id).await?;

    if let Some(ref old_inv) = old {
        let invoice = sqlx::query_as!(
            Invoice,
            r#"UPDATE invoices SET 
                invoice_number = COALESCE($2, invoice_number),
                order_number = COALESCE($3, order_number),
                invoice_date = COALESCE($4, invoice_date),
                subtotal = COALESCE($5, subtotal),
                tax_rate = COALESCE($6, tax_rate),
                total = COALESCE($5, subtotal) * (1 + COALESCE($6, tax_rate) / 100),
                notes = COALESCE($7, notes)
               WHERE id = $1 
               RETURNING id, destination_id, invoice_number, order_number, invoice_date, 
                         subtotal, tax_rate, total, notes, created_at, updated_at"#,
            id,
            data.invoice_number,
            data.order_number,
            data.invoice_date,
            data.subtotal,
            data.tax_rate,
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

    // Unlink purchases that reference this invoice (SET NULL, not delete)
    sqlx::query!(r#"UPDATE purchases SET invoice_id = NULL WHERE invoice_id = $1"#, id)
        .execute(pool)
        .await?;

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

    Ok(row.and_then(|r| {
        match (r.original_pdf, r.original_filename) {
            (Some(pdf), Some(name)) => Some((pdf, name)),
            (Some(pdf), None) => Some((pdf, "invoice.pdf".to_string())),
            _ => None,
        }
    }))
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
        r#"SELECT 
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
            (inv.original_pdf IS NOT NULL) AS has_pdf,
            inv.notes,
            inv.created_at,
            inv.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE(SUM(p.quantity * COALESCE(p.selling_price, p.purchase_cost)), 0) AS purchases_total,
            COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_cost,
            COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission,
            COUNT(p.id) FILTER (WHERE p.receipt_id IS NOT NULL) AS receipted_count
        FROM invoices inv
        JOIN destinations d ON d.id = inv.destination_id
        LEFT JOIN purchases p ON p.invoice_id = inv.id
        WHERE inv.id = $1
        GROUP BY inv.id, inv.destination_id, d.code, d.name, inv.invoice_number, inv.order_number,
                 inv.invoice_date, inv.subtotal, inv.tax_rate, inv.total, inv.original_pdf, inv.notes, inv.created_at, inv.updated_at"#,
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
        r#"SELECT 
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
            (inv.original_pdf IS NOT NULL) AS has_pdf,
            inv.notes,
            inv.created_at,
            inv.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE(SUM(p.quantity * COALESCE(p.selling_price, p.purchase_cost)), 0) AS purchases_total,
            COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS total_cost,
            COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission,
            COUNT(p.id) FILTER (WHERE p.receipt_id IS NOT NULL) AS receipted_count
        FROM invoices inv
        JOIN destinations d ON d.id = inv.destination_id
        LEFT JOIN purchases p ON p.invoice_id = inv.id
        GROUP BY inv.id, inv.destination_id, d.code, d.name, inv.invoice_number, inv.order_number,
                 inv.invoice_date, inv.subtotal, inv.tax_rate, inv.total, inv.original_pdf, inv.notes, inv.created_at, inv.updated_at
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
            pe.selling_price,
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
            pe.notes
        FROM v_purchase_economics pe
        WHERE pe.invoice_id = $1
        ORDER BY pe.purchase_date DESC"#,
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
        r#"SELECT p.id, p.item_id, p.invoice_id, p.receipt_id, p.quantity, p.purchase_cost, p.selling_price,
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
        r#"SELECT id, item_id, invoice_id, receipt_id, quantity, purchase_cost, selling_price,
                  destination_id, status as "status: DeliveryStatus", 
                  delivery_date, notes, created_at, updated_at
           FROM purchases WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_purchase(
    pool: &PgPool,
    data: CreatePurchase,
    user_id: Uuid,
) -> Result<Purchase, sqlx::Error> {
    let status = data.status.unwrap_or(DeliveryStatus::Pending);
    
    let purchase = sqlx::query_as!(
        Purchase,
        r#"INSERT INTO purchases (item_id, invoice_id, receipt_id, quantity, purchase_cost, selling_price, destination_id, status, delivery_date, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
           RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, selling_price,
                     destination_id, status as "status: DeliveryStatus", 
                     delivery_date, notes, created_at, updated_at"#,
        data.item_id,
        data.invoice_id,
        data.receipt_id,
        data.quantity,
        data.purchase_cost,
        data.selling_price,
        data.destination_id,
        status as DeliveryStatus,
        data.delivery_date,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(pool, "purchases", purchase.id, "create", None::<&Purchase>, Some(&purchase), user_id)
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
        // Resolve nullable fields: explicit clear wins, then new value, then keep existing
        let invoice_id = if data.clear_invoice { None } else { data.invoice_id.or(old_purchase.invoice_id) };
        let receipt_id = if data.clear_receipt { None } else { data.receipt_id.or(old_purchase.receipt_id) };
        let selling_price = if data.clear_selling_price { None } else { data.selling_price.or(old_purchase.selling_price) };
        let item_id = data.item_id.unwrap_or(old_purchase.item_id);
        let quantity = data.quantity.unwrap_or(old_purchase.quantity);
        let purchase_cost = data.purchase_cost.unwrap_or(old_purchase.purchase_cost);
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
                selling_price = $7,
                destination_id = $8,
                status = $9,
                delivery_date = $10,
                notes = $11
               WHERE id = $1 
               RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, selling_price,
                         destination_id, status as "status: DeliveryStatus", 
                         delivery_date, notes, created_at, updated_at"#,
            id,
            item_id,
            invoice_id,
            receipt_id,
            quantity,
            purchase_cost,
            selling_price,
            destination_id,
            status as DeliveryStatus,
            delivery_date,
            notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref p) = purchase {
            AuditService::log(pool, "purchases", id, "update", Some(old_purchase), Some(p), user_id)
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
        let purchase = sqlx::query_as!(
            Purchase,
            r#"UPDATE purchases SET status = $2
               WHERE id = $1 
               RETURNING id, item_id, invoice_id, receipt_id, quantity, purchase_cost, selling_price,
                         destination_id, status as "status: DeliveryStatus", 
                         delivery_date, notes, created_at, updated_at"#,
            id,
            status as DeliveryStatus
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref p) = purchase {
            AuditService::log(pool, "purchases", id, "update", Some(old_purchase), Some(p), user_id)
                .await?;
        }
        return Ok(purchase);
    }
    Ok(None)
}

pub async fn delete_purchase(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_purchase_by_id(pool, id).await?;

    let result = sqlx::query!(r#"DELETE FROM purchases WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref p) = old {
            AuditService::log(pool, "purchases", id, "delete", Some(p), None::<&Purchase>, user_id)
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
            pe.selling_price,
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
pub async fn get_audit_logs(pool: &PgPool, query: AuditQuery) -> Result<Vec<AuditLog>, sqlx::Error> {
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

// ============================================
// Receipts
// ============================================

pub async fn get_all_receipts(pool: &PgPool) -> Result<Vec<Receipt>, sqlx::Error> {
    sqlx::query_as!(
        Receipt,
        r#"SELECT id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total, 
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
    let tax_rate = data.tax_rate.unwrap_or(Decimal::new(1300, 2)); // 13.00
    let total = data.subtotal * (Decimal::ONE + tax_rate / Decimal::new(100, 0));
    let receipt = sqlx::query_as!(
        Receipt,
        r#"INSERT INTO receipts (vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           RETURNING id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total, 
                     notes, created_at, updated_at"#,
        data.vendor_id,
        data.receipt_number,
        data.receipt_date,
        data.subtotal,
        tax_rate,
        total,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(pool, "receipts", receipt.id, "create", None::<&Receipt>, Some(&receipt), user_id).await?;
    Ok(receipt)
}

pub async fn update_receipt(
    pool: &PgPool,
    id: Uuid,
    data: UpdateReceipt,
    user_id: Uuid,
) -> Result<Option<Receipt>, sqlx::Error> {
    let old = get_receipt_by_id(pool, id).await?;

    if let Some(ref old_receipt) = old {
        let receipt = sqlx::query_as!(
            Receipt,
            r#"UPDATE receipts SET 
                receipt_number = COALESCE($2, receipt_number),
                receipt_date = COALESCE($3, receipt_date),
                subtotal = COALESCE($4, subtotal),
                tax_rate = COALESCE($5, tax_rate),
                total = COALESCE($4, subtotal) * (1 + COALESCE($5, tax_rate) / 100),
                notes = COALESCE($6, notes)
               WHERE id = $1 
               RETURNING id, vendor_id, receipt_number, receipt_date, subtotal, tax_rate, total,
                         notes, created_at, updated_at"#,
            id,
            data.receipt_number,
            data.receipt_date,
            data.subtotal,
            data.tax_rate,
            data.notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref r) = receipt {
            AuditService::log(pool, "receipts", id, "update", Some(old_receipt), Some(r), user_id).await?;
        }
        return Ok(receipt);
    }
    Ok(None)
}

pub async fn delete_receipt(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_receipt_by_id(pool, id).await?;

    // Unlink purchases that reference this receipt (SET NULL, not delete)
    sqlx::query!(r#"UPDATE purchases SET receipt_id = NULL WHERE receipt_id = $1"#, id)
        .execute(pool)
        .await?;

    let result = sqlx::query!(r#"DELETE FROM receipts WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref r) = old {
            AuditService::log(pool, "receipts", id, "delete", Some(r), None::<&Receipt>, user_id).await?;
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

    Ok(row.and_then(|r| {
        match (r.original_pdf, r.original_filename) {
            (Some(pdf), Some(name)) => Some((pdf, name)),
            (Some(pdf), None) => Some((pdf, "receipt.pdf".to_string())),
            _ => None,
        }
    }))
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
            (r.original_pdf IS NOT NULL) AS has_pdf,
            r.notes,
            r.created_at,
            r.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS purchases_total,
            COALESCE(SUM(p.quantity * COALESCE(p.selling_price, 0)), 0) AS total_selling,
            COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission,
            COUNT(p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AS invoiced_count
        FROM receipts r
        JOIN vendors v ON v.id = r.vendor_id
        LEFT JOIN purchases p ON p.receipt_id = r.id
        WHERE r.id = $1
        GROUP BY r.id, r.vendor_id, v.name, r.receipt_number, r.receipt_date, r.subtotal, r.tax_rate, r.total,
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
            (r.original_pdf IS NOT NULL) AS has_pdf,
            r.notes,
            r.created_at,
            r.updated_at,
            COUNT(p.id) AS purchase_count,
            COALESCE(SUM(p.quantity * p.purchase_cost), 0) AS purchases_total,
            COALESCE(SUM(p.quantity * COALESCE(p.selling_price, 0)), 0) AS total_selling,
            COALESCE(SUM(p.quantity * (COALESCE(p.selling_price, p.purchase_cost) - p.purchase_cost)), 0) AS total_commission,
            COUNT(p.id) FILTER (WHERE p.invoice_id IS NOT NULL) AS invoiced_count
        FROM receipts r
        JOIN vendors v ON v.id = r.vendor_id
        LEFT JOIN purchases p ON p.receipt_id = r.id
        GROUP BY r.id, r.vendor_id, v.name, r.receipt_number, r.receipt_date, r.subtotal, r.tax_rate, r.total,
                 r.original_pdf, r.notes, r.created_at, r.updated_at
        ORDER BY r.receipt_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_purchases_by_receipt(
    pool: &PgPool,
    receipt_id: Uuid,
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
            pe.selling_price,
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
            pe.notes
        FROM v_purchase_economics pe
        WHERE pe.receipt_id = $1
        ORDER BY pe.purchase_date DESC"#,
        receipt_id
    )
    .fetch_all(pool)
    .await
}

pub async fn get_purchases_by_item(
    pool: &PgPool,
    item_id: Uuid,
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
            pe.selling_price,
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
            pe.notes
        FROM v_purchase_economics pe
        WHERE pe.item_id = $1
        ORDER BY pe.purchase_date DESC"#,
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
        r#"SELECT 
            SUM(total_cost) as total_cost,
            SUM(total_selling) as total_revenue,
            SUM(total_commission) as total_commission,
            SUM(tax_paid) as total_tax_paid,
            SUM(tax_owed) as total_tax_owed,
            COUNT(*) as purchase_count,
            COUNT(DISTINCT purchase_id) as item_count
        FROM v_purchase_economics
        WHERE ($1::date IS NULL OR purchase_date >= $1::date)
          AND ($2::date IS NULL OR purchase_date <= $2::date)"#,
        from,
        to
    )
    .fetch_one(pool)
    .await
}
