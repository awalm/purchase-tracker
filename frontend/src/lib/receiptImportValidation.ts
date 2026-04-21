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

export type MappedImportLineForMerge = {
  itemId: string
  description: string
  quantity: number
  unitCost: number | string
  notes?: string | null
}

export type MergedMappedImportLine = {
  itemId: string
  quantity: number
  unitCost: string
  notes: string
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

const normalizeDescriptionForFeeDetection = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const isFeeLikeDescription = (description: string): boolean => {
  const normalized = normalizeDescriptionForFeeDetection(description)
  if (!normalized) return false

  return (
    /\b(env|enu|environmental|eco)\s*fee\b/.test(normalized) ||
    /\bfee\b.*\b(env|enu|environmental|eco|handling)\b/.test(normalized) ||
    /\bhandling\s*fee\b/.test(normalized)
  )
}

const toPositiveFiniteNumber = (value: number | string): number | null => {
  const parsed = toFiniteNumber(value)
  if (parsed === null || parsed <= 0) return null
  return parsed
}

export const mergeMappedImportLines = (
  lines: MappedImportLineForMerge[]
): MergedMappedImportLine[] => {
  type Group = {
    itemId: string
    firstIndex: number
    totalAmount: number
    quantityAll: number
    quantityNonFee: number
    notes: string[]
  }

  const groups = new Map<string, Group>()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const itemId = line.itemId.trim()
    if (!itemId) continue

    const quantity = toPositiveFiniteNumber(line.quantity)
    const unitCost = toPositiveFiniteNumber(line.unitCost)
    if (quantity === null || unitCost === null) continue

    const amount = quantity * unitCost
    const feeLike = isFeeLikeDescription(line.description)

    const existing = groups.get(itemId)
    if (!existing) {
      groups.set(itemId, {
        itemId,
        firstIndex: index,
        totalAmount: amount,
        quantityAll: quantity,
        quantityNonFee: feeLike ? 0 : quantity,
        notes: line.notes?.trim() ? [line.notes.trim()] : [],
      })
      continue
    }

    existing.totalAmount += amount
    existing.quantityAll += quantity
    if (!feeLike) {
      existing.quantityNonFee += quantity
    }

    const note = line.notes?.trim()
    if (note && !existing.notes.includes(note)) {
      existing.notes.push(note)
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((group) => {
      const quantity = group.quantityNonFee > 0 ? group.quantityNonFee : group.quantityAll
      const unitCost = quantity > 0 ? group.totalAmount / quantity : 0
      const note = group.notes.join(" | ").trim()

      return {
        itemId: group.itemId,
        quantity: Math.max(1, Math.round(quantity)),
        unitCost: unitCost.toFixed(2),
        notes: note,
      }
    })
    .filter((line) => line.quantity > 0 && Number.parseFloat(line.unitCost) > 0)
}
