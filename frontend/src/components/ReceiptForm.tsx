import { useEffect, useRef, useState } from "react"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type VendorOption = {
  id: string
  name: string
}

export type ReceiptFormSubmitData = {
  vendor_id: string
  receipt_number: string
  receipt_date: string
  subtotal: string
  tax_amount: string
  payment_method: string
  notes: string
  document_file: File | null
}

type ReceiptFormInitialValues = Partial<Omit<ReceiptFormSubmitData, "document_file">>

interface ReceiptFormProps {
  open: boolean
  vendors: VendorOption[]
  initialValues?: ReceiptFormInitialValues
  submitLabel: string
  submittingLabel?: string
  isSubmitting?: boolean
  requireDocument?: boolean
  onSubmit: (data: ReceiptFormSubmitData) => Promise<void> | void
  onCancel: () => void
  onBack?: () => void
  onImport?: () => void
  importButtonLabel?: string
  onDirtyChange?: (dirty: boolean) => void
}

export function ReceiptForm({
  open,
  vendors,
  initialValues,
  submitLabel,
  submittingLabel,
  isSubmitting = false,
  requireDocument = false,
  onSubmit,
  onCancel,
  onBack,
  onImport,
  importButtonLabel = "Import Receipt",
  onDirtyChange,
}: ReceiptFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [vendorId, setVendorId] = useState("")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [receiptDate, setReceiptDate] = useState("")
  const [subtotal, setSubtotal] = useState("")
  const [taxAmount, setTaxAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("")
  const [notes, setNotes] = useState("")
  const [documentFile, setDocumentFile] = useState<File | null>(null)
  const [validationError, setValidationError] = useState("")

  useEffect(() => {
    if (!open) return

    setVendorId(initialValues?.vendor_id || "")
    setReceiptNumber(initialValues?.receipt_number || "")
    setReceiptDate(initialValues?.receipt_date || "")
    setSubtotal(initialValues?.subtotal || "")
    setTaxAmount(initialValues?.tax_amount || "")
    setPaymentMethod(initialValues?.payment_method || "")
    setNotes(initialValues?.notes || "")
    setDocumentFile(null)
    setValidationError("")
  }, [
    open,
    initialValues?.vendor_id,
    initialValues?.receipt_number,
    initialValues?.receipt_date,
    initialValues?.subtotal,
    initialValues?.tax_amount,
    initialValues?.payment_method,
    initialValues?.notes,
  ])

  useEffect(() => {
    if (!onDirtyChange) return

    if (!open) {
      onDirtyChange(false)
      return
    }

    const initialVendorId = initialValues?.vendor_id || ""
    const initialReceiptNumber = initialValues?.receipt_number || ""
    const initialReceiptDate = initialValues?.receipt_date || ""
    const initialSubtotal = initialValues?.subtotal || ""
    const initialTaxAmount = initialValues?.tax_amount || ""
    const initialPaymentMethod = initialValues?.payment_method || ""
    const initialNotes = initialValues?.notes || ""

    const dirty =
      vendorId !== initialVendorId ||
      receiptNumber !== initialReceiptNumber ||
      receiptDate !== initialReceiptDate ||
      subtotal !== initialSubtotal ||
      taxAmount !== initialTaxAmount ||
      paymentMethod !== initialPaymentMethod ||
      notes !== initialNotes ||
      documentFile !== null

    onDirtyChange(dirty)
  }, [
    open,
    onDirtyChange,
    initialValues,
    vendorId,
    receiptNumber,
    receiptDate,
    subtotal,
    taxAmount,
    paymentMethod,
    notes,
    documentFile,
  ])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setValidationError("")

    if (requireDocument && !documentFile) {
      setValidationError("Choose a receipt document before saving.")
      return
    }

    await onSubmit({
      vendor_id: vendorId,
      receipt_number: receiptNumber,
      receipt_date: receiptDate,
      subtotal,
      tax_amount: taxAmount,
      payment_method: paymentMethod,
      notes,
      document_file: documentFile,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="receipt-vendor">Vendor *</Label>
        <Select value={vendorId} onValueChange={setVendorId} required>
          <SelectTrigger id="receipt-vendor">
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
        <Label htmlFor="receipt-number">Receipt Number</Label>
        <Input
          id="receipt-number"
          value={receiptNumber}
          onChange={(e) => setReceiptNumber(e.target.value)}
          placeholder="Auto-generated if empty"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="receipt-date">Receipt Date *</Label>
        <Input
          id="receipt-date"
          type="date"
          value={receiptDate}
          onChange={(e) => setReceiptDate(e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="receipt-subtotal">Subtotal *</Label>
          <Input
            id="receipt-subtotal"
            type="number"
            step="0.01"
            value={subtotal}
            onChange={(e) => setSubtotal(e.target.value)}
            placeholder="0.00"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="receipt-tax-amount">Tax Amount *</Label>
          <Input
            id="receipt-tax-amount"
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
        <Label htmlFor="payment-method">Payment Method</Label>
        <Input
          id="payment-method"
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          placeholder="Optional (e.g. Gift Card, Visa 1234)"
        />
      </div>

      <div className="space-y-2">
        <Label>Receipt Document {requireDocument ? "*" : ""}</Label>
        <Input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            setDocumentFile(e.target.files?.[0] || null)
            setValidationError("")
          }}
        />
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
            Choose document
          </Button>
          <span className="text-sm text-muted-foreground truncate">
            {documentFile ? documentFile.name : "No file chosen"}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="receipt-notes">Notes</Label>
        <Input
          id="receipt-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes..."
        />
      </div>

      {validationError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {validationError}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {onBack && (
            <Button type="button" variant="link" className="px-0" onClick={onBack}>
              ← Back
            </Button>
          )}
          {onImport && (
            <Button type="button" variant="outline" onClick={onImport}>
              <Upload className="h-4 w-4 mr-2" />
              {importButtonLabel}
            </Button>
          )}
        </div>
        <div className="flex gap-2 sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? submittingLabel || "Saving..." : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}