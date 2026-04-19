import { formatCurrency } from "@/lib/utils"

export type ReceiptSummaryLike = {
  subtotal: string
  purchases_total: string | null
  purchase_count: number | null
  invoiced_count: number | null
  receipt_line_item_count: number | null
}

export type ReceiptReconciliationBadgeState = {
  kind: "no-receipt-lines" | "no-linked-purchases" | "reconciled" | "issues"
  label: string
}

export const getReceiptItemsDisplayCount = (receipt: ReceiptSummaryLike): number => {
  return Math.max(0, receipt.receipt_line_item_count || 0)
}

export const getReceiptReconciliationBadgeState = (
  receipt: ReceiptSummaryLike
): ReceiptReconciliationBadgeState => {
  const subtotal = Number.parseFloat(receipt.subtotal || "0")
  const purchasesTotal = Number.parseFloat(receipt.purchases_total || "0")
  const difference = Math.abs(subtotal - purchasesTotal)
  const linkedPurchaseCount = receipt.purchase_count || 0
  const receiptLineItemCount = getReceiptItemsDisplayCount(receipt)
  const invoicedCount = receipt.invoiced_count || 0
  const allInvoiced = linkedPurchaseCount > 0 && invoicedCount === linkedPurchaseCount
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

  if (totalsMatched && allInvoiced) {
    return {
      kind: "reconciled",
      label: "Reconciled",
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
