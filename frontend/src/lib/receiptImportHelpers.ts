import type { ParsedReceipt } from "@/api"
import {
  computeImportLineItemsSubtotal,
  mergeMappedImportLines,
  type MappedImportLineForMerge,
  type MergedMappedImportLine,
} from "./receiptImportValidation"
import { getCachedVendorItemId } from "./vendorItemMappingCache"

// ── Shared types ──

export type ManualImportLine = {
  id: string
  description: string
  itemId: string
  quantity: string
  unitCost: string
}

export type ImportLineOverrides = {
  lineDescriptionOverrides: Record<number, string>
  lineItemOverrides: Record<number, string>
  lineQtyOverrides: Record<number, string>
  lineUnitCostOverrides: Record<number, string>
  deletedLineIndexes: Record<number, true>
}

export type MergePreview = {
  mappedLineCount: number
  mergedLineCount: number
  collapsedLineCount: number
}

// ── Shared small helpers ──

export const normalizeItemName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "")

export const tokenizeName = (name: string): string[] =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)

export const createManualImportLine = (): ManualImportLine => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  description: "",
  itemId: "",
  quantity: "1",
  unitCost: "",
})

export const getOcrEngineDisplayName = (engine: string | null | undefined): string => {
  const normalized = (engine || "").trim().toLowerCase()
  if (normalized === "paddleocr-vl") return "PaddleOCR-VL"
  if (normalized === "paddleocr") return "PaddleOCR"
  return engine?.trim() || "Unknown"
}

export const getFixtureUsedDisplayName = (fixtureUsed: string | null | undefined): string => {
  const normalized = fixtureUsed?.trim().toLowerCase()
  if (!normalized) return "generic"
  return normalized
}

// ── Line resolution ──

export const resolveImportedDescription = (
  overrides: Record<number, string>,
  index: number,
  fallbackDescription: string
): string => {
  const override = overrides[index]
  if (typeof override === "string") return override
  return fallbackDescription
}

export const resolveImportedQty = (
  overrides: Record<number, string>,
  index: number,
  fallbackQty: number
): number => {
  const raw = overrides[index]
  if (!raw) return fallbackQty
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallbackQty
}

export const resolveImportedUnitCost = (
  overrides: Record<number, string>,
  index: number,
  fallbackUnitCost: string | null,
  qty: number,
  lineTotal: string | null
): string | null => {
  const raw = overrides[index]
  if (raw && raw.trim() !== "") return raw.trim()
  if (fallbackUnitCost && fallbackUnitCost.trim() !== "") return fallbackUnitCost.trim()
  if (lineTotal && qty > 0) {
    const numericLineTotal = Number.parseFloat(lineTotal)
    if (Number.isFinite(numericLineTotal)) {
      return (numericLineTotal / qty).toFixed(2)
    }
  }
  return null
}

export const isLineDeleted = (
  deletedLineIndexes: Record<number, true>,
  index: number
): boolean => Boolean(deletedLineIndexes[index])

type AutoMatchContext = {
  vendorId: string
  items: Array<{ id: string; name: string }>
  itemIdSet: Set<string>
}

export const getAutoMatchedItemId = (
  ctx: AutoMatchContext,
  description: string
): string | null => {
  const descriptionNormalized = normalizeItemName(description)

  if (ctx.vendorId) {
    const cachedItemId = getCachedVendorItemId(ctx.vendorId, description)
    if (cachedItemId && ctx.itemIdSet.has(cachedItemId)) {
      return cachedItemId
    }
  }

  const direct = ctx.items.find((it) => normalizeItemName(it.name) === descriptionNormalized)
  if (direct) return direct.id

  const containsMatch = ctx.items.find((it) => {
    const itemNormalized = normalizeItemName(it.name)
    return (
      itemNormalized.length > 0 &&
      (descriptionNormalized.includes(itemNormalized) ||
        itemNormalized.includes(descriptionNormalized))
    )
  })
  if (containsMatch) return containsMatch.id

  const descriptionTokens = new Set(tokenizeName(description))
  if (descriptionTokens.size === 0) return null

  let bestId: string | null = null
  let bestScore = 0

  for (const item of ctx.items) {
    const itemTokens = new Set(tokenizeName(item.name))
    if (itemTokens.size === 0) continue

    let overlapCount = 0
    for (const token of itemTokens) {
      if (descriptionTokens.has(token)) overlapCount += 1
    }

    if (overlapCount === 0) continue

    const overlapRatio = overlapCount / Math.max(itemTokens.size, descriptionTokens.size)
    const score = overlapCount * 10 + overlapRatio * 100
    const strongEnough = overlapCount >= 2 && overlapRatio >= 0.4

    if (strongEnough && score > bestScore) {
      bestScore = score
      bestId = item.id
    }
  }

  return bestId
}

export const resolveImportedItemId = (
  ctx: AutoMatchContext,
  overrides: ImportLineOverrides,
  index: number,
  fallbackDescription: string
): string | null => {
  const manual = overrides.lineItemOverrides[index]
  if (manual) return manual
  const description = resolveImportedDescription(
    overrides.lineDescriptionOverrides,
    index,
    fallbackDescription
  )
  return getAutoMatchedItemId(ctx, description)
}

export const resolveImportedLineNotes = (
  overrides: ImportLineOverrides,
  itemNameById: Map<string, string>,
  index: number,
  fallbackDescription: string
): string => {
  const explicitDescription = overrides.lineDescriptionOverrides[index]
  if (typeof explicitDescription === "string") return explicitDescription

  const mappedItemOverrideId = overrides.lineItemOverrides[index]
  if (mappedItemOverrideId) {
    const mappedName = itemNameById.get(mappedItemOverrideId)
    if (mappedName) return mappedName
  }

  return fallbackDescription
}

// ── Computed stats ──

export type ImportLineStats = {
  total: number
  unresolved: number
  lineSubtotal: number
}

export const computeImportLineStats = (
  parsedReceipt: ParsedReceipt | null,
  overrides: ImportLineOverrides,
  manualLines: ManualImportLine[],
  ctx: AutoMatchContext
): ImportLineStats => {
  if (!parsedReceipt) {
    const manualUnresolved = manualLines.filter((line) => {
      const qty = Number.parseInt(line.quantity, 10)
      const unitCostNum = Number.parseFloat(line.unitCost)
      return (
        !line.description.trim() ||
        !line.itemId ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        !Number.isFinite(unitCostNum) ||
        unitCostNum <= 0
      )
    }).length

    return {
      total: manualLines.length,
      unresolved: manualUnresolved,
      lineSubtotal: computeImportLineItemsSubtotal(
        manualLines.map((line) => ({ quantity: line.quantity, unitCost: line.unitCost }))
      ),
    }
  }

  const parsedUnresolved = parsedReceipt.line_items.filter((line, index) => {
    if (isLineDeleted(overrides.deletedLineIndexes, index)) return false
    const description = resolveImportedDescription(
      overrides.lineDescriptionOverrides,
      index,
      line.description
    ).trim()
    const itemId = resolveImportedItemId(ctx, overrides, index, line.description)
    const qty = resolveImportedQty(overrides.lineQtyOverrides, index, line.quantity)
    const unitCost = resolveImportedUnitCost(
      overrides.lineUnitCostOverrides,
      index,
      line.unit_cost,
      qty,
      line.line_total
    )
    const unitCostNum = unitCost ? Number.parseFloat(unitCost) : NaN
    return !description || !itemId || qty <= 0 || !Number.isFinite(unitCostNum) || unitCostNum <= 0
  }).length

  const manualUnresolved = manualLines.filter((line) => {
    const qty = Number.parseInt(line.quantity, 10)
    const unitCostNum = Number.parseFloat(line.unitCost)
    return (
      !line.description.trim() ||
      !line.itemId ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      !Number.isFinite(unitCostNum) ||
      unitCostNum <= 0
    )
  }).length

  const parsedSubtotalInput = parsedReceipt.line_items
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => !isLineDeleted(overrides.deletedLineIndexes, index))
    .map(({ line, index }) => {
      const qty = resolveImportedQty(overrides.lineQtyOverrides, index, line.quantity)
      const unitCost = resolveImportedUnitCost(
        overrides.lineUnitCostOverrides,
        index,
        line.unit_cost,
        qty,
        line.line_total
      )
      return { quantity: qty, unitCost }
    })

  const manualSubtotalInput = manualLines.map((line) => ({
    quantity: line.quantity,
    unitCost: line.unitCost,
  }))

  const totalParsedLines = parsedReceipt.line_items.filter(
    (_line, index) => !isLineDeleted(overrides.deletedLineIndexes, index)
  ).length

  return {
    total: totalParsedLines + manualLines.length,
    unresolved: parsedUnresolved + manualUnresolved,
    lineSubtotal: computeImportLineItemsSubtotal([
      ...parsedSubtotalInput,
      ...manualSubtotalInput,
    ]),
  }
}

// ── Merge preview ──

export const computeMergePreview = (
  parsedReceipt: ParsedReceipt | null,
  overrides: ImportLineOverrides,
  manualLines: ManualImportLine[],
  ctx: AutoMatchContext,
  itemNameById: Map<string, string>
): MergePreview => {
  if (!parsedReceipt) {
    return { mappedLineCount: 0, mergedLineCount: 0, collapsedLineCount: 0 }
  }

  const mappedLines: MappedImportLineForMerge[] = []

  for (let index = 0; index < parsedReceipt.line_items.length; index += 1) {
    if (isLineDeleted(overrides.deletedLineIndexes, index)) continue

    const line = parsedReceipt.line_items[index]
    const description = resolveImportedDescription(
      overrides.lineDescriptionOverrides,
      index,
      line.description
    ).trim()
    const itemId = resolveImportedItemId(ctx, overrides, index, line.description)
    const qty = resolveImportedQty(overrides.lineQtyOverrides, index, line.quantity)
    const unitCost = resolveImportedUnitCost(
      overrides.lineUnitCostOverrides,
      index,
      line.unit_cost,
      qty,
      line.line_total
    )
    const unitCostNumber = unitCost ? Number.parseFloat(unitCost) : NaN

    if (!description || !itemId || qty <= 0 || !Number.isFinite(unitCostNumber) || unitCostNumber <= 0) {
      continue
    }

    mappedLines.push({
      itemId,
      description,
      quantity: qty,
      unitCost: unitCostNumber,
      notes: resolveImportedLineNotes(overrides, itemNameById, index, line.description).trim() || description,
    })
  }

  for (const line of manualLines) {
    const description = line.description.trim()
    const itemId = line.itemId.trim()
    const qty = Number.parseInt(line.quantity, 10)
    const unitCost = Number.parseFloat(line.unitCost)

    if (!description || !itemId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost <= 0) {
      continue
    }

    mappedLines.push({ itemId, description, quantity: qty, unitCost, notes: description })
  }

  const mergedLines = mergeMappedImportLines(mappedLines)

  return {
    mappedLineCount: mappedLines.length,
    mergedLineCount: mergedLines.length,
    collapsedLineCount: Math.max(0, mappedLines.length - mergedLines.length),
  }
}

// ── Save pipeline: build merged lines + learned mappings ──

export type BuildMergedLinesResult = {
  mergedLines: MergedMappedImportLine[]
  learnedMappings: Array<{ sourceText: string; itemId: string }>
}

export const buildMergedLinesForSave = (
  parsedReceipt: ParsedReceipt,
  overrides: ImportLineOverrides,
  manualLines: ManualImportLine[],
  ctx: AutoMatchContext,
  itemNameById: Map<string, string>
): BuildMergedLinesResult => {
  const mappedLinesForMerge: Array<{
    itemId: string
    description: string
    quantity: number
    unitCost: number
    notes: string
  }> = []
  const learnedMappings: Array<{ sourceText: string; itemId: string }> = []

  for (let i = 0; i < parsedReceipt.line_items.length; i += 1) {
    if (isLineDeleted(overrides.deletedLineIndexes, i)) continue

    const li = parsedReceipt.line_items[i]
    const description = resolveImportedDescription(
      overrides.lineDescriptionOverrides,
      i,
      li.description
    ).trim()
    const lineNotes = resolveImportedLineNotes(overrides, itemNameById, i, li.description).trim()
    const itemId = resolveImportedItemId(ctx, overrides, i, li.description)
    const qty = resolveImportedQty(overrides.lineQtyOverrides, i, li.quantity)
    const unitCost = resolveImportedUnitCost(
      overrides.lineUnitCostOverrides,
      i,
      li.unit_cost,
      qty,
      li.line_total
    )

    if (!description) throw new Error(`Line ${i + 1} description is required`)
    if (!itemId) throw new Error(`Line ${i + 1} is not mapped to an item`)
    if (qty <= 0) throw new Error(`Line ${i + 1} has invalid quantity`)
    const unitCostNumber = unitCost ? Number.parseFloat(unitCost) : NaN
    if (!unitCost || !Number.isFinite(unitCostNumber) || unitCostNumber <= 0) {
      throw new Error(`Line ${i + 1} has invalid unit cost`)
    }

    mappedLinesForMerge.push({
      itemId,
      description,
      quantity: qty,
      unitCost: unitCostNumber,
      notes: lineNotes || description,
    })

    learnedMappings.push({ sourceText: description, itemId })
  }

  const parsedLineCountForNumbering = parsedReceipt.line_items.reduce(
    (count, _line, idx) => count + (isLineDeleted(overrides.deletedLineIndexes, idx) ? 0 : 1),
    0
  )

  for (let i = 0; i < manualLines.length; i += 1) {
    const line = manualLines[i]
    const manualLineNumber = parsedLineCountForNumbering + i + 1
    const itemId = line.itemId
    const qty = Number.parseInt(line.quantity, 10)
    const unitCost = line.unitCost.trim()
    const unitCostNumber = Number.parseFloat(unitCost)
    const description = line.description.trim()

    if (!description) throw new Error(`Line ${manualLineNumber} description is required`)
    if (!itemId) throw new Error(`Line ${manualLineNumber} is not mapped to an item`)
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Line ${manualLineNumber} has invalid quantity`)
    if (!Number.isFinite(unitCostNumber) || unitCostNumber <= 0) throw new Error(`Line ${manualLineNumber} has invalid unit cost`)

    mappedLinesForMerge.push({
      itemId,
      description,
      quantity: qty,
      unitCost: unitCostNumber,
      notes: description,
    })

    learnedMappings.push({ sourceText: description, itemId })
  }

  const mergedLines = mergeMappedImportLines(mappedLinesForMerge)
  if (mergedLines.length === 0) {
    throw new Error("No valid mapped line items to create")
  }

  return { mergedLines, learnedMappings }
}
