import React, { useState, useMemo, useCallback, useRef, useEffect, Component } from "react"
import type { ErrorInfo, ReactNode } from "react"
import {
  useTravelUploads,
  useTravelSummary,
  useTravelSegments,
  useUploadTimeline,
  useDeleteTravelUpload,
  useReparseTravelUpload,
  useClassifySegment,
  useTripLogs,
  useCreateTripLog,
  useUpdateTripLog,
  useDeleteTripLog,
  useReceiptLocations,
} from "@/hooks/useApi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
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
import {
  Upload,
  Briefcase,
  Home,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  Trash2,
  MapPin,
  RefreshCw,
  Car,
  Save,
  CheckCircle,
  FileText,
  Receipt,
  AlertTriangle,
} from "lucide-react"
import { MapContainer, Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import GoogleTileLayer from "@/components/ui/google-tile-layer"
import { travel } from "@/api"
import type { TravelSegment, TravelTripSummary, TravelUpload, TravelTripLog } from "@/api"
import type { ReceiptWithVendor } from "@/types"

function formatKm(km: number | null | undefined): string {
  if (km == null) return "—"
  return km.toFixed(1) + " km"
}

function formatMetersAsKm(meters: number | null | undefined): string {
  if (meters == null) return "—"
  return (meters / 1000).toFixed(1) + " km"
}

function formatPct(value: number | null | undefined): string {
  if (value == null) return "—"
  return value.toFixed(1) + "%"
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = formatTime(start)
  const e = formatTime(end)
  if (!s && !e) return ""
  if (s && e) return `${s}–${e}`
  return s || e
}

// Auto-fit map bounds
function FitBounds({ bounds }: { bounds: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [20, 20] })
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 13)
    }
  }, [map, bounds])
  return null
}

class MapErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Map render error:", error, info)
  }
  render() {
    if (this.state.error) {
      return <div className="text-xs text-red-600 py-2">Map failed to render: {this.state.error}</div>
    }
    return this.props.children
  }
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  business: "#15803d",
  personal: "#1d4ed8",
  commute: "#b45309",
  unclassified: "#6b7280",
}

// Route cache persists across re-renders / remounts so we don't re-fetch routes
const routeCache = new Map<string, [number, number][]>()

function TripMap({ segments, receiptLocations }: { segments: TravelSegment[]; receiptLocations?: ReceiptWithVendor[] }) {
  const [snappedRoutes, setSnappedRoutes] = useState<Map<string, [number, number][]>>(new Map())
  const [snapping, setSnapping] = useState(false)
  const [routeErrors, setRouteErrors] = useState<string[]>([])

  const { points, drives, visits } = useMemo(() => {
    const pts: [number, number][] = []
    const drvs: { key: string; positions: [number, number][]; color: string; label: string }[] = []
    const vsts: { pos: [number, number]; label: string; color: string }[] = []

    for (const seg of segments) {
      if (seg.segment_type === "drive" && seg.start_lat != null && seg.start_lng != null && seg.end_lat != null && seg.end_lng != null) {
        const start: [number, number] = [seg.start_lat, seg.start_lng]
        const end: [number, number] = [seg.end_lat, seg.end_lng]
        pts.push(start, end)
        drvs.push({
          key: `${seg.start_lat},${seg.start_lng}-${seg.end_lat},${seg.end_lng}`,
          positions: [start, end],
          color: CLASSIFICATION_COLORS[seg.classification] || CLASSIFICATION_COLORS.unclassified,
          label: `${seg.from_location || "?"} → ${seg.to_location || "?"} (${seg.distance_meters ? (seg.distance_meters / 1000).toFixed(1) + " km" : "?"})`,
        })
      } else if (seg.segment_type === "visit" && seg.start_lat != null && seg.start_lng != null) {
        const pos: [number, number] = [seg.start_lat, seg.start_lng]
        pts.push(pos)
        vsts.push({
          pos,
          label: seg.from_location || "Unknown",
          color: CLASSIFICATION_COLORS[seg.classification] || CLASSIFICATION_COLORS.unclassified,
        })
      }
    }
    return { points: pts, drives: drvs, visits: vsts }
  }, [segments])

  // Fetch road-snapped routes via backend (Google Maps Directions)
  useEffect(() => {
    if (drives.length === 0) return
    let cancelled = false

    const fetchRoutes = async () => {
      setSnapping(true)
      setRouteErrors([])
      const newRoutes = new Map<string, [number, number][]>()
      const errors: string[] = []

      for (const d of drives) {
        if (cancelled) break
        // Use cache if available
        if (routeCache.has(d.key)) {
          newRoutes.set(d.key, routeCache.get(d.key)!)
          continue
        }
        const [sLat, sLng] = d.positions[0]
        const [eLat, eLng] = d.positions[1]
        try {
          const data = await travel.directions(sLat, sLng, eLat, eLng)
          const coords: [number, number][] = data.coords.map(
            ([lat, lng]) => [lat, lng] as [number, number]
          )
          newRoutes.set(d.key, coords)
          routeCache.set(d.key, coords)
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Directions API failed"
          errors.push(`${d.label}: ${msg}`)
        }
      }
      if (!cancelled) {
        setSnappedRoutes(newRoutes)
        setRouteErrors(errors)
        setSnapping(false)
      }
    }

    fetchRoutes()
    return () => { cancelled = true }
  }, [drives])

  // Receipt locations for this trip's date
  const receiptMarkers = useMemo(() => {
    if (!receiptLocations?.length) return []
    // Get the trip date from segments
    const tripDate = segments[0]?.trip_date
    if (!tripDate) return []
    return receiptLocations
      .filter((r) => r.receipt_date === tripDate && r.store_location_id != null)
      .map((r) => ({
        pos: [r.store_latitude!, r.store_longitude!] as [number, number],
        label: `${r.vendor_name} — ${r.receipt_number} ($${parseFloat(r.total).toFixed(2)})`,
        address: r.store_label || r.store_address,
      }))
  }, [receiptLocations, segments])

  // Combine all points for bounds
  const allBoundsPoints = useMemo(() => {
    const receiptPts = receiptMarkers.map((r) => r.pos)
    return [...points, ...receiptPts]
  }, [points, receiptMarkers])

  if (allBoundsPoints.length === 0) {
    return <div className="text-xs text-muted-foreground italic py-2">No coordinate data available for map</div>
  }

  return (
    <div className="h-64 w-full rounded border overflow-hidden my-2">
      {snapping && <div className="text-xs text-muted-foreground py-1">Snapping routes to roads...</div>}
      {routeErrors.length > 0 && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1 my-1 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-medium">Route snapping failed for {routeErrors.length} segment(s)</span>
            {routeErrors.length <= 3 && routeErrors.map((e, i) => <div key={i} className="text-red-500">{e}</div>)}
          </div>
        </div>
      )}
      <MapContainer center={allBoundsPoints[0]} zoom={10} className="h-full w-full" scrollWheelZoom={false}>
        <GoogleTileLayer />
        <FitBounds bounds={allBoundsPoints} />
        {drives.map((d, i) => (
          <Polyline
            key={`drive-${i}`}
            positions={snappedRoutes.get(d.key) || d.positions}
            color={d.color}
            weight={3}
            opacity={0.8}
          >
            <Tooltip>{d.label}</Tooltip>
          </Polyline>
        ))}
        {visits.map((v, i) => (
          <CircleMarker key={`visit-${i}`} center={v.pos} radius={6} fillColor={v.color} fillOpacity={0.9} color="#fff" weight={2}>
            <Tooltip>{v.label}</Tooltip>
          </CircleMarker>
        ))}
        {receiptMarkers.map((r, i) => (
          <CircleMarker key={`receipt-${i}`} center={r.pos} radius={8} fillColor="#e11d48" fillOpacity={0.9} color="#fff" weight={2}>
            <Tooltip>
              <div>
                <strong>Receipt:</strong> {r.label}
                {r.address && <div className="text-xs">{r.address}</div>}
              </div>
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  )
}

function classificationBadge(c: string) {
  switch (c) {
    case "business":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-green-100 text-green-800"><Briefcase className="h-3 w-3" /> Business</span>
    case "personal":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-blue-100 text-blue-800"><Home className="h-3 w-3" /> Personal</span>
    default:
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600"><HelpCircle className="h-3 w-3" /> Unclassified</span>
  }
}

export default function TravelReportPage() {
  const [selectedUploadId, setSelectedUploadId] = useState<string>("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [expandedTrips, setExpandedTrips] = useState<Set<string>>(new Set())
  const [showOnlyVisits, setShowOnlyVisits] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editingLogId, setEditingLogId] = useState<string | null>(null)
  const [logPurpose, setLogPurpose] = useState("")
  const [logNotes, setLogNotes] = useState("")
  const [savingAllLogs, setSavingAllLogs] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: uploads, isLoading: uploadsLoading } = useTravelUploads()

  // Auto-select first upload
  const effectiveUploadId = selectedUploadId || uploads?.[0]?.id || ""

  const { data: summary, isLoading: summaryLoading } = useTravelSummary(
    effectiveUploadId || undefined,
    fromDate || undefined,
    toDate || undefined,
  )
  const { data: segments } = useTravelSegments(
    effectiveUploadId || undefined,
    fromDate || undefined,
    toDate || undefined,
  )
  const { data: tripLogs } = useTripLogs(effectiveUploadId || undefined)
  const { data: receiptLocations } = useReceiptLocations(fromDate || undefined, toDate || undefined)

  const uploadMutation = useUploadTimeline()
  const deleteMutation = useDeleteTravelUpload()
  const reparseMutation = useReparseTravelUpload()
  const classifyMutation = useClassifySegment()
  const createTripLogMutation = useCreateTripLog()
  const updateTripLogMutation = useUpdateTripLog()
  const deleteTripLogMutation = useDeleteTripLog()

  // Index trip logs by date for quick lookup
  const tripLogsByDate = useMemo(() => {
    const map = new Map<string, TravelTripLog>()
    if (tripLogs) {
      for (const log of tripLogs) {
        map.set(log.trip_date, log)
      }
    }
    return map
  }, [tripLogs])

  // Group segments by trip_date
  const tripSegments = useMemo(() => {
    if (!segments) return new Map<string, TravelSegment[]>()
    const map = new Map<string, TravelSegment[]>()
    for (const s of segments) {
      const existing = map.get(s.trip_date) || []
      existing.push(s)
      map.set(s.trip_date, existing)
    }
    return map
  }, [segments])

  // Auto-generate a purpose string from store visits
  const generatePurpose = useCallback((visits: string[]) => {
    if (visits.length === 0) return ""
    return `Business: ${visits.join(", ")}`
  }, [])

  const toggleTrip = useCallback((date: string) => {
    setExpandedTrips((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) return
    try {
      const result = await uploadMutation.mutateAsync(file)
      setSelectedUploadId(result.id)
      setUploadOpen(false)
    } catch {
      // error shown via mutation state
    }
  }

  const handleClassify = (segmentId: string, classification: string) => {
    classifyMutation.mutate({ id: segmentId, classification })
  }

  const handleDelete = (upload: TravelUpload) => {
    deleteMutation.mutate(upload.id, {
      onSuccess: () => {
        setConfirmDeleteId(null)
        if (selectedUploadId === upload.id) setSelectedUploadId("")
      },
    })
  }

  const handleSaveAllLogs = async () => {
    if (!summary || !effectiveUploadId || savingAllLogs) return
    const unloggedTrips = summary.trips.filter(
      (t) => t.business_km > 0 && !tripLogsByDate.has(t.trip_date)
    )
    if (unloggedTrips.length === 0) return
    setSavingAllLogs(true)
    try {
      for (const trip of unloggedTrips) {
        await createTripLogMutation.mutateAsync({
          upload_id: effectiveUploadId,
          trip_date: trip.trip_date,
          purpose: generatePurpose(trip.store_visits) || undefined,
        })
      }
    } finally {
      setSavingAllLogs(false)
    }
  }

  if (uploadsLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mileage Import</h1>
        <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
          <DialogTrigger asChild>
            <Button>
              <Upload className="h-4 w-4 mr-2" />
              Upload Timeline
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Google Timeline</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="text-sm text-muted-foreground">
                Upload a Google Timeline JSON export (Timeline.json). The file will be parsed
                to extract driving activities and place visits.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
              />
              {uploadMutation.isError && (
                <p className="text-sm text-red-600">
                  Upload failed: {uploadMutation.error instanceof Error ? uploadMutation.error.message : "Unknown error"}
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={handleUpload}
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? "Processing..." : "Upload & Process"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex items-end gap-4 flex-wrap">
        <div className="w-72">
          <label className="text-sm font-medium mb-1 block">Upload</label>
          <Select
            value={effectiveUploadId}
            onValueChange={setSelectedUploadId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select upload..." />
            </SelectTrigger>
            <SelectContent>
              {uploads?.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.filename} ({u.date_range_start?.slice(0, 10) ?? "?"} – {u.date_range_end?.slice(0, 10) ?? "?"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">From</label>
          <DateInput value={fromDate} onChange={setFromDate} />
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">To</label>
          <DateInput value={toDate} onChange={setToDate} />
        </div>
        {effectiveUploadId && confirmDeleteId !== effectiveUploadId && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={reparseMutation.isPending}
              onClick={() => reparseMutation.mutate(effectiveUploadId)}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${reparseMutation.isPending ? "animate-spin" : ""}`} />
              {reparseMutation.isPending ? "Re-parsing..." : "Re-parse"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:text-red-700"
              onClick={() => setConfirmDeleteId(effectiveUploadId)}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </>
        )}
        {effectiveUploadId && confirmDeleteId === effectiveUploadId && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded px-3 py-1.5 text-sm">
            <span className="text-red-800">Delete this upload and all its segments?</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                const u = uploads?.find((x) => x.id === effectiveUploadId)
                if (u) handleDelete(u)
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Yes, Delete"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDeleteId(null)}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* Summary Cards */}
      {summary && !summaryLoading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Total Distance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatKm(summary.total_km)}</div>
              <p className="text-xs text-muted-foreground">{summary.total_trips} trips</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Business</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-700">{formatKm(summary.business_km)}</div>
              <p className="text-xs text-muted-foreground">{formatPct(summary.business_percentage)} of total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Personal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-700">{formatKm(summary.personal_km)}</div>
            </CardContent>
          </Card>

        </div>
      )}

      {summary && summary.unclassified_km > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-800">
          {formatKm(summary.unclassified_km)} unclassified — expand trips below to classify segments.
        </div>
      )}

      {/* Trip Table */}
      {summary && summary.trips.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Daily Trips</CardTitle>
            <div className="flex items-center gap-4">
              {summary && (() => {
                const unloggedCount = summary.trips.filter(
                  (t) => t.business_km > 0 && !tripLogsByDate.has(t.trip_date)
                ).length
                return unloggedCount > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={savingAllLogs}
                    onClick={handleSaveAllLogs}
                  >
                    <Save className="h-3 w-3 mr-1" />
                    {savingAllLogs ? "Saving..." : `Save All (${unloggedCount})`}
                  </Button>
                ) : null
              })()}
              <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyVisits}
                  onChange={(e) => setShowOnlyVisits(e.target.checked)}
                  className="rounded"
                />
                Only days with business visits
              </label>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Business</TableHead>
                  <TableHead className="text-right">Personal</TableHead>
                  <TableHead className="text-right">Unclassified</TableHead>
                  <TableHead>Business Visits</TableHead>
                  <TableHead className="w-24">Log</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.trips
                  .filter((trip: TravelTripSummary) => !showOnlyVisits || trip.store_visits.length > 0)
                  .map((trip: TravelTripSummary) => {
                  const isExpanded = expandedTrips.has(trip.trip_date)
                  const segs = tripSegments.get(trip.trip_date) || []
                  const tripLog = tripLogsByDate.get(trip.trip_date)
                  return (
                    <React.Fragment key={trip.trip_date}>
                      <TableRow
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => toggleTrip(trip.trip_date)}
                      >
                        <TableCell className="w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-medium">
                          {trip.trip_date}
                        </TableCell>
                        <TableCell className="text-right">{formatKm(trip.total_distance_km)}</TableCell>
                        <TableCell className="text-right text-green-700">{formatKm(trip.business_km)}</TableCell>
                        <TableCell className="text-right text-blue-700">{formatKm(trip.personal_km)}</TableCell>
                        <TableCell className="text-right">{trip.unclassified_km > 0 ? formatKm(trip.unclassified_km) : "—"}</TableCell>
                        <TableCell>
                          {trip.store_visits.length > 0 ? (
                            <span className="text-xs text-muted-foreground">{trip.store_visits.join(", ")}</span>
                          ) : "—"}
                        </TableCell>
                        <TableCell>
                          {tripLog ? (
                            tripLog.status === "confirmed" ? (
                              <span className="inline-flex items-center gap-1 text-xs text-green-700">
                                <CheckCircle className="h-3.5 w-3.5" /> Confirmed
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                <FileText className="h-3.5 w-3.5" /> Draft
                              </span>
                            )
                          ) : trip.business_km > 0 ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs"
                              onClick={(e) => {
                                e.stopPropagation()
                                const purpose = generatePurpose(trip.store_visits)
                                createTripLogMutation.mutate({
                                  upload_id: effectiveUploadId,
                                  trip_date: trip.trip_date,
                                  purpose: purpose || undefined,
                                }, {
                                  onSuccess: (newLog) => {
                                    // Auto-expand the trip and enter edit mode
                                    setExpandedTrips((prev) => new Set(prev).add(trip.trip_date))
                                    setEditingLogId(newLog.id)
                                    setLogPurpose(newLog.purpose || purpose)
                                    setLogNotes(newLog.notes || "")
                                  },
                                })
                              }}
                            >
                              <Save className="h-3 w-3 mr-1" /> Save
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${trip.trip_date}-map`}>
                          <TableCell colSpan={8} className="p-2">
                            <MapErrorBoundary>
                              <TripMap segments={segs} receiptLocations={receiptLocations} />
                            </MapErrorBoundary>
                          </TableCell>
                        </TableRow>
                      )}
                      {isExpanded && tripLog && (
                        <TableRow key={`${trip.trip_date}-log`} className="bg-green-50/50">
                          <TableCell colSpan={8} className="px-4 py-3">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-2">
                                <label className="text-xs font-medium w-16">Purpose:</label>
                                {editingLogId === tripLog.id ? (
                                  <input
                                    className="text-xs border rounded px-2 py-1 flex-1"
                                    value={logPurpose}
                                    onChange={(e) => setLogPurpose(e.target.value)}
                                    placeholder="e.g. Deliver merchandise to BSC, pick up supplies at Staples"
                                  />
                                ) : (
                                  <span className="text-xs flex-1">{tripLog.purpose || <span className="text-muted-foreground italic">No purpose set</span>}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <label className="text-xs font-medium w-16">Notes:</label>
                                {editingLogId === tripLog.id ? (
                                  <textarea
                                    className="text-xs border rounded px-2 py-1 flex-1"
                                    rows={2}
                                    value={logNotes}
                                    onChange={(e) => setLogNotes(e.target.value)}
                                    placeholder="Additional notes for audit..."
                                  />
                                ) : (
                                  <span className="text-xs flex-1">{tripLog.notes || <span className="text-muted-foreground italic">No notes</span>}</span>
                                )}
                              </div>
                              <div className="flex gap-2 items-center">
                                <span className="text-xs text-muted-foreground">
                                  {formatKm(tripLog.business_km)} business / {formatKm(tripLog.total_km)} total
                                </span>
                                <div className="flex-1" />
                                {editingLogId === tripLog.id ? (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 text-xs"
                                      onClick={() => setEditingLogId(null)}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      size="sm"
                                      className="h-6 text-xs"
                                      onClick={() => {
                                        updateTripLogMutation.mutate({
                                          id: tripLog.id,
                                          purpose: logPurpose,
                                          notes: logNotes,
                                        })
                                        setEditingLogId(null)
                                      }}
                                    >
                                      Save Changes
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 text-xs"
                                      onClick={() => {
                                        setEditingLogId(tripLog.id)
                                        setLogPurpose(tripLog.purpose)
                                        setLogNotes(tripLog.notes)
                                      }}
                                    >
                                      Edit
                                    </Button>
                                    {tripLog.status === "draft" ? (
                                      <Button
                                        size="sm"
                                        className="h-6 text-xs bg-green-600 hover:bg-green-700"
                                        onClick={() => updateTripLogMutation.mutate({ id: tripLog.id, status: "confirmed" })}
                                      >
                                        <CheckCircle className="h-3 w-3 mr-1" /> Confirm
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-xs"
                                        onClick={() => updateTripLogMutation.mutate({ id: tripLog.id, status: "draft" })}
                                      >
                                        Unconfirm
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 text-xs text-red-500"
                                      onClick={() => deleteTripLogMutation.mutate(tripLog.id)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                      {isExpanded && segs.map((seg) => (
                        <TableRow key={seg.id} className="bg-slate-50/50">
                          <TableCell />
                          <TableCell className="text-xs text-muted-foreground pl-8">
                            {seg.segment_type === "drive" ? (
                              <>
                                <span className="text-[10px] text-muted-foreground/70 mr-1.5 font-mono">{formatTimeRange(seg.start_time, seg.end_time)}</span>
                                {seg.from_location || "?"} → {seg.to_location || "?"}
                              </>
                            ) : (
                              <>
                                <span className="text-[10px] text-muted-foreground/70 mr-1.5 font-mono">{formatTimeRange(seg.start_time, seg.end_time)}</span>
                                Visit: {seg.visit_location_label || seg.visit_location_chain || (seg.start_lat != null ? `Unknown (${seg.start_lat.toFixed(5)}, ${seg.start_lng?.toFixed(5)})` : "Unknown")}
                                {seg.visit_duration_minutes != null && (
                                  <span className="ml-1">({seg.visit_duration_minutes}min)</span>
                                )}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {seg.distance_meters != null ? formatMetersAsKm(seg.distance_meters) : "—"}
                          </TableCell>
                          <TableCell colSpan={3} className="text-center">
                            <div className="flex items-center gap-2 justify-center">
                              {classificationBadge(seg.classification)}
                              {seg.segment_type === "drive" && (
                                <Select
                                  value={seg.classification}
                                  onValueChange={(v) => handleClassify(seg.id, v)}
                                >
                                  <SelectTrigger className="h-6 w-28 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="business">Business</SelectItem>
                                    <SelectItem value="personal">Personal</SelectItem>
                                    <SelectItem value="unclassified">Unclassified</SelectItem>
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {seg.is_detour && seg.detour_extra_km != null && (
                              <span className="text-green-600">+{seg.detour_extra_km.toFixed(1)} km detour</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </React.Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!effectiveUploadId && (
        <div className="text-center py-16 text-muted-foreground">
          <Car className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No timeline data yet. Upload a Google Timeline JSON to get started.</p>
        </div>
      )}
    </div>
  )
}
