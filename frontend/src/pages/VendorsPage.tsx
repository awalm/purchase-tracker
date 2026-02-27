import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVendors, useCreateVendor, useUpdateVendor, useDeleteVendor } from "@/hooks/useApi"
import { importApi, type VendorPreview, type PreviewRow } from "@/api"
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
import { ImportDialog } from "@/components/ImportDialog"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { RowActions } from "@/components/RowActions"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { Plus } from "lucide-react"

function VendorPreviewTable({ rows }: { rows: PreviewRow<VendorPreview>[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Row</TableHead>
          <TableHead>Name</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.row}>
            <TableCell className="text-muted-foreground">{row.row}</TableCell>
            <TableCell>{row.data.name}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function VendorsPage() {
  const queryClient = useQueryClient()
  const { data: vendors = [], isLoading } = useVendors()
  const createVendor = useCreateVendor()
  const updateVendor = useUpdateVendor()
  const deleteVendor = useDeleteVendor()
  const [isImporting, setIsImporting] = useState(false)

  const [isOpen, setIsOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingId) {
      await updateVendor.mutateAsync({ id: editingId, name })
    } else {
      await createVendor.mutateAsync(name)
    }
    setIsOpen(false)
    setEditingId(null)
    setName("")
  }

  const handleEdit = (vendor: { id: string; name: string }) => {
    setEditingId(vendor.id)
    setName(vendor.name)
    setIsOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this vendor?")) {
      await deleteVendor.mutateAsync(id)
    }
  }

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Vendors</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="vendors"
            columns={[
              { header: "Name", accessor: (v: { name: string }) => v.name },
            ]}
            data={vendors}
          />
          <ImportDialog<VendorPreview>
            entityName="Vendors"
            columns={[
              { name: "name", required: true, description: "Vendor name" },
            ]}
            exampleCsv="name\nBest Buy\nAmazon\nCostco"
            onPreview={importApi.vendorsPreview}
            onImport={async (csv) => {
              setIsImporting(true)
              try {
                return await importApi.vendors(csv)
              } finally {
                setIsImporting(false)
              }
            }}
            renderPreviewTable={(rows) => <VendorPreviewTable rows={rows} />}
            isPending={isImporting}
            onSuccess={() => queryClient.invalidateQueries({ queryKey: ["vendors"] })}
          />
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open)
            if (!open) {
              setEditingId(null)
              setName("")
            }
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Vendor
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Vendor" : "Add Vendor"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Best Buy"
                  required
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createVendor.isPending || updateVendor.isPending}>
                  {editingId ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Vendors</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((vendor) => (
                <TableRow key={vendor.id}>
                  <TableCell>{vendor.name}</TableCell>
                  <TableCell>
                    <RowActions
                      onEdit={() => handleEdit(vendor)}
                      onDelete={() => handleDelete(vendor.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {vendors.length === 0 && <EmptyTableRow colSpan={2} message="No vendors yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
