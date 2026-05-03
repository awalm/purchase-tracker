/**
 * Pure business logic for the Receipt Mileage Import page.
 * No React dependencies — all functions are pure and testable.
 */

import type { TravelSegment, TravelLocation } from "@/api"

// ----- Types -----

export interface SegmentDraft {
  from_id: string
  to_id: string
  distance_km: string
  computed_km: string
  classification: string
  routeCoords: [number, number][]
  computing: boolean
  routeError: string | null
  source: string
  isDetour: boolean
  detourStopIds: string[]
  directKm: string
  withStopsKm: string
  directCoords: [number, number][]
  withStopsCoords: [number, number][]
}

export function emptySegment(fromId?: string): SegmentDraft {
  return {
    from_id: fromId || "", to_id: "", distance_km: "", computed_km: "",
    classification: "business", routeCoords: [], computing: false, routeError: null, source: "manual",
    isDetour: false, detourStopIds: [], directKm: "", withStopsKm: "",
    directCoords: [], withStopsCoords: [],
  }
}

// ----- Haversine -----

/** Haversine distance in km between two lat/lng points */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const p = Math.PI / 180
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lng2 - lng1) * p / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// ----- Optimal Stop Insertion -----

/** Find the optimal insertion index for a new stop that minimizes total route distance */
export function optimalStopIndex(
  fromLoc: { latitude: number; longitude: number },
  toLoc: { latitude: number; longitude: number },
  existingStops: { latitude: number; longitude: number }[],
  newStop: { latitude: number; longitude: number },
): number {
  const chain = [fromLoc, ...existingStops, toLoc]
  let bestIdx = 0
  let bestCost = Infinity
  for (let pos = 0; pos <= existingStops.length; pos++) {
    const prev = chain[pos]
    const next = chain[pos + 1]
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

/** Sort stop IDs to minimize total route distance (nearest-neighbor greedy) */
export function sortStopsByShortestRoute(
  fromLoc: { latitude: number; longitude: number },
  toLoc: { latitude: number; longitude: number },
  stopIds: string[],
  locations: TravelLocation[],
): string[] {
  if (stopIds.length <= 1) return stopIds
  const stops = stopIds
    .map((id) => ({ id, loc: locations.find((l) => l.id === id) }))
    .filter((s): s is { id: string; loc: TravelLocation } => !!s.loc?.latitude && !!s.loc?.longitude)
  if (stops.length <= 1) return stopIds

  // Greedy nearest-neighbor from start
  const remaining = [...stops]
  const sorted: string[] = []
  let current = fromLoc
  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current.latitude, current.longitude, remaining[i].loc.latitude!, remaining[i].loc.longitude!)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    sorted.push(remaining[bestIdx].id)
    current = { latitude: remaining[bestIdx].loc.latitude!, longitude: remaining[bestIdx].loc.longitude! }
    remaining.splice(bestIdx, 1)
  }
  return sorted
}

// ----- Timeline Label Resolution -----

/** Number "Unknown" labels and infer missing drive endpoints from adjacent visits */
export function labelTimelineSegments(segs: TravelSegment[]): Map<string, string> {
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

// ----- Segment Suggestion -----

/** Filter timeline segments to high-confidence visits, sorted chronologically */
export function getHighConfidenceVisits(segs: TravelSegment[]): TravelSegment[] {
  return segs
    .filter(
      (s) => s.segment_type === "visit" && s.visit_location_label && !s.visit_location_label.startsWith("Unknown")
    )
    .sort((a, b) => {
      if (a.start_time && b.start_time) return a.start_time.localeCompare(b.start_time)
      return a.segment_order - b.segment_order
    })
}

/**
 * Auto-suggest segments from timeline data.
 * Finds Personal → [business visits...] → Personal brackets.
 * Creates a single segment per bracket with intermediate business visits as stops.
 * - If business stops exist: from=personal, to=personal, stops=business locations, isDetour=true
 * - If no business stops: from=personal, to=personal, classification=personal (just a drive)
 */
export function suggestSegmentsFromTimeline(
  segs: TravelSegment[],
  locations: TravelLocation[],
): SegmentDraft[] {
  const visits = getHighConfidenceVisits(segs)
  if (visits.length < 2) return []

  const findLocId = (label: string) => locations.find((l) => l.label === label)?.id || ""

  const drafts: SegmentDraft[] = []
  let i = 0
  while (i < visits.length) {
    if (visits[i].classification !== "personal") { i++; continue }
    const startVisit = visits[i]

    const businessStops: TravelSegment[] = []
    let j = i + 1
    while (j < visits.length && visits[j].classification === "business") {
      businessStops.push(visits[j])
      j++
    }

    if (j >= visits.length || visits[j].classification !== "personal") { i++; continue }
    const endVisit = visits[j]

    const fromId = findLocId(startVisit.visit_location_label!)
    const toId = findLocId(endVisit.visit_location_label!)
    if (!fromId || !toId) { i = j; continue }

    if (businessStops.length === 0) {
      // Pure personal drive, no business stops
      drafts.push({ ...emptySegment(fromId), to_id: toId, classification: "personal", source: "suggested" })
    } else {
      // Business detour: personal endpoints with business stops in between
      const stopIds = businessStops
        .map((s) => findLocId(s.visit_location_label!))
        .filter((id) => id && id !== fromId && id !== toId)
      drafts.push({
        ...emptySegment(fromId),
        to_id: toId,
        classification: "business",
        isDetour: true,
        detourStopIds: stopIds,
        source: "suggested",
      })
    }
    i = j
  }
  return drafts
}

// ----- Auto-fill Detour Stops -----

/**
 * Find detour stop location IDs from timeline visits between from and to.
 * Searches backwards (latest matching pair) to avoid grabbing earlier brackets.
 */
export function findAutoFillStopIds(
  timelineSegments: TravelSegment[],
  fromLabel: string,
  toLabel: string,
  excludeIds: Set<string>,
  locations: TravelLocation[],
): string[] {
  const visits = getHighConfidenceVisits(timelineSegments)

  // Find the LATEST matching pair
  let toIdx = -1
  for (let i = visits.length - 1; i >= 0; i--) {
    if (visits[i].visit_location_label === toLabel) { toIdx = i; break }
  }
  if (toIdx < 0) return []

  let fromIdx = -1
  for (let i = toIdx - 1; i >= 0; i--) {
    if (visits[i].visit_location_label === fromLabel) { fromIdx = i; break }
  }
  if (fromIdx < 0 || toIdx <= fromIdx + 1) return []

  const between = visits.slice(fromIdx + 1, toIdx)
  const stopIds = between
    .map((v) => locations.find((l) => l.label === v.visit_location_label!)?.id)
    .filter((id): id is string => !!id && !excludeIds.has(id))
  return [...new Set(stopIds)]
}

// ----- Save Payload -----

export interface SaveSegmentPayload {
  from_location: string
  to_location: string
  distance_km: number
  classification: string
  route_coords?: [number, number][]
  is_detour?: boolean
  detour_stop_ids?: string[]
  direct_km?: number
  with_stops_km?: number
}

/** Build the API-ready segment payload from drafts */
export function buildSegmentPayload(
  segments: SegmentDraft[],
  locations: TravelLocation[],
): SaveSegmentPayload[] {
  return segments
    .filter((s) => s.from_id && s.to_id && parseFloat(s.distance_km) > 0)
    .map((s) => {
      const fromLoc = locations.find((l) => l.id === s.from_id)
      const toLoc = locations.find((l) => l.id === s.to_id)
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
}
