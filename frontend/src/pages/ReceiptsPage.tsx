import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useReceipts,
  useCreateReceipt,
  useUpdateReceipt,
  useDeleteReceipt,
  useVendors,
  usePurchases,
} from "@/hooks/useApi"
import {
  type ReceiptOcrMode,
  receipts as receiptsApi,
} from "@/api"
import { Button } from "@/components/ui/button"
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
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog"
import { ReceiptForm, type ReceiptFormSubmitData } from "@/components/ReceiptForm"
import { ReceiptImportPanel, type ReceiptImportPanelHandle } from "@/components/ReceiptImportPanel"
import { Plus, Trash2, Pencil, FileText, Upload, CheckCircle2, AlertCircle, Search } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  getReceiptItemsDisplayCount,
  getReceiptReconciliationBadgeState,
  getStoredExpectedTaxRate,
} from "@/lib/receiptSummary"

type Receipt = ReturnType<typeof useReceipts>["data"] extends (infer T)[] | undefined ? T : never

function ReconciliationBadgeInner({ receipt, expectedTaxRate }: { receipt: Receipt; expectedTaxRate: number }) {
  const badgeState = getReceiptReconciliationBadgeState(receipt, expectedTaxRate)

  if (badgeState.kind === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 px-2 py-1 rounded-full" title={badgeState.detail}>
        <AlertCircle className="h-3 w-3" />
        {badgeState.label}{badgeState.detail ? ` · ${badgeState.detail}` : ""}
      </span>
    )
  }

  if (badgeState.kind === "warning") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 bg-orange-50 px-2 py-1 rounded-full" title={badgeState.detail}>
        <AlertCircle className="h-3 w-3" />
        {badgeState.label}{badgeState.detail ? ` · ${badgeState.detail}` : ""}
      </span>
    )
  }

  if (badgeState.kind === "reconciled") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded-full">
        <CheckCircle2 className="h-3 w-3" />
        {badgeState.label}
      </span>
    )
  }

  // nominal
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 bg-slate-100 px-2 py-1 rounded-full">
      <CheckCircle2 className="h-3 w-3" />
      {badgeState.label}
    </span>
  )
}

const ReconciliationBadge = memo(ReconciliationBadgeInner)

export default function ReceiptsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { data: allReceipts = [], isLoading } = useReceipts()
  const { data: vendors = [] } = useVendors()
  const { data: allPurchases = [] } = usePurchases()

  // Build receipt → item names lookup for search
  const receiptItemNames = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const p of allPurchases) {
      if (!p.receipt_id) continue
      let set = map.get(p.receipt_id)
      if (!set) { set = new Set(); map.set(p.receipt_id, set) }
      set.add(p.item_name.toLowerCase())
    }
    return map
  }, [allPurchases])

  const createReceipt = useCreateReceipt()
  const updateReceipt = useUpdateReceipt()
  const deleteReceipt = useDeleteReceipt()

  const [isOpen, setIsOpen] = useState(false)
  const [isReceiptFormDirty, setIsReceiptFormDirty] = useState(false)
  const [confirmReceiptCloseOpen, setConfirmReceiptCloseOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [vendorFilter, setVendorFilter] = useState<string>("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [searchQuery, setSearchQuery] = useState("")
  const expectedTaxRate = getStoredExpectedTaxRate()

  const [isImportOpen, setIsImportOpen] = useState(false)
  const [confirmImportCloseOpen, setConfirmImportCloseOpen] = useState(false)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [bulkImportPrefillFiles, setBulkImportPrefillFiles] = useState<File[]>([])
  const [bulkImportPrefillOcrMode, setBulkImportPrefillOcrMode] = useState<ReceiptOcrMode | null>(null)
  const [bulkImportAutoStart, setBulkImportAutoStart] = useState(false)
  const [importActionInProgress, setImportActionInProgress] = useState(false)
  const importPanelHandleRef = useRef<ReceiptImportPanelHandle | null>(null)

  useEffect(() => {
    const shouldOpenOcrImport = searchParams.get("import") === "1"
    if (!shouldOpenOcrImport) return
    setIsImportOpen(true)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete("import")
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const filteredReceipts = useMemo(() => {
    let result = allReceipts
    if (vendorFilter) {
      result = result.filter((r) => r.vendor_id === vendorFilter)
    }
    if (statusFilter) {
      result = result.filter((r) => getReceiptReconciliationBadgeState(r, expectedTaxRate).kind === statusFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter((r) => {
        if (
          r.receipt_number.toLowerCase().includes(q) ||
          r.vendor_name.toLowerCase().includes(q) ||
          (r.notes && r.notes.toLowerCase().includes(q)) ||
          (r.payment_method && r.payment_method.toLowerCase().includes(q))
        ) return true
        // Search within linked purchase item names
        const names = receiptItemNames.get(r.id)
        if (names) {
          for (const name of names) {
            if (name.includes(q)) return true
          }
        }
        return false
      })
    }
    return result
  }, [allReceipts, vendorFilter, statusFilter, searchQuery, expectedTaxRate, receiptItemNames])

  const resetForm = () => {
    setEditingId(null)
    setIsReceiptFormDirty(false)
  }

  const closeImportDialogNow = () => {
    setConfirmImportCloseOpen(false)
    setIsImportOpen(false)
    importPanelHandleRef.current?.reset()
  }

  const requestImportDialogClose = () => {
    if (importActionInProgress) {
      setConfirmImportCloseOpen(true)
      return
    }
    closeImportDialogNow()
  }

  const hasReceiptActionInProgress = createReceipt.isPending || updateReceipt.isPending || isReceiptFormDirty

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

  const handleSubmit = async (data: ReceiptFormSubmitData) => {
    let receiptId = editingId
    if (editingId) {
      await updateReceipt.mutateAsync({
        id: editingId, vendor_id: data.vendor_id, receipt_number: data.receipt_number,
        receipt_date: data.receipt_date, subtotal: data.subtotal, tax_amount: data.tax_amount,
        payment_method: data.payment_method.trim() || undefined, notes: data.notes || undefined,
      })
    } else {
      const created = await createReceipt.mutateAsync({
        vendor_id: data.vendor_id,
        ...(data.receipt_number.trim() ? { receipt_number: data.receipt_number.trim() } : {}),
        receipt_date: data.receipt_date, subtotal: data.subtotal, tax_amount: data.tax_amount,
        payment_method: data.payment_method.trim() || undefined, notes: data.notes || undefined,
      })
      receiptId = created.id
    }
    if (data.document_file && receiptId) {
      await receiptsApi.uploadPdf(receiptId, data.document_file)
    }
    closeReceiptDialogNow()
  }

  const handleEdit = (r: (typeof allReceipts)[0]) => { setEditingId(r.id); setIsOpen(true) }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this receipt?")) { await deleteReceipt.mutateAsync(id) }
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

  const editingReceipt = editingId ? allReceipts.find((r) => r.id === editingId) || null : null

  const { totalReceipts, totalSpent, errorCount, warningCount, reconciledCount } = useMemo(() => {
    let spent = 0
    let errors = 0
    let warnings = 0
    let reconciledCount = 0
    for (const r of filteredReceipts) {
      spent += parseFloat(r.total || "0")
      const badgeState = getReceiptReconciliationBadgeState(r, expectedTaxRate)
      if (badgeState.kind === "error") errors++
      else if (badgeState.kind === "warning") warnings++
      else if (badgeState.kind === "reconciled") reconciledCount++
    }
    return { totalReceipts: filteredReceipts.length, totalSpent: spent, errorCount: errors, warningCount: warnings, reconciledCount }
  }, [filteredReceipts, expectedTaxRate])

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
              { header: "Tax Amount", accessor: (r) => r.tax_amount },
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
            onOpenChange={(open) => { if (open) { setIsImportOpen(true); return }; requestImportDialogClose() }}
          >
            <DialogTrigger asChild>
              <Button variant="outline"><Upload className="h-4 w-4 mr-2" />Import Receipt</Button>
            </DialogTrigger>
            <DialogContent className="w-[96vw] max-w-[1700px]">
              <DialogHeader><DialogTitle>Import Receipt Image / PDF</DialogTitle></DialogHeader>
              <ReceiptImportPanel
                onImported={closeImportDialogNow}
                onActionInProgressChange={setImportActionInProgress}
                onHandle={(h) => { importPanelHandleRef.current = h }}
                onMultipleFilesSelected={(files) => {
                  closeImportDialogNow()
                  setBulkImportPrefillFiles(files)
                  setBulkImportPrefillOcrMode(null)
                  setBulkImportAutoStart(true)
                  setBulkImportOpen(true)
                }}
                extraButtons={
                  <Button variant="outline" onClick={requestImportDialogClose}>Cancel</Button>
                }
              />
            </DialogContent>
          </Dialog>
          <ConfirmCloseDialog open={confirmImportCloseOpen} onOpenChange={setConfirmImportCloseOpen} onConfirm={closeImportDialogNow} />
          <Button variant="outline" onClick={() => { setBulkImportPrefillFiles([]); setBulkImportPrefillOcrMode(null); setBulkImportAutoStart(false); setBulkImportOpen(true) }}>
            <Upload className="h-4 w-4 mr-2" />Bulk Import Receipts
          </Button>
          <BulkReceiptImportDialog
            open={bulkImportOpen}
            onOpenChange={(open) => { setBulkImportOpen(open); if (!open) { setBulkImportPrefillFiles([]); setBulkImportPrefillOcrMode(null); setBulkImportAutoStart(false) } }}
            prefillFiles={bulkImportPrefillFiles}
            prefillOcrMode={bulkImportPrefillOcrMode ?? undefined}
            autoStartParse={bulkImportAutoStart}
          />
          <Dialog open={isOpen} onOpenChange={(open) => { if (open) { setIsOpen(true); return }; requestReceiptDialogClose() }}>
            <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />Add Receipt</Button></DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>{editingId ? "Edit Receipt" : "Add Receipt"}</DialogTitle></DialogHeader>
              <ReceiptForm
                open={isOpen}
                vendors={vendors}
                initialValues={editingReceipt ? {
                  vendor_id: editingReceipt.vendor_id, receipt_number: editingReceipt.receipt_number,
                  receipt_date: editingReceipt.receipt_date, subtotal: editingReceipt.subtotal,
                  tax_amount: editingReceipt.tax_amount,
                  payment_method: editingReceipt.payment_method || "", notes: editingReceipt.notes || "",
                } : undefined}
                requireDocument={!editingId}
                submitLabel={editingId ? "Save Changes" : "Create"}
                submittingLabel={editingId ? "Saving..." : "Creating..."}
                isSubmitting={createReceipt.isPending || updateReceipt.isPending}
                onSubmit={handleSubmit}
                onCancel={requestReceiptDialogClose}
                onImport={!editingId ? () => { closeReceiptDialogNow(); setIsImportOpen(true) } : undefined}
                importButtonLabel="Import Receipt"
                onDirtyChange={setIsReceiptFormDirty}
              />
            </DialogContent>
          </Dialog>
          <ConfirmCloseDialog open={confirmReceiptCloseOpen} onOpenChange={setConfirmReceiptCloseOpen} onConfirm={closeReceiptDialogNow} />
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card><CardContent className="pt-6"><div className="text-2xl font-bold">{totalReceipts}</div><p className="text-sm text-muted-foreground">Total Receipts</p></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="text-2xl font-bold">{formatCurrency(totalSpent.toFixed(2))}</div><p className="text-sm text-muted-foreground">Total Spent (incl. tax)</p></CardContent></Card>
        <Card><CardContent className="pt-6"><div className={`text-2xl font-bold ${reconciledCount === totalReceipts ? "text-green-600" : "text-slate-600"}`}>{reconciledCount}</div><p className="text-sm text-muted-foreground">Reconciled</p></CardContent></Card>
        <Card><CardContent className="pt-6"><div className={`text-2xl font-bold ${warningCount > 0 ? "text-orange-600" : "text-green-600"}`}>{warningCount}</div><p className="text-sm text-muted-foreground">Warnings</p></CardContent></Card>
        <Card><CardContent className="pt-6"><div className={`text-2xl font-bold ${errorCount > 0 ? "text-red-600" : "text-green-600"}`}>{errorCount}</div><p className="text-sm text-muted-foreground">Errors</p></CardContent></Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="flex-1 min-w-[200px]">
              <Label className="mb-2 block">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  placeholder="Search receipts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </div>
            <div className="w-48">
              <Label className="mb-2 block">Vendor</Label>
              <Select value={vendorFilter || "all"} onValueChange={(v) => setVendorFilter(v === "all" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="All vendors" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All vendors</SelectItem>
                  {vendors.map((v) => (<SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-48">
              <Label className="mb-2 block">Status</Label>
              <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="reconciled">Reconciled</SelectItem>
                  <SelectItem value="nominal">Nominal</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Receipts ({filteredReceipts.length})</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Receipt #</TableHead><TableHead>Vendor</TableHead>
                <TableHead>Source</TableHead><TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">Tax</TableHead><TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Items</TableHead><TableHead>Status</TableHead>
                <TableHead>PDF</TableHead><TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReceipts.map((r) => {
                const source = r.ingestion_metadata?.source || "manual"
                const isAutoParsed = r.ingestion_metadata?.auto_parsed === true
                return (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/receipts/${r.id}`)}>
                    <TableCell>{formatDate(r.receipt_date)}</TableCell>
                    <TableCell className="font-mono font-medium">{r.receipt_number}</TableCell>
                    <TableCell>{r.vendor_name}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${source === "ocr" ? "bg-blue-50 text-blue-700" : source === "csv" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-700"}`}>
                        {source}{isAutoParsed ? " • auto" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(r.subtotal)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(r.tax_amount)}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(r.total)}</TableCell>
                    <TableCell className="text-right">{getReceiptItemsDisplayCount(r)}</TableCell>
                    <TableCell><ReconciliationBadge receipt={r} expectedTaxRate={expectedTaxRate} /></TableCell>
                    <TableCell>
                      {r.has_pdf ? (<FileText className="h-4 w-4 text-blue-600" />) : (
                        <button onClick={(e) => { e.stopPropagation(); handleUploadPdf(r.id) }} className="text-muted-foreground hover:text-foreground"><Upload className="h-4 w-4" /></button>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); handleEdit(r) }}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" className="text-red-600" onClick={(e) => { e.stopPropagation(); handleDelete(r.id) }}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredReceipts.length === 0 && (<EmptyTableRow colSpan={11} message="No receipts yet" />)}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
