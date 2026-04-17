//! Pure business logic for purchase allocations, decoupled from database queries.
//! These functions test allocation-backed resolution of receipt links and costs.

use rust_decimal::Decimal;
use uuid::Uuid;

/// Resolves the effective receipt_id for a purchase considering allocations.
///
/// If the purchase has a direct receipt_id, use it. Otherwise, if allocations exist,
/// use the receipt_id from any allocation. This handles detached purchases that are
/// linked to receipts only via allocations.
pub fn resolve_receipt_id(
    direct_receipt_id: Option<Uuid>,
    any_allocation_receipt_id: Option<Uuid>,
) -> Option<Uuid> {
    direct_receipt_id.or(any_allocation_receipt_id)
}

/// Resolves the effective unit cost for a purchase considering allocations.
///
/// if allocations fully cover the purchase quantity and the stored purchase_cost is 0
/// (indicating a stale/unknown cost), derive the unit cost from allocations.
/// Otherwise, use the stored purchase_cost.
///
/// # Arguments
/// * `purchase_cost` - The stored cost on the purchase record
/// * `quantity` - The purchase quantity
/// * `allocated_qty` - Total quantity covered by allocations
/// * `allocated_total_cost` - Total cost from allocations
pub fn resolve_effective_unit_cost(
    purchase_cost: Decimal,
    quantity: i32,
    allocated_qty: i32,
    allocated_total_cost: Decimal,
) -> Decimal {
    // If allocations fully cover the purchase and purchase_cost is 0, use allocation cost
    if allocated_qty == quantity
        && allocated_qty > 0
        && quantity > 0
        && purchase_cost == Decimal::ZERO
    {
        return if quantity > 0 {
            allocated_total_cost / Decimal::from(quantity)
        } else {
            Decimal::ZERO
        };
    }

    // Otherwise use stored purchase_cost
    purchase_cost
}

/// Computes commission from a purchase cost and commission rate.
pub fn compute_commission(purchase_cost: Decimal, commission_rate: Decimal) -> Decimal {
    purchase_cost * commission_rate / Decimal::from(100)
}

/// Validates that an allocation doesn't exceed the available quantity on a receipt line.
///
/// # Arguments
/// * `allocated_for_line_sum` - Total quantity already allocated to this line item
/// * `requested_qty` - Quantity requested for this new allocation
/// * `receipt_line_qty` - Total quantity on the receipt line item
///
/// # Errors
/// Returns an error description if validation fails.
pub fn validate_allocation_qty(
    allocated_for_line_sum: i32,
    requested_qty: i32,
    receipt_line_qty: i32,
) -> Result<(), String> {
    if allocated_for_line_sum + requested_qty > receipt_line_qty {
        return Err(format!(
            "Allocated quantity exceeds receipt line quantity (allocated: {}, requested: {}, receipt line qty: {})",
            allocated_for_line_sum, requested_qty, receipt_line_qty
        ));
    }
    Ok(())
}

/// Clamps a requested quantity to the maximum allocatable quantity.
///
/// This is used by UI flows that should allocate the largest possible amount
/// instead of failing when the requested quantity is above the available cap.
pub fn clamp_requested_allocation_qty(requested_qty: i32, max_allocatable_qty: i32) -> i32 {
    requested_qty.clamp(0, max_allocatable_qty.max(0))
}

/// Checks if a purchase update would violate receipt-linked purchase constraints.
///
/// Purchases linked to receipts cannot have their item, quantity, or purchase_cost modified
/// to prevent accidental data inconsistency.
pub fn validate_receipt_linked_purchase_update(
    is_receipt_linked: bool,
    item_changed: bool,
    quantity_changed: bool,
    cost_changed: bool,
) -> Result<(), String> {
    if is_receipt_linked && (item_changed || quantity_changed || cost_changed) {
        let changed_fields: Vec<&str> = [
            if item_changed { Some("item") } else { None },
            if quantity_changed {
                Some("quantity")
            } else {
                None
            },
            if cost_changed {
                Some("purchase_cost")
            } else {
                None
            },
        ]
        .into_iter()
        .flatten()
        .collect();

        return Err(format!(
            "Cannot modify {} on purchase linked to receipt: {}",
            changed_fields.join(", "),
            "receipt-linked purchases must be unlinked first or edited via allocations"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_receipt_id_prefers_direct_link() {
        let direct_id = Uuid::new_v4();
        let alloc_id = Uuid::new_v4();

        let result = resolve_receipt_id(Some(direct_id), Some(alloc_id));
        assert_eq!(result, Some(direct_id));
    }

    #[test]
    fn resolve_receipt_id_falls_back_to_allocation() {
        let alloc_id = Uuid::new_v4();

        let result = resolve_receipt_id(None, Some(alloc_id));
        assert_eq!(result, Some(alloc_id));
    }

    #[test]
    fn resolve_receipt_id_returns_none_when_both_absent() {
        let result = resolve_receipt_id(None, None);
        assert_eq!(result, None);
    }

    #[test]
    fn effective_cost_uses_allocation_when_purchase_cost_is_zero() {
        let result = resolve_effective_unit_cost(
            Decimal::ZERO,           // purchase_cost
            2,                       // quantity
            2,                       // allocated_qty
            Decimal::new(175998, 2), // allocated_total_cost (2 × 87999)
        );
        assert_eq!(result, Decimal::new(87999, 2));
    }

    #[test]
    fn effective_cost_uses_purchase_cost_when_nonzero() {
        let result = resolve_effective_unit_cost(
            Decimal::new(50000, 2),  // purchase_cost
            2,                       // quantity
            2,                       // allocated_qty
            Decimal::new(175998, 2), // allocated_total_cost
        );
        assert_eq!(result, Decimal::new(50000, 2));
    }

    #[test]
    fn effective_cost_uses_purchase_cost_when_allocations_partial() {
        let result = resolve_effective_unit_cost(
            Decimal::ZERO,          // purchase_cost
            2,                      // quantity
            1,                      // allocated_qty (partial)
            Decimal::new(87999, 2), // allocated_total_cost
        );
        assert_eq!(result, Decimal::ZERO);
    }

    #[test]
    fn effective_cost_handles_zero_quantity() {
        let result = resolve_effective_unit_cost(
            Decimal::new(50000, 2), // purchase_cost
            0,                      // quantity
            0,                      // allocated_qty
            Decimal::ZERO,
        );
        assert_eq!(result, Decimal::new(50000, 2));
    }

    #[test]
    fn commission_computation_applies_rate() {
        let cost = Decimal::new(100000, 2); // $1000
        let rate = Decimal::new(2, 0); // 2%
        let result = compute_commission(cost, rate);
        assert_eq!(result, Decimal::new(2000, 2)); // $20
    }

    #[test]
    fn commission_computation_handles_zero_cost() {
        let result = compute_commission(Decimal::ZERO, Decimal::new(2, 0));
        assert_eq!(result, Decimal::ZERO);
    }

    #[test]
    fn commission_computation_handles_zero_rate() {
        let result = compute_commission(Decimal::new(100000, 2), Decimal::ZERO);
        assert_eq!(result, Decimal::ZERO);
    }

    #[test]
    fn validate_allocation_qty_rejects_exceeding_allocation() {
        let result = validate_allocation_qty(
            2, // already allocated
            3, // requested
            4, // receipt line qty
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Allocated quantity exceeds"));
    }

    #[test]
    fn validate_allocation_qty_allows_exact_fit() {
        let result = validate_allocation_qty(
            2, // already allocated
            2, // requested
            4, // receipt line qty
        );
        assert!(result.is_ok());
    }

    #[test]
    fn validate_allocation_qty_allows_partial() {
        let result = validate_allocation_qty(
            1, // already allocated
            1, // requested
            3, // receipt line qty
        );
        assert!(result.is_ok());
    }

    #[test]
    fn validate_allocation_qty_rejects_first_allocation_exceeding_line_qty() {
        let result = validate_allocation_qty(
            0, // none allocated yet
            5, // requested
            4, // receipt line qty
        );
        assert!(result.is_err());
    }

    #[test]
    fn clamp_requested_allocation_qty_caps_to_available_quantity() {
        assert_eq!(clamp_requested_allocation_qty(7, 4), 4);
    }

    #[test]
    fn clamp_requested_allocation_qty_keeps_smaller_requests() {
        assert_eq!(clamp_requested_allocation_qty(3, 4), 3);
    }

    #[test]
    fn clamp_requested_allocation_qty_never_goes_negative() {
        assert_eq!(clamp_requested_allocation_qty(-3, 4), 0);
    }

    #[test]
    fn validate_receipt_linked_purchase_allows_nonlinked_updates() {
        let result = validate_receipt_linked_purchase_update(
            false, // not receipt-linked
            true,  // item changed
            true,  // quantity changed
            true,  // cost changed
        );
        assert!(result.is_ok());
    }

    #[test]
    fn validate_receipt_linked_purchase_rejects_item_change() {
        let result = validate_receipt_linked_purchase_update(
            true, // receipt-linked
            true, // item changed
            false, false,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("item"));
    }

    #[test]
    fn validate_receipt_linked_purchase_rejects_quantity_change() {
        let result = validate_receipt_linked_purchase_update(
            true, // receipt-linked
            false, true, // quantity changed
            false,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("quantity"));
    }

    #[test]
    fn validate_receipt_linked_purchase_rejects_cost_change() {
        let result = validate_receipt_linked_purchase_update(
            true, // receipt-linked
            false, false, true, // cost changed
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("purchase_cost"));
    }

    #[test]
    fn validate_receipt_linked_purchase_allows_metadata_edit() {
        let result = validate_receipt_linked_purchase_update(
            true,  // receipt-linked
            false, // item NOT changed
            false, // quantity NOT changed
            false, // cost NOT changed
        );
        assert!(result.is_ok());
    }
}
