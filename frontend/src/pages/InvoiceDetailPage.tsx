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
  useItemPurchases,
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
import { DateInput } from "@/components/ui/date-input"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ReceiptForm, type ReceiptFormSubmitData } from "@/components/ReceiptForm"
import { ArrowLeft, Plus, Trash2, Pencil, CheckCircle2, AlertCircle, Package, FileDown, Upload, Loader2, ChevronDown, ChevronRight, Check, X, Scissors, Share2 } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { assessPurchaseReconciliation } from "@/lib/purchaseReconciliation"
import { getBonusAttribution, countUnattributedBonuses, buildDisplayRows } from "@/lib/bonusAttribution"
import type { PurchaseEconomics } from "@/types"
import { getOrLoadReceiptLineItems, invalidateReceiptLineItemsCache } from "@/lib/receiptLineItemsCache"
import { ApiError, invoices as invoicesApi, receipts as receiptsApi, purchases as purchasesApi, type AutoAllocatePurchaseResult, type PurchaseAllocation, type ReceiptLineItem } from "@/api"

type InvoicePurchase = ReturnType<typeof useInvoicePurchases>["data"] extends (infer T)[] | undefined ? T : never
type AutoAllocateLineSummary = {
  message: string
  tone: "success" | "warning" | "neutral"
}

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
  const invoiceLocked = invoice?.reconciliation_state === "locked"
  const invoiceReopened = invoice?.reconciliation_state === "reopened"

  const createPurchase = useCreatePurchase()
  const updatePurchase = useUpdatePurchase()
  const deletePurchase = useDeletePurchase()
  const createReceipt = useCreateReceipt()

  // PDF upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const [isUploadingPdf, setIsUploadingPdf] = useState(false)
  const [isExportingBackup, setIsExportingBackup] = useState(false)
  const [isImportingBackup, setIsImportingBackup] = useState(false)
  const [isSavingReconciliationState, setIsSavingReconciliationState] = useState(false)
  const [finalizeDialogOpen, setFinalizeDialogOpen] = useState(false)
  const [finalizeDialogError, setFinalizeDialogError] = useState("")
  const [reconciliationActionError, setReconciliationActionError] = useState("")
  const [reconciliationActionNotice, setReconciliationActionNotice] = useState("")
  const [deletePurchaseDialogOpen, setDeletePurchaseDialogOpen] = useState(false)
  const [purchasePendingDeleteId, setPurchasePendingDeleteId] = useState<string | null>(null)
  const [editingDeliveryDate, setEditingDeliveryDate] = useState(false)
  const [deliveryDateDraft, setDeliveryDateDraft] = useState("")

  // Split purchase dialog
  const [splitDialogOpen, setSplitDialogOpen] = useState(false)
  const [splitPurchase, setSplitPurchase] = useState<InvoicePurchase | null>(null)
  const [splitLines, setSplitLines] = useState<{ item_id: string; quantity: number; purchase_type: string }[]>([])
  const [isSplitting, setIsSplitting] = useState(false)
  const [splitError, setSplitError] = useState("")

  // Distribute bonus dialog
  const [distributeDialogOpen, setDistributeDialogOpen] = useState(false)
  const [distributePurchase, setDistributePurchase] = useState<InvoicePurchase | null>(null)
  const [distributeItems, setDistributeItems] = useState<{ item_id: string; item_name: string; auto_qty: number; parent_count: number; quantity: number; checked: boolean }[]>([])
  const [isDistributeLoading, setIsDistributeLoading] = useState(false)
  const [isDistributing, setIsDistributing] = useState(false)
  const [distributeError, setDistributeError] = useState("")
  const [distributeStage, setDistributeStage] = useState<"select" | "distribute">("select")

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return
    
    setIsUploadingPdf(true)
    try {
      await invoicesApi.uploadPdf(id, file)
      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to upload PDF"
      )
    } finally {
      setIsUploadingPdf(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  const handleSaveDeliveryDate = async () => {
    if (!id || !invoice) return
    try {
      await invoicesApi.update(id, { delivery_date: deliveryDateDraft })
      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      setEditingDeliveryDate(false)
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to update delivery date"
      )
    }
  }

  const handleFinalizeInvoice = () => {
    if (!id || !invoice || invoiceLocked || !canFinalize) return

    setReconciliationActionError("")
    setFinalizeDialogError("")
    setFinalizeDialogOpen(true)
  }

  const formatFinalizeErrorMessage = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 422) {
        return `Finalize blocked: ${err.message}`
      }
      return `Finalize failed (${err.status}): ${err.message}`
    }

    if (err instanceof Error) {
      return `Finalize failed: ${err.message}`
    }

    return "Finalize failed due to an unexpected error."
  }

  const confirmFinalizeInvoice = async () => {
    if (!id || !invoice || invoiceLocked || !canFinalize) return

    setIsSavingReconciliationState(true)
    setFinalizeDialogError("")
    try {
      await invoicesApi.update(id, { reconciliation_state: "locked" })
      setFinalizeDialogOpen(false)
      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
    } catch (err) {
      const message = formatFinalizeErrorMessage(err)
      setFinalizeDialogError(message)
      setReconciliationActionError(message)
      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
    } finally {
      setIsSavingReconciliationState(false)
    }
  }

  const handleReopenInvoice = async () => {
    if (!id || !invoice || !invoiceLocked) return

    setReconciliationActionError("")

    setIsSavingReconciliationState(true)
    try {
      await invoicesApi.update(id, { reconciliation_state: "reopened" })
      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to reopen invoice"
      )
    } finally {
      setIsSavingReconciliationState(false)
    }
  }

  const handleExportBackup = async () => {
    if (!id || !invoice) return

    setIsExportingBackup(true)
    try {
      const blob = await invoicesApi.downloadBackup(id)
      const safeInvoiceNumber = invoice.invoice_number.replace(/[^a-zA-Z0-9_-]+/g, "_")
      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = downloadUrl
      link.download = `invoice_${safeInvoiceNumber}_backup.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(downloadUrl)
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to export invoice backup"
      )
    } finally {
      setIsExportingBackup(false)
    }
  }

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsImportingBackup(true)
    try {
      const restored = await invoicesApi.importBackup(file)
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      navigate(`/invoices/${restored.invoice_id}`)
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to restore invoice backup"
      )
    } finally {
      setIsImportingBackup(false)
      if (backupInputRef.current) {
        backupInputRef.current.value = ""
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
  const [refundsPurchaseId, setRefundsPurchaseId] = useState("")
  const [purchaseType, setPurchaseType] = useState<"unit" | "bonus" | "refund">("unit")
  const [costAdjustment, setCostAdjustment] = useState("")
  const [adjustmentNote, setAdjustmentNote] = useState("")

  // Candidate purchases for the "Refunds Purchase" selector (same item, positive qty)
  const parsedQty = parseInt(quantity)
  const isRefund = purchaseType === "refund" || (!Number.isNaN(parsedQty) && parsedQty < 0)
  const isBonus = purchaseType === "bonus"
  const { data: itemPurchases = [] } = useItemPurchases(itemId)
  const refundCandidates = itemPurchases.filter(
    (p) => p.quantity > 0 && p.purchase_id !== editingPurchaseId
  )

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
  const [linkNotes, setLinkNotes] = useState("")
  const [allowReceiptDateOverride, setAllowReceiptDateOverride] = useState(false)
  const [expandedAllocations, setExpandedAllocations] = useState<Record<string, boolean>>({})
  const [allocationApiUnavailable, setAllocationApiUnavailable] = useState(false)
  const [allocatableReceiptIds, setAllocatableReceiptIds] = useState<string[]>([])
  const [loadingAllocatableReceipts, setLoadingAllocatableReceipts] = useState(false)
  const [autoAllocatingPurchaseId, setAutoAllocatingPurchaseId] = useState<string | null>(null)
  const [isAutoAllocatingAll, setIsAutoAllocatingAll] = useState(false)
  const [autoAllocateLineSummaryByPurchase, setAutoAllocateLineSummaryByPurchase] = useState<Record<string, AutoAllocateLineSummary>>({})
  const receiptLineItemsCacheRef = useRef<Record<string, ReceiptLineItem[]>>({})

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
    const unitCost = Number.parseFloat(purchase.purchase_cost || "0")
    if (purchase.quantity > 0 && allocs.length > 0) {
      const remainingQty = Math.max(0, purchase.quantity - allocatedQty)
      const blendedTotalCost = allocatedTotalCost + remainingQty * unitCost
      return {
        unitCost: blendedTotalCost / purchase.quantity,
        totalCost: blendedTotalCost,
      }
    }

    return {
      unitCost,
      totalCost: unitCost * purchase.quantity,
    }
  }

  const isReceiptDateEligibleForInvoice = (
    receiptDate: string | null | undefined,
    overrideEnabled: boolean
  ) => {
    if (overrideEnabled) return true
    const cutoffDate = invoice?.delivery_date || invoice?.invoice_date
    if (!cutoffDate || !receiptDate) return true
    return receiptDate.slice(0, 10) <= cutoffDate
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
        setReconciliationActionError(
          err instanceof Error ? err.message : "Failed to load receipt allocations"
        )
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
    if (invoiceLocked) return
    clearReceiptLineItemsCache()
    setLinkingPurchaseId(purchase.purchase_id)
    setLinkingPurchase(purchase)
    setLinkNotes(purchase.notes || "")
    setAllowReceiptDateOverride(Boolean(purchase.allow_receipt_date_override))
    setLoadingAllocations(true)
    const existing = getEffectiveAllocations(purchase)
    setAllocations(existing)
    setAllocatableReceiptIds([])
    resetAllocationForm()
    setAllocationUnitCost("")
    setShowNewReceipt(false)
    setLinkDialogOpen(true)
    setLoadingAllocations(false)
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
    return rows
  }

  const getAllocationCapsForLine = (
    line: ReceiptLineItem,
    options?: {
      allocationRows?: PurchaseAllocation[]
      editingId?: string | null
    }
  ) => {
    const allocationRows = options?.allocationRows ?? allocations
    const editingId = options?.editingId ?? editingAllocationId

    const editingAllocation = editingId
      ? allocationRows.find((a) => a.id === editingId)
      : undefined
    const editingQtyOnLine =
      editingAllocation?.receipt_line_item_id === line.id ? editingAllocation.allocated_qty : 0

    const usedByOther = allocationRows
      .filter((a) => a.id !== editingId)
      .reduce((sum, a) => sum + a.allocated_qty, 0)

    const purchaseCapacity = linkingPurchase
      ? Math.max(0, linkingPurchase.quantity - usedByOther)
      : Math.max(0, line.remaining_qty + editingQtyOnLine)
    const receiptCapacity = Math.max(0, line.remaining_qty + editingQtyOnLine)
    const maxAllocatable = Math.max(0, Math.min(receiptCapacity, purchaseCapacity))

    return {
      purchaseCapacity,
      receiptCapacity,
      maxAllocatable,
    }
  }

  const getReceiptLineItemsCached = async (receiptId: string): Promise<ReceiptLineItem[]> => {
    return getOrLoadReceiptLineItems(
      receiptLineItemsCacheRef.current,
      receiptId,
      (id) => receiptsApi.lineItems.list(id)
    )
  }

  const clearReceiptLineItemsCache = (receiptId?: string) => {
    invalidateReceiptLineItemsCache(receiptLineItemsCacheRef.current, receiptId)
  }

  const loadReceiptLineItemsForAllocation = async (receiptId: string, purchase: InvoicePurchase) => {
    const selectedReceipt = receipts.find((row) => row.id === receiptId)
    const receiptDateOutOfRange = !isReceiptDateEligibleForInvoice(
      selectedReceipt?.receipt_date,
      allowReceiptDateOverride
    )

    if (receiptDateOutOfRange) {
      setAllocationWarning(
        `Receipt date ${formatDate(selectedReceipt?.receipt_date)} is after delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)}. Enable override to proceed.`
      )
    }

    const rows = await getReceiptLineItemsCached(receiptId)
    const sameItemRows = rows
      .filter((row) => row.item_id === purchase.item_id)
      .sort((a, b) => b.remaining_qty - a.remaining_qty)
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
    const caps = getAllocationCapsForLine(candidate)
    if (caps.maxAllocatable > 0) {
      setAllocationQty(String(caps.maxAllocatable))
    } else {
      setAllocationQty("")
      setAllocationWarning("No allocatable quantity remains for this line.")
      return
    }

    if (receiptDateOutOfRange) {
      setAllocationWarning(
        `Receipt date ${formatDate(selectedReceipt?.receipt_date)} is after delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)}. Enable override to proceed.`
      )
      return
    }

    setAllocationWarning("")
  }

  const refreshAllocatableReceipts = async (purchase: InvoicePurchase) => {
    setLoadingAllocatableReceipts(true)

    try {
      const candidateIds = (
        await Promise.all(
          receipts.map(async (receipt) => {
            if (!isReceiptDateEligibleForInvoice(receipt.receipt_date, allowReceiptDateOverride)) {
              return null
            }

            const rows = await getReceiptLineItemsCached(receipt.id)
            const sameItemRows = rows.filter((row) => row.item_id === purchase.item_id)
            const hasAllocatableLine = sameItemRows.some(
              (line) => getAllocationCapsForLine(line).maxAllocatable > 0
            )
            return hasAllocatableLine ? receipt.id : null
          })
        )
      ).filter((candidateId): candidateId is string => Boolean(candidateId))

      setAllocatableReceiptIds(candidateIds)

      if (candidateIds.length === 0) {
        setAllocationReceiptId("")
        setAllocationReceiptLineItemId("")
        setAllocationReceiptLineItems([])
        setAllocationUnitCost("")
        setAllocationQty("")
        if (allowReceiptDateOverride) {
          setAllocationWarning("No receipts currently have allocatable line items for this product.")
        } else {
          setAllocationWarning(
            `No receipts on or before delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)} have allocatable line items for this product. Enable override to include later receipts.`
          )
        }
        return
      }

      const currentSelectionIsValid =
        allocationReceiptId.length > 0 && candidateIds.includes(allocationReceiptId)
      const nextReceiptId = currentSelectionIsValid ? allocationReceiptId : candidateIds[0]

      if (!currentSelectionIsValid || allocationReceiptLineItems.length === 0) {
        await handleAllocationReceiptChange(nextReceiptId)
      }
    } catch (err) {
      setAllocatableReceiptIds([])
      setAllocationError(
        err instanceof Error ? err.message : "Failed to load allocatable receipts"
      )
    } finally {
      setLoadingAllocatableReceipts(false)
    }
  }

  useEffect(() => {
    if (!linkDialogOpen || showNewReceipt || !linkingPurchase) return

    void refreshAllocatableReceipts(linkingPurchase)
  }, [
    linkDialogOpen,
    showNewReceipt,
    linkingPurchase?.purchase_id,
    allocations,
    editingAllocationId,
    receipts,
    allowReceiptDateOverride,
    invoice?.delivery_date,
    invoice?.invoice_date,
  ])

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

    const caps = getAllocationCapsForLine(line)
    if (caps.maxAllocatable <= 0) {
      setAllocationQty("")
      setAllocationWarning("No allocatable quantity remains for this line.")
      return
    }

    setAllocationQty(String(caps.maxAllocatable))

    if (caps.maxAllocatable < caps.receiptCapacity) {
      setAllocationWarning(`Purchase line has only ${caps.purchaseCapacity} qty left, so max allocatable here is ${caps.maxAllocatable}.`)
      return
    }

    setAllocationWarning("")
  }

  const handleSaveAllocation = async () => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    if (!linkingPurchaseId || !linkingPurchase) return

    const requestedQty = Number.parseInt(allocationQty || "0", 10)
    let unitCost = allocationUnitCost.trim()
    if (!allocationReceiptId) {
      setAllocationError("Select a receipt")
      return
    }
    if (!requestedQty || requestedQty <= 0) {
      setAllocationError("Allocated quantity must be greater than zero")
      return
    }
    if (!allocationReceiptLineItemId) {
      setAllocationError("Select a receipt line item before allocating.")
      return
    }

    const selectedReceipt = receipts.find((row) => row.id === allocationReceiptId)
    if (!isReceiptDateEligibleForInvoice(selectedReceipt?.receipt_date, allowReceiptDateOverride)) {
      setAllocationError(
        `Receipt date ${formatDate(selectedReceipt?.receipt_date)} is after delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)}. Enable override to continue.`
      )
      return
    }

    const selectedLineItem = allocationReceiptLineItems.find((row) => row.id === allocationReceiptLineItemId)
    if (!selectedLineItem) {
      setAllocationError("Selected receipt line item is unavailable. Reload and try again.")
      return
    }

    if (!selectedLineItem.unit_cost) {
      setAllocationError("Unit cost must come from receipt line items. Use Edit Receipt to set it.")
      return
    }

    const caps = getAllocationCapsForLine(selectedLineItem)
    if (caps.maxAllocatable <= 0) {
      setAllocationError("No allocatable quantity remains for this receipt line.")
      return
    }

    const qty = Math.min(requestedQty, caps.maxAllocatable)
    if (qty < requestedQty) {
      setAllocationWarning(
        `Requested qty (${requestedQty}) exceeds max allocatable qty (${caps.maxAllocatable}); allocating ${qty} instead.`
      )
    }

    unitCost = Number.parseFloat(selectedLineItem.unit_cost).toFixed(2)
    setAllocationUnitCost(unitCost)
    setAllocationQty(String(qty))

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
          allow_receipt_date_override: allowReceiptDateOverride,
        })
      } else {
        await purchasesApi.allocations.create(linkingPurchaseId, {
          receipt_line_item_id: allocationReceiptLineItemId,
          allocated_qty: qty,
          allow_receipt_date_override: allowReceiptDateOverride,
        })
      }

      await updatePurchase.mutateAsync({
        id: linkingPurchaseId,
        notes: linkNotes || undefined,
      })

      clearReceiptLineItemsCache()
      const refreshedAllocations = await reloadAllocations(linkingPurchaseId)
      const allocatedQty = refreshedAllocations.reduce((sum, row) => sum + row.allocated_qty, 0)
      const remainingQty = Math.max(0, linkingPurchase.quantity - allocatedQty)

      if (!editingAllocationId && remainingQty === 0) {
        setLinkDialogOpen(false)
        setShowNewReceipt(false)
        setLinkingPurchase(null)
        setLinkingPurchaseId(null)
        setAllocations([])
        setAllocatableReceiptIds([])
        resetAllocationForm()
      } else {
        resetAllocationForm()
      }

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
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    if (!linkingPurchaseId) return
    await purchasesApi.allocations.delete(linkingPurchaseId, allocationId)
    clearReceiptLineItemsCache()
    await reloadAllocations(linkingPurchaseId)
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
  }

  const buildAutoAllocateNotice = (
    purchase: InvoicePurchase,
    result: AutoAllocatePurchaseResult
  ) => {
    const formatUnits = (qty: number) => `${qty} unit${qty === 1 ? "" : "s"}`
    const touchedReceiptLabel =
      result.receipts_touched > 0
        ? ` across ${result.receipts_touched} receipt${result.receipts_touched === 1 ? "" : "s"}`
        : ""

    if (result.auto_allocated_qty <= 0) {
      const base = `No additional quantity could be auto-allocated for ${purchase.item_name}. ${formatUnits(result.remaining_qty)} remain unallocated.`
      return result.warning ? `${base} ${result.warning}` : base
    }

    if (result.remaining_qty > 0) {
      return `Auto-allocated ${formatUnits(result.auto_allocated_qty)}${touchedReceiptLabel} for ${purchase.item_name}. ${formatUnits(result.remaining_qty)} still need manual allocation.`
    }

    const completed = `Auto-allocation complete for ${purchase.item_name}: ${formatUnits(result.auto_allocated_qty)}${touchedReceiptLabel}.`
    return result.warning ? `${completed} ${result.warning}` : completed
  }

  const buildAutoAllocateLineSummary = (
    result: AutoAllocatePurchaseResult
  ): AutoAllocateLineSummary => {
    if (result.warning) {
      return {
        message: "Auto: no eligible receipts before invoice date",
        tone: "warning",
      }
    }

    if (result.auto_allocated_qty <= 0) {
      return {
        message: `Auto: no qty allocated (${result.remaining_qty} remaining)`,
        tone: "neutral",
      }
    }

    if (result.remaining_qty > 0) {
      return {
        message: `Auto: +${result.auto_allocated_qty}, ${result.remaining_qty} remaining`,
        tone: "warning",
      }
    }

    return {
      message: `Auto: complete (+${result.auto_allocated_qty})`,
      tone: "success",
    }
  }

  const getAllocatedQtyForPurchase = (purchase: InvoicePurchase) => {
    return getEffectiveAllocations(purchase).reduce((sum, allocation) => sum + allocation.allocated_qty, 0)
  }

  const isPurchaseEligibleForAutoAllocation = (purchase: InvoicePurchase) => {
    if (purchase.purchase_type === "bonus" || purchase.quantity <= 0) {
      return false
    }

    return getAllocatedQtyForPurchase(purchase) < purchase.quantity
  }

  const handleAutoAllocatePurchase = async (
    purchase: InvoicePurchase,
    options?: {
      allowReceiptDateOverride?: boolean
    }
  ) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }

    const allowDateOverride =
      options?.allowReceiptDateOverride ?? Boolean(purchase.allow_receipt_date_override)

    setReconciliationActionError("")
    setReconciliationActionNotice("")
    if (linkingPurchaseId === purchase.purchase_id) {
      setAllocationError("")
      setAllocationWarning("")
    }

    setAutoAllocatingPurchaseId(purchase.purchase_id)

    try {
      const result = await purchasesApi.allocations.auto(purchase.purchase_id, {
        allow_receipt_date_override: allowDateOverride,
      })
      clearReceiptLineItemsCache()
      await reloadAllocations(purchase.purchase_id)

      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })

      const notice = buildAutoAllocateNotice(purchase, result)
      setReconciliationActionNotice(notice)
      setAutoAllocateLineSummaryByPurchase((previous) => ({
        ...previous,
        [purchase.purchase_id]: buildAutoAllocateLineSummary(result),
      }))

      if (
        linkingPurchaseId === purchase.purchase_id &&
        result.remaining_qty === 0 &&
        !result.warning
      ) {
        setLinkDialogOpen(false)
        setShowNewReceipt(false)
        setLinkingPurchase(null)
        setLinkingPurchaseId(null)
        setAllocations([])
        setAllocatableReceiptIds([])
        resetAllocationForm()
        setReconciliationActionNotice(`All ${purchase.quantity} units of ${purchase.item_name} fully allocated.`)
      } else if (
        linkingPurchaseId === purchase.purchase_id &&
        (result.remaining_qty > 0 || Boolean(result.warning))
      ) {
        setAllocationWarning(notice)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAllocationApiUnavailable(true)
      }

      const message = err instanceof Error ? err.message : "Failed to auto-allocate this line item"
      setReconciliationActionError(message)
      if (linkingPurchaseId === purchase.purchase_id) {
        setAllocationError(message)
      }
    } finally {
      setAutoAllocatingPurchaseId(null)
    }
  }

  const handleCreateReceipt = async (data: ReceiptFormSubmitData) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    if (!linkingPurchaseId) return

    const newReceipt = await createReceipt.mutateAsync({
      vendor_id: data.vendor_id,
      ...(data.receipt_number.trim() ? { receipt_number: data.receipt_number.trim() } : {}),
      receipt_date: data.receipt_date,
      subtotal: data.subtotal,
      tax_amount: data.tax_amount,
      payment_method: data.payment_method.trim() || undefined,
      notes: data.notes || undefined,
    })

    if (data.document_file) {
      await receiptsApi.uploadPdf(newReceipt.id, data.document_file)
    }

    setAllocationReceiptId(newReceipt.id)
    await reloadAllocations(linkingPurchaseId)

    if (linkingPurchase) {
      try {
        await loadReceiptLineItemsForAllocation(newReceipt.id, linkingPurchase)
      } catch {
        setAllocationWarning("Could not load line items from the new receipt yet.")
      }
    }

    if (linkingPurchase) {
      const remaining = Math.max(1, linkingPurchase.quantity - totalAllocatedQty)
      setAllocationQty(String(remaining))
    }

    queryClient.invalidateQueries({ queryKey: ["invoices"] })
    queryClient.invalidateQueries({ queryKey: ["receipts"] })
    setShowNewReceipt(false)
  }

  const totalAllocatedQty = allocations.reduce((sum, a) => sum + a.allocated_qty, 0)
  const isAutoAllocatingCurrentPurchase =
    linkingPurchaseId !== null && autoAllocatingPurchaseId === linkingPurchaseId
  const selectedAllocationLineItem = allocationReceiptLineItems.find((row) => row.id === allocationReceiptLineItemId)
  const allocationCaps = selectedAllocationLineItem
    ? getAllocationCapsForLine(selectedAllocationLineItem)
    : null
  const allocationMaxQty = allocationCaps?.maxAllocatable ?? 0

  const handleAllocationQtyChange = (value: string) => {
    if (!selectedAllocationLineItem) return
    if (value.trim() === "") {
      setAllocationQty("")
      return
    }

    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed)) return

    const maxQty = getAllocationCapsForLine(selectedAllocationLineItem).maxAllocatable
    if (maxQty <= 0) {
      setAllocationQty("")
      return
    }

    const clamped = Math.min(Math.max(parsed, 1), maxQty)
    setAllocationQty(String(clamped))
  }

  const toggleAllocationDrilldown = (purchaseId: string, defaultExpanded = false) => {
    setExpandedAllocations((prev) => {
      const hasUserState = Object.prototype.hasOwnProperty.call(prev, purchaseId)
      const currentExpanded = hasUserState ? !!prev[purchaseId] : defaultExpanded

      return {
        ...prev,
        [purchaseId]: !currentExpanded,
      }
    })
  }

  // Show all items (no vendor filtering needed for outgoing invoices)
  const availableItems = items

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    if (editingPurchaseId) {
      await updatePurchase.mutateAsync({
        id: editingPurchaseId,
        item_id: itemId,
        quantity: parseInt(quantity),
        invoice_unit_price: invoiceUnitPrice || undefined,
        destination_id: destinationId || undefined,
        invoice_id: id,
        notes: notes || undefined,
        purchase_type: purchaseType,
        refunds_purchase_id: refundsPurchaseId || undefined,
        clear_refunds_purchase: !refundsPurchaseId,
        cost_adjustment: costAdjustment ? costAdjustment : "0",
        adjustment_note: adjustmentNote || undefined,
        clear_adjustment_note: !adjustmentNote,
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
        purchase_type: purchaseType,
        refunds_purchase_id: refundsPurchaseId || undefined,
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
    setRefundsPurchaseId("")
    setPurchaseType("unit")
    setCostAdjustment("")
    setAdjustmentNote("")
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

  const handleAutoAllocateAllPurchases = async () => {
    if (invoiceLocked || isAutoAllocatingAll) {
      return
    }

    const eligiblePurchases = purchases.filter(isPurchaseEligibleForAutoAllocation)
    if (eligiblePurchases.length === 0) {
      setReconciliationActionNotice("All eligible invoice line items are already fully allocated.")
      return
    }

    setReconciliationActionError("")
    setReconciliationActionNotice("")
    setIsAutoAllocatingAll(true)

    let linesUpdated = 0
    let totalAutoAllocatedQty = 0
    let totalRemainingQty = 0
    let warningCount = 0

    try {
      for (const purchase of eligiblePurchases) {
        try {
          const result = await purchasesApi.allocations.auto(purchase.purchase_id, {
            allow_receipt_date_override: Boolean(purchase.allow_receipt_date_override),
          })

          totalAutoAllocatedQty += result.auto_allocated_qty
          totalRemainingQty += result.remaining_qty

          if (result.auto_allocated_qty > 0) {
            linesUpdated += 1
          }

          if (result.warning) {
            warningCount += 1
          }

          clearReceiptLineItemsCache()
          await reloadAllocations(purchase.purchase_id)

          setAutoAllocateLineSummaryByPurchase((previous) => ({
            ...previous,
            [purchase.purchase_id]: buildAutoAllocateLineSummary(result),
          }))
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            setAllocationApiUnavailable(true)
            throw err
          }

          throw err
        }
      }

      queryClient.invalidateQueries({ queryKey: ["invoices", id] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["receipts"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })

      const summaryParts = [
        `Auto-allocated ${totalAutoAllocatedQty} unit${totalAutoAllocatedQty === 1 ? "" : "s"}`,
        `across ${linesUpdated} line item${linesUpdated === 1 ? "" : "s"}`,
      ]

      if (totalRemainingQty > 0) {
        summaryParts.push(`${totalRemainingQty} unit${totalRemainingQty === 1 ? "" : "s"} still need manual allocation`)
      }

      if (warningCount > 0) {
        summaryParts.push(`${warningCount} line item${warningCount === 1 ? "" : "s"} need review`)
      }

      setReconciliationActionNotice(summaryParts.join(". ") + ".")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to auto-allocate invoice line items"
      setReconciliationActionError(message)
    } finally {
      setIsAutoAllocatingAll(false)
    }
  }

  const handleEditPurchase = (p: typeof purchases[0]) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
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
    setRefundsPurchaseId(p.refunds_purchase_id || "")
    setPurchaseType((p.purchase_type as "unit" | "bonus" | "refund") || "unit")
    setCostAdjustment(p.cost_adjustment && Number.parseFloat(p.cost_adjustment) !== 0 ? Number.parseFloat(p.cost_adjustment).toFixed(4) : "")
    setAdjustmentNote(p.adjustment_note || "")
    setIsOpen(true)
  }

  const handleStatusChange = async (purchaseId: string, newStatus: string) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    await updatePurchase.mutateAsync({ id: purchaseId, status: newStatus })
    queryClient.invalidateQueries({ queryKey: ["invoices"] })
  }

  const handleDeletePurchase = (purchaseId: string) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    setReconciliationActionError("")
    setPurchasePendingDeleteId(purchaseId)
    setDeletePurchaseDialogOpen(true)
  }

  const handleOpenSplit = (p: InvoicePurchase) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    // Find the item that matches this purchase
    const matchedItem = items.find((i) => i.name === p.item_name)
    setSplitPurchase(p)
    setSplitLines([
      { item_id: matchedItem?.id || "", quantity: p.quantity, purchase_type: p.purchase_type || "unit" },
    ])
    setSplitError("")
    setSplitDialogOpen(true)
  }

  const handleSplitSubmit = async () => {
    if (!splitPurchase) return
    const totalQty = splitLines.reduce((s, l) => s + l.quantity, 0)
    if (totalQty !== splitPurchase.quantity) {
      setSplitError(`Split quantities (${totalQty}) must equal original quantity (${splitPurchase.quantity}).`)
      return
    }
    if (splitLines.some((l) => !l.item_id)) {
      setSplitError("All split lines must have an item selected.")
      return
    }
    setIsSplitting(true)
    setSplitError("")
    try {
      await purchasesApi.split(splitPurchase.purchase_id, { lines: splitLines })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
      setSplitDialogOpen(false)
      setSplitPurchase(null)
      setReconciliationActionNotice(
        `Split purchase into ${splitLines.length} line${splitLines.length === 1 ? "" : "s"}.`
      )
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : "Failed to split purchase")
    } finally {
      setIsSplitting(false)
    }
  }

  const handleOpenDistribute = async (p: InvoicePurchase) => {
    if (invoiceLocked) {
      setReconciliationActionError("Finalized invoices are locked.")
      return
    }
    setDistributePurchase(p)
    setDistributeItems([])
    setDistributeError("")
    setDistributeStage("select")
    setDistributeDialogOpen(true)
    setIsDistributeLoading(true)
    try {
      const preview = await purchasesApi.distributePreview(p.purchase_id)
      const previewByItem = new Map(preview.items.map((item) => [item.item_id, item]))
      const bonusItemId = p.item_id
      // Only show eligible items; pre-check only the bonus's own item
      const eligible = availableItems
        .map((item) => {
          const match = previewByItem.get(item.id)
          return {
            item_id: item.id,
            item_name: item.name,
            auto_qty: match?.auto_qty ?? 0,
            parent_count: match?.parent_count ?? 0,
            quantity: 0,
            checked: item.id === bonusItemId && (match?.auto_qty ?? 0) > 0,
          }
        })
        .filter((i) => i.parent_count > 0)
        .sort((a, b) => {
          // Bonus's own item always first
          if (a.item_id === bonusItemId && b.item_id !== bonusItemId) return -1
          if (b.item_id === bonusItemId && a.item_id !== bonusItemId) return 1
          return b.auto_qty - a.auto_qty
        })
      setDistributeItems(eligible)
      // If any items are pre-checked, skip straight to stage 2 with auto-filled quantities
      const hasPreChecked = eligible.some((i) => i.checked)
      if (hasPreChecked) {
        setDistributeItems(eligible.map((i) => i.checked ? { ...i, quantity: i.auto_qty } : i))
        setDistributeStage("distribute")
      }
    } catch (err) {
      setDistributeError(err instanceof Error ? err.message : "Failed to load distribute preview")
    } finally {
      setIsDistributeLoading(false)
    }
  }

  const handleDistributeSubmit = async () => {
    if (!distributePurchase) return
    const checkedItems = distributeItems.filter((i) => i.checked && i.quantity > 0)
    if (checkedItems.length === 0) {
      setDistributeError("Select at least one item with a quantity.")
      return
    }
    setIsDistributing(true)
    setDistributeError("")
    try {
      const result = await purchasesApi.distribute(distributePurchase.purchase_id, {
        items: checkedItems.map((i) => ({ item_id: i.item_id, quantity: i.quantity })),
      })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
      setDistributeDialogOpen(false)
      setDistributePurchase(null)
      const parts = [`Distributed bonus → ${result.bonus_purchases_created} purchase${result.bonus_purchases_created === 1 ? "" : "s"} created (${result.total_qty_attributed} qty attributed)`]
      if (result.remainder_qty > 0) {
        parts.push(`${result.remainder_qty} qty left as unattributed remainder`)
      }
      setReconciliationActionNotice(parts.join(". "))
    } catch (err) {
      setDistributeError(err instanceof Error ? err.message : "Failed to distribute bonus")
    } finally {
      setIsDistributing(false)
    }
  }

  const confirmDeletePurchase = async () => {
    if (!purchasePendingDeleteId) return

    try {
      await deletePurchase.mutateAsync(purchasePendingDeleteId)
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
      setDeletePurchaseDialogOpen(false)
      setPurchasePendingDeleteId(null)
    } catch (err) {
      setReconciliationActionError(
        err instanceof Error ? err.message : "Failed to remove purchase from invoice"
      )
    }
  }

  if (invoiceLoading) return <div className="text-muted-foreground">Loading...</div>
  if (!invoice) return <div className="text-muted-foreground">Invoice not found</div>

  const invoiceSubtotal = parseFloat(invoice.subtotal)
  const purchasesTotal = purchases.reduce((sum, purchase) => {
    const invoicePrice = purchase.invoice_unit_price
      ? Number.parseFloat(purchase.invoice_unit_price)
      : Number.NaN
    const unitPrice = Number.isFinite(invoicePrice)
      ? invoicePrice
      : Number.parseFloat(purchase.purchase_cost || "0")
    return sum + purchase.quantity * unitPrice
  }, 0)
  const difference = invoiceSubtotal - purchasesTotal
  const isReconciled = Math.abs(difference) < 0.01
  const purchaseCount = purchases.length
  const totalQuantity = purchases.reduce((sum, p) => sum + p.quantity, 0)
  const totalCost = purchases.reduce((sum, p) => sum + getDisplayPurchaseCosts(p).totalCost, 0)
  const totalCommission = purchases.reduce((sum, p) => sum + parseFloat(p.total_commission || "0"), 0)
  const hasAnyPrice = purchases.some((p) => p.invoice_unit_price !== null)
  const receiptedCount = purchases.filter((p) => {
    // Bonus purchases don't need receipt allocation
    if (p.purchase_type === "bonus") return true
    const allocs = getEffectiveAllocations(p)
    const allocatedQty = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
    return Boolean(p.receipt_id) || allocatedQty >= p.quantity
  }).length

  const lineItemAssessments = purchases.map((purchase) => {
    const allocs = getEffectiveAllocations(purchase)
    const allocatedQty = allocs.reduce((sum, allocation) => sum + allocation.allocated_qty, 0)

    return {
      purchase,
      assessment: assessPurchaseReconciliation({
        quantity: purchase.quantity,
        purchase_cost: purchase.purchase_cost,
        receipt_id: purchase.receipt_id,
        invoice_date: invoice.delivery_date || invoice.invoice_date,
        invoice_id: purchase.invoice_id,
        invoice_unit_price: purchase.invoice_unit_price,
        destination_code: purchase.destination_code,
        requireAllocations: true,
        allocationCount: allocs.length,
        allocatedQty,
        allocationReceiptDates: allocs.map((allocation) => allocation.receipt_date),
        allowReceiptDateOverride: Boolean(purchase.allow_receipt_date_override),
        invoiceLocked: invoice.reconciliation_state === "locked",
      }),
    }
  })

  const unreconciledLineItems = lineItemAssessments.filter(
    ({ purchase, assessment }) => {
      // Bonus purchases with attribution are always reconciled
      if (purchase.purchase_type === "bonus" && purchase.bonus_for_purchase_id) return false
      // Bonus purchases without attribution are unreconciled
      if (purchase.purchase_type === "bonus" && !purchase.bonus_for_purchase_id) return true
      return !assessment.isReconciled && !assessment.isReadyToReconcile
    }
  )
  const unreconciledLineItemCount = unreconciledLineItems.length

  const totalPurchases = purchases.length
  const isFinalized = invoice.reconciliation_state === "locked"
  const autoAllocatablePurchases = purchases.filter(isPurchaseEligibleForAutoAllocation)
  const hasReceiptGap = totalPurchases > 0 && receiptedCount < totalPurchases
  const canFinalize =
    isReconciled && totalPurchases > 0 && !hasReceiptGap && unreconciledLineItemCount === 0

  const finalizeBlockReasons: string[] = []
  if (totalPurchases === 0) {
    finalizeBlockReasons.push("Add at least one line item.")
  }
  if (!isReconciled) {
    finalizeBlockReasons.push(
      `Invoice totals are ${formatCurrency(Math.abs(difference))} ${difference > 0 ? "under" : "over"}.`
    )
  }
  if (hasReceiptGap) {
    finalizeBlockReasons.push(`${receiptedCount}/${totalPurchases} line items are receipted.`)
  }
  if (unreconciledLineItemCount > 0) {
    const unattributedBonuses = countUnattributedBonuses(purchases)
    if (unattributedBonuses > 0) {
      finalizeBlockReasons.push(
        `${unattributedBonuses} bonus line${unattributedBonuses === 1 ? " is" : "s are"} not attributed to a parent purchase.`
      )
    }
    const otherUnreconciled = unreconciledLineItemCount - unattributedBonuses
    if (otherUnreconciled > 0) {
      finalizeBlockReasons.push(
        `${otherUnreconciled}/${totalPurchases} line items are unreconciled.`
      )
    }
  }

  return (
    <div className="space-y-6">
      <Dialog
        open={finalizeDialogOpen}
        onOpenChange={(open) => {
          setFinalizeDialogOpen(open)
          if (!open) {
            setFinalizeDialogError("")
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Finalize Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              Finalizing locks this invoice and includes it in dashboard reporting.
            </p>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
              All {totalPurchases} line items are reconciled and ready to finalize.
            </div>
            {finalizeDialogError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                {finalizeDialogError}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFinalizeDialogOpen(false)}
              disabled={isSavingReconciliationState}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmFinalizeInvoice}
              disabled={isSavingReconciliationState}
            >
              {isSavingReconciliationState ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Finalizing...
                </>
              ) : (
                "Confirm Finalize"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deletePurchaseDialogOpen}
        onOpenChange={(open) => {
          setDeletePurchaseDialogOpen(open)
          if (!open) {
            setPurchasePendingDeleteId(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove Line Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>Remove this purchase from the invoice?</p>
            <p className="text-muted-foreground">
              This action removes the line item link and cannot be undone from this screen.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletePurchaseDialogOpen(false)}
              disabled={deletePurchase.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDeletePurchase}
              disabled={deletePurchase.isPending}
            >
              {deletePurchase.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Split Purchase Dialog */}
      <Dialog
        open={splitDialogOpen}
        onOpenChange={(open) => {
          setSplitDialogOpen(open)
          if (!open) {
            setSplitPurchase(null)
            setSplitLines([])
            setSplitError("")
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Split Purchase</DialogTitle>
          </DialogHeader>
          {splitPurchase && (
            <div className="space-y-4">
              <div className="text-sm bg-muted p-3 rounded-md space-y-1">
                <p><strong>Original:</strong> {splitPurchase.item_name} × {splitPurchase.quantity}</p>
                <p className="text-muted-foreground">Invoice unit price: {splitPurchase.invoice_unit_price ? formatCurrency(splitPurchase.invoice_unit_price) : "—"}</p>
              </div>
              <div className="space-y-2">
                {splitLines.map((line, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-blue-50/50 p-2 rounded">
                    <span className="text-xs text-muted-foreground">↳</span>
                    <Select
                      value={line.item_id || "__none__"}
                      onValueChange={(v) => {
                        setSplitLines((prev) => {
                          const next = [...prev]
                          next[idx] = { ...next[idx], item_id: v === "__none__" ? "" : v }
                          return next
                        })
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue placeholder="Select item" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-amber-600">— Select item</span>
                        </SelectItem>
                        {availableItems.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="h-8 w-20 text-xs text-right"
                      value={line.quantity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0
                        setSplitLines((prev) => {
                          const next = [...prev]
                          next[idx] = { ...next[idx], quantity: val }
                          return next
                        })
                      }}
                    />
                    <Select
                      value={line.purchase_type}
                      onValueChange={(v) => {
                        setSplitLines((prev) => {
                          const next = [...prev]
                          next[idx] = { ...next[idx], purchase_type: v }
                          return next
                        })
                      }}
                    >
                      <SelectTrigger className="h-8 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unit">Unit</SelectItem>
                        <SelectItem value="bonus">Bonus</SelectItem>
                        <SelectItem value="refund">Refund</SelectItem>
                      </SelectContent>
                    </Select>
                    {splitLines.length > 1 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => setSplitLines((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-xs text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1"
                  onClick={() => setSplitLines((prev) => [...prev, { item_id: "", quantity: 0, purchase_type: "unit" }])}
                >
                  <Plus className="h-3 w-3" />Add split row
                </button>
                {(() => {
                  const totalQty = splitLines.reduce((s, l) => s + l.quantity, 0)
                  const matches = totalQty === splitPurchase.quantity
                  return (
                    <span className={`text-xs font-medium ${matches ? "text-green-600" : "text-red-500"}`}>
                      Qty: {totalQty}/{splitPurchase.quantity} {matches ? "✓" : ""}
                    </span>
                  )
                })()}
              </div>
              {splitError && (
                <p className="text-xs text-red-600">{splitError}</p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setSplitDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleSplitSubmit}
                  disabled={isSplitting}
                >
                  {isSplitting ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Splitting...</>
                  ) : (
                    `Split into ${splitLines.length} Line${splitLines.length === 1 ? "" : "s"}`
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Distribute Bonus Dialog */}
      <Dialog
        open={distributeDialogOpen}
        onOpenChange={(open) => {
          setDistributeDialogOpen(open)
          if (!open) {
            setDistributePurchase(null)
            setDistributeItems([])
            setDistributeError("")
            setDistributeStage("select")
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {distributeStage === "select" ? "Distribute Bonus — Select Items" : "Distribute Bonus — Set Quantities"}
            </DialogTitle>
          </DialogHeader>
          {distributePurchase && (
            <div className="space-y-4">
              <div className="text-sm bg-muted p-3 rounded-md space-y-1">
                <p><strong>Bonus:</strong> {distributePurchase.item_name} × {distributePurchase.quantity}</p>
                <p className="text-muted-foreground">
                  Unit price: {distributePurchase.invoice_unit_price ? formatCurrency(distributePurchase.invoice_unit_price) : "—"}
                </p>
              </div>

              {isDistributeLoading ? (
                <div className="flex items-center gap-2 justify-center py-4 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading eligible items…</span>
                </div>
              ) : distributeItems.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No eligible parent purchases found for distribution.
                </p>
              ) : distributeStage === "select" ? (
                /* ── Stage 1: Select Items ── */
                <>
                  <p className="text-xs text-muted-foreground">
                    Select which items this bonus should be attributed across. Only items with unattributed unit purchases are shown.
                  </p>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {distributeItems.map((item) => {
                      const idx = distributeItems.findIndex((d) => d.item_id === item.item_id)
                      return (
                        <label
                          key={item.item_id}
                          className={`flex items-center gap-3 p-2 rounded cursor-pointer ${
                            item.checked ? "bg-blue-50/50 ring-1 ring-blue-200" : "hover:bg-muted/50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={item.checked}
                            onChange={(e) => {
                              setDistributeItems((prev) => {
                                const next = [...prev]
                                next[idx] = { ...next[idx], checked: e.target.checked }
                                return next
                              })
                            }}
                            className="rounded"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{item.item_name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {item.parent_count} parent purchase{item.parent_count === 1 ? "" : "s"} • {item.auto_qty} suggested qty
                            </div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between">
                    {(() => {
                      const allChecked = distributeItems.every((i) => i.checked)
                      return (
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          onClick={() => {
                            setDistributeItems((prev) =>
                              prev.map((i) => ({ ...i, checked: !allChecked }))
                            )
                          }}
                        >
                          {allChecked ? "Deselect All" : "Select All"}
                        </button>
                      )
                    })()}
                    <span className="text-xs text-muted-foreground">
                      {distributeItems.filter((i) => i.checked).length} of {distributeItems.length} selected
                    </span>
                  </div>
                  {distributeError && (
                    <p className="text-xs text-red-600">{distributeError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setDistributeDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        const selected = distributeItems.filter((i) => i.checked)
                        if (selected.length === 0) {
                          setDistributeError("Select at least one item.")
                          return
                        }
                        setDistributeError("")
                        // Auto-fill quantities for selected items
                        setDistributeItems((prev) =>
                          prev.map((i) => i.checked ? { ...i, quantity: i.auto_qty } : i)
                        )
                        setDistributeStage("distribute")
                      }}
                      disabled={distributeItems.filter((i) => i.checked).length === 0}
                    >
                      Next →
                    </Button>
                  </div>
                </>
              ) : (
                /* ── Stage 2: Set Quantities & Distribute ── */
                <>
                  <p className="text-xs text-muted-foreground">
                    Adjust quantities for each item. Bonus qty is distributed FIFO across each item's parent purchases.
                  </p>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {distributeItems.filter((i) => i.checked).map((item) => {
                      const idx = distributeItems.findIndex((d) => d.item_id === item.item_id)
                      return (
                        <div
                          key={item.item_id}
                          className="flex items-center gap-3 p-2 rounded bg-blue-50/50"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{item.item_name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {item.parent_count} parent{item.parent_count === 1 ? "" : "s"} • suggested: {item.auto_qty}
                            </div>
                          </div>
                          <Input
                            type="number"
                            className="h-8 w-20 text-xs text-right"
                            value={item.quantity || ""}
                            min={0}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 0
                              setDistributeItems((prev) => {
                                const next = [...prev]
                                next[idx] = { ...next[idx], quantity: val }
                                return next
                              })
                            }}
                            placeholder="0"
                          />
                        </div>
                      )
                    })}
                  </div>
                  {(() => {
                    const totalQty = distributeItems.filter((i) => i.checked).reduce((s, i) => s + i.quantity, 0)
                    const remainder = distributePurchase.quantity - totalQty
                    return (
                      <div className="flex items-center justify-between text-xs">
                        <button
                          type="button"
                          className="text-blue-600 hover:text-blue-800 hover:underline"
                          onClick={() => {
                            setDistributeItems((prev) =>
                              prev.map((i) => i.checked ? { ...i, quantity: i.auto_qty } : i)
                            )
                          }}
                        >
                          Reset to suggested
                        </button>
                        <span className={`font-medium ${remainder === 0 ? "text-green-600" : remainder > 0 ? "text-amber-600" : "text-red-500"}`}>
                          {totalQty}/{distributePurchase.quantity} qty
                          {remainder === 0 ? " ✓" : remainder > 0 ? ` (${remainder} left)` : " (over!)"}
                        </span>
                      </div>
                    )
                  })()}
                  {distributeError && (
                    <p className="text-xs text-red-600">{distributeError}</p>
                  )}
                  <div className="flex justify-between gap-2">
                    <Button type="button" variant="outline" onClick={() => {
                      setDistributeStage("select")
                      setDistributeError("")
                    }}>
                      ← Change Items
                    </Button>
                    <Button
                      type="button"
                      onClick={handleDistributeSubmit}
                      disabled={isDistributing || distributeItems.filter((i) => i.checked && i.quantity > 0).length === 0}
                    >
                      {isDistributing ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Distributing...</>
                      ) : (
                        "Distribute Bonus"
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

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
          <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
            <span>Delivery:</span>
            {editingDeliveryDate ? (
              <span className="flex items-center gap-1">
                <DateInput
                  value={deliveryDateDraft}
                  onChange={setDeliveryDateDraft}
                  className="h-7 w-36 text-sm"
                />
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSaveDeliveryDate}>
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingDeliveryDate(false)}>
                  <X className="h-3 w-3" />
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span>{formatDate(invoice.delivery_date || invoice.invoice_date)}</span>
                {!isFinalized && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => {
                      setDeliveryDateDraft(invoice.delivery_date || invoice.invoice_date)
                      setEditingDeliveryDate(true)
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Hidden file input for PDF upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handlePdfUpload}
            className="hidden"
          />
          <input
            ref={backupInputRef}
            type="file"
            accept=".zip"
            onChange={handleImportBackup}
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
              { header: "Avg. Unit Cost", accessor: (p) => getDisplayPurchaseCosts(p).unitCost.toFixed(2) },
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
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportBackup}
            disabled={isExportingBackup || purchases.length === 0}
          >
            {isExportingBackup ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting Backup...
              </>
            ) : (
              <>
                <FileDown className="h-4 w-4 mr-2" />
                Export Backup
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => backupInputRef.current?.click()}
            disabled={isImportingBackup}
          >
            {isImportingBackup ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Restoring...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Restore Backup
              </>
            )}
          </Button>
          {isFinalized ? (
            <>
              <span className="flex items-center gap-1 text-green-700 bg-green-50 px-3 py-1.5 rounded-full text-sm font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Finalized
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReopenInvoice}
                disabled={isSavingReconciliationState}
              >
                {isSavingReconciliationState ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Reopening...
                  </>
                ) : (
                  "Reopen Invoice"
                )}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={handleFinalizeInvoice}
              disabled={isSavingReconciliationState || !canFinalize}
            >
              {isSavingReconciliationState ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Finalizing...
                </>
              ) : (
                "Finalize Invoice"
              )}
            </Button>
          )}
          {invoiceReopened && !isFinalized && (
            <span className="flex items-center gap-1 text-orange-700 bg-orange-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              Reopened
            </span>
          )}
          {!isFinalized && canFinalize && (
            <span className="flex items-center gap-1 text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Ready to finalize
            </span>
          )}
          {!isFinalized && !isReconciled && (
            <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              {purchaseCount === 0 ? "No purchases linked" : `${formatCurrency(Math.abs(difference))} ${difference > 0 ? "unaccounted" : "over"}`}
            </span>
          )}
          {!isFinalized && hasReceiptGap && (
            <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              {receiptedCount}/{totalPurchases} receipted
            </span>
          )}
          {!isFinalized && unreconciledLineItemCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              {unreconciledLineItemCount}/{totalPurchases} unreconciled lines
            </span>
          )}
          {isFinalized && (!isReconciled || hasReceiptGap) && (
            <span className="flex items-center gap-1 text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertCircle className="h-4 w-4" />
              Finalized with unresolved checks
            </span>
          )}
        </div>
      </div>

      {reconciliationActionError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {reconciliationActionError}
        </div>
      )}

      {reconciliationActionNotice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {reconciliationActionNotice}
        </div>
      )}

      {!isFinalized && !canFinalize && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-medium">Finalize is blocked until all line items are reconciled.</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {finalizeBlockReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {isFinalized && (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          This invoice is finalized and locked. Line items and receipt allocations are read-only.
        </div>
      )}

      {!isFinalized && invoiceReopened && (
        <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
          This invoice has been reopened. You can edit line items and receipt allocations, then finalize again.
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Subtotal (pre-tax)</p>
            <p className="text-2xl font-bold">{formatCurrency(invoice.subtotal)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              + tax = {formatCurrency(invoice.total)}
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
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void handleAutoAllocateAllPurchases()}
                disabled={
                  isFinalized ||
                  allocationApiUnavailable ||
                  isAutoAllocatingAll ||
                  autoAllocatablePurchases.length === 0
                }
              >
                {isAutoAllocatingAll ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Auto-Allocating...
                  </>
                ) : (
                  "Auto Allocate All"
                )}
              </Button>
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
                  }} disabled={isFinalized}>
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
                  <div className="space-y-2">
                    <Label htmlFor="purchaseType">Type</Label>
                    <Select value={purchaseType} onValueChange={(v) => {
                      setPurchaseType(v as "unit" | "bonus" | "refund")
                      if (v !== "refund") setRefundsPurchaseId("")
                    }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unit">Unit</SelectItem>
                        <SelectItem value="bonus">Bonus</SelectItem>
                        <SelectItem value="refund">Refund</SelectItem>
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
                  {editingPurchaseId && (
                    <div className="space-y-2">
                      <Label htmlFor="costAdjustment">Cost Adjustment (per unit)</Label>
                      <Input
                        id="costAdjustment"
                        type="number"
                        step="0.0001"
                        value={costAdjustment}
                        onChange={(e) => setCostAdjustment(e.target.value)}
                        placeholder="0 (positive = increase cost, negative = decrease)"
                      />
                      {costAdjustment && Number.parseFloat(costAdjustment) !== 0 && (
                        <>
                          <Input
                            id="adjustmentNote"
                            value={adjustmentNote}
                            onChange={(e) => setAdjustmentNote(e.target.value)}
                            placeholder="Reason for adjustment (e.g. bundle promo redistribution)"
                          />
                          <p className="text-xs text-muted-foreground">
                            Adjusts effective cost for economics without changing the receipt cost.
                          </p>
                        </>
                      )}
                    </div>
                  )}
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
                    <div className="text-xs text-muted-foreground bg-blue-50 border border-blue-200 p-3 rounded-md">
                      After saving this bonus line, use the <strong>Distribute</strong> button (
                      <Share2 className="inline h-3 w-3 text-blue-600" />) on the purchase row to attribute it across items.
                    </div>
                  )}
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
                  <TableHead>Receipts</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg. Unit Cost</TableHead>
                  <TableHead className="text-right">Invoice Unit Price</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buildDisplayRows(purchases as PurchaseEconomics[]).map((row) => {
                  if (row.kind === "bonus-group") {
                    const { representative: p, totalQty, totalSelling, totalCommission, attributions } = row
                    return (
                      <TableRow key={`bonus-group-${p.item_id}`} className="bg-blue-50/50">
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <Link to={`/items/${p.item_id}`} className="hover:underline text-primary">
                                {p.item_name}
                              </Link>
                              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">BONUS</span>
                            </div>
                            {attributions.map((a, i) => (
                              <span key={i} className="text-[10px] text-muted-foreground">
                                ↳ {a.parentQty} × {a.parentItemName} (inv #{a.invoiceNumber})
                              </span>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground italic">bonus — no allocation</span>
                        </TableCell>
                        <TableCell className="text-right">{totalQty}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatCurrency(0)}</TableCell>
                        <TableCell className="text-right">{p.invoice_unit_price ? formatCurrency(p.invoice_unit_price) : "-"}</TableCell>
                        <TableCell className="text-right">{formatCurrency(totalSelling)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatCurrency(totalCommission)}
                        </TableCell>
                        <TableCell>
                          <StatusSelect
                            value={p.status}
                            onValueChange={(value) => handleStatusChange(p.purchase_id, value)}
                            disabled={isFinalized}
                          />
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    )
                  }

                  const p = row.purchase
                  const allocs = getEffectiveAllocations(p)
                  const allocated = allocs.reduce((sum, a) => sum + a.allocated_qty, 0)
                  const autoAllocateLineSummary = autoAllocateLineSummaryByPurchase[p.purchase_id]
                  const isPartiallyAllocated = allocated > 0 && allocated < p.quantity
                  const hasUserExpansionState = Object.prototype.hasOwnProperty.call(expandedAllocations, p.purchase_id)
                  const isExpanded = hasUserExpansionState
                    ? !!expandedAllocations[p.purchase_id]
                    : isPartiallyAllocated
                  const displayCosts = getDisplayPurchaseCosts(p)

                  return (
                    <Fragment key={p.purchase_id}>
                      <TableRow className={p.purchase_type === "bonus" ? "bg-blue-50/50" : p.purchase_type === "refund" ? "bg-red-50/50" : ""}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <Link to={`/items/${p.item_id}`} className="hover:underline text-primary">
                                {p.item_name}
                              </Link>
                              {p.purchase_type === "bonus" && (
                                <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">BONUS</span>
                              )}
                              {p.purchase_type === "refund" && (
                                <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">REFUND</span>
                              )}
                            </div>
                            {(() => {
                              const attr = getBonusAttribution(p)
                              return attr.label ? (
                                <span className="text-[10px] text-muted-foreground">{attr.label}</span>
                              ) : null
                            })()}
                          </div>
                        </TableCell>
                        <TableCell>
                          {p.purchase_type === "bonus" ? (
                            <span className="text-xs text-muted-foreground italic">bonus — no allocation</span>
                          ) : allocs.length > 0 ? (
                            <div className="space-y-1">
                              <div className={`text-xs font-medium ${isPartiallyAllocated ? "text-amber-700" : "text-emerald-700"}`}>
                                {allocated}/{p.quantity} allocated
                              </div>
                              <div className="text-[11px] text-muted-foreground">{allocs.length} receipt link{allocs.length > 1 ? "s" : ""}</div>
                              <div className="flex items-center gap-3">
                                {isPartiallyAllocated ? (
                                  <button
                                    onClick={() => toggleAllocationDrilldown(p.purchase_id, isPartiallyAllocated)}
                                    className="text-[11px] text-amber-700 hover:text-amber-800 hover:underline inline-flex items-center gap-1"
                                    title={isExpanded ? "Hide allocation breakdown" : "Show allocation breakdown"}
                                  >
                                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                    partially allocated
                                  </button>
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
                                {isPartiallyAllocated && (
                                  !isFinalized && (
                                  <button
                                    onClick={() => openLinkDialog(p)}
                                    className="text-[11px] text-amber-700 hover:text-amber-800 hover:underline inline-flex items-center gap-1"
                                    title="Link remaining quantity to a receipt"
                                  >
                                    <AlertCircle className="h-3 w-3" />
                                    link receipt
                                  </button>
                                  )
                                )}
                                {isPartiallyAllocated && !isFinalized && (
                                  <button
                                    type="button"
                                    onClick={() => void handleAutoAllocatePurchase(p)}
                                    disabled={
                                      allocationApiUnavailable ||
                                      autoAllocatingPurchaseId === p.purchase_id
                                    }
                                    className="text-[11px] text-muted-foreground hover:underline disabled:opacity-50 disabled:no-underline"
                                    title="Automatically allocate remaining from matching receipt line items"
                                  >
                                    {autoAllocatingPurchaseId === p.purchase_id ? (
                                      <span className="inline-flex items-center gap-1">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        allocating...
                                      </span>
                                    ) : (
                                      "auto allocate"
                                    )}
                                  </button>
                                )}
                                {!isFinalized && (
                                  <button
                                    onClick={() => openLinkDialog(p)}
                                    className="text-[11px] text-muted-foreground hover:underline"
                                    title="Manage allocations"
                                  >
                                    manage allocations
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : (
                            isFinalized ? (
                              <span className="text-red-500 text-xs flex items-center gap-1">
                                <AlertCircle className="h-3 w-3" />
                                unallocated
                              </span>
                            ) : (
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => openLinkDialog(p)}
                                  className="text-red-500 text-xs flex items-center gap-1 hover:underline cursor-pointer"
                                  title="Click to allocate to receipts"
                                >
                                  <AlertCircle className="h-3 w-3" />
                                  unallocated
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleAutoAllocatePurchase(p)}
                                  disabled={
                                    allocationApiUnavailable ||
                                    autoAllocatingPurchaseId === p.purchase_id
                                  }
                                  className="text-[11px] text-muted-foreground hover:underline disabled:opacity-50 disabled:no-underline"
                                  title="Automatically allocate from matching receipt line items"
                                >
                                  {autoAllocatingPurchaseId === p.purchase_id ? (
                                    <span className="inline-flex items-center gap-1">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      allocating...
                                    </span>
                                  ) : (
                                    "auto allocate"
                                  )}
                                </button>
                              </div>
                            )
                          )}
                          {autoAllocateLineSummary && (
                            <div
                              className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                autoAllocateLineSummary.tone === "success"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : autoAllocateLineSummary.tone === "warning"
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-muted text-muted-foreground"
                              }`}
                              title="Last auto-allocation result"
                            >
                              {autoAllocateLineSummary.message}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{p.quantity}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatCurrency(displayCosts.unitCost)}
                          {p.cost_adjustment && Number.parseFloat(p.cost_adjustment) !== 0 && (
                            <span
                              className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700"
                              title={p.adjustment_note || `Cost adjustment: ${p.cost_adjustment}/unit`}
                            >
                              ADJ
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{p.invoice_unit_price ? formatCurrency(p.invoice_unit_price) : "-"}</TableCell>
                        <TableCell className="text-right">{p.total_selling ? formatCurrency(p.total_selling) : formatCurrency(p.total_cost)}</TableCell>
                        <TableCell className={`text-right ${p.total_commission ? (parseFloat(p.total_commission) >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
                          {p.total_commission ? formatCurrency(p.total_commission) : "—"}
                        </TableCell>
                        <TableCell>
                          <StatusSelect
                            value={p.status}
                            onValueChange={(value) => handleStatusChange(p.purchase_id, value)}
                            disabled={isFinalized}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => getBonusAttribution(p).showDistributeAction
                                ? handleOpenDistribute(p)
                                : handleEditPurchase(p)
                              }
                              disabled={isFinalized}
                              title={getBonusAttribution(p).showDistributeAction ? "Distribute bonus" : "Edit"}
                            >
                              {getBonusAttribution(p).showDistributeAction
                                ? <Share2 className="h-4 w-4 text-blue-600" />
                                : <Pencil className="h-4 w-4" />
                              }
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleOpenSplit(p)}
                              disabled={isFinalized}
                              title="Split into multiple items"
                            >
                              <Scissors className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-red-600"
                              onClick={() => handleDeletePurchase(p.purchase_id)}
                              disabled={isFinalized}
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={9} className="bg-muted/30 py-3">
                            <div className={`ml-6 border-l-2 pl-4 space-y-2 ${isPartiallyAllocated ? "border-amber-300" : "border-muted-foreground/20"}`}>
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                  Receipt Allocation Breakdown
                                </div>
                                {!isFinalized && isPartiallyAllocated && (
                                  <button
                                    onClick={() => openLinkDialog(p)}
                                    className="text-[11px] text-amber-700 hover:text-amber-800 hover:underline inline-flex items-center gap-1"
                                    title="Link remaining quantity to a receipt"
                                  >
                                    <AlertCircle className="h-3 w-3" />
                                    link receipt
                                  </button>
                                )}
                              </div>

                              <div className={`border rounded-md bg-background overflow-hidden ${isPartiallyAllocated ? "border-amber-200" : ""}`}>
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

                              <div className={`text-xs ${isPartiallyAllocated ? "text-amber-700" : "text-muted-foreground"}`}>
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
                  <EmptyTableRow colSpan={9}>
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
          setAllocatableReceiptIds([])
          setAllowReceiptDateOverride(false)
          resetAllocationForm()
        }
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{showNewReceipt ? "Add Receipt" : "Link Receipt"}</DialogTitle>
          </DialogHeader>
          {showNewReceipt ? (
            <ReceiptForm
              open={showNewReceipt}
              vendors={vendors}
              requireDocument
              submitLabel="Create"
              submittingLabel="Creating..."
              isSubmitting={createReceipt.isPending}
              onSubmit={handleCreateReceipt}
              onCancel={() => setLinkDialogOpen(false)}
              onBack={() => setShowNewReceipt(false)}
              onImport={() => {
                setLinkDialogOpen(false)
                navigate("/receipts?import=1")
              }}
              importButtonLabel="Import Receipt"
            />
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

              <div className="rounded-md border border-muted p-3 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={allowReceiptDateOverride}
                    onChange={(event) => setAllowReceiptDateOverride(event.target.checked)}
                    disabled={isFinalized}
                    className="mt-0.5"
                  />
                  <span>
                    Allow receipts dated after delivery date ({formatDate(invoice?.delivery_date || invoice?.invoice_date)}) for this line item.
                  </span>
                </label>
                {!allowReceiptDateOverride && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    By default, only receipts on or before the delivery date are eligible.
                  </p>
                )}
              </div>

              {loadingAllocations ? (
                <p className="text-sm text-muted-foreground">Loading allocations...</p>
              ) : allocations.length > 0 ? (
                <div className="space-y-2">
                  <Label>Current Allocations</Label>
                  <div className="border rounded-md divide-y">
                    {allocations.map((a) => (
                      <div key={a.id} className="p-3 text-sm flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
                        <div className="min-w-0">
                          <div className="font-medium break-words">
                            <Link
                              to={`/receipts/${a.receipt_id}`}
                              className="text-primary hover:underline"
                              title="Open receipt details"
                            >
                              {a.receipt_number}
                            </Link>
                            <span> - {a.vendor_name}</span>
                          </div>
                          <div className="text-muted-foreground">Qty {a.allocated_qty} × {formatCurrency(a.unit_cost)}</div>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={isFinalized}
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
                            disabled={isFinalized}
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
                  disabled={isFinalized || loadingAllocatableReceipts || allocatableReceiptIds.length === 0}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder={loadingAllocatableReceipts ? "Finding allocatable receipts..." : "Select receipt"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground">— No receipt</span>
                    </SelectItem>
                    {receipts
                      .filter((r) => allocatableReceiptIds.includes(r.id))
                      .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.receipt_number} - {r.vendor_name} ({formatCurrency(r.total)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loadingAllocatableReceipts ? (
                  <p className="text-xs text-muted-foreground">Finding receipts with allocatable line items...</p>
                ) : allocatableReceiptIds.length === 0 ? (
                  <p className="text-xs text-amber-700">
                    {allowReceiptDateOverride
                      ? "No allocatable receipts found for this product."
                      : `No allocatable receipts on or before delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)}.`}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {allowReceiptDateOverride
                      ? "Showing receipts with allocatable line items for this product (including dates after delivery date)."
                      : `Showing receipts with allocatable line items on or before delivery date ${formatDate(invoice?.delivery_date || invoice?.invoice_date)}.`}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isFinalized}
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
                    disabled={isFinalized}
                    onClick={() => setShowNewReceipt(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Receipt
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
              </div>
              <div className="space-y-2">
                <Label>Quantity (from receipt line) *</Label>
                <Input
                  className="w-full min-w-0"
                  type="number"
                  min={1}
                  max={allocationMaxQty || undefined}
                  value={allocationQty}
                  onChange={(e) => handleAllocationQtyChange(e.target.value)}
                  disabled={isFinalized || !allocationReceiptLineItemId || allocationMaxQty <= 0}
                />
                {allocationCaps ? (
                  <p className="text-xs text-muted-foreground">
                    Receipt remaining: {allocationCaps.receiptCapacity} · Purchase remaining: {allocationCaps.purchaseCapacity} · Max allocatable: {allocationCaps.maxAllocatable}. You can reduce this quantity.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Select a receipt line item to derive quantity.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Receipt Line Item *</Label>
                <Select
                  value={allocationReceiptLineItemId || "__none__"}
                  onValueChange={handleAllocationReceiptLineItemChange}
                  disabled={isFinalized || !allocationReceiptId}
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
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {editingAllocationId && (
                  <Button variant="outline" onClick={resetAllocationForm} disabled={isFinalized}>
                    Reset
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => linkingPurchase && void handleAutoAllocatePurchase(linkingPurchase, {
                    allowReceiptDateOverride,
                  })}
                  disabled={
                    isFinalized ||
                    allocationApiUnavailable ||
                    !linkingPurchase ||
                    isAutoAllocatingCurrentPurchase
                  }
                >
                  {isAutoAllocatingCurrentPurchase ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Auto-allocating...
                    </>
                  ) : (
                    "Auto Allocate"
                  )}
                </Button>
                <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                <Button
                  onClick={handleSaveAllocation}
                  disabled={
                    isFinalized ||
                    updatePurchase.isPending ||
                    createReceipt.isPending ||
                    isAutoAllocatingCurrentPurchase
                  }
                >
                  {updatePurchase.isPending || createReceipt.isPending
                    ? "Saving..."
                    : editingAllocationId
                      ? "Update Allocation"
                      : "Add Allocation"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
