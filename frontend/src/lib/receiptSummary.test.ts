import { describe, expect, it } from "vitest"
import {
  getReceiptItemsDisplayCount,
  getReceiptReconciliationBadgeState,
  type ReceiptSummaryLike,
} from "./receiptSummary"

const buildReceipt = (overrides: Partial<ReceiptSummaryLike> = {}): ReceiptSummaryLike => ({
  subtotal: "100.00",
  purchases_total: "100.00",
  purchase_count: 1,
  invoiced_count: 1,
  receipt_line_item_count: 1,
  ...overrides,
})

describe("receiptSummary", () => {
  it("uses receipt line item count for items display", () => {
    const receipt = buildReceipt({
      receipt_line_item_count: 3,
      purchase_count: 0,
    })

    expect(getReceiptItemsDisplayCount(receipt)).toBe(3)
  })

  it("shows no linked purchases when receipt has lines but no purchases (regression)", () => {
    const receipt = buildReceipt({
      receipt_line_item_count: 2,
      purchase_count: 0,
      purchases_total: "0",
      invoiced_count: 0,
    })

    const state = getReceiptReconciliationBadgeState(receipt)

    expect(state.kind).toBe("no-linked-purchases")
    expect(state.label).toBe("No linked purchases")
  })

  it("shows no receipt lines when receipt has no lines", () => {
    const receipt = buildReceipt({
      receipt_line_item_count: 0,
      purchase_count: 0,
      purchases_total: "0",
      invoiced_count: 0,
    })

    const state = getReceiptReconciliationBadgeState(receipt)

    expect(state.kind).toBe("no-receipt-lines")
    expect(state.label).toBe("No receipt lines")
  })

  it("shows reconciled when totals match and all linked purchases invoiced", () => {
    const state = getReceiptReconciliationBadgeState(buildReceipt())

    expect(state.kind).toBe("reconciled")
    expect(state.label).toBe("Reconciled")
  })

  it("shows issue details when linked purchases are not fully invoiced", () => {
    const receipt = buildReceipt({
      purchase_count: 2,
      invoiced_count: 1,
      receipt_line_item_count: 2,
    })

    const state = getReceiptReconciliationBadgeState(receipt)

    expect(state.kind).toBe("issues")
    expect(state.label).toContain("1/2 invoiced")
  })
})
