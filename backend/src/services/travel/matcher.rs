use crate::db::models::TravelLocation;

/// Haversine distance in meters between two lat/lng points.
pub fn haversine_meters(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    const R: f64 = 6_371_000.0; // Earth radius in meters
    let d_lat = (lat2 - lat1).to_radians();
    let d_lng = (lng2 - lng1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lng / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    R * c
}

pub struct MatchResult {
    pub location_id: uuid::Uuid,
    pub label: String,
    pub chain: Option<String>,
    pub distance_meters: f64,
    pub location_type: String,
}

/// Match a visit's lat/lng against known locations.
/// Returns the closest match within `radius_meters`, or None.
pub fn match_location(
    visit_lat: f64,
    visit_lng: f64,
    locations: &[TravelLocation],
    radius_meters: f64,
) -> Option<MatchResult> {
    let mut best: Option<MatchResult> = None;
    let mut best_dist = f64::MAX;

    for loc in locations {
        if loc.excluded {
            continue;
        }
        let (lat, lng) = match (loc.latitude, loc.longitude) {
            (Some(lat), Some(lng)) => (lat, lng),
            _ => continue, // Not geocoded yet
        };

        let dist = haversine_meters(visit_lat, visit_lng, lat, lng);
        if dist <= radius_meters && dist < best_dist {
            best_dist = dist;
            best = Some(MatchResult {
                location_id: loc.id,
                label: loc.label.clone(),
                chain: loc.chain.clone(),
                distance_meters: dist,
                location_type: loc.location_type.clone(),
            });
        }
    }

    best
}

/// Estimate direct-route distance between two points.
/// Uses haversine * 1.3 road factor as a rough approximation.
pub fn estimated_road_distance_meters(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    haversine_meters(lat1, lng1, lat2, lng2) * 1.3
}
