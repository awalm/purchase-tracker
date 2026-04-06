import { useState, useRef } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useInvoice,
  useInvoicePurchases,
  useCreatePurchase,
  useUpdatePurchase,
  useDeletePurchase,
  useItems,
  useDestinations,
  useReceipts,
  useVendors,
  useCreateReceipt,
} from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card"
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
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { StatusSelect } from "@/components/StatusSelect"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ArrowLeft, Plus, Trash2, Pencil, CheckCircle2, AlertCircle, Package, FileDown, Upload, Loader2 } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { invoices as invoicesApi, receipts as receiptsApi } from "@/api"

type InvoicePurchase = ReturnType<typeof useInvoicePurchases>["data"] extends (infer T)[] | undefined ? T : never


export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: invoice, isLoading: invoiceLoading } = useInvoice(id || "")
  const { data: purchases = [], isLoading: purchasesLoading } = useInvoicePurchases(id || "")
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const { data: receipts = [] } = useReceipts()
  const { data: vendors = [] } = useVendors()

  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()
  const createReceipt = useCreateReceipt()

  // PDF upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploadingPdf, setIsUploadingPdf] = useState(false)

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return
    
    setIsUploadingPdf(true)
    try {
      await invoicesApi.uploadPdf(id, file)
      queryClient.invalidateQueries({ queryKey: ["invoice", id] })
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to upload PDF")
    } finally {
      setIsUploadingPdf(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  // Add purchase form
  const [isOpen, setIsOpen] = useState(false)
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null)
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [purchaseCost, setPurchaseCost] = useState("")
  const [invoiceUnitPrice, setInvoiceUnitPrice] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [receiptId, setReceiptId] = useState("")
  const [notes, setNotes] = useState("")

  // Receipt-link dialog (focused, not the full edit form)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkingPurchaseId, setLinkingPurchaseId] = useState<string | null>(null)
  const [linkReceiptId, setLinkReceiptId] = useState("")
  const [showNewReceipt, setShowNewReceipt] = useState(false)
  const [newRcptVendorId, setNewRcptVendorId] = useState("")
  const [newRcptNumber, setNewRcptNumber] = useState("")
  const [newRcptDate, setNewRcptDate] = useState("")
  const [newRcptSubtotal, setNewRcptSubtotal] = useState("")
  const [newRcptTaxAmount, setNewRcptTaxAmount] = useState("")
  const [newRcptFile, setNewRcptFile] = useState<File | null>(null)
  const [linkQuantity, setLinkQuantity] = useState("1")
  const [linkingPurchase, setLinkingPurchase] = useState<InvoicePurchase | null>(null)
  const [linkNotes, setLinkNotes] = useState("")
  const [confirmSplit, setConfirmSplit] = useState(false)

  const openLinkDialog = (purchase: InvoicePurchase) => {
    setLinkingPurchaseId(purchase.purchase_id)
    setLinkingPurchase(purchase)
    setLinkReceiptId(purchase.receipt_id || "")
    setLinkNotes(purchase.notes || "")
    setLinkQuantity(String(purchase.quantity))
    setShowNewReceipt(false)
    setNewRcptFile(null)
    setConfirmSplit(false)
    setLinkDialogOpen(true)
  }

  const resetNewReceiptForm = () => {
    setNewRcptVendorId("")
    setNewRcptNumber("")
    setNewRcptDate("")
    setNewRcptSubtotal("")
    setNewRcptTaxAmount("")
    setNewRcptFile(null)
    setLinkQuantity("1")
    setConfirmSplit(false)
  }

  const resolveDestinationIdForPurchase = (purchase: InvoicePurchase): string | undefined => {
    const byCode = destinations.find((d) => d.code === purchase.destination_code)
    return byCode?.id || invoice?.destination_id || undefined
  }

  const ensureReceiptItemCapacity = async (receiptIdToAssign: string, selectedQty: number) => {
    if (!linkingPurchase) return

    const isSameReceipt = linkingPurchase.receipt_id === receiptIdToAssign
    if (isSameReceipt) return

    const receiptLines = await receiptsApi.purchases(receiptIdToAssign)
    const availableQtyForItem = receiptLines
      .filter((line) => line.item_id === linkingPurchase.item_id && !line.invoice_id)
      .reduce((sum, line) => sum + line.quantity, 0)

    if (selectedQty > availableQtyForItem) {
      throw new Error(`Only ${availableQtyForItem} unallocated unit(s) of this item remain on the selected receipt.`)
    }
  }

  const applyReceiptAllocation = async (receiptIdToAssign?: string) => {
    if (!linkingPurchaseId || !linkingPurchase) return

    const parsedQty = parseInt(linkQuantity, 10)
    const selectedQty = Number.isNaN(parsedQty) ? 1 : parsedQty

    if (selectedQty <= 0 || selectedQty > linkingPurchase.quantity) {
      alert(`Quantity must be between 1 and ${linkingPurchase.quantity}`)
      return
    }

    if (!receiptIdToAssign && selectedQty < linkingPurchase.quantity) {
      alert("Choose a receipt when splitting quantity.")
      return
    }

    if (receiptIdToAssign) {
      try {
        await ensureReceiptItemCapacity(receiptIdToAssign, selectedQty)
      } catch (err) {
        alert(err instanceof Error ? err.message : "Selected receipt does not have enough available quantity for this item.")
        return
      }
    }

    if (selectedQty === linkingPurchase.quantity) {
      await updatePurchase.mutateAsync({
        id: linkingPurchaseId,
        receipt_id: receiptIdToAssign || undefined,
        clear_receipt: !receiptIdToAssign,
        notes: linkNotes || undefined,
      })
      return
    }

    const remainingQty = linkingPurchase.quantity - selectedQty

    await updatePurchase.mutateAsync({
      id: linkingPurchaseId,
      quantity: remainingQty,
    })

    await createPurchase.mutateAsync({
      item_id: linkingPurchase.item_id,
      quantity: selectedQty,
      purchase_cost: linkingPurchase.purchase_cost,
      invoice_unit_price: linkingPurchase.invoice_unit_price || undefined,
      destination_id: resolveDestinationIdForPurchase(linkingPurchase),
      receipt_id: receiptIdToAssign,
      invoice_id: id,
      status: linkingPurchase.status,
      notes: linkNotes || linkingPurchase.notes || undefined,
    })
  }

  const handleCreateAndLink = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!linkingPurchaseId) return
    const newReceipt = await createReceipt.mutateAsync({
      vendor_id: newRcptVendorId,
      ...(newRcptNumber.trim() ? { receipt_number: newRcptNumber.trim() } : {}),
      receipt_date: newRcptDate,
      subtotal: newRcptSubtotal,
      tax_amount: newRcptTaxAmount,
    })
    await receiptsApi.uploadPdf(newReceipt.id, newRcptFile!)
    await applyReceiptAllocation(newReceipt.id)
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setLinkDialogOpen(false)
    resetNewReceiptForm()
  }

  const handleLinkReceipt = async () => {
    if (!linkingPurchaseId) return
    await applyReceiptAllocation(linkReceiptId || undefined)
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setConfirmSplit(false)
    setLinkDialogOpen(false)
  }

  const handleSaveLinkFlow = async () => {
    if (!linkingPurchase) return

    const parsedQty = parseInt(linkQuantity, 10)
    const selectedQty = Number.isNaN(parsedQty) ? 1 : parsedQty

    if (selectedQty < linkingPurchase.quantity && !confirmSplit) {
      setConfirmSplit(true)
      return
    }

    await handleLinkReceipt()
  }

  // Show all items (no vendor filtering needed for outgoing invoices)
  const availableItems = items

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingPurchaseId) {
      await updatePurchase.mutateAsync({
        id: editingPurchaseId,
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        invoice_unit_price: invoiceUnitPrice || undefined,
        destination_id: destinationId || undefined,
        receipt_id: receiptId || undefined,
        clear_receipt: !receiptId,
        invoice_id: id,
        notes: notes || undefined,
      })
    } else {
      await createPurchase.mutateAsync({
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        invoice_unit_price: invoiceUnitPrice || undefined,
        destination_id: destinationId || undefined,
        receipt_id: receiptId || undefined,
        invoice_id: id,
        notes: notes || undefined,
      })
    }
    // Also invalidate the invoice detail to refresh counts
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setIsOpen(false)
    resetForm()
  }

  const resetForm = () => {
    setEditingPurchaseId(null)
    setItemId("")
    setQuantity("1")
    setPurchaseCost("")
    setInvoiceUnitPrice("")
    setDestinationId("")
    setReceiptId("")
    setNotes("")
  }

  const handleItemChange = (selectedId: string) => {
    setItemId(selectedId)
    const item = items.find((i) => i.id === selectedId)
    if (item) {
      // Default to invoice destination if item has no default
      if (item.default_destination_id) {
        setDestinationId(item.default_destination_id)
      } else if (invoice) {
        setDestinationId(invoice.destination_id)
      }
    }
  }

  const handleEditPurchase = (p: typeof purchases[0]) => {
    setEditingPurchaseId(p.purchase_id)
    // Find item ID by name
    const matchedItem = items.find((i) => i.name === p.item_name)
    setItemId(matchedItem?.id || "")
    setQuantity(String(p.quantity))
    setPurchaseCost(p.purchase_cost)
    setInvoiceUnitPrice(p.invoice_unit_price || "")
    // Find destination by code
    const matchedDest = destinations.find((d) => d.code === p.destination_code)
    setDestinationId(matchedDest?.id || "")
    setReceiptId(p.receipt_id || "")
    setNotes("")
    setIsOpen(true)
  }

  const handleStatusChange = async (purchaseId: string, newStatus: string) => {
    await updatePurchase.mutateAsync({ id: purchaseId, status: newStatus })
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
  }

  const handleDeletePurchase = async (purchaseId: string) => {
    if (confirm("Remove this purchase from the invoice?")) {
      await deletePurchase.mutateAsync(purchaseId)
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
    }
  }

  if (invoiceLoading) return <div className="text-muted-foreground">Loading...</div>
  if (!invoice) return <div className="text-muted-foreground">Invoice not found</div>

  const invoiceSubtotal = parseFloat(invoice.subtotal)
  const purchasesTotal = parseFloat(invoice.purchases_total || "0")
  const difference = invoiceSubtotal - purchasesTotal
  const isReconciled = Math.abs(difference) < 0.01
  const purchaseCount = invoice.purchase_count || 0

  const totalQuantity = purchases.reduce((sum, p) => sum + p.quantity, 0)
  const totalCost = purchases.reduce((sum, p) => sum + parseFloat(p.total_cost || "0"), 0)
  const totalCommission = purchases.reduce((sum, p) => sum + parseFloat(p.total_commission || "0"), 0)
  const hasAnyPrice = purchases.some(p => p.invoice_unit_price !== null)
  const receiptedCount = invoice.receipted_count || purchases.filter(p => p.receipt_id).length
  const totalPurchases = purchases.length
  const fullyReconciled = isReconciled && totalPurchases > 0 && receiptedCount === totalPurchases

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/invoices")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Invoice {invoice.invoice_number}</h1>
          <p className="text-muted-foreground">
            {invoice.destination_code} - {invoice.destination_name} · {formatDate(invoice.invoice_date)}
            {invoice.order_number && ` · Order: ${invoice.order_number}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Hidden file input for PDF upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handlePdfUpload}
            className="hidden"
          />
          
          {invoice.has_pdf ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const token = localStorage.getItem('token')
                const url = invoicesApi.downloadPdfUrl(invoice.id)
                // Open in new tab with auth
                fetch(url, { headers: { Authorization: `Bearer ${token}` } })
                  .then(res => res.blob())
                  .then(blob => {
                    const blobUrl = URL.createObjectURL(blob)
                    window.open(blobUrl, '_blank')
                  })
              }}
            >
              <FileDown className="h-4 w-4 mr-2" />
              View Invoice
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingPdf}
            >
              {isUploadingPdf ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Attach Invoice
                </>
              )}
            </Button>
          )}
          <ExportCsvButton
            filename={`invoice_${invoice.invoice_number}`}
            columns={[
              { header: "Item", accessor: (p) => p.item_name },
              { header: "Destination", accessor: (p) => p.destination_code },
              { header: "Quantity", accessor: (p) => p.quantity },
              { header: "Purchase Cost", accessor: (p) => p.purchase_cost },
              { header: "Invoice Unit Price", accessor: (p) => p.invoice_unit_price },
              { header: "Line Total", accessor: (p) => p.total_selling },
              { header: "Commission", accessor: (p) => p.total_commission },
              { header: "Receipt", accessor: (p) => p.receipt_number },
              { header: "Status", accessor: (p) => p.status },
              { header: "Delivery Date", accessor: (p) => p.delivery_date },
              { header: "Notes", accessor: (p) => p.notes },
            ]}
            data={purchases}
            size="sm"
          />
          {fullyReconciled ? (
            <span className="flex items-center gap-1 text-green-600 bg-green-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Reconciled
            </span>
          ) : (
            <>
              {!isReconciled && (
                <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
                  <AlertCircle className="h-4 w-4" />
                  {purchaseCount === 0 ? "No purchases linked" : `${formatCurrency(Math.abs(difference))} ${difference > 0 ? "unaccounted" : "over"}`}
                </span>
              )}
              {totalPurchases > 0 && receiptedCount < totalPurchases && (
                <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
                  <AlertCircle className="h-4 w-4" />
                  {receiptedCount}/{totalPurchases} receipted
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Subtotal (pre-tax)</p>
            <p className="text-2xl font-bold">{formatCurrency(invoice.subtotal)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              +{invoice.tax_rate}% tax = {formatCurrency(invoice.total)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Purchases Total</p>
            <p className="text-2xl font-bold">{formatCurrency(purchasesTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Difference</p>
            <p className={`text-2xl font-bold ${isReconciled ? "text-green-600" : "text-amber-600"}`}>
              {formatCurrency(difference)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Cost</p>
            <p className="text-2xl font-bold">{formatCurrency(totalCost)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Commission</p>
            <p className={`text-2xl font-bold ${hasAnyPrice ? (totalCommission >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
              {hasAnyPrice ? formatCurrency(totalCommission) : "—"}
            </p>
            {hasAnyPrice && totalCost > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {((totalCommission / totalCost) * 100).toFixed(1)}% margin
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Notes */}
      {invoice.notes && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground mb-1">Notes</p>
            <p>{invoice.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Purchases linked to this invoice */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>Line Items ({purchases.length})</CardTitle>
              <CardDescription>
                {totalQuantity} units across {purchases.length} purchase{purchases.length !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <Dialog
              open={isOpen}
              onOpenChange={(open) => {
                setIsOpen(open)
                if (!open) resetForm()
              }}
            >
              <DialogTrigger asChild>
                <Button onClick={() => {
                  resetForm()
                  if (invoice) setDestinationId(invoice.destination_id)
                }}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Line Item
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>{editingPurchaseId ? "Edit Line Item" : "Add Purchase to Invoice"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
                    <strong>Invoice:</strong> {invoice.invoice_number} ({invoice.destination_code} - {invoice.destination_name})
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="item">Item *</Label>
                    <Select value={itemId} onValueChange={handleItemChange} required>
                      <SelectTrigger className="truncate">
                        <SelectValue placeholder="Select item" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableItems.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            <span className="truncate">{i.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="quantity">Quantity *</Label>
                      <Input
                        id="quantity"
                        type="number"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="purchaseCost">Purchase Cost *</Label>
                      <Input
                        id="purchaseCost"
                        type="number"
                        step="0.01"
                        value={purchaseCost}
                        onChange={(e) => setPurchaseCost(e.target.value)}
                        placeholder="Your cost"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="invoiceUnitPrice">Invoice Unit Price</Label>
                      <Input
                        id="invoiceUnitPrice"
                        type="number"
                        step="0.01"
                        value={invoiceUnitPrice}
                        onChange={(e) => setInvoiceUnitPrice(e.target.value)}
                        placeholder="Invoice unit price"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="destination">Destination</Label>
                    <Select value={destinationId} onValueChange={setDestinationId}>
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
                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Input
                      id="notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Any notes..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="receipt">Receipt</Label>
                    <Select
                      value={receiptId || "__none__"}
                      onValueChange={(v) => setReceiptId(v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select receipt" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-muted-foreground">— No receipt</span>
                        </SelectItem>
                        {receipts.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.receipt_number} - {r.vendor_name} ({formatCurrency(r.total)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Live reconciliation hint */}
                  {invoiceUnitPrice && quantity && (
                    <div className="text-sm bg-muted p-3 rounded-md space-y-1">
                      <p>This line: <strong>{formatCurrency(parseFloat(invoiceUnitPrice) * parseInt(quantity || "0"))}</strong></p>
                      <p>
                        Remaining after:{" "}
                        <strong className={
                          (difference - parseFloat(invoiceUnitPrice) * parseInt(quantity || "0")) < 0.01
                            ? "text-green-600"
                            : "text-amber-600"
                        }>
                          {formatCurrency(difference - parseFloat(invoiceUnitPrice) * parseInt(quantity || "0"))}
                        </strong>
                      </p>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createPurchase.isPending || updatePurchase.isPending}>
                      {editingPurchaseId ? "Save Changes" : "Add to Invoice"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {purchasesLoading ? (
            <p className="text-muted-foreground">Loading purchases...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Dest</TableHead>
                  <TableHead>Receipts</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Purchase Cost</TableHead>
                  <TableHead className="text-right">Invoice Unit Price</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => (
                  <TableRow key={p.purchase_id}>
                    <TableCell className="font-medium">
                      <Link to={`/items/${p.item_id}`} className="hover:underline text-primary">
                        {p.item_name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono">{p.destination_code || "-"}</TableCell>
                    <TableCell>
                      {p.receipt_id ? (
                        <div className="space-y-1">
                          <Link
                            to={`/receipts/${p.receipt_id}`}
                            className="text-xs font-mono text-emerald-600 hover:underline block"
                          >
                            {p.receipt_number || "linked"}
                          </Link>
                          <button
                            onClick={() => openLinkDialog(p)}
                            className="text-[11px] text-muted-foreground hover:underline"
                            title="Change receipt link or split quantity"
                          >
                            split / change
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => openLinkDialog(p)}
                          className="text-red-500 text-xs flex items-center gap-1 hover:underline cursor-pointer"
                          title="Click to link a receipt"
                        >
                          <AlertCircle className="h-3 w-3" />
                          unlinked
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{p.quantity}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(p.purchase_cost)}</TableCell>
                    <TableCell className="text-right">{p.invoice_unit_price ? formatCurrency(p.invoice_unit_price) : "-"}</TableCell>
                    <TableCell className="text-right">{p.total_selling ? formatCurrency(p.total_selling) : formatCurrency(p.total_cost)}</TableCell>
                    <TableCell className={`text-right ${p.total_commission ? (parseFloat(p.total_commission) >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
                      {p.total_commission ? formatCurrency(p.total_commission) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusSelect
                        value={p.status}
                        onValueChange={(value) => handleStatusChange(p.purchase_id, value)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEditPurchase(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-red-600"
                          onClick={() => handleDeletePurchase(p.purchase_id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {purchases.length === 0 && (
                  <EmptyTableRow colSpan={10}>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Package className="h-8 w-8" />
                      <p>No purchases linked to this invoice yet</p>
                      <p className="text-sm">Click "Add Line Item" to start entering what was on this invoice</p>
                    </div>
                  </EmptyTableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Focused Receipt Link Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={(open) => {
        setLinkDialogOpen(open)
        if (!open) {
          setShowNewReceipt(false)
          setLinkingPurchase(null)
          setLinkingPurchaseId(null)
          resetNewReceiptForm()
        }
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{showNewReceipt ? "New Receipt" : "Link Receipt"}</DialogTitle>
          </DialogHeader>
          {showNewReceipt ? (
            <form onSubmit={handleCreateAndLink} className="space-y-4 min-w-0">
              <div className="space-y-2">
                <Label>Vendor *</Label>
                <Select value={newRcptVendorId} onValueChange={setNewRcptVendorId} required>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder="Select vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Receipt Number</Label>
                <Input className="w-full min-w-0" value={newRcptNumber} onChange={(e) => setNewRcptNumber(e.target.value)} placeholder="Auto-generated if empty" />
              </div>
              <div className="space-y-2">
                <Label>Date *</Label>
                <Input className="w-full min-w-0" type="date" value={newRcptDate} onChange={(e) => setNewRcptDate(e.target.value)} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Subtotal *</Label>
                  <Input className="w-full min-w-0" type="number" step="0.01" value={newRcptSubtotal} onChange={(e) => setNewRcptSubtotal(e.target.value)} placeholder="0.00" required />
                </div>
                <div className="space-y-2">
                  <Label>Tax Amount *</Label>
                  <Input className="w-full min-w-0" type="number" step="0.01" value={newRcptTaxAmount} onChange={(e) => setNewRcptTaxAmount(e.target.value)} placeholder="0.00" required />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Receipt Document *</Label>
                <Input
                  className="w-full min-w-0 cursor-pointer"
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  onChange={(e) => setNewRcptFile(e.target.files?.[0] || null)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Input className="w-full min-w-0" value={linkNotes} onChange={(e) => setLinkNotes(e.target.value)} placeholder="e.g. Used gift card, price adjusted..." />
              </div>
              <div className="flex justify-between">
                <Button type="button" variant="link" className="px-0" onClick={() => setShowNewReceipt(false)}>
                  ← Back
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createReceipt.isPending}>
                    {createReceipt.isPending ? "Creating..." : "Create & Link"}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <div className="space-y-4 min-w-0">
              <div className="rounded-md bg-muted p-3 text-sm min-w-0">
                <div>
                  <strong className="block break-words">{linkingPurchase?.item_name || "Item"}</strong>
                </div>
                <div className="text-muted-foreground">
                  Available quantity to allocate: {linkingPurchase?.quantity ?? 0}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Receipt</Label>
                <Select
                  value={linkReceiptId || "__none__"}
                  onValueChange={(v) => {
                    setLinkReceiptId(v === "__none__" ? "" : v)
                    setConfirmSplit(false)
                  }}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder="Select receipt" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— No receipt</span>
                    </SelectItem>
                    {receipts.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.receipt_number} - {r.vendor_name} ({formatCurrency(r.total)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Quantity *</Label>
                <Input
                  className="w-full min-w-0"
                  type="number"
                  min={1}
                  max={linkingPurchase?.quantity || 1}
                  value={linkQuantity}
                  onChange={(e) => {
                    setLinkQuantity(e.target.value)
                    setConfirmSplit(false)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  If less than total quantity, this line will be split so you can link to multiple receipts.
                </p>
              </div>
              {confirmSplit && linkingPurchase && parseInt(linkQuantity || "0", 10) < linkingPurchase.quantity && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">Split confirmation</p>
                  <p>
                    This will split the current line into <strong>{linkQuantity}</strong> linked now and{" "}
                    <strong>{linkingPurchase.quantity - parseInt(linkQuantity || "0", 10)}</strong> remaining.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label>Notes</Label>
                <Input className="w-full min-w-0" value={linkNotes} onChange={(e) => setLinkNotes(e.target.value)} placeholder="e.g. Used gift card, price adjusted..." />
              </div>
              <div className="flex justify-between">
                <Button
                  variant="link"
                  className="px-0 text-emerald-600"
                  onClick={() => setShowNewReceipt(true)}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Receipt
                </Button>
                <div className="flex gap-2">
                  {confirmSplit && (
                    <Button variant="outline" onClick={() => setConfirmSplit(false)}>
                      Back
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleSaveLinkFlow} disabled={updatePurchase.isPending || createPurchase.isPending}>
                    {updatePurchase.isPending || createPurchase.isPending
                      ? "Saving..."
                      : confirmSplit
                        ? "Confirm Split & Save"
                        : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
