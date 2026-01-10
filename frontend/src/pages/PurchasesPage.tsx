import { useState } from "react"
import {
  usePurchases,
  useCreatePurchase,
  useUpdatePurchase,
  useDeletePurchase,
  useItems,
  useDestinations,
  useInvoices,
} from "@/hooks/useApi"
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
import { Plus, Trash2 } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { StatusBadge } from "@/components/ui/status-badge"

const STATUSES = ["pending", "in_transit", "delivered", "damaged", "returned", "lost"]

export default function PurchasesPage() {
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [destFilter, setDestFilter] = useState<string>("")
  
  const { data: purchases = [], isLoading } = usePurchases({
    status: statusFilter || undefined,
    destination_id: destFilter || undefined,
  })
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const { data: invoices = [] } = useInvoices()
  
  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()

  const [isOpen, setIsOpen] = useState(false)
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [unitCost, setUnitCost] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [invoiceId, setInvoiceId] = useState("")
  const [notes, setNotes] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await createPurchase.mutateAsync({
      item_id: itemId,
      quantity: parseInt(quantity),
      unit_cost: unitCost,
      destination_id: destinationId || undefined,
      invoice_id: invoiceId || undefined,
      notes: notes || undefined,
    })
    setIsOpen(false)
    resetForm()
  }

  const resetForm = () => {
    setItemId("")
    setQuantity("1")
    setUnitCost("")
    setDestinationId("")
    setInvoiceId("")
    setNotes("")
  }

  const handleStatusChange = async (purchaseId: string, newStatus: string) => {
    await updatePurchase.mutateAsync({ id: purchaseId, status: newStatus })
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this purchase?")) {
      await deletePurchase.mutateAsync(id)
    }
  }

  // Auto-fill unit cost when item is selected
  const handleItemChange = (id: string) => {
    setItemId(id)
    const item = items.find((i) => i.id === id)
    if (item) {
      setUnitCost(item.unit_cost)
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
              <DialogTitle>Add Purchase</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="item">Item</Label>
                <Select value={itemId} onValueChange={handleItemChange} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select item" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name} ({i.vendor_name}) - {formatCurrency(i.unit_cost)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unitCost">Unit Cost</Label>
                  <Input
                    id="unitCost"
                    type="number"
                    step="0.01"
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
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
                <Label htmlFor="invoice">Invoice (optional)</Label>
                <Select value={invoiceId} onValueChange={setInvoiceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select invoice" />
                  </SelectTrigger>
                  <SelectContent>
                    {invoices.map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        {inv.invoice_number} - {formatCurrency(inv.total)}
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
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createPurchase.isPending}>
                  Create
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="w-48">
              <Label className="mb-2 block">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All statuses</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-48">
              <Label className="mb-2 block">Destination</Label>
              <Select value={destFilter} onValueChange={setDestFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="All destinations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All destinations</SelectItem>
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
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Payout</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.map((p) => (
                <TableRow key={p.purchase_id}>
                  <TableCell>{formatDate(p.purchase_date)}</TableCell>
                  <TableCell className="font-medium">{p.item_name}</TableCell>
                  <TableCell>{p.vendor_name}</TableCell>
                  <TableCell>{p.destination_code || "-"}</TableCell>
                  <TableCell className="text-right">{p.quantity}</TableCell>
                  <TableCell className="text-right">{formatCurrency(p.total_cost)}</TableCell>
                  <TableCell className="text-right">
                    {p.payout_price ? formatCurrency(p.total_revenue) : "-"}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${
                      parseFloat(p.total_profit || "0") >= 0
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {p.total_profit ? formatCurrency(p.total_profit) : "-"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.status}
                      onValueChange={(value) => handleStatusChange(p.purchase_id, value)}
                    >
                      <SelectTrigger className="w-28 h-8">
                        <StatusBadge status={p.status} />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.replace("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => handleDelete(p.purchase_id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {purchases.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    No purchases yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
