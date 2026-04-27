import { useState, useMemo } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useItems, useDeleteItem, useInvoices } from "@/hooks/useApi"
import { useMultiSelect } from "@/hooks/useMultiSelect"
import { importApi, type ItemPreview, type PreviewRow } from "@/api"
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
import { ImportDialog } from "@/components/ImportDialog"
import { ItemFormDialog } from "@/components/ItemFormDialog"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { RowActions } from "@/components/RowActions"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { TransferItemDialog } from "@/components/TransferItemDialog"
import { Plus, Trash2, ArrowRightLeft, ArrowUp, ArrowDown } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { ActiveItem } from "@/types"

type SortKey = "name" | "default_destination_code" | "total_qty" | "total_value" | "total_commission" | "avg_unit_commission" | "min_unit_cost" | "avg_unit_cost" | "max_unit_cost" | "last_receipt_date" | "notes"
type SortDir = "asc" | "desc"

function SortableHead({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className = "",
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey | null
  dir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = currentKey === sortKey
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        {active ? (
          dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <span className="h-3 w-3" />
        )}
      </button>
    </TableHead>
  )
}

function ItemPreviewTable({ rows }: { rows: PreviewRow<ItemPreview>[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Row</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Dest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.row}>
            <TableCell className="text-muted-foreground">{row.row}</TableCell>
            <TableCell>{row.data.name}</TableCell>
            <TableCell className="font-mono">{row.data.destination_code || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function ItemsPage() {
  const queryClient = useQueryClient()
  const { data: items = [], isLoading } = useItems()
  const { data: invoices = [] } = useInvoices()
  const deleteItem = useDeleteItem()
  const [isImporting, setIsImporting] = useState(false)

  // Item form dialog state
  const [isOpen, setIsOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ActiveItem | null>(null)

  // Transfer dialog state
  const [transferItem, setTransferItem] = useState<ActiveItem | null>(null)

  // Sorting state
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(
        key === "total_qty" ||
        key === "total_value" ||
        key === "total_commission" ||
        key === "avg_unit_commission" ||
        key === "min_unit_cost" ||
        key === "avg_unit_cost" ||
        key === "max_unit_cost" ||
        key === "last_receipt_date"
          ? "desc"
          : "asc"
      )
    }
  }

  const totalCommission = useMemo(
    () => items.reduce((sum, item) => sum + Number.parseFloat(item.total_commission || "0"), 0),
    [items]
  )

  // Commission % based on finalized invoice cost (same denominator as Invoices page)
  const commissionEligibleCost = useMemo(() => {
    return invoices
      .filter((inv: any) => inv.reconciliation_state === "locked")
      .reduce((sum: number, inv: any) => sum + parseFloat(inv.total_cost || "0"), 0)
  }, [invoices])

  const commissionPct = useMemo(
    () => (commissionEligibleCost > 0 ? (totalCommission / commissionEligibleCost) * 100 : null),
    [totalCommission, commissionEligibleCost]
  )

  const avgItemCommission = useMemo(() => {
    const rowsWithCommission = items
      .map((item) => item.avg_unit_commission)
      .filter((value): value is string => value !== null)

    if (rowsWithCommission.length === 0) return null

    const totalAvg = rowsWithCommission.reduce((sum, value) => sum + Number.parseFloat(value), 0)
    return totalAvg / rowsWithCommission.length
  }, [items])

  const sortedItems = useMemo(() => {
    if (!sortKey) return items
    const dir = sortDir === "asc" ? 1 : -1
    return [...items].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * a.name.localeCompare(b.name)
        case "default_destination_code":
          return dir * (a.default_destination_code || "").localeCompare(b.default_destination_code || "")
        case "total_qty":
          return dir * (a.total_qty - b.total_qty)
        case "total_value":
          return dir * (parseFloat(a.total_value) - parseFloat(b.total_value))
        case "total_commission":
          return dir * (parseFloat(a.total_commission || "0") - parseFloat(b.total_commission || "0"))
        case "avg_unit_commission":
          return dir * (parseFloat(a.avg_unit_commission || "0") - parseFloat(b.avg_unit_commission || "0"))
        case "min_unit_cost":
          return dir * (parseFloat(a.min_unit_cost || "0") - parseFloat(b.min_unit_cost || "0"))
        case "avg_unit_cost":
          return dir * (parseFloat(a.avg_unit_cost || "0") - parseFloat(b.avg_unit_cost || "0"))
        case "max_unit_cost":
          return dir * (parseFloat(a.max_unit_cost || "0") - parseFloat(b.max_unit_cost || "0"))
        case "last_receipt_date":
          return dir * ((a.last_receipt_date || "").localeCompare(b.last_receipt_date || ""))
        case "notes":
          return dir * (a.notes || "").localeCompare(b.notes || "")
        default:
          return 0
      }
    })
  }, [items, sortKey, sortDir])

  const { selectedIds, isDeleting, toggleSelect, toggleSelectAll, handleBulkDelete, allSelected } = useMultiSelect(items)

  const openEditDialog = (item: ActiveItem) => {
    setEditingItem(item)
    setIsOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this item?")) {
      await deleteItem.mutateAsync(id)
    }
  }

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Items (Active)</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="items"
            columns={[
              { header: "Name", accessor: (i: ActiveItem) => i.name },
              { header: "Default Destination", accessor: (i: ActiveItem) => i.default_destination_code },
              { header: "Qty", accessor: (i: ActiveItem) => String(i.total_qty) },
              { header: "Total Value", accessor: (i: ActiveItem) => i.total_value },
              { header: "Total Commission", accessor: (i: ActiveItem) => i.total_commission || "" },
              { header: "Avg Unit Commission", accessor: (i: ActiveItem) => i.avg_unit_commission || "" },
              { header: "Min P.P.", accessor: (i: ActiveItem) => i.min_unit_cost },
              { header: "Avg P.P.", accessor: (i: ActiveItem) => i.avg_unit_cost },
              { header: "Max P.P.", accessor: (i: ActiveItem) => i.max_unit_cost },
              { header: "Last Receipt", accessor: (i: ActiveItem) => i.last_receipt_date },
              { header: "Notes", accessor: (i: ActiveItem) => i.notes },
            ]}
            data={items}
          />
          {selectedIds.size > 0 && (
            <Button 
              variant="destructive" 
              onClick={() => handleBulkDelete((id) => deleteItem.mutateAsync(id), "item(s)")}
              disabled={isDeleting}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete ({selectedIds.size})
            </Button>
          )}
          <ImportDialog<ItemPreview>
            entityName="Items"
            columns={[
              { name: "name / Item", required: true, description: "Item name" },
              { name: "destination / Default Destination", required: false, description: "Default destination code" },
              { name: "notes / Notes", required: false, description: "Optional notes" },
            ]}
            exampleCsv={`Item,Default Destination,Notes
Echo Dot,BSC,Sample item`}
            onPreview={importApi.itemsPreview}
            onImport={async (csv) => {
              setIsImporting(true)
              try {
                return await importApi.items(csv)
              } finally {
                setIsImporting(false)
              }
            }}
            renderPreviewTable={(rows) => <ItemPreviewTable rows={rows} />}
            isPending={isImporting}
            onSuccess={() => queryClient.invalidateQueries({ queryKey: ["items"] })}
          />
          <Button onClick={() => { setEditingItem(null); setIsOpen(true) }}>
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
          <ItemFormDialog
            open={isOpen}
            onOpenChange={(open) => {
              setIsOpen(open)
              if (!open) setEditingItem(null)
            }}
            editingItem={editingItem}
            onCreated={() => {}}
            onUpdated={() => {}}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Items</p>
            <p className="text-2xl font-bold">{items.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Commission</p>
            <p className={`text-2xl font-bold ${totalCommission >= 0 ? "text-green-600" : "text-red-600"}`}>
              {formatCurrency(totalCommission)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Avg Item Commission</p>
            <p className={`text-2xl font-bold ${avgItemCommission === null ? "text-muted-foreground" : avgItemCommission >= 0 ? "text-green-600" : "text-red-600"}`}>
              {avgItemCommission === null ? "-" : formatCurrency(avgItemCommission)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Commission %</p>
            <p className={`text-2xl font-bold ${commissionPct === null ? "text-muted-foreground" : commissionPct >= 0 ? "text-green-600" : "text-red-600"}`}>
              {commissionPct === null ? "-" : `${commissionPct.toFixed(1)}%`}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Items ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                </TableHead>
                <SortableHead label="Name" sortKey="name" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableHead label="Dest" sortKey="default_destination_code" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[80px]" />
                <SortableHead label="Qty" sortKey="total_qty" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[60px] text-right" />
                <SortableHead label="Total Value" sortKey="total_value" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[100px] text-right" />
                <SortableHead label="Total Comm" sortKey="total_commission" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[100px] text-right" />
                <SortableHead label="Avg Comm" sortKey="avg_unit_commission" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[90px] text-right" />
                <SortableHead label="Min P.P." sortKey="min_unit_cost" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[90px] text-right" />
                <SortableHead label="Avg P.P." sortKey="avg_unit_cost" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[90px] text-right" />
                <SortableHead label="Max P.P." sortKey="max_unit_cost" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[90px] text-right" />
                <SortableHead label="Last Receipt" sortKey="last_receipt_date" currentKey={sortKey} dir={sortDir} onSort={toggleSort} className="w-[130px]" />
                <SortableHead label="Notes" sortKey="notes" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <TableHead className="w-[112px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedItems.map((item) => {
                const totalItemCommission = Number.parseFloat(item.total_commission || "0")
                const avgUnitCommission = item.avg_unit_commission ? Number.parseFloat(item.avg_unit_commission) : null
                const hasCommissionRows = item.total_commission !== null

                return (
                <TableRow 
                  key={item.id}
                  className={selectedIds.has(item.id) ? "bg-muted/50" : ""}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                  <TableCell className="font-medium truncate max-w-0">
                    <Link to={`/items/${item.id}`} className="text-blue-600 hover:underline">
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell>{item.default_destination_code || "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{item.total_qty || "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.total_qty ? formatCurrency(item.total_value) : "-"}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${hasCommissionRows ? (totalItemCommission >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
                    {hasCommissionRows ? formatCurrency(totalItemCommission) : "-"}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${avgUnitCommission === null || avgUnitCommission === undefined ? "text-muted-foreground" : avgUnitCommission >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {avgUnitCommission === null || avgUnitCommission === undefined ? "-" : formatCurrency(avgUnitCommission)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.min_unit_cost ? formatCurrency(item.min_unit_cost) : "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.avg_unit_cost ? formatCurrency(item.avg_unit_cost) : "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.max_unit_cost ? formatCurrency(item.max_unit_cost) : "-"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.last_receipt_date ? formatDate(item.last_receipt_date) : "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm truncate max-w-0">
                    {item.notes || "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" title="Transfer to another item" className="text-blue-600" onClick={() => setTransferItem(item)}>
                        <ArrowRightLeft className="h-4 w-4" />
                      </Button>
                      <RowActions
                        onEdit={() => openEditDialog(item)}
                        onDelete={() => handleDelete(item.id)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
                )
              })}
              {items.length === 0 && <EmptyTableRow colSpan={13} message="No items yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {transferItem && (
        <TransferItemDialog
          open={!!transferItem}
          onOpenChange={(open) => { if (!open) setTransferItem(null) }}
          sourceItem={transferItem}
          onTransferred={() => setTransferItem(null)}
        />
      )}
    </div>
  )
}
