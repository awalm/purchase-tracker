export type PurchaseReconciliationInput = {
  quantity: number
  purchase_cost?: string | null
  receipt_id?: string | null
  receipt_date?: string | null
  invoice_id?: string | null
  invoice_date?: string | null
  invoice_unit_price?: string | null
  destination_code?: string | null
  destination_id?: string | null
  requireAllocations?: boolean
  allocationCount?: number
  allocatedQty?: number
  allocationReceiptDates?: Array<string | null | undefined>
  allowReceiptDateOverride?: boolean
}

export type PurchaseReconciliationAssessment = {
  isReconciled: boolean
  reasons: string[]
}

export function assessPurchaseReconciliation(
  input: PurchaseReconciliationInput
): PurchaseReconciliationAssessment {
  const normalizeDate = (value?: string | null): string | null => {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    return trimmed.slice(0, 10)
  }

  const reasons: string[] = []
  const allocationCount = input.allocationCount ?? 0
  const allocatedQty = input.allocatedQty ?? 0
  const hasReceiptLink = Boolean(input.receipt_id) || (input.requireAllocations && allocationCount > 0)

  if (!hasReceiptLink) {
    reasons.push("Missing receipt link")
  }

  if (!input.invoice_id) {
    reasons.push("Missing invoice link")
  }

  const invoiceDate = normalizeDate(input.invoice_date)
  const allocationReceiptDates = (input.allocationReceiptDates || [])
    .map((value) => normalizeDate(value || null))
    .filter((value): value is string => Boolean(value))
  const directReceiptDate = normalizeDate(input.receipt_date)
  const relevantReceiptDates = allocationReceiptDates.length > 0
    ? allocationReceiptDates
    : (directReceiptDate ? [directReceiptDate] : [])

  if (
    input.invoice_id &&
    invoiceDate &&
    !input.allowReceiptDateOverride &&
    relevantReceiptDates.some((receiptDate) => receiptDate > invoiceDate)
  ) {
    reasons.push("Receipt date is after invoice date")
  }

  if (!input.invoice_unit_price) {
    reasons.push("Missing invoice unit price")
  }

  const hasDestination = Boolean(input.destination_code || input.destination_id)
  if (!hasDestination) {
    reasons.push("Missing destination")
  }

  if (input.requireAllocations) {
    if (allocationCount === 0) {
      reasons.push("No receipt allocations")
    } else if (allocatedQty < input.quantity) {
      reasons.push(`Only ${allocatedQty}/${input.quantity} qty allocated`)
    } else if (allocatedQty > input.quantity) {
      reasons.push(`Over-allocated qty (${allocatedQty}/${input.quantity})`)
    }
  }

  const parsedPurchaseCost = Number.parseFloat(input.purchase_cost || "0")
  if (
    Number.isFinite(parsedPurchaseCost) &&
    parsedPurchaseCost === 0 &&
    ((input.requireAllocations && allocationCount === 0) || !hasReceiptLink)
  ) {
    reasons.push("Unit cost still unknown")
  }

  return {
    isReconciled: reasons.length === 0,
    reasons,
  }
}
