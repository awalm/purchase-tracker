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
import { invoices as invoicesApi } from "@/api"


export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: invoice, isLoading: invoiceLoading } = useInvoice(id || "")
  const { data: purchases = [], isLoading: purchasesLoading } = useInvoicePurchases(id || "")
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()

  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()

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
  const [sellingPrice, setSellingPrice] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [notes, setNotes] = useState("")

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
        selling_price: sellingPrice || undefined,
        destination_id: destinationId || undefined,
        notes: notes || undefined,
      })
    } else {
      await createPurchase.mutateAsync({
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        selling_price: sellingPrice || undefined,
        destination_id: destinationId || undefined,
        invoice_id: id,
        notes: notes || undefined,
      })
    }
    // Also invalidate the invoice detail to refresh counts
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    setIsOpen(false)
    resetForm()
  }

  const resetForm = () => {
    setEditingPurchaseId(null)
    setItemId("")
    setQuantity("1")
    setPurchaseCost("")
    setSellingPrice("")
    setDestinationId("")
    setNotes("")
  }

  const handleItemChange = (selectedId: string) => {
    setItemId(selectedId)
    const item = items.find((i) => i.id === selectedId)
    if (item) {
      setPurchaseCost(item.purchase_cost)
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
    setSellingPrice(p.selling_price || "")
    // Find destination by code
    const matchedDest = destinations.find((d) => d.code === p.destination_code)
    setDestinationId(matchedDest?.id || "")
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
  const hasAnyPrice = purchases.some(p => p.selling_price !== null)

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
              View Receipt
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
                  Attach Receipt
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
              { header: "Selling Price", accessor: (p) => p.selling_price },
              { header: "Line Total", accessor: (p) => p.total_selling },
              { header: "Commission", accessor: (p) => p.total_commission },
              { header: "Status", accessor: (p) => p.status },
              { header: "Delivery Date", accessor: (p) => p.delivery_date },
            ]}
            data={purchases}
            size="sm"
          />
          {isReconciled ? (
            <span className="flex items-center gap-1 text-green-600 bg-green-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Reconciled
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              {purchaseCount === 0 ? "No purchases linked" : `${formatCurrency(Math.abs(difference))} ${difference > 0 ? "unaccounted" : "over"}`}
            </span>
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
                    <Label htmlFor="item">Item</Label>
                    <Select value={itemId} onValueChange={handleItemChange} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select item" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableItems.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} ({(i as { vendor_name?: string }).vendor_name || "Unknown"}) - {formatCurrency(i.purchase_cost)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="quantity">Quantity</Label>
                      <Input
                        id="quantity"
                        type="number"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="purchaseCost">Purchase Cost</Label>
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
                      <Label htmlFor="sellingPrice">Selling Price</Label>
                      <Input
                        id="sellingPrice"
                        type="number"
                        step="0.01"
                        value={sellingPrice}
                        onChange={(e) => setSellingPrice(e.target.value)}
                        placeholder="Selling price"
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
                    <Label htmlFor="notes">Notes (optional)</Label>
                    <Input
                      id="notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Any notes..."
                    />
                  </div>
                  {/* Live reconciliation hint */}
                  {sellingPrice && quantity && (
                    <div className="text-sm bg-muted p-3 rounded-md space-y-1">
                      <p>This line: <strong>{formatCurrency(parseFloat(sellingPrice) * parseInt(quantity || "0"))}</strong></p>
                      <p>
                        Remaining after:{" "}
                        <strong className={
                          (difference - parseFloat(sellingPrice) * parseInt(quantity || "0")) < 0.01
                            ? "text-green-600"
                            : "text-amber-600"
                        }>
                          {formatCurrency(difference - parseFloat(sellingPrice) * parseInt(quantity || "0"))}
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
                  <TableHead>Receipt</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Purchase Cost</TableHead>
                  <TableHead className="text-right">Selling Price</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => (
                  <TableRow key={p.purchase_id}>
                    <TableCell className="font-medium">{p.item_name}</TableCell>
                    <TableCell className="font-mono">{p.destination_code || "-"}</TableCell>
                    <TableCell>
                      {p.receipt_id ? (
                        <Link
                          to={`/receipts/${p.receipt_id}`}
                          className="text-xs font-mono text-emerald-600 hover:underline"
                        >
                          {p.receipt_number || "linked"}
                        </Link>
                      ) : (
                        <span className="text-red-500 text-xs flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          unlinked
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{p.quantity}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(p.purchase_cost)}</TableCell>
                    <TableCell className="text-right">{p.selling_price ? formatCurrency(p.selling_price) : "-"}</TableCell>
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
    </div>
  )
}
