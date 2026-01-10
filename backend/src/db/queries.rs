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
            total_invoices,
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
            total_purchases,
            total_quantity,
            total_cost,
            total_profit
        FROM v_destination_summary
        ORDER BY destination_code"#
    )
    .fetch_all(pool)
    .await
}

// ============================================
// Items
// ============================================

pub async fn get_all_items(pool: &PgPool, query: ItemQuery) -> Result<Vec<Item>, sqlx::Error> {
    let date = query.date.unwrap_or_else(|| chrono::Utc::now().date_naive());
    let active_only = query.active_only.unwrap_or(false);

    if active_only {
        sqlx::query_as!(
            Item,
            r#"SELECT id, name, vendor_id, unit_cost, start_date, end_date, 
                      default_destination_id, notes, created_at, updated_at
               FROM items
               WHERE ($1::uuid IS NULL OR vendor_id = $1)
                 AND start_date <= $2
                 AND (end_date IS NULL OR end_date >= $2)
               ORDER BY name"#,
            query.vendor_id,
            date
        )
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as!(
            Item,
            r#"SELECT id, name, vendor_id, unit_cost, start_date, end_date, 
                      default_destination_id, notes, created_at, updated_at
               FROM items
               WHERE ($1::uuid IS NULL OR vendor_id = $1)
               ORDER BY name"#,
            query.vendor_id
        )
        .fetch_all(pool)
        .await
    }
}

pub async fn get_active_items(pool: &PgPool) -> Result<Vec<ActiveItem>, sqlx::Error> {
    sqlx::query_as!(
        ActiveItem,
        r#"SELECT 
            id as "id!",
            name as "name!",
            vendor_id as "vendor_id!",
            vendor_name as "vendor_name!",
            unit_cost as "unit_cost!",
            default_destination_id,
            default_destination_code,
            notes
        FROM v_active_items
        ORDER BY name"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_item_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Item>, sqlx::Error> {
    sqlx::query_as!(
        Item,
        r#"SELECT id, name, vendor_id, unit_cost, start_date, end_date, 
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
        r#"INSERT INTO items (name, vendor_id, unit_cost, start_date, end_date, default_destination_id, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           RETURNING id, name, vendor_id, unit_cost, start_date, end_date, 
                     default_destination_id, notes, created_at, updated_at"#,
        data.name,
        data.vendor_id,
        data.unit_cost,
        data.start_date,
        data.end_date,
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
                unit_cost = COALESCE($3, unit_cost),
                end_date = COALESCE($4, end_date),
                default_destination_id = COALESCE($5, default_destination_id),
                notes = COALESCE($6, notes)
               WHERE id = $1 
               RETURNING id, name, vendor_id, unit_cost, start_date, end_date, 
                         default_destination_id, notes, created_at, updated_at"#,
            id,
            data.name,
            data.unit_cost,
            data.end_date,
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
// Payouts
// ============================================

pub async fn get_all_payouts(pool: &PgPool, query: PayoutQuery) -> Result<Vec<Payout>, sqlx::Error> {
    let date = query.date.unwrap_or_else(|| chrono::Utc::now().date_naive());
    let active_only = query.active_only.unwrap_or(false);

    if active_only {
        sqlx::query_as!(
            Payout,
            r#"SELECT id, destination_id, item_id, payout_price, start_date, end_date, 
                      notes, created_at, updated_at
               FROM payouts
               WHERE ($1::uuid IS NULL OR destination_id = $1)
                 AND ($2::uuid IS NULL OR item_id = $2)
                 AND start_date <= $3
                 AND (end_date IS NULL OR end_date >= $3)
               ORDER BY start_date DESC"#,
            query.destination_id,
            query.item_id,
            date
        )
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as!(
            Payout,
            r#"SELECT id, destination_id, item_id, payout_price, start_date, end_date, 
                      notes, created_at, updated_at
               FROM payouts
               WHERE ($1::uuid IS NULL OR destination_id = $1)
                 AND ($2::uuid IS NULL OR item_id = $2)
               ORDER BY start_date DESC"#,
            query.destination_id,
            query.item_id
        )
        .fetch_all(pool)
        .await
    }
}

pub async fn get_active_payouts(pool: &PgPool) -> Result<Vec<ActivePayout>, sqlx::Error> {
    sqlx::query_as!(
        ActivePayout,
        r#"SELECT 
            id as "id!",
            item_id as "item_id!",
            item_name as "item_name!",
            destination_id as "destination_id!",
            destination_code as "destination_code!",
            payout_price as "payout_price!",
            notes
        FROM v_active_payouts
        ORDER BY item_name, destination_code"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_payout_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Payout>, sqlx::Error> {
    sqlx::query_as!(
        Payout,
        r#"SELECT id, destination_id, item_id, payout_price, start_date, end_date, 
                  notes, created_at, updated_at
           FROM payouts WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_payout(
    pool: &PgPool,
    data: CreatePayout,
    user_id: Uuid,
) -> Result<Payout, sqlx::Error> {
    let payout = sqlx::query_as!(
        Payout,
        r#"INSERT INTO payouts (destination_id, item_id, payout_price, start_date, end_date, notes) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           RETURNING id, destination_id, item_id, payout_price, start_date, end_date, 
                     notes, created_at, updated_at"#,
        data.destination_id,
        data.item_id,
        data.payout_price,
        data.start_date,
        data.end_date,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(pool, "payouts", payout.id, "create", None::<&Payout>, Some(&payout), user_id).await?;
    Ok(payout)
}

pub async fn update_payout(
    pool: &PgPool,
    id: Uuid,
    data: UpdatePayout,
    user_id: Uuid,
) -> Result<Option<Payout>, sqlx::Error> {
    let old = get_payout_by_id(pool, id).await?;

    if let Some(ref old_payout) = old {
        let payout = sqlx::query_as!(
            Payout,
            r#"UPDATE payouts SET 
                payout_price = COALESCE($2, payout_price),
                end_date = COALESCE($3, end_date),
                notes = COALESCE($4, notes)
               WHERE id = $1 
               RETURNING id, destination_id, item_id, payout_price, start_date, end_date, 
                         notes, created_at, updated_at"#,
            id,
            data.payout_price,
            data.end_date,
            data.notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref p) = payout {
            AuditService::log(pool, "payouts", id, "update", Some(old_payout), Some(p), user_id)
                .await?;
        }
        return Ok(payout);
    }
    Ok(None)
}

pub async fn delete_payout(pool: &PgPool, id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let old = get_payout_by_id(pool, id).await?;

    let result = sqlx::query!(r#"DELETE FROM payouts WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref p) = old {
            AuditService::log(pool, "payouts", id, "delete", Some(p), None::<&Payout>, user_id)
                .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

// ============================================
// Incoming Invoices
// ============================================

pub async fn get_all_invoices(pool: &PgPool) -> Result<Vec<IncomingInvoice>, sqlx::Error> {
    sqlx::query_as!(
        IncomingInvoice,
        r#"SELECT id, vendor_id, invoice_number, order_number, invoice_date, 
                  total, notes, created_at, updated_at
           FROM incoming_invoices ORDER BY invoice_date DESC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn get_invoice_by_id(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<IncomingInvoice>, sqlx::Error> {
    sqlx::query_as!(
        IncomingInvoice,
        r#"SELECT id, vendor_id, invoice_number, order_number, invoice_date, 
                  total, notes, created_at, updated_at
           FROM incoming_invoices WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

pub async fn create_invoice(
    pool: &PgPool,
    data: CreateInvoice,
    user_id: Uuid,
) -> Result<IncomingInvoice, sqlx::Error> {
    let invoice = sqlx::query_as!(
        IncomingInvoice,
        r#"INSERT INTO incoming_invoices (vendor_id, invoice_number, order_number, invoice_date, total, notes) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           RETURNING id, vendor_id, invoice_number, order_number, invoice_date, 
                     total, notes, created_at, updated_at"#,
        data.vendor_id,
        data.invoice_number,
        data.order_number,
        data.invoice_date,
        data.total,
        data.notes
    )
    .fetch_one(pool)
    .await?;

    AuditService::log(
        pool,
        "incoming_invoices",
        invoice.id,
        "create",
        None::<&IncomingInvoice>,
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
) -> Result<Option<IncomingInvoice>, sqlx::Error> {
    let old = get_invoice_by_id(pool, id).await?;

    if let Some(ref old_inv) = old {
        let invoice = sqlx::query_as!(
            IncomingInvoice,
            r#"UPDATE incoming_invoices SET 
                invoice_number = COALESCE($2, invoice_number),
                order_number = COALESCE($3, order_number),
                invoice_date = COALESCE($4, invoice_date),
                total = COALESCE($5, total),
                notes = COALESCE($6, notes)
               WHERE id = $1 
               RETURNING id, vendor_id, invoice_number, order_number, invoice_date, 
                         total, notes, created_at, updated_at"#,
            id,
            data.invoice_number,
            data.order_number,
            data.invoice_date,
            data.total,
            data.notes
        )
        .fetch_optional(pool)
        .await?;

        if let Some(ref inv) = invoice {
            AuditService::log(
                pool,
                "incoming_invoices",
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

    let result = sqlx::query!(r#"DELETE FROM incoming_invoices WHERE id = $1"#, id)
        .execute(pool)
        .await?;

    if result.rows_affected() > 0 {
        if let Some(ref inv) = old {
            AuditService::log(
                pool,
                "incoming_invoices",
                id,
                "delete",
                Some(inv),
                None::<&IncomingInvoice>,
                user_id,
            )
            .await?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub async fn get_invoice_reconciliation(
    pool: &PgPool,
) -> Result<Vec<InvoiceReconciliation>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceReconciliation,
        r#"SELECT 
            invoice_id as "invoice_id!",
            invoice_number as "invoice_number!",
            vendor_name as "vendor_name!",
            invoice_date as "invoice_date!",
            invoice_total as "invoice_total!",
            purchases_total as "purchases_total!",
            difference as "difference!",
            is_matched as "is_matched!",
            purchase_count as "purchase_count!"
        FROM v_invoice_reconciliation
        ORDER BY invoice_date DESC"#
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
        r#"SELECT p.id, p.item_id, p.invoice_id, p.quantity, p.unit_cost, 
                  p.destination_id, p.status as "status: DeliveryStatus", 
                  p.delivery_date, p.notes, p.created_at, p.updated_at
           FROM purchases p
           JOIN items i ON i.id = p.item_id
           WHERE ($1::delivery_status IS NULL OR p.status = $1)
             AND ($2::uuid IS NULL OR p.destination_id = $2)
             AND ($3::uuid IS NULL OR i.vendor_id = $3)
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
        r#"SELECT id, item_id, invoice_id, quantity, unit_cost, 
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
        r#"INSERT INTO purchases (item_id, invoice_id, quantity, unit_cost, destination_id, status, delivery_date, notes) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           RETURNING id, item_id, invoice_id, quantity, unit_cost, 
                     destination_id, status as "status: DeliveryStatus", 
                     delivery_date, notes, created_at, updated_at"#,
        data.item_id,
        data.invoice_id,
        data.quantity,
        data.unit_cost,
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
        let purchase = sqlx::query_as!(
            Purchase,
            r#"UPDATE purchases SET 
                invoice_id = COALESCE($2, invoice_id),
                quantity = COALESCE($3, quantity),
                unit_cost = COALESCE($4, unit_cost),
                destination_id = COALESCE($5, destination_id),
                status = COALESCE($6, status),
                delivery_date = COALESCE($7, delivery_date),
                notes = COALESCE($8, notes)
               WHERE id = $1 
               RETURNING id, item_id, invoice_id, quantity, unit_cost, 
                         destination_id, status as "status: DeliveryStatus", 
                         delivery_date, notes, created_at, updated_at"#,
            id,
            data.invoice_id,
            data.quantity,
            data.unit_cost,
            data.destination_id,
            data.status as Option<DeliveryStatus>,
            data.delivery_date,
            data.notes
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
               RETURNING id, item_id, invoice_id, quantity, unit_cost, 
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
            pe.item_name as "item_name!",
            pe.vendor_name as "vendor_name!",
            pe.destination_code,
            pe.quantity as "quantity!",
            pe.unit_cost as "unit_cost!",
            pe.payout_price,
            pe.unit_profit,
            pe.total_profit,
            pe.total_cost,
            pe.total_revenue,
            pe.status as "status!: DeliveryStatus",
            pe.delivery_date,
            pe.invoice_id
        FROM v_purchase_economics pe
        JOIN purchases p ON p.id = pe.purchase_id
        JOIN items i ON i.id = p.item_id
        WHERE ($1::delivery_status IS NULL OR pe.status = $1)
          AND ($2::uuid IS NULL OR p.destination_id = $2)
          AND ($3::uuid IS NULL OR i.vendor_id = $3)
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
// Reports
// ============================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct ProfitReport {
    pub total_revenue: Option<Decimal>,
    pub total_cost: Option<Decimal>,
    pub total_profit: Option<Decimal>,
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
            SUM(total_revenue) as total_revenue,
            SUM(total_cost) as total_cost,
            SUM(total_profit) as total_profit,
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
