import { useState, useEffect } from "react"
import { useVendors, useCreateVendor, useDestinations, useCreateItem, useUpdateItem } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
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
import { Plus } from "lucide-react"
import type { ActiveItem } from "@/types"

interface ItemFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** If provided, we're editing this item (no start/end date fields shown) */
  editingItem?: ActiveItem | null
  /** Pre-fill values for a new item */
  defaults?: {
    name?: string
    purchaseCost?: string
    defaultDestinationId?: string
    startDate?: string
  }
  /** Called after successful create with the new item id */
  onCreated?: (id: string) => void
  /** Called after successful update */
  onUpdated?: () => void
}

export function ItemFormDialog({
  open,
  onOpenChange,
  editingItem,
  defaults,
  onCreated,
  onUpdated,
}: ItemFormDialogProps) {
  const { data: vendors = [] } = useVendors()
  const { data: destinations = [] } = useDestinations()
  const createItem = useCreateItem()
  const updateItem = useUpdateItem()
  const createVendor = useCreateVendor()

  const [name, setName] = useState("")
  const [vendorId, setVendorId] = useState("")
  const [purchaseCost, setPurchaseCost] = useState("")
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0])
  const [endDate, setEndDate] = useState("")
  const [defaultDestinationId, setDefaultDestinationId] = useState("")
  const [notes, setNotes] = useState("")

  // Inline vendor creation
  const [showNewVendor, setShowNewVendor] = useState(false)
  const [newVendorName, setNewVendorName] = useState("")

  // Reset form when dialog opens/closes or editing item changes
  useEffect(() => {
    if (open) {
      if (editingItem) {
        setName(editingItem.name)
        setVendorId(editingItem.vendor_id)
        setPurchaseCost(editingItem.purchase_cost)
        setDefaultDestinationId(editingItem.default_destination_id || "")
        setNotes(editingItem.notes || "")
        setStartDate("")
        setEndDate("")
      } else {
        setName(defaults?.name || "")
        setVendorId("")
        setPurchaseCost(defaults?.purchaseCost || "")
        setStartDate(defaults?.startDate || new Date().toISOString().split("T")[0])
        setEndDate("")
        setDefaultDestinationId(defaults?.defaultDestinationId || "")
        setNotes("")
      }
      setShowNewVendor(false)
      setNewVendorName("")
    }
  }, [open, editingItem, defaults])

  const handleCreateVendor = async () => {
    if (!newVendorName.trim()) return
    try {
      const { id } = await createVendor.mutateAsync(newVendorName.trim())
      setVendorId(id)
      setShowNewVendor(false)
      setNewVendorName("")
    } catch {
      // keep open on error
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingItem) {
      await updateItem.mutateAsync({
        id: editingItem.id,
        name,
        vendor_id: vendorId,
        purchase_cost: purchaseCost,
        default_destination_id: defaultDestinationId || null,
        notes: notes || null,
      })
      onUpdated?.()
      onOpenChange(false)
    } else {
      const { id } = await createItem.mutateAsync({
        name,
        vendor_id: vendorId,
        purchase_cost: purchaseCost,
        start_date: startDate,
        end_date: endDate || undefined,
        default_destination_id: defaultDestinationId || undefined,
        notes: notes || undefined,
      })
      onCreated?.(id)
      onOpenChange(false)
    }
  }

  const isEditing = !!editingItem

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Item" : "Add Item"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="item-name">Name</Label>
            <Input
              id="item-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="item-vendor">Vendor</Label>
            {showNewVendor ? (
              <div className="flex gap-2">
                <Input
                  value={newVendorName}
                  onChange={(e) => setNewVendorName(e.target.value)}
                  placeholder="New vendor name"
                  className="flex-1"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleCreateVendor() }
                    if (e.key === "Escape") { setShowNewVendor(false); setNewVendorName("") }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateVendor}
                  disabled={createVendor.isPending || !newVendorName.trim()}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowNewVendor(false); setNewVendorName("") }}
                >
                  ✕
                </Button>
              </div>
            ) : (
              <Select
                value={vendorId}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    setShowNewVendor(true)
                  } else {
                    setVendorId(v)
                  }
                }}
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
                  <SelectItem value="__new__" className="text-blue-600">
                    <span className="flex items-center gap-1">
                      <Plus className="h-3 w-3" />
                      Add new vendor…
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="item-purchaseCost">Purchase Cost</Label>
            <Input
              id="item-purchaseCost"
              type="number"
              step="0.0001"
              value={purchaseCost}
              onChange={(e) => setPurchaseCost(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>
          {!isEditing && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="item-startDate">Start Date</Label>
                <DateInput
                  id="item-startDate"
                  value={startDate}
                  onChange={setStartDate}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-endDate">End Date (optional)</Label>
                <DateInput
                  id="item-endDate"
                  value={endDate}
                  onChange={setEndDate}
                />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="item-destination">Default Destination (optional)</Label>
            <Select value={defaultDestinationId || "__none__"} onValueChange={(v) => setDefaultDestinationId(v === "__none__" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select destination" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {destinations.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} - {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="item-notes">Notes (optional)</Label>
            <Input
              id="item-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add a note here"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createItem.isPending || updateItem.isPending || !vendorId}>
              {isEditing ? "Save Changes" : "Create Item"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
