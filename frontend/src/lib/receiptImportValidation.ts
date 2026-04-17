export type ImportLineSubtotalInput = {
  quantity: number | string
  unitCost: number | string | null | undefined
}

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
