import { useState } from "react"
import { Link } from "react-router-dom"
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
  const [shortId, setShortId] = useState("")

  const suggestShortId = (vendorName: string) => {
    const chunks = vendorName
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 3).toUpperCase())
      .join("")
    return (chunks || "VND").slice(0, 20)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingId) {
      await updateVendor.mutateAsync({ id: editingId, name, short_id: shortId || undefined })
    } else {
      await createVendor.mutateAsync({
        name,
        short_id: shortId || suggestShortId(name),
      })
    }
    setIsOpen(false)
    setEditingId(null)
    setName("")
    setShortId("")
  }

  const handleEdit = (vendor: { id: string; name: string; short_id?: string | null }) => {
    setEditingId(vendor.id)
    setName(vendor.name)
    setShortId(vendor.short_id || "")
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
              { header: "Short ID", accessor: (v: { short_id?: string | null }) => v.short_id || "" },
            ]}
            data={vendors}
          />
          <ImportDialog<VendorPreview>
            entityName="Vendors"
            columns={[
              { name: "name", required: true, description: "Vendor name" },
              { name: "short_id", required: false, description: "Optional short id prefix for receipt numbers" },
            ]}
            exampleCsv="name,short_id\nBest Buy,BBY\nAmazon,AMZ\nCostco,CST"
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
              setShortId("")
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
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Best Buy"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shortId">Short ID</Label>
                <Input
                  id="shortId"
                  value={shortId}
                  onChange={(e) => setShortId(e.target.value.toUpperCase())}
                  placeholder={suggestShortId(name || "Vendor")}
                />
                <p className="text-xs text-muted-foreground">
                  Used for auto receipt numbers: SHORTID-uuid
                </p>
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
                <TableHead>Short ID</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((vendor) => (
                <TableRow key={vendor.id}>
                  <TableCell>
                    <Link className="text-blue-600 hover:underline" to={`/vendors/${vendor.id}`}>
                      {vendor.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono">{vendor.short_id || "—"}</TableCell>
                  <TableCell>
                    <RowActions
                      onEdit={() => handleEdit(vendor)}
                      onDelete={() => handleDelete(vendor.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {vendors.length === 0 && <EmptyTableRow colSpan={3} message="No vendors yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
