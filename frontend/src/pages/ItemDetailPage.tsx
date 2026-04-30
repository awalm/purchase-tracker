import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useItem,
  useItemReceiptLines,
} from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { TransferItemDialog } from "@/components/TransferItemDialog"
import { ArrowLeft, Package, Pencil, ArrowRightLeft } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { ActiveItem } from "@/types"

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: item, isLoading: itemLoading } = useItem(id || "")
  const { data: receiptLines = [], isLoading: linesLoading } = useItemReceiptLines(id || "")

  useEffect(() => {
    document.title = item ? `${item.name} — BG Tracker` : "Item — BG Tracker"
  }, [item?.name])

  // Edit / Transfer dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)

  if (itemLoading) return <div className="text-muted-foreground">Loading...</div>
  if (!item) return <div className="text-muted-foreground">Item not found</div>

  const totalQty = receiptLines.reduce((sum, r) => sum + r.quantity, 0)
  const totalCost = receiptLines.reduce((sum, r) => sum + parseFloat(r.line_total), 0)
  const receiptCount = new Set(receiptLines.map((r) => r.receipt_id)).size
  const unitCosts = receiptLines.map((r) => parseFloat(r.unit_cost))
  const minCost = unitCosts.length > 0 ? Math.min(...unitCosts) : 0
  const maxCost = unitCosts.length > 0 ? Math.max(...unitCosts) : 0
  const avgCost = totalQty > 0 ? totalCost / totalQty : 0

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
        <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
          <Pencil className="h-4 w-4 mr-2" />
          Edit
        </Button>
        <Button variant="outline" size="sm" onClick={() => setTransferDialogOpen(true)}>
          <ArrowRightLeft className="h-4 w-4 mr-2" />
          Transfer
        </Button>
        <ExportCsvButton
          filename={`item-${item.name}-receipts`}
          columns={[
            { header: "Receipt #", accessor: (r) => r.receipt_number },
            { header: "Vendor", accessor: (r) => r.vendor_name || "" },
            { header: "Date", accessor: (r) => formatDate(r.receipt_date) },
            { header: "Qty", accessor: (r) => r.quantity },
            { header: "Unit Cost", accessor: (r) => r.unit_cost },
            { header: "Line Total", accessor: (r) => r.line_total },
            { header: "Notes", accessor: (r) => r.notes || "" },
          ]}
          data={receiptLines}
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{receiptCount}</div>
            <p className="text-sm text-muted-foreground">Receipts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalQty}</div>
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
            <div className="text-2xl font-bold">{formatCurrency(avgCost.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Avg Unit Cost</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {formatCurrency(minCost.toFixed(2))} – {formatCurrency(maxCost.toFixed(2))}
            </div>
            <p className="text-sm text-muted-foreground">Cost Range</p>
          </CardContent>
        </Card>
      </div>

      {/* Receipt History */}
      <Card>
        <CardHeader>
          <CardTitle>Receipt History ({receiptLines.length} line{receiptLines.length !== 1 ? "s" : ""} across {receiptCount} receipt{receiptCount !== 1 ? "s" : ""})</CardTitle>
        </CardHeader>
        <CardContent>
          {linesLoading ? (
            <p className="text-muted-foreground">Loading receipts...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receiptLines.map((r) => (
                  <TableRow key={r.receipt_line_item_id}>
                    <TableCell>
                      <Link
                        to={`/receipts/${r.receipt_id}`}
                        className="font-mono text-sm text-emerald-600 hover:underline"
                      >
                        {r.receipt_number}
                      </Link>
                    </TableCell>
                    <TableCell>{r.vendor_name || "-"}</TableCell>
                    <TableCell className="text-sm">{formatDate(r.receipt_date)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(r.unit_cost)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(r.line_total)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.notes || "-"}</TableCell>
                  </TableRow>
                ))}
                {receiptLines.length === 0 && (
                  <EmptyTableRow colSpan={7}>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Package className="h-8 w-8" />
                      <p>No receipts for this item yet</p>
                    </div>
                  </EmptyTableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ItemFormDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        editingItem={item as unknown as ActiveItem}
        onUpdated={() => {
          queryClient.invalidateQueries({ queryKey: ["item", id] })
          queryClient.invalidateQueries({ queryKey: ["items"] })
        }}
      />

      {transferDialogOpen && (
        <TransferItemDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          sourceItem={item as unknown as ActiveItem}
          onTransferred={() => {
            setTransferDialogOpen(false)
            navigate("/items")
          }}
        />
      )}
    </div>
  )
}
