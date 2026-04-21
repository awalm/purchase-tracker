import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useReceipts,
  useCreateReceipt,
  useUpdateReceipt,
  useDeleteReceipt,
  useVendors,
  useItems,
  useVendorImportAliases,
  useCreateVendorImportAlias,
  useDeleteVendorImportAlias,
} from "@/hooks/useApi"
import {
  importApi,
  type ParsedReceipt,
  type ReceiptOcrMode,
  type ReceiptImageParseProgress,
  receipts as receiptsApi,
} from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { BulkReceiptImportDialog } from "@/components/BulkReceiptImportDialog"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog"
import { ReceiptForm, type ReceiptFormSubmitData } from "@/components/ReceiptForm"
import { Plus, Trash2, Pencil, FileText, Upload, CheckCircle2, AlertCircle, Clock, Loader2 } from "lucide-react"
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils"
import {
  computeImportLineItemsSubtotal,
  findDuplicateMappedImportItems,
  findExistingReceiptByNumber,
  getImportSubtotalDifference,
  importSubtotalMatches,
  truncateOptionLabel,
} from "@/lib/receiptImportValidation"
import {
  getReceiptItemsDisplayCount,
  getReceiptReconciliationBadgeState,
} from "@/lib/receiptSummary"
import {
  getCachedVendorItemId,
  rememberVendorItemMappings,
} from "@/lib/vendorItemMappingCache"

type Receipt = ReturnType<typeof useReceipts>["data"] extends (infer T)[] | undefined ? T : never

const normalizeItemName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "")

const tokenizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)

type ManualImportLine = {
  id: string
  description: string
  itemId: string
  quantity: string
  unitCost: string
}

type ImportNewItemTarget =
  | { kind: "parsed"; index: number }
  | { kind: "manual"; lineId: string }

const createManualImportLine = (): ManualImportLine => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  description: "",
  itemId: "",
  quantity: "1",
  unitCost: "",
})

const getOcrEngineDisplayName = (engine: string | null | undefined): string => {
  const normalized = (engine || "").trim().toLowerCase()
  if (normalized === "paddleocr-vl") {
    return "PaddleOCR-VL"
  }
  if (normalized === "paddleocr") {
    return "PaddleOCR"
  }
  return engine?.trim() || "Unknown"
}

const getFixtureUsedDisplayName = (fixtureUsed: string | null | undefined): string => {
  const normalized = fixtureUsed?.trim().toLowerCase()
  if (!normalized) return "generic"
  return normalized
}

function ReconciliationBadge({ receipt }: { receipt: Receipt }) {
  const badgeState = getReceiptReconciliationBadgeState(receipt)

  if (badgeState.kind === "reconciled") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded-full">
        <CheckCircle2 className="h-3 w-3" />
        {badgeState.label}
      </span>
    )
  }

  if (badgeState.kind === "no-receipt-lines") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
        <Clock className="h-3 w-3" />
        {badgeState.label}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
      <AlertCircle className="h-3 w-3" />
      {badgeState.label}
    </span>
  )
}

export default function ReceiptsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { data: allReceipts = [], isLoading } = useReceipts()
  const { data: vendors = [] } = useVendors()
  const { data: items = [] } = useItems()
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items])
  const itemNameById = useMemo(
    () => new Map(items.map((item) => [item.id, item.name])),
    [items]
  )

  const createReceipt = useCreateReceipt()
  const updateReceipt = useUpdateReceipt()
  const deleteReceipt = useDeleteReceipt()

  const [isOpen, setIsOpen] = useState(false)
  const [isReceiptFormDirty, setIsReceiptFormDirty] = useState(false)
  const [confirmReceiptCloseOpen, setConfirmReceiptCloseOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [vendorFilter, setVendorFilter] = useState<string>("")

  const [isImportOpen, setIsImportOpen] = useState(false)
  const [confirmImportCloseOpen, setConfirmImportCloseOpen] = useState(false)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [bulkImportPrefillFiles, setBulkImportPrefillFiles] = useState<File[]>([])
  const [bulkImportPrefillOcrMode, setBulkImportPrefillOcrMode] = useState<ReceiptOcrMode | null>(null)
  const [bulkImportAutoStart, setBulkImportAutoStart] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [parsedReceipt, setParsedReceipt] = useState<ParsedReceipt | null>(null)
  const [importParsing, setImportParsing] = useState(false)
  const [importCreating, setImportCreating] = useState(false)
  const [importError, setImportError] = useState("")
  const [importStatus, setImportStatus] = useState("")
  const [importVendorId, setImportVendorId] = useState("")
  const [importVendorLabel, setImportVendorLabel] = useState("")
  const [importReceiptNumber, setImportReceiptNumber] = useState("")
  const [importReceiptDate, setImportReceiptDate] = useState("1970-01-01")
  const [importSubtotal, setImportSubtotal] = useState("")
  const [importTaxAmount, setImportTaxAmount] = useState("")
  const [importTotal, setImportTotal] = useState("")
  const [importPaymentMethod, setImportPaymentMethod] = useState("")
  const [importNotes, setImportNotes] = useState("")
  const [importLineDescriptionOverrides, setImportLineDescriptionOverrides] = useState<Record<number, string>>({})
  const [importLineItemOverrides, setImportLineItemOverrides] = useState<Record<number, string>>({})
  const [importLineQtyOverrides, setImportLineQtyOverrides] = useState<Record<number, string>>({})
  const [importLineUnitCostOverrides, setImportLineUnitCostOverrides] = useState<Record<number, string>>({})
  const [importDeletedLineIndexes, setImportDeletedLineIndexes] = useState<Record<number, true>>({})
  const [importManualLines, setImportManualLines] = useState<ManualImportLine[]>([])
  const [importNewItemTarget, setImportNewItemTarget] = useState<ImportNewItemTarget | null>(null)
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importFilePreviewUrl, setImportFilePreviewUrl] = useState<string | null>(null)
  const [importParseStage, setImportParseStage] = useState<ReceiptImageParseProgress["stage"] | null>(null)
  const [importParseProgress, setImportParseProgress] = useState<number | null>(null)
  const [importBypassCompression, setImportBypassCompression] = useState(false)
  const [importOcrMode, setImportOcrMode] = useState<ReceiptOcrMode>("auto")
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const { data: selectedVendorAliases = [] } = useVendorImportAliases(importVendorId)
  const createVendorAlias = useCreateVendorImportAlias(importVendorId)
  const deleteVendorAlias = useDeleteVendorImportAlias(importVendorId)

  useEffect(() => {
    const shouldOpenOcrImport = searchParams.get("import") === "1"
    if (!shouldOpenOcrImport) return

    setIsImportOpen(true)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete("import")
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!importFile) {
      setImportFilePreviewUrl(null)
      return
    }

    const url = URL.createObjectURL(importFile)
    setImportFilePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [importFile])

  const filteredReceipts = vendorFilter
    ? allReceipts.filter((r) => r.vendor_id === vendorFilter)
    : allReceipts

  const duplicateImportedReceipt = useMemo(() => {
    return findExistingReceiptByNumber(allReceipts, importReceiptNumber)
  }, [allReceipts, importReceiptNumber])

  const hasDuplicateImportedReceipt = Boolean(duplicateImportedReceipt)

  const resetForm = () => {
    setEditingId(null)
    setIsReceiptFormDirty(false)
  }

  const resetImportForm = () => {
    setImportFile(null)
    setParsedReceipt(null)
    setImportParsing(false)
    setImportCreating(false)
    setImportError("")
    setImportStatus("")
    setImportVendorId("")
    setImportVendorLabel("")
    setImportReceiptNumber("")
    setImportReceiptDate("1970-01-01")
    setImportSubtotal("")
    setImportTaxAmount("")
    setImportTotal("")
    setImportPaymentMethod("")
    setImportNotes("")
    setImportLineDescriptionOverrides({})
    setImportLineItemOverrides({})
    setImportLineQtyOverrides({})
    setImportLineUnitCostOverrides({})
    setImportDeletedLineIndexes({})
    setImportManualLines([])
    setImportNewItemTarget(null)
    setImportWarnings([])
    setImportFilePreviewUrl(null)
    setImportParseStage(null)
    setImportParseProgress(null)
    setImportBypassCompression(false)
    setImportOcrMode("auto")
    if (importFileInputRef.current) {
      importFileInputRef.current.value = ""
    }
  }

  const getAutoMatchedItemId = (description: string): string | null => {
    const descriptionNormalized = normalizeItemName(description)

    if (importVendorId) {
      const cachedItemId = getCachedVendorItemId(importVendorId, description)
      if (cachedItemId && itemIdSet.has(cachedItemId)) {
        return cachedItemId
      }
    }

    const direct = items.find((it) => normalizeItemName(it.name) === descriptionNormalized)
    if (direct) return direct.id

    // If one normalized name fully contains the other, treat it as a strong match.
    const containsMatch = items.find((it) => {
      const itemNormalized = normalizeItemName(it.name)
      return (
        itemNormalized.length > 0 &&
        (descriptionNormalized.includes(itemNormalized) || itemNormalized.includes(descriptionNormalized))
      )
    })
    if (containsMatch) return containsMatch.id

    // Fall back to token overlap scoring for long OCR descriptions.
    const descriptionTokens = new Set(tokenizeName(description))
    if (descriptionTokens.size === 0) return null

    let bestId: string | null = null
    let bestScore = 0

    for (const item of items) {
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

  const resolveImportedDescription = (index: number, fallbackDescription: string): string => {
    const override = importLineDescriptionOverrides[index]
    if (typeof override === "string") {
      return override
    }
    return fallbackDescription
  }

  const resolveImportedItemId = (description: string, index: number): string | null => {
    const manual = importLineItemOverrides[index]
    if (manual) return manual
    return getAutoMatchedItemId(resolveImportedDescription(index, description))
  }

  const resolveImportedLineNotes = (index: number, fallbackDescription: string): string => {
    const explicitDescription = importLineDescriptionOverrides[index]
    if (typeof explicitDescription === "string") {
      return explicitDescription
    }

    const mappedItemOverrideId = importLineItemOverrides[index]
    if (mappedItemOverrideId) {
      const mappedName = itemNameById.get(mappedItemOverrideId)
      if (mappedName) {
        return mappedName
      }
    }

    return fallbackDescription
  }

  const resolveImportedQty = (index: number, fallbackQty: number): number => {
    const raw = importLineQtyOverrides[index]
    if (!raw) return fallbackQty
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallbackQty
  }

  const resolveImportedUnitCost = (index: number, fallbackUnitCost: string | null, qty: number, lineTotal: string | null): string | null => {
    const raw = importLineUnitCostOverrides[index]
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

  const isImportedLineDeleted = (index: number): boolean => Boolean(importDeletedLineIndexes[index])

  const unresolvedParsedCount = parsedReceipt
    ? parsedReceipt.line_items.filter((li, idx) => {
        if (isImportedLineDeleted(idx)) return false
        const description = resolveImportedDescription(idx, li.description).trim()
        const itemId = resolveImportedItemId(li.description, idx)
        const qty = resolveImportedQty(idx, li.quantity)
        const unitCost = resolveImportedUnitCost(idx, li.unit_cost, qty, li.line_total)
        const unitCostNum = unitCost ? Number.parseFloat(unitCost) : NaN
        return !description || !itemId || qty <= 0 || !Number.isFinite(unitCostNum) || unitCostNum <= 0
      }).length
    : 0

  const unresolvedManualCount = importManualLines.filter((line) => {
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

  const unresolvedImportedCount = unresolvedParsedCount + unresolvedManualCount
  const totalParsedLineCount = parsedReceipt
    ? parsedReceipt.line_items.filter((_, idx) => !isImportedLineDeleted(idx)).length
    : 0
  const totalImportLineCount = totalParsedLineCount + importManualLines.length

  const duplicateMappedImportedItems = (() => {
    if (!parsedReceipt) {
      return []
    }

    let lineNumber = 0
    const parsedMappedLines = parsedReceipt.line_items
      .map((li, idx) => ({ li, idx }))
      .filter(({ idx }) => !isImportedLineDeleted(idx))
      .map(({ li, idx }) => {
        lineNumber += 1
        const itemId = resolveImportedItemId(li.description, idx)
        return {
          lineNumber,
          itemId,
          itemName: itemId ? itemNameById.get(itemId) || null : null,
        }
      })

    const manualMappedLines = importManualLines.map((line) => {
      lineNumber += 1
      const itemId = line.itemId.trim() || null
      return {
        lineNumber,
        itemId,
        itemName: itemId ? itemNameById.get(itemId) || null : null,
      }
    })

    return findDuplicateMappedImportItems([...parsedMappedLines, ...manualMappedLines])
  })()

  const hasDuplicateMappedImportedItems = duplicateMappedImportedItems.length > 0
  const duplicateMappedImportedMessage = hasDuplicateMappedImportedItems
    ? `Item \"${duplicateMappedImportedItems[0].itemName}\" is mapped on multiple lines (${duplicateMappedImportedItems[0].lineNumbers.join(", ")}). Each item can appear only once per receipt.`
    : ""

  const importLineItemsSubtotal = useMemo(() => {
    const parsedLines = (parsedReceipt?.line_items || [])
      .map((li, idx) => ({ li, idx }))
      .filter(({ idx }) => !isImportedLineDeleted(idx))
      .map(({ li, idx }) => {
        const qty = resolveImportedQty(idx, li.quantity)
        const unitCost = resolveImportedUnitCost(idx, li.unit_cost, qty, li.line_total)
        return {
          quantity: qty,
          unitCost,
        }
      })

    const manualLines = importManualLines.map((line) => ({
      quantity: line.quantity,
      unitCost: line.unitCost,
    }))

    return computeImportLineItemsSubtotal([...parsedLines, ...manualLines])
  }, [parsedReceipt, importLineQtyOverrides, importLineUnitCostOverrides, importDeletedLineIndexes, importManualLines])

  const importSubtotalDifference = useMemo(
    () => getImportSubtotalDifference(importSubtotal, importLineItemsSubtotal),
    [importSubtotal, importLineItemsSubtotal]
  )

  const hasImportSubtotalMismatch =
    totalImportLineCount > 0 &&
    unresolvedImportedCount === 0 &&
    importSubtotalDifference !== null &&
    !importSubtotalMatches(importSubtotal, importLineItemsSubtotal)

  const selectedVendor = vendors.find((vendor) => vendor.id === importVendorId) || null
  const hasVendorMapping =
    Boolean(importVendorLabel.trim()) &&
    selectedVendorAliases.some(
      (alias) => alias.raw_alias.trim().toLowerCase() === importVendorLabel.trim().toLowerCase()
    )

  const hasImportActionInProgress =
    importParsing ||
    importCreating ||
    importFile !== null ||
    parsedReceipt !== null ||
    importManualLines.length > 0

  const closeImportDialogNow = () => {
    setConfirmImportCloseOpen(false)
    setIsImportOpen(false)
    resetImportForm()
  }

  const requestImportDialogClose = () => {
    if (hasImportActionInProgress) {
      setConfirmImportCloseOpen(true)
      return
    }
    closeImportDialogNow()
  }

  const hasReceiptActionInProgress =
    createReceipt.isPending || updateReceipt.isPending || isReceiptFormDirty

  const closeReceiptDialogNow = () => {
    setConfirmReceiptCloseOpen(false)
    setIsOpen(false)
    resetForm()
  }

  const requestReceiptDialogClose = () => {
    if (hasReceiptActionInProgress) {
      setConfirmReceiptCloseOpen(true)
      return
    }
    closeReceiptDialogNow()
  }

  const handleSaveVendorMapping = async () => {
    const rawVendorLabel = importVendorLabel.trim()
    if (!rawVendorLabel || !importVendorId) return

    await createVendorAlias.mutateAsync(rawVendorLabel)
    queryClient.invalidateQueries({ queryKey: ["vendors", importVendorId, "import-aliases"] })
  }

  const handleDeleteVendorMapping = async (aliasId: string) => {
    if (!importVendorId) return

    await deleteVendorAlias.mutateAsync(aliasId)
    queryClient.invalidateQueries({ queryKey: ["vendors", importVendorId, "import-aliases"] })
  }

  const addManualImportLine = () => {
    setImportManualLines((prev) => [...prev, createManualImportLine()])
  }

  const updateManualImportLine = (
    id: string,
    updates: Partial<Omit<ManualImportLine, "id">>
  ) => {
    setImportManualLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, ...updates } : line))
    )
  }

  const removeManualImportLine = (id: string) => {
    setImportManualLines((prev) => prev.filter((line) => line.id !== id))
  }

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length === 0) return

    if (selectedFiles.length > 1) {
      const selectedMode = importOcrMode
      setIsImportOpen(false)
      resetImportForm()
      setBulkImportPrefillFiles(selectedFiles)
      setBulkImportPrefillOcrMode(selectedMode)
      setBulkImportAutoStart(true)
      setBulkImportOpen(true)
      return
    }

    const file = selectedFiles[0]

    setImportFile(file)
    setImportVendorId("")
    setImportVendorLabel("")
    setImportParsing(true)
    setImportError("")
    setImportStatus("Uploading receipt...")
    setParsedReceipt(null)
    setImportLineDescriptionOverrides({})
    setImportLineItemOverrides({})
    setImportLineQtyOverrides({})
    setImportLineUnitCostOverrides({})
    setImportDeletedLineIndexes({})
    setImportManualLines([])
    setImportNewItemTarget(null)
    setImportWarnings([])
    setImportParseStage("uploading")
    setImportParseProgress(0)

    try {
      const parsed = await importApi.receiptImage(file, ({ stage, progress }) => {
        setImportParseStage(stage)
        setImportParseProgress(progress)

        if (stage === "uploading") {
          const percent = typeof progress === "number" ? `${progress}%` : "..."
          setImportStatus(`Uploading receipt... ${percent}`)
        } else {
          setImportStatus("Parsing receipt...")
        }
      }, { bypassCompression: importBypassCompression, ocrMode: importOcrMode })
      setParsedReceipt(parsed)
      const rawVendorName = parsed.vendor_name?.trim() || ""
      const suggestedVendorId = parsed.suggested_vendor_id || ""
      const matchingVendorId =
        rawVendorName &&
        vendors.find((v) => v.name.trim().toLowerCase() === rawVendorName.toLowerCase())?.id
      setImportVendorLabel(rawVendorName)
      setImportVendorId(
        matchingVendorId ||
          (suggestedVendorId && vendors.some((v) => v.id === suggestedVendorId)
            ? suggestedVendorId
            : "")
      )
      setImportReceiptNumber(parsed.receipt_number || "")
      setImportReceiptDate(parsed.receipt_date || "1970-01-01")
      setImportSubtotal(parsed.subtotal || "")
      const taxFromPayload = parsed.tax || ""
      const inferredTax = (!taxFromPayload && parsed.total && parsed.subtotal)
        ? (Number.parseFloat(parsed.total) - Number.parseFloat(parsed.subtotal)).toFixed(2)
        : ""
      setImportTaxAmount(taxFromPayload || inferredTax)
      setImportTotal(parsed.total || "")
      setImportPaymentMethod(parsed.payment_method || "")
      setImportWarnings(parsed.warnings || [])
      setImportNotes("")
      setImportStatus(
        `Receipt parsed using ${getOcrEngineDisplayName(parsed.parse_engine)}. Confirm all fields before saving.`
      )
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to parse receipt image")
      setImportStatus("")
    } finally {
      setImportParsing(false)
      setImportParseStage(null)
      setImportParseProgress(null)
    }
  }

  const handleImportCreate = async () => {
    if (!parsedReceipt || !importFile || !importVendorId) return
    if (totalImportLineCount === 0) {
      setImportError("Add at least one receipt line item before creating this receipt.")
      return
    }
    if (hasDuplicateImportedReceipt) {
      const duplicateNumber = importReceiptNumber.trim()
      if (duplicateImportedReceipt) {
        setImportError(
          `Receipt # ${duplicateNumber} already exists (${duplicateImportedReceipt.vendor_name}, ${formatDate(duplicateImportedReceipt.receipt_date)}). Use a unique receipt number.`
        )
      } else {
        setImportError(`Receipt # ${duplicateNumber} already exists. Use a unique receipt number.`)
      }
      return
    }
    if (hasDuplicateMappedImportedItems) {
      setImportError(duplicateMappedImportedMessage)
      return
    }
    if (hasImportSubtotalMismatch) {
      const expected = Number.parseFloat(importSubtotal)
      setImportError(
        `Line item subtotal ${formatCurrency(importLineItemsSubtotal.toFixed(2))} does not match receipt subtotal ${formatCurrency(expected.toFixed(2))}.`
      )
      return
    }

    setImportCreating(true)
    setImportError("")

    let createdReceiptId: string | null = null
    const learnedMappings: Array<{ sourceText: string; itemId: string }> = []

    try {
      setImportStatus("Creating receipt...")
      const created = await receiptsApi.create({
        vendor_id: importVendorId,
        source_vendor_alias: parsedReceipt.vendor_name?.trim() || undefined,
        ...(importReceiptNumber.trim() ? { receipt_number: importReceiptNumber.trim() } : {}),
        receipt_date: importReceiptDate,
        subtotal: importSubtotal,
        tax_amount: importTaxAmount || undefined,
        payment_method: importPaymentMethod || undefined,
        ingestion_metadata: {
          source: "ocr",
          auto_parsed: true,
          parse_engine: parsedReceipt.parse_engine || "unknown",
          ...(parsedReceipt.parse_version ? { parse_version: parsedReceipt.parse_version } : {}),
          ...(parsedReceipt.fixture_used ? { fixture_used: parsedReceipt.fixture_used } : {}),
          ...(typeof parsedReceipt.confidence_score === "number"
            ? { confidence_score: parsedReceipt.confidence_score }
            : {}),
          ...(parsedReceipt.vendor_name?.trim()
            ? { raw_vendor_name: parsedReceipt.vendor_name.trim() }
            : {}),
          ...(parsedReceipt.warnings.length ? { warnings: parsedReceipt.warnings } : {}),
          ingested_at: new Date().toISOString(),
          ingestion_version: "ocr-v1",
        },
        notes: importNotes || undefined,
      })
      createdReceiptId = created.id

      setImportStatus("Creating receipt line items...")
      for (let i = 0; i < parsedReceipt.line_items.length; i += 1) {
        if (isImportedLineDeleted(i)) {
          continue
        }

        const li = parsedReceipt.line_items[i]
        const description = resolveImportedDescription(i, li.description).trim()
        const lineNotes = resolveImportedLineNotes(i, li.description).trim()
        const itemId = resolveImportedItemId(li.description, i)
        const qty = resolveImportedQty(i, li.quantity)
        const unitCost = resolveImportedUnitCost(i, li.unit_cost, qty, li.line_total)

        if (!description) {
          throw new Error(`Line ${i + 1} description is required`)
        }
        if (!itemId) {
          throw new Error(`Line ${i + 1} is not mapped to an item`)
        }
        if (qty <= 0) {
          throw new Error(`Line ${i + 1} has invalid quantity`)
        }
        if (!unitCost || Number.parseFloat(unitCost) <= 0) {
          throw new Error(`Line ${i + 1} has invalid unit cost`)
        }

        await receiptsApi.lineItems.create(createdReceiptId, {
          item_id: itemId,
          quantity: qty,
          unit_cost: unitCost,
          notes: lineNotes || description,
        })

        learnedMappings.push({
          sourceText: description,
          itemId,
        })
      }

      const parsedLineCountForNumbering = parsedReceipt.line_items.reduce(
        (count, _line, idx) => count + (isImportedLineDeleted(idx) ? 0 : 1),
        0
      )

      for (let i = 0; i < importManualLines.length; i += 1) {
        const line = importManualLines[i]
        const manualLineNumber = parsedLineCountForNumbering + i + 1
        const itemId = line.itemId
        const qty = Number.parseInt(line.quantity, 10)
        const unitCost = line.unitCost.trim()
        const unitCostNumber = Number.parseFloat(unitCost)
        const description = line.description.trim()

        if (!description) {
          throw new Error(`Line ${manualLineNumber} description is required`)
        }
        if (!itemId) {
          throw new Error(`Line ${manualLineNumber} is not mapped to an item`)
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Line ${manualLineNumber} has invalid quantity`)
        }
        if (!Number.isFinite(unitCostNumber) || unitCostNumber <= 0) {
          throw new Error(`Line ${manualLineNumber} has invalid unit cost`)
        }

        await receiptsApi.lineItems.create(createdReceiptId, {
          item_id: itemId,
          quantity: qty,
          unit_cost: unitCostNumber.toFixed(2),
          notes: description,
        })

        learnedMappings.push({
          sourceText: description,
          itemId,
        })
      }

      setImportStatus("Uploading original receipt document...")
      await receiptsApi.uploadPdf(createdReceiptId, importFile, {
        bypassCompression: importBypassCompression,
      })

      rememberVendorItemMappings(importVendorId, learnedMappings)

      setImportStatus("Done")
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      closeImportDialogNow()
    } catch (err) {
      const baseMessage = err instanceof Error ? err.message : "Failed to import receipt"
      let message = baseMessage

      if (createdReceiptId) {
        try {
          await receiptsApi.delete(createdReceiptId)
          message = `${baseMessage}. Import was rolled back and temporary receipt (${createdReceiptId}) was deleted.`
        } catch (cleanupErr) {
          const cleanupMessage =
            cleanupErr instanceof Error
              ? cleanupErr.message
              : "Failed to clean up created receipt"
          message = `${baseMessage}. Receipt was created (${createdReceiptId}) but rollback failed: ${cleanupMessage}`
        }

        queryClient.invalidateQueries({ queryKey: ["receipts"] })
      }

      setImportError(message)
    } finally {
      setImportCreating(false)
      setImportStatus("")
    }
  }

  const handleSubmit = async (data: ReceiptFormSubmitData) => {
    let receiptId = editingId

    if (editingId) {
      await updateReceipt.mutateAsync({
        id: editingId,
        vendor_id: data.vendor_id,
        receipt_number: data.receipt_number,
        receipt_date: data.receipt_date,
        subtotal: data.subtotal,
        tax_amount: data.tax_amount,
        payment_method: data.payment_method.trim() || undefined,
        notes: data.notes || undefined,
      })
    } else {
      const created = await createReceipt.mutateAsync({
        vendor_id: data.vendor_id,
        ...(data.receipt_number.trim() ? { receipt_number: data.receipt_number.trim() } : {}),
        receipt_date: data.receipt_date,
        subtotal: data.subtotal,
        tax_amount: data.tax_amount,
        payment_method: data.payment_method.trim() || undefined,
        notes: data.notes || undefined,
      })
      receiptId = created.id
    }

    if (data.document_file && receiptId) {
      await receiptsApi.uploadPdf(receiptId, data.document_file)
    }

    closeReceiptDialogNow()
  }

  const handleEdit = (r: (typeof allReceipts)[0]) => {
    setEditingId(r.id)
    setIsOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this receipt?")) {
      await deleteReceipt.mutateAsync(id)
    }
  }

  const handleUploadPdf = async (id: string) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".pdf,.png,.jpg,.jpeg,.webp"
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file) {
        await receiptsApi.uploadPdf(id, file)
        queryClient.invalidateQueries({ queryKey: ["receipts"] })
      }
    }
    input.click()
  }

  const editingReceipt = editingId
    ? allReceipts.find((r) => r.id === editingId) || null
    : null

  // Summary stats
  const totalReceipts = filteredReceipts.length
  const totalSpent = filteredReceipts.reduce(
    (sum, r) => sum + parseFloat(r.total || "0"),
    0
  )
  const unreconciledCount = filteredReceipts.filter(r => {
    const badgeState = getReceiptReconciliationBadgeState(r)
    return badgeState.kind === "no-linked-purchases" || badgeState.kind === "issues"
  }).length

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Receipts</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="receipts"
            columns={[
              { header: "Receipt #", accessor: (r) => r.receipt_number },
              { header: "Vendor", accessor: (r) => r.vendor_name },
              { header: "Date", accessor: (r) => r.receipt_date },
              { header: "Subtotal", accessor: (r) => r.subtotal },
              { header: "Tax Rate", accessor: (r) => formatNumber(r.tax_rate) },
              { header: "Total", accessor: (r) => r.total },
              { header: "Receipt Line Count", accessor: (r) => r.receipt_line_item_count },
              { header: "Purchase Count", accessor: (r) => r.purchase_count },
              { header: "Purchases Total", accessor: (r) => r.purchases_total },
              { header: "Has Document", accessor: (r) => r.has_pdf ? "Yes" : "No" },
              { header: "Notes", accessor: (r) => r.notes },
            ]}
            data={filteredReceipts}
          />
          <Dialog
            open={isImportOpen}
            onOpenChange={(open) => {
              if (open) {
                setIsImportOpen(true)
                return
              }
              requestImportDialogClose()
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline">
                <Upload className="h-4 w-4 mr-2" />
                Import Receipt
              </Button>
            </DialogTrigger>
            <DialogContent className="w-[96vw] max-w-[1700px]">
              <DialogHeader>
                <DialogTitle>Import Receipt Image / PDF</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]">
                <div className="order-2 min-w-0 space-y-4 xl:order-1">
                  {importError && (
                    <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                      {importError}
                    </div>
                  )}

                  {!parsedReceipt && !importError && importParsing && (
                    <div className="rounded-md border bg-muted/20 px-4 py-8">
                      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <div className="font-medium text-foreground">
                          {importParseStage === "uploading" ? "Uploading receipt" : "Parsing receipt"}
                        </div>
                        {importParseStage === "uploading" && typeof importParseProgress === "number" && (
                          <div className="w-full max-w-sm space-y-1">
                            <div className="h-2 w-full overflow-hidden rounded bg-muted">
                              <div
                                className="h-full bg-primary transition-all"
                                style={{ width: `${importParseProgress}%` }}
                              />
                            </div>
                            <div className="text-center text-xs">{importParseProgress}% uploaded</div>
                          </div>
                        )}
                        {importParseStage !== "uploading" && (
                          <div className="text-xs">Running OCR and field extraction...</div>
                        )}
                      </div>
                    </div>
                  )}

                  {!parsedReceipt && !importError && !importParsing && (
                    <div className="rounded-md border border-dashed bg-muted/10 px-4 py-5 text-sm text-muted-foreground">
                      Choose a receipt file on the right to parse and review extracted fields.
                    </div>
                  )}

                  {parsedReceipt && (
                    <>
                      <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="font-medium text-foreground">OCR vendor label</div>
                            <div className="text-muted-foreground">
                              {importVendorLabel || parsedReceipt.vendor_name?.trim() || "-"}
                            </div>
                          </div>
                          <div className="space-y-1 min-w-[260px] flex-1 md:flex-none md:min-w-[320px]">
                            <Label className="text-xs font-medium">Mapped vendor</Label>
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <Select value={importVendorId} onValueChange={setImportVendorId}>
                                <SelectTrigger className="sm:flex-1">
                                  <SelectValue placeholder="Select vendor" />
                                </SelectTrigger>
                                <SelectContent>
                                  {vendors.map((v) => (
                                    <SelectItem key={v.id} value={v.id}>
                                      {v.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={handleSaveVendorMapping}
                                disabled={!importVendorLabel.trim() || !importVendorId}
                              >
                                Save mapping
                              </Button>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {selectedVendor
                                ? `${importVendorLabel || "OCR label"} → ${selectedVendor.name}`
                                : "Choose the real vendor for this OCR label."}
                            </div>
                            {hasVendorMapping && (
                              <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1 inline-flex items-center gap-1">
                                Mapping saved for this vendor label.
                              </div>
                            )}
                          </div>
                        </div>

                        {selectedVendorAliases.length > 0 && selectedVendor && (
                          <div className="space-y-2 border-t border-border/60 pt-3">
                            <div className="text-xs font-medium text-foreground">Saved aliases for {selectedVendor.name}</div>
                            <div className="flex flex-wrap gap-2">
                              {selectedVendorAliases.map((alias) => (
                                <div
                                  key={alias.id}
                                  className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs"
                                >
                                  <span>{alias.raw_alias}</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 text-muted-foreground"
                                    title={`Remove alias ${alias.raw_alias}`}
                                    onClick={() => handleDeleteVendorMapping(alias.id)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {parsedReceipt && (
                        <div className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
                          <div className="font-medium mb-1">OCR result</div>
                          <div>Final engine: {getOcrEngineDisplayName(parsedReceipt.parse_engine)}</div>
                          <div>Fixture used: {getFixtureUsedDisplayName(parsedReceipt.fixture_used)}</div>
                          {typeof parsedReceipt.confidence_score === "number" && (
                            <div>Confidence score: {parsedReceipt.confidence_score.toFixed(2)}</div>
                          )}
                          {parsedReceipt.parse_version && (
                            <div>Parse version: {parsedReceipt.parse_version}</div>
                          )}
                        </div>
                      )}

                      {importWarnings.length > 0 && (
                        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          <div className="font-medium mb-1">
                            OCR warnings (final engine: {getOcrEngineDisplayName(parsedReceipt?.parse_engine)})
                          </div>
                          <ul className="list-disc pl-5">
                            {importWarnings.map((w, idx) => (
                              <li key={idx}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Receipt #</Label>
                          <Input value={importReceiptNumber} onChange={(e) => setImportReceiptNumber(e.target.value)} />
                          {hasDuplicateImportedReceipt && duplicateImportedReceipt && (
                            <p className="text-xs text-red-600">
                              Duplicate receipt number. Already used by {duplicateImportedReceipt.vendor_name} on {formatDate(duplicateImportedReceipt.receipt_date)}.
                            </p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label>Receipt Date *</Label>
                          <Input type="date" value={importReceiptDate} onChange={(e) => setImportReceiptDate(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Subtotal *</Label>
                          <Input value={importSubtotal} onChange={(e) => setImportSubtotal(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Tax Amount</Label>
                          <Input value={importTaxAmount} onChange={(e) => setImportTaxAmount(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Total</Label>
                          <Input value={importTotal} onChange={(e) => setImportTotal(e.target.value)} />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label>Payment Method (extracted)</Label>
                          <Input
                            value={importPaymentMethod}
                            onChange={(e) => setImportPaymentMethod(e.target.value)}
                            placeholder="Not detected"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Notes</Label>
                        <Input value={importNotes} onChange={(e) => setImportNotes(e.target.value)} placeholder="Optional notes" />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-sm font-medium">Receipt Lines</Label>
                        <Button type="button" variant="outline" size="sm" onClick={addManualImportLine}>
                          <Plus className="h-4 w-4 mr-2" />
                          Add Line Item
                        </Button>
                      </div>

                      <div className="border rounded-md overflow-hidden [&>div]:overflow-hidden">
                        <Table className="table-fixed">
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[28%]">Description</TableHead>
                              <TableHead className="w-[34%]">Map Item</TableHead>
                              <TableHead className="w-[10%] text-right">Qty</TableHead>
                              <TableHead className="w-[12%] text-right">Unit Cost</TableHead>
                              <TableHead className="w-[8%] text-center">Confidence</TableHead>
                              <TableHead className="w-[8%] text-center">Action</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {parsedReceipt.line_items
                              .map((li, idx) => ({ li, idx }))
                              .filter(({ idx }) => !isImportedLineDeleted(idx))
                              .map(({ li, idx }) => {
                              const selectedItemId = resolveImportedItemId(li.description, idx) || "__none__"
                              const descriptionValue = resolveImportedDescription(idx, li.description)
                              const qtyValue = importLineQtyOverrides[idx] ?? String(li.quantity)
                              const unitCostValue = importLineUnitCostOverrides[idx] ?? (li.unit_cost || "")

                              return (
                                <TableRow key={`${idx}-${li.description}`}>
                                  <TableCell className="align-top">
                                    <Input
                                      value={descriptionValue}
                                      onChange={(e) => {
                                        const value = e.target.value
                                        setImportLineDescriptionOverrides((prev) => {
                                          const next = { ...prev }
                                          if (value === li.description) {
                                            delete next[idx]
                                          } else {
                                            next[idx] = value
                                          }
                                          return next
                                        })
                                      }}
                                      placeholder="Line description"
                                    />
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Select
                                      value={selectedItemId}
                                      onValueChange={(v) => {
                                        if (v === "__create__") {
                                          setImportNewItemTarget({ kind: "parsed", index: idx })
                                          return
                                        }
                                        setImportLineItemOverrides((prev) => {
                                          const next = { ...prev }
                                          if (v === "__none__") delete next[idx]
                                          else next[idx] = v
                                          return next
                                        })
                                      }}
                                    >
                                      <SelectTrigger className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all">
                                        <SelectValue placeholder="Map item" />
                                      </SelectTrigger>
                                      <SelectContent className="max-w-[min(90vw,32rem)]">
                                        <SelectItem value="__none__">Unmapped</SelectItem>
                                        <SelectItem value="__create__">
                                          <span className="text-blue-600">+ Create New Item</span>
                                        </SelectItem>
                                        {items.map((it) => (
                                          <SelectItem key={it.id} value={it.id}>
                                            <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                                              {truncateOptionLabel(it.name, 120)}
                                            </span>
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Input
                                      className="text-right"
                                      type="number"
                                      min={1}
                                      value={qtyValue}
                                      onChange={(e) =>
                                        setImportLineQtyOverrides((prev) => ({ ...prev, [idx]: e.target.value }))
                                      }
                                    />
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Input
                                      className="text-right"
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={unitCostValue}
                                      onChange={(e) =>
                                        setImportLineUnitCostOverrides((prev) => ({
                                          ...prev,
                                          [idx]: e.target.value,
                                        }))
                                      }
                                    />
                                  </TableCell>
                                  <TableCell className="align-top text-center text-xs text-muted-foreground">
                                    {li.confidence !== null ? `${Math.round(li.confidence * 100)}%` : "-"}
                                  </TableCell>
                                  <TableCell className="align-top text-center">
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="text-red-600"
                                      onClick={() => {
                                        setImportDeletedLineIndexes((prev) => ({
                                          ...prev,
                                          [idx]: true,
                                        }))
                                        setImportLineDescriptionOverrides((prev) => {
                                          const next = { ...prev }
                                          delete next[idx]
                                          return next
                                        })
                                        setImportLineItemOverrides((prev) => {
                                          const next = { ...prev }
                                          delete next[idx]
                                          return next
                                        })
                                        setImportLineQtyOverrides((prev) => {
                                          const next = { ...prev }
                                          delete next[idx]
                                          return next
                                        })
                                        setImportLineUnitCostOverrides((prev) => {
                                          const next = { ...prev }
                                          delete next[idx]
                                          return next
                                        })
                                        setImportNewItemTarget((prev) => {
                                          if (prev?.kind === "parsed" && prev.index === idx) {
                                            return null
                                          }
                                          return prev
                                        })
                                      }}
                                      title="Remove parsed line"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              )
                            })}

                            {importManualLines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell className="align-top">
                                  <Input
                                    value={line.description}
                                    onChange={(e) =>
                                      updateManualImportLine(line.id, {
                                        description: e.target.value,
                                      })
                                    }
                                    placeholder="Manual line description"
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <Select
                                    value={line.itemId || "__none__"}
                                    onValueChange={(value) => {
                                      if (value === "__create__") {
                                        setImportNewItemTarget({ kind: "manual", lineId: line.id })
                                        return
                                      }
                                      updateManualImportLine(line.id, {
                                        itemId: value === "__none__" ? "" : value,
                                      })
                                    }}
                                  >
                                    <SelectTrigger className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all">
                                      <SelectValue placeholder="Map item" />
                                    </SelectTrigger>
                                    <SelectContent className="max-w-[min(90vw,32rem)]">
                                      <SelectItem value="__none__">Unmapped</SelectItem>
                                      <SelectItem value="__create__">
                                        <span className="text-blue-600">+ Create New Item</span>
                                      </SelectItem>
                                      {items.map((it) => (
                                        <SelectItem key={it.id} value={it.id}>
                                          <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                                            {truncateOptionLabel(it.name, 120)}
                                          </span>
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                                <TableCell className="align-top">
                                  <Input
                                    className="text-right"
                                    type="number"
                                    min={1}
                                    value={line.quantity}
                                    onChange={(e) =>
                                      updateManualImportLine(line.id, {
                                        quantity: e.target.value,
                                      })
                                    }
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <Input
                                    className="text-right"
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={line.unitCost}
                                    onChange={(e) =>
                                      updateManualImportLine(line.id, {
                                        unitCost: e.target.value,
                                      })
                                    }
                                  />
                                </TableCell>
                                <TableCell className="align-top text-center text-xs text-muted-foreground">
                                  Manual
                                </TableCell>
                                <TableCell className="align-top text-center">
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="text-red-600"
                                    onClick={() => removeManualImportLine(line.id)}
                                    title="Remove line"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}

                            {totalImportLineCount === 0 && (
                              <EmptyTableRow
                                colSpan={6}
                                message="No line items extracted yet. Add one manually or retry parsing."
                              />
                            )}
                          </TableBody>
                        </Table>
                      </div>

                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>
                          Line-item subtotal: {formatCurrency(importLineItemsSubtotal.toFixed(2))}
                          {importSubtotalDifference !== null && (
                            <>
                              {" "}
                              (difference vs receipt subtotal: {formatCurrency(importSubtotalDifference.toFixed(2))})
                            </>
                          )}
                        </p>
                        <p>
                          Confidence is OCR extraction confidence for parsed line text, not item-map confidence.
                        </p>
                      </div>

                      <div
                        className={`text-xs px-3 py-2 rounded-md ${
                          hasDuplicateImportedReceipt || hasDuplicateMappedImportedItems || hasImportSubtotalMismatch
                            ? "text-red-700 bg-red-50"
                            : unresolvedImportedCount > 0 || totalImportLineCount === 0
                              ? "text-amber-700 bg-amber-50"
                              : "text-muted-foreground bg-muted"
                        }`}
                      >
                        {hasDuplicateImportedReceipt
                          ? "Receipt number must be unique before creating this receipt."
                          : hasDuplicateMappedImportedItems
                            ? duplicateMappedImportedMessage
                          : hasImportSubtotalMismatch
                            ? `Line-item subtotal ${formatCurrency(importLineItemsSubtotal.toFixed(2))} must match receipt subtotal ${formatCurrency(Number.parseFloat(importSubtotal).toFixed(2))}.`
                          : unresolvedImportedCount > 0
                          ? `Resolve all line items to continue (${totalImportLineCount - unresolvedImportedCount}/${totalImportLineCount} ready)`
                          : totalImportLineCount === 0
                            ? "Add at least one line item to continue."
                            : `Ready to create receipt + ${totalImportLineCount} receipt line item${totalImportLineCount === 1 ? "" : "s"} and upload original document`}
                      </div>

                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={requestImportDialogClose} disabled={importCreating || importParsing}>
                          Cancel
                        </Button>
                        <Button
                          onClick={handleImportCreate}
                          disabled={
                            importCreating ||
                            importParsing ||
                            !importFile ||
                            !importVendorId ||
                            !importReceiptDate ||
                            !importSubtotal ||
                            hasDuplicateImportedReceipt ||
                            hasDuplicateMappedImportedItems ||
                            unresolvedImportedCount > 0 ||
                            totalImportLineCount === 0 ||
                            hasImportSubtotalMismatch
                          }
                        >
                          Create Receipt
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                <div className="order-1 space-y-4 xl:order-2">
                  <div className="space-y-2">
                    <Label htmlFor="receipt-import-file">Receipt file</Label>
                    <input
                      id="receipt-import-file"
                      ref={importFileInputRef}
                      type="file"
                      multiple
                      accept=".pdf,.png,.jpg,.jpeg,.webp"
                      className="hidden"
                      onChange={handleImportFileChange}
                    />
                    <div className="rounded-md border bg-muted/10 p-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => importFileInputRef.current?.click()}
                        >
                          Choose File
                        </Button>
                        <span className="text-sm text-muted-foreground truncate min-w-0">
                          {importFile ? importFile.name : "No file chosen"}
                        </span>
                      </div>

                      <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={importBypassCompression}
                          onChange={(e) => setImportBypassCompression(e.target.checked)}
                          disabled={importParsing || importCreating}
                        />
                        Bypass compression (upload original file)
                      </label>

                      <div className="mt-3 space-y-1">
                        <Label className="text-xs">OCR mode</Label>
                        <Select
                          value={importOcrMode}
                          onValueChange={(value) => setImportOcrMode(value as ReceiptOcrMode)}
                          disabled={importParsing || importCreating}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select OCR mode" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto (PaddleOCR + PaddleOCR-VL fallback)</SelectItem>
                            <SelectItem value="classic">PaddleOCR</SelectItem>
                            <SelectItem value="vl">PaddleOCR-VL</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  {importStatus && (
                    <div className="text-xs text-muted-foreground">{importStatus}</div>
                  )}

                  <div className="space-y-2">
                    <Label>Document Preview</Label>
                    <div className="rounded-md border bg-muted/20 p-2 min-h-[24rem]">
                      {importFilePreviewUrl ? (
                        importFile?.type.startsWith("image/") ? (
                          <img src={importFilePreviewUrl} alt="Receipt preview" className="max-h-[70vh] w-auto mx-auto rounded" />
                        ) : importFile?.type === "application/pdf" ? (
                          <iframe src={importFilePreviewUrl} title="Receipt preview" className="w-full h-[70vh] rounded border" />
                        ) : (
                          <div className="h-full flex items-center justify-center text-sm">
                            <a href={importFilePreviewUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                              Open preview in new tab
                            </a>
                          </div>
                        )
                      ) : (
                        <div className="h-full min-h-[22rem] flex items-center justify-center text-sm text-muted-foreground">
                          Select a file to preview.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <ConfirmCloseDialog
            open={confirmImportCloseOpen}
            onOpenChange={setConfirmImportCloseOpen}
            onConfirm={closeImportDialogNow}
          />
          <Button
            variant="outline"
            onClick={() => {
              setBulkImportPrefillFiles([])
              setBulkImportPrefillOcrMode(null)
              setBulkImportAutoStart(false)
              setBulkImportOpen(true)
            }}
          >
            <Upload className="h-4 w-4 mr-2" />
            Bulk Import Receipts
          </Button>
          <BulkReceiptImportDialog
            open={bulkImportOpen}
            onOpenChange={(open) => {
              setBulkImportOpen(open)
              if (!open) {
                setBulkImportPrefillFiles([])
                setBulkImportPrefillOcrMode(null)
                setBulkImportAutoStart(false)
              }
            }}
            prefillFiles={bulkImportPrefillFiles}
            prefillOcrMode={bulkImportPrefillOcrMode ?? undefined}
            autoStartParse={bulkImportAutoStart}
          />
          <ItemFormDialog
            open={importNewItemTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setImportNewItemTarget(null)
              }
            }}
            defaults={(() => {
              if (!importNewItemTarget) return undefined
              if (importNewItemTarget.kind === "parsed") {
                const line = parsedReceipt?.line_items[importNewItemTarget.index]
                if (!line) return undefined
                return {
                  name: resolveImportedDescription(importNewItemTarget.index, line.description),
                }
              }
              const line = importManualLines.find((entry) => entry.id === importNewItemTarget.lineId)
              if (!line) return undefined
              return { name: line.description }
            })()}
            onCreated={(newItemId) => {
              if (!importNewItemTarget) return

              if (importNewItemTarget.kind === "parsed") {
                setImportLineItemOverrides((prev) => ({
                  ...prev,
                  [importNewItemTarget.index]: newItemId,
                }))
              } else {
                updateManualImportLine(importNewItemTarget.lineId, { itemId: newItemId })
              }

              setImportNewItemTarget(null)
            }}
          />
          <Dialog
            open={isOpen}
            onOpenChange={(open) => {
              if (open) {
                setIsOpen(true)
                return
              }
              requestReceiptDialogClose()
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Receipt
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingId ? "Edit Receipt" : "Add Receipt"}
                </DialogTitle>
              </DialogHeader>
              <ReceiptForm
                open={isOpen}
                vendors={vendors}
                initialValues={editingReceipt
                  ? {
                      vendor_id: editingReceipt.vendor_id,
                      receipt_number: editingReceipt.receipt_number,
                      receipt_date: editingReceipt.receipt_date,
                      subtotal: editingReceipt.subtotal,
                      tax_amount: (parseFloat(editingReceipt.total) - parseFloat(editingReceipt.subtotal)).toFixed(2),
                      payment_method: editingReceipt.payment_method || "",
                      notes: editingReceipt.notes || "",
                    }
                  : undefined}
                requireDocument={!editingId}
                submitLabel={editingId ? "Save Changes" : "Create"}
                submittingLabel={editingId ? "Saving..." : "Creating..."}
                isSubmitting={createReceipt.isPending || updateReceipt.isPending}
                onSubmit={handleSubmit}
                onCancel={requestReceiptDialogClose}
                onImport={!editingId ? () => {
                  closeReceiptDialogNow()
                  setIsImportOpen(true)
                } : undefined}
                importButtonLabel="Import Receipt"
                onDirtyChange={setIsReceiptFormDirty}
              />
            </DialogContent>
          </Dialog>
          <ConfirmCloseDialog
            open={confirmReceiptCloseOpen}
            onOpenChange={setConfirmReceiptCloseOpen}
            onConfirm={closeReceiptDialogNow}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalReceipts}</div>
            <p className="text-sm text-muted-foreground">Total Receipts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatCurrency(totalSpent.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Total Spent (incl. tax)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className={`text-2xl font-bold ${unreconciledCount > 0 ? "text-amber-600" : "text-green-600"}`}>
              {unreconciledCount}
            </div>
            <p className="text-sm text-muted-foreground">Unreconciled</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="w-48">
              <Label className="mb-2 block">Vendor</Label>
              <Select
                value={vendorFilter || "all"}
                onValueChange={(v) => setVendorFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All vendors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All vendors</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Receipts Table */}
      <Card>
        <CardHeader>
          <CardTitle>Receipts ({filteredReceipts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Receipt #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>PDF</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReceipts.map((r) => {
                const taxAmount =
                  parseFloat(r.total || "0") - parseFloat(r.subtotal || "0")
                const source = r.ingestion_metadata?.source || "manual"
                const isAutoParsed = r.ingestion_metadata?.auto_parsed === true
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/receipts/${r.id}`)}
                  >
                    <TableCell>{formatDate(r.receipt_date)}</TableCell>
                    <TableCell className="font-mono font-medium">
                      {r.receipt_number}
                    </TableCell>
                    <TableCell>{r.vendor_name}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          source === "ocr"
                            ? "bg-blue-50 text-blue-700"
                            : source === "csv"
                              ? "bg-indigo-50 text-indigo-700"
                              : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {source}{isAutoParsed ? " • auto" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(r.subtotal)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCurrency(taxAmount.toFixed(2))}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(r.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {getReceiptItemsDisplayCount(r)}
                    </TableCell>
                    <TableCell>
                      <ReconciliationBadge receipt={r} />
                    </TableCell>
                    <TableCell>
                      {r.has_pdf ? (
                        <FileText className="h-4 w-4 text-blue-600" />
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleUploadPdf(r.id)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Upload className="h-4 w-4" />
                        </button>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleEdit(r)
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-red-600"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(r.id)
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredReceipts.length === 0 && (
                <EmptyTableRow colSpan={11} message="No receipts yet" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
