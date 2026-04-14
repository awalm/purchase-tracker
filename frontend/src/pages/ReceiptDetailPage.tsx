import { useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useReceipt,
  useReceiptPurchases,
  useCreatePurchase,
  useUpdatePurchase,
  useDeletePurchase,
  useItems,
  useDestinations,
  useInvoices,
} from "@/hooks/useApi"
import { receipts as receiptsApi, type ReceiptLineItem } from "@/api"
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
import { StatusSelect } from "@/components/StatusSelect"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import {
  ArrowLeft,
  Plus,
  Trash2,
  Pencil,
  FileText,
  Upload,
  AlertCircle,
  CheckCircle2,
} from "lucide-react"
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils"

export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: receipt, isLoading: loadingReceipt } = useReceipt(id || "")
  const { data: purchases = [], isLoading: loadingPurchases } =
    useReceiptPurchases(id || "")
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const { data: invoices = [] } = useInvoices()

  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()

  const {
    data: receiptLineItems = [],
    isLoading: loadingReceiptLineItems,
  } = useQuery({
    queryKey: ["receipts", id, "line-items"],
    queryFn: () => receiptsApi.lineItems.list(id || ""),
    enabled: !!id,
  })

  const [lineItemDialogOpen, setLineItemDialogOpen] = useState(false)
  const [editingLineItemId, setEditingLineItemId] = useState<string | null>(null)
  const [lineItemId, setLineItemId] = useState("")
  const [lineItemQty, setLineItemQty] = useState("1")
  const [lineItemUnitCost, setLineItemUnitCost] = useState("")
  const [lineItemNotes, setLineItemNotes] = useState("")

  const [isOpen, setIsOpen] = useState(false)
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null)
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [purchaseCost, setPurchaseCost] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [invoiceId, setInvoiceId] = useState("")
  const [purchaseNotes, setPurchaseNotes] = useState("")

  const resetForm = () => {
    setEditingPurchaseId(null)
    setItemId("")
    setQuantity("1")
    setPurchaseCost("")
    setDestinationId("")
    setInvoiceId("")
    setPurchaseNotes("")
  }

  const resetLineItemForm = () => {
    setEditingLineItemId(null)
    setLineItemId("")
    setLineItemQty("1")
    setLineItemUnitCost("")
    setLineItemNotes("")
  }

  const handleLineItemSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return

    if (editingLineItemId) {
      await receiptsApi.lineItems.update(id, editingLineItemId, {
        item_id: lineItemId,
        quantity: Number.parseInt(lineItemQty, 10),
        unit_cost: lineItemUnitCost,
        notes: lineItemNotes || undefined,
      })
    } else {
      await receiptsApi.lineItems.create(id, {
        item_id: lineItemId,
        quantity: Number.parseInt(lineItemQty, 10),
        unit_cost: lineItemUnitCost,
        notes: lineItemNotes || undefined,
      })
    }

    queryClient.invalidateQueries({ queryKey: ["receipts", id, "line-items"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setLineItemDialogOpen(false)
    resetLineItemForm()
  }

  const handleEditLineItem = (line: ReceiptLineItem) => {
    setEditingLineItemId(line.id)
    setLineItemId(line.item_id)
    setLineItemQty(String(line.quantity))
    setLineItemUnitCost(Number.parseFloat(line.unit_cost).toFixed(2))
    setLineItemNotes(line.notes || "")
    setLineItemDialogOpen(true)
  }

  const handleDeleteLineItem = async (line: ReceiptLineItem) => {
    if (!id) return
    if (!confirm(`Delete line item ${line.item_name}?`)) return
    await receiptsApi.lineItems.delete(id, line.id)
    queryClient.invalidateQueries({ queryKey: ["receipts", id, "line-items"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingPurchaseId) {
      await updatePurchase.mutateAsync({
        id: editingPurchaseId,
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        destination_id: destinationId || undefined,
        invoice_id: invoiceId || undefined,
        clear_invoice: !invoiceId,
        receipt_id: id,
        notes: purchaseNotes || undefined,
      })
    } else {
      await createPurchase.mutateAsync({
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        destination_id: destinationId || undefined,
        invoice_id: invoiceId || undefined,
        receipt_id: id,
        notes: purchaseNotes || undefined,
      })
    }
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setIsOpen(false)
    resetForm()
  }

  const handleEdit = (p: (typeof purchases)[0]) => {
    setEditingPurchaseId(p.purchase_id)
    const matchedItem = items.find((i) => i.name === p.item_name)
    setItemId(matchedItem?.id || "")
    setQuantity(String(p.quantity))
    setPurchaseCost(Number.parseFloat(p.purchase_cost).toFixed(2))
    const matchedDest = destinations.find((d) => d.code === p.destination_code)
    setDestinationId(matchedDest?.id || "")
    setInvoiceId(p.invoice_id || "")
    setPurchaseNotes("")
    setIsOpen(true)
  }

  const handleStatusChange = async (purchaseId: string, newStatus: string) => {
    await updatePurchase.mutateAsync({ id: purchaseId, status: newStatus })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
  }

  const handleDelete = async (purchaseId: string) => {
    if (confirm("Delete this line item?")) {
      await deletePurchase.mutateAsync(purchaseId)
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
    }
  }

  const handleItemChange = (selectedItemId: string) => {
    setItemId(selectedItemId)
    const item = items.find((i) => i.id === selectedItemId)
    if (item) {
      if (item.default_destination_id) {
        setDestinationId(item.default_destination_id)
      }
    }
  }

  const handleUploadPdf = async () => {
    if (!id) return
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

  if (loadingReceipt || loadingPurchases)
    return <div className="text-muted-foreground">Loading...</div>
  if (!receipt) return <div className="text-red-600">Receipt not found</div>

  // Compute summary stats
  const totalCost = purchases.reduce(
    (sum, p) => sum + parseFloat(p.total_cost || "0"),
    0
  )
  const unlinkedCount = purchases.filter((p) => !p.invoice_id).length
  const receiptSubtotal = parseFloat(receipt.subtotal)
  const costDifference = receiptSubtotal - totalCost
  const isCostMatched = Math.abs(costDifference) < 0.01
  const allInvoiced = purchases.length > 0 && unlinkedCount === 0
  const fullyReconciled = isCostMatched && allInvoiced && purchases.length > 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/receipts")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">
            Receipt {receipt.receipt_number}
          </h1>
          <p className="text-muted-foreground">
            {receipt.vendor_name} • {formatDate(receipt.receipt_date)}
          </p>
          <div className="flex gap-2 mt-2">
            {fullyReconciled ? (
              <span className="flex items-center gap-1 text-green-600 bg-green-50 px-3 py-1.5 rounded-full text-sm font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Reconciled
              </span>
            ) : (
              <>
                {!isCostMatched && (
                  <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
                    <AlertCircle className="h-4 w-4" />
                    {purchases.length === 0 ? "No items" : `${formatCurrency(Math.abs(costDifference))} ${costDifference > 0 ? "unaccounted" : "over"}`}
                  </span>
                )}
                {purchases.length > 0 && !allInvoiced && (
                  <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
                    <AlertCircle className="h-4 w-4" />
                    {purchases.length - unlinkedCount}/{purchases.length} invoiced
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {receipt.has_pdf ? (
            <Button
              variant="outline"
              onClick={() => {
                const token = localStorage.getItem('token')
                const url = receiptsApi.downloadPdfUrl(id!)
                fetch(url, { headers: { Authorization: `Bearer ${token}` } })
                  .then(res => res.blob())
                  .then(blob => {
                    const blobUrl = URL.createObjectURL(blob)
                    window.open(blobUrl, '_blank')
                  })
              }}
            >
                <FileText className="h-4 w-4 mr-2" />
                View Document
            </Button>
          ) : (
            <Button variant="outline" onClick={handleUploadPdf}>
              <Upload className="h-4 w-4 mr-2" />
              Upload Document
            </Button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {formatCurrency(receipt.subtotal)}
            </div>
            <p className="text-sm text-muted-foreground">Receipt Subtotal</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {formatCurrency(receipt.total)}
            </div>
            <p className="text-sm text-muted-foreground">
              Receipt Total ({formatNumber(receipt.tax_rate)}% HST)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {formatCurrency(totalCost.toFixed(2))}
            </div>
            <p className="text-sm text-muted-foreground">Items Cost</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{purchases.length}</div>
            <p className="text-sm text-muted-foreground">Line Items</p>
          </CardContent>
        </Card>
      </div>

      {/* Line Items Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Receipt Line Items (Source of Truth)</CardTitle>
          <Dialog
            open={lineItemDialogOpen}
            onOpenChange={(open) => {
              setLineItemDialogOpen(open)
              if (!open) resetLineItemForm()
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" onClick={resetLineItemForm}>
                <Plus className="h-4 w-4 mr-2" />
                Add Receipt Line
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingLineItemId ? "Edit Receipt Line" : "Add Receipt Line"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleLineItemSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label>Item *</Label>
                  <Select value={lineItemId} onValueChange={setLineItemId} required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select item" />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((it) => (
                        <SelectItem key={it.id} value={it.id}>
                          {it.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Quantity *</Label>
                    <Input type="number" min={1} value={lineItemQty} onChange={(e) => setLineItemQty(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label>Unit Cost *</Label>
                    <Input type="number" step="0.01" value={lineItemUnitCost} onChange={(e) => setLineItemUnitCost(e.target.value)} required />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <Input value={lineItemNotes} onChange={(e) => setLineItemNotes(e.target.value)} />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setLineItemDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit">{editingLineItemId ? "Save" : "Add"}</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {loadingReceiptLineItems ? (
            <p className="text-muted-foreground">Loading receipt lines...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Allocated</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="w-20">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receiptLineItems.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-medium">{line.item_name}</TableCell>
                    <TableCell className="text-right">{line.quantity}</TableCell>
                    <TableCell className="text-right">{line.allocated_qty}</TableCell>
                    <TableCell className={`text-right ${line.remaining_qty < 0 ? "text-red-600" : ""}`}>{line.remaining_qty}</TableCell>
                    <TableCell className="text-right">{formatCurrency(line.unit_cost)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(line.unit_cost) * line.quantity)}</TableCell>
                    <TableCell className="text-muted-foreground">{line.notes || "-"}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" onClick={() => handleEditLineItem(line)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-red-600"
                          onClick={() => handleDeleteLineItem(line)}
                          disabled={line.allocated_qty > 0}
                          title={line.allocated_qty > 0 ? "Cannot delete while allocated" : "Delete"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {receiptLineItems.length === 0 && (
                  <EmptyTableRow colSpan={8} message="No receipt lines yet" />
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Line Items ({purchases.length})</CardTitle>
          <Dialog
            open={isOpen}
            onOpenChange={(open) => {
              setIsOpen(open)
              if (!open) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingPurchaseId ? "Edit Line Item" : "Add Line Item"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="item">Item *</Label>
                  <Select
                    value={itemId}
                    onValueChange={handleItemChange}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select item" />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
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
                      required
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
                  <Label htmlFor="invoice">Invoice</Label>
                  <Select
                    value={invoiceId || "__none__"}
                    onValueChange={(v) =>
                      setInvoiceId(v === "__none__" ? "" : v)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select invoice" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        <span className="text-muted-foreground">
                          — No invoice
                        </span>
                      </SelectItem>
                      {invoices.map((inv) => (
                        <SelectItem key={inv.id} value={inv.id}>
                          {inv.invoice_number} - {formatCurrency(inv.total)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Input
                    id="notes"
                    value={purchaseNotes}
                    onChange={(e) => setPurchaseNotes(e.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      createPurchase.isPending || updatePurchase.isPending
                    }
                  >
                    {editingPurchaseId ? "Save Changes" : "Add"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Dest</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
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
                  <TableCell>{p.destination_code || "—"}</TableCell>
                  <TableCell>
                    {p.invoice_id ? (
                      <Link
                        to={`/invoices/${p.invoice_id}`}
                        className="text-blue-600 hover:underline font-mono text-xs"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.invoice_number || "linked"}
                      </Link>
                    ) : (
                      <span className="text-red-500 text-xs flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        unlinked
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{p.quantity}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatCurrency(p.total_cost)}
                  </TableCell>
                  <TableCell>
                    <StatusSelect
                      value={p.status}
                      onValueChange={(value) =>
                        handleStatusChange(p.purchase_id, value)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleEdit(p)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-600"
                        onClick={() => handleDelete(p.purchase_id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {purchases.length === 0 && (
                <EmptyTableRow colSpan={7} message="No line items yet" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
