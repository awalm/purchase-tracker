import { useState, useEffect } from "react"
import { useDestinations, useCreateItem, useUpdateItem } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import type { ActiveItem } from "@/types"

interface ItemFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** If provided, we're editing this item */
  editingItem?: ActiveItem | null
  /** Pre-fill values for a new item */
  defaults?: {
    name?: string
    defaultDestinationId?: string
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
  const { data: destinations = [] } = useDestinations()
  const createItem = useCreateItem()
  const updateItem = useUpdateItem()

  const [name, setName] = useState("")
  const [defaultDestinationId, setDefaultDestinationId] = useState("")
  const [notes, setNotes] = useState("")

  // Reset form when dialog opens/closes or editing item changes
  useEffect(() => {
    if (open) {
      if (editingItem) {
        setName(editingItem.name)
        setDefaultDestinationId(editingItem.default_destination_id || "")
        setNotes(editingItem.notes || "")
      } else {
        setName(defaults?.name || "")
        setDefaultDestinationId(defaults?.defaultDestinationId || "")
        setNotes("")
      }
    }
  }, [open, editingItem, defaults])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingItem) {
      await updateItem.mutateAsync({
        id: editingItem.id,
        name,
        default_destination_id: defaultDestinationId || null,
        notes: notes || null,
      })
      onUpdated?.()
      onOpenChange(false)
    } else {
      const { id } = await createItem.mutateAsync({
        name,
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
            <Button type="submit" disabled={createItem.isPending || updateItem.isPending}>
              {isEditing ? "Save Changes" : "Create Item"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
