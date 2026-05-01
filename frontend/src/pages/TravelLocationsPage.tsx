import { useState, useRef } from "react"
import {
  useTravelLocations,
  useCreateTravelLocation,
  useUpdateTravelLocation,
  useDeleteTravelLocation,
  useImportTravelLocations,
  useGeocodeTravelLocations,
} from "@/hooks/useApi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { MapPin, Plus, Pencil, Trash2, Globe, Check, X, AlertCircle, FileUp, Loader2 } from "lucide-react"
import type { TravelLocation, GeocodeResponse } from "@/api"

function geocodeStatusBadge(status: string, error: string | null) {
  switch (status) {
    case "geocoded":
      return <span className="inline-flex items-center gap-1 text-xs text-green-700"><Check className="h-3 w-3" /> Geocoded</span>
    case "pending":
      return <span className="inline-flex items-center gap-1 text-xs text-amber-700"><Globe className="h-3 w-3" /> Pending</span>
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-700" title={error || ""}>
          <AlertCircle className="h-3 w-3" /> Failed
        </span>
      )
    default:
      return <span className="text-xs text-gray-500">{status}</span>
  }
}

export default function TravelLocationsPage() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ label: "", chain: "", address: "", location_type: "business" })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const { data: locations, isLoading } = useTravelLocations()
  const createMutation = useCreateTravelLocation()
  const updateMutation = useUpdateTravelLocation()
  const deleteMutation = useDeleteTravelLocation()
  const importMutation = useImportTravelLocations()
  const geocodeMutation = useGeocodeTravelLocations()
  const csvInputRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [geocodeModalOpen, setGeocodeModalOpen] = useState(false)
  const [geocodeResult, setGeocodeResult] = useState<GeocodeResponse | null>(null)
  const [geocodeRequestInfo, setGeocodeRequestInfo] = useState<{
    endpoint: string;
    locationCount: number;
    locationNames: string[];
    mode: string;
  } | null>(null)

  const allSelected = locations && locations.length > 0 && selectedIds.size === locations.length
  const someSelected = selectedIds.size > 0

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(locations?.map((l) => l.id) || []))
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({ label: "", chain: "", address: "", location_type: "business" })
    setDialogOpen(true)
  }

  const openEdit = (loc: TravelLocation) => {
    setEditingId(loc.id)
    setForm({
      label: loc.label,
      chain: loc.chain || "",
      address: loc.address,
      location_type: loc.location_type,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    const data = {
      label: form.label,
      chain: form.chain || undefined,
      address: form.address,
      location_type: form.location_type,
    }
    if (editingId) {
      await updateMutation.mutateAsync({ id: editingId, ...data })
    } else {
      await createMutation.mutateAsync(data)
    }
    setDialogOpen(false)
  }

  const handleDelete = (loc: TravelLocation) => {
    if (window.confirm(`Delete location "${loc.label}"?`)) {
      deleteMutation.mutate(loc.id)
    }
  }

  const handleCsvImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string
        const lines = text.split(/\r?\n/).filter((l) => l.trim())
        if (lines.length < 2) {
          setImportError("CSV must have a header row and at least one data row.")
          return
        }

        // Parse a CSV line respecting quoted fields
        const parseCsvLine = (line: string): string[] => {
          const result: string[] = []
          let current = ""
          let inQuotes = false
          for (let i = 0; i < line.length; i++) {
            const ch = line[i]
            if (inQuotes) {
              if (ch === '"' && line[i + 1] === '"') {
                current += '"'
                i++
              } else if (ch === '"') {
                inQuotes = false
              } else {
                current += ch
              }
            } else if (ch === '"') {
              inQuotes = true
            } else if (ch === ",") {
              result.push(current.trim())
              current = ""
            } else {
              current += ch
            }
          }
          result.push(current.trim())
          return result
        }

        const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())

        // Support both formats:
        // Format A: label,address,chain,type
        // Format B: store,address,city,province,postal code,notes
        const labelIdx = header.indexOf("label")
        const storeIdx = header.indexOf("store")
        const addressIdx = header.indexOf("address")
        const chainIdx = header.indexOf("chain")
        const typeIdx = header.indexOf("type")
        const cityIdx = header.indexOf("city")
        const provinceIdx = header.indexOf("province")
        const postalIdx = header.findIndex((h) => h === "postal code" || h === "postal_code" || h === "postalcode")
        const notesIdx = header.indexOf("notes")

        const isFormatB = storeIdx >= 0 && cityIdx >= 0
        if (!isFormatB && labelIdx === -1) {
          setImportError("CSV must have a 'label' (or 'store') column and an 'address' column.")
          return
        }
        if (addressIdx === -1) {
          setImportError("CSV must have an 'address' column.")
          return
        }

        const locations = lines.slice(1).map((line) => {
          const cols = parseCsvLine(line)

          if (isFormatB) {
            // Store,Address,City,Province,Postal Code,Notes
            const store = cols[storeIdx] || ""
            const addr = cols[addressIdx] || ""
            const city = cityIdx >= 0 ? cols[cityIdx] || "" : ""
            const province = provinceIdx >= 0 ? cols[provinceIdx] || "" : ""
            const postal = postalIdx >= 0 ? cols[postalIdx] || "" : ""
            const notes = notesIdx >= 0 ? cols[notesIdx] || "" : ""
            const fullAddress = [addr, city, province, postal].filter(Boolean).join(", ")
            const excluded = /exclude/i.test(notes)
            return {
              label: `${store} ${city}`.trim(),
              chain: store || undefined,
              address: fullAddress,
              location_type: "business" as const,
              excluded,
            }
          }

          // Format A: label,address,chain,type
          return {
            label: cols[labelIdx] || "",
            chain: chainIdx >= 0 ? cols[chainIdx] || undefined : undefined,
            address: cols[addressIdx] || "",
            location_type: typeIdx >= 0 && cols[typeIdx] ? cols[typeIdx] : "business",
            excluded: false,
          }
        }).filter((l) => l.label && l.address)

        if (locations.length === 0) {
          setImportError("No valid rows found. Each row needs at least a store/label and address.")
          return
        }
        importMutation.mutate(locations)
      } catch {
        setImportError("Failed to parse CSV file.")
      }
    }
    reader.readAsText(file)
    // Reset so the same file can be re-selected
    if (csvInputRef.current) csvInputRef.current.value = ""
  }

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Travel Locations</h1>
        <div className="flex items-center gap-2">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCsvImport}
          />
          <Button
            variant="outline"
            onClick={() => csvInputRef.current?.click()}
            disabled={importMutation.isPending}
          >
            <FileUp className="h-4 w-4 mr-2" />
            {importMutation.isPending ? "Importing..." : "Import from CSV"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setGeocodeResult(null)
              setGeocodeRequestInfo(null)
              setGeocodeModalOpen(true)
            }}
          >
            <Globe className="h-4 w-4 mr-2" />
            {someSelected ? `Geocode Selected (${selectedIds.size})` : "Geocode Pending"}
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4 mr-2" />
                Add Location
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit Location" : "Add Location"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <Label>Label</Label>
                  <Input
                    value={form.label}
                    onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                    placeholder="e.g. Staples Woodstock"
                  />
                </div>
                <div>
                  <Label>Chain (optional)</Label>
                  <Input
                    value={form.chain}
                    onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value }))}
                    placeholder="e.g. Staples"
                  />
                </div>
                <div>
                  <Label>Address</Label>
                  <Input
                    value={form.address}
                    onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                    placeholder="e.g. 245 Connell Rd, Woodstock, NB"
                  />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select
                    value={form.location_type}
                    onValueChange={(v) => setForm((f) => ({ ...f, location_type: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="business">Business</SelectItem>
                      <SelectItem value="personal">Personal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  onClick={handleSave}
                  disabled={!form.label || !form.address || createMutation.isPending || updateMutation.isPending}
                >
                  {editingId ? "Update" : "Create"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {importError && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
          {importError}
        </div>
      )}

      {importMutation.isSuccess && importMutation.data && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
          Imported {importMutation.data.imported} locations
          {importMutation.data.skipped > 0 && `, ${importMutation.data.skipped} skipped (already exist)`}.
        </div>
      )}

      {geocodeMutation.isSuccess && geocodeMutation.data && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
          Geocoded {geocodeMutation.data.success} locations
          {geocodeMutation.data.failed > 0 && `, ${geocodeMutation.data.failed} failed`}
          {" "}via {geocodeMutation.data.provider}.
        </div>
      )}

      {/* Geocode Modal */}
      <Dialog open={geocodeModalOpen} onOpenChange={setGeocodeModalOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Geocode Locations
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Pre-run info */}
            {!geocodeResult && !geocodeMutation.isPending && (() => {
              const targetLocations = someSelected
                ? locations?.filter((l) => selectedIds.has(l.id)) || []
                : locations?.filter((l) => l.geocode_status === "pending" || l.geocode_status === "failed") || []
              const pendingCount = locations?.filter((l) => l.geocode_status === "pending").length ?? 0
              const failedCount = locations?.filter((l) => l.geocode_status === "failed").length ?? 0
              const resolvedCount = locations?.filter((l) => l.geocode_status === "resolved").length ?? 0

              return (
                <>
                  {/* Request info */}
                  <div className="bg-slate-50 border rounded p-3 space-y-2 text-sm font-mono">
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">Endpoint:</span>
                      <span className="break-all">POST /api/travel/locations/geocode</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">Mode:</span>
                      <span>{someSelected ? `Selected (${selectedIds.size} locations, any status)` : `Auto (${pendingCount} pending + ${failedCount} failed)`}</span>
                    </div>
                  </div>

                  {/* Summary counts */}
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-amber-50 border border-amber-200 rounded p-2 text-center">
                      <span className="block text-xs text-amber-700">Pending</span>
                      <span className="font-semibold text-amber-800">{pendingCount}</span>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded p-2 text-center">
                      <span className="block text-xs text-red-700">Failed</span>
                      <span className="font-semibold text-red-800">{failedCount}</span>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded p-2 text-center">
                      <span className="block text-xs text-green-700">Resolved</span>
                      <span className="font-semibold text-green-800">{resolvedCount}</span>
                    </div>
                  </div>

                  {/* Locations to be geocoded */}
                  {targetLocations.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        Will geocode {targetLocations.length} location(s):
                      </p>
                      <div className="max-h-40 overflow-y-auto border rounded text-xs">
                        <table className="w-full">
                          <thead className="bg-slate-50 sticky top-0">
                            <tr>
                              <th className="text-left px-2 py-1 font-medium">Label</th>
                              <th className="text-left px-2 py-1 font-medium">Address</th>
                              <th className="text-left px-2 py-1 font-medium w-16">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {targetLocations.map((l) => (
                              <tr key={l.id} className="border-t">
                                <td className="px-2 py-1 font-medium">{l.label}</td>
                                <td className="px-2 py-1 truncate max-w-[250px]" title={l.address}>{l.address}</td>
                                <td className="px-2 py-1">{geocodeStatusBadge(l.geocode_status, l.geocode_error)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Provider is determined server-side: Google Maps if <code className="bg-slate-100 px-1 rounded">GOOGLE_MAPS_API_KEY</code> is set, otherwise Nominatim (OpenStreetMap).
                  </p>

                  <div className="flex justify-end">
                    <Button
                      onClick={() => {
                        const ids = someSelected ? Array.from(selectedIds) : undefined
                        const targetLocs = someSelected
                          ? locations?.filter((l) => selectedIds.has(l.id)) || []
                          : locations?.filter((l) => l.geocode_status === "pending" || l.geocode_status === "failed") || []
                        setGeocodeRequestInfo({
                          endpoint: "POST /api/travel/locations/geocode",
                          locationCount: targetLocs.length,
                          locationNames: targetLocs.map((l) => `${l.label} — ${l.address}`),
                          mode: someSelected ? `Selected (${selectedIds.size})` : "Auto (pending + failed)",
                        })
                        geocodeMutation.mutate(ids, {
                          onSuccess: (data) => {
                            setGeocodeResult(data)
                            setSelectedIds(new Set())
                          },
                        })
                      }}
                      disabled={
                        !someSelected &&
                        (locations?.filter((l) => l.geocode_status === "pending" || l.geocode_status === "failed").length ?? 0) === 0
                      }
                    >
                      <Globe className="h-4 w-4 mr-2" />
                      {someSelected ? `Geocode ${selectedIds.size} Selected` : "Start Geocoding"}
                    </Button>
                  </div>
                </>
              )
            })()}

            {/* In progress */}
            {geocodeMutation.isPending && geocodeRequestInfo && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 py-2">
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  <span className="text-sm font-medium">Geocoding in progress...</span>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded p-3 space-y-2 text-sm font-mono">
                  <div className="flex items-start gap-2">
                    <span className="text-blue-700 shrink-0">Endpoint:</span>
                    <span>{geocodeRequestInfo.endpoint}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-700 shrink-0">Mode:</span>
                    <span>{geocodeRequestInfo.mode}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-700 shrink-0">Count:</span>
                    <span>{geocodeRequestInfo.locationCount} locations</span>
                  </div>
                </div>

                {geocodeRequestInfo.locationNames.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Geocoding:</p>
                    <div className="max-h-32 overflow-y-auto border rounded text-xs p-2 space-y-0.5">
                      {geocodeRequestInfo.locationNames.map((name, i) => (
                        <div key={i} className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                          <span className="truncate">{name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Server geocodes sequentially with rate limiting (Google: 100ms, Nominatim: 1.1s per address).
                </p>
              </div>
            )}

            {/* Error */}
            {geocodeMutation.isError && (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
                {geocodeMutation.error instanceof Error ? geocodeMutation.error.message : "Geocoding failed"}
              </div>
            )}

            {/* Results */}
            {geocodeResult && (() => {
              const remainingPending = locations?.filter(
                (l) => l.geocode_status === "pending" || l.geocode_status === "failed"
              ) || []

              return (
                <div className="space-y-4">
                  {/* Provider & summary */}
                  <div className="bg-slate-50 border rounded p-3 space-y-1 text-sm font-mono">
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">Provider:</span>
                      <span className="font-semibold">{geocodeResult.provider}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">Endpoint:</span>
                      <span>{geocodeResult.provider.includes("Google") ? "maps.googleapis.com/maps/api/geocode/json" : "nominatim.openstreetmap.org/search"}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-slate-50 border rounded p-2 text-center">
                      <span className="block text-xs text-muted-foreground">Processed</span>
                      <span className="font-semibold">{geocodeResult.total}</span>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded p-2 text-center">
                      <span className="block text-xs text-green-700">Succeeded</span>
                      <span className="font-semibold text-green-800">{geocodeResult.success}</span>
                    </div>
                    <div className={`${geocodeResult.failed > 0 ? "bg-red-50 border-red-200" : "bg-slate-50"} border rounded p-2 text-center`}>
                      <span className={`block text-xs ${geocodeResult.failed > 0 ? "text-red-700" : "text-muted-foreground"}`}>Failed</span>
                      <span className={`font-semibold ${geocodeResult.failed > 0 ? "text-red-800" : ""}`}>{geocodeResult.failed}</span>
                    </div>
                  </div>

                  {/* Per-address details */}
                  {geocodeResult.details.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Results:</p>
                      <div className="max-h-56 overflow-y-auto border rounded">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 sticky top-0">
                            <tr>
                              <th className="text-left px-2 py-1 font-medium">Address</th>
                              <th className="text-left px-2 py-1 font-medium w-16">Status</th>
                              <th className="text-left px-2 py-1 font-medium w-40">Coordinates / Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {geocodeResult.details.map((d, i) => (
                              <tr key={i} className="border-t">
                                <td className="px-2 py-1 truncate max-w-[220px]" title={d.address}>
                                  {d.address}
                                </td>
                                <td className="px-2 py-1">
                                  {d.status === "ok" ? (
                                    <span className="text-green-700 flex items-center gap-1"><Check className="h-3 w-3" /> OK</span>
                                  ) : (
                                    <span className="text-red-700 flex items-center gap-1"><X className="h-3 w-3" /> Fail</span>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {d.status === "ok" && d.lat != null && d.lng != null ? (
                                    <span className="font-mono">{d.lat.toFixed(5)}, {d.lng.toFixed(5)}</span>
                                  ) : d.error ? (
                                    <span className="text-red-600 truncate block max-w-[140px]" title={d.error}>{d.error}</span>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Still pending */}
                  {remainingPending.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm">
                      <p className="font-medium text-amber-800 mb-1">
                        {remainingPending.length} location(s) still unresolved:
                      </p>
                      <ul className="text-xs text-amber-700 space-y-0.5 max-h-24 overflow-y-auto">
                        {remainingPending.map((l) => (
                          <li key={l.id} className="flex items-center gap-1">
                            {l.geocode_status === "failed" ? <X className="h-3 w-3 text-red-600 shrink-0" /> : <Globe className="h-3 w-3 shrink-0" />}
                            <span className="truncate">{l.label} — {l.address}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setGeocodeModalOpen(false)}>
                      Close
                    </Button>
                  </div>
                </div>
              )
            })()}
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Locations ({locations?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={!!allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Chain</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Coordinates</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations?.map((loc) => (
                <TableRow key={loc.id} className={selectedIds.has(loc.id) ? "bg-blue-50" : ""}>
                  <TableCell className="w-8">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(loc.id)}
                      onChange={() => toggleSelect(loc.id)}
                      className="rounded"
                    />
                  </TableCell>
                  <TableCell className="font-medium">{loc.label}</TableCell>
                  <TableCell>{loc.chain || "—"}</TableCell>
                  <TableCell className="text-sm">{loc.address}</TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-0.5 rounded ${loc.location_type === "business" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800"}`}>
                      {loc.location_type === "business" ? "Business" : "Personal"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {loc.latitude != null && loc.longitude != null
                      ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`
                      : "—"}
                  </TableCell>
                  <TableCell>{geocodeStatusBadge(loc.geocode_status, loc.geocode_error)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(loc)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => handleDelete(loc)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(!locations || locations.length === 0) && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No locations configured. Add stores manually or import from CSV.
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
