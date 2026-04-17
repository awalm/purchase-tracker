import { Fragment, useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useItem,
  useItemPurchases,
  useUpdatePurchase,
  useReceipts,
  useInvoices,
  useVendors,
  useCreateReceipt,
  useDestinations,
  useCreateInvoice,
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
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ReceiptForm, type ReceiptFormSubmitData } from "@/components/ReceiptForm"
import { ArrowLeft, Package, AlertCircle, Plus, Upload, ChevronDown, ChevronRight } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { assessPurchaseReconciliation } from "@/lib/purchaseReconciliation"
import { ApiError, purchases as purchasesApi, receipts as receiptsApi, type PurchaseAllocation } from "@/api"

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: item, isLoading: itemLoading } = useItem(id || "")
  const { data: purchases = [], isLoading: purchasesLoading } = useItemPurchases(id || "")
  const { data: receipts = [] } = useReceipts()
  const { data: invoices = [] } = useInvoices()
  const { data: vendors = [] } = useVendors()
  const { data: destinations = [] } = useDestinations()
  const updatePurchase = useUpdatePurchase()
  const createReceipt = useCreateReceipt()
  const createInvoice = useCreateInvoice()

  // Linking dialog state
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkingPurchaseId, setLinkingPurchaseId] = useState<string | null>(null)
  const [linkType, setLinkType] = useState<"receipt" | "invoice">("receipt")
  const [selectedLinkId, setSelectedLinkId] = useState("")
  const [showNewForm, setShowNewForm] = useState(false)
  const [linkNotes, setLinkNotes] = useState("")

  // New invoice inline form
  const [newInvDestId, setNewInvDestId] = useState("")
  const [newInvNumber, setNewInvNumber] = useState("")
  const [newInvDate, setNewInvDate] = useState("")
  const [newInvSubtotal, setNewInvSubtotal] = useState("")
  const [newInvTaxRate, setNewInvTaxRate] = useState("13.00")
  const [allocationsByPurchase, setAllocationsByPurchase] = useState<Record<string, PurchaseAllocation[]>>({})
  const [expandedAllocations, setExpandedAllocations] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const loadAllocations = async () => {
      if (!purchases.length) {
        setAllocationsByPurchase({})
        return
      }

      const entries = await Promise.all(
        purchases.map(async (p) => {
          try {
            const rows = await purchasesApi.allocations.list(p.purchase_id)
            return [p.purchase_id, rows] as const
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return [p.purchase_id, []] as const
            }
            throw err
          }
        })
      )

      setAllocationsByPurchase(Object.fromEntries(entries))
    }

    loadAllocations().catch((err) => {
      alert(err instanceof Error ? err.message : "Failed to load allocations")
    })
  }, [purchases])

  const getEffectiveAllocations = (p: (typeof purchases)[0]): PurchaseAllocation[] => {
    const rows = allocationsByPurchase[p.purchase_id] || []
    if (rows.length > 0) return rows
    if (!p.receipt_id) return []

    const receipt = receipts.find((r) => r.id === p.receipt_id)
    return [{
      id: `legacy-${p.purchase_id}`,
      purchase_id: p.purchase_id,
      receipt_id: p.receipt_id,
      receipt_line_item_id: null,
      item_id: p.item_id,
      item_name: p.item_name,
      allocated_qty: p.quantity,
      unit_cost: p.purchase_cost || "0",
      receipt_number: p.receipt_number || receipt?.receipt_number || "linked",
      vendor_name: p.vendor_name || receipt?.vendor_name || "Unknown vendor",
      receipt_date: receipt?.receipt_date || p.purchase_date,
      created_at: p.purchase_date,
      updated_at: p.purchase_date,
    }]
  }

  const getDisplayCosts = (p: (typeof purchases)[0]) => {
    const allocs = getEffectiveAllocations(p)
    const allocatedQty = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
    const allocatedTotalCost = allocs.reduce(
      (sum, a) => sum + Number.parseFloat(a.unit_cost || "0") * a.allocated_qty,
      0
    )

    if (allocs.length > 0 && allocatedQty === p.quantity && allocatedQty > 0) {
      return {
        unitCost: allocatedTotalCost / allocatedQty,
        totalCost: allocatedTotalCost,
      }
    }

    const totalCost = Number.parseFloat(p.total_cost || "0")
    const unitCost = Number.parseFloat(p.purchase_cost || "0")
    const effectiveUnitCost =
      unitCost === 0 && totalCost > 0 && p.quantity > 0
        ? totalCost / p.quantity
        : unitCost

    return {
      unitCost: effectiveUnitCost,
      totalCost,
    }
  }

  const toggleAllocationDrilldown = (purchaseId: string) => {
    setExpandedAllocations((prev) => ({ ...prev, [purchaseId]: !prev[purchaseId] }))
  }

  const resetNewForms = () => {
    setNewInvDestId(""); setNewInvNumber(""); setNewInvDate(""); setNewInvSubtotal(""); setNewInvTaxRate("13.00")
    setLinkNotes("")
  }

  const openLinkDialog = (purchaseId: string, type: "receipt" | "invoice", currentId?: string | null, currentNotes?: string | null) => {
    setLinkingPurchaseId(purchaseId)
    setLinkType(type)
    setSelectedLinkId(currentId || "")
    setLinkNotes(currentNotes || "")
    setShowNewForm(false)
    resetNewForms()
    setLinkDialogOpen(true)
  }

  const handleLink = async () => {
    if (!linkingPurchaseId) return
    const update: Record<string, unknown> = { id: linkingPurchaseId }
    if (linkType === "receipt") {
      update.receipt_id = selectedLinkId || undefined
      update.clear_receipt = !selectedLinkId
    } else {
      update.invoice_id = selectedLinkId || undefined
      update.clear_invoice = !selectedLinkId
    }
    if (linkNotes) update.notes = linkNotes
    await updatePurchase.mutateAsync(update as { id: string } & Record<string, unknown>)
    queryClient.invalidateQueries({ queryKey: ["item", id, "purchases"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    setLinkDialogOpen(false)
  }

  const handleCreateReceiptAndLink = async (data: ReceiptFormSubmitData) => {
    if (!linkingPurchaseId) return

    const createdReceipt = await createReceipt.mutateAsync({
      vendor_id: data.vendor_id,
      ...(data.receipt_number.trim() ? { receipt_number: data.receipt_number.trim() } : {}),
      receipt_date: data.receipt_date,
      subtotal: data.subtotal,
      tax_amount: data.tax_amount,
      payment_card_last4: data.payment_card_last4.trim() || undefined,
      notes: data.notes || undefined,
    })

    if (data.document_file) {
      await receiptsApi.uploadPdf(createdReceipt.id, data.document_file)
    }

    await updatePurchase.mutateAsync({
      id: linkingPurchaseId,
      receipt_id: createdReceipt.id,
      ...(linkNotes ? { notes: linkNotes } : {}),
    })

    queryClient.invalidateQueries({ queryKey: ["item", id, "purchases"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    setLinkDialogOpen(false)
    resetNewForms()
  }

  const handleCreateInvoiceAndLink = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!linkingPurchaseId) return

    const inv = await createInvoice.mutateAsync({
      destination_id: newInvDestId,
      invoice_number: newInvNumber,
      invoice_date: newInvDate,
      subtotal: newInvSubtotal,
      tax_rate: newInvTaxRate,
    })

    await updatePurchase.mutateAsync({
      id: linkingPurchaseId,
      invoice_id: inv.id,
      ...(linkNotes ? { notes: linkNotes } : {}),
    })

    queryClient.invalidateQueries({ queryKey: ["item", id, "purchases"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    setLinkDialogOpen(false)
    resetNewForms()
  }

  if (itemLoading) return <div className="text-muted-foreground">Loading...</div>
  if (!item) return <div className="text-muted-foreground">Item not found</div>

  const totalQuantity = purchases.reduce((sum, p) => sum + p.quantity, 0)
  const totalCost = purchases.reduce((sum, p) => sum + getDisplayCosts(p).totalCost, 0)
  const totalSelling = purchases.reduce((sum, p) => sum + parseFloat(p.total_selling || "0"), 0)
  const totalCommission = purchases.reduce((sum, p) => sum + parseFloat(p.total_commission || "0"), 0)
  const linkedReceipts = new Set(purchases.filter((p) => p.receipt_id).map((p) => p.receipt_id))
  const linkedInvoices = new Set(purchases.filter((p) => p.invoice_id).map((p) => p.invoice_id))
  const unlinkedReceiptCount = purchases.filter((p) => !p.receipt_id).length
  const unlinkedInvoiceCount = purchases.filter((p) => !p.invoice_id).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/items")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{item.name}</h1>
          <p className="text-muted-foreground">
            {item.notes || ""}
          </p>
        </div>
        <ExportCsvButton
          filename={`item-${item.name}-purchases`}
          columns={[
            { header: "Date", accessor: (p) => formatDate(p.purchase_date) },
            { header: "Destination", accessor: (p) => p.destination_code || "" },
            { header: "Receipt", accessor: (p) => p.receipt_number || "" },
            { header: "Invoice", accessor: (p) => p.invoice_number || "" },
            { header: "Qty", accessor: (p) => p.quantity },
            { header: "Purchase Cost", accessor: (p) => p.purchase_cost },
            { header: "Total Cost", accessor: (p) => p.total_cost || "" },
            { header: "Invoice Unit Price", accessor: (p) => p.invoice_unit_price || "" },
            { header: "Total Selling", accessor: (p) => p.total_selling || "" },
            { header: "Commission", accessor: (p) => p.total_commission || "" },
            { header: "Status", accessor: (p) => p.status },
            { header: "Delivery Date", accessor: (p) => p.delivery_date || "" },
            { header: "Notes", accessor: (p) => p.notes || "" },
          ]}
          data={purchases}
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-6 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{purchases.length}</div>
            <p className="text-sm text-muted-foreground">Purchases</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalQuantity}</div>
            <p className="text-sm text-muted-foreground">Total Qty</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatCurrency(totalCost.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Total Cost</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatCurrency(totalSelling.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Total Revenue</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className={`text-2xl font-bold ${totalCommission >= 0 ? "text-green-600" : "text-red-600"}`}>
              {formatCurrency(totalCommission.toFixed(2))}
            </div>
            <p className="text-sm text-muted-foreground">Total Profit</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {linkedReceipts.size} / {linkedInvoices.size}
            </div>
            <p className="text-sm text-muted-foreground">Receipts / Invoices</p>
          </CardContent>
        </Card>
      </div>

      {(unlinkedReceiptCount > 0 || unlinkedInvoiceCount > 0) && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          <AlertCircle className="h-4 w-4" />
          {unlinkedReceiptCount > 0 && `${unlinkedReceiptCount} purchase(s) missing receipt`}
          {unlinkedReceiptCount > 0 && unlinkedInvoiceCount > 0 && " · "}
          {unlinkedInvoiceCount > 0 && `${unlinkedInvoiceCount} purchase(s) missing invoice`}
        </div>
      )}

      {/* Purchase History */}
      <Card>
        <CardHeader>
          <CardTitle>Purchase History ({purchases.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {purchasesLoading ? (
            <p className="text-muted-foreground">Loading purchases...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Dest</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Allocations</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                  <TableHead className="text-right">Selling</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Reconciliation</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => {
                  const allocs = getEffectiveAllocations(p)
                  const totalAllocated = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
                  const isExpanded = !!expandedAllocations[p.purchase_id]
                  const displayCosts = getDisplayCosts(p)
                  const reconciliation = assessPurchaseReconciliation({
                    quantity: p.quantity,
                    purchase_cost: p.purchase_cost,
                    receipt_id: p.receipt_id,
                    invoice_id: p.invoice_id,
                    invoice_unit_price: p.invoice_unit_price,
                    destination_code: p.destination_code,
                    requireAllocations: true,
                    allocationCount: allocs.length,
                    allocatedQty: totalAllocated,
                  })

                  return (
                  <Fragment key={p.purchase_id}>
                    <TableRow>
                    <TableCell className="text-sm">{formatDate(p.purchase_date)}</TableCell>
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
                        <button
                          onClick={() => openLinkDialog(p.purchase_id, "receipt", p.receipt_id, p.notes)}
                          className="text-red-500 text-xs flex items-center gap-1 hover:underline cursor-pointer"
                          title="Click to link a receipt"
                        >
                          <AlertCircle className="h-3 w-3" />
                          none
                        </button>
                      )}
                    </TableCell>
                    <TableCell>
                      {allocs.length > 0 ? (
                        <button
                          onClick={() => toggleAllocationDrilldown(p.purchase_id)}
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {totalAllocated}/{p.quantity}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">none</span>
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
                        <button
                          onClick={() => openLinkDialog(p.purchase_id, "invoice", p.invoice_id, p.notes)}
                          className="text-red-500 text-xs flex items-center gap-1 hover:underline cursor-pointer"
                          title="Click to link an invoice"
                        >
                          <AlertCircle className="h-3 w-3" />
                          none
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{p.quantity}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(displayCosts.unitCost)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(displayCosts.totalCost)}</TableCell>
                    <TableCell className="text-right">{p.invoice_unit_price ? formatCurrency(p.invoice_unit_price) : "-"}</TableCell>
                    <TableCell className={`text-right ${p.total_commission ? (parseFloat(p.total_commission) >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
                      {p.total_commission ? formatCurrency(p.total_commission) : "—"}
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
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        p.status === "delivered" ? "bg-green-100 text-green-700" :
                        p.status === "in_transit" ? "bg-blue-100 text-blue-700" :
                        p.status === "cancelled" ? "bg-red-100 text-red-700" :
                        "bg-gray-100 text-gray-700"
                      }`}>
                        {p.status.replace("_", " ")}
                      </span>
                    </TableCell>
                  </TableRow>

                  {isExpanded && allocs.length > 0 && (
                    <TableRow>
                      <TableCell colSpan={12} className="bg-muted/30 py-2">
                        <div className="border rounded-md bg-background overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Receipt</TableHead>
                                <TableHead>Vendor</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Qty</TableHead>
                                <TableHead className="text-right">Unit Cost</TableHead>
                                <TableHead className="text-right">Allocated Total</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {allocs.map((a) => (
                                <TableRow key={a.id}>
                                  <TableCell>
                                    <Link to={`/receipts/${a.receipt_id}`} className="text-primary hover:underline font-mono text-xs">
                                      {a.receipt_number}
                                    </Link>
                                  </TableCell>
                                  <TableCell>{a.vendor_name}</TableCell>
                                  <TableCell>{formatDate(a.receipt_date)}</TableCell>
                                  <TableCell className="text-right">{a.allocated_qty}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(a.unit_cost)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(Number(a.unit_cost) * a.allocated_qty)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                )})}
                {purchases.length === 0 && (
                  <EmptyTableRow colSpan={12}>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Package className="h-8 w-8" />
                      <p>No purchases for this item yet</p>
                    </div>
                  </EmptyTableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Link Receipt/Invoice Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={(open) => {
        setLinkDialogOpen(open)
        if (!open) { setShowNewForm(false); resetNewForms() }
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {showNewForm
                ? linkType === "receipt" ? "Add Receipt" : "New Invoice"
                : linkType === "receipt" ? "Link Receipt" : "Link Invoice"}
            </DialogTitle>
          </DialogHeader>
          {showNewForm ? (
            linkType === "receipt" ? (
              <ReceiptForm
                open={showNewForm && linkType === "receipt"}
                vendors={vendors}
                requireDocument
                submitLabel="Create & Link"
                submittingLabel="Creating..."
                isSubmitting={createReceipt.isPending || updatePurchase.isPending}
                onSubmit={handleCreateReceiptAndLink}
                onCancel={() => setLinkDialogOpen(false)}
                onBack={() => setShowNewForm(false)}
                onImport={() => {
                  setLinkDialogOpen(false)
                  navigate("/receipts?import=1")
                }}
                importButtonLabel="Import Receipt"
              />
            ) : (
              <form onSubmit={handleCreateInvoiceAndLink} className="space-y-4">
                <div className="space-y-2">
                  <Label>Destination *</Label>
                  <Select value={newInvDestId} onValueChange={setNewInvDestId} required>
                    <SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger>
                    <SelectContent>
                      {destinations.map((d) => <SelectItem key={d.id} value={d.id}>{d.code} - {d.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Invoice Number *</Label>
                  <Input value={newInvNumber} onChange={(e) => setNewInvNumber(e.target.value)} placeholder="INV-001" required />
                </div>
                <div className="space-y-2">
                  <Label>Date *</Label>
                  <Input type="date" value={newInvDate} onChange={(e) => setNewInvDate(e.target.value)} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Subtotal *</Label>
                    <Input type="number" step="0.01" value={newInvSubtotal} onChange={(e) => setNewInvSubtotal(e.target.value)} placeholder="0.00" required />
                  </div>
                  <div className="space-y-2">
                    <Label>Tax %</Label>
                    <Input type="number" step="0.01" value={newInvTaxRate} onChange={(e) => setNewInvTaxRate(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <Input value={linkNotes} onChange={(e) => setLinkNotes(e.target.value)} placeholder="e.g. Used gift card, price adjusted..." />
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Button type="button" variant="link" className="px-0 self-start" onClick={() => setShowNewForm(false)}>← Back</Button>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                    <Button type="submit" disabled={createInvoice.isPending}>{createInvoice.isPending ? "Creating..." : "Create & Link"}</Button>
                  </div>
                </div>
              </form>
            )
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{linkType === "receipt" ? "Receipt" : "Invoice"}</Label>
                <Select
                  value={selectedLinkId || "__none__"}
                  onValueChange={(v) => setSelectedLinkId(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={`Select ${linkType}`} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— None</span>
                    </SelectItem>
                    {linkType === "receipt"
                      ? receipts.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.receipt_number} - {r.vendor_name} ({formatCurrency(r.total)})
                          </SelectItem>
                        ))
                      : invoices.map((inv) => (
                          <SelectItem key={inv.id} value={inv.id}>
                            {inv.invoice_number} - {inv.destination_code} ({formatCurrency(inv.total)})
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Input value={linkNotes} onChange={(e) => setLinkNotes(e.target.value)} placeholder="e.g. Used gift card, price adjusted..." />
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  {linkType === "receipt" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setLinkDialogOpen(false)
                          navigate("/receipts?import=1")
                        }}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Import Receipt
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowNewForm(true)}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Receipt
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="link"
                      className="px-0 text-emerald-600"
                      onClick={() => setShowNewForm(true)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      New Invoice
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleLink} disabled={updatePurchase.isPending}>
                    {updatePurchase.isPending ? "Saving..." : "Save"}
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
