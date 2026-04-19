import { useEffect, useRef, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatDate } from "@/lib/utils"

type BulkImportStage = "upload" | "parsing" | "review" | "creating" | "result"

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
  paymentMethod: string
  notes: string
  selected: boolean
  parseStage: ReceiptImageParseProgress["stage"] | null
  parseProgress: number | null
  result: "pending" | "success" | "failed" | "skipped"
  resultMessage: string
}

type BulkReceiptImportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefillFiles?: File[]
  autoStartParse?: boolean
}

const normalizeItemName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "")

const tokenizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)

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
  paymentMethod: "",
  notes: "",
  selected: true,
  parseStage: null,
  parseProgress: null,
  result: "pending",
  resultMessage: "",
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

export function BulkReceiptImportDialog({
  open,
  onOpenChange,
  prefillFiles = [],
  autoStartParse = false,
}: BulkReceiptImportDialogProps) {
  const queryClient = useQueryClient()
  const { data: vendors = [] } = useVendors()
  const { data: items = [] } = useItems()
  const { data: allReceipts = [] } = useReceipts()

  const [bulkImportStage, setBulkImportStage] = useState<BulkImportStage>("upload")
  const [bulkImportDrafts, setBulkImportDrafts] = useState<BulkReceiptDraft[]>([])
  const [bulkImportError, setBulkImportError] = useState("")
  const [bulkImportStatus, setBulkImportStatus] = useState("")
  const [bulkBypassCompression, setBulkBypassCompression] = useState(false)
  const [bulkOcrMode, setBulkOcrMode] = useState<ReceiptOcrMode>("auto")
  const bulkImportInputRef = useRef<HTMLInputElement>(null)
  const autoParsePendingRef = useRef(false)

  const resetBulkImportForm = () => {
    setBulkImportStage("upload")
    setBulkImportDrafts([])
    setBulkImportError("")
    setBulkImportStatus("")
    setBulkBypassCompression(false)
    setBulkOcrMode("auto")
    autoParsePendingRef.current = false
    if (bulkImportInputRef.current) {
      bulkImportInputRef.current.value = ""
    }
  }

  useEffect(() => {
    if (open) return
    autoParsePendingRef.current = false
  }, [open])

  useEffect(() => {
    if (!open || prefillFiles.length === 0) return

    setBulkImportStage("upload")
    setBulkImportDrafts(prefillFiles.map((file) => createBulkReceiptDraft(file)))
    setBulkImportError("")
    setBulkImportStatus(
      `${prefillFiles.length} file(s) selected. Parse to review extracted data.`
    )
    autoParsePendingRef.current = autoStartParse

    if (bulkImportInputRef.current) {
      bulkImportInputRef.current.value = ""
    }
  }, [open, prefillFiles, autoStartParse])

  const getAutoMatchedItemId = (description: string): string | null => {
    const descriptionNormalized = normalizeItemName(description)
    const direct = items.find((it) => normalizeItemName(it.name) === descriptionNormalized)
    if (direct) return direct.id

    const containsMatch = items.find((it) => {
      const itemNormalized = normalizeItemName(it.name)
      return (
        itemNormalized.length > 0 &&
        (descriptionNormalized.includes(itemNormalized) || itemNormalized.includes(descriptionNormalized))
      )
    })
    if (containsMatch) return containsMatch.id

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

  const resolveBulkVendorIdFromParsed = (parsed: ParsedReceipt): string => {
    const rawVendorName = parsed.vendor_name?.trim() || ""
    const suggestedVendorId = parsed.suggested_vendor_id || ""
    const matchingVendorId =
      rawVendorName &&
      vendors.find((v) => v.name.trim().toLowerCase() === rawVendorName.toLowerCase())?.id

    return (
      matchingVendorId ||
      (suggestedVendorId && vendors.some((v) => v.id === suggestedVendorId)
        ? suggestedVendorId
        : "")
    )
  }

  const resolveParsedLineUnitCost = (
    line: ParsedReceipt["line_items"][number]
  ): string | null => {
    if (line.unit_cost && line.unit_cost.trim() !== "") {
      return line.unit_cost.trim()
    }
    if (line.line_total && line.quantity > 0) {
      const total = Number.parseFloat(line.line_total)
      if (Number.isFinite(total)) {
        return (total / line.quantity).toFixed(2)
      }
    }
    return null
  }

  const getBulkLineStats = (draft: BulkReceiptDraft) => {
    if (!draft.parsedReceipt) {
      return { total: 0, unresolved: 0 }
    }

    const unresolved = draft.parsedReceipt.line_items.filter((line) => {
      const itemId = getAutoMatchedItemId(line.description)
      const unitCost = resolveParsedLineUnitCost(line)
      const unitCostNumber = unitCost ? Number.parseFloat(unitCost) : NaN
      return (
        !itemId ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(unitCostNumber) ||
        unitCostNumber <= 0
      )
    }).length

    return { total: draft.parsedReceipt.line_items.length, unresolved }
  }

  const getExistingDuplicateForBulkDraft = (draft: BulkReceiptDraft) => {
    const normalized = draft.receiptNumber.trim().toLowerCase()
    if (!normalized || !draft.vendorId) return null

    return (
      allReceipts.find(
        (r) =>
          r.vendor_id === draft.vendorId &&
          r.receipt_number.trim().toLowerCase() === normalized
      ) || null
    )
  }

  const getBulkDraftValidationMessage = (draft: BulkReceiptDraft) => {
    if (!draft.selected) {
      return { ready: false, message: "Not selected for import." }
    }
    if (draft.parseError) {
      return { ready: false, message: "Parse failed. Re-upload or deselect this file." }
    }
    if (!draft.parsedReceipt) {
      return { ready: false, message: "File has not been parsed yet." }
    }
    if (!draft.vendorId) {
      return { ready: false, message: "Vendor is required." }
    }
    if (!draft.receiptDate || draft.receiptDate === "1970-01-01") {
      return { ready: false, message: "Receipt date is required." }
    }
    if (!draft.subtotal) {
      return { ready: false, message: "Subtotal is required." }
    }

    const normalized = draft.receiptNumber.trim().toLowerCase()
    if (normalized) {
      const duplicateInBatch = bulkImportDrafts.some(
        (other) =>
          other.id !== draft.id &&
          other.selected &&
          other.vendorId === draft.vendorId &&
          other.receiptNumber.trim().toLowerCase() === normalized
      )
      if (duplicateInBatch) {
        return {
          ready: false,
          message: "Duplicate receipt number in this batch for the same vendor.",
        }
      }

      const existingDuplicate = getExistingDuplicateForBulkDraft(draft)
      if (existingDuplicate) {
        return {
          ready: false,
          message: `Receipt # ${draft.receiptNumber.trim()} already exists for ${existingDuplicate.vendor_name} (${formatDate(existingDuplicate.receipt_date)}).`,
        }
      }
    }

    const { total, unresolved } = getBulkLineStats(draft)
    if (total === 0) {
      return { ready: false, message: "No receipt lines were extracted." }
    }
    if (unresolved > 0) {
      return {
        ready: false,
        message: `${unresolved} line item(s) need item matches or valid costs.`,
      }
    }

    return { ready: true, message: `Ready to import (${total} line items).` }
  }

  const handleBulkImportFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    setBulkImportDrafts(files.map((file) => createBulkReceiptDraft(file)))
    setBulkImportStage("upload")
    setBulkImportError("")
    setBulkImportStatus(`${files.length} file(s) selected. Parse to review extracted data.`)
  }

  const handleBulkParseAll = async () => {
    if (bulkImportDrafts.length === 0) {
      setBulkImportError("Choose at least one file to parse.")
      return
    }

    setBulkImportError("")
    setBulkImportStage("parsing")
    const total = bulkImportDrafts.length
    let parsedCount = 0
    let failedCount = 0

    for (let index = 0; index < total; index += 1) {
      const draft = bulkImportDrafts[index]
      setBulkImportStatus(`Parsing ${index + 1}/${total}: ${draft.file.name}`)

      setBulkImportDrafts((prev) =>
        prev.map((entry) =>
          entry.id === draft.id
            ? {
                ...entry,
                parseError: null,
                parsedReceipt: null,
                warnings: [],
                parseStage: "uploading",
                parseProgress: 0,
                result: "pending",
                resultMessage: "",
              }
            : entry
        )
      )

      try {
        const parsed = await importApi.receiptImage(draft.file, ({ stage, progress }) => {
          setBulkImportDrafts((prev) =>
            prev.map((entry) =>
              entry.id === draft.id
                ? {
                    ...entry,
                    parseStage: stage,
                    parseProgress: progress ?? null,
                  }
                : entry
            )
          )
        }, { bypassCompression: bulkBypassCompression, ocrMode: bulkOcrMode })

        const taxFromPayload = parsed.tax || ""
        let inferredTax = ""
        if (!taxFromPayload && parsed.total && parsed.subtotal) {
          const totalNumber = Number.parseFloat(parsed.total)
          const subtotalNumber = Number.parseFloat(parsed.subtotal)
          if (Number.isFinite(totalNumber) && Number.isFinite(subtotalNumber)) {
            inferredTax = (totalNumber - subtotalNumber).toFixed(2)
          }
        }

        setBulkImportDrafts((prev) =>
          prev.map((entry) =>
            entry.id === draft.id
              ? {
                  ...entry,
                  parsedReceipt: parsed,
                  parseError: null,
                  warnings: parsed.warnings || [],
                  vendorLabel: parsed.vendor_name?.trim() || "",
                  vendorId: resolveBulkVendorIdFromParsed(parsed),
                  receiptNumber: parsed.receipt_number || "",
                  receiptDate: parsed.receipt_date || "1970-01-01",
                  subtotal: parsed.subtotal || "",
                  taxAmount: taxFromPayload || inferredTax,
                  paymentMethod: parsed.payment_method || "",
                  notes: "",
                  parseStage: null,
                  parseProgress: null,
                }
              : entry
          )
        )

        parsedCount += 1
      } catch (err) {
        failedCount += 1
        const message = err instanceof Error ? err.message : "Failed to parse receipt image"
        setBulkImportDrafts((prev) =>
          prev.map((entry) =>
            entry.id === draft.id
              ? {
                  ...entry,
                  parsedReceipt: null,
                  parseError: message,
                  warnings: [],
                  parseStage: null,
                  parseProgress: null,
                  result: "failed",
                  resultMessage: message,
                }
              : entry
          )
        )
      }
    }

    setBulkImportStage("review")
    setBulkImportStatus(
      `Parsed ${parsedCount}/${total} files${failedCount > 0 ? ` (${failedCount} failed)` : ""}. Review and create.`
    )
  }

  const handleBulkCreateAll = async () => {
    const selectedDrafts = bulkImportDrafts.filter((draft) => draft.selected)
    if (selectedDrafts.length === 0) {
      setBulkImportError("Select at least one parsed file to import.")
      return
    }

    setBulkImportError("")
    setBulkImportStage("creating")
    setBulkImportDrafts((prev) =>
      prev.map((draft) =>
        draft.selected
          ? { ...draft, result: "pending", resultMessage: "" }
          : { ...draft, result: "skipped", resultMessage: "Not selected." }
      )
    )

    const total = selectedDrafts.length
    const skippedCount = bulkImportDrafts.length - total
    let successCount = 0
    let failedCount = 0

    for (let index = 0; index < selectedDrafts.length; index += 1) {
      const draft = selectedDrafts[index]
      setBulkImportStatus(`Creating ${index + 1}/${total}: ${draft.file.name}`)

      let createdReceiptId: string | null = null

      try {
        const validation = getBulkDraftValidationMessage(draft)
        if (!validation.ready) {
          throw new Error(validation.message)
        }

        if (!draft.parsedReceipt) {
          throw new Error("Parsed receipt data is missing.")
        }

        const parsed = draft.parsedReceipt

        const created = await receiptsApi.create({
          vendor_id: draft.vendorId,
          source_vendor_alias: parsed.vendor_name?.trim() || undefined,
          ...(draft.receiptNumber.trim() ? { receipt_number: draft.receiptNumber.trim() } : {}),
          receipt_date: draft.receiptDate,
          subtotal: draft.subtotal,
          tax_amount: draft.taxAmount || undefined,
          payment_method: draft.paymentMethod || undefined,
          ingestion_metadata: {
            source: "ocr",
            auto_parsed: true,
            parse_engine: parsed.parse_engine || "unknown",
            ...(parsed.parse_version ? { parse_version: parsed.parse_version } : {}),
            ...(typeof parsed.confidence_score === "number"
              ? { confidence_score: parsed.confidence_score }
              : {}),
            ...(parsed.vendor_name?.trim()
              ? { raw_vendor_name: parsed.vendor_name.trim() }
              : {}),
            ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
            ingested_at: new Date().toISOString(),
            ingestion_version: "ocr-v1",
          },
          notes: draft.notes || undefined,
        })
        createdReceiptId = created.id

        for (let lineIndex = 0; lineIndex < parsed.line_items.length; lineIndex += 1) {
          const line = parsed.line_items[lineIndex]
          const itemId = getAutoMatchedItemId(line.description)
          const qty = line.quantity
          const unitCost = resolveParsedLineUnitCost(line)

          if (!itemId) {
            throw new Error(`Line ${lineIndex + 1} is not mapped to an item`)
          }
          if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error(`Line ${lineIndex + 1} has invalid quantity`)
          }
          if (!unitCost || Number.parseFloat(unitCost) <= 0) {
            throw new Error(`Line ${lineIndex + 1} has invalid unit cost`)
          }

          await receiptsApi.lineItems.create(createdReceiptId, {
            item_id: itemId,
            quantity: qty,
            unit_cost: unitCost,
            notes: line.description,
          })
        }

        await receiptsApi.uploadPdf(createdReceiptId, draft.file, {
          bypassCompression: bulkBypassCompression,
        })

        successCount += 1
        setBulkImportDrafts((prev) =>
          prev.map((entry) =>
            entry.id === draft.id
              ? {
                  ...entry,
                  result: "success",
                  resultMessage: `Imported as ${createdReceiptId}.`,
                }
              : entry
          )
        )
      } catch (err) {
        failedCount += 1
        const baseMessage = err instanceof Error ? err.message : "Failed to import receipt"
        const message = createdReceiptId
          ? `${baseMessage}. Receipt was created (${createdReceiptId}) but import did not fully complete.`
          : baseMessage

        setBulkImportDrafts((prev) =>
          prev.map((entry) =>
            entry.id === draft.id
              ? {
                  ...entry,
                  result: "failed",
                  resultMessage: message,
                }
              : entry
          )
        )
      }
    }

    if (successCount > 0) {
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
    }

    setBulkImportStage("result")
    setBulkImportStatus(
      `Created ${successCount} receipt(s); ${failedCount} failed; ${skippedCount} skipped.`
    )
  }

  useEffect(() => {
    if (!open || !autoParsePendingRef.current) return
    if (bulkImportStage !== "upload") return
    if (bulkImportDrafts.length === 0) return

    autoParsePendingRef.current = false
    void handleBulkParseAll()
  }, [open, bulkImportDrafts, bulkImportStage])

  const readySelectedCount = bulkImportDrafts.filter(
    (draft) => draft.selected && getBulkDraftValidationMessage(draft).ready
  ).length

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen)
        if (!nextOpen) resetBulkImportForm()
      }}
    >
      <DialogContent className="w-[96vw] max-w-[1500px]">
        <DialogHeader>
          <DialogTitle>Import Receipts (OCR)</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {bulkImportError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {bulkImportError}
            </div>
          )}

          {bulkImportStatus && (
            <div className="text-xs text-muted-foreground">{bulkImportStatus}</div>
          )}

          {bulkImportStage === "upload" && (
            <div className="space-y-4">
              <div className="rounded-md border border-dashed bg-muted/10 px-4 py-5 space-y-3">
                <input
                  ref={bulkImportInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                  onChange={handleBulkImportFilesChange}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => bulkImportInputRef.current?.click()}
                  >
                    Choose Files
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Select multiple receipt PDFs/images. Each file will run through OCR parse before create.
                  </span>
                </div>

                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={bulkBypassCompression}
                    onChange={(e) => setBulkBypassCompression(e.target.checked)}
                  />
                  Bypass compression (upload original files)
                </label>

                <div className="space-y-1 max-w-sm">
                  <Label className="text-xs">OCR mode</Label>
                  <Select
                    value={bulkOcrMode}
                    onValueChange={(value) => setBulkOcrMode(value as ReceiptOcrMode)}
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

              {bulkImportDrafts.length > 0 && (
                <div className="border rounded-md max-h-56 overflow-y-auto divide-y">
                  {bulkImportDrafts.map((draft) => (
                    <div key={draft.id} className="px-3 py-2 text-sm">
                      {draft.file.name}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleBulkParseAll}
                  disabled={bulkImportDrafts.length === 0}
                >
                  Parse {bulkImportDrafts.length || ""} File{bulkImportDrafts.length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}

          {(bulkImportStage === "parsing" ||
            bulkImportStage === "review" ||
            bulkImportStage === "creating" ||
            bulkImportStage === "result") && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                {bulkImportDrafts.length} file(s) in batch. {bulkImportDrafts.filter((d) => d.parsedReceipt).length} parsed.
              </div>

              <div className="max-h-[62vh] overflow-y-auto space-y-3 pr-1">
                {bulkImportDrafts.map((draft) => {
                  const lineStats = getBulkLineStats(draft)
                  const validation = getBulkDraftValidationMessage(draft)
                  const controlsDisabled =
                    bulkImportStage === "creating" || bulkImportStage === "result"

                  return (
                    <div key={draft.id} className="border rounded-md p-3 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium break-all">{draft.file.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {draft.parseError
                              ? "Parse failed"
                              : draft.parsedReceipt
                                ? "Parsed"
                                : draft.parseStage === "uploading"
                                  ? `Uploading${typeof draft.parseProgress === "number" ? ` ${draft.parseProgress}%` : "..."}`
                                  : draft.parseStage === "processing"
                                    ? "Parsing..."
                                    : "Pending"}
                          </div>
                            {draft.parsedReceipt && (
                              <div className="text-xs text-sky-700 mt-1">
                                Final engine: {getOcrEngineDisplayName(draft.parsedReceipt.parse_engine)}
                                {typeof draft.parsedReceipt.confidence_score === "number"
                                  ? ` (score ${draft.parsedReceipt.confidence_score.toFixed(2)})`
                                  : ""}
                              </div>
                            )}
                        </div>

                        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={draft.selected}
                            disabled={controlsDisabled}
                            onChange={(e) => {
                              const checked = e.target.checked
                              setBulkImportDrafts((prev) =>
                                prev.map((entry) =>
                                  entry.id === draft.id
                                    ? { ...entry, selected: checked }
                                    : entry
                                )
                              )
                            }}
                          />
                          Import this file
                        </label>
                      </div>

                      {draft.parseError && (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                          {draft.parseError}
                        </div>
                      )}

                      {draft.parsedReceipt && (
                        <>
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Vendor *</Label>
                              <Select
                                value={draft.vendorId || "__none__"}
                                onValueChange={(value) => {
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? {
                                            ...entry,
                                            vendorId: value === "__none__" ? "" : value,
                                          }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select vendor" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">Unmapped</SelectItem>
                                  {vendors.map((vendor) => (
                                    <SelectItem key={vendor.id} value={vendor.id}>
                                      {vendor.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-[11px] text-muted-foreground truncate">
                                OCR label: {draft.vendorLabel || "-"}
                              </p>
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Receipt #</Label>
                              <Input
                                value={draft.receiptNumber}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, receiptNumber: value }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Receipt Date *</Label>
                              <Input
                                type="date"
                                value={draft.receiptDate}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, receiptDate: value }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Subtotal *</Label>
                              <Input
                                value={draft.subtotal}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, subtotal: value }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Tax Amount</Label>
                              <Input
                                value={draft.taxAmount}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, taxAmount: value }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Payment Method</Label>
                              <Input
                                value={draft.paymentMethod}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, paymentMethod: value }
                                        : entry
                                    )
                                  )
                                }}
                                disabled={controlsDisabled}
                              />
                            </div>

                            <div className="space-y-1 md:col-span-3">
                              <Label className="text-xs">Notes</Label>
                              <Input
                                value={draft.notes}
                                onChange={(e) => {
                                  const value = e.target.value
                                  setBulkImportDrafts((prev) =>
                                    prev.map((entry) =>
                                      entry.id === draft.id
                                        ? { ...entry, notes: value }
                                        : entry
                                    )
                                  )
                                }}
                                placeholder="Optional notes"
                                disabled={controlsDisabled}
                              />
                            </div>
                          </div>

                          {draft.warnings.length > 0 && (
                            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                              <div className="font-medium mb-1">
                                OCR warnings (final engine: {getOcrEngineDisplayName(draft.parsedReceipt?.parse_engine)})
                              </div>
                              {draft.warnings.join(" | ")}
                            </div>
                          )}

                          <div
                            className={`text-xs px-2 py-1 rounded-md ${
                              validation.ready
                                ? "text-green-700 bg-green-50"
                                : "text-amber-700 bg-amber-50"
                            }`}
                          >
                            Parsed lines: {lineStats.total}. Ready lines: {lineStats.total - lineStats.unresolved}. {validation.message}
                          </div>
                        </>
                      )}

                      {bulkImportStage === "result" && (
                        <div
                          className={`text-xs px-2 py-1 rounded-md ${
                            draft.result === "success"
                              ? "text-green-700 bg-green-50"
                              : draft.result === "failed"
                                ? "text-red-700 bg-red-50"
                                : "text-muted-foreground bg-muted"
                          }`}
                        >
                          {draft.result === "success"
                            ? "Imported"
                            : draft.result === "failed"
                              ? "Failed"
                              : draft.result === "skipped"
                                ? "Skipped"
                                : "Pending"}
                          {draft.resultMessage ? `: ${draft.resultMessage}` : ""}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {(bulkImportStage === "review" || bulkImportStage === "creating") && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBulkImportStage("upload")}
                    disabled={bulkImportStage === "creating"}
                  >
                    Choose Different Files
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                      disabled={bulkImportStage === "creating"}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={handleBulkCreateAll}
                      disabled={bulkImportStage === "creating" || readySelectedCount === 0}
                    >
                      {bulkImportStage === "creating"
                        ? "Creating..."
                        : `Create ${readySelectedCount} Receipt${readySelectedCount === 1 ? "" : "s"}`}
                    </Button>
                  </div>
                </div>
              )}

              {bulkImportStage === "result" && (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetBulkImportForm}
                  >
                    Import More
                  </Button>
                  <Button type="button" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
