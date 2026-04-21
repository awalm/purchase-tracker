export type ImportLineSubtotalInput = {
  quantity: number | string
  unitCost: number | string | null | undefined
}

export type ReceiptDuplicateRecord = {
  id?: string
  receipt_number: string
}

export type ReceiptDuplicateBatchEntry = {
  id: string
  receiptNumber: string
}

export type DuplicateMappedImportLine = {
  lineNumber: number
  itemId: string | null | undefined
  itemName?: string | null
}

export type DuplicateMappedImportItem = {
  itemId: string
  itemName: string
  lineNumbers: number[]
}

const normalizeReceiptNumber = (value: string): string => value.trim().toLowerCase()

const toFiniteNumber = (value: number | string | null | undefined): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

export const truncateOptionLabel = (value: string, maxLength = 96): string => {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, Math.max(1, maxLength - 3))}...`
}

export const computeImportLineItemsSubtotal = (
  lines: ImportLineSubtotalInput[]
): number => {
  return lines.reduce((sum, line) => {
    const quantity = toFiniteNumber(line.quantity)
    const unitCost = toFiniteNumber(line.unitCost)

    if (quantity === null || unitCost === null || quantity <= 0 || unitCost <= 0) {
      return sum
    }

    return sum + quantity * unitCost
  }, 0)
}

export const getImportSubtotalDifference = (
  expectedSubtotal: number | string,
  lineItemsSubtotal: number
): number | null => {
  const expected = toFiniteNumber(expectedSubtotal)
  if (expected === null) return null
  return lineItemsSubtotal - expected
}

export const importSubtotalMatches = (
  expectedSubtotal: number | string,
  lineItemsSubtotal: number,
  tolerance = 0.01
): boolean => {
  const diff = getImportSubtotalDifference(expectedSubtotal, lineItemsSubtotal)
  if (diff === null) return false
  return Math.abs(diff) <= tolerance
}

export const findExistingReceiptByNumber = <T extends ReceiptDuplicateRecord>(
  receipts: T[],
  receiptNumber: string,
  options?: { excludeId?: string | null }
): T | null => {
  const normalized = normalizeReceiptNumber(receiptNumber)
  if (!normalized) return null

  return (
    receipts.find((receipt) => {
      if (options?.excludeId && receipt.id === options.excludeId) {
        return false
      }

      return normalizeReceiptNumber(receipt.receipt_number) === normalized
    }) || null
  )
}

export const hasBatchDuplicateReceiptNumber = <T extends ReceiptDuplicateBatchEntry>(
  entries: T[],
  target: T
): boolean => {
  const normalizedTarget = normalizeReceiptNumber(target.receiptNumber)
  if (!normalizedTarget) return false

  return entries.some((entry) => {
    if (entry.id === target.id) {
      return false
    }

    return normalizeReceiptNumber(entry.receiptNumber) === normalizedTarget
  })
}

export const findDuplicateMappedImportItems = (
  lines: DuplicateMappedImportLine[]
): DuplicateMappedImportItem[] => {
  const grouped = new Map<string, DuplicateMappedImportItem>()

  for (const line of lines) {
    const itemId = typeof line.itemId === "string" ? line.itemId.trim() : ""
    if (!itemId) continue

    const existing = grouped.get(itemId)
    if (existing) {
      existing.lineNumbers.push(line.lineNumber)
      continue
    }

    grouped.set(itemId, {
      itemId,
      itemName: line.itemName?.trim() || itemId,
      lineNumbers: [line.lineNumber],
    })
  }

  return Array.from(grouped.values()).filter((entry) => entry.lineNumbers.length > 1)
}
