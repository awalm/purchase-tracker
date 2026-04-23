import { describe, expect, it } from "vitest"
import {
  assessPurchaseReconciliation,
  type PurchaseReconciliationInput,
} from "./purchaseReconciliation"

const buildInput = (overrides: Partial<PurchaseReconciliationInput> = {}): PurchaseReconciliationInput => ({
  quantity: 1,
  purchase_cost: "39.99",
  receipt_id: "r1",
  invoice_id: "i1",
  invoice_unit_price: "42.00",
  destination_code: "BSC",
  ...overrides,
})

describe("assessPurchaseReconciliation", () => {
  it("is NOT reconciled when invoice is not locked, even if all data is good", () => {
    const result = assessPurchaseReconciliation(buildInput({ invoiceLocked: false }))
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(true)
    expect(result.reasons).toHaveLength(0)
  })

  it("is NOT reconciled when invoiceLocked is omitted (undefined)", () => {
    const result = assessPurchaseReconciliation(buildInput())
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(true)
    expect(result.reasons).toHaveLength(0)
  })

  it("IS reconciled when invoice is locked and all data is good", () => {
    const result = assessPurchaseReconciliation(buildInput({ invoiceLocked: true }))
    expect(result.isReconciled).toBe(true)
    expect(result.isReadyToReconcile).toBe(false)
    expect(result.reasons).toHaveLength(0)
  })

  it("is NOT reconciled or ready when data issues exist, regardless of lock state", () => {
    const result = assessPurchaseReconciliation(buildInput({
      invoiceLocked: true,
      receipt_id: null, // missing receipt
    }))
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(false)
    expect(result.reasons).toContain("Missing receipt link")
  })

  it("regression: inv 6 purchases show 'ready to reconcile' not 'reconciled' when invoice is open", () => {
    // PS5 Digital on invoice 6 — all data present, invoice NOT locked
    const result = assessPurchaseReconciliation({
      quantity: 1,
      purchase_cost: "449.99",
      receipt_id: "r-ps5",
      invoice_id: "inv-6",
      invoice_unit_price: "453.00",
      destination_code: "BSC",
      invoiceLocked: false,
    })
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(true)
  })

  it("missing invoice_unit_price is not ready", () => {
    const result = assessPurchaseReconciliation(buildInput({
      invoice_unit_price: null,
      invoiceLocked: false,
    }))
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(false)
    expect(result.reasons).toContain("Missing invoice unit price")
  })

  it("missing destination is not ready", () => {
    const result = assessPurchaseReconciliation(buildInput({
      destination_code: null,
      invoiceLocked: false,
    }))
    expect(result.isReconciled).toBe(false)
    expect(result.isReadyToReconcile).toBe(false)
    expect(result.reasons).toContain("Missing destination")
  })
})
