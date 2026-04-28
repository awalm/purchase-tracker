import { useState, useEffect } from "react"
import { useCreateVendor } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface VendorFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaults?: { name?: string }
  onCreated?: (id: string) => void
}

function suggestShortId(vendorName: string) {
  const chunks = vendorName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 3).toUpperCase())
    .join("")
  return (chunks || "VND").slice(0, 20)
}

export function VendorFormDialog({
  open,
  onOpenChange,
  defaults,
  onCreated,
}: VendorFormDialogProps) {
  const createVendor = useCreateVendor()

  const [name, setName] = useState("")
  const [shortId, setShortId] = useState("")

  useEffect(() => {
    if (open) {
      setName(defaults?.name || "")
      setShortId("")
    }
  }, [open, defaults])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const { id } = await createVendor.mutateAsync({
      name,
      short_id: shortId || suggestShortId(name),
    })
    onCreated?.(id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Vendor</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vendor-name">Name *</Label>
            <Input
              id="vendor-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Best Buy"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vendor-short-id">Short ID</Label>
            <Input
              id="vendor-short-id"
              value={shortId}
              onChange={(e) => setShortId(e.target.value.toUpperCase())}
              placeholder={suggestShortId(name || "Vendor")}
            />
            <p className="text-xs text-muted-foreground">
              Used for auto receipt numbers: SHORTID-uuid
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createVendor.isPending}>
              {createVendor.isPending ? "Creating..." : "Create Vendor"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
