import { Fragment, useEffect, useState, useRef } from "react"
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
import { ArrowLeft, Plus, Trash2, Pencil, CheckCircle2, AlertCircle, Package, FileDown, Upload, Loader2, ChevronDown, ChevronRight } from "lucide-react"
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils"
import { ApiError, invoices as invoicesApi, receipts as receiptsApi, purchases as purchasesApi, type PurchaseAllocation, type ReceiptLineItem } from "@/api"

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
  const [invoiceUnitPrice, setInvoiceUnitPrice] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [notes, setNotes] = useState("")

  // Receipt-link dialog (focused, not the full edit form)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkingPurchaseId, setLinkingPurchaseId] = useState<string | null>(null)
  const [linkingPurchase, setLinkingPurchase] = useState<InvoicePurchase | null>(null)
  const [allocations, setAllocations] = useState<PurchaseAllocation[]>([])
  const [allocationsByPurchase, setAllocationsByPurchase] = useState<Record<string, PurchaseAllocation[]>>({})
  const [loadingAllocations, setLoadingAllocations] = useState(false)
  const [allocationError, setAllocationError] = useState("")
  const [allocationWarning, setAllocationWarning] = useState("")
  const [editingAllocationId, setEditingAllocationId] = useState<string | null>(null)
  const [allocationReceiptId, setAllocationReceiptId] = useState("")
  const [allocationReceiptLineItemId, setAllocationReceiptLineItemId] = useState("")
  const [allocationReceiptLineItems, setAllocationReceiptLineItems] = useState<ReceiptLineItem[]>([])
  const [allocationQty, setAllocationQty] = useState("1")
  const [allocationUnitCost, setAllocationUnitCost] = useState("")
  const [showNewReceipt, setShowNewReceipt] = useState(false)
  const [newRcptVendorId, setNewRcptVendorId] = useState("")
  const [newRcptNumber, setNewRcptNumber] = useState("")
  const [newRcptDate, setNewRcptDate] = useState("")
  const [newRcptSubtotal, setNewRcptSubtotal] = useState("")
  const [newRcptTaxAmount, setNewRcptTaxAmount] = useState("")
  const [newRcptFile, setNewRcptFile] = useState<File | null>(null)
  const [linkNotes, setLinkNotes] = useState("")
  const [expandedAllocations, setExpandedAllocations] = useState<Record<string, boolean>>({})
  const [allocationApiUnavailable, setAllocationApiUnavailable] = useState(false)

  const buildLegacyAllocations = (purchase: InvoicePurchase): PurchaseAllocation[] => {
    if (!purchase.receipt_id) return []
    const receipt = receipts.find((r) => r.id === purchase.receipt_id)
    return [{
      id: `legacy-${purchase.purchase_id}`,
      purchase_id: purchase.purchase_id,
      receipt_id: purchase.receipt_id,
      receipt_line_item_id: null,
      item_id: purchase.item_id,
      item_name: purchase.item_name,
      allocated_qty: purchase.quantity,
      unit_cost: purchase.purchase_cost || "0",
      receipt_number: purchase.receipt_number || receipt?.receipt_number || "linked",
      vendor_name: purchase.vendor_name || receipt?.vendor_name || "Unknown vendor",
      receipt_date: receipt?.receipt_date || purchase.purchase_date,
      created_at: purchase.purchase_date,
      updated_at: purchase.purchase_date,
    }]
  }

  const getEffectiveAllocations = (purchase: InvoicePurchase): PurchaseAllocation[] => {
    const rows = allocationsByPurchase[purchase.purchase_id] || []
    if (rows.length > 0) return rows
    return buildLegacyAllocations(purchase)
  }

  const getDisplayPurchaseCosts = (purchase: InvoicePurchase) => {
    const allocs = getEffectiveAllocations(purchase)
    const allocatedQty = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
    const allocatedTotalCost = allocs.reduce(
      (sum, a) => sum + Number.parseFloat(a.unit_cost || "0") * a.allocated_qty,
      0
    )

    if (allocs.length > 0 && allocatedQty === purchase.quantity && allocatedQty > 0) {
      return {
        unitCost: allocatedTotalCost / allocatedQty,
      }
    }

    return {
      unitCost: Number.parseFloat(purchase.purchase_cost || "0"),
    }
  }

  useEffect(() => {
    const load = async () => {
      if (!purchases.length) {
        setAllocationsByPurchase({})
        return
      }
      try {
        const entries = await Promise.all(
          purchases.map(async (p) => {
            try {
              const rows = await purchasesApi.allocations.list(p.purchase_id)
              return [p.purchase_id, rows] as const
            } catch (err) {
              if (err instanceof ApiError && err.status === 404) {
                setAllocationApiUnavailable(true)
                return [p.purchase_id, []] as const
              }
              throw err
            }
          })
        )
        setAllocationsByPurchase(Object.fromEntries(entries))
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to load receipt allocations")
      }
    }

    load()
  }, [purchases])

  const resetAllocationForm = () => {
    setEditingAllocationId(null)
    setAllocationReceiptId("")
    setAllocationReceiptLineItemId("")
    setAllocationReceiptLineItems([])
    setAllocationQty("1")
    setAllocationUnitCost("")
    setAllocationError("")
    setAllocationWarning("")
  }

  const openLinkDialog = (purchase: InvoicePurchase) => {
    setLinkingPurchaseId(purchase.purchase_id)
    setLinkingPurchase(purchase)
    setLinkNotes(purchase.notes || "")
    setLoadingAllocations(true)
    const existing = getEffectiveAllocations(purchase)
    setAllocations(existing)
    resetAllocationForm()
    setAllocationUnitCost("")
    setShowNewReceipt(false)
    setNewRcptFile(null)
    setLinkDialogOpen(true)
    setLoadingAllocations(false)
  }

  const resetNewReceiptForm = () => {
    setNewRcptVendorId("")
    setNewRcptNumber("")
    setNewRcptDate("")
    setNewRcptSubtotal("")
    setNewRcptTaxAmount("")
    setNewRcptFile(null)
  }

  const reloadAllocations = async (purchaseId: string) => {
    setLoadingAllocations(true)
    let rows: PurchaseAllocation[] = []
    try {
      rows = await purchasesApi.allocations.list(purchaseId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAllocationApiUnavailable(true)
        rows = []
      } else {
        setLoadingAllocations(false)
        throw err
      }
    }
    setAllocations(rows)
    setAllocationsByPurchase(prev => ({ ...prev, [purchaseId]: rows }))
    setLoadingAllocations(false)
  }

  const loadReceiptLineItemsForAllocation = async (receiptId: string, purchase: InvoicePurchase) => {
    const rows = await receiptsApi.lineItems.list(receiptId)
    const sameItemRows = rows.filter((row) => row.item_id === purchase.item_id)
    setAllocationReceiptLineItems(sameItemRows)

    if (sameItemRows.length === 0) {
      setAllocationReceiptLineItemId("")
      setAllocationUnitCost("")
      setAllocationWarning("Selected receipt has no line item for this product. Use Edit Receipt.")
      return
    }

    const candidate = sameItemRows[0]
    setAllocationReceiptLineItemId(candidate.id)
    setAllocationUnitCost(Number.parseFloat(candidate.unit_cost).toFixed(2))
    setAllocationWarning("")
  }

  const handleAllocationReceiptChange = async (value: string) => {
    const selectedReceiptId = value === "__none__" ? "" : value
    setAllocationReceiptId(selectedReceiptId)
    setAllocationReceiptLineItemId("")
    setAllocationReceiptLineItems([])
    setAllocationWarning("")
    setAllocationError("")

    if (!selectedReceiptId || !linkingPurchase) return

    try {
      await loadReceiptLineItemsForAllocation(selectedReceiptId, linkingPurchase)
    } catch {
      setAllocationUnitCost("")
      setAllocationWarning("Could not read receipt line items for this receipt.")
    }
  }

  const handleAllocationReceiptLineItemChange = (value: string) => {
    const selectedId = value === "__none__" ? "" : value
    setAllocationReceiptLineItemId(selectedId)
    setAllocationWarning("")
    setAllocationError("")

    if (!selectedId) {
      setAllocationUnitCost("")
      return
    }

    const line = allocationReceiptLineItems.find((row) => row.id === selectedId)
    if (!line) {
      setAllocationUnitCost("")
      return
    }

    setAllocationUnitCost(Number.parseFloat(line.unit_cost).toFixed(2))

    const requestedQty = Number.parseInt(allocationQty || "0", 10)
    if (requestedQty > line.remaining_qty) {
      setAllocationWarning(`Requested qty (${requestedQty}) exceeds remaining receipt qty (${line.remaining_qty}).`)
    }
  }

  const handleSaveAllocation = async () => {
    if (!linkingPurchaseId || !linkingPurchase) return

    const qty = Number.parseInt(allocationQty || "0", 10)
    let unitCost = allocationUnitCost.trim()
    if (!allocationReceiptId) {
      setAllocationError("Select a receipt")
      return
    }
    if (!qty || qty <= 0) {
      setAllocationError("Allocated quantity must be greater than zero")
      return
    }
    if (!allocationReceiptLineItemId) {
      setAllocationError("Select a receipt line item before allocating.")
      return
    }

    const selectedLineItem = allocationReceiptLineItems.find((row) => row.id === allocationReceiptLineItemId)
    if (!selectedLineItem) {
      setAllocationError("Selected receipt line item is unavailable. Reload and try again.")
      return
    }

    if (qty > selectedLineItem.remaining_qty) {
      setAllocationError(`Allocated qty (${qty}) exceeds remaining receipt qty (${selectedLineItem.remaining_qty}).`)
      return
    }

    if (!selectedLineItem.unit_cost) {
      setAllocationError("Unit cost must come from receipt line items. Use Edit Receipt to set it.")
      return
    }

    unitCost = Number.parseFloat(selectedLineItem.unit_cost).toFixed(2)
    setAllocationUnitCost(unitCost)

    const usedByOther = allocations
      .filter(a => a.id !== editingAllocationId)
      .reduce((sum, a) => sum + a.allocated_qty, 0)
    if (usedByOther + qty > linkingPurchase.quantity) {
      setAllocationError(`Allocated qty exceeds line quantity (${usedByOther + qty}/${linkingPurchase.quantity})`)
      return
    }

    try {
      if (editingAllocationId) {
        await purchasesApi.allocations.update(linkingPurchaseId, editingAllocationId, {
          receipt_line_item_id: allocationReceiptLineItemId,
          allocated_qty: qty,
        })
      } else {
        await purchasesApi.allocations.create(linkingPurchaseId, {
          receipt_line_item_id: allocationReceiptLineItemId,
          allocated_qty: qty,
        })
      }

      await updatePurchase.mutateAsync({
        id: linkingPurchaseId,
        notes: linkNotes || undefined,
      })

      await reloadAllocations(linkingPurchaseId)
      resetAllocationForm()
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAllocationApiUnavailable(true)
        setAllocationError("Allocation API is unavailable on this backend instance. Please restart backend and retry.")
        return
      }
      setAllocationError(err instanceof Error ? err.message : "Failed to save allocation")
    }
  }

  const handleDeleteAllocation = async (allocationId: string) => {
    if (!linkingPurchaseId) return
    await purchasesApi.allocations.delete(linkingPurchaseId, allocationId)
    await reloadAllocations(linkingPurchaseId)
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
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
    setAllocationReceiptId(newReceipt.id)
    await reloadAllocations(linkingPurchaseId)
    if (linkingPurchase) {
      const remaining = Math.max(1, linkingPurchase.quantity - totalAllocatedQty)
      setAllocationQty(String(remaining))
    }
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setShowNewReceipt(false)
    resetNewReceiptForm()
  }

  const totalAllocatedQty = allocations.reduce((sum, a) => sum + a.allocated_qty, 0)

  const toggleAllocationDrilldown = (purchaseId: string) => {
    setExpandedAllocations((prev) => ({
      ...prev,
      [purchaseId]: !prev[purchaseId],
    }))
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
        invoice_unit_price: invoiceUnitPrice || undefined,
        destination_id: destinationId || undefined,
        invoice_id: id,
        notes: notes || undefined,
      })
    } else {
      await createPurchase.mutateAsync({
        item_id: itemId,
        quantity: parseInt(quantity),
        purchase_cost: "0",
        invoice_unit_price: invoiceUnitPrice || undefined,
        destination_id: destinationId || undefined,
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
    setInvoiceUnitPrice("")
    setDestinationId("")
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
    setInvoiceUnitPrice(p.invoice_unit_price ? Number.parseFloat(p.invoice_unit_price).toFixed(2) : "")
    // Find destination by code
    const matchedDest = destinations.find((d) => d.code === p.destination_code)
    setDestinationId(matchedDest?.id || "")
    setNotes(p.notes || "")
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
              +{formatNumber(invoice.tax_rate)}% tax = {formatCurrency(invoice.total)}
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
                    <div className="space-y-2 col-span-2">
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
                  <div className="text-xs text-muted-foreground bg-muted p-3 rounded-md">
                    Stage 1 (invoice line): quantity and invoice price only. Purchase cost is assigned during receipt allocation (Stage 2).
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
                {purchases.map((p) => {
                  const allocs = getEffectiveAllocations(p)
                  const allocated = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
                  const isPartiallyAllocated = allocated > 0 && allocated < p.quantity
                  const isExpanded = isPartiallyAllocated || !!expandedAllocations[p.purchase_id]
                  const displayCosts = getDisplayPurchaseCosts(p)

                  return (
                    <Fragment key={p.purchase_id}>
                      <TableRow>
                        <TableCell className="font-medium">
                          <Link to={`/items/${p.item_id}`} className="hover:underline text-primary">
                            {p.item_name}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono">{p.destination_code || "-"}</TableCell>
                        <TableCell>
                          {allocs.length > 0 ? (
                            <div className="space-y-1">
                              <div className="text-xs text-emerald-700 font-medium">{allocated}/{p.quantity} allocated</div>
                              <div className="text-[11px] text-muted-foreground">{allocs.length} receipt link{allocs.length > 1 ? "s" : ""}</div>
                              <div className="flex items-center gap-3">
                                {isPartiallyAllocated ? (
                                  <span className="text-[11px] text-amber-700 inline-flex items-center gap-1">
                                    <ChevronDown className="h-3 w-3" />
                                    partially allocated (auto-expanded)
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => toggleAllocationDrilldown(p.purchase_id)}
                                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                                    title="Show allocation breakdown"
                                  >
                                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                    {isExpanded ? "hide breakdown" : "view breakdown"}
                                  </button>
                                )}
                                <button
                                  onClick={() => openLinkDialog(p)}
                                  className="text-[11px] text-muted-foreground hover:underline"
                                  title="Manage allocations"
                                >
                                  manage allocations
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => openLinkDialog(p)}
                              className="text-red-500 text-xs flex items-center gap-1 hover:underline cursor-pointer"
                              title="Click to allocate to receipts"
                            >
                              <AlertCircle className="h-3 w-3" />
                              unallocated
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{p.quantity}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatCurrency(displayCosts.unitCost)}</TableCell>
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

                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={10} className="bg-muted/30 py-3">
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Allocation Breakdown
                              </div>
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
                              <div className="text-xs text-muted-foreground">
                                Total allocated on this line: {allocated}/{p.quantity} units
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
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
            {allocationApiUnavailable && (
              <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Allocation endpoints are unavailable on this backend session (404). Showing legacy receipt links where present.
              </div>
            )}
      </Card>

      {/* Focused Receipt Link Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={(open) => {
        setLinkDialogOpen(open)
        if (!open) {
          setShowNewReceipt(false)
          setLinkingPurchase(null)
          setLinkingPurchaseId(null)
          setAllocations([])
          resetAllocationForm()
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
                <div className="text-muted-foreground">
                  Already allocated: {totalAllocatedQty}
                </div>
              </div>

              {allocationError && (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                  {allocationError}
                </div>
              )}

              {allocationWarning && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700">
                  {allocationWarning}
                </div>
              )}

              {loadingAllocations ? (
                <p className="text-sm text-muted-foreground">Loading allocations...</p>
              ) : allocations.length > 0 ? (
                <div className="space-y-2">
                  <Label>Current Allocations</Label>
                  <div className="border rounded-md divide-y">
                    {allocations.map((a) => (
                      <div key={a.id} className="p-3 text-sm flex items-center justify-between gap-2">
                        <div>
                          <div className="font-medium">{a.receipt_number} - {a.vendor_name}</div>
                          <div className="text-muted-foreground">Qty {a.allocated_qty} × {formatCurrency(a.unit_cost)}</div>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              setEditingAllocationId(a.id)
                              setAllocationReceiptId(a.receipt_id)
                              setAllocationQty(String(a.allocated_qty))
                              setAllocationUnitCost(Number.parseFloat(a.unit_cost).toFixed(2))
                              if (linkingPurchase) {
                                await loadReceiptLineItemsForAllocation(a.receipt_id, linkingPurchase)
                              }
                              if (a.receipt_line_item_id) {
                                setAllocationReceiptLineItemId(a.receipt_line_item_id)
                              }
                              setAllocationError("")
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-red-600"
                            onClick={() => handleDeleteAllocation(a.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No allocations yet.</p>
              )}

              <div className="space-y-2">
                <Label>Receipt</Label>
                <Select
                  value={allocationReceiptId || "__none__"}
                  onValueChange={handleAllocationReceiptChange}
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
                  value={allocationQty}
                  onChange={(e) => setAllocationQty(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Receipt Line Item *</Label>
                <Select
                  value={allocationReceiptLineItemId || "__none__"}
                  onValueChange={handleAllocationReceiptLineItemChange}
                  disabled={!allocationReceiptId}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder={allocationReceiptId ? "Select receipt line item" : "Select receipt first"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— No line item selected</span>
                    </SelectItem>
                    {allocationReceiptLineItems.map((line) => (
                      <SelectItem key={line.id} value={line.id}>
                        {line.item_name} · {line.remaining_qty}/{line.quantity} remaining @ {formatCurrency(line.unit_cost)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Unit Cost *</Label>
                <Input
                  className="w-full min-w-0"
                  type="number"
                  step="0.01"
                  value={allocationUnitCost}
                  readOnly
                />
                <p className="text-xs text-muted-foreground">Derived from receipt line items. Edit in receipt if correction is needed.</p>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Input className="w-full min-w-0" value={linkNotes} onChange={(e) => setLinkNotes(e.target.value)} placeholder="e.g. Used gift card, price adjusted..." />
              </div>
              <div className="flex justify-between">
                <div className="flex items-center gap-3">
                  <Button
                    variant="link"
                    className="px-0 text-emerald-600"
                    onClick={() => setShowNewReceipt(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    New Receipt
                  </Button>
                  {allocationReceiptId && (
                    <Button
                      type="button"
                      variant="link"
                      className="px-0"
                      onClick={() => navigate(`/receipts/${allocationReceiptId}`)}
                    >
                      Edit Receipt
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {editingAllocationId && (
                    <Button variant="outline" onClick={resetAllocationForm}>
                      Reset
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleSaveAllocation} disabled={updatePurchase.isPending || createReceipt.isPending}>
                    {updatePurchase.isPending || createReceipt.isPending
                      ? "Saving..."
                      : editingAllocationId
                        ? "Update Allocation"
                        : "Add Allocation"}
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
