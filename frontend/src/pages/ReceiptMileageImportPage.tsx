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
  useCreateTravelLocation,
  useUpdateTripLog,
} from "@/hooks/useApi"
import { useQueryClient, useQuery } from "@tanstack/react-query"
import { travel } from "@/api"
import type { TravelTripLog, TravelLocation, TravelSegment } from "@/api"
import type { ReceiptWithVendor } from "@/types"
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
    const key = bounds.map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join("|")
    if (key === prevKeyRef.current) return
    prevKeyRef.current = key
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
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Map render error:", error, info) }
  render() {
    if (this.state.error) return <div className="text-xs text-red-600 py-2">Map failed: {this.state.error}</div>
    return this.props.children
  }
}

// ----- Helpers -----

const CLASSIFICATION_COLORS: Record<string, string> = { business: "#15803d", personal: "#1d4ed8" }
const TIMELINE_COLORS: Record<string, { line: string; marker: string }> = {
  business: { line: "#16a34a", marker: "#15803d" },
  personal: { line: "#93c5fd", marker: "#60a5fa" },
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return ""
  return new Date(ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function fmtDateWithDay(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00")
  const day = d.toLocaleDateString("en-CA", { weekday: "long" })
  return `${dateStr} (${day})`
}

/** Number "Unknown" labels and infer missing drive endpoints from adjacent visits */
function labelTimelineSegments(segs: TravelSegment[]): Map<string, string> {
  const labels = new Map<string, string>()
  let unknownCounter = 0
  const visitLabelAt = (idx: number, direction: "before" | "after"): string => {
    const step = direction === "before" ? -1 : 1
    for (let j = idx + step; j >= 0 && j < segs.length; j += step) {
      if (segs[j].segment_type === "visit") return segs[j].visit_location_label || segs[j].from_location || ""
    }
    return ""
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (labels.has(s.id)) continue
    let rawLabel: string
    if (s.segment_type === "visit") {
      rawLabel = s.visit_location_label || s.from_location || ""
    } else {
      rawLabel = s.from_location || visitLabelAt(i, "before")
    }
    if (!rawLabel || rawLabel.startsWith("Unknown") || rawLabel === "?") {
      unknownCounter++
      labels.set(s.id, `Unknown (${unknownCounter})`)
    } else {
      labels.set(s.id, rawLabel)
    }
    if (s.segment_type === "drive") {
      let toLabel = s.to_location || visitLabelAt(i, "after")
      if (!toLabel || toLabel.startsWith("Unknown") || toLabel === "?") {
        unknownCounter++
        labels.set(s.id + "_to", `Unknown (${unknownCounter})`)
      } else {
        labels.set(s.id + "_to", toLabel)
      }
    }
  }
  return labels
}

/**
 * Auto-suggest detour segments from timeline data.
 * Pattern: Personal visit → Business visit(s) → Personal visit
 * Only uses high-confidence matches (visit_location_label set).
 */
function suggestDetourSegments(
  segs: TravelSegment[],
  locations: TravelLocation[],
): SegmentDraft[] {
  // Extract matched visits in chronological order
  const visits = segs.filter(
    (s) => s.segment_type === "visit" && s.visit_location_label && !s.visit_location_label.startsWith("Unknown")
  )
  if (visits.length < 3) return []

  const findLocId = (label: string) => locations.find((l) => l.label === label)?.id || ""

  const drafts: SegmentDraft[] = []
  let i = 0
  while (i < visits.length) {
    // Look for a personal visit
    if (visits[i].classification !== "personal") { i++; continue }
    const fromVisit = visits[i]

    // Collect consecutive business visits after it
    const businessStops: TravelSegment[] = []
    let j = i + 1
    while (j < visits.length && visits[j].classification === "business") {
      businessStops.push(visits[j])
      j++
    }

    // Need at least one business stop AND a personal visit to close the bracket
    if (businessStops.length > 0 && j < visits.length && visits[j].classification === "personal") {
      const toVisit = visits[j]
      const fromId = findLocId(fromVisit.visit_location_label!)
      const toId = findLocId(toVisit.visit_location_label!)
      const stopIds = businessStops
        .map((s) => findLocId(s.visit_location_label!))
        .filter((id) => id && id !== fromId && id !== toId)
      // Deduplicate stops
      const uniqueStopIds = [...new Set(stopIds)]

      if (fromId && toId && uniqueStopIds.length > 0) {
        drafts.push({
          from_id: fromId,
          to_id: toId,
          distance_km: "",
          computed_km: "",
          classification: "business",
          routeCoords: [],
          computing: false,
          routeError: null,
          source: "suggested",
          isDetour: true,
          detourStopIds: uniqueStopIds,
          directKm: "",
          withStopsKm: "",
          directCoords: [],
          withStopsCoords: [],
        })
      }
      i = j // continue from the closing personal visit (it can start a new bracket)
    } else {
      i++
    }
  }
  return drafts
}

// ----- Segment Types (simple) -----

/** Haversine distance in km between two lat/lng points */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const p = Math.PI / 180
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lng2 - lng1) * p / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

/** Find the optimal insertion index for a new stop that minimizes total route distance */
function optimalStopIndex(
  fromLoc: { latitude: number; longitude: number },
  toLoc: { latitude: number; longitude: number },
  existingStops: { latitude: number; longitude: number }[],
  newStop: { latitude: number; longitude: number },
): number {
  // Build the full waypoint chain: [from, ...stops, to]
  const chain = [fromLoc, ...existingStops, toLoc]
  let bestIdx = 0
  let bestCost = Infinity
  // Try inserting at each position among stops (index 0..existingStops.length)
  for (let pos = 0; pos <= existingStops.length; pos++) {
    // Insert after chain[pos] (which is from or a stop) and before chain[pos+1]
    const prev = chain[pos]
    const next = chain[pos + 1]
    // Cost of inserting here = dist(prev→new) + dist(new→next) - dist(prev→next)
    const added = haversineKm(prev.latitude, prev.longitude, newStop.latitude, newStop.longitude)
      + haversineKm(newStop.latitude, newStop.longitude, next.latitude, next.longitude)
      - haversineKm(prev.latitude, prev.longitude, next.latitude, next.longitude)
    if (added < bestCost) {
      bestCost = added
      bestIdx = pos
    }
  }
  return bestIdx
}

interface SegmentDraft {
  from_id: string
  to_id: string
  distance_km: string
  computed_km: string
  classification: string
  routeCoords: [number, number][]
  computing: boolean
  routeError: string | null
  source: string
  // Detour fields
  isDetour: boolean
  detourStopIds: string[]
  directKm: string
  withStopsKm: string
  directCoords: [number, number][]
  withStopsCoords: [number, number][]
}

function emptySegment(fromId?: string): SegmentDraft {
  return {
    from_id: fromId || "", to_id: "", distance_km: "", computed_km: "",
    classification: "business", routeCoords: [], computing: false, routeError: null, source: "manual",
    isDetour: false, detourStopIds: [], directKm: "", withStopsKm: "",
    directCoords: [], withStopsCoords: [],
  }
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
  const result = { distance: data.distance_meters, coords: data.coords.map(([lat, lng]) => [lat, lng] as [number, number]) }
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

    return { allPoints: pts, manualDrives: manual, detourDrives: detours, timelineDrives: tlDrives, timelineVisits: tlVisits, receiptMarkers: rcpt }
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
    <MapErrorBoundary>
      <div className="h-80 w-full rounded border overflow-hidden relative z-0">
        <MapContainer center={allPoints[0]} zoom={10} className="h-full w-full" scrollWheelZoom={false}>
          <GoogleTileLayer />
          <FitBounds bounds={allPoints} />

          {/* Timeline drives — road-snapped */}
          {timelineDrives.map((d, i) => {
            const isHovered = hoveredSegmentId === d.segId
            const positions = snappedRoutes.get(d.key) || [d.start, d.end]
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
          {manualDrives.map((d, i) => (
            <Polyline key={`seg-${i}-${d.color}`} positions={d.positions} color={d.color} weight={4} opacity={0.9}>
              <Tooltip>{d.label}</Tooltip>
            </Polyline>
          ))}

          {/* Detour segments */}
          {detourDrives.map((d, i) => (
            <Polyline key={`det-${i}`} positions={d.positions} color={d.color} weight={4} opacity={0.9}>
              <Tooltip>{d.label}</Tooltip>
            </Polyline>
          ))}

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
        Stops on this personal route (drag to reorder):
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
  const [matchRadius, setMatchRadius] = useState(250)
  const [rematching, setRematching] = useState(false)
  const [yearFilter, setYearFilter] = useState<string>("all")
  const [editingYearlyKm, setEditingYearlyKm] = useState<string>("")

  const { data: receipts, isLoading: receiptsLoading } = useReceipts()
  const { data: allLogs } = useTripLogs()
  const { data: yearlyMileageData } = useQuery({ queryKey: ["travel", "yearly-mileage"], queryFn: () => travel.yearlyMileage.list() })
  const { data: travelLocations = [] } = useTravelLocations()
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
    return Array.from(years).sort((a, b) => b - a)
  }, [allLogs, receipts])

  // Effective date range (year filter overrides from/to)
  const effectiveFromDate = yearFilter !== "all" ? `${yearFilter}-01-01` : fromDate
  const effectiveToDate = yearFilter !== "all" ? `${yearFilter}-12-31` : toDate

  const receiptsByDate = useMemo(() => {
    if (!receipts) return []
    const map = new Map<string, ReceiptWithVendor[]>()
    for (const r of receipts) {
      if (effectiveFromDate && r.receipt_date < effectiveFromDate) continue
      if (effectiveToDate && r.receipt_date > effectiveToDate) continue
      if (!r.store_location_id) continue
      if (r.store_location_id === onlineLocation?.id) continue
      const existing = map.get(r.receipt_date) || []
      existing.push(r)
      map.set(r.receipt_date, existing)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, recs]) => ({
        date, receipts: recs,
        totalSpent: recs.reduce((sum, r) => sum + parseFloat(r.total), 0),
        vendors: [...new Set(recs.map((r) => r.vendor_name))],
        storeCount: new Set(recs.map((r) => r.store_location_id)).size,
        hasLog: logsByDate.has(date),
        log: logsByDate.get(date),
      }))
  }, [receipts, effectiveFromDate, effectiveToDate, logsByDate, onlineLocation])

  const selectedDateData = useMemo(() => receiptsByDate.find((d) => d.date === selectedDate), [receiptsByDate, selectedDate])

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

  // Grouped location list for segment pickers: Receipt Locations (unused) first, then All Locations
  const segmentLocationGroups = useMemo(() => {
    const usedIds = new Set(segments.flatMap((s) => [s.from_id, s.to_id]).filter(Boolean))
    const receiptIds = new Set(receiptStoreLocations.map((l) => l.id))
    const unusedReceipt = receiptStoreLocations.filter((l) => !usedIds.has(l.id) && l.id !== homeLocation?.id)
    const topLocs = [
      ...(homeLocation ? [homeLocation] : []),
      ...unusedReceipt,
    ]
    const restLocs = locationOptions.filter((l) => !receiptIds.has(l.id) && l.id !== homeLocation?.id)
    return [
      { label: "Receipt Locations", locations: topLocs },
      { label: "All Locations", locations: restLocs },
    ]
  }, [receiptStoreLocations, locationOptions, homeLocation, segments])

  const handleSelectDate = useCallback((date: string) => {
    setSelectedDate(date)
    const data = receiptsByDate.find((d) => d.date === date)
    if (!data) return
    if (!data.hasLog) {
      setPurpose(`Business: ${data.vendors.join(", ")}`)
      setNotes("")
    }
    setSegments([emptySegment()])
    setAutoSaveStatus("idle")
    lastSavedKey.current = ""
    setDraftLogId(null)
    loadedLogDateRef.current = null
  }, [receiptsByDate])

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
      // Set lastSavedKey so auto-save doesn't immediately re-fire
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
        // Update lastSavedKey to match loaded state so auto-save doesn't re-fire
        const validSegs = drafts.filter((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0).map((s) => ({
          from_location: locationOptions.find((l) => l.id === s.from_id)?.label || "",
          to_location: locationOptions.find((l) => l.id === s.to_id)?.label || "",
          distance_km: parseFloat(s.distance_km),
          classification: s.classification,
          route_coords: s.routeCoords.length > 0 ? s.routeCoords : undefined,
          is_detour: s.isDetour || undefined,
          detour_stop_ids: s.detourStopIds.length > 0 ? s.detourStopIds : undefined,
          direct_km: s.directKm ? parseFloat(s.directKm) : undefined,
          with_stops_km: s.withStopsKm ? parseFloat(s.withStopsKm) : undefined,
        }))
        const purpose_ = selectedDateData.log?.purpose || ""
        const notes_ = selectedDateData.log?.notes || ""
        lastSavedKey.current = JSON.stringify({ date: selectedDate, purpose: purpose_ || undefined, notes: notes_ || undefined, segs: validSegs })
      } else {
        // No existing manual segments — try auto-suggesting detour segments from timeline
        if (timelineSegments && timelineSegments.length > 0) {
          const suggested = suggestDetourSegments(timelineSegments, locationOptions)
          if (suggested.length > 0) {
            setSegments([...suggested, emptySegment()])
          }
        }
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
      if (seg.isDetour && seg.detourStopIds.length > 0) {
        // Detour mode: compute direct route AND route with stops
        const waypoints: [number, number][] = seg.detourStopIds
          .map((id) => locationOptions.find((l) => l.id === id))
          .filter((l): l is TravelLocation => l != null && l.latitude != null && l.longitude != null)
          .map((l) => [l.latitude!, l.longitude!])
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
  const removeSegment = (index: number) => setSegments((prev) => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev)

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
    return segments
      .filter((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0)
      .map((s) => {
        const fromLoc = locationOptions.find((l) => l.id === s.from_id)
        const toLoc = locationOptions.find((l) => l.id === s.to_id)
        return {
          from_location: fromLoc?.label || "",
          to_location: toLoc?.label || "",
          distance_km: parseFloat(s.distance_km),
          classification: s.classification,
          route_coords: s.routeCoords.length > 0 ? s.routeCoords : undefined,
          is_detour: s.isDetour || undefined,
          detour_stop_ids: s.detourStopIds.length > 0 ? s.detourStopIds : undefined,
          direct_km: s.directKm ? parseFloat(s.directKm) : undefined,
          with_stops_km: s.withStopsKm ? parseFloat(s.withStopsKm) : undefined,
        }
      })
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
        // Already have a draft — update purpose/notes AND segments
        updateTripLog.mutateAsync({ id: draftLogId, purpose: purpose || undefined, notes: notes || undefined, segments: validSegs })
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
      setAutoSaveStatus("saved")
      lastSavedKey.current = saveKey
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

  if (receiptsLoading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Receipt Mileage Import</h1>
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
        {/* Left: Receipt dates */}
        <Card className="col-span-2">
          <CardHeader><CardTitle className="text-sm">Receipt Dates ({receiptsByDate.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            {receiptsByDate.length > 0 ? (
              <Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Vendors</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="w-10"></TableHead></TableRow></TableHeader>
                <TableBody>
                  {receiptsByDate.map(({ date, receipts: dateReceipts, vendors, totalSpent, storeCount, hasLog }) => (
                    <TableRow key={date} className={`cursor-pointer hover:bg-slate-50 ${selectedDate === date ? "bg-blue-50" : ""}`} onClick={() => handleSelectDate(date)}>
                      <TableCell className="font-medium text-sm">{fmtDateWithDay(date)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[180px]">
                        {vendors.join(", ")}
                        <span className="ml-1"><FileText className="h-3 w-3 inline" />{dateReceipts.length}</span>
                        {storeCount > 1 && <span className="ml-1"><MapPin className="h-3 w-3 inline" />{storeCount}</span>}
                      </TableCell>
                      <TableCell className="text-right text-sm">${totalSpent.toFixed(2)}</TableCell>
                      <TableCell>{hasLog && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-8 text-center text-muted-foreground text-sm">No in-store receipts found.</div>
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
                  const logStatus = selectedDateData.log?.status
                  if (logStatus === "confirmed") return <span className="text-[11px] font-medium bg-green-100 text-green-800 px-1.5 py-0.5 rounded">Saved</span>
                  if (logStatus === "draft" || autoSaveStatus === "saved") return <span className="text-[11px] font-medium bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">Draft</span>
                  if (autoSaveStatus === "saving") return <span className="text-[11px] font-medium bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded flex items-center gap-1"><RotateCw className="h-2.5 w-2.5 animate-spin" />Saving…</span>
                  if (autoSaveStatus === "error") return <span className="text-[11px] font-medium bg-red-100 text-red-800 px-1.5 py-0.5 rounded">Error</span>
                  return <span className="text-[11px] font-medium bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Unsaved</span>
                })()}
              </div>
              {selectedDate && selectedDateData && (
                <Button size="sm" disabled={!canSave || createReceiptTripLog.isPending || updateTripLog.isPending} onClick={handleSave}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  {createReceiptTripLog.isPending || updateTripLog.isPending ? "Saving…" : "Save to Log"}
                </Button>
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

                {/* Timeline Activity */}
                {timelineSegments && timelineSegments.length > 0 && (() => {
                  const tlLabelsLocal = labelTimelineSegments(timelineSegments)
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-medium">
                          Timeline Activity ({timelineSegments.length} segments)
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
                      <div className="space-y-0.5 max-h-[200px] overflow-y-auto border rounded p-1.5 bg-white">
                        {timelineSegments.map((seg: TravelSegment) => {
                          const timeRange = `${fmtTime(seg.start_time)}\u2013${fmtTime(seg.end_time)}`
                          const classColor = seg.classification === "business" ? "text-green-700" : seg.classification === "personal" ? "text-blue-700" : "text-gray-500"
                          if (seg.segment_type === "drive") {
                            const fromLabel = tlLabelsLocal.get(seg.id) || seg.from_location || "?"
                            const toLabel = tlLabelsLocal.get(seg.id + "_to") || seg.to_location || "?"
                            return (
                              <div key={seg.id}
                                className={`flex items-center gap-2 text-xs px-1.5 py-0.5 cursor-pointer transition-colors ${hoveredSegmentId === seg.id ? "bg-amber-100" : "hover:bg-slate-50"}`}
                                onMouseEnter={() => setHoveredSegmentId(seg.id)} onMouseLeave={() => setHoveredSegmentId(null)}
                              >
                                <span className="text-muted-foreground w-[90px] flex-shrink-0 font-mono">{timeRange}</span>
                                <Car className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                <span className="truncate">{fromLabel} {"\u2192"} {toLabel}</span>
                                {seg.distance_meters != null && <span className="text-muted-foreground ml-auto flex-shrink-0">{(seg.distance_meters / 1000).toFixed(1)} km</span>}
                                <span className={`flex-shrink-0 ${classColor}`}>{seg.classification}</span>
                              </div>
                            )
                          }
                          const visitLabel = tlLabelsLocal.get(seg.id) || seg.visit_location_label || seg.from_location || "Unknown"
                          return (
                            <div key={seg.id}
                              className={`flex items-center gap-2 text-xs px-1.5 py-0.5 transition-colors ${hoveredSegmentId === seg.id ? "bg-amber-100" : "bg-slate-50 hover:bg-slate-100"}`}
                              onMouseEnter={() => setHoveredSegmentId(seg.id)} onMouseLeave={() => setHoveredSegmentId(null)}
                            >
                              <span className="text-muted-foreground w-[90px] flex-shrink-0 font-mono">{timeRange}</span>
                              <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              <span className="truncate">{visitLabel}{seg.visit_duration_minutes != null && <span className="text-muted-foreground ml-1">({seg.visit_duration_minutes} min)</span>}</span>
                              <span className={`ml-auto flex-shrink-0 ${classColor}`}>{seg.classification}</span>
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
                    <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addSegment}>
                      <Plus className="h-3 w-3 mr-1" /> Add Segment
                    </Button>
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
                          <span className="text-xs text-muted-foreground">{"\u2192"}</span>
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
                          {segments.length > 1 && (
                            <Button variant="ghost" size="sm" className="h-6 px-1 text-red-500" onClick={() => removeSegment(i)}><Trash2 className="h-3 w-3" /></Button>
                          )}
                        </div>

                        {/* Detour stop picker + breakdown */}
                        {seg.isDetour && (
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
                            {seg.directKm && seg.withStopsKm && (
                              <div className="text-[11px] text-muted-foreground font-mono">
                                Direct: {seg.directKm} km · With stops: {seg.withStopsKm} km · <span className="text-green-700 font-semibold">Business detour: {seg.distance_km} km</span>
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
