import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  importApi,
  type ParsedReceipt,
  type ReceiptOcrMode,
  type ReceiptImageParseProgress,
} from "@/api"
import { useItems, useReceipts, useVendors, useVendorImportAliases, useCreateVendorImportAlias, useDeleteVendorImportAlias } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { ReceiptImportLineTable } from "@/components/ReceiptImportLineTable"
import { Plus, Trash2, Loader2 } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  findExistingReceiptByNumber,
  getImportSubtotalDifference,
  importSubtotalMatches,
} from "@/lib/receiptImportValidation"
import {
  getReceiptTaxValidationState,
  getStoredExpectedTaxRate,
} from "@/lib/receiptSummary"
import {
  type ManualImportLine,
  type ImportLineOverrides,
  createManualImportLine,
  getOcrEngineDisplayName,
  getFixtureUsedDisplayName,
  resolveImportedDescription,
  computeImportLineStats,
  computeMergePreview,
  executeReceiptImport,
} from "@/lib/receiptImportHelpers"

type ImportNewItemTarget =
  | { kind: "parsed"; index: number }
  | { kind: "manual"; lineId: string }

export type ReceiptImportPanelHandle = {
  /** True if there's any in-progress state that should block close */
  hasActionInProgress: boolean
  /** Reset all import state */
  reset: () => void
}

type ReceiptImportPanelProps = {
  /** When provided, the panel auto-parses this file on mount (or when it changes). */
  initialFile?: File | null
  /** OCR mode override */
  ocrMode?: ReceiptOcrMode
  /** Bypass compression override */
  bypassCompression?: boolean
  /** Hide the file picker sidebar (bulk import provides its own) */
  hideFilePicker?: boolean
  /** Initial parsed receipt data (for restoring previously parsed files) */
  initialParsedReceipt?: ParsedReceipt | null
  /** Called when the receipt has been parsed successfully */
  onParsed?: (receipt: ParsedReceipt) => void
  /** Called when importing state changes (true = currently importing, false = done) */
  onImportingChange?: (importing: boolean) => void
  /** Called when the import finishes successfully */
  onImported?: () => void
  /** Called when the panel's dirty/actionInProgress state changes */
  onActionInProgressChange?: (inProgress: boolean) => void
  /** Expose imperative handle to parent */
  onHandle?: (handle: ReceiptImportPanelHandle) => void
  /** Show a re-parse button instead of the file chooser */
  showReParse?: boolean
  /** Extra buttons to render in the action bar */
  extraButtons?: React.ReactNode
  /** Whether busy externally (e.g. another draft importing) */
  externalBusy?: boolean
  /** Additional validation: check for batch-level duplicate receipt numbers */
  batchDuplicateCheck?: (receiptNumber: string) => boolean
}

export function ReceiptImportPanel({
  initialFile = null,
  ocrMode: ocrModeOverride,
  bypassCompression: bypassCompressionOverride,
  hideFilePicker = false,
  initialParsedReceipt,
  onParsed,
  onImportingChange,
  onImported,
  onActionInProgressChange,
  onHandle,
  showReParse = false,
  extraButtons,
  externalBusy = false,
  batchDuplicateCheck,
}: ReceiptImportPanelProps) {
  const queryClient = useQueryClient()
  const { data: vendors = [] } = useVendors()
  const { data: items = [] } = useItems()
  const { data: allReceipts = [] } = useReceipts()
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items])
  const itemNameById = useMemo(
    () => new Map(items.map((item) => [item.id, item.name])),
    [items]
  )

  const [importFile, setImportFile] = useState<File | null>(initialFile)
  const [parsedReceipt, setParsedReceipt] = useState<ParsedReceipt | null>(initialParsedReceipt ?? null)
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
  const [importBypassCompression, setImportBypassCompression] = useState(bypassCompressionOverride ?? false)
  const [importOcrMode, setImportOcrMode] = useState<ReceiptOcrMode>(ocrModeOverride ?? "auto")
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const importFileInputId = useId()

  const { data: selectedVendorAliases = [] } = useVendorImportAliases(importVendorId)
  const createVendorAlias = useCreateVendorImportAlias(importVendorId)
  const deleteVendorAlias = useDeleteVendorImportAlias(importVendorId)

  // ── File preview URL management ──

  useEffect(() => {
    if (!importFile) { setImportFilePreviewUrl(null); return }
    const url = URL.createObjectURL(importFile)
    setImportFilePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [importFile])

  // ── Sync overrides from parent ──

  useEffect(() => {
    if (ocrModeOverride !== undefined) setImportOcrMode(ocrModeOverride)
  }, [ocrModeOverride])

  useEffect(() => {
    if (bypassCompressionOverride !== undefined) setImportBypassCompression(bypassCompressionOverride)
  }, [bypassCompressionOverride])

  // ── Overrides & context ──

  const importOverrides: ImportLineOverrides = useMemo(
    () => ({
      lineDescriptionOverrides: importLineDescriptionOverrides,
      lineItemOverrides: importLineItemOverrides,
      lineQtyOverrides: importLineQtyOverrides,
      lineUnitCostOverrides: importLineUnitCostOverrides,
      deletedLineIndexes: importDeletedLineIndexes,
    }),
    [importLineDescriptionOverrides, importLineItemOverrides, importLineQtyOverrides, importLineUnitCostOverrides, importDeletedLineIndexes]
  )

  const autoMatchCtx = useMemo(
    () => ({ vendorId: importVendorId, items, itemIdSet }),
    [importVendorId, items, itemIdSet]
  )

  // ── Line stats & validation ──

  const lineStats = useMemo(
    () => computeImportLineStats(parsedReceipt, importOverrides, importManualLines, autoMatchCtx),
    [parsedReceipt, importOverrides, importManualLines, autoMatchCtx]
  )

  const importSubtotalDifference = useMemo(
    () => getImportSubtotalDifference(importSubtotal, lineStats.lineSubtotal),
    [importSubtotal, lineStats.lineSubtotal]
  )

  const importMergePreview = useMemo(
    () => computeMergePreview(parsedReceipt, importOverrides, importManualLines, autoMatchCtx, itemNameById),
    [parsedReceipt, importOverrides, importManualLines, autoMatchCtx, itemNameById]
  )

  const duplicateImportedReceipt = useMemo(
    () => findExistingReceiptByNumber(allReceipts, importReceiptNumber),
    [allReceipts, importReceiptNumber]
  )
  const hasDuplicateImportedReceipt = Boolean(duplicateImportedReceipt) || Boolean(batchDuplicateCheck?.(importReceiptNumber))

  const hasImportSubtotalMismatch =
    lineStats.total > 0 &&
    lineStats.unresolved === 0 &&
    importSubtotalDifference !== null &&
    !importSubtotalMatches(importSubtotal, lineStats.lineSubtotal)

  const importTaxValidationState = useMemo(
    () => getReceiptTaxValidationState(
      {
        subtotal: importSubtotal || "0",
        tax_amount: importTaxAmount || "0",
        total: importTotal || "0",
      },
      getStoredExpectedTaxRate()
    ),
    [importSubtotal, importTaxAmount, importTotal]
  )

  const selectedVendor = vendors.find((vendor) => vendor.id === importVendorId) || null
  const hasVendorMapping =
    Boolean(importVendorLabel.trim()) &&
    selectedVendorAliases.some(
      (alias) => alias.raw_alias.trim().toLowerCase() === importVendorLabel.trim().toLowerCase()
    )

  const hasActionInProgress =
    importParsing || importCreating || importFile !== null || parsedReceipt !== null || importManualLines.length > 0

  const isBusy = importParsing || importCreating || externalBusy

  // ── Notify parent of action-in-progress changes ──

  useEffect(() => {
    onActionInProgressChange?.(hasActionInProgress)
  }, [hasActionInProgress, onActionInProgressChange])

  // ── Notify parent of importing state changes ──

  useEffect(() => {
    onImportingChange?.(importCreating)
  }, [importCreating, onImportingChange])

  // ── Reset ──

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
    setImportBypassCompression(bypassCompressionOverride ?? false)
    setImportOcrMode(ocrModeOverride ?? "auto")
    if (importFileInputRef.current) importFileInputRef.current.value = ""
  }

  // ── Imperative handle ──

  useEffect(() => {
    onHandle?.({ hasActionInProgress, reset: resetImportForm })
  }, [hasActionInProgress])

  // ── Auto-parse when initialFile changes ──

  const lastParsedFileRef = useRef<File | null>(null)
  useEffect(() => {
    if (!initialFile || initialFile === lastParsedFileRef.current) return
    // If we have a previously parsed receipt for this file, don't re-parse
    if (initialParsedReceipt) return
    lastParsedFileRef.current = initialFile
    setImportFile(initialFile)
    void parseFile(initialFile)
  }, [initialFile, initialParsedReceipt])

  // ── Populate form from initialParsedReceipt (restore on switch back) ──

  useEffect(() => {
    if (!initialParsedReceipt) return
    lastParsedFileRef.current = initialFile
    setImportFile(initialFile)
    const rawVendorName = initialParsedReceipt.vendor_name?.trim() || ""
    const suggestedVendorId = initialParsedReceipt.suggested_vendor_id || ""
    const matchingVendorId =
      rawVendorName && vendors.find((v) => v.name.trim().toLowerCase() === rawVendorName.toLowerCase())?.id
    setImportVendorLabel(rawVendorName)
    setImportVendorId(
      matchingVendorId ||
        (suggestedVendorId && vendors.some((v) => v.id === suggestedVendorId) ? suggestedVendorId : "")
    )
    setImportReceiptNumber(initialParsedReceipt.receipt_number || "")
    setImportReceiptDate(initialParsedReceipt.receipt_date || "1970-01-01")
    setImportSubtotal(initialParsedReceipt.subtotal || "")
    const taxFromPayload = initialParsedReceipt.tax || ""
    const inferredTax = (!taxFromPayload && initialParsedReceipt.total && initialParsedReceipt.subtotal)
      ? (Number.parseFloat(initialParsedReceipt.total) - Number.parseFloat(initialParsedReceipt.subtotal)).toFixed(2)
      : ""
    setImportTaxAmount(taxFromPayload || inferredTax)
    setImportTotal(initialParsedReceipt.total || "")
    setImportPaymentMethod(initialParsedReceipt.payment_method || "")
    setImportWarnings(initialParsedReceipt.warnings || [])
    setImportNotes("")
  }, [initialParsedReceipt, vendors])

  // ── Vendor mapping helpers ──

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

  // ── Line management ──

  const addManualImportLine = () => {
    setImportManualLines((prev) => [...prev, createManualImportLine()])
  }

  const updateManualImportLine = (id: string, updates: Partial<Omit<ManualImportLine, "id">>) => {
    setImportManualLines((prev) => prev.map((line) => (line.id === id ? { ...line, ...updates } : line)))
  }

  const removeManualImportLine = (id: string) => {
    setImportManualLines((prev) => prev.filter((line) => line.id !== id))
  }

  const handleDeleteParsedLine = (idx: number) => {
    setImportDeletedLineIndexes((prev) => ({ ...prev, [idx]: true }))
    setImportLineDescriptionOverrides((prev) => { const next = { ...prev }; delete next[idx]; return next })
    setImportLineItemOverrides((prev) => { const next = { ...prev }; delete next[idx]; return next })
    setImportLineQtyOverrides((prev) => { const next = { ...prev }; delete next[idx]; return next })
    setImportLineUnitCostOverrides((prev) => { const next = { ...prev }; delete next[idx]; return next })
    setImportNewItemTarget((prev) => {
      if (prev?.kind === "parsed" && prev.index === idx) return null
      return prev
    })
  }

  // ── Parse file ──

  const parseFile = async (file: File) => {
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
      onParsed?.(parsed)
      const rawVendorName = parsed.vendor_name?.trim() || ""
      const suggestedVendorId = parsed.suggested_vendor_id || ""
      const matchingVendorId =
        rawVendorName && vendors.find((v) => v.name.trim().toLowerCase() === rawVendorName.toLowerCase())?.id
      setImportVendorLabel(rawVendorName)
      setImportVendorId(
        matchingVendorId ||
          (suggestedVendorId && vendors.some((v) => v.id === suggestedVendorId) ? suggestedVendorId : "")
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
      setImportStatus(`Receipt parsed using ${getOcrEngineDisplayName(parsed.parse_engine)}. Confirm all fields before saving.`)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to parse receipt image")
      setImportStatus("")
    } finally {
      setImportParsing(false)
      setImportParseStage(null)
      setImportParseProgress(null)
    }
  }

  // ── Handle file input change (single-import mode) ──

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length === 0) return
    const file = selectedFiles[0]
    await parseFile(file)
  }

  // ── Create receipt ──

  const handleImportCreate = async () => {
    if (!parsedReceipt || !importFile || !importVendorId) return
    if (lineStats.total === 0) {
      setImportError("Add at least one receipt line item before creating this receipt.")
      return
    }
    if (hasDuplicateImportedReceipt) {
      const duplicateNumber = importReceiptNumber.trim()
      if (duplicateImportedReceipt) {
        setImportError(`Receipt # ${duplicateNumber} already exists (${duplicateImportedReceipt.vendor_name}, ${formatDate(duplicateImportedReceipt.receipt_date)}). Use a unique receipt number.`)
      } else {
        setImportError(`Receipt # ${duplicateNumber} already exists. Use a unique receipt number.`)
      }
      return
    }
    if (hasImportSubtotalMismatch) {
      const expected = Number.parseFloat(importSubtotal)
      setImportError(`Line item subtotal ${formatCurrency(lineStats.lineSubtotal.toFixed(2))} does not match receipt subtotal ${formatCurrency(expected.toFixed(2))}.`)
      return
    }

    setImportCreating(true)
    setImportError("")

    try {
      await executeReceiptImport({
        parsedReceipt,
        overrides: importOverrides,
        manualLines: importManualLines,
        autoMatchCtx,
        itemNameById,
        vendorId: importVendorId,
        receiptNumber: importReceiptNumber,
        receiptDate: importReceiptDate,
        subtotal: importSubtotal,
        taxAmount: importTaxAmount,
        paymentMethod: importPaymentMethod,
        notes: importNotes,
        file: importFile,
        bypassCompression: importBypassCompression,
        onStatus: setImportStatus,
      })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      onImported?.()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import receipt")
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
    } finally {
      setImportCreating(false)
      setImportStatus("")
    }
  }

  // ── Finish Import disabled reason ──

  const finishImportDisabledReason = (() => {
    if (importCreating) return "Finishing import..."
    if (importParsing) return "Still parsing..."
    if (externalBusy) return "Another import is in progress."
    if (!importFile) return "Select a file first."
    if (!parsedReceipt) return "File has not been parsed yet."
    if (!importVendorId) return "Vendor is required."
    if (hasDuplicateImportedReceipt) {
      const dup = duplicateImportedReceipt
      return dup
        ? `Receipt # ${importReceiptNumber.trim()} already exists (${dup.vendor_name}, ${formatDate(dup.receipt_date)}). Use a unique receipt number.`
        : "Duplicate receipt number."
    }
    if (!importReceiptDate || importReceiptDate === "1970-01-01") return "Receipt date is required."
    if (!importSubtotal) return "Subtotal is required."
    if (lineStats.total === 0) return "Add at least one line item."
    if (lineStats.unresolved > 0) return `${lineStats.unresolved} line item(s) need mapping or valid costs.`
    if (hasImportSubtotalMismatch) {
      return `Line-item subtotal ${formatCurrency(lineStats.lineSubtotal.toFixed(2))} must match receipt subtotal ${formatCurrency(Number.parseFloat(importSubtotal).toFixed(2))}.`
    }
    return null
  })()
  const isFinishImportDisabled = finishImportDisabledReason !== null

  // ── Render ──

  return (
    <>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]">
        {/* Left column: parsed receipt form */}
        <div className="order-2 min-w-0 space-y-4 xl:order-1">
          {importError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{importError}</div>
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
                      <div className="h-full bg-primary transition-all" style={{ width: `${importParseProgress}%` }} />
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
              {hideFilePicker
                ? "Parse this file first, then review all extracted fields and lines before finishing import."
                : "Choose a receipt file on the right to parse and review extracted fields."}
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
                        <SelectTrigger className="sm:flex-1"><SelectValue placeholder="Select vendor" /></SelectTrigger>
                        <SelectContent>
                          {vendors.map((v) => (<SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>))}
                        </SelectContent>
                      </Select>
                      <Button type="button" variant="outline" onClick={handleSaveVendorMapping} disabled={!importVendorLabel.trim() || !importVendorId}>
                        Save mapping
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {selectedVendor ? `${importVendorLabel || "OCR label"} → ${selectedVendor.name}` : "Choose the real vendor for this OCR label."}
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
                        <div key={alias.id} className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs">
                          <span>{alias.raw_alias}</span>
                          <Button type="button" variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground" title={`Remove alias ${alias.raw_alias}`} onClick={() => handleDeleteVendorMapping(alias.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
                <div className="font-medium mb-1">OCR result</div>
                <div>Final engine: {getOcrEngineDisplayName(parsedReceipt.parse_engine)}</div>
                <div>Fixture used: {getFixtureUsedDisplayName(parsedReceipt.fixture_used)}</div>
                {typeof parsedReceipt.confidence_score === "number" && (
                  <div>Confidence score: {parsedReceipt.confidence_score.toFixed(2)}</div>
                )}
                {parsedReceipt.parse_version && (<div>Parse version: {parsedReceipt.parse_version}</div>)}
              </div>

              {importWarnings.length > 0 && (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  <div className="font-medium mb-1">OCR warnings (final engine: {getOcrEngineDisplayName(parsedReceipt?.parse_engine)})</div>
                  <ul className="list-disc pl-5">
                    {importWarnings.map((w, idx) => (<li key={idx}>{w}</li>))}
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
                  <Input value={importPaymentMethod} onChange={(e) => setImportPaymentMethod(e.target.value)} placeholder="Not detected" />
                </div>
              </div>

              {importTaxValidationState && (
                <div className={`text-sm border rounded-md px-3 py-2 ${importTaxValidationState.kind === "error" ? "text-red-700 bg-red-50 border-red-200" : "text-orange-700 bg-orange-50 border-orange-200"}`}>
                  <div className="font-medium mb-1">{importTaxValidationState.label}</div>
                  {importTaxValidationState.detail && <div>{importTaxValidationState.detail}</div>}
                </div>
              )}

              <div className="space-y-2">
                <Label>Notes</Label>
                <Input value={importNotes} onChange={(e) => setImportNotes(e.target.value)} placeholder="Optional notes" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="text-sm font-medium">Receipt Lines</Label>
                <Button type="button" variant="outline" size="sm" onClick={addManualImportLine}>
                  <Plus className="h-4 w-4 mr-2" />Add Line Item
                </Button>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">Tip: Map fee lines (e.g. env fee) to the same item to merge them into one line on save.</p>

              <ReceiptImportLineTable
                parsedReceipt={parsedReceipt}
                overrides={importOverrides}
                manualLines={importManualLines}
                items={items}
                autoMatchCtx={autoMatchCtx}
                totalLineCount={lineStats.total}
                onDescriptionChange={(idx, value, originalDescription) => {
                  setImportLineDescriptionOverrides((prev) => {
                    const next = { ...prev }
                    if (value === originalDescription) delete next[idx]
                    else next[idx] = value
                    return next
                  })
                }}
                onItemChange={(idx, v) => {
                  setImportLineItemOverrides((prev) => {
                    const next = { ...prev }
                    if (v === "__none__") delete next[idx]
                    else next[idx] = v
                    return next
                  })
                }}
                onQtyChange={(idx, value) => setImportLineQtyOverrides((prev) => ({ ...prev, [idx]: value }))}
                onUnitCostChange={(idx, value) => setImportLineUnitCostOverrides((prev) => ({ ...prev, [idx]: value }))}
                onDeleteParsedLine={handleDeleteParsedLine}
                onCreateItem={(target) => setImportNewItemTarget(target)}
                onManualLineChange={(lineId, updates) => updateManualImportLine(lineId, updates)}
                onManualLineRemove={removeManualImportLine}
              />

              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Line-item subtotal: {formatCurrency(lineStats.lineSubtotal.toFixed(2))}
                  {importSubtotalDifference !== null && (
                    <>{" "}(difference vs receipt subtotal: {formatCurrency(importSubtotalDifference.toFixed(2))})</>
                  )}
                </p>
                <p>Confidence is OCR extraction confidence for parsed line text, not item-map confidence.</p>
                {importMergePreview.collapsedLineCount > 0 && (
                  <p>
                    Merge preview: {importMergePreview.mappedLineCount} mapped lines will save as {importMergePreview.mergedLineCount} item lines.
                    Map fee lines (env/handling) to the same item to roll fee into that item's saved unit cost.
                  </p>
                )}
              </div>

              <div className={`text-xs px-3 py-2 rounded-md ${
                hasDuplicateImportedReceipt || hasImportSubtotalMismatch
                  ? "text-red-700 bg-red-50"
                  : lineStats.unresolved > 0 || lineStats.total === 0
                    ? "text-amber-700 bg-amber-50"
                    : "text-muted-foreground bg-muted"
              }`}>
                {isFinishImportDisabled ? finishImportDisabledReason : `Ready to create receipt + ${lineStats.total} receipt line item${lineStats.total === 1 ? "" : "s"} and upload original document`}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                {showReParse && (
                  <Button type="button" variant="outline" onClick={() => { if (importFile) void parseFile(importFile) }} disabled={isBusy}>
                    Re-Parse
                  </Button>
                )}
                {extraButtons}
                <Button
                  onClick={handleImportCreate}
                  disabled={isFinishImportDisabled}
                  title={finishImportDisabledReason || "Finish Import"}
                >
                  {importCreating ? "Finishing Import..." : "Finish Import"}
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Right column: file picker + preview */}
        <div className="order-1 space-y-4 xl:order-2">
          {!hideFilePicker && (
            <div className="space-y-2">
              <Label htmlFor={importFileInputId}>Receipt file</Label>
              <input id={importFileInputId} ref={importFileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={handleImportFileChange} />
              <div className="rounded-md border bg-muted/10 p-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Button asChild type="button" variant="outline">
                    <label htmlFor={importFileInputId}>Choose File</label>
                  </Button>
                  <span className="text-sm text-muted-foreground truncate min-w-0">{importFile ? importFile.name : "No file chosen"}</span>
                </div>
                <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={importBypassCompression} onChange={(e) => setImportBypassCompression(e.target.checked)} disabled={isBusy} />
                  Bypass compression (upload original file)
                </label>
                <div className="mt-3 space-y-1">
                  <Label className="text-xs">OCR mode</Label>
                  <Select value={importOcrMode} onValueChange={(value) => setImportOcrMode(value as ReceiptOcrMode)} disabled={isBusy}>
                    <SelectTrigger><SelectValue placeholder="Select OCR mode" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (PaddleOCR + PaddleOCR-VL fallback)</SelectItem>
                      <SelectItem value="classic">PaddleOCR</SelectItem>
                      <SelectItem value="vl">PaddleOCR-VL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {hideFilePicker && (
            <div className="space-y-2">
              <Label>Selected file</Label>
              <div className="rounded-md border bg-muted/10 p-3 space-y-3">
                <div className="text-sm break-all">{importFile?.name || "No file"}</div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={importBypassCompression} onChange={(e) => setImportBypassCompression(e.target.checked)} disabled={isBusy} />
                  Bypass compression (upload original file)
                </label>
                <div className="space-y-1">
                  <Label className="text-xs">OCR mode</Label>
                  <Select value={importOcrMode} onValueChange={(value) => setImportOcrMode(value as ReceiptOcrMode)} disabled={isBusy}>
                    <SelectTrigger><SelectValue placeholder="Select OCR mode" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (PaddleOCR + PaddleOCR-VL fallback)</SelectItem>
                      <SelectItem value="classic">PaddleOCR</SelectItem>
                      <SelectItem value="vl">PaddleOCR-VL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!parsedReceipt && !importParsing && (
                  <Button type="button" variant="outline" onClick={() => { if (importFile) void parseFile(importFile) }} disabled={isBusy}>
                    Parse Selected File
                  </Button>
                )}
              </div>
            </div>
          )}

          {importStatus && (<div className="text-xs text-muted-foreground">{importStatus}</div>)}

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
                    <a href={importFilePreviewUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open preview in new tab</a>
                  </div>
                )
              ) : (
                <div className="h-full min-h-[22rem] flex items-center justify-center text-sm text-muted-foreground">Select a file to preview.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ItemFormDialog
        open={importNewItemTarget !== null}
        onOpenChange={(open) => { if (!open) setImportNewItemTarget(null) }}
        defaults={(() => {
          if (!importNewItemTarget) return undefined
          if (importNewItemTarget.kind === "parsed") {
            const line = parsedReceipt?.line_items[importNewItemTarget.index]
            if (!line) return undefined
            return { name: resolveImportedDescription(importLineDescriptionOverrides, importNewItemTarget.index, line.description) }
          }
          const line = importManualLines.find((entry) => entry.id === importNewItemTarget.lineId)
          if (!line) return undefined
          return { name: line.description }
        })()}
        onCreated={(newItemId) => {
          if (!importNewItemTarget) return
          if (importNewItemTarget.kind === "parsed") {
            setImportLineItemOverrides((prev) => ({ ...prev, [importNewItemTarget.index]: newItemId }))
          } else {
            updateManualImportLine(importNewItemTarget.lineId, { itemId: newItemId })
          }
          setImportNewItemTarget(null)
        }}
      />
    </>
  )
}
