import { useState, useMemo } from "react"
import { useItems, useTransferItem } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ActiveItem } from "@/types"

interface TransferItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceItem: ActiveItem
  onTransferred?: () => void
}

export function TransferItemDialog({
  open,
  onOpenChange,
  sourceItem,
  onTransferred,
}: TransferItemDialogProps) {
  const { data: allItems = [] } = useItems()
  const transferItem = useTransferItem()
  const [search, setSearch] = useState("")
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => {
    const filtered = allItems.filter((i) => i.id !== sourceItem.id)
    if (!search.trim()) return filtered
    const q = search.toLowerCase()
    return filtered.filter((i) => i.name.toLowerCase().includes(q))
  }, [allItems, sourceItem.id, search])

  const selectedTarget = allItems.find((i) => i.id === selectedTargetId)

  const handleTransfer = async () => {
    if (!selectedTargetId) return
    setError(null)
    try {
      await transferItem.mutateAsync({
        sourceId: sourceItem.id,
        targetItemId: selectedTargetId,
      })
      onOpenChange(false)
      onTransferred?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Transfer failed")
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSearch("")
      setSelectedTargetId(null)
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Item</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-sm text-muted-foreground">Transferring from</Label>
            <p className="font-medium">{sourceItem.name}</p>
            <p className="text-xs text-muted-foreground mt-1">
              All purchases and receipt lines will be moved to the target item, then
              &ldquo;{sourceItem.name}&rdquo; will be deleted.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-search">Transfer to</Label>
            <Input
              id="target-search"
              placeholder="Search items..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="border rounded-md max-h-48 overflow-y-auto">
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground p-3 text-center">
                  No matching items
                </p>
              ) : (
                candidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors ${
                      selectedTargetId === item.id
                        ? "bg-primary/10 font-medium"
                        : ""
                    }`}
                    onClick={() => setSelectedTargetId(item.id)}
                  >
                    {item.name}
                    {item.default_destination_code && (
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        ({item.default_destination_code})
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          {selectedTarget && (
            <p className="text-sm">
              Target: <span className="font-medium">{selectedTarget.name}</span>
            </p>
          )}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleTransfer}
              disabled={!selectedTargetId || transferItem.isPending}
            >
              {transferItem.isPending ? "Transferring..." : "Transfer & Delete Source"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
