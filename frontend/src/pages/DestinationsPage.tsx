import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useDestinations,
  useCreateDestination,
  useUpdateDestination,
  useDeleteDestination,
} from "@/hooks/useApi"
import { importApi, type DestinationPreview, type PreviewRow } from "@/api"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Plus } from "lucide-react"

function DestinationPreviewTable({ rows }: { rows: PreviewRow<DestinationPreview>[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Row</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Name</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.row}>
            <TableCell className="text-muted-foreground">{row.row}</TableCell>
            <TableCell className="font-mono">{row.data.code}</TableCell>
            <TableCell>{row.data.name}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function DestinationsPage() {
  const queryClient = useQueryClient()
  const { data: destinations = [], isLoading } = useDestinations()
  const createDestination = useCreateDestination()
  const updateDestination = useUpdateDestination()
  const deleteDestination = useDeleteDestination()
  const [isImporting, setIsImporting] = useState(false)

  const [isOpen, setIsOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [isActive, setIsActive] = useState(true)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingId) {
      await updateDestination.mutateAsync({ id: editingId, code, name, is_active: isActive })
    } else {
      await createDestination.mutateAsync({ code, name })
    }
    setIsOpen(false)
    setEditingId(null)
    setCode("")
    setName("")
    setIsActive(true)
  }

  const handleEdit = (dest: { id: string; code: string; name: string; is_active: boolean }) => {
    setEditingId(dest.id)
    setCode(dest.code)
    setName(dest.name)
    setIsActive(dest.is_active)
    setIsOpen(true)
  }

  const handleToggleActive = async (dest: { id: string; is_active: boolean }) => {
    await updateDestination.mutateAsync({ id: dest.id, is_active: !dest.is_active })
  }

  const handleDelete = async (id: string) => {
    if (confirm("Delete this destination?")) {
      await deleteDestination.mutateAsync(id)
    }
  }

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Destinations</h1>
        <div className="flex gap-2">
          <ExportCsvButton
            filename="destinations"
            columns={[
              { header: "Code", accessor: (d: { code: string; name: string; is_active: boolean }) => d.code },
              { header: "Name", accessor: (d: { code: string; name: string; is_active: boolean }) => d.name },
              { header: "Active", accessor: (d: { code: string; name: string; is_active: boolean }) => d.is_active ? "Yes" : "No" },
            ]}
            data={destinations}
          />
          <ImportDialog<DestinationPreview>
            entityName="Destinations"
            columns={[
              { name: "code", required: true, description: "Unique destination code (e.g., CBG)" },
              { name: "name", required: true, description: "Full destination name" },
            ]}
            exampleCsv="code,name\nCBG,Canadian Buying Group\nUSB,US Buyers"
            onPreview={importApi.destinationsPreview}
            onImport={async (csv) => {
              setIsImporting(true)
              try {
                return await importApi.destinations(csv)
              } finally {
                setIsImporting(false)
              }
            }}
            renderPreviewTable={(rows) => <DestinationPreviewTable rows={rows} />}
            isPending={isImporting}
            onSuccess={() => queryClient.invalidateQueries({ queryKey: ["destinations"] })}
          />
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open)
            if (!open) {
              setEditingId(null)
              setCode("")
              setName("")
              setIsActive(true)
            }
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Destination
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Destination" : "Add Destination"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g., CBG"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Canadian Buying Group"
                  required
                />
              </div>
              {editingId && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="is_active"
                    checked={isActive}
                    onChange={(e) => setIsActive((e.target as HTMLInputElement).checked)}
                  />
                  <Label htmlFor="is_active">Active</Label>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createDestination.isPending || updateDestination.isPending}
                >
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
          <CardTitle>All Destinations</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map((dest) => (
                <TableRow key={dest.id}>
                  <TableCell className="font-mono">{dest.code}</TableCell>
                  <TableCell>{dest.name}</TableCell>
                  <TableCell>
                    <button
                      onClick={() => handleToggleActive(dest)}
                      className={`inline-flex px-2 py-1 rounded text-xs font-medium cursor-pointer transition-colors hover:opacity-80 ${
                        dest.is_active
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                      title={dest.is_active ? "Click to deactivate" : "Click to activate"}
                    >
                      {dest.is_active ? "Active" : "Inactive"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <RowActions
                      onEdit={() => handleEdit(dest)}
                      onDelete={() => handleDelete(dest.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {destinations.length === 0 && <EmptyTableRow colSpan={4} message="No destinations yet" />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
