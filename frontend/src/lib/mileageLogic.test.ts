import { describe, expect, it } from "vitest"
import {
  haversineKm,
  optimalStopIndex,
  labelTimelineSegments,
  suggestSegmentsFromTimeline,
  findAutoFillStopIds,
  buildSegmentPayload,
  emptySegment,
  getHighConfidenceVisits,
} from "./mileageLogic"
import type { TravelSegment, TravelLocation } from "@/api"

// ----- Test Helpers -----

function makeVisit(overrides: Partial<TravelSegment> = {}): TravelSegment {
  return {
    id: "v1",
    upload_id: "u1",
    trip_date: "2025-11-19",
    segment_order: 0,
    segment_type: "visit",
    activity_id: null,
    distance_meters: null,
    visit_id: null,
    start_time: "2025-11-19T09:00:00Z",
    end_time: "2025-11-19T09:30:00Z",
    from_location: null,
    to_location: null,
    classification: "personal",
    classification_reason: null,
    is_detour: false,
    detour_extra_km: null,
    linked_receipt_id: null,
    notes: null,
    created_at: "",
    updated_at: "",
    visit_location_label: "Home",
    visit_location_chain: null,
    visit_duration_minutes: 30,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
    route_coords: null,
    detour_stop_ids: null,
    direct_km: null,
    with_stops_km: null,
    ...overrides,
  }
}

function makeDrive(overrides: Partial<TravelSegment> = {}): TravelSegment {
  return {
    ...makeVisit({ segment_type: "drive", visit_location_label: null, visit_duration_minutes: null }),
    ...overrides,
  }
}

function makeLoc(id: string, label: string, type = "personal"): TravelLocation {
  return {
    id, config_key: label.toLowerCase(), label, chain: null,
    address: "123 Main St", latitude: 43.65, longitude: -79.38,
    geocode_status: "ok", geocode_error: null, location_type: type,
    excluded: false, created_at: "", updated_at: "",
  }
}

// ----- haversineKm -----

describe("haversineKm", () => {
  it("returns 0 for same point", () => {
    expect(haversineKm(43.65, -79.38, 43.65, -79.38)).toBe(0)
  })

  it("calculates known distance Toronto→Ottawa (~350km)", () => {
    const km = haversineKm(43.65, -79.38, 45.42, -75.69)
    expect(km).toBeGreaterThan(340)
    expect(km).toBeLessThan(360)
  })

  it("is symmetric", () => {
    const ab = haversineKm(43.65, -79.38, 45.42, -75.69)
    const ba = haversineKm(45.42, -75.69, 43.65, -79.38)
    expect(ab).toBeCloseTo(ba, 10)
  })
})

// ----- optimalStopIndex -----

describe("optimalStopIndex", () => {
  const toronto = { latitude: 43.65, longitude: -79.38 }
  const ottawa = { latitude: 45.42, longitude: -75.69 }
  const kingston = { latitude: 44.23, longitude: -76.49 } // between Toronto and Ottawa

  it("inserts only stop at index 0", () => {
    expect(optimalStopIndex(toronto, ottawa, [], kingston)).toBe(0)
  })

  it("inserts stop at optimal position minimizing total distance", () => {
    const montreal = { latitude: 45.50, longitude: -73.57 }
    // Route: Toronto → Ottawa, existing stop: Montreal
    // Kingston should go before Montreal (it's between Toronto and Ottawa geographically)
    const idx = optimalStopIndex(toronto, ottawa, [montreal], kingston)
    expect(idx).toBe(0)
  })

  it("appends when stop is beyond endpoint", () => {
    const montreal = { latitude: 45.50, longitude: -73.57 }
    // Route: Toronto → Kingston, existing: none, insert Montreal (past Kingston toward Ottawa)
    const idx = optimalStopIndex(toronto, kingston, [], montreal)
    expect(idx).toBe(0) // Still index 0 since there are no existing stops
  })
})

// ----- getHighConfidenceVisits -----

describe("getHighConfidenceVisits", () => {
  it("filters to visits with non-unknown labels", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home" }),
      makeDrive({ id: "d1" }),
      makeVisit({ id: "v2", visit_location_label: "Costco" }),
      makeVisit({ id: "v3", visit_location_label: "Unknown (1)" }),
      makeVisit({ id: "v4", visit_location_label: null }),
    ]
    const result = getHighConfidenceVisits(segs)
    expect(result).toHaveLength(2)
    expect(result[0].visit_location_label).toBe("Home")
    expect(result[1].visit_location_label).toBe("Costco")
  })

  it("returns empty for no visits", () => {
    expect(getHighConfidenceVisits([])).toHaveLength(0)
  })
})

// ----- labelTimelineSegments -----

describe("labelTimelineSegments", () => {
  it("labels visits by their visit_location_label", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home" }),
      makeVisit({ id: "v2", visit_location_label: "Costco" }),
    ]
    const labels = labelTimelineSegments(segs)
    expect(labels.get("v1")).toBe("Home")
    expect(labels.get("v2")).toBe("Costco")
  })

  it("numbers unknown locations sequentially", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: null, from_location: null }),
      makeVisit({ id: "v2", visit_location_label: null, from_location: null }),
    ]
    const labels = labelTimelineSegments(segs)
    expect(labels.get("v1")).toBe("Unknown (1)")
    expect(labels.get("v2")).toBe("Unknown (2)")
  })

  it("infers drive from/to labels from adjacent visits", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home" }),
      makeDrive({ id: "d1", from_location: null, to_location: null }),
      makeVisit({ id: "v2", visit_location_label: "Costco" }),
    ]
    const labels = labelTimelineSegments(segs)
    expect(labels.get("d1")).toBe("Home")
    expect(labels.get("d1_to")).toBe("Costco")
  })

  it("uses from_location for drives when available", () => {
    const segs = [
      makeDrive({ id: "d1", from_location: "Office", to_location: "Store" }),
    ]
    const labels = labelTimelineSegments(segs)
    expect(labels.get("d1")).toBe("Office")
    expect(labels.get("d1_to")).toBe("Store")
  })
})

// ----- suggestSegmentsFromTimeline -----

describe("suggestSegmentsFromTimeline", () => {
  const home = makeLoc("loc-home", "Home", "personal")
  const costco = makeLoc("loc-costco", "Costco", "business")
  const walmart = makeLoc("loc-walmart", "Walmart", "business")
  const gym = makeLoc("loc-gym", "Gym", "personal")
  const locations = [home, costco, walmart, gym]

  it("returns empty for fewer than 2 visits", () => {
    const segs = [makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" })]
    expect(suggestSegmentsFromTimeline(segs, locations)).toHaveLength(0)
  })

  it("creates Personal→Personal segment when no business stops", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Gym", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    expect(result).toHaveLength(1)
    expect(result[0].from_id).toBe("loc-home")
    expect(result[0].to_id).toBe("loc-gym")
    expect(result[0].classification).toBe("personal")
  })

  it("creates single detour segment for Personal→Business→Personal", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    expect(result).toHaveLength(1)
    expect(result[0].from_id).toBe("loc-home")
    expect(result[0].to_id).toBe("loc-home")
    expect(result[0].classification).toBe("business")
    expect(result[0].isDetour).toBe(true)
    expect(result[0].detourStopIds).toEqual(["loc-costco"])
  })

  it("creates single detour segment with multiple stops for Personal→Business₁→Business₂→Personal", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Walmart", classification: "business" }),
      makeVisit({ id: "v4", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ from_id: "loc-home", to_id: "loc-home", classification: "business", isDetour: true })
    expect(result[0].detourStopIds).toEqual(["loc-costco", "loc-walmart"])
  })

  it("handles multiple brackets", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v4", visit_location_label: "Walmart", classification: "business" }),
      makeVisit({ id: "v5", visit_location_label: "Gym", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    // First bracket: Home→Home with Costco stop (detour)
    // Second bracket: Home→Gym with Walmart stop (detour)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ from_id: "loc-home", to_id: "loc-home", isDetour: true })
    expect(result[0].detourStopIds).toEqual(["loc-costco"])
    expect(result[1]).toMatchObject({ from_id: "loc-home", to_id: "loc-gym", isDetour: true })
    expect(result[1].detourStopIds).toEqual(["loc-walmart"])
  })

  it("skips unknown/unmatched visits", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Unknown (1)", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    // Unknown is filtered out, so Home→Home with no business = personal
    expect(result).toHaveLength(1)
    expect(result[0].classification).toBe("personal")
  })

  it("skips when no closing personal visit", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    expect(result).toHaveLength(0)
  })

  it("sets source to suggested", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = suggestSegmentsFromTimeline(segs, locations)
    expect(result[0].source).toBe("suggested")
  })
})

// ----- findAutoFillStopIds -----

describe("findAutoFillStopIds", () => {
  const home = makeLoc("loc-home", "Home")
  const costco = makeLoc("loc-costco", "Costco")
  const walmart = makeLoc("loc-walmart", "Walmart")
  const gym = makeLoc("loc-gym", "Gym")
  const locations = [home, costco, walmart, gym]

  it("finds stops between latest matching from/to pair", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Home", classification: "personal" }),
      // Second bracket
      makeVisit({ id: "v4", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v5", visit_location_label: "Walmart", classification: "business" }),
      makeVisit({ id: "v6", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = findAutoFillStopIds(segs, "Home", "Home", new Set(["loc-home"]), locations)
    // Should match the LATEST Home→Home pair (v4→v6) with Walmart between
    expect(result).toEqual(["loc-walmart"])
  })

  it("returns empty when no matching pair", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
    ]
    const result = findAutoFillStopIds(segs, "Home", "Gym", new Set(), locations)
    expect(result).toEqual([])
  })

  it("returns empty when no visits between pair", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Gym", classification: "personal" }),
    ]
    const result = findAutoFillStopIds(segs, "Home", "Gym", new Set(), locations)
    expect(result).toEqual([])
  })

  it("excludes specified IDs", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Walmart", classification: "business" }),
      makeVisit({ id: "v4", visit_location_label: "Gym", classification: "personal" }),
    ]
    const result = findAutoFillStopIds(segs, "Home", "Gym", new Set(["loc-home", "loc-gym", "loc-costco"]), locations)
    expect(result).toEqual(["loc-walmart"])
  })

  it("deduplicates stop IDs", () => {
    const segs = [
      makeVisit({ id: "v1", visit_location_label: "Home", classification: "personal" }),
      makeVisit({ id: "v2", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v3", visit_location_label: "Costco", classification: "business" }),
      makeVisit({ id: "v4", visit_location_label: "Home", classification: "personal" }),
    ]
    const result = findAutoFillStopIds(segs, "Home", "Home", new Set(["loc-home"]), locations)
    expect(result).toEqual(["loc-costco"])
  })
})

// ----- buildSegmentPayload -----

describe("buildSegmentPayload", () => {
  const home = makeLoc("loc-home", "Home")
  const costco = makeLoc("loc-costco", "Costco")
  const locations = [home, costco]

  it("builds payload from valid segments", () => {
    const segments = [
      { ...emptySegment("loc-home"), to_id: "loc-costco", distance_km: "15.3", classification: "business" },
    ]
    const result = buildSegmentPayload(segments, locations)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      from_location: "Home",
      to_location: "Costco",
      distance_km: 15.3,
      classification: "business",
      route_coords: undefined,
      is_detour: undefined,
      detour_stop_ids: undefined,
      direct_km: undefined,
      with_stops_km: undefined,
    })
  })

  it("filters out incomplete segments", () => {
    const segments = [
      emptySegment(), // no from_id, to_id, or distance
      { ...emptySegment("loc-home"), to_id: "loc-costco", distance_km: "0" }, // distance 0
      { ...emptySegment("loc-home"), to_id: "loc-costco", distance_km: "5" }, // valid
    ]
    const result = buildSegmentPayload(segments, locations)
    expect(result).toHaveLength(1)
  })

  it("includes detour fields when present", () => {
    const segments = [{
      ...emptySegment("loc-home"),
      to_id: "loc-costco",
      distance_km: "3.2",
      classification: "business",
      isDetour: true,
      detourStopIds: ["loc-walmart"],
      directKm: "10",
      withStopsKm: "13.2",
    }]
    const result = buildSegmentPayload(segments, locations)
    expect(result[0].is_detour).toBe(true)
    expect(result[0].detour_stop_ids).toEqual(["loc-walmart"])
    expect(result[0].direct_km).toBe(10)
    expect(result[0].with_stops_km).toBe(13.2)
  })

  it("includes route_coords when present", () => {
    const segments = [{
      ...emptySegment("loc-home"),
      to_id: "loc-costco",
      distance_km: "15",
      routeCoords: [[43.65, -79.38], [43.70, -79.40]] as [number, number][],
    }]
    const result = buildSegmentPayload(segments, locations)
    expect(result[0].route_coords).toEqual([[43.65, -79.38], [43.70, -79.40]])
  })
})

// ----- emptySegment -----

describe("emptySegment", () => {
  it("creates with defaults", () => {
    const seg = emptySegment()
    expect(seg.from_id).toBe("")
    expect(seg.to_id).toBe("")
    expect(seg.classification).toBe("business")
    expect(seg.source).toBe("manual")
    expect(seg.isDetour).toBe(false)
    expect(seg.detourStopIds).toEqual([])
  })

  it("sets from_id when provided", () => {
    const seg = emptySegment("loc-home")
    expect(seg.from_id).toBe("loc-home")
  })
})
