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
  kind: "tax-math-error" | "unexpected-tax-rate" | "no-receipt-lines" | "no-linked-purchases" | "ready-to-reconcile" | "reconciled" | "issues"
  label: string
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

export const getReceiptReconciliationBadgeState = (
  receipt: ReceiptSummaryLike,
  expectedTaxRate: number = DEFAULT_EXPECTED_TAX_RATE
): ReceiptReconciliationBadgeState => {
  const subtotal = Number.parseFloat(receipt.subtotal || "0")
  const taxAmount = Number.parseFloat(receipt.tax_amount || "0")
  const total = Number.parseFloat(receipt.total || "0")

  // Tax math check: subtotal + tax_amount should ≈ total
  if (subtotal > 0 && total > 0) {
    const diff = Math.abs(subtotal + taxAmount - total)
    if (diff > 0.02) {
      return {
        kind: "tax-math-error",
        label: `Tax math: ${formatCurrency(diff)} off`,
      }
    }
  }

  // Unexpected tax rate check
  if (subtotal > 0 && expectedTaxRate > 0) {
    const effectiveRate = getEffectiveTaxRate(subtotal, taxAmount)
    if (effectiveRate !== null && Math.abs(effectiveRate - expectedTaxRate) > 0.05) {
      return {
        kind: "unexpected-tax-rate",
        label: `Tax rate: ${formatNumber(effectiveRate.toFixed(2))}% (expected ${formatNumber(expectedTaxRate.toFixed(2))}%)`,
      }
    }
  }

  const purchasesTotal = Number.parseFloat(receipt.purchases_total || "0")
  const difference = Math.abs(subtotal - purchasesTotal)
  const linkedPurchaseCount = receipt.purchase_count || 0
  const receiptLineItemCount = getReceiptItemsDisplayCount(receipt)
  const invoicedCount = receipt.invoiced_count || 0
  const lockedPurchaseCount = receipt.locked_purchase_count || 0
  const allInvoiced = linkedPurchaseCount > 0 && invoicedCount === linkedPurchaseCount
  const allLocked = linkedPurchaseCount > 0 && lockedPurchaseCount === linkedPurchaseCount
  const totalsMatched = difference < 0.01

  if (receiptLineItemCount === 0) {
    return {
      kind: "no-receipt-lines",
      label: "No receipt lines",
    }
  }

  if (linkedPurchaseCount === 0) {
    return {
      kind: "no-linked-purchases",
      label: "No linked purchases",
    }
  }

  if (totalsMatched && allInvoiced && allLocked) {
    return {
      kind: "reconciled",
      label: "Reconciled",
    }
  }

  if (totalsMatched && allInvoiced && !allLocked) {
    return {
      kind: "ready-to-reconcile",
      label: `Ready to reconcile (${lockedPurchaseCount}/${linkedPurchaseCount} finalized)`,
    }
  }

  const issues: string[] = []
  if (!totalsMatched) {
    issues.push(`${formatCurrency(difference)} off`)
  }
  if (!allInvoiced) {
    issues.push(`${invoicedCount}/${linkedPurchaseCount} invoiced`)
  }

  return {
    kind: "issues",
    label: issues.join(" · "),
  }
}
