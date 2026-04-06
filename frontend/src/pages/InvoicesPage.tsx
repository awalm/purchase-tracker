import { useState, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { useInvoices, useCreateInvoice, useUpdateInvoice, useDeleteInvoice, useDestinations, useItems, useCreatePurchase } from "@/hooks/useApi"
import { useMultiSelect } from "@/hooks/useMultiSelect"
import { importApi, invoices as invoicesApi, type ParsedInvoice } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
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
import { Plus, Trash2, CheckCircle2, AlertCircle, Clock, Upload, FileText } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"

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
  has_pdf: boolean | null
  notes: string | null
  purchase_count: number | null
  purchases_total: string | null
  receipted_count: number | null
}

function ReconciliationBadge({ invoice }: { invoice: Invoice }) {
  const invoiceSubtotal = parseFloat(invoice.subtotal)
  const purchasesTotal = parseFloat(invoice.purchases_total || "0")
  const difference = Math.abs(invoiceSubtotal - purchasesTotal)
  const count = invoice.purchase_count || 0
  const receiptedCount = invoice.receipted_count || 0
  const allReceipted = count > 0 && receiptedCount === count
  const totalsMatched = difference < 0.01

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
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded-full">
        <CheckCircle2 className="h-3 w-3" />
        Reconciled
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
  const { data: invoices = [], isLoading } = useInvoices()
  const { data: destinations = [] } = useDestinations()
  const createInvoice = useCreateInvoice()
  const updateInvoice = useUpdateInvoice()
  const deleteInvoice = useDeleteInvoice()
  const { data: activeItems = [] } = useItems()
  const createPurchase = useCreatePurchase()

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
    if (overrideId === "__skip__") return null
    if (overrideId) return activeItems.find(ai => ai.id === overrideId) ?? null
    return activeItems.find(ai => ai.name.toLowerCase() === li.description.toLowerCase()) ?? null
  }

  // Compute select value for a line item dropdown
  const getLineItemSelectValue = (li: ParsedInvoice["line_items"][0], idx: number): string => {
    const overrideId = lineItemOverrides[idx]
    if (overrideId === "__skip__") return "__none__"
    if (overrideId) return overrideId
    const autoMatch = activeItems.find(ai => ai.name.toLowerCase() === li.description.toLowerCase())
    return autoMatch ? autoMatch.id : "__none__"
  }

  const [pdfCreating, setPdfCreating] = useState(false)
  const [pdfCreateStatus, setPdfCreateStatus] = useState("")

  const handlePdfCreate = async () => {
    if (!parsedInvoice || !pdfDestinationId) return
    setPdfCreating(true)
    setPdfError("")
    setPdfCreateStatus("Creating invoice...")

    try {
      const invoiceDate = parsedInvoice.invoice_date || new Date().toISOString().split("T")[0]

      const { id: invoiceId } = await createInvoice.mutateAsync({
        destination_id: pdfDestinationId,
        invoice_number: parsedInvoice.invoice_number || "UNKNOWN",
        invoice_date: invoiceDate,
        subtotal: parsedInvoice.subtotal || "0",
        tax_rate: parsedInvoice.tax_rate || undefined,
        notes: parsedInvoice.notes || undefined,
      })

      // Upload the original PDF to the new invoice
      if (invoiceId && pdfFile) {
        try {
          setPdfCreateStatus("Attaching PDF document...")
          await invoicesApi.uploadPdf(invoiceId, pdfFile)
        } catch {
          // non-critical — invoice is created, just PDF attachment failed
        }
      }

      if (parsedInvoice.line_items.length > 0 && invoiceId) {
        for (let i = 0; i < parsedInvoice.line_items.length; i++) {
          const li = parsedInvoice.line_items[i]
          const item = resolveItem(li, i)
          if (!item) continue

          // Create purchase linked to invoice
          // purchase_cost is unknown until reconciled with a receipt — use 0 as placeholder
          try {
            setPdfCreateStatus(`Creating purchase: ${li.description} x${li.qty}...`)
            await createPurchase.mutateAsync({
              item_id: item.id,
              quantity: li.qty,
              purchase_cost: "0",
              invoice_unit_price: li.invoice_unit_price,
              destination_id: pdfDestinationId,
              invoice_id: invoiceId,
              status: "delivered",
            })
          } catch {
            // skip items that fail
          }
        }
      }

      setPdfDialogOpen(false)
      setParsedInvoice(null)
      setPdfDestinationId("")
      setPdfError("")
      setPdfFile(null)
      setLineItemOverrides({})
      setNewItemForLineIdx(null)
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Failed to create invoice")
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
  const unreconciledCount = invoices.filter(inv => {
    const count = inv.purchase_count || 0
    if (count === 0) return false // "No items" is not unreconciled, just empty
    const diff = Math.abs(parseFloat(inv.subtotal) - parseFloat(inv.purchases_total || "0"))
    const totalsMatched = diff < 0.01
    const allReceipted = (inv.receipted_count || 0) === count
    return !totalsMatched || !allReceipted
  }).length
  const emptyCount = invoices.filter(inv => (inv.purchase_count || 0) === 0).length

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Invoices</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="invoices"
            columns={[
              { header: "Invoice #", accessor: (inv: Invoice) => inv.invoice_number },
              { header: "Destination", accessor: (inv: Invoice) => `${inv.destination_code} - ${inv.destination_name}` },
              { header: "Order #", accessor: (inv: Invoice) => inv.order_number },
              { header: "Date", accessor: (inv: Invoice) => inv.invoice_date },
              { header: "Subtotal", accessor: (inv: Invoice) => inv.subtotal },
              { header: "Tax Rate", accessor: (inv: Invoice) => inv.tax_rate },
              { header: "Total", accessor: (inv: Invoice) => inv.total },
              { header: "Purchase Count", accessor: (inv: Invoice) => inv.purchase_count },
              { header: "Purchases Total", accessor: (inv: Invoice) => inv.purchases_total },
              { header: "Notes", accessor: (inv: Invoice) => inv.notes },
            ]}
            data={invoices}
          />
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
                          <span className="text-muted-foreground">Tax ({parsedInvoice.tax_rate}%)</span>
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
                                return (
                                <TableRow key={i} className={resolved ? "" : "bg-amber-50"}>
                                  <TableCell className="text-xs px-1">
                                    {resolved ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <AlertCircle className="h-3 w-3 text-amber-500" />}
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    <div className="space-y-1">
                                      <span>{item.description}</span>
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
                                              // If there's an auto-match, store explicit skip
                                              const autoMatch = activeItems.find(ai => ai.name.toLowerCase() === item.description.toLowerCase())
                                              if (autoMatch) next[i] = "__skip__"
                                              else delete next[i]
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
                                            <span className="text-amber-600">— Skip</span>
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
                        const skipped = resolved.filter(r => r.item === null).length
                        const notes: string[] = []
                        if (matched > 0) notes.push(`${matched} purchase${matched > 1 ? "s" : ""}`)
                        if (skipped > 0) notes.push(`${skipped} skipped`)
                        return notes.length > 0 ? (
                          <div className="text-xs text-muted-foreground bg-muted px-3 py-2 rounded-md">
                            Will create: {notes.join(", ")}
                          </div>
                        ) : null
                      })()}
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setPdfDialogOpen(false)} disabled={pdfCreating}>
                          Cancel
                        </Button>
                        <Button
                          onClick={handlePdfCreate}
                          disabled={!pdfDestinationId || pdfCreating}
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
            <p className="text-sm text-muted-foreground">Unreconciled</p>
            <p className={`text-2xl font-bold ${unreconciledCount > 0 ? "text-amber-600" : "text-green-600"}`}>
              {unreconciledCount}
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
