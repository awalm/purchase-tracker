import { useEffect, useState, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useInvoices, useCreateInvoice, useUpdateInvoice, useDeleteInvoice, useDestinations, useItems } from "@/hooks/useApi"
import { useMultiSelect } from "@/hooks/useMultiSelect"
import { ApiValidationError, importApi, invoices as invoicesApi, type InvoicePdfCommitErrorResponse, type InvoicePdfLineFailure, type ParsedInvoice } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { BulkReceiptImportDialog } from "@/components/BulkReceiptImportDialog"
import { consumePendingBulkReceiptFiles } from "@/lib/bulkReceiptImportTransfer"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { RowActions } from "@/components/RowActions"
import { EmptyTableRow } from "@/components/EmptyTableRow"
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
import { Plus, Trash2, CheckCircle2, AlertCircle, Clock, Upload, FileText, FileDown, Loader2 } from "lucide-react"
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils"

interface Invoice {
  id: string
  destination_id: string
  destination_code: string
  destination_name: string
  invoice_number: string
  order_number: string | null
  invoice_date: string
  subtotal: string
  tax_rate: string
  total: string
  reconciliation_state: string
  has_pdf: boolean | null
  notes: string | null
  purchase_count: number | null
  purchases_total: string | null
  receipted_count: number | null
}

function ReconciliationBadge({ invoice }: { invoice: Invoice }) {
  const isFinalized = invoice.reconciliation_state === "locked"
  const isReopened = invoice.reconciliation_state === "reopened"
  const invoiceSubtotal = parseFloat(invoice.subtotal)
  const purchasesTotal = parseFloat(invoice.purchases_total || "0")
  const difference = Math.abs(invoiceSubtotal - purchasesTotal)
  const count = invoice.purchase_count || 0
  const receiptedCount = invoice.receipted_count || 0
  const allReceipted = count > 0 && receiptedCount === count
  const totalsMatched = difference < 0.01

  if (isFinalized) {
    if (count > 0 && totalsMatched && allReceipted) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-1 rounded-full">
          <CheckCircle2 className="h-3 w-3" />
          Finalized
        </span>
      )
    }

    const finalizedIssues: string[] = []
    if (count === 0) finalizedIssues.push("No items")
    if (!totalsMatched) finalizedIssues.push(`${formatCurrency(difference)} off`)
    if (count > 0 && !allReceipted) finalizedIssues.push(`${receiptedCount}/${count} receipted`)

    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-1 rounded-full">
        <AlertCircle className="h-3 w-3" />
        Finalized · {finalizedIssues.join(" · ")}
      </span>
    )
  }

  if (isReopened) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 bg-orange-50 px-2 py-1 rounded-full">
        <AlertCircle className="h-3 w-3" />
        Reopened
      </span>
    )
  }

  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
        <Clock className="h-3 w-3" />
        No items
      </span>
    )
  }

  if (totalsMatched && allReceipted) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full">
        <CheckCircle2 className="h-3 w-3" />
        Ready to finalize
      </span>
    )
  }

  // Show what's missing
  const issues: string[] = []
  if (!totalsMatched) issues.push(`${formatCurrency(difference)} off`)
  if (!allReceipted) issues.push(`${receiptedCount}/${count} receipted`)

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
      <AlertCircle className="h-3 w-3" />
      {issues.join(" · ")}
    </span>
  )
}

export default function InvoicesPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { data: invoices = [], isLoading } = useInvoices()
  const { data: destinations = [] } = useDestinations()
  const createInvoice = useCreateInvoice()
  const updateInvoice = useUpdateInvoice()
  const deleteInvoice = useDeleteInvoice()
  const { data: activeItems = [] } = useItems()

  // Form state
  const [isOpen, setIsOpen] = useState(false)
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null)
  const [destinationId, setDestinationId] = useState("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [orderNumber, setOrderNumber] = useState("")
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split("T")[0])
  const [subtotal, setSubtotal] = useState("")
  const [notes, setNotes] = useState("")

  // Multi-select state
  const { selectedIds, isDeleting, toggleSelect, toggleSelectAll, handleBulkDelete, allSelected } = useMultiSelect(invoices)

  // PDF upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false)
  const [pdfParsing, setPdfParsing] = useState(false)
  const [parsedInvoice, setParsedInvoice] = useState<ParsedInvoice | null>(null)
  const [pdfDestinationId, setPdfDestinationId] = useState("")
  const [pdfError, setPdfError] = useState("")
  const [pdfLineFailures, setPdfLineFailures] = useState<InvoicePdfLineFailure[]>([])
  // Per-line-item overrides: index → item_id (for unmatched items the user manually maps)
  const [lineItemOverrides, setLineItemOverrides] = useState<Record<number, string>>({})
  // "Create New Item" dialog state: which line item index is being created
  const [newItemForLineIdx, setNewItemForLineIdx] = useState<number | null>(null)

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfFile(file)
    setPdfParsing(true)
    setPdfError("")
    setPdfLineFailures([])
    setParsedInvoice(null)
    setLineItemOverrides({})
    setNewItemForLineIdx(null)
    try {
      const result = await importApi.invoicePdf(file)
      setParsedInvoice(result)
      // Default destination to BSC if available
      const bsc = destinations.find(d => d.code.toUpperCase() === "BSC")
      if (bsc) setPdfDestinationId(bsc.id)
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Failed to parse PDF")
    } finally {
      setPdfParsing(false)
    }
  }

  // Resolve item for a line item: override → name match → null
  const resolveItem = (li: ParsedInvoice["line_items"][0], idx: number) => {
    const overrideId = lineItemOverrides[idx]
    if (overrideId) return activeItems.find(ai => ai.id === overrideId) ?? null
    return activeItems.find(ai => ai.name.toLowerCase() === li.description.toLowerCase()) ?? null
  }

  // Compute select value for a line item dropdown
  const getLineItemSelectValue = (li: ParsedInvoice["line_items"][0], idx: number): string => {
    const overrideId = lineItemOverrides[idx]
    if (overrideId) return overrideId
    const autoMatch = activeItems.find(ai => ai.name.toLowerCase() === li.description.toLowerCase())
    return autoMatch ? autoMatch.id : "__none__"
  }

  const unresolvedLineCount = parsedInvoice
    ? parsedInvoice.line_items.filter((li, idx) => resolveItem(li, idx) === null).length
    : 0

  const lineFailureByIndex = pdfLineFailures.reduce<Record<number, InvoicePdfLineFailure[]>>((acc, failure) => {
    if (!acc[failure.line_index]) acc[failure.line_index] = []
    acc[failure.line_index].push(failure)
    return acc
  }, {})

  const [pdfCreating, setPdfCreating] = useState(false)
  const [pdfCreateStatus, setPdfCreateStatus] = useState("")
  const [bulkReceiptImportOpen, setBulkReceiptImportOpen] = useState(false)
  const [bulkReceiptImportPrefillFiles, setBulkReceiptImportPrefillFiles] = useState<File[]>([])

  // Bulk backup modal + import state
  const bulkImportInputRef = useRef<HTMLInputElement>(null)
  const [bulkBackupDialogOpen, setBulkBackupDialogOpen] = useState(false)
  const [includeUnfinalizedInvoices, setIncludeUnfinalizedInvoices] = useState(false)
  const [includeBackupDocuments, setIncludeBackupDocuments] = useState(true)
  const [bulkBackupFromDate, setBulkBackupFromDate] = useState("")
  const [bulkBackupToDate, setBulkBackupToDate] = useState("")
  const [isExportingAllBackups, setIsExportingAllBackups] = useState(false)
  const [isImportingAllBackups, setIsImportingAllBackups] = useState(false)
  const [bulkBackupError, setBulkBackupError] = useState("")
  const [bulkBackupNotice, setBulkBackupNotice] = useState("")

  useEffect(() => {
    const shouldOpenBulkReceiptImport = searchParams.get("bulkReceiptImport") === "1"
    if (!shouldOpenBulkReceiptImport) return

    setBulkReceiptImportPrefillFiles(consumePendingBulkReceiptFiles())
    setBulkReceiptImportOpen(true)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete("bulkReceiptImport")
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const handleExportAllBackups = async () => {
    if (bulkBackupFromDate && bulkBackupToDate && bulkBackupFromDate > bulkBackupToDate) {
      setBulkBackupError("Invalid date range: From date must be before or equal to To date.")
      return
    }

    setIsExportingAllBackups(true)
    setBulkBackupError("")
    setBulkBackupNotice("")

    try {
      const blob = await invoicesApi.downloadAllBackups({
        include_unfinalized: includeUnfinalizedInvoices,
        include_documents: includeBackupDocuments,
        from: bulkBackupFromDate || undefined,
        to: bulkBackupToDate || undefined,
      })

      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement("a")
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      link.href = downloadUrl
      link.download = `invoices_backup_${stamp}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(downloadUrl)

      setBulkBackupDialogOpen(false)
      setBulkBackupNotice("Invoice backup export started.")
    } catch (err) {
      setBulkBackupError(err instanceof Error ? err.message : "Failed to export invoice backups")
    } finally {
      setIsExportingAllBackups(false)
    }
  }

  const handleImportAllBackups = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsImportingAllBackups(true)
    setBulkBackupError("")
    setBulkBackupNotice("")

    try {
      const restored = await invoicesApi.importAllBackups(file)
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      queryClient.invalidateQueries({ queryKey: ["purchases"] })

      setBulkBackupNotice(
        `Imported ${restored.restored_invoice_count} invoice backup(s): ${restored.restored_purchase_count} purchases, ${restored.restored_receipt_count} receipts, ${restored.restored_allocation_count} allocations.`
      )
    } catch (err) {
      setBulkBackupError(err instanceof Error ? err.message : "Failed to import invoice backups")
    } finally {
      setIsImportingAllBackups(false)
      if (bulkImportInputRef.current) {
        bulkImportInputRef.current.value = ""
      }
    }
  }

  const handlePdfCreate = async () => {
    if (!parsedInvoice || !pdfDestinationId || !pdfFile) return
    setPdfCreating(true)
    setPdfError("")
    setPdfLineFailures([])
    setPdfCreateStatus("Committing atomic import...")

    try {
      const invoiceDate = parsedInvoice.invoice_date || ""
      const invoiceNumber = parsedInvoice.invoice_number || ""
      const invoiceSubtotal = parsedInvoice.subtotal || ""
      const lineItems = parsedInvoice.line_items.map((li, idx) => {
        const item = resolveItem(li, idx)
        return {
          line_index: idx,
          description: li.description,
          qty: li.qty,
          invoice_unit_price: li.invoice_unit_price,
          subtotal: li.subtotal,
          item_id: item?.id ?? null,
        }
      })

      await importApi.invoicePdfCommit(pdfFile, {
        destination_id: pdfDestinationId,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        subtotal: invoiceSubtotal,
        tax_rate: parsedInvoice.tax_rate || undefined,
        notes: parsedInvoice.notes || undefined,
        line_items: lineItems,
      })

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
        queryClient.invalidateQueries({ queryKey: ["reports"] }),
        queryClient.invalidateQueries({ queryKey: ["item"] }),
      ])

      setPdfDialogOpen(false)
      setParsedInvoice(null)
      setPdfDestinationId("")
      setPdfError("")
      setPdfLineFailures([])
      setPdfFile(null)
      setLineItemOverrides({})
      setNewItemForLineIdx(null)
    } catch (err) {
      if (err instanceof ApiValidationError) {
        const details = err.details as InvoicePdfCommitErrorResponse
        setPdfError(err.message)
        setPdfLineFailures(details.line_failures || [])
      } else {
        setPdfError(err instanceof Error ? err.message : "Failed to create invoice")
      }
    } finally {
      setPdfCreating(false)
      setPdfCreateStatus("")
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingInvoice) {
      await updateInvoice.mutateAsync({
        id: editingInvoice.id,
        invoice_number: invoiceNumber,
        order_number: orderNumber || null,
        invoice_date: invoiceDate,
        subtotal,
        notes: notes || null,
      })
    } else {
      await createInvoice.mutateAsync({
        destination_id: destinationId,
        invoice_number: invoiceNumber,
        order_number: orderNumber || undefined,
        invoice_date: invoiceDate,
        subtotal,
        notes: notes || undefined,
      })
    }
    setIsOpen(false)
    resetForm()
  }

  const resetForm = () => {
    setEditingInvoice(null)
    setDestinationId("")
    setInvoiceNumber("")
    setOrderNumber("")
    setInvoiceDate(new Date().toISOString().split("T")[0])
    setSubtotal("")
    setNotes("")
  }

  const openEditDialog = (invoice: Invoice) => {
    setEditingInvoice(invoice)
    setDestinationId(invoice.destination_id)
    setInvoiceNumber(invoice.invoice_number)
    setOrderNumber(invoice.order_number || "")
    setInvoiceDate(invoice.invoice_date)
    setSubtotal(invoice.subtotal)
    setNotes(invoice.notes || "")
    setIsOpen(true)
  }

  // Summary stats
  const totalInvoiceValue = invoices.reduce((sum, inv) => sum + parseFloat(inv.subtotal), 0)
  const unfinalizedCount = invoices.filter((inv) => inv.reconciliation_state !== "locked").length
  const emptyCount = invoices.filter(inv => (inv.purchase_count || 0) === 0).length

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Invoices</h1>
        <div className="flex gap-2">
          <input
            ref={bulkImportInputRef}
            type="file"
            accept=".zip"
            onChange={handleImportAllBackups}
            className="hidden"
          />
          <ExportCsvButton
            filename="invoices"
            columns={[
              { header: "Invoice #", accessor: (inv: Invoice) => inv.invoice_number },
              { header: "Destination", accessor: (inv: Invoice) => `${inv.destination_code} - ${inv.destination_name}` },
              { header: "Order #", accessor: (inv: Invoice) => inv.order_number },
              { header: "Date", accessor: (inv: Invoice) => inv.invoice_date },
              { header: "Subtotal", accessor: (inv: Invoice) => inv.subtotal },
              { header: "Tax Rate", accessor: (inv: Invoice) => formatNumber(inv.tax_rate) },
              { header: "Total", accessor: (inv: Invoice) => inv.total },
              { header: "Purchase Count", accessor: (inv: Invoice) => inv.purchase_count },
              { header: "Purchases Total", accessor: (inv: Invoice) => inv.purchases_total },
              { header: "Notes", accessor: (inv: Invoice) => inv.notes },
            ]}
            data={invoices}
          />
          <Dialog open={bulkBackupDialogOpen} onOpenChange={setBulkBackupDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <FileDown className="h-4 w-4 mr-2" />
                Export Backups
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Export Invoice Backups</DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeUnfinalizedInvoices}
                    onChange={(e) => setIncludeUnfinalizedInvoices(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Include unfinalized invoices
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeBackupDocuments}
                    onChange={(e) => setIncludeBackupDocuments(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Include attached invoice/receipt documents
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="bulk-backup-from">From Date</Label>
                    <DateInput
                      id="bulk-backup-from"
                      value={bulkBackupFromDate}
                      onChange={setBulkBackupFromDate}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bulk-backup-to">To Date</Label>
                    <DateInput
                      id="bulk-backup-to"
                      value={bulkBackupToDate}
                      onChange={setBulkBackupToDate}
                    />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Exports a ZIP containing one backup ZIP per invoice plus a manifest file.
                </p>

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBulkBackupDialogOpen(false)}
                    disabled={isExportingAllBackups}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleExportAllBackups}
                    disabled={isExportingAllBackups}
                  >
                    {isExportingAllBackups ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Exporting...
                      </>
                    ) : (
                      "Export"
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Button
            variant="outline"
            onClick={() => bulkImportInputRef.current?.click()}
            disabled={isImportingAllBackups}
          >
            {isImportingAllBackups ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Importing Backups...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Import Backups
              </>
            )}
          </Button>
          {selectedIds.size > 0 && (
            <Button 
              variant="destructive" 
              onClick={() => handleBulkDelete((id) => deleteInvoice.mutateAsync(id), "invoice(s)")}
              disabled={isDeleting}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete ({selectedIds.size})
            </Button>
          )}
          <Dialog open={pdfDialogOpen} onOpenChange={(open) => {
            setPdfDialogOpen(open)
            if (!open) {
              setParsedInvoice(null)
              setPdfDestinationId("")
              setPdfError("")
              setPdfLineFailures([])
              setPdfFile(null)
              setLineItemOverrides({})
              setNewItemForLineIdx(null)
              if (fileInputRef.current) fileInputRef.current.value = ""
            }
          }}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Upload className="h-4 w-4 mr-2" />
                Import from PDF
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Import Invoice from PDF</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select PDF Invoice</Label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handlePdfUpload}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={pdfParsing}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {pdfParsing ? "Parsing..." : "Choose PDF File"}
                  </Button>
                </div>

                {pdfParsing && (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4 animate-spin" />
                    Parsing PDF...
                  </div>
                )}

                {pdfError && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded">
                    {pdfError}
                  </div>
                )}

                {pdfLineFailures.length > 0 && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 p-3 rounded space-y-1">
                    <div className="font-medium">Line-level issues:</div>
                    {pdfLineFailures.map((f, idx) => (
                      <div key={`${f.line_index}-${idx}`}>Line {f.line_index + 1}: {f.message}</div>
                    ))}
                  </div>
                )}

                {parsedInvoice && (
                  <div className="space-y-4">
                    <div className="bg-muted p-3 rounded-md space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Invoice #</span>
                        <span className="font-mono font-medium">{parsedInvoice.invoice_number || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Date</span>
                        <span>{parsedInvoice.invoice_date || "—"}</span>
                      </div>
                      {parsedInvoice.bill_to && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Bill To</span>
                          <span className="text-right whitespace-pre-line max-w-[250px]">{parsedInvoice.bill_to}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span>{parsedInvoice.subtotal ? formatCurrency(parsedInvoice.subtotal) : "—"}</span>
                      </div>
                      {parsedInvoice.tax_rate && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Tax ({formatNumber(parsedInvoice.tax_rate)}%)</span>
                          <span>{parsedInvoice.tax_amount ? formatCurrency(parsedInvoice.tax_amount) : "—"}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold border-t pt-1">
                        <span>Total</span>
                        <span>{parsedInvoice.total ? formatCurrency(parsedInvoice.total) : "—"}</span>
                      </div>
                    </div>

                    {parsedInvoice.line_items.length > 0 && (
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">
                          Line Items ({parsedInvoice.line_items.filter((li, idx) => resolveItem(li, idx) !== null).length}/{parsedInvoice.line_items.length} matched)
                        </Label>
                        <div className="border rounded-md overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="text-xs w-6"></TableHead>
                                <TableHead className="text-xs">Description</TableHead>
                                <TableHead className="text-xs text-right w-12">Qty</TableHead>
                                <TableHead className="text-xs text-right w-20">Unit $</TableHead>
                                <TableHead className="text-xs text-right w-20">Subtotal</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {parsedInvoice.line_items.map((item, i) => {
                                const resolved = resolveItem(item, i)
                                const selectValue = getLineItemSelectValue(item, i)
                                const lineFailures = lineFailureByIndex[i] || []
                                return (
                                <TableRow key={i} className={lineFailures.length > 0 ? "bg-red-50" : (resolved ? "" : "bg-amber-50")}>
                                  <TableCell className="text-xs px-1">
                                    {lineFailures.length > 0
                                      ? <AlertCircle className="h-3 w-3 text-red-600" />
                                      : (resolved ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <AlertCircle className="h-3 w-3 text-amber-500" />)}
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    <div className="space-y-1">
                                      <span>{item.description}</span>
                                      {lineFailures.length > 0 && (
                                        <div className="text-[10px] text-red-600 font-medium">
                                          {lineFailures.map((f) => f.message).join(" • ")}
                                        </div>
                                      )}
                                      {resolved && (
                                        <div className="text-[10px] text-green-600 font-medium">→ {resolved.name}</div>
                                      )}
                                      <Select
                                        value={selectValue}
                                        onValueChange={(v) => {
                                          if (v === "__create__") {
                                            setNewItemForLineIdx(i)
                                            return
                                          }
                                          setLineItemOverrides(prev => {
                                            const next = { ...prev }
                                            if (v === "__none__") {
                                              delete next[i]
                                            } else {
                                              // If choosing the auto-match item, remove override (let auto-match work)
                                              const autoMatch = activeItems.find(ai => ai.name.toLowerCase() === item.description.toLowerCase())
                                              if (autoMatch && autoMatch.id === v) delete next[i]
                                              else next[i] = v
                                            }
                                            return next
                                          })
                                        }}
                                      >
                                        <SelectTrigger className="h-6 text-[11px]">
                                          <SelectValue placeholder="Map to item…" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="__none__">
                                            <span className="text-amber-600">— Unmapped (will fail)</span>
                                          </SelectItem>
                                          <SelectItem value="__create__">
                                            <span className="text-blue-600">+ Create New Item</span>
                                          </SelectItem>
                                          {activeItems.map(ai => (
                                            <SelectItem key={ai.id} value={ai.id}>
                                              {ai.name}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-xs text-right">{item.qty}</TableCell>
                                  <TableCell className="text-xs text-right">{formatCurrency(item.invoice_unit_price)}</TableCell>
                                  <TableCell className="text-xs text-right">{formatCurrency(item.subtotal)}</TableCell>
                                </TableRow>
                                )
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label>Destination</Label>
                      <Select value={pdfDestinationId} onValueChange={setPdfDestinationId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {destinations.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.code} - {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-2">
                      {pdfCreateStatus && (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Clock className="h-3 w-3 animate-spin" />
                          {pdfCreateStatus}
                        </div>
                      )}
                      {/* Summary of what will be created */}
                      {parsedInvoice.line_items.length > 0 && pdfDestinationId && (() => {
                        const resolved = parsedInvoice.line_items.map((li, idx) => ({ li, item: resolveItem(li, idx), idx }))
                        const matched = resolved.filter(r => r.item !== null).length
                        const unresolved = resolved.filter(r => r.item === null).length
                        return (
                          <div className={`text-xs px-3 py-2 rounded-md ${unresolved > 0 ? "text-amber-700 bg-amber-50" : "text-muted-foreground bg-muted"}`}>
                            {unresolved > 0
                              ? `Resolve all line items to continue (${matched}/${parsedInvoice.line_items.length} mapped)`
                              : `Ready to create: ${matched} invoice line record${matched > 1 ? "s" : ""}`}
                          </div>
                        )
                      })()}
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setPdfDialogOpen(false)} disabled={pdfCreating}>
                          Cancel
                        </Button>
                        <Button
                          onClick={handlePdfCreate}
                          disabled={!pdfDestinationId || pdfCreating || unresolvedLineCount > 0 || !pdfFile}
                        >
                          <FileText className="h-4 w-4 mr-2" />
                          Create Invoice
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
          {/* Create New Item dialog (triggered from per-line-item dropdown) */}
          <ItemFormDialog
            open={newItemForLineIdx !== null}
            onOpenChange={(open) => {
              if (!open) setNewItemForLineIdx(null)
            }}
            defaults={newItemForLineIdx !== null && parsedInvoice ? {
              name: parsedInvoice.line_items[newItemForLineIdx]?.description || "",
              defaultDestinationId: pdfDestinationId || undefined,
            } : undefined}
            onCreated={(newId) => {
              if (newItemForLineIdx !== null) {
                setLineItemOverrides(prev => ({ ...prev, [newItemForLineIdx]: newId }))
              }
              setNewItemForLineIdx(null)
            }}
          />
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open)
            if (!open) resetForm()
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Invoice
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingInvoice ? "Edit Invoice" : "Add Invoice"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                {!editingInvoice && (
                  <div className="space-y-2">
                    <Label htmlFor="destination">Destination *</Label>
                    <Select value={destinationId} onValueChange={setDestinationId} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select destination" />
                      </SelectTrigger>
                      <SelectContent>
                        {destinations.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.code} - {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {editingInvoice && (
                  <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
                    <strong>Destination:</strong> {editingInvoice.destination_code} - {editingInvoice.destination_name}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="invoiceNumber">Invoice # *</Label>
                    <Input
                      id="invoiceNumber"
                      value={invoiceNumber}
                      onChange={(e) => setInvoiceNumber(e.target.value)}
                      placeholder="INV-001"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="orderNumber">Order #</Label>
                    <Input
                      id="orderNumber"
                      value={orderNumber}
                      onChange={(e) => setOrderNumber(e.target.value)}
                      placeholder="ORD-001"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="invoiceDate">Invoice Date *</Label>
                    <DateInput
                      id="invoiceDate"
                      value={invoiceDate}
                      onChange={setInvoiceDate}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subtotal">Subtotal (pre-tax) *</Label>
                    <Input
                      id="subtotal"
                      type="number"
                      step="0.01"
                      value={subtotal}
                      onChange={(e) => setSubtotal(e.target.value)}
                      placeholder="0.00"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Input
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any notes..."
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createInvoice.isPending || updateInvoice.isPending}>
                    {editingInvoice ? "Save Changes" : "Create"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <BulkReceiptImportDialog
        open={bulkReceiptImportOpen}
        onOpenChange={(open) => {
          setBulkReceiptImportOpen(open)
          if (!open) {
            setBulkReceiptImportPrefillFiles([])
          }
        }}
        prefillFiles={bulkReceiptImportPrefillFiles}
      />

      {bulkBackupError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {bulkBackupError}
        </div>
      )}

      {bulkBackupNotice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {bulkBackupNotice}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Invoices</p>
            <p className="text-2xl font-bold">{invoices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Value</p>
            <p className="text-2xl font-bold">{formatCurrency(totalInvoiceValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Need Items</p>
            <p className="text-2xl font-bold text-gray-500">{emptyCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Not Finalized</p>
            <p className={`text-2xl font-bold ${unfinalizedCount > 0 ? "text-amber-600" : "text-green-600"}`}>
              {unfinalizedCount}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Invoices ({invoices.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                </TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Order #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[76px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow 
                  key={inv.id}
                  className={`cursor-pointer transition-colors ${selectedIds.has(inv.id) ? "bg-muted/50" : "hover:bg-muted/50"}`}
                  onClick={() => navigate(`/invoices/${inv.id}`)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(inv.id)}
                      onChange={() => toggleSelect(inv.id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                  <TableCell className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline">{inv.invoice_number}</TableCell>
                  <TableCell>{inv.destination_code} - {inv.destination_name}</TableCell>
                  <TableCell className="font-mono">{inv.order_number || "-"}</TableCell>
                  <TableCell>{formatDate(inv.invoice_date)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(inv.subtotal)}</TableCell>
                  <TableCell className="text-right">
                    <span className="text-muted-foreground">
                      {inv.purchase_count || 0} items · {formatCurrency(inv.purchases_total || "0")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ReconciliationBadge invoice={inv} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm truncate max-w-[200px]">
                    {inv.notes || "-"}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      onEdit={() => openEditDialog(inv)}
                      onDelete={() => {
                        if (confirm("Delete this invoice?")) {
                          deleteInvoice.mutateAsync(inv.id)
                        }
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {invoices.length === 0 && (
                <EmptyTableRow colSpan={10} message="No invoices yet. Add your first invoice to start tracking!" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
