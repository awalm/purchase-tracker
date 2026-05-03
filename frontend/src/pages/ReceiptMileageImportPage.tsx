import { useState, useMemo, useEffect, useCallback, useRef, Component } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  useReceipts,
  useTripLogs,
  useCreateReceiptTripLog,
  useTravelLocations,
  useUpdateReceipt,
  useTravelSegmentsForDate,
  useTravelSegmentDates,
  useCreateTravelLocation,
  useUpdateTripLog,
} from "@/hooks/useApi"
import { useQueryClient, useQuery } from "@tanstack/react-query"
import { travel } from "@/api"
import type { TravelTripLog, TravelLocation, TravelSegment } from "@/api"
import type { ReceiptWithVendor } from "@/types"
import {
  type SegmentDraft,
  emptySegment,
  haversineKm,
  optimalStopIndex,
  labelTimelineSegments,
  suggestSegmentsFromTimeline,
  findAutoFillStopIds,
  buildSegmentPayload,
  sortStopsByShortestRoute,
} from "@/lib/mileageLogic"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LocationSearch } from "@/components/ui/location-search"
import {
  CheckCircle,
  Plus,
  Trash2,
  Save,
  AlertTriangle,
  MapPin,
  RotateCw,
  Car,
  FileText,
  GripVertical,
  Undo2,
  ChevronDown,
  ChevronRight,
  ArrowLeftRight,
} from "lucide-react"
import { MapContainer, Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import GoogleTileLayer from "@/components/ui/google-tile-layer"

// ----- Map Helpers -----

function FitBounds({ bounds }: { bounds: [number, number][] }) {
  const map = useMap()
  const prevKeyRef = useRef("")
  useEffect(() => {
    if (bounds.length === 0) return
    try {
      const key = bounds.map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join("|")
      if (key === prevKeyRef.current) return
      prevKeyRef.current = key
      if (bounds.length > 1) {
        const lb = L.latLngBounds(bounds.map(([a, b]) => L.latLng(a, b)))
        if (lb.isValid()) map.fitBounds(lb, { padding: [20, 20] })
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 13)
      }
    } catch (e) {
      console.warn("FitBounds error:", e)
    }
  }, [map, bounds])
  return null
}

class MapErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Map render error:", error, info) }
  componentDidUpdate(prevProps: { resetKey?: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }
  render() {
    if (this.state.error) return <div className="text-xs text-red-600 py-2">Map failed to render: {this.state.error}</div>
    return this.props.children
  }
}

// ----- Helpers -----

const CLASSIFICATION_COLORS: Record<string, string> = { business: "#15803d", personal: "#1d4ed8" }
const TIMELINE_COLORS: Record<string, { line: string; marker: string }> = {
  business: { line: "#16a34a", marker: "#15803d" },
  personal: { line: "#93c5fd", marker: "#60a5fa" },
}

/** Filter out invalid coordinate pairs that would crash Leaflet */
function validPositions(pts: [number, number][]): [number, number][] {
  return pts.filter(([a, b]) => a != null && b != null && isFinite(a) && isFinite(b))
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return ""
  return new Date(ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })
}

/** Format a time, adding ⁺¹ if it falls on a different day than the reference date */
function fmtTimeWithDay(ts: string | null | undefined, refDate: string | null): { text: string; nextDay: boolean } {
  if (!ts) return { text: "", nextDay: false }
  const d = new Date(ts)
  const text = d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (!refDate) return { text, nextDay: false }
  // Compare in local timezone to avoid UTC offset causing false +1
  const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const nextDay = localDate !== refDate
  return { text, nextDay }
}

function TimeWithDay({ ts, refDate }: { ts: string | null | undefined; refDate: string | null }) {
  const { text, nextDay } = fmtTimeWithDay(ts, refDate)
  if (!text) return null
  return <>{text}{nextDay && <sup className="text-[8px] text-orange-600 ml-px">+1</sup>}</>
}

function fmtDateWithDay(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00")
  const day = d.toLocaleDateString("en-CA", { weekday: "long" })
  return `${dateStr} (${day})`
}




// ----- Route fetching (cached — same coords always give same Google route) -----

const routeCache = new Map<string, { distance: number; coords: [number, number][] }>()

async function fetchRoute(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
  waypoints?: [number, number][],
): Promise<{ distance: number; coords: [number, number][] }> {
  const wpKey = waypoints?.map(([a, b]) => `${a},${b}`).join(";") || ""
  const key = `${fromLat},${fromLng}-${toLat},${toLng}|${wpKey}`
  if (routeCache.has(key)) return routeCache.get(key)!
  const data = await travel.directions(fromLat, fromLng, toLat, toLng, waypoints)
  const coords = data.coords
    .map(([lat, lng]) => [lat, lng] as [number, number])
    .filter(([lat, lng]) => lat != null && lng != null && isFinite(lat) && isFinite(lng))
  const result = { distance: data.distance_meters, coords }
  routeCache.set(key, result)
  return result
}

// ----- Route Map (uses same road-snap approach as TravelReportPage) -----



function RouteMap({
  segments,
  locations,
  receiptLocations,
  timelineSegments,
  hoveredSegmentId,
  onHoverSegment,
}: {
  segments: SegmentDraft[]
  locations: TravelLocation[]
  receiptLocations: ReceiptWithVendor[]
  timelineSegments?: TravelSegment[]
  hoveredSegmentId?: string | null
  onHoverSegment?: (id: string | null) => void
}) {
  const [snappedRoutes, setSnappedRoutes] = useState<Map<string, [number, number][]>>(new Map())
  const [snapping, setSnapping] = useState(false)
  const [snappedCount, setSnappedCount] = useState(0)

  const { allPoints, manualDrives, detourDrives, timelineDrives, timelineVisits, receiptMarkers } = useMemo(() => {
    const pts: [number, number][] = []
    const manual: { positions: [number, number][]; color: string; label: string }[] = []
    const detours: { positions: [number, number][]; color: string; label: string }[] = []

    for (const seg of segments) {
      const fromLoc = locations.find((l) => l.id === seg.from_id)
      const toLoc = locations.find((l) => l.id === seg.to_id)
      if (!fromLoc?.latitude || !fromLoc?.longitude || !toLoc?.latitude || !toLoc?.longitude) continue
      const start: [number, number] = [fromLoc.latitude, fromLoc.longitude]
      const end: [number, number] = [toLoc.latitude, toLoc.longitude]
      pts.push(start, end)
      if (seg.isDetour) {
        const coords = seg.withStopsCoords.length > 0 ? seg.withStopsCoords : (seg.routeCoords.length > 0 ? seg.routeCoords : null)
        if (coords) {
          detours.push({
            positions: coords,
            color: CLASSIFICATION_COLORS[seg.classification] || "#6b7280",
            label: `${fromLoc.label} \u2192 ${toLoc.label} (detour: ${seg.distance_km || "?"} km)`,
          })
        }
      } else {
        if (seg.routeCoords.length > 0) {
          manual.push({
            positions: seg.routeCoords,
            color: CLASSIFICATION_COLORS[seg.classification] || "#6b7280",
            label: `${fromLoc.label} \u2192 ${toLoc.label} (${seg.distance_km || seg.computed_km || "?"} km)`,
          })
        }
      }
    }

    const tlLabels = timelineSegments ? labelTimelineSegments(timelineSegments) : new Map<string, string>()
    const tlDrives: { key: string; start: [number, number]; end: [number, number]; color: string; label: string; timeRange: string; segId: string }[] = []
    const tlVisits: { pos: [number, number]; label: string; classification: string; duration?: number; timeRange: string; segId: string }[] = []

    if (timelineSegments) {
      for (const ts of timelineSegments) {
        const timeRange = `${fmtTime(ts.start_time)}\u2013${fmtTime(ts.end_time)}`
        if (ts.segment_type === "drive" && ts.start_lat != null && ts.start_lng != null && ts.end_lat != null && ts.end_lng != null) {
          const start: [number, number] = [ts.start_lat, ts.start_lng]
          const end: [number, number] = [ts.end_lat, ts.end_lng]
          pts.push(start, end)
          const km = ts.distance_meters != null ? (ts.distance_meters / 1000).toFixed(1) : "?"
          const fromLabel = tlLabels.get(ts.id) || ts.from_location || "?"
          const toLabel = tlLabels.get(ts.id + "_to") || ts.to_location || "?"
          tlDrives.push({
            key: `${ts.start_lat},${ts.start_lng}-${ts.end_lat},${ts.end_lng}`,
            start, end,
            color: TIMELINE_COLORS[ts.classification]?.line || "#9ca3af",
            label: `${fromLabel} \u2192 ${toLabel} (${km} km)`,
            timeRange, segId: ts.id,
          })
        } else if (ts.segment_type === "visit" && ts.start_lat != null && ts.start_lng != null) {
          pts.push([ts.start_lat, ts.start_lng])
          tlVisits.push({
            pos: [ts.start_lat, ts.start_lng],
            label: tlLabels.get(ts.id) || ts.visit_location_label || ts.from_location || "Unknown",
            classification: ts.classification,
            duration: ts.visit_duration_minutes ?? undefined,
            timeRange, segId: ts.id,
          })
        }
      }
    }

    const rcpt = receiptLocations
      .filter((r) => r.store_location_id != null && r.store_latitude != null && r.store_longitude != null)
      .map((r) => ({ pos: [r.store_latitude!, r.store_longitude!] as [number, number], label: `${r.vendor_name} ($${parseFloat(r.total).toFixed(2)})`, address: r.store_label || r.store_address }))
    for (const rm of rcpt) pts.push(rm.pos)

    // Filter out any invalid points that could crash Leaflet
    const validPts = pts.filter(([a, b]) => a != null && b != null && !isNaN(a) && !isNaN(b))

    return { allPoints: validPts, manualDrives: manual, detourDrives: detours, timelineDrives: tlDrives, timelineVisits: tlVisits, receiptMarkers: rcpt }
  }, [segments, locations, receiptLocations, timelineSegments])

  // Road-snap timeline drives via Directions API
  const driveKeys = useMemo(() => timelineDrives.map((d) => d.key).join(","), [timelineDrives])
  useEffect(() => {
    if (timelineDrives.length === 0) { setSnapping(false); return }
    let cancelled = false
    const snap = async () => {
      setSnapping(true)
      setSnappedCount(0)
      const routes = new Map<string, [number, number][]>()
      let done = 0
      for (const d of timelineDrives) {
        if (cancelled) break
        try {
          const { coords } = await fetchRoute(d.start[0], d.start[1], d.end[0], d.end[1])
          routes.set(d.key, coords)
        } catch { /* skip if directions fail */ }
        done++
        if (!cancelled) setSnappedCount(done)
      }
      if (!cancelled) { setSnappedRoutes(routes); setSnapping(false) }
    }
    snap()
    return () => { cancelled = true }
  }, [driveKeys])

  if (allPoints.length === 0) {
    return <div className="text-xs text-muted-foreground italic py-2">No geocoded locations or timeline data to display.</div>
  }

  const seenVisitKeys = new Set<string>()
  const dedupedVisits = timelineVisits.filter((v) => {
    const key = `${v.pos[0].toFixed(4)},${v.pos[1].toFixed(4)}`
    if (seenVisitKeys.has(key)) return false
    seenVisitKeys.add(key)
    return true
  })

  return (
    <MapErrorBoundary resetKey={`${allPoints.length}-${manualDrives.length}-${timelineDrives.length}`}>
      <div className="h-80 w-full rounded border overflow-hidden relative z-0">
        <MapContainer key={`map-${allPoints.length}`} center={allPoints[0] || [43.65, -79.38]} zoom={10} className="h-full w-full" scrollWheelZoom={false}>
          <GoogleTileLayer />
          <FitBounds bounds={allPoints} />

          {/* Timeline drives — road-snapped */}
          {timelineDrives.map((d, i) => {
            const isHovered = hoveredSegmentId === d.segId
            const positions = validPositions(snappedRoutes.get(d.key) || [d.start, d.end])
            if (positions.length < 2) return null
            return (
              <Polyline key={`tl-${i}`} positions={positions}
                color={isHovered ? "#f59e0b" : d.color} weight={isHovered ? 5 : 4} opacity={isHovered ? 1 : 0.85}
                eventHandlers={{
                  mouseover: onHoverSegment ? () => onHoverSegment(d.segId) : undefined,
                  mouseout: onHoverSegment ? () => onHoverSegment(null) : undefined,
                }}
              >
                <Tooltip><div><div>{d.label}</div><div className="text-xs text-gray-400">{d.timeRange}</div></div></Tooltip>
              </Polyline>
            )
          })}

          {/* Timeline visits */}
          {dedupedVisits.map((v, i) => {
            const isHovered = hoveredSegmentId === v.segId
            return (
              <CircleMarker key={`v-${i}`} center={v.pos} radius={isHovered ? 8 : 5}
                fillColor={isHovered ? "#f59e0b" : (TIMELINE_COLORS[v.classification]?.marker || "#9ca3af")}
                fillOpacity={isHovered ? 1 : 0.7} color={isHovered ? "#d97706" : "#fff"} weight={isHovered ? 2 : 1}
                eventHandlers={{
                  mouseover: onHoverSegment ? () => onHoverSegment(v.segId) : undefined,
                  mouseout: onHoverSegment ? () => onHoverSegment(null) : undefined,
                }}
              >
                <Tooltip><div><strong>{v.label}</strong><div className="text-xs text-gray-400">{v.timeRange}</div>{v.duration != null && <div className="text-xs">{v.duration} min</div>}</div></Tooltip>
              </CircleMarker>
            )
          })}

          {/* Manual segments */}
          {manualDrives.map((d, i) => {
            const pos = validPositions(d.positions)
            if (pos.length < 2) return null
            return (
              <Polyline key={`seg-${i}-${d.color}`} positions={pos} color={d.color} weight={4} opacity={0.9}>
                <Tooltip>{d.label}</Tooltip>
              </Polyline>
            )
          })}

          {/* Detour segments */}
          {detourDrives.map((d, i) => {
            const pos = validPositions(d.positions)
            if (pos.length < 2) return null
            return (
              <Polyline key={`det-${i}`} positions={pos} color={d.color} weight={4} opacity={0.9}>
                <Tooltip>{d.label}</Tooltip>
              </Polyline>
            )
          })}

          {/* Receipt store markers */}
          {receiptMarkers.map((r, i) => (
            <CircleMarker key={`r-${i}`} center={r.pos} radius={8} fillColor="#e11d48" fillOpacity={0.9} color="#fff" weight={2}>
              <Tooltip><div><strong>{r.label}</strong>{r.address && <div className="text-xs">{r.address}</div>}</div></Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>

        {snapping && (
          <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded px-2.5 py-1.5 text-[11px] text-muted-foreground flex items-center gap-1.5 shadow-sm">
            <RotateCw className="h-3 w-3 animate-spin" />
            <span>Snapping routes… {snappedCount}/{timelineDrives.length}</span>
          </div>
        )}

        {timelineSegments && timelineSegments.length > 0 && (
          <div className="absolute bottom-2 right-2 z-[1000] bg-white/90 border rounded px-2 py-1 text-[10px] space-y-0.5">
            <div className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2" style={{ borderColor: "#93c5fd" }} /><span>Personal</span></div>
            <div className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2" style={{ borderColor: "#16a34a" }} /><span>Business</span></div>
            <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#e11d48]" /><span>Receipt store</span></div>
          </div>
        )}
      </div>
    </MapErrorBoundary>
  )
}

// ----- Detour Stop List with Drag & Drop -----

function DetourStopList({
  seg, segIndex, locationOptions, receiptStoreLocations, homeLocationId,
  onAdd, onRemove, onReorder,
}: {
  seg: SegmentDraft
  segIndex: number
  locationOptions: TravelLocation[]
  receiptStoreLocations: TravelLocation[]
  homeLocationId?: string
  onAdd: (segIndex: number, locationId: string) => void
  onRemove: (segIndex: number, locationId: string) => void
  onReorder: (segIndex: number, newIds: string[]) => void
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", String(idx))
  }

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    setOverIdx(idx)
  }

  const handleDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault()
    if (dragIdx == null || dragIdx === dropIdx) { setDragIdx(null); setOverIdx(null); return }
    const ids = [...seg.detourStopIds]
    const [moved] = ids.splice(dragIdx, 1)
    ids.splice(dropIdx, 0, moved)
    onReorder(segIndex, ids)
    setDragIdx(null)
    setOverIdx(null)
  }

  const handleDragEnd = () => { setDragIdx(null); setOverIdx(null) }

  const used = new Set([...seg.detourStopIds, seg.from_id, seg.to_id])
  const receiptIds = new Set(receiptStoreLocations.map((l) => l.id))
  const groups = [
    { label: "Receipt Locations", locations: receiptStoreLocations.filter((l) => !used.has(l.id) && l.id !== homeLocationId) },
    { label: "All Locations", locations: locationOptions.filter((l) => !used.has(l.id) && !receiptIds.has(l.id) && l.id !== homeLocationId) },
  ]

  return (
    <div className="space-y-1.5 pl-1">
      <div className="text-[11px] text-muted-foreground">
        {seg.isDetour ? "Stops on this personal route (drag to reorder):" : "Intermediate stops (drag to reorder):"}
      </div>
      <div className="space-y-0.5">
        {seg.detourStopIds.map((stopId, si) => {
          const loc = locationOptions.find((l) => l.id === stopId)
          const isDragging = dragIdx === si
          const isOver = overIdx === si && dragIdx !== si
          return (
            <div
              key={stopId}
              draggable
              onDragStart={(e) => handleDragStart(e, si)}
              onDragOver={(e) => handleDragOver(e, si)}
              onDrop={(e) => handleDrop(e, si)}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 cursor-grab active:cursor-grabbing transition-all ${
                isDragging ? "opacity-30 scale-95" : ""
              } ${isOver ? "border-t-2 border-amber-500" : ""}`}
            >
              <span className="text-[10px] text-muted-foreground w-3 text-right flex-shrink-0">{si + 1}.</span>
              <div className="flex items-center gap-0.5 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5 text-[11px] flex-1 min-w-0">
                <span className="text-muted-foreground cursor-grab" title="Drag to reorder">⠿</span>
                <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
                <span className="truncate">{loc?.label || "?"}</span>
                <button className="ml-auto pl-1 text-amber-700 hover:text-red-600 flex-shrink-0" onClick={() => onRemove(segIndex, stopId)} title="Remove">&times;</button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-1.5 pl-1">
        <span className="text-[10px] text-muted-foreground w-3 text-right flex-shrink-0">{seg.detourStopIds.length + 1}.</span>
        <LocationSearch
          locations={locationOptions}
          groups={groups}
          value=""
          onValueChange={(v) => onAdd(segIndex, v)}
          placeholder="Add location..."
          className="w-[180px]"
          triggerClassName="h-6 text-[11px]"
        />
      </div>
    </div>
  )
}

// ----- Main Page -----

export default function ReceiptMileageImportPage() {
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [segments, setSegments] = useState<SegmentDraft[]>([emptySegment()])
  const [purpose, setPurpose] = useState("")
  const [notes, setNotes] = useState("")
  const [hoveredSegmentId, setHoveredSegmentId] = useState<string | null>(null)
  const [expandedTimelineId, setExpandedTimelineId] = useState<string | null>(null)
  const [matchRadius, setMatchRadius] = useState(250)
  const [rematching, setRematching] = useState(false)
  const [yearFilter, setYearFilter] = useState<string>("all")
  const [unsavedOnly, setUnsavedOnly] = useState(false)
  const [editingYearlyKm, setEditingYearlyKm] = useState<string>("")

  // Snapshot of the last confirmed/saved state (for revert)
  const savedSnapshot = useRef<{ segments: SegmentDraft[]; purpose: string; notes: string } | null>(null)

  const { data: receipts, isLoading: receiptsLoading } = useReceipts()
  const { data: allLogs } = useTripLogs()
  const { data: yearlyMileageData } = useQuery({ queryKey: ["travel", "yearly-mileage"], queryFn: () => travel.yearlyMileage.list() })
  const { data: travelLocations = [] } = useTravelLocations()
  const { data: timelineDates } = useTravelSegmentDates()
  const createReceiptTripLog = useCreateReceiptTripLog()
  const createTravelLocation = useCreateTravelLocation()
  const queryClient = useQueryClient()
  const updateReceipt = useUpdateReceipt()
  const [pendingLocations, setPendingLocations] = useState<Record<string, string>>({})
  const [newLocTarget, setNewLocTarget] = useState<{ segIndex: number; field: "from_id" | "to_id" } | null>(null)
  const [newLocLabel, setNewLocLabel] = useState("")
  const [newLocAddress, setNewLocAddress] = useState("")
  const [newLocType, setNewLocType] = useState("personal")
  const [geocoding, setGeocoding] = useState(false)
  const { data: timelineSegments } = useTravelSegmentsForDate(selectedDate)

  const onlineLocation = useMemo(() => travelLocations.find((l) => l.location_type === "online"), [travelLocations])
  const logsByDate = useMemo(() => {
    const map = new Map<string, TravelTripLog>()
    if (allLogs) for (const log of allLogs) map.set(log.trip_date, log)
    return map
  }, [allLogs])

  const homeLocation = useMemo(
    () => travelLocations.find((l) => l.label.toLowerCase() === "home" && l.location_type === "personal"),
    [travelLocations]
  )

  const locationOptions = useMemo(() => {
    const locs = travelLocations.filter((l) => !l.excluded && l.latitude != null && l.longitude != null)
    return locs.sort((a, b) => {
      if (a.id === homeLocation?.id) return -1
      if (b.id === homeLocation?.id) return 1
      return a.label.localeCompare(b.label)
    })
  }, [travelLocations, homeLocation])

  // Compute available years from all logs
  const availableYears = useMemo(() => {
    const years = new Set<number>()
    if (allLogs) for (const log of allLogs) years.add(parseInt(log.trip_date.slice(0, 4)))
    if (receipts) for (const r of receipts) years.add(parseInt(r.receipt_date.slice(0, 4)))
    if (timelineDates) for (const td of timelineDates) years.add(parseInt(td.date.slice(0, 4)))
    return Array.from(years).sort((a, b) => b - a)
  }, [allLogs, receipts, timelineDates])

  // Effective date range (year filter overrides from/to)
  const effectiveFromDate = yearFilter !== "all" ? `${yearFilter}-01-01` : fromDate
  const effectiveToDate = yearFilter !== "all" ? `${yearFilter}-12-31` : toDate

  const dateEntries = useMemo(() => {
    // Build receipt map
    const receiptMap = new Map<string, ReceiptWithVendor[]>()
    if (receipts) {
      for (const r of receipts) {
        if (effectiveFromDate && r.receipt_date < effectiveFromDate) continue
        if (effectiveToDate && r.receipt_date > effectiveToDate) continue
        if (!r.store_location_id) continue
        if (r.store_location_id === onlineLocation?.id) continue
        const existing = receiptMap.get(r.receipt_date) || []
        existing.push(r)
        receiptMap.set(r.receipt_date, existing)
      }
    }
    // Build timeline business visits map
    const timelineVisitsMap = new Map<string, string[]>()
    if (timelineDates) {
      for (const td of timelineDates) {
        if (effectiveFromDate && td.date < effectiveFromDate) continue
        if (effectiveToDate && td.date > effectiveToDate) continue
        timelineVisitsMap.set(td.date, td.business_visits)
      }
    }
    // Collect all dates (receipts + timeline)
    const allDates = new Set<string>([...receiptMap.keys(), ...timelineVisitsMap.keys()])
    return Array.from(allDates)
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const recs = receiptMap.get(date) || []
        const businessVisits = timelineVisitsMap.get(date) || []
        return {
          date,
          receipts: recs,
          totalSpent: recs.reduce((sum, r) => sum + parseFloat(r.total), 0),
          vendors: [...new Set(recs.map((r) => r.vendor_name))],
          storeCount: new Set(recs.map((r) => r.store_location_id)).size,
          hasLog: logsByDate.has(date),
          log: logsByDate.get(date),
          timelineOnly: recs.length === 0,
          businessVisits,
        }
      })
  }, [receipts, effectiveFromDate, effectiveToDate, logsByDate, onlineLocation, timelineDates])

  const filteredDateEntries = useMemo(() => {
    if (!unsavedOnly) return dateEntries
    return dateEntries.filter((d) => !d.hasLog || d.log?.status === "draft")
  }, [dateEntries, unsavedOnly])

  const selectedDateData = useMemo(() => dateEntries.find((d) => d.date === selectedDate), [dateEntries, selectedDate])

  const unlinkedByDate = useMemo(() => {
    if (!receipts) return []
    const map = new Map<string, ReceiptWithVendor[]>()
    for (const r of receipts) {
      if (effectiveFromDate && r.receipt_date < effectiveFromDate) continue
      if (effectiveToDate && r.receipt_date > effectiveToDate) continue
      if (r.store_location_id) continue
      const existing = map.get(r.receipt_date) || []
      existing.push(r)
      map.set(r.receipt_date, existing)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, recs]) => ({ date, receipts: recs }))
  }, [receipts, effectiveFromDate, effectiveToDate])

  const findMatchingLocation = useCallback(
    (receipt: ReceiptWithVendor): TravelLocation | undefined => {
      if (!receipt.store_location_id) return undefined
      return locationOptions.find((l) => l.id === receipt.store_location_id)
    }, [locationOptions]
  )

  // Store locations from the selected date's receipts (for detour stop picker)
  const receiptStoreLocations = useMemo(() => {
    if (!selectedDateData) return []
    const ids = new Set(selectedDateData.receipts.map((r) => r.store_location_id).filter(Boolean) as string[])
    return locationOptions.filter((l) => ids.has(l.id))
  }, [selectedDateData, locationOptions])

  // Grouped location list for segment pickers: Receipt Locations, Timeline Locations, All Locations
  const segmentLocationGroups = useMemo(() => {
    const usedIds = new Set(segments.flatMap((s) => [s.from_id, s.to_id]).filter(Boolean))
    const receiptIds = new Set(receiptStoreLocations.map((l) => l.id))
    const unusedReceipt = receiptStoreLocations.filter((l) => !usedIds.has(l.id) && l.id !== homeLocation?.id)
    const topLocs = [
      ...(homeLocation ? [homeLocation] : []),
      ...unusedReceipt,
    ]
    // Timeline locations: matched visit labels from timeline segments
    const topIds = new Set(topLocs.map((l) => l.id))
    const timelineVisitLabels = new Set(
      (timelineSegments || [])
        .filter((s) => s.segment_type === "visit" && s.visit_location_label && !s.visit_location_label.startsWith("Unknown"))
        .map((s) => s.visit_location_label!)
    )
    const timelineLocs = locationOptions.filter(
      (l) => timelineVisitLabels.has(l.label) && !topIds.has(l.id) && l.id !== homeLocation?.id
    )
    const usedInGroupIds = new Set([...topIds, ...timelineLocs.map((l) => l.id)])
    const restLocs = locationOptions.filter((l) => !usedInGroupIds.has(l.id) && l.id !== homeLocation?.id)
    return [
      { label: "Receipt Locations", locations: topLocs },
      ...(timelineLocs.length > 0 ? [{ label: "Timeline Locations", locations: timelineLocs }] : []),
      { label: "All Locations", locations: restLocs },
    ]
  }, [receiptStoreLocations, locationOptions, homeLocation, segments, timelineSegments])

  const handleSelectDate = useCallback((date: string) => {
    setSelectedDate(date)
    const data = dateEntries.find((d) => d.date === date)
    // Set default purpose from vendors; loading effect will override with log value if present
    const vendors = data?.vendors ?? []
    setPurpose(vendors.length > 0 ? `Business: ${vendors.join(", ")}` : "Business")
    setNotes("")
    setSegments([emptySegment()])
    setAutoSaveStatus("idle")
    lastSavedKey.current = ""
    setDraftLogId(null)
    savedSnapshot.current = null
    loadedLogDateRef.current = null
  }, [dateEntries])

  // When selecting a date that has an existing log, load its data
  const loadedLogDateRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedDate || !selectedDateData) return
    // Only run once per date selection
    if (loadedLogDateRef.current === selectedDate) return

    if (selectedDateData.hasLog && selectedDateData.log) {
      const log = selectedDateData.log
      setPurpose(log.purpose || "")
      setNotes(log.notes || "")
      setDraftLogId(log.id)
      setAutoSaveStatus("idle")
      lastSavedKey.current = "loaded"
    }

    // Load existing manual segments from timeline data
    if (timelineSegments && timelineSegments.length > 0) {
      const manualSegs = timelineSegments.filter(
        (s) => s.classification_reason === "manual" && s.segment_type === "drive"
      )
      if (manualSegs.length > 0) {
        const drafts: SegmentDraft[] = manualSegs.map((s) => {
          const fromLoc = locationOptions.find((l) => l.label === s.from_location)
          const toLoc = locationOptions.find((l) => l.label === s.to_location)
          return {
            from_id: fromLoc?.id || "",
            to_id: toLoc?.id || "",
            distance_km: s.distance_meters != null ? (s.distance_meters / 1000).toFixed(1) : "",
            computed_km: s.distance_meters != null ? (s.distance_meters / 1000).toFixed(1) : "",
            classification: s.classification || "business",
            routeCoords: s.route_coords || [],
            computing: false,
            routeError: null,
            source: "loaded",
            isDetour: s.is_detour || false,
            detourStopIds: s.detour_stop_ids || [],
            directKm: s.direct_km != null ? String(s.direct_km) : "",
            withStopsKm: s.with_stops_km != null ? String(s.with_stops_km) : "",
            directCoords: [],
            withStopsCoords: [],
          }
        })
        setSegments(drafts)
        loadedLogDateRef.current = selectedDate
        // Snapshot for revert if this is a confirmed log
        if (selectedDateData.log?.status === "confirmed") {
          savedSnapshot.current = { segments: drafts, purpose: selectedDateData.log?.purpose || "", notes: selectedDateData.log?.notes || "" }
        }
        // Update lastSavedKey to match loaded state so auto-save doesn't re-fire
        const validSegs = buildSegmentPayload(drafts, locationOptions)
        const purpose_ = selectedDateData.log?.purpose || ""
        const notes_ = selectedDateData.log?.notes || ""
        lastSavedKey.current = JSON.stringify({ date: selectedDate, purpose: purpose_ || undefined, notes: notes_ || undefined, segs: validSegs })
      } else {
        // No existing manual segments — user can click "Generate from timeline" to auto-suggest
        loadedLogDateRef.current = selectedDate
      }
    }
  }, [selectedDate, selectedDateData, timelineSegments, locationOptions])

  // Auto-compute route distance when from/to set
  const computeSegmentDistance = useCallback(async (index: number, segSnapshot: SegmentDraft) => {
    setSegments((prev) => prev.map((s, i) => i === index ? { ...s, computing: true, routeError: null } : s))
    const seg = segSnapshot
    const fromLoc = locationOptions.find((l) => l.id === seg.from_id)
    const toLoc = locationOptions.find((l) => l.id === seg.to_id)
    if (!fromLoc?.latitude || !fromLoc?.longitude || !toLoc?.latitude || !toLoc?.longitude) {
      setSegments((prev) => prev.map((s, i) => i === index ? { ...s, computing: false, routeError: "Missing coordinates" } : s))
      return
    }
    try {
      if (seg.detourStopIds.length > 0) {
        const waypoints: [number, number][] = seg.detourStopIds
          .map((id) => locationOptions.find((l) => l.id === id))
          .filter((l): l is TravelLocation => l != null && l.latitude != null && l.longitude != null)
          .map((l) => [l.latitude!, l.longitude!])

        if (seg.isDetour) {
          // Detour mode: compute direct route AND route with stops, distance = extra km
          const [direct, withStops] = await Promise.all([
            fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude),
            waypoints.length > 0
              ? fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude, waypoints)
              : fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude),
          ])
          const directKm = direct.distance / 1000
          const withStopsKm = withStops.distance / 1000
          const detourKm = Math.max(0, withStopsKm - directKm)
          setSegments((prev) => prev.map((s, i) => i === index ? {
            ...s, computing: false, routeError: null,
            directKm: directKm.toFixed(1),
            withStopsKm: withStopsKm.toFixed(1),
            directCoords: direct.coords,
            withStopsCoords: withStops.coords,
            computed_km: detourKm.toFixed(1),
            distance_km: detourKm.toFixed(1),
            routeCoords: withStops.coords,
          } : s))
        } else {
          // Regular segment with waypoints: route through stops, total km
          const result = waypoints.length > 0
            ? await fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude, waypoints)
            : await fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude)
          setSegments((prev) => prev.map((s, i) => i === index ? {
            ...s, computing: false, routeError: null,
            computed_km: (result.distance / 1000).toFixed(1),
            distance_km: s.distance_km || (result.distance / 1000).toFixed(1),
            routeCoords: result.coords,
            directKm: "", withStopsKm: "", directCoords: [], withStopsCoords: [],
          } : s))
        }
      } else {
        // Normal mode
        const result = await fetchRoute(fromLoc.latitude, fromLoc.longitude, toLoc.latitude, toLoc.longitude)
        setSegments((prev) => prev.map((s, i) => i === index ? {
          ...s, computing: false, routeError: null,
          computed_km: (result.distance / 1000).toFixed(1),
          distance_km: s.distance_km || (result.distance / 1000).toFixed(1),
          routeCoords: result.coords,
          directKm: "", withStopsKm: "", directCoords: [], withStopsCoords: [],
        } : s))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Directions API failed"
      setSegments((prev) => prev.map((s, i) => i === index ? { ...s, computing: false, routeError: msg } : s))
    }
  }, [locationOptions])

  useEffect(() => {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      // Skip loaded segments that already have computed km and route coords
      if (seg.source === "loaded" && seg.computed_km && seg.routeCoords.length > 0) continue
      // Skip segments that have errored (user must manually retry)
      if (seg.routeError) continue
      if (seg.from_id && seg.to_id && (!seg.computed_km || seg.routeCoords.length === 0) && !seg.computing) {
        computeSegmentDistance(i, seg)
        break
      }
    }
  }, [segments, computeSegmentDistance])

  const addSegment = () => setSegments((prev) => {
    const lastTo = prev[prev.length - 1]?.to_id || ""
    return [...prev, emptySegment(lastTo)]
  })
  const removeSegment = (index: number) => setSegments((prev) => prev.length > 1 ? prev.filter((_, i) => i !== index) : [emptySegment()])

  const generateFromTimeline = () => {
    if (!timelineSegments || timelineSegments.length === 0) return
    const suggested = suggestSegmentsFromTimeline(timelineSegments, locationOptions)
    if (suggested.length > 0) {
      setSegments([...suggested, emptySegment()])
    }
  }

  // Drag-and-drop segment reordering
  const [dragSegIdx, setDragSegIdx] = useState<number | null>(null)
  const [overSegIdx, setOverSegIdx] = useState<number | null>(null)

  const handleSegDragStart = (e: React.DragEvent, idx: number) => {
    setDragSegIdx(idx)
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", String(idx))
  }
  const handleSegDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    setOverSegIdx(idx)
  }
  const handleSegDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault()
    if (dragSegIdx == null || dragSegIdx === dropIdx) { setDragSegIdx(null); setOverSegIdx(null); return }
    setSegments((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragSegIdx, 1)
      next.splice(dropIdx, 0, moved)
      return next
    })
    setDragSegIdx(null)
    setOverSegIdx(null)
  }
  const handleSegDragEnd = () => { setDragSegIdx(null); setOverSegIdx(null) }

  const toggleDetour = (index: number) => {
    setSegments((prev) => prev.map((s, i) => {
      if (i !== index) return s
      const toggled = !s.isDetour
      return {
        ...s, isDetour: toggled,
        classification: toggled ? "business" : s.classification,
        computed_km: "", distance_km: "", routeCoords: [],
        directKm: "", withStopsKm: "", directCoords: [], withStopsCoords: [],
      }
    }))
  }

  const addDetourStop = (segIndex: number, locationId: string) => {
    setSegments((prev) => prev.map((s, i) => {
      if (i !== segIndex || s.detourStopIds.includes(locationId)) return s
      // Find optimal insertion position
      const fromLoc = locationOptions.find((l) => l.id === s.from_id)
      const toLoc = locationOptions.find((l) => l.id === s.to_id)
      const newLoc = locationOptions.find((l) => l.id === locationId)
      const existingStops = s.detourStopIds.map((id) => locationOptions.find((l) => l.id === id)).filter((l): l is TravelLocation => l != null && l.latitude != null)
      let insertIdx = s.detourStopIds.length // default: append
      if (fromLoc?.latitude != null && toLoc?.latitude != null && newLoc?.latitude != null) {
        insertIdx = optimalStopIndex(
          { latitude: fromLoc.latitude!, longitude: fromLoc.longitude! },
          { latitude: toLoc.latitude!, longitude: toLoc.longitude! },
          existingStops.map((l) => ({ latitude: l.latitude!, longitude: l.longitude! })),
          { latitude: newLoc.latitude!, longitude: newLoc.longitude! },
        )
      }
      const ids = [...s.detourStopIds]
      ids.splice(insertIdx, 0, locationId)
      return { ...s, detourStopIds: ids, computed_km: "", distance_km: "", routeCoords: [] }
    }))
  }

  const removeDetourStop = (segIndex: number, locationId: string) => {
    setSegments((prev) => prev.map((s, i) => {
      if (i !== segIndex) return s
      return { ...s, detourStopIds: s.detourStopIds.filter((id) => id !== locationId), computed_km: "", distance_km: "", routeCoords: [] }
    }))
  }

  // Auto-fill detour stops from timeline visits between from and to
  const autoFillDetourStops = (segIndex: number) => {
    if (!timelineSegments) return
    const seg = segments[segIndex]
    if (!seg.from_id || !seg.to_id) return
    const fromLoc = locationOptions.find((l) => l.id === seg.from_id)
    const toLoc = locationOptions.find((l) => l.id === seg.to_id)
    if (!fromLoc || !toLoc) return
    const stopIds = findAutoFillStopIds(
      timelineSegments, fromLoc.label, toLoc.label,
      new Set([seg.from_id, seg.to_id]), locationOptions,
    )
    if (stopIds.length === 0) return
    setSegments((prev) => prev.map((s, i) => {
      if (i !== segIndex) return s
      return { ...s, detourStopIds: stopIds, computed_km: "", distance_km: "", routeCoords: [] }
    }))
  }

  const handleRematch = async () => {
    if (!selectedDate || rematching) return
    setRematching(true)
    try {
      await travel.rematchVisits(selectedDate, matchRadius)
      queryClient.invalidateQueries({ queryKey: ["travel", "segments-by-date", selectedDate] })
    } finally {
      setRematching(false)
    }
  }

  const updateSegment = (index: number, field: keyof SegmentDraft, value: string) => {
    setSegments((prev) => prev.map((s, i) => {
      if (i !== index) return s
      const updated = { ...s, [field]: value }
      if (field === "from_id" || field === "to_id") {
        updated.computed_km = ""
        updated.distance_km = ""
        updated.routeCoords = []
        updated.routeError = null
        // Auto-set classification based on location types
        const fromId = field === "from_id" ? value : s.from_id
        const toId = field === "to_id" ? value : s.to_id
        if (fromId && toId) {
          const fromLoc = locationOptions.find((l) => l.id === fromId)
          const toLoc = locationOptions.find((l) => l.id === toId)
          if (fromLoc?.location_type === "personal" && toLoc?.location_type === "personal") {
            updated.classification = "personal"
          } else {
            updated.classification = "business"
          }
        }
      }
      return updated
    }))
  }

  const canSave = segments.some((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0)

  // Build valid segment payloads for saving
  const buildSavePayload = useCallback(() => {
    return buildSegmentPayload(segments, locationOptions)
  }, [segments, locationOptions])

  // Auto-save as draft: create draft once when segments become valid,
  // then PATCH purpose/notes on subsequent changes.
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [draftLogId, setDraftLogId] = useState<string | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedKey = useRef("")
  const updateTripLog = useUpdateTripLog()

  useEffect(() => {
    if (!selectedDate || !canSave) return
    const validSegs = buildSavePayload()
    if (validSegs.length === 0) return
    const saveKey = JSON.stringify({ date: selectedDate, purpose, notes, segs: validSegs })
    if (saveKey === lastSavedKey.current) return

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      setAutoSaveStatus("saving")

      if (draftLogId) {
        // Already have a log — update as draft
        updateTripLog.mutateAsync({ id: draftLogId, purpose: purpose || undefined, notes: notes || undefined, status: "draft", segments: validSegs })
          .then(() => { lastSavedKey.current = saveKey; setAutoSaveStatus("saved") })
          .catch(() => setAutoSaveStatus("error"))
      } else {
        // First save — create the draft
        createReceiptTripLog.mutateAsync(
          { trip_date: selectedDate, purpose: purpose || undefined, notes: notes || undefined, segments: validSegs },
        ).then((result) => {
          setDraftLogId(result.id)
          lastSavedKey.current = saveKey
          setAutoSaveStatus("saved")
        }).catch(() => setAutoSaveStatus("error"))
      }
    }, 1500)

    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [selectedDate, canSave, buildSavePayload, purpose, notes, draftLogId])

  // "Save to Log" promotes draft → confirmed
  const handleSave = () => {
    if (!selectedDate || !canSave) return
    // Cancel any pending auto-save to prevent race conditions
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }

    const logId = draftLogId || selectedDateData?.log?.id
    const validSegments = buildSavePayload()
    const saveKey = JSON.stringify({ date: selectedDate, purpose, notes, segs: validSegments })

    const onDone = (newId?: string) => {
      if (newId) setDraftLogId(newId)
      setAutoSaveStatus("idle")
      lastSavedKey.current = saveKey
      // Snapshot the confirmed state for future reverts
      savedSnapshot.current = { segments: [...segments], purpose, notes }
      // Reset so re-selecting this date will reload fresh data
      loadedLogDateRef.current = null
    }

    if (logId) {
      updateTripLog.mutate(
        { id: logId, purpose: purpose || undefined, notes: notes || undefined, status: "confirmed", segments: validSegments },
        { onSuccess: () => onDone() },
      )
    } else {
      if (validSegments.length === 0) return
      createReceiptTripLog.mutate(
        { trip_date: selectedDate, purpose: purpose || undefined, notes: notes || undefined, segments: validSegments },
        { onSuccess: (result) => onDone(result.id) },
      )
    }
  }

  // "Skip" saves a confirmed log with no segments (marks date as handled)
  const handleSkip = () => {
    if (!selectedDate) return
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }

    const logId = draftLogId || selectedDateData?.log?.id
    const onDone = (newId?: string) => {
      if (newId) setDraftLogId(newId)
      setAutoSaveStatus("idle")
      lastSavedKey.current = "skipped"
      savedSnapshot.current = null
      loadedLogDateRef.current = null
    }

    if (logId) {
      updateTripLog.mutate(
        { id: logId, purpose: "No trip", notes: undefined, status: "confirmed", segments: [] },
        { onSuccess: () => onDone() },
      )
    } else {
      createReceiptTripLog.mutate(
        { trip_date: selectedDate, purpose: "No trip", notes: undefined, segments: [] },
        { onSuccess: (result) => onDone(result.id) },
      )
    }
  }

  const handleRevert = () => {
    if (!savedSnapshot.current || !draftLogId) return
    // Cancel any pending auto-save
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
    const snap = savedSnapshot.current
    setSegments(snap.segments)
    setPurpose(snap.purpose)
    setNotes(snap.notes)
    const validSegs = buildSegmentPayload(snap.segments, locationOptions)
    const saveKey = JSON.stringify({ date: selectedDate, purpose: snap.purpose, notes: snap.notes, segs: validSegs })
    updateTripLog.mutate(
      { id: draftLogId, purpose: snap.purpose || undefined, notes: snap.notes || undefined, status: "confirmed", segments: validSegs },
      { onSuccess: () => { lastSavedKey.current = saveKey; setAutoSaveStatus("saved") } },
    )
  }

  if (receiptsLoading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Import Mileage Logs</h1>
      </div>

      {/* Year Filter + Date Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Year:</label>
          <Select value={yearFilter} onValueChange={(v) => { setYearFilter(v); if (v !== "all") { setFromDate(""); setToDate("") } }}>
            <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {availableYears.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {yearFilter === "all" && (
          <>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">From:</label>
              <DateInput value={fromDate} onChange={setFromDate} className="w-36" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">To:</label>
              <DateInput value={toDate} onChange={setToDate} className="w-36" />
            </div>
            {(fromDate || toDate) && (
              <Button variant="ghost" size="sm" onClick={() => { setFromDate(""); setToDate("") }}>Clear</Button>
            )}
          </>
        )}
        <span className="text-xs text-muted-foreground ml-auto">In-store receipts only. Online excluded.</span>
      </div>

      {/* Year Summary */}
      {yearFilter !== "all" && (() => {
        const yearNum = parseInt(yearFilter)
        const yearLogs = allLogs?.filter((l) => l.trip_date.startsWith(yearFilter)) || []
        const loggedBusinessKm = yearLogs.reduce((s, l) => s + l.business_km, 0)
        const loggedTotalKm = yearLogs.reduce((s, l) => s + l.total_km, 0)
        const loggedPersonalKm = loggedTotalKm - loggedBusinessKm
        const yearlyEntry = yearlyMileageData?.find((y) => y.year === yearNum)
        const odometerKm = yearlyEntry?.total_km
        const businessPct = odometerKm && odometerKm > 0 ? (loggedBusinessKm / odometerKm) * 100 : null
        return (
          <Card>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-6 flex-wrap">
                <div className="text-sm space-y-0.5">
                  <div className="text-muted-foreground text-xs">Logged Trips</div>
                  <div className="font-semibold">{yearLogs.length} trips · {loggedTotalKm.toFixed(1)} km</div>
                </div>
                <div className="text-sm space-y-0.5">
                  <div className="text-muted-foreground text-xs">Business</div>
                  <div className="font-semibold text-green-700">{loggedBusinessKm.toFixed(1)} km</div>
                </div>
                <div className="text-sm space-y-0.5">
                  <div className="text-muted-foreground text-xs">Personal</div>
                  <div className="font-semibold text-blue-600">{loggedPersonalKm.toFixed(1)} km</div>
                </div>
                <div className="border-l pl-4 flex items-center gap-2">
                  <div className="text-sm space-y-0.5">
                    <div className="text-muted-foreground text-xs">Total Year km (odometer)</div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        className="w-28 h-7 text-sm border rounded px-2"
                        placeholder="e.g. 20000"
                        value={editingYearlyKm || (odometerKm != null ? String(odometerKm) : "")}
                        onChange={(e) => setEditingYearlyKm(e.target.value)}
                        onBlur={() => {
                          const val = parseFloat(editingYearlyKm)
                          if (!isNaN(val) && val > 0) {
                            travel.yearlyMileage.upsert(yearNum, val).then(() => {
                              queryClient.invalidateQueries({ queryKey: ["travel", "yearly-mileage"] })
                              setEditingYearlyKm("")
                            })
                          } else {
                            setEditingYearlyKm("")
                          }
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
                      />
                      <span className="text-xs text-muted-foreground">km</span>
                    </div>
                  </div>
                </div>
                {businessPct != null && (
                  <div className="text-sm space-y-0.5">
                    <div className="text-muted-foreground text-xs">Business %</div>
                    <div className="font-bold text-lg text-green-700">{businessPct.toFixed(1)}%</div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })()}

      {/* Unlinked Receipts */}
      {unlinkedByDate.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Receipts Without Store Location ({unlinkedByDate.reduce((n, g) => n + g.receipts.length, 0)})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3">
              {unlinkedByDate.map(({ date, receipts: recs }) => (
                <div key={date}>
                  <div className="text-xs font-medium text-muted-foreground mb-1">{date}</div>
                  <div className="space-y-1">
                    {recs.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 bg-slate-50 border rounded px-3 py-1.5 text-xs">
                        <Link to={`/receipts/${r.id}`} className="font-medium min-w-[120px] text-blue-600 hover:underline">{r.vendor_name}</Link>
                        <span className="text-muted-foreground w-16">${parseFloat(r.total).toFixed(2)}</span>
                        <LocationSearch
                          locations={locationOptions}
                          value={pendingLocations[r.id] || ""}
                          onValueChange={(val) => setPendingLocations((prev) => ({ ...prev, [r.id]: val }))}
                          placeholder="Search locations..."
                          className="flex-1"
                          triggerClassName="h-7"
                        />
                        <Button variant="outline" size="sm" className="h-7 text-xs"
                          disabled={!pendingLocations[r.id] || updateReceipt.isPending}
                          onClick={() => {
                            updateReceipt.mutate({ id: r.id, store_location_id: pendingLocations[r.id] }, {
                              onSuccess: () => setPendingLocations((prev) => { const next = { ...prev }; delete next[r.id]; return next }),
                            })
                          }}
                        ><Save className="h-3 w-3" /></Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-5 gap-6">
        {/* Left: Trip dates */}
        <Card className="col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Trip Dates ({filteredDateEntries.length})</CardTitle>
              <label className="flex items-center gap-1.5 text-xs font-normal cursor-pointer">
                <input type="checkbox" checked={unsavedOnly} onChange={(e) => setUnsavedOnly(e.target.checked)} className="rounded" />
                Unsaved only
              </label>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {filteredDateEntries.length > 0 ? (
              <Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Vendors</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="w-10"></TableHead></TableRow></TableHeader>
                <TableBody>
                  {filteredDateEntries.map(({ date, receipts: dateReceipts, vendors, totalSpent, storeCount, hasLog, log, timelineOnly, businessVisits }) => (
                    <TableRow key={date} className={`cursor-pointer hover:bg-slate-50 ${selectedDate === date ? "bg-blue-50" : ""}`} onClick={() => handleSelectDate(date)}>
                      <TableCell className="font-medium text-sm">{fmtDateWithDay(date)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[180px]">
                        {timelineOnly ? (
                          businessVisits.length > 0 ? (
                            <span className="flex items-center gap-1"><Car className="h-3 w-3 flex-shrink-0" />{businessVisits.join(", ")}</span>
                          ) : (
                            <span title="Timeline only"><Car className="h-3 w-3" /></span>
                          )
                        ) : (
                          <>
                            {vendors.join(", ")}
                            <span className="ml-1"><FileText className="h-3 w-3 inline" />{dateReceipts.length}</span>
                            {storeCount > 1 && <span className="ml-1"><MapPin className="h-3 w-3 inline" />{storeCount}</span>}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm">{totalSpent > 0 ? `$${totalSpent.toFixed(2)}` : ""}</TableCell>
                      <TableCell>
                        {hasLog && log?.status === "confirmed" && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}
                        {hasLog && log?.status === "draft" && <div className="h-3.5 w-3.5 rounded-full bg-yellow-400 border border-yellow-500" title="Draft" />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-8 text-center text-muted-foreground text-sm">No trip dates found.</div>
            )}
          </CardContent>
        </Card>

        {/* Right: Segment entry + map */}
        <Card className="col-span-3">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">{selectedDate ? `Mileage Entry: ${fmtDateWithDay(selectedDate)}` : "Select a date"}</CardTitle>
                {selectedDate && selectedDateData && (() => {
                  if (autoSaveStatus === "saving") return <span className="text-[11px] font-medium bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded flex items-center gap-1"><RotateCw className="h-2.5 w-2.5 animate-spin" />Saving…</span>
                  if (autoSaveStatus === "error") return <span className="text-[11px] font-medium bg-red-100 text-red-800 px-1.5 py-0.5 rounded">Error</span>
                  if (autoSaveStatus === "saved") return <span className="text-[11px] font-medium bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">Draft</span>
                  const logStatus = selectedDateData.log?.status
                  if (logStatus === "confirmed") return <span className="text-[11px] font-medium bg-green-100 text-green-800 px-1.5 py-0.5 rounded">Saved</span>
                  if (logStatus === "draft") return <span className="text-[11px] font-medium bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">Draft</span>
                  return null
                })()}
              </div>
              {selectedDate && selectedDateData && (
                <div className="flex items-center gap-2">
                  {savedSnapshot.current && autoSaveStatus === "saved" && (
                    <Button size="sm" variant="outline" disabled={updateTripLog.isPending} onClick={handleRevert}>
                      <Undo2 className="h-3.5 w-3.5 mr-1" />Revert
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={createReceiptTripLog.isPending || updateTripLog.isPending} onClick={handleSkip}>
                    Skip
                  </Button>
                  <Button size="sm" disabled={!canSave || createReceiptTripLog.isPending || updateTripLog.isPending} onClick={handleSave}>
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {createReceiptTripLog.isPending || updateTripLog.isPending ? "Saving…" : "Save to Log"}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {selectedDate && selectedDateData ? (
              <div className="space-y-4">
                {selectedDateData.hasLog && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2 text-sm text-amber-800 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span>A {selectedDateData.log?.source} log already exists. Saving will merge.</span>
                  </div>
                )}

                {/* Receipts */}
                {selectedDateData.receipts.length > 0 && (
                <div>
                  <div className="text-xs font-medium mb-1">Receipts ({selectedDateData.receipts.length})</div>
                  <div className="space-y-1">
                    {selectedDateData.receipts.map((r) => {
                      const matchedLoc = findMatchingLocation(r)
                      return (
                        <div key={r.id} className="flex items-center gap-2 bg-slate-50 border rounded px-2 py-1 text-xs">
                          <Link to={`/receipts/${r.id}`} className="font-medium text-blue-600 hover:underline">{r.vendor_name}</Link>
                          <span className="text-muted-foreground">${parseFloat(r.total).toFixed(2)}</span>
                          <span className="text-muted-foreground ml-auto flex items-center gap-1 truncate max-w-[200px]">
                            <MapPin className="h-3 w-3 flex-shrink-0" />
                            <span className="text-green-700">{matchedLoc?.label || r.store_label || r.store_address || "Unknown"}</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                )}

                {/* Timeline Activity */}
                {timelineSegments && timelineSegments.length > 0 && (() => {
                  const tlLabelsLocal = labelTimelineSegments(timelineSegments)
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-medium">
                          Timeline Activity ({timelineSegments.filter((s: TravelSegment) => s.classification_reason !== "manual").length} segments)
                          <span className="font-normal text-muted-foreground ml-1">— Google data, may have gaps</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground">Match:</span>
                          <select className="text-[11px] border rounded px-1 py-0.5 h-5 bg-white"
                            value={matchRadius} onChange={(e) => setMatchRadius(Number(e.target.value))}
                          >
                            <option value={150}>150m</option>
                            <option value={200}>200m</option>
                            <option value={250}>250m</option>
                            <option value={300}>300m</option>
                            <option value={400}>400m</option>
                            <option value={500}>500m</option>
                          </select>
                          <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" disabled={rematching}
                            onClick={handleRematch}
                          >
                            {rematching ? <RotateCw className="h-2.5 w-2.5 animate-spin" /> : <RotateCw className="h-2.5 w-2.5" />}
                            <span className="ml-0.5">Rematch</span>
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-0.5 max-h-[300px] overflow-y-auto border rounded p-1.5 bg-white">
                        {timelineSegments.filter((seg: TravelSegment) => seg.classification_reason !== "manual").map((seg: TravelSegment) => {
                          const classColor = seg.classification === "business" ? "text-green-700" : seg.classification === "personal" ? "text-blue-700" : "text-gray-500"
                          const isExpanded = expandedTimelineId === seg.id
                          const toggleExpand = () => setExpandedTimelineId(isExpanded ? null : seg.id)
                          if (seg.segment_type === "drive") {
                            const fromLabel = tlLabelsLocal.get(seg.id) || seg.from_location || "?"
                            const toLabel = tlLabelsLocal.get(seg.id + "_to") || seg.to_location || "?"
                            return (
                              <div key={seg.id}>
                                <div
                                  className={`flex items-center gap-2 text-xs px-1.5 py-0.5 cursor-pointer transition-colors ${hoveredSegmentId === seg.id ? "bg-amber-100" : "hover:bg-slate-50"}`}
                                  onMouseEnter={() => setHoveredSegmentId(seg.id)} onMouseLeave={() => setHoveredSegmentId(null)}
                                  onClick={toggleExpand}
                                >
                                  {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                                  <span className="text-muted-foreground w-[100px] flex-shrink-0 font-mono">
                                    <TimeWithDay ts={seg.start_time} refDate={selectedDate} />–<TimeWithDay ts={seg.end_time} refDate={selectedDate} />
                                  </span>
                                  <Car className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                  <span className="truncate">{fromLabel} {"\u2192"} {toLabel}</span>
                                  {seg.distance_meters != null && <span className="text-muted-foreground ml-auto flex-shrink-0">{(seg.distance_meters / 1000).toFixed(1)} km</span>}
                                  <span className={`flex-shrink-0 ${classColor}`}>{seg.classification}</span>
                                </div>
                                {isExpanded && (
                                  <div className="ml-7 mb-1 px-2 py-1 bg-slate-50 border rounded text-[10px] text-muted-foreground space-y-0.5">
                                    {seg.start_time && <div>Time: {new Date(seg.start_time).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}–{seg.end_time ? new Date(seg.end_time).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false }) : "?"}</div>}
                                    {seg.start_lat != null && <div>Start: {seg.start_lat.toFixed(6)}, {seg.start_lng?.toFixed(6)}</div>}
                                    {seg.end_lat != null && <div>End: {seg.end_lat.toFixed(6)}, {seg.end_lng?.toFixed(6)}</div>}
                                    {seg.distance_meters != null && <div>Distance: {seg.distance_meters.toFixed(0)} m ({(seg.distance_meters / 1000).toFixed(2)} km)</div>}
                                    {seg.from_location && <div>From (raw): {seg.from_location}</div>}
                                    {seg.to_location && <div>To (raw): {seg.to_location}</div>}
                                    <div>Classification: {seg.classification} ({seg.classification_reason || "auto"})</div>
                                    <div>ID: {seg.id}</div>
                                  </div>
                                )}
                              </div>
                            )
                          }
                          const visitLabel = tlLabelsLocal.get(seg.id) || seg.visit_location_label || seg.from_location || "Unknown"
                          return (
                            <div key={seg.id}>
                              <div
                                className={`flex items-center gap-2 text-xs px-1.5 py-0.5 cursor-pointer transition-colors ${hoveredSegmentId === seg.id ? "bg-amber-100" : "bg-slate-50 hover:bg-slate-100"}`}
                                onMouseEnter={() => setHoveredSegmentId(seg.id)} onMouseLeave={() => setHoveredSegmentId(null)}
                                onClick={toggleExpand}
                              >
                                {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                                <span className="text-muted-foreground w-[100px] flex-shrink-0 font-mono">
                                  <TimeWithDay ts={seg.start_time} refDate={selectedDate} />–<TimeWithDay ts={seg.end_time} refDate={selectedDate} />
                                </span>
                                <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                <span className="truncate">{visitLabel}{seg.visit_duration_minutes != null && <span className="text-muted-foreground ml-1">({seg.visit_duration_minutes} min)</span>}</span>
                                <span className={`ml-auto flex-shrink-0 ${classColor}`}>{seg.classification}</span>
                              </div>
                              {isExpanded && (
                                <div className="ml-7 mb-1 px-2 py-1 bg-slate-50 border rounded text-[10px] text-muted-foreground space-y-0.5">
                                  {seg.start_time && <div>Time: {new Date(seg.start_time).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}–{seg.end_time ? new Date(seg.end_time).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false }) : "?"}</div>}
                                  {seg.start_lat != null && <div>Coordinates: {seg.start_lat.toFixed(6)}, {seg.start_lng?.toFixed(6)}</div>}
                                  {seg.visit_location_label && <div>Matched: {seg.visit_location_label}{seg.visit_location_chain ? ` (${seg.visit_location_chain})` : ""}</div>}
                                  {seg.from_location && <div>Raw label: {seg.from_location}</div>}
                                  {seg.visit_duration_minutes != null && <div>Duration: {seg.visit_duration_minutes} min</div>}
                                  <div>Classification: {seg.classification} ({seg.classification_reason || "auto"})</div>
                                  <div>ID: {seg.id}</div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}

                {/* Drive Segments */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium">Drive Segments</label>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" className="h-6 text-xs"
                        disabled={!timelineSegments || timelineSegments.length === 0}
                        title={!timelineSegments || timelineSegments.length === 0 ? "No timeline data for this date" : "Generate drive segments from timeline activity"}
                        onClick={generateFromTimeline}
                      >
                        <RotateCw className="h-3 w-3 mr-1" /> Generate from timeline
                      </Button>
                      {segments.length > 1 && (
                        <Button variant="outline" size="sm" className="h-6 text-xs text-red-500 hover:text-red-700" onClick={() => setSegments([emptySegment()])}>
                          <Trash2 className="h-3 w-3 mr-1" /> Clear All
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addSegment}>
                        <Plus className="h-3 w-3 mr-1" /> Add Segment
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {segments.map((seg, i) => (
                      <div key={i}
                        draggable
                        onDragStart={(e) => handleSegDragStart(e, i)}
                        onDragOver={(e) => handleSegDragOver(e, i)}
                        onDrop={(e) => handleSegDrop(e, i)}
                        onDragEnd={handleSegDragEnd}
                        className={`border rounded p-2 space-y-2 bg-slate-50 transition-all ${
                          dragSegIdx === i ? "opacity-30 scale-[0.98]" : ""
                        } ${overSegIdx === i && dragSegIdx !== i ? "border-t-2 border-blue-500" : ""}`}
                      >
                        <div className="flex gap-2 items-center">
                          <span className="cursor-grab active:cursor-grabbing text-muted-foreground" title="Drag to reorder">
                            <GripVertical className="h-4 w-4" />
                          </span>
                          <LocationSearch locations={locationOptions} groups={segmentLocationGroups} value={seg.from_id}
                            onValueChange={(v) => updateSegment(i, "from_id", v)} placeholder="From..." className="flex-1" triggerClassName="h-7"
                            onAddNew={() => { setNewLocTarget({ segIndex: i, field: "from_id" }); setNewLocLabel(""); setNewLocAddress(""); setNewLocType("personal") }}
                          />
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 flex-shrink-0" title="Swap start and end"
                            onClick={() => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, from_id: s.to_id, to_id: s.from_id, computed_km: "", distance_km: "", routeCoords: [], routeError: null } : s))}>
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                          </Button>
                          <LocationSearch locations={locationOptions} groups={segmentLocationGroups} value={seg.to_id}
                            onValueChange={(v) => updateSegment(i, "to_id", v)} placeholder="To..." className="flex-1" triggerClassName="h-7"
                            onAddNew={() => { setNewLocTarget({ segIndex: i, field: "to_id" }); setNewLocLabel(""); setNewLocAddress(""); setNewLocType("personal") }}
                          />
                        </div>
                        <div className="flex gap-2 items-center flex-wrap">
                          <div className="flex items-center gap-1">
                            <input type="number" step="0.1" min="0" className="w-20 text-xs border rounded px-2 py-1 h-7" placeholder="km"
                              value={seg.distance_km} onChange={(e) => updateSegment(i, "distance_km", e.target.value)}
                              readOnly={seg.isDetour}
                              title={seg.isDetour ? `Detour: ${seg.withStopsKm || "?"} − ${seg.directKm || "?"} = ${seg.distance_km || "?"} km` : undefined}
                            />
                            <span className="text-xs text-muted-foreground">{seg.isDetour ? "detour km" : "km"}</span>
                            {seg.computing && <RotateCw className="h-3 w-3 text-muted-foreground animate-spin" />}
                            {seg.routeError && <span className="text-xs text-red-600 flex items-center gap-1" title={seg.routeError}><AlertTriangle className="h-3 w-3" />Failed</span>}
                            {seg.from_id && seg.to_id && !seg.computing && (
                              <Button variant="ghost" size="sm" className="h-6 px-1" title={seg.routeError ? "Retry" : "Recompute"}
                                onClick={() => setSegments((prev) => prev.map((s, j) => j === i ? { ...s, computed_km: "", distance_km: "", routeCoords: [], routeError: null } : s))}
                              ><RotateCw className="h-3 w-3" /></Button>
                            )}
                          </div>
                          {!seg.isDetour && (
                            <Select value={seg.classification} onValueChange={(v) => updateSegment(i, "classification", v)}>
                              <SelectTrigger className="h-6 w-[85px] text-[11px] px-2"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="business" className="text-xs">Business</SelectItem>
                                <SelectItem value="personal" className="text-xs">Personal</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                          <Button variant={seg.isDetour ? "default" : "outline"} size="sm"
                            className={`h-6 text-[11px] px-2`}
                            onClick={() => toggleDetour(i)} title="Detour: business km = route with stops − direct route"
                          >Detour</Button>
                          <Button variant="ghost" size="sm" className="h-6 px-1 text-red-500" onClick={() => removeSegment(i)}><Trash2 className="h-3 w-3" /></Button>
                        </div>

                        {/* Stops + breakdown */}
                        {(seg.isDetour || seg.detourStopIds.length > 0 || (seg.from_id && seg.to_id)) && (
                          <div className="space-y-1.5">
                            <DetourStopList
                              seg={seg}
                              segIndex={i}
                              locationOptions={locationOptions}
                              receiptStoreLocations={receiptStoreLocations}
                              homeLocationId={homeLocation?.id}
                              onAdd={addDetourStop}
                              onRemove={removeDetourStop}
                              onReorder={(segIdx, newIds) => {
                                setSegments((prev) => prev.map((s, j) => j === segIdx ? { ...s, detourStopIds: newIds, computed_km: "", distance_km: "", routeCoords: [] } : s))
                              }}
                            />
                            {(() => {
                              const noTimeline = !timelineSegments || timelineSegments.length === 0
                              const missingEndpoints = !seg.from_id || !seg.to_id
                              const hasStops = seg.detourStopIds.length > 0
                              const disabled = noTimeline || missingEndpoints || hasStops
                              const title = noTimeline ? "No timeline data for this date"
                                : missingEndpoints ? "Set both From and To locations first"
                                : hasStops ? "Clear existing stops first"
                                : "Fill detour stops from timeline visits"
                              return (
                                <div className="flex gap-1 ml-5">
                                  <Button variant="outline" size="sm" className="h-5 text-[10px] px-2" disabled={disabled} title={title} onClick={() => autoFillDetourStops(i)}>
                                    Auto-fill from timeline
                                  </Button>
                                  <Button variant="outline" size="sm" className="h-5 text-[10px] px-2"
                                    disabled={seg.detourStopIds.length < 2 || !seg.from_id || !seg.to_id}
                                    title={seg.detourStopIds.length < 2 ? "Need at least 2 stops" : !seg.from_id || !seg.to_id ? "Set both endpoints first" : "Reorder stops to minimize total route distance"}
                                    onClick={() => {
                                      const fromLoc = locationOptions.find((l) => l.id === seg.from_id)
                                      const toLoc = locationOptions.find((l) => l.id === seg.to_id)
                                      if (!fromLoc?.latitude || !toLoc?.latitude) return
                                      const sorted = sortStopsByShortestRoute(
                                        { latitude: fromLoc.latitude, longitude: fromLoc.longitude! },
                                        { latitude: toLoc.latitude, longitude: toLoc.longitude! },
                                        seg.detourStopIds, locationOptions,
                                      )
                                      setSegments((prev) => prev.map((s, j) => j === i ? { ...s, detourStopIds: sorted, computed_km: "", distance_km: "", routeCoords: [] } : s))
                                    }}
                                  >
                                    Sort by shortest route
                                  </Button>
                                </div>
                              )
                            })()}
                            {seg.directKm && seg.withStopsKm && seg.isDetour && (
                              <div className="text-[11px] text-muted-foreground font-mono">
                                Direct: {seg.directKm} km · With stops: {seg.withStopsKm} km · <span className="text-green-700 font-semibold">Business detour: {seg.distance_km} km</span>
                              </div>
                            )}
                            {!seg.isDetour && seg.detourStopIds.length > 0 && seg.distance_km && (
                              <div className="text-[11px] text-muted-foreground font-mono">
                                Route with {seg.detourStopIds.length} stop{seg.detourStopIds.length !== 1 ? "s" : ""}: <span className="font-semibold">{seg.distance_km} km</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Add New Location inline */}
                {newLocTarget && (
                  <div className="border rounded p-3 bg-blue-50 space-y-2">
                    <div className="text-xs font-medium">Add New Location (segment {newLocTarget.segIndex + 1} {newLocTarget.field === "from_id" ? "From" : "To"})</div>
                    <div className="grid grid-cols-2 gap-2">
                      <input className="text-xs border rounded px-2 py-1 h-7" placeholder="Label" value={newLocLabel} onChange={(e) => setNewLocLabel(e.target.value)} />
                      <input className="text-xs border rounded px-2 py-1 h-7" placeholder="Address" value={newLocAddress} onChange={(e) => setNewLocAddress(e.target.value)} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={newLocType} onValueChange={setNewLocType}>
                        <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="personal" className="text-xs">Personal</SelectItem>
                          <SelectItem value="business" className="text-xs">Business</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button size="sm" className="h-7 text-xs" disabled={!newLocAddress || createTravelLocation.isPending || geocoding}
                        onClick={() => {
                          const label = newLocLabel.trim() || newLocAddress.trim()
                          createTravelLocation.mutate({ label, address: newLocAddress, location_type: newLocType }, {
                            onSuccess: async (newLoc) => {
                              setGeocoding(true)
                              try {
                                await travel.locations.geocode([newLoc.id])
                                await queryClient.invalidateQueries({ queryKey: ["travel", "locations"] })
                              } catch { /* geocode best-effort */ }
                              setGeocoding(false)
                              updateSegment(newLocTarget.segIndex, newLocTarget.field, newLoc.id)
                              setNewLocTarget(null)
                            },
                          })
                        }}
                      >{geocoding ? "Geocoding\u2026" : createTravelLocation.isPending ? "Creating\u2026" : "Create & Select"}</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setNewLocTarget(null)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Map */}
                <RouteMap
                  segments={segments}
                  locations={locationOptions}
                  receiptLocations={selectedDateData.receipts}
                  timelineSegments={timelineSegments}
                  hoveredSegmentId={hoveredSegmentId}
                  onHoverSegment={setHoveredSegmentId}
                />

                {/* Purpose & Notes */}
                <div>
                  <label className="text-xs font-medium">Purpose</label>
                  <input className="w-full text-sm border rounded px-2 py-1 mt-1" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Business supplies" />
                </div>
                <div>
                  <label className="text-xs font-medium">Notes</label>
                  <textarea className="w-full text-sm border rounded px-2 py-1 mt-1" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Additional notes..." />
                </div>

                {/* Km Summary */}
                {segments.some((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0) && (() => {
                  const valid = segments.filter((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0)
                  const totalKm = valid.reduce((sum, s) => sum + parseFloat(s.distance_km || "0"), 0)
                  const businessKm = valid.filter((s) => s.classification === "business").reduce((sum, s) => sum + parseFloat(s.distance_km || "0"), 0)
                  const personalKm = valid.filter((s) => s.classification === "personal").reduce((sum, s) => sum + parseFloat(s.distance_km || "0"), 0)
                  return (
                    <div className="flex items-center gap-3 text-xs font-mono bg-muted/50 rounded px-3 py-1.5">
                      <span className="font-semibold">Total: {totalKm.toFixed(1)} km</span>
                      {businessKm > 0 && <span className="text-green-700">Business: {businessKm.toFixed(1)} km</span>}
                      {personalKm > 0 && <span className="text-blue-600">Personal: {personalKm.toFixed(1)} km</span>}
                    </div>
                  )
                })()}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">Click a date on the left to create a mileage log entry.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
