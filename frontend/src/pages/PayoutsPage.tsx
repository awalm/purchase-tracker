import { useState } from "react"
import { usePayouts, useCreatePayout, useDeletePayout, useItems, useDestinations } from "@/hooks/useApi"
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
import { Plus, Trash2 } from "lucide-react"
import { formatCurrency } from "@/lib/utils"

export default function PayoutsPage() {
  const { data: payouts = [], isLoading } = usePayouts()
  const { data: items = [] } = useItems()
  const { data: destinations = [] } = useDestinations()
  const createPayout = useCreatePayout()
  const deletePayout = useDeletePayout()

  const [isOpen, setIsOpen] = useState(false)
  const [itemId, setItemId] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [payoutPrice, setPayoutPrice] = useState("")
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0])
  const [notes, setNotes] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await createPayout.mutateAsync({
      item_id: itemId,
      destination_id: destinationId,
      payout_price: payoutPrice,
      start_date: startDate,
      notes: notes || undefined,
    })
    setIsOpen(false)
    resetForm()
  }

  const resetForm = () => {
    setItemId("")
    setDestinationId("")
    setPayoutPrice("")
    setStartDate(new Date().toISOString().split("T")[0])
    setNotes("")
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this payout?")) {
      await deletePayout.mutateAsync(id)
    }
  }

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Payouts (Active)</h1>
        <Dialog open={isOpen} onOpenChange={(open) => {
          setIsOpen(open)
          if (!open) resetForm()
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Payout
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add Payout</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="destination">Destination</Label>
                <Select value={destinationId} onValueChange={setDestinationId} required>
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
                <Label htmlFor="item">Item</Label>
                <Select value={itemId} onValueChange={setItemId} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select item" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name} ({i.vendor_name})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="payoutPrice">Payout Price</Label>
                  <Input
                    id="payoutPrice"
                    type="number"
                    step="0.01"
                    value={payoutPrice}
                    onChange={(e) => setPayoutPrice(e.target.value)}
                    placeholder="0.00"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any notes..."
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createPayout.isPending}>
                  Create
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Payouts</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Payout Price</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-16">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((payout) => (
                <TableRow key={payout.id}>
                  <TableCell className="font-medium">{payout.item_name}</TableCell>
                  <TableCell>{payout.destination_code}</TableCell>
                  <TableCell className="text-right">{formatCurrency(payout.payout_price)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {payout.notes || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => handleDelete(payout.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {payouts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No payouts yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
