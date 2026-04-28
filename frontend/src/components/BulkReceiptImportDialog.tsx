import { useEffect, useId, useRef, useState } from "react"
import { importApi, type ReceiptOcrMode, type ParsedReceipt } from "@/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog"
import { ReceiptImportPanel, type ReceiptImportPanelHandle } from "@/components/ReceiptImportPanel"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2, Loader2, Trash2, AlertCircle } from "lucide-react"

type BulkDraft = {
  id: string
  file: File
  imported: boolean
  parsed: boolean
  parsing?: boolean
  parseError?: string | null
  parsedReceipt?: ParsedReceipt | null
}

type BulkReceiptImportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefillFiles?: File[]
  prefillOcrMode?: ReceiptOcrMode
  autoStartParse?: boolean
  onReceiptImported?: (receiptId: string) => void
}

export function BulkReceiptImportDialog({
  open,
  onOpenChange,
  prefillFiles = [],
  prefillOcrMode,
  autoStartParse = true,
  onReceiptImported,
}: BulkReceiptImportDialogProps) {
  const [drafts, setDrafts] = useState<BulkDraft[]>([])
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [bulkOcrMode, setBulkOcrMode] = useState<ReceiptOcrMode>(prefillOcrMode ?? "auto")
  const [bulkBypassCompression, setBulkBypassCompression] = useState(false)
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  const [panelActionInProgress, setPanelActionInProgress] = useState(false)
  const [panelImporting, setPanelImporting] = useState(false)
  const panelHandleRef = useRef<ReceiptImportPanelHandle | null>(null)
  const bulkImportInputRef = useRef<HTMLInputElement>(null)
  const bulkFileInputId = useId()

  const activeDraft = drafts.find((d) => d.id === activeDraftId) ?? null

  // ── Helpers ──

  const makeDraft = (file: File): BulkDraft => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    file,
    imported: false,
    parsed: false,
    parsing: false,
    parseError: null,
  })

  const hasActionInProgress = panelActionInProgress || drafts.length > 0

  const closeDialogNow = () => {
    setConfirmCloseOpen(false)
    onOpenChange(false)
    parsingIdsRef.current.clear()
    setDrafts([])
    setActiveDraftId(null)
    setBulkOcrMode(prefillOcrMode ?? "auto")
    setBulkBypassCompression(false)
    setPanelActionInProgress(false)
    setPanelImporting(false)
    panelHandleRef.current = null
    if (bulkImportInputRef.current) bulkImportInputRef.current.value = ""
  }

  const requestCloseDialog = () => {
    if (hasActionInProgress) { setConfirmCloseOpen(true); return }
    closeDialogNow()
  }

  // ── Prefill files ──

  useEffect(() => {
    if (!open || prefillFiles.length === 0) return
    const nextDrafts = prefillFiles.map(makeDraft)
    setDrafts(nextDrafts)
    setActiveDraftId(nextDrafts[0]?.id ?? null)
    setBulkOcrMode(prefillOcrMode ?? "auto")
  }, [open, prefillFiles, prefillOcrMode])

  // ── Keep activeDraftId valid ──

  useEffect(() => {
    if (drafts.length === 0) { setActiveDraftId(null); return }
    if (!activeDraftId || !drafts.some((d) => d.id === activeDraftId)) {
      setActiveDraftId(drafts[0].id)
    }
  }, [drafts, activeDraftId])

  // ── Background parse queue — parses ALL drafts with concurrency limit ──

  const parsingIdsRef = useRef<Set<string>>(new Set())
  const MAX_CONCURRENT_PARSES = 2

  useEffect(() => {
    if (!open) return
    const slotsAvailable = MAX_CONCURRENT_PARSES - parsingIdsRef.current.size
    if (slotsAvailable <= 0) return

    const candidates = drafts.filter(
      (d) => !d.imported && !d.parsed && !d.parsing && !d.parseError && !parsingIdsRef.current.has(d.id)
    ).slice(0, slotsAvailable)

    if (candidates.length === 0) return

    for (const candidate of candidates) {
      parsingIdsRef.current.add(candidate.id)

      setDrafts((prev) => prev.map((d) =>
        d.id === candidate.id ? { ...d, parsing: true, parseError: null } : d
      ))

      void importApi.receiptImage(candidate.file, undefined, {
        bypassCompression: bulkBypassCompression,
        ocrMode: bulkOcrMode,
      }).then((receipt) => {
        parsingIdsRef.current.delete(candidate.id)
        setDrafts((prev) => prev.map((d) =>
          d.id === candidate.id
            ? { ...d, parsing: false, parsed: true, parseError: null, parsedReceipt: receipt }
            : d
        ))
      }).catch((error) => {
        parsingIdsRef.current.delete(candidate.id)
        setDrafts((prev) => prev.map((d) =>
          d.id === candidate.id
            ? { ...d, parsing: false, parseError: error instanceof Error ? error.message : "Failed to parse receipt image" }
            : d
        ))
      })
    }
  }, [open, drafts, bulkBypassCompression, bulkOcrMode])

  // ── File input ──

  const handleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const nextDrafts = files.map(makeDraft)
    setDrafts(nextDrafts)
    setActiveDraftId(nextDrafts[0]?.id ?? null)
  }

  // ── Delete draft ──

  const deleteDraft = (draftId: string) => {
    parsingIdsRef.current.delete(draftId)
    const deletingIsActive = draftId === activeDraftId
    setDrafts((prev) => {
      const nextDrafts = prev.filter((d) => d.id !== draftId)
      // If deleting the active one, move to next unimported draft
      if (deletingIsActive && nextDrafts.length > 0) {
        const nextUnimported = nextDrafts.find((d) => !d.imported)
        if (nextUnimported) {
          setActiveDraftId(nextUnimported.id)
        } else if (nextDrafts.length > 0) {
          setActiveDraftId(nextDrafts[0].id)
        }
      }
      return nextDrafts
    })
  }

  // ── Derived ──

  const importedCount = drafts.filter((d) => d.imported).length

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => { if (nextOpen) { onOpenChange(true); return }; requestCloseDialog() }}>
        <DialogContent className="w-[96vw] max-w-[1800px]">
          <DialogHeader><DialogTitle>Bulk Import Receipts</DialogTitle></DialogHeader>

          <input id={bulkFileInputId} ref={bulkImportInputRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={handleFilesChange} />

          {drafts.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-md border border-dashed bg-muted/10 px-4 py-5 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button asChild type="button" variant="outline">
                    <label htmlFor={bulkFileInputId}>Choose Files</label>
                  </Button>
                  <span className="text-sm text-muted-foreground">Load multiple receipt files, then review each one before finishing import.</span>
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
                      <SelectItem value="auto">Auto (PaddleOCR + PaddleOCR-VL fallback)</SelectItem>
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
                  {drafts.length} file(s) loaded. {importedCount} imported.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild type="button" variant="outline">
                    <label htmlFor={bulkFileInputId}>Replace Files</label>
                  </Button>
                  <Button type="button" variant="outline" onClick={requestCloseDialog}>Close</Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                {/* Draft list sidebar */}
                <div className="border rounded-md p-2 max-h-[76vh] overflow-y-auto space-y-2">
                  {drafts.map((draft) => {
                    const isActive = draft.id === activeDraftId
                    return (
                      <div key={draft.id} className={`flex items-start gap-2 rounded-md border px-3 py-2 transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}>
                        <button type="button" onClick={() => setActiveDraftId(draft.id)} className="flex-1 text-left space-y-1 min-w-0">
                          <div className="font-medium text-sm break-all">{draft.file.name}</div>
                          {draft.imported ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                              <CheckCircle2 className="h-3 w-3" />Imported
                            </div>
                          ) : draft.parsing ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-sky-700 bg-sky-50 px-2 py-0.5 rounded-full">
                              <Loader2 className="h-3 w-3 animate-spin" />Parsing
                            </div>
                          ) : draft.parsed ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                              <CheckCircle2 className="h-3 w-3" />Parsed
                            </div>
                          ) : draft.parseError ? (
                            <div className="inline-flex items-center gap-1 text-[11px] text-red-700 bg-red-50 px-2 py-0.5 rounded-full" title={draft.parseError}>
                              <AlertCircle className="h-3 w-3" />Parse failed
                            </div>
                          ) : (
                            <div className="text-[11px] text-muted-foreground">Waiting to parse</div>
                          )}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-600"
                          title="Remove from batch"
                          onClick={() => deleteDraft(draft.id)}
                          disabled={isActive && panelImporting}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )
                  })}
                </div>

                {/* All draft panels rendered; only active one visible (preserves state) */}
                <div className="min-w-0">
                  {!activeDraft && (
                    <div className="rounded-md border bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
                      Select a file from the left to review and finish import.
                    </div>
                  )}
                  {drafts.map((draft) => {
                    const isActive = draft.id === activeDraftId
                    if (!isActive) return null
                    return (
                      <div key={draft.id}>
                        <ReceiptImportPanel
                          initialFile={draft.file}
                          initialParsedReceipt={draft.parsedReceipt}
                          externalParsing={draft.parsing}
                          ocrMode={bulkOcrMode}
                          bypassCompression={bulkBypassCompression}
                          hideFilePicker
                          showReParse
                          onParsed={(receipt) => {
                            setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, parsed: true, parsedReceipt: receipt } : d)))
                          }}
                          onImported={(receiptId) => {
                            setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, imported: true } : d)))
                            onReceiptImported?.(receiptId)
                            const nextDraft = drafts.find((d) => d.id !== draft.id && !d.imported)
                            if (nextDraft) setActiveDraftId(nextDraft.id)
                          }}
                          onActionInProgressChange={isActive ? setPanelActionInProgress : undefined}
                          onImportingChange={isActive ? setPanelImporting : undefined}
                          onHandle={isActive ? (h) => { panelHandleRef.current = h } : undefined}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmCloseDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen} onConfirm={closeDialogNow} />
    </>
  )
}
