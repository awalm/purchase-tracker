import { describe, it, expect } from "vitest"
import { buildPriceHistory } from "./vendorPriceHistory"
import type { PriceHistoryInput } from "./vendorPriceHistory"

function purchase(overrides: Partial<PriceHistoryInput> & { item_id: string }): PriceHistoryInput {
  return {
    item_name: "Test Item",
    quantity: 1,
    purchase_cost: "10.00",
    total_cost: null,
    purchase_date: "2025-01-01",
    ...overrides,
  }
}

describe("buildPriceHistory", () => {
  it("returns empty array for no purchases", () => {
    expect(buildPriceHistory([])).toEqual([])
  })

  it("aggregates a single purchase", () => {
    const rows = buildPriceHistory([
      purchase({ item_id: "a", item_name: "Widget", quantity: 5, purchase_cost: "20.00" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].item_name).toBe("Widget")
    expect(rows[0].purchase_count).toBe(1)
    expect(rows[0].total_qty).toBe(5)
    expect(rows[0].avg_unit).toBe(20)
    expect(rows[0].total_spend).toBe(100)
    expect(rows[0].min_unit).toBe(20)
    expect(rows[0].max_unit).toBe(20)
  })

  it("aggregates multiple purchases of the same item", () => {
    const rows = buildPriceHistory([
      purchase({ item_id: "a", item_name: "Echo Dot", quantity: 6, purchase_cost: "40.00" }),
      purchase({ item_id: "a", item_name: "Echo Dot", quantity: 4, purchase_cost: "38.00" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].purchase_count).toBe(2)
    expect(rows[0].total_qty).toBe(10)
    expect(rows[0].total_spend).toBe(6 * 40 + 4 * 38) // 392
    expect(rows[0].avg_unit).toBeCloseTo(39.2) // 392/10
    expect(rows[0].min_unit).toBe(38)
    expect(rows[0].max_unit).toBe(40)
  })

  it("uses vendor-scoped quantities, not total item quantities", () => {
    // Regression: if the backend returns vendor-scoped qty (e.g. 6 of 44),
    // the price history should show 6, not 44.
    const rows = buildPriceHistory([
      purchase({
        item_id: "echo",
        item_name: "Echo Dot 5th Gen Charcoal",
        quantity: 6, // vendor-scoped qty (was incorrectly 44 before fix)
        purchase_cost: "40.11",
      }),
      purchase({
        item_id: "echo",
        item_name: "Echo Dot 5th Gen Charcoal",
        quantity: 4,
        purchase_cost: "39.99",
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].total_qty).toBe(10) // 6+4, NOT 44+anything
    expect(rows[0].purchase_count).toBe(2)
  })

  it("groups different items separately", () => {
    const rows = buildPriceHistory([
      purchase({ item_id: "a", item_name: "PS5", quantity: 1, purchase_cost: "500.00" }),
      purchase({ item_id: "b", item_name: "Echo Dot", quantity: 10, purchase_cost: "40.00" }),
      purchase({ item_id: "a", item_name: "PS5", quantity: 2, purchase_cost: "510.00" }),
    ])
    expect(rows).toHaveLength(2)
    const ps5 = rows.find((r) => r.item_name === "PS5")!
    const echo = rows.find((r) => r.item_name === "Echo Dot")!
    expect(ps5.purchase_count).toBe(2)
    expect(ps5.total_qty).toBe(3)
    expect(echo.purchase_count).toBe(1)
    expect(echo.total_qty).toBe(10)
  })

  it("tracks last purchase date and unit cost", () => {
    const rows = buildPriceHistory([
      purchase({
        item_id: "a",
        item_name: "Widget",
        quantity: 1,
        purchase_cost: "10.00",
        purchase_date: "2025-11-25",
      }),
      purchase({
        item_id: "a",
        item_name: "Widget",
        quantity: 1,
        purchase_cost: "12.00",
        purchase_date: "2025-12-02",
      }),
    ])
    expect(rows[0].last_purchase).toBe("2025-12-02")
    expect(rows[0].last_unit).toBe(12)
  })

  it("uses total_cost when available instead of unit*qty", () => {
    const rows = buildPriceHistory([
      purchase({
        item_id: "a",
        item_name: "Widget",
        quantity: 5,
        purchase_cost: "10.00",
        total_cost: "45.00", // discount applied
      }),
    ])
    expect(rows[0].total_spend).toBe(45)
    expect(rows[0].avg_unit).toBe(9) // 45/5
  })

  it("sorts by total_spend descending", () => {
    const rows = buildPriceHistory([
      purchase({ item_id: "a", item_name: "Cheap", quantity: 1, purchase_cost: "5.00" }),
      purchase({ item_id: "b", item_name: "Expensive", quantity: 10, purchase_cost: "100.00" }),
      purchase({ item_id: "c", item_name: "Mid", quantity: 3, purchase_cost: "50.00" }),
    ])
    expect(rows.map((r) => r.item_name)).toEqual(["Expensive", "Mid", "Cheap"])
  })

  it("handles zero quantity without NaN", () => {
    const rows = buildPriceHistory([
      purchase({ item_id: "a", item_name: "Cancelled", quantity: 0, purchase_cost: "10.00" }),
    ])
    expect(rows[0].avg_unit).toBe(0)
    expect(Number.isNaN(rows[0].avg_unit)).toBe(false)
  })
})
