use chrono::{DateTime, FixedOffset, Utc};
use serde::Deserialize;

/// Raw Google Timeline export structure
#[derive(Debug, Deserialize)]
pub struct TimelineExport {
    #[serde(rename = "semanticSegments")]
    pub semantic_segments: Vec<SemanticSegment>,
}

#[derive(Debug, Deserialize)]
pub struct SemanticSegment {
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: String,
    pub visit: Option<VisitData>,
    pub activity: Option<ActivityData>,
    #[serde(rename = "timelinePath")]
    pub timeline_path: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
pub struct VisitData {
    #[serde(rename = "hierarchyLevel", default)]
    pub hierarchy_level: i32,
    pub probability: Option<f64>,
    #[serde(rename = "topCandidate")]
    pub top_candidate: Option<VisitCandidate>,
}

#[derive(Debug, Deserialize)]
pub struct VisitCandidate {
    #[serde(rename = "placeId")]
    pub place_id: Option<String>,
    #[serde(rename = "semanticType")]
    pub semantic_type: Option<String>,
    pub probability: Option<f64>,
    #[serde(rename = "placeLocation")]
    pub place_location: Option<PlaceLocation>,
}

#[derive(Debug, Deserialize)]
pub struct PlaceLocation {
    #[serde(rename = "latLng")]
    pub lat_lng: String,
}

#[derive(Debug, Deserialize)]
pub struct ActivityData {
    pub start: Option<LatLngPoint>,
    pub end: Option<LatLngPoint>,
    #[serde(rename = "distanceMeters")]
    pub distance_meters: Option<f64>,
    pub probability: Option<f64>,
    #[serde(rename = "topCandidate")]
    pub top_candidate: Option<ActivityCandidate>,
}

#[derive(Debug, Deserialize)]
pub struct LatLngPoint {
    #[serde(rename = "latLng")]
    pub lat_lng: String,
}

#[derive(Debug, Deserialize)]
pub struct ActivityCandidate {
    #[serde(rename = "type")]
    pub activity_type: Option<String>,
    pub probability: Option<f64>,
}

/// Parsed visit ready for DB insertion
#[derive(Debug, Clone)]
pub struct ParsedVisit {
    pub place_id: Option<String>,
    pub semantic_type: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub duration_minutes: i32,
    pub hierarchy_level: i32,
    pub probability: Option<f64>,
}

/// Parsed activity ready for DB insertion
#[derive(Debug, Clone)]
pub struct ParsedActivity {
    pub activity_type: String,
    pub start_lat: f64,
    pub start_lng: f64,
    pub end_lat: f64,
    pub end_lng: f64,
    pub distance_meters: f64,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub probability: Option<f64>,
}

#[derive(Debug)]
pub struct ParseResult {
    pub visits: Vec<ParsedVisit>,
    pub activities: Vec<ParsedActivity>,
    pub date_range_start: Option<chrono::NaiveDate>,
    pub date_range_end: Option<chrono::NaiveDate>,
}

/// Parse a "45.0714509°, -64.4744732°" style lat/lng string
fn parse_lat_lng(s: &str) -> Option<(f64, f64)> {
    let cleaned = s.replace('°', "").replace('\u{00b0}', "");
    let parts: Vec<&str> = cleaned.split(',').collect();
    if parts.len() != 2 {
        return None;
    }
    let lat = parts[0].trim().parse::<f64>().ok()?;
    let lng_raw = parts[1].trim().parse::<f64>().ok()?;
    // Google exports longitude without sign for western hemisphere sometimes,
    // but the data we've seen has it positive for west. Keep as-is since
    // the matching will use the same coordinate system.
    Some((lat, lng_raw))
}

fn parse_timestamp(s: &str) -> Option<DateTime<Utc>> {
    // Format: "2025-10-18T05:00:00.000-04:00"
    DateTime::<FixedOffset>::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

const EXCLUDED_ACTIVITY_TYPES: &[&str] = &["WALKING", "CYCLING", "FLYING", "IN_FERRY", "IN_TRAIN", "IN_BUS"];

pub fn parse_timeline(data: &[u8]) -> Result<ParseResult, String> {
    let export: TimelineExport =
        serde_json::from_slice(data).map_err(|e| format!("Invalid Timeline JSON: {}", e))?;

    let mut visits: Vec<ParsedVisit> = Vec::new();
    let mut activities: Vec<ParsedActivity> = Vec::new();
    let mut all_dates = Vec::new();
    // Track seen visit start times for dedup (keep hierarchy_level 0)
    let mut seen_visit_starts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for segment in &export.semantic_segments {
        let start_time = match parse_timestamp(&segment.start_time) {
            Some(t) => t,
            None => continue,
        };
        let end_time = match parse_timestamp(&segment.end_time) {
            Some(t) => t,
            None => continue,
        };

        all_dates.push(start_time.date_naive());

        // Parse visits
        if let Some(ref visit) = segment.visit {
            if let Some(ref candidate) = visit.top_candidate {
                if let Some(ref loc) = candidate.place_location {
                    if let Some((lat, lng)) = parse_lat_lng(&loc.lat_lng) {
                        let duration = (end_time - start_time).num_minutes() as i32;
                        let key = segment.start_time.clone();
                        let idx = visits.len();

                        // Deduplicate: if we've seen this start_time, keep the one with hierarchy_level 0
                        if let Some(&prev_idx) = seen_visit_starts.get(&key) {
                            if visit.hierarchy_level == 0 && visits[prev_idx].hierarchy_level != 0 {
                                visits[prev_idx] = ParsedVisit {
                                    place_id: candidate.place_id.clone(),
                                    semantic_type: candidate.semantic_type.clone(),
                                    latitude: lat,
                                    longitude: lng,
                                    start_time,
                                    end_time,
                                    duration_minutes: duration,
                                    hierarchy_level: visit.hierarchy_level,
                                    probability: candidate.probability,
                                };
                            }
                            // Skip duplicate
                            continue;
                        }

                        seen_visit_starts.insert(key, idx);
                        visits.push(ParsedVisit {
                            place_id: candidate.place_id.clone(),
                            semantic_type: candidate.semantic_type.clone(),
                            latitude: lat,
                            longitude: lng,
                            start_time,
                            end_time,
                            duration_minutes: duration,
                            hierarchy_level: visit.hierarchy_level,
                            probability: candidate.probability,
                        });
                    }
                }
            }
        }

        // Parse activities (only driving/vehicle)
        if let Some(ref activity) = segment.activity {
            let activity_type = activity
                .top_candidate
                .as_ref()
                .and_then(|c| c.activity_type.as_deref())
                .unwrap_or("UNKNOWN");

            if EXCLUDED_ACTIVITY_TYPES.contains(&activity_type) {
                continue;
            }

            let start_coords = activity
                .start
                .as_ref()
                .and_then(|p| parse_lat_lng(&p.lat_lng));
            let end_coords = activity
                .end
                .as_ref()
                .and_then(|p| parse_lat_lng(&p.lat_lng));

            if let (Some((slat, slng)), Some((elat, elng))) = (start_coords, end_coords) {
                let distance = activity.distance_meters.unwrap_or(0.0);
                let prob = activity
                    .top_candidate
                    .as_ref()
                    .and_then(|c| c.probability);

                activities.push(ParsedActivity {
                    activity_type: activity_type.to_string(),
                    start_lat: slat,
                    start_lng: slng,
                    end_lat: elat,
                    end_lng: elng,
                    distance_meters: distance,
                    start_time,
                    end_time,
                    probability: prob,
                });
            }
        }

        // timelinePath entries are skipped — raw GPS, redundant with activities
    }

    let date_range_start = all_dates.iter().min().cloned();
    let date_range_end = all_dates.iter().max().cloned();

    Ok(ParseResult {
        visits,
        activities,
        date_range_start,
        date_range_end,
    })
}
