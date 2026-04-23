import { describe, expect, it } from "vitest"
import {
  getReceiptItemsDisplayCount,
  getReceiptReconciliationBadgeState,
  getEffectiveTaxRate,
  type ReceiptSummaryLike,
} from "./receiptSummary"

const buildReceipt = (overrides: Partial<ReceiptSummaryLike> = {}): ReceiptSummaryLike => ({
  subtotal: "100.00",
  tax_amount: "13.00",
  total: "113.00",
  purchases_total: "100.00",
  purchase_count: 1,
  invoiced_count: 1,
  locked_purchase_count: 1,
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

  it("shows tax-math-error when subtotal + tax_amount ≠ total", () => {
    const receipt = buildReceipt({
      subtotal: "100.00",
      tax_amount: "13.00",
      total: "120.00", // off by $7.00
    })

    const state = getReceiptReconciliationBadgeState(receipt)

    expect(state.kind).toBe("tax-math-error")
    expect(state.label).toContain("off")
  })

  it("does not show tax-math-error when math is within tolerance", () => {
    const receipt = buildReceipt({
      subtotal: "100.00",
      tax_amount: "13.00",
      total: "113.01", // only $0.01 off — within tolerance
    })

    const state = getReceiptReconciliationBadgeState(receipt)

    expect(state.kind).not.toBe("tax-math-error")
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

  it("shows reconciled when totals match, all linked purchases invoiced, and all are finalized", () => {
    const state = getReceiptReconciliationBadgeState(buildReceipt())

    expect(state.kind).toBe("reconciled")
    expect(state.label).toBe("Reconciled")
  })

  it("shows ready-to-reconcile when totals match and all linked purchases invoiced but invoices are not finalized", () => {
    const state = getReceiptReconciliationBadgeState(
      buildReceipt({
        purchase_count: 1,
        invoiced_count: 1,
        locked_purchase_count: 0,
      })
    )

    expect(state.kind).toBe("ready-to-reconcile")
    expect(state.label).toContain("Ready to reconcile")
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

  it("shows unexpected-tax-rate when effective rate differs from expected", () => {
    const receipt = buildReceipt({
      subtotal: "100.00",
      tax_amount: "5.00", // 5% instead of 13%
      total: "105.00",
    })

    const state = getReceiptReconciliationBadgeState(receipt, 13)

    expect(state.kind).toBe("unexpected-tax-rate")
    expect(state.label).toContain("5%")
    expect(state.label).toContain("expected")
  })

  it("does not show unexpected-tax-rate when rate matches expected", () => {
    const receipt = buildReceipt({
      subtotal: "100.00",
      tax_amount: "13.00",
      total: "113.00",
    })

    const state = getReceiptReconciliationBadgeState(receipt, 13)

    expect(state.kind).not.toBe("unexpected-tax-rate")
  })

  it("uses custom expected tax rate for unexpected-tax-rate check", () => {
    const receipt = buildReceipt({
      subtotal: "100.00",
      tax_amount: "13.00",
      total: "113.00",
    })

    // If expected is 15%, then 13% is unexpected
    const state = getReceiptReconciliationBadgeState(receipt, 15)
    expect(state.kind).toBe("unexpected-tax-rate")
  })

  it("flags Staples receipt with correct math but wrong tax rate (regression)", () => {
    // Real case: receipt 00120020125871_20251117
    // Math is correct ($159.96 + $13.00 = $172.96) but rate is 8.13% not 13%
    const receipt = buildReceipt({
      subtotal: "159.96",
      tax_amount: "13.00",
      total: "172.96",
      purchase_count: 1,
      invoiced_count: 1,
      receipt_line_item_count: 1,
      purchases_total: "159.96",
    })

    const state = getReceiptReconciliationBadgeState(receipt, 13)
    expect(state.kind).toBe("unexpected-tax-rate")
    expect(state.label).toContain("8.1")
    expect(state.label).toContain("expected")
  })
})

describe("getEffectiveTaxRate", () => {
  it("computes tax rate from stored amounts", () => {
    expect(getEffectiveTaxRate(100, 13)).toBeCloseTo(13.0)
    expect(getEffectiveTaxRate(200, 26)).toBeCloseTo(13.0)
  })

  it("returns null when subtotal is zero", () => {
    expect(getEffectiveTaxRate(0, 13)).toBeNull()
  })
})
