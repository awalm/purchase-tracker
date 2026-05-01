use serde::Deserialize;
use serde::Serialize;

const GOOGLE_GEOCODE_URL: &str = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL: &str = "https://maps.googleapis.com/maps/api/directions/json";
const NOMINATIM_URL: &str = "https://nominatim.openstreetmap.org/search";
const USER_AGENT: &str = "bg-tracker/1.0";

// --- Google Maps ---

#[derive(Debug, Deserialize)]
struct GoogleGeocodeResponse {
    status: String,
    results: Vec<GoogleGeocodeResult>,
}

#[derive(Debug, Deserialize)]
struct GoogleGeocodeResult {
    geometry: GoogleGeometry,
}

#[derive(Debug, Deserialize)]
struct GoogleGeometry {
    location: GoogleLatLng,
}

#[derive(Debug, Deserialize)]
struct GoogleLatLng {
    lat: f64,
    lng: f64,
}

// --- Nominatim ---

#[derive(Debug, Deserialize)]
struct NominatimResult {
    lat: String,
    lon: String,
}

pub struct GeocodeResult {
    pub latitude: f64,
    pub longitude: f64,
}

pub struct GeocodeBatchResult {
    pub provider: String,
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub details: Vec<GeocodeDetail>,
}

pub struct GeocodeDetail {
    pub address: String,
    pub status: String, // "ok" or "failed"
    pub error: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
}

/// Geocode using Google Maps Geocoding API.
async fn geocode_google(address: &str, api_key: &str) -> Result<GeocodeResult, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(GOOGLE_GEOCODE_URL)
        .query(&[
            ("address", address),
            ("key", api_key),
            ("region", "ca"),
        ])
        .send()
        .await
        .map_err(|e| format!("Google Maps request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Google Maps returned status {}", response.status()));
    }

    let body: GoogleGeocodeResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Maps response: {}", e))?;

    match body.status.as_str() {
        "OK" => {}
        "ZERO_RESULTS" => return Err("No geocoding results found".to_string()),
        other => return Err(format!("Google Maps API error: {}", other)),
    }

    let result = body.results.first().ok_or("No results in response")?;
    Ok(GeocodeResult {
        latitude: result.geometry.location.lat,
        longitude: result.geometry.location.lng,
    })
}

/// Geocode using Nominatim (OpenStreetMap) — fallback when no Google API key.
async fn geocode_nominatim(address: &str) -> Result<GeocodeResult, String> {
    let cleaned = clean_address_for_nominatim(address);
    let client = reqwest::Client::new();
    let response = client
        .get(NOMINATIM_URL)
        .query(&[
            ("q", cleaned.as_str()),
            ("format", "json"),
            ("limit", "1"),
            ("countrycodes", "ca"),
        ])
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Nominatim request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Nominatim returned status {}", response.status()));
    }

    let results: Vec<NominatimResult> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Nominatim response: {}", e))?;

    let result = results.first().ok_or_else(|| "No geocoding results found".to_string())?;

    let lat = result.lat.parse::<f64>().map_err(|e| format!("Invalid latitude: {}", e))?;
    let lng = result.lon.parse::<f64>().map_err(|e| format!("Invalid longitude: {}", e))?;

    Ok(GeocodeResult { latitude: lat, longitude: lng })
}

/// Geocode an address. Uses Google Maps if GOOGLE_MAPS_API_KEY is set, otherwise Nominatim.
pub async fn geocode_address(address: &str) -> Result<GeocodeResult, String> {
    if let Ok(api_key) = std::env::var("GOOGLE_MAPS_API_KEY") {
        if !api_key.is_empty() {
            return geocode_google(address, &api_key).await;
        }
    }
    geocode_nominatim(address).await
}

/// Geocode locations in the database.
/// If `location_ids` is Some, geocode those specific locations (any status).
/// If None, geocode all pending/failed locations.
pub async fn geocode_pending_locations(pool: &sqlx::PgPool, location_ids: Option<&[uuid::Uuid]>) -> Result<GeocodeBatchResult, String> {
    let using_google = std::env::var("GOOGLE_MAPS_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    let provider = if using_google { "Google Maps" } else { "Nominatim (OpenStreetMap)" }.to_string();

    let pending: Vec<(uuid::Uuid, String)> = if let Some(ids) = location_ids {
        sqlx::query_as(
            "SELECT id, address FROM travel_locations WHERE id = ANY($1)"
        )
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch locations: {}", e))?
    } else {
        sqlx::query_as(
            "SELECT id, address FROM travel_locations WHERE geocode_status IN ('pending', 'failed')"
        )
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch pending locations: {}", e))?
    };;

    let total = pending.len();
    let mut success_count = 0;
    let mut details = Vec::new();

    for (id, address) in &pending {
        match geocode_address(address).await {
            Ok(result) => {
                sqlx::query(
                    "UPDATE travel_locations SET latitude = $1, longitude = $2, geocode_status = 'resolved', geocode_error = NULL, updated_at = NOW() WHERE id = $3"
                )
                .bind(result.latitude)
                .bind(result.longitude)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to update location {}: {}", id, e))?;
                success_count += 1;
                details.push(GeocodeDetail {
                    address: address.clone(),
                    status: "ok".to_string(),
                    error: None,
                    lat: Some(result.latitude),
                    lng: Some(result.longitude),
                });
            }
            Err(err) => {
                sqlx::query(
                    "UPDATE travel_locations SET geocode_status = 'failed', geocode_error = $1, updated_at = NOW() WHERE id = $2"
                )
                .bind(&err)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to update location {}: {}", id, e))?;
                tracing::warn!("Geocode failed for '{}': {}", address, err);
                details.push(GeocodeDetail {
                    address: address.clone(),
                    status: "failed".to_string(),
                    error: Some(err),
                    lat: None,
                    lng: None,
                });
            }
        }

        // Rate limit: Nominatim needs 1 req/sec, Google allows much more
        if total > 1 {
            let delay = if using_google { 100 } else { 1100 };
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    }

    Ok(GeocodeBatchResult {
        provider,
        total,
        success: success_count,
        failed: total - success_count,
        details,
    })
}

/// Strip unit/suite numbers from a street address before Nominatim geocoding.
fn clean_address_for_nominatim(address: &str) -> String {
    // Split on comma to isolate street part from city/province/postal
    let parts: Vec<&str> = address.splitn(2, ',').collect();
    let mut street = parts[0].trim().to_string();
    let rest = if parts.len() > 1 { parts[1] } else { "" };

    // Remove "#N" or "#N" patterns anywhere in street
    if let Some(hash_pos) = street.find('#') {
        // Find end of the unit number (next space or end)
        let after = &street[hash_pos + 1..];
        let end = after.find(' ').unwrap_or(after.len());
        street = format!("{}{}", street[..hash_pos].trim_end(), &street[hash_pos + 1 + end..]);
    }

    // Remove trailing tokens that look like unit numbers: "G6", "Unit 5", etc.
    let words: Vec<&str> = street.split_whitespace().collect();
    if words.len() >= 2 {
        let last = *words.last().unwrap();
        let second_last = words[words.len() - 2];

        // "Unit X", "Suite X", "Ste X", "Apt X"
        let is_unit_prefix = matches!(
            second_last.to_lowercase().as_str(),
            "unit" | "suite" | "ste" | "apt"
        );
        if is_unit_prefix {
            street = words[..words.len() - 2].join(" ");
        } else if last.len() <= 3 && last.chars().next().map_or(false, |c| c.is_ascii_uppercase()) && last.chars().any(|c| c.is_ascii_digit()) {
            // Short alphanumeric like "G6", "B2"
            street = words[..words.len() - 1].join(" ");
        }
    }

    if rest.is_empty() {
        street
    } else {
        format!("{},{}", street, rest)
    }
}

// --- Google Directions API ---

#[derive(Debug, Deserialize)]
struct GoogleDirectionsResponse {
    status: String,
    #[serde(default)]
    routes: Vec<GoogleRoute>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleRoute {
    legs: Vec<GoogleLeg>,
    overview_polyline: GooglePolyline,
}

#[derive(Debug, Deserialize)]
struct GoogleLeg {
    distance: GoogleDistance,
}

#[derive(Debug, Deserialize)]
struct GoogleDistance {
    value: u64, // meters
}

#[derive(Debug, Deserialize)]
struct GooglePolyline {
    points: String,
}

#[derive(Debug, Serialize)]
pub struct DirectionsResult {
    pub distance_meters: u64,
    pub coords: Vec<[f64; 2]>, // [lat, lng] pairs
}

/// Decode a Google Maps encoded polyline into lat/lng pairs.
fn decode_polyline(encoded: &str) -> Vec<[f64; 2]> {
    let mut coords = Vec::new();
    let mut lat: i64 = 0;
    let mut lng: i64 = 0;
    let bytes = encoded.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Decode latitude
        let mut shift = 0;
        let mut result: i64 = 0;
        loop {
            let b = (bytes[i] as i64) - 63;
            i += 1;
            result |= (b & 0x1f) << shift;
            shift += 5;
            if b < 0x20 { break; }
        }
        lat += if result & 1 != 0 { !(result >> 1) } else { result >> 1 };

        // Decode longitude
        shift = 0;
        result = 0;
        loop {
            let b = (bytes[i] as i64) - 63;
            i += 1;
            result |= (b & 0x1f) << shift;
            shift += 5;
            if b < 0x20 { break; }
        }
        lng += if result & 1 != 0 { !(result >> 1) } else { result >> 1 };

        coords.push([lat as f64 / 1e5, lng as f64 / 1e5]);
    }
    coords
}

/// Get driving directions between two points using Google Maps Directions API.
/// Requires GOOGLE_MAPS_API_KEY to be set — returns an error if not configured.
/// Optional waypoints (lat,lng pairs) can be provided for more accurate routing.
pub async fn get_directions(
    from_lat: f64, from_lng: f64,
    to_lat: f64, to_lng: f64,
    waypoints: &[[f64; 2]],
) -> Result<DirectionsResult, String> {
    let api_key = std::env::var("GOOGLE_MAPS_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "GOOGLE_MAPS_API_KEY is not set — cannot compute directions".to_string())?;

    get_directions_google(from_lat, from_lng, to_lat, to_lng, waypoints, &api_key).await
}

async fn get_directions_google(
    from_lat: f64, from_lng: f64,
    to_lat: f64, to_lng: f64,
    waypoints: &[[f64; 2]],
    api_key: &str,
) -> Result<DirectionsResult, String> {
    let mut url = format!(
        "{}?origin={},{}&destination={},{}&avoid=tolls&key={}",
        GOOGLE_DIRECTIONS_URL, from_lat, from_lng, to_lat, to_lng, api_key
    );

    // Add waypoints if provided (via: prefix = pass-through, no stop)
    if !waypoints.is_empty() {
        let wp_str: Vec<String> = waypoints.iter()
            .map(|[lat, lng]| format!("via:{},{}", lat, lng))
            .collect();
        url.push_str(&format!("&waypoints={}", wp_str.join("|")));
    }

    let client = reqwest::Client::new();
    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Google Directions request failed: {}", e))?;

    let data: GoogleDirectionsResponse = resp.json()
        .await
        .map_err(|e| format!("Failed to parse Google Directions response: {}", e))?;

    match data.status.as_str() {
        "OK" => {}
        other => {
            let detail = data.error_message.as_deref().unwrap_or("no detail");
            tracing::error!("Google Directions API error: {} — {}", other, detail);
            return Err(format!("Google Directions API error: {} — {}", other, detail));
        }
    }

    let route = data.routes.first().ok_or("No routes returned")?;
    let distance_meters: u64 = route.legs.iter().map(|l| l.distance.value).sum();
    let coords = decode_polyline(&route.overview_polyline.points);

    Ok(DirectionsResult { distance_meters, coords })
}

