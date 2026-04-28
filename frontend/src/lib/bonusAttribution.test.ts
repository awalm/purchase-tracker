import { describe, expect, it } from "vitest"
import { getBonusAttribution, countUnattributedBonuses, buildDisplayRows } from "./bonusAttribution"
import type { PurchaseEconomics } from "../types"

describe("getBonusAttribution", () => {
  it("returns no attribution for unit purchases", () => {
    const result = getBonusAttribution({
      purchase_type: "unit",
      bonus_for_purchase_id: null,
      bonus_parent_item_name: null,
      bonus_parent_quantity: null,
      bonus_parent_invoice_number: null,
    })
    expect(result.isAttributed).toBe(false)
    expect(result.label).toBeNull()
    expect(result.showDistributeAction).toBe(false)
  })

  it("returns distribute action for unattributed bonus", () => {
    const result = getBonusAttribution({
      purchase_type: "bonus",
      bonus_for_purchase_id: null,
      bonus_parent_item_name: null,
      bonus_parent_quantity: null,
      bonus_parent_invoice_number: null,
    })
    expect(result.isAttributed).toBe(false)
    expect(result.label).toBeNull()
    expect(result.showDistributeAction).toBe(true)
  })

  it("returns attribution label for same-invoice parent", () => {
    const result = getBonusAttribution({
      purchase_type: "bonus",
      bonus_for_purchase_id: "parent-uuid",
      bonus_parent_item_name: "Echo Dot 5th Gen White",
      bonus_parent_quantity: 4,
      bonus_parent_invoice_number: "7",
    })
    expect(result.isAttributed).toBe(true)
    expect(result.label).toBe("↳ attributed to Echo Dot 5th Gen White × 4 (inv #7)")
    expect(result.showDistributeAction).toBe(false)
  })

  it("returns attribution label for cross-invoice parent", () => {
    const result = getBonusAttribution({
      purchase_type: "bonus",
      bonus_for_purchase_id: "parent-on-inv-6",
      bonus_parent_item_name: "Echo Dot 5th Gen Blue",
      bonus_parent_quantity: 28,
      bonus_parent_invoice_number: "6",
    })
    expect(result.isAttributed).toBe(true)
    expect(result.label).toBe("↳ attributed to Echo Dot 5th Gen Blue × 28 (inv #6)")
    expect(result.showDistributeAction).toBe(false)
  })

  it("handles attributed bonus where server didn't return parent info", () => {
    const result = getBonusAttribution({
      purchase_type: "bonus",
      bonus_for_purchase_id: "parent-uuid",
      bonus_parent_item_name: null,
      bonus_parent_quantity: null,
      bonus_parent_invoice_number: null,
    })
    expect(result.isAttributed).toBe(true)
    expect(result.label).toContain("parent details unavailable")
    expect(result.showDistributeAction).toBe(false)
  })

  it("returns no attribution for refund purchases", () => {
    const result = getBonusAttribution({
      purchase_type: "refund",
      bonus_for_purchase_id: null,
      bonus_parent_item_name: null,
      bonus_parent_quantity: null,
      bonus_parent_invoice_number: null,
    })
    expect(result.isAttributed).toBe(false)
    expect(result.label).toBeNull()
    expect(result.showDistributeAction).toBe(false)
  })
})

describe("countUnattributedBonuses", () => {
  it("returns 0 when no bonuses", () => {
    const purchases = [
      { purchase_type: "unit", bonus_for_purchase_id: null },
      { purchase_type: "unit", bonus_for_purchase_id: null },
    ]
    expect(countUnattributedBonuses(purchases)).toBe(0)
  })

  it("counts unattributed bonuses only", () => {
    const purchases = [
      { purchase_type: "unit", bonus_for_purchase_id: null },
      { purchase_type: "bonus", bonus_for_purchase_id: null },
      { purchase_type: "bonus", bonus_for_purchase_id: "parent-1" },
      { purchase_type: "bonus", bonus_for_purchase_id: null },
      { purchase_type: "bonus", bonus_for_purchase_id: "parent-2" },
    ]
    expect(countUnattributedBonuses(purchases)).toBe(2)
  })

  it("returns 0 when all bonuses are attributed", () => {
    const purchases = [
      { purchase_type: "bonus", bonus_for_purchase_id: "p1" },
      { purchase_type: "bonus", bonus_for_purchase_id: "p2" },
    ]
    expect(countUnattributedBonuses(purchases)).toBe(0)
  })

  it("returns 0 for empty list", () => {
    expect(countUnattributedBonuses([])).toBe(0)
  })
})

const makePurchase = (overrides: Partial<PurchaseEconomics> = {}): PurchaseEconomics => ({
  purchase_id: "p-" + Math.random().toString(36).slice(2, 8),
  purchase_date: "2025-12-02",
  item_id: "item-1",
  item_name: "Echo Dot 5th Gen Blue",
  vendor_name: null,
  destination_code: null,
  quantity: 10,
  purchase_cost: "0",
  cost_adjustment: null,
  adjustment_note: null,
  total_cost: "0",
  invoice_unit_price: "0.50",
  total_selling: "5.00",
  unit_commission: "0",
  total_commission: "0",
  tax_paid: "0",
  tax_owed: "0",
  status: "delivered",
  delivery_date: null,
  invoice_id: "inv-7",
  receipt_id: null,
  receipt_number: null,
  invoice_number: "7",
  allow_receipt_date_override: false,
  notes: null,
  refunds_purchase_id: null,
  purchase_type: "unit",
  bonus_for_purchase_id: null,
  bonus_parent_item_name: null,
  bonus_parent_quantity: null,
  bonus_parent_invoice_number: null,
  display_parent_purchase_id: null,
  display_group: null,
  invoice_reconciliation_state: null,
  ...overrides,
})

describe("buildDisplayRows", () => {
  it("passes through unit and refund purchases unchanged", () => {
    const purchases = [
      makePurchase({ purchase_type: "unit" }),
      makePurchase({ purchase_type: "refund" }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe("purchase")
    expect(rows[1].kind).toBe("purchase")
  })

  it("passes through unattributed bonuses as regular rows", () => {
    const purchases = [
      makePurchase({ purchase_type: "bonus", bonus_for_purchase_id: null }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("purchase")
  })

  it("collapses attributed bonuses for the same item into one group", () => {
    const purchases = [
      makePurchase({
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "parent-1",
        quantity: 4,
        total_selling: "2.00",
        total_commission: "0",
        bonus_parent_item_name: "Echo Dot 5th Gen Blue",
        bonus_parent_quantity: 4,
        bonus_parent_invoice_number: "5",
      }),
      makePurchase({
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "parent-2",
        quantity: 28,
        total_selling: "14.00",
        total_commission: "0",
        bonus_parent_item_name: "Echo Dot 5th Gen Blue",
        bonus_parent_quantity: 28,
        bonus_parent_invoice_number: "6",
      }),
      makePurchase({
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "parent-3",
        quantity: 10,
        total_selling: "5.00",
        total_commission: "0",
        bonus_parent_item_name: "Echo Dot 5th Gen Blue",
        bonus_parent_quantity: 10,
        bonus_parent_invoice_number: "7",
      }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("bonus-group")
    if (rows[0].kind === "bonus-group") {
      expect(rows[0].totalQty).toBe(42)
      expect(rows[0].totalSelling).toBeCloseTo(21.0)
      expect(rows[0].attributions).toHaveLength(3)
      expect(rows[0].purchaseIds).toHaveLength(3)
      expect(rows[0].attributions[0].invoiceNumber).toBe("5")
      expect(rows[0].attributions[1].invoiceNumber).toBe("6")
      expect(rows[0].attributions[2].invoiceNumber).toBe("7")
    }
  })

  it("keeps separate groups for different items", () => {
    const purchases = [
      makePurchase({
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "p1",
        quantity: 10,
        total_selling: "5.00",
        bonus_parent_item_name: "Echo Dot Blue",
        bonus_parent_quantity: 10,
        bonus_parent_invoice_number: "7",
      }),
      makePurchase({
        item_id: "echo-white",
        item_name: "Echo Dot 5th Gen White",
        purchase_type: "bonus",
        bonus_for_purchase_id: "p2",
        quantity: 4,
        total_selling: "2.00",
        bonus_parent_item_name: "Echo Dot White",
        bonus_parent_quantity: 4,
        bonus_parent_invoice_number: "7",
      }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe("bonus-group")
    expect(rows[1].kind).toBe("bonus-group")
    if (rows[0].kind === "bonus-group" && rows[1].kind === "bonus-group") {
      expect(rows[0].totalQty).toBe(10)
      expect(rows[1].totalQty).toBe(4)
    }
  })

  it("orphan bonus group placed after all unit rows", () => {
    const purchases = [
      makePurchase({ purchase_id: "unit-1", purchase_type: "unit", item_id: "ps5" }),
      makePurchase({
        purchase_id: "bonus-blue-1",
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "p1",
        quantity: 4,
        total_selling: "2.00",
        bonus_parent_item_name: "Echo Blue",
        bonus_parent_quantity: 4,
        bonus_parent_invoice_number: "5",
      }),
      makePurchase({ purchase_id: "unit-2", purchase_type: "unit", item_id: "kindle" }),
      makePurchase({
        purchase_id: "bonus-blue-2",
        item_id: "echo-blue",
        purchase_type: "bonus",
        bonus_for_purchase_id: "p2",
        quantity: 28,
        total_selling: "14.00",
        bonus_parent_item_name: "Echo Blue",
        bonus_parent_quantity: 28,
        bonus_parent_invoice_number: "6",
      }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(3)
    expect(rows[0].kind).toBe("purchase") // unit-1
    expect(rows[1].kind).toBe("purchase") // unit-2
    expect(rows[2].kind).toBe("bonus-group") // orphan bonus group at end
    if (rows[2].kind === "bonus-group") {
      expect(rows[2].totalQty).toBe(32)
      expect(rows[2].attributions).toHaveLength(2)
    }
  })

  it("returns empty array for empty input", () => {
    expect(buildDisplayRows([])).toHaveLength(0)
  })

  it("single attributed bonus still becomes a group of 1", () => {
    const purchases = [
      makePurchase({
        item_id: "echo-white",
        purchase_type: "bonus",
        bonus_for_purchase_id: "p1",
        quantity: 4,
        total_selling: "2.00",
        bonus_parent_item_name: "Echo Dot White",
        bonus_parent_quantity: 4,
        bonus_parent_invoice_number: "7",
      }),
    ]
    const rows = buildDisplayRows(purchases)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("bonus-group")
    if (rows[0].kind === "bonus-group") {
      expect(rows[0].totalQty).toBe(4)
      expect(rows[0].attributions).toHaveLength(1)
    }
  })
})
