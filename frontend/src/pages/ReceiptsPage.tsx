import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useReceipts,
  useCreateReceipt,
  useUpdateReceipt,
  useDeleteReceipt,
  useVendors,
} from "@/hooks/useApi"
import { receipts as receiptsApi } from "@/api"
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
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { Plus, Trash2, Pencil, FileText, Upload, CheckCircle2, AlertCircle, Clock } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"

type Receipt = ReturnType<typeof useReceipts>["data"] extends (infer T)[] | undefined ? T : never

function ReconciliationBadge({ receipt }: { receipt: Receipt }) {
  const subtotal = parseFloat(receipt.subtotal)
  const purchasesTotal = parseFloat(receipt.purchases_total || "0")
  const difference = Math.abs(subtotal - purchasesTotal)
  const count = receipt.purchase_count || 0
  const invoicedCount = receipt.invoiced_count || 0
  const allInvoiced = count > 0 && invoicedCount === count
  const totalsMatched = difference < 0.01

  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
        <Clock className="h-3 w-3" />
        No items
      </span>
    )
  }

  if (totalsMatched && allInvoiced) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded-full">
        <CheckCircle2 className="h-3 w-3" />
        Reconciled
      </span>
    )
  }

  const issues: string[] = []
  if (!totalsMatched) issues.push(`${formatCurrency(difference)} off`)
  if (!allInvoiced) issues.push(`${invoicedCount}/${count} invoiced`)

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
      <AlertCircle className="h-3 w-3" />
      {issues.join(" · ")}
    </span>
  )
}

export default function ReceiptsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: allReceipts = [], isLoading } = useReceipts()
  const { data: vendors = [] } = useVendors()

  const createReceipt = useCreateReceipt()
  const updateReceipt = useUpdateReceipt()
  const deleteReceipt = useDeleteReceipt()

  const [isOpen, setIsOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [vendorId, setVendorId] = useState("")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [receiptDate, setReceiptDate] = useState("")
  const [subtotal, setSubtotal] = useState("")
  const [taxAmount, setTaxAmount] = useState("")
  const [notes, setNotes] = useState("")
  const [vendorFilter, setVendorFilter] = useState<string>("")

  const filteredReceipts = vendorFilter
    ? allReceipts.filter((r) => r.vendor_id === vendorFilter)
    : allReceipts

  const resetForm = () => {
    setEditingId(null)
    setVendorId("")
    setReceiptNumber("")
    setReceiptDate("")
    setSubtotal("")
    setTaxAmount("")
    setNotes("")
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingId) {
      await updateReceipt.mutateAsync({
        id: editingId,
        vendor_id: vendorId,
        receipt_number: receiptNumber,
        receipt_date: receiptDate,
        subtotal,
        tax_amount: taxAmount,
        notes: notes || undefined,
      })
    } else {
      await createReceipt.mutateAsync({
        vendor_id: vendorId,
        ...(receiptNumber.trim() ? { receipt_number: receiptNumber.trim() } : {}),
        receipt_date: receiptDate,
        subtotal,
        tax_amount: taxAmount,
        notes: notes || undefined,
      })
    }
    setIsOpen(false)
    resetForm()
  }

  const handleEdit = (r: (typeof allReceipts)[0]) => {
    setEditingId(r.id)
    setVendorId(r.vendor_id)
    setReceiptNumber(r.receipt_number)
    setReceiptDate(r.receipt_date)
    setSubtotal(r.subtotal)
    setTaxAmount((parseFloat(r.total) - parseFloat(r.subtotal)).toFixed(2))
    setNotes(r.notes || "")
    setIsOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this receipt?")) {
      await deleteReceipt.mutateAsync(id)
    }
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

  // Summary stats
  const totalReceipts = filteredReceipts.length
  const totalSpent = filteredReceipts.reduce(
    (sum, r) => sum + parseFloat(r.total || "0"),
    0
  )
  const unreconciledCount = filteredReceipts.filter(r => {
    const count = r.purchase_count || 0
    if (count === 0) return false
    const diff = Math.abs(parseFloat(r.subtotal) - parseFloat(r.purchases_total || "0"))
    const totalsMatched = diff < 0.01
    const allInvoiced = (r.invoiced_count || 0) === count
    return !totalsMatched || !allInvoiced
  }).length

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
              { header: "Tax Rate", accessor: (r) => r.tax_rate },
              { header: "Total", accessor: (r) => r.total },
              { header: "Purchase Count", accessor: (r) => r.purchase_count },
              { header: "Purchases Total", accessor: (r) => r.purchases_total },
              { header: "Has Document", accessor: (r) => r.has_pdf ? "Yes" : "No" },
              { header: "Notes", accessor: (r) => r.notes },
            ]}
            data={filteredReceipts}
          />
          <Dialog
            open={isOpen}
            onOpenChange={(open) => {
              setIsOpen(open)
              if (!open) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Receipt
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingId ? "Edit Receipt" : "Add Receipt"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="vendor">Vendor *</Label>
                  <Select
                    value={vendorId}
                    onValueChange={setVendorId}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="receiptNumber">Receipt Number</Label>
                  <Input
                    id="receiptNumber"
                    value={receiptNumber}
                    onChange={(e) => setReceiptNumber(e.target.value)}
                    placeholder="Auto-generated if empty"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="receiptDate">Receipt Date *</Label>
                  <Input
                    id="receiptDate"
                    type="date"
                    value={receiptDate}
                    onChange={(e) => setReceiptDate(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="subtotal">Subtotal *</Label>
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
                  <div className="space-y-2">
                    <Label htmlFor="taxAmount">Tax Amount *</Label>
                    <Input
                      id="taxAmount"
                      type="number"
                      step="0.01"
                      value={taxAmount}
                      onChange={(e) => setTaxAmount(e.target.value)}
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
                    placeholder="Optional notes..."
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
                      createReceipt.isPending || updateReceipt.isPending
                    }
                  >
                    {editingId ? "Save Changes" : "Create"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalReceipts}</div>
            <p className="text-sm text-muted-foreground">Total Receipts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatCurrency(totalSpent.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Total Spent (incl. tax)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className={`text-2xl font-bold ${unreconciledCount > 0 ? "text-amber-600" : "text-green-600"}`}>
              {unreconciledCount}
            </div>
            <p className="text-sm text-muted-foreground">Unreconciled</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="w-48">
              <Label className="mb-2 block">Vendor</Label>
              <Select
                value={vendorFilter || "all"}
                onValueChange={(v) => setVendorFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All vendors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All vendors</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Receipts Table */}
      <Card>
        <CardHeader>
          <CardTitle>Receipts ({filteredReceipts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Receipt #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>PDF</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReceipts.map((r) => {
                const taxAmount =
                  parseFloat(r.total || "0") - parseFloat(r.subtotal || "0")
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/receipts/${r.id}`)}
                  >
                    <TableCell>{formatDate(r.receipt_date)}</TableCell>
                    <TableCell className="font-mono font-medium">
                      {r.receipt_number}
                    </TableCell>
                    <TableCell>{r.vendor_name}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(r.subtotal)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCurrency(taxAmount.toFixed(2))}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(r.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.purchase_count || 0}
                    </TableCell>
                    <TableCell>
                      <ReconciliationBadge receipt={r} />
                    </TableCell>
                    <TableCell>
                      {r.has_pdf ? (
                        <FileText className="h-4 w-4 text-blue-600" />
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleUploadPdf(r.id)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Upload className="h-4 w-4" />
                        </button>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleEdit(r)
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-red-600"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(r.id)
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredReceipts.length === 0 && (
                <EmptyTableRow colSpan={10} message="No receipts yet" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
