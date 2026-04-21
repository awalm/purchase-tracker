import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  importApi,
  type ParsedReceipt,
  type ReceiptImageParseProgress,
  type ReceiptOcrMode,
  receipts as receiptsApi,
} from "@/api"
import { useItems, useReceipts, useVendors } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { ReceiptImportLineTable } from "@/components/ReceiptImportLineTable"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertCircle, CheckCircle2, Loader2, Plus } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  findExistingReceiptByNumber,
  hasBatchDuplicateReceiptNumber,
  getImportSubtotalDifference,
  importSubtotalMatches,
} from "@/lib/receiptImportValidation"
import { rememberVendorItemMappings } from "@/lib/vendorItemMappingCache"
import {
  type ManualImportLine,
  type ImportLineOverrides,
  createManualImportLine,
  getOcrEngineDisplayName,
  getFixtureUsedDisplayName,
  resolveImportedDescription,
  computeImportLineStats,
  computeMergePreview,
  buildMergedLinesForSave,
} from "@/lib/receiptImportHelpers"

type BulkImportNewItemTarget =
  | { draftId: string; kind: "parsed"; index: number }
  | { draftId: string; kind: "manual"; lineId: string }

type BulkReceiptDraft = {
  id: string
  file: File
  parsedReceipt: ParsedReceipt | null
  parseError: string | null
  warnings: string[]
  vendorLabel: string
  vendorId: string
  receiptNumber: string
  receiptDate: string
  subtotal: string
  taxAmount: string
  total: string
  paymentMethod: string
  notes: string
  parseStage: ReceiptImageParseProgress["stage"] | null
  parseProgress: number | null
  status: "pending" | "imported" | "failed"
  statusMessage: string
  lineDescriptionOverrides: Record<number, string>
  lineItemOverrides: Record<number, string>
  lineQtyOverrides: Record<number, string>
  lineUnitCostOverrides: Record<number, string>
  deletedLineIndexes: Record<number, true>
  manualLines: ManualImportLine[]
}

type BulkReceiptImportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefillFiles?: File[]
  prefillOcrMode?: ReceiptOcrMode
  autoStartParse?: boolean
}

const createBulkReceiptDraft = (file: File): BulkReceiptDraft => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  file,
  parsedReceipt: null,
  parseError: null,
  warnings: [],
  vendorLabel: "",
  vendorId: "",
  receiptNumber: "",
  receiptDate: "1970-01-01",
  subtotal: "",
  taxAmount: "",
  total: "",
  paymentMethod: "",
  notes: "",
  parseStage: null,
  parseProgress: null,
  status: "pending",
  statusMessage: "",
  lineDescriptionOverrides: {},
  lineItemOverrides: {},
  lineQtyOverrides: {},
  lineUnitCostOverrides: {},
  deletedLineIndexes: {},
  manualLines: [],
})

const getDraftOverrides = (draft: BulkReceiptDraft): ImportLineOverrides => ({
  lineDescriptionOverrides: draft.lineDescriptionOverrides,
  lineItemOverrides: draft.lineItemOverrides,
  lineQtyOverrides: draft.lineQtyOverrides,
  lineUnitCostOverrides: draft.lineUnitCostOverrides,
  deletedLineIndexes: draft.deletedLineIndexes,
})

export function BulkReceiptImportDialog({
  open,
  onOpenChange,
  prefillFiles = [],
  prefillOcrMode,
  autoStartParse = false,
}: BulkReceiptImportDialogProps) {
  const queryClient = useQueryClient()
  const { data: vendors = [] } = useVendors()
  const { data: items = [] } = useItems()
  const { data: allReceipts = [] } = useReceipts()
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items])
  const itemNameById = useMemo(
    () => new Map(items.map((item) => [item.id, item.name])),
    [items]
  )

  const [bulkImportDrafts, setBulkImportDrafts] = useState<BulkReceiptDraft[]>([])
  const [bulkImportError, setBulkImportError] = useState("")
  const [bulkImportStatus, setBulkImportStatus] = useState("")
  const [bulkBypassCompression, setBulkBypassCompression] = useState(false)
  const [bulkOcrMode, setBulkOcrMode] = useState<ReceiptOcrMode>("auto")
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [importingDraftId, setImportingDraftId] = useState<string | null>(null)
  const [newItemTarget, setNewItemTarget] = useState<BulkImportNewItemTarget | null>(null)
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null)

  const bulkImportInputRef = useRef<HTMLInputElement>(null)
  const autoParsePendingRef = useRef(false)
  const autoParseModeRef = useRef<ReceiptOcrMode>("auto")

  const resetBulkImportForm = () => {
    setBulkImportDrafts([])
    setBulkImportError("")
    setBulkImportStatus("")
    setBulkBypassCompression(false)
    setBulkOcrMode("auto")
    setConfirmCloseOpen(false)
    setActiveDraftId(null)
    setImportingDraftId(null)
    setNewItemTarget(null)
    setActivePreviewUrl(null)
    autoParsePendingRef.current = false
    autoParseModeRef.current = "auto"
    if (bulkImportInputRef.current) {
      bulkImportInputRef.current.value = ""
    }
  }

  const hasActionInProgress =
    importingDraftId !== null ||
    bulkImportDrafts.some((draft) => draft.parseStage !== null) ||
    bulkImportDrafts.length > 0

  const closeDialogNow = () => {
    setConfirmCloseOpen(false)
    onOpenChange(false)
    resetBulkImportForm()
  }

  const requestCloseDialog = () => {
    if (hasActionInProgress) { setConfirmCloseOpen(true); return }
    closeDialogNow()
  }

  useEffect(() => { if (!open) autoParsePendingRef.current = false }, [open])

  useEffect(() => {
    if (!open || prefillFiles.length === 0) return
    const initialMode = prefillOcrMode || "auto"
    const nextDrafts = prefillFiles.map((file) => createBulkReceiptDraft(file))
    setBulkImportDrafts(nextDrafts)
    setActiveDraftId(nextDrafts[0]?.id || null)
    setBulkImportError("")
    setBulkImportStatus(`${prefillFiles.length} file(s) preloaded. Select a file, review full details, then Finish Import.`)
    setBulkOcrMode(initialMode)
    autoParseModeRef.current = initialMode
    autoParsePendingRef.current = autoStartParse
    if (bulkImportInputRef.current) bulkImportInputRef.current.value = ""
  }, [open, prefillFiles, prefillOcrMode, autoStartParse])

  useEffect(() => {
    if (bulkImportDrafts.length === 0) { setActiveDraftId(null); return }
    if (!activeDraftId || !bulkImportDrafts.some((d) => d.id === activeDraftId)) {
      setActiveDraftId(bulkImportDrafts[0].id)
    }
  }, [bulkImportDrafts, activeDraftId])

  const activeDraft = useMemo(
    () => bulkImportDrafts.find((d) => d.id === activeDraftId) || null,
    [bulkImportDrafts, activeDraftId]
  )

  useEffect(() => {
    if (!activeDraft) { setActivePreviewUrl(null); return }
    const url = URL.createObjectURL(activeDraft.file)
    setActivePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [activeDraft])

  const updateDraft = (draftId: string, updater: (draft: BulkReceiptDraft) => BulkReceiptDraft) => {
    setBulkImportDrafts((prev) => prev.map((d) => (d.id === draftId ? updater(d) : d)))
  }

  // ── Shared context for auto-matching (uses active draft's vendorId) ──

  const makeAutoMatchCtx = (vendorId: string) => ({ vendorId, items, itemIdSet })

  const resolveBulkVendorIdFromParsed = (parsed: ParsedReceipt): string => {
    const rawVendorName = parsed.vendor_name?.trim() || ""
    const suggestedVendorId = parsed.suggested_vendor_id || ""
    const matchingVendorId =
      rawVendorName && vendors.find((v) => v.name.trim().toLowerCase() === rawVendorName.toLowerCase())?.id
    return matchingVendorId || (suggestedVendorId && vendors.some((v) => v.id === suggestedVendorId) ? suggestedVendorId : "")
  }

  // ── Draft line stats & validation (shared helpers) ──

  const getDraftLineStats = (draft: BulkReceiptDraft) => {
    return computeImportLineStats(
      draft.parsedReceipt,
      getDraftOverrides(draft),
      draft.manualLines,
      makeAutoMatchCtx(draft.vendorId)
    )
  }

  const getBulkDraftValidationMessage = (draft: BulkReceiptDraft) => {
    if (draft.status === "imported") return { ready: false, message: "Already imported." }
    if (draft.parseError) return { ready: false, message: "Parse failed. Re-parse this file to continue." }
    if (!draft.parsedReceipt) return { ready: false, message: "File has not been parsed yet." }

    if (hasDuplicateInBatch(draft)) return { ready: false, message: "Duplicate receipt number in this batch." }
    const existingDuplicate = getExistingDuplicateForBulkDraft(draft)
    if (existingDuplicate) {
      return {
        ready: false,
        message: `Receipt # ${draft.receiptNumber.trim()} already exists (${existingDuplicate.vendor_name}, ${formatDate(existingDuplicate.receipt_date)}). Use a unique receipt number.`,
      }
    }
    if (!draft.vendorId) return { ready: false, message: "Vendor is required." }
    if (!draft.receiptDate || draft.receiptDate === "1970-01-01") return { ready: false, message: "Receipt date is required." }
    if (!draft.subtotal) return { ready: false, message: "Subtotal is required." }

    const stats = getDraftLineStats(draft)
    if (stats.total === 0) return { ready: false, message: "Add at least one line item to continue." }
    if (stats.unresolved > 0) return { ready: false, message: `${stats.unresolved} line item(s) need mapping or valid costs.` }

    const subtotalDifference = getImportSubtotalDifference(draft.subtotal, stats.lineSubtotal)
    if (subtotalDifference !== null && !importSubtotalMatches(draft.subtotal, stats.lineSubtotal)) {
      return {
        ready: false,
        message: `Line-item subtotal ${formatCurrency(stats.lineSubtotal.toFixed(2))} must match receipt subtotal ${formatCurrency(Number.parseFloat(draft.subtotal).toFixed(2))}.`,
      }
    }

    return { ready: true, message: `Ready to Finish Import (${stats.total} line item${stats.total === 1 ? "" : "s"}).` }
  }

  const getExistingDuplicateForBulkDraft = (draft: BulkReceiptDraft) =>
    findExistingReceiptByNumber(allReceipts, draft.receiptNumber)

  const hasDuplicateInBatch = (draft: BulkReceiptDraft): boolean =>
    hasBatchDuplicateReceiptNumber(
      bulkImportDrafts.map((entry) => ({ id: entry.id, receiptNumber: entry.receiptNumber })),
      { id: draft.id, receiptNumber: draft.receiptNumber }
    )

  // ── Parsing ──

  const handleBulkImportFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const nextDrafts = files.map((file) => createBulkReceiptDraft(file))
    setBulkImportDrafts(nextDrafts)
    setActiveDraftId(nextDrafts[0]?.id || null)
    setBulkImportError("")
    setBulkImportStatus(`${files.length} file(s) loaded. Select each file, review full details, then Finish Import.`)
    setNewItemTarget(null)
  }

  const parseDraft = async (draftId: string, modeOverride?: ReceiptOcrMode): Promise<boolean> => {
    const draft = bulkImportDrafts.find((entry) => entry.id === draftId)
    if (!draft) return false
    const ocrMode = modeOverride || bulkOcrMode
    setBulkImportError("")
    setBulkImportStatus(`Parsing ${draft.file.name}...`)
    updateDraft(draftId, (entry) => ({
      ...entry, parseError: null, warnings: [], parseStage: "uploading", parseProgress: 0,
      status: entry.status === "imported" ? "imported" : "pending", statusMessage: "",
    }))

    try {
      const parsed = await importApi.receiptImage(
        draft.file,
        ({ stage, progress }) => { updateDraft(draftId, (entry) => ({ ...entry, parseStage: stage, parseProgress: progress ?? null })) },
        { bypassCompression: bulkBypassCompression, ocrMode }
      )
      const taxFromPayload = parsed.tax || ""
      let inferredTax = ""
      if (!taxFromPayload && parsed.total && parsed.subtotal) {
        const totalNumber = Number.parseFloat(parsed.total)
        const subtotalNumber = Number.parseFloat(parsed.subtotal)
        if (Number.isFinite(totalNumber) && Number.isFinite(subtotalNumber)) {
          inferredTax = (totalNumber - subtotalNumber).toFixed(2)
        }
      }
      updateDraft(draftId, (entry) => ({
        ...entry,
        parsedReceipt: parsed, parseError: null, warnings: parsed.warnings || [],
        vendorLabel: parsed.vendor_name?.trim() || "", vendorId: resolveBulkVendorIdFromParsed(parsed),
        receiptNumber: parsed.receipt_number || "", receiptDate: parsed.receipt_date || "1970-01-01",
        subtotal: parsed.subtotal || "", taxAmount: taxFromPayload || inferredTax,
        total: parsed.total || "", paymentMethod: parsed.payment_method || "", notes: "",
        parseStage: null, parseProgress: null,
        status: entry.status === "imported" ? "imported" : "pending", statusMessage: "",
        lineDescriptionOverrides: {}, lineItemOverrides: {}, lineQtyOverrides: {},
        lineUnitCostOverrides: {}, deletedLineIndexes: {}, manualLines: [],
      }))
      setBulkImportStatus(`Parsed ${draft.file.name} using ${getOcrEngineDisplayName(parsed.parse_engine)}.`)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse receipt image"
      updateDraft(draftId, (entry) => ({
        ...entry, parsedReceipt: null, parseError: message, warnings: [],
        parseStage: null, parseProgress: null, status: "failed", statusMessage: message,
      }))
      setBulkImportError(message)
      setBulkImportStatus("")
      return false
    }
  }

  const handleParseAll = async (modeOverride?: ReceiptOcrMode) => {
    if (bulkImportDrafts.length === 0) { setBulkImportError("Choose at least one file to parse."); return }
    const ocrMode = modeOverride || bulkOcrMode
    setBulkImportError("")
    let parsedCount = 0; let failedCount = 0
    for (let index = 0; index < bulkImportDrafts.length; index += 1) {
      const draft = bulkImportDrafts[index]
      setBulkImportStatus(`Parsing ${index + 1}/${bulkImportDrafts.length}: ${draft.file.name}`)
      const success = await parseDraft(draft.id, ocrMode)
      if (success) parsedCount += 1; else failedCount += 1
    }
    setBulkImportStatus(`Parsed ${parsedCount}/${bulkImportDrafts.length} files${failedCount > 0 ? ` (${failedCount} failed)` : ""}. Select each file to verify full details and finish import.`)
  }

  // ── Finish import (uses shared buildMergedLinesForSave) ──

  const handleFinishImport = async () => {
    if (!activeDraft) { setBulkImportError("Select a file first."); return }
    if (activeDraft.parseStage) { setBulkImportError(`Please wait: ${activeDraft.file.name} is still parsing.`); return }
    if (importingDraftId && importingDraftId !== activeDraft.id) {
      const importing = bulkImportDrafts.find((e) => e.id === importingDraftId)
      setBulkImportError(importing ? `Please wait: ${importing.file.name} is currently importing.` : "Another receipt is currently importing.")
      return
    }
    const validation = getBulkDraftValidationMessage(activeDraft)
    if (!validation.ready) { setBulkImportError(validation.message); return }
    if (!activeDraft.parsedReceipt) { setBulkImportError("Parsed receipt data is missing."); return }

    setBulkImportError("")
    setImportingDraftId(activeDraft.id)
    setBulkImportStatus(`Finishing import: ${activeDraft.file.name}`)

    let createdReceiptId: string | null = null

    try {
      const parsed = activeDraft.parsedReceipt
      const created = await receiptsApi.create({
        vendor_id: activeDraft.vendorId,
        source_vendor_alias: parsed.vendor_name?.trim() || undefined,
        ...(activeDraft.receiptNumber.trim() ? { receipt_number: activeDraft.receiptNumber.trim() } : {}),
        receipt_date: activeDraft.receiptDate,
        subtotal: activeDraft.subtotal,
        tax_amount: activeDraft.taxAmount || undefined,
        payment_method: activeDraft.paymentMethod || undefined,
        ingestion_metadata: {
          source: "ocr", auto_parsed: true, parse_engine: parsed.parse_engine || "unknown",
          ...(parsed.parse_version ? { parse_version: parsed.parse_version } : {}),
          ...(parsed.fixture_used ? { fixture_used: parsed.fixture_used } : {}),
          ...(typeof parsed.confidence_score === "number" ? { confidence_score: parsed.confidence_score } : {}),
          ...(parsed.vendor_name?.trim() ? { raw_vendor_name: parsed.vendor_name.trim() } : {}),
          ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
          ingested_at: new Date().toISOString(), ingestion_version: "ocr-v1",
        },
        notes: activeDraft.notes || undefined,
      })
      createdReceiptId = created.id

      const ctx = makeAutoMatchCtx(activeDraft.vendorId)
      const { mergedLines, learnedMappings } = buildMergedLinesForSave(
        parsed, getDraftOverrides(activeDraft), activeDraft.manualLines, ctx, itemNameById
      )

      for (const line of mergedLines) {
        await receiptsApi.lineItems.create(createdReceiptId, {
          item_id: line.itemId, quantity: line.quantity, unit_cost: line.unitCost, notes: line.notes || undefined,
        })
      }

      await receiptsApi.uploadPdf(createdReceiptId, activeDraft.file, { bypassCompression: bulkBypassCompression })
      rememberVendorItemMappings(activeDraft.vendorId, learnedMappings)

      updateDraft(activeDraft.id, (entry) => ({ ...entry, status: "imported", statusMessage: `Imported as ${createdReceiptId}.` }))
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      const nextDraft = bulkImportDrafts.find((d) => d.id !== activeDraft.id && d.status !== "imported")
      if (nextDraft) setActiveDraftId(nextDraft.id)
      setBulkImportStatus(`Imported ${activeDraft.file.name}.`)
    } catch (err) {
      const baseMessage = err instanceof Error ? err.message : "Failed to import receipt"
      let message = baseMessage
      if (createdReceiptId) {
        try {
          await receiptsApi.delete(createdReceiptId)
          message = `${baseMessage}. Import was rolled back and temporary receipt (${createdReceiptId}) was deleted.`
        } catch (cleanupErr) {
          const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : "Failed to clean up created receipt"
          message = `${baseMessage}. Receipt was created (${createdReceiptId}) but rollback failed: ${cleanupMessage}`
        }
        queryClient.invalidateQueries({ queryKey: ["receipts"] })
      }
      updateDraft(activeDraft.id, (entry) => ({ ...entry, status: "failed", statusMessage: message }))
      setBulkImportError(message)
      setBulkImportStatus("")
    } finally {
      setImportingDraftId(null)
    }
  }

  // ── Manual line management ──

  const addManualImportLine = () => {
    if (!activeDraft) return
    updateDraft(activeDraft.id, (entry) => ({ ...entry, manualLines: [...entry.manualLines, createManualImportLine()] }))
  }

  const updateManualImportLine = (draftId: string, lineId: string, updates: Partial<Omit<ManualImportLine, "id">>) => {
    updateDraft(draftId, (entry) => ({
      ...entry, manualLines: entry.manualLines.map((l) => (l.id === lineId ? { ...l, ...updates } : l)),
    }))
  }

  const removeManualImportLine = (draftId: string, lineId: string) => {
    updateDraft(draftId, (entry) => ({ ...entry, manualLines: entry.manualLines.filter((l) => l.id !== lineId) }))
  }

  const removeParsedDraftLine = (draftId: string, index: number) => {
    updateDraft(draftId, (entry) => {
      const nextDesc = { ...entry.lineDescriptionOverrides }; delete nextDesc[index]
      const nextItem = { ...entry.lineItemOverrides }; delete nextItem[index]
      const nextQty = { ...entry.lineQtyOverrides }; delete nextQty[index]
      const nextCost = { ...entry.lineUnitCostOverrides }; delete nextCost[index]
      return {
        ...entry,
        deletedLineIndexes: { ...entry.deletedLineIndexes, [index]: true },
        lineDescriptionOverrides: nextDesc, lineItemOverrides: nextItem,
        lineQtyOverrides: nextQty, lineUnitCostOverrides: nextCost,
      }
    })
    setNewItemTarget((prev) => {
      if (prev?.draftId === draftId && prev.kind === "parsed" && prev.index === index) return null
      return prev
    })
  }

  // ── Auto-parse effect ──

  useEffect(() => {
    if (!open || !autoParsePendingRef.current) return
    if (bulkImportDrafts.length === 0) return
    autoParsePendingRef.current = false
    void handleParseAll(autoParseModeRef.current)
  }, [open, bulkImportDrafts])

  // ── Derived state ──

  const importedCount = bulkImportDrafts.filter((d) => d.status === "imported").length
  const parsedCount = bulkImportDrafts.filter((d) => d.parsedReceipt).length
  const parsingDrafts = bulkImportDrafts.filter((d) => d.parseStage !== null)
  const isBusy = importingDraftId !== null || parsingDrafts.length > 0

  const importingDraft = importingDraftId ? bulkImportDrafts.find((d) => d.id === importingDraftId) || null : null
  const importBusyReason = importingDraft ? `Please wait: ${importingDraft.file.name} is currently importing.` : null

  const activeLineStats = activeDraft ? getDraftLineStats(activeDraft) : null
  const activeValidation = activeDraft ? getBulkDraftValidationMessage(activeDraft) : { ready: false, message: "Select a file to review." }
  const activeSubtotalDifference =
    activeDraft && activeLineStats
      ? getImportSubtotalDifference(activeDraft.subtotal, activeLineStats.lineSubtotal)
      : null
  const activeHasSubtotalMismatch =
    Boolean(activeDraft) && Boolean(activeLineStats) &&
    Boolean(activeLineStats && activeLineStats.total > 0 && activeLineStats.unresolved === 0) &&
    activeSubtotalDifference !== null &&
    !importSubtotalMatches(activeDraft?.subtotal || "", activeLineStats?.lineSubtotal || 0)

  const activeMergePreview = useMemo(() => {
    if (!activeDraft || !activeDraft.parsedReceipt) return { mappedLineCount: 0, mergedLineCount: 0, collapsedLineCount: 0 }
    return computeMergePreview(
      activeDraft.parsedReceipt,
      getDraftOverrides(activeDraft),
      activeDraft.manualLines,
      makeAutoMatchCtx(activeDraft.vendorId),
      itemNameById
    )
  }, [activeDraft, itemNameById])

  const activeDraftParsing = Boolean(activeDraft?.parseStage)
  const otherParsingCount = parsingDrafts.filter((d) => d.id !== activeDraftId).length

  const finishImportDisabledReason = (() => {
    if (!activeDraft) return "Select a file first."
    if (importingDraftId === activeDraft.id) return `Finishing import for ${activeDraft.file.name}...`
    if (activeDraftParsing) return `Please wait: ${activeDraft.file.name} is still parsing.`
    if (importBusyReason) return importBusyReason
    if (activeDraft.status === "imported") return activeDraft.statusMessage || "This file has already been imported."
    if (!activeValidation.ready) return activeValidation.message
    return null
  })()
  const isFinishImportDisabled = finishImportDisabledReason !== null

  // ── Active draft auto-match context (for the line table) ──

  const activeAutoMatchCtx = useMemo(
    () => makeAutoMatchCtx(activeDraft?.vendorId || ""),
    [activeDraft?.vendorId, items, itemIdSet]
  )
  const activeOverrides: ImportLineOverrides | null = activeDraft ? getDraftOverrides(activeDraft) : null

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => { if (nextOpen) { onOpenChange(true); return }; requestCloseDialog() }}>
        <DialogContent className="w-[96vw] max-w-[1800px]">
          <DialogHeader><DialogTitle>Bulk Import Receipts (Full Review Per File)</DialogTitle></DialogHeader>

          <div className="space-y-4">
            {bulkImportError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{bulkImportError}</div>
            )}
            {bulkImportStatus && (<div className="text-xs text-muted-foreground">{bulkImportStatus}</div>)}

            <input ref={bulkImportInputRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={handleBulkImportFilesChange} />

            {bulkImportDrafts.length === 0 ? (
              <div className="space-y-4">
                <div className="rounded-md border border-dashed bg-muted/10 px-4 py-5 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" onClick={() => bulkImportInputRef.current?.click()}>Choose Files</Button>
                    <span className="text-sm text-muted-foreground">Load multiple receipt files, then review each one in full before finishing import.</span>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={bulkBypassCompression} onChange={(e) => setBulkBypassCompression(e.target.checked)} />
                    Bypass compression (upload original file)
                  </label>
                  <div className="space-y-1 max-w-sm">
                    <Label className="text-xs">OCR mode</Label>
                    <Select value={bulkOcrMode} onValueChange={(value) => setBulkOcrMode(value as ReceiptOcrMode)}>
                      <SelectTrigger><SelectValue placeholder="Select OCR mode" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto (PaddleOCR-VL + PaddleOCR fallback)</SelectItem>
                        <SelectItem value="classic">PaddleOCR</SelectItem>
                        <SelectItem value="vl">PaddleOCR-VL</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={requestCloseDialog}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-muted-foreground">
                    {bulkImportDrafts.length} file(s) loaded. {parsedCount} parsed. {importedCount} imported.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => bulkImportInputRef.current?.click()} disabled={isBusy}>Replace Files</Button>
                    <Button type="button" variant="outline" onClick={() => { void handleParseAll() }} disabled={isBusy}>Parse All</Button>
                    <Button type="button" variant="outline" onClick={requestCloseDialog} disabled={isBusy}>Close</Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                  {/* Draft list sidebar */}
                  <div className="border rounded-md p-2 max-h-[76vh] overflow-y-auto space-y-2">
                    {bulkImportDrafts.map((draft) => {
                      const isActive = draft.id === activeDraftId
                      const draftStats = getDraftLineStats(draft)
                      const draftValidation = getBulkDraftValidationMessage(draft)
                      return (
                        <button key={draft.id} type="button" onClick={() => setActiveDraftId(draft.id)}
                          className={`w-full text-left rounded-md border px-3 py-2 space-y-1 transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}>
                          <div className="font-medium text-sm break-all">{draft.file.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {draft.status === "imported" ? "Imported"
                              : draft.parseStage === "uploading" ? `Uploading${typeof draft.parseProgress === "number" ? ` ${draft.parseProgress}%` : "..."}`
                              : draft.parseStage === "processing" ? "Parsing..."
                              : draft.parseError ? "Parse failed"
                              : draft.parsedReceipt ? "Parsed" : "Not parsed"}
                          </div>
                          {draft.parsedReceipt && (
                            <div className="text-[11px] text-muted-foreground">{draftStats.total - draftStats.unresolved}/{draftStats.total} lines ready</div>
                          )}
                          {draft.status === "imported" ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />Imported</div>
                          ) : !draftValidation.ready ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full"><AlertCircle className="h-3 w-3" />Needs review</div>
                          ) : (
                            <div className="inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />Ready</div>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {/* Active draft detail */}
                  <div className="min-w-0">
                    {!activeDraft ? (
                      <div className="rounded-md border bg-muted/10 px-4 py-6 text-sm text-muted-foreground">Select a file from the left to review and finish import.</div>
                    ) : (
                      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]">
                        <div className="order-2 min-w-0 space-y-4 2xl:order-1">
                          {activeDraft.parseError && (
                            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{activeDraft.parseError}</div>
                          )}

                          {!activeDraft.parsedReceipt && !activeDraft.parseError && activeDraft.parseStage && (
                            <div className="rounded-md border bg-muted/20 px-4 py-8">
                              <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                <div className="font-medium text-foreground">{activeDraft.parseStage === "uploading" ? "Uploading receipt" : "Parsing receipt"}</div>
                                {activeDraft.parseStage === "uploading" && typeof activeDraft.parseProgress === "number" && (
                                  <div className="w-full max-w-sm space-y-1">
                                    <div className="h-2 w-full overflow-hidden rounded bg-muted">
                                      <div className="h-full bg-primary transition-all" style={{ width: `${activeDraft.parseProgress}%` }} />
                                    </div>
                                    <div className="text-center text-xs">{activeDraft.parseProgress}% uploaded</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {!activeDraft.parsedReceipt && !activeDraft.parseError && !activeDraft.parseStage && (
                            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-5 text-sm text-muted-foreground space-y-3">
                              <div>Parse this file first, then review all extracted fields and lines before finishing import.</div>
                              <Button type="button" onClick={() => { void parseDraft(activeDraft.id) }} disabled={isBusy}>Parse Selected File</Button>
                            </div>
                          )}

                          {activeDraft.parsedReceipt && activeOverrides && (
                            <>
                              <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-3">
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                  <div className="space-y-1">
                                    <div className="font-medium text-foreground">OCR vendor label</div>
                                    <div className="text-muted-foreground">{activeDraft.vendorLabel || activeDraft.parsedReceipt.vendor_name?.trim() || "-"}</div>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs font-medium">Mapped vendor</Label>
                                    <Select value={activeDraft.vendorId || "__none__"} onValueChange={(value) => updateDraft(activeDraft.id, (e) => ({ ...e, vendorId: value === "__none__" ? "" : value }))} disabled={isBusy}>
                                      <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">Unmapped</SelectItem>
                                        {vendors.map((v) => (<SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              </div>

                              <div className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
                                <div className="font-medium mb-1">OCR result</div>
                                <div>Final engine: {getOcrEngineDisplayName(activeDraft.parsedReceipt.parse_engine)}</div>
                                <div>Fixture used: {getFixtureUsedDisplayName(activeDraft.parsedReceipt.fixture_used)}</div>
                                {typeof activeDraft.parsedReceipt.confidence_score === "number" && (
                                  <div>Confidence score: {activeDraft.parsedReceipt.confidence_score.toFixed(2)}</div>
                                )}
                                {activeDraft.parsedReceipt.parse_version && (<div>Parse version: {activeDraft.parsedReceipt.parse_version}</div>)}
                              </div>

                              {activeDraft.warnings.length > 0 && (
                                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                                  <div className="font-medium mb-1">OCR warnings (final engine: {getOcrEngineDisplayName(activeDraft.parsedReceipt.parse_engine)})</div>
                                  <ul className="list-disc pl-5">{activeDraft.warnings.map((w, idx) => (<li key={idx}>{w}</li>))}</ul>
                                </div>
                              )}

                              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <div className="space-y-2"><Label>Receipt #</Label><Input value={activeDraft.receiptNumber} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, receiptNumber: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Receipt Date *</Label><Input type="date" value={activeDraft.receiptDate} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, receiptDate: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Subtotal *</Label><Input value={activeDraft.subtotal} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, subtotal: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Tax Amount</Label><Input value={activeDraft.taxAmount} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, taxAmount: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Total</Label><Input value={activeDraft.total} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, total: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Payment Method</Label><Input value={activeDraft.paymentMethod} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, paymentMethod: e.target.value }))} placeholder="Not detected" /></div>
                              </div>

                              <div className="space-y-2"><Label>Notes</Label><Input value={activeDraft.notes} onChange={(e) => updateDraft(activeDraft.id, (en) => ({ ...en, notes: e.target.value }))} placeholder="Optional notes" /></div>

                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <Label className="text-sm font-medium">Receipt Lines</Label>
                                <Button type="button" variant="outline" size="sm" onClick={addManualImportLine}><Plus className="h-4 w-4 mr-2" />Add Line Item</Button>
                              </div>
                              <p className="text-xs text-muted-foreground -mt-2">Tip: Map fee lines (e.g. env fee) to the same item to merge them into one line on save.</p>

                              <ReceiptImportLineTable
                                parsedReceipt={activeDraft.parsedReceipt}
                                overrides={activeOverrides}
                                manualLines={activeDraft.manualLines}
                                items={items}
                                autoMatchCtx={activeAutoMatchCtx}
                                totalLineCount={activeLineStats?.total || 0}
                                onDescriptionChange={(index, value, originalDescription) => {
                                  updateDraft(activeDraft.id, (entry) => {
                                    const next = { ...entry.lineDescriptionOverrides }
                                    if (value === originalDescription) delete next[index]; else next[index] = value
                                    return { ...entry, lineDescriptionOverrides: next }
                                  })
                                }}
                                onItemChange={(index, value) => {
                                  updateDraft(activeDraft.id, (entry) => {
                                    const next = { ...entry.lineItemOverrides }
                                    if (value === "__none__") delete next[index]; else next[index] = value
                                    return { ...entry, lineItemOverrides: next }
                                  })
                                }}
                                onQtyChange={(index, value) => updateDraft(activeDraft.id, (e) => ({ ...e, lineQtyOverrides: { ...e.lineQtyOverrides, [index]: value } }))}
                                onUnitCostChange={(index, value) => updateDraft(activeDraft.id, (e) => ({ ...e, lineUnitCostOverrides: { ...e.lineUnitCostOverrides, [index]: value } }))}
                                onDeleteParsedLine={(index) => removeParsedDraftLine(activeDraft.id, index)}
                                onCreateItem={(target) => setNewItemTarget({ draftId: activeDraft.id, ...target })}
                                onManualLineChange={(lineId, updates) => updateManualImportLine(activeDraft.id, lineId, updates)}
                                onManualLineRemove={(lineId) => removeManualImportLine(activeDraft.id, lineId)}
                              />

                              <div className="text-xs text-muted-foreground space-y-1">
                                <p>
                                  Line-item subtotal: {formatCurrency((activeLineStats?.lineSubtotal || 0).toFixed(2))}
                                  {activeSubtotalDifference !== null && (<>{" "}(difference vs receipt subtotal: {formatCurrency(activeSubtotalDifference.toFixed(2))})</>)}
                                </p>
                                {activeMergePreview.collapsedLineCount > 0 && (
                                  <p>
                                    Merge preview: {activeMergePreview.mappedLineCount} mapped lines will save as {activeMergePreview.mergedLineCount} item lines.
                                    Map fee lines (env/handling) to the same item to roll fee into that item's saved unit cost.
                                  </p>
                                )}
                              </div>

                              <div className={`text-xs px-3 py-2 rounded-md ${
                                activeDraft.status === "imported" ? "text-green-700 bg-green-50"
                                  : activeHasSubtotalMismatch || !activeValidation.ready ? "text-amber-700 bg-amber-50"
                                  : "text-muted-foreground bg-muted"
                              }`}>
                                {activeDraft.status === "imported" ? activeDraft.statusMessage || "This file has already been imported." : activeValidation.message}
                              </div>

                              <div className="flex flex-wrap justify-end gap-2">
                                <Button type="button" variant="outline" onClick={() => { void parseDraft(activeDraft.id) }} disabled={isBusy}>Re-Parse Selected</Button>
                                <Button type="button" onClick={handleFinishImport} disabled={isFinishImportDisabled} title={finishImportDisabledReason || "Finish Import"}>
                                  {importingDraftId === activeDraft.id ? "Finishing Import..." : "Finish Import"}
                                </Button>
                              </div>

                              {isFinishImportDisabled && (
                                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">Finish Import is disabled: {finishImportDisabledReason}</div>
                              )}

                              {otherParsingCount > 0 && (
                                <div className="text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
                                  {otherParsingCount === 1 ? "1 other file is still parsing in the background. You can still finish this selected file."
                                    : `${otherParsingCount} other files are still parsing in the background. You can still finish this selected file.`}
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        <div className="order-1 space-y-4 2xl:order-2">
                          <div className="space-y-2">
                            <Label>Selected file</Label>
                            <div className="rounded-md border bg-muted/10 p-3 space-y-3">
                              <div className="text-sm break-all">{activeDraft.file.name}</div>
                              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                                <input type="checkbox" checked={bulkBypassCompression} onChange={(e) => setBulkBypassCompression(e.target.checked)} disabled={isBusy} />
                                Bypass compression (upload original file)
                              </label>
                              <div className="space-y-1">
                                <Label className="text-xs">OCR mode</Label>
                                <Select value={bulkOcrMode} onValueChange={(value) => setBulkOcrMode(value as ReceiptOcrMode)} disabled={isBusy}>
                                  <SelectTrigger><SelectValue placeholder="Select OCR mode" /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="auto">Auto (PaddleOCR-VL + PaddleOCR fallback)</SelectItem>
                                    <SelectItem value="classic">PaddleOCR</SelectItem>
                                    <SelectItem value="vl">PaddleOCR-VL</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <Button type="button" variant="outline" onClick={() => { void parseDraft(activeDraft.id) }} disabled={isBusy}>Parse Selected File</Button>
                            </div>
                          </div>

                          {activeDraft.status === "failed" && activeDraft.statusMessage && (
                            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{activeDraft.statusMessage}</div>
                          )}
                          {activeDraft.status === "imported" && activeDraft.statusMessage && (
                            <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{activeDraft.statusMessage}</div>
                          )}

                          <div className="space-y-2">
                            <Label>Document Preview</Label>
                            <div className="rounded-md border bg-muted/20 p-2 min-h-[24rem]">
                              {activePreviewUrl ? (
                                activeDraft.file.type.startsWith("image/") ? (
                                  <img src={activePreviewUrl} alt="Receipt preview" className="max-h-[70vh] w-auto mx-auto rounded" />
                                ) : activeDraft.file.type === "application/pdf" ? (
                                  <iframe src={activePreviewUrl} title="Receipt preview" className="w-full h-[70vh] rounded border" />
                                ) : (
                                  <div className="h-full flex items-center justify-center text-sm">
                                    <a href={activePreviewUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open preview in new tab</a>
                                  </div>
                                )
                              ) : (
                                <div className="h-full min-h-[22rem] flex items-center justify-center text-sm text-muted-foreground">Select a file to preview.</div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ItemFormDialog
        open={newItemTarget !== null}
        onOpenChange={(isOpen) => { if (!isOpen) setNewItemTarget(null) }}
        defaults={(() => {
          if (!newItemTarget) return undefined
          const targetDraft = bulkImportDrafts.find((e) => e.id === newItemTarget.draftId)
          if (!targetDraft) return undefined
          if (newItemTarget.kind === "parsed") {
            const line = targetDraft.parsedReceipt?.line_items[newItemTarget.index]
            if (!line) return undefined
            return { name: resolveImportedDescription(targetDraft.lineDescriptionOverrides, newItemTarget.index, line.description) }
          }
          const line = targetDraft.manualLines.find((e) => e.id === newItemTarget.lineId)
          if (!line) return undefined
          return { name: line.description }
        })()}
        onCreated={(newItemId) => {
          if (!newItemTarget) return
          if (newItemTarget.kind === "parsed") {
            updateDraft(newItemTarget.draftId, (e) => ({ ...e, lineItemOverrides: { ...e.lineItemOverrides, [newItemTarget.index]: newItemId } }))
          } else {
            updateManualImportLine(newItemTarget.draftId, newItemTarget.lineId, { itemId: newItemId })
          }
          setNewItemTarget(null)
        }}
      />

      <ConfirmCloseDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen} onConfirm={closeDialogNow} />
    </>
  )
}
