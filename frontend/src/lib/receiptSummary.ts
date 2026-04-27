import { formatCurrency, formatNumber } from "@/lib/utils"

export type ReceiptSummaryLike = {
  subtotal: string
  tax_amount: string
  total: string
  purchases_total: string | null
  purchase_count: number | null
  invoiced_count: number | null
  locked_purchase_count: number | null
  receipt_line_item_count: number | null
}

export type ReceiptReconciliationBadgeState = {
  kind: "error" | "warning" | "reconciled" | "nominal"
  label: string
  detail?: string
}

export type ReceiptTaxValidationState = {
  kind: "error" | "warning"
  label: string
  detail?: string
}

export const DEFAULT_EXPECTED_TAX_RATE = 13
export const EXPECTED_TAX_RATE_STORAGE_KEY = "bg-tracker-expected-tax-rate"

export const getStoredExpectedTaxRate = (): number => {
  const stored = localStorage.getItem(EXPECTED_TAX_RATE_STORAGE_KEY)
  return stored ? parseFloat(stored) : DEFAULT_EXPECTED_TAX_RATE
}

export const getReceiptItemsDisplayCount = (receipt: ReceiptSummaryLike): number => {
  return Math.max(0, receipt.receipt_line_item_count || 0)
}

/** Compute effective tax rate % from stored amounts */
export const getEffectiveTaxRate = (subtotal: number, taxAmount: number): number | null => {
  if (subtotal <= 0) return null
  return (taxAmount / subtotal) * 100
}

export const getReceiptTaxValidationState = (
  receipt: Pick<ReceiptSummaryLike, "subtotal" | "tax_amount" | "total">,
  expectedTaxRate: number = DEFAULT_EXPECTED_TAX_RATE
): ReceiptTaxValidationState | null => {
  const subtotal = Number.parseFloat(receipt.subtotal || "0")
  const taxAmount = Number.parseFloat(receipt.tax_amount || "0")
  const total = Number.parseFloat(receipt.total || "0")

  if (subtotal > 0 && total > 0) {
    const diff = Math.abs(subtotal + taxAmount - total)
    if (diff > 0.02) {
      return {
        kind: "error",
        label: "Tax Math Error",
        detail: `subtotal + tax is ${formatCurrency(diff)} off from total`,
      }
    }
  }

  if (subtotal > 0 && expectedTaxRate > 0) {
    const effectiveRate = getEffectiveTaxRate(subtotal, taxAmount)
    if (effectiveRate !== null && Math.abs(effectiveRate - expectedTaxRate) > 0.05) {
      return {
        kind: "warning",
        label: "Unexpected Tax Rate",
        detail: `${formatNumber(effectiveRate.toFixed(2))}% (expected ${formatNumber(expectedTaxRate.toFixed(2))}%)`,
      }
    }
  }

  return null
}

export const getReceiptReconciliationBadgeState = (
  receipt: ReceiptSummaryLike,
  expectedTaxRate: number = DEFAULT_EXPECTED_TAX_RATE
): ReceiptReconciliationBadgeState => {
  const taxValidationState = getReceiptTaxValidationState(receipt, expectedTaxRate)
  if (taxValidationState) {
    return taxValidationState
  }

  const linkedPurchaseCount = receipt.purchase_count || 0
  const receiptLineItemCount = getReceiptItemsDisplayCount(receipt)
  const lockedPurchaseCount = receipt.locked_purchase_count || 0
  const allLocked = linkedPurchaseCount > 0 && lockedPurchaseCount === linkedPurchaseCount

  if (receiptLineItemCount === 0) {
    return {
      kind: "warning",
      label: "No Receipt Lines",
    }
  }

  if (allLocked) {
    return {
      kind: "reconciled",
      label: "Reconciled",
    }
  }

  return {
    kind: "nominal",
    label: "Nominal",
  }
}
