import { useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  usePurchases,
  useCreatePurchase,
  useUpdatePurchase,
  useDeletePurchase,
  useItems,
  useDestinations,
  useInvoices,
  useReceipts,
  useItemPurchases,
} from "@/hooks/useApi"
import { importApi, type PurchasePreview, type PreviewRow } from "@/api"
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
import { ImportDialog } from "@/components/ImportDialog"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { StatusSelect } from "@/components/StatusSelect"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { Plus, Trash2, Pencil, AlertCircle } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { PURCHASE_STATUSES } from "@/lib/constants"
import { assessPurchaseReconciliation } from "@/lib/purchaseReconciliation"

function PurchasePreviewTable({ rows }: { rows: PreviewRow<PurchasePreview>[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Row</TableHead>
          <TableHead>Item</TableHead>
          <TableHead>Vendor</TableHead>
          <TableHead>Qty</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Dest</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.row}>
            <TableCell className="text-muted-foreground">{row.row}</TableCell>
            <TableCell>{row.data.item_name}</TableCell>
            <TableCell>{row.data.vendor_name || "-"}</TableCell>
            <TableCell>{row.data.quantity}</TableCell>
            <TableCell>${row.data.purchase_cost}</TableCell>
            <TableCell className="font-mono">{row.data.destination_code || "-"}</TableCell>
            <TableCell>{row.data.date}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}


export default function PurchasesPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [destFilter, setDestFilter] = useState<string>("")
  const [isImporting, setIsImporting] = useState(false)
  
  const { data: purchases = [], isLoading } = usePurchases({
    status: statusFilter || undefined,
    destination_id: destFilter || undefined,
  })
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const { data: invoices = [] } = useInvoices()
  const { data: allReceipts = [] } = useReceipts()
  
  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()

  const [isOpen, setIsOpen] = useState(false)
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null)
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [purchaseCost, setPurchaseCost] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [invoiceId, setInvoiceId] = useState("")
  const [receiptId, setReceiptId] = useState("")
  const [notes, setNotes] = useState("")
  const [refundsPurchaseId, setRefundsPurchaseId] = useState("")
  const [purchaseType, setPurchaseType] = useState("unit")
  const [bonusForPurchaseId, setBonusForPurchaseId] = useState("")

  const parsedQty = parseInt(quantity)
  const isRefund = !Number.isNaN(parsedQty) && parsedQty < 0
  const isBonus = purchaseType === "bonus"
  const { data: itemPurchases = [] } = useItemPurchases(itemId)
  const refundCandidates = itemPurchases.filter(
    (p) => p.quantity > 0 && p.purchase_id !== editingPurchaseId
  )
  const bonusCandidates = itemPurchases.filter(
    (p) => p.quantity > 0 && p.purchase_type !== "bonus" && p.purchase_id !== editingPurchaseId
  )

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
        receipt_id: receiptId || undefined,
        clear_receipt: !receiptId,
        notes: notes || undefined,
        refunds_purchase_id: refundsPurchaseId || undefined,
        clear_refunds_purchase: !refundsPurchaseId,
        purchase_type: purchaseType,
        bonus_for_purchase_id: bonusForPurchaseId || undefined,
        clear_bonus_for_purchase: !bonusForPurchaseId,
      })
    } else {
      await createPurchase.mutateAsync({
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: purchaseCost,
        destination_id: destinationId || undefined,
        invoice_id: invoiceId || undefined,
        receipt_id: receiptId || undefined,
        notes: notes || undefined,
        refunds_purchase_id: refundsPurchaseId || undefined,
        purchase_type: purchaseType,
        bonus_for_purchase_id: bonusForPurchaseId || undefined,
      })
    }
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
    setDestinationId("")
    setInvoiceId("")
    setReceiptId("")
    setNotes("")
    setRefundsPurchaseId("")
    setPurchaseType("unit")
    setBonusForPurchaseId("")
  }

  const handleEdit = (p: typeof purchases[0]) => {
    setEditingPurchaseId(p.purchase_id)
    const matchedItem = items.find((i) => i.name === p.item_name)
    setItemId(matchedItem?.id || "")
    setQuantity(String(p.quantity))
    setPurchaseCost(p.purchase_cost)
    const matchedDest = destinations.find((d) => d.code === p.destination_code)
    setDestinationId(matchedDest?.id || "")
    setInvoiceId(p.invoice_id || "")
    setReceiptId(p.receipt_id || "")
    setNotes("")
    setRefundsPurchaseId(p.refunds_purchase_id || "")
    setPurchaseType(p.purchase_type || "unit")
    setBonusForPurchaseId(p.bonus_for_purchase_id || "")
    setIsOpen(true)
  }

  const handleStatusChange = async (purchaseId: string, newStatus: string) => {
    await updatePurchase.mutateAsync({ id: purchaseId, status: newStatus })
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this purchase?")) {
      await deletePurchase.mutateAsync(id)
    }
  }

  // Auto-fill destination when item is selected
  const handleItemChange = (id: string) => {
    setItemId(id)
    const item = items.find((i) => i.id === id)
    if (item) {
      if (item.default_destination_id) {
        setDestinationId(item.default_destination_id)
      }
    }
  }

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Purchases</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="purchases"
            columns={[
              { header: "Date", accessor: (p) => p.purchase_date?.split("T")[0] },
              { header: "Item", accessor: (p) => p.item_name },
              { header: "Vendor", accessor: (p) => p.vendor_name || "" },
              { header: "Destination", accessor: (p) => p.destination_code },
              { header: "Quantity", accessor: (p) => p.quantity },
              { header: "Purchase Cost", accessor: (p) => p.purchase_cost },
              { header: "Total Cost", accessor: (p) => p.total_cost },
              { header: "Invoice Unit Price", accessor: (p) => p.invoice_unit_price },
              { header: "Total Price", accessor: (p) => p.total_selling },
              { header: "Commission", accessor: (p) => p.total_commission },
              { header: "Receipt", accessor: (p) => p.receipt_number },
              { header: "Invoice", accessor: (p) => p.invoice_number },
              { header: "Status", accessor: (p) => p.status },
              { header: "Delivery Date", accessor: (p) => p.delivery_date },
              { header: "Notes", accessor: (p) => p.notes },
              { header: "Type", accessor: (p) => p.purchase_type },
            ]}
            data={purchases}
          />
          <ImportDialog<PurchasePreview>
            entityName="Purchases"
            columns={[
              { name: "item", required: true, description: "Item name (must exist)" },
              { name: "quantity", required: true, description: "Quantity purchased" },
              { name: "purchase_cost", required: true, description: "Cost per unit" },
              { name: "destination", required: false, description: "Destination code" },
              { name: "date", required: false, description: "Purchase date (YYYY-MM-DD)" },
              { name: "invoice", required: false, description: "Invoice number (must exist)" },
              { name: "receipt", required: false, description: "Receipt number (must exist)" },
              { name: "invoice_unit_price", required: false, description: "Invoice unit price" },
              { name: "status", required: false, description: "pending/in_transit/delivered/damaged/returned/lost" },
              { name: "delivery_date", required: false, description: "Delivery date (YYYY-MM-DD)" },
              { name: "notes", required: false, description: "Optional notes" },
            ]}
            exampleCsv="item,quantity,purchase_cost,destination,date,invoice,receipt,invoice_unit_price,status\nWidget A,10,9.99,CBG,2024-01-15,INV-001,REC-001,12.99,delivered"
            onPreview={importApi.purchasesPreview}
            onImport={async (csv) => {
              setIsImporting(true)
              try {
                return await importApi.purchases(csv)
              } finally {
                setIsImporting(false)
              }
            }}
            renderPreviewTable={(rows) => <PurchasePreviewTable rows={rows} />}
            isPending={isImporting}
            onSuccess={() => queryClient.invalidateQueries({ queryKey: ["purchases"] })}
          />
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open)
            if (!open) resetForm()
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Purchase
              </Button>
            </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingPurchaseId ? "Edit Purchase" : "Add Purchase"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="item">Item *</Label>
                <Select value={itemId} onValueChange={handleItemChange} required>
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
                    placeholder="0.00"
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
                <Select value={invoiceId || "__none__"} onValueChange={(v) => setInvoiceId(v === "__none__" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select invoice" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— No invoice</span>
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
                <Label htmlFor="receipt">Receipt</Label>
                <Select value={receiptId || "__none__"} onValueChange={(v) => setReceiptId(v === "__none__" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select receipt" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— No receipt</span>
                    </SelectItem>
                    {allReceipts.map((rec) => (
                      <SelectItem key={rec.id} value={rec.id}>
                        {rec.receipt_number} - {rec.vendor_name} - {formatCurrency(rec.total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Purchase Type</Label>
                <Select value={purchaseType} onValueChange={setPurchaseType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unit">Unit (physical item)</SelectItem>
                    <SelectItem value="bonus">Bonus (promo freebie)</SelectItem>
                    <SelectItem value="refund">Refund (credit/return)</SelectItem>
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
              {isRefund && (
                <div className="space-y-2">
                  <Label htmlFor="refundsPurchase">Refunds Purchase</Label>
                  <Select
                    value={refundsPurchaseId || "__none__"}
                    onValueChange={(v) => setRefundsPurchaseId(v === "__none__" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Link to original purchase" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {refundCandidates.map((p) => (
                        <SelectItem key={p.purchase_id} value={p.purchase_id}>
                          {p.item_name} × {p.quantity} — {p.invoice_number || p.receipt_number || "unlinked"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Link this credit to the original purchase being refunded.
                  </p>
                </div>
              )}
              {isBonus && (
                <div className="space-y-2">
                  <Label htmlFor="bonusForPurchase">Attribute Bonus To</Label>
                  <Select
                    value={bonusForPurchaseId || "__none__"}
                    onValueChange={(v) => setBonusForPurchaseId(v === "__none__" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Link to parent purchase" />
                    </SelectTrigger>
                    <SelectContent>
                      {bonusCandidates.map((p) => (
                        <SelectItem key={p.purchase_id} value={p.purchase_id}>
                          {p.item_name} × {p.quantity} — {p.invoice_number || p.receipt_number || "unlinked"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Link this bonus to a parent purchase to boost its commission.
                  </p>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createPurchase.isPending || updatePurchase.isPending}>
                  {editingPurchaseId ? "Save Changes" : "Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="w-48">
              <Label className="mb-2 block">Status</Label>
              <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {PURCHASE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-48">
              <Label className="mb-2 block">Destination</Label>
              <Select value={destFilter || "all"} onValueChange={(v) => setDestFilter(v === "all" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="All destinations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All destinations</SelectItem>
                  {destinations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Purchase Economics ({purchases.length} records)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Dest</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Selling</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead>Reconciliation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.map((p) => {
                const reconciliation = assessPurchaseReconciliation({
                  quantity: p.quantity,
                  purchase_cost: p.purchase_cost,
                  receipt_id: p.receipt_id,
                  invoice_id: p.invoice_id,
                  invoice_unit_price: p.invoice_unit_price,
                  destination_code: p.destination_code,
                })
                const isUnlinked = !p.receipt_id && !p.invoice_id
                return (
                <TableRow key={p.purchase_id} className={isUnlinked ? "bg-red-50" : (!reconciliation.isReconciled ? "bg-amber-50/40" : "")}>
                  <TableCell>{formatDate(p.purchase_date)}</TableCell>
                  <TableCell className="font-medium">
                    <Link to={`/items/${p.item_id}`} className="hover:underline text-primary">
                      {p.item_name}
                    </Link>
                    {p.purchase_type && p.purchase_type !== "unit" && (
                      <span className={`ml-1 text-[10px] px-1 py-0.5 rounded ${p.purchase_type === "bonus" ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"}`}>
                        {p.purchase_type}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{p.vendor_name || "-"}</TableCell>
                  <TableCell>{p.destination_code || "-"}</TableCell>
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
                        none
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.invoice_id ? (
                      <Link
                        to={`/invoices/${p.invoice_id}`}
                        className="text-xs font-mono text-blue-600 hover:underline"
                      >
                        {p.invoice_number || "linked"}
                      </Link>
                    ) : (
                      <span className="text-red-500 text-xs flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        none
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{p.quantity}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatCurrency(p.total_cost)}</TableCell>
                  <TableCell className="text-right">{p.total_selling ? formatCurrency(p.total_selling) : "-"}</TableCell>
                  <TableCell className={`text-right ${p.total_commission ? (parseFloat(p.total_commission) >= 0 ? "text-green-600" : "text-red-600") : ""}`}>
                    {p.total_commission ? formatCurrency(p.total_commission) : "-"}
                  </TableCell>
                  <TableCell>
                    {reconciliation.isReconciled ? (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                        Reconciled
                      </span>
                    ) : (
                      <div className="space-y-1">
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                          Needs attention
                        </span>
                        {reconciliation.reasons.slice(0, 2).map((reason) => (
                          <div key={reason} className="text-[11px] text-amber-700">
                            {reason}
                          </div>
                        ))}
                        {reconciliation.reasons.length > 2 && (
                          <div className="text-[11px] text-muted-foreground">
                            +{reconciliation.reasons.length - 2} more
                          </div>
                        )}
                      </div>
                    )}
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
                )
              })}
              {purchases.length === 0 && <EmptyTableRow colSpan={13} message="No purchases yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
