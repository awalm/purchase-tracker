import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useReceipt,
  useReceiptPurchases,
  useCreatePurchase,
  useUpdateReceipt,
  useUpdatePurchase,
  useDeletePurchase,
  useItems,
  useDestinations,
  useInvoices,
} from "@/hooks/useApi"
import { receipts as receiptsApi, purchases as purchasesApi, type ReceiptLineItem } from "@/api"
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
import { assessPurchaseReconciliation } from "@/lib/purchaseReconciliation"
import { truncateOptionLabel } from "@/lib/receiptImportValidation"

const METADATA_AUDIT_PRIORITY_KEYS = [
  "source",
  "auto_parsed",
  "parse_engine",
  "parse_version",
  "confidence_score",
  "raw_vendor_name",
  "warnings",
  "ingested_at",
  "ingestion_version",
]

function toMetadataRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function getChangedMetadataKeys(oldMetadata: unknown, newMetadata: unknown): string[] {
  const oldRecord = toMetadataRecord(oldMetadata)
  const newRecord = toMetadataRecord(newMetadata)

  const allKeys = new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])
  const changedKeys = Array.from(allKeys).filter((key) => {
    const oldValue = oldRecord[key]
    const newValue = newRecord[key]
    return JSON.stringify(oldValue) !== JSON.stringify(newValue)
  })

  return changedKeys.sort((a, b) => {
    const aIndex = METADATA_AUDIT_PRIORITY_KEYS.indexOf(a)
    const bIndex = METADATA_AUDIT_PRIORITY_KEYS.indexOf(b)

    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b)
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })
}

function formatAuditActor(userId: string): string {
  if (!userId) return "unknown"
  return `${userId.slice(0, 8)}...`
}

export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: receipt, isLoading: loadingReceipt } = useReceipt(id || "")
  const {
    data: purchases = [],
    isLoading: loadingPurchases,
    isError: purchasesLoadError,
    error: purchasesLoadErrorDetail,
  } = useReceiptPurchases(id || "")
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const { data: invoices = [] } = useInvoices()

  const createPurchase = useCreatePurchase()
  const updateReceipt = useUpdateReceipt()
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

  const {
    data: metadataAuditHistory = [],
    isLoading: loadingMetadataAudit,
    isError: metadataAuditError,
  } = useQuery({
    queryKey: ["receipts", id, "metadata-audit"],
    queryFn: () => receiptsApi.metadataAudit(id || ""),
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
  const [selectedReceiptLineId, setSelectedReceiptLineId] = useState("")
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [purchaseCost, setPurchaseCost] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [invoiceId, setInvoiceId] = useState("")
  const [purchaseNotes, setPurchaseNotes] = useState("")
  const [isEditingMetadata, setIsEditingMetadata] = useState(false)
  const [metadataDraft, setMetadataDraft] = useState("")
  const [metadataError, setMetadataError] = useState("")

  const resetForm = () => {
    setEditingPurchaseId(null)
    setSelectedReceiptLineId("")
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
    const parsedQty = parseInt(quantity, 10)

    if (Number.isNaN(parsedQty) || parsedQty <= 0) {
      alert("Quantity must be greater than zero")
      return
    }

    if (editingPurchaseId) {
      await updatePurchase.mutateAsync({
        id: editingPurchaseId,
        destination_id: destinationId || undefined,
        invoice_id: invoiceId || undefined,
        clear_invoice: !invoiceId,
        notes: purchaseNotes || undefined,
      })
    } else {
      const sourceLine = receiptLineItems.find((line) => line.id === selectedReceiptLineId)
      if (!sourceLine) {
        alert("Select a receipt line before adding a purchase")
        return
      }

      const allocatableQty = Math.min(parsedQty, sourceLine.remaining_qty)
      if (allocatableQty <= 0) {
        alert(`No remaining quantity is available on ${sourceLine.item_name}`)
        return
      }

      const createdPurchase = await createPurchase.mutateAsync({
        item_id: sourceLine.item_id,
        quantity: allocatableQty,
        purchase_cost: sourceLine.unit_cost,
        destination_id: destinationId || undefined,
        invoice_id: invoiceId || undefined,
        receipt_id: id,
        notes: purchaseNotes || undefined,
      })

      await purchasesApi.allocations.create(createdPurchase.id, {
        receipt_line_item_id: sourceLine.id,
        allocated_qty: allocatableQty,
      })
    }
    queryClient.invalidateQueries({ queryKey: ["receipts", id, "line-items"] })
    queryClient.invalidateQueries({ queryKey: ["receipts", id, "purchases"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setIsOpen(false)
    resetForm()

    if (invoiceId) {
      navigate(`/invoices/${invoiceId}`)
    }
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
    setSelectedReceiptLineId("")
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

  const handleSelectReceiptLine = (selectedLineId: string) => {
    setSelectedReceiptLineId(selectedLineId)
    const selectedLine = receiptLineItems.find((line) => line.id === selectedLineId)
    if (!selectedLine) return

    handleItemChange(selectedLine.item_id)
    setPurchaseCost(Number.parseFloat(selectedLine.unit_cost).toFixed(2))
    setQuantity(String(Math.max(1, selectedLine.remaining_qty)))
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

  useEffect(() => {
    if (!receipt) return
    setMetadataDraft(JSON.stringify(receipt.ingestion_metadata || {}, null, 2))
    setMetadataError("")
    setIsEditingMetadata(false)
  }, [receipt?.id, receipt?.updated_at])

  const handleSaveMetadata = async () => {
    if (!id) return

    try {
      const parsed = metadataDraft.trim() ? JSON.parse(metadataDraft) : {}
      await updateReceipt.mutateAsync({
        id,
        ingestion_metadata: parsed,
      })
      await queryClient.invalidateQueries({ queryKey: ["receipts", id] })
      await queryClient.invalidateQueries({ queryKey: ["receipts"] })
      await queryClient.invalidateQueries({ queryKey: ["receipts", id, "metadata-audit"] })
      setIsEditingMetadata(false)
      setMetadataError("")
    } catch (err) {
      if (err instanceof SyntaxError) {
        setMetadataError(`Invalid JSON: ${err.message}`)
        return
      }
      setMetadataError(err instanceof Error ? err.message : "Failed to save metadata")
    }
  }

  const handleCancelMetadataEdit = () => {
    setMetadataDraft(JSON.stringify(receipt?.ingestion_metadata || {}, null, 2))
    setMetadataError("")
    setIsEditingMetadata(false)
  }

  if (loadingReceipt)
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
  const metadata = receipt.ingestion_metadata
  const metadataSource = metadata?.source || "manual"
  const metadataWarnings = metadata?.warnings || []
  const metadataUpdateHistory = metadataAuditHistory.filter(
    (entry) => entry.operation === "update"
  )
  const latestMetadataAudit = metadataAuditHistory[0]
  const creatableReceiptLines = receiptLineItems.filter((line) => line.remaining_qty > 0)
  const selectedReceiptLine = receiptLineItems.find((line) => line.id === selectedReceiptLineId)

  return (
    <div className="flex flex-col gap-6">
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
                    {loadingPurchases
                      ? "Loading linked purchases..."
                      : purchasesLoadError
                        ? "Linked purchases unavailable"
                        : purchases.length === 0
                          ? "No linked purchases"
                          : `${formatCurrency(Math.abs(costDifference))} ${costDifference > 0 ? "unaccounted" : "over"}`}
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
            <p className="text-sm text-muted-foreground">Linked Purchases</p>
          </CardContent>
        </Card>
      </div>

      <Card className="order-last">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Ingestion Metadata</CardTitle>
          {isEditingMetadata ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCancelMetadataEdit}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveMetadata}
                disabled={updateReceipt.isPending}
              >
                {updateReceipt.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setMetadataDraft(JSON.stringify(receipt.ingestion_metadata || {}, null, 2))
                setMetadataError("")
                setIsEditingMetadata(true)
              }}
            >
              Edit Metadata
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isEditingMetadata && (
            <div className="mb-4 space-y-2">
              <Label htmlFor="metadata-json">Metadata JSON</Label>
              <textarea
                id="metadata-json"
                className="min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={metadataDraft}
                onChange={(e) => {
                  setMetadataDraft(e.target.value)
                  if (metadataError) setMetadataError("")
                }}
              />
              {metadataError && (
                <p className="text-sm text-red-600">{metadataError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                This JSON is stored separately from notes and tracks ingestion provenance.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground">Source</p>
              <p className="font-medium">{metadataSource}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Auto Parsed</p>
              <p className="font-medium">{metadata?.auto_parsed ? "Yes" : "No"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Parse Engine</p>
              <p className="font-medium">{metadata?.parse_engine || "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Parse Version</p>
              <p className="font-medium">{metadata?.parse_version || "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Confidence</p>
              <p className="font-medium">
                {typeof metadata?.confidence_score === "number"
                  ? metadata.confidence_score.toFixed(2)
                  : "-"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Ingested At</p>
              <p className="font-medium">{metadata?.ingested_at ? formatDate(metadata.ingested_at) : "-"}</p>
            </div>
          </div>
          {metadata?.raw_vendor_name && (
            <div className="mt-3 text-sm">
              <p className="text-muted-foreground">OCR Vendor Label</p>
              <p className="font-medium">{metadata.raw_vendor_name}</p>
            </div>
          )}
          {metadataWarnings.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="text-muted-foreground">Parse Warnings</p>
              <ul className="list-disc ml-5 mt-1 space-y-1">
                {metadataWarnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 border-t pt-3 space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                Audit
              </span>
              {loadingMetadataAudit ? (
                <span className="text-muted-foreground">Loading history...</span>
              ) : (
                <span className="text-muted-foreground">
                  {metadataUpdateHistory.length > 0
                    ? `Edited ${metadataUpdateHistory.length} time${metadataUpdateHistory.length === 1 ? "" : "s"}`
                    : "No metadata edits yet"}
                </span>
              )}
              {!loadingMetadataAudit && latestMetadataAudit && (
                <span className="text-xs text-muted-foreground">
                  Last change {new Date(latestMetadataAudit.created_at).toLocaleString()} by {formatAuditActor(latestMetadataAudit.user_id)}
                </span>
              )}
            </div>

            {metadataAuditError && (
              <p className="text-xs text-red-600">Could not load metadata audit history.</p>
            )}

            {!loadingMetadataAudit && !metadataAuditError && metadataAuditHistory.length > 0 && (
              <div className="space-y-2">
                {metadataAuditHistory.slice(0, 5).map((entry) => {
                  const changedKeys = getChangedMetadataKeys(
                    entry.old_ingestion_metadata,
                    entry.new_ingestion_metadata
                  )

                  return (
                    <div key={entry.id} className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-foreground">
                          {entry.operation === "create"
                            ? "Initial metadata snapshot"
                            : "Metadata updated"}
                        </p>
                        <p className="text-muted-foreground">
                          {new Date(entry.created_at).toLocaleString()}
                        </p>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {entry.operation === "create"
                          ? "Created with ingestion metadata."
                          : changedKeys.length > 0
                            ? `Changed: ${changedKeys.join(", ")}`
                            : "Metadata changed."}
                      </p>
                      <p className="text-muted-foreground">
                        User: {formatAuditActor(entry.user_id)}
                      </p>
                    </div>
                  )
                })}

                {metadataAuditHistory.length > 5 && (
                  <p className="text-xs text-muted-foreground">
                    Showing 5 most recent entries.
                  </p>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Receipt Lines Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Receipt Lines (Mapped to Items)</CardTitle>
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
            <DialogContent className="max-w-lg overflow-x-hidden">
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
          <CardTitle>Linked Purchases ({purchases.length})</CardTitle>
          <Dialog
            open={isOpen}
            onOpenChange={(open) => {
              setIsOpen(open)
              if (!open) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button
                size="sm"
                disabled={loadingReceiptLineItems || creatableReceiptLines.length === 0}
                onClick={() => {
                  resetForm()
                  if (creatableReceiptLines.length > 0) {
                    handleSelectReceiptLine(creatableReceiptLines[0].id)
                  }
                }}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Purchase
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg overflow-x-hidden">
              <DialogHeader>
                <DialogTitle>
                  {editingPurchaseId ? "Edit Purchase" : "Add Purchase"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                {editingPurchaseId ? (
                  <>
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Item, quantity, and unit cost are receipt-derived on this page.
                        Edit them in Receipt Lines if needed.
                    </div>
                      <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                          <Label htmlFor="item">Item</Label>
                        <Input
                            id="item"
                            value={items.find((i) => i.id === itemId)?.name || ""}
                            placeholder="-"
                            readOnly
                        />
                      </div>
                      <div className="space-y-2">
                          <Label htmlFor="quantity">Quantity</Label>
                        <Input
                            id="quantity"
                            value={quantity}
                            placeholder="-"
                            readOnly
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="purchaseCost">Unit Cost</Label>
                          <Input
                            id="purchaseCost"
                            value={purchaseCost}
                            placeholder="-"
                            readOnly
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="receipt-line">Receipt Line *</Label>
                      <Select
                        value={selectedReceiptLineId}
                        onValueChange={handleSelectReceiptLine}
                        disabled={loadingReceiptLineItems || creatableReceiptLines.length === 0}
                        required
                      >
                        <SelectTrigger
                          id="receipt-line"
                          className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all"
                        >
                          <SelectValue placeholder="Select receipt line" />
                        </SelectTrigger>
                        <SelectContent className="max-w-[min(90vw,40rem)]">
                          {creatableReceiptLines.map((line) => (
                            <SelectItem key={line.id} value={line.id}>
                              <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                                {truncateOptionLabel(`${line.item_name} - remaining ${line.remaining_qty} @ ${formatCurrency(line.unit_cost)}`, 140)}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {creatableReceiptLines.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          All receipt lines are already fully linked.
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="item">Item</Label>
                        <Input
                          id="item"
                          value={selectedReceiptLine?.item_name || ""}
                          placeholder="Select a receipt line"
                          readOnly
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="purchaseCost">Unit Cost</Label>
                        <Input
                          id="purchaseCost"
                          value={selectedReceiptLine ? Number.parseFloat(selectedReceiptLine.unit_cost).toFixed(2) : ""}
                          placeholder="-"
                          readOnly
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="quantity">Quantity to Link *</Label>
                      <Input
                        id="quantity"
                        type="number"
                        min={1}
                        max={selectedReceiptLine?.remaining_qty || 1}
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                      />
                      {selectedReceiptLine && (
                        <p className="text-xs text-muted-foreground">
                          Remaining on selected receipt line: {selectedReceiptLine.remaining_qty}
                        </p>
                      )}
                    </div>
                  </>
                )}
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
                      createPurchase.isPending ||
                      updatePurchase.isPending ||
                      (!editingPurchaseId && !selectedReceiptLineId)
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
                <TableHead>Reconciliation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingPurchases ? (
                <EmptyTableRow colSpan={8} message="Loading linked purchases..." />
              ) : purchasesLoadError ? (
                <EmptyTableRow
                  colSpan={8}
                  message={
                    purchasesLoadErrorDetail instanceof Error
                      ? `Could not load linked purchases: ${purchasesLoadErrorDetail.message}`
                      : "Could not load linked purchases"
                  }
                />
              ) : (
                <>
                  {purchases.map((p) => {
                    const reconciliation = assessPurchaseReconciliation({
                      quantity: p.quantity,
                      purchase_cost: p.purchase_cost,
                      receipt_id: p.receipt_id,
                      invoice_id: p.invoice_id,
                      invoice_unit_price: p.invoice_unit_price,
                      destination_code: p.destination_code,
                    })

                    return (
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
                    )
                  })}
                  {purchases.length === 0 && (
                    <EmptyTableRow colSpan={8} message="No linked purchases yet" />
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
