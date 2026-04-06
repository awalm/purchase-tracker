import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useItems, useDeleteItem } from "@/hooks/useApi"
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
import { Plus, Trash2 } from "lucide-react"
import type { ActiveItem } from "@/types"

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
  const deleteItem = useDeleteItem()
  const [isImporting, setIsImporting] = useState(false)

  // Item form dialog state
  const [isOpen, setIsOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ActiveItem | null>(null)

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
                <TableHead className="w-[28%]">Name</TableHead>
                <TableHead className="w-[14%]">Default Dest</TableHead>
                <TableHead className="w-[40%]">Notes</TableHead>
                <TableHead className="w-[76px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
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
                  <TableCell className="font-medium truncate max-w-0">{item.name}</TableCell>
                  <TableCell>{item.default_destination_code || "-"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm truncate max-w-0">
                    {item.notes || "-"}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      onEdit={() => openEditDialog(item)}
                      onDelete={() => handleDelete(item.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && <EmptyTableRow colSpan={5} message="No items yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
