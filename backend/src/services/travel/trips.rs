use chrono::NaiveDate;
use chrono_tz::America::Toronto;
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::db::models::{TravelActivity, TravelLocation, TravelVisit};

use super::matcher;

#[derive(Debug, Clone)]
pub struct SegmentDraft {
    pub trip_date: NaiveDate,
    pub segment_order: i32,
    pub segment_type: String, // "drive" | "visit"
    pub activity_id: Option<Uuid>,
    pub distance_meters: Option<f64>,
    pub visit_id: Option<Uuid>,
    pub start_time: chrono::DateTime<chrono::Utc>,
    pub end_time: chrono::DateTime<chrono::Utc>,
    pub from_location: Option<String>,
    pub to_location: Option<String>,
    pub classification: String,
    pub classification_reason: Option<String>,
    pub is_detour: bool,
    pub detour_extra_km: Option<f64>,
}

/// Intermediate event for chronological sorting
#[derive(Debug, Clone)]
enum TripEvent {
    Visit {
        visit: TravelVisit,
        matched_label: Option<String>,
        matched_type: Option<String>,
    },
    Drive {
        activity: TravelActivity,
    },
}

impl TripEvent {
    fn start_time(&self) -> chrono::DateTime<chrono::Utc> {
        match self {
            TripEvent::Visit { visit, .. } => visit.start_time,
            TripEvent::Drive { activity } => activity.start_time,
        }
    }
}

/// Effective type for classification: business or personal.
/// Unknowns/unmatched are treated as personal per CRA guidelines.
fn effective_type(matched_type: Option<&str>) -> &str {
    match matched_type {
        Some("business") | Some("store") => "business",
        _ => "personal", // personal, unknown, unmatched → all personal
    }
}

/// Build trip segments from parsed visits and activities.
/// Groups events by date, sorts chronologically, then runs detour analysis.
pub fn build_segments(
    visits: &[TravelVisit],
    activities: &[TravelActivity],
    locations: &[TravelLocation],
) -> Vec<SegmentDraft> {
    let loc_map: std::collections::HashMap<Uuid, &TravelLocation> =
        locations.iter().map(|l| (l.id, l)).collect();

    let mut events: Vec<TripEvent> = Vec::new();

    for visit in visits {
        let (matched_label, matched_type) = visit
            .matched_location_id
            .and_then(|id| loc_map.get(&id))
            .map(|l| (Some(l.label.clone()), Some(l.location_type.clone())))
            .unwrap_or((None, None));

        let label = matched_label.or_else(|| {
            visit.semantic_type.as_ref().and_then(|st| match st.as_str() {
                "HOME" => Some("Home".to_string()),
                "WORK" | "INFERRED_WORK" => Some("Work".to_string()),
                _ => None,
            })
        });

        events.push(TripEvent::Visit {
            visit: visit.clone(),
            matched_label: label,
            matched_type: matched_type.or_else(|| {
                visit.semantic_type.as_ref().and_then(|st| match st.as_str() {
                    "HOME" | "WORK" | "INFERRED_WORK" => Some("personal".to_string()),
                    _ => None,
                })
            }),
        });
    }

    for activity in activities {
        events.push(TripEvent::Drive {
            activity: activity.clone(),
        });
    }

    // Group by local date (America/Toronto) — UTC date_naive() misgroups
    // evening events that are still the previous local day
    let mut by_date: BTreeMap<NaiveDate, Vec<TripEvent>> = BTreeMap::new();
    for event in events {
        let date = event.start_time().with_timezone(&Toronto).date_naive();
        by_date.entry(date).or_default().push(event);
    }

    let mut all_segments = Vec::new();

    for (date, mut day_events) in by_date {
        day_events.sort_by_key(|e| e.start_time());

        // Pass 1: Build raw segments
        let mut day_segments = build_day_segments(date, &day_events);

        // Pass 2: Detour analysis — identifies business detour stretches
        apply_detour_classification(&day_events, &mut day_segments);

        all_segments.append(&mut day_segments);
    }

    all_segments
}

/// Pass 1: Build raw segments for a day. Visits get classified by type.
/// Drives are initially "personal" — detour pass will reclassify.
fn build_day_segments(date: NaiveDate, events: &[TripEvent]) -> Vec<SegmentDraft> {
    let mut segments = Vec::new();
    let mut order = 0;

    for (i, event) in events.iter().enumerate() {
        match event {
            TripEvent::Visit {
                visit,
                matched_label,
                matched_type,
            } => {
                let label = matched_label
                    .clone()
                    .unwrap_or_else(|| format!("Unknown ({})", visit.semantic_type.as_deref().unwrap_or("?")));

                let etype = effective_type(matched_type.as_deref());
                let classification = if etype == "business" { "business" } else { "personal" };

                segments.push(SegmentDraft {
                    trip_date: date,
                    segment_order: order,
                    segment_type: "visit".to_string(),
                    activity_id: None,
                    distance_meters: None,
                    visit_id: Some(visit.id),
                    start_time: visit.start_time,
                    end_time: visit.end_time,
                    from_location: Some(label.clone()),
                    to_location: Some(label),
                    classification: classification.to_string(),
                    classification_reason: Some("auto".to_string()),
                    is_detour: false,
                    detour_extra_km: None,
                });
                order += 1;
            }
            TripEvent::Drive { activity } => {
                let prev_visit = find_prev_visit(events, i);
                let next_visit = find_next_visit(events, i);

                let from_label = prev_visit
                    .as_ref()
                    .map(|(_, l, _)| l.clone().unwrap_or_else(|| "Unknown".to_string()));
                let to_label = next_visit
                    .as_ref()
                    .map(|(_, l, _)| l.clone().unwrap_or_else(|| "Unknown".to_string()));

                // Default: personal. Detour pass reclassifies to business if needed.
                segments.push(SegmentDraft {
                    trip_date: date,
                    segment_order: order,
                    segment_type: "drive".to_string(),
                    activity_id: Some(activity.id),
                    distance_meters: Some(activity.distance_meters),
                    visit_id: None,
                    start_time: activity.start_time,
                    end_time: activity.end_time,
                    from_location: from_label,
                    to_location: to_label,
                    classification: "personal".to_string(),
                    classification_reason: Some("auto:personal".to_string()),
                    is_detour: false,
                    detour_extra_km: None,
                });
                order += 1;
            }
        }
    }

    segments
}

/// Pass 2: Find detour stretches and reclassify drives.
///
/// A "detour" occurs when business visits appear between two personal visits.
/// Example: Home → Store1 → Store2 → Work
///   - Home and Work are personal endpoints
///   - The stretch Home→Store1→Store2→Work is a detour
///   - All drives in the stretch are classified "business"
///   - detour_extra_km = total_drive_distance − estimated_direct(Home, Work)
///
/// Multiple detour stretches can occur in one day.
fn apply_detour_classification(events: &[TripEvent], segments: &mut [SegmentDraft]) {
    // Collect personal visit indices (in the events array) and their coords
    let personal_visits: Vec<(usize, &TravelVisit)> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            if let TripEvent::Visit { visit, matched_type, .. } = e {
                if effective_type(matched_type.as_deref()) == "personal" {
                    return Some((i, visit));
                }
            }
            None
        })
        .collect();

    if personal_visits.len() < 2 {
        // Can't identify detour stretches without at least 2 personal endpoints.
        // If there's a business visit somewhere, mark adjacent drives as business.
        mark_business_adjacent_drives(events, segments);
        return;
    }

    // Walk consecutive pairs of personal visits
    for window in personal_visits.windows(2) {
        let (start_idx, start_visit) = window[0];
        let (end_idx, end_visit) = window[1];

        // Check if there are any business visits between these two personal visits
        let has_business_between = events[start_idx + 1..end_idx].iter().any(|e| {
            if let TripEvent::Visit { matched_type, .. } = e {
                effective_type(matched_type.as_deref()) == "business"
            } else {
                false
            }
        });

        if !has_business_between {
            continue; // No detour — drives stay personal
        }

        // This stretch is a detour. Find the corresponding drive segments.
        // Drive segments between the two personal visit segments need reclassification.
        let start_time = start_visit.end_time; // drives start after the visit ends
        let end_time = end_visit.start_time;   // drives end before the next visit starts

        // Sum up actual drive distances in this stretch
        let mut stretch_drive_distance = 0.0;
        let mut stretch_drive_indices: Vec<usize> = Vec::new();

        for (si, seg) in segments.iter().enumerate() {
            if seg.segment_type == "drive"
                && seg.start_time >= start_time
                && seg.end_time <= end_time
            {
                stretch_drive_distance += seg.distance_meters.unwrap_or(0.0);
                stretch_drive_indices.push(si);
            }
        }

        if stretch_drive_indices.is_empty() {
            continue;
        }

        // Compute direct road distance between the two personal endpoints
        let direct_distance = matcher::estimated_road_distance_meters(
            start_visit.latitude,
            start_visit.longitude,
            end_visit.latitude,
            end_visit.longitude,
        );

        let detour_km = {
            let extra = stretch_drive_distance - direct_distance;
            if extra > 0.0 { extra / 1000.0 } else { 0.0 }
        };

        // Reclassify all drives in the stretch as business detours
        for &si in &stretch_drive_indices {
            segments[si].classification = "business".to_string();
            segments[si].classification_reason = Some("auto:detour".to_string());
            segments[si].is_detour = true;
        }

        // Store the total detour km on the first drive of the stretch
        if let Some(&first_si) = stretch_drive_indices.first() {
            segments[first_si].detour_extra_km = Some(detour_km);
        }
    }
}

/// Fallback for days with fewer than 2 personal visits:
/// If a drive is adjacent to a business visit, mark it as business.
fn mark_business_adjacent_drives(events: &[TripEvent], segments: &mut [SegmentDraft]) {
    for (i, event) in events.iter().enumerate() {
        if let TripEvent::Drive { activity } = event {
            let prev_type = find_prev_visit(events, i)
                .map(|(_, _, t)| effective_type(t.as_deref()).to_string());
            let next_type = find_next_visit(events, i)
                .map(|(_, _, t)| effective_type(t.as_deref()).to_string());

            let involves_business = prev_type.as_deref() == Some("business")
                || next_type.as_deref() == Some("business");

            if involves_business {
                // Find the matching segment by activity_id
                if let Some(seg) = segments.iter_mut().find(|s| s.activity_id == Some(activity.id)) {
                    seg.classification = "business".to_string();
                    seg.classification_reason = Some("auto:business".to_string());
                    seg.detour_extra_km = Some(activity.distance_meters / 1000.0);
                }
            }
        }
    }
}

fn find_prev_visit(
    events: &[TripEvent],
    current: usize,
) -> Option<(TravelVisit, Option<String>, Option<String>)> {
    for i in (0..current).rev() {
        if let TripEvent::Visit {
            visit,
            matched_label,
            matched_type,
        } = &events[i]
        {
            return Some((visit.clone(), matched_label.clone(), matched_type.clone()));
        }
    }
    None
}

fn find_next_visit(
    events: &[TripEvent],
    current: usize,
) -> Option<(TravelVisit, Option<String>, Option<String>)> {
    for i in (current + 1)..events.len() {
        if let TripEvent::Visit {
            visit,
            matched_label,
            matched_type,
        } = &events[i]
        {
            return Some((visit.clone(), matched_label.clone(), matched_type.clone()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use uuid::Uuid;

    // Helper to create a visit at a given lat/lng with a type
    fn make_visit(
        lat: f64,
        lng: f64,
        semantic_type: Option<&str>,
        matched_location_id: Option<Uuid>,
        hour: u32,
        duration_min: u32,
    ) -> TravelVisit {
        let start = Utc.with_ymd_and_hms(2025, 11, 19, hour, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2025, 11, 19, hour, duration_min, 0).unwrap();
        TravelVisit {
            id: Uuid::new_v4(),
            upload_id: Uuid::nil(),
            place_id: None,
            semantic_type: semantic_type.map(|s| s.to_string()),
            latitude: lat,
            longitude: lng,
            start_time: start,
            end_time: end,
            duration_minutes: duration_min as i32,
            matched_location_id,
            match_distance_meters: None,
            hierarchy_level: 0,
            probability: None,
            created_at: start,
        }
    }

    fn make_activity(distance_meters: f64, hour: u32, duration_min: u32) -> TravelActivity {
        let start = Utc.with_ymd_and_hms(2025, 11, 19, hour, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2025, 11, 19, hour, duration_min, 0).unwrap();
        TravelActivity {
            id: Uuid::new_v4(),
            upload_id: Uuid::nil(),
            activity_type: "IN_PASSENGER_VEHICLE".to_string(),
            start_lat: 0.0,
            start_lng: 0.0,
            end_lat: 0.0,
            end_lng: 0.0,
            distance_meters,
            start_time: start,
            end_time: end,
            probability: None,
            created_at: start,
        }
    }

    fn make_location(id: Uuid, loc_type: &str) -> TravelLocation {
        TravelLocation {
            id,
            config_key: format!("loc_{}", id),
            label: format!("Location_{}", &id.to_string()[..8]),
            chain: None,
            address: "123 Test St".to_string(),
            latitude: Some(43.7),
            longitude: Some(-79.4),
            geocode_status: "resolved".to_string(),
            geocode_error: None,
            location_type: loc_type.to_string(),
            excluded: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// Home → Work (no business stops) → all drives personal
    #[test]
    fn personal_only_no_detour() {
        // Home (43.7, -79.4) → Work (43.65, -79.38)
        let home = make_visit(43.7, -79.4, Some("HOME"), None, 8, 30);
        let drive = make_activity(15000.0, 9, 30); // 15km
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 10, 0);

        let segments = build_segments(&[home, work], &[drive], &[]);
        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();

        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].classification, "personal");
        assert!(!drives[0].is_detour);
        assert!(drives[0].detour_extra_km.is_none());
    }

    /// Home → Store → Work → detour detected
    #[test]
    fn single_store_detour() {
        let store_id = Uuid::new_v4();
        let store_loc = make_location(store_id, "business");

        // Home(43.7,-79.4) --drive1(20km)--> Store(43.75,-79.35) --drive2(25km)--> Work(43.65,-79.38)
        let home = make_visit(43.7, -79.4, Some("HOME"), None, 8, 30);
        let drive1 = make_activity(20000.0, 9, 30);
        let store = make_visit(43.75, -79.35, None, Some(store_id), 10, 15);
        let drive2 = make_activity(25000.0, 11, 30);
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 12, 0);

        let segments = build_segments(
            &[home, store, work],
            &[drive1, drive2],
            &[store_loc],
        );

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives.len(), 2);

        // Both drives should be business (part of detour)
        assert_eq!(drives[0].classification, "business");
        assert_eq!(drives[1].classification, "business");
        assert!(drives[0].is_detour);
        assert!(drives[1].is_detour);

        // Detour km = (20 + 25) - direct(Home, Work) estimated road distance
        // direct ≈ haversine(43.7,-79.4, 43.65,-79.38) * 1.3
        let detour_km = drives[0].detour_extra_km.unwrap();
        assert!(detour_km > 0.0, "Detour should be positive, got {}", detour_km);
        // Total actual = 45km, direct Home→Work ~ 5.8km * 1.3 ≈ 7.5km, detour ≈ 37.5km
        assert!(detour_km > 30.0, "Detour should be > 30km for a 45km trip vs ~7.5km direct, got {}", detour_km);
    }

    /// Home → Store1 → Store2 → Work → single detour stretch
    #[test]
    fn multiple_stores_single_stretch() {
        let s1_id = Uuid::new_v4();
        let s2_id = Uuid::new_v4();
        let s1_loc = make_location(s1_id, "business");
        let s2_loc = make_location(s2_id, "business");

        let home = make_visit(43.7, -79.4, Some("HOME"), None, 8, 30);
        let d1 = make_activity(10000.0, 9, 15);   // Home → Store1
        let store1 = make_visit(43.72, -79.38, None, Some(s1_id), 10, 10);
        let d2 = make_activity(8000.0, 10, 15);    // Store1 → Store2
        let store2 = make_visit(43.74, -79.36, None, Some(s2_id), 11, 10);
        let d3 = make_activity(12000.0, 11, 20);   // Store2 → Work
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 12, 0);

        let segments = build_segments(
            &[home, store1, store2, work],
            &[d1, d2, d3],
            &[s1_loc, s2_loc],
        );

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives.len(), 3);

        // All three drives are part of the same detour stretch
        for d in &drives {
            assert_eq!(d.classification, "business", "Drive {} should be business", d.from_location.as_deref().unwrap_or("?"));
            assert!(d.is_detour);
        }

        // Detour km on first drive only
        assert!(drives[0].detour_extra_km.is_some());
        assert!(drives[0].detour_extra_km.unwrap() > 0.0);
    }

    /// Home → Store → Home → Store2 → Work → two separate detour stretches
    #[test]
    fn two_separate_detours_in_one_day() {
        let s1_id = Uuid::new_v4();
        let s2_id = Uuid::new_v4();
        let s1_loc = make_location(s1_id, "business");
        let s2_loc = make_location(s2_id, "business");

        // Morning: Home→Store→Home (detour from Home to Home through Store)
        let home1 = make_visit(43.7, -79.4, Some("HOME"), None, 7, 30);
        let d1 = make_activity(10000.0, 8, 15);
        let store1 = make_visit(43.72, -79.38, None, Some(s1_id), 9, 10);
        let d2 = make_activity(10000.0, 9, 15);
        let home2 = make_visit(43.7, -79.4, Some("HOME"), None, 10, 30);

        // Afternoon: Home→Store2→Work
        let d3 = make_activity(15000.0, 11, 20);
        let store2 = make_visit(43.74, -79.36, None, Some(s2_id), 12, 10);
        let d4 = make_activity(20000.0, 12, 25);
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 13, 0);

        let segments = build_segments(
            &[home1, store1, home2, store2, work],
            &[d1, d2, d3, d4],
            &[s1_loc, s2_loc],
        );

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives.len(), 4);

        // All 4 drives should be business (2 stretches, each containing business visits)
        for d in &drives {
            assert_eq!(d.classification, "business");
            assert!(d.is_detour);
        }
    }

    /// Home → Work → Home → all personal, no business stops
    #[test]
    fn home_work_home_no_business() {
        let home1 = make_visit(43.7, -79.4, Some("HOME"), None, 8, 30);
        let d1 = make_activity(15000.0, 9, 30);
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 10, 0);
        let d2 = make_activity(15000.0, 17, 30);
        let home2 = make_visit(43.7, -79.4, Some("HOME"), None, 18, 0);

        let segments = build_segments(&[home1, work, home2], &[d1, d2], &[]);

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives.len(), 2);

        for d in &drives {
            assert_eq!(d.classification, "personal");
            assert!(!d.is_detour);
        }
    }

    /// Unknown visits treated as personal
    #[test]
    fn unknown_visits_are_personal() {
        let store_id = Uuid::new_v4();
        let store_loc = make_location(store_id, "business");

        // Unknown → Store → Unknown: both unknowns are personal → detour
        let unk1 = make_visit(43.7, -79.4, None, None, 8, 30);
        let d1 = make_activity(10000.0, 9, 15);
        let store = make_visit(43.72, -79.38, None, Some(store_id), 10, 10);
        let d2 = make_activity(10000.0, 10, 15);
        let unk2 = make_visit(43.65, -79.38, None, None, 11, 0);

        let segments = build_segments(
            &[unk1, store, unk2],
            &[d1, d2],
            &[store_loc],
        );

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives.len(), 2);
        for d in &drives {
            assert_eq!(d.classification, "business");
            assert!(d.is_detour);
        }

        // Unknown visits classified as personal
        let visit_segs: Vec<_> = segments.iter().filter(|s| s.segment_type == "visit").collect();
        let unk_visits: Vec<_> = visit_segs.iter().filter(|v| v.classification == "personal").collect();
        assert!(unk_visits.len() >= 2, "Unknown visits should be classified personal");
    }

    /// Day with only business visits (no personal anchor) → drives are business via fallback
    #[test]
    fn only_business_visits_fallback() {
        let s1_id = Uuid::new_v4();
        let s1_loc = make_location(s1_id, "business");

        let store = make_visit(43.72, -79.38, None, Some(s1_id), 10, 10);
        let drive = make_activity(5000.0, 11, 15);
        // No personal visits at all (unusual but possible — e.g. timeline starts mid-day)

        let segments = build_segments(&[store], &[drive], &[s1_loc]);
        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();

        // With < 2 personal visits, fallback marks drives adjacent to business as business
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].classification, "business");
    }

    /// Detour km should be 0 when the store is on the way (actual ≤ direct)
    #[test]
    fn store_on_the_way_detour_is_zero() {
        let store_id = Uuid::new_v4();
        let store_loc = make_location(store_id, "business");

        // Home(43.7,-79.4) → Store(43.675,-79.39) → Work(43.65,-79.38)
        // Store is directly between Home and Work, so actual ≈ direct
        let home = make_visit(43.7, -79.4, Some("HOME"), None, 8, 30);
        let d1 = make_activity(3500.0, 9, 10); // ~3.5km
        let store = make_visit(43.675, -79.39, None, Some(store_id), 9, 5);
        let d2 = make_activity(3500.0, 10, 10); // ~3.5km
        let work = make_visit(43.65, -79.38, Some("WORK"), None, 10, 0);

        let segments = build_segments(
            &[home, store, work],
            &[d1, d2],
            &[store_loc],
        );

        let drives: Vec<_> = segments.iter().filter(|s| s.segment_type == "drive").collect();
        assert_eq!(drives[0].classification, "business");
        assert!(drives[0].is_detour);

        // The detour_extra_km should be 0 or very small since store is on the way
        let detour = drives[0].detour_extra_km.unwrap();
        assert!(detour < 1.0, "Store on the way should have near-zero detour, got {}", detour);
    }
}
